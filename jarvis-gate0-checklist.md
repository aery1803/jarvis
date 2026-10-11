# Jarvis: Gate 0 Checklist (Step by Step)

**Matches:** `jarvis-master-context.md` v3.0 FINAL, Section 22.2 (tasks P1 to P18) and decision D63.
**Goal:** get your laptop, tools, accounts, and repository ready, so that your local AI can start working. Nothing here needs any Jarvis code.
**How to use it:** do the steps in order and tick the boxes. When you finish (or get stuck), send Claude the "Report back" block at the bottom.

## Three safety rules for every step
1. **Never paste a token, password, or recovery code into a chat, an email, a screenshot, or a file inside the project.** Tokens go only into Windows Credential Manager (instructions are in P11 and P12).
2. **Turn on two-step verification** on GitHub, Telegram, and Google before you create anything else.
3. **Install only from the official site** of each tool, and write down the exact version you installed. Pick versions that were released at least 14 days ago. Menu names below can change between versions, so if a menu looks different, tell Claude what you see.

---

## Step 0: Decide the GitHub plan (before P8)
GitHub's documentation says two things that matter here: a fine-grained token **cannot reach a project board owned by a personal account**, and **branch protection on a private repository needs a paid plan** (Pro, Team, or Enterprise). Check the current plans and prices on GitHub's pricing page, then choose:

- [ ] **Option 1 (recommended): an organization on a paid plan.** The organization owns the private repository and the board; GitHub itself enforces branch protection.
- [ ] **Option 2 (fine to start): an organization on the free plan.** Everything works except branch protection on the private repository; only Jarvis's own gateway guards `main` and `master`. You can upgrade later.
- [ ] **Not recommended: your personal account with a personal board.** It forces a broad token that reaches all your repositories.

My choice: ______________________ (write it down; you will mention it in the report)

---

## Part A: The laptop (P1 to P5)

### P1. Back up the laptop
- [ ] Copy your important files to an external drive or a backup service you trust.
- [ ] Create a restore point: search "Create a restore point" in the Start menu, choose your system drive, click Create.
- **Done when:** the backup opens and you can see your files in it.

### P2. Update Windows, the BIOS, and the graphics driver
- [ ] Plug in the charger.
- [ ] Run Windows Update until nothing is pending, then restart.
- [ ] Open the **MyASUS** app and run its live update for the BIOS, firmware, and drivers.
- [ ] Install the current **AMD Software: Adrenalin Edition** for your Ryzen AI Max+ / Radeon 8060S from amd.com.
- [ ] Write down the versions in a text note: Windows (`winver`), BIOS (in PowerShell: `Get-CimInstance Win32_BIOS | Select-Object SMBIOSBIOSVersion`), and the AMD driver (shown in AMD Software).
- **Done when:** the three versions are noted.

### P3. Raise the GPU memory (the default is too small)
Your 64 GB is shared between the processor and the graphics chip. The default GPU share is small, so large models would not fit.
- [ ] Find the setting. It is in one of these places (names vary, so look for "graphics memory", "VRAM", or "UMA frame buffer"): **AMD Software: Adrenalin Edition** (Performance, then Tuning, look for variable graphics memory), the **Armoury Crate** app, or the **BIOS**.
- [ ] Choose a GPU share near **32 to 40 GB**. Always leave **at least 14 to 18 GB** for Windows, the browser, Docker, and the other tools. If the menu offers only presets, take the closest one under 40 GB.
- [ ] Restart (the change needs a reboot).
- [ ] Check: Task Manager, Performance, GPU, **Dedicated GPU memory** shows the new size.
- **If Windows becomes slow or apps crash after this,** lower the share one step and restart.
- **Done when:** Task Manager shows the larger dedicated memory.

### P4. Free up disk space
- [ ] Settings, System, Storage: make sure you have at least **250 GB free** now.
- [ ] Over time keep **at least 25% of the 1 TB free**.
- [ ] Do **not** shrink the Windows partition yet. A Linux partition is only needed if the benchmark later shows Linux is faster.
- **Done when:** free space is 250 GB or more.

### P5. Set the high-performance power mode
- [ ] Use the original charger, plugged in.
- [ ] In Armoury Crate choose the performance operating mode (the name varies, often Performance or Turbo), and set Windows power mode to **Best performance**.
- [ ] Note the settings you used. Heavy AI work will warm the tablet, so give it airflow.
- **Done when:** the settings are noted.

---

## Part B: Tools (P6 and P7)

