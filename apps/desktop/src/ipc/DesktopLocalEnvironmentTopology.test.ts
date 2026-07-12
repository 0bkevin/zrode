import { describe, expect, it } from "vite-plus/test";

import { makeLocalEnvironmentTopologyChangeDetector } from "./DesktopLocalEnvironmentTopology.ts";

describe("desktop local environment topology", () => {
  it("broadcasts the initial snapshot and only meaningful subsequent changes", () => {
    const changed = makeLocalEnvironmentTopologyChangeDetector();
    const initial = [
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3000/",
        wsBaseUrl: "ws://127.0.0.1:3000/",
        bootstrapToken: "token-1",
      },
    ];

    expect(changed(initial)).toBe(true);
    expect(changed(initial.map((entry) => ({ ...entry })))).toBe(false);
    expect(changed([{ ...initial[0]!, bootstrapToken: "token-2" }])).toBe(true);
  });
});
