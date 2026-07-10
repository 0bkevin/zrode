/** Workspace-only editor presentation; chat code blocks and diff views keep their themes. */
export const WORKSPACE_EDITOR_THEME_NAMES = {
  dark: "dark-plus",
  light: "light-plus",
} as const;

export const WORKSPACE_EDITOR_BACKGROUNDS = {
  dark: "#1e1e1e",
  light: "#ffffff",
} as const;

export function workspaceEditorTheme(theme: "light" | "dark") {
  return WORKSPACE_EDITOR_THEME_NAMES[theme];
}

export function workspaceEditorBackground(theme: "light" | "dark") {
  return WORKSPACE_EDITOR_BACKGROUNDS[theme];
}

export const WORKSPACE_EDITOR_UNSAFE_CSS = `
  :host {
    --diffs-font-family: Menlo, Monaco, Consolas, "Courier New", monospace;
    --diffs-font-size: 13px;
    --diffs-line-height: 20px;
  }

  :host,
  [data-file],
  [data-code],
  [data-content],
  [data-gutter],
  pre {
    background-color: var(--diffs-bg) !important;
  }
`;
