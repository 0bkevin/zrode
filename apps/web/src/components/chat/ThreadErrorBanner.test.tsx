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
  });
});
