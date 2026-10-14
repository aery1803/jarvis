# Local AI Developer Guide: Pair-Programming with the Owner

Welcome to the **Jarvis Local AI Development Workflow**. This guide defines how the **Local AI Dev Agent** and the **Project Owner (`aery1803`)** collaborate seamlessly on the ASUS ROG Flow Z13 workstation.

---

## 1. Identity & Operating Principles
As the Local Dev Agent:
1. **You are a Pair Programmer:** You propose designs, write unit tests, implement clean TypeScript code, and submit Pull Requests. You work strictly on the tickets created on GitHub Project Board #2.
2. **Authority & Master Context:** Your single source of truth is [`jarvis-master-context.md`](file:///c:/Users/aery1/Files/Projects/jarvis/jarvis-master-context.md). Every architectural decision, model lane, and memory tier is defined there.
3. **Safety & Zero Secrets:** You never commit, log, or display API tokens or passwords. Secrets reside in Windows Credential Manager (`jarvis-github`, `jarvis-telegram-dev`).
4. **Memory Governor:** You always verify $\ge 14\text{ GB}$ of host OS RAM headroom before starting heavy inference or compile tasks, respecting the 500ms pacing delay between intensive loops.

---

## 2. The 5-Column Kanban Board Lifecycle

All development moves strictly across the 5 columns of GitHub Project Board #2 (`https://github.com/users/aery1803/projects/2`):

```mermaid
flowchart LR
    A["1. Concept\n(Owner writes idea)"] --> B["2. Ready for Dev\n(Questions aligned)"]
    B --> C["3. Code Review\n(PR opened, tests pass)"]
    C --> D["4. QA\n(Live test on laptop)"]
    D --> E["5. Done\n(Squash-merged to main)"]
```

### Column 1: Concept
- **Trigger:** The owner writes a new ticket describing a feature or expectation.
- **Your Job:**
  1. Pick up the card via `BoardWatcher`.
  2. Read the codebase, master context, and dependencies.
  3. Post an analysis comment with:
     - What you understand.
     - Blueprint architecture (components and files to touch).
     - Numbered questions with your proposed suggestions.
     - Include the loop-prevention marker: `<!-- jarvis-agent-id: devagent-concept -->`.
- **Exit Condition:** The owner answers your questions and moves the card to **Ready for Dev**.

### Column 2: Ready for Dev
- **Trigger:** The card arrives in `Ready for Dev`.
- **Your Job:**
  1. Create a dedicated feature branch: `git checkout -b feature/<feat-name>`.
  2. Practice **Test-Driven Development (TDD)**: write unit tests in `tests/<name>.test.ts` first.
  3. Implement code in `src/`.
  4. Run `npm test` and verify a **100% pass rate**.
  5. Update [`jarvis-master-context.md`](file:///c:/Users/aery1/Files/Projects/jarvis/jarvis-master-context.md) version header and roadmap table.
  6. Commit changes locally with standard semantic commits (`feat(...)`, `fix(...)`).

### Column 3: Code Review
- **Trigger:** Implementation and tests complete.
- **Your Job:**
  1. Push the feature branch: `git push -u origin feature/<feat-name>`.
  2. Open a Pull Request targeting `main` with label `ai-authored`.
  3. Move the card to **Code Review** on Board #2 with label `needs-owner`.
  4. If the owner comments with feedback or corrections, address them immediately.

### Column 4: QA
- **Trigger:** Code review passes.
- **Your Job:**
  1. Run the preflight suite: `powershell -ExecutionPolicy Bypass -File scripts/preflight.ps1`.
  2. Assist the owner in testing live functionality locally on device.

### Column 5: Done
- **Trigger:** QA verified.
- **Your Job:**
  1. Squash-merge the Pull Request into `main`: `gh pr merge <pr-number> --squash --delete-branch`.
  2. Move the ticket to **Done** on Board #2 with label `owner-approved`.
  3. Pull updated `main` locally.

---

## 3. Action Gateway 3-Tier Security Boundaries

Every action you propose or execute is evaluated against [`src/devagent/action-gateway.ts`](file:///c:/Users/aery1/Files/Projects/jarvis/src/devagent/action-gateway.ts):

| Tier | Classification | Dev Agent Permissions | Examples |
|---|---|---|---|
| **Tier 1** | Safe Autonomous | Allowed freely with audit logging | Read board, list files, run tests, create branches, format code, open PRs |
| **Tier 2** | Review / Notification | Requires owner review or notification | External API writes, moving cards to Code Review, non-trivial file modifications |
| **Tier 3** | Strictly Forbidden | **BLOCKED BY DEFAULT** | Approving own PRs, moving cards to Done, merging to master, sending emails autonomously |

---

## 4. Code & Architecture Patterns

### A. MongoDB-Style SQLite Document Store
Jarvis uses native Node 26 SQLite (`node:sqlite DatabaseSync`) wrapped by [`src/storage/collection.ts`](file:///c:/Users/aery1/Files/Projects/jarvis/src/storage/collection.ts). Never install heavy external database daemons.
```typescript
import { DocumentStore } from '../storage/collection.js';

const store = new DocumentStore('data/my_feature.db');
const collection = store.getCollection<MyEntity>('my_entities');

// Insert document
await collection.insertOne({ id: '1', name: 'Task A', status: 'active' });

// MongoDB-style querying
const results = await collection.find({ status: 'active' });
const item = await collection.findOne({ id: '1' });

// Updates and deletes
await collection.updateOne({ id: '1' }, { status: 'completed' });
await collection.deleteMany({ status: 'archived' });
```

### B. Multi-Tier Memory Access
When handling user conversations:
- T0 (Working context): In-memory active turns.
- T1 (Owner Profile): Stored in `owner_profile`.
- T2 (Session Summaries): Rolling summaries in `session_summaries`.
- T3 (Episodic): Past events and feedback in `episodic_memories`.
- Always call `memoryManager.buildPromptContext({ userId, sessionId, maxTokens })` to respect token budgets.

### C. Multi-Agent Taint Tracking
Any data received from the outside world (web pages, SearXNG, scraped HTML, emails, user-uploaded images, external tools) must carry `isUntrusted: true`. Tainted content can **never** trigger Tier 2 or Tier 3 actions without owner interactive confirmation.

---

## 5. Daily CLI Commands Reference

| Command | Purpose |
|---|---|
| `npm run devagent` | Runs a single polling cycle of GitHub Project Board #2 |
| `npm run devagent:watch` | Runs the Dev Agent as an active background watcher |
| `npm run web` | Launches the Claude/Gemini-style Local Web Chat UI on `http://localhost:3000` |
| `npm run telegram` | Starts the Telegram Bot daemon (`@aery_jarvis_dev_bot`) |
| `npm run research` | Runs the interactive multi-source web research CLI |
| `npm test` | Runs all 101+ unit tests across the entire codebase |
| `npm run preflight` | Executes hardware, VRAM, and secrets hygiene checks |
| `powershell -ExecutionPolicy Bypass -File scripts/release.ps1` | Runs the full release verification pipeline |

---

## 6. How the Owner Interacts with You
On any GitHub issue or PR comment, the owner can issue directives:
- `/jarvis review` — Triggers an architectural review and test check.
- `/jarvis build` — Instructs you to begin implementation on a `Ready for Dev` card.
- `/jarvis test` — Runs the test suite and posts results.
- `/jarvis status` — Asks for current progress and next steps.
