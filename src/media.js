// Turns what the user sent (voice note, photo, document) into text and/or images the agent can use.

import { downloadFile } from "./telegram.js";
import { toBase64 } from "./util.js";

const MAX_VOICE = 10_000_000;
const MAX_IMAGE = 5_000_000;
const MAX_DOC = 5_000_000;
const FILE_CHARS = 12_000; // how much of a document goes into the prompt

const TEXT_FILE = /\.(txt|md|csv|tsv|json|jsonl|xml|html?|ya?ml|toml|ini|log|py|js|mjs|ts|jsx|tsx|java|c|cpp|h|go|rs|rb|php|sh|sql|css)$/i;

/** Speech to text: Groq Whisper (free tier) first, Cloudflare Workers AI as the fallback. */
async function transcribe(env, bytes, filename) {
  const errors = [];
  if (env.GROQ_API_KEY) {
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes]), filename);
      form.append("model", "whisper-large-v3-turbo");
      form.append("response_format", "json");
      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Groq ${res.status}`);
      return (await res.json()).text?.trim() ?? "";
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (env.AI) {
    try {
      return (await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(bytes) })).text?.trim() ?? "";
    } catch (e) {
      errors.push(`Workers AI ${e.message}`);
    }
  }
  throw new Error(
    errors.length
      ? `Voice samajh nahi paya (${errors.join("; ")}).`
      : "Voice ke liye GROQ_API_KEY (free) set kar, ya wrangler.toml mein [ai] binding rakh.",
  );
}

async function documentText(env, doc, bytes) {
  const mime = doc.mime_type || "";
  if (mime.startsWith("text/") || /json|xml|yaml/.test(mime) || TEXT_FILE.test(doc.file_name || "")) {
    return new TextDecoder().decode(bytes);
  }
  if (!env.AI?.toMarkdown) {
    throw new Error("Is file type (PDF, Word, Excel...) ke liye wrangler.toml mein [ai] binding chahiye.");
  }
  const out = await env.AI.toMarkdown([{ name: doc.file_name || "file", blob: new Blob([bytes], { type: mime }) }]);
  const first = Array.isArray(out) ? out[0] : out;
  if (!first || first.format === "error") throw new Error(`File padh nahi paya: ${first?.error || "unknown error"}`);
  return first.data ?? "";
}

/**
 * Returns { text, images?, heard? }. `heard` is the transcript of a voice note, to echo back to the user.
 * Throws an Error with a user-friendly message when the input can't be handled.
 */
export async function prepareInput(env, msg) {
  const caption = msg.text || msg.caption || "";

  const voice = msg.voice || msg.audio;
  if (voice) {
    const bytes = await downloadFile(env, voice.file_id, MAX_VOICE);
    const heard = await transcribe(env, bytes, msg.voice ? "voice.ogg" : voice.file_name || "audio.mp3");
    if (!heard) throw new Error("Voice mein kuch sunai nahi diya.");
    return { text: caption ? `${caption}\n\n${heard}` : heard, heard };
  }

  const image = msg.photo?.at(-1) || (msg.document?.mime_type?.startsWith("image/") ? msg.document : null);
  if (image) {
    const bytes = await downloadFile(env, image.file_id, MAX_IMAGE);
    const mime = msg.photo ? "image/jpeg" : image.mime_type;
    return { text: caption || "Is photo mein kya hai? Batao.", images: [`data:${mime};base64,${toBase64(bytes)}`] };
  }

  if (msg.document) {
    const doc = msg.document;
    const content = await documentText(env, doc, await downloadFile(env, doc.file_id, MAX_DOC));
    const clipped = content.length > FILE_CHARS ? `${content.slice(0, FILE_CHARS)}\n...[file truncated]` : content;
    return { text: `${caption || "Is file ko dekh ke batao."}\n\n[File: ${doc.file_name || "file"}]\n${clipped}` };
  }

  return { text: caption };
}
