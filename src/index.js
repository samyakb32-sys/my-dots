// Telegram front-end for the agent, as a Cloudflare Worker. No dependencies.

import {
  runAgent, takeDueReminders, listFacts, clearFacts, clearHistory, selectedModel, setModel,
} from "./agent.js";
import {
  PRESETS, PROVIDERS, resolveModel, hasKey, modelChain, listProviderModels, checkModels,
} from "./models.js";

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
    return reply(
      "Hi! Main tera always-on assistant hoon. Kuch bhi pooch, ya bol 'kal subah 8 baje yaad dilana'.\n" +
        "/model model chun ya dekh, /models list, /check test kar kaunsa chal raha hai, " +
        "/memory jo yaad hai, /reset chat bhoolne ke liye.",
    );
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
    const [spec] = args;
    if (!spec) {
      const order = modelChain(env, await selectedModel(env, chatId)).map((m) => m.label);
      return reply(
        order.length
          ? `Is order mein try hoga (fail hua to agla):\n${order.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n\n` +
              "Badalne ke liye: /model <naam> (naam ke liye /models). Wapas default: /model auto"
          : "Koi model active nahi. Kisi provider ki API key secret daal (README dekh).",
      );
    }
    if (spec === "auto") {
      await setModel(env, chatId, null);
      return reply("Default order wapas.");
    }
    const m = resolveModel(spec);
    if (!m) return reply(`'${spec}' samajh nahi aaya. /models dekh, ya provider:model likh (e.g. nvidia:meta/llama-3.3-70b-instruct).`);
    if (!hasKey(env, m.provider)) return reply(`${m.provider} ki key set nahi hai (${PROVIDERS[m.provider].keyEnv}).`);
    await setModel(env, chatId, spec);
    return reply(`Ab pehle ${m.label} try hoga, fail hua to baaki.`);
  }
  if (command === "/models") {
    const [provider, filter = ""] = args;
    if (!provider) {
      const presets = Object.entries(PRESETS).map(([alias, spec]) => {
        const m = resolveModel(spec);
        return `${hasKey(env, m.provider) ? "✅" : "❌ key nahi"} ${alias} -> ${spec}`;
      });
      return reply(
        `Short names:\n${presets.join("\n")}\n\nProviders: ${Object.keys(PROVIDERS).join(", ")}\n` +
          "Live list: /models <provider> [filter], e.g. /models nvidia deepseek\n" +
          "Koi bhi model: /model provider:model-id. Kaunsa chal raha hai: /check",
      );
    }
    if (!PROVIDERS[provider]) return reply(`Unknown provider. Options: ${Object.keys(PROVIDERS).join(", ")}`);
    if (!hasKey(env, provider)) return reply(`${provider} ki key set nahi hai (${PROVIDERS[provider].keyEnv}).`);
    try {
      const ids = await listProviderModels(env, provider, filter);
      const shown = ids.slice(0, 60);
      return reply(
        ids.length
          ? `${shown.join("\n")}${ids.length > shown.length ? `\n... aur ${ids.length - shown.length} (filter laga)` : ""}`
          : "Kuch nahi mila.",
      );
    } catch (e) {
      return reply(`List nahi mili: ${e.message}`);
    }
  }
  if (command === "/check") {
    const chain = modelChain(env, await selectedModel(env, chatId));
    if (!chain.length) return reply("Koi model active nahi. Kisi provider ki API key secret daal (README dekh).");
    await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
    return reply((await checkModels(env, chain)).join("\n"));
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
