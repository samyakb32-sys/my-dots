// Extra tools: web search, running code, making files and images. Same shape as TOOLS in agent.js:
// { description, parameters, run(env, ctx, args), readOnly?, available?(env) }

import { sendDocument, sendPhoto } from "./telegram.js";
import { fromBase64, obj, str, num } from "./util.js";

const RESULT_CHARS = 5000;

// ---- web search -----------------------------------------------------------------------------

// Tavily works with a free key (1000 searches/month, no card) and also in "keyless" mode without one.
async function tavily(env, query, n) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.TAVILY_API_KEY ? { authorization: `Bearer ${env.TAVILY_API_KEY}` } : { "x-tavily-access-mode": "keyless" }),
    },
    body: JSON.stringify({ query, max_results: n, include_answer: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return {
    answer: data.answer,
    results: (data.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
  };
}

async function brave(env, query, n) {
  const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`, {
    headers: { accept: "application/json", "x-subscription-token": env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = await res.json();
  return { results: (data.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })) };
}

// ---- code execution -------------------------------------------------------------------------

// Judge0 names its runtimes like "Python (3.12.5)"; ids differ between versions, so look them up by prefix.
const LANGS = {
  python: "Python (", javascript: "JavaScript (", typescript: "TypeScript (", bash: "Bash (",
  c: "C (GCC", cpp: "C++ (GCC", java: "Java (", go: "Go (", rust: "Rust (", ruby: "Ruby (", php: "PHP (",
};
const languageCache = new Map(); // runner url -> its language list

async function languageId(base, headers, language) {
  if (!languageCache.has(base)) {
    const res = await fetch(`${base}/languages`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`languages ${res.status}`);
    languageCache.set(base, await res.json());
  }
  const matches = languageCache.get(base).filter((l) => l.name.startsWith(LANGS[language]));
  if (!matches.length) throw new Error(`${language} not available on this runner`);
  return matches.reduce((a, b) => (b.id > a.id ? b : a)).id; // highest id = newest version
}

export const EXTRA_TOOLS = {
  web_search: {
    readOnly: true,
    description: "Search the web for current information. Returns an answer plus titles, URLs and snippets; use fetch_url to read a result in full.",
    parameters: obj({ query: str("Search query"), max_results: num("1 to 8, default 5") }, ["query"]),
    async run(env, _ctx, { query, max_results }) {
      if (!query) return "Error: query is required.";
      const n = Math.min(Math.max(Number(max_results) || 5, 1), 8);
      const { answer, results } = env.BRAVE_API_KEY && !env.TAVILY_API_KEY ? await brave(env, query, n) : await tavily(env, query, n);
      const lines = results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${(r.snippet || "").slice(0, 300)}`);
      return ([answer && `Answer: ${answer}`, ...lines].filter(Boolean).join("\n\n") || "No results.").slice(0, RESULT_CHARS);
    },
  },

  run_code: {
    readOnly: true, // runs in a remote sandbox: it can't change anything of the user's
    description:
      "Run a program in a sandbox and return its output. Use it for calculations, data processing, or checking code. " +
      `Languages: ${Object.keys(LANGS).join(", ")}. No internet inside the sandbox. Print results to stdout.`,
    parameters: obj(
      { language: { type: "string", enum: Object.keys(LANGS) }, code: str("Full program source"), stdin: str("Optional input") },
      ["language", "code"],
    ),
    async run(env, _ctx, { language, code, stdin }) {
      if (!LANGS[language]) return `Error: language must be one of ${Object.keys(LANGS).join(", ")}.`;
      const base = (env.JUDGE0_URL || "https://ce.judge0.com").replace(/\/$/, "");
      const headers = { "content-type": "application/json", ...(env.JUDGE0_KEY ? { "x-auth-token": env.JUDGE0_KEY } : {}) };
      const res = await fetch(`${base}/submissions?base64_encoded=false&wait=true`, {
        method: "POST",
        headers,
        body: JSON.stringify({ source_code: code, language_id: await languageId(base, headers, language), stdin: stdin || "" }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return `Error: runner ${res.status}`;
      const r = await res.json();
      const parts = [
        `Status: ${r.status?.description ?? "unknown"}`,
        r.stdout && `stdout:\n${r.stdout}`,
        r.stderr && `stderr:\n${r.stderr}`,
        r.compile_output && `compile output:\n${r.compile_output}`,
        r.message && `message: ${r.message}`,
      ];
      return parts.filter(Boolean).join("\n").slice(0, RESULT_CHARS);
    },
  },

  generate_image: {
    available: (env) => Boolean(env.AI),
    description: "Generate an image from a text prompt and send it to the user in Telegram. Describe it in English for best results.",
    parameters: obj({ prompt: str("What the image should show") }, ["prompt"]),
    async run(env, { chatId }, { prompt }) {
      if (!prompt) return "Error: prompt is required.";
      const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt, steps: 4 });
      if (!out?.image) return "Error: the model returned no image.";
      await sendPhoto(env, chatId, new Blob([fromBase64(out.image)], { type: "image/jpeg" }), prompt);
      return "Image sent to the user.";
    },
  },

  send_file: {
    description: "Create a text file (code, CSV, notes, markdown, JSON...) with the given content and send it to the user as a Telegram document.",
    parameters: obj({ filename: str("e.g. report.md or data.csv"), content: str("Full file content") }, ["filename", "content"]),
    async run(env, { chatId }, { filename, content }) {
      const name = String(filename || "file.txt").replace(/[^\w.\- ]/g, "_").slice(0, 80);
      if (typeof content !== "string" || !content) return "Error: content is required.";
      if (content.length > 200_000) return "Error: file too large (max 200 KB).";
      await sendDocument(env, chatId, new Blob([content], { type: "text/plain" }), name);
      return `Sent ${name} to the user.`;
    },
  },
};
