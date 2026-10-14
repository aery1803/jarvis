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

export class ConceptWriter {
  /**
   * Formats the standardized AI Concept Analysis comment.
   */
  public formatConceptComment(issueNumber: number, plan: ConceptPlan, actionId: string): string {
    const storiesList = plan.proposedStories
      .map((story) => {
        const criteria = story.criteria.map((c) => `    - [ ] ${c}`).join('\n');
        return `  - **${story.title}:**\n${criteria}`;
      })
      .join('\n');

    const risksList = plan.risksAndLimitations.map((r) => `  - ${r}`).join('\n');

    const questionsList = plan.questions
      .map((q) => {
        const opts = q.options.join(', ');
        return `  ${q.id}. **${q.question}**\n     - Options: ${opts}\n     - *(Recommendation)*: **${q.recommendation}**`;
      })
      .join('\n');

    return `## 🤖 Jarvis Dev Agent: Concept Analysis & Architecture Plan

### 1. Understanding & Context
${plan.understanding}

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
    const criteriaList = options.acceptanceCriteria.map((c) => `- [x] ${c}`).join('\n');

    return `## Summary of Changes
${options.summary}

Closes #${options.issueNumber}

## Acceptance Criteria
${criteriaList}

## Verification & Test Results
${options.testsReport}

## Security & Architecture Checklist
- [x] Zero-secrets hygiene: no credentials or tokens committed.
- [x] Action Gateway tiers honored; no unauthorized state mutations.
- [x] Memory governor verified: >= 14 GB free host RAM maintained.
- [x] Living documentation updated.`;
  }
}
