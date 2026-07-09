import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

describe("Devin model metadata", () => {
  it("declares Devin display and default model metadata", () => {
    const devin = ProviderDriverKind.make("devin");

    expect(PROVIDER_DISPLAY_NAMES[devin]).toBe("Devin");
    expect(DEFAULT_MODEL_BY_PROVIDER[devin]).toBe("adaptive");
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[devin]).toBe("adaptive");
  });
});

describe("GitHub Copilot model metadata", () => {
  it("declares GitHub Copilot display and default model metadata", () => {
    const githubCopilot = ProviderDriverKind.make("githubCopilot");

    expect(PROVIDER_DISPLAY_NAMES[githubCopilot]).toBe("GitHub Copilot");
    expect(DEFAULT_MODEL_BY_PROVIDER[githubCopilot]).toBe("auto");
    expect(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[githubCopilot]).toBe("auto");
  });
});
