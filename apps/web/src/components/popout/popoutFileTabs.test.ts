import { describe, expect, it } from "vite-plus/test";

import {
  activatePopoutFileTab,
  closePopoutFileTabs,
  createPopoutFileTabsState,
  openPopoutFileTab,
} from "./popoutFileTabState";

describe("popout file tabs", () => {
  it("keeps opened files in tab order and activates the latest file", () => {
    let state = createPopoutFileTabsState("README.md");
    state = openPopoutFileTab(state, "src/index.ts", null);
    state = openPopoutFileTab(state, "src/app.ts", { kind: "line", line: 12 });

    expect(state).toEqual({
      activePath: "src/app.ts",
      tabs: [
        { relativePath: "README.md", revealTarget: null, revealRequestId: 0 },
        { relativePath: "src/index.ts", revealTarget: null, revealRequestId: 1 },
        {
          relativePath: "src/app.ts",
          revealTarget: { kind: "line", line: 12 },
          revealRequestId: 1,
        },
      ],
    });
  });

  it("reuses an existing tab and advances its reveal request", () => {
    let state = createPopoutFileTabsState(null);
    state = openPopoutFileTab(state, "src/index.ts", null);
    state = openPopoutFileTab(state, "README.md", null);
    state = openPopoutFileTab(state, "src/index.ts", { kind: "line", line: 7 });

    expect(state.tabs.map((tab) => tab.relativePath)).toEqual(["src/index.ts", "README.md"]);
    expect(state.tabs[0]).toEqual({
      relativePath: "src/index.ts",
      revealTarget: { kind: "line", line: 7 },
      revealRequestId: 2,
    });
    expect(state.activePath).toBe("src/index.ts");
  });

  it("activates tabs and selects the next tab when the active one closes", () => {
    let state = createPopoutFileTabsState(null);
    state = openPopoutFileTab(state, "a.ts", null);
    state = openPopoutFileTab(state, "b.ts", null);
    state = openPopoutFileTab(state, "c.ts", null);
    state = activatePopoutFileTab(state, "b.ts");
    state = closePopoutFileTabs(state, new Set(["b.ts"]));

    expect(state.tabs.map((tab) => tab.relativePath)).toEqual(["a.ts", "c.ts"]);
    expect(state.activePath).toBe("c.ts");

    state = closePopoutFileTabs(state, new Set(["a.ts", "c.ts"]));
    expect(state).toEqual({ tabs: [], activePath: null });
  });
});
