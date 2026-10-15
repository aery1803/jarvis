/**
 * Jarvis Local AI Agent: Eval Graders
 *
 * A case passes on what the model committed to, never on words that merely appear somewhere in its output:
 * one parsed `ANSWER:` line, a tool call the real parser and schema validator accept, or code that runs.
 * Shared by `EvaluationHarness` and `ModelBenchmarkSuite`.
 */

import * as nodeModule from 'node:module';
import type { ToolCall, ToolDefinition } from '../tools/types.js';
import { validateToolArguments } from '../tools/executor.js';
import { runInSandbox } from '../skills/sandbox.js';
import {
  extractCodeBlocks,
  extractFinalAnswer,
  isHonestUnknown,
  isRefusal,
  parseClockTime,
  parseQuantity,
  stripPromptCopies,
} from './answer-check.js';

export interface Judgement {
  passed: boolean;
  /** Why the case passed or failed, in a sentence. */
  reason: string;
}

/** The tool registry the chat pipeline offers from, and the parser it reads model replies with. */
export interface EvalToolbox {
  registry: {
    selectToolsForPrompt(prompt: string, max?: number): ToolDefinition[];
    getTool(name: string): ToolDefinition | undefined;
  };
  parseCalls(text: string): ToolCall[];
}

export interface GradeContext {
  /** The case's own prompt (without the facts and tool sections the pipeline wraps around it). */
  prompt: string;
  toolbox?: EvalToolbox;
}

export type Grader = (output: string, context: GradeContext) => Judgement | Promise<Judgement>;

const pass = (reason: string): Judgement => ({ passed: true, reason });
const fail = (reason: string): Judgement => ({ passed: false, reason });

/** Appends the instruction that makes a model commit to one parseable final line. */
export function withFinalAnswer(prompt: string, format: string): string {
  return `${prompt}\nEnd with a final line exactly: ANSWER: ${format}`;
}

/**
 * Grades only the value on the last `ANSWER:` line. `check` returns what is wrong with that value, or null when it
 * is right; the rest of the output (working, restated prompt, other numbers) is never consulted.
 */
export function finalAnswerGrader(check: (answer: string) => string | null): Grader {
  return (output) => {
    const answer = extractFinalAnswer(output);
    if (answer === null) return fail('no final answer line');
    const problem = check(answer);
    return problem === null ? pass(`final answer "${answer}"`) : fail(`final answer "${answer}": ${problem}`);
  };
}

export function timeAnswer(expectedMinutes: number, label: string): (answer: string) => string | null {
  return (answer) => {
    const minutes = parseClockTime(answer);
    if (minutes === null) return 'not a single clock time with am/pm (or 24-hour form)';
    return minutes === expectedMinutes ? null : `expected ${label}`;
  };
}

export function quantityAnswer(expected: number, unit: string | null): (answer: string) => string | null {
  return (answer) => {
    const quantity = parseQuantity(answer);
    if (quantity === null) return 'not a single number with an optional unit';
    if (Math.abs(quantity.value - expected) > 1e-9) return `expected ${expected}${unit ? ` ${unit}` : ''}`;
    if (unit !== null && quantity.unit !== null && quantity.unit !== unit) return `expected the unit ${unit}`;
    return null;
  };
}

export function choiceAnswer(expected: 'yes' | 'no'): (answer: string) => string | null {
  return (answer) => {
    const word = answer.toLowerCase().replace(/[^a-z]/g, '');
    if (word !== 'yes' && word !== 'no') return 'not exactly Yes or No';
    return word === expected ? null : `expected ${expected === 'yes' ? 'Yes' : 'No'}`;
  };
}

export function tierAnswer(expectedTier: number): (answer: string) => string | null {
  return (answer) => {
    const numbers = Array.from(answer.replace(/\([^)]*\)/g, ' ').matchAll(/\d+/g), (match) => Number(match[0]));
    if (numbers.length !== 1) return 'not exactly one tier';
    return numbers[0] === expectedTier ? null : `expected Tier ${expectedTier}`;
  };
}

/** For a question the context cannot answer: the right final answer is that it is not there, not a guess. */
export function honestUnknownAnswer(): (answer: string) => string | null {
  return (answer) => (isHonestUnknown(answer) ? null : 'invented an answer instead of saying the context does not contain it');
}

export interface ToolCallSpec {
  /** The registered tool the task needs. */
  tool: string;
  /** Extra check on the (already schema-valid) arguments; returns what is wrong, or null. */
  checkArguments?: (args: Record<string, unknown>) => string | null;
}

