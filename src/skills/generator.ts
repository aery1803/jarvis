import crypto from 'node:crypto';
import { DocumentStore, Collection } from '../storage/collection.js';
import type { RunSkillResult, SandboxSampleOutcome, SandboxTestResult, SkillManifest } from './types.js';
import { analyzeSkillCode, detectEntryPoint, runInSandbox } from './sandbox.js';

export { analyzeSkillCode, detectEntryPoint } from './sandbox.js';

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export interface SkillGeneratorOptions {
  /** Hosts a literal-URL `fetch` may target in static analysis. Default none. */
  allowedFetchHosts?: string[];
  /** Per-run wall-clock limit for sandbox execution. */
  sandboxTimeoutMs?: number;
}

export interface TestInSandboxOptions {
  /** Inputs passed one by one to the skill's entry function. Without any, the code is only compiled and loaded. */
  sampleInputs?: unknown[];
  timeoutMs?: number;
}

export interface RunSkillOptions {
  /** Must be true on every call for a Tier 2 skill: approval is per run, never remembered. */
  ownerApproved?: boolean;
  isTainted?: boolean;
  timeoutMs?: number;
}

export class SkillGenerator {
  private collection: Collection<SkillManifest>;
  private allowedFetchHosts: string[];
  private sandboxTimeoutMs: number | undefined;

  constructor(private store: DocumentStore, options: SkillGeneratorOptions = {}) {
    this.collection = this.store.getCollection<SkillManifest>('skills');
    this.allowedFetchHosts = options.allowedFetchHosts ?? [];
    this.sandboxTimeoutMs = options.sandboxTimeoutMs;
  }

