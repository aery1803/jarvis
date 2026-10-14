/**
 * Unit Tests: Sensitive Vault (key management, secret detection, remember routing)
 * Authority: Section 8.3, CODING_RULES.md Sections 2.3 and 3
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore } from '../src/storage/collection.js';
import { MemoryManager, SensitiveValueError } from '../src/memory/manager.js';
import {
  decryptSensitive,
  encryptSensitive,
  keyIdOf,
  loadVaultKey,
  tryDecryptSensitive,
  VaultKeyError,
  VaultKeyMismatchError,
  type EncryptedPayload,
} from '../src/memory/crypto.js';
import { detectSensitive, redactSensitive } from '../src/memory/sensitive.js';
import { parseRememberCommand } from '../src/memory/context-builder.js';

const LUHN_VISA = '4111 1111 1111 1111';

describe('vault key management', () => {
  let dir: string;
  let keyPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-vault-'));
    keyPath = path.join(dir, 'nested', 'vault.key');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('generates a random 256-bit key once, in a 0600 file, and reuses it', () => {
    const first = loadVaultKey({ keyPath, env: {} });
    assert.equal(first.key.length, 32);
    assert.equal(first.source, 'file');
    assert.match(fs.readFileSync(keyPath, 'utf8').trim(), /^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    }
    const second = loadVaultKey({ keyPath, env: {} });
    assert.deepEqual(second.key, first.key);
    assert.equal(first.keyId, keyIdOf(first.key));
    assert.equal(first.keyId.length, 8);
    assert.deepEqual(fs.readdirSync(path.dirname(keyPath)), ['vault.key']);
  });

  test('is not derived from the username and hostname', () => {
    const legacy = crypto
      .createHash('sha256')
      .update(`${os.userInfo().username}:${os.hostname()}:jarvis-local-memory-salt-v1`)
      .digest();
    assert.notDeepEqual(loadVaultKey({ keyPath, env: {} }).key, legacy);
  });

  test('JARVIS_VAULT_KEY wins over the key file and the file is not created', () => {
    const loaded = loadVaultKey({ keyPath, env: { JARVIS_VAULT_KEY: 'from-env' } });
    assert.equal(loaded.source, 'env');
    assert.deepEqual(loaded.key, crypto.createHash('sha256').update('from-env').digest());
    assert.equal(fs.existsSync(keyPath), false);
  });

  test('JARVIS_VAULT_KEY_PATH relocates the key file', () => {
    const custom = path.join(dir, 'custom.key');
    loadVaultKey({ env: { JARVIS_VAULT_KEY_PATH: custom } });
    assert.equal(fs.existsSync(custom), true);
  });

  test('a damaged key file is an error, never silently regenerated', () => {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, 'not a key');
    assert.throws(() => loadVaultKey({ keyPath, env: {} }), VaultKeyError);
    assert.equal(fs.readFileSync(keyPath, 'utf8'), 'not a key');
  });

  test('every payload carries the key id and round-trips', () => {
    const options = { keyPath, env: {} };
    const payload = encryptSensitive('hunter2', options);
    assert.equal(payload.keyId, loadVaultKey(options).keyId);
    assert.equal(decryptSensitive(payload, options), 'hunter2');
  });

  test('a changed key is a typed key-mismatch, not null', () => {
    const payload = encryptSensitive('hunter2', { keyPath, env: {} });
    const other = { keyPath: path.join(dir, 'other.key'), env: {} };
    const result = tryDecryptSensitive(payload, other);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error, 'key-mismatch');
    assert.throws(() => decryptSensitive(payload, other), VaultKeyMismatchError);
  });

  test('a tampered ciphertext with the right key id is reported as corrupt', () => {
    const options = { keyPath, env: {} };
    const payload = encryptSensitive('hunter2', options);
    const tampered: EncryptedPayload = { ...payload, ciphertext: payload.ciphertext.replace(/^../, '00') };
    const result = tryDecryptSensitive(tampered, options);
    assert.equal(!result.ok && result.error, 'corrupt');
  });

  test('legacy payloads without a key id still decrypt with the old derivation', () => {
    const seed = 'legacy-user:legacy-host:jarvis-local-memory-salt-v1';
    const legacyKey = crypto.createHash('sha256').update(seed).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const ciphertext = cipher.update('old secret', 'utf8', 'hex') + cipher.final('hex');
    const legacy: EncryptedPayload = { ciphertext, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };

    const result = tryDecryptSensitive(legacy, { keyPath, env: {}, legacySeed: seed });
    assert.equal(result.ok && result.plaintext, 'old secret');
    assert.equal(result.ok && result.legacy, true);
    const unreadable = tryDecryptSensitive(legacy, { keyPath, env: {}, legacySeed: 'something else' });
    assert.equal(!unreadable.ok && unreadable.error, 'key-mismatch');
  });
});

describe('detectSensitive / redactSensitive', () => {
  const secrets: Array<[string, string]> = [
    ['my password is hunter2', 'password'],
    ['the wifi password for the cabin is correct-horse', 'password'],
    ['sk-abcdefghijklmnopqrstuvwxyz123456', 'api-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz', 'token'],
    ['xoxb-1234567890-abcdefghij', 'token'],
    ['Authorization: Bearer abcdefghijklmnop1234567890', 'token'],
    [`card ${LUHN_VISA}`, 'card-number'],
    ['ssn 123-45-6789', 'ssn'],
    ['my api key is zzz-123-yyy', 'api-key'],
  ];

  for (const [text, kind] of secrets) {
    test(`flags ${kind}: ${text.slice(0, 24)}`, () => {
      const scan = detectSensitive(text);
      assert.equal(scan.sensitive, true);
      assert.ok(scan.kinds.includes(kind as never), `kinds ${scan.kinds.join(',')}`);
    });
  }

  test('leaves ordinary facts alone', () => {
    for (const text of [
      'my favourite colour is green',
      'I prefer short answers',
      'order number 1234 5678 9012 3456',
      'the meeting is on 2026-10-15',
      'call me on 555-1234',
    ]) {
      assert.equal(detectSensitive(text).sensitive, false, text);
    }
  });

  test('redacts the secret and keeps the surrounding text', () => {
    const redacted = redactSensitive(`my password is hunter2 and card ${LUHN_VISA} ok`);
    assert.ok(!redacted.includes('hunter2'));
    assert.ok(!redacted.includes('4111'));
    assert.ok(redacted.includes('my password is [REDACTED:password]'));
    assert.equal(redactSensitive('nothing here'), 'nothing here');
  });
});

describe('remember routing', () => {
  let store: DocumentStore;
  let memory: MemoryManager;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-remember-'));
    store = new DocumentStore(':memory:');
    memory = new MemoryManager(store, { vault: { keyPath: path.join(dir, 'vault.key'), env: {} } });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a secret goes to the vault and the profile gets only a pointer', async () => {
    const command = parseRememberCommand('Remember that my wifi password is hunter2')!;
    const result = await memory.rememberFact('owner', command);
    assert.equal(result.stored, 'vault');
    assert.equal(result.tag, 'my-wifi-password');
    assert.equal(result.created, true);

    const prompt = await memory.formatProfileForPrompt('owner');
    assert.ok(prompt.includes('stored in vault: my-wifi-password'));
    assert.ok(!prompt.includes('hunter2'));
    const facts = await memory.getProfileFacts('owner');
    assert.ok(facts.every((fact) => !fact.value.includes('hunter2')));
    assert.equal(await memory.retrieveSensitive('owner', 'my-wifi-password'), 'my wifi password is hunter2');
    assert.deepEqual(await memory.listSensitiveTags('owner'), ['my-wifi-password']);
  });

  test('the raw collection never holds the secret in plaintext', async () => {
    await memory.rememberFact('owner', parseRememberCommand('remember that my github token is ghp_abcdefghijklmnopqrstuvwxyz0123456789')!);
    const dump = JSON.stringify([
      ...store.collection('owner_profile').find(),
      ...store.collection('sensitive_vault').find(),
    ]);
    assert.ok(!dump.includes('ghp_'));
  });

  test('remembering the secret again updates it rather than creating a second one', async () => {
    const first = await memory.rememberFact('owner', parseRememberCommand('remember that my pin is 4821')!);
    const second = await memory.rememberFact('owner', parseRememberCommand('remember that my pin is 9999')!);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal((await memory.listSensitiveTags('owner')).length, 1);
    assert.equal(await memory.retrieveSensitive('owner', second.tag!), 'my pin is 9999');
  });

  test('a bare secret gets a tag that does not contain it', async () => {
    const command = parseRememberCommand('remember that sk-abcdefghijklmnopqrstuvwxyz123456')!;
    assert.ok(!command.key.includes('sk-abc'));
    const result = await memory.rememberFact('owner', command);
    assert.equal(result.stored, 'vault');
    assert.match(result.tag!, /^api-key-[0-9a-f]{6}$/);
  });

  test('an ordinary fact is a profile fact, and reports created then updated', async () => {
    const first = await memory.rememberFact('owner', { key: 'editor', value: 'VS Code' });
    const second = await memory.rememberFact('owner', { key: 'editor', value: 'Neovim' });
    assert.deepEqual([first.stored, first.created, second.created], ['profile', true, false]);
    assert.equal((await memory.getProfileFacts('owner'))[0].value, 'Neovim');
  });

  test('setProfileFact refuses a secret instead of storing it in plaintext', async () => {
    await assert.rejects(memory.setProfileFact('owner', 'password', 'hunter2'), SensitiveValueError);
    await assert.rejects(memory.setProfileFact('owner', 'note', `card ${LUHN_VISA}`), SensitiveValueError);
    assert.equal((await memory.getProfileFacts('owner')).length, 0);
  });

  test('a legacy plaintext fact that holds a secret is redacted in the prompt', async () => {
    store.collection('owner_profile').insertOne({ userId: 'owner', key: 'old', value: 'my password is hunter2', category: 'preference', updatedAt: new Date().toISOString() });
    const prompt = await memory.formatProfileForPrompt('owner');
    assert.ok(!prompt.includes('hunter2'));
  });

  test('a changed vault key makes retrieve throw a typed error, not return null', async () => {
    await memory.storeSensitive('owner', 'tag', 'secret value');
    const other = new MemoryManager(store, { vault: { keyPath: path.join(dir, 'other.key'), env: {} } });
    await assert.rejects(other.retrieveSensitive('owner', 'tag'), VaultKeyMismatchError);
    const result = await other.retrieveSensitiveResult('owner', 'tag');
    assert.equal(result.status, 'key-mismatch');
    assert.equal(await other.retrieveSensitive('owner', 'nope'), null);
  });

  test('a legacy vault row is readable and re-encrypted under the current key', async () => {
    const seed = 'u:h:jarvis-local-memory-salt-v1';
    const legacyKey = crypto.createHash('sha256').update(seed).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
    const ciphertext = cipher.update('legacy secret', 'utf8', 'hex') + cipher.final('hex');
    store.collection('sensitive_vault').insertOne({
      id: 'vault-1',
      userId: 'owner',
      tag: 'old',
      ciphertext,
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
      createdAt: new Date().toISOString(),
    });
    const legacyMemory = new MemoryManager(store, { vault: { keyPath: path.join(dir, 'vault.key'), env: {}, legacySeed: seed } });
    assert.equal(await legacyMemory.retrieveSensitive('owner', 'old'), 'legacy secret');
    const row = store.collection<{ keyId?: string }>('sensitive_vault').findOne({ id: 'vault-1' });
    assert.equal(row?.keyId?.length, 8);
    assert.equal(await legacyMemory.retrieveSensitive('owner', 'old'), 'legacy secret');
  });

  test('same-millisecond vault writes do not overwrite each other', async () => {
    await Promise.all([memory.storeSensitive('owner', 'a', '1'), memory.storeSensitive('owner', 'b', '2')]);
    assert.deepEqual((await memory.listSensitiveTags('owner')).sort(), ['a', 'b']);
  });

  test('deleteSensitive removes the secret and its profile pointer', async () => {
    const result = await memory.rememberFact('owner', parseRememberCommand('remember that my pin is 4821')!);
    assert.equal(await memory.deleteSensitive('owner', result.tag!), true);
    assert.equal(await memory.retrieveSensitive('owner', result.tag!), null);
    assert.equal((await memory.getProfileFacts('owner')).length, 0);
  });
});