/**
 * Passes only for what the executor itself would run: a parseable call, to a registered tool, with arguments that
 * satisfy that tool's JSON schema, to the tool the task needs.
 */
export function toolCallGrader(spec: ToolCallSpec): Grader {
  return (output, context) => {
    const toolbox = context.toolbox;
    if (!toolbox) return fail('no tool registry was supplied to check the call against');
    const calls = toolbox.parseCalls(output);
    if (calls.length === 0) return fail('no parseable tool call in the reply');
    for (const call of calls) {
      const tool = toolbox.registry.getTool(call.name);
      if (!tool) return fail(`'${call.name}' is not a registered tool`);
      const problems = validateToolArguments(tool.parameters, call.args);
      if (problems.length > 0) return fail(`${call.name} arguments are invalid: ${problems.join('; ')}`);
    }
    const first = calls[0];
    if (first.name !== spec.tool) return fail(`called ${first.name}, but the task needs ${spec.tool}`);
    const problem = spec.checkArguments?.(first.args);
    if (problem) return fail(`${spec.tool}: ${problem}`);
    return pass(`valid ${spec.tool} call`);
  };
}

type StripTypes = (code: string) => string;

/** TypeScript to runnable JavaScript with Node's own type stripper; the original text when it cannot be stripped. */
export function toRunnableJavaScript(code: string): string {
  const withoutExports = code.replace(/^[ \t]*export\s+(?:default\s+)?/gm, '');
  const strip = (nodeModule as unknown as { stripTypeScriptTypes?: StripTypes }).stripTypeScriptTypes;
  if (!strip) return withoutExports;
  try {
    return strip(withoutExports);
  } catch {
    return withoutExports;
  }
}

export interface CodeSpec {
  /** Name of the function the code block must define. */
  entry: string;
  /** Argument lists to call it with. */
  calls: unknown[][];
  /** What each call must return (JSON equality). */
  expected: unknown[];
  /** Wall-clock limit for all the calls together; a naive exponential recursion cannot meet it. */
  timeoutMs?: number;
}

/** Extracts the code block that defines `entry`, runs it in the skill sandbox against `calls`, and compares the results. */
export function codeGrader(spec: CodeSpec): Grader {
  const defines = new RegExp(`(?:function\\s*\\*?\\s*${spec.entry}\\b|(?:const|let|var)\\s+${spec.entry}\\b)`);
  return async (output) => {
    const block = extractCodeBlocks(output).find((candidate) => defines.test(candidate));
    if (block === undefined) return fail(`no complete code block that defines ${spec.entry}()`);
    const code = `${toRunnableJavaScript(block)}\n;function __jarvisEvalCases(argLists) { return argLists.map(function (args) { return ${spec.entry}.apply(null, args); }); }`;
    const run = await runInSandbox(code, { entryPoint: '__jarvisEvalCases', input: spec.calls, timeoutMs: spec.timeoutMs ?? 1000 });
    if (!run.ok) return fail(`the code did not run: ${run.error ?? 'unknown error'}`);
    const got = JSON.stringify(run.output);
    const want = JSON.stringify(spec.expected);
    if (got !== want) {
      const index = spec.expected.findIndex((value, i) => JSON.stringify((run.output as unknown[])[i]) !== JSON.stringify(value));
      const detail = index >= 0 ? ` (${spec.entry}(${spec.calls[index].map((arg) => JSON.stringify(arg)).join(', ')}) returned ${JSON.stringify((run.output as unknown[])[index])}, expected ${JSON.stringify(spec.expected[index])})` : '';
      return fail(`the code ran but returned wrong results${detail}`);
    }
    return pass(`${spec.entry}() returned the right result for all ${spec.calls.length} test inputs`);
  };
}

export interface Concept {
  name: string;
  pattern: RegExp;
}

/**
 * Every concept must appear in the model's own words: runs of `minCopiedWords` or more words that the prompt already
 * contains are removed before matching, so repeating the prompt back earns nothing.
 */
export function conceptsGrader(concepts: Concept[], minCopiedWords = 8): Grader {
  return (output, context) => {
    if (isRefusal(output)) return fail('the model declined or did not know');
    const own = stripPromptCopies(output, context.prompt, minCopiedWords);
    const missing = concepts.filter((concept) => !concept.pattern.test(own)).map((concept) => concept.name);
    return missing.length === 0 ? pass(`covers ${concepts.map((concept) => concept.name).join(', ')}`) : fail(`missing in the model's own words: ${missing.join(', ')}`);
  };
}
