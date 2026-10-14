# Jarvis: Core Coding & Engineering Rules

**File:** `docs/rules/CODING_RULES.md`  
**Applies to:** Project Owner, AI Coding Agents, and all automated pipelines.  
**Matches:** `jarvis-master-context.md` Sections 6, 17.11, 18, and Decisions D8, D14, D23, D39, D40, D45.  
**Authority:** [OWNER APPROVED]. This document is the law of code construction for the Jarvis project.

---

## 1. Living Context & Documentation Integrity (The Golden Rule)
1. **Single Source of Truth:** `jarvis-master-context.md` is the authoritative master blueprint. 
2. **Immediate Documentation:** Whenever a task is completed, an architecture change is made, or an engineering decision is settled, `jarvis-master-context.md` MUST be updated in the same pull request / commit.
3. **No Drift:** Never write code that contradicts decisions (`D1`–`D63`) without first raising a Concept ticket to update the master design.

---

## 2. Test-First Development (TDD) (Decision D40)
1. **Tests Before Code:** When developing a new feature or user story, write the interface definition and tests *first*.
2. **No Regression:** All existing tests must pass before code review.
3. **Coverage Targets:**
   - **Action Gateway & Permissions:** 100% test coverage.
   - **Tools & Parsers:** Comprehensive input validation, boundary tests, and failure-mode tests.
   - **Memory & Storage:** Explicit verification of encryption boundaries and schema migrations.

---

## 3. Absolute Secrets Hygiene (Safety Rule 1 & P17)
1. **Zero Credentials in Code:** Never hardcode tokens, passwords, API keys, private keys, or recovery phrases in code, tests, logs, or comments.
2. **Storage Boundaries:**
   - Tokens and authentication credentials live exclusively in **Windows Credential Manager** (e.g. `jarvis-github`, `jarvis-telegram-dev`).
   - Host configuration lives outside the repository directory at `%USERPROFILE%\.jarvis\settings.env`.
3. **Verification:** Always run `git status` before committing to verify that no secret, environment file, or temporary credential file is tracked.

---

## 4. Untrusted Content Stays Data (Principle 7 & Section 5.6)
1. **Strict Data Taint:** Any content retrieved from the web (SearXNG, scrapers), email (Gmail), external files, device screens, or messages from third parties is strictly **untrusted data**.
2. **No Prompt Injection Execution:** Untrusted data must never be concatenated into system prompts as instructions or allowed to trigger state-changing tools without validation.
3. **Sanitization:** Strip formatting, execute schema verification, and isolate content within clear data tags before passing to any reasoning model.

---

## 5. Action Gateway & Permission Tiers (Section 6.2 & Decision D23)
All tool executions and interactions with the outside world must route through the **Action Gateway**:
- **Tier 0 (Safe / Local Read-Only):** Deterministic calculations, memory reads, local log inspections. Allowed automatically.
- **Tier 1 (Reversible / Internal):** Scratch file creation, dry-run tool calls. Requires announcing intent before acting (Principle 4 / D8).
- **Tier 2 (State-Changing / External):** Shell commands on host, file modification outside sandbox, sending emails, browser form submissions, GitHub pull request merges, model downloads. **Requires explicit owner confirmation or explicit approved rule.**
- **Tier 3 (Core Security & Boundaries):** Permissions configuration, Action Gateway logic, kill-switch mechanisms, credential handling. **Immutable. AI can never self-modify Tier 3 rules.**

---

## 6. Zero Unapproved Dependencies (Section 18.2)
1. **Approval Required:** No new npm package, Python library, or binary dependency may be added without the project owner's explicit sign-off on a ticket.
2. **Maturity & Stability:** When approved, install only pinned, exact versions released **at least 14 days ago**. No floating versions (`^` or `~`), no unvetted bleeding-edge releases.
3. **Proprietary License Compatibility (D53):** Only use permissive open-source licenses (MIT, Apache 2.0, BSD, ISC). Never incorporate GPL/AGPL dependencies into distributable proprietary packages without architectural isolation.

---

## 7. Hardware & Thermal Awareness (Sections 4, 7.3, 7.4)
1. **Memory Budgeting:** Always preserve **at least 14–18 GB** of system RAM for Windows OS, background services, Docker, and the browser.
2. **Pre-Flight Allocation:** Check available VRAM and system memory before loading models or allocating memory-mapped buffers. Refuse loads that would force memory swapping.
3. **Thermal Pacing:** On the thin tablet chassis (Flow Z13), heavy inference and background agent loops must respect the **500ms pacing interval** to prevent thermal throttling.

---

## 8. Branching, Commits, and Pull Requests (Decisions D38, D39, D45)
1. **Protected Branches:** Never commit directly to `main` or `master`.
2. **Branch Naming:**
   - Stories: `story/<ticket-number>-<short-description>`
   - Features: `feature/<ticket-number>-<short-description>`
   - Bugfixes: `bug/<ticket-number>-<short-description>`
3. **Merge Strategy:**
   - **Stories into Feature Branch:** Always **Squash and Merge** (keeps history atomic and clean).
   - **Feature Branch into `main`:** **Merge Commit** once all stories are Done and tested.
   - **`main` into `master`:** Only released upon explicit project owner confirmation.
4. **Commit Format (Conventional Commits):**
   ```text
   <type>(<scope>): <short description>
   
   [optional body]
   ```
   Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`.

---

## 9. Code Quality & Type Safety
1. **Strict TypeScript:** Enable `strict: true`. Avoid `any`. Use strict union types and explicit interface definitions.
2. **Input Validation:** Use `zod` schemas for all incoming arguments, tool parameters, and external API responses.
3. **Explicit Error Handling:** Never swallow exceptions with empty `catch` blocks. Log structured errors with contextual metadata and error codes.
