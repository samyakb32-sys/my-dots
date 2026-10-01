// Page watcher: "tell me when this page changes / mentions X / shows a price under $Y".
// The cron trigger checks due watches and messages you directly, with no LLM call, so a watch costs no model quota.
// Modelled on OpenMuse's monitors: the first look is only a baseline, "contains" and "price_below" alert when the
// condition turns true (not on every check while it stays true), and repeated failures back off, then pause the watch.

import { readPage } from "./page.js";
import { sendMessage } from "./telegram.js";
import { obj, str, num, sha256Hex } from "./util.js";

const KEY = "watches";
const MAX_WATCHES = 5; // per chat
const DEFAULT_MINUTES = 60;
const MAX_FAILURES = 5; // consecutive failures before a watch pauses itself
const MAX_BACKOFF_MINUTES = 24 * 60;
const PER_TICK = 3; // checks per cron run, so one run stays inside the free plan's subrequest limit
const CONDITIONS = ["change", "contains", "price_below"];
const PRICE = /(?:\$|USD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g;

// Every check is one KV write (the next due time), and the free plan allows 1000 writes a day for everything.
// 5 watches at the 30-minute floor is at most 240 of them. WATCH_MIN_MINUTES can raise the floor (never below 10).
const minMinutes = (env) => Math.max(10, Number(env.WATCH_MIN_MINUTES) || 30);

const load = async (env) => JSON.parse((await env.CHAT?.get(KEY)) || "null") ?? [];
const save = (env, list) => env.CHAT.put(KEY, JSON.stringify(list));

function lowestPrice(text) {
  const prices = [...text.matchAll(PRICE)].map((m) => Number(m[1].replace(/,/g, "")));
  return prices.length ? Math.min(...prices) : null;
}

/** Does this page state satisfy the watch? `notify` is true only when it just became true. */
function evaluate(w, text, hash) {
  if (w.condition === "change") {
    const matched = w.lastHash !== hash; // creating the watch stored the baseline hash
    return { matched, notify: matched, reason: "Page badal gaya." };
  }
  if (w.condition === "contains") {
    const matched = text.toLowerCase().includes(w.value.toLowerCase());
    return { matched, notify: matched && !w.matched, reason: `Page par ab "${w.value}" likha hai.` };
  }
  const low = lowestPrice(text);
  const matched = low !== null && low < Number(w.value);
  return { matched, notify: matched && !w.matched, reason: `Price $${low} hai, tere $${w.value} se kam.` };
}

// An error page is not content: a 404 or 503 must not look like "the page changed".
async function readOk(env, url) {
  const page = await readPage(env, url);
  if (page.status >= 400) throw new Error(`HTTP ${page.status}`);
  return page;
}

async function checkOne(env, w, now) {
  try {
    const { text } = await readOk(env, w.url);
    const hash = await sha256Hex(text);
    const r = evaluate(w, text, hash);
    const next = {
      ...w, checks: w.checks + 1, failures: 0, error: undefined, lastHash: hash, matched: r.matched,
      lastCheckedAt: now, nextCheckAt: now + w.every * 60_000, lastSnippet: text.slice(0, 200),
    };
    const notice = r.notify ? `🔔 ${w.title}\n${r.reason}\n${w.url}\n\n${text.slice(0, 300)}` : null;
    return { watch: next, notice };
  } catch (e) {
    const failures = w.failures + 1;
    if (failures >= MAX_FAILURES) {
      return {
        watch: { ...w, failures, status: "paused", error: e.message, lastCheckedAt: now },
        notice: `⏸ Watch "${w.title}" ${failures} baar fail hua (${e.message}), isliye pause kar diya. Chahiye to naya watch bana.`,
      };
    }
    const wait = Math.min(w.every * 2 ** failures, MAX_BACKOFF_MINUTES);
    return { watch: { ...w, failures, error: e.message, lastCheckedAt: now, nextCheckAt: now + wait * 60_000 }, notice: null };
  }
}

/** Cron entry point: check the due watches, store the new state, then alert (at most once per change). */
export async function checkWatches(env, now = Date.now()) {
  if (!env.CHAT) return;
  const due = (await load(env)).filter((w) => w.status === "active" && w.nextCheckAt <= now).slice(0, PER_TICK);
  if (!due.length) return; // the common case: one KV read, no write
  const results = await Promise.all(due.map((w) => checkOne(env, w, now)));
  // Re-read before saving: a watch created or stopped while we were fetching must not be undone by our write.
  const fresh = await load(env);
  const updated = new Map(results.map((r) => [r.watch.id, r]));
  await save(env, fresh.map((w) => updated.get(w.id)?.watch ?? w));
  for (const { watch, notice } of results) {
    if (!notice || !fresh.some((w) => w.id === watch.id)) continue; // stopped meanwhile: stay quiet
    await sendMessage(env, watch.chatId, notice).catch((e) => console.error(e));
  }
}

export const WATCH_TOOLS = {
  watch_page: {
    kv: true,
    description:
      "Watch a web page and message the user when it changes, when it mentions some text, or when a USD price on it drops below a limit. " +
      "Use for 'tell me when tickets are back', 'alert me if this drops under $50'. Checked in the background; no need to poll.",
    parameters: obj(
      {
        url: str("Full http(s) URL of the page"),
        condition: { type: "string", enum: CONDITIONS, description: "change (default), contains (needs value: text to look for), price_below (needs value: USD limit, e.g. 49.99)" },
        value: str("Text to look for, or the USD price limit"),
        every_minutes: num(`Minutes between checks, default ${DEFAULT_MINUTES}, at least 30`),
        title: str("Short name for the alert, e.g. 'PS5 price'"),
      },
      ["url"],
    ),
    async run(env, { chatId }, { url, condition = "change", value = "", every_minutes, title }) {
      if (!/^https?:\/\//i.test(String(url))) return "Error: only http(s) URLs.";
      if (!CONDITIONS.includes(condition)) return `Error: condition must be one of ${CONDITIONS.join(", ")}.`;
      value = String(value).trim().slice(0, 200);
      if (condition !== "change" && !value) return "Error: value is required for this condition.";
      if (condition === "price_below" && !(Number(value) > 0)) return "Error: value must be a positive USD price, e.g. 49.99.";
      const every = Number(every_minutes ?? DEFAULT_MINUTES);
      const min = minMinutes(env);
      if (!(every >= min)) return `Error: every_minutes must be at least ${min}.`;
      if ((await load(env)).filter((w) => w.chatId === chatId).length >= MAX_WATCHES) {
        return `Error: limit of ${MAX_WATCHES} watches reached. Stop one first.`;
      }

      const { text } = await readOk(env, url).catch((e) => {
        throw new Error(`could not read ${url} (${e.message}), so it was not watched`); // fail now, not on the first background run
      });
      const hash = await sha256Hex(text);
      const now = Date.now();
      const w = {
        id: crypto.randomUUID().slice(0, 6), chatId, title: String(title || url).slice(0, 100), url, condition, value, every,
        status: "active", checks: 1, failures: 0, lastHash: hash, matched: false,
        lastCheckedAt: now, nextCheckAt: now + every * 60_000, lastSnippet: text.slice(0, 200),
      };
      w.matched = evaluate(w, text, hash).matched; // only remembered: creating a watch never alerts
      await save(env, [...(await load(env)), w]);
      const what = { change: "changes", contains: `mentions "${value}"`, price_below: `shows a price under $${value}` }[condition];
      return (
        `Watching ${url} (id ${w.id}), checking every ${every} min. The user gets a Telegram message when the page ${what}.` +
        (w.matched && condition !== "change" ? " It already matches right now, so the next alert comes only after it stops matching and matches again." : "")
      );
    },
  },

  list_watches: {
    kv: true,
    readOnly: true,
    description: "List the user's page watches.",
    parameters: obj({}),
    async run(env, { chatId }) {
      const mine = (await load(env)).filter((w) => w.chatId === chatId);
      if (!mine.length) return "No page watches.";
      return mine
        .map(
          (w) =>
            `${w.id} | ${w.status}${w.error ? ` (${w.error})` : ""} | ${w.condition}${w.value ? ` "${w.value}"` : ""} | every ${w.every} min | ${w.title} | ${w.url}`,
        )
        .join("\n");
    },
  },

  stop_watch: {
    kv: true,
    description: "Stop and delete a page watch by its id (also how to clear a watch that paused itself after failures).",
    parameters: obj({ id: str("Id from list_watches") }, ["id"]),
    async run(env, { chatId }, { id }) {
      const list = await load(env);
      const keep = list.filter((w) => !(w.id === id && w.chatId === chatId));
      await save(env, keep);
      return keep.length < list.length ? "Stopped." : "No such id.";
    },
  },
};
