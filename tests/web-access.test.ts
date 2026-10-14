/**
 * Unit Tests: Web UI LAN Access Policy
 * Authority: FEAT-004
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeBinding, isClientAllowed, isHostHeaderAllowed, isOriginAllowed, isLoopbackAddress, normalizeAddress, parseAllowedIps } from '../src/web/access.js';
import { JarvisWebServer } from '../src/web/server.js';
import { ChatStore } from '../src/storage/chat-store.js';

describe('web access policy', () => {
  test('normalizes IPv4-mapped IPv6 addresses', () => {
    assert.equal(normalizeAddress('::ffff:192.168.1.20'), '192.168.1.20');
    assert.equal(normalizeAddress(' 192.168.1.20 '), '192.168.1.20');
    assert.equal(normalizeAddress(undefined), '');
  });

  test('recognizes loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) assert.equal(isLoopbackAddress(a), true, a);
    for (const a of ['0.0.0.0', '192.168.1.20', '10.0.0.5', '']) assert.equal(isLoopbackAddress(a), false, a);
  });

  test('parses a comma or space separated allowlist', () => {
    assert.deepEqual(parseAllowedIps('192.168.1.20, 192.168.1.21 ::ffff:10.0.0.4'), ['192.168.1.20', '192.168.1.21', '10.0.0.4']);
    assert.deepEqual(parseAllowedIps(undefined), []);
    assert.deepEqual(parseAllowedIps(''), []);
  });

  test('allows loopback always, and LAN clients only when allowlisted', () => {
    const allowed = ['192.168.1.20'];
    assert.equal(isClientAllowed('127.0.0.1', allowed), true);
    assert.equal(isClientAllowed('::ffff:192.168.1.20', allowed), true);
    assert.equal(isClientAllowed('192.168.1.99', allowed), false);
    assert.equal(isClientAllowed(undefined, allowed), false);
    assert.equal(isClientAllowed('192.168.1.20', []), false);
  });

  test('matches IPv4 CIDR ranges and exact IPs', () => {
    const allowed = ['192.168.1.0/24', '10.1.2.3'];
    assert.equal(isClientAllowed('192.168.1.77', allowed), true);
    assert.equal(isClientAllowed('::ffff:192.168.1.255', allowed), true);
    assert.equal(isClientAllowed('192.168.2.1', allowed), false);
    assert.equal(isClientAllowed('10.1.2.3', allowed), true);
    assert.equal(isClientAllowed('10.1.2.4', allowed), false);
    assert.equal(isClientAllowed('172.16.5.5', ['172.16.0.0/12']), true);
    assert.equal(isClientAllowed('172.32.0.1', ['172.16.0.0/12']), false);
    assert.equal(isClientAllowed('fe80::1', ['192.168.1.0/24']), false);
  });

  test('nonsense allowlist entries are rejected loudly', () => {
    for (const bad of ['192.168.1.0/33', '0.0.0.0/0', 'example.com', '192.168.1/24', 'fe80::/10', '1.2.3.4/x', '999.1.1.1']) {
      assert.throws(() => parseAllowedIps(bad), /Invalid JARVIS_WEB_ALLOWED_IPS/, bad);
    }
    assert.deepEqual(parseAllowedIps('192.168.1.0/24, ::1'), ['192.168.1.0/24', '::1']);
    assert.throws(() => assertSafeBinding('0.0.0.0', ['nope']), /Invalid/);
  });

  test('host and origin checks', () => {
    assert.equal(isHostHeaderAllowed('localhost:3000', '127.0.0.1', []), true);
    assert.equal(isHostHeaderAllowed('192.168.1.5:3000', '0.0.0.0', []), true);
    assert.equal(isHostHeaderAllowed('[::1]:3000', '127.0.0.1', []), true);
    assert.equal(isHostHeaderAllowed('evil.example', '127.0.0.1', []), false);
    assert.equal(isHostHeaderAllowed('jarvis.lan:3000', '0.0.0.0', ['http://jarvis.lan:3000']), true);
    assert.equal(isHostHeaderAllowed(undefined, '127.0.0.1', []), false);
    assert.equal(isOriginAllowed('http://127.0.0.1:3000', '127.0.0.1:3000', []), true);
    assert.equal(isOriginAllowed('http://evil.example', '127.0.0.1:3000', []), false);
    assert.equal(isOriginAllowed('null', '127.0.0.1:3000', []), false);
    assert.equal(isOriginAllowed('http://jarvis.lan:3000', '127.0.0.1:3000', ['http://jarvis.lan:3000']), true);
  });

  test('binding beyond loopback requires an allowlist', () => {
    assert.doesNotThrow(() => assertSafeBinding('127.0.0.1', []));
    assert.throws(() => assertSafeBinding('0.0.0.0', []), /JARVIS_WEB_ALLOWED_IPS/);
    assert.doesNotThrow(() => assertSafeBinding('0.0.0.0', ['192.168.1.20']));
  });

  test('the web server refuses to start on a LAN address without an allowlist', async () => {
    const server = new JarvisWebServer({ port: 3097, host: '0.0.0.0', allowedIps: [], chatStore: new ChatStore(':memory:') });
    await assert.rejects(server.start(), /JARVIS_WEB_ALLOWED_IPS/);
    await server.stop();
  });
});
