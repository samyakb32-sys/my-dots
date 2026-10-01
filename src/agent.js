// The "dot": an LLM with memory, tools and scheduled tasks. Models come from src/models.js.

import { complete, modelChain, DEFAULT_VISION_CHAIN } from "./models.js";
import { EXTRA_TOOLS } from "./tools-extra.js";
import { loadMcpTools, refreshMcp } from "./mcp.js";
import { WATCH_TOOLS } from "./watch.js";
import { BROWSER_TOOLS } from "./browser.js";
import { readPage } from "./page.js";
import { requestApproval } from "./approvals.js";
import { csv, matchesAny, obj, str, num } from "./util.js";

export { refreshMcp as refreshTools };

const MAX_HISTORY = 20; // messages remembered per chat
const HISTORY_TTL = 60 * 60 * 24 * 7; // forget chats idle for 7 days
const MAX_STEPS = 5; // tool round-trips per message
const MAX_FACTS = 50;
const MAX_TASKS = 20;
const MIN_REPEAT_MINUTES = 10; // keeps recurring tasks from burning the free LLM quota
const PAGE_CHARS = 6000;

const DEFAULT_PROMPT =
  "You are the user's personal always-on assistant, chatting on Telegram. " +
  "Reply in the language the user writes in (Hinglish is fine). Keep answers short and plain text. " +
  "Use tools when they help: search the web, read pages, run code, make files or images, remember lasting " +
  "preferences, schedule reminders or recurring tasks, watch a page for changes or price drops. Never invent facts you could look up. " +
  "Some actions need the user's approval: call the tool to request it, and never claim it is done before they approve.";

// ---- storage (Cloudflare KV, optional) ------------------------------------------------------

const load = async (env, key, fallback) => JSON.parse((await env.CHAT?.get(key)) || "null") ?? fallback;
const save = (env, key, value, opts) => env.CHAT.put(key, JSON.stringify(value), opts);

export const listFacts = (env, chatId) => load(env, `facts:${chatId}`, []);
export const clearFacts = (env, chatId) => env.CHAT?.delete(`facts:${chatId}`);
export const clearHistory = (env, chatId) => env.CHAT?.delete(`history:${chatId}`);
/** The model this chat picked with /model (tried first), or null to use MODEL_CHAIN order. */
export const selectedModel = async (env, chatId) => (await env.CHAT?.get(`model:${chatId}`)) || null;
export const setModel = (env, chatId, spec) =>
  spec ? env.CHAT?.put(`model:${chatId}`, spec) : env.CHAT?.delete(`model:${chatId}`);

// ---- time -----------------------------------------------------------------------------------

function fmt(env, ms, style = { dateStyle: "full", timeStyle: "short" }) {
  try {
    return new Date(ms).toLocaleString("en-GB", { timeZone: env.TIMEZONE || "UTC", ...style });
  } catch {
    return new Date(ms).toLocaleString("en-GB", { timeZone: "UTC", ...style }); // bad TIMEZONE value
  }
}

// ---- tools ----------------------------------------------------------------------------------
// Tool shape: { description, parameters, run(env, ctx, args), kv?, readOnly?, risky?, available?(env) }
//   kv: needs the KV binding. readOnly: allowed in background (scheduled) runs.
//   risky: user must approve each call. available: tool is hidden when this returns false.

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
    async run(env, _ctx, { url }) {
      const { status, text } = await readPage(env, url);
      return `HTTP ${status}\n${text.slice(0, PAGE_CHARS)}`;
    },
  },
};
Object.assign(TOOLS, EXTRA_TOOLS, WATCH_TOOLS, BROWSER_TOOLS);

// Boundaries: the TOOLS env var (comma list, trailing * allowed) limits what the agent may do. Scheduled
// (background) runs are read-only, like dots' autonomous mode: they can look things up but change nothing.
async function enabledTools(env, scheduled) {
  const allowed = env.TOOLS ? csv(env.TOOLS) : null;
  const all = [...Object.entries(TOOLS), ...(await loadMcpTools(env))];
  return all.filter(
    ([name, t]) =>
      (!allowed || matchesAny(allowed, name)) &&
      (env.CHAT || !t.kv) &&
      (!t.available || t.available(env)) &&
      (!scheduled || t.readOnly),
  );
}

const toSpec = ([name, t]) => ({
  type: "function",
  function: { name, description: t.description, parameters: t.parameters },
});

