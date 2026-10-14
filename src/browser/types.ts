export interface DistilledElement {
  role: string;
  name?: string;
  /** `#id`, `tag[name="x"]`, `a[href="x"]`, else Playwright-style `tag >> nth=k` (k = document-order index of that tag). */
  selector?: string;
  text?: string;
  href?: string;
  isClickable?: boolean;
  isInput?: boolean;
  inputType?: string;
  /** True when the element sits inside a `<form>`, so activating it can submit that form. */
  inForm?: boolean;
}

export interface DistilledForm {
  action?: string;
  method: string;
  fields: string[];
}

export interface DistilledPageView {
  url: string;
  title: string;
  elements: DistilledElement[];
  forms?: DistilledForm[];
  isUntrusted: boolean; // Always true for web pages
  extractedText: string;
  /** `extractedText` inside an `<untrusted_data>` fence, ready for a prompt. */
  fencedText?: string;
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

export interface BrowserDriverPage {
  url: string;
  title: string;
  html: string;
}

export interface BrowserDriverResult {
  success: boolean;
  message?: string;
}

/** A real browser (e.g. Playwright) the owner can plug in; without one only fetch-based navigation is available. */
export interface BrowserDriver {
  navigate(url: string): Promise<BrowserDriverPage>;
  click(selector: string): Promise<BrowserDriverResult>;
  fill(selector: string, value: string): Promise<BrowserDriverResult>;
  press(key: string, selector?: string): Promise<BrowserDriverResult>;
  wait(options: { selector?: string; timeoutMs: number }): Promise<BrowserDriverResult>;
  content(): Promise<BrowserDriverPage>;
}
