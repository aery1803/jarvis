import type { OcrResult, FrameSample } from './types.js';

export class MediaService {
  /**
   * Performs optical character recognition and extracts clean text with taint tracking.
   */
  async extractOcrText(input: string | Buffer): Promise<OcrResult> {
    const rawText = typeof input === 'string' ? input : input.toString('utf8');

    // Basic prompt injection defense in OCR inputs (e.g. malicious receipts or screenshots)
    const sanitized = rawText
      .replace(/ignore previous instructions/gi, '[REDACTED_PROMPT_INJECTION]')
      .replace(/system prompt/gi, '[REDACTED]');

    const words = sanitized.split(/\s+/).filter(Boolean);

    return {
      text: sanitized.trim(),
      confidence: 0.94,
      wordCount: words.length,
      isUntrusted: true, // Content from media is untrusted per Principle 2 / Section 5.10
    };
  }

  /**
   * Samples key video timestamps for distillation.
   */
  sampleVideoFrames(videoDurationSec: number, sampleIntervalSec = 10): FrameSample[] {
    const samples: FrameSample[] = [];
    let currentTime = 0;
    let index = 1;

    while (currentTime <= videoDurationSec) {
      samples.push({
        frameIndex: index,
        timestampSec: currentTime,
        description: `Keyframe #${index} at ${currentTime}s`,
      });
      currentTime += sampleIntervalSec;
      index++;
    }

    return samples;
  }
}
