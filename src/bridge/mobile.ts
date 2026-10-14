import type { MobileDeviceStatus, MobileNotification, MobileTransport } from './types.js';
import { stripControlChars } from './untrusted.js';

const MAX_NOTIFICATION_HISTORY = 200;
const MAX_SEEN_EXTERNAL_IDS = 1000;

export interface MobileBridgeOptions {
  transport?: MobileTransport;
}

export type MobileNotificationInput = Omit<MobileNotification, 'id' | 'timestamp' | 'isUntrusted'>;

function validateStatus(status: MobileDeviceStatus): void {
  if (!status.deviceId.trim()) throw new Error('Device id must not be empty.');
  if (status.batteryLevel !== null && (!Number.isFinite(status.batteryLevel) || status.batteryLevel < 0 || status.batteryLevel > 100)) {
    throw new Error(`Battery level must be between 0 and 100 (got ${status.batteryLevel}).`);
  }
}

/**
 * Tracks phones a transport (ADB, a companion app) reports. It starts empty and never invents a device.
 */
export class MobileBridge {
  private connectedDevices: Map<string, MobileDeviceStatus> = new Map();
  private notificationHistory: MobileNotification[] = [];
  private seenExternalIds = new Set<string>();
  private readonly transport?: MobileTransport;

  constructor(options: MobileBridgeOptions = {}) {
    this.transport = options.transport;
  }

  registerDevice(status: MobileDeviceStatus): MobileDeviceStatus {
    validateStatus(status);
    const stored = { ...status };
    this.connectedDevices.set(stored.deviceId, stored);
    return { ...stored };
  }

  updateDevice(deviceId: string, patch: Partial<Omit<MobileDeviceStatus, 'deviceId'>>): MobileDeviceStatus | null {
    const existing = this.connectedDevices.get(deviceId);
    if (!existing) return null;
    const merged: MobileDeviceStatus = { ...existing, ...patch, deviceId };
    validateStatus(merged);
    this.connectedDevices.set(deviceId, merged);
    return { ...merged };
  }

  removeDevice(deviceId: string): boolean {
    return this.connectedDevices.delete(deviceId);
  }

  listDevices(): MobileDeviceStatus[] {
    return [...this.connectedDevices.values()].map((device) => ({ ...device }));
  }

  /** Status of a known device; with no id, the only registered device (null when there are zero or several). */
  getDeviceStatus(deviceId?: string): MobileDeviceStatus | null {
    if (deviceId === undefined) {
      return this.connectedDevices.size === 1 ? { ...[...this.connectedDevices.values()][0] } : null;
    }
    const device = this.connectedDevices.get(deviceId);
    return device ? { ...device } : null;
  }

  /**
   * Re-reads the injected transport: new devices are registered, and any known device the transport no longer
   * reports is marked disconnected. Without a transport this returns the current registry unchanged.
   */
  async refreshDevices(): Promise<MobileDeviceStatus[]> {
    if (!this.transport) return this.listDevices();

    const reported = this.transport.listDevices ? await this.transport.listDevices() : [];
    const ids = new Set<string>([...this.connectedDevices.keys(), ...reported.map((device) => device.deviceId)]);
    for (const deviceId of ids) {
      const fresh = (await this.transport.getStatus(deviceId)) ?? reported.find((device) => device.deviceId === deviceId) ?? null;
      const known = this.connectedDevices.get(deviceId);
      if (fresh) {
        this.registerDevice(fresh);
      } else if (known) {
        this.connectedDevices.set(deviceId, { ...known, connected: false });
      }
    }
    return this.listDevices();
  }

  /** Pulls notifications from the transport into the tainted history. Already-seen transport ids are skipped. */
  async pullNotifications(): Promise<MobileNotification[]> {
    if (!this.transport) return [];
    const incoming = await this.transport.listNotifications();
    const forwarded: MobileNotification[] = [];
    for (const notification of incoming) {
      if (this.seenExternalIds.has(notification.id)) continue;
      this.seenExternalIds.add(notification.id);
      if (this.seenExternalIds.size > MAX_SEEN_EXTERNAL_IDS) {
        this.seenExternalIds.delete(this.seenExternalIds.values().next().value as string);
      }
      forwarded.push(this.forwardNotification(notification));
    }
    return forwarded;
  }

  /**
   * Forwards mobile notifications with taint tracking.
   */
  forwardNotification(notification: MobileNotificationInput): MobileNotification {
    const item: MobileNotification = {
      appName: stripControlChars(notification.appName).slice(0, 100),
      title: stripControlChars(notification.title).slice(0, 300),
      text: stripControlChars(notification.text).slice(0, 2000),
      id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      isUntrusted: true, // External phone content is untrusted per Section 12.3
    };
    this.notificationHistory.push(item);
    if (this.notificationHistory.length > MAX_NOTIFICATION_HISTORY) {
      this.notificationHistory.splice(0, this.notificationHistory.length - MAX_NOTIFICATION_HISTORY);
    }
    return item;
  }

  listNotifications(limit = 10): MobileNotification[] {
    return limit <= 0 ? [] : this.notificationHistory.slice(-limit);
  }

  /**
   * Evaluates phone actions against Tier 2 boundaries.
   * Sending SMS, calling, or payments strictly require owner approval.
   */
  assessPhoneAction(actionType: 'read_status' | 'read_notification' | 'send_sms' | 'place_call' | 'make_payment'): {
    tier: 1 | 2;
    requiresApproval: boolean;
    reason?: string;
  } {
    if (actionType === 'send_sms' || actionType === 'place_call' || actionType === 'make_payment') {
      return {
        tier: 2,
        requiresApproval: true,
        reason: `Phone action '${actionType}' incurs carrier cost or external communication. Owner confirmation required.`,
      };
    }
    return { tier: 1, requiresApproval: false };
  }
}
