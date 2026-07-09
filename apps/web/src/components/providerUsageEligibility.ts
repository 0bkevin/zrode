import type { ServerProvider } from "@t3tools/contracts";

export interface UnmeteredProviderEligibilityInput {
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProvider["status"];
  readonly auth: Pick<ServerProvider["auth"], "status">;
  readonly availability?: ServerProvider["availability"];
}

export function isUnmeteredProviderEligible(provider: UnmeteredProviderEligibilityInput): boolean {
  if (!provider.enabled || !provider.installed || provider.availability === "unavailable") {
    return false;
  }
  if (provider.auth.status === "authenticated") {
    return true;
  }
  return (
    provider.driver === "devin" &&
    provider.status === "ready" &&
    provider.auth.status !== "unauthenticated"
  );
}
