# Jarvis Local AI Agent: Master Design and Context Document

**Version:** v3.1 (Hardware Audited, Vulkan 54GB VRAM Confirmed, Gate 0 In Progress, Merged Master Specification)
**Status:** **IN PROGRESS - GATE 0 EXECUTION.** Requirements approved (D61). Hardware profile actively audited and confirmed on ASUS ROG Flow Z13 (`GZ302EA`). Native Windows Vulkan GPU acceleration verified with 54+ GB free VRAM (`llama.cpp` b11272). Personal private repository linked (`aery1803/jarvis`) with `main` and `master` synchronized. Gate 0 checklist (`jarvis-gate0-checklist.md`) is now fully merged into Section 22.2 as the single standalone master file.
**Purpose:** The single source of truth for the Jarvis project. Holds the complete architecture, verified hardware baseline, decisions, and live Gate 0 checklist.

**Labels used throughout**
- **[OWNER]** stated or decided by the owner.
- **[PROPOSED]** a design suggestion from Claude, not yet confirmed by the owner.
- **[DEFERRED]** the owner will answer later.
- **[VERIFY]** a time-sensitive fact (software, models, versions) that must be re-checked at build time.

---

## A. Start Here: A Plain-Language Guide for the Owner

### A.1 What this document is
This is the **one master document** for the Jarvis project. It holds everything you asked for, every decision you made (each has an ID such as D42), the design Claude proposes, the prerequisites, and the plan. **You do not have to read all of it.** Read this Section A, then **Section 23** (a one-page summary), then **Section 22** (what to prepare). Everything else is reference, and your local AI reads it in small pieces (Section 22.4).

**How to tell decisions from suggestions**
- **[OWNER]** means you decided it.
- **[PROPOSED]** means it is Claude's suggestion, which you can change.
- **[DEFERRED]** means you will answer later.
- **[VERIFY]** means a fact that must be re-checked when building, because software changes fast.

**How the parts connect:** what you asked for (Section 2) leads to decisions (Section 3), which lead to the design (Sections 4 to 21), which lead to the prerequisites and plan (Sections 21 and 22). Section 26 traces every request to its decisions and sections.

### A.2 Jarvis in plain words
- It runs **on your Z13**, not in the cloud, so your data stays with you.
- You talk to it on **Telegram** (text or voice notes) and by **voice on the laptop**.
- It **remembers you across every chat**, yet keeps separate tasks separate.
- It **looks things up on the internet**, checks several sources, and tells you how sure it is.
- It **watches your Gmail**, sends summaries to Telegram with buttons, writes draft replies, and sends nothing until you approve.
- It can **operate your browser, your laptop, and your phones** (deepest on Android). Anything risky asks you first.
- It **chooses the right AI model for each job**, loads it only if the machine has room, and keeps things cheap without lowering quality.
- It keeps **several strong models** (Qwen-class and others) so there is always an alternative. The very biggest ones, such as Kimi's flagship and Claude Sonnet, cannot run on your laptop and are cloud-only, so they need your approval each time.
- It **learns how you work**, creates new skills (telling you first), and turns repeated successes into fast "reflexes".
- It **understands images and video**: it tells you what is in them, reads the text, builds context from them, edits several at once, and can generate images (and short video clips, slowly) when you ask.
- It is an **agent platform**: it calls tools, connects to outside tools through MCP, retrieves knowledge with sources, runs **several agents at once**, builds new agents, trains small machine-learning models, and keeps learning. "AGI" is the long-term direction, not something a laptop can promise today (Section 5.2).
- It stays **safe**: it runs in a sealed box, every action has a permission level, and one command stops everything.
- It is **built like a real software project**: you write tickets on a GitHub board; the AI plans, asks questions, builds, and writes tests; you review, test, and decide when to release.

### A.3 How the project will run day to day
1. You write a **Concept** ticket: what you want and how it should work.
2. The AI reads it and replies with what it understood, a plan, and numbered questions with suggestions.
3. You answer the questions. When none are left, **you** move the ticket to **Ready for Dev**.
4. The AI builds it, writing tests first, and notes every new requirement, error, or limitation on the ticket. Then it moves the ticket to **Code Review**.
5. You review the code. The AI answers your questions and fixes what it can.
6. When you approve, the ticket moves to **QA**. You try the feature in a test copy of Jarvis.
7. When QA passes, you move it to **Done**. The AI merges the story into its feature branch.
8. When every story of a feature is Done, the feature merges into `main` automatically.
9. When **you** decide, and confirm on Telegram, `main` is released to `master` and the global build is made.

### A.4 Your first steps, in order
1. **Read Section 23** and tell Claude what is wrong or missing. This is the last chance to change the plan cheaply.
2. **Prepare the laptop (P1 to P5, Section 22.2):** back it up, update Windows, BIOS, and the graphics driver, raise the GPU memory and reboot, free up disk space, and set the high-performance power mode.
3. **Install the tools (P6 and P7):** Git, Node.js, Docker Desktop, VS Code, Ollama, and a llama.cpp build for testing.
4. **Set up GitHub (P8 to P11):** first choose the plan (the note under the Section 22.2 table), then create the organization and its private repository, branch protection if your plan allows it, the five-column board, and the limited access token.
5. **Create the test accounts (P12 and P13):** the Telegram bots for development and QA, and the test Gmail account. Note your Telegram user ID.
6. **Set up the editor and models (P14 and P15):** the VS Code extensions and a first set of models to benchmark.
7. **Write your coding rules, or approve Claude's default template (P16)**, then finish the housekeeping (P17 and P18).
8. **Tell Claude you are done.** Claude then delivers the first stage of the handover package (Section 22.3).
9. **Run the preflight check and the readiness test (Sections 22.5 and 22.6)** before the local AI is trusted with the board.
10. **Run the benchmark (Phase 0)** and then **build the minimal Dev Agent (Phase 0b)** with your local AI. After that, everything flows through the board.

**Do not give your local AI the whole document.** It gets the builder guide and a small context pack for each task (Section 22.4).
**You do not need to do yet:** the OpenClaw notes, the never-store list, the production Telegram bot, the production Gmail setup, phone setup, voice hardware, the distribution channel for other people, MCP servers, the ML workbench, the agent factory, or the image and video generation models (Section 22.7).

### A.5 Who decides and who does what
| | You | Your local AI (the Dev Agent) | Claude |
|---|---|---|---|
| **Decisions** | Make every decision marked [OWNER]; approve or change [PROPOSED] items | Proposes answers and options on tickets; never decides alone on scope | Proposes designs and options; records your decisions |
| **Writing** | Concept tickets, most user stories, coding rules, code review comments | Concept replies, code, tests, updates, pull requests | The master document, the blueprint, reference code, templates |
| **Approvals** | Code review, QA, moving cards to Done, the release label, the Telegram release confirmation | Cannot approve its own work or release | Cannot approve anything for you |
| **Always needs your approval** | Sending email, deleting, installing, payments and transfers, social posts, shell commands on your laptop, cloud-model use, merging into `master` | | |

