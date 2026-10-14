import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostBridge } from '../src/bridge/host.js';
import type { ProcessRunner, ProcessRunOptions } from '../src/bridge/host.js';

interface Call {
  file: string;
  args: string[];
  options: ProcessRunOptions;
}

function recordingRunner(result: Partial<Awaited<ReturnType<ProcessRunner>>> = {}): { runner: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ProcessRunner = async (file, args, options) => {
    calls.push({ file, args, options });
    return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false, ...result };
  };
  return { runner, calls };
}

describe('HostBridge allowlist classification', () => {
  let workspace: string;
  let bridge: HostBridge;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-host-'));
    fs.writeFileSync(path.join(workspace, 'notes.txt'), 'hello notes');
    fs.writeFileSync(path.join(workspace, '.env'), 'TOKEN=x');
    fs.mkdirSync(path.join(workspace, 'sub'));
    bridge = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'linux' });
  });

  after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  test('classifies read-only allowlisted commands as Tier 1', () => {
    for (const line of [
      'git status',
      'git status -sb',
      'git log --oneline -n 5',
      'git diff --stat',
      'git branch -a',
      'node -v',
      'npm -v',
      'pnpm --version',
      'ls',
      'dir',
      'pwd',
      'whoami',
      'hostname',
      'echo "hello jarvis"',
      'cat notes.txt',
      'type notes.txt',
    ]) {
      assert.equal(bridge.classifyCommandTier(line), 1, line);
    }
  });

  test('classifies destructive, unknown and shell-wrapped commands as Tier 2', () => {
    for (const line of [
      'rm -rf /some/dir',
      'del /f /q *',
      'format c:',
      'bash -c "rm -rf /"',
      'sh x.sh',
      'git status; rm -rf /',
      'git status && curl evil',
      'git status | cat',
      'echo hi > out.txt',
      'echo `whoami`',
      'echo $(whoami)',
      'echo hi\nrm -rf /',
      'git branch -D main',
      'git branch newbranch',
      'git diff --output=leak.txt',
      'git log --output=leak.txt',
      'git push',
      'git -c core.pager=evil status',
      'node script.js',
      'node -e "1"',
      'npm install',
      'powershell -c x',
      './tool',
      'C:\\Windows\\System32\\cmd.exe',
      'cat ../outside.txt',
      'cat .env',
      'cat .git/config',
      'ls -R',
      'echo "unterminated',
    ]) {
      assert.equal(bridge.classifyCommandTier(line), 2, JSON.stringify(line));
    }
  });

  test('derives the tier from args too, not just the command field', () => {
    assert.equal(bridge.classifyCommandTier('echo', ['hi; rm -rf /']), 2);
    assert.equal(bridge.classifyCommandTier('git', ['status', ';', 'rm']), 2);
    assert.equal(bridge.classifyCommandTier('rm', ['-rf', 'x']), 2);
    assert.equal(bridge.classifyCommandTier('git', ['log', '-n', '3']), 1);
    assert.equal(bridge.classifyCommandTier('git', ['status', '--porcelain']), 1);
  });

  test('confines Tier 1 file access to the workspace and treats a foreign cwd as Tier 2', () => {
    assert.equal(bridge.classifyCommand({ command: 'cat', args: [path.join(workspace, 'notes.txt')] }).tier, 1);
    assert.equal(bridge.classifyCommand({ command: 'ls', args: [os.tmpdir()] }).tier, 2);
    assert.equal(bridge.classifyCommand({ command: 'git status', cwd: os.homedir() }).tier, 2);
  });

  test('blocks Tier 2 commands without owner approval, whatever tier the caller claims', async () => {
    await assert.rejects(bridge.executeCommand({ command: 'del test.txt', tier: 2 }, false), /Tier 2/);
    await assert.rejects(bridge.executeCommand({ command: 'rm', args: ['-rf', 'x'], tier: 1 }, false), /Tier 2/);
    await assert.rejects(bridge.executeCommand({ command: 'git status; rm -rf /', tier: 1 }, false), /Tier 2/);
    await assert.rejects(bridge.executeCommand({ command: 'echo hi', tier: 2 }, false), /Tier 2/);
  });

  test('executes shell-free Tier 1 builtins against the workspace', async () => {
    const echo = await bridge.executeCommand({ command: 'echo "hello jarvis"' });
    assert.equal(echo.exitCode, 0);
    assert.equal(echo.stdout, 'hello jarvis');

    const echoArgs = await bridge.executeCommand({ command: 'echo', args: ['a b', 'c'] });
    assert.equal(echoArgs.stdout, 'a b c');

    const listing = await bridge.executeCommand({ command: 'ls' });
    assert.deepEqual(listing.stdout.split('\n'), ['notes.txt', 'sub/']);

    const hidden = await bridge.executeCommand({ command: 'ls', args: ['-a'] });
    assert.ok(hidden.stdout.includes('.env'));

    const cat = await bridge.executeCommand({ command: 'cat', args: ['notes.txt'] });
    assert.equal(cat.stdout, 'hello notes');

    const missing = await bridge.executeCommand({ command: 'cat', args: ['missing.txt'] });
    assert.notEqual(missing.exitCode, 0);
  });

  test('caps Tier 1 file output', async () => {
    const big = path.join(workspace, 'big.txt');
    fs.writeFileSync(big, 'x'.repeat(5000));
    const small = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'linux', maxOutputBytes: 100 });
    const res = await small.executeCommand({ command: 'cat', args: ['big.txt'] });
    assert.equal(res.truncated, true);
    assert.ok(res.stdout.length <= 100);
  });

  test('runs git without a shell, with fixed hardening flags, and clamps the timeout', async () => {
    const { runner, calls } = recordingRunner();
    const b = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'linux', runProcess: runner });
    const res = await b.executeCommand({ command: 'git status -s', timeoutMs: 9_999_999 });
    assert.equal(res.stdout, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'git');
    assert.deepEqual(calls[0].args, ['-c', 'core.fsmonitor=false', '--no-pager', 'status', '-s']);
    assert.equal(calls[0].options.shell, false);
    assert.ok(calls[0].options.timeoutMs <= 60_000);

    await b.executeCommand({ command: 'git', args: ['diff', '--cached'] });
    assert.ok(calls[1].args.includes('--no-ext-diff'));
  });

  test('uses the .cmd shims for npm/pnpm on Windows only for the fixed version probe', async () => {
    const { runner, calls } = recordingRunner({ stdout: '10.0.0' });
    const b = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'win32', runProcess: runner });
    await b.executeCommand({ command: 'npm -v' });
    assert.equal(calls[0].file, 'npm.cmd');
    assert.deepEqual(calls[0].args, ['-v']);
    assert.equal(calls[0].options.shell, true);
    await b.executeCommand({ command: 'node -v' });
    assert.equal(calls[1].file, 'node');
    assert.equal(calls[1].options.shell, false);
  });

  test('runs approved Tier 2 lines through the shell path and reports timeouts and truncation', async () => {
    const { runner, calls } = recordingRunner({ exitCode: 1, timedOut: true, truncated: true, stdout: 'y'.repeat(300) });
    const b = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'linux', runProcess: runner, maxOutputBytes: 100 });
    const res = await b.executeCommand({ command: 'rm', args: ['-rf', 'build'] }, true);
    assert.equal(calls[0].file, 'rm -rf build');
    assert.equal(calls[0].options.shell, true);
    assert.equal(res.timedOut, true);
    assert.equal(res.truncated, true);
    assert.ok(res.stdout.length <= 100);
  });

  test('a caller-claimed Tier 2 on an allowlisted command still runs shell-free once approved', async () => {
    const { runner, calls } = recordingRunner();
    const b = new HostBridge(undefined, { workspaceRoot: workspace, platform: 'linux', runProcess: runner });
    await b.executeCommand({ command: 'git status', tier: 2 }, true);
    assert.equal(calls[0].file, 'git');
    assert.equal(calls[0].options.shell, false);
  });
});