async function runTool(env, tools, call, ctx) {
  const [name, tool] = tools.find(([n]) => n === call.function.name) ?? [];
  if (!tool) return "Error: unknown tool.";
  try {
    const args = JSON.parse(call.function.arguments || "{}");
    // Risky actions (anything an MCP server doesn't mark read-only) wait for the user's tap.
    if (tool.risky && !matchesAny(csv(env.AUTO_APPROVE), name)) return await requestApproval(env, ctx.chatId, name, args);
    return String(await tool.run(env, ctx, args));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

/**
 * Run a call the user just approved with the buttons. The outcome is "succeeded", "failed" (it did not happen) or
 * "outcome_unknown" (the request may have reached the provider; never retry it blindly).
 */
export async function executePending(env, { chatId, name, args }) {
  const tool = (await enabledTools(env, false)).find(([n]) => n === name)?.[1];
  if (!tool) return { status: "failed", text: "Error: ye tool ab available nahi hai." };
  try {
    const text = String(await tool.run(env, { chatId }, args));
    return { status: text.startsWith("Error:") ? "failed" : "succeeded", text };
  } catch (e) {
    return { status: e.outcomeUnknown ? "outcome_unknown" : "failed", text: `Error: ${e.message}` };
  }
}

/** One line per tool, for /tools. ✋ = needs the user's approval each time. */
export async function describeTools(env) {
  return (await enabledTools(env, false)).map(
    ([name, t]) => `${t.risky ? "✋" : "•"} ${name}: ${t.description.split(/(?<=\.)\s|\n/)[0].slice(0, 80)}`,
  );
}

/** Record something that happened outside the chat flow (e.g. an approved action), so the model knows later. */
export async function addHistoryNote(env, chatId, text) {
  const history = await load(env, `history:${chatId}`, []);
  await env.CHAT?.put(
    `history:${chatId}`,
    JSON.stringify([...history, { role: "assistant", content: text }].slice(-MAX_HISTORY)),
    { expirationTtl: HISTORY_TTL },
  );
}

// ---- agent loop -----------------------------------------------------------------------------

// Reasoning models (DeepSeek, gpt-oss, ...) may put their thinking inline; don't show it.
const stripThinking = (text) => text?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// Interactive replies run in waitUntil, which Workers cut off ~30s after the webhook returns: stay inside that.
// Cron-triggered runs have far more time.
const BUDGET_MS = { interactive: 25_000, scheduled: 100_000 };

/** One user message in, one answer out. Runs the tool loop and updates history. */
export async function runAgent(env, chatId, userText, { scheduled = false, images = [] } = {}) {
  const history = await load(env, `history:${chatId}`, []);
  const facts = await listFacts(env, chatId);
  // Photos go to vision-capable models only; the chat's /model pick may be text-only.
  const chain = images.length
    ? modelChain(env, null, env.VISION_CHAIN || DEFAULT_VISION_CHAIN)
    : modelChain(env, await selectedModel(env, chatId));
  if (images.length && !chain.length) {
    throw new Error("Photo samajhne ke liye vision model chahiye: GEMINI_API_KEY (free) ya NVIDIA_API_KEY set kar.");
  }
  const until = Date.now() + (scheduled ? BUDGET_MS.scheduled : BUDGET_MS.interactive);
  const tools = await enabledTools(env, scheduled);
  const specs = tools.map(toSpec);

  const system = [
    env.SYSTEM_PROMPT || DEFAULT_PROMPT,
    `Current time: ${fmt(env, Date.now())} (${env.TIMEZONE || "UTC"}). UTC now: ${new Date().toISOString()}.`,
    facts.length ? `What you know about the user:\n${facts.map((f) => `- ${f}`).join("\n")}` : "",
    scheduled ? "This is a scheduled task you set earlier. Carry it out now and reply directly to the user." : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const text = scheduled ? `[Scheduled task] ${userText}` : userText;
  // History keeps a text stand-in for photos: base64 images would bloat KV and every later prompt.
  const userMsg = { role: "user", content: images.length ? `[photo] ${text}` : text };
  const llmMsg = images.length
    ? { role: "user", content: [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] }
    : userMsg;
  const messages = [{ role: "system", content: system }, ...history, llmMsg];

  let answer = "Kaam poora nahi ho paya (too many steps).";
  let used = chain[0]?.label;
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await complete(env, chain, messages, specs, until);
    used = res.used;
    const reply = res.message;
    if (!reply.tool_calls?.length) {
      answer = stripThinking(reply.content) || "(empty reply)";
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
  // Say so when a fallback model answered, so it's clear why the style changed.
  return used !== chain[0].label ? `${answer}\n\n(via ${used})` : answer;
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
