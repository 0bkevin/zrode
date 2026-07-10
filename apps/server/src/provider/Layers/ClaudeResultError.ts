import {
  isInternalProviderDiagnosticMessage,
  normalizeProviderErrorMessage,
} from "@t3tools/shared/providerError";

function normalizeClaudeResultError(error: string): string | null {
  const message = error.trim();
  if (message.length === 0 || isInternalProviderDiagnosticMessage(message)) {
    return null;
  }

  return normalizeProviderErrorMessage(message, {
    fallback: "Claude turn failed.",
    requestSubject: "Claude request",
  });
}

/**
 * Pick a user-facing failure from a Claude SDK result.
 *
 * Claude Code prepends `errors` with an internal EDE diagnostic that explains
 * why it classified the result as unsuccessful. The actionable error, when
 * present, follows that entry. Raw HTML response bodies are also reduced to
 * their HTTP status; provider-native logging still captures the complete SDK
 * result when diagnostics logging is enabled.
 */
export function claudeResultErrorMessage(errors: ReadonlyArray<string>): string {
  for (const error of errors) {
    const message = normalizeClaudeResultError(error);
    if (message) {
      return message;
    }
  }

  return "Claude turn failed.";
}
