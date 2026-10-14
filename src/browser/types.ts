export interface DistilledElement {
  role: string;
  name?: string;
  selector?: string;
  text?: string;
  href?: string;
  isClickable?: boolean;
  isInput?: boolean;
}

export interface DistilledPageView {
  url: string;
  title: string;
  elements: DistilledElement[];
  isUntrusted: boolean; // Always true for web pages
  extractedText: string;
  estimatedTokens: number;
}

export interface BrowserAction {
  type: 'navigate' | 'click' | 'fill' | 'press' | 'wait' | 'snapshot';
  selector?: string;
  value?: string;
  url?: string;
  requiresTier2Approval?: boolean;
  approvalReason?: string;
}

export interface BrowserActionResult {
  action: BrowserAction['type'];
  success: boolean;
  message?: string;
  pageView?: DistilledPageView;
}
