import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MobileBridge } from '../src/bridge/mobile.js';

describe('MobileBridge', () => {
  const mobile = new MobileBridge();

  test('should return device status for connected phone', () => {
    const status = mobile.getDeviceStatus('android-flow-phone');
    assert.ok(status);
    assert.equal(status.platform, 'android');
    assert.equal(status.connected, true);
    assert.ok(status.batteryLevel > 0);
  });

  test('should forward notifications with taint tracking', () => {
    const notif = mobile.forwardNotification({
      appName: 'Slack',
      title: 'Dev Channel',
      text: 'Meeting at 3 PM',
    });

    assert.equal(notif.isUntrusted, true);
    assert.equal(notif.appName, 'Slack');

    const history = mobile.listNotifications();
    assert.ok(history.length > 0);
  });

  test('should classify phone actions into tiers correctly', () => {
    const statusCheck = mobile.assessPhoneAction('read_status');
    assert.equal(statusCheck.tier, 1);
    assert.equal(statusCheck.requiresApproval, false);

    const smsCheck = mobile.assessPhoneAction('send_sms');
    assert.equal(smsCheck.tier, 2);
    assert.equal(smsCheck.requiresApproval, true);

    const callCheck = mobile.assessPhoneAction('place_call');
    assert.equal(callCheck.tier, 2);
    assert.equal(callCheck.requiresApproval, true);
  });
});
