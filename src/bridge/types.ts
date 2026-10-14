export interface HostCommand {
  command: string;
  args?: string[];
  cwd?: string;
  /** Advisory only: the tier is always derived from the full command line, and a caller value can only raise it. */
  tier?: 1 | 2;
  timeoutMs?: number;
}

export interface HostCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface ScreenState {
  timestamp: string;
  activeWindow: string | null;
  resolution: { width: number; height: number } | null;
  /** Set whenever `activeWindow` or `resolution` could not be read, with the reason. */
  unavailableReason?: string;
  isUntrusted: true;
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

/** Source of live phone data (ADB, a companion app). The bridge never invents devices without one. */
export interface MobileTransport {
  getStatus(deviceId: string): Promise<MobileDeviceStatus | null>;
  listNotifications(): Promise<MobileNotification[]>;
  listDevices?(): Promise<MobileDeviceStatus[]>;
}
