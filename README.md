# Telegram AI assistant (a free, DIY take on OpenAI "dots")

Ek always-on AI assistant jo tu **Telegram** se use karta hai. Cloudflare Workers pe chalta hai (free plan, koi server nahi, 24/7 online) aur **kai free open models** use karta hai (DeepSeek, GLM, Llama, Nemotron, gpt-oss). Ek model fail ho to agle pe chala jata hai.

Text ke alawa ye **voice note, photo aur file** bhi samajhta hai, **web search** karta hai, **code chalata hai**, **file aur image bana ke bhejta hai**, aur **MCP** ke zariye **GitHub, Gmail, Calendar jaise apps** se jud sakta hai. Risky kaam se pehle tujhse button se **approval** maangta hai.

## Dots se kya match karta hai, kya nahi

| OpenAI dots | Yahan |
|---|---|
| Always-on, Slack/Teams/ChatGPT se access | ✅ Always-on, **Telegram** se access |
| Tere preferences seekhta hai | ✅ `remember` tool + `/memory` (dekh sakta hai, delete bhi) |
| Scheduled / recurring automations | ✅ "roz subah 8 baje ye summary bhej" |
| Khud pehle message karta hai | ✅ Due task pe bot khud message bhejta hai |
| Background mode read-only | ✅ Scheduled runs mein sirf read-only tools |
| Risky kaam pe approval | ✅ Telegram pe ✅/❌ buttons (MCP ke write tools ke liye) |
| Boundaries set karna | ✅ `TOOLS`, `AUTO_APPROVE`, `ALLOWED_USER_IDS` |
| 4000+ apps via plugins/MCP | ✅ MCP client: Zapier, GitHub, ya koi bhi MCP server (tu server chunta hai) |
| Voice | ✅ Voice note bhej, wo samajhta hai. ❌ Bolke jawab nahi deta (Hindi TTS free nahi mila) |
| Cloud computer | 🟡 Poora computer nahi, lekin `run_code` sandbox mein code chalata hai |
| Browser | 🟡 `fetch_url` JavaScript pages bhi padh leta hai (r.jina.ai se). Clicking/login nahi |
| Credential vault | ❌ Tokens Cloudflare secrets mein rehte hain, model ko nahi dikhte |
| Voice call karna | ❌ |
| GPT-6 Astra | ❌ Free open models chalte hain, reasoning utni strong nahi hogi |

## Ye kya-kya kar sakta hai

| Tool / feature | Kaam | Kya chahiye |
|---|---|---|
| Baat-cheet | Kisi bhi free model se, Hinglish | Kam se kam ek model key |
| `remember` / `/memory` | Tere baare mein yaad rakhta hai | KV |
| `set_reminder` | "20 min baad yaad dila", "roz subah 8 baje..." (khud message bhejta hai) | KV |
| `web_search` | Internet pe search | Kuch nahi (Tavily keyless). Behtar: free `TAVILY_API_KEY` |
| `fetch_url` | Link ka page padhta hai | Kuch nahi |
| `run_code` | Python, JS, C++, Java, Go... chala ke output deta hai | Kuch nahi (public Judge0) |
| `send_file` | CSV, code, notes jaisi file bana ke Telegram pe bhejta hai | Kuch nahi |
| `generate_image` | Text se image banata hai (Flux) | `[ai]` binding (default on) |
| Voice note | Transcribe karke jawab deta hai | `GROQ_API_KEY` ya `[ai]` |
| Photo | Vision model se dekhta hai | `GEMINI_API_KEY` (free) ya `NVIDIA_API_KEY` |
| File (txt, csv, code, PDF, Word, Excel) | Padh ke summary/jawab | Text files: kuch nahi. PDF/Word/Excel: `[ai]` |
| Apps (GitHub, Gmail, Calendar...) | MCP se, approval ke saath | `MCP_SERVERS` (neeche) |

`/tools` bhej: abhi konse tools active hain wo dikhata hai (✋ = har baar tera approval).

## Models

Bot kai providers se baat kar sakta hai. **Jis provider ki API key tu daalega wahi active hoga**, baaki skip. Sabki key zaroori nahi, ek se bhi chal jata hai.

