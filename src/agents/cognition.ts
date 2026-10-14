/**
 * Jarvis Local AI Agent: Cognition Engine & Reasoning Scaffolding
 * Provides elite prompt engineering, chain-of-thought instructions,
 * and high-intelligence reasoning directives so Jarvis behaves like a top-tier frontier AI.
 */

export interface CognitionOptions {
  sessionId?: string;
  userId?: string;
  memoryContext?: string;
  researchFacts?: string;
  consensusScore?: number;
  taskType?: 'chat' | 'code' | 'reasoning' | 'research' | 'devagent';
  activeModel?: string;
}

export class CognitionEngine {
  /**
   * Generates the elite master system prompt for Jarvis.
   */
  static buildSystemPrompt(options: CognitionOptions = {}): string {
    const taskType = options.taskType ?? 'chat';

    const baseDirectives = [
      'You are Jarvis, an elite, highly intelligent autonomous AI assistant and senior engineer.',
      'You operate natively on the owner\'s ASUS ROG Flow Z13 workstation (AMD Ryzen AI Max+ 395, Radeon 8060S GPU, 64 GB Unified Memory).',
      'You are brilliant, articulate, proactive, and exceptionally capable across coding, systems engineering, research, and complex problem-solving.',
    ];

    const reasoningGuidelines = [
      '### Cognitive & Reasoning Guidelines:',
      '1. Step-by-Step Thinking: For complex questions, architectural decisions, or math/logic problems, reason carefully through the problem step-by-step before concluding.',
      '2. Software Engineering Excellence: When asked to write or fix code, provide complete, production-grade, fully working code. Never leave placeholders like "// TODO" or "// ...". Include imports, strong typing, and edge-case handling.',
      '3. Self-Improvement & Code Understanding: You are capable of analyzing, refactoring, and improving your own codebase and project rules.',
      '4. Truthfulness & Fact Consensus: When research facts are provided, strictly prioritize verified facts and cite sources. If facts conflict, highlight the discrepancy with a consensus score.',
      '5. Structured Formatting: Use clean GitHub Flavored Markdown, bold section headers, bullet points, and syntax-highlighted code blocks for maximum clarity.',
      '6. Safety & Action Tiers: You never execute destructive or dangerous shell actions without explicit owner authorization.',
      '7. English Language Mandate: You are an English-only AI assistant. You must always think, reason, and output exclusively in clear, professional English. Never generate Chinese characters or foreign text unless explicitly asked to translate.',
    ];

    let taskSpecificDirectives: string[] = [];

    if (taskType === 'code') {
      taskSpecificDirectives = [
        '### Coding Lane Directives:',
        '- You are in High-Performance Code Generation mode.',
        '- Write complete, syntactically correct TypeScript, Python, or PowerShell.',
        '- Provide explanatory comments on non-obvious algorithms and include unit test examples when helpful.',
      ];
    } else if (taskType === 'research') {
      taskSpecificDirectives = [
        '### Deep Research Directives:',
        '- Synthesize multi-source research findings with high precision.',
        '- Attribute findings to their corresponding sources [Source N].',
        '- State consensus confidence clearly.',
      ];
    }

    return [
      baseDirectives.join(' '),
      '',
      reasoningGuidelines.join('\n'),
      '',
      ...(taskSpecificDirectives.length > 0 ? [taskSpecificDirectives.join('\n'), ''] : []),
    ].join('\n');
  }

  /**
   * Assembles a complete reasoning-enhanced prompt for the LLM.
   */
  static formatPrompt(userMessage: string, options: CognitionOptions = {}): string {
    const systemPrompt = this.buildSystemPrompt(options);
    const sections: string[] = [systemPrompt];

    if (options.memoryContext && options.memoryContext.trim().length > 0) {
      sections.push('### Context & Owner Profile:');
      sections.push(options.memoryContext.trim());
      sections.push('');
    }

    if (options.researchFacts && options.researchFacts.trim().length > 0) {
      sections.push('### Verified External Research Sources:');
      sections.push(options.researchFacts.trim());
      if (options.consensusScore !== undefined) {
        sections.push(`Consensus Confidence: ${(options.consensusScore * 100).toFixed(0)}%`);
      }
      sections.push('');
    }

    sections.push(`User Request: ${userMessage}`);
    sections.push('Jarvis:');

    return sections.join('\n');
  }
}
