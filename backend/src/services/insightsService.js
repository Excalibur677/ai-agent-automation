// backend/src/services/insightsService.js
const Task = require("../models/task.model");

const DEFAULT_LIMIT = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

function safeAvg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, val));
}

// ─── 1. Workflow-level success & duration ───────────────────────────────────

async function getWorkflowRunStats(workflowId, limit = DEFAULT_LIMIT) {
  const tasks = await Task.find({ workflowId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const successRate = tasks.length > 0 ? (completed.length / tasks.length) * 100 : 0;

  const durations = tasks
    .filter((t) => t.startedAt && t.completedAt)
    .map((t) => new Date(t.completedAt) - new Date(t.startedAt));

  return {
    totalRuns: tasks.length,
    completedRuns: completed.length,
    failedRuns: failed.length,
    successRate: parseFloat(successRate.toFixed(2)),
    avgDurationMs: Math.round(safeAvg(durations)),
    minDurationMs: durations.length ? Math.min(...durations) : null,
    maxDurationMs: durations.length ? Math.max(...durations) : null,
  };
}

// ─── 2. Step-level stability stats ──────────────────────────────────────────

function computeStepStats(tasks) {
  const stepMap = {}; // keyed by stepId

  for (const task of tasks) {
    for (const sr of task.stepResults || []) {
      const key = sr.stepId || sr.type || "unknown";
      if (!stepMap[key]) {
        stepMap[key] = {
          stepId: key,
          type: sr.type,
          executions: 0,
          successes: 0,
          failures: 0,
          durations: [],
          errors: [],
        };
      }
      const s = stepMap[key];
      s.executions++;
      if (sr.success === false) {
        s.failures++;
        const errMsg = sr.output?.error || sr.output?.message;
        if (errMsg) s.errors.push(errMsg);
      } else {
        s.successes++;
      }
      if (typeof sr.durationMs === "number") s.durations.push(sr.durationMs);
    }
  }

  return Object.values(stepMap).map((s) => ({
    stepId: s.stepId,
    type: s.type,
    executions: s.executions,
    successRate: s.executions ? parseFloat(((s.successes / s.executions) * 100).toFixed(2)) : 0,
    failureCount: s.failures,
    avgDurationMs: Math.round(safeAvg(s.durations)),
    commonErrors: [...new Set(s.errors)].slice(0, 3),
  }));
}

// ─── 3. Branch routing skew analysis ────────────────────────────────────────

function computeBranchRouting(tasks) {
  const branchMap = {}; // conditionStepId → { outcomes: { label: count } }

  for (const task of tasks) {
    const steps = task.steps || [];
    const results = task.stepResults || [];

    for (const step of steps) {
      if (!["condition", "switch"].includes(step.type)) continue;

      const key = step.id || step.stepId;
      if (!key) continue;
      if (!branchMap[key]) {
        branchMap[key] = { stepId: key, type: step.type, outcomes: {}, totalTraversals: 0 };
      }

      // find the matching step result to see which branch was taken
      const sr = results.find((r) => r.stepId === key);
      if (!sr) continue;

      const outcome = sr.output?.branch || sr.output?.outcome || sr.output?.result || "unknown";
      branchMap[key].outcomes[outcome] = (branchMap[key].outcomes[outcome] || 0) + 1;
      branchMap[key].totalTraversals++;
    }
  }

  return Object.values(branchMap).map((b) => {
    const total = b.totalTraversals;
    const outcomeEntries = Object.entries(b.outcomes);

    const outcomePct = outcomeEntries.map(([label, count]) => ({
      label,
      count,
      pct: total ? parseFloat(((count / total) * 100).toFixed(1)) : 0,
    }));

    const maxPct = outcomePct.length ? Math.max(...outcomePct.map((o) => o.pct)) : 0;
    const isSkewed = maxPct >= 90;
    const deadBranches = outcomeEntries.filter(([, c]) => c === 0).map(([l]) => l);

    return {
      stepId: b.stepId,
      type: b.type,
      totalTraversals: total,
      outcomes: outcomePct,
      isSkewed,
      deadBranches,
    };
  });
}

// ─── 4. RAG & Memory relevance analysis ─────────────────────────────────────

function computeSemanticMetrics(tasks) {
  const memoryScores = [];
  const ragScores = [];
  let lowRelevanceMemory = false;
  let lowRelevanceRag = false;

  for (const task of tasks) {
    for (const sr of task.stepResults || []) {
      const m = sr.metrics;
      if (!m) continue;

      if (m.useMemory && typeof m.averageSimilarity === "number") {
        memoryScores.push(m.averageSimilarity);
      }
      if (typeof m.topK === "number" && typeof m.averageSimilarity === "number") {
        ragScores.push(m.averageSimilarity);
      }
    }
  }

  const avgMemorySimilarity = parseFloat(safeAvg(memoryScores).toFixed(4));
  const avgRagSimilarity = parseFloat(safeAvg(ragScores).toFixed(4));

  lowRelevanceMemory = memoryScores.length > 0 && avgMemorySimilarity < 0.35;
  lowRelevanceRag = ragScores.length > 0 && avgRagSimilarity < 0.35;

  return {
    memory: {
      sampleCount: memoryScores.length,
      avgSimilarity: avgMemorySimilarity,
      lowRelevance: lowRelevanceMemory,
    },
    rag: {
      sampleCount: ragScores.length,
      avgSimilarity: avgRagSimilarity,
      lowRelevance: lowRelevanceRag,
    },
  };
}

// ─── 5. Composite health score (0–100) ──────────────────────────────────────

function computeHealthScore({ runStats, stepStats, branchRouting, semanticMetrics }) {
  // Reliability component (35%)
  const reliability = runStats ? runStats.successRate : 100;

  // Step stability component (25%) — average step-level success rate
  const stepSuccessRates = stepStats.map((s) => s.successRate);
  const stepStability = safeAvg(stepSuccessRates) || 100;

  // Branch efficiency component (20%) — penalise heavily skewed or dead branches
  let branchScore = 100;
  if (branchRouting.length > 0) {
    const skewedCount = branchRouting.filter((b) => b.isSkewed).length;
    const deadCount = branchRouting.reduce((acc, b) => acc + b.deadBranches.length, 0);
    branchScore = Math.max(0, 100 - skewedCount * 15 - deadCount * 10);
  }

  // Memory/RAG relevance component (20%)
  const memPenalty = semanticMetrics.memory.lowRelevance ? 40 : 0;
  const ragPenalty = semanticMetrics.rag.lowRelevance ? 40 : 0;
  const relevanceScore = Math.max(0, 100 - memPenalty - ragPenalty);

  const composite =
    reliability * 0.35 +
    stepStability * 0.25 +
    branchScore * 0.2 +
    relevanceScore * 0.2;

  return parseFloat(clamp(composite).toFixed(1));
}

// ─── 6. Optimization recommendations ────────────────────────────────────────

function buildRecommendations({ runStats, stepStats, branchRouting, semanticMetrics }) {
  const recs = [];

  // Low success rate
  if (runStats && runStats.successRate < 80) {
    recs.push({
      type: "reliability",
      severity: runStats.successRate < 50 ? "critical" : "warning",
      message: `Workflow success rate is ${runStats.successRate.toFixed(1)}%. Investigate frequently failing steps and add retry logic or fallback handlers.`,
    });
  }

  // Slow / unstable steps
  for (const s of stepStats) {
    if (s.successRate < 70 && s.executions >= 3) {
      recs.push({
        type: "step_stability",
        severity: "warning",
        message: `Step "${s.stepId}" (${s.type}) has a ${s.successRate}% success rate over ${s.executions} executions. Common errors: ${s.commonErrors.join("; ") || "N/A"}.`,
      });
    }
    if (s.avgDurationMs > 10000 && s.executions >= 3) {
      recs.push({
        type: "step_performance",
        severity: "notice",
        message: `Step "${s.stepId}" averages ${(s.avgDurationMs / 1000).toFixed(1)}s. Consider caching outputs or parallelising upstream steps.`,
      });
    }
  }

  // Skewed branches
  for (const b of branchRouting) {
    if (b.isSkewed) {
      recs.push({
        type: "branch_routing",
        severity: "notice",
        message: `Branch "${b.stepId}" is heavily skewed (≥90% of executions take one path). Review condition logic — the alternative branches may be unreachable.`,
      });
    }
    if (b.deadBranches.length > 0) {
      recs.push({
        type: "dead_branch",
        severity: "warning",
        message: `Branch "${b.stepId}" has never-taken outcome(s): ${b.deadBranches.join(", ")}. These are dead code — remove or fix routing conditions.`,
      });
    }
  }

  // Low RAG relevance
  if (semanticMetrics.rag.lowRelevance) {
    recs.push({
      type: "rag_relevance",
      severity: "warning",
      message: `Average RAG similarity is ${semanticMetrics.rag.avgSimilarity.toFixed(3)} (threshold 0.35). Increase Top-K, improve document chunking strategy, or refine query prompts.`,
    });
  }

  // Low memory relevance
  if (semanticMetrics.memory.lowRelevance) {
    recs.push({
      type: "memory_relevance",
      severity: "warning",
      message: `Average memory retrieval similarity is ${semanticMetrics.memory.avgSimilarity.toFixed(3)} (threshold 0.35). Consider pruning stale memories or tuning the embedding model.`,
    });
  }

  return recs;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute full insights for a single workflow.
 * @param {string} workflowId - MongoDB ObjectId string
 * @param {number} [limit=200]  - max runs to analyse
 */
async function getWorkflowInsights(workflowId, limit = DEFAULT_LIMIT) {
  const tasks = await Task.find({ workflowId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (tasks.length === 0) {
    return { workflowId, message: "No execution history found.", healthScore: null };
  }

  const runStats = await getWorkflowRunStats(workflowId, limit);
  const stepStats = computeStepStats(tasks);
  const branchRouting = computeBranchRouting(tasks);
  const semanticMetrics = computeSemanticMetrics(tasks);
  const healthScore = computeHealthScore({ runStats, stepStats, branchRouting, semanticMetrics });
  const recommendations = buildRecommendations({ runStats, stepStats, branchRouting, semanticMetrics });

  return {
    workflowId,
    analysedRuns: tasks.length,
    runStats,
    stepStats,
    branchRouting,
    semanticMetrics,
    healthScore,
    recommendations,
  };
}

/**
 * Compute aggregated insights across all workflows for a user.
 * @param {string} userId - MongoDB ObjectId string
 * @param {number} [limit=200]
 */
async function getGlobalInsights(userId, limit = DEFAULT_LIMIT) {
  const tasks = await Task.find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  if (tasks.length === 0) {
    return { userId, message: "No execution history found.", healthScore: null };
  }

  // Group by workflowId
  const byWorkflow = {};
  for (const t of tasks) {
    const wid = t.workflowId ? t.workflowId.toString() : "standalone";
    (byWorkflow[wid] = byWorkflow[wid] || []).push(t);
  }

  const workflowSummaries = Object.entries(byWorkflow).map(([wid, wTasks]) => {
    const completed = wTasks.filter((t) => t.status === "completed").length;
    const successRate = parseFloat(((completed / wTasks.length) * 100).toFixed(2));
    const durations = wTasks
      .filter((t) => t.startedAt && t.completedAt)
      .map((t) => new Date(t.completedAt) - new Date(t.startedAt));
    return {
      workflowId: wid,
      totalRuns: wTasks.length,
      successRate,
      avgDurationMs: Math.round(safeAvg(durations)),
    };
  });

  const overallSuccessRate = parseFloat(
    safeAvg(workflowSummaries.map((w) => w.successRate)).toFixed(2)
  );

  const stepStats = computeStepStats(tasks);
  const branchRouting = computeBranchRouting(tasks);
  const semanticMetrics = computeSemanticMetrics(tasks);
  const runStats = { successRate: overallSuccessRate };
  const healthScore = computeHealthScore({ runStats, stepStats, branchRouting, semanticMetrics });
  const recommendations = buildRecommendations({ runStats, stepStats, branchRouting, semanticMetrics });

  return {
    userId,
    analysedRuns: tasks.length,
    workflowSummaries,
    overallSuccessRate,
    stepStats,
    branchRouting,
    semanticMetrics,
    healthScore,
    recommendations,
  };
}

module.exports = {
  getWorkflowInsights,
  getGlobalInsights,
};
