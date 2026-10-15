# ⚡ Jarvis Local AI Agent

> **Meet Jarvis:** Your personal, super-smart, private AI assistant — just like Iron Man's Jarvis, but running 100% locally on your ASUS ROG Flow Z13 laptop! 🚀

---

## 🌟 What is Jarvis? (The 10-Year-Old Explanation!)

Imagine you have a super-smart robot friend who lives **inside your laptop**. 

- 🔒 **It never leaks your secrets:** It does **NOT** send your messages or photos to big cloud companies. Everything stays locked inside your machine!
- 💬 **You can talk to it anywhere:** Chat with it in your web browser, or send voice notes and messages from your phone using Telegram while you're on the couch!
- 🔍 **It is a master detective:** When you ask a question, it searches multiple internet sources, fact-checks whether the information is true, and shows you the proof!
- 💻 **It writes real code & scripts:** Need a Python game, a web page, or a homework helper? Jarvis writes the code, tests it, and fixes its own mistakes!
- 🛡️ **It has a safety shield:** Jarvis will never delete your files or send an email without asking your permission first. And if you ever want it to freeze, you just say `/kill`!

---

## 🚀 The One Magic Command to Start Everything!

You don't need to open ten different windows. You can start all of Jarvis with **one single command**:

```powershell
pnpm start
```
*(Or in PowerShell: `.\scripts\start-all.ps1`)*

### 🔥 Auto-Reload Mode (Watch Mode with Nodemon)
Want Jarvis to automatically re-run whenever you change or improve any code? Run:

```powershell
pnpm dev
# Or if you have nodemon installed globally:
nodemon
# Or in PowerShell with watch flag:
.\scripts\start-all.ps1 -Watch
```
*Whenever you edit any file in `src/` (TypeScript, HTML, CSS, JSON), Nodemon instantly restarts Jarvis cleanly with zero downtime!*

