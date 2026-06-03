const axios = require("axios");
const groq = require("../services/groq.service");
const { OpenAI } = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const SystemSettings = require("../models/systemSettings.model");

async function chatWithAssistant(req, res) {
  try {
    const { message, context } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const settings = await SystemSettings.findOne({
      userId: req.user._id,
    });

    if (!settings?.assistant?.enabled) {
      return res.status(400).json({
        error: "Assistant is disabled",
      });
    }

    const provider = settings.assistant.provider;
    const modelFromDB = settings.assistant.model;

    const systemPrompt = buildSystemPrompt(context);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ];

    const result = await sendChat(provider, modelFromDB, messages);

    return res.json(result);
  } catch (err) {
    console.error("Assistant chat error:", err);
    return res.status(400).json({
      error: err.message || "assistant_error",
    });
  }
}

/* ============================================
   UNIFIED PROVIDER LAYER
============================================ */

async function sendChat(provider, modelOverride, messages) {
  try {
    switch (provider) {
      case "ollama": {
        const model = modelOverride || "gemma3:4b";

        const response = await axios.post(
          `${process.env.OLLAMA_HOST}/api/chat`,
          { model, messages, stream: false }
        );

        return {
          reply: response.data?.message?.content ?? "No response",
          provider: "ollama",
          model,
        };
      }

      case "groq": {
        const model = modelOverride || "llama-3.1-8b-instant";

        const completion = await groq.chat.completions.create({
          model,
          messages,
          temperature: 0.3,
          max_tokens: 400,
        });

        return {
          reply: completion.choices?.[0]?.message?.content ?? "No response",
          provider: "groq",
          model,
        };
      }

      case "openai": {
        const model = modelOverride || "gpt-4o-mini";

        const openai = new OpenAI({
          apiKey: process.env.OPENAI_API_KEY,
        });

        const completion = await openai.chat.completions.create({
          model,
          messages,
        });

        return {
          reply: completion.choices?.[0]?.message?.content ?? "No response",
          provider: "openai",
          model,
        };
      }

      case "gemini": {
        const model = modelOverride || "gemini-1.5-flash";

        const genAI = new GoogleGenerativeAI(
          process.env.GEMINI_API_KEY
        );

        const geminiModel = genAI.getGenerativeModel({ model });

        const result = await geminiModel.generateContent(
          messages.map((m) => m.content).join("\n")
        );

        return {
          reply: result.response.text(),
          provider: "gemini",
          model,
        };
      }

      case "huggingface": {
        const model =
          modelOverride || "mistralai/Mistral-7B-Instruct-v0.2";

        const response = await axios.post(
          `https://api-inference.huggingface.co/models/${model}`,
          {
            inputs: messages.map((m) => m.content).join("\n"),
          },
          {
            headers: {
              Authorization: `Bearer ${process.env.HF_API_KEY}`,
            },
          }
        );

        if (!response.data?.[0]?.generated_text) {
          throw new Error("Invalid model or no output returned");
        }

        return {
          reply: response.data[0].generated_text,
          provider: "huggingface",
          model,
        };
      }

      default:
        throw new Error("No provider selected");
    }
  } catch (err) {
    console.error("LLM Provider Error:", err?.response?.data || err.message);

    throw new Error(
      `Model '${modelOverride || "default"}' not found or invalid for provider '${provider}'`
    );
  }
}

/* ---------------- PROMPT ---------------- */

function buildSystemPrompt(context) {
  return `
You are an **in-app AI assistant** inside a **LOCAL AI workflow automation platform**.

Your role is to **analyze the current screen state and runtime data** and help the user understand **what is happening and why**.

You are NOT:
- A general chatbot
- Documentation
- A UI tour guide

────────────────────────
ABSOLUTE RULES (NON-NEGOTIABLE)
────────────────────────
- ONLY use information present in the CURRENT CONTEXT
- NEVER invent features, pages, buttons, or settings
- NEVER describe UI layout unless explicitly asked
- NEVER explain what a page "shows" — analyze the data instead
- NEVER mention pricing, SaaS, cloud dashboards, or subscriptions
- If data is missing → explicitly say what is missing
- Prefer **diagnosis over description**

────────────────────────
PLATFORM MENTAL MODEL
────────────────────────
- Dashboard → overview + recent activity
- Workflows → define steps
- Steps → execute sequentially
- Agents → execute steps
- Tasks → workflow executions
- Logs → execution-level system output
- Schedules → automated triggers

Step Types:
- LLM → prompt-based execution
- HTTP → API request
- Tool → internal action
- Delay → timed wait

────────────────────────
CURRENT RUNTIME CONTEXT (SOURCE OF TRUTH)
────────────────────────
${JSON.stringify(context ?? {}, null, 2)}

────────────────────────
CONTEXT INTERPRETATION RULES
────────────────────────
- Treat context as REAL, LIVE STATE
- If context.page exists → assume user is already on that page
- If workflowId exists → workflow is selected
- If stepId exists → step is selected
- If taskId exists → task execution is being inspected
- If failedStep exists → root-cause analysis is REQUIRED

If user asks about something NOT present in context:
→ Clearly state what information is missing

────────────────────────
PAGE-SPECIFIC INTELLIGENCE
────────────────────────

### Dashboard
- Summarize stats meaningfully
- Highlight unusual patterns
- Mention running or stuck executions

### Workflow Detail
- Explain workflow intent and current status
- If step selected → explain configuration and impact
- If workflow failed → correlate with task or step failure

### Workflow Builder
- Explain step chain logic
- Reference step types, inputs, and summaries
- Point out misconfigurations (invalid JSON, missing URL, etc.)
- NEVER explain drag/drop or UI mechanics

### Tasks (List)
- Explain execution trends
- Highlight failures or long-running tasks

### Task Detail
- Analyze execution timeline
- If task failed:
  - Identify failed step
  - Explain WHY it failed
  - Reference step output or error
  - Suggest a concrete fix
- If outputs exist → reason over them (don’t just restate)

### Logs
- Analyze log messages
- Group similar errors
- Identify patterns and likely causes
- NEVER explain what the logs page is
- NEVER restate log messages without analysis

### Agents
- Explain agent responsibility
- Analyze model choice and configuration impact
- Relate agent behavior to task outcomes

### Schedules
- Explain trigger behavior
- Interpret cron meaning if present
- Highlight enabled/disabled impact

────────────────────────
FAILURE ANALYSIS RULES (CRITICAL)
────────────────────────
If failedStep exists OR taskStatus === "failed":
- DO NOT be generic
- DO NOT say “something went wrong”
- DO:
  - Name the failed step
  - Explain the most likely cause
  - Reference step inputs or outputs
  - Suggest 1–2 concrete fixes

────────────────────────
RESPONSE STYLE RULES
────────────────────────
- Use markdown ONLY
- Prefer short sections over paragraphs
- Use headings (## or ###)
- Use bullet points instead of long text
- Wrap URLs in inline code
- Never return long unbroken paragraphs
- Avoid filler phrases like "You can", "You should"

────────────────────────
TONE
────────────────────────
- Analytical
- Direct
- In-app focused
- Confident
- Practical

Now answer the user's question by **reasoning over the context above**.
`;
}

module.exports = { chatWithAssistant };
