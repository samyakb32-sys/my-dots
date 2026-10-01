// Fetch a web page and reduce it to plain text. Shared by fetch_url and the page watcher.

const MAX_PAGE_BYTES = 2_000_000;

/** { status, text } with whitespace collapsed. Throws on network errors and oversized pages. */
export async function readPage(env, url) {
  if (!/^https?:\/\//i.test(String(url))) throw new Error("only http(s) URLs.");
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "telegram-ai-bot" } });
  if (Number(res.headers.get("content-length")) > MAX_PAGE_BYTES) throw new Error("page too large.");
  let text = await res.text();
  const isHtml = (res.headers.get("content-type") || "").includes("html");
  if (isHtml) {
    text = text
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  }
  let clean = text.replace(/\s+/g, " ").trim();
  if (isHtml && clean.length < 200 && env.JINA_FALLBACK !== "0") {
    // Almost no text usually means a JavaScript-rendered page: let a reader service render it for us.
    const r = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const rendered = r?.ok ? (await r.text()).replace(/\s+/g, " ").trim() : "";
    if (rendered.length > clean.length) clean = rendered;
  }
  return { status: res.status, text: clean };
}