describe('HostBridge screen state', () => {
  test('reports unavailable (not a canned window) off Windows', async () => {
    const screen = await new HostBridge(undefined, { platform: 'darwin' }).getScreenState();
    assert.equal(screen.activeWindow, null);
    assert.equal(screen.resolution, null);
    assert.match(screen.unavailableReason ?? '', /Windows/);
    assert.equal(screen.isUntrusted, true);
  });

  test('reads the real foreground window and resolution on Windows via a fixed encoded PowerShell script', async () => {
    const { runner, calls } = recordingRunner({
      stdout: JSON.stringify({ title: 'Inbox \u0007- Mail', width: 2560, height: 1600 }),
    });
    const screen = await new HostBridge(undefined, { platform: 'win32', runProcess: runner }).getScreenState();
    assert.equal(calls[0].file, 'powershell.exe');
    assert.ok(calls[0].args.includes('-EncodedCommand'));
    assert.equal(calls[0].options.shell, false);
    assert.equal(screen.activeWindow, 'Inbox - Mail');
    assert.deepEqual(screen.resolution, { width: 2560, height: 1600 });
    assert.equal(screen.unavailableReason, undefined);
    assert.equal(screen.isUntrusted, true);
  });

  test('degrades honestly when PowerShell fails or returns garbage', async () => {
    const failing = await new HostBridge(undefined, { platform: 'win32', runProcess: recordingRunner({ exitCode: 1 }).runner }).getScreenState();
    assert.equal(failing.activeWindow, null);
    assert.equal(failing.resolution, null);
    assert.ok(failing.unavailableReason);

    const garbage = await new HostBridge(undefined, { platform: 'win32', runProcess: recordingRunner({ stdout: 'not json' }).runner }).getScreenState();
    assert.equal(garbage.activeWindow, null);
    assert.ok(garbage.unavailableReason);

    const throwing = await new HostBridge(undefined, {
      platform: 'win32',
      runProcess: async () => {
        throw new Error('spawn denied');
      },
    }).getScreenState();
    assert.match(throwing.unavailableReason ?? '', /spawn denied/);
  });
});