### P6. Install the toolchain
- [ ] **Git for Windows** (git-scm.com). After installing, run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`.
- [ ] **Node.js, an LTS version, 20 or newer** (nodejs.org).
- [ ] **Docker Desktop**, choosing the **WSL 2** backend, then restart. Docker Desktop is free for personal use and small businesses; check its current terms if you will use it commercially.
- [ ] **VS Code** (code.visualstudio.com).
- [ ] **GitHub CLI** (optional, cli.github.com).
- [ ] Check, in PowerShell: `git --version`, `node --version`, `npm --version`, `docker --version`, `code --version`. Then `docker run hello-world`.
- **Done when:** every command prints a version and `hello-world` runs.

### P7. Install the two local AI engines (for the benchmark)
- [ ] **Ollama** (ollama.com). Test it by pulling any small model (under 1 GB) from the Ollama library and sending one prompt.
- [ ] **llama.cpp, a Windows build with the Vulkan backend.** Download it from the project's GitHub releases page (look for a Windows zip with "vulkan" in its name; the exact name changes), unzip it into a folder such as `C:\tools\llama.cpp`, and run its command-line program with `--version`.
- **Done when:** both programs run on your machine. You do not need to pick models yet.

---

## Part C: GitHub (P8 to P11)
First turn on two-step verification on GitHub (Settings, Password and authentication).

### P8. Organization, private repository, and branches
- [ ] Create the **organization** (the plus menu, New organization), owned by your account. Free plan or paid, as decided in Step 0.
- [ ] In the organization, create the **private repository**. Choose a name (for example `jarvis-local`). Tick "Add a README" so the `main` branch exists.
- [ ] Create the `master` branch: on the repository page open the branch menu, type `master`, and choose "Create branch from main".
- **Done when:** the repository shows both `main` and `master`.

### P9. Branch protection (only if your plan allows it)
- [ ] Repository, Settings, Branches (or Rules, Rulesets): protect **both** `main` and `master`.
- [ ] Turn on: require a pull request before merging, with **required approvals set to 0** (you cannot approve your own pull requests, and the AI uses your account); block force pushes; block deletion; **do not allow bypassing, include administrators**.
- [ ] Leave "required status checks" for later. Claude's repository skeleton adds the checks, and then you add them here.
- [ ] If your plan does not allow branch protection on a private repository, write "skipped, free plan" in your report.
- **Done when:** the rules show on both branches, or the skip is noted.

### P10. The board, its fields, and the nine labels
- [ ] Organization, Projects, New project, **Board** layout. Make it belong to the organization and link it to the repository.
- [ ] Edit the **Status** field so it has **exactly five options, in this order:** `Concept`, `Ready for Dev`, `Code Review`, `QA`, `Done`. Delete the default options you do not need.
- [ ] Add a **Type** field (single select) with the options `Feature`, `Story`, `Bug`.
- [ ] In the repository, Issues, Labels, create these **nine labels:**
  `concept-complete`, `ai-working`, `needs-owner`, `blocked`, `bug`, `release-approved`, `ai-proposed`, `ai-authored`, `owner-approved`
- **Done when:** the board matches and all nine labels exist.

### P11. The limited token (guard it carefully)
- [ ] GitHub, your profile menu, Settings, Developer settings, Personal access tokens, **Fine-grained tokens**, Generate new token.
- [ ] **Resource owner:** the organization. **Repository access:** only the one Jarvis repository.
- [ ] **Permissions:** repository contents, issues, and pull requests read and write; metadata read; the organization's **Projects** permission, read and write. No administration, no settings, no workflows.
- [ ] **Expiration:** 90 days at the most. Put a reminder in your calendar for day 80.
- [ ] The organization may ask you to approve the token. Approve it as the owner.
- [ ] Copy the token **once** and store it in **Windows Credential Manager**: Control Panel, Credential Manager, Windows Credentials, Add a generic credential, address `jarvis-github`, user name `token`, password = the token. Then close the page.
- **Done when:** the token appears in your GitHub token list and is stored only in Credential Manager. Never paste it anywhere else.

---

## Part D: Telegram and the test Gmail (P12 and P13)

### P12. Telegram bots and your user ID
- [ ] In Telegram, turn on **Two-Step Verification** (Settings, Privacy and Security). Your Telegram account is the key to Jarvis, so protect it.
- [ ] Open **@BotFather**, send `/newbot`, and create two bots: one for **development** and one for **QA** (names must end in "bot"). A production bot can wait until later.
- [ ] Store each token in Credential Manager (`jarvis-telegram-dev`, `jarvis-telegram-qa`), the same way as in P11.
- [ ] Find your **numeric user ID** without any third-party bot: send any message to your dev bot, then open this address in your browser, with your token in place of `<TOKEN>`: `https://api.telegram.org/bot<TOKEN>/getUpdates`. Look for `"from":{"id": ...}`. Write the number down. Do not share a screenshot of that page, because it contains the token.
- **Done when:** two bots exist, their tokens are stored, and you know your user ID.

