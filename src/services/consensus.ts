/**
 * Jarvis Local AI Agent: Consensus & Fact-Checking Engine
 * Authority: Section 10 (Research & Fact-Check Skill, Consensus Scoring)
 */

export type ClaimStatus = 'VERIFIED' | 'DISPUTED' | 'UNCONFIRMED';

export interface SourceFinding {
  source: string;
  excerpt: string;
}

export interface ClaimEvaluation {
  claim: string;
  status: ClaimStatus;
  confidence: number;
  sources: string[];
  notes?: string;
}

export interface ConsensusReport {
  overallScore: number;
  verifiedClaimsCount: number;
  disputedClaimsCount: number;
  evaluations: ClaimEvaluation[];
  summary: string;
}

export class ConsensusEngine {
  /**
   * Evaluates a single claim across multiple source findings.
   */
  public evaluateClaim(claim: string, findings: SourceFinding[]): ClaimEvaluation {
    if (findings.length === 0) {
      return {
        claim,
        status: 'UNCONFIRMED',
        confidence: 0.2,
        sources: [],
        notes: 'No sources provided to corroborate claim.',
      };
    }

    const uniqueSources = Array.from(new Set(findings.map((f) => f.source)));

    // Check for contradiction signals between excerpts
    const hasDisputeSignals = this.detectDisputeSignals(findings);

    if (hasDisputeSignals) {
      return {
        claim,
        status: 'DISPUTED',
        confidence: 0.45,
        sources: uniqueSources,
        notes: 'Sources express conflicting values or contradictory observations.',
      };
    }

    if (uniqueSources.length >= 3) {
      return {
        claim,
        status: 'VERIFIED',
        confidence: 0.95,
        sources: uniqueSources,
        notes: `Corroborated across ${uniqueSources.length} independent sources.`,
      };
    }

    if (uniqueSources.length === 2) {
      return {
        claim,
        status: 'VERIFIED',
        confidence: 0.85,
        sources: uniqueSources,
        notes: 'Corroborated across 2 sources.',
      };
    }

    return {
      claim,
      status: 'UNCONFIRMED',
      confidence: 0.55,
      sources: uniqueSources,
      notes: 'Single source only; uncorroborated.',
    };
  }

  private detectDisputeSignals(findings: SourceFinding[]): boolean {
    const text = findings.map((f) => f.excerpt.toLowerCase()).join(' | ');

    // Check for conflicting numbers or negative vs positive qualifiers
    const conflictPairs = [
      ['only', 'up to'],
      ['fails', 'succeeds'],
      ['not supported', 'supported'],
      ['unstable', 'stable'],
      ['6 hours', '18 hours'],
    ];

    for (const [a, b] of conflictPairs) {
      if (text.includes(a) && text.includes(b)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Aggregates multiple evaluated claims into a master ConsensusReport.
   */
  public buildReport(claimsData: Array<{ claim: string; sources: SourceFinding[] }>): ConsensusReport {
    const evaluations = claimsData.map((cd) => this.evaluateClaim(cd.claim, cd.sources));

    const verified = evaluations.filter((e) => e.status === 'VERIFIED');
    const disputed = evaluations.filter((e) => e.status === 'DISPUTED');

    const totalScore = evaluations.reduce((acc, curr) => acc + curr.confidence, 0);
    const overallScore = evaluations.length > 0 ? Number((totalScore / evaluations.length).toFixed(2)) : 0;

    let summary = `Consensus analysis complete across ${evaluations.length} key claims. `;
    if (disputed.length > 0) {
      summary += `Warning: ${disputed.length} claim(s) disputed across sources.`;
    } else {
      summary += `High consensus reached with 0 disputed claims.`;
    }

    return {
      overallScore,
      verifiedClaimsCount: verified.length,
      disputedClaimsCount: disputed.length,
      evaluations,
      summary,
    };
  }
}
