import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handleUpdate, runDue } from "../src/index.js";
import { complete, modelChain } from "../src/models.js";

const GROQ = "api.groq.com";
const NVIDIA = "integrate.api.nvidia.com";

let calls; // every outbound fetch: { url, body }
let llmReply;
let llmQueue; // scripted assistant messages, consumed in order; then plain llmReply
let failHosts; // host -> HTTP status, or "throw" for a network error
let rejectTools; // every provider answers 400 when a request carries tools

const kv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k), m };
};

const makeEnv = (over = {}) => ({
  TELEGRAM_BOT_TOKEN: "TOKEN",
  TELEGRAM_WEBHOOK_SECRET: "s3cret",
  GROQ_API_KEY: "groq-key",
  NVIDIA_API_KEY: "nvidia-key",
  MODEL_CHAIN: "gpt-oss,deepseek,llama",
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
const llmCalls = () => calls.filter((c) => c.url.endsWith("/chat/completions"));
const hostOf = (call) => new URL(call.url).host;
const toolNames = (call) => (call.body.tools ?? []).map((t) => t.function.name);

beforeEach(() => {
  calls = [];
  llmReply = "hello from llm";
  llmQueue = [];
  failHosts = {};
  rejectTools = false;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init?.headers });
    const host = new URL(url).host;
    if (url.endsWith("/chat/completions")) {
      if (failHosts[host] === "throw") throw new Error("network down");
      if (failHosts[host]) return new Response("nope", { status: failHosts[host] });
      if (rejectTools && body.tools) return new Response("tools unsupported", { status: 400 });
      const message = llmQueue.shift() ?? { role: "assistant", content: llmReply };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "meta/llama-3.3-70b-instruct" }, { id: "deepseek-ai/deepseek-v3.1" }] }));
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

test("replies via the first model in the chain and remembers the conversation", async () => {
  const env = makeEnv();
  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("again"), env);

  assert.deepEqual(sent(), ["hello from llm", "hello from llm"]);
  assert.equal(hostOf(llmCalls()[1]), GROQ);
  assert.equal(llmCalls()[1].body.model, "openai/gpt-oss-120b");
  assert.equal(llmCalls()[1].headers.authorization, "Bearer groq-key");
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

test("/reset clears chat history; commands addressed to the bot (/reset@my_bot) work too", async () => {
  const env = makeEnv();
  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("/reset"), env);
  assert.equal(env.CHAT.m.has("history:42"), false);

  await handleUpdate(msg("hi"), env);
  await handleUpdate(msg("/reset@my_bot"), env);
  assert.equal(env.CHAT.m.has("history:42"), false);
});

test("long answers are split to fit Telegram's limit", async () => {
  llmReply = "x".repeat(9000);
  await handleUpdate(msg("hi"), makeEnv());
  assert.deepEqual(sent().map((t) => t.length), [4000, 4000, 1000]);
});

test("reasoning models' <think> blocks are not shown", async () => {
  llmReply = "<think>let me see...</think>The answer is 4.";
  await handleUpdate(msg("2+2?"), makeEnv());
  assert.deepEqual(sent(), ["The answer is 4."]);
});

test("works without a KV binding (stateless, memory tools hidden)", async () => {
  await handleUpdate(msg("hi"), makeEnv({ CHAT: undefined }));
  assert.deepEqual(sent(), ["hello from llm"]);
  assert.deepEqual(toolNames(llmCalls()[0]), ["fetch_url"]);
});

// ---- many models: picking, listing, fallback ------------------------------------------------

test("/model shows the order, switches model, rejects bad or keyless ones, and resets with auto", async () => {
  const env = makeEnv();
  await handleUpdate(msg("/model"), env);
  assert.match(sent().at(-1), /1\. groq:openai\/gpt-oss-120b\n2\. nvidia:deepseek-ai\/deepseek-v3\.1\n3\. nvidia:meta\/llama-3\.3-70b-instruct/);

  await handleUpdate(msg("/model llama"), env);
  assert.match(sent().at(-1), /nvidia:meta\/llama-3\.3-70b-instruct/);
  await handleUpdate(msg("hi"), env);
  assert.equal(hostOf(llmCalls().at(-1)), NVIDIA);
  assert.equal(llmCalls().at(-1).body.model, "meta/llama-3.3-70b-instruct");

  await handleUpdate(msg("/model nvidia:some/custom-model:free"), env); // any provider:model id, colons included
  await handleUpdate(msg("hi"), env);
  assert.equal(llmCalls().at(-1).body.model, "some/custom-model:free");

  await handleUpdate(msg("/model nonsense"), env);
  assert.match(sent().at(-1), /samajh nahi aaya/);
  await handleUpdate(msg("/model cerebras:x"), env);
  assert.match(sent().at(-1), /CEREBRAS_API_KEY/);

  await handleUpdate(msg("/model auto"), env);
  await handleUpdate(msg("hi"), env);
  assert.equal(llmCalls().at(-1).body.model, "openai/gpt-oss-120b");
});

