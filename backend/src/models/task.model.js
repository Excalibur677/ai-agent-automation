const mongoose = require("mongoose");

/**
 * Step execution result (immutable history)
 */
const StepResultSchema = new mongoose.Schema(
  {
    stepId: { type: String },
    type: { type: String },
    tool: { type: String },
    serverId: { type: String },
    toolName: { type: String },
    position: {
      x: Number,
      y: Number,
    },
    input: { type: mongoose.Schema.Types.Mixed },
    output: { type: mongoose.Schema.Types.Mixed },
    success: { type: Boolean, default: true },
    timestamp: { type: Date, default: Date.now },
    /**
     * Wall-clock execution time of this step in milliseconds.
     * Set by the runner after each executeStep() call.
     */
    durationMs: { type: Number },
    /**
     * Step-level telemetry payload.
     * For "llm" steps with memory enabled:
     *   { useMemory, retrievedMemoriesCount, similarityScores[], averageSimilarity }
     * For "document_query" steps:
     *   { topK, retrievedChunksCount, averageSimilarity, relevantChunksCount }
     */
    metrics: { type: mongoose.Schema.Types.Mixed }
  },
  { _id: false }
);

/**
 * Task = executable runtime instance of a workflow
 */
const TaskSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workflow",
      default: null
    },

    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      default: null
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    name: {
      type: String,
      default: "Default Task Name",
    },

    position: {
      x: Number,
      y: Number,
    },

    status: {
      type: String,
      enum: ["pending", "running", "failed", "completed", "pending_approval", "rejected"],
      default: "pending",
      index: true
    },

    /**
     * 🔥 CRITICAL: steps copied from workflow.metadata.steps
     * Runner executes THIS field
     */
    steps: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },

    /**
     * Pointer to current executing step index
     */
    currentStep: {
      type: Number,
      default: 0
    },

    /**
     * Input payload for the task
     */
    input: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    /**
     * Runtime metadata (schedule info, trigger source, etc.)
     */
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },

    /**
     * Execution history
     */
    stepResults: {
      type: [StepResultSchema],
      default: []
    },

    startedAt: {
      type: Date,
      default: null
    },

    completedAt: {
      type: Date,
      default: null
    },

    attempts: {
      type: Number,
      default: 0
    },
    
    retryHistory: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },

    /**
     * HITL: Tracks which step paused execution for approval.
     * Set when the runner encounters an approval step.
     */
    pausedAtStepId: {
      type: String,
      default: null
    },

    /**
     * HITL: Approval metadata for human-in-the-loop workflows.
     * Populated when a task reaches an approval node.
     */
    approval: {
      stepId: { type: String },
      requestedAt: { type: Date },
      decidedAt: { type: Date },
      decision: { type: String, enum: ["approved", "rejected"] },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      feedback: { type: String, default: "" }
    }
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Task || mongoose.model("Task", TaskSchema);
