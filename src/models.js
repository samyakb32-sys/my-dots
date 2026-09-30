// Free/open-model providers. All of them speak the OpenAI chat-completions API, so one code path serves every
// provider. A provider is active when its API key secret is set; models are tried in order until one answers.

export const PROVIDERS = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", keyEnv: "NVIDIA_API_KEY" }, // DeepSeek, GLM, Llama, Nemotron...
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" }, // use ids ending in :free
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyEnv: "GEMINI_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", keyEnv: "CEREBRAS_API_KEY" },
};

// Short names for /model. Free-tier model ids change often and these are NOT guaranteed to exist today:
// `/check` tests them, `/models <provider>` lists what a provider really offers, and a dead one is skipped.
export const PRESETS = {
  "gpt-oss": "groq:openai/gpt-oss-120b",
  deepseek: "nvidia:deepseek-ai/deepseek-v3.1",
  glm: "nvidia:z-ai/glm-5.1",
  llama: "nvidia:meta/llama-3.3-70b-instruct",
  nemotron: "nvidia:nvidia/nemotron-3-ultra-550b-a55b",
  free: "openrouter:openrouter/free", // OpenRouter picks any currently-free model
};

const TRY_MS = 20_000; // per model; slow free endpoints shouldn't eat the whole time budget

/** "deepseek" or "provider:model" -> { provider, model, label }, or null if it can't be parsed. */
export function resolveModel(spec) {
  const full = PRESETS[spec] ?? spec;
  const i = full.indexOf(":"); // model ids may contain ":" too (openrouter ...:free), so split on the first one
  const provider = full.slice(0, i);
  const model = full.slice(i + 1);
  return i > 0 && model && PROVIDERS[provider] ? { provider, model, label: `${provider}:${model}` } : null;
}

export const hasKey = (env, provider) => Boolean(env[PROVIDERS[provider].keyEnv]);

/** Models to try, in order: the chat's pick first, then MODEL_CHAIN. Providers without a key are dropped. */
export function modelChain(env, selected) {
  const seen = new Set();
  return [selected, ...(env.MODEL_CHAIN || "").split(",")]
    .map((s) => s?.trim())
    .filter(Boolean)
    .map(resolveModel)
    .filter((m) => m && hasKey(env, m.provider) && !seen.has(m.label) && seen.add(m.label));
}

async function chatOnce(env, m, messages, specs, timeoutMs, extra = {}) {
  const p = PROVIDERS[m.provider];
  const res = await fetch(`${p.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env[p.keyEnv]}` },
    body: JSON.stringify({ model: m.model, messages, ...(specs.length ? { tools: specs } : {}), ...extra }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`${m.label}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return (await res.json()).choices[0].message;
}

/**
 * Ask the first model in `chain` that answers. Rate limit, outage, dead model id, timeout: move to the next.
 * If some model rejected the tools (400), retry the chain once as plain chat. `until` is a hard deadline (ms epoch).
 */
export async function complete(env, chain, messages, specs, until) {
  if (!chain.length) {
    throw new Error(
      "Koi model available nahi. Kam se kam ek provider ki key daal: " +
        Object.values(PROVIDERS).map((p) => p.keyEnv).join(", "),
    );
  }
  const errors = [];
  for (const withTools of specs.length ? [true, false] : [false]) {
    for (const m of chain) {
      const left = until - Date.now();
      if (left < 1000) break;
      try {
        const message = await chatOnce(env, m, messages, withTools ? specs : [], Math.min(left, TRY_MS));
        return { message, used: m.label };
      } catch (e) {
        errors.push(e);
        console.warn(`${m.label} failed: ${e.message}`);
      }
    }
    if (!errors.some((e) => e.status === 400)) break;
  }
  const err = new Error(errors.length ? errors.map((e) => e.message).join("\n") : "Time budget khatam, sab models slow hain.");
  if (errors.length && errors.every((e) => e.status === 429)) err.status = 429;
  throw err;
}

/** Live model ids from a provider (its own /models endpoint), optionally filtered by substring. */
export async function listProviderModels(env, provider, filter = "") {
  const p = PROVIDERS[provider];
  const res = await fetch(`${p.baseUrl}/models`, {
    headers: { authorization: `Bearer ${env[p.keyEnv]}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${provider}: ${res.status}`);
  const ids = (await res.json()).data.map((m) => m.id).sort();
  return ids.filter((id) => id.toLowerCase().includes(filter.toLowerCase()));
}

/** Send a tiny prompt to every model in the chain, in parallel, and report which ones actually work. */
export function checkModels(env, chain) {
  return Promise.all(
    chain.map(async (m) => {
      const t = Date.now();
      try {
        await chatOnce(env, m, [{ role: "user", content: "Reply with OK" }], [], TRY_MS, { max_tokens: 16 });
        return `✅ ${m.label} (${((Date.now() - t) / 1000).toFixed(1)}s)`;
      } catch (e) {
        return `❌ ${e.message.slice(0, 140)}`;
      }
    }),
  );
}
