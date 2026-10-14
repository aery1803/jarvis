export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'document';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedText?: string;
  isUntrusted: boolean;
  createdAt: string;
}

export interface OcrResult {
  text: string;
  /** Only set when the OCR engine or model supplied one; never estimated here. */
  confidence: number | null;
  wordCount: number;
  /** Set when the input could not be treated as OCR text, with the reason. */
  unavailableReason?: string;
  isUntrusted: boolean;
}

export interface FrameSample {
  frameIndex: number;
  timestampSec: number;
  /** Present only when a vision result was attached for this frame. */
  description?: string;
  isUntrusted: true;
}

export type ImageDescription =
  | {
      available: true;
      text: string;
      /** `text` inside an `<untrusted_data>` fence, ready for a prompt. */
      fenced: string;
      model: string;
      isUntrusted: true;
    }
  | {
      available: false;
      reason: string;
      isUntrusted: true;
    };

export interface VisionOptions {
  baseUrl?: string;
  /** Must be one of the installed models; otherwise the best installed vision model is chosen. */
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts the Ollama requests (the kill switch and a closed request use it). */
  signal?: AbortSignal;
}
