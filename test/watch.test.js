import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { checkWatches, WATCH_TOOLS } from "../src/watch.js";

const MIN = 60_000;
let calls; // every outbound fetch: { url, body }
let pages; // url -> { html, status? } or "throw"
let puts; // KV writes since the last reset

const kv = () => {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, put: async (k, v) => (puts++, void m.set(k, v)), delete: async (k) => void m.delete(k), m };
};
const makeEnv = (over = {}) => ({ TELEGRAM_BOT_TOKEN: "TOKEN", ALLOWED_USER_IDS: "42", JINA_FALLBACK: "0", CHAT: kv(), ...over });
const watches = (env) => JSON.parse(env.CHAT.m.get("watches") || "[]");
const alerts = () => calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => c.body.text);
const watch = (env, args, chatId = 42) => WATCH_TOOLS.watch_page.run(env, { chatId }, args);
const setPage = (url, text, status = 200) => (pages[url] = { html: `<html><p>${text}</p></html>`, status });

beforeEach(() => {
  calls = [];
  pages = {};
  puts = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (url.includes("api.telegram.org")) return Response.json({ ok: true });
    const page = pages[url];
    if (page === "throw") throw new Error("connection refused");
    if (!page) return new Response("not found", { status: 404 });
    return new Response(page.html, { status: page.status, headers: { "content-type": "text/html" } });
  };
});

const filler = " lorem ipsum".repeat(30); // keeps pages above the "looks JavaScript-rendered" threshold

test("a new watch takes a baseline and does not alert; unchanged pages stay quiet; a change alerts once", async () => {
  const env = makeEnv();
  setPage("https://shop.test/a", `Price list${filler}`);
  const reply = await watch(env, { url: "https://shop.test/a", title: "Shop page" });
  assert.match(reply, /Watching https:\/\/shop.test\/a .*every 60 min/);
  const [w] = watches(env);
  assert.equal(w.checks, 1);

  await checkWatches(env, Date.now() + 30 * MIN); // not due yet: no fetch beyond the creation read
  assert.equal(calls.filter((c) => c.url === "https://shop.test/a").length, 1);

  await checkWatches(env, Date.now() + 61 * MIN); // due, same page
  assert.deepEqual(alerts(), []);

  setPage("https://shop.test/a", `Price list NEW ITEM${filler}`);
  await checkWatches(env, Date.now() + 122 * MIN);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /🔔 Shop page\nPage badal gaya\.\nhttps:\/\/shop.test\/a[\s\S]*NEW ITEM/);

  await checkWatches(env, Date.now() + 183 * MIN); // the new version is the baseline now: no repeat
  assert.equal(alerts().length, 1);
  assert.equal(watches(env)[0].checks, 4);
});

test("contains: alerts when the text appears, not on every check while it stays, and again after it left", async () => {
  const env = makeEnv();
  setPage("https://t.test/x", `Sold out${filler}`);
  await watch(env, { url: "https://t.test/x", condition: "contains", value: "tickets available", every_minutes: 30 });

  let now = Date.now();
  const tick = async () => checkWatches(env, (now += 31 * MIN));
  await tick();
  assert.deepEqual(alerts(), []);

  setPage("https://t.test/x", `TICKETS AVAILABLE now${filler}`); // case-insensitive
  await tick();
  assert.equal(alerts().length, 1);
  await tick();
  await tick(); // still true: no repeat
  assert.equal(alerts().length, 1);

  setPage("https://t.test/x", `Sold out${filler}`);
  await tick();
  setPage("https://t.test/x", `Tickets available again${filler}`);
  await tick();
  assert.equal(alerts().length, 2);
});

test("contains: a page that already matches when the watch is created doesn't alert straight away", async () => {
  const env = makeEnv();
  setPage("https://t.test/y", `In stock${filler}`);
  const reply = await watch(env, { url: "https://t.test/y", condition: "contains", value: "in stock" });
  assert.match(reply, /already matches right now/);
  await checkWatches(env, Date.now() + 61 * MIN);
  assert.deepEqual(alerts(), []);
});

