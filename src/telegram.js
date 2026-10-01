// Telegram Bot API helpers: messages, file uploads and downloads.

const API = "https://api.telegram.org";
const TG_LIMIT = 4000; // Telegram caps messages at 4096 chars

export function tg(env, method, body) {
  return fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Send text, split to fit Telegram's limit. `extra` (e.g. reply_markup) goes on the last chunk. */
export async function sendMessage(env, chatId, text, extra = {}) {
  const chunks = [];
  for (let i = 0; i < text.length; i += TG_LIMIT) chunks.push(text.slice(i, i + TG_LIMIT));
  if (!chunks.length) chunks.push("(empty)");
  for (const [i, chunk] of chunks.entries()) {
    await tg(env, "sendMessage", { chat_id: chatId, text: chunk, ...(i === chunks.length - 1 ? extra : {}) });
  }
}

async function upload(env, method, chatId, field, blob, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(field, blob, filename);
  if (caption) form.append("caption", caption.slice(0, 1000));
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
}

export const sendDocument = (env, chatId, blob, filename, caption) =>
  upload(env, "sendDocument", chatId, "document", blob, filename, caption);

export const sendPhoto = (env, chatId, blob, caption) => upload(env, "sendPhoto", chatId, "photo", blob, "image.jpg", caption);

/** Download a file the user sent. The file URL contains the bot token, so it never leaves this function. */
export async function downloadFile(env, fileId, maxBytes) {
  const info = await (await tg(env, "getFile", { file_id: fileId })).json();
  if (!info.ok) throw new Error(`File nahi mili: ${info.description}`);
  if (info.result.file_size > maxBytes) throw new Error(`File bahut badi hai (max ${Math.round(maxBytes / 1e6)} MB).`);
  const res = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`);
  if (!res.ok) throw new Error(`File download fail: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`File bahut badi hai (max ${Math.round(maxBytes / 1e6)} MB).`);
  return bytes;
}