### P13. The test Gmail account (for QA only)
- [ ] Create a **new** Google account used only for testing, in a separate browser profile. Turn on two-step verification.
- [ ] Do not forward any of your real mail to it and do not connect it to your real accounts.
- **Done when:** you can sign in to it. You will give Claude only the address, never the password.

---

## Part E: Editor and models (P14 and P15)
These two depend on current candidates that Claude names in the Phase 0 specification, so you may finish them right after that arrives. Gate 0 is complete when all 18 tasks are done.

### P14. VS Code extensions
- [ ] Turn telemetry off: VS Code settings, search "telemetry", set the telemetry level to off.
- [ ] Install an **agent extension** (a Cline-style one) and an **autocomplete extension** that can use a local model. Claude names the current choices; Section 17.2 lists candidates. Check the publisher before installing.
- [ ] Turn **auto-update off** for these extensions and write down their exact versions.
- **Done when:** the extension list and versions are noted.

### P15. The model roster (for the benchmark)
- [ ] Make a note with columns: name, size, license, source, date downloaded.
- [ ] For each lane, get **at least two models from different families** (Section 7.6): a tool-calling, code-strong model (about 30B mixture-of-experts class, roughly 18 to 20 GB at 4-bit), an alternate of similar size, a small autocomplete model, an embedding model, and a vision-language model.
- [ ] Download only from the official publisher, in safe formats (GGUF or safetensors). Never run code that comes with a download.
- [ ] Read each model's license (Jarvis is proprietary, D53). Kimi's flagship and Claude Sonnet cannot be downloaded; they stay cloud-only.
- **Done when:** the roster note lists every model with its license.

---

## Part F: Rules and housekeeping (P16 to P18)

### P16. Your coding rules
- [ ] Write a first version of how code must be written (even five to fifteen lines: language and style, naming, testing, error handling, commit messages, "no new dependency without my approval"), **or** tell Claude to supply the default template for you to approve.
- **Done when:** you have either a draft or a decision to use the default. The file will live at `docs/rules/CODING_RULES.md` and only you edit it.

### P17. Secrets hygiene
- [ ] Decide where secrets live: **Windows Credential Manager** for tokens and passwords, and a configuration file **outside** the project folder (for example `%USERPROFILE%\.jarvis\settings.env`) for anything else.
- [ ] Claude's skeleton includes a `.gitignore`. After you add it, run `git status` and confirm no secret file appears.
- **Done when:** the locations are decided and written down.

### P18. The project folder
- [ ] Create the folder on the fast internal drive, for example `C:\dev\jarvis-local`.
- [ ] It must **not** be inside OneDrive, Dropbox, Google Drive, or any synced folder (Windows often puts Documents and Desktop inside OneDrive, so avoid those).
- **Done when:** the folder exists and its path is noted.

---

## Report back (copy this into your reply to Claude)
Fill in everything **except secrets**. Never include a token, password, or recovery code.

```
Step 0 GitHub choice:
P1 backup done (yes/no):
P2 versions: Windows ___  BIOS ___  AMD driver ___
P3 dedicated GPU memory now shows: ___ GB
P4 free disk space: ___ GB
P5 power settings used:
P6 versions: git ___  node ___  npm ___  docker ___  code ___
P7 Ollama runs (yes/no), llama.cpp Vulkan runs (yes/no):
P8 organization and repository names (not secret): ___
P8 branches main and master exist (yes/no):
P9 branch protection: on / skipped (free plan)
P10 board has the five columns, Type field, nine labels (yes/no):
P11 token created, stored in Credential Manager, expires on: ___
P12 two bots created (yes/no), my numeric Telegram user ID: ___
P13 test Gmail address (address only): ___
P14 extensions and versions (or "after the Phase 0 spec"):
P15 model roster note done (yes/no, or "after the Phase 0 spec"):
P16 coding rules: draft written / use Claude's default
P17 secrets locations decided (yes/no):
P18 project folder path: ___
Anything that looked different from these instructions:
```

## If you get stuck
Send Claude what you see: the screen name, the menu you are on, and the exact error text (not any token). Typical trouble spots: the GPU memory menu (its name changes between versions), Docker needing a restart after installing WSL 2, and the organization asking you to approve the token.

## What happens after you report
Claude delivers the first stage of the handover package: the builder guide, the Phase 0 setup and benchmark specification, the repository skeleton (templates, `.gitignore`, `CODEOWNERS`, workflow stubs), the board setup guide, the Phase 0b specification for the agent that watches your board, a default coding-rules template, and the preflight script. You then run the preflight check, the readiness test, and the benchmark.
