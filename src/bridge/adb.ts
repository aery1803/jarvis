import { execFile } from 'node:child_process';
import type { MobileDeviceStatus, MobileNotification, MobileTransport } from './types.js';

const SERIAL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type AdbRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export interface AdbTransportOptions {
  adbPath?: string;
  timeoutMs?: number;
  runner?: AdbRunner;
}

const defaultRunner: AdbRunner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** Parses `adb devices` output into serial/state pairs, skipping the header and daemon chatter. */
export function parseAdbDevices(output: string): Array<{ serial: string; state: string }> {
  const devices: Array<{ serial: string; state: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader)\b/.exec(line.trim());
    if (match && SERIAL_PATTERN.test(match[1])) devices.push({ serial: match[1], state: match[2] });
  }
  return devices;
}

/** Parses `dumpsys battery`; returns null when no battery level is present. */
export function parseDumpsysBattery(output: string): { batteryLevel: number; isCharging: boolean } | null {
  const level = /^\s*level:\s*(\d+)/m.exec(output);
  if (!level) return null;
  const powered = /^\s*(AC|USB|Wireless|Dock) powered:\s*true/im.test(output);
  const status = /^\s*status:\s*(\d+)/m.exec(output);
  // BatteryManager status 2 is CHARGING; 5 is FULL while still on a charger.
  const isCharging = status ? status[1] === '2' || (status[1] === '5' && powered) : powered;
  return { batteryLevel: Math.min(100, Number(level[1])), isCharging };
}

/**
 * Read-only Android transport over `adb`. Runs only `adb devices` and `adb -s <serial> shell dumpsys battery`;
 * when adb is missing or fails it reports no devices rather than inventing any.
 */
export class AdbTransport implements MobileTransport {
  private readonly adbPath: string;
  private readonly timeoutMs: number;
  private readonly runner: AdbRunner;

  constructor(options: AdbTransportOptions = {}) {
    this.adbPath = options.adbPath ?? 'adb';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.runner = options.runner ?? defaultRunner;
  }

  async listDevices(): Promise<MobileDeviceStatus[]> {
    let output: string;
    try {
      output = await this.runner(this.adbPath, ['devices'], this.timeoutMs);
    } catch {
      return [];
    }
    const statuses: MobileDeviceStatus[] = [];
    for (const { serial, state } of parseAdbDevices(output)) {
      const status = state === 'device' ? await this.getStatus(serial) : null;
      statuses.push(
        status ?? { deviceId: serial, platform: 'android', batteryLevel: 0, isCharging: false, connected: false, lastSyncTime: new Date().toISOString() }
      );
    }
    return statuses;
  }

  async getStatus(deviceId: string): Promise<MobileDeviceStatus | null> {
    if (!SERIAL_PATTERN.test(deviceId)) return null;
    try {
      const output = await this.runner(this.adbPath, ['-s', deviceId, 'shell', 'dumpsys', 'battery'], this.timeoutMs);
      const battery = parseDumpsysBattery(output);
      if (!battery) return null;
      return { deviceId, platform: 'android', ...battery, connected: true, lastSyncTime: new Date().toISOString() };
    } catch {
      return null;
    }
  }

  /** Reading notifications over adb is not implemented; the transport honestly reports none. */
  async listNotifications(): Promise<MobileNotification[]> {
    return [];
  }
}
