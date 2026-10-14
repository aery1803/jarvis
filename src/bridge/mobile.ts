import { MobileDeviceStatus, MobileNotification } from './types.js';

export class MobileBridge {
  private connectedDevices: Map<string, MobileDeviceStatus> = new Map();
  private notificationHistory: MobileNotification[] = [];

  constructor() {
    // Default simulated Android device
    this.connectedDevices.set('android-flow-phone', {
      deviceId: 'android-flow-phone',
      platform: 'android',
      batteryLevel: 85,
      isCharging: false,
      connected: true,
      lastSyncTime: new Date().toISOString(),
    });
  }

  getDeviceStatus(deviceId = 'android-flow-phone'): MobileDeviceStatus | null {
    return this.connectedDevices.get(deviceId) ?? null;
  }

  /**
   * Forwards mobile notifications with taint tracking.
   */
  forwardNotification(notification: Omit<MobileNotification, 'id' | 'timestamp' | 'isUntrusted'>): MobileNotification {
    const item: MobileNotification = {
      ...notification,
      id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      timestamp: new Date().toISOString(),
      isUntrusted: true, // External phone content is untrusted per Section 12.3
    };
    this.notificationHistory.push(item);
    return item;
  }

  listNotifications(limit = 10): MobileNotification[] {
    return this.notificationHistory.slice(-limit);
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
