// Small byte helpers. Workers has btoa/atob but no Buffer.

/** Uint8Array -> base64, in chunks so big images don't overflow the call stack. */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** SHA-256 as hex (Web Crypto: available in Workers and Node). */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "a,b,c*" style allowlist match: exact name or a trailing-* prefix. */
export const matchesAny = (list, name) =>
  list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));

export const csv = (value) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);

// JSON-schema shorthands for tool parameters.
export const obj = (properties, required = []) => ({ type: "object", properties, required });
export const str = (description) => ({ type: "string", description });
export const num = (description) => ({ type: "number", description });