test("rate-limited model falls through to the next one and says which answered", async () => {
  const env = makeEnv();
  failHosts[GROQ] = 429;
  await handleUpdate(msg("hi"), env);

  assert.deepEqual(llmCalls().map(hostOf), [GROQ, NVIDIA]);
  assert.equal(sent()[0], "hello from llm\n\n(via nvidia:deepseek-ai/deepseek-v3.1)");
  // the footer is for the user only, not stored in the conversation
  assert.equal(JSON.parse(env.CHAT.m.get("history:42")).at(-1).content, "hello from llm");
});

test("network errors and dead models also fall through", async () => {
  failHosts[GROQ] = "throw";
  await handleUpdate(msg("hi"), makeEnv());
  assert.match(sent()[0], /via nvidia:/);

  calls = [];
  failHosts = { [GROQ]: 404 };
  await handleUpdate(msg("hi"), makeEnv());
  assert.match(sent()[0], /via nvidia:/);
});

test("all models rate-limited -> friendly message; other failures list each model", async () => {
  failHosts = { [GROQ]: 429, [NVIDIA]: 429 };
  await handleUpdate(msg("hi"), makeEnv());
  assert.match(sent().at(-1), /Free limit/);

  failHosts = { [GROQ]: 500, [NVIDIA]: 404 };
  await handleUpdate(msg("hi"), makeEnv());
  assert.match(sent().at(-1), /groq:openai\/gpt-oss-120b: 500[\s\S]*nvidia:deepseek-ai\/deepseek-v3\.1: 404/);
});

test("only providers with a key are used; with none, the user is told which keys to set", async () => {
  await handleUpdate(msg("hi"), makeEnv({ GROQ_API_KEY: undefined }));
  assert.deepEqual(llmCalls().map(hostOf), [NVIDIA]);

  calls = [];
  await handleUpdate(msg("hi"), makeEnv({ GROQ_API_KEY: undefined, NVIDIA_API_KEY: undefined }));
  assert.equal(llmCalls().length, 0);
  assert.match(sent().at(-1), /GROQ_API_KEY.*NVIDIA_API_KEY/);
});

test("/models lists short names with key status, and live model ids with a filter", async () => {
  const env = makeEnv({ NVIDIA_API_KEY: undefined });
  await handleUpdate(msg("/models"), env);
  assert.match(sent().at(-1), /✅ gpt-oss -> groq:openai\/gpt-oss-120b/);
  assert.match(sent().at(-1), /❌ key nahi deepseek -> nvidia:deepseek-ai\/deepseek-v3\.1/);

  const env2 = makeEnv();
  await handleUpdate(msg("/models nvidia deepseek"), env2);
  assert.equal(sent().at(-1), "deepseek-ai/deepseek-v3.1");
  const req = calls.find((c) => c.url === "https://integrate.api.nvidia.com/v1/models");
  assert.equal(req.headers.authorization, "Bearer nvidia-key");

  await handleUpdate(msg("/models cerebras"), env2);
  assert.match(sent().at(-1), /CEREBRAS_API_KEY/);
});

test("/check tests every model in the chain and reports which work", async () => {
  failHosts[GROQ] = 500;
  await handleUpdate(msg("/check"), makeEnv());
  const lines = sent().at(-1).split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^❌ groq:openai\/gpt-oss-120b: 500/);
  assert.match(lines[1], /^✅ nvidia:deepseek-ai\/deepseek-v3\.1 \(/);
  assert.match(lines[2], /^✅ nvidia:meta\/llama-3\.3-70b-instruct \(/);
  assert.equal(llmCalls()[0].body.max_tokens, 16); // cheap probe
});

test("the time budget is enforced: an expired deadline makes no model calls", async () => {
  const env = makeEnv();
  await assert.rejects(complete(env, modelChain(env, null), [], [], Date.now() - 1), /Time budget/);
  assert.equal(llmCalls().length, 0);
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

test("if no model accepts tools, the chain is retried as plain chat", async () => {
  rejectTools = true;
  await handleUpdate(msg("hi"), makeEnv());
  assert.deepEqual(sent(), ["hello from llm"]);
  assert.equal(llmCalls().length, 4); // 3 rejected with tools, then the first model without
  assert.equal(llmCalls().at(-1).body.tools, undefined);
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
