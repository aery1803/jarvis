/**
 * Unit Tests: Concept Writer & PR Formatter
 * Authority: Section 17.11 (Tickets, Updates Log, Templates)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConceptWriter } from '../src/devagent/concept-writer.js';
import type { ConceptPlan } from '../src/devagent/types.js';

describe('ConceptWriter', () => {
  const writer = new ConceptWriter();

  test('should format an AI concept comment containing required sections and marker', () => {
    const plan: ConceptPlan = {
      understanding: 'Bootstrap minimal Dev Agent to monitor GitHub Board #2.',
      proposedStories: [
        {
          title: 'Own-Action Registry',
          criteria: ['Store actions in SQLite', 'Detect loops'],
        },
        {
          title: 'Action Gateway',
          criteria: ['Block Tier 3 actions', 'Log Tier 1 and 2'],
        },
      ],
      risksAndLimitations: ['Memory pressure on host', 'Shared account loopback'],
      questions: [
        {
          id: 1,
          question: 'Which test runner should we use?',
          options: ['node:test', 'vitest'],
          recommendation: 'node:test',
        },
      ],
    };

    const actionId = 'act-test-concept-1';
    const comment = writer.formatConceptComment(3, plan, actionId);

    // Verify sections
    assert.match(comment, /## 🤖 Jarvis Dev Agent: Concept Analysis & Architecture Plan/);
    assert.match(comment, /### 1\. Understanding & Context/);
    assert.match(comment, /Bootstrap minimal Dev Agent/);
    assert.match(comment, /### 2\. Proposed Story Breakdown/);
    assert.match(comment, /Own-Action Registry/);
    assert.match(comment, /### 3\. Risks & Hardware Considerations/);
    assert.match(comment, /### 4\. Architectural Clarifications/);
    assert.match(comment, /Which test runner should we use\?/);
    assert.ok(comment.includes('*(Recommendation)*: **node:test**'));

    // Verify invisible marker for own-action registry
    assert.match(comment, new RegExp(`<!-- jarvis-devagent:action-id:${actionId} -->`));
  });

  test('should format PR body adhering to CODING_RULES.md template', () => {
    const prBody = writer.formatPullRequestBody({
      issueNumber: 3,
      title: 'Phase 0b Minimal Dev Agent',
      summary: 'Delivers the bootstrap engine with own-action registry and board watcher.',
      acceptanceCriteria: [
        'Own-Action Registry prevents loops',
        'Action Gateway blocks Tier 3 actions',
      ],
      testsReport: '4 test suites, 16 tests passing, 0 failures',
    });

    assert.match(prBody, /## Summary of Changes/);
    assert.match(prBody, /Closes #3/);
    assert.match(prBody, /## Acceptance Criteria/);
    assert.match(prBody, /\[x\] Own-Action Registry prevents loops/);
    assert.match(prBody, /## Verification & Test Results/);
    assert.match(prBody, /4 test suites, 16 tests passing/);
  });
});
