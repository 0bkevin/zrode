import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

describe("deriveProviderInstanceConfigMap", () => {
  it("synthesizes the default Devin instance from legacy provider settings", () => {
    const devinDriver = ProviderDriverKind.make("devin");
    const devinId = defaultInstanceIdForDriver(devinDriver);
    const map = deriveProviderInstanceConfigMap(DEFAULT_SERVER_SETTINGS);

    expect(map[devinId]).toEqual({
      driver: devinDriver,
      config: DEFAULT_SERVER_SETTINGS.providers.devin,
    });
  });
});
