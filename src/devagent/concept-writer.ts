/**
 * Jarvis Local AI Agent: Concept Writer & Ticket Formatter
 * Authority: Section 17.11 (Tickets, Updates Log, Templates)
 */

import type { ConceptPlan } from './types.js';

export interface PullRequestTemplateOptions {
  issueNumber: number;
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  testsReport: string;
  breakingChanges?: string;
}

const SAFE_ACTION_ID = /^[a-zA-Z0-9_.-]+$/;

/** Model-written text must not be able to smuggle in HTML comments such as a forged loopback marker. */
function neutralize(text: string): string {
  return text.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;');
}

export class ConceptWriter {
  /**
   * Formats the standardized AI Concept Analysis comment.
   */
  public formatConceptComment(issueNumber: number, plan: ConceptPlan, actionId: string): string {
    if (!SAFE_ACTION_ID.test(actionId)) {
      throw new Error(`Invalid action id for loopback marker: '${actionId}'`);
    }
    const storiesList = plan.proposedStories
      .map((story) => {
        const criteria = story.criteria.map((c) => `    - [ ] ${neutralize(c)}`).join('\n');
        return `  - **${neutralize(story.title)}:**\n${criteria}`;
      })
      .join('\n');

    const risksList = plan.risksAndLimitations.map((r) => `  - ${neutralize(r)}`).join('\n');

    const questionsList = plan.questions
      .map((q) => {
        const opts = neutralize(q.options.join(', '));
        return `  ${q.id}. **${neutralize(q.question)}**\n     - Options: ${opts}\n     - *(Recommendation)*: **${neutralize(q.recommendation)}**`;
      })
      .join('\n');

    return `## 🤖 Jarvis Dev Agent: Concept Analysis & Architecture Plan

### 1. Understanding & Context
${neutralize(plan.understanding)}

### 2. Proposed Story Breakdown
${storiesList}

### 3. Risks & Hardware Considerations
${risksList}

### 4. Architectural Clarifications / Questions for Owner
${questionsList}

---
*Labeling ticket with \`concept-complete\` awaiting owner review.*
<!-- jarvis-devagent:action-id:${actionId} -->`;
  }

  /**
   * Formats the Pull Request description matching docs/rules/CODING_RULES.md.
   */
  public formatPullRequestBody(options: PullRequestTemplateOptions): string {
    const criteriaList = options.acceptanceCriteria.map((c) => `- [x] ${neutralize(c)}`).join('\n');

    return `## Summary of Changes
${neutralize(options.summary)}

Closes #${options.issueNumber}

## Acceptance Criteria
${criteriaList}

## Verification & Test Results
${neutralize(options.testsReport)}

## Security & Architecture Checklist
- [x] Zero-secrets hygiene: no credentials or tokens committed.
- [x] Action Gateway tiers honored; no unauthorized state mutations.
- [x] Memory governor verified: >= 14 GB free host RAM maintained.
- [x] Living documentation updated.`;
  }
}
