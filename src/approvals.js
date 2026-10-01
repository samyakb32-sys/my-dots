// Human approval for risky tool calls (sending email, creating issues, ...). Like dots: the agent never does these
// on its own. The call is parked in KV, the user gets Approve/Reject buttons in Telegram, and only a tap runs it.

import { tg } from "./telegram.js";

const PENDING_TTL = 60 * 60;

export async function requestApproval(env, chatId, name, args) {
  if (!env.CHAT) return "Error: this action needs approval, which needs the KV binding.";
  const id = crypto.randomUUID().slice(0, 8);
  await env.CHAT.put(`pending:${id}`, JSON.stringify({ chatId, name, args }), { expirationTtl: PENDING_TTL });
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `⚠️ Approval chahiye\nAction: ${name}\n${JSON.stringify(args, null, 1).slice(0, 900)}`,
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Haan, kar", callback_data: `ok:${id}` }, { text: "❌ Nahi", callback_data: `no:${id}` }]],
    },
  });
  return "NOT executed yet: the user was asked to approve it with buttons in Telegram. Tell them in one short sentence what is waiting for their OK. Do not retry.";
}

/** One-shot: returns the parked call and removes it, so a double tap can't run it twice. */
export async function takePending(env, id) {
  const raw = await env.CHAT?.get(`pending:${id}`);
  if (!raw) return null;
  await env.CHAT.delete(`pending:${id}`);
  return JSON.parse(raw);
}
