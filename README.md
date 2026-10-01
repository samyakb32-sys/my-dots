# Telegram AI assistant (a free, DIY take on OpenAI "dots")

Ek always-on AI assistant jo tu **Telegram** se use karta hai. Cloudflare Workers pe chalta hai (free plan, koi server nahi, 24/7 online) aur **kai free open models** use karta hai (DeepSeek, GLM, Llama, Nemotron, gpt-oss). Ek model fail ho to agle pe chala jata hai.

Text ke alawa ye **voice note, photo aur file** bhi samajhta hai, **web search** karta hai, **code chalata hai**, **file aur image bana ke bhejta hai**, aur **MCP** ke zariye **GitHub, Gmail, Calendar jaise apps** se jud sakta hai. Risky kaam se pehle tujhse button se **approval** maangta hai. Kisi **page pe nazar** rakh sakta hai (badle, koi text aaye, price gire to khud message karta hai), aur chahe to ek **asli browser** (screenshot, click) bhi use karta hai.

## Dots se kya match karta hai, kya nahi

| OpenAI dots | Yahan |
|---|---|
| Always-on, Slack/Teams/ChatGPT se access | ✅ Always-on, **Telegram** se access |
| Tere preferences seekhta hai | ✅ `remember` tool + `/memory` (dekh sakta hai, delete bhi) |
| Scheduled / recurring automations | ✅ "roz subah 8 baje ye summary bhej" |
| Khud pehle message karta hai | ✅ Due task pe bot khud message bhejta hai |
| Background mode read-only | ✅ Scheduled runs mein sirf read-only tools |
| Risky kaam pe approval | ✅ Telegram pe ✅/❌ buttons. Poora content dikhta hai, ek approval = ek decision, aur result (ho gaya / fail / pata nahi) record hota hai |
| Cheezein track karna | ✅ `watch_page`: page badle, text aaye, ya price gire to bot khud message karta hai |
| Boundaries set karna | ✅ `TOOLS`, `AUTO_APPROVE`, `ALLOWED_USER_IDS` |
| 4000+ apps via plugins/MCP | ✅ MCP client: Zapier, GitHub, ya koi bhi MCP server (tu server chunta hai) |
| Voice | ✅ Voice note bhej, wo samajhta hai. ❌ Bolke jawab nahi deta (Hindi TTS free nahi mila) |
| Cloud computer | 🟡 Poora computer nahi, lekin `run_code` sandbox mein code chalata hai |
| Browser | 🟡 `fetch_url` JavaScript pages bhi padh leta hai (r.jina.ai se). Optional: asli browser (`browse`, screenshot, approval ke saath click/type), [neeche](#real-browser-optional). Login nahi |
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
| `watch_page`, `list_watches`, `stop_watch` | Page pe nazar: badle / text aaye / price gire to message ([neeche](#page-watch)) | Kuch nahi (KV) |
| `browse`, `browser_screenshot`, `browser_act` | Asli browser: JavaScript pages, screenshot, click/type (click/type pe approval) | Apna browser worker ([neeche](#real-browser-optional)) |

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

Read-only tools (list, search) seedhe chalte hain. Kisi tool ko bina puche chalne dena ho to `AUTO_APPROVE = "github__list_*"` (wildcard chalta hai). Scheduled/background runs mein sirf read-only tools milte hain. Approval kaise kaam karta hai, neeche dekh.

## Approval kaise kaam karta hai

[OpenMuse](https://github.com/CopilotKit/OpenMuse) ke "action review" se seekhke pakka kiya gaya:

- **Poora content dikhta hai.** Arguments lambe hon to pehle poori JSON file aati hai, phir buttons. Jo tu dekh nahi sakta uspe approval nahi maangta.
- **Button request se bandha hai.** Button mein request ka hash hota hai. Request badal gayi ya purani hai to "badal gayi thi" bolke nahi chalata.
- **Ek approval = ek decision.** Do baar dabaya (ya do button ek saath) to sirf pehla jeetta hai. Ye `APPROVAL_LOCK` Durable Object se hota hai (free plan pe chalta hai, `wrangler deploy` khud bana deta hai). `wrangler.toml` se uske do blocks hata de to KV wala best-effort claim chalega: KV mein atomic operation nahi hota, to bahut paas-paas do tap dono chal *sakte* hain.
- **Result record hota hai.** ✅ ho gaya, ❌ fail (nahi chala), ya ⚠️ *pata nahi* (request bheji gayi par jawab nahi mila, to ho sakta hai ho gaya ho). ⚠️ pe bot dobara nahi chalata; pehle app mein check kar. Bot ko bhi history mein yahi likha jaata hai ki retry na kare.
- Wahi call model dobara maange to doosra prompt nahi aata. Expire 1 ghante mein.
- Update se pehle bheje gaye purane approval buttons ab kaam nahi karenge ("badal gayi thi"); bot se dobara bol.

## Page watch

"Jab ye page badle / is par *tickets available* likha aaye / price $50 se neeche jaye to bata." Bol de, bot `watch_page` se background mein dekhta rehta hai aur seedha Telegram pe message karta hai. **Message ke liye LLM nahi chalta**, to model ka free quota nahi khata.

| Condition | Kab alert |
|---|---|
| `change` | Page ka text badle. Pehli baar sirf baseline banta hai, alert nahi. |
| `contains` + text | Page par wo text *aa jaye*. Jab tak rehta hai tab tak baar-baar nahi, hatke dobara aaye tab phir. |
| `price_below` + USD limit | Page par koi bhi `$` / `USD` price limit se kam ho. Page ke *kisi bhi* item ki price chalti hai, ek item ki nahi. |

- Har ghante (default) check; kam se kam 30 minute (`WATCH_MIN_MINUTES` se badha sakta hai, 10 se kam nahi). Har check KV mein 1 write leta hai, aur free plan mein pure din ke 1000 writes hain, to 5 watch x 30 min = 240 writes/din. Isliye ek chat mein max 5 watches.
- Page na khule to wait badhta jaata hai (2x, 4x... max 24 ghante), 5 baar lagatar fail ho to watch khud pause ho jata hai aur ek message aata hai. Pause wale ko `stop_watch` se hata ke naya bana.
- Error pages (404, 503...) ko "page badla" nahi maana jaata: wo fail gina jaata hai (upar wala backoff). Jo page abhi hi error de raha ho, uspe watch banta hi nahi.
- Cron ek baar mein max 3 pages dekhta hai (free plan ki subrequest limit).
- JavaScript wale pages ke liye `fetch_url` jaisa hi r.jina.ai fallback chalta hai (`JINA_FALLBACK = "0"` se band). Badi pages pe free plan ka 10 ms CPU limit lag sakta hai.
- Page ka text aksar badalta rehta hai (timestamp, ads) to `change` baar-baar bol sakta hai. Aisi pages ke liye `contains` ya `price_below` behtar hain.

## Real browser (optional)

`fetch_url` sirf text padhta hai. Asli browser (JavaScript chalta hai, cookies yaad rehti hain, screenshot milta hai) ke liye [OpenMuse](https://github.com/CopilotKit/OpenMuse) ka **browser worker** (Playwright + Chromium, MIT) apni machine pe chala aur bot ko uska URL de. Worker ko ek always-on machine chahiye (apna PC, Raspberry Pi, ya koi VM): ye Cloudflare Workers pe nahi chal sakta. Agar paid VM lega to "bill nahi aayega" wala promise yahan lagu nahi hota.

1. **Worker chala** (Docker chahiye). Ye commit pinned hai, kyunki OpenMuse alpha hai aur API badal sakti hai:
   ```bash
   git clone https://github.com/CopilotKit/OpenMuse.git && cd OpenMuse && git checkout 6c56494
   export WORKER_TOKEN=$(openssl rand -hex 24)   # 48 characters, kam se kam 32 chahiye
   docker compose -f infra/compose.yaml up --build -d   # sirf 127.0.0.1:8790 pe sunta hai
   ```
2. **Internet pe HTTPS URL do**, kyunki Worker (Cloudflare) tere ghar ki machine tak seedha nahi pahunch sakta. Sabse aasaan: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared tunnel --url http://127.0.0.1:8790`). Quick tunnel ka URL har restart pe badalta hai; pakka URL ke liye named tunnel.
3. **Bot ko bata**: `wrangler.toml` mein `BROWSER_WORKER_URL = "https://..."` (https hi chalega), aur `npx wrangler secret put BROWSER_WORKER_TOKEN` (wahi token), phir `npx wrangler deploy`. `/tools` mein `browse`, `browser_screenshot`, `browser_act` dikhne chahiye. Dono na hon to ye tools dikhte hi nahi.

| Tool | Kaam |
|---|---|
| `browse` | URL kholta hai, pata dikhne wala text lautata hai. Har chat ka apna browser session (cookies/profile yaad rehte hain). |
| `browser_screenshot` | Current page ka screenshot **tujhe** Telegram pe bhejta hai. |
| `browser_act` ✋ | Click (x, y), text type, key (Enter/Tab/...), ya scroll. **Har baar tera approval**, aur baad mein screenshot aata hai. |

Seedhi baat:

- **Model screenshot nahi dekh sakta** (tool ka jawab text hi hota hai). Isliye click tabhi kaam ka hai jab tu coordinates bataye ("320, 240 pe click kar"). Form ke liye Tab/Enter behtar hain. Screenshot dekh ke tu bol, bot ek-ek step approval se chalata hai.
- **Login ke liye mat use kar, aur password kabhi mat bhej.** Jo tu chat mein likhta hai wo model providers ko jaata hai. Ye public pages, JavaScript pages, cookie banner / "load more" jaisi cheezon ke liye hai.
- Worker sirf public sites (port 80/443) kholta hai; private/internal addresses wo khud mana kar deta hai. Phir bhi worker ka sandbox default se band hai aur hostile pages se pakki isolation nahi (OpenMuse ke apne docs bhi yahi kehte hain). Tunnel ka URL public hota hai, sirf token rok-tok karta hai: token lamba aur secret rakh.
- Page ka text **untrusted** hai (prompt injection). Isliye `browse` ke jawab mein ye likha aata hai aur click/type approval maangte hain. `browse` background (scheduled) runs mein nahi milta.
- Cold Chromium kholne mein time lagta hai: ~18 second ke baad "too slow" error aata hai. Worker mein 3 saath ke sessions, 30 minute idle ke baad band (agle `browse` pe wahi profile dobara khulta hai).

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

- **Maine zyadatar mock se test kiya hai, asli services se nahi.** Tavily keyless mode, Judge0 public server, Workers AI (toMarkdown, Flux, Whisper), Jina Reader, aur MCP servers (GitHub/Zapier) ke asli behaviour ki guarantee nahi. Pehle chalake dekh, jo kaam na kare wo bata.
- **Jo asli cheez pe check hui:** poora worker local `wrangler dev` (workerd) pe `wrangler.toml` ke saath chala; `APPROVAL_LOCK` Durable Object ne 20 ek-saath claims mein 5/5 baar sirf ek ko jeetne diya (local KV pe fallback ka race dikha nahi, wo KV ki limitation hai jo main reproduce nahi kar paya). `browse` ka request/error wala hissa asli OpenMuse browser worker (is commit ka) ke saamne chala: auth, session id, private addresses ka block, error codes sahi nikle. **Jo check nahi hua:** asli page ka khulna aur screenshot (is machine pe Chromium/internet nahi tha), real Telegram, real KV ki eventual consistency, aur Cloudflare Tunnel.
- Free models slow ho sakte hain. Har jawab ke liye ~25 second ka budget hai, har model ko max 20 second.
- Cloudflare **free plan mein har request ko sirf 10 ms CPU** milta hai. Text chat mein dikkat nahi, lekin badi photo ya badi file (base64, parsing) pe "exceeded CPU" error aa sakta hai. Aisa ho to chhoti photo/file bhej, ya Workers Paid plan ($5/mahina) le.
- Photo 5 MB tak, file 5 MB tak, voice 10 MB tak. File ka sirf shuruaat ka ~12,000 characters model ko jata hai.
- KV ke free 1000 writes/din: har message ~1 write.
- `run_code` ek public sandbox pe chalta hai: wahan internet nahi, aur tera code un servers ko jata hai.
- Bot Hindi mein bolke jawab nahi deta (sirf text). Browser mein click/login/forms nahi.

## Safety notes

(Page watch, approval aur browser ke baare mein upar unke apne sections mein bhi likha hai.)

- Webhook `X-Telegram-Bot-Api-Secret-Token` se verify hota hai, secret set na ho to sab reject hota hai. Approval buttons bhi sirf `ALLOWED_USER_IDS` wale daba sakte hain.
- **Prompt injection**: web page, file ya search result mein chhupi instruction model ko bahekane ki koshish kar sakti hai. Isliye risky actions approval maangte hain aur background runs read-only hain. Phir bhi approval message mein **action ka naam aur arguments dhyan se padh** ke hi ✅ dabana.
- `fetch_url` aur `web_search` se data bahar jaa sakta hai (URL/query ke zariye). Zyada safe rehna ho to `TOOLS` setting se unhe hata de.
- Tera chat aur files 3rd-party free providers (NVIDIA, Groq, Google, Tavily, Jina, Judge0) ko jaate hain. Page watch ke URLs aur (agar tune lagaya) browser worker bhi apne servers se pages kholte hain. Passwords ya private cheezein mat bhej.
- Secrets kabhi commit mat kar. `.dev.vars` gitignored hai.

## Local test aur development

```bash
npm test          # Telegram + sab APIs mock karke 81 tests
npm run dev       # local worker; `.dev.vars` mein secrets rakh
```

Code: `src/index.js` (Telegram routing, commands, cron), `src/agent.js` (agent loop, memory, scheduler, tool registry), `src/models.js` (providers, fallback), `src/tools-extra.js` (search, code, files, images), `src/mcp.js` (apps), `src/approvals.js` (buttons), `src/media.js` (voice, photo, files), `src/telegram.js`, `src/util.js`, `src/watch.js` (page watch), `src/browser.js` (browser worker), `src/page.js` (page text padhna), `src/approval-lock.js` (approval ka Durable Object).

Naya tool add karna: `src/tools-extra.js` ke `EXTRA_TOOLS` mein ek entry (`description`, `parameters`, `run`). `readOnly: true` rakhega to background runs mein bhi chalega, `risky: true` rakhega to approval maangega.

## Credits

Page watch, approval hardening aur browser worker [OpenMuse](https://github.com/CopilotKit/OpenMuse) (CopilotKit, MIT) se prerit hain: uske monitors, action reviews aur `apps/worker`. Browser worker unka hi hai, is repo mein uska code copy nahi kiya, bas uski HTTP API use hoti hai.
