import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HostBridge } from '../src/bridge/host.js';

describe('HostBridge & Laptop Control', () => {
  const bridge = new HostBridge();

  test('should classify commands into Tier 1 and Tier 2 correctly', () => {
    assert.equal(bridge.classifyCommandTier('git status'), 1);
    assert.equal(bridge.classifyCommandTier('node -v'), 1);
    assert.equal(bridge.classifyCommandTier('rm -rf /some/dir'), 2);
    assert.equal(bridge.classifyCommandTier('del /f /q *'), 2);
    assert.equal(bridge.classifyCommandTier('format c:'), 2);
  });

  test('should block Tier 2 command without explicit owner approval', async () => {
    await assert.rejects(
      async () => {
        await bridge.executeCommand({
          command: 'del test.txt',
          tier: 2,
        }, false);
      },
      (err: Error) => {
        assert.ok(err.message.includes('Tier 2'));
        return true;
      }
    );
  });

  test('should execute safe Tier 1 commands', async () => {
    const res = await bridge.executeCommand({
      command: 'echo "hello jarvis"',
      tier: 1,
    });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('hello jarvis'));
  });

  test('should return screen state marked untrusted', async () => {
    const screen = await bridge.getScreenState();
    assert.ok(screen.resolution.width > 0);
    assert.equal(screen.isUntrusted, true);
  });
});
