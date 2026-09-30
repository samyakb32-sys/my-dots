# Telegram AI assistant (a free, DIY take on OpenAI "dots")

Ek always-on AI assistant jo tu **Telegram** se use karta hai. Cloudflare Workers pe chalta hai (free plan, koi server nahi, 24/7 online) aur **koi bhi OpenAI-compatible API** use karta hai, to free models chalenge.

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
| GPT-6 Astra | ❌ Tu jo free model chune (Llama, Gemini, ...) wo chalega, reasoning utni strong nahi hogi |

## Bill kaise nahi aayega

- **Cloudflare Workers free plan**: limit cross hone pe requests fail hoti hain, bill nahi aata (paid plan tu khud lega tabhi).
- **LLM**: free-tier key use kar (Groq, Google AI Studio/Gemini, OpenRouter `:free` models). Card mat daal, to bill ka chance hi nahi. Free tier ki limits badalti rehti hain, apne provider ka page dekh le.
- OpenAI ki API key chalani ho to: prepaid credits rakh, **auto-recharge band** rakh, aur monthly budget limit laga.
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
4. **Provider chun**, `wrangler.toml` ke `[vars]` mein `LLM_BASE_URL` aur `LLM_MODEL` set kar (model ka naam provider ki list se check kar, free models ke naam badalte rehte hain):

   | Provider | `LLM_BASE_URL` |
   |---|---|
   | Groq | `https://api.groq.com/openai/v1` |
   | Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
   | OpenRouter | `https://openrouter.ai/api/v1` (model naam ke end mein `:free`) |

   Tools use karne ke liye model ko function calling support karni chahiye. Nahi karega to bot apne aap simple chat mode mein chalega.
5. **`TIMEZONE`** apni IANA timezone pe set kar (default `Asia/Kolkata`).
6. **Secrets daal**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put LLM_API_KEY
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # koi bhi random string, e.g. `openssl rand -hex 16`
   ```
7. **Deploy**:
   ```bash
   npx wrangler deploy
   ```
   Ye `https://telegram-ai-bot.<tera-subdomain>.workers.dev` URL dega.
8. **Telegram ko webhook batao**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
     -d "url=https://telegram-ai-bot.<tera-subdomain>.workers.dev/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET wali string>"
   ```
9. **Khud ko allow kar**: bot ko koi bhi message bhej. Wo tera Telegram ID bata dega. Phir:
   ```bash
   npx wrangler secret put ALLOWED_USER_IDS   # e.g. 123456789  (kai log ho to comma se)
   ```
   Uske baad sirf tu bot use kar sakta hai, baaki sabko koi jawab nahi milta.

## Use kaise karein

- Seedha baat kar. Hinglish chalega.
- "Mujhe chai pasand hai, yaad rakh" → `remember` se save hota hai. `/memory` se dekh, `/memory clear` se sab hata.
- "20 minute baad paani pilane ko yaad dila" ya "roz subah 8 baje https://... ka summary bhej" → scheduled task. "kya scheduled hai?" pooch kar dekh, "wo wala cancel kar" bol kar hata.
- "Ye page padh ke bata: https://..." → `fetch_url`.
- `/reset` chat history clear, `/model <naam>` model badal, `/start` help.

## Safety notes

- Webhook `X-Telegram-Bot-Api-Secret-Token` se verify hota hai, aur secret set na ho to sab reject hota hai.
- Allowlist se bahar ke log ko koi jawab nahi milta, to tera free quota koi aur use nahi kar sakta.
- **Web page padhne ka risk**: kisi page mein chhupi instruction model ko bahekane ki koshish kar sakti hai (prompt injection). Isliye scheduled runs read-only hain. Phir bhi `fetch_url` ek page se data bahar bhejne wali URL kholne ke liye use ho sakta hai. Zyada safe rehna ho to `wrangler.toml` mein `TOOLS` uncomment karke `fetch_url` hata de.
- Secrets kabhi commit mat kar. `.dev.vars` gitignored hai.

## Local test aur development

```bash
npm test          # Telegram + LLM mock karke 20 tests
npm run dev       # local worker; `.dev.vars` mein secrets rakh
```

Code: `src/index.js` (Telegram + cron), `src/agent.js` (LLM loop, memory, tools, scheduler).
