import { describe, expect, it } from "@effect/vitest";

import {
  WORKSPACE_EDITOR_UNSAFE_CSS,
  workspaceEditorBackground,
  workspaceEditorTheme,
} from "./workspaceEditorPresentation";

describe("workspace editor presentation", () => {
  it("uses VS Code default themes without changing the shared diff resolver", () => {
    expect(workspaceEditorTheme("dark")).toBe("dark-plus");
    expect(workspaceEditorTheme("light")).toBe("light-plus");
    expect(workspaceEditorBackground("dark")).toBe("#1e1e1e");
    expect(workspaceEditorBackground("light")).toBe("#ffffff");
  });

  it("sets the conservative editor metrics and every Pierre background layer", () => {
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("Menlo, Monaco, Consolas");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("--diffs-font-size: 13px");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("--diffs-line-height: 20px");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("[data-gutter]");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("background-color: var(--diffs-bg)");
  });
});