test("price_below: finds the lowest USD price, handles thousands separators, alerts on the way down only", async () => {
  const env = makeEnv();
  setPage("https://p.test/1", `Laptop $1,299.00 and USD 1,150${filler}`);
  await watch(env, { url: "https://p.test/1", condition: "price_below", value: "1000", title: "Laptop" });

  let now = Date.now();
  await checkWatches(env, (now += 61 * MIN));
  assert.deepEqual(alerts(), []); // 1,150 is not below 1000

  setPage("https://p.test/1", `Laptop now $899.99${filler}`);
  await checkWatches(env, (now += 61 * MIN));
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /Price \$899.99 hai, tere \$1000 se kam/);

  await checkWatches(env, (now += 61 * MIN));
  assert.equal(alerts().length, 1);
});

test("failures back off exponentially, a success resets them, and five in a row pause the watch with one notice", async () => {
  const env = makeEnv();
  setPage("https://f.test/1", `fine${filler}`);
  await watch(env, { url: "https://f.test/1", every_minutes: 30, title: "Flaky" });
  pages["https://f.test/1"] = "throw";

  let now = Date.now() + 31 * MIN;
  await checkWatches(env, now);
  let [w] = watches(env);
  assert.equal(w.failures, 1);
  assert.equal(Math.round((w.nextCheckAt - now) / MIN), 60); // 30 * 2^1
  await checkWatches(env, now + 59 * MIN); // still backing off
  assert.equal(watches(env)[0].failures, 1);

  now = w.nextCheckAt;
  await checkWatches(env, now);
  [w] = watches(env);
  assert.equal(w.failures, 2);
  assert.equal(Math.round((w.nextCheckAt - now) / MIN), 120);

  setPage("https://f.test/1", `fine${filler}`); // recovers
  await checkWatches(env, w.nextCheckAt);
  assert.equal(watches(env)[0].failures, 0);

  pages["https://f.test/1"] = "throw";
  for (let i = 0; i < 5; i++) await checkWatches(env, watches(env)[0].nextCheckAt);
  [w] = watches(env);
  assert.equal(w.status, "paused");
  assert.match(w.error, /connection refused/);
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /⏸ Watch "Flaky" 5 baar fail hua[\s\S]*pause/);

  const before = calls.length;
  await checkWatches(env, Date.now() + 10_000 * MIN); // paused watches are not checked
  assert.equal(calls.length, before);
});

test("an oversized page counts as a failure", async () => {
  const env = makeEnv();
  setPage("https://e.test/1", `ok${filler}`);
  await watch(env, { url: "https://e.test/1", every_minutes: 30 });
  globalThis.fetch = async () => new Response("x", { headers: { "content-length": "9999999", "content-type": "text/html" } });
  await checkWatches(env, Date.now() + 31 * MIN);
  assert.equal(watches(env)[0].failures, 1);
  assert.match(watches(env)[0].error, /too large/);
});

test("an outage page (503) is a failure to back off from, not \"the page changed\"", async () => {
  const env = makeEnv();
  setPage("https://e.test/2", `ok${filler}`);
  await watch(env, { url: "https://e.test/2", every_minutes: 30 });
  setPage("https://e.test/2", `Service Unavailable${filler}`, 503);
  await checkWatches(env, Date.now() + 31 * MIN);
  assert.equal(watches(env)[0].failures, 1);
  assert.match(watches(env)[0].error, /HTTP 503/);
  assert.deepEqual(alerts(), []);

  setPage("https://e.test/2", `ok${filler}`); // back up with the same content: still nothing to report
  await checkWatches(env, watches(env)[0].nextCheckAt);
  assert.equal(watches(env)[0].failures, 0);
  assert.deepEqual(alerts(), []);
});

test("a page that already errors is not watched in the first place", async () => {
  const env = makeEnv();
  setPage("https://e.test/gone", "Not found", 404);
  await assert.rejects(watch(env, { url: "https://e.test/gone" }), /could not read https:\/\/e.test\/gone \(HTTP 404\), so it was not watched/);
  assert.deepEqual(watches(env), []);
});

test("nothing due means no KV write; a due check writes once; at most 3 checks run per tick", async () => {
  const env = makeEnv();
  for (const n of [1, 2, 3, 4]) {
    setPage(`https://m.test/${n}`, `page ${n}${filler}`);
    await watch(env, { url: `https://m.test/${n}`, every_minutes: 30 });
  }
  puts = 0;
  await checkWatches(env, Date.now() + 5 * MIN);
  assert.equal(puts, 0);

  const before = calls.length;
  await checkWatches(env, Date.now() + 31 * MIN);
  assert.equal(calls.length - before, 3); // the fourth waits for the next tick
  assert.equal(puts, 1);
  assert.equal(watches(env).length, 4); // the write kept every watch, due or not
  await checkWatches(env, Date.now() + 32 * MIN);
  assert.equal(watches(env).every((w) => w.checks === 2), true);
});

