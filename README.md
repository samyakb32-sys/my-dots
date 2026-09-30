# Telegram AI assistant (a free, DIY take on OpenAI "dots")

Ek always-on AI assistant jo tu **Telegram** se use karta hai. Cloudflare Workers pe chalta hai (free plan, koi server nahi, 24/7 online) aur **kai free open models** use karta hai: DeepSeek, GLM, Llama, NVIDIA Nemotron, gpt-oss, sab. Ek model rate-limit ya band ho jaye to bot **apne aap agle model pe chala jata hai**.

## Dots se kya match karta hai, kya nahi

| OpenAI dots | Yahan |
|---|---|
| Always-on, Slack/Teams/ChatGPT se access | ✅ Always-on, **Telegram** se access |
| Tere preferences seekhta hai | ✅ `remember` tool + `/memory` (dekh sakta hai, delete bhi) |
| Scheduled / recurring automations | ✅ "roz subah 8 baje ye summary bhej" (cron har minute check karta hai) |
| Khud pehle message karta hai | ✅ Due task pe bot khud message bhejta hai |
| Background mode read-only | ✅ Scheduled runs mein sirf read-only tools (web padhna, list) |
| Boundaries set karna | ✅ `TOOLS` var se tools allow/deny, `ALLOWED_USER_IDS` se sirf tu |
| 4000+ apps, MCP plugins | ❌ Abhi sirf web padhna. Naye tools `src/agent.js` ke `TOOLS` mein add hote hain |
| Apna cloud computer + browser | ❌ Workers mein VM/browser nahi hota |
| Credential vault, sensitive action approval | ❌ Zaroorat nahi, kyunki koi risky tool nahi hai. Email bhejna jaisa tool add kare to approval step bhi add karna |
| Voice calls | ❌ |
| GPT-6 Astra | ❌ Free open models chalte hain, reasoning utni strong nahi hogi |

## Models

Bot kai providers se baat kar sakta hai. **Jis provider ki API key tu daalega wahi active hoga**, baaki skip. Sabki key zaroori nahi, ek se bhi chal jata hai.

