import { describe, expect, it } from "@effect/vitest";

import {
  hasWorkspaceEditorRenderOptions,
  WORKSPACE_EDITOR_RENDER_OPTIONS,
  WORKSPACE_EDITOR_THEME_NAMES,
  WORKSPACE_EDITOR_UNSAFE_CSS,
  WORKSPACE_TOKENIZE_MAX_LINE_LENGTH,
  workspaceEditorBackground,
  workspaceEditableEditorRenderOptions,
  workspaceEditorRenderOptions,
  workspaceEditorTheme,
} from "./workspaceEditorPresentation";

describe("workspace editor presentation", () => {
  it("uses VS Code default themes without changing the shared diff resolver", () => {
    expect(workspaceEditorTheme("dark")).toBe("dark-plus");
    expect(workspaceEditorTheme("light")).toBe("light-plus");
    expect(workspaceEditorBackground("dark")).toBe("#1e1e1e");
    expect(workspaceEditorBackground("light")).toBe("#ffffff");
  });

  it("keeps both syntax palettes available to incremental editor tokens", () => {
    const darkOptions = workspaceEditableEditorRenderOptions("dark");
    expect(darkOptions.theme).toBe(WORKSPACE_EDITOR_THEME_NAMES);
    expect(darkOptions).toEqual({
      theme: {
        dark: "dark-plus",
        light: "light-plus",
      },
      themeType: "dark",
      tokenizeMaxLineLength: 20_000,
      useTokenTransformer: true,
    });
    expect(workspaceEditableEditorRenderOptions("light").themeType).toBe("light");
  });

  it("keeps workspace worker rendering aligned with the file surface", () => {
    expect(WORKSPACE_TOKENIZE_MAX_LINE_LENGTH).toBe(20_000);
    expect(WORKSPACE_EDITOR_RENDER_OPTIONS).toEqual({
      useTokenTransformer: true,
      tokenizeMaxLineLength: 20_000,
    });
    expect(workspaceEditorRenderOptions("dark")).toEqual({
      theme: "dark-plus",
      useTokenTransformer: true,
      tokenizeMaxLineLength: 20_000,
    });
    expect(
      hasWorkspaceEditorRenderOptions(
        {
          theme: "dark-plus",
          useTokenTransformer: true,
          tokenizeMaxLineLength: 20_000,
        },
        "dark",
      ),
    ).toBe(true);
    expect(
      hasWorkspaceEditorRenderOptions(
        {
          theme: "pierre-dark",
          useTokenTransformer: true,
          tokenizeMaxLineLength: 1_000,
        },
        "dark",
      ),
    ).toBe(false);
  });

  it("sets the conservative editor metrics and every Pierre background layer", () => {
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("Menlo, Monaco, Consolas");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("--diffs-font-size: 13px");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("--diffs-line-height: 20px");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("--diffs-line-bg: transparent");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("[data-gutter]");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain("background-color: transparent !important");
    expect(WORKSPACE_EDITOR_UNSAFE_CSS).toContain(
      "background-color: var(--workspace-editor-background) !important",
    );
  });
});