### A.6 Document map
| Section | What it covers | Read it when |
|---|---|---|
| **A. Start Here** | This guide: plain-language overview, first steps, and who does what | You begin |
| **0. How to Use This Document in a New Conversation** | How to hand this document to Claude, or any AI, in a new chat, and the rules the AI must follow when it reads it. | You hand this document to an AI |
| **1. Vision and Principles** | What Jarvis is, what it is for, and the seven principles it follows. | You want the big picture |
| **2. Owner Requirements (consolidated, in the owner's intent)** | Everything you asked for, in one list (R1 to R24). | You want to check what you asked for |
| **3. Decision Register** | Every decision made, each with an ID (D1 to D63). Other sections point back to this table. | You want to check or find a decision |
| **4. Hardware and Environment** | Your machine, and what it means for how Jarvis is designed. | You want to know what your hardware means |
| **5. Architecture and Agent Platform** | One picture of how the pieces fit together, plus the agent abilities: tools, MCP, RAG, several agents at once, adaptive learning, and images and video. | You want the overall structure |
| **6. Safety, Isolation, and Permissions** | How Jarvis stays safe: where it runs, what it may do alone, and what always needs your approval. | You want to know what Jarvis may do alone |
| **7. Models: Lanes, Efficiency, Orchestration** | Which AI models Jarvis uses and downloads, how they are kept lean and fast, and how the right one is chosen and loaded. | You are choosing or tuning models |
| **8. Memory and Context Architecture** | How Jarvis remembers you and your work across every chat without wasting effort or leaking private data. | You want to know how memory works |
| **9. Skills and Self-Learning** | How Jarvis learns how you work, creates new skills, and builds muscle memory from experience. | You want to know how Jarvis learns |
| **10. Research and Fact-Check Skill (original pipeline)** | The original research feature: search the web, read pages, cross-check, and answer with sources. | You want the research feature |
| **11. Telegram Interface, Sessions, and Tasks** | How you talk to Jarvis on Telegram, and how several tasks stay separate. | You use Telegram |
| **12. Automation: Browser, Laptop, and Phones** | How Jarvis operates the browser, your laptop, and your phones. | You automate browser, laptop, or phone |
| **13. Email and Proactive Monitoring** | How Jarvis watches your Gmail and reports to you on Telegram. | You set up email |
| **14. Voice** | How you can talk to Jarvis by voice. | You set up voice |
| **15. Information Access Policy** | Jarvis does not filter what you are allowed to look up. | You wonder what Jarvis will and will not look up |
| **16. Quality, Cost, and Evaluation** | How Jarvis balances quality and cost, and how the 90% accuracy goal is measured. | You care about quality, cost, and accuracy |
| **17. Local AI Coding Environment and Development Workflow (Phase 0 onward)** | How Jarvis gets built: your local AI coding setup and the GitHub board workflow from idea to release. | You set up the editor or the GitHub board |
| **18. Tech Stack and Build Conventions** | The tools and packages used, and the rules for installing them safely. | You install anything |
| **19. Project Structure** | The folders and files of the project, and what Claude hands over for building it. | You create the project folders |
| **20. Original Spec Baseline and Known Issues** | What the original document said, and which parts were wrong or have changed. | You compare with the original spec |
| **21. Roadmap** | The order in which things get built. | You plan the order of work |
| **22. Prerequisites and Handover to the Local AI** | What you must prepare before your local AI can start, and what Claude delivers. | You prepare to start |
| **23. Final Summary for Owner Confirmation** | A one-page summary of the whole plan, for you to confirm or correct. | You confirm the plan |
| **24. Open and Deferred Items** | What is still open or deferred, and what will be designed later. | You want to see what is still open |
| **25. Interview Log and Changelog** | How this document was put together, in order, and how it changed. | You want the history |
| **26. Traceability Matrix** | Each thing you asked for, traced to the decisions and sections that cover it. | You trace a request to its decisions |
| **27. Glossary** | Plain meanings of the technical words. | A word is unclear |
| **28. The Owner's Requests in Their Own Words** | Your requests in your own words, so the original intent is never lost. | You want your original words |

### A.7 Reading paths
- **Ten minutes:** Section A, then Section 23.
- **Ready to start building:** Section A.4, then Section 22.
- **Checking a decision:** Section 3, then the section named in its last column; Section 26 shows the whole trail.
- **Handing the project to your local AI:** do not paste everything; follow Section 22.4.
- **A word you do not know:** Section 27.
- **What you originally said:** Section 28.

---

## 0. How to Use This Document in a New Conversation

*In plain words: How to hand this document to Claude, or any AI, in a new chat, and the rules the AI must follow when it reads it.*

Say: *"This is the master context for my Jarvis project. Read it fully and continue from Section 24."*

**Instructions for Claude when reading this file**
1. Treat **[OWNER]** items as decisions. Treat **[PROPOSED]** items as suggestions that still need the owner's confirmation.
2. **Claude writes the blueprint package; the owner's local AI writes the code from it (D35).** The owner said "that's all" (D55) and approved the plan by requesting the final revision (D61), so Section 23 counts as confirmed. Produce the handover package (Section 22.3) in stages once the owner reports that Gate 0 is done.
3. After every new piece of information, update this document: bump the version, fold the information into the right section, update the decision register (Section 3), and add a line to the changelog (Section 25).
4. Keep the owner's intent and wording. Never present a proposal as a decision.
5. Do not suggest or configure tools that expose the local environment to the internet (public tunnels and similar). This also matches the project's own no-public-exposure rule (Section 6).
6. Follow the build conventions in Section 18 for every dependency and install command.
7. **Current stage (v3.0, final):** requirements are complete and approved. Do not collect more requirements unless the owner adds them. The next steps are, in order: the owner completes Gate 0 in Section 22 (using `jarvis-gate0-checklist.md`); Claude delivers the handover package (Section 22.3) in stages, starting with Phases 0 and 0b.
8. **Run the documentation consistency check after every edit (D57):** every section reference, decision ID, requirement ID, and prerequisite ID must resolve to something that exists. Fix any break before delivering the document.

---

## 1. Vision and Principles

*In plain words: What Jarvis is, what it is for, and the seven principles it follows.*

**Jarvis Local AI Agent** is a fully local, privacy-first personal AI assistant for one owner, running on an ASUS ROG Flow Z13 (2025). The owner wants something close to Iron Man's Jarvis in everyday practice: an assistant that helps with all daily work, learns how the owner works and communicates, creates new skills when it needs them, controls the browser, the laptop, and the phones, watches email and reports through Telegram, and keeps its memory across every conversation.

It began as a research agent (search, scrape, cross-verify, cited answer). That pipeline remains, but it is now **one skill among many**. References named by the owner: **OpenClaw** (Jarvis should be a similar but more advanced version), **Iron Man's Jarvis** (the experience), and **Comet by Perplexity** (agentic browser and device control).

**Principles**
1. **Truth-seeking.** Never rely on a model's memory alone for factual, temporal, or real-time questions; verify across sources and label confidence.
2. **Local-first and private.** Models, memory, and search run on the owner's hardware. One approval-gated cloud exception exists (D22).
3. **Quality before cost.** Quality is a hard constraint; cost is optimized only after it is met (D14).
4. **Transparency.** Jarvis announces what it will do before it does it (D8).
5. **Owner in control.** Approval rules are set by the owner, per skill (D23); some actions always need approval.
6. **Efficient with hardware.** Lean models, careful memory use, thermal awareness (D33).
7. **Untrusted content stays data.** Emails, web pages, files, and screens can never give Jarvis commands.

---

## 2. Owner Requirements (consolidated, in the owner's intent)

*In plain words: Everything you asked for, in one list (R1 to R24).*

| # | Requirement |
|---|---|
| R1 | Do everything the owner needs in daily work, not only search and fact-check. |
| R2 | Understand the owner: learn how they work and communicate through **active skills**. |
| R3 | Create or acquire new skills by itself when needed, but **tell the owner first**. |
| R4 | Run in a safe place: Docker, only if it costs no efficiency or result quality (D18). |
| R5 | Automate things on the laptop and on both phones, in the manner of Comet. |
| R6 | Detect important new emails, summarize them, and send the summary over a Telegram bot so the owner can act from the phone. |
| R7 | A smart **master model** that understands commands, uses search, picks the right model for each task, checks hardware specs, and loads it locally. |
| R8 | Persistent memory across **all** conversations; use context wisely to save tokens while staying **90%+ accurate**; decide what stays in context and what goes to the RAG database; learn from all data. |
| R9 | Use the full potential of the workstation (64 GB, 1 TB). |
| R10 | No restriction on information available on the internet (D10). |
| R11 | Everything accessible from Telegram. |
| R12 | Separate sessions and tasks that never mix, while Jarvis keeps knowledge of the person, per Telegram user. |
| R13 | Browser automation with free tools: **Playwright**. |
| R14 | Better quality at lower cost; compromise on cost, never on the result. |
| R15 | **Build Jarvis's own code with the owner's local AI** inside VS Code (or Cursor), with an AI coding agent and Cursor-style autocomplete (Section 17). |
| R16 | Use mostly **quantized, English-only, lean** models; remove unneeded computation so the model's capacity goes to results; use memory efficiently (Section 7.3). |
| R17 | Voice in every mode (D24). |
| R18 | Rewrite the whole document with everything discussed (this document). |
| R19 | Claude writes the complete **blueprint**; the owner's **local AI builds the code entirely** from it (D35). |
| R20 | The local AI **learns by doing**: every time it does something it forms connections about how, what, and when, like human muscle memory or neurons strengthening with repetition (D36, Section 9.4). |
| R21 | Run the project like a **real software project**: all code in the owner's Git repository; a GitHub kanban board where the AI automatically picks up new and updated tickets; stages Concept, Ready for Dev, Code Review, QA, Done; story, feature, main, and master branches; the AI writes tests; release only when the owner decides (Section 17.6 to 17.12). |
| R22 | **Download good AI models** (Qwen, Kimi, Sonnet, and others) so that if one model can give a good result, the others can too: a roster with alternates in every lane (D58, Section 7.6). |
| R23 | Jarvis must have the abilities of **adaptive ML, AGI, building AI agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system**, so that **multiple works can run together** (D59, Section 5). |
| R24 | Jarvis must handle **images and video**: understand what is in shared images and make the context, read text in them, **generate images when required**, accept **multiple images** to edit and to read, and do **the same for video** (D60, Section 5.10). |

---

## 3. Decision Register

*In plain words: Every decision made, each with an ID (D1 to D63). Other sections point back to this table.*

| ID | Decision | Section |
|---|---|---|
| D1 | **[OWNER]** Deliver both a detailed design document and the code. *Refined by D35: the code deliverable is a complete implementation blueprint that the owner's local AI turns into code.* | 0, 19.3 |
| D2 | **[OWNER]** No building until the owner says "that's everything"; summary-back first. | 0 |
| D3 | **[OWNER]** This master document is the single source of truth, updated after every message. | 0 |
| D4 | **[OWNER]** Scope is a general personal assistant; the research pipeline is one skill. | 1 |
| D5 | **[OWNER]** Run in an isolated environment. *Refined by D18.* | 6 |
| D6 | **[OWNER]** A Telegram bot is the notification and command channel. | 11 |
| D7 | **[OWNER]** Persistent cross-chat memory with a context-versus-RAG policy, token-efficient, 90%+ accurate. | 8 |
| D8 | **[OWNER]** Jarvis can create its own skills but announces what it will do first. | 9 |
| D9 | **[OWNER]** The master model selects task-appropriate models and checks hardware before loading. | 7 |
| D10 | **[OWNER]** Unrestricted information retrieval; no topic filters at the agent level. | 15 |
| D11 | **[OWNER]** Telegram is the universal interface. | 11 |
| D12 | **[OWNER]** Strict session isolation with a shared per-user profile; phase 1 is one session per user named with `/commands`. | 11 |
| D13 | **[OWNER]** Free open-source browser automation. *Refined by D31.* | 12 |
| D14 | **[OWNER]** Quality is a hard constraint; cost is minimized subject to it. | 16 |
| D15 | **[OWNER]** Use the full workstation through tiered model lanes. | 7 |
| D16 | **[OWNER]** Hardware is the ROG Flow Z13 2025: Ryzen AI Max+ 395, Radeon 8060S, 64 GB unified memory, 1 TB. The original 6-8 GB VRAM assumption is dropped. | 4 |
| D17 | **[OWNER]** OS: Windows 11, plus dual-boot Linux if benchmarks show it is faster. Code must be cross-platform. | 4, 7.5 |
| D18 | **[OWNER]** Isolation is efficiency-first: use Docker only if it costs no result quality or efficiency; no full VM. | 6 |
| D19 | **[OWNER]** Phone scope: open apps and tap/type (Android), calendar/contacts/reminders, read and forward notifications, Telegram baseline, and anything a normal user does on a phone. Both Android and iPhone are used. | 12 |
| D20 | **[OWNER]** Laptop scope: files and folders, browser and websites, coding/terminal/dev tools, and any app on screen (full computer control). | 12 |
| D21 | **[OWNER]** Email (Gmail / Google Workspace): read, summarize, write drafts, and send replies only after the owner approves each one. | 13 |
| D22 | **[OWNER]** Cloud models only for very hard tasks, with the owner's approval each time. | 16 |
| D23 | **[OWNER]** Approval rules are set by the owner, per skill, as the project goes on. | 6 |
| D24 | **[OWNER]** Voice in all modes: text, Telegram voice notes, and live voice on the laptop. | 14 |
| D25 | **[OWNER]** Single user now (the owner), others maybe later; design multi-user-ready. | 11 |
| D26 | **[OWNER]** Multi-task routing: auto-routing first. | 11 |
| D27 | **[OWNER]** Encrypt only sensitive memory items. | 8 |
| D28 | **[OWNER]** Measure "90%+ accurate" with automatic tests plus the owner's feedback. | 16 |
| D29 | **[OWNER]** With fewer than 3 sources, always label (High / Unverified / Contradictory) and still answer. | 10 |
| D30 | **[OWNER]** Logged-in browsing allowed for Google services, work tools, social media, and shopping/banking sites. | 12 |
| D31 | **[OWNER]** Browser automation tool: Playwright. | 12 |
| D32 | **[OWNER] + [PROPOSED]** Build Jarvis with local AI in an editor with an agent and autocomplete. Proposed: **VS Code-based**, not Cursor, because Cursor's local-model route needs a public tunnel. | 17 |
| D33 | **[OWNER] + [PROPOSED]** Model efficiency policy: mostly quantized, English-only, lean models, memory-efficient, with a quality guardrail. | 7.3 |
| D34 | **[OWNER]** This document is rewritten as one consolidated master document (v1.0). | 0 |
| D35 | **[OWNER]** Claude writes everything the blueprint needs; the owner's local AI then builds the code entirely, working in the local coding environment. | 17.5, 19.3 |
| D36 | **[OWNER] + [PROPOSED]** Experience learning ("muscle memory"): whenever the local AI does something, it records and strengthens connections about how, what, and when. Proposed as an external connection graph, not weight changes. | 9.4 |
| D37 | **[OWNER]** The project runs like a real software project: all code lives in the owner's Git repository on GitHub, and the GitHub Projects kanban board is the control surface. The AI, acting as a developer, picks up new and updated tickets automatically and records everything on them. | 17.6 |
| D38 | **[OWNER]** Board stages and gates: **Concept** (owner writes the expectation; AI posts understanding, blueprint, and questions with suggestions), **Ready for Dev** (only after all AI questions are answered; AI builds and logs new requirements, errors, and limitations), **Code Review** (owner reviews; AI answers, fixes, and resolves comments), **QA** (owner tests; AI has already written and run tests), **Done**. These are the **only five columns** (owner, v1.3). | 17.7 |
| D39 | **[OWNER]** Branching and release: a story merges into its feature branch when it is Done; a feature branch merges into main when all its stories are Done; merging into master and the global build for all users happen only when the owner decides. | 17.8 |
| D40 | **[OWNER]** The AI writes tests at build time so that QA finds fewer bugs. The owner supplies the coding rules and instructs the AI how to write code. | 17.11 |
| D41 | **[PROPOSED]** Automation mechanism: outbound polling of the GitHub API (no webhooks, no tunnels), a least-privilege single-repository token (identity per D42), protected branches, and the owner as the only approver for master. | 17.10 |
| D42 | **[OWNER]** The AI signs in to GitHub with the **owner's own account** (the owner chose this over the recommended separate bot account or GitHub App). Because GitHub then cannot tell the AI from the owner, the compensating safeguards in Section 17.10 are required. | 17.10 |
| D43 | **[OWNER]** An approved release produces **all of**: Docker images, installers for Windows and Linux, automatic updates on the owner's own devices, and a release that other people can install later. | 17.8 |
| D44 | **[OWNER]** The QA copy of Jarvis connects to a **separate test Telegram bot and a test Gmail account**, never to the owner's real ones. | 17.9 |
| D45 | **[OWNER]** Merge style: **squash** each story into its feature branch; use a **merge commit** when a feature merges into main. | 17.8 |
| D46 | **[OWNER]** English-only main models, plus an **optional translation model that loads only when a non-English page is useful**. | 7.2, 7.3 |
| D47 | **[OWNER]** The editor for building Jarvis with the local AI is **VS Code** (not Cursor, not VSCodium). | 17.3 |
| D48 | **[OWNER]** Blueprint depth: **all**. Interpreted as the maximum: interfaces, schemas, pseudocode, tests, and complete reference code for as many modules as practical, delivered in stages (Section 19.3). | 19.3 |
| D49 | **[OWNER]** Learning is not limited to external memory: the AI may also **retrain the model's weights later, on data the owner approves**. Not in version 1 (Section 9.5). | 9.5 |
| D50 | **[OWNER]** The GitHub repository is **private**. Release artifacts for other people therefore need their own distribution channel (decided later, D51). | 17.10 |
| D51 | **[OWNER]** How other people receive Jarvis is **decided later**; the release pipeline must be built so that **either invite-only or public distribution works**. | 17.8 |
| D52 | **[OWNER]** Skip the paid Windows code-signing certificate for now (Windows shows a warning on install); updates are still verified with a free release-signing key. | 17.8 |
| D53 | **[OWNER]** Jarvis is **proprietary: all rights reserved.** Consequences for dependencies, bundled services, and models are in Sections 17.8 and 18.2. | 17.8, 18.2 |
| D54 | **[OWNER]** User stories are created **both ways**: the AI may propose them in Concept, and the owner will mostly create them himself. Owner-created stories are authoritative; AI proposals become tickets only when the owner moves the feature to Ready for Dev (Section 17.7). *Replaces the earlier answer in v1.6.* | 17.7 |
| D55 | **[OWNER]** Requirements gathering is complete ("that's all"). Before the final documents are produced, the owner receives the prerequisites list (Section 22), and Claude makes the final alterations (this version). | 22, 23 |
| D56 | **[PROPOSED]** Because this document is about 45,000 tokens (about 180 KB), too large for a local model to hold while coding, it is split into small **context packs**, and the local AI works from a short **builder guide** plus the task's own pack (Section 22.4). | 22.4 |
| D57 | **[OWNER]** The master document must be readable by the owner and **fully consistent**: every section reference, decision ID, requirement ID, and prerequisite ID must resolve. It includes a plain-language start guide, a document map, a traceability matrix, a glossary, and the owner's own words. An automated documentation check becomes part of the project (Section 19.3, item 11). | 26, 27, 28 |
| D58 | **[OWNER] + facts checked** Good AI models must be downloaded (the owner named Qwen, Kimi, and Sonnet) so that several models can deliver good results. Checked facts: **Qwen** open models can run here; **Kimi's** flagship is a 1-trillion-parameter model that cannot run on 64 GB, so it is cloud-only; **Claude Sonnet** has closed weights and is cloud-only. Cloud use stays under D22 (approval each time). Each lane gets a primary and an alternate from a different family. | 7.6, 22.2 |
| D59 | **[OWNER] + [PROPOSED]** Jarvis is an **agent platform** with these abilities: adaptive ML, general capability (AGI as a long-term direction, not a deliverable), building AI agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system that lets multiple works run together within the hardware limits (Sections 5.1 to 5.9). | 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9 |
| D60 | **[OWNER] + [PROPOSED] + facts checked** Jarvis handles **images and video**: it understands shared images and videos and builds context from them, reads text in them, edits several at a time, and generates images and (short, experimental) video when required. Image generation, editing, and short video generation are confirmed to run on this chip, slowly for video (Section 5.10). | 5.10, 7.2 |
| D61 | **[OWNER]** The plan is final. By asking for the final revision so that work can start, the owner approved the summary in Section 23. The owner now starts the Gate 0 checklist (Section 22.2). | 22, 23 |
| D62 | **[OWNER]** The owner declined to add a Version 1 scope and an encrypted backup plan to the document. They stay as advice only and can be added later as a Concept ticket (Section 24.2). | 24.2 |
| D63 | **[OWNER]** GitHub plan & repository structure: Personal private repository (`https://github.com/aery1803/jarvis.git`) with `main` and `master` branches synchronized. Native branch protection skipped on free private repo; Jarvis's Action Gateway enforces branch rules before merges (Section 17.10, Section 22.2). | 22.2, 17.10 |

---

## 4. Hardware and Environment

*In plain words: Your machine, and what it means for how Jarvis is designed.*

**Machine: ASUS ROG Flow Z13 (2025, model GZ302EA_GZ302EA)** **[OWNER; VERIFIED ON DEVICE]**.

| Item | Profile | Status / Audited Value |
|---|---|---|
| Model | ASUS ROG Flow Z13 (`GZ302EA_GZ302EA`) | Verified via Win32_ComputerSystem |
| CPU | AMD Ryzen AI Max+ 395 "Strix Halo", 16 Zen 5 cores / 32 threads | Verified via Win32_Processor |
| GPU | Integrated AMD Radeon 8060S, 40 RDNA 3.5 compute units (`gfx1151`) | Verified (PCI ID `0x1586`) |
| GPU Driver | AMD Software: Adrenalin Edition, Driver `32.0.31041.1004` | Verified via Win32_VideoController |
| BIOS | `GZ302EA.314` | Verified via Win32_BIOS |
| OS | Windows 11 Home Single Language, Version `26H2`, Build `26300.0` | Verified on host |
| NPU | Up to 50 TOPS (AMD XDNA 2); software support for LLM/speech **[VERIFY]** | Present on SoC |
| Memory Pool | **64 GB LPDDR5X-8000 unified memory** (`Win32_PhysicalMemory`: 64 GB) | Verified |
| OS RAM vs GPU VRAM | Windows OS allocated: **31.65 GB** (up from 15.65 GB; provides double headroom for Docker/WSL2 and host tasks). Dedicated GPU allocation: **32 GB** | Verified |
| **Vulkan Backend Acceleration** | **Operational with 46.5 GB free VRAM** (`llama.cpp` b11272: `Vulkan0: AMD Radeon(TM) 8060S Graphics (48,971 MiB total, 46,523 MiB free)`) | **VERIFIED & WORKING** |
| Storage | 1 TB NVMe SSD. Current available: **640.2 GB free** on `C:` | Verified (exceeds 250 GB target) |
| Power and thermals | High-performance AC power profile (Armoury Crate Performance/Turbo, Windows Best Performance) | Verified active |
| Phones | Android and iPhone | D19 |

**Installed Toolchain Versions (Audited):**
- `git`: 2.56.0.windows.2
- `node`: v26.10.0 | `npm`: 12.2.0
- `docker`: Docker version 29.8.2, build 7fc2dff (WSL2 backend)
- `code` (VS Code): 1.141.0
- `ollama`: 0.40.4 (service active and verified via CLI)
- `llama.cpp`: build b11272 (Vulkan x64) installed in `C:\tools\llama.cpp`
- `gh` (GitHub CLI): 2.102.0 installed in `C:\Program Files\GitHub CLI\gh.exe`

**Consequences for the design (Updated with live findings)**
1. **Memory bandwidth, not capacity, limits generation speed.** Models that read fewer bytes per token (smaller active parameters, lower-bit quantization) run faster. Mixture-of-experts (MoE) models suit this machine.
2. **Unified memory is balanced perfectly:** Windows has **31.65 GB** dedicated headroom (eliminating memory pressure/lag during heavy multitasking), while Vulkan simultaneously retains **46.5 GB of free addressable GPU memory** for model inference and KV-cache.
3. **GPU backend support on Windows is CONFIRMED via Vulkan.** Prior uncertainty regarding gfx1151 Vulkan support on Windows is resolved: `llama.cpp` b11272 with Vulkan driver enumerates `AMD Radeon(TM) 8060S Graphics` with 46,523 MiB free VRAM and executes without fallback. Official Ollama runs alongside it for comparative benchmarking (Section 7.5).
4. **Thermal limits** push heavy and background work to moments when the laptop is plugged in, idle, and cool.

---

## 5. Architecture and Agent Platform

*In plain words: One picture of how the pieces fit together, plus the agent abilities: tools, MCP, RAG, several agents at once, adaptive learning, and images and video.*

```
Owner interfaces:  Telegram (text, voice notes, files, buttons)   Laptop voice / CLI
                              |                                           |
                              v                                           v
+--------------------- Docker sandbox (agent, no GPU needed) -----------------------+
|  Session & Task Manager (auto-routing)      Master Planner (understands commands) |
|  Memory Manager (tiers, RAG, profile)       Skill Manager (built-in + generated)  |
|  Scheduler / Watchers (email, routines)     Cost ledger + Quality gates + Evals   |
|  Research skill: SearXNG -> Scraper -> Consensus -> Synthesis                     |
|  Playwright browser (persistent logged-in profile)                                |
+---------------------------------------|-------------------------------------------+
                                         v
                  Action Gateway: permission engine, approvals, audit log, kill switch
                     |                      |                         |
              Host bridge (laptop)   Phone bridge (Android-first)   Gmail / Telegram APIs
                     
Host (outside Docker):  Inference server (Ollama or llama.cpp) on the Radeon 8060S
                        Model Manager + Memory Governor decide what is loaded
Dev only (Phase 0):     VS Code with a local AI agent and local autocomplete (Section 17)
```

| Component | Responsibility |
|---|---|
| Master Planner | Interprets commands, builds a plan, picks skills, tools, and models, announces the plan |
| Session & Task Manager | Isolated sessions and tasks per user; auto-routes messages |
| Memory Manager | Decides what stays in context and what goes to RAG; consolidates and forgets |
| Skill Manager | Runs, creates, tests, versions skills |
| Model Manager and Governor | Loads and unloads models within a memory budget; benchmarks backends |
| Action Gateway | Only path from the sandbox to the laptop, phones, and external accounts |
| Scheduler / Watchers | Email watcher, reminders, routines, consolidation jobs |
| Quality and Cost layer | Quality gates, cascade escalation, cost ledger, evaluation harness |
| Tool Registry | The list of tools Jarvis can call, each with a schema, a permission tier, and a time limit (Section 5.3) |
| MCP client (and optional server) | Connects Jarvis to approved outside tools through the Model Context Protocol (Section 5.4) |
| RAG Engine | Ingests, indexes, and retrieves knowledge with sources (Section 5.5) |
| Agent Orchestrator and Agent Pool | Runs several specialist agents at once under one scheduler (Section 5.6) |
| Agent Factory | Builds new agents on request, with tests and approval (Section 5.7) |
| ML Workbench | Trains and serves classic machine-learning models on approved data (Section 5.8) |
| Adaptive Learning Loops | The learning loops that improve routing, ranking, and classifiers over time (Section 5.9) |
| Media Service and Generators | Reads, edits, and converts images and video, extracts text and frames, and calls the image and video generation backend (Section 5.10) |

### 5.1 Agent platform: the abilities **[OWNER: D59, D60; design PROPOSED]**
**Owner's requirement:** Jarvis must have the abilities of adaptive ML, AGI, building AI agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system, **so that multiple works can run together.**

| Ability | What it means for Jarvis | Defined in | Built in |
|---|---|---|---|
| Adaptive ML | Jarvis improves from experience with measured, reversible learning loops | 5.9, 9.4, 9.5 | Phases 3 to 6; retraining in Phase 8 |
| AGI (general capability) | A general-purpose agent that handles a widening range of tasks; AGI itself is a direction, not a feature | 5.2 | Measured throughout |
| Building AI agents | Jarvis creates new specialist agents, with tests and approval | 5.7, 9.2 | Phase 6 |
| ML models | Jarvis trains and uses classic machine-learning models on approved data | 5.8 | Phase 6 |
| RAG | Retrieval of stored knowledge with sources | 5.5, 8 | Phases 1 and 2 |
| MCP | Standard connection to outside tools, safely | 5.4 | Phase 3 |
| Memory | Tiered memory and the experience graph | 8, 9.4 | Phase 2 |
| Tool calling | The model calls validated tools | 5.3 | Phase 1 |
| Multi-agent system | Several agents working at once | 5.6, 11.3 | Phase 3 |
| Images and video (D60) | Understanding, reading, editing, and generating images and video | 5.10, 7.2 | Phases 3 to 5 |

### 5.2 General capability and "AGI": what is and is not promised **[OWNER: D59; interpretation PROPOSED]**
Artificial general intelligence, a system that matches people on almost any intellectual task, **does not exist today, and it cannot honestly be delivered as a feature of a personal assistant on a laptop.** Promising it would be false. What can be built, and measured, is a **general-purpose agent platform**:
- It plans and breaks down tasks it has never seen before.
- It uses tools, retrieves knowledge, and browses and operates devices.
- It creates new skills and agents when it needs them (Sections 9.2 and 5.7).
- It learns from experience and reuses what worked (Section 9.4).
- It tells the owner when it is unsure or has failed, instead of bluffing (Section 16.1).

**Success is measured, not labeled:** the evaluation set (Section 16.2) gains new task categories over time, and Jarvis is judged by breadth (how many kinds of tasks it handles) and reliability (how often it gets them right). "AGI" stays the long-term direction.

### 5.3 Tool calling **[PROPOSED]**
- **Tool registry.** Every tool has a name, a description, an argument schema checked by `zod`, a permission tier (Section 6.2), a time limit, a note on side effects, and a cost estimate. Tools come from three sources: built-in tools (search, files, browser, email, GitHub, calendar, shell through the gateway), Jarvis's own skills, and MCP servers (Section 5.4).
- **Calling.** The model proposes a call, using native function calling when the model supports it, or grammar-constrained JSON when it does not. The runtime validates the arguments, checks permissions in the Action Gateway, asks the owner when the tier requires it, runs the tool with a time limit, and writes the audit log.
- **Reliability.** At most two automatic repair attempts for a malformed call; independent calls run in parallel; side effects carry idempotency keys; Tier 1 and Tier 2 actions can run as a dry run first (announce before acting, D8).
- **Many tools, small models.** Showing a small model dozens of tools makes it worse, so the runtime retrieves only the **most relevant tools (about ten at most) for each step.**
- **Tool results are untrusted data.** They are marked as such (Section 5.6, taint tracking) and can never change permissions or trigger Tier 2 actions on their own.
- **Model requirement.** Every model used for agents must pass a tool-calling test in the readiness test (Section 22.5).

### 5.4 MCP (Model Context Protocol) **[PROPOSED; VERIFY the protocol version at build time]**
- **Jarvis as an MCP client:** it connects to **approved** MCP servers to gain tools, resources, and prompts, which then appear in the tool registry.
- **Jarvis as an MCP server (optional, later):** it can expose selected skills, such as the research skill, to other MCP clients on this machine, for example the VS Code agent.
- **Local only.** Connections use local transports (a local process or localhost). Nothing is exposed to the internet and no tunnel is used (Section 6.3).
- **Each server is third-party code, so:** the owner approves adding a server (Tier 2); it runs in its own container with minimal file access and restricted network access; its version is pinned and its license checked (D53); its credentials sit in the vault; the build conventions apply (Section 18.2).
- **Tool descriptions are untrusted.** A server can hide instructions in a tool description or result. The runtime pins a hash of each approved tool description and **asks for approval again if it changes**; results are tainted data; arguments are validated; calls are rate-limited and audited.
- **GitHub for the Dev Agent** uses the direct gateway integration (Section 17.10), not MCP, so that the shared-account safeguards stay in one place.

### 5.5 RAG (retrieval-augmented generation) **[PROPOSED]**
The RAG engine serves the research skill, the memory tiers T2 to T4 (Section 8), the Dev Agent's context packs (Section 22.4), and the tool retrieval in Section 5.3.
1. **Ingest** owner-approved sources: pages from the research skill, folders the owner approves, email digests, notes, the code repository, tickets, past sessions, and the images and videos the owner shares (stored as descriptions, extracted text, and transcripts with timestamps, Section 5.10).
2. **Chunk** by meaning (about 300 to 800 tokens with some overlap; code by function), keeping the source, time, and owner of each chunk.
3. **Embed** with the small local embedding model (Resident lane, Section 7.2) and store in LanceDB with metadata: user, session, source, time, content hash, and sensitivity.
4. **Retrieve** with a hybrid of vector search and keyword search (SQLite full-text search), always filtered by user and session (Section 11.2).
5. **Rerank** the top results with a small model, then assemble the context **inside the token budget** (Section 8.2).
6. **Answer with sources:** every claim keeps its provenance so it can be cited (Section 10).
7. **Keep it fresh:** hashes remove duplicates; old items expire by their type; changing the embedding model re-embeds everything (embedding spaces are versioned).
8. **Sensitive items get no vectors** (D27); they are fetched by exact key.
9. **Iterate within budgets:** an "agentic" retrieval loop may search again, but only within the existing limit of 3 iterations (Section 10).
10. **Measure it:** retrieval recall and answer groundedness are part of the evaluation set (Section 16.2); owner feedback adjusts ranking (Section 5.9).

### 5.6 Multi-agent system: running multiple works together **[OWNER: D59; design PROPOSED]**
**Agents.** An agent is a role prompt, a set of tools, a permission manifest, a model lane, a memory scope, and budgets. Built-in agents **[PROPOSED]**: Orchestrator (the master planner), Researcher, Developer (the Dev Agent, Section 17), Email, Browser, Computer-control, Memory (consolidation), Verifier (a critic that checks other agents' results), and Watcher (schedules and monitors).

**Coordination.** An orchestrator-and-worker model: the orchestrator splits a request into tasks and hands them to agents through the **SQLite task queue and event log** (Section 11.3). Patterns: run in parallel and merge, a pipeline, a critic loop, and (rarely) a debate between two models. Each task has its own **session scope** (D12); agents share information through a per-task blackboard, never through global memory.

```
Owner request -> Orchestrator -> task queue --+--> Researcher ----+
                                             +--> Email agent ----+--> results -> Verifier -> answer
                                             +--> Browser agent --+
                  all agents: tools (5.3) | RAG (5.5) | permissions (6.2) | audit log | cost ledger
```

**What "together" can mean on this hardware [PROPOSED; benchmark sets the numbers].**
- Work that **waits** (search, scraping, browsing, email, GitHub, the owner) runs truly in parallel across many tasks.
- **Text generation shares one memory bandwidth.** Several agents can use one loaded model at the same time, which raises total throughput but slows each agent and uses more memory for each parallel slot **[VERIFY the backend's parallel-slot support]**. Different heavy models cannot run at once.
- A **global scheduler** sets limits, starting values to be tuned by benchmark: 2 to 3 simultaneous model requests, 4 to 6 active agents per user (mostly waiting), one story in active development (D38, Section 17.12), priority classes (interactive replies, then approvals, then background), short jobs allowed to pause long ones, and the memory governor (Section 7.4) and thermal limits always in force.

**Safety for many agents [PROPOSED]**
- An agent's permissions can **never exceed those of whoever created it**, and no agent holds Tier 3 abilities.
- **Taint tracking:** anything that came from an untrusted source (web pages, email, files, tool and MCP results, screens) stays marked as tainted as it passes between agents; **tainted content can never trigger a Tier 2 action without the owner's approval**.
- No agent can approve another agent's Tier 2 action; **only the owner can.**
- Each agent has budgets (tokens, steps, and time); runaway detection stops loops; the kill switch (Section 6.3) stops all agents; every action is audited with the agent's ID; the cost ledger (Section 16.1) tracks cost per agent.
- Failures are retried with backoff, then moved to a dead-letter list, and the owner is told.

**Telegram view.** `/agents` shows the running agents and their tasks; `/pause <id>` and `/cancel <id>` control them (Section 11.1).

### 5.7 Building AI agents: the agent factory **[OWNER: D59; design PROPOSED]**
Jarvis can build new specialist agents, when the owner asks or when it notices a recurring need.
- **Agent specification:** name, purpose, role prompt, tools (from the registry or approved MCP servers), permission manifest, model lane, memory scope, triggers or schedule, budgets, and success tests.
- **Lifecycle (the same as skills, Section 9.2):** announce what it will build and why; draft the specification; **test it in the sandbox** against evaluation cases; ask for the owner's approval if the agent needs Tier 2 permissions or will run unattended; register and version it; monitor it; retire it.
- **Declarative agents** (a specification only, no new code) are created at run time. **An agent that needs new code becomes a ticket on the board** (Section 17.7) and goes through concept, review, and QA like any other feature (D37 to D40).
- **Limits:** a new agent's permissions are a subset of its creator's (Section 5.6); no Tier 3; a cap on the number of agents; each agent has a plain-language description visible to the owner, and the owner can disable any agent.

### 5.8 ML models: the machine-learning workbench **[OWNER: D59; design PROPOSED]**
Jarvis can train and use **classic machine-learning models** for the owner's data: classifiers (for example email importance or ticket triage), forecasting, clustering, anomaly detection, and recommendations, plus data analysis. For narrow tasks these are cheaper and faster than a language model.
- **Separate service.** A Python **ML workbench** runs in Docker, with exact-pinned dependencies verified by hashes, no outbound network access, and owner-approved datasets mounted read-only. Python and its packages follow the same build conventions as the rest (Section 18.2), and their licenses are checked (D53) **[VERIFY the libraries at build time]**.
- **Operations:** `train`, `evaluate`, `predict`, and `explain`. Trained models are exported to a portable format for fast use from TypeScript **[VERIFY]**.
- **Model registry** for ML models (separate from the language-model registry): version, data lineage, metrics, and owner approval.
- **Quality gate (D14):** a new model replaces the old one only if it is better on held-out data with no regression; drift is monitored; retraining runs when the laptop is plugged in and idle.
- **Privacy:** sensitive features are excluded (D27); data stays on the machine.
- **Language-model adapters** (Section 9.5) are a different, later tool; the workbench comes first for narrow tasks.

### 5.9 Adaptive ML: learning loops **[OWNER: D59; design PROPOSED]**
Jarvis adapts through several **separate, measured loops**, not one mysterious one:
1. **Model routing** learns, from quality-gate results and cost, which model lane is enough for each task type (a bandit-style method).
2. **Email importance** is a classifier updated from the owner's reactions (Section 5.8).
3. **Style and habits profile** keeps learning from corrections (Section 9.1).
4. **Reflexes** are compiled from repeated successes (Section 9.4).
5. **Retrieval ranking** is tuned by the owner's feedback (Section 5.5).
6. **Approval-rule suggestions:** Jarvis may suggest loosening a rule after repeated approvals, but never applies it (D23).
7. **Scheduling** learns the owner's active hours and quiet hours.
8. **Adapters** on the language model come later (Section 9.5, Phase 8).

**Guardrails [PROPOSED]**
- Every adaptation is judged on held-out data or the evaluation set (Section 16.2), versioned, and reversible; drift is watched.
- **Safe exploration:** Jarvis never experiments on Tier 2 actions or high-stakes tasks.
- Safety rules, permission tiers, and approval rules are **never adapted by the AI** (Tier 3).
- The owner can see, freeze, or reset any loop.
- Metrics: routing regret (how often a cheaper model would have been enough, or a stronger one was needed), classifier precision and recall, reflex rate (Section 9.4), and retrieval recall.

### 5.10 Images and video **[OWNER: D60; design PROPOSED; facts checked]**
**Owner's requirement:** Jarvis must handle the images the owner shares: know what is in each image and **make the context** from it, **generate images when required**, accept **multiple images** to edit and to read, and do **the same for video**.

| Task | Images | Video |
|---|---|---|
| **Understand** | Describe the scene, objects, people (how many and what they are doing, not who they are), colors, and layout; answer questions; compare several images | Summarize; answer questions with timestamps; find moments; notice what changes between scenes |
| **Read** | Text recognition (OCR): documents, receipts, screenshots, forms, and handwriting where possible; turn tables into a spreadsheet | Read on-screen text; transcribe the speech with timestamps (Speech lane); subtitles |
| **Make context** | Store the description, the extracted text, key facts, and a link to the original in the session's memory (Section 5.5) | Store a timeline: transcript, scene summaries, key frames, and timestamps |
| **Edit** | **Plain tools first** (crop, resize, rotate, adjust, annotate, merge, convert); model-based edits when needed (object removal, inpainting, style change, edits described in words); the same edit applied to many images | **Plain tools first** with ffmpeg (trim, cut, join, speed, captions, audio, convert, extract frames); model-based video editing is experimental |
| **Generate** | Text to image, image to image, and generation from reference images | Short clips from text or from an image: experimental, slow, in the background |

**How it works [PROPOSED]**
- **From Telegram.** Photos, albums (several images sent together are combined into one task), documents, videos, and screenshots. Telegram compresses photos, so for exact originals the owner can send them as files. Results come back as images or video, or as files when large. Size limits apply **[VERIFY]** (Section 11.1).
- **Images:** normalize (orientation and size; remove metadata such as location) -> the Vision lane describes and the OCR engine reads the text -> a sensitivity check (IDs, bank cards, passwords, medical documents, faces) -> store the context (D27) -> answer or act. Images cost many tokens, so the resolution and the number per request are capped, descriptions are cached by file hash, and the OCR engine is used instead of the big model when only the text is needed.
- **Video:** extract the audio and transcribe it (Speech lane); sample frames (at scene changes and at fixed intervals) and describe the key frames (Vision lane); build a timeline with timestamps; answer questions by retrieving the right timeline segments (Section 5.5) and looking at specific frames again when needed. Long videos are processed in the background in chunks.
- **Several images or videos** in one request are treated as a set: compared, combined into one answer, edited in a batch, or processed one by one with progress messages.
- **Media service (Docker):** ffmpeg, an image library, and an OCR engine, with no network access and file access only to the session's media folder. **Generation** runs in a host-side backend (a ComfyUI-type server) behind a **provider interface**, like the language models (Section 7.5). Because generation shares the one unified memory pool, the memory governor unloads other heavy models first (Section 7.4), and Jarvis says when a job will take a while.
- **Storage.** Originals and results live in per-session media folders with expiry rules, count against the storage budget (Section 7.6), and can be deleted by the owner.

**Hardware reality (checked) [VERIFY at build time]**
- Local image generation, instruction-based image editing, and **short video generation do run on the Ryzen AI Max+ 395** (Radeon 8060S). A community toolbox packages ComfyUI for this chip with workflows for Qwen Image, Qwen Image Edit, and Wan 2.2 (text-to-video and image-to-video, a 14B model with a 4-step speed-up). AMD documents running ComfyUI natively on Windows on this chip, with SDXL, Flux.1-dev, and a short video workflow (Wan 2.2); SDXL loads in well under 10 GB.
- **Video generation is far slower and heavier than image generation**, so it is optional, runs in the background, and makes short clips only.
- **One heavy job at a time.** Image generation and a large language model compete for the same memory; another local-server project even pauses its language-model slots while images are generated.
- The Phase 0 benchmark may include a short image-generation test to learn the speed, but the choices are made in Phase 5.

**Models [VERIFY at build time]**
- **Understanding:** a vision-language model from the roster (Section 7.6); Qwen's vision models are a natural first candidate and also accept video; an alternate from another family. **Reading text:** a dedicated OCR engine or a small OCR model.
- **Generation and editing:** candidates include SDXL, Flux.1, Qwen Image and Qwen Image Edit; for video, Wan 2.2 and others.
- **Licenses differ a lot.** Some image models carry non-commercial or use-based terms (for example Flux.1-dev is reported as non-commercial). Because Jarvis is proprietary (D53) and may be distributed (D43), **models are never bundled**, each model's license is checked, and a model whose license does not allow the use is not shipped or recommended to other users.

**Safeguards [PROPOSED]**
1. **Content inside media is untrusted data.** Text in an image or frame, subtitles, and metadata can contain instructions; they can never give commands or trigger Tier 2 actions (taint, Section 5.6).
2. **Privacy.** Location and device metadata are removed on intake and before sharing. Jarvis **describes people but does not identify them by face by default**; naming specific known people is an opt-in the owner can turn on per person. Sensitive content (IDs, bank cards, passwords, medical documents) is detected and handled as sensitive: encrypted and without vectors (D27).
3. **Generation limits (fixed rules).** Jarvis does not create sexual content involving minors, sexual images of real people, or deceptive fakes that impersonate real people or fabricate evidence. These are rules about **creating** content; they do not limit what the owner may look up (D10, Section 15). Generated images and video are tagged as AI-generated in their file metadata.
4. **Cost and heat.** Each job's time and energy go into the cost ledger (Section 16.1); heavy generation waits for the laptop to be plugged in and cool, and long jobs show progress and can be canceled.
5. **Measured.** The evaluation set (Section 16.2) gains media tasks: text-reading accuracy, description correctness, video questions with timestamps, and the owner's rating of edits.

---

## 6. Safety, Isolation, and Permissions

*In plain words: How Jarvis stays safe: where it runs, what it may do alone, and what always needs your approval.*

### 6.1 Isolation **[OWNER: D18]**
- The owner wants **no sandbox that lowers efficiency or result quality**. If Docker costs nothing in quality, use **Docker**. **No full VM.** If a measurable loss appears, report it to the owner for a decision.
- **[PROPOSED]** Inference runs on the **host** (Ollama or llama.cpp server on the GPU). The agent, SearXNG, scraper, and Playwright run in Docker with no GPU. Docker adds almost nothing to the agent's work because the heavy computation happens on the host.
- **[PROPOSED]** The inference server listens on the loopback interface only; containers reach it through the host-gateway name Docker provides, protected by a local access key. Nothing listens on the network.
- **[PROPOSED]** Option B (Linux dual-boot, D17): inference and the agent can both be containers, with the GPU passed through as a device, if benchmarks favor Linux.
- Docker alone does not control the laptop; laptop and phone actions go through the Action Gateway (below).

### 6.2 Permission tiers **[PROPOSED, with owner-set rules]**
| Tier | Examples | Behavior |
|---|---|---|
| 0 Read-only | Search, read mail, read files in approved folders, read screens | Allowed, logged |
| 1 Reversible | Draft an email, create a file, add a calendar item | Announce, proceed, logged |
| 2 Sensitive / irreversible / external-facing | Send email, delete files, run shell commands on the host, install software, spend money, post publicly, payments and transfers | **Owner approval each time** (Telegram button or CLI prompt showing exactly what will happen) |
| 3 Forbidden | Disable the audit log, edit its own permission rules, read secrets outside its scope. For the Dev Agent also: approve a pull request, move a card to Done, set the `release-approved` label, or merge into master (Section 17.10) | Never allowed, cannot be unlocked |

**Per-skill rules [OWNER: D23].** The owner sets approval rules per skill over time. Mechanics **[PROPOSED]**:
1. Until the owner sets a rule, a skill uses the strict tier defaults above.
2. Each skill has a permission manifest the owner can loosen or tighten with an explicit command (for example `/trust <skill> <level>`); every change is logged.
3. Only the owner can change a rule, never the agent, a skill, or any email, web page, or file content.
4. Tier 3 can never be unlocked.
5. "Announce before acting" (D8) applies at every trust level.
6. The agent may suggest loosening a rule after repeated approvals but never applies it by itself.

**Rules already fixed by the owner:** sending email needs approval each time (D21); cloud models need approval each time (D22); payments, purchases, transfers, and social posts need approval (D30); merging into master and releasing need the owner's explicit go (D39).

### 6.3 Safety principles **[PROPOSED]**
- **Announce before acting:** every plan is shown first.
- **Untrusted content is data:** text from email, web, files, and screens cannot trigger Tier 2 actions or change permissions (defense against prompt injection).
- **Audit log:** every action, input source, and approval, append-only, in SQLite.
- **Kill switch:** one command (Telegram, CLI, voice) stops all agent activity.
- **Secrets vault:** tokens and credentials stay outside prompts and outside generated skills.
- **No public exposure:** nothing from the local environment is exposed to the internet; Telegram uses outbound long polling only; the bot answers only allow-listed Telegram user IDs.
- **Skill safety:** generated skills are tested in the sandbox, declare the permissions they need, and cannot escalate themselves.
- **Media safety (D60):** text and metadata inside images and video are untrusted data; people are described but not identified by face by default; location metadata is removed; sensitive images are handled as sensitive; generation has fixed limits (Section 5.10).
- **Agent and tool safety (D59):** an agent can never hold more permissions than its creator; MCP servers, their tool descriptions, and tool results are untrusted; untrusted content stays tainted across agents and cannot trigger Tier 2 actions without the owner's approval (Sections 5.3, 5.4, and 5.6).

---

## 7. Models: Lanes, Efficiency, Orchestration

*In plain words: Which AI models Jarvis uses and downloads, how they are kept lean and fast, and how the right one is chosen and loaded.*

### 7.1 Principle
Pick the **cheapest model that meets the quality target** for each task (D14), load it only when needed, and keep memory and heat under control.

### 7.2 Model lanes **[PROPOSED; sizes approximate; exact models chosen by benchmark at build time]**
The Qwen2.5 7B/14B models in the original spec were chosen for a 6-8 GB VRAM plan and are **placeholders**. **[VERIFY]** which open models are current when building. The roster of candidates is in Section 7.6.

| Lane | Model class | Memory | Use |
|---|---|---|---|
| Resident | Small embedding model plus a small (about 4B or less) router/classifier | About 3-5 GB, always loaded | Retrieval, intent routing, cheap classification, email importance |
| Fast | MoE, about 30B total / about 3B active, 4-bit | About 18-20 GB | Everyday tasks, summaries, drafting, tool use |
| Balanced | Dense 14B-32B, 4-5 bit | About 9-22 GB | Harder reasoning, planning, code |
| Deep | Dense 70B-class, 4-bit | About 40 GB, slow | Rare hard tasks in the background; other heavy models unloaded meanwhile |
| Vision | Small vision-language model | On demand | Screenshots, screen control, photos, and video frames (Section 5.10) |
| Speech | Local speech-to-text, text-to-speech, wake word | About 2-4 GB; wake word always on | Voice (Section 14) |
| Translation | Small multilingual translation model **[OWNER: D46]** | About 2-6 GB; loaded only when needed, unloaded afterwards | Reading non-English pages and sources |
| OCR | Text-recognition engine or small OCR model | About 0.5-2 GB, on demand | Reading text in images, scans, receipts, and screenshots (D60) |
| Image generation and editing | Diffusion-type image model plus an editing model | About 10-24 GB, loaded on demand; other heavy models unload first | Creating and editing images (D60) **[VERIFY]** |
| Video generation (optional, experimental) | Open video-generation model | About 20 GB or more; slow; background only | Short clips (D60) **[VERIFY]** |
| Code autocomplete | Small code model with fill-in-the-middle support | About 1-4 GB, loaded while coding | Editor autocomplete (Section 17) |
| Code agent | Reuses Fast or Balanced (code-strong model) | Shared | Editor agent (Section 17) |

**Proposed memory budget:** reserve about 14-18 GB for the OS, browser, Docker, SearXNG, Playwright, and the agent; the remaining 46-50 GB holds models and context. Start with a GPU share of about 32-40 GB, then tune.

The NPU (50 TOPS) may later host small always-on models such as embeddings or speech-to-text **[VERIFY]**.

### 7.3 Model efficiency policy **[OWNER: R16, D33; with PROPOSED guardrails]**
**Owner's intent:** mostly quantized models, English-only models to save computation, remove unnecessary layers so the model's capacity goes into results, and use memory efficiently.

**What will be done**
1. **Quantization everywhere [OWNER].** Default 4-bit (K-quants, or importance-matrix/dynamic quants); 5-6 bit for quality-critical lanes (code, planning); 8-bit for the smallest models (router, embeddings), which degrade faster. Quantize the KV cache and use flash attention where the backend supports it. Every quantization choice is checked against the evaluation set.
2. **English-only models [OWNER].** Prefer English-focused or English/code-focused models in every lane. **[PROPOSED]** For small models also trim the vocabulary to English and code tokens, which shrinks the embedding table and output layer.
3. **Lean computation [PROPOSED], so capacity goes to results:**
   - **Reasoning budget:** "thinking" models spend many hidden tokens; thinking is off for simple tasks and capped for hard ones.
   - **Deterministic code first:** regex, parsers, and scripts handle whatever they can; no model call.
   - **Small specialist models** for classification and extraction (router, email importance, intent) instead of the big model.
   - **Constrained, structured output** (schema or grammar) to avoid retries.
   - **Prefix/prompt caching** so the stable system prompt and owner profile are not recomputed each time.
   - **Speculative decoding** with a small draft model where supported: faster output with the same quality.
   - **MoE models** read only active parameters per token, which matches this machine's bandwidth limit.
   - **Context discipline** (Section 8): retrieve only what is needed.
4. **Memory efficiency [PROPOSED].** Memory-mapped model loading, load on demand, keep-alive timers, one heavy model at a time, the memory governor (7.4), and per-lane context caps.

**Honest limits and guardrails [PROPOSED]**
- **Removing layers is lossy.** Knowledge is spread across all layers; research shows some layers can be dropped with modest loss only after extra training and testing. That conflicts with D14 (never compromise the result). So **layer pruning is not part of version 1.** It is an optional later experiment, accepted only if the evaluation set shows **no quality loss**. A better route to the same goal is choosing already-efficient models (MoE, distilled) and training small task-specific models.
- **English-only does not free "layers"**; languages are not stored in separate layers. The saving comes from choosing English-focused models and trimming vocabulary.
- **English-only conflicts with R10 in one case:** reading non-English web pages. **[OWNER: D46]** Jarvis keeps an **optional translation model that loads only when needed.** **[PROPOSED]** mechanics: a tiny deterministic language detector (no model call) flags non-English pages; only the extracted relevant passages are translated, not whole pages; the model unloads when done; translated text is labeled "translated from <language>", the original is kept, and citations point to the original page.
- Every efficiency change (quantization level, trimming, pruning, draft model) must pass the **evaluation harness** (Section 16) with no regression before it ships.
- Track one efficiency metric per model: **quality score per gigabyte read per token**, plus tokens/s and watts.

### 7.4 Orchestration **[OWNER: D9; design PROPOSED]**
- **Master Planner:** an always-available small-to-mid model interprets commands, plans, and chooses skills, tools, and models.
- **Model Registry (SQLite):** size, quantization, memory need, context length, strengths (chat, code, vision, embeddings, reasoning), measured tokens/s on this machine, last use.
- **Capability Checker:** before loading, reads free unified memory and the current GPU/CPU split, disk space, temperature, and power state; decides full GPU, partial offload, or refusal/fallback.
- **Model Manager:** loads and unloads through the provider interface; idle timeouts; cooling delays (original 500 ms rule between heavy loops).
- **Memory Governor:** enforces a memory budget, reserves headroom for the OS, browser, and containers, refuses loads that would cause swapping, unloads idle models first.
- **Model acquisition:** if no suitable local model exists, Jarvis proposes pulling one (name, size, reason) and **asks for approval** before downloading.
- **Routing policy:** task type to model, learned over time from outcomes (Section 16).

### 7.5 Inference backend and benchmark plan **[PROPOSED; VERIFIED ON DEVICE]**
- Code talks to a **provider interface** that supports Ollama and any OpenAI-compatible server such as a llama.cpp server. The backend is chosen by benchmark, not by assumption.
- **Hardware baseline verified (Gate 0):** `llama.cpp` (build b11272) running on Windows with the Vulkan backend successfully detects and initializes `Vulkan0: AMD Radeon(TM) 8060S Graphics` with 46,523 MiB free VRAM. Both Ollama 0.40.4 and `llama.cpp` Vulkan are installed on the host.
- **Measured Benchmark Results (Phase 0, ASUS ROG Flow Z13):**
  - **Autocomplete Lane (`qwen2.5-coder:1.5b`):** Generation speed: **141.0 tokens/sec** | Prompt intake speed: **15,529.5 tokens/sec** | Host RAM headroom: **14.92 GB free**.
  - **Fast Lane (`qwen2.5:7b`):** Generation speed: **41.2 tokens/sec** | Prompt intake speed: **1,088.8 tokens/sec** | Host RAM headroom: **14.30 GB free**.
  - **Memory Governor & Stability:** Both test passes maintained $> 14$ GB host memory headroom with zero GPU driver resets or memory swapping. Windows native performance confirms Linux dual-boot is not required for interactive speeds (D17).

### 7.6 Model roster: which strong models to download **[OWNER: D58; facts checked; details PROPOSED]**
**Owner's requirement.** It is necessary to download good AI models, such as Qwen, Kimi, and Sonnet, so that **if one model can give a good result, the others can too.**

**How this is understood [PROPOSED; the owner can correct it, Section 24.4].** Jarvis keeps **several good models available**, so that no single model is a point of failure; any of them can take over, a second model can check an important answer, and a method that worked once can be reused by other models.

**What is actually possible on this machine** **[VERIFY at build time; community and vendor sources]**

| Family | Can it run on the Z13 (64 GB)? | How Jarvis uses it | Notes |
|---|---|---|---|
| **Qwen** (Alibaba): open weights in many sizes, including a roughly 30B mixture-of-experts size with about 3B active | **Yes** | Main local family for the Fast, Balanced, and Code lanes | A community test on this chip reported tens of tokens per second for a 30B-class Qwen MoE model at 4-bit; each model has its own license, so check it (D53) |
| **Kimi** (Moonshot AI): open weights, reported as a modified MIT license | **No for the flagship.** The K2 family is about 1 trillion parameters (32 billion active); even a 2-bit version is reported at about 350 GB | Cloud API only, under D22 (approval each time), unless a smaller Kimi model suits the machine; small companion models in the K2 family appear to be draft models for speculative decoding, not stand-alone assistants | A smaller Kimi release may exist; check when building |
| **Claude Sonnet** (Anthropic): **closed weights** | **No.** It cannot be downloaded, only used through the cloud | Cloud step only (D22): very hard tasks, with approval each time | Never used as training data (Section 9.5) |
| **Other open families to benchmark** (for example gpt-oss, Mistral and Devstral, DeepSeek, GLM, Gemma, Llama) | Depends on size and format | Alternates in each lane | Shortlist only; the benchmark decides |

**Roster rules**
1. **Two or more per lane.** Each lane (Section 7.2) gets a **primary and at least one alternate from a different family**, both downloaded and benchmarked in Phase 0. The benchmark ranks them; the ranking is re-run when models change.
2. **Redundancy.** If a model fails to load, runs out of memory, or fails the quality gate (Section 16.1), the alternate takes over before escalation to the cloud.
3. **Second opinion for important answers.** For high-stakes tasks (for example research summaries the owner will act on), a model from a different family can check the answer. This costs time, so it is used only where quality matters most (D14).
4. **Shared know-how.** Because learning lives in the external memory (Section 9.4), a procedure that worked once, even when a strong model such as a cloud model produced the result and the owner approved it, is stored as a procedure and can be followed by the local models. It is **not** used as training data (Section 9.5).
5. **English preference, not a ban.** The strongest open families (Qwen, Kimi) are multilingual. D33's English-first rule applies **when quality is equal**; vocabulary trimming can reduce a multilingual model later (Section 7.3).
6. **Safe acquisition.** Every download needs the owner's approval (Section 7.4) and a disk-space check. Download only from the model's official publisher, in safe file formats (GGUF or safetensors), never run downloaded code, check the license (D53), pin the exact revision, and verify checksums.
7. **Storage.** Plan about 150 to 250 GB for the roster, and keep at least 25% of the 1 TB free (Section 22.2, P4).

---

## 8. Memory and Context Architecture

*In plain words: How Jarvis remembers you and your work across every chat without wasting effort or leaking private data.*

**Owner requirements [OWNER: D7, D27]:** memory across all chats, token-efficient, 90%+ accurate, Jarvis decides what stays in context and what goes to RAG, self-learning, only sensitive items encrypted.

### 8.1 Memory tiers **[PROPOSED]**
| Tier | Content | Storage | In prompt? |
|---|---|---|---|
| T0 Working context | Current task, last turns, active plan | Memory | Always |
| T1 Owner profile | Compact structured facts: preferences, communication style, work habits, recurring contacts, routines, owner-stated rules | SQLite | Always, within a fixed small token budget |
| T2 Session summaries | Rolling summaries of past conversations | SQLite + LanceDB | When relevant |
| T3 Episodic | Events: asked, done, outcome, owner feedback | LanceDB + SQLite metadata | On demand |
| T4 Knowledge | Scraped pages, notes, files, email digests | LanceDB | On demand |
| T5 Skill memory | Skill definitions, versions, success/failure stats | SQLite + files | When the skill is chosen |
| T6 Procedural graph ("muscle memory") | Weighted connections between goals, contexts, procedures, steps, and outcomes, learned from experience (Section 9.4) | SQLite + LanceDB | Activated when a similar goal or context appears |

### 8.2 Memory Manager policies **[PROPOSED]**
- **Write:** after each interaction, score candidates on importance, novelty, owner emphasis ("remember this"), repetition, and sensitivity. Drop low-value items; promote stable preferences to T1; send the rest to T2-T4.
- **Read:** build each prompt inside a **token budget**: T0 + T1 + top-k retrieved items ranked by relevance, recency, and importance. Never dump history.
- **Consolidation ("sleep" cycle, when idle and plugged in):** summarize old sessions, merge duplicates, flag contradictions with the profile, decay stale items, promote or demote between tiers.
- **Owner control:** view, correct, and delete memories; mark items sensitive or never-store.

### 8.3 Sensitive items **[OWNER: D27; mechanics PROPOSED]**
- Only **sensitive items** are encrypted, not the whole store. A classifier tags sensitivity at write time (candidates: credentials, financial, health, government IDs, items the owner marks).
- Sensitive items are encrypted with a key kept in the OS secret store (Windows Credential Manager/DPAPI, or the Linux keyring); never in the database or in prompts.
- Because embeddings can reveal their source text, sensitive items get **no embedding in the shared vector store**; they are retrieved by exact key or tag.
- Full-disk encryption (for example BitLocker) is recommended separately, since this is a portable device.
- **Never-store list: [DEFERRED].** Interim default **[PROPOSED]**: do not persist passwords, card or bank numbers, or government ID numbers; credentials go to the secrets vault only when the owner explicitly adds them; they may be used transiently for a task.

### 8.4 Session isolation
Every record carries `user_id` and `session_id`; retrieval filters by both. Details in Section 11.

---

## 9. Skills and Self-Learning

*In plain words: How Jarvis learns how you work, creates new skills, and builds muscle memory from experience.*

### 9.1 Learning the owner **[OWNER: R2; design PROPOSED]**
- **Style profile:** tone, length, language, and sign-offs per context (work email, chat, formal).
- **Work profile:** tools, routines, time patterns, projects, priorities, important people.
- **Feedback loop:** corrections ("shorter") update the profile; repeated corrections become rules.

### 9.2 Skill lifecycle **[OWNER: D8; design PROPOSED]**
1. **Detect gap:** no existing skill or tool fits the request.
2. **Announce:** tell the owner what skill will be created or acquired, and why.
3. **Build:** generate it with a declared permission manifest.
4. **Test in the sandbox** with sample inputs, checking for errors and forbidden behavior.
5. **Approve:** low-risk skills register after announcement; skills needing Tier 2 permissions need the owner's approval.
6. **Register and version** with success/failure stats; can be disabled or rolled back.
7. **Improve** from outcomes and feedback.

### 9.3 Built-in skill candidates **[PROPOSED]**
Research and fact-check, email triage and drafting, calendar/contacts/reminders, file handling, writing in the owner's style, browser tasks, laptop control, phone control, coding help, routines.

### 9.4 Experience learning ("muscle memory") **[OWNER: D36; design PROPOSED]**
**Owner's intent:** every time the local AI does something, it should create connections about *how* to do it, *what* to do, and *when* to do it, the way a human builds muscle memory and neurons connect more strongly through repetition.

**Honest framing.** The model's weights do not change while Jarvis works. The learning lives in an **external connection graph** that Jarvis reads and updates. It behaves like muscle memory because repeated, successful behavior becomes stronger, faster, and cheaper. Retraining the model's weights is a separate, later option that the owner has approved in principle (D49, Section 9.5).

**What is recorded for every episode**
- **What:** the goal and its parameters.
- **When:** the context and trigger (time, app, person, project, the event that came before).
- **How:** tools, steps, commands, and parameters used.
- **Result:** outcome and any errors.
- **Feedback:** the owner's approval, corrections, and one-tap ratings.
- **Cost:** tokens and time.

**The connection graph**
- **Nodes:** goals, contexts and triggers, skills, tools, steps, outcomes, and entities (people, files, sites, projects).
- **Weighted edges:** goal to procedure ("how"), context to goal ("when"), step to next step ("sequence"), procedure to outcome ("result"), procedure to owner preference ("the owner likes this").

**Learning rules**
1. **Reinforce** a connection after success or positive feedback.
2. **Strengthen with repetition**, with diminishing returns.
3. **Weaken** after failure or a correction.
4. **Decay** connections that go unused.
5. **Generalize:** cluster similar episodes into one procedure with slots instead of fixed values.
6. **Associate:** link new knowledge to existing nodes.

**Three levels**
1. **Episodic:** the raw record of what happened.
2. **Procedural:** a distilled procedure with its *when* (preconditions), *how* (steps), and expected outcome.
3. **Compiled reflex:** a deterministic script or macro that runs **without a model call** once it is reliable (for example after several successes, no recent failures, and the owner's approval). This is the muscle memory: faster, cheaper, and consistent with the cost policy (Section 16).

**Recall.** For a new request, activation spreads from the goal and context nodes to propose known procedures ranked by weight, recency, and context match. High confidence and permitted by the owner's rules (D23): run it, announcing first. Medium: use it as a plan template for the model. Low: reason from scratch, then record the episode.

**Consolidation** runs in the sleep cycle: merge episodes, compile reflexes, prune weak connections, and optionally give the owner a short "what I learned" digest.

**Safety [PROPOSED]**
- A learned procedure can never gain permissions beyond its skill's manifest.
- Only episodes from owner-initiated or owner-approved work are learned, **never instructions found inside emails, web pages, or files** (protects against poisoning).
- Every connection stores its provenance; the owner can view, edit, freeze, or delete any connection or procedure.
- If a compiled reflex fails, Jarvis falls back to the model path and lowers its weight.

**Metrics:** reflex rate (share of tasks done without a model call), success rate per procedure, tokens saved, and time saved, tracked in the evaluation harness.

**Coding agent.** The local coding agent keeps a project "how we do things" notes memory (conventions, commands, pitfalls) in a store **separate from the editor's instruction and configuration files**, which only the owner edits.

### 9.5 Model adaptation: retraining later **[OWNER: D49; design PROPOSED]**
**Owner's decision:** besides external memory, Jarvis may **also retrain the model's weights later, on data the owner approves.** This is **not part of version 1**; it is a later phase (roadmap Phase 8) that builds on the experience graph and the evaluation harness.

**Proposed approach**
- **Adapters, not full retraining.** Small low-rank adapters (LoRA-style) are trained on top of a frozen, quantized base model. They are small, can be swapped or switched off, and can be rolled back, and the base model stays intact. Training tools for this chip are uncertain **[VERIFY]**; very small specialist models (router, email-importance classifier) are the most realistic first targets.
- **The owner approves the data.** A training set is built only from owner-approved episodes and corrections. It **excludes sensitive items (D27)** and anything that came from untrusted content such as emails or web pages. The owner reviews the dataset before any training, and deleting an episode removes it from future training.
- **The owner approves each run (Tier 2).** Training runs when the laptop is plugged in, idle, and cool.
- **Quality gate (D14).** A new adapter is released only if the evaluation set shows **no regression and a real improvement** on the target task types, with an A/B comparison against the current model; otherwise it is discarded. Every adapter is versioned and reversible.
- **Local only.** Training data and adapters never leave the machine; sending data to a cloud service for training would need a separate explicit decision by the owner.
- **No training on hosted-model outputs by default.** Answers from a cloud model (for example Claude Sonnet, D22) are excluded from training sets, because hosted providers generally restrict using their outputs to train other models. **[VERIFY the provider's terms.]** Such answers can still be kept as owner-approved procedures or notes in memory (Section 9.4).
- **Risks to manage:** the model forgetting earlier skills, learning from mistakes, and leaking private details into weights (which cannot be edited afterwards, so training data must be clean).

---

## 10. Research and Fact-Check Skill (original pipeline)

*In plain words: The original research feature: search the web, read pages, cross-check, and answer with sources.*

```
[User Request] -> [Router / Intent Analyzer] --(casual: direct answer)
      | factual / research
      v
[SearXNG] -> [Scraper + Cleaner (Readability, Cheerio)] -> [Consensus Engine] -> [Synthesis (local model)]
```

**Requirements carried over from the original spec**
- **Router classes (original spec):** Casual, Code/Logic, and Research/Fact retrieval. Casual and non-factual requests get a direct answer without searching.
- **SearxngService:** query `http://localhost:8080/search?format=json&q=<query>`; remove duplicate domains and dead links; **max 2 URLs per domain**. PDFs and other formats are no longer dropped; they are converted to text where feasible (D10).
- **WebScraperService:** 5-second timeout, realistic headers, user-agent rotation, concurrent fetch; Readability extraction; cap about 4,000 tokens (~16,000 characters) per page.
- **ConsensusEngine:** break text into propositions; label **High Confidence** (2 or more independent domains), **Unverified** (1 source), **Contradictory** (conflict).
- **Owner rule [D29]:** with fewer than 3 independent sources, **always label and still answer**; say how many independent sources back each claim. **[PROPOSED]** use the search budget to look for more sources first; a primary or official source may be noted as such; contradictions are shown side by side with sources; labels appear in the answer text.
- **Budgets:** max 3 search iterations per query; 12,000-token prompt limit (**now a tunable config value**, originally set for 6-8 GB VRAM); 500 ms cooling delay between heavy inference loops.
- **Provider layer:** the original `OllamaService` becomes a generic LLM provider with retry, streaming, and fallback to a smaller model on **unified-memory pressure**, latency spikes, or OOM.
- **Needs a real design [PROPOSED]:** claim extraction, normalization, similarity matching, confidence formula, and a re-query strategy for the 3-iteration budget.

---

## 11. Telegram Interface, Sessions, and Tasks

*In plain words: How you talk to Jarvis on Telegram, and how several tasks stay separate.*

### 11.1 Telegram as the universal interface **[OWNER: D6, D11]**
- **Exposes:** chat, commands, task status, approvals (inline buttons), file send/receive, screenshots from browser tasks, voice notes, memory and skill management, model status, kill switch.
- **Security [PROPOSED]:** allow-list of Telegram user IDs (owner is admin); optional PIN for Tier 2 actions; bot token in the secrets vault; outbound long polling only.
- **Telegram limits to design for [VERIFY]:** message length, file size (this matters for photos and video), rate limits (prefer editing one status message in place; send long output as a file). Photo albums arrive as a group of messages that Jarvis combines into one task; for exact originals the owner sends the images as files (Section 5.10).
- **Draft commands [PROPOSED]:** `/new <name>`, `/sessions`, `/switch <name>`, `/rename`, `/close`, `/tasks`, `/status`, `/cancel <id>`, `/memory`, `/forget`, `/models`, `/skills`, `/trust <skill> <level>`, `/agents` (running agents and tasks), `/sync` (check GitHub now), `/release` (confirm a release), `/pause`, `/kill`, `/help`.
- **Users [OWNER: D25]:** only the owner now. **[PROPOSED]** the data model is multi-user-ready (every record has `user_id`); any added user gets a separate profile, memory, sessions, and permissions with no access to the owner's data, email, laptop, or phone; only the owner can add or remove users.

### 11.2 Sessions, tasks, and isolation **[OWNER: D12, D26; design PROPOSED]**
```
User (Telegram ID)
 |-- Profile (shared knowledge of the person: memory T1)
 |-- Sessions (isolated workspaces, e.g. "market-report")
      |-- Tasks (units of work inside a session)
```
- Every stored item is tagged with `user_id` and `session_id`; retrieval always filters by both, so session context never leaks.
- **Shared on purpose:** the user profile. Session facts reach the profile only through the Memory Manager or when the owner says "remember globally".
- Cross-session lookups are explicit and read-only.

### 11.3 Owner's multi-task question and the answer
*How does Jarvis track three or more tasks from one bot?* **Auto-routing first [OWNER: D26].**
- The master model matches each message to an existing session or task using content, recent activity, and session summaries. High confidence: route silently, but **every reply carries a task tag** (for example `[#2 market-report]`). Low confidence: ask a one-tap question ("Is this for #2 or a new task?"). If a message could affect two tasks, ask.
- Manual overrides always work: `/commands` or replying to a specific message.
- **Approval buttons and Tier 2 actions are bound to a task ID and are never auto-routed.**
- **Concurrency:** a SQLite task queue with states `queued`, `running`, `waiting_approval`, `done`, `failed`, `cancelled`. Searching, scraping, and browsing run in parallel across tasks; **LLM inference is priority-scheduled** (interactive replies first, then approval follow-ups, then background work) because one heavy model fits at a time. `/tasks` lists everything. Several agents can work on different tasks at once, within the limits in Section 5.6.
- **Phases:** Phase 1 one session per user with `/commands`; Phase 2 concurrent tasks with the queue, tags, and auto-routing; Phase 3 reply routing and Telegram topics as extra manual steering.

---

## 12. Automation: Browser, Laptop, and Phones

*In plain words: How Jarvis operates the browser, your laptop, and your phones.*

### 12.1 Browser **[OWNER: D30, D31; design PROPOSED]**
- **Playwright** (free, TypeScript-native, auto-waiting, isolated contexts, tracing, accessibility snapshots). Selenium is not used.
- The real cost of browser automation is **model tokens**. Send the model a **distilled page view** (accessibility tree or trimmed DOM), not raw HTML or full screenshots; use deterministic scripts for repeated flows; a flow that works is saved as a **macro skill**.
- Loop: observe, plan, announce, act, verify.
- **Logged-in sites allowed [OWNER: D30]:** Google services, work tools (Slack, Notion, Jira, and similar), social media, shopping and banking. Safeguards **[PROPOSED]**: the owner logs in once into a dedicated browser profile; credentials stay in the vault; per-site trust rules follow D23; banking and shopping default to **read-only** and any payment, transfer, purchase, or change of account details is Tier 2 with amount and recipient shown; posting or messaging on social media is Tier 2; CAPTCHA and two-factor prompts are handed to the owner through Telegram; page content is untrusted. Note: some sites restrict automated access and may lock accounts, so pace actions humanly; site terms are the owner's responsibility.

### 12.2 Laptop **[OWNER: D20; design PROPOSED]**
Scope: files and folders, browser, coding/terminal/dev tools, and any app on screen (full computer control).
- Reaches the host only through the **Action Gateway and host bridge**.
- File access starts with owner-approved folders.
- Shell commands, installs, deletes, and anything external-facing are Tier 2.
- Full computer control is screen-based (vision model plus mouse and keyboard), uses the Vision lane, and treats screen content as untrusted.
- Code and tools must run on both Windows and Linux (D17).

### 12.3 Phones **[OWNER: D19; design PROPOSED]**
Scope: Telegram as baseline; read and forward notifications; calendar, contacts, and reminders; open apps and tap/type (Android); in general anything a normal user does on a phone.
- **Android first:** deeper control (for example through the debug bridge or accessibility-based control **[VERIFY]**). **iPhone** is limited by Apple's restrictions, so it gets a reduced set (Telegram, and Apple-permitted hooks such as Shortcuts).
- Every phone action follows the tiers: sending messages, calls, payments, deleting, and installing are Tier 2. Phone screen content is untrusted.

---

## 13. Email and Proactive Monitoring

*In plain words: How Jarvis watches your Gmail and reports to you on Telegram.*

**Owner decisions [OWNER: D6, D21]:** provider **Gmail / Google Workspace**; Jarvis may **read, summarize, write drafts, and send replies only after the owner approves each one**. No autonomous sending.

**Design [PROPOSED]**
```
[Mailbox watcher] -> [Importance classifier (uses owner profile)] -> [Summarizer]
   -> [Telegram message with action buttons]
   -> [Owner taps: Reply draft / Archive / Remind me / Ask Jarvis more]
   -> [Action Gateway applies tiers; sending needs per-message approval]
```
- Access: Gmail API with OAuth and the narrowest scope first (read-only), tokens in the secrets vault; IMAP with an app password as a fallback. Workspace accounts may need the administrator to allow API access. **[VERIFY]**
- Tier mapping: read and summarize = Tier 0; drafts = Tier 1; sending = Tier 2 (Telegram button showing final text and recipients).
- Importance is **learned** (senders, keywords, thread history, owner reactions), not hard-coded; quiet hours, rate limits, and a digest mode prevent notification spam.
- Email content is untrusted data and can never trigger a send by itself.

---

## 14. Voice

*In plain words: How you can talk to Jarvis by voice.*

**[OWNER: D24]** Voice in all modes: text, Telegram voice notes (in and out), and live voice on the laptop (microphone, speaker, wake word).

**Design [PROPOSED]**
- All speech processing is **local**: speech-to-text, text-to-speech, and wake-word detection, so audio never leaves the machine.
- A visible indicator shows when the microphone is listening; a mute and kill command exist.
- Tier 2 approvals by voice need a confirmation step (for example Jarvis repeats the action back), because voice can be misheard or spoofed.
- Speech models use a share of the memory budget (Speech lane, Section 7.2); the NPU may later host small always-on parts **[VERIFY]**.

---

## 15. Information Access Policy

*In plain words: Jarvis does not filter what you are allowed to look up.*

**[OWNER: D10]** Jarvis should have access to all kinds of information and knowledge on the internet and should not restrict the owner from any data.

**Interpretation [PROPOSED]**
- The agent layer adds **no topic filters and no domain allow- or block-lists** to the owner's searches and page retrieval. The safety controls in Section 6 govern **actions** and **malicious instructions hidden in content**, not topics.
- SearXNG uses a broad engine set (general web, news, academic, IT/docs, Q&A and forums, code hosting, archives) and multiple languages; no forced safe search.
- PDFs, transcripts, and other formats are converted to text where feasible.
- Content behind the owner's own logins is reachable through browser automation (Section 12.1) under the permission tiers.
- Only **technical** limits apply: polite rate limiting, timeouts, and retry budgets.
- Local models have their own built-in behavior; Jarvis adds no extra filter layer on top, and model choice can take this into account.
- Legal and terms-of-service responsibility for retrieved content stays with the owner.

---

## 16. Quality, Cost, and Evaluation

*In plain words: How Jarvis balances quality and cost, and how the 90% accuracy goal is measured.*

### 16.1 Quality-first policy **[OWNER: D14; design PROPOSED]**
The owner wants better, high-quality results at lower cost; if a tradeoff is needed, **compromise on cost, never on the result.** Quality is a **hard constraint**; cost (tokens, time, GPU load and heat, electricity, owner attention, and money if cloud is used) is minimized subject to it.

**Cascade**
1. Start with deterministic code, then the cheapest model that can plausibly do the task.
2. Run the task's **quality gate** (grounding and citation checks, self-consistency, schema validation, verifier pass, tests for generated code).
3. If the gate fails, **escalate** to a stronger local model or lane.
4. **Last rung: a cloud model, only for very hard tasks and only with the owner's approval each time [OWNER: D22].** Before asking, Jarvis shows what would be sent, why local failed, and the estimated cost; sensitive data is excluded or redacted; every cloud call is logged.
5. **Honesty rule:** if the gate still fails, Jarvis says so instead of presenting a weak answer as final.

**Supporting mechanisms:** caching (search results with expiry, scraped pages, embeddings, repeated answers), context compression and retrieval budgets, batching, off-peak scheduling, a **cost ledger and quality score per task**, and a routing policy that learns which model suffices for which task type.

### 16.2 Measuring "90%+ accurate" **[OWNER: D28; design PROPOSED]**
- An **evaluation set built from the owner's real tasks** (research questions with known answers, email triage, drafting, browser, file, and coding tasks), re-run automatically after any change to models, prompts, memory, or skills, with a score per task type.
- **Owner feedback** with one tap in Telegram (good / needs fixing, optional note), stored with the task.
- A dashboard of accuracy, token cost, and time per task type; a regression alert when any task type falls below its threshold.
- The same harness gates every efficiency change from Section 7.3.

---

## 17. Local AI Coding Environment and Development Workflow (Phase 0 onward)

*In plain words: How Jarvis gets built: your local AI coding setup and the GitHub board workflow from idea to release.*

### 17.1 Owner requirement **[OWNER: R15, D32]**
Before starting the project, the owner wants Jarvis's own code to be built with the owner's **local AI**, inside **VS Code or Cursor**, using the editor's AI agent plus **Cursor-style autocomplete**.

### 17.2 Findings **[VERIFY at build time; community sources, mid-2026]**
- **Cursor:** direct connections to local models on localhost are not supported; requests go through Cursor's servers, so a local model needs a **public HTTPS endpoint** (a tunnel). That conflicts with this project's no-public-exposure rule (Section 6), so **Cursor is not used for local models.**
- **VS Code:** since a mid-June 2026 release, VS Code can list a local Ollama server in the Copilot Chat model picker, powering **chat and agent mode**; it does **not** cover inline completions, which need a separate model source. A model must support tool calling to work in agent mode.
- **Agent extensions:** **Cline** is described as the active, widely used autonomous coding agent for VS Code (plans, edits files, runs terminal commands; resource-hungry). Roo Code's status changed (reports of archiving and a rename; sources conflict). **Continue** was reportedly acquired and discontinued as a standalone product (single source; unconfirmed), so do not depend on it. OpenCode is a popular command-line agent.
- **Autocomplete:** needs a fill-in-the-middle code model served locally plus an editor extension that requests completions from it (candidates include llama.cpp's own VS Code extension and Ollama-backed completion extensions).

### 17.3 Proposed setup
1. **Editor [OWNER: D47]:** **VS Code.** Telemetry is switched off where possible, and extensions are limited to a short vetted list with pinned versions.
2. **Inference:** the same local backend chosen by the benchmark (Section 7.5), shared with Jarvis so the Model Manager and Memory Governor see all loaded models.
3. **Chat and agent:** VS Code's local provider and/or a Cline-class extension pointed at the local server, using a tool-calling, code-strong model from the Fast or Balanced lane.
4. **Autocomplete:** a small fill-in-the-middle code model (1-4 GB) kept loaded while coding, served locally.
5. **Safety for the agent extension:** terminal commands and file writes require manual approval (no auto-approve), extension versions are pinned, publishers verified, telemetry off where possible, and no tunnel or public endpoint is used.
6. **Same rules as Jarvis:** build conventions (Section 18) apply to everything the coding agent installs.

### 17.4 Reality check **[PROPOSED]**
Local 30B-class models are weaker than the largest hosted models on big, multi-file engineering. Mitigations: small well-specified tasks, tests written first, the owner reviewing diffs, and the evaluation harness. For genuinely hard coding problems the cloud step (D22, approval each time) remains available. Because the local AI will build the whole system (D35), the blueprint must be split into small, independently testable tasks, each with tests written first.

### 17.5 Who writes the code **[OWNER: D35]**
**Decided:** Claude writes everything the blueprint needs; the owner's **local AI then builds the code entirely** from it, working inside the editor setup above. Consequences: Phase 0 (the local coding environment) must work before building starts; the blueprint is split into small tasks with tests; the local coding agent follows the build conventions and the owner approves terminal commands; the cloud step (D22) stays available for stuck tasks, with approval each time.

### 17.6 The development workflow: overview **[OWNER: D37; design PROPOSED]**
The project is run like a real software project. **All code lives in the owner's Git repository on GitHub**, and the **GitHub Projects kanban board is the control surface.** The owner creates and moves tickets; the local AI, acting as a **developer (the Dev Agent)**, picks up new tickets and every update **automatically** and records everything on the ticket.

- **Dev Agent versus Jarvis.** The Dev Agent is the role in which the local AI builds Jarvis. It works only on the repository, in the dev environment, with a limited single-repository GitHub token (the owner's own account, D42), and **never touches the owner's real accounts, email, laptop, or phones.** Jarvis, the assistant, is the product being built. Both share the model backend, memory tiers, and the experience graph (Section 9.4).
- **Each ticket is a session (D12):** an isolated context holding the ticket's history, with the shared owner profile and project knowledge.
- **The repository holds the documents:** this master context, a blueprint per ticket, and the owner's coding rules (Section 17.11). Changes to the master context go through a pull request that the owner reviews.
- **Ticket types:** Feature (what the owner writes in Concept), Story (a slice of a feature), and Bug. A Type field on the board tells them apart.

### 17.7 Board stages and gates **[OWNER: D38; details PROPOSED]**
| Column | Owner does | AI does automatically | Exit gate |
|---|---|---|---|
| **Concept** | Writes the expectation or new feature, with details and how it should work | Reads the ticket; builds context from memory (decisions, related tickets, the code, the owner's rules); posts its **own understanding**, a **proposed blueprint**, a **proposed breakdown into user stories** with acceptance criteria (and, for stories the owner already wrote, comments on gaps, overlaps, and questions), risks and limitations, and **numbered questions with suggestions** (a recommended option marked). Re-reads every owner answer, updates the concept, and says when no questions remain | Every AI question is answered and the AI marks the concept complete (label `concept-complete`). Only then does the owner move it to Ready for Dev |
| **Ready for Dev** | Moves the card here only when the concept is complete | Starts: creates the feature branch; picks up the owner's stories and creates tickets for the AI-proposed stories the owner left in place (see story creation below); creates a branch per story; writes tests first; implements; writes every **new requirement, error, or limitation** into the ticket's AI Updates log; when finished, runs tests, lint, type-check, and build, does a self-review, opens the pull request, and moves the card to Code Review | Implementation done; checks pass; pull request description complete |
| **Code Review** | Reviews the code before the story merges into the feature branch; writes comments | Picks up every comment. A question gets an answer. A change that is clearly right gets the code fixed, pushed, explained, and the thread resolved. Disagreement or ambiguity gets reasoning and options, and the thread stays open for the owner | The owner approves the pull request (the approval signal is described in Section 17.10). The AI then moves the card to QA and posts a QA guide |
| **QA** | Uses the feature in the QA environment and reports bugs | Has already **written and run tests during the build** and attaches the report, so fewer bugs reach QA. For each bug: reproduces it with a failing test, fixes it, and sends it back through review (or a quick-fix path if the owner allows) | The owner passes QA and moves the card to Done |
| **Done** | Moves the card here after QA passes | Merges the story into the feature branch, deletes the story branch, updates the ticket, changelog, and docs, and records the lessons in experience memory. **When every story of the feature is Done**, runs the full regression and merges the feature branch into main | Feature in main; ticket closed |

**Gate enforcement [PROPOSED]**
- If a card is moved to Ready for Dev while questions are still open, the AI does **not** start; it lists the open questions and moves the card back to Concept.
- If the owner edits a ticket after work has started, the AI pauses, posts an impact analysis, and asks before continuing.
- If a card moves backward, the AI stops work on it and keeps the branch.
- **Scope never grows silently:** a new requirement the AI discovers is proposed to the owner in the AI Updates log, not just built.

**Story creation [OWNER: D54, revised v1.18; mechanics PROPOSED]**
The owner answered **both**: the AI can propose stories in the Concept stage, and the owner will **mostly create the stories himself.**
1. **Owner-created stories are authoritative.** The AI never edits, merges, splits, reorders, or deletes them without the owner's approval. It comments on them with questions, missing acceptance criteria, overlaps, or suggested splits.
2. **AI-proposed stories are suggestions** inside the Concept response. The AI creates tickets for them (labeled `ai-proposed`) **only when the owner moves the feature to Ready for Dev** and only for proposals the owner did not reject or replace. The owner can edit or delete any of them afterwards.
3. **No duplicates.** Before creating anything, the AI compares its proposals with the owner's stories and creates only the non-overlapping ones. If unsure whether two stories overlap, it asks (label `needs-owner`) instead of creating.
4. **Every story needs the same minimum before it is built,** whoever wrote it: a goal, acceptance criteria, and no open questions. The AI checks this when the feature moves to Ready for Dev; a story that fails the check is not started and gets a comment, while the feature's other stories can proceed. The feature cannot finish until all its stories are Done (D39).
5. **Cards.** Stories sit under their feature as sub-issues. The AI moves a story's card to Ready for Dev only as the consequence of the owner moving the parent feature there (the story must pass the check above), and logs it; the owner can also move a story himself.

**Exactly five columns [OWNER, v1.3]:** Concept, Ready for Dev, Code Review, QA, Done. There are no *In Development*, *Blocked*, or *Release* columns. **[PROPOSED]** The extra states are shown with **labels** on the card instead: `concept-complete`, `ai-working` (the AI is building it, inside Ready for Dev), `needs-owner` (the AI is waiting for an answer or a decision), `blocked` (with the reason in the AI Updates log), `bug`, and `release-approved` (set by the owner to approve a release). Three more labels come from other rules: `ai-proposed` (a story the AI proposed, Section 17.7), `ai-authored` (a pull request opened by the AI, Section 17.10), and `owner-approved` (the owner's approval on a pull request, Section 17.10). **The full label set has nine labels:** `concept-complete`, `ai-working`, `needs-owner`, `blocked`, `bug`, `release-approved`, `ai-proposed`, `ai-authored`, `owner-approved`.

### 17.8 Branching, merging, and release **[OWNER: D39; mechanics PROPOSED]**
```
master   (production)  <---- only when the owner decides ----------------+
  ^                                                                       |
main     (integration)  <---- a feature merges when ALL its stories are Done
  ^
feature/<id>-<slug>     <---- a story merges when the owner moves it to Done
  ^
story/<id>-<slug>       <---- the AI works here; the owner reviews this pull request
```
1. **Story to feature branch:** after the owner approves the code review and passes QA (Done). **Squash merge [OWNER: D45]** keeps the history clean: one commit per story.
2. **Feature to main:** **automatic** once every story is Done, the full regression passes, and the required checks are green. It is merged with a **merge commit [OWNER: D45]**, which keeps each feature visible in the history. The AI posts a release-notes draft and notifies the owner on Telegram.
3. **Main to master and the global build:** **only when the owner decides**, with an explicit signal (the owner adds the label `release-approved` to the feature, or sends `/release` on Telegram; there is no Release column). The AI then opens the release pull request (merged into `master` with a merge commit **[PROPOSED]**), tags a version, builds the release artifacts, writes release notes, and keeps a rollback ready.
4. **Protection:** main and master are protected (no direct pushes, required status checks, administrators included so the token cannot bypass the rules). Because the AI uses the owner's account (D42), **GitHub itself cannot stop the AI from approving or merging; the Action Gateway enforces that in software** (Section 17.10).
5. **Names [OWNER, v1.4]:** two long-lived branches named **`main`** (integration: finished features combine here) and **`master`** (production: the released version). Working branches are `feature/`, `story/`, and `fix/`; commit messages use the Conventional Commits style. **[PROPOSED]** Because the two names are easy to confuse, the repository's README, the branch-protection descriptions, and the Dev Agent's builder guide state this explicitly, and the Dev Agent is hard-coded to target only `feature/` and `story/` branches, `main` through the feature-completion rule, and `master` only through the owner-approved release flow. GitHub's default branch is set to `main`.

**Release pipeline [OWNER: D43; design PROPOSED]**
When the owner approves a release (the `release-approved` label plus the Telegram confirmation, D42), the global build produces **everything the owner asked for**:
1. **Docker images** for the agent and its services (SearXNG configuration, Playwright, and so on), published to a container registry (private by default).
2. **Installers for Windows and Linux** (Windows installer; Linux package or similar), each with a checksum.
3. **Automatic updates on the owner's own devices** through an update channel.
4. **A release other people can install later** (supports the multi-user plan, D25).

Design points:
- **Versioning:** semantic versions, a git tag on `master`, and generated release notes from the merged stories.
- **Build:** run by continuous integration on GitHub's side from a clean checkout, with pinned dependencies and a lockfile (Section 18.2); each release also publishes a **software bill of materials** and checksums.
- **No Windows code-signing certificate for now [OWNER: D52]:** Windows will show an "unknown publisher" warning on install, which is acceptable on the owner's own devices. This does **not** remove the need to verify updates: **[PROPOSED]** releases are still signed with a free release-signing key and checked by the auto-updater, so a tampered update is rejected. The certificate can be added later without redesign, and should be reconsidered before public distribution.
- **Signing keys never reach the Dev Agent.** Release signing (and any Windows code-signing certificate) happens only after the owner's confirmation, with the keys held outside the agent's container and vault scope.
- **Auto-update on the owner's devices:** outbound checks only (no inbound connection), verify the signature and checksum, **back up data**, run schema migrations, health-check after the update, and **roll back automatically** if the check fails. Updates apply when Jarvis is idle, never in the middle of a task, and are announced on Telegram. Two channels: **stable** (from `master`) and an optional **preview** (from `main`) for the owner's QA and staging devices.
- **For other people:** artifacts must contain **no owner data** (no memory, profile, tokens, or logs); a first-run setup wizard creates each user's own accounts and settings; permission tiers start strict; **no telemetry unless the user opts in**; a **proprietary license (all rights reserved, D53)**, terms of use, and documentation are included. How others receive it is **decided later [OWNER: D51]**: the pipeline supports both an invite-only channel and a public channel (see below).
- **Distribution channel [OWNER: D51; design PROPOSED]:** the pipeline builds each release once and publishes it through a **channel setting** with two modes. **Invite-only:** a private registry and download area with per-person access tokens that the owner can revoke. **Public:** a separate public location that holds **only the built artifacts and checksums, never the source repository** (which stays private, D50). Signing, checksums, and the software bill of materials are required in both modes. A public release also needs a chosen license first.
- **License consequences [OWNER: D53; checks PROPOSED]:** because Jarvis is proprietary, every dependency's license must allow proprietary distribution. The pipeline runs a **dependency license scan** and flags copyleft (for example GPL and AGPL) and non-commercial licenses for the owner's decision. **SearXNG is licensed under the AGPL**: running it as an unmodified, separate service is one thing, but shipping it inside distributed images brings source-offer and notice obligations, so decide whether to ship it or have each user pull it themselves. **Model weights are not bundled**: each model has its own license, so users download models themselves under those terms. A third-party notices file is generated for every release. **[VERIFY]** these points with a lawyer before distributing to other people; this is not legal advice.
- **Phone companion:** if a phone companion app is built (Section 12.3), its package is built and distributed through the same pipeline.

### 17.9 Environments **[PROPOSED]**
| Environment | Branch | Purpose | Safety |
|---|---|---|---|
| Dev | story and feature branches | Where the AI builds and runs its own tests | Docker dev container; mocked laptop and phone bridges; separate test Telegram bot; no real accounts |
| QA | the story branch under review | Where the owner tests the feature | **[OWNER: D44]** a **separate test Telegram bot** and a **test Gmail account**; separate data folder and ports; strict permission tiers; test accounts' tokens in their own vault entries, so the QA copy cannot read production secrets. **[PROPOSED]** the test Gmail is seeded with sample emails (important, routine, spam, phishing, and prompt-injection samples); features touching banking, social media, or other real services use mocks or local fixtures in QA; the owner may allow real read-only access for one feature, explicitly and temporarily |
| Staging | main | Integration of all finished features; full regression; the owner can dogfood it | Separate from the daily Jarvis |
| Production | master | The real Jarvis the owner uses every day | Updated only on a release the owner approved; backup before any data migration; rollback to the previous tag |

### 17.10 Automation mechanism and security **[PROPOSED: D41]**
- **Polling, not webhooks.** The Dev Agent polls the GitHub API from the laptop (outbound only), using conditional requests, about every 30-60 seconds while active and slower when idle; `/sync` on Telegram forces a check. Webhooks would need a public endpoint, which this project does not allow (Section 6), and no tunnel is used. GitHub Actions may run the continuous-integration checks on GitHub's side; self-hosted runners on the laptop are not used unless the owner approves them. **[VERIFY]** the GraphQL fields for the Projects board at build time.
- **No duplicate or looping work.** Processed event identifiers and update times are stored in SQLite; the AI's own comments carry a marker and are ignored; comments are rate-limited.
- **Identity and least privilege [OWNER: D42].** The AI signs in with the **owner's own GitHub account**, but **never with the owner's password or a broad token**. It uses a **fine-grained personal access token limited to this one repository**, with only issues, pull requests, contents (non-protected branches), and the organization's Projects permission (the board must be owned by an organization, because fine-grained tokens cannot reach a board owned by a personal account, D63), an **expiry date** (renewed regularly), and no admin, settings, or workflow-file rights. The token lives in the secrets vault, not in the repository, not in prompts, and not in the dev container's files beyond what it needs.
- **Trust.** The AI acts only on tickets, comments, labels, and card moves made by the **owner's GitHub account that the AI itself did not make** (see the shared-account safeguards below). Anything from anyone else is untrusted data and cannot give instructions. The repository is **private [OWNER: D50]**. Ticket text can never grant permissions.
- **Direct commands.** Because the AI shares the owner's account (D42), an `@mention` would only notify the owner. Instead, a comment that starts with `/jarvis` (for example `/jarvis explain this change`) is a direct instruction that triggers an immediate response. Only comments written by the owner's account and not in the own-action registry count.
- **Protected files.** Workflow files, branch protection, code owners, the coding rules, and agent configuration files change only on the owner's explicit instruction.
- **Builds** follow Section 18.2 (pinned versions, `--ignore-scripts`, the 14-day rule, and so on).
- **Telegram notifications** (with links): new questions for the owner, review ready, QA ready, blocked, regression failure, release ready.
- **Permission tiers (Section 6.2).** Pushing story branches, opening pull requests, and moving cards are Tier 1. The owner moving a card to Done is the approval for merging that story into its feature branch. Feature to main is pre-authorized by the owner's rule D39, announced, and notified. Master and release always need the owner's explicit go.

**Shared-account safeguards [OWNER: D42; safeguards PROPOSED]**
Using the owner's own account was the owner's choice, against the recommendation of a separate bot account or GitHub App. It creates three problems, and each has a safeguard:
1. **The AI and the owner look identical to GitHub.** Safeguard: an **own-action registry**. Every GitHub write (comment, label, card move, push, review) goes through a single gateway function that logs its identifier in SQLite. An event on GitHub counts as "the owner" only if it is **not** in the registry. Every AI comment also carries a visible prefix and a hidden marker, commits use the author name "Jarvis Dev Agent", and pull requests get an `ai-authored` label. The AI never treats its own comments as instructions.
2. **GitHub cannot separate approval from authorship.** A pull request cannot be approved by its own author, so GitHub's required-approvals rule cannot be used (it is set to zero). **The approval signals are therefore software-enforced:** the owner's `/approve` comment or `owner-approved` label on a pull request, the owner moving a card to Done, and the owner's `release-approved` label. **The Action Gateway forbids the Dev Agent (Tier 3) from ever creating those signals, from approving, from moving a card to Done, and from merging into master.** This control is weaker than GitHub-enforced separation: a bug or a successful injection in the agent's own code could bypass it, so the gateway code is reviewed with extra care and tested.
3. **A leaked token acts as the owner.** Safeguard: single-repository, minimal permissions, expiry, vault storage, and revocation. The kill switch (`/kill`) stops the Dev Agent, and the owner can revoke the token on GitHub at any time.

Further rules:
- **Release needs two signals:** the `release-approved` label **and** a confirmation on Telegram (a channel the AI cannot forge). Merging into master never happens on one signal.
- The Dev Agent's container holds **only this token**: no SSH keys, no browser sessions, and no other credentials of the owner.
- Branch protection includes administrators and requires status checks.
- **Optional hardening:** sign the AI's commits with a separate key so they are distinguishable.
- **Easy to change later.** All GitHub access sits behind one identity interface, so moving to a bot account or a GitHub App later changes configuration only and lets GitHub enforce approvals itself.

### 17.11 Tickets, updates log, tests, and rules **[OWNER: D40; templates PROPOSED]**
- **Concept ticket (written by the owner):** title, goal or expectation, details, how it should work, out of scope, examples, priority.
- **AI Concept response:** understanding; context used; proposed blueprint; story breakdown with acceptance criteria; risks and limitations; numbered questions, each with options and a recommendation; status.
- **AI Updates log (on every ticket):** time-stamped entries for new requirements, errors, limitations, decisions, scope changes, and progress, each saying what happened, the impact, and whether the owner's input is needed.
- **Pull request template:** summary, linked ticket, acceptance-criteria checklist, how it was tested, risks, logs or screenshots, new dependencies (exact version and publish date), data migrations, docs updated.
- **Tests at build time [OWNER: D40].** The AI writes the tests first and runs them during the build (unit, integration, and end-to-end where practical) so QA finds fewer bugs. A test report is attached to the pull request.
- **Definition of Done:** acceptance criteria met; tests written and passing; lint, type-check, and build pass; no new dependency without the owner's OK and a license check; security checklist done (permissions, secrets, untrusted input); docs and changelog updated and the documentation check passes (D57); the owner's coding rules followed; the owner's QA passed.
- **Coding rules [OWNER: D40, DEFERRED].** The owner will provide the rules for how code must be written. They are stored in the repository (for example `docs/rules/CODING_RULES.md`), **edited only by the owner**, loaded into every development context, and rank above the AI's own preferences.

### 17.12 Learning loop, priorities, and bootstrap **[PROPOSED]**
- **Learning loop.** After each ticket the AI records the lessons (review-comment patterns, bugs found in QA, the owner's preferences) in the experience graph (Section 9.4) and proposes new rules for the owner to approve. The goal is fewer review comments and fewer QA bugs over time. Metrics: review comments per pull request, QA bugs per story, rework rate, and cycle time.
- **Priorities and work in progress.** One story in active development at a time, because of model memory and heat. Short jobs come first: answering review comments and questions can pause a long build, then the build resumes. Concept analysis comes next. Long builds run when the laptop is plugged in and cool.
- **Bootstrap problem.** The board watcher and the Dev Agent must exist before the AI can work from the board. So **Phase 0b** builds a minimal Dev Agent first, specified in Claude's blueprint and built by the owner with the local AI manually in the editor. After that the AI works only through the board.
- **Initial backlog.** Claude's blueprint (Section 19.3) also supplies seed Feature and Story tickets with acceptance criteria for the board. The owner can place them in Concept to review each one, or in Ready for Dev for the foundation items.
- **Hard tasks.** The cloud step (D22, approval each time) stays available for a stuck ticket.

---

## 18. Tech Stack and Build Conventions

*In plain words: The tools and packages used, and the rules for installing them safely.*

### 18.1 Stack
| Layer | Choice |
|---|---|
| Language / runtime | Node.js 20+ and TypeScript (ESNext, strict mode), cross-platform (Windows and Linux) |
| LLM serving | Ollama or a llama.cpp server behind one provider interface (Section 7.5) |
| Search | Self-hosted SearXNG in Docker, JSON output enabled |
| Extraction | HTTP client (axios or undici), `@mozilla/readability`, `jsdom`, `cheerio` |
| State | `better-sqlite3` (sessions, tasks, logs, registry, audit) |
| Vectors | `@lancedb/lancedb` with a small local embedding model |
| Validation / config | `zod`, `dotenv` |
| Telegram | A maintained Telegram bot library, long polling **[PROPOSED]** |
| Browser | Playwright inside Docker **[OWNER: D31]** |
| Email | Gmail API / OAuth **[PROPOSED]** |
| Scheduling | In-process scheduler persisted in SQLite **[PROPOSED]** |
| Voice | Local speech-to-text, text-to-speech, wake word **[PROPOSED; VERIFY]** |
| Dev tooling | `tsx`, `typescript`, `@types/node`, `@types/jsdom` |
| Source control and board | Git, a private GitHub repository, GitHub Projects (five-column board), GitHub Actions for continuous-integration checks, a container registry **[OWNER: D37, D50]** |
| Release tooling | Version tags, software bill of materials, dependency license scan, a free release-signing key, installers for Windows and Linux, an update channel **[OWNER: D43, D52, D53]** |
| Translation | Small on-demand translation model **[OWNER: D46]** |
| Editor | VS Code with a local agent extension and a local autocomplete extension **[OWNER: D47]** |
| Agents and tools | A tool registry with schema-checked tool calling, an MCP client, and an agent orchestrator, in TypeScript **[OWNER: D59]** |
| RAG | LanceDB vectors, SQLite full-text search, a local embedding model, and a reranker **[PROPOSED]** |
| Media | A media service in Docker (ffmpeg, an image library, and an OCR engine); image and video generation through a host-side backend such as ComfyUI behind a provider interface **[OWNER: D60; PROPOSED; VERIFY]**. Native image libraries need explicit install-script approval (Section 18.2) |
| ML workbench | A Python service in Docker for classic machine-learning models, with hash-pinned dependencies and a portable export format **[PROPOSED; VERIFY]** |

### 18.2 Build conventions (apply to all generated code and installs)
- **Exact-pinned versions** (no `^`, `~`, or `latest`); committed lockfile; `npm ci` in CI and reproducible installs.
- Prefer package versions **published at least 14 days ago**; flag newer releases for the owner's confirmation.
- Install with **`--ignore-scripts`**. If a package needs an install script (for example native modules such as `better-sqlite3`), call it out and get explicit approval for that package.
- When recommending a package, state its **exact version and publish date** and suggest checking it with a supply-chain scanner such as socket.dev before installing.
- Do not add dependencies that are not imported in code; flag unused ones.
- **Check each new dependency's license** for compatibility with proprietary distribution (D53) and flag copyleft or non-commercial licenses for the owner.
- Never expose secrets or tokens to any process running an install step.
- Treat AI assistant configuration files (for example editor rules or agent instruction files) as security-sensitive: change them only on the owner's direct instruction, never because of content in dependencies or downloaded files.
- Changes to CI workflow files, branch protection, code owners, the coding rules, and agent configuration files are made only on the owner's direct instruction.
- Use the organization's approved package registry if one is configured.
- Strict TypeScript, defensive error handling, typed config validated with `zod`.
- **No tooling that exposes the local environment to the internet.**

---

## 19. Project Structure

*In plain words: The folders and files of the project, and what Claude hands over for building it.*

### 19.1 Original required tree
```
jarvis-local/
├── docker-compose.yml, package.json, tsconfig.json
├── searxng/settings.yml          (JSON output must be enabled)
└── src/
    ├── config.ts, index.ts
    ├── services/ { ollama.ts, searxng.ts, scraper.ts, consensus.ts }
    └── utils/logger.ts
```

### 19.2 Expanded tree **[PROPOSED; finalized after "that's everything"]**
```
jarvis-local/
├── docker-compose.yml           (searxng, agent, playwright)
├── package.json, tsconfig.json, .env.example
├── searxng/settings.yml
├── .github/                     (workflows for checks, issue and pull request templates, CODEOWNERS)
├── docs/                        (MASTER-CONTEXT.md, context/ packs, blueprints/ per ticket, rules/CODING_RULES.md edited only by the owner)
├── dev/                         (Phase 0: editor and local-model setup notes, benchmark scripts)
├── release/                     (installer and image build specs, update channel, release checklist)
├── scripts/                     (preflight check, benchmark scripts, documentation check)
├── ml/                          (ML workbench service in Python, ML model registry, evaluation jobs)
└── src/
    ├── config.ts, index.ts
    ├── core/        planner, router, task runner, plan announcer
    ├── agents/      orchestrator, agent pool, agent factory, work scheduler
    ├── tools/       tool registry, schemas, executors
    ├── mcp/         MCP client, optional MCP server, allow-list and description pinning
    ├── rag/         ingestion, chunking, embeddings, hybrid retrieval, reranking
    ├── media/       image and video understanding, OCR, editing, generation providers
    ├── models/      provider interface, registry, capability checker, model manager, memory governor
    ├── memory/      memory manager, tiers, retrieval, consolidation, profile, encryption
    ├── sessions/    session manager, task tracker, auto-router, isolation layer
    ├── skills/      loader, generator, sandbox tester, built-in skills
    ├── services/    ollama, searxng, scraper, consensus, email, telegram, voice
    ├── browser/     Playwright controller, page distiller, saved macros
    ├── gateway/     action gateway, permission engine, host bridge, phone bridge, audit log
    ├── scheduler/   watchers, routines, task queue
    ├── devagent/    board watcher, ticket analyzer, concept writer, story runner, pull request and review handler, release handler
    ├── learning/    experience recorder, connection graph, reinforcement and decay, reflex compiler
    ├── cost/        cost ledger, quality gates, routing policy, evaluation harness
    └── utils/       logger, secrets, token counter
```

### 19.3 Implementation Blueprint (the code deliverable) **[OWNER: D35; contents PROPOSED]**
Decision: **Claude writes everything the blueprint needs; the owner's local AI builds the code entirely.** So the build deliverable is a blueprint that a local model of roughly 30B class can follow reliably:
1. **The final design document** (this document, finalized after "that's everything").
2. **Per-module specifications:** purpose, public interfaces (TypeScript types), data schemas (SQLite tables, vector schemas), configuration, algorithms in pseudocode, prompts and templates, error handling, and logging.
3. **Task list:** small, ordered, independently testable build tasks with dependencies, each sized to fit the local model's context window, each with a definition of done.
4. **Tests and acceptance criteria** written first for every task, plus a seed evaluation set (Section 16.2).
5. **Builder guide for the local AI:** how to read the blueprint, the build conventions (Section 18.2), what it must never do (permissions, installs, configuration files), how to record what it learns (Section 9.4), and when to stop and ask the owner.
6. **Phase 0 setup specifications:** benchmark, editor and local-model setup, Docker, SearXNG configuration.
7. **Reference code [OWNER: D48, answered "all"].** **Complete reference code for as many modules as practical**, starting with the riskiest (permission engine, Action Gateway, own-action registry, encryption, consensus scoring), followed by the rest. **Delivery [PROPOSED]:** in stages by roadmap phase so each part can be checked, starting with Phases 0 and 0b. **Honest limits:** Claude writes this code without running it on the owner's hardware (GPU backends, Telegram, Gmail, Docker) and without being able to verify package versions here, so every module still passes through the board workflow (tests, review, QA) and the local AI adapts it to the real environment and the benchmark results.
8. **Seed backlog:** Feature and Story tickets with acceptance criteria, ready to import into the GitHub board (Section 17.12), plus the specification of the minimal Dev Agent for Phase 0b.
9. **Context packs and builder guide (D56):** the master document split into small, self-contained packs, a machine-readable decision index, and a short builder guide, so a local model with a limited context window can work from them (Section 22.4).
10. **Preflight check and readiness test:** a script that verifies the prerequisites (Section 22.2) and a smoke test of the local AI (Section 22.5).
11. **Documentation consistency check (D57):** a script in `scripts/` that fails if any section reference, decision ID, requirement ID, or prerequisite ID does not resolve; it runs before any documentation change merges.

---

## 20. Original Spec Baseline and Known Issues

*In plain words: What the original document said, and which parts were wrong or have changed.*

**Original baseline (kept for traceability)**
- **Target:** privacy-first local research agent for the Flow Z13; Node.js 20+ and TypeScript; Ollama with Qwen2.5-7B / 14B; SearXNG; Readability and Cheerio scraping; SQLite and LanceDB.
- **Starter code:** `package.json` (ESM, scripts `build`, `start`, `dev`; dependencies `@mozilla/readability`, `axios`, `cheerio`, `dotenv`, `jsdom`, `ollama`, `zod`; dev dependencies `@types/jsdom`, `@types/node`, `tsx`, `typescript`); `docker-compose.yml` for `searxng/searxng` with dropped capabilities; `src/index.ts` with a five-step flow (intent routing, search, scrape, consensus, grounded streamed synthesis with `[Domain/Source]` citations).
- **Original checklist:** install Ollama and pull a model; create the folder structure; create `searxng/settings.yml` with JSON enabled; start SearXNG; verify with `curl "http://localhost:8080/search?q=test&format=json"`; implement the four services; build; test with a comparison query; verify thermal and RAM behavior; verify attribution and handling of sites that block requests.

**Known issues to fix in the build**
1. `docker-compose.yml` was malformed (stray character, broken YAML indentation); SearXNG needs `settings.yml` with JSON output or it returns 403.
2. `src/index.ts` had template strings missing backticks and called undefined methods (`checkIfFactualQuery`, `streamResponse`, `chat`).
3. `package.json` lacked `better-sqlite3`, `@lancedb/lancedb`, and an embedding model.
4. The **6-8 GB VRAM assumption is wrong** for this machine (unified memory); the spec also said LPDDR5 but the memory is LPDDR5X-8000. GPU backend support must be benchmarked (Sections 4 and 7.5).
5. The consensus engine was only sketched; it needs a concrete design (Section 10).
6. Dependencies were not pinned (Section 18.2).
7. "Max 3 search iterations" had no re-query strategy.
8. The original design had no permission model, memory architecture, session isolation, or sandbox boundary; these are specified in Sections 6, 8, and 11.

---

## 21. Roadmap **[PROPOSED]**

*In plain words: The order in which things get built.*

| Phase | Goal | Contents |
|---|---|---|
| 0 | Workstation and coding setup | Raise the GPU memory share; install inference backends; run the benchmark (Section 7.5); choose models; set up VS Code with local agent and autocomplete (Section 17); Docker; start the evaluation set |
| 0b | Development workflow bootstrap | Git repository, protected branches, board and templates, the limited GitHub token, CI checks, and a minimal Dev Agent (board watcher, concept writer, pull request handler), built first with manual help in the editor; afterwards the AI works only through the board (Section 17.6 to 17.12) |
| 1 | Core and research skill | Config, logger, provider interface, SearXNG, scraper, consensus engine, synthesis, CLI; the original deliverables, corrected |
| 2 | Memory, sessions, Telegram, safety | Memory manager and tiers, session and task manager, Telegram bot, Action Gateway, permission engine, audit log, kill switch |
| 3 | Orchestration and quality | Model registry, capability checker, memory governor, cascade, cost ledger, evaluation harness; image understanding and OCR (Section 5.10) |
| 4 | Email and browser | Gmail watcher with Telegram summaries and approvals; Playwright automation with logged-in profile |
| 5 | Laptop, phone, voice, media | Host bridge and screen control; Android and iPhone bridges; local voice; video understanding, image editing and generation, and experimental short video generation (Section 5.10) |
| 6 | Self-extension and learning | Skill generation with sandbox testing; owner style and work profile; experience graph and reflex compiler (Section 9.4); consolidation; routing learned from outcomes |
| 7 | Release and distribution | Release pipeline (Section 17.8): Docker images, Windows and Linux installers, the auto-update channel with backup and rollback, and the multi-user release package. A minimal release flow exists from Phase 0b; this phase completes it |
| 8 | Model adaptation (later) | Owner-approved training sets, adapter training, A/B evaluation against the baseline, versioned and reversible adapters (Section 9.5). Starts only after the system is stable |

**Where the agent abilities land (D59):** tool calling and the first RAG engine arrive in Phases 1 and 2; the MCP client and the multi-agent orchestrator in Phase 3; the agent factory, the ML workbench, and the first adaptive loops in Phase 6; model retraining stays in Phase 8.

**Blueprint first [OWNER: D35].** These phases are the build order the blueprint will describe; the owner's local AI implements them one task at a time.

---

## 22. Prerequisites and Handover to the Local AI

*In plain words: What you must prepare before your local AI can start, and what Claude delivers.*

**Purpose.** What must be in place before this document can be given to the local AI so that it can start working. The prerequisites are grouped into three **gates**. Nothing in Gate 0 requires any Jarvis code.

### 22.1 The gates
| Gate | Meaning | Unlocks |
|---|---|---|
| **Gate 0** | The workstation, tools, accounts, and repository are ready, and the local AI passes the readiness test | Phase 0 (benchmarks, editor setup) and Phase 0b (the minimal Dev Agent), built by the owner with the local AI in the editor |
| **Gate 1** | The board-driven workflow works and the first model lanes are chosen by benchmark | Phase 1 (core and research skill), now built through the board |
| **Gate 2** | Production accounts and devices are connected | Phases 2 to 7 (memory, Telegram, email, browser, laptop, phone, voice, release); Phase 8 (model retraining) comes later, once the system is stable |

### 22.2 Gate 0: The Step-by-Step Execution Checklist & Status

*Merged from `jarvis-gate0-checklist.md` as the single authoritative execution plan for Gate 0.*
**Goal:** Prepare the laptop, tools, accounts, and repository so that local AI development can begin. No Jarvis application code is written until Gate 0 is satisfied.

#### Three Safety Rules for Every Step
1. **Never paste a token, password, or recovery code into a chat, an email, a screenshot, or a file inside the project.** Tokens go only into Windows Credential Manager (P11 and P12).
2. **Turn on two-step verification** on GitHub, Telegram, and Google before creating anything else.
3. **Install only from the official site** of each tool, and record the exact version. Pick versions released at least 14 days ago.

---

#### Step 0: Decide the GitHub Plan (D63)
- [x] **Chosen Option: Personal Private Repository** (`https://github.com/aery1803/jarvis.git`).
  - Direct ownership under the owner's personal GitHub account (`aery1803`).
  - Native GitHub branch protection on private repositories is skipped (free tier); branch protection is enforced by Jarvis's internal Action Gateway guarding `main` and `master`.
  - Can be transferred to an Organization at any time in 1 click if desired.

---

#### Part A: The Laptop (P1 to P5)

##### P1. Back up the laptop
- [x] **Status:** Skipped by owner decision for Gate 0. (Can be created anytime via `sysdm.cpl ,4`).

##### P2. Update Windows, the BIOS, and the graphics driver
- [x] **Status: VERIFIED & COMPLETED**
  - **Windows OS:** Windows 11 Home Single Language, Version `26H2`, Build `26300.0`.
  - **BIOS:** `GZ302EA.314`.
  - **AMD Graphics Driver:** `32.0.31041.1004` (AMD Software: Adrenalin Edition for Radeon 8060S).

##### P3. Raise the GPU memory (Dedicated VRAM allocation)
- [x] **Status: VERIFIED & COMPLETED**
  - Total Unified Physical RAM: **64 GB LPDDR5X-8000**.
  - OS Allocation: **31.65 GB** available to Windows (doubled from 15.65 GB; completely resolves host memory pressure).
  - Dedicated GPU / UMA Frame Buffer: **32 GB** hardware setting.
  - Direct hardware test via `llama.cpp` Vulkan confirms: `Vulkan0: AMD Radeon(TM) 8060S Graphics (48,971 MiB total, 46,523 MiB free)`! Perfect 50/50 balance between host and AI models.

##### P4. Free up disk space
- [x] **Status: VERIFIED & COMPLETED**
  - Target: At least 250 GB free on `C:`.
  - Actual: **640.2 GB free** on `C:` (NVMe 1 TB).

##### P5. Set the high-performance power mode
- [x] **Status: VERIFIED & COMPLETED**
  - Laptop plugged in on original AC charger.
  - Armoury Crate profile: Performance/Turbo.
  - Windows Power Mode: Best Performance.

---

#### Part B: Tools (P6 and P7)

##### P6. Install the toolchain
- [x] **Status: VERIFIED & COMPLETED**
  - **Git for Windows:** `2.56.0.windows.2` (configured user: Avinav Aery <aery1803@gmail.com>).
  - **Node.js:** `v26.10.0` | **npm:** `12.2.0`.
  - **Docker Desktop:** `Docker version 29.8.2, build 7fc2dff` (WSL 2 backend).
  - **VS Code:** `1.141.0`.
  - **GitHub CLI (`gh`):** `2.102.0` (installed in `C:\Program Files\GitHub CLI\gh.exe`).

##### P7. Install the two local AI engines (for benchmark)
- [x] **Status: VERIFIED & COMPLETED**
  - **Ollama:** `0.40.4` running on host.
  - **llama.cpp (Vulkan backend):** Official release `b11272` (commit `7fee17846`, Vulkan x64) installed in `C:\tools\llama.cpp`. Device initialization verified: `Vulkan0` active with 54,305 MiB free VRAM.

---

#### Part C: GitHub Setup (P8 to P11)

##### P8. Repository and branches
- [x] **Status: VERIFIED & COMPLETED**
  - Remote repository: `https://github.com/aery1803/jarvis.git` (Private).
  - Branches created and pushed: `main` (default) and `master`.

##### P9. Branch protection
- [x] **Status: SKIPPED (Free plan)**
  - Guarded by Jarvis Action Gateway instead of GitHub web UI branch protection ruleset.

##### P10. The board, its fields, and the nine labels
- [x] **Status: VERIFIED & COMPLETED**
  - **Project Board:** `Jarvis` (URL: `https://github.com/users/aery1803/projects/2`, Project ID: `PVT_kwHOBShJEs4Bm-d2`).
  - **Linked Repository:** `aery1803/jarvis`.
  - **Status Columns (exact 5 in order):** `Concept`, `Ready for Dev`, `Code Review`, `QA`, `Done`.
  - **Single-select Type Field:** `Ticket Type` with options: `Feature`, `Story`, `Bug`.
  - **Nine Repository Labels:** Created and verified on `aery1803/jarvis` (`concept-complete`, `ai-working`, `needs-owner`, `blocked`, `bug`, `release-approved`, `ai-proposed`, `ai-authored`, `owner-approved`).

##### P11. The limited token (Windows Credential Manager)
- [x] **Status: VERIFIED & COMPLETED**
  - Personal Access Token created on GitHub with `repo` and `project` permissions.
  - Stored securely in Windows Credential Manager under target `jarvis-github` (user: `token`).
  - No secret committed to repository or exposed in logs.

---

#### Part D: Telegram and Test Gmail (P12 and P13)

##### P12. Telegram bots and your user ID
- [x] **Status: VERIFIED & COMPLETED**
  - Dev and QA bots created via @BotFather.
  - Tokens stored securely in Windows Credential Manager under `jarvis-telegram-dev` and `jarvis-telegram-qa`.
  - Numeric Telegram User ID identified and retained in local secure environment. No tokens exposed in repo.

##### P13. Gmail account (for email watcher and actions)
- [x] **Status: VERIFIED & COMPLETED**
  - Owner decided to use primary Gmail (`aery1803@gmail.com`).
  - Governed strictly by Decision D21 and Principle 5: Jarvis may read, summarize, and draft replies locally, but can **never send an email without explicit approval on Telegram each time**.
  - OAuth credentials and token storage will be established in Phase 4 outside git. Address recorded.

---

#### Part E: Editor and Models (P14 and P15)

##### P14. VS Code extensions
- [x] **Status: SPECIFIED & READY TO INSTALL**
  - Specified in `docs/specs/PHASE_0_SPEC.md`: Roo Code / Cline (local OpenAI compatible / Ollama) and Continue.dev autocomplete.
  - Telemetry disabled in `.vscode/settings.json`.

##### P15. Model roster (for Phase 0 benchmark)
- [x] **Status: SPECIFIED & SHORTLISTED**
  - Defined in `docs/specs/PHASE_0_SPEC.md`: Primary and alternate candidate pairs established across all 5 lanes (Qwen2.5-Coder-32B, Mistral-Small-24B, Qwen2.5-7B, Llama-3.1-8B, Qwen2.5-Coder-1.5B, nomic-embed-text, Qwen2-VL-7B). All sized for the 46.5 GB free Vulkan VRAM pool.

---

#### Part F: Rules and Housekeeping (P16 to P18)

##### P16. Coding rules
- [x] **Status: VERIFIED & COMPLETED**
  - Standard engineering rules defined in `docs/rules/CODING_RULES.md` (covering living context, TDD, zero-secrets hygiene, taint tracking, Action Gateway tiers, dependency discipline, and commit conventions).

##### P17. Secrets hygiene
- [x] **Status: VERIFIED & COMPLETED**
  - Comprehensive `.gitignore` created blocking credentials, `.env` files, model weights (`*.gguf`), databases, caches, and runtime data.
  - Secrets storage designated strictly in Windows Credential Manager and `%USERPROFILE%\.jarvis\settings.env`.
  - Verified via `git status` that no secret is tracked.

##### P18. The project folder
- [x] **Status: VERIFIED & COMPLETED**
  - Path: `c:\Users\aery1\Files\Projects\jarvis` on the fast internal NVMe SSD (outside OneDrive and cloud sync).

---

#### Gate 0 Live Status Report (Audited on Host)
```
Step 0 GitHub choice: Personal Private Repository (Option 2 equivalent)
P1 backup done: Skipped by owner decision
P2 versions: Windows 11 26H2 (26300) | BIOS GZ302EA.314 | AMD driver 32.0.31041.1004
P3 dedicated GPU memory now shows: ~46.5 GB free in Vulkan (31.65 GB to Windows OS)
P4 free disk space: 640.2 GB free on C:
P5 power settings used: Armoury Crate Performance/Turbo, Windows Best Performance (AC plugged in)
P6 versions: git 2.56.0 | node v26.10.0 | npm 12.2.0 | docker 29.8.2 | code 1.141.0 | gh 2.102.0
P7 Ollama runs: Yes (v0.40.4) | llama.cpp Vulkan runs: Yes (b11272, 54,305 MiB free on Radeon 8060S)
P8 organization and repository names: aery1803/jarvis (Private)
P8 branches main and master exist: Yes (both active and synchronized on origin)
P9 branch protection: Skipped (free plan; guarded by Jarvis Action Gateway)
P10 board has the five columns, Type field, nine labels: Yes (Board #2 created, linked to repo, 5 columns & 9 labels active)
P11 token created, stored in Credential Manager: Yes (target jarvis-github)
P12 two bots created, numeric Telegram ID: Yes (stored in Credential Manager and local secure env)
P13 test Gmail address: aery1803@gmail.com (owner primary Gmail chosen; governed by D21 approval gates)
P14 extensions and versions: Done (docs/specs/PHASE_0_SPEC.md: Roo Code/Cline + Continue FIM)
P15 model roster note done: Done (docs/specs/PHASE_0_SPEC.md: Qwen2.5 32B/7B/1.5B, Mistral, nomic-embed, Qwen2-VL)
P16 coding rules: Done (docs/rules/CODING_RULES.md established)
P17 secrets locations decided: Done (Credential Manager + %USERPROFILE%\.jarvis\settings.env + .gitignore verified)
P18 project folder path: c:\Users\aery1\Files\Projects\jarvis
```

### 22.3 What Claude delivers before the local AI starts (the handover package)
Delivered in stages (D48); each stage is checked on the board before the next begins.
1. **Final design document** (this document) and its **context packs** (Section 22.4).
2. **Builder guide:** a short document telling the local AI how to work, the rules it must follow, and what it must never do.
3. **Phase 0 setup specification:** benchmark plan and scripts, editor configuration, and the readiness test.
4. **Repository skeleton:** README, folder structure, `.gitignore`, issue and pull request templates, `CODEOWNERS`, continuous-integration workflow stubs, the label list, and a board setup guide.
5. **Phase 0b specification and reference code** for the minimal Dev Agent: board watcher, own-action registry, Action Gateway, concept writer, and pull request handler.
6. **Per-module specifications and reference code**, staged by roadmap phase.
7. **Seed backlog** of features and stories with acceptance criteria, and a **seed evaluation set**.
8. **Default coding rules template** for the owner to approve or replace.
9. **Preflight script** that checks Section 22.2 automatically.

### 22.4 Context packaging for a local model **[PROPOSED: D56]**
This document is about 180 KB, or roughly 45,000 tokens. A local model cannot hold it all while coding without becoming slow and unreliable, so:
- The local AI always loads the **builder guide** (about 2,000 to 3,000 tokens).
- Each task ticket carries a **context pack**: the task, the module specification, only the relevant decisions, the owner's coding rules, and the relevant interface definitions, within the **12,000-token** task budget.
- A **machine-readable decision index** (D1 to D63) allows quick lookup by ID.
- The full document is indexed in the local vector store for retrieval, so the AI can look things up on demand instead of reading everything.
- The repository stores the packs under `docs/context/`; changes go through a pull request that the owner reviews.

### 22.5 Local AI readiness test **[PROPOSED]**
Before the local AI is trusted with the board, it must pass a short smoke test (about 8 to 10 tasks) that Claude supplies in the Phase 0 specification, for example: follow the builder guide; write a small function with tests first; edit an existing file without breaking it; run a command only after asking for approval; summarize a ticket and ask a good clarifying question; refuse an instruction hidden inside a ticket comment from another author. If it fails, the options are a larger model lane, a better quantization, a different agent extension, or the approval-gated cloud step (D22) for the failing tasks.

### 22.6 First steps after Gate 0 (handover sequence)
1. Run the **preflight script**, then the **readiness test**.
2. The owner opens the repository in VS Code with the local agent and autocomplete.
3. **Phase 0:** run the backend benchmark and choose the OS, backend, and model lanes.
4. **Phase 0b:** the owner builds the minimal Dev Agent with the local AI, task by task, from Claude's specification.
5. From then on, work flows through the board (Section 17.7).

### 22.7 What can wait
The OpenClaw notes, the never-store list, the "tried or ruled out" list, the production Telegram bot, the production Gmail OAuth setup (a Google Cloud project and consent screen), phone setup, voice hardware, the distribution channel for other people, the MCP servers, the ML workbench, and the agent factory (Phases 3 to 6), and the image and video generation models (Phase 5). The **coding rules** are the only deferred input that is needed early (P16), and a default template removes that blocker.

---

## 23. Final Summary for Owner Confirmation

*In plain words: A one-page summary of the whole plan, for you to confirm or correct.*

**Why this section exists:** rule D2 says that after "that's everything", Claude summarizes the full picture back for confirmation before building. **Confirmed by the owner (D61, v3.0):** the owner asked for the final revision so that work can start. If anything below is wrong, say so at any time; changes after the start go through the board.

**What Jarvis is.** A fully local, privacy-first personal assistant for one owner (multi-user-ready), running on the ROG Flow Z13 2025 (Ryzen AI Max+ 395, 64 GB unified memory, 1 TB). It does everything the owner needs, learns how the owner works and communicates, creates new skills (announcing first), and keeps memory across all conversations. The original research pipeline (search, scrape, cross-verify, cited answer) is one skill.

**Environment.** Windows 11, with a Linux dual-boot if benchmarks show it is faster for local inference. The agent runs in Docker only if that costs no result quality; inference runs on the host GPU. No public exposure of any kind.

**Safety.** Permission tiers; the owner sets approval rules per skill; announce before acting; untrusted content is only data; audit log; kill switch. Email: read, summarize, draft, and send only after approval each time. Cloud models only for very hard tasks, with approval each time. Payments, transfers, purchases, and social posts always need approval.

**Models.** Local-first, mostly quantized, English-only main models plus an on-demand translation model; MoE-class models suit the machine; tiered lanes and a memory governor; backend chosen by benchmark; a roster of several strong open models (Qwen and others) with an alternate in every lane, while Kimi's flagship and Claude Sonnet are cloud-only and need approval each time. Layer pruning is not in version 1; retraining weights on owner-approved data may come later.

**Memory and learning.** Tiered memory with a procedural "muscle memory" graph; only sensitive items encrypted; sessions isolated per task with a shared profile of the owner; accuracy target of 90% or more, measured by automatic tests plus the owner's feedback; confidence labels on facts, and always an answer.

**Images and video.** Jarvis understands and reads shared images and video (albums included), builds context from them, edits them with plain tools first and models when needed, and generates images and short video clips when required; generation is confirmed to run on this chip, with video slow and optional; content inside media is untrusted, people are not identified by face by default, and fixed limits apply to what Jarvis will create.

**Agent platform.** Tool calling with validated tools; MCP for approved outside tools, local only; a RAG engine with sources; a multi-agent system so several works run together within hardware limits; an agent factory; a machine-learning workbench; adaptive learning loops with guardrails. "AGI" is a direction measured by breadth and reliability, not a promised feature.

**Interfaces and automation.** Telegram for everything (auto-routing between tasks); voice in all modes, processed locally; Playwright for browser tasks on Google services, work tools, social media, and banking/shopping (read-only by default); laptop control including full screen control; Android-first phone control with a reduced iPhone set; Gmail summaries with action buttons.

**How it gets built.** Claude writes the complete blueprint with reference code, delivered in stages; the owner's local AI builds it in VS Code with a local agent and autocomplete. The project runs as a real software project in a private GitHub repository using the owner's account with safeguards: a five-column board (Concept, Ready for Dev, Code Review, QA, Done); stories mostly written by the owner; story, feature, `main`, and `master` branches; the AI writes tests; squash for stories and a merge commit for features; automatic merge to `main` when all stories are Done; release to `master` and the global build only on the owner's explicit go.

**Release.** Docker images, Windows and Linux installers, automatic updates on the owner's devices, and a release other people can install later; proprietary license; no paid Windows signing for now; distribution channel decided later.

**Still deferred by the owner:** OpenClaw likes and improvements, the never-store list, what was tried or ruled out, and the coding rules (needed early; a default template is offered).

**What happens next:** (1) the owner completes the Gate 0 checklist (Section 22.2, with `jarvis-gate0-checklist.md`); (3) Claude delivers the handover package in stages (Section 22.3), starting with the builder guide, the Phase 0 specification, the repository skeleton, and the Phase 0b Dev Agent.

---

## 24. Open and Deferred Items

*In plain words: What is still open or deferred, and what will be designed later.*

### 24.1 Deferred by the owner (none of these blocks the start)
| # | Item | What is needed | Needed by | Until then |
|---|---|---|---|---|
| 1 | **OpenClaw** | The owner types what they like and what they would improve | Any time; best before the skills are designed | Nothing is assumed about OpenClaw's features |
| 2 | **Never-store list** | The owner decides what Jarvis must never keep in memory | Before the memory phase (Phase 2) | The cautious default in Section 8.3 applies |
| 3 | **Tried or ruled out** | Anything the owner has already tried or rejected | Any time | Nothing is excluded |
| 4 | **Coding rules** | The owner writes `docs/rules/CODING_RULES.md`, or approves Claude's default template | **Gate 0 (prerequisite P16)** | A default template removes the blocker |

### 24.2 Decisions the owner postponed on purpose (already planned for)
- How other people receive Jarvis: invite-only or public. The release pipeline supports both (D51).
- A paid Windows code-signing certificate: skipped for now (D52); reconsider before public distribution.
- A separate bot account or GitHub App instead of the owner's own account: possible later without redesign (D42).
- Whether to ship SearXNG inside releases for other people (it is AGPL-licensed): decide before any distribution (Section 17.8).
- A Linux dual-boot: only if the benchmark shows it is faster (D17).
- Layer pruning of models: not in version 1 (Section 7.3).
- A Version 1 scope and an encrypted backup plan: offered and declined for now (D62). Claude's advice stands: start with a small first slice and plan encrypted backups of Jarvis's memory, audit log, and settings. Either can be added later as a Concept ticket.
- The GitHub plan (paid or free) for the organization: chosen at setup (D63).
- Model retraining: a later phase (D49, Section 9.5).

### 24.3 To be designed at build time (by Claude's blueprint and the benchmark)
The consensus algorithm; the choice of vision, OCR, image, and video models and of the generation backend; the concurrency limits (model slots and agent counts) from the benchmark; the tool schema format; the choice of machine-learning libraries; the model shortlist and quantization levels; the inference backend and the operating system; Telegram topics support; the phone bridge mechanism; the embedding model; the GitHub Projects fields used by the board watcher; the Gmail access path; the details of the own-action registry and the Action Gateway; whether the NPU is useful.

### 24.4 Interpretations the owner can correct
- Blueprint depth "all" means the maximum: interfaces, schemas, pseudocode, tests, and complete reference code for as many modules as practical (D48).
- User stories are created both ways, mostly by the owner (D54).
- "English-only" means English-focused models plus vocabulary trimming, not deleting layers (Section 7.3).
- "Build globally for all users" means all four release outputs (D43).
- "Own account" for GitHub means a limited single-repository token on the owner's account, never the password (D42).
- The named models (Qwen, Kimi, Sonnet) are examples of strong model families to bring in. Only Qwen-class open models can run on this machine; Kimi's flagship and Sonnet are cloud-only (Section 7.6).
- "If one model can give a good result, the others can too" means: keep several good models so any can step in, cross-check, and reuse learned procedures (Section 7.6).
- English-only is a preference when quality is equal; the strongest open families are multilingual and are not excluded (Section 7.6).
- "AGI" is treated as a long-term direction measured by breadth and reliability, not as a deliverable (Section 5.2).
- "The same for video" means understanding, reading, and plain-tool editing are core; model-based video editing and video generation are experimental and slow (Section 5.10).
- Fixed limits on generated content (Section 5.10) are rules about creating content, not about what the owner may look up.
- "Multiple works together" means several tasks and agents progress at once within the hardware limits: waiting work in parallel, text generation sharing one model's bandwidth (Section 5.6).

### 24.5 Facts to re-verify at build time **[VERIFY]**
Current open-model names, sizes, and licenses (including which Qwen releases fit this machine and whether any small Kimi model suits it); GPU backend support for this chip on Windows and Linux; Telegram limits and bot features; the GitHub Projects API and token permissions; VS Code local-model features and the status of the Cline, Roo Code, and Continue extensions; package versions and publish dates; Gmail API access rules for Workspace accounts; Docker behavior on Windows; the ComfyUI workflows and model licenses for image and video generation; Telegram's media size limits; the current MCP protocol version, transports, and authorization rules; the backend's support for several parallel requests; portable export of trained models; legal points about licenses (ask a lawyer).

---

## 25. Interview Log and Changelog

*In plain words: How this document was put together, in order, and how it changed.*

### 25.1 What the owner provided, in order
| # | What the owner provided | Key content | Recorded in |
|---|---|---|---|
| 0 | The original specification | Architecture, hardware profile, stack, requirements A to E, deliverable tree, starter code, checklist | 4, 6, 10, 19, 20 |
| 1 | First replies | Wants both a design document and code; information in pieces; the document must carry full context into new chats | 0, D1 to D3 |
| 2 | Vision message | OpenClaw-like but more advanced; Iron Man's Jarvis; does everything; learns the owner; creates skills and announces them; safe environment; laptop and phone automation like Comet; email summaries over Telegram; a master model that picks and loads models; memory across all chats; self-learning | 1, 2, 6 to 9, 11, 13 |
| 3 | Requirements message | Full use of 64 GB and 1 TB; unrestricted information; everything from Telegram; separate sessions with shared knowledge of the person; browser automation; quality before cost | 2, 7, 11, 12, 15, 16 |
| 4 | Hardware confirmation | ROG Flow Z13 2025; GPU memory at default | 4, 7 |
| 5 | The 18-question interview | Operating system; isolation; phones; laptop scope; Gmail and its permissions; cloud policy; per-skill approvals; voice; users; auto-routing; selective encryption; accuracy measurement; confidence labels; logged-in browsing; Playwright; three items deferred | D17 to D31, 24 |
| 6 | Coding and efficiency demands | Build Jarvis with the local AI in VS Code or Cursor with an agent and autocomplete; quantized English-only lean models and efficient memory; rewrite the whole document | 7.3, 17, D32, D33, D34 |
| 7 | Blueprint and muscle-memory message | Claude writes all the blueprint; the local AI builds it; the AI forms connections for how, what, and when, like muscle memory | 9.4, 17.5, 19.3, D35, D36 |
| 8 | Development workflow message | All code on the owner's Git; a GitHub kanban board; the AI picks up tickets; stages Concept, Ready for Dev, Code Review, QA, Done; story, feature, main, and master branches; tests at build time; owner-supplied coding rules; release only on the owner's decision | 17.6 to 17.12, D37 to D41 |
| 9 | Follow-up answers on the workflow | Exactly five columns; branches named main and master; the AI uses the owner's own account; all four release outputs; test Telegram bot and test Gmail for QA; squash for stories and a merge commit for features | 17.7 to 17.10, D42 to D45 |
| 10 | Follow-up answers on the remaining items | Optional translation model; VS Code; blueprint depth "all"; retraining later on approved data; private repository; distribution decided later; no Windows signing certificate for now; proprietary license; stories created both ways and mostly by the owner (this replaced an earlier answer) | 7.3, 9.5, 17, D46 to D54 |
| 11 | "That's all" and the prerequisites request | Wants the list of prerequisites so the local AI can start, and Claude's final alterations | 22, 23, D55, D56 |
| 12 | Readability and consistency request | The document must be readable by the owner, mention everything, and have every reference match | A, 26 to 28, D57 |
| 13 | Model roster message | Good AI models such as Qwen, Kimi, and Sonnet must be downloaded so that if one gives a good result, others can too | 7.6, 9.5, 22.2, D58 |
| 14 | Agent abilities message | Adaptive ML, AGI, building AI agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system, so multiple works run together | 5.1 to 5.9, D59 |
| 15 | Images and video message | Understand shared images and make context; generate images; several images to edit and to read; the same for video | 5.10, D60 |
| 16 | Offer of a Version 1 scope and a backup plan | Declined: keep the document as it is | 24.2, D62 |
| 17 | Final revision request | "Do the final revision and update the docs so I can start working on it" | A, 22, 23, D61 |
| 18 | Gate 0 execution start | Step 0 option 2 / personal private repo; laptop audit; Vulkan acceleration verified on device; winget install GitHub CLI | 4, 7.5, 22.2, D63 |
| 19 | Single master document consolidation | Merge `jarvis-gate0-checklist.md` directly into master context; update hardware profile with live device values | 4, 22.2 |

### 25.2 Changelog
- **v0.1 to v0.4:** Created the master document from the original specification; added the expanded vision (safety, models, memory, skills, Telegram, email), the requirements for unrestricted information, sessions, browser automation, and cost-quality; confirmed the Flow Z13 2025 and replaced the VRAM assumption with unified memory.
- **v0.5 to v0.26:** Recorded the 18-question interview one answer at a time (D17 to D31); three answers deferred.
- **v1.0:** Complete rewrite into one consolidated document with a decision register, integrated sections, and a roadmap; added the local AI coding environment (Section 17), the model efficiency policy (Section 7.3), and new model lanes.
- **v1.1:** Claude writes the blueprint and the local AI builds the code (D35); the experience-learning design (Section 9.4, D36).
- **v1.2 to v1.9:** The GitHub development workflow and its decisions: stages and gates, five columns, branch names, the owner's own account with safeguards, release outputs, QA environment, merge style (D37 to D45).
- **v1.10 to v1.17:** Translation model, VS Code, blueprint depth, retraining later, private repository, distribution, signing, proprietary license (D46 to D53).
- **v1.18:** User stories created both ways (D54).
- **v2.0:** Requirements closed (D55); prerequisites, handover package, context packs, readiness test, and final summary (Sections 22 and 23; D56).
- **v2.1:** Readable and cross-checked edition (D57): start guide (Section A), document map, plain-language introductions to every section, traceability matrix (Section 26), glossary (Section 27), the owner's words (Section 28), a clean Section 24, a clean Section 25, and corrections of wording that conflicted with decisions.
- **v3.0:** Plan approved by owner (D61); GitHub ownership and branch protection constraints corrected from official GitHub documentation (D63).
- **v3.1 (Current):** Device Hardware Audit & Consolidation:
  - Audited live machine: ASUS ROG Flow Z13 (`GZ302EA_GZ302EA`), AMD Ryzen AI Max+ 395 (16C/32T), Radeon 8060S (driver `32.0.31041.1004`), BIOS `GZ302EA.314`, Windows 11 Home 26H2 (Build 26300), 640.2 GB free NVMe storage.
  - Resolved Vulkan GPU acceleration: Installed `llama.cpp` b11272 Vulkan x64 into `C:\tools\llama.cpp`; confirmed native execution on `Vulkan0: AMD Radeon(TM) 8060S Graphics` with 54,305 MiB free VRAM.
  - Linked GitHub repository (`https://github.com/aery1803/jarvis.git`), created and pushed `main` and `master` branches.
  - Installed GitHub CLI (`gh` 2.102.0) via `winget`.
  - Merged `jarvis-gate0-checklist.md` directly into Section 22.2, unifying the repository into a single master context file with live checklist tracking.

---

## 26. Traceability Matrix

*In plain words: Each thing you asked for, traced to the decisions and sections that cover it.*

Each row follows one thing the owner asked for to the decisions that settled it and to the sections that describe it. Status: **Decided** (the owner decided), **Decided, design proposed** (the owner decided; Claude proposed the details), **Deferred** (the owner will answer later).

| Owner asked for | Requirement | Decisions | Described in | Status |
|---|---|---|---|---|
| Do everything, not only search | R1 | D4 | 1, 9.3, 10 | Decided |
| Learn how the owner works and communicates | R2 | D7, D8 | 9.1, 9.2 | Decided, design proposed |
| Create new skills, and say what it will do first | R3 | D8 | 9.2 | Decided, design proposed |
| A safe environment (Docker if no quality loss) | R4 | D5, D18 | 6.1 | Decided |
| Automate the laptop and the phones like Comet | R5 | D19, D20, D30 | 12 | Decided, design proposed |
| Email summaries to Telegram with actions | R6 | D6, D21 | 13, 11.1 | Decided, design proposed |
| A master model that picks and loads models after checking specs | R7 | D9 | 7.4 | Decided, design proposed |
| Memory across all chats; context versus RAG; 90%+ accuracy; self-learning | R8 | D7, D27, D28 | 8, 16.2 | Decided, design proposed |
| Full use of the workstation | R9 | D15, D16 | 4, 7.2 | Decided, design proposed |
| No restriction on internet information | R10 | D10, D46 | 15, 7.3 | Decided |
| Everything from Telegram | R11 | D6, D11 | 11.1 | Decided |
| Separate sessions, shared knowledge of the person | R12 | D12, D25, D26 | 11.2, 11.3 | Decided, design proposed |
| Browser automation with Playwright | R13 | D13, D30, D31 | 12.1 | Decided |
| Quality before cost | R14 | D14, D22 | 16.1 | Decided |
| Build Jarvis with the local AI in VS Code, with agent and autocomplete | R15 | D32, D47 | 17.1 to 17.5 | Decided |
| Quantized, English-only, lean, memory-efficient models | R16 | D33, D46 | 7.3 | Decided with guardrails (no layer pruning in version 1) |
| Voice in every mode | R17 | D24 | 14 | Decided, design proposed |
| Rewrite the whole document | R18 | D34 | Whole document | Done |
| Claude writes the blueprint; the local AI builds the code | R19 | D1, D35, D48 | 17.5, 19.3 | Decided |
| The local AI learns by doing, like muscle memory | R20 | D36, D49 | 9.4, 9.5 | Decided, design proposed |
| Run like a real project on a GitHub kanban board | R21 | D37 to D45, D50 to D54, D63 | 17.6 to 17.12 | Decided, design proposed |
| Download good models (Qwen, Kimi, Sonnet, and others) so several can give good results | R22 | D58, D22, D33 | 7.6, 22.2 (P15) | Decided, design proposed |
| Adaptive ML, AGI, building agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system, so multiple works run together | R23 | D59, D36, D12 | 5.1 to 5.9, 8, 9.4, 11.3 | Decided, design proposed (AGI is a direction, not a deliverable) |
| Handle images and video: understand, read, make context, edit several, generate | R24 | D60, D27, D53 | 5.10, 7.2, 11.1 | Decided, design proposed (video generation experimental) |
| Operating system: Windows 11, Linux if faster | R9 | D17 | 4, 7.5 | Decided |
| Hardware is the Flow Z13 2025 | R9 | D16 | 4 | Decided |
| Cloud models only for very hard tasks, with approval | R14 | D22 | 16.1 | Decided |
| Approval rules set per skill by the owner | R3 | D23 | 6.2 | Decided, design proposed |
| Email: read, summarize, draft, send only after approval | R6 | D21 | 13 | Decided |
| Confidence labels, and always answer | R8 | D29 | 10 | Decided |
| Encrypt only sensitive memory | R8 | D27 | 8.3 | Decided, design proposed |
| One user now, others later | R12 | D25 | 11.1 | Decided |
| Release outputs, distribution, signing, license | R21 | D43, D51, D52, D53 | 17.8 | Decided |
| The prerequisites for the local AI | R19 | D55, D56 | 22 | Delivered |
| A readable, fully consistent document | R18 | D57 | A, 26, 27, 28 | Done |
| The plan is final; start working | R18 | D61, D62 | 22, 23, 24.2 | Decided |
| OpenClaw likes and improvements | R1 | None yet | 24.1 | **Deferred** |
| The never-store list | R8 | None yet | 8.3, 24.1 | **Deferred** |
| What was tried or ruled out | None | None yet | 24.1 | **Deferred** |
| The coding rules | R21 | D40 | 17.11, 22.2 (P16), 24.1 | **Deferred** (needed at Gate 0) |

---

## 27. Glossary

*In plain words: Plain meanings of the technical words.*

| Term | Plain meaning |
|---|---|
| **Action Gateway** | The only door between the sandbox and your laptop, phones, and online accounts. It checks permissions and writes the audit log. |
| **Adapter (LoRA)** | A small add-on layer trained on top of a model to teach it something, without changing the model itself. |
| **Adaptive ML** | Machine learning that keeps improving from experience, with each change measured and reversible. |
| **Agent factory** | The part of Jarvis that builds new specialist agents, with tests and approval. |
| **AGI** | Artificial general intelligence: a system matching people on almost any intellectual task. It does not exist today; for Jarvis it is a long-term direction. |
| **Audit log** | A record of everything Jarvis did, which cannot be edited by the AI. |
| **Auto-routing** | Jarvis deciding which task or session a new Telegram message belongs to. |
| **Blueprint** | The detailed plan and reference code Claude writes so that your local AI can build Jarvis. |
| **Board** | The GitHub Projects kanban board with your five columns. |
| **Builder guide** | A short document that tells the local AI how to work on this project. |
| **Closed-weight (hosted) model** | A model whose files are not released, such as Claude Sonnet. It can only be used through the provider's cloud. |
| **Context pack** | The small set of document pieces a task needs, so the local AI does not read the whole document. |
| **Cost ledger** | A running record of what each task cost in time, tokens, and heat. |
| **Dev Agent** | The role of your local AI when it builds Jarvis from the board. It never touches your real accounts. |
| **Diffusion model** | A kind of AI model that creates images or video by gradually turning noise into a picture. |
| **Docker** | A way to run programs in a sealed box so they stay separate from the rest of the computer. |
| **Draft model** | A small model that guesses the next words quickly so a larger model only has to check them, which speeds up generation (speculative decoding). |
| **Embedding** | A list of numbers that represents the meaning of a text, used for searching by meaning. |
| **Evaluation set** | A collection of your real tasks with known good answers, used to score accuracy. |
| **Feature / Story / Bug** | A feature is a big piece of wanted behavior, a story is a slice of it, a bug is something broken. |
| **Gate 0, 1, 2** | Checkpoints in the prerequisites: what must be ready before each part of the build can start. |
| **Host bridge** | The controlled connection that lets approved actions reach your laptop. |
| **Inference** | Running an AI model to get an answer. |
| **Inpainting** | Editing part of an image, for example removing an object, by having a model fill in the gap. |
| **Kill switch** | One command that stops all Jarvis activity. |
| **LanceDB** | The local database used to search by meaning. |
| **llama.cpp** | A program that runs AI models locally; an alternative to Ollama. |
| **MCP (Model Context Protocol)** | A standard way for an AI program to connect to outside tools and data. Each server must be approved, because it is third-party code. |
| **Memory governor** | The part that keeps the AI models from using more memory than the machine can spare. |
| **MoE (mixture of experts)** | A model that uses only a small part of itself for each word, so it runs fast. |
| **ML workbench** | A separate service where Jarvis trains and tests classic machine-learning models on your approved data. |
| **Multi-agent system** | Several specialist agents working at the same time under one coordinator. |
| **Muscle memory (reflex)** | A procedure Jarvis has done successfully many times and can now run as a plain script without calling an AI model. |
| **OCR** | Optical character recognition: reading the text in an image. |
| **Ollama** | A program that downloads and runs AI models locally. |
| **Open-weight model** | A model whose files are published so you can download and run it yourself, such as Qwen. The license decides what you may do with it. |
| **Own-action registry** | A list of everything the AI did on GitHub, used to tell the AI's actions apart from yours on the shared account. |
| **Playwright** | A free tool that lets a program operate a web browser. |
| **Preflight check** | A script that checks whether your machine and accounts are ready. |
| **Provider interface** | A single plug that lets Jarvis use Ollama or llama.cpp without changing its code. |
| **Quantization** | Storing a model with fewer bits per number, so it is smaller and faster with a small quality cost. |
| **RAG** | Retrieval-augmented generation: looking up relevant stored information and giving it to the model. |
| **ROCm / Vulkan** | Two ways for programs to use an AMD graphics chip. Which one is faster here is decided by the benchmark. |
| **Roster** | The set of downloaded models Jarvis can choose from, with a primary and an alternate for every lane. |
| **SearXNG** | A self-hosted search engine that asks many search engines at once. |
| **Skill** | A reusable ability of Jarvis, such as triaging email or researching a topic. |
| **Squash merge / merge commit** | Two ways to combine branches: squash turns many commits into one; a merge commit keeps the branch visible in the history. |
| **Tier 0 to 3** | The permission levels: read-only, reversible, sensitive (needs your approval), and forbidden. |
| **Taint (tracking)** | Marking content from untrusted sources so that it can never trigger a sensitive action without your approval. |
| **Tool calling** | The AI asks the program to run a tool, such as search or email, with checked arguments. |
| **Tool registry** | The list of tools Jarvis may call, with their rules. |
| **Unified memory** | One pool of RAM shared by the processor and the graphics chip. |
| **Vision-language model (VLM)** | An AI model that can look at images or video frames and talk about them. |
| **VS Code** | The code editor you chose for building Jarvis with your local AI. |
| **WSL2** | A Windows feature that runs Linux programs, used by Docker on Windows. |

---

## 28. The Owner's Requests in Their Own Words

*In plain words: Your requests in your own words, so the original intent is never lost.*

Spelling and grammar are lightly corrected; the meaning is unchanged. These are kept so that the original intent is never lost, and the local AI can look them up.

**On the vision**
> The main purpose is a similar but more advanced version of what OpenClaw does. I want my agent to work very close to what the actual Jarvis does in Iron Man. I know that was conceptual, but still very close to that. It should do everything, not only searching or fact-checking, but help me in my everyday work and understand me. It must create active skills to learn me: how I work, how I communicate. Whenever it needs a new skill to answer my question or do any work, it can handle it by itself, but it should also let me know what it is going to do.
>
> I want to build this in a very safe place, like VMware or Docker. I want to use it to automate things: if I say to do something on the laptop or my mobile, it should do it, like Comet from Perplexity does. It should know when an important new email comes and summarize it to me over Telegram from the bot, so I can take action.
>
> The master AI model should be smart enough to understand my commands and use search, choose the appropriate model for each task, check the specs to see whether it can run it, and load it in the local AI to continue my tasks. It should always have the proper context, conversation understanding, and logic for every new conversation. I do not want it to keep the conversation memory in just one chat but across all chats, used wisely to save context and token generation while still giving me enough and 90%+ accurate answers. It must have the self-learning ability from all the data and must understand which data or memory to keep in the context and which memory to send to the RAG database.

**On the workstation and the requirements**
> I want to get the full potential from my workstation and AI models, as it has 64 GB RAM and 1 TB storage. It should have access to all kinds of information and not restrict me from any kind of data and knowledge on the internet. I can access everything of my AI from Telegram.
>
> As I may run various tasks from the AI, it should maintain different sessions' data separately and not mix them up, but it must contain the knowledge of the specific person, mostly me, per Telegram user. If I give three works from Telegram, how can it track three or more different ones from the bot? That is my question; we can work on that later. For now we can assume one session per user from the bot, or we can name it with a `/command`.
>
> It must automate things by controlling the browser, using Playwright or Selenium, which seems easier and cost-efficient. It must also give better quality results with fewer costs or less budget; it can compromise on cost, but not on the result.

**On building Jarvis with the local AI and on efficient models**
> Before starting on the project, I want my code to also be built by my own local AI. So I want it to use VS Code or Cursor so it can use its own AI agent in it, and also give me code auto-completion as Cursor does.
>
> It is mostly going to use quantized models, and also use only English models, so it can save the layers for calculating and remove as many unnecessary layers as possible, so it can focus its brain on results rather than other calculations and use memory efficiently. Rewrite the whole document with the proper information we all discussed.

**On the blueprint and learning**
> Claude must write all the blueprint that is needed to write the code, then my local AI builds it entirely. That is how it is going to learn how to work. Every time my local AI does something, it should make the connections: how to do it, what to do, and when to do it. As a human grows muscle memory, or what we call neuron connections, the same way the AI should create connections whenever it does something.

**On the development workflow**
> Before starting on the code I want it to work like an actual project moves. The whole code should be on my Git, and it should have a proper kanban board from GitHub, so whenever there is a new entry or update, the AI should pick it up automatically and update everything on it.
>
> I can make columns like these. **Concept:** here I write my expectation or the new feature, with details on what I want or how it should work. The AI should pick up the ticket when I create it, read it, build the context from its memory, give its own description of what it understands, give its blueprint of how it is going to implement the feature, and ask me questions, with suggestions if it has any.
>
> **Ready for Dev:** when the concept ticket is ready from the AI, with all the questions asked by the AI and my answers given, only then can I move the ticket here. Then the AI starts work on the feature, and all updates about new requirements, errors, or limitations it writes in the ticket updates. When the implementation is done, it goes to code review.
>
> **Code Review:** I will review the code before merging the user story into the feature. We will use proper environments before merging all the code into main, as we work properly as developers, and I will tell you how to write the code and the rules. If I add comments, the AI should validate the questions and give answers, or, if it can be fixed, make the changes and resolve the comments.
>
> **QA:** I use the feature to test it. The AI should also write tests to validate the feature at build time, so that when it reaches me for QA I find fewer bugs.
>
> **Done:** then it merges into the feature branch. When all the user stories in the feature are marked Done, the feature branch merges into main. When I feel it is good to merge into master, only then is the code built globally for all users.

**On models**
> It is necessary to download good AI models like Qwen, Kimi, Sonnet, and so on, so that if one model can give a good result, the others can too.

**On the agent abilities**
> It must have the abilities of adaptive ML, AGI, building AI agents, ML models, RAG, MCP, memory, tool calling, and a multi-agent system, so I can run multiple works together.

**On images and video**
> It should handle the images I share: it should know what is in the image and make the context, and generate images when required. I can share multiple images to edit and to read things from them, and the same for video.

**On the prerequisites and this document**
> Before building the final documents, let me know what the prerequisites should be, so I can give this document to my local AI so it can start working on it. That is all; now you can make your final alteration.
>
> Mention everything in the document so that I can read it and start on it, and all the dots must match everything.
- **v2.2:** Added the model roster (Section 7.6, D58, R22): which of Qwen, Kimi, and Sonnet can actually run on this machine (Qwen yes; Kimi's flagship and Sonnet are cloud-only), roster rules (primary and alternate per lane, redundancy, second opinion, shared know-how, safe acquisition, storage), no training on hosted-model outputs (Section 9.5), an updated prerequisite P15, glossary terms, the traceability row, and the owner's words.
- **v2.3:** Added the agent platform (D59, R23): Section 5 retitled to Architecture and Agent Platform with new Sections 5.1 to 5.9 (the nine abilities; an honest statement on AGI; tool calling; MCP with its security rules; the RAG engine; the multi-agent system with scheduling limits and taint tracking; the agent factory; the ML workbench; adaptive learning loops with guardrails); new component rows, stack rows, project folders, the `/agents` command, a roadmap note, glossary terms, a traceability row, and the owner's words.
- **v2.4:** Added images and video (D60, R24): new Section 5.10 (what Jarvis does with images and video, the pipelines, the media service, the checked hardware reality, models and license cautions, safeguards), new model lanes (OCR, image generation and editing, experimental video generation), Telegram media handling, roadmap placement in Phases 3 and 5, an extended prerequisite P15, glossary terms, a traceability row, and the owner's words.
- **v3.0 (FINAL):** The owner approved the plan (D61) and declined the optional Version 1 scope and backup plan (D62). Final revision: corrected the GitHub setup from GitHub's own documentation (organization-owned repository and board; paid plan for private-repository branch protection; D63; prerequisites P8 to P11 rewritten with an order note and a plan note); reconciled the label set to all nine labels; updated the status, Section 0, Section 23, Section 24, the traceability matrix, and the interview log; added the step-by-step Gate 0 checklist file. The consistency check passes.