| Provider | Key kahan se | Kya milta hai (free tier) |
|---|---|---|
| `nvidia` | [build.nvidia.com](https://build.nvidia.com) | **Ek key = DeepSeek, GLM, Llama, Nemotron...** Sabse zyada variety, isse shuru kar |
| `groq` | [console.groq.com](https://console.groq.com) | gpt-oss, bahut fast. Voice (Whisper) bhi yahi se |
| `gemini` | [aistudio.google.com](https://aistudio.google.com) | Photos ke liye best free option |
| `openrouter` | [openrouter.ai](https://openrouter.ai) | `:free` models, aur `openrouter/free` |
| `cerebras` | [cloud.cerebras.ai](https://cloud.cerebras.ai) | Fast open models |

Sab mein card ki zaroorat nahi hoti (tab bill aa hi nahi sakta), lekin free tiers ki limits aur model lists badalti rehti hain.

**Zaroori caveat:** `src/models.js` ke `PRESETS` mein model IDs maine web search se liye hain, providers se verify nahi kiye. Free model IDs bahut jaldi badalte hain. Deploy ke baad:

1. Telegram mein **`/check`** bhej: har model ko chhota test bhejta hai, ✅/❌ dikhata hai.
2. ❌ wale ke liye **`/models nvidia glm`** se asli live ID dekh, phir **`/model nvidia:<asli-id>`**. Permanent karna ho to `PRESETS` mein naam theek kar de.

Dead model bot ko todta nahi, bas skip ho jata hai.

## Apps jodna (GitHub, Gmail, Calendar...) via MCP

MCP ek standard hai jisse bot kisi bhi app ke tools use kar sakta hai. `MCP_SERVERS` secret mein JSON list daal (isme tokens hote hain, to secret hi rakh):

```bash
npx wrangler secret put MCP_SERVERS
```

```json
[
  {"name": "github", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer <GitHub personal access token>"}},
  {"name": "zapier", "url": "<tera Zapier MCP endpoint URL>"}
]
```

- **GitHub**: repo/issues/PR tools. Token github.com → Settings → Developer settings se.
- **Zapier**: zapier.com pe MCP endpoint banake usme Gmail, Google Calendar, Slack, Notion wagairah actions jod. Wo URL yahan daal.
- Koi bhi remote MCP server chalega jo `https://` pe hai aur token/header se chalta hai. OAuth-only wale servers (jo browser login maangte hain) seedhe nahi chalenge.
- Zyada tools hon to server entry mein `"include": ["tool_name", ...]` daal, taaki sirf wahi bot ko dikhe (free models ko 30 se zyada tools se dikkat hoti hai; ek server se max 30 hi liye jaate hain).
- `/tools` se dekh kya load hua. Naya tool add kiya to `/tools refresh`.

**Approval:** MCP tool jo khud ko "read-only" mark nahi karta (email bhejna, issue banana, event badalna...) wo chalne se pehle tujhse button se puchta hai:

```
⚠️ Approval chahiye
Action: github__create_issue
{ "title": "bug" }
[✅ Haan, kar] [❌ Nahi]
```

Button dabane ke baad hi chalta hai, ek hi baar, aur 1 ghante baad expire ho jata hai. Read-only tools (list, search) seedhe chalte hain. Kisi tool ko bina puche chalne dena ho to `AUTO_APPROVE = "github__list_*"` (wildcard chalta hai). Scheduled/background runs mein sirf read-only tools milte hain.

## Bill kaise nahi aayega

- **Cloudflare Workers free plan**: limit cross hone pe requests fail hoti hain, bill nahi aata (paid plan tu khud lega tabhi). Workers AI ki free daily allowance (10,000 neurons) khatam hone pe bhi calls fail hoti hain.
- **Models aur search**: upar wale providers ki free tier, card mat daal.
- **Zapier / GitHub / Judge0**: unki apni free limits hain, dekh lena.
- Recurring tasks kam se kam 10 minute ke gap pe hi bante hain, taaki free quota jaldi na khatam ho.

## Setup (10 minute)

1. **Bot banao**: Telegram pe `@BotFather` → `/newbot` → token copy kar.
2. **Install + login**:
   ```bash
   npm install
   npx wrangler login
   ```
3. **KV banao** aur output ki `id` `wrangler.toml` mein `REPLACE_WITH_KV_ID` ki jagah paste kar:
   ```bash
   npx wrangler kv namespace create CHAT
   ```
4. **Timezone**: `wrangler.toml` mein `TIMEZONE` apni IANA timezone pe set kar (default `Asia/Kolkata`). `MODEL_CHAIN` mein models ka order bhi yahin.
5. **Secrets daal**:
   ```bash
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # koi bhi random string, e.g. `openssl rand -hex 16`
   npx wrangler secret put NVIDIA_API_KEY            # jo providers chahiye unki key (kam se kam ek)
   npx wrangler secret put GROQ_API_KEY              # voice notes ke liye bhi kaam aati hai
   npx wrangler secret put GEMINI_API_KEY            # photos ke liye
   npx wrangler secret put TAVILY_API_KEY            # optional, behtar web search
   npx wrangler secret put MCP_SERVERS               # optional, apps
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
9. **`/check` aur `/tools` bhej** aur dekh kya chal raha hai.

## Telegram commands

| Command | Kaam |
|---|---|
| `/tools`, `/tools refresh` | Active tools (✋ = approval chahiye) |
| `/model`, `/model deepseek`, `/model auto` | Model order dekh / badal / default |
| `/models`, `/models nvidia deepseek` | Short names, ya provider ki live list (filter ke saath) |
| `/check` | Sab active models test kar |
| `/memory`, `/memory clear` | Jo yaad hai dekh / saaf kar |
| `/reset` | Chat history saaf |

Jab fallback model jawab deta hai, jawab ke neeche `(via provider:model)` likha aata hai.

## Limits (seedhi baat)

- **Maine sab kuch mock se test kiya hai, asli services se nahi.** Tavily keyless mode, Judge0 public server, Workers AI (toMarkdown, Flux, Whisper), Jina Reader, aur MCP servers (GitHub/Zapier) ke asli behaviour ki guarantee nahi. Pehle chalake dekh, jo kaam na kare wo bata.
- Free models slow ho sakte hain. Har jawab ke liye ~25 second ka budget hai, har model ko max 20 second.
- Cloudflare **free plan mein har request ko sirf 10 ms CPU** milta hai. Text chat mein dikkat nahi, lekin badi photo ya badi file (base64, parsing) pe "exceeded CPU" error aa sakta hai. Aisa ho to chhoti photo/file bhej, ya Workers Paid plan ($5/mahina) le.
- Photo 5 MB tak, file 5 MB tak, voice 10 MB tak. File ka sirf shuruaat ka ~12,000 characters model ko jata hai.
- KV ke free 1000 writes/din: har message ~1 write.
- `run_code` ek public sandbox pe chalta hai: wahan internet nahi, aur tera code un servers ko jata hai.
- Bot Hindi mein bolke jawab nahi deta (sirf text). Browser mein click/login/forms nahi.

## Safety notes

- Webhook `X-Telegram-Bot-Api-Secret-Token` se verify hota hai, secret set na ho to sab reject hota hai. Approval buttons bhi sirf `ALLOWED_USER_IDS` wale daba sakte hain.
- **Prompt injection**: web page, file ya search result mein chhupi instruction model ko bahekane ki koshish kar sakti hai. Isliye risky actions approval maangte hain aur background runs read-only hain. Phir bhi approval message mein **action ka naam aur arguments dhyan se padh** ke hi ✅ dabana.
- `fetch_url` aur `web_search` se data bahar jaa sakta hai (URL/query ke zariye). Zyada safe rehna ho to `TOOLS` setting se unhe hata de.
- Tera chat aur files 3rd-party free providers (NVIDIA, Groq, Google, Tavily, Jina, Judge0) ko jaate hain. Passwords ya private cheezein mat bhej.
- Secrets kabhi commit mat kar. `.dev.vars` gitignored hai.

## Local test aur development

```bash
npm test          # Telegram + sab APIs mock karke 49 tests
npm run dev       # local worker; `.dev.vars` mein secrets rakh
```

Code: `src/index.js` (Telegram routing, commands, cron), `src/agent.js` (agent loop, memory, scheduler, tool registry), `src/models.js` (providers, fallback), `src/tools-extra.js` (search, code, files, images), `src/mcp.js` (apps), `src/approvals.js` (buttons), `src/media.js` (voice, photo, files), `src/telegram.js`, `src/util.js`.

Naya tool add karna: `src/tools-extra.js` ke `EXTRA_TOOLS` mein ek entry (`description`, `parameters`, `run`). `readOnly: true` rakhega to background runs mein bhi chalega, `risky: true` rakhega to approval maangega.
