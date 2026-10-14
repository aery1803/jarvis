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

  test('three contradicting pages do not score as verified', () => {
    const result = engine.evaluateClaim('The Z13 ships with 32 GB of memory', [
      { source: 'https://a.example.com/review', excerpt: 'The Z13 ships with 32 GB of memory in the base model.' },
      { source: 'https://b.example.org/specs', excerpt: 'The Z13 ships with 64 GB of memory in the base model.' },
      { source: 'https://c.example.net/news', excerpt: 'The Z13 ships with 128 GB of memory in the base model.' },
    ]);
    assert.equal(result.status, 'DISPUTED');
    assert.ok(result.confidence < 0.5);
    assert.ok((result.conflicts ?? []).some((c) => c.kind === 'numeric'));
  });

  test('three sources that never overlap are not verified', () => {
    const result = engine.evaluateClaim('Quantum computers will break encryption', [
      { source: 'https://a.example.com', excerpt: 'Bananas grow in tropical climates around the equator.' },
      { source: 'https://b.example.org', excerpt: 'The marathon course winds through the old harbor district.' },
      { source: 'https://c.example.net', excerpt: 'Medieval castles used drawbridges for defence.' },
    ]);
    assert.equal(result.status, 'UNCONFIRMED');
    assert.ok(result.confidence < 0.6);
  });

  test('many pages from one domain count as a single independent source', () => {
    const result = engine.evaluateClaim('Zen 5 powers the Ryzen AI Max+ 395', [
      { source: 'https://www.example.com/a', excerpt: 'The Ryzen AI Max+ 395 uses Zen 5 cores.' },
      { source: 'https://blog.example.com/b', excerpt: 'Zen 5 cores power the Ryzen AI Max+ 395.' },
      { source: 'https://example.com/c', excerpt: 'Ryzen AI Max+ 395 is built on Zen 5.' },
    ]);
    assert.equal(result.status, 'UNCONFIRMED');
    assert.equal(result.independentSources, 1);
  });

  test('syndicated near-duplicate text on different domains is one independent origin', () => {
    const wire = 'Researchers announced a new unified memory design that allows the integrated graphics processor to address a large share of system memory for local inference workloads across several laptop models this quarter.';
    const result = engine.evaluateClaim('New unified memory design announced', [
      { source: 'https://one.example.com/x', excerpt: wire },
      { source: 'https://two.example.org/y', excerpt: wire + ' Reuters.' },
    ]);
    assert.equal(result.independentSources, 1);
    assert.equal(result.status, 'UNCONFIRMED');
  });

  test('detects a polarity conflict generically without a keyword-pair list', () => {
    const result = engine.evaluateClaim('Vulkan backend works on the Radeon 8060S', [
      { source: 'https://a.example.com', excerpt: 'The Vulkan backend works on the Radeon 8060S GPU.' },
      { source: 'https://b.example.org', excerpt: 'The Vulkan backend does not work on the Radeon 8060S GPU.' },
    ]);
    assert.equal(result.status, 'DISPUTED');
    assert.ok((result.conflicts ?? []).some((c) => c.kind === 'polarity'));
  });

  test('old keyword pairs alone no longer trigger a dispute', () => {
    const result = engine.evaluateClaim('Alpha release notes', [
      { source: 'https://a.example.com', excerpt: 'The mode is only for admins and the weather was sunny.' },
      { source: 'https://b.example.org', excerpt: 'The cache holds up to a gigabyte of data on the stable branch.' },
    ]);
    assert.notEqual(result.status, 'DISPUTED');
  });

  test('numeric ranges that overlap and rounding within tolerance agree', () => {
    const result = engine.evaluateClaim('Battery life is about 10 hours', [
      { source: 'https://a.example.com', excerpt: 'Battery life reaches 9-11 hours in mixed use.' },
      { source: 'https://b.example.org', excerpt: 'Mixed use battery life is roughly 10 hours.' },
    ]);
    assert.equal(result.status, 'VERIFIED');
  });

  test('a declarative claim contradicted by the only source is disputed; a question claim is not', () => {
    const src = [{ source: 'https://a.example.com', excerpt: 'Battery life is 6 hours.' }];
    assert.equal(engine.evaluateClaim('Battery life is 18 hours', src).status, 'DISPUTED');
    assert.notEqual(engine.evaluateClaim('Is battery life 18 hours?', src).status, 'DISPUTED');
  });

  test('empty findings and empty excerpts are unconfirmed at low confidence', () => {
    assert.equal(engine.evaluateClaim('x', []).status, 'UNCONFIRMED');
    assert.ok(engine.evaluateClaim('x', [{ source: 'a.com', excerpt: '  ' }]).confidence <= 0.2);
  });

  test('the report summary does not claim high consensus when nothing was verified', () => {
    const report = engine.buildReport([{ claim: 'x', sources: [{ source: 'a.com', excerpt: 'only one source here' }] }]);
    assert.match(report.summary, /No claim was independently corroborated/);
  });
});
