// The "dot": an LLM with memory, tools and scheduled tasks.
// Provider = any OpenAI-compatible chat API (Groq, OpenRouter, Gemini, ...).

const MAX_HISTORY = 20; // messages remembered per chat
const HISTORY_TTL = 60 * 60 * 24 * 7; // forget chats idle for 7 days
const MAX_STEPS = 5; // tool round-trips per message
const MAX_FACTS = 50;
const MAX_TASKS = 20;
const MIN_REPEAT_MINUTES = 10; // keeps recurring tasks from burning the free LLM quota
const PAGE_CHARS = 6000;
const MAX_PAGE_BYTES = 2_000_000;

const DEFAULT_PROMPT =
  "You are the user's personal always-on assistant, chatting on Telegram. " +
  "Reply in the language the user writes in (Hinglish is fine). Keep answers short and plain text. " +
  "Use tools when they help: remember lasting preferences, schedule reminders or recurring tasks, read web pages.";

// ---- storage (Cloudflare KV, optional) ------------------------------------------------------

const load = async (env, key, fallback) => JSON.parse((await env.CHAT?.get(key)) || "null") ?? fallback;
const save = (env, key, value, opts) => env.CHAT.put(key, JSON.stringify(value), opts);

export const listFacts = (env, chatId) => load(env, `facts:${chatId}`, []);
export const clearFacts = (env, chatId) => env.CHAT?.delete(`facts:${chatId}`);
export const clearHistory = (env, chatId) => env.CHAT?.delete(`history:${chatId}`);
export const setModel = (env, chatId, model) => env.CHAT?.put(`model:${chatId}`, model);
export const currentModel = async (env, chatId) => (await env.CHAT?.get(`model:${chatId}`)) || env.LLM_MODEL;

// ---- time -----------------------------------------------------------------------------------

function fmt(env, ms, style = { dateStyle: "full", timeStyle: "short" }) {
  try {
    return new Date(ms).toLocaleString("en-GB", { timeZone: env.TIMEZONE || "UTC", ...style });
  } catch {
    return new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", ...style }); // bad TIMEZONE value
  }
}

// ---- tools ----------------------------------------------------------------------------------

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });

const TOOLS = {
  remember: {
    kv: true,
    description: "Save a lasting fact or preference about the user (name, habits, likes, routines).",
    parameters: obj({ fact: str("One short sentence") }, ["fact"]),
    async run(env, { chatId }, { fact }) {
      const facts = await listFacts(env, chatId);
      if (!facts.includes(fact)) facts.push(fact);
      await save(env, `facts:${chatId}`, facts.slice(-MAX_FACTS));
      return "Saved.";
    },
  },

  forget: {
    kv: true,
    description: "Delete remembered facts that contain the given text.",
    parameters: obj({ match: str("Text to match, case-insensitive") }, ["match"]),
    async run(env, { chatId }, { match }) {
      const facts = await listFacts(env, chatId);
      const keep = facts.filter((f) => !f.toLowerCase().includes(String(match).toLowerCase()));
      await save(env, `facts:${chatId}`, keep);
      return `Removed ${facts.length - keep.length} fact(s).`;
    },
  },

  set_reminder: {
    kv: true,
    description:
      "Schedule a message or task for later. When it is due you will be asked to carry out `text` and the answer is sent to the user. " +
      "Give either in_minutes (relative) or at (absolute ISO 8601 with UTC offset). Add every_minutes for recurring.",
    parameters: obj(
      {
        text: str("What to do or say when due, e.g. 'Remind the user to drink water'"),
        in_minutes: num("Minutes from now"),
        at: str("Absolute time, ISO 8601 with offset, e.g. 2026-10-01T08:00:00+05:30"),
        every_minutes: num(`Repeat interval in minutes (min ${MIN_REPEAT_MINUTES})`),
      },
      ["text"],
    ),
    async run(env, { chatId }, { text, in_minutes, at, every_minutes }) {
      const due = in_minutes != null ? Date.now() + Number(in_minutes) * 60_000 : Date.parse(at);
      if (!text || !Number.isFinite(due) || due < Date.now() - 60_000) {
        return "Error: need text plus a future in_minutes or a valid ISO 'at'.";
      }
      if (every_minutes != null && !(every_minutes >= MIN_REPEAT_MINUTES)) {
        return `Error: every_minutes must be at least ${MIN_REPEAT_MINUTES}.`;
      }
      const tasks = await load(env, "reminders", []);
      if (tasks.length >= MAX_TASKS) return `Error: limit of ${MAX_TASKS} scheduled tasks reached.`;
      const id = crypto.randomUUID().slice(0, 6);
      tasks.push({ id, chatId, text, due, ...(every_minutes ? { every_minutes: Number(every_minutes) } : {}) });
      await save(env, "reminders", tasks);
      return `Scheduled ${id} for ${fmt(env, due)}.`;
    },
  },

  list_reminders: {
    kv: true,
    readOnly: true,
    description: "List the user's scheduled reminders and recurring tasks.",
    parameters: obj({}),
    async run(env, { chatId }) {
      const mine = (await load(env, "reminders", [])).filter((t) => t.chatId === chatId);
      if (!mine.length) return "No scheduled tasks.";
      return mine
        .map((t) => `${t.id} | ${fmt(env, t.due)} | ${t.text}${t.every_minutes ? ` | every ${t.every_minutes} min` : ""}`)
        .join("\n");
    },
  },

  cancel_reminder: {
    kv: true,
    description: "Cancel a scheduled reminder by its id.",
    parameters: obj({ id: str("Id from list_reminders") }, ["id"]),
    async run(env, { chatId }, { id }) {
      const tasks = await load(env, "reminders", []);
      const keep = tasks.filter((t) => !(t.id === id && t.chatId === chatId));
      await save(env, "reminders", keep);
      return keep.length < tasks.length ? "Cancelled." : "No such id.";
    },
  },

  fetch_url: {
    readOnly: true,
    description: "Fetch a web page (http/https) and return its text. Use to read articles, docs, feeds.",
    parameters: obj({ url: str("Full URL") }, ["url"]),
    async run(_env, _ctx, { url }) {
      if (!/^https?:\/\//i.test(String(url))) return "Error: only http(s) URLs.";
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "telegram-ai-bot" } });
      if (Number(res.headers.get("content-length")) > MAX_PAGE_BYTES) return "Error: page too large.";
      let text = await res.text();
      if ((res.headers.get("content-type") || "").includes("html")) {
        text = text
          .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&");
      }
      return `HTTP ${res.status}\n${text.replace(/\s+/g, " ").trim().slice(0, PAGE_CHARS)}`;
    },
  },
};

