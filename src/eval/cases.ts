/**
 * Jarvis Local AI Agent: Benchmark and Eval Case Definitions
 *
 * Every case gives the model what it needs (the real tool schemas, the facts it is asked about) and grades only a
 * committed answer: one `ANSWER:` line, a valid tool call, code that runs, or concepts in the model's own words.
 */

import type { EvalCaseSpec } from './case-runner.js';
import {
  choiceAnswer,
  codeGrader,
  conceptsGrader,
  finalAnswerGrader,
  honestUnknownAnswer,
  quantityAnswer,
  tierAnswer,
  timeAnswer,
  toolCallGrader,
  withFinalAnswer,
} from './graders.js';

const minutes = (hour: number, minute = 0): number => hour * 60 + minute;

/** Facts the retrieval cases are asked about; the tier table is Section 6.2 of the master context. */
export const HARDWARE_FACTS =
  '[Source 1] Jarvis host profile from the system probe: the workstation reports 31.65 GB of host RAM. Its GPU is a Radeon 8060S with a separate memory pool.';
export const TIER_FACTS =
  '[Source 2] Jarvis permission tiers. Tier 0 (read-only): search, read mail and files; allowed and logged. ' +
  'Tier 1 (reversible): draft an email, create a file; announced, then done and logged. ' +
  'Tier 2 (sensitive, irreversible or external-facing): send email, delete files, run host shell commands; the owner must approve each time. ' +
  'Tier 3 (forbidden): disabling the audit log or editing its own permission rules; never allowed and cannot be unlocked.';

export interface CaseDefinition extends EvalCaseSpec {
  category: 'reasoning' | 'coding' | 'tool_calling' | 'retrieval';
  title: string;
}

export function reasoningCases(): CaseDefinition[] {
  return [
    {
      id: 'reasoning-01-temporal',
      category: 'reasoning',
      title: 'Time & Distance Calculation',
      prompt: withFinalAnswer('A train departs at 10:30 AM and travels 180 miles at 60 mph without stopping. What time does it arrive? Show your working briefly.', '<a clock time such as 3:45 PM>'),
      grade: finalAnswerGrader(timeAnswer(minutes(13, 30), '1:30 PM')),
    },
    {
      id: 'reasoning-02-deduction',
      category: 'reasoning',
      title: 'Syllogistic Logical Deduction',
      prompt: withFinalAnswer(
        'Premise 1: All high-memory APUs use unified memory. Premise 2: The AMD Strix Halo is a high-memory APU. Does the Strix Halo use unified memory? Give a one-sentence reason.',
        '<Yes or No>'
      ),
      grade: finalAnswerGrader(choiceAnswer('yes')),
    },
    {
      id: 'reasoning-03-sequencing',
      category: 'reasoning',
      title: 'Task Sequencing & Dependencies',
      prompt: withFinalAnswer(
        'Task A takes 1 hour. Task B depends on A and takes 2 hours. Task C depends on B and takes 1 hour. If we start Task A at 8:00 AM, at what time is Task C completed? Show your working briefly.',
        '<a clock time such as 3:45 PM>'
      ),
      grade: finalAnswerGrader(timeAnswer(minutes(12), '12:00 PM')),
    },
  ];
}

