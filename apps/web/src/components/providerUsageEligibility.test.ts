import { describe, expect, it } from "vite-plus/test";

import {
  isUnmeteredProviderEligible,
  type UnmeteredProviderEligibilityInput,
} from "./providerUsageEligibility";

function provider(
  overrides: Partial<UnmeteredProviderEligibilityInput>,
): UnmeteredProviderEligibilityInput {
  return {
    driver: "cursor",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    ...overrides,
  };
}

describe("isUnmeteredProviderEligible", () => {
  it("keeps existing providers gated on authenticated auth", () => {
    expect(isUnmeteredProviderEligible(provider({ driver: "cursor" }))).toBe(true);
    expect(
      isUnmeteredProviderEligible(provider({ driver: "cursor", auth: { status: "unknown" } })),
    ).toBe(false);
    expect(
      isUnmeteredProviderEligible(provider({ driver: "opencode", auth: { status: "unknown" } })),
    ).toBe(false);
  });

  it("allows ready Devin snapshots when auth is unknown", () => {
    expect(
      isUnmeteredProviderEligible(provider({ driver: "devin", auth: { status: "unknown" } })),
    ).toBe(true);
  });

  it("does not show unavailable or unauthenticated Devin snapshots", () => {
    expect(
      isUnmeteredProviderEligible(
        provider({ driver: "devin", status: "warning", auth: { status: "unknown" } }),
      ),
    ).toBe(false);
    expect(
      isUnmeteredProviderEligible(
        provider({ driver: "devin", auth: { status: "unauthenticated" } }),
      ),
    ).toBe(false);
    expect(
      isUnmeteredProviderEligible(
        provider({
          driver: "devin",
          availability: "unavailable",
          auth: { status: "unknown" },
        }),
      ),
    ).toBe(false);
  });
});
