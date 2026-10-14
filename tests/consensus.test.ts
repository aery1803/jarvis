/**
 * Unit Tests: Consensus & Fact-Checking Engine
 * Authority: Section 10 (Research & Fact-Check Skill, Consensus Scoring)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConsensusEngine } from '../src/services/consensus.js';

describe('ConsensusEngine', () => {
  const engine = new ConsensusEngine();

  test('should score high confidence when multiple sources corroborate a claim', () => {
    const claim = 'Radeon 8060S has 54GB available VRAM on Flow Z13';
    const sourceFindings = [
      { source: 'https://rog.asus.com', excerpt: 'Provides up to 54GB VRAM with UMA.' },
      { source: 'https://anandtech.com', excerpt: 'Unified memory architecture supports 54GB VRAM.' },
      { source: 'https://tomshardware.com', excerpt: '54GB VRAM measured on Radeon 8060S.' },
    ];

    const result = engine.evaluateClaim(claim, sourceFindings);
    assert.equal(result.status, 'VERIFIED');
    assert.ok(result.confidence >= 0.85);
    assert.equal(result.sources.length, 3);
  });

  test('should detect conflicts and lower confidence when sources disagree', () => {
    const claim = 'ASUS Flow Z13 battery life is 18 hours';
    const sourceFindings = [
      { source: 'https://source1.com', excerpt: 'Battery lasts 18 hours under light load.' },
      { source: 'https://source2.com', excerpt: 'Battery only lasts 6 hours in our tests.' },
    ];

    const result = engine.evaluateClaim(claim, sourceFindings);
    assert.equal(result.status, 'DISPUTED');
    assert.ok(result.confidence < 0.6);
  });

  test('should produce a synthesized consensus report across multiple claims', () => {
    const findings = [
      {
        claim: 'Ryzen AI Max+ 395 is based on Zen 5',
        sources: [
          { source: 'amd.com', excerpt: 'Features Zen 5 architecture.' },
          { source: 'anandtech.com', excerpt: 'Zen 5 core configuration.' },
        ],
      },
    ];

    const report = engine.buildReport(findings);
    assert.equal(report.verifiedClaimsCount, 1);
    assert.ok(report.overallScore > 0.7);
  });
});
