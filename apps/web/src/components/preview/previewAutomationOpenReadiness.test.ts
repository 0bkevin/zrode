import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewAutomationOpenNeedsNavigation,
  previewAutomationOpenNeedsOverlay,
} from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("does not wait for a desktop overlay when opening an empty tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("waits when an empty tab is immediately given a URL", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(true);
  });

  it("waits for existing tabs that already have rendered content", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
      ),
    ).toBe(true);
  });
});

describe("preview automation open navigation", () => {
  const loaded = snapshot({
    _tag: "Success",
    url: "http://localhost:5173/",
    title: "App",
  });

  it("does not reload a newly returned session whose normalized URL already matches", () => {
    expect(
      previewAutomationOpenNeedsNavigation(
        { url: "localhost:5173" } as PreviewAutomationOpenInput,
        loaded,
        false,
      ),
    ).toBe(false);
  });

  it("navigates a server-reused session when its URL differs", () => {
    expect(
      previewAutomationOpenNeedsNavigation(
        { url: "localhost:3000" } as PreviewAutomationOpenInput,
        loaded,
        false,
      ),
    ).toBe(true);
  });

  it("preserves explicit navigation for a locally selected existing tab", () => {
    expect(
      previewAutomationOpenNeedsNavigation(
        { url: "localhost:5173" } as PreviewAutomationOpenInput,
        loaded,
        true,
      ),
    ).toBe(true);
  });
});
