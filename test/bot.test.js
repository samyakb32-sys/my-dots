import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handleUpdate, runDue } from "../src/index.js";

let calls; // every outbound fetch: { url, body }
let llmReply;
let llmStatus;
let llmQueue; // scripted assistant messages, consumed in order; then plain llmReply
let rejectTools; // provider answers 400 when a request carries tools

const kv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), m };
};

const makeEnv = (over = {}) => ({
  TELEGRAM_BOT_TOKEN: "TOKEN",
  TELEGRAM_WEBHOOK_SECRET: "s3cret",
  LLM_API_KEY: "key",
  LLM_BASE_URL: "https://llm.test/v1",
  LLM_MODEL: "default-model",
  ALLOWED_USER_IDS: "42",
  TIMEZONE: "Asia/Kolkata",
  CHAT: kv(),
  ...over,
});

const msg = (text, id = 42) => ({ message: { text, chat: { id }, from: { id } } });
const toolCall = (name, args, id = "c1") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const sent = () => calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => c.body.text);
const llmCalls = () => calls.filter((c) => c.url.startsWith("https://llm.test"));
const toolNames = (call) => (call.body.tools ?? []).map((t) => t.function.name);

beforeEach(() => {
  calls = [];
  llmReply = "hello from llm";
  llmStatus = 200;
  llmQueue = [];
  rejectTools = false;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    if (url.startsWith("https://llm.test")) {
      if (llmStatus !== 200) return new Response("nope", { status: llmStatus });
      if (rejectTools && body.tools) return new Response("tools unsupported", { status: 400 });
      const message = llmQueue.shift() ?? { role: "assistant", content: llmReply };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }
    if (url.startsWith("https://page.test")) {
      return new Response("<html><script>evil()</script><p>Hello &amp; welcome</p></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("{}");
  };
});

// ---- chat basics ----------------------------------------------------------------------------

test("replies via the LLM and remembers the conversation", async () => {
  const env = makeEnv();
  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("again"), env);

  assert.deepEqual(sent(), ["hello from llm", "hello from llm"]);
  assert.equal(llmCalls()[1].body.model, "default-model");
  assert.deepEqual(llmCalls()[1].body.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
});

test("ignores users who are not allowed, without calling anything", async () => {
  await handleUpdate(msg("hi", 7), makeEnv());
  assert.equal(calls.length, 0);
});

test("setup mode reveals the Telegram ID when no allowlist is configured", async () => {
  await handleUpdate(msg("hi", 7), makeEnv({ ALLOWED_USER_IDS: "" }));
  assert.match(sent()[0], /Your Telegram ID is 7/);
  assert.equal(llmCalls().length, 0);
});

test("/reset clears chat history and /model switches model", async () => {
  const env = makeEnv();
  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("/reset"), env);
  assert.equal(env.CHAT.m.has("history:42"), false);

  await handleUpdate(msg("/model other/model:free"), env);
  await handleUpdate(msg("hi"), env);
  assert.equal(llmCalls().at(-1).body.model, "other/model:free");
});

test("commands addressed to the bot (/reset@my_bot) still work", async () => {
  const env = makeEnv();
  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("/reset@my_bot"), env);
  assert.equal(env.CHAT.m.has("history:42"), false);
});

test("rate limit from the provider gives a friendly message and keeps history clean", async () => {
  const env = makeEnv();
  llmStatus = 429;
  await handleUpdate(msg("hi"), env);
  assert.match(sent()[0], /Free limit/);
  assert.equal(env.CHAT.m.has("history:42"), false);
});

test("long answers are split to fit Telegram's limit", async () => {
  llmReply = "x".repeat(9000);
  await handleUpdate(msg("hi"), makeEnv());
  assert.deepEqual(sent().map((t) => t.length), [4000, 4000, 1000]);
});

test("works without a KV binding (stateless, memory tools hidden)", async () => {
  await handleUpdate(msg("hi"), makeEnv({ CHAT: undefined }));
  assert.deepEqual(sent(), ["hello from llm"]);
  assert.deepEqual(toolNames(llmCalls()[0]), ["fetch_url"]);
});

// ---- memory ---------------------------------------------------------------------------------

test("remember tool stores a fact that shows up in later prompts, /memory lists and clears it", async () => {
  const env = makeEnv();
  llmQueue = [toolCall("remember", { fact: "User likes chai" }), { role: "assistant", content: "noted" }];
  await handleUpdate(msg("mujhe chai pasand hai"), env);
  assert.deepEqual(sent(), ["noted"]);
  // the tool result was fed back to the model
  assert.equal(llmCalls()[1].body.messages.at(-1).role, "tool");

  await handleUpdate(msg("hi"), env);
  assert.match(llmCalls().at(-1).body.messages[0].content, /User likes chai/);

  await handleUpdate(msg("/memory"), env);
  assert.equal(sent().at(-1), "- User likes chai");
  await handleUpdate(msg("/memory clear"), env);
  await handleUpdate(msg("/memory"), env);
  assert.equal(sent().at(-1), "Abhi kuch yaad nahi.");
});

test("forget tool removes matching facts", async () => {
  const env = makeEnv();
  await env.CHAT.put("facts:42", JSON.stringify(["User likes chai", "User lives in Pune"]));
  llmQueue = [toolCall("forget", { match: "chai" }), { role: "assistant", content: "done" }];
  await handleUpdate(msg("chai bhool ja"), env);
  assert.deepEqual(JSON.parse(env.CHAT.m.get("facts:42")), ["User lives in Pune"]);
});

