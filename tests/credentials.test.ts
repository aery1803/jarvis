import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSetting,
  getTelegramToken,
  getTelegramOwnerId,
  readWindowsCredential,
} from '../src/security/credentials.js';

describe('Credentials & External Settings', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('should load settings with fallback to environment variables', () => {
    process.env.TEST_JARVIS_KEY = 'custom_value';
    assert.equal(getSetting('TEST_JARVIS_KEY'), 'custom_value');
    assert.equal(getSetting('NON_EXISTENT_KEY', 'default'), 'default');
  });

  test('should prioritize environment variable overrides for credentials', () => {
    process.env.TELEGRAM_DEV_TOKEN = 'mock-dev-token-12345';
    assert.equal(getTelegramToken('jarvis-telegram-dev'), 'mock-dev-token-12345');
  });

  test('should safely return empty string or null for non-existent target without crashing', () => {
    const cred = readWindowsCredential('non-existent-credential-xyz-999');
    assert.equal(cred, null);
  });
});
