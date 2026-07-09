import { describe, expect, it } from "vite-plus/test";

import { formatProcessType } from "./DiagnosticsSettings.logic";

describe("formatProcessType", () => {
  it("classifies known top-level agent commands", () => {
    expect(formatProcessType({ command: "codex app-server", depth: 0 })).toBe("Agent");
    expect(formatProcessType({ command: "/usr/local/bin/devin acp", depth: 0 })).toBe("Agent");
    expect(formatProcessType({ command: "devin", depth: 0 })).toBe("Agent");
  });

  it("keeps nested commands as subprocesses", () => {
    expect(formatProcessType({ command: "devin acp", depth: 1 })).toBe("Subprocess");
  });
});
