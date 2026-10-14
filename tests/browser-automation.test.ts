import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAutomationEngine } from '../src/browser/automation.js';

describe('BrowserAutomationEngine & Safeguards', () => {
  const engine = new BrowserAutomationEngine();

  test('should distill raw HTML into a token-efficient representation', () => {
    const rawHtml = `
      <html>
        <head><title>Shopping Store</title></head>
        <body>
          <h1>Welcome to Store</h1>
          <p>Explore our latest gadgets and electronics today.</p>
          <a href="/products">View Products</a>
          <input name="search_query" />
          <button>Submit Search</button>
        </body>
      </html>
    `;

    const distilled = engine.distillHtml(rawHtml, 'https://example.com/store', 'Shopping Store');
    assert.equal(distilled.url, 'https://example.com/store');
    assert.equal(distilled.isUntrusted, true);
    assert.equal(distilled.elements.length, 3); // link, input, button
    assert.ok(distilled.elements.some((e) => e.role === 'link' && e.name === 'View Products'));
    assert.ok(distilled.elements.some((e) => e.role === 'input' && e.name === 'search_query'));
    assert.ok(distilled.elements.some((e) => e.role === 'button' && e.name === 'Submit Search'));
    assert.ok(distilled.estimatedTokens < 100);
  });

  test('should detect financial/purchase risks and block autonomous execution', async () => {
    const riskyAction = {
      type: 'click' as const,
      selector: '#btn-checkout-pay-now',
      value: 'Confirm Purchase',
    };

    const risk = engine.assessActionRisk(riskyAction);
    assert.equal(risk.isRisky, true);
    assert.ok(risk.reason?.includes('financial'));

    // Executing without owner approval should throw
    await assert.rejects(
      async () => {
        await engine.executeAction(riskyAction, false);
      },
      (err: Error) => {
        assert.ok(err.message.includes('Action Blocked'));
        return true;
      }
    );
  });

  test('should allow benign browser actions autonomously', async () => {
    const navResult = await engine.executeAction({
      type: 'navigate',
      url: 'https://docs.local.io',
    });
    assert.equal(navResult.success, true);
    assert.equal(engine.getCurrentUrl(), 'https://docs.local.io');

    const clickResult = await engine.executeAction({
      type: 'click',
      selector: '#btn-next-page',
    });
    assert.equal(clickResult.success, true);
  });
});