### What happens when you run this?
In 2 seconds, three awesome things wake up at the exact same time:
1. 🌐 **Web Chat Workstation:** Available in your browser at [`http://localhost:3000`](http://localhost:3000).
2. 📱 **Telegram Bot:** Ready to chat on your phone via `@aery_jarvis_dev_bot`.
3. 🤖 **Board monitor:** Reads your GitHub board and logs new, moved or removed cards. It is read-only and does not act on cards.

To stop everything, simply press **Ctrl + C** in your terminal.

---

## 🎮 How to Use Jarvis

### 1. The Local Web Chat (Like Claude or ChatGPT, but on your machine!)
1. Run `pnpm start` (or `pnpm dev` for auto-reloading).
2. Open [`http://localhost:3000`](http://localhost:3000) in Chrome, Edge, or Brave.
3. Pick your model from the dropdown. It lists whatever Ollama has installed (with size), and starts on the resident baseline `qwen3:8b` (`JARVIS_DEFAULT_MODEL`). If Ollama is not running, the dropdown says so instead of showing a made-up list.
4. Type anything you want! The **Web Research** toggle decides whether the question goes to your local SearXNG for sources: on means it searches, off means it never touches the internet. If the model cannot answer, you get an error message and your prompt back in the box, never an invented reply.

The sidebar footer shows host RAM (the Windows partition, about 31.65 GB) and, when the GPU probe works, the separate GPU pool (about 48 GiB Vulkan) where model weights live. A red banner appears if the kill switch is engaged.

### 2. Chat on Telegram from Your Phone
1. Open Telegram on your phone or PC.
2. Search for your bot: **`@aery_jarvis_dev_bot`**.
3. Only the owner is served: set `TELEGRAM_OWNER_ID` to your numeric Telegram user id (send `/id` to the bot to see it). Without it the bot refuses everyone except `/id`. `JARVIS_TELEGRAM_OPEN=1` is a development-only switch that serves every user and disables Telegram approvals.
4. Send any of these commands (any other text is a chat message; a photo is described by an installed vision model):

   | Command | What it does |
   |---|---|
   | `/help` (`/start`) | Lists the commands |
   | `/id` (`/myid`) | Shows your Telegram user id (works for anyone) |
   | `/status` | Host RAM, VRAM, Ollama, loaded models, kill switch, pending approvals |
   | `/kill` | Emergency stop: aborts running turns, downloads and tools, denies waiting approvals, blocks new work |
   | `/resume` | Resets the kill switch (owner only) |
   | `/models` | Installed models with sizes and which are loaded |
   | `/model <name\|auto>` | Pins the chat model, or returns to automatic routing |
   | `/ensemble [on\|off\|<question>]` | Asks several installed models one after another and reports how far they agree |
   | `/research <topic>` | Web research answered with sources |
   | `/agents <goal>` | Multi-agent research pipeline |
   | `/benchmark [model]` | Benchmarks the active or a named model |
   | `/eval` | Runs the evaluation suite |
   | `/cost` | Token usage and speed per model |
   | `/tools`, `/mcp` | Tools with their tiers; MCP servers, tools and failures |
   | `/skills`, `/skill <description>`, `/skill promote <id>` | List skills; generate and sandbox-test one; activate it |
   | `/email [sync]` | Lists stored emails (untrusted text) |
   | `/phone` | Phone status and notifications over adb |
   | `/memory`, `/forget <key>` | Lists profile facts and vault labels; deletes a fact or vault entry |
   | `/new [name]`, `/sessions`, `/switch <number\|id>`, `/delete <number\|id>` | Manage sessions |
   | `/tasks` | Task list with real statuses |

   A Tier 2 action (for example sending an email or running a command that is not on the read-only list) arrives as a message with Approve and Deny buttons. Nothing runs until you tap Approve.

### 3. The Web API
The web UI uses these endpoints on `http://localhost:3000` (POST and DELETE need the header `X-Jarvis-Client: web`):

| Endpoint | Purpose |
|---|---|
| `POST /api/chat/stream` | Chat turn as server-sent events: `{chunk}`, `{sources}`, `{status}`, `{model}`, `{tool}`, `{error}`, `{partial}`, then `[DONE]` |
| `GET /api/health`, `GET /api/diagnostics` | Memory, GPU pool and Ollama state (diagnostics are cached for 15 s) |
| `GET/POST /api/sessions`, `GET /api/sessions/:id/messages`, `DELETE /api/sessions/:id` | Sessions and their messages |
| `GET /api/status`, `/api/models`, `/api/ledger`, `/api/tools`, `/api/mcp`, `/api/phone` | Runtime state, models, token ledger, tools, MCP servers, phone |
| `GET /api/approvals`, `POST /api/approvals/:id` | Pending Tier 2 approvals; approve or deny one |
| `POST /api/kill`, `POST /api/kill/reset` | Engage or reset the kill switch |
| `POST /api/media/describe` | Describe an image with an installed vision model |
| `GET/POST /api/skills`, `POST /api/skills/:id/test`, `POST /api/skills/:id/promote` | Skills |
| `GET/POST /api/benchmark`, `GET/POST /api/eval` | Benchmarks and evaluation (one run at a time). Accuracy is correctness only; latency and decode t/s are reported per case |
| `POST /api/probe/speed` | Decode-speed probe: body `{model?, numCtx? (512-131072), numPredict? (default 128, max 512), repeat? (1-5, default 3), think?}`; returns Ollama's own load, prompt-eval and decode counters as ms and tokens/s, the median and best decode t/s of the warm runs, and what `/api/ps` reports. Shares the one-at-a-time slot with benchmarks |
| `POST /api/agents/research` | Multi-agent research |
| `GET /api/email`, `POST /api/email/ingest`, `POST /api/email/:id/draft`, `POST /api/email/:id/send` | Email (sending needs your approval) |

---

## 🔮 Jarvis's Superpowers

| Superpower | What It Does |
|---|---|
| 🔍 **Consensus Fact-Checking** | Doesn't just guess! It checks Google, DuckDuckGo, and Wikipedia, compares their stories, and gives a confidence score (e.g. 95% sure). |
| 💻 **Code Builder** | Writes TypeScript, Python, HTML, PowerShell scripts, and unit tests. |
| 🧠 **Multi-Tier Memory** | Remembers who you are, your style, and previous chats, keeping passwords safe in an AES-256 encrypted vault. |
| 🛡️ **3-Tier Action Gateway** | **Tier 1 (Safe):** Reading and testing.<br>**Tier 2 (Review):** Changing files or external actions.<br>**Tier 3 (Strictly Blocked):** Deleting databases or sending emails without owner approval. |
| 📱 **Phone & Device Control** | Checks Android phone status, battery, notifications, and screen. |
| 📧 **Email Summarizer** | Reads incoming emails, prepares drafts, but **never sends** without you clicking [Approve]. |

---

## 🎯 Fun Questions You Can Try Right Now!

Copy and paste any of these into Jarvis to see the magic:

1. **For Research:**
   > *"Explain how the AMD Radeon 8060S unified memory works like I'm 10 years old."*
2. **For Coding:**
   > *"Write a fun text-based adventure game in Python where I explore a haunted spaceship."*
3. **For Deep Search:**
   > *"What are the latest discoveries from the James Webb Space Telescope? Give me sources."*
4. **For Scripts:**
   > *"Write a PowerShell script that cleans temporary files and tells me how much disk space was saved."*

---

## 🛠️ Individual Commands Cheat Sheet

If you ever want to run just one specific piece of Jarvis:

| Command | What It Runs |
|---|---|
| `pnpm start` | **All-in-One:** Starts Web Chat, Telegram Bot, and the read-only board monitor together! |
| `pnpm dev` | **Auto-Reload:** Runs all services with `nodemon`, auto-restarting on code changes! |
| `nodemon` | Same as `pnpm dev` (when using nodemon globally) |
| `pnpm run web` | Starts only the Web Chat UI on `http://localhost:3000` |
| `pnpm run telegram` | Starts only the Telegram Bot daemon |
| `pnpm run research` | Runs the deep research terminal tool |
| `pnpm run devagent:watch` | Starts the autonomous pair-programming watcher on GitHub |
| `pnpm test` | Runs the whole automated test suite |
| `pnpm run build` | Compiles all TypeScript code into production JavaScript |
| `pnpm run benchmark:eval` | Runs intelligence benchmark on installed models (Score, Grade, t/s) |
| `pnpm run searxng` | Starts your local private search engine in Docker |
| `pnpm run preflight` | Checks that your GPU, VRAM, and RAM have enough breathing room |

---

## 💻 Workstation Profile
- **Laptop:** ASUS ROG Flow Z13 (`GZ302EA`)
- **Processor:** AMD Ryzen AI Max+ 395 (16 Cores, 32 Threads)
- **Graphics & AI Engine:** AMD Radeon 8060S (about 48 GiB Vulkan pool; 47.8 GiB reported by `llama-cli --list-devices`)
- **RAM:** 64 GB LPDDR5X unified memory, split at boot: Windows and Node see about 31.65 GB, the rest is the GPU pool that model weights load into (see `/api/diagnostics`)
- **Operating System:** Windows 11 Home 26H2 (Build 26300)
- **Local AI Engine:** Ollama & `llama.cpp` (Vulkan acceleration)

---

## ⚙️ Settings

Every setting is read from the environment first, then from `%USERPROFILE%\.jarvis\settings.env` (`KEY=value` lines, never committed). Secrets such as tokens live in Windows Credential Manager, not here.

| Setting | Default | Meaning |
|---|---|---|
| `JARVIS_DEFAULT_MODEL` | `qwen3:8b` | Resident baseline model used when a request names none |
| `JARVIS_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `JARVIS_SEARXNG_URL` | `http://127.0.0.1:8080` | SearXNG endpoint |
| `JARVIS_SEARCH_LIVE_FALLBACK` | `true` | Search DuckDuckGo directly when SearXNG is down (privacy trade-off: only the query text leaves your machine, and the reply says which engine answered); set `0` to turn it off |
| `JARVIS_THINKING` | `off` | Reasoning control: `off` sends `think:false` to the qwen3 family (reasoning tasks and deepseek-r1/Nemotron keep their own default), `auto` leaves every model's default, `on` always thinks |
| `JARVIS_ALLOW_MODEL_PULL` | `false` | Allow model downloads (Tier 2: each one still needs your approval) |
| `JARVIS_CONTEXT_TOKENS` | `16384` | Token budget for a chat turn |
| `JARVIS_MIN_HOST_FREE_GB` | min(14, 25% of host RAM) | Minimum free host RAM before a model loads; model weights themselves are budgeted against the GPU pool |
| `TELEGRAM_OWNER_ID` | none | Numeric Telegram user id of the only person the bot serves |
| `JARVIS_TELEGRAM_OPEN` | off | Development only: serve every Telegram user when no owner is set (disables Telegram approvals) |
| `JARVIS_VAULT_KEY_PATH` | `~/.jarvis/vault.key` | Where the vault encryption key file lives; `JARVIS_VAULT_KEY` overrides the file |
| `JARVIS_MCP_SERVERS` | none | JSON array of `{ "name", "command", "args", "env" }` |
| `JARVIS_WEB_HOST` | `127.0.0.1` | Web UI bind address |
| `JARVIS_WEB_ALLOWED_IPS` | none | LAN client IPs or IPv4 CIDR ranges (for example `192.168.1.0/24`); required to bind beyond loopback, bad entries stop startup |
| `JARVIS_WEB_ALLOWED_ORIGINS` | none | Extra browser origins allowed to make changes |
| `PORT` | `3000` | Web UI port |

The web API sends no CORS headers. Changes (POST, DELETE) must come from the bundled UI, which adds `X-Jarvis-Client: web`; other callers must send that header too. Benchmarks are `POST /api/benchmark` only, one at a time.

The SearXNG container reads its secret from `SEARXNG_SECRET`; set it in your shell or a git-ignored `.env` file next to `docker-compose.yml` before `pnpm run searxng`.

---

## 📜 Principles & Safety Guarantee
1. **Your computer is the boss:** Jarvis works for you and only you.
2. **Never commit secrets:** Passwords and tokens live in Windows Credential Manager.
3. **100% Local:** No cloud bills, no data selling, no surveillance.