// ---- scheduled tasks ------------------------------------------------------------------------

test("set_reminder -> due task runs the agent and messages the user first", async () => {
  const env = makeEnv();
  llmQueue = [toolCall("set_reminder", { text: "Remind me to drink water", in_minutes: 5 }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("5 min baad paani yaad dilana"), env);
  const [task] = JSON.parse(env.CHAT.m.get("reminders"));
  assert.equal(task.chatId, 42);

  await runDue(env, Date.now() + 60_000); // not due yet
  assert.equal(sent().length, 1);

  llmReply = "Paani pi le!";
  await runDue(env, Date.now() + 6 * 60_000);
  assert.equal(sent().at(-1), "Paani pi le!");
  const run = llmCalls().at(-1);
  assert.match(run.body.messages.at(-1).content, /^\[Scheduled task\] Remind me to drink water/);
  // background runs are read-only: no writing memory, no scheduling, no cancelling
  assert.deepEqual(toolNames(run), ["list_reminders", "fetch_url"]);
  assert.deepEqual(JSON.parse(env.CHAT.m.get("reminders")), []);
});

test("recurring tasks are re-queued in the future, not repeated as a backlog", async () => {
  const env = makeEnv();
  const t0 = Date.now() + 1000;
  await env.CHAT.put("reminders", JSON.stringify([{ id: "a", chatId: 42, text: "brief", due: t0, every_minutes: 60 }]));

  await runDue(env, t0 + 5 * 3_600_000 + 10); // bot was "down" for 5 hours
  assert.equal(sent().length, 1); // fired once, not five times
  const [next] = JSON.parse(env.CHAT.m.get("reminders"));
  assert.equal(next.due, t0 + 6 * 3_600_000);
});

test("reminder validation, listing and cancelling", async () => {
  const env = makeEnv();
  llmQueue = [toolCall("set_reminder", { text: "x", in_minutes: 5, every_minutes: 1 }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("spam me"), env);
  assert.match(llmCalls()[1].body.messages.at(-1).content, /at least 10/); // quota protection
  assert.equal(env.CHAT.m.has("reminders"), false);

  await env.CHAT.put("reminders", JSON.stringify([{ id: "abc123", chatId: 42, text: "gym", due: Date.now() + 1e6 }]));
  llmQueue = [toolCall("list_reminders", {}), toolCall("cancel_reminder", { id: "nope" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("what's scheduled"), env);
  assert.match(llmCalls().at(-2).body.messages.at(-1).content, /abc123 \|.*\| gym/);
  assert.equal(llmCalls().at(-1).body.messages.at(-1).content, "No such id.");
});

// ---- web tool, boundaries, robustness -------------------------------------------------------

test("fetch_url returns page text without scripts or tags", async () => {
  llmQueue = [toolCall("fetch_url", { url: "https://page.test/x" }), { role: "assistant", content: "summary" }];
  await handleUpdate(msg("read this"), makeEnv());
  const toolMsg = llmCalls()[1].body.messages.at(-1).content;
  assert.match(toolMsg, /Hello & welcome/);
  assert.doesNotMatch(toolMsg, /evil|<p>/);
});

test("fetch_url refuses non-http schemes", async () => {
  llmQueue = [toolCall("fetch_url", { url: "file:///etc/passwd" }), { role: "assistant", content: "no" }];
  await handleUpdate(msg("read this"), makeEnv());
  assert.match(llmCalls()[1].body.messages.at(-1).content, /only http/);
});

test("TOOLS env restricts what the agent may do", async () => {
  await handleUpdate(msg("hi"), makeEnv({ TOOLS: "remember" }));
  assert.deepEqual(toolNames(llmCalls()[0]), ["remember"]);

  llmQueue = [toolCall("fetch_url", { url: "https://page.test/x" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("read"), makeEnv({ TOOLS: "remember" }));
  assert.match(llmCalls().at(-1).body.messages.at(-1).content, /unknown tool/);
});

test("models without tool support fall back to plain chat", async () => {
  rejectTools = true;
  await handleUpdate(msg("hi"), makeEnv());
  assert.deepEqual(sent(), ["hello from llm"]);
  assert.equal(llmCalls().length, 2);
  assert.equal(llmCalls()[1].body.tools, undefined);
});

test("a model stuck in a tool loop is stopped after 5 steps", async () => {
  llmQueue = Array.from({ length: 10 }, () => toolCall("list_reminders", {}));
  await handleUpdate(msg("loop"), makeEnv());
  assert.equal(llmCalls().length, 5);
  assert.match(sent()[0], /too many steps/);
});

// ---- webhook --------------------------------------------------------------------------------

test("webhook rejects a wrong or missing secret token", async () => {
  const env = makeEnv();
  const req = (headers) => new Request("https://w.test/webhook", { method: "POST", headers, body: JSON.stringify(msg("hi")) });
  const ctx = { waitUntil: () => {} };

  assert.equal((await worker.fetch(req({}), env, ctx)).status, 403);
  assert.equal((await worker.fetch(req({ "X-Telegram-Bot-Api-Secret-Token": "bad" }), env, ctx)).status, 403);
  assert.equal((await worker.fetch(req({ "X-Telegram-Bot-Api-Secret-Token": "s3cret" }), env, ctx)).status, 200);
});

test("webhook fails closed when no secret is configured", async () => {
  const env = makeEnv({ TELEGRAM_WEBHOOK_SECRET: undefined });
  const res = await worker.fetch(new Request("https://w.test/webhook", { method: "POST", body: "{}" }), env, { waitUntil() {} });
  assert.equal(res.status, 403);
});
