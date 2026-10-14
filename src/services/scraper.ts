/**
 * Jarvis Local AI Agent: Web Scraper & Taint-Tracking Content Distiller
 * Authority: Principle 2 (Taint Tracking), Section 10, Section 18.1
 */

import { logger } from '../utils/logger.js';

export interface ExtractedContent {
  content: string;
  url: string;
  isUntrusted: true;
  extractedAt: string;
}

// Patterns commonly used in prompt injection payloads
const PROMPT_INJECTION_PATTERNS = [
  /system\s+override\s*:/gi,
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /disregard\s+(all\s+)?prior\s+instructions/gi,
  /you\s+are\s+now\s+an\s+unrestricted/gi,
  /jailbreak\s+mode/gi,
  /output\s+your\s+(api\s+)?(token|key|secret)/gi,
];

export class ContentDistiller {
  /**
   * Sanitizes text to neutralize potential prompt injection vectors.
   */
  public sanitizeForContext(rawText: string): string {
    let sanitized = rawText;
    for (const pattern of PROMPT_INJECTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, '[FLAGGED_INJECTION_PATTERN]');
    }
    return sanitized;
  }

  /**
   * Extracts clean, readable text from raw HTML with scripts/styles stripped.
   * Principle 2: Marks result with isUntrusted: true (Taint Tracking).
   */
  public extractText(html: string, url: string): ExtractedContent {
    // 1. Remove script, style, noscript, and iframe tags
    let clean = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    clean = clean.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');
    clean = clean.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');

    // 2. Convert common block tags to newlines
    clean = clean.replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n');

    // 3. Strip remaining HTML tags
    clean = clean.replace(/<[^>]+>/g, ' ');

    // 4. Decode HTML entities
    clean = clean
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // 5. Normalize whitespace and clean empty lines
    clean = clean
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');

    // 6. Neutralize injection patterns
    clean = this.sanitizeForContext(clean);

    return {
      content: clean,
      url,
      isUntrusted: true, // Principle 2 Law
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Fetches an external webpage and distills readable text.
   */
  public async fetchAndExtract(url: string, timeoutMs: number = 7_000): Promise<ExtractedContent> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisLocal/1.0',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const rawHtml = await response.text();
      return this.extractText(rawHtml, url);
    } catch (err: any) {
      logger.warn(`[ContentDistiller] Failed to fetch ${url}: ${err.message}`);
      return {
        content: `[Failed to retrieve page content: ${err.message}]`,
        url,
        isUntrusted: true,
        extractedAt: new Date().toISOString(),
      };
    }
  }
}
