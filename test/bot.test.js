import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handleUpdate, runDue } from "../src/index.js";
import { complete, modelChain } from "../src/models.js";
import { ApprovalLock } from "../src/approval-lock.js";

const GROQ = "api.groq.com";
const NVIDIA = "integrate.api.nvidia.com";

let calls; // every outbound fetch: { url, body, headers }
let llmReply;
let llmQueue; // scripted assistant messages, consumed in order; then plain llmReply
let failHosts; // host -> HTTP status, or "throw" for a network error
let rejectTools; // every provider answers 400 when a request carries tools
let tgFiles; // file_id -> { bytes, size? } for files "uploaded" by the user
let transcript; // what Groq Whisper "hears"
let mcpCalls; // tools/call params received by the fake MCP server
let mcpRequests; // every request to the fake MCP server: { body, headers }
let mcpSse; // answer MCP requests as an event stream instead of JSON
let mcpDown; // fake MCP server answers 500
let mcpCallFail; // tools/call fails: "throw" (network), an HTTP status, or "iserror" (the tool reports an error)
let tgFail; // (url, body) => true makes that Telegram call answer 400

const MCP_TOOLS = [
  { name: "list_issues", description: "List issues.", inputSchema: { type: "object", properties: { repo: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
];
const JUDGE0_LANGS = [
  { id: 70, name: "Python (2.7.17)" }, { id: 71, name: "Python (3.8.1)" }, { id: 109, name: "Python (3.14.0)" },
  { id: 89, name: "Python for ML (3.11.2)" }, { id: 63, name: "JavaScript (Node.js 12.14.0)" },
];

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
  tgFiles = new Map();
  transcript = "kal subah 8 baje yaad dilana";
  mcpCalls = [];
  mcpRequests = [];
  mcpSse = false;
  mcpDown = false;
  mcpCallFail = null;
  tgFail = null;
  globalThis.fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null); // FormData stays as is
    calls.push({ url, body, headers: init?.headers });
    const host = new URL(url).host;
    if (tgFail?.(url, body)) return new Response("{}", { status: 400 });

    if (url.endsWith("/getFile")) {
      const f = tgFiles.get(body.file_id) ?? { bytes: new Uint8Array([1, 2, 3]) };
      return Response.json({ ok: true, result: { file_path: `files/${body.file_id}`, file_size: f.size ?? f.bytes.length } });
    }
    if (url.includes("/file/bot")) {
      const id = url.split("/files/")[1];
      return new Response((tgFiles.get(id) ?? { bytes: new Uint8Array([1, 2, 3]) }).bytes);
    }
    if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
      return failHosts[`${host}/stt`] ? new Response("no", { status: 500 }) : Response.json({ text: transcript });
    }
    if (url === "https://api.tavily.com/search") {
      return Response.json({ answer: "It is sunny.", results: [{ title: "Weather", url: "https://w.test/pune", content: "Pune 30C" }] });
    }
    if (url.startsWith("https://api.search.brave.com/")) {
      return Response.json({ web: { results: [{ title: "Brave hit", url: "https://b.test/1", description: "from brave" }] } });
    }
    if (url === "https://ce.judge0.com/languages") return Response.json(JUDGE0_LANGS);
    if (url.startsWith("https://ce.judge0.com/submissions")) {
      return Response.json({ status: { description: "Accepted" }, stdout: "42\n", stderr: null });
    }
    if (url === "https://mcp.test/rpc") {
      mcpRequests.push({ body, headers: init.headers });
      if (mcpDown) return new Response("down", { status: 500 });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result = {};
      if (body.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
      if (body.method === "tools/list") result = { tools: MCP_TOOLS };
      if (body.method === "tools/call") {
        if (mcpCallFail === "throw") throw new Error("socket hang up");
        if (typeof mcpCallFail === "number") return new Response("rejected", { status: mcpCallFail });
        if (mcpCallFail === "iserror") result = { isError: true, content: [{ type: "text", text: "permission denied" }] };
        else mcpCalls.push(body.params);
        if (mcpCallFail !== "iserror") result = { content: [{ type: "text", text: `ran ${body.params.name} ${JSON.stringify(body.params.arguments)}` }] };
      }
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return mcpSse
        ? new Response(`event: message\ndata: ${payload}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "sess1" } })
        : new Response(payload, { headers: { "content-type": "application/json", "mcp-session-id": "sess1" } });
    }

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
  assert.deepEqual(toolNames(llmCalls()[0]), ["fetch_url", "web_search", "run_code", "send_file"]); // no memory tools, no image tool
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
  assert.deepEqual(toolNames(run), ["list_reminders", "fetch_url", "web_search", "run_code", "list_watches"]);
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

// ======================================================================================
// Beyond text: search, code, files, voice, photos, documents, MCP apps and approvals
// ======================================================================================

const toolMsg = (n = -1) => llmCalls().at(n).body.messages.at(-1).content; // last message sent to the model on call n
const MCP = JSON.stringify([{ name: "gh", url: "https://mcp.test/rpc", headers: { Authorization: "Bearer t0k" } }]);
const callbackUpdate = (data, userId = 42) => ({
  callback_query: { id: "cb1", from: { id: userId }, data, message: { message_id: 7, chat: { id: 42 } } },
});
const callbackIdFromButtons = () => {
  const withButtons = calls.filter((c) => c.url.endsWith("/sendMessage") && c.body.reply_markup).at(-1);
  return withButtons.body.reply_markup.inline_keyboard[0][0].callback_data.slice(3); // "<id>:<hash>", what follows "ok:"
};

// ---- web search -----------------------------------------------------------------------------

test("web_search works keyless, with a Tavily key, or with only a Brave key", async () => {
  llmQueue = [toolCall("web_search", { query: "pune weather" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("weather?"), makeEnv());
  let req = calls.find((c) => c.url === "https://api.tavily.com/search");
  assert.equal(req.headers["x-tavily-access-mode"], "keyless");
  assert.equal(req.headers.authorization, undefined);
  assert.match(toolMsg(1), /Answer: It is sunny\.[\s\S]*https:\/\/w\.test\/pune/);

  calls = [];
  llmQueue = [toolCall("web_search", { query: "x" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("again"), makeEnv({ TAVILY_API_KEY: "tvly-1" }));
  req = calls.find((c) => c.url === "https://api.tavily.com/search");
  assert.equal(req.headers.authorization, "Bearer tvly-1");

  calls = [];
  llmQueue = [toolCall("web_search", { query: "x" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("again"), makeEnv({ BRAVE_API_KEY: "br-1" }));
  req = calls.find((c) => c.url.startsWith("https://api.search.brave.com/"));
  assert.equal(req.headers["x-subscription-token"], "br-1");
  assert.match(toolMsg(1), /Brave hit/);
});

// ---- running code ---------------------------------------------------------------------------

test("run_code picks the newest runtime for the language and returns the output", async () => {
  llmQueue = [toolCall("run_code", { language: "python", code: "print(6*7)" }), { role: "assistant", content: "42" }];
  await handleUpdate(msg("6*7?"), makeEnv());
  const submit = calls.find((c) => c.url.startsWith("https://ce.judge0.com/submissions"));
  assert.equal(submit.body.language_id, 109); // not 70/71 (old) and not "Python for ML"
  assert.equal(submit.body.source_code, "print(6*7)");
  assert.match(toolMsg(1), /Status: Accepted\nstdout:\n42/);
});

test("run_code rejects unknown languages", async () => {
  llmQueue = [toolCall("run_code", { language: "cobol", code: "x" }), { role: "assistant", content: "no" }];
  await handleUpdate(msg("run"), makeEnv());
  assert.match(toolMsg(1), /language must be one of/);
});

// ---- making files and images ----------------------------------------------------------------

test("send_file uploads a sanitized document to the chat", async () => {
  llmQueue = [toolCall("send_file", { filename: "my report/../x.csv", content: "a,b\n1,2" }), { role: "assistant", content: "sent" }];
  await handleUpdate(msg("csv bana"), makeEnv());
  const up = calls.find((c) => c.url.endsWith("/sendDocument"));
  assert.equal(up.body.get("chat_id"), "42");
  const file = up.body.get("document");
  assert.equal(file.name, "my report_.._x.csv");
  assert.equal(await file.text(), "a,b\n1,2");
});

test("generate_image needs the AI binding, then sends the picture", async () => {
  const ai = { run: async (model, input) => ({ image: btoa("fakejpeg"), model, input }) };
  llmQueue = [toolCall("generate_image", { prompt: "a red fox" }), { role: "assistant", content: "done" }];
  await handleUpdate(msg("fox ki photo bana"), makeEnv({ AI: ai }));
  const up = calls.find((c) => c.url.endsWith("/sendPhoto"));
  assert.equal(up.body.get("caption"), "a red fox");
  assert.equal(await up.body.get("photo").text(), "fakejpeg");
  assert.match(toolMsg(1), /Image sent/);
});

// ---- voice, photos, documents the user sends ------------------------------------------------

test("a voice note is transcribed, echoed back, and answered like text", async () => {
  await handleUpdate({ message: { voice: { file_id: "v1" }, chat: { id: 42 }, from: { id: 42 } } }, makeEnv());
  assert.equal(sent()[0], "🎤 kal subah 8 baje yaad dilana");
  assert.equal(llmCalls()[0].body.messages.at(-1).content, "kal subah 8 baje yaad dilana");
  const stt = calls.find((c) => c.url.endsWith("/audio/transcriptions"));
  assert.equal(stt.body.get("model"), "whisper-large-v3-turbo");
  assert.equal(stt.headers.authorization, "Bearer groq-key");
});

test("voice falls back to Workers AI when Groq fails; with neither, the user is told what to set", async () => {
  const ai = { run: async () => ({ text: "from workers ai" }) };
  failHosts["api.groq.com/stt"] = true;
  await handleUpdate({ message: { voice: { file_id: "v1" }, chat: { id: 42 }, from: { id: 42 } } }, makeEnv({ AI: ai }));
  assert.equal(sent()[0], "🎤 from workers ai");

  calls = [];
  await handleUpdate({ message: { voice: { file_id: "v1" }, chat: { id: 42 }, from: { id: 42 } } }, makeEnv({ GROQ_API_KEY: undefined }));
  assert.match(sent().at(-1), /GROQ_API_KEY/);
  assert.equal(llmCalls().length, 0);
});

test("a photo goes to a vision model as an image, and history keeps only a text stand-in", async () => {
  const env = makeEnv();
  const update = { message: { photo: [{ file_id: "small" }, { file_id: "big" }], caption: "ye kya hai", chat: { id: 42 }, from: { id: 42 } } };
  await handleUpdate(update, env);

  const call = llmCalls()[0];
  assert.equal(call.body.model, "meta/llama-3.2-90b-vision-instruct"); // only NVIDIA has a vision model here
  const content = call.body.messages.at(-1).content;
  assert.equal(content[0].text, "ye kya hai");
  assert.equal(content[1].image_url.url, "data:image/jpeg;base64,AQID"); // bytes 1,2,3
  assert.ok(calls.some((c) => c.url.endsWith("/getFile") && c.body.file_id === "big")); // the largest size
  assert.equal(JSON.parse(env.CHAT.m.get("history:42"))[0].content, "[photo] ye kya hai");
});

test("a photo with no vision-capable key explains what to set", async () => {
  const update = { message: { photo: [{ file_id: "p" }], chat: { id: 42 }, from: { id: 42 } } };
  await handleUpdate(update, makeEnv({ NVIDIA_API_KEY: undefined }));
  assert.match(sent().at(-1), /GEMINI_API_KEY/);
});

test("a text document is read directly; PDFs go through Workers AI toMarkdown", async () => {
  tgFiles.set("d1", { bytes: new TextEncoder().encode("hello file") });
  const textDoc = { document: { file_id: "d1", file_name: "notes.txt", mime_type: "text/plain" }, caption: "summary de", chat: { id: 42 }, from: { id: 42 } };
  await handleUpdate({ message: textDoc }, makeEnv());
  assert.equal(llmCalls()[0].body.messages.at(-1).content, "summary de\n\n[File: notes.txt]\nhello file");

  const pdf = { document: { file_id: "d2", file_name: "cv.pdf", mime_type: "application/pdf" }, chat: { id: 42 }, from: { id: 42 } };
  const ai = { toMarkdown: async ([f]) => [{ name: f.name, format: "markdown", data: "# Resume" }] };
  await handleUpdate({ message: pdf }, makeEnv({ AI: ai }));
  assert.match(llmCalls().at(-1).body.messages.at(-1).content, /\[File: cv\.pdf\]\n# Resume/);

  await handleUpdate({ message: pdf }, makeEnv()); // no AI binding
  assert.match(sent().at(-1), /\[ai\] binding/);
});

test("oversized files are refused before downloading", async () => {
  tgFiles.set("huge", { bytes: new Uint8Array(1), size: 50_000_000 });
  await handleUpdate({ message: { document: { file_id: "huge", file_name: "a.txt", mime_type: "text/plain" }, chat: { id: 42 }, from: { id: 42 } } }, makeEnv());
  assert.match(sent().at(-1), /bahut badi/);
  assert.equal(calls.filter((c) => c.url.includes("/file/bot")).length, 0);
});

test("media from users who are not allowed is never downloaded", async () => {
  await handleUpdate({ message: { voice: { file_id: "v1" }, chat: { id: 7 }, from: { id: 7 } } }, makeEnv());
  assert.equal(calls.length, 0);
});

test("fetch_url asks a reader service to render JavaScript pages, unless disabled", async () => {
  globalThis.fetch = ((orig) => async (url, init) => {
    if (url === "https://spa.test/app") return new Response("<html><div id=root></div></html>", { headers: { "content-type": "text/html" } });
    if (url === "https://r.jina.ai/https://spa.test/app") return new Response("Rendered article text ".repeat(20));
    return orig(url, init);
  })(globalThis.fetch);

  llmQueue = [toolCall("fetch_url", { url: "https://spa.test/app" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("read"), makeEnv());
  assert.match(toolMsg(1), /Rendered article text/);

  calls = [];
  llmQueue = [toolCall("fetch_url", { url: "https://spa.test/app" }), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("read"), makeEnv({ JINA_FALLBACK: "0" }));
  assert.equal(calls.filter((c) => c.url.startsWith("https://r.jina.ai")).length, 0);
});

// ---- MCP apps and approvals -----------------------------------------------------------------

test("MCP tools are discovered, cached, and read-only ones run without asking", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  llmQueue = [toolCall("gh__list_issues", { repo: "me/app" }), { role: "assistant", content: "2 issues" }];
  await handleUpdate(msg("issues dikha"), env);

  assert.deepEqual(toolNames(llmCalls()[0]).filter((n) => n.startsWith("gh__")), ["gh__create_issue", "gh__list_issues"]);
  assert.deepEqual(mcpCalls, [{ name: "list_issues", arguments: { repo: "me/app" } }]);
  assert.match(toolMsg(1), /ran list_issues/);
  const methods = mcpRequests.map((r) => r.body.method);
  assert.deepEqual(methods.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
  assert.equal(mcpRequests[0].headers.Authorization, "Bearer t0k");
  assert.equal(mcpRequests.find((r) => r.body.method === "tools/call").headers["mcp-session-id"], "sess1");

  await handleUpdate(msg("phir se"), env);
  assert.equal(mcpRequests.filter((r) => r.body.method === "tools/list").length, 1); // second message used the cache
});

test("MCP servers that answer with an event stream work too", async () => {
  mcpSse = true;
  llmQueue = [toolCall("gh__list_issues", {}), { role: "assistant", content: "ok" }];
  await handleUpdate(msg("issues"), makeEnv({ MCP_SERVERS: MCP }));
  assert.match(toolMsg(1), /ran list_issues/);
});

test("an MCP server that is down doesn't break the bot", async () => {
  mcpDown = true;
  await handleUpdate(msg("hi"), makeEnv({ MCP_SERVERS: MCP }));
  assert.deepEqual(sent(), ["hello from llm"]);
  assert.equal(toolNames(llmCalls()[0]).some((n) => n.startsWith("gh__")), false);
});

test("risky MCP calls wait for a button tap; Approve runs them exactly once", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  llmQueue = [toolCall("gh__create_issue", { title: "bug" }), { role: "assistant", content: "Approval ka wait hai" }];
  await handleUpdate(msg("issue bana"), env);

  assert.deepEqual(mcpCalls, []); // nothing ran yet
  const ask = calls.find((c) => c.url.endsWith("/sendMessage") && c.body.reply_markup);
  assert.match(ask.body.text, /Approval chahiye\nAction: gh__create_issue[\s\S]*"title": "bug"/);
  assert.match(toolMsg(1), /NOT executed yet/);
  assert.equal(sent().at(-1), "Approval ka wait hai");

  const id = callbackIdFromButtons();
  await handleUpdate(callbackUpdate(`ok:${id}`), env);
  assert.deepEqual(mcpCalls, [{ name: "create_issue", arguments: { title: "bug" } }]);
  assert.match(sent().at(-1), /✅ Ho gaya \(gh__create_issue\)[\s\S]*ran create_issue/);
  assert.ok(calls.some((c) => c.url.endsWith("/editMessageReplyMarkup"))); // buttons removed
  assert.match(JSON.parse(env.CHAT.m.get("history:42")).at(-1).content, /approved and gh__create_issue ran/);

  await handleUpdate(callbackUpdate(`ok:${id}`), env); // double tap
  assert.equal(mcpCalls.length, 1);
  assert.match(sent().at(-1), /expire/);
});

test("Reject cancels, and taps from other users do nothing", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  llmQueue = [toolCall("gh__create_issue", { title: "bug" }), { role: "assistant", content: "wait" }];
  await handleUpdate(msg("issue bana"), env);
  const id = callbackIdFromButtons();

  const before = calls.length;
  await handleUpdate(callbackUpdate(`ok:${id}`, 7), env); // stranger
  assert.equal(calls.length, before);
  assert.equal(mcpCalls.length, 0);

  await handleUpdate(callbackUpdate(`no:${id}`), env);
  assert.equal(mcpCalls.length, 0);
  assert.match(sent().at(-1), /cancel/);
  assert.match(JSON.parse(env.CHAT.m.get("history:42")).at(-1).content, /rejected gh__create_issue/);
});

test("AUTO_APPROVE lets chosen tools run without asking", async () => {
  llmQueue = [toolCall("gh__create_issue", { title: "bug" }), { role: "assistant", content: "done" }];
  await handleUpdate(msg("issue bana"), makeEnv({ MCP_SERVERS: MCP, AUTO_APPROVE: "gh__create_*" }));
  assert.deepEqual(mcpCalls, [{ name: "create_issue", arguments: { title: "bug" } }]);
  assert.equal(calls.some((c) => c.body?.reply_markup), false);
});

test("background runs only get read-only MCP tools; TOOLS can allow a whole server with a wildcard", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await env.CHAT.put("reminders", JSON.stringify([{ id: "a", chatId: 42, text: "check issues", due: Date.now() - 1 }]));
  await runDue(env);
  assert.deepEqual(toolNames(llmCalls()[0]).filter((n) => n.startsWith("gh__")), ["gh__list_issues"]);

  calls = [];
  await handleUpdate(msg("hi"), makeEnv({ MCP_SERVERS: MCP, TOOLS: "gh__*" }));
  assert.deepEqual(toolNames(llmCalls()[0]), ["gh__create_issue", "gh__list_issues"]);
});

test("/tools lists everything the bot can do and marks the ones that need approval", async () => {
  await handleUpdate(msg("/tools"), makeEnv({ MCP_SERVERS: MCP }));
  const text = sent().at(-1);
  assert.match(text, /• web_search/);
  assert.match(text, /• gh__list_issues/);
  assert.match(text, /✋ gh__create_issue/);
  assert.doesNotMatch(text, /generate_image/); // no AI binding
});

test("MCP_SERVERS must be https and valid JSON, otherwise it is ignored", async () => {
  await handleUpdate(msg("hi"), makeEnv({ MCP_SERVERS: JSON.stringify([{ name: "bad", url: "http://insecure.test/rpc" }]) }));
  await handleUpdate(msg("hi"), makeEnv({ MCP_SERVERS: "{not json" }));
  assert.equal(calls.some((c) => c.url.includes("insecure.test")), false); // never contacted over plain http
  assert.equal(mcpRequests.length, 0);
  assert.deepEqual(sent(), ["hello from llm", "hello from llm"]);
});

// ---- approvals: content binding, expiry, concurrency, outcomes ------------------------------

const requestIssue = async (env, args = { title: "bug" }, id = "c1") => {
  llmQueue = [toolCall("gh__create_issue", args, id), { role: "assistant", content: "wait" }];
  await handleUpdate(msg("issue bana"), env);
};
const pendingKeys = (env) => [...env.CHAT.m.keys()].filter((k) => k.startsWith("pending:"));
const readPending = (env, payload) => JSON.parse(env.CHAT.m.get(`pending:${payload.split(":")[0]}`));
const tap = (env, payload, action = "ok") => handleUpdate(callbackUpdate(`${action}:${payload}`), env);

const lockNamespace = () => {
  const store = new Map();
  const storage = {
    get: async (k) => store.get(k),
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    list: async () => new Map(store),
  };
  const lock = new ApprovalLock({ storage });
  let queue = Promise.resolve(); // a Durable Object handles one request at a time
  const next = (url, init) => (queue = queue.then(() => lock.fetch(new Request(url, init))));
  return { idFromName: (n) => n, get: () => ({ fetch: next }), store };
};

test("approval buttons are bound to the request: no hash, a wrong hash, or an altered request never runs", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await requestIssue(env);
  const payload = callbackIdFromButtons();
  const [id] = payload.split(":");

  await tap(env, id); // button without a hash
  assert.match(sent().at(-1), /badal gayi/);
  await tap(env, `${id}:000000000000`); // some other request's hash
  assert.match(sent().at(-1), /badal gayi/);
  await tap(env, `${id}:${payload.split(":")[1].slice(0, 1)}`); // a prefix that matches but is too short to mean anything
  assert.match(sent().at(-1), /badal gayi/);

  const record = readPending(env, payload);
  record.args.title = "something else"; // the parked call is altered after the user was asked
  env.CHAT.m.set(`pending:${id}`, JSON.stringify(record));
  await tap(env, payload);
  assert.match(sent().at(-1), /badal gayi/);
  assert.deepEqual(mcpCalls, []);
});

test("an approval that expired does not run, even if its KV entry is still there", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await requestIssue(env);
  const payload = callbackIdFromButtons();
  const record = readPending(env, payload);
  env.CHAT.m.set(`pending:${payload.split(":")[0]}`, JSON.stringify({ ...record, expiresAt: Date.now() - 1 }));

  await tap(env, payload);
  assert.deepEqual(mcpCalls, []);
  assert.match(sent().at(-1), /expire/);
});

test("arguments too long for the message are attached in full before the buttons appear", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  const title = "x".repeat(5000);
  await requestIssue(env, { title });

  const doc = calls.find((c) => c.url.endsWith("/sendDocument"));
  assert.match(await doc.body.get("document").text(), new RegExp(`"title": "x{5000}"`));
  const ask = calls.find((c) => c.url.endsWith("/sendMessage") && c.body.reply_markup);
  assert.ok(calls.indexOf(doc) < calls.indexOf(ask)); // the file comes first
  assert.ok(ask.body.text.length < 4096);
  assert.match(ask.body.text, /poora content upar file mein/);
});

test("if the user can't be asked, nothing stays pending and the model is told", async () => {
  for (const fails of [(url) => url.endsWith("/sendDocument"), (url, body) => url.endsWith("/sendMessage") && body.reply_markup]) {
    tgFail = fails;
    const env = makeEnv({ MCP_SERVERS: MCP });
    await requestIssue(env, { title: "x".repeat(5000) });
    assert.match(toolMsg(1), /could not ask the user for approval/);
    assert.deepEqual([...env.CHAT.m.keys()].filter((k) => k.startsWith("pending")), []);
    assert.deepEqual(mcpCalls, []);
  }
});

test("the model repeating a risky call doesn't stack up identical prompts", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  llmQueue = [toolCall("gh__create_issue", { title: "bug" }, "c1"), toolCall("gh__create_issue", { title: "bug" }, "c2"), { role: "assistant", content: "wait" }];
  await handleUpdate(msg("issue bana"), env);

  assert.equal(calls.filter((c) => c.url.endsWith("/sendMessage") && c.body.reply_markup).length, 1);
  assert.match(toolMsg(2), /already waiting/);
  assert.equal(pendingKeys(env).length, 1);

  // A different call (other arguments) is a different request.
  llmQueue = [toolCall("gh__create_issue", { title: "another" }), { role: "assistant", content: "wait" }];
  await handleUpdate(msg("ek aur"), env);
  assert.equal(pendingKeys(env).length, 2);
});

test("simultaneous taps run the action once when the Durable Object lock is bound", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP, APPROVAL_LOCK: lockNamespace() });
  await requestIssue(env);
  const payload = callbackIdFromButtons();

  await Promise.all([tap(env, payload), tap(env, payload), tap(env, payload, "no")]);
  assert.equal(mcpCalls.length + (sent().filter((t) => /cancel/.test(t)).length), 1); // one decision in total: run or cancel
  assert.equal(sent().filter((t) => /expire ho gayi ya pehle hi/.test(t)).length, 2); // the others were told it's done
  assert.equal(env.APPROVAL_LOCK.store.size, 1);
});

test("ApprovalLock: the first claim wins, later ones lose, and old claims are forgotten", async () => {
  const store = new Map([["ancient", { decision: "approve", at: Date.now() - 25 * 3600 * 1000 }]]);
  const lock = new ApprovalLock({ storage: { get: async (k) => store.get(k), put: async (k, v) => void store.set(k, v), delete: async (k) => void store.delete(k), list: async () => new Map(store) } });
  const claim = async (id, decision) => (await lock.fetch(new Request("https://lock/claim", { method: "POST", body: JSON.stringify({ id, decision }) }))).json();

  assert.deepEqual(await claim("a1", "approve"), { won: true });
  assert.deepEqual(await claim("a1", "approve"), { won: false, decision: "approve" });
  assert.deepEqual(await claim("a1", "deny"), { won: false, decision: "approve" });
  assert.deepEqual(await claim("b2", "deny"), { won: true });
  assert.equal(store.has("ancient"), false);
});

test("a call whose outcome is uncertain is reported as unknown, recorded, and never retried", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await requestIssue(env);
  const payload = callbackIdFromButtons();
  mcpCallFail = "throw"; // the connection drops after the request was sent

  await tap(env, payload);
  assert.match(sent().at(-1), /⚠️ Pata nahi chala \(gh__create_issue\)[\s\S]*Dobara mat chala/);
  assert.equal(readPending(env, payload).status, "outcome_unknown");
  assert.match(JSON.parse(env.CHAT.m.get("history:42")).at(-1).content, /outcome is unknown[\s\S]*Never retry/);

  mcpCallFail = null;
  await tap(env, payload); // tapping again must not run it
  assert.equal(mcpRequests.filter((r) => r.body.method === "tools/call").length, 1);
  assert.deepEqual(mcpCalls, []);
});

test("a server error (5xx) is unknown too, but an answer that says no is a plain failure", async () => {
  for (const [fail, status, shown] of [[500, "outcome_unknown", /Pata nahi chala/], [400, "failed", /❌ Fail ho gaya/], ["iserror", "failed", /❌ Fail ho gaya[\s\S]*permission denied/]]) {
    mcpCallFail = null;
    const env = makeEnv({ MCP_SERVERS: MCP });
    await requestIssue(env);
    const payload = callbackIdFromButtons();
    mcpCallFail = fail;
    await tap(env, payload);
    assert.match(sent().at(-1), shown);
    assert.equal(readPending(env, payload).status, status);
    assert.doesNotMatch(sent().at(-1), /✅/);
  }
});

test("a successful approval is recorded with its result", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await requestIssue(env);
  const payload = callbackIdFromButtons();
  await tap(env, payload);

  const record = readPending(env, payload);
  assert.equal(record.status, "succeeded");
  assert.match(record.result, /ran create_issue/);
  assert.equal(env.CHAT.m.has(`pending-dup:${record.hash.slice(0, 16)}`), false); // the same call can be asked again later
});

test("if recording the outcome fails, the user still hears what happened", async () => {
  const env = makeEnv({ MCP_SERVERS: MCP });
  await requestIssue(env);
  const payload = callbackIdFromButtons();
  const put = env.CHAT.put;
  env.CHAT.put = async (key, value, opts) => {
    if (key.startsWith("pending:") && value.includes('"status":"succeeded"')) throw new Error("KV down");
    return put(key, value, opts);
  };
  await tap(env, payload);
  assert.deepEqual(mcpCalls, [{ name: "create_issue", arguments: { title: "bug" } }]);
  assert.match(sent().at(-1), /✅ Ho gaya \(gh__create_issue\)/);
});
