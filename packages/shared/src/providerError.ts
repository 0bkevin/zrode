const INTERNAL_PROVIDER_DIAGNOSTIC = /(?:^|:\s*)\[ede_diagnostic\](?:\s|$)/i;
const UNSAFE_RESPONSE_MARKUP = /(?:<!doctype\s+html\b|<(?:html|head|body|script|style)\b)/i;
const RAW_RESPONSE_METADATA =
  /(?:\bcontent-type\s*[:=]|(?:^|[;\r\n]\s*)(?:body|response(?:[ _-]?body)?)\s*[:=])/i;
const HTTP_STATUS_ERROR =
  /(?:unexpected\s+status(?:\s+code)?|status(?:\s+code)?|http(?:\s+status)?|failed)\s*[:=]?\s*(\d{3})(?:\s+([^:;,\r\n<]+?))?(?=\s*(?:[:;,]|$))/i;
const SAFE_HTTP_STATUS_TEXT =
  /^(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Method Not Allowed|Not Acceptable|Request Timeout|Conflict|Gone|Payload Too Large|URI Too Long|Unsupported Media Type|Unprocessable Content|Too Many Requests|Internal Server Error|Not Implemented|Bad Gateway|Service Unavailable|Gateway Timeout|Network Authentication Required)$/i;
const DEFAULT_MAX_LENGTH = 500;

export interface NormalizeProviderErrorMessageOptions {
  readonly fallback?: string;
  readonly requestSubject?: string;
  readonly maxLength?: number;
}

export function isInternalProviderDiagnosticMessage(message: string): boolean {
  return INTERNAL_PROVIDER_DIAGNOSTIC.test(message.trim());
}

function compactAndBoundMessage(message: string, maxLength: number): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
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
  const requestedMaxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const maxLength = Number.isFinite(requestedMaxLength)
    ? Math.max(1, Math.floor(requestedMaxLength))
    : DEFAULT_MAX_LENGTH;
  if (isInternalProviderDiagnosticMessage(normalized)) {
    return fallback;
  }

  if (UNSAFE_RESPONSE_MARKUP.test(normalized) || RAW_RESPONSE_METADATA.test(normalized)) {
    const httpStatus = normalized.match(HTTP_STATUS_ERROR);
    if (httpStatus) {
      const status = httpStatus[1];
      const statusTextCandidate = httpStatus[2]
        ? compactAndBoundMessage(httpStatus[2], 80)
        : undefined;
      const statusText =
        statusTextCandidate && SAFE_HTTP_STATUS_TEXT.test(statusTextCandidate)
          ? statusTextCandidate
          : undefined;
      const subject = options.requestSubject?.trim() || "Provider request";
      return `${subject} failed: ${status}${statusText ? ` ${statusText}` : ""}.`;
    }

    return fallback;
  }

  return compactAndBoundMessage(normalized, maxLength);
}
