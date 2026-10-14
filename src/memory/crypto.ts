/**
 * Jarvis Local AI Agent: Sensitive Vault Cryptography
 * Authority: Section 8.3 (encrypted sensitive items), CODING_RULES.md Section 3
 *
 * AES-256-GCM with a random 256-bit key generated once and kept in `~/.jarvis/vault.key` (mode 0600),
 * outside the database and the repository. `JARVIS_VAULT_KEY` still wins when set. Every payload carries a
 * key id, so a changed key is reported as `VaultKeyMismatchError` instead of looking like a missing secret.
 * Payloads written before key ids existed are still readable with the old host-derived key.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_FILE_PATTERN = /^[0-9a-f]{64}$/;

export interface VaultKeyOptions {
  /** Where the generated key lives; defaults to `JARVIS_VAULT_KEY_PATH`, then `~/.jarvis/vault.key`. */
  keyPath?: string;
  /** Environment to read `JARVIS_VAULT_KEY` from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Replaces the host-derived legacy key seed, so tests do not depend on the machine. */
  legacySeed?: string;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  /** First 8 hex characters of sha256(key). Absent on payloads written before key ids existed. */
  keyId?: string;
}

export type DecryptResult =
  | { ok: true; plaintext: string; legacy: boolean }
  | { ok: false; error: 'key-mismatch' | 'corrupt'; message: string };

export class VaultKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultKeyError';
  }
}

/** The payload was written under a different key than the one now configured. */
export class VaultKeyMismatchError extends Error {
  constructor(
    public readonly payloadKeyId: string | undefined,
    public readonly currentKeyId: string
  ) {
    super(`Vault key mismatch: payload key id ${payloadKeyId ?? 'legacy'} does not match current key id ${currentKeyId}`);
    this.name = 'VaultKeyMismatchError';
  }
}

/** The ciphertext failed authentication or is malformed. */
export class VaultCorruptError extends Error {
  constructor(message = 'Vault payload could not be decrypted') {
    super(message);
    this.name = 'VaultCorruptError';
  }
}

export function getVaultKeyPath(options: VaultKeyOptions = {}): string {
  return options.keyPath ?? (options.env ?? process.env).JARVIS_VAULT_KEY_PATH ?? path.join(os.homedir(), '.jarvis', 'vault.key');
}

export function keyIdOf(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function readKeyFile(keyPath: string): Buffer {
  const hex = fs.readFileSync(keyPath, 'utf8').trim();
  if (!KEY_FILE_PATTERN.test(hex)) {
    // Regenerating here would silently orphan every stored secret, so a damaged key file is an error.
    throw new VaultKeyError(`Vault key file ${keyPath} is not 64 hex characters; fix or restore it`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Creates the key file if absent. The key is written to a private temp file and hard-linked into place:
 * `link` fails with `EEXIST` when another process won the race, so the file is never seen half-written
 * and never replaced.
 */
function createKeyFile(keyPath: string): Buffer {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  const tempPath = `${keyPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(tempPath, keyPath);
    return key;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return readKeyFile(keyPath);
    }
    // Filesystems without hard links: exclusive create is still race-safe, only not half-write-safe.
    try {
      fs.writeFileSync(keyPath, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (inner: unknown) {
      if ((inner as NodeJS.ErrnoException).code === 'EEXIST') {
        return readKeyFile(keyPath);
      }
      throw inner;
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export function loadVaultKey(options: VaultKeyOptions = {}): { key: Buffer; keyId: string; source: 'env' | 'file' } {
  const env = options.env ?? process.env;
  if (env.JARVIS_VAULT_KEY) {
    const key = crypto.createHash('sha256').update(env.JARVIS_VAULT_KEY).digest();
    return { key, keyId: keyIdOf(key), source: 'env' };
  }
  const keyPath = getVaultKeyPath(options);
  const key = fs.existsSync(keyPath) ? readKeyFile(keyPath) : createKeyFile(keyPath);
  return { key, keyId: keyIdOf(key), source: 'file' };
}

/** Keys that could have encrypted a payload with no key id: the host-derived key, and the env key. */
function legacyKeys(options: VaultKeyOptions): Buffer[] {
  const env = options.env ?? process.env;
  const seed = options.legacySeed ?? `${os.userInfo().username}:${os.hostname()}:jarvis-local-memory-salt-v1`;
  const keys = [crypto.createHash('sha256').update(seed).digest()];
  if (env.JARVIS_VAULT_KEY) {
    keys.unshift(crypto.createHash('sha256').update(env.JARVIS_VAULT_KEY).digest());
  }
  return keys;
}

function decryptWith(key: Buffer, payload: EncryptedPayload): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
  return decipher.update(payload.ciphertext, 'hex', 'utf8') + decipher.final('utf8');
}

/** Encrypts a plaintext string using AES-256-GCM under the current vault key. */
export function encryptSensitive(plaintext: string, options: VaultKeyOptions = {}): EncryptedPayload {
  const { key, keyId } = loadVaultKey(options);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return { ciphertext, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), keyId };
}

/** Decrypts a payload; a payload from another key is a typed `key-mismatch`, never a silent null. */
export function tryDecryptSensitive(payload: EncryptedPayload, options: VaultKeyOptions = {}): DecryptResult {
  const { key, keyId } = loadVaultKey(options);

  if (payload.keyId) {
    if (payload.keyId !== keyId) {
      const error = new VaultKeyMismatchError(payload.keyId, keyId);
      return { ok: false, error: 'key-mismatch', message: error.message };
    }
    try {
      return { ok: true, plaintext: decryptWith(key, payload), legacy: false };
    } catch {
      return { ok: false, error: 'corrupt', message: 'Vault payload failed authentication' };
    }
  }

  for (const candidate of legacyKeys(options)) {
    try {
      return { ok: true, plaintext: decryptWith(candidate, payload), legacy: true };
    } catch {
      continue;
    }
  }
  const mismatch = new VaultKeyMismatchError(undefined, keyId);
  return { ok: false, error: 'key-mismatch', message: mismatch.message };
}

/** Like `tryDecryptSensitive` but throws `VaultKeyMismatchError` / `VaultCorruptError`. */
export function decryptSensitive(payload: EncryptedPayload, options: VaultKeyOptions = {}): string {
  const result = tryDecryptSensitive(payload, options);
  if (result.ok) return result.plaintext;
  if (result.error === 'key-mismatch') {
    throw new VaultKeyMismatchError(payload.keyId, loadVaultKey(options).keyId);
  }
  throw new VaultCorruptError(result.message);
}

/** True when the payload predates key ids and should be re-encrypted on its next write. */
export function isLegacyPayload(payload: EncryptedPayload): boolean {
  return !payload.keyId;
}
