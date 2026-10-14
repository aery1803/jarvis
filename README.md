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
3. 🤖 **Dev Agent:** Watching your GitHub board to write code and build new features!

To stop everything, simply press **Ctrl + C** in your terminal.

---

## 🎮 How to Use Jarvis

### 1. The Local Web Chat (Like Claude or ChatGPT, but on your machine!)
1. Run `pnpm start` (or `pnpm dev` for auto-reloading).
2. Open [`http://localhost:3000`](http://localhost:3000) in Chrome, Edge, or Brave.
3. Pick your model:
   - 💻 **`qwen2.5-coder:7b` (Code Lane):** Heavyweight coding brain for complete scripts, bug fixes, and testing.
   - 🧠 **`qwen2.5:7b` (Reasoning Lane):** Deep thinker for big questions, essays, and analysis.
4. Type anything you want! The **Web Research** toggle will automatically fact-check your questions on the web and show you source links.

### 2. Chat on Telegram from Your Phone
1. Open Telegram on your phone or PC.
2. Search for your bot: **`@aery_jarvis_dev_bot`**.
3. Send any of these commands:
   - `/help` — Shows the cheat sheet of what Jarvis can do.
   - `/status` — Shows laptop battery, memory, and temperature.
   - `/models` — Lists all the smart AI models installed.
   - `/model qwen2.5-coder:7b` — Switches to the code-writing model!
   - `/benchmark [model]` — Tests reasoning, coding, and speed, giving a real scorecard!
   - `/research <topic>` — Conducts a deep internet investigation and gives you a summary with sources.
   - `/kill` — Emergency stop button that halts all background tasks.

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
| `pnpm start` | **All-in-One:** Starts Web Chat, Telegram Bot, and Dev Agent together! |
| `pnpm dev` | **Auto-Reload:** Runs all services with `nodemon`, auto-restarting on code changes! |
| `nodemon` | Same as `pnpm dev` (when using nodemon globally) |
| `pnpm run web` | Starts only the Web Chat UI on `http://localhost:3000` |
| `pnpm run telegram` | Starts only the Telegram Bot daemon |
| `pnpm run research` | Runs the deep research terminal tool |
| `pnpm run devagent:watch` | Starts the autonomous pair-programming watcher on GitHub |
| `pnpm test` | Runs all 113 automated tests across 32 suites (takes ~5 seconds) |
| `pnpm run build` | Compiles all TypeScript code into production JavaScript |
| `pnpm run benchmark:eval` | Runs intelligence benchmark on installed models (Score, Grade, t/s) |
| `pnpm run searxng` | Starts your local private search engine in Docker |
| `pnpm run preflight` | Checks that your GPU, VRAM, and RAM have enough breathing room |

---

## 💻 Workstation Profile
- **Laptop:** ASUS ROG Flow Z13 (`GZ302EA`)
- **Processor:** AMD Ryzen AI Max+ 395 (16 Cores, 32 Threads)
- **Graphics & AI Engine:** AMD Radeon 8060S (46.5 GB dedicated Vulkan VRAM)
- **RAM:** 64 GB LPDDR5X Unified Memory
- **Operating System:** Windows 11 Home 26H2 (Build 26300)
- **Local AI Engine:** Ollama & `llama.cpp` (Vulkan acceleration)

---

## 📜 Principles & Safety Guarantee
1. **Your computer is the boss:** Jarvis works for you and only you.
2. **Never commit secrets:** Passwords and tokens live in Windows Credential Manager.
3. **100% Local:** No cloud bills, no data selling, no surveillance.
