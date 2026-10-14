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
  confidence: number;
  wordCount: number;
  isUntrusted: boolean;
}

export interface FrameSample {
  frameIndex: number;
  timestampSec: number;
  description: string;
}