export function codingCases(): CaseDefinition[] {
  return [
    {
      id: 'coding-01-algorithm',
      category: 'coding',
      title: 'TypeScript Memoized Algorithm',
      taskType: 'code',
      prompt:
        'Write a TypeScript function fibonacci(n: number): number that uses memoization to compute the nth Fibonacci number efficiently (fibonacci(0) is 0, fibonacci(1) is 1). ' +
        'Reply with exactly one fenced code block containing the function; do not call it and do not export it.',
      grade: codeGrader({
        entry: 'fibonacci',
        calls: [[0], [1], [10], [50]],
        // 50 is out of reach for the naive exponential recursion inside the sandbox's time limit.
        expected: [0, 1, 55, 12586269025],
      }),
    },
    {
      id: 'coding-02-debugging',
      category: 'coding',
      title: 'Boundary Bug Fix',
      taskType: 'code',
      prompt:
        'This function has a bug:\nfunction sum(arr: number[]): number {\n  let total = 0;\n  for (let i = 0; i <= arr.length; i++) {\n    total += arr[i];\n  }\n  return total;\n}\n' +
        'Reply with the corrected function sum in exactly one fenced code block, then one sentence naming the cause.',
      grade: codeGrader({
        entry: 'sum',
        calls: [[[1, 2, 3]], [[]], [[5]], [[-1, 1, 10.5]]],
        expected: [6, 0, 5, 10.5],
      }),
    },
    {
      id: 'coding-03-self-improvement',
      category: 'coding',
      title: 'Security Rule Formulation',
      prompt:
        'Write a one- or two-sentence security rule for an autonomous AI agent, worded as a binding requirement. ' +
        'Facts to cover: sensitive API tokens; stored in an AES-256 encrypted vault; plain text not allowed.',
      grade: conceptsGrader([
        { name: 'tokens or secrets', pattern: /\b(?:tokens?|secrets?|credentials?|keys?)\b/ },
        { name: 'a vault', pattern: /\b(?:vault|keystore|secrets? manager|key ?chain)\b/ },
        { name: 'encryption', pattern: /\b(?:encrypt\w*|aes-?256)\b/ },
        { name: 'plain text', pattern: /\b(?:plain[ -]?text|unencrypted|cleartext|clear[ -]text)\b/ },
        { name: 'a prohibition', pattern: /\b(?:never|not|no|without|rather than|instead of|prohibit\w*|forbid\w*)\b/ },
        { name: 'binding language', pattern: /\b(?:must|shall|never|required|prohibited|forbidden)\b/ },
      ]),
    },
  ];
}

export function toolCases(): CaseDefinition[] {
  return [
    {
      id: 'tool-01-system-stats',
      category: 'tool_calling',
      title: 'System Stats Tool Invocation',
      prompt: 'How much host memory does this machine have free right now?',
      offerTools: true,
      expectsOffered: 'system_stats',
      grade: toolCallGrader({ tool: 'system_stats' }),
    },
    {
      id: 'tool-02-search',
      category: 'tool_calling',
      title: 'Search Tool Parameter Schema',
      prompt: 'Search the web for "Radeon 8060S memory bandwidth" and give me the results.',
      offerTools: true,
      expectsOffered: 'web_search',
      grade: toolCallGrader({
        tool: 'web_search',
        checkArguments: (args) => {
          const query = args.query;
          if (typeof query !== 'string' || query.trim() === '') return 'the required query argument is missing';
          return /\b8060s\b/i.test(query) && /\bbandwidth\b/i.test(query) ? null : `the query "${query}" is not about the Radeon 8060S memory bandwidth`;
        },
      }),
    },
  ];
}

export function retrievalCases(): CaseDefinition[] {
  return [
    {
      id: 'retrieval-01-hardware',
      category: 'retrieval',
      title: 'Grounded Hardware Fact',
      facts: HARDWARE_FACTS,
      prompt: withFinalAnswer('According to the provided context, how many GB of host RAM does the Jarvis workstation report?', '<a number with its unit>'),
      grade: finalAnswerGrader(quantityAnswer(31.65, 'gb')),
    },
    {
      id: 'retrieval-02-security',
      category: 'retrieval',
      title: 'Grounded Permission Tier',
      facts: TIER_FACTS,
      prompt: withFinalAnswer('According to the provided context, which action tier requires the owner to approve each action?', '<the tier>'),
      grade: finalAnswerGrader(tierAnswer(2)),
    },
    {
      id: 'retrieval-03-honesty',
      category: 'retrieval',
      title: 'Honest About Missing Context',
      facts: `${HARDWARE_FACTS}\n${TIER_FACTS}`,
      prompt: withFinalAnswer(
        'According to the provided context, how many tool calls may Jarvis make in a single turn?',
        '<the answer, or that the context does not contain it>'
      ),
      grade: finalAnswerGrader(honestUnknownAnswer()),
    },
  ];
}

/** The benchmark's cases. Tool cases are included only when a tool registry is available to check them against. */
export function buildStandardCases(options: { includeTools: boolean }): CaseDefinition[] {
  return [...reasoningCases(), ...codingCases(), ...(options.includeTools ? toolCases() : []), ...retrievalCases()];
}
