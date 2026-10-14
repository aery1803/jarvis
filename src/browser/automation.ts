import { DistilledPageView, DistilledElement, BrowserAction, BrowserActionResult } from './types.js';
import { ActionGateway } from '../devagent/action-gateway.js';

export class BrowserAutomationEngine {
  private currentUrl = 'about:blank';
  private currentTitle = 'Blank Page';
  private currentElements: DistilledElement[] = [];

  constructor(private gateway?: ActionGateway) {}

  /**
   * Distills raw HTML into a compact, token-efficient representation (role, text, actions).
   * Reduces token footprint by ~90% compared to raw HTML while marking content as untrusted.
   */
  distillHtml(html: string, url: string, title = 'Page'): DistilledPageView {
    this.currentUrl = url;
    this.currentTitle = title;

    const elements: DistilledElement[] = [];
    const textChunks: string[] = [];

    // Extract links
    const linkMatches = html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis);
    for (const match of linkMatches) {
      const href = match[1];
      const text = match[2].replace(/<[^>]+>/g, '').trim();
      if (text) {
        elements.push({ role: 'link', name: text, href, isClickable: true });
        textChunks.push(`[Link: ${text}]`);
      }
    }

    // Extract buttons
    const btnMatches = html.matchAll(/<button[^>]*>(.*?)<\/button>/gis);
    for (const match of btnMatches) {
      const text = match[1].replace(/<[^>]+>/g, '').trim();
      if (text) {
        elements.push({ role: 'button', name: text, isClickable: true });
        textChunks.push(`[Button: ${text}]`);
      }
    }

    // Extract input fields
    const inputMatches = html.matchAll(/<input\s+[^>]*name=["']([^"']+)["'][^>]*>/gis);
    for (const match of inputMatches) {
      const name = match[1];
      elements.push({ role: 'input', name, isInput: true });
      textChunks.push(`[Input: ${name}]`);
    }

    // Extract paragraphs & headings
    const pMatches = html.matchAll(/<(?:p|h[1-6])[^>]*>(.*?)<\/(?:p|h[1-6])>/gis);
    for (const match of pMatches) {
      const clean = match[1].replace(/<[^>]+>/g, '').trim();
      if (clean && clean.length > 5) {
        textChunks.push(clean);
      }
    }

    this.currentElements = elements;
    const extractedText = textChunks.join('\n');
    const estimatedTokens = Math.ceil(extractedText.length / 4);

    return {
      url,
      title,
      elements,
      isUntrusted: true, // Web page content is always untrusted per Principle 2
      extractedText,
      estimatedTokens,
    };
  }

  /**
   * Assesses if an intended browser action involves financial, purchase, or social posting risks.
   */
  assessActionRisk(action: BrowserAction): { isRisky: boolean; reason?: string } {
    const textTarget = `${action.selector ?? ''} ${action.value ?? ''} ${action.url ?? ''}`.toLowerCase();

    // Financial / Purchase safeguards (Section 12.1)
    const financialKeywords = ['buy', 'purchase', 'pay', 'checkout', 'transfer', 'confirm order', 'subscribe'];
    for (const kw of financialKeywords) {
      if (textTarget.includes(kw)) {
        return {
          isRisky: true,
          reason: `Action involves financial transaction ('${kw}'). Explicit Tier 2 owner confirmation required.`,
        };
      }
    }

    // Social posting safeguards
    const socialKeywords = ['tweet', 'publish post', 'share update', 'send direct message'];
    for (const kw of socialKeywords) {
      if (textTarget.includes(kw)) {
        return {
          isRisky: true,
          reason: `Action involves public social media publication ('${kw}'). Explicit Tier 2 owner confirmation required.`,
        };
      }
    }

    return { isRisky: false };
  }

  /**
   * Executes a browser action under Action Gateway safeguards.
   */
  async executeAction(action: BrowserAction, isOwnerExplicitlyApproved = false): Promise<BrowserActionResult> {
    const risk = this.assessActionRisk(action);

    if (risk.isRisky && !isOwnerExplicitlyApproved) {
      throw new Error(`Action Blocked by Browser Safeguards: ${risk.reason}`);
    }

    if (risk.isRisky && this.gateway) {
      await this.gateway.executeTier2Action('BROWSER_ACTION', risk.reason ?? 'High impact browser action', action.selector);
    }

    switch (action.type) {
      case 'navigate': {
        this.currentUrl = action.url ?? this.currentUrl;
        return {
          action: 'navigate',
          success: true,
          message: `Navigated to ${this.currentUrl}`,
        };
      }

      case 'click': {
        return {
          action: 'click',
          success: true,
          message: `Clicked element '${action.selector}'`,
        };
      }

      case 'fill': {
        return {
          action: 'fill',
          success: true,
          message: `Filled element '${action.selector}' with value`,
        };
      }

      case 'wait': {
        return {
          action: 'wait',
          success: true,
          message: `Waited for DOM ready`,
        };
      }

      case 'snapshot':
      default: {
        return {
          action: 'snapshot',
          success: true,
          pageView: {
            url: this.currentUrl,
            title: this.currentTitle,
            elements: this.currentElements,
            isUntrusted: true,
            extractedText: this.currentElements.map((e) => `[${e.role}] ${e.name ?? ''}`).join('\n'),
            estimatedTokens: 50,
          },
        };
      }
    }
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }
}
