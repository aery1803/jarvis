import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const credentialCache = new Map<string, string>();
let settingsCache: Record<string, string> | null = null;

/**
 * Loads key-value settings from $HOME/.jarvis/settings.env without logging values.
 */
export function loadExternalSettings(): Record<string, string> {
  if (settingsCache) {
    return settingsCache;
  }

  const settings: Record<string, string> = {};
  const userHome = os.homedir();
  const settingsPath = path.join(userHome, '.jarvis', 'settings.env');

  if (fs.existsSync(settingsPath)) {
    try {
      const content = fs.readFileSync(settingsPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const val = trimmed.slice(eqIdx + 1).trim();
          settings[key] = val;
        }
      }
    } catch {
      // Intentionally silent
    }
  }

  settingsCache = settings;
  return settings;
}

/**
 * Retrieves a non-secret setting from external settings or process.env.
 */
export function getSetting(key: string, defaultValue = ''): string {
  if (process.env[key]) {
    return process.env[key]!;
  }
  const settings = loadExternalSettings();
  return settings[key] ?? defaultValue;
}

/**
 * Reads a generic credential from Windows Credential Manager using scripts/read-cred.ps1.
 * Returns null if not found, empty, or on non-Windows platforms.
 */
export function readWindowsCredential(targetName: string): string | null {
  if (credentialCache.has(targetName)) {
    return credentialCache.get(targetName)!;
  }

  // Check process.env override first (useful in CI or test environments)
  const envName = targetName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  if (process.env[envName]) {
    const val = process.env[envName]!;
    credentialCache.set(targetName, val);
    return val;
  }

  if (os.platform() !== 'win32') {
    return null;
  }

  const scriptPath = path.resolve(process.cwd(), 'scripts', 'read-cred.ps1');
  if (!fs.existsSync(scriptPath)) {
    return null;
  }

  try {
    const sanitizedTarget = targetName.replace(/[^a-zA-Z0-9_-]/g, '');
    const output = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" ${sanitizedTarget}`,
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();

    if (output) {
      credentialCache.set(targetName, output);
      return output;
    }
  } catch {
    // Intentionally silent - zero secret logging
  }

  return null;
}

/**
 * Returns the Telegram bot token for dev or qa target.
 */
export function getTelegramToken(target: 'jarvis-telegram-dev' | 'jarvis-telegram-qa' = 'jarvis-telegram-dev'): string {
  // Check direct env vars first
  if (target === 'jarvis-telegram-dev' && process.env.TELEGRAM_DEV_TOKEN) {
    return process.env.TELEGRAM_DEV_TOKEN;
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }

  const cred = readWindowsCredential(target);
  if (cred) {
    return cred;
  }

  return '';
}

/**
 * Returns the Telegram owner ID from settings or env.
 */
export function getTelegramOwnerId(): string {
  return getSetting('TELEGRAM_OWNER_ID', '');
}
