export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  requiredTier: 1 | 2;
  parametersSchema: Record<string, unknown>;
  executableCode?: string;
  /** Function the sandbox calls; detected from the code (`run`, `main`, or the first declared function) when absent. */
  entryPoint?: string;
  author: 'ai-generated' | 'built-in' | 'owner';
  status: 'draft' | 'sandboxed' | 'approved' | 'active' | 'retired';
  successCount: number;
  failureCount: number;
  createdAt: string;
  /** SHA-256 of the code that last passed the sandbox; promotion and execution require it to match the current code. */
  sandboxedCodeHash?: string;
  lastSandboxAt?: string;
}

export interface SandboxSampleOutcome {
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface SandboxTestResult {
  skillId: string;
  passed: boolean;
  errors: string[];
  executionTimeMs: number;
  forbiddenActionsDetected: boolean;
  /** True when the code compiled and loaded inside the vm sandbox. */
  executed: boolean;
  /** One entry per sample input that was run through the entry point. */
  samples: SandboxSampleOutcome[];
  logs: string[];
}

export interface RunSkillResult {
  skillId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  /** Mirrors the taint of the input the skill was given; skill output derived from tainted input stays tainted. */
  isTainted: boolean;
  logs: string[];
}