test("a watch stopped or created while checks were running is neither resurrected nor lost", async () => {
  const env = makeEnv();
  setPage("https://r.test/1", `one${filler}`);
  setPage("https://r.test/2", `two${filler}`);
  await watch(env, { url: "https://r.test/1", every_minutes: 30 });
  const [first] = watches(env);

  let interfered = false;
  globalThis.fetch = async (url) => {
    if (url === "https://r.test/1" && !interfered) {
      // While the check of r.test/1 is in flight the user stops it and creates another watch.
      interfered = true;
      const list = watches(env).filter((w) => w.id !== first.id);
      list.push({ id: "new123", chatId: 42, title: "New", url: "https://r.test/2", condition: "change", value: "", every: 60, status: "active", checks: 1, failures: 0, nextCheckAt: Date.now() + 99 * MIN });
      env.CHAT.m.set("watches", JSON.stringify(list));
    }
    return new Response(`<p>changed ${filler}</p>`, { headers: { "content-type": "text/html" } });
  };
  await checkWatches(env, Date.now() + 31 * MIN);
  assert.deepEqual(watches(env).map((w) => w.id), ["new123"]);
  assert.deepEqual(alerts(), []); // no alert for a watch that was stopped
});

test("validation: bad input is refused and nothing is stored; an unreachable page is refused up front", async () => {
  const env = makeEnv();
  setPage("https://v.test/1", `fine${filler}`);
  const bad = [
    [{ url: "ftp://x" }, /only http\(s\)/],
    [{ url: "https://v.test/1", condition: "nope" }, /condition must be one of/],
    [{ url: "https://v.test/1", condition: "contains" }, /value is required/],
    [{ url: "https://v.test/1", condition: "price_below", value: "cheap" }, /positive USD price/],
    [{ url: "https://v.test/1", every_minutes: 5 }, /at least 30/],
  ];
  for (const [args, expected] of bad) assert.match(await watch(env, args), expected);
  pages["https://v.test/down"] = "throw";
  await assert.rejects(watch(env, { url: "https://v.test/down" }), /could not read .*connection refused/);
  assert.deepEqual(watches(env), []);

  assert.match(await watch(makeEnv({ WATCH_MIN_MINUTES: "120" }), { url: "https://v.test/1", every_minutes: 60 }), /at least 120/);
});

test("at most 5 watches per chat; list and stop only see your own", async () => {
  const env = makeEnv();
  setPage("https://l.test/1", `fine${filler}`);
  for (let i = 0; i < 5; i++) assert.match(await watch(env, { url: "https://l.test/1" }), /Watching/);
  assert.match(await watch(env, { url: "https://l.test/1" }), /limit of 5/);
  assert.match(await watch(env, { url: "https://l.test/1" }, 99), /Watching/); // another chat has its own allowance

  const list = await WATCH_TOOLS.list_watches.run(env, { chatId: 42 });
  assert.equal(list.split("\n").length, 5);
  const [id] = list.split(" | ");
  assert.equal(await WATCH_TOOLS.stop_watch.run(env, { chatId: 99 }, { id }), "No such id."); // not theirs
  assert.equal(await WATCH_TOOLS.stop_watch.run(env, { chatId: 42 }, { id }), "Stopped.");
  assert.equal(watches(env).length, 5);
  assert.equal(await WATCH_TOOLS.list_watches.run(makeEnv(), { chatId: 1 }), "No page watches.");
});

test("the cron trigger checks watches, in addition to reminders", async () => {
  const env = makeEnv();
  setPage("https://c.test/1", `a${filler}`);
  await watch(env, { url: "https://c.test/1", every_minutes: 30, title: "Cron page" });
  const w = { ...watches(env)[0], nextCheckAt: Date.now() - 1 }; // due now
  env.CHAT.m.set("watches", JSON.stringify([w]));
  setPage("https://c.test/1", `b${filler}`);

  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.match(alerts()[0], /🔔 Cron page/);
});
