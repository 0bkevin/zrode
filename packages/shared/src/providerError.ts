const INTERNAL_PROVIDER_DIAGNOSTIC = /(?:^|:\s*)\[ede_diagnostic\](?:\s|$)/i;
const HTML_DOCUMENT = /(?:^|:\s*)(?:<!doctype\s+html\b|<html\b)/i;
const HTML_STATUS_ERROR =
  /unexpected status(?:\s+code)?\s+(\d{3})(?:\s+([^:\r\n<]+?))?\s*:\s*(?:<!doctype\s+html\b|<html\b)/i;

export interface NormalizeProviderErrorMessageOptions {
  readonly fallback?: string;
  readonly requestSubject?: string;
}

export function isInternalProviderDiagnosticMessage(message: string): boolean {
  return INTERNAL_PROVIDER_DIAGNOSTIC.test(message.trim());
}

/**
 * Normalize provider-authored text before it reaches persistent user-facing
 * state or notification UI. Native event logs retain the original payload.
 */
export function normalizeProviderErrorMessage(
  message: string | null | undefined,
  options: NormalizeProviderErrorMessageOptions = {},
): string | null {
  const normalized = message?.trim();
  if (!normalized) {
    return null;
  }

  const fallback = options.fallback?.trim() || "Provider request failed.";
  if (isInternalProviderDiagnosticMessage(normalized)) {
    return fallback;
  }

  const htmlStatus = normalized.match(HTML_STATUS_ERROR);
  if (htmlStatus) {
    const status = htmlStatus[1];
    const statusText = htmlStatus[2]?.trim();
    const subject = options.requestSubject?.trim() || "Provider request";
    return `${subject} failed: ${status}${statusText ? ` ${statusText}` : ""}.`;
  }

  return HTML_DOCUMENT.test(normalized) ? fallback : normalized;
}
