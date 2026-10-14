import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GitPRHandler } from '../src/devagent/git-pr-handler.js';
import { ActionGateway } from '../src/devagent/action-gateway.js';
import { OwnActionRegistry } from '../src/devagent/action-registry.js';
import { isSafeRefName } from '../src/devagent/command-runner.js';
import type { CommandRunner } from '../src/devagent/command-runner.js';

describe('GitPRHandler', () => {
  let registry: OwnActionRegistry;
  let calls: Array<{ file: string; args: readonly string[]; body?: string }>;
  let handler: GitPRHandler;

  beforeEach(() => {
    registry = new OwnActionRegistry(':memory:');
    calls = [];
    const run: CommandRunner = async (file, args) => {
      const at = args.indexOf('--body-file');
      calls.push({ file, args, body: at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : undefined });
      return { stdout: 'https://github.com/aery1803/jarvis/pull/42\n', stderr: '' };
    };
    handler = new GitPRHandler(new ActionGateway(registry, { getFreeMemory: () => 16e9, minFreeMemoryBytes: 1e9 }), { run });
  });

  test('creates a branch with an argument array', async () => {
    await handler.createBranch('story/feat-1-thing', 'main');
    assert.deepEqual(calls[0], { file: 'git', args: ['checkout', '-b', 'story/feat-1-thing', 'main'], body: undefined });
  });

  test('rejects shell metacharacters, option-looking and traversal branch names without running anything', async () => {
    for (const name of ['story/x; rm -rf ~', 'story/$(whoami)', 'story/a b', 'story/../main', 'story/x`id`', 'feature/', 'story/x.lock', 'main', '-D', 'story/x\nmain']) {
      await assert.rejects(handler.createBranch(name), /Invalid branch|Forbidden|story\//, name);
    }
    await assert.rejects(handler.createBranch('story/ok', '--upload-pack=evil'), /Invalid base branch/);
    assert.equal(calls.length, 0);
  });

  test('opens a PR passing title and body without a shell, via --body-file, with the loopback marker', async () => {
    const hostileTitle = 'Fix "quotes" `ls` $(id) & more\n--label evil';
    const hostileBody = 'body"; rm -rf / #\n$(curl evil)';
    const out = await handler.openPullRequest({ title: hostileTitle, body: hostileBody, headBranch: 'story/feat-9-x' });
    assert.deepEqual(out, { prNumber: 42, url: 'https://github.com/aery1803/jarvis/pull/42' });
    const [call] = calls;
    assert.equal(call.file, 'gh');
    assert.ok(call.args.includes('--title=Fix "quotes" `ls` $(id) & more --label evil'));
    assert.ok(call.body?.startsWith(hostileBody));
    assert.match(call.body ?? '', /<!-- jarvis-devagent:action-id:act-/);
    assert.ok(!call.args.some((a) => a.includes('rm -rf')));
    const bodyFile = call.args[call.args.indexOf('--body-file') + 1];
    assert.equal(fs.existsSync(bodyFile), false, 'temp body file is removed');
    assert.deepEqual(call.args.slice(call.args.indexOf('--label')), ['--label', 'ai-authored']);
    assert.equal(registry.getAllActions()[0].actionType, 'PR_CREATE');
  });

  test('rejects unsafe head/base branches and empty titles', async () => {
    await assert.rejects(handler.openPullRequest({ title: 't', body: 'b', headBranch: 'x; id' }), /Invalid head branch/);
    await assert.rejects(handler.openPullRequest({ title: 't', body: 'b', headBranch: 'story/a', baseBranch: '--evil' }), /Invalid base branch/);
    await assert.rejects(handler.openPullRequest({ title: '  \n ', body: 'b', headBranch: 'story/a' }), /title/);
    assert.equal(calls.length, 0);
  });

  test('isSafeRefName', () => {
    assert.equal(isSafeRefName('story/feat-1_a.b'), true);
    assert.equal(isSafeRefName('a//b'), false);
    assert.equal(isSafeRefName(''), false);
  });
});