| Provider | Key kahan se | Kya milta hai (free tier) |
|---|---|---|
| `nvidia` | [build.nvidia.com](https://build.nvidia.com) | **Ek key = DeepSeek, GLM, Llama, Nemotron...** Sabse zyada variety, isse shuru kar |
| `groq` | [console.groq.com](https://console.groq.com) | gpt-oss, bahut fast |
| `openrouter` | [openrouter.ai](https://openrouter.ai) | `:free` models, aur `openrouter/free` jo koi bhi free model chun leta hai |
| `gemini` | [aistudio.google.com](https://aistudio.google.com) | Gemini free tier |
| `cerebras` | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Fast open models |

Sab mein card ki zaroorat nahi hoti (tab bill aa hi nahi sakta), lekin free tiers ki limits aur model lists badalti rehti hain.

**Zaroori caveat:** `src/models.js` ke `PRESETS` mein short names (`deepseek`, `glm`, `llama`, `nemotron`, `gpt-oss`, `free`) ke model IDs maine web search se liye hain, providers se verify nahi kiye. Free model IDs bahut jaldi badalte hain (e.g. Groq ne Llama 3.3 70B free plan se hata diya bataya gaya hai, OpenRouter pe GLM 5.1 ab free nahi hai). Isliye deploy ke baad:

1. Telegram mein **`/check`** bhej: har model ko chhota test bhejta hai, ✅/❌ dikhata hai.
2. ❌ wale ke liye **`/models nvidia glm`** (provider + filter) se asli live ID dekh, phir **`/model nvidia:<asli-id>`** se chun. Permanent karna ho to `PRESETS` mein naam theek kar de.

Dead model bot ko todta nahi, bas skip ho jata hai.

### Telegram commands

| Command | Kaam |
|---|---|
| `/model` | Kis order mein models try honge |
| `/model deepseek` | Short name se pehle ye try ho (ya `/model nvidia:meta/llama-3.3-70b-instruct`) |
| `/model auto` | Default order (`MODEL_CHAIN`) wapas |
| `/models` | Short names + kis ki key set hai |
| `/models nvidia deepseek` | Provider ki live list, filter ke saath |
| `/check` | Sab active models test kar |
| `/memory`, `/memory clear` | Jo yaad hai dekh / saaf kar |
| `/reset` | Chat history saaf |

Jab fallback model jawab deta hai, jawab ke neeche `(via provider:model)` likha aata hai.

## Bill kaise nahi aayega

- **Cloudflare Workers free plan**: limit cross hone pe requests fail hoti hain, bill nahi aata (paid plan tu khud lega tabhi).
- **Models**: upar wale providers ki free tier, card mat daal. Limit khatam to 429 aata hai aur bot agle model pe jata hai.
- Recurring tasks kam se kam 10 minute ke gap pe hi bante hain, taaki free quota jaldi na khatam ho.

## Setup (10 minute)

1. **Bot banao**: Telegram pe `@BotFather` → `/newbot` → token copy kar.
2. **Install + login**:
   ```bash
   npm install
   npx wrangler login
   ```
3. **Memory wala KV banao** aur output ki `id` `wrangler.toml` mein `REPLACE_WITH_KV_ID` ki jagah paste kar:
   ```bash
   npx wrangler kv namespace create CHAT
   ```
4. **Timezone**: `wrangler.toml` mein `TIMEZONE` apni IANA timezone pe set kar (default `Asia/Kolkata`). `MODEL_CHAIN` mein models ka order bhi yahin badal sakta hai.
5. **Secrets daal**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # koi bhi random string, e.g. `openssl rand -hex 16`
   npx wrangler secret put NVIDIA_API_KEY            # jo providers chahiye unki key (kam se kam ek)
   npx wrangler secret put GROQ_API_KEY
   npx wrangler secret put OPENROUTER_API_KEY
   ```
6. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
   Ye `https://telegram-ai-bot.<tera-subdomain>.workers.dev` URL dega.
7. **Telegram ko webhook batao**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://telegram-ai-bot.<tera-subdomain>.workers.dev/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET wali string>"
   ```
8. **Khud ko allow kar**: bot ko koi bhi message bhej. Wo tera Telegram ID bata dega. Phir:
   ```bash
   npx wrangler secret put ALLOWED_USER_IDS   # e.g. 123456789  (kai log ho to comma se)
   ```
   Uske baad sirf tu bot use kar sakta hai, baaki sabko koi jawab nahi milta.
9. **`/check` bhej** aur dekh kaunse models chal rahe hain (upar ka caveat).

## Use kaise karein

- Seedha baat kar. Hinglish chalega.
- "Mujhe chai pasand hai, yaad rakh" → `remember` se save hota hai.
- "20 minute baad paani pilane ko yaad dila" ya "roz subah 8 baje https://... ka summary bhej" → scheduled task. "kya scheduled hai?" pooch kar dekh, "wo wala cancel kar" bol kar hata.
- "Ye page padh ke bata: https://..." → `fetch_url`.
- Tools (memory, reminders, web) ke liye model ko function calling support karni chahiye. Jo model nahi karta uske saath bot simple chat mode mein chalta hai.

## Limits

- Free models slow ho sakte hain. Har jawab ke liye ~25 second ka budget hai, har model ko max 20 second; uske baad agla model try hota hai. Sab slow/fail hon to error message aata hai, dobara bhej dena.
- Cloudflare free KV mein roz 1000 writes hain: har message ~1 write, to roz kuch sau messages tak theek hai.

## Safety notes

- Webhook `X-Telegram-Bot-Api-Secret-Token` se verify hota hai, aur secret set na ho to sab reject hota hai.
- Allowlist se bahar ke log ko koi jawab nahi milta, to tera free quota koi aur use nahi kar sakta.
- **Web page padhne ka risk**: kisi page mein chhupi instruction model ko bahekane ki koshish kar sakti hai (prompt injection). Isliye scheduled runs read-only hain. Phir bhi `fetch_url` ek page se data bahar bhejne wali URL kholne ke liye use ho sakta hai. Zyada safe rehna ho to `wrangler.toml` mein `TOOLS` uncomment karke `fetch_url` hata de.
- Tera chat 3rd-party free providers ko jata hai (NVIDIA, Groq, ...). Free tier pe wo data use kar sakte hain, isliye passwords ya private cheezein mat bhej.
- Secrets kabhi commit mat kar. `.dev.vars` gitignored hai.

## Local test aur development

```bash
npm test          # Telegram + model APIs mock karke 27 tests
npm run dev       # local worker; `.dev.vars` mein secrets rakh
```

Code: `src/index.js` (Telegram, commands, cron), `src/models.js` (providers, fallback), `src/agent.js` (agent loop, memory, tools, scheduler).
