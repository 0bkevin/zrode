import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders the error inside the alert description slot", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Codex crashed while processing the request." />,
    );

    const descriptionSlotIndex = markup.indexOf('data-slot="alert-description"');
    const errorTextIndex = markup.indexOf("Codex crashed while processing the request.");
    const actionSlotIndex = markup.indexOf('data-slot="alert-action"');

    expect(descriptionSlotIndex).toBeGreaterThanOrEqual(0);
    expect(errorTextIndex).toBeGreaterThan(descriptionSlotIndex);
    expect(actionSlotIndex).toBe(-1);
    expect(markup).toContain("w-fit max-w-full sm:max-w-2xl");
    expect(markup).not.toContain("w-full max-w-3xl");
  });

  it("normalizes provider-native diagnostics before rendering", () => {
    const htmlError =
      "unexpected status 403 Forbidden: <html><head><title>Denied</title></head></html>";
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={htmlError} />);

    expect(markup).toContain("Provider request failed: 403 Forbidden.");
    expect(markup).not.toContain("&lt;html&gt;");
    expect(markup).not.toContain("Denied");
  });
});
