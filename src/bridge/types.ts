export interface HostCommand {
  command: string;
  args?: string[];
  cwd?: string;
  tier: 1 | 2;
  timeoutMs?: number;
}

export interface HostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
}

export interface ScreenState {
  timestamp: string;
  activeWindow: string;
  resolution: { width: number; height: number };
  isUntrusted: boolean;
}

export interface MobileDeviceStatus {
  deviceId: string;
  platform: 'android' | 'ios';
  batteryLevel: number;
  isCharging: boolean;
  connected: boolean;
  lastSyncTime: string;
}

export interface MobileNotification {
  id: string;
  appName: string;
  title: string;
  text: string;
  timestamp: string;
  isUntrusted: boolean;
}
