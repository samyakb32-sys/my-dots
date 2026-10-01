// Human approval for risky tool calls (sending email, creating issues, ...). Like dots: the agent never does these
// on its own. The call is parked in KV, the user gets Approve/Reject buttons in Telegram, and only a tap runs it.
//
// Hardened along the lines of OpenMuse's action reviews:
//  - the user is only asked about content they can see in full: long arguments are sent as a file first;
//  - the button carries a hash of the parked call, so a stale or altered request is refused, never run;
//  - one decision per request, claimed atomically through the APPROVAL_LOCK Durable Object (see approval-lock.js).
//    Without it a KV read-then-write is used, which narrows the race but can't close it;
//  - the outcome is recorded as succeeded, failed, or unknown (the call may have gone through) and never retried.

import { tg, sendDocument } from "./telegram.js";
import { sha256Hex } from "./util.js";

const PENDING_TTL = 60 * 60;
const OUTCOME_TTL = 24 * 60 * 60;
const SHOWN_CHARS = 3000; // Telegram allows 4096 per message; arguments beyond this are also attached as a file
const HASH_CHARS = 12; // the part of the hash that fits in the 64-byte button payload

const pendingKey = (id) => `pending:${id}`;
const dupKey = (hash) => `pending-dup:${hash.slice(0, 16)}`;
const fingerprint = ({ chatId, name, args }) => sha256Hex(JSON.stringify([chatId, name, args]));
const read = async (env, id) => JSON.parse((await env.CHAT.get(pendingKey(id))) || "null");
const write = (env, id, record, ttl) => env.CHAT.put(pendingKey(id), JSON.stringify(record), { expirationTtl: ttl });

export async function requestApproval(env, chatId, name, args) {
  if (!env.CHAT) return "Error: this action needs approval, which needs the KV binding.";
  const hash = await fingerprint({ chatId, name, args });
  // A model that retries the same call must not stack up identical prompts.
  const waitingId = await env.CHAT.get(dupKey(hash));
  const waiting = waitingId && (await read(env, waitingId));
  if (waiting?.status === "pending" && waiting.expiresAt > Date.now()) {
    return "NOT executed yet: this exact action is already waiting for the user's approval in Telegram. Do not ask again.";
  }

  const id = crypto.randomUUID().slice(0, 8);
  const now = Date.now();
  await write(env, id, { chatId, name, args, hash, status: "pending", createdAt: now, expiresAt: now + PENDING_TTL * 1000 }, PENDING_TTL);
  await env.CHAT.put(dupKey(hash), id, { expirationTtl: PENDING_TTL });
  try {
    const shown = JSON.stringify(args, null, 1);
    const long = shown.length > SHOWN_CHARS;
    if (long) {
      const file = new Blob([shown], { type: "application/json" });
      await sendDocument(env, chatId, file, `${name.replace(/[^\w.-]/g, "_")}-arguments.json`, "Poora content jo approval ke liye ruka hai");
    }
    const res = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ Approval chahiye\nAction: ${name}\n${shown.slice(0, SHOWN_CHARS)}${long ? "\n… (poora content upar file mein)" : ""}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Haan, kar", callback_data: `ok:${id}:${hash.slice(0, HASH_CHARS)}` },
          { text: "❌ Nahi", callback_data: `no:${id}:${hash.slice(0, HASH_CHARS)}` },
        ]],
      },
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}`);
  } catch (e) {
    // Never leave a request the user may not have seen.
    await Promise.all([env.CHAT.delete(pendingKey(id)), env.CHAT.delete(dupKey(hash))]);
    return `Error: could not ask the user for approval (${e.message}). Nothing was executed.`;
  }
  return "NOT executed yet: the user was asked to approve it with buttons in Telegram. Tell them in one short sentence what is waiting for their OK. Do not retry.";
}

/** Who wins when the same approval is decided twice at once. true = this caller owns the decision. */
async function win(env, id, decision) {
  if (env.APPROVAL_LOCK) {
    const stub = env.APPROVAL_LOCK.get(env.APPROVAL_LOCK.idFromName("approvals"));
    const res = await stub.fetch("https://approval-lock/claim", { method: "POST", body: JSON.stringify({ id, decision }) });
    return (await res.json()).won === true;
  }
  const token = crypto.randomUUID();
  await env.CHAT.put(`claim:${id}`, token, { expirationTtl: PENDING_TTL });
  return (await env.CHAT.get(`claim:${id}`)) === token;
}

/**
 * Take the decision on a parked call. Resolves to { status: "claimed", pending } when the caller may act, otherwise
 * { status: "gone" | "expired" | "handled" | "changed" } and nothing may run. Throws if the lock can't be reached.
 */
export async function claimApproval(env, { id, hash, chatId, decision }) {
  const rec = id ? await read(env, id) : null;
  if (!rec || rec.chatId !== chatId) return { status: "gone" };
  if (rec.status !== "pending") return { status: "handled" };
  if (Date.now() > rec.expiresAt) return { status: "expired" };
  // The button must match the stored request, and the stored request must still hash to what the user was shown.
  if (hash?.length !== HASH_CHARS || !rec.hash.startsWith(hash) || (await fingerprint(rec)) !== rec.hash) return { status: "changed" };
  if (!(await win(env, id, decision))) return { status: "handled" };

  const pending = { ...rec, status: decision === "approve" ? "executing" : "denied", decidedAt: Date.now() };
  await write(env, id, pending, OUTCOME_TTL);
  await env.CHAT.delete(dupKey(rec.hash));
  return { status: "claimed", pending };
}

/** Record how an approved call ended: "succeeded", "failed" or "outcome_unknown". */
export const finishApproval = (env, id, pending, { status, text }) =>
  write(env, id, { ...pending, status, result: text.slice(0, 500), finishedAt: Date.now() }, OUTCOME_TTL);
