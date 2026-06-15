const Agent = require("../models/agent.model");
const groq = require("../services/groq.service");
const { storeMemory, retrieveMemory } = require("../services/memoryService");

/** Helpers */
function sendError(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}
function sendOK(res, payload) {
  return res.json({ ok: true, ...payload });
}

/** Create agent - POST /api/agents */
async function createAgent(req, res) {
  try {
    const userId = req.user._id;
    const { name, description, type, config, capabilities, isActive, quota } = req.body;
    if (!name) return sendError(res, 400, "name_required");
    const agent = await Agent.create({
      name,
      description: description || "",
      userId,
      type: type || "custom",
      config: config || {},
      capabilities: capabilities || ["llm"],
      isActive: isActive === undefined ? true : !!isActive,
      quota: quota || {},
    });
    return sendOK(res, { agent });
  } catch (err) {
    console.error("createAgent error", err);
    return sendError(res, 500, "server_error");
  }
}

/** List agents for user - GET /api/agents */
async function listAgents(req, res) {
  try {
    const userId = req.user._id;
    const agents = await Agent.find({ userId }).sort({ createdAt: -1 });
    return sendOK(res, { agents });
  } catch (err) {
    console.error("listAgents error", err);
    return sendError(res, 500, "server_error");
  }
}

/** Get single agent - GET /api/agents/:id */
async function getAgent(req, res) {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) return sendError(res, 404, "not_found");
    if (agent.userId.toString() !== req.user._id.toString())
      return sendError(res, 403, "forbidden");
    return sendOK(res, { agent });
  } catch (err) {
    console.error("getAgent error", err);
    return sendError(res, 500, "server_error");
  }
}

/** Update agent - PUT /api/agents/:id */
async function updateAgent(req, res) {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) return sendError(res, 404, "not_found");
    if (agent.userId.toString() !== req.user._id.toString())
      return sendError(res, 403, "forbidden");
    const allowed = ["name", "description", "type", "config", "capabilities", "isActive", "quota"];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) agent[k] = req.body[k];
    });
    await agent.save();
    return sendOK(res, { agent });
  } catch (err) {
    console.error("updateAgent error", err);
    return sendError(res, 500, "server_error");
  }
}

/** Delete agent - DELETE /api/agents/:id */
async function deleteAgent(req, res) {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) return sendError(res, 404, "not_found");
    if (agent.userId.toString() !== req.user._id.toString())
      return sendError(res, 403, "forbidden");
    await agent.deleteOne();
    return sendOK(res, { message: "agent_deleted" });
  } catch (err) {
    console.error("deleteAgent error", err);
    return sendError(res, 500, "server_error");
  }
}

/**
 * Run agent in playground - POST /api/agents/:id/run
 * Body: { prompt, useMemory }
 * Returns: { response, retrievedMemory }
 */
async function runAgent(req, res) {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) return sendError(res, 404, "not_found");
    if (agent.userId.toString() !== req.user._id.toString())
      return sendError(res, 403, "forbidden");

    const { prompt, useMemory = false } = req.body;
    if (!prompt?.trim()) return sendError(res, 400, "prompt_required");

    const provider = agent.config?.provider || "groq";
    const model = agent.config?.model || "llama-3.1-8b-instant";
    const temperature = agent.config?.temperature ?? 0.7;

    // 1. Retrieve semantic memory if enabled
    let retrievedMemory = [];
    let memoryContext = "";

    if (useMemory) {
      retrievedMemory = await retrieveMemory(agent, prompt, 5, 0.45);
      if (retrievedMemory.length > 0) {
        memoryContext =
          "\n\nRelevant memory context:\n" +
          retrievedMemory.map((m) => `- ${m.content}`).join("\n");
      }
    }

    // 2. Build messages
    const messages = [
      {
        role: "system",
        content:
          `You are ${agent.name}. ${agent.description || ""}${memoryContext}`.trim(),
      },
      { role: "user", content: prompt },
    ];

    // 3. Call LLM — currently supports groq, extend for other providers
    let responseText = "";

    if (provider === "groq") {
      const completion = await groq.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: agent.config?.maxTokens || 1024,
      });
      responseText = completion.choices[0]?.message?.content || "";
    } else {
      // Fallback for unsupported providers in playground
      return sendError(res, 400, `provider_not_supported_in_playground: ${provider}`);
    }

    // 4. Store conversation in memory if enabled
    if (useMemory) {
      await storeMemory(
        agent,
        `User: ${prompt}\nAssistant: ${responseText}`,
        { type: "conversation", source: "playground" }
      );
    }

    return sendOK(res, {
      response: responseText,
      retrievedMemory: retrievedMemory.map((m) => ({
        content: m.content,
        score: parseFloat(m.score.toFixed(3)),
        createdAt: m.createdAt,
      })),
      meta: { provider, model, temperature },
    });
  } catch (err) {
    console.error("runAgent error", err);
    return sendError(res, 500, "server_error");
  }
}

module.exports = {
  createAgent,
  listAgents,
  getAgent,
  updateAgent,
  deleteAgent,
  runAgent,
};
