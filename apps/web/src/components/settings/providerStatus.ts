import type { ServerProvider, ServerProviderVersionAdvisory } from "@t3tools/contracts";
import { normalizeProviderErrorMessage } from "@t3tools/shared/providerError";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

function providerStatusDetail(provider: ServerProvider, fallback: string | null): string | null {
  if (!provider.message) {
    return fallback;
  }
  const providerName = provider.displayName?.trim() || "Provider";
  const safeFallback = fallback ?? `${providerName} status could not be verified.`;
  return (
    normalizeProviderErrorMessage(provider.message, {
      fallback: safeFallback,
      requestSubject: `${providerName} status check`,
      maxLength: 240,
    }) ?? safeFallback
  );
}

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail: providerStatusDetail(
        provider,
        "This provider is installed but disabled for new sessions in Zrode.",
      ),
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: providerStatusDetail(provider, "CLI not detected on PATH."),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: providerStatusDetail(provider, null),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: providerStatusDetail(provider, null),
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail: providerStatusDetail(
        provider,
        "The provider is installed, but the server could not fully verify it.",
      ),
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: providerStatusDetail(provider, "The provider failed its startup checks."),
    };
  }
  return {
    headline: "Available",
    detail: providerStatusDetail(
      provider,
      "Installed and ready, but authentication could not be verified.",
    ),
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = "Update available";
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      normalizeProviderErrorMessage(advisory.message, {
        fallback: "Provider update information is temporarily unavailable.",
        requestSubject: "Provider update check",
        maxLength: 240,
      }) ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
