// Telegram front-end for the agent, as a Cloudflare Worker. No dependencies.

import {
  runAgent, takeDueReminders, listFacts, clearFacts, clearHistory, currentModel, setModel,
} from "./agent.js";

const TG_API = "https://api.telegram.org";
const TG_LIMIT = 4000; // Telegram caps messages at 4096 chars

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST" || pathname !== "/webhook") {
      return new Response("ok"); // health check
    }
    // Fails closed: if the secret is unset, nothing matches.
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }
    const update = await request.json();
    // Ack immediately so Telegram doesn't retry; do the slow LLM work in the background.
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error(e)));
    return new Response("ok");
  },

  // Cron trigger (every minute): the bot messages you first when a scheduled task is due.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runDue(env).catch((e) => console.error(e)));
  },
};

export async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const reply = (text) => sendMessage(env, chatId, text);

  const allowed = (env.ALLOWED_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    // Setup mode: tell the owner their ID so they can whitelist it.
    return reply(`Setup mode. Your Telegram ID is ${userId}. Run: npx wrangler secret put ALLOWED_USER_IDS`);
  }
  if (!allowed.includes(userId)) return; // strangers get silence, not free quota

  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const command = cmd.startsWith("/") ? cmd.split("@")[0] : null;

  if (command === "/start") {
    return reply("Hi! Main tera always-on assistant hoon. Kuch bhi pooch, ya bol 'kal subah 8 baje yaad dilana'.\n/reset chat bhoolne ke liye, /memory jo yaad hai wo dekhne ke liye, /model model badalne ke liye.");
  }
  if (command === "/reset") {
    await clearHistory(env, chatId);
    return reply("Chat history clear. (Long-term memory ke liye /memory clear)");
  }
  if (command === "/memory") {
    if (args[0] === "clear") {
      await clearFacts(env, chatId);
      return reply("Saari yaadein delete.");
    }
    const facts = await listFacts(env, chatId);
    return reply(facts.length ? facts.map((f) => `- ${f}`).join("\n") : "Abhi kuch yaad nahi.");
  }
  if (command === "/model") {
    if (!args.length) return reply(`Current model: ${await currentModel(env, chatId)}`);
    await setModel(env, chatId, args[0]);
    return reply(`Model set to ${args[0]}`);
  }

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    await reply(await runAgent(env, chatId, msg.text));
  } catch (e) {
    console.error(e);
    await reply(e.status === 429 ? "Free limit hit ho gayi, thodi der baad try kar." : `LLM error: ${e.message}`);
  }
}

export async function runDue(env, now = Date.now()) {
  for (const task of await takeDueReminders(env, now)) {
    try {
      await sendMessage(env, task.chatId, await runAgent(env, task.chatId, task.text, { scheduled: true }));
    } catch (e) {
      console.error(e);
      await sendMessage(env, task.chatId, `Scheduled task fail ho gaya: ${e.message}`);
    }
  }
}

async function sendMessage(env, chatId, text) {
  for (let i = 0; i < text.length; i += TG_LIMIT) {
    await tg(env, "sendMessage", { chat_id: chatId, text: text.slice(i, i + TG_LIMIT) });
  }
}

function tg(env, method, body) {
  return fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
