import { z } from 'zod';
import type { OcrResult, FrameSample, ImageDescription, VisionOptions } from './types.js';
import { ContentDistiller } from '../services/scraper.js';
import { fenceUntrusted, stripControlChars } from '../bridge/untrusted.js';

/** Largest image accepted for vision analysis; stays under Telegram's 10 MB photo upload limit. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_FRAME_SAMPLES = 500;
const MAX_DESCRIPTION_CHARS = 8000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_VISION_PROMPT = 'Describe this image in detail and transcribe any visible text exactly.';

/** Vision-capable Ollama model families, best first. Matched against installed tags only, never assumed present. */
const VISION_MODEL_PRIORITY: RegExp[] = [
  /(^|[^a-z])qwen[\w.]*?-?vl([^a-z]|$)/i,
  /minicpm-v/i,
  /llama3\.2-vision/i,
  /llava/i,
  /granite[\w.]*-vision/i,
  /gemma3/i,
  /moondream/i,
  /(^|[^a-z])vl([^a-z]|$)/i,
];

const OllamaTagsSchema = z.object({ models: z.array(z.object({ name: z.string() })).optional() });
const OllamaGenerateSchema = z.object({ response: z.string().optional(), error: z.string().optional() });

function detectImageType(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]): boolean => sig.every((value, index) => bytes[index] === value);
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpeg';
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

export function pickVisionModel(installed: string[]): string | null {
  const candidates = installed.filter((name) => !/embed/i.test(name));
  for (const pattern of VISION_MODEL_PRIORITY) {
    const match = candidates.find((name) => pattern.test(name));
    if (match) return match;
  }
  return null;
}

export type MediaServiceOptions = VisionOptions;

export class MediaService {
  private readonly distiller = new ContentDistiller();

  constructor(private readonly defaults: MediaServiceOptions = {}) {}

  /**
   * Sanitises text that already came from an OCR engine or vision model. It does not recognise text in images
   * (use `describeImage`) and never invents a confidence: pass the engine's own value in `meta.confidence`.
   */
  async extractOcrText(input: string | Buffer, meta: { confidence?: number } = {}): Promise<OcrResult> {
    if (typeof input !== 'string' && detectImageType(input)) {
      return {
        text: '',
        confidence: null,
        wordCount: 0,
        unavailableReason: 'raw image bytes are not OCR text; use describeImage with an installed vision model',
        isUntrusted: true,
      };
    }
    const rawText = typeof input === 'string' ? input : input.toString('utf8');

    const sanitized = this.sanitize(rawText);
    const words = sanitized.split(/\s+/).filter(Boolean);
    const confidence = typeof meta.confidence === 'number' && meta.confidence >= 0 && meta.confidence <= 1 ? meta.confidence : null;

    return {
      text: sanitized,
      confidence,
      wordCount: words.length,
      isUntrusted: true, // Content from media is untrusted per Principle 2 / Section 5.10
    };
  }

  /**
   * Asks a locally installed Ollama vision model to describe an image. Returns `{ available: false, reason }`
   * when Ollama is unreachable, no vision model is installed, or the image is unusable, and never invents text.
   */
  async describeImage(image: Buffer | Uint8Array, prompt?: string, options: VisionOptions = {}): Promise<ImageDescription> {
    const settings = { ...this.defaults, ...options };
    const unavailable = (reason: string): ImageDescription => ({ available: false, reason, isUntrusted: true });

    if (image.byteLength === 0) return unavailable('image is empty');
    if (image.byteLength > MAX_IMAGE_BYTES) {
      return unavailable(`image is ${image.byteLength} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`);
    }
    if (!detectImageType(image)) return unavailable('unsupported image format (expected PNG, JPEG, GIF or WebP)');

    const baseUrl = (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchImpl = settings.fetchImpl ?? fetch;
    const timeoutMs = settings.timeoutMs ?? 120_000;

    let installed: string[];
    try {
      const tagsResponse = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)) });
      if (!tagsResponse.ok) return unavailable(`Ollama /api/tags returned HTTP ${tagsResponse.status}`);
      const tags = OllamaTagsSchema.safeParse(await tagsResponse.json());
      if (!tags.success) return unavailable('Ollama /api/tags returned an unexpected response');
      installed = (tags.data.models ?? []).map((model) => model.name);
    } catch (err: unknown) {
      return unavailable(`Ollama is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }

    let model: string | null;
    if (settings.model) {
      model = installed.includes(settings.model) ? settings.model : null;
      if (!model) return unavailable(`requested vision model '${settings.model}' is not installed`);
    } else {
      model = pickVisionModel(installed);
      if (!model) return unavailable('no vision model is installed in Ollama (for example a qwen-vl, llava, minicpm-v or gemma3 tag)');
    }

    try {
      const response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: prompt?.trim() || DEFAULT_VISION_PROMPT,
          images: [Buffer.from(image).toString('base64')],
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return unavailable(`Ollama /api/generate returned HTTP ${response.status}`);
      const parsed = OllamaGenerateSchema.safeParse(await response.json());
      if (!parsed.success) return unavailable('Ollama /api/generate returned an unexpected response');
      if (parsed.data.error) return unavailable(`Ollama error: ${parsed.data.error}`);
      const text = this.sanitize(parsed.data.response ?? '').slice(0, MAX_DESCRIPTION_CHARS);
      if (!text) return unavailable(`model '${model}' returned no text`);
      return { available: true, text, fenced: fenceUntrusted('image_description', text, { model }), model, isUntrusted: true };
    } catch (err: unknown) {
      return unavailable(`vision request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Lists the timestamps to sample from a video. Descriptions are included only for frames that have an
   * attached, available vision result (keyed by `frameIndex`); nothing is described otherwise.
   */
  sampleVideoFrames(videoDurationSec: number, sampleIntervalSec = 10, visionResults?: ReadonlyMap<number, ImageDescription>): FrameSample[] {
    if (!Number.isFinite(videoDurationSec) || videoDurationSec < 0) throw new Error('Video duration must be a non-negative number of seconds.');
    if (!Number.isFinite(sampleIntervalSec) || sampleIntervalSec <= 0) throw new Error('Sample interval must be a positive number of seconds.');

    const samples: FrameSample[] = [];
    for (let index = 1, currentTime = 0; currentTime <= videoDurationSec && index <= MAX_VIDEO_FRAME_SAMPLES; index++, currentTime += sampleIntervalSec) {
      const vision = visionResults?.get(index);
      const sample: FrameSample = { frameIndex: index, timestampSec: currentTime, isUntrusted: true };
      if (vision?.available) sample.description = vision.text;
      samples.push(sample);
    }
    return samples;
  }

  private sanitize(raw: string): string {
    const stripped = stripControlChars(raw)
      .replace(/ignore previous instructions/gi, '[REDACTED_PROMPT_INJECTION]')
      .replace(/system prompt/gi, '[REDACTED]');
    return this.distiller.sanitizeForContext(stripped).trim();
  }
}
