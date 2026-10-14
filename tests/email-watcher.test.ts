import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { ActionGateway } from '../src/devagent/action-gateway.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import { EmailWatcher } from '../src/email/watcher.js';

describe('EmailWatcher & Triage Safeguards', () => {
  const testDbPath = path.resolve(process.cwd(), 'data', 'test-email.db');
  let store: DocumentStore;
  let registry: OwnActionRegistry;
  let gateway: ActionGateway;
  let watcher: EmailWatcher;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    store = new DocumentStore(testDbPath);
    registry = new OwnActionRegistry(testDbPath);
    gateway = new ActionGateway(registry, { minFreeMemoryBytes: 1024 * 1024 });
    watcher = new EmailWatcher(store, gateway);
  });

  afterEach(() => {
    store.close();
    registry.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  test('should classify urgent emails accurately and mark them as untrusted', async () => {
    const email = await watcher.ingestEmail({
      from: 'security@cloud.com',
      to: 'owner@local.com',
      subject: 'URGENT: Critical Security Alert regarding account',
      body: 'Action required immediately to prevent unauthorized access.',
    });

    assert.equal(email.importance, 'urgent');
    assert.ok(email.importanceScore >= 0.75);
    assert.equal(email.isUntrusted, true);
    assert.equal(email.suggestedAction, 'reply');
  });

  test('should generate reply drafts (Tier 1 safe)', async () => {
    const email = await watcher.ingestEmail({
      from: 'client@example.com',
      to: 'owner@local.com',
      subject: 'Project Proposal Review',
      body: 'Can we discuss the project roadmap tomorrow?',
    });

    const draft = await watcher.generateDraft(email.id, 'I am available at 2 PM.');
    assert.ok(draft.includes('Project Proposal Review'));
    assert.ok(draft.includes('available at 2 PM'));
  });

  test('should REJECT autonomous email sending without explicit owner approval (Tier 2)', async () => {
    const email = await watcher.ingestEmail({
      from: 'client@example.com',
      to: 'owner@local.com',
      subject: 'Contract Signature',
      body: 'Please send signed contract.',
    });

    await assert.rejects(
      async () => {
        await watcher.sendEmail(
          {
            to: email.from,
            subject: 'Re: Contract Signature',
            body: 'Approved and signed.',
          },
          false // isOwnerExplicitlyApproved = false
        );
      },
      (err: Error) => {
        assert.ok(err.message.includes('Tier 2'));
        return true;
      }
    );
  });

  test('should ALLOW sending email when explicitly approved by owner', async () => {
    const res = await watcher.sendEmail(
      {
        to: 'colleague@example.com',
        subject: 'Weekly Status',
        body: 'Here is the weekly summary.',
      },
      true // isOwnerExplicitlyApproved = true
    );

    assert.equal(res.sent, true);
    assert.ok(res.messageId.startsWith('msg-'));
  });
});
