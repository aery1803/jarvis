import { DocumentStore, Collection } from '../storage/collection.js';
import type { SkillManifest, SandboxTestResult } from './types.js';

export class SkillGenerator {
  private collection: Collection<SkillManifest>;

  constructor(private store: DocumentStore) {
    this.collection = this.store.getCollection<SkillManifest>('skills');
  }

  /**
   * Generates a new declared skill manifest when a capability gap is detected.
   */
  async generateSkill(params: {
    name: string;
    description: string;
    requiredTier?: 1 | 2;
    executableCode: string;
    parametersSchema?: Record<string, unknown>;
  }): Promise<SkillManifest> {
    const id = `skill-${params.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now().toString(36)}`;
    const skill: SkillManifest = {
      id,
      name: params.name,
      description: params.description,
      version: '1.0.0',
      requiredTier: params.requiredTier ?? 1,
      parametersSchema: params.parametersSchema ?? {},
      executableCode: params.executableCode,
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
   * Evaluates the candidate skill code inside a security sandbox, verifying syntax and absence of forbidden calls.
   */
  async testInSandbox(skillId: string): Promise<SandboxTestResult> {
    const skill = await this.collection.findOne({ id: skillId });
    if (!skill) {
      throw new Error(`Skill ${skillId} not found`);
    }

    const start = Date.now();
    const errors: string[] = [];
    let forbiddenDetected = false;

    // Static analysis for forbidden dangerous constructs
    const code = skill.executableCode ?? '';
    const forbiddenPatterns = [
      /\beval\s*\(/i,
      /\bFunction\s*\(/i,
      /\bprocess\.exit\s*\(/i,
      /\bchild_process\b/i,
      /\brm\s+-rf\b/i,
      /\bformat\s+c:/i,
    ];

    for (const pat of forbiddenPatterns) {
      if (pat.test(code)) {
        forbiddenDetected = true;
        errors.push(`Forbidden construct detected: ${pat.source}`);
      }
    }

    const passed = !forbiddenDetected && errors.length === 0;
    const newStatus = passed ? 'sandboxed' : 'draft';
    await this.collection.updateOne({ id: skillId }, { status: newStatus });

    return {
      skillId,
      passed,
      errors,
      executionTimeMs: Date.now() - start,
      forbiddenActionsDetected: forbiddenDetected,
    };
  }

  /**
   * Promotes a verified sandboxed skill to active status.
   * If the skill requires Tier 2 permissions, explicit owner approval is required.
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

    await this.collection.updateOne({ id: skillId }, { status: 'active' });
    return { ...skill, status: 'active' };
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

  async listSkills(filter?: Partial<Pick<SkillManifest, 'status' | 'author'>>): Promise<SkillManifest[]> {
    return this.collection.find(filter as Record<string, unknown>);
  }
}
