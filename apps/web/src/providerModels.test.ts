import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSupportsImageAttachments } from "./providerModels";

describe("getProviderSupportsImageAttachments", () => {
  it("defaults legacy providers to supported and honors an explicit false capability", () => {
    const codex = ProviderInstanceId.make("codex");
    const grok = ProviderInstanceId.make("grok");
    const providers = [
      { instanceId: codex },
      { instanceId: grok, supportsImageAttachments: false },
    ];

    expect(getProviderSupportsImageAttachments(providers, codex)).toBe(true);
    expect(getProviderSupportsImageAttachments(providers, grok)).toBe(false);
    expect(getProviderSupportsImageAttachments(providers, ProviderInstanceId.make("missing"))).toBe(
      true,
    );
  });
});