// Boundaries: TOOLS env var (comma list) limits what the agent may do. Scheduled (background) runs are
// read-only, like dots' autonomous mode: they can look things up but can't change memory or schedules.
function enabledTools(env, scheduled) {
  const allowed = env.TOOLS ? env.TOOLS.split(",").map((s) => s.trim()) : Object.keys(TOOLS);
  return Object.entries(TOOLS).filter(
    ([name, t]) => allowed.includes(name) && (env.CHAT || !t.kv) && (!scheduled || t.readOnly),
  );
}

const toSpec = ([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
});

async function runTool(env, tools, call, ctx) {
  const tool = tools.find(([name]) => name === call.function.name)?.[1];
  if (!tool) return "Error: unknown tool.";
  try {
    return String(await tool.run(env, ctx, JSON.parse(call.function.arguments || "{}")));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// ---- LLM ------------------------------------------------------------------------------------

async function chat(env, model, messages, specs) {
  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.LLM_API_KEY}` },
    body: JSON.stringify({ model, messages, ...(specs.length ? { tools: specs } : {}) }),
  });
  if (!res.ok) {
    const err = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).choices[0].message;
}

/** One user message in, one answer out. Runs the tool loop and updates history. */
export async function runAgent(env, chatId, userText, { scheduled = false } = {}) {
  const history = await load(env, `history:${chatId}`, []);
  const facts = await listFacts(env, chatId);
  const model = await currentModel(env, chatId);
  const tools = enabledTools(env, scheduled);
  let specs = tools.map(toSpec);

  const system = [
    env.SYSTEM_PROMPT || DEFAULT_PROMPT,
    `Current time: ${fmt(env, Date.now())} (${env.TIMEZONE || "UTC"}). UTC now: ${new Date().toISOString()}.`,
    facts.length ? `What you know about the user:\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    scheduled ? "This is a scheduled task you set earlier. Carry it out now and reply directly to the user." : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userMsg = { role: "user", content: scheduled ? `[Scheduled task] ${userText}` : userText };
  const messages = [{ role: "system", content: system }, ...history, userMsg];

  let answer = "Kaam poora nahi ho paya (too many steps).";
  for (let step = 0; step < MAX_STEPS; step++) {
    let reply;
    try {
      reply = await chat(env, model, messages, specs);
    } catch (e) {
      // Many free models don't support tool calling: fall back to plain chat instead of failing.
      if (step === 0 && specs.length && (e.status === 400 || e.status === 404)) {
        console.warn(`model ${model} rejected tools, continuing without: ${e.message}`);
        specs = [];
        reply = await chat(env, model, messages, specs);
      } else {
        throw e;
      }
    }
    if (!reply.tool_calls?.length) {
      answer = reply.content?.trim() || "(empty reply)";
      break;
    }
    messages.push({ role: "assistant", content: reply.content ?? null, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      messages.push({ role: "tool", tool_call_id: call.id, content: await runTool(env, tools, call, { chatId }) });
    }
  }

  await env.CHAT?.put(
    `history:${chatId}`,
    JSON.stringify([...history, userMsg, { role: "assistant", content: answer }].slice(-MAX_HISTORY)),
    { expirationTtl: HISTORY_TTL },
  );
  return answer;
}

// ---- scheduler ------------------------------------------------------------------------------

/** Remove due tasks from storage (re-queueing recurring ones) and return them. At-most-once delivery. */
export async function takeDueReminders(env, now = Date.now()) {
  const all = await load(env, "reminders", []);
  const due = all.filter((t) => t.due <= now);
  if (!due.length) return [];
  const next = all.filter((t) => t.due > now);
  for (const t of due) {
    if (!t.every_minutes) continue;
    const step = t.every_minutes * 60_000;
    next.push({ ...t, due: t.due + Math.ceil((now - t.due + 1) / step) * step });
  }
  await save(env, "reminders", next);
  return due;
}
