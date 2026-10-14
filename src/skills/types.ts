export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  requiredTier: 1 | 2;
  parametersSchema: Record<string, unknown>;
  executableCode?: string;
  author: 'ai-generated' | 'built-in' | 'owner';
  status: 'draft' | 'sandboxed' | 'approved' | 'active' | 'retired';
  successCount: number;
  failureCount: number;
  createdAt: string;
}

export interface SandboxTestResult {
  skillId: string;
  passed: boolean;
  errors: string[];
  executionTimeMs: number;
  forbiddenActionsDetected: boolean;
}