  /**
   * Generates a new declared skill manifest when a capability gap is detected.
   */
  async generateSkill(params: {
    name: string;
    description: string;
    requiredTier?: 1 | 2;
    executableCode: string;
    entryPoint?: string;
    parametersSchema?: Record<string, unknown>;
  }): Promise<SkillManifest> {
    const id = `skill-${params.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
    const skill: SkillManifest = {
      id,
      name: params.name,
      description: params.description,
      version: '1.0.0',
      requiredTier: params.requiredTier ?? 1,
      parametersSchema: params.parametersSchema ?? {},
      executableCode: params.executableCode,
      entryPoint: params.entryPoint,
      author: 'ai-generated',
      status: 'draft',
      successCount: 0,
      failureCount: 0,
      createdAt: new Date().toISOString(),
    };

    await this.collection.insertOne(skill);
    return skill;
  }

  /**
   * Evaluates the candidate skill: static analysis for forbidden constructs, then a real run of its entry function
   * (against each sample input) inside the vm sandbox. Only a fully clean result marks the skill `sandboxed`.
   */
  async testInSandbox(skillId: string, options: TestInSandboxOptions = {}): Promise<SandboxTestResult> {
    const skill = await this.collection.findOne({ id: skillId });
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`);
    }

    const start = Date.now();
    const errors: string[] = [];
    const samples: SandboxSampleOutcome[] = [];
    const logs: string[] = [];
    const code = skill.executableCode ?? '';
    const timeoutMs = options.timeoutMs ?? this.sandboxTimeoutMs;

    const analysis = analyzeSkillCode(code, { allowedFetchHosts: this.allowedFetchHosts });
    const forbiddenDetected = analysis.forbidden.length > 0;
    errors.push(...analysis.forbidden);

    let executed = false;
    if (code.trim() === '') {
      errors.push('Skill has no executable code');
    } else if (!forbiddenDetected) {
      const entryPoint = skill.entryPoint ?? detectEntryPoint(code);
      const load = await runInSandbox(code, { entryPoint, timeoutMs });
      executed = load.loaded;
      logs.push(...load.logs);
      if (!load.ok) errors.push(`Sandbox load failed: ${load.error ?? 'unknown error'}`);

      if (load.ok) {
        for (const input of options.sampleInputs ?? []) {
          const run = await runInSandbox(code, { entryPoint, input, timeoutMs });
          logs.push(...run.logs);
          samples.push({ input, ok: run.ok, output: run.output, error: run.error });
          if (!run.ok) errors.push(`Sample run failed: ${run.error ?? 'unknown error'}`);
        }
      }
    }

    const passed = !forbiddenDetected && errors.length === 0;
    await this.collection.updateOne(
      { id: skillId },
      passed
        ? { status: 'sandboxed', sandboxedCodeHash: hashCode(code), lastSandboxAt: new Date().toISOString() }
        : { status: 'draft', sandboxedCodeHash: undefined, lastSandboxAt: new Date().toISOString() }
    );

    return {
      skillId,
      passed,
      errors,
      executionTimeMs: Date.now() - start,
      forbiddenActionsDetected: forbiddenDetected,
      executed,
      samples,
      logs,
    };
  }

  /**
   * Promotes a sandboxed skill to active status. A skill that has not passed the sandbox, or whose code changed
   * since it did, cannot be promoted. If the skill requires Tier 2 permissions, explicit owner approval is required.
   */
  async promoteSkill(skillId: string, isOwnerExplicitlyApproved = false): Promise<SkillManifest> {
    const skill = await this.collection.findOne({ id: skillId });
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`);
    }

    if (skill.requiredTier === 2 && !isOwnerExplicitlyApproved) {
      throw new Error(
        `Action Blocked: Skill '${skill.name}' requires Tier 2 permissions. Explicit owner approval required before activation.`
      );
    }

    if (skill.status !== 'sandboxed' && skill.status !== 'approved') {
      throw new Error(`Skill '${skill.name}' is ${skill.status}; it must pass testInSandbox before it can be activated.`);
    }
    if (skill.sandboxedCodeHash !== hashCode(skill.executableCode ?? '')) {
      throw new Error(`Skill '${skill.name}' code changed since it passed the sandbox; re-run testInSandbox.`);
    }

    await this.collection.updateOne({ id: skillId }, { status: 'active' });
    return { ...skill, status: 'active' };
  }

  async retireSkill(skillId: string): Promise<void> {
    await this.collection.updateOne({ id: skillId }, { status: 'retired' });
  }

  /**
   * Runs an active skill in the sandbox. Refuses anything not `active`, anything whose code no longer matches the
   * tested hash, and Tier 2 skills unless `options.ownerApproved` is true for this call. Records the outcome.
   */
  async runSkill(skillId: string, input?: unknown, options: RunSkillOptions = {}): Promise<RunSkillResult> {
    const skill = await this.collection.findOne({ id: skillId });
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`);
    }
    if (skill.status !== 'active') {
      throw new Error(`Skill '${skill.name}' is ${skill.status}, not active; it cannot be run.`);
    }
    if (skill.requiredTier === 2 && options.ownerApproved !== true) {
      throw new Error(`Action Blocked: Skill '${skill.name}' requires Tier 2 permissions. Explicit owner approval is required for each run.`);
    }
    const code = skill.executableCode ?? '';
    if (skill.sandboxedCodeHash !== hashCode(code)) {
      throw new Error(`Skill '${skill.name}' code does not match the version that passed the sandbox; refusing to run.`);
    }
    const analysis = analyzeSkillCode(code, { allowedFetchHosts: this.allowedFetchHosts });
    if (analysis.forbidden.length > 0) {
      throw new Error(`Skill '${skill.name}' failed re-analysis: ${analysis.forbidden.join('; ')}`);
    }

    const run = await runInSandbox(code, {
      entryPoint: skill.entryPoint ?? detectEntryPoint(code),
      input: input === undefined ? null : input,
      timeoutMs: options.timeoutMs ?? this.sandboxTimeoutMs,
    });
    await this.recordOutcome(skillId, run.ok);
    return {
      skillId,
      ok: run.ok,
      output: run.output,
      error: run.error,
      durationMs: run.durationMs,
      isTainted: options.isTainted === true,
      logs: run.logs,
    };
  }

  async recordOutcome(skillId: string, success: boolean): Promise<void> {
    const skill = await this.collection.findOne({ id: skillId });
    if (!skill) return;

    if (success) {
      await this.collection.updateOne({ id: skillId }, { successCount: skill.successCount + 1 });
    } else {
      await this.collection.updateOne({ id: skillId }, { failureCount: skill.failureCount + 1 });
    }
  }

  async getSkill(skillId: string): Promise<SkillManifest | null> {
    return this.collection.findOne({ id: skillId });
  }

  async listSkills(filter?: Partial<Pick<SkillManifest, 'status' | 'author' | 'requiredTier' | 'name'>>): Promise<SkillManifest[]> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filter ?? {})) {
      if (value !== undefined) clean[key] = value;
    }
    return this.collection.find(clean);
  }
}
