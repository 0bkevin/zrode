import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { assert, describe, it } from "vite-plus/test";

import { PierreEntryIcon } from "./components/chat/PierreEntryIcon";
import {
  getZrodePierreIconColor,
  hasSpecificPierreIconForFileName,
  inferEntryKindFromPath,
  resolvePierreIconForEntry,
  syntheticFileNameForLanguageId,
  ZRODE_PIERRE_ICONS,
  ZRODE_PIERRE_ICON_TREE_CSS,
} from "./pierre-icons";

describe("Pierre file icons", () => {
  it("restores recognizable file identities across filenames and extensions", () => {
    assert.equal(resolvePierreIconForEntry("Dockerfile", "file")?.token, "docker");
    assert.equal(resolvePierreIconForEntry("src/Button.tsx", "file")?.token, "react");
    assert.equal(resolvePierreIconForEntry("vite.config.ts", "file")?.token, "vite");
    assert.equal(resolvePierreIconForEntry("src/index.ts", "file")?.token, "typescript");
    assert.equal(resolvePierreIconForEntry("src/index.js", "file")?.token, "javascript");
    assert.equal(resolvePierreIconForEntry("src/block.tsx", "file")?.token, "react");
  });

  it("gives important project files purpose-specific glyphs", () => {
    assert.equal(resolvePierreIconForEntry("package.json", "file")?.token, "json");
    assert.equal(resolvePierreIconForEntry("config/tsconfig.json", "file")?.token, "json");
    assert.equal(resolvePierreIconForEntry("AGENTS.md", "file")?.token, "markdown");
    assert.equal(resolvePierreIconForEntry("CLAUDE.md", "file")?.token, "claude");
    assert.equal(resolvePierreIconForEntry("README.md", "file")?.token, "markdown");
    assert.equal(resolvePierreIconForEntry("pnpm-lock.yaml", "file")?.token, "yml");
    assert.equal(resolvePierreIconForEntry("pnpm-workspace.yaml", "file")?.token, "yml");
  });

  it("uses the complete set with a restrained theme-aware palette", () => {
    assert.equal(ZRODE_PIERRE_ICONS.set, "complete");
    assert.isTrue(ZRODE_PIERRE_ICONS.colored);
    assert.equal(getZrodePierreIconColor("react", "light"), "#4f7b91");
    assert.equal(getZrodePierreIconColor("react", "dark"), "#7398aa");
    assert.notEqual(
      getZrodePierreIconColor("typescript", "light"),
      getZrodePierreIconColor("javascript", "light"),
    );
    assert.include(ZRODE_PIERRE_ICON_TREE_CSS, "--trees-icon-cyan: light-dark(#4f7b91, #7398aa);");
  });

  it("uses the neutral default glyph for unknown file types", () => {
    assert.equal(
      resolvePierreIconForEntry("artifact.unknown-ext", "file")?.name,
      "file-tree-builtin-default",
    );
    assert.isFalse(hasSpecificPierreIconForFileName("artifact.unknown-ext"));
  });

  it("allows callers to override the compact default icon size", () => {
    const markup = renderToStaticMarkup(
      createElement(PierreEntryIcon, {
        pathValue: "src/index.ts",
        kind: "file",
        theme: "dark",
        className: "size-5",
      }),
    );

    assert.include(markup, "size-5");
    assert.notInclude(markup, "width:12px");
    assert.notInclude(markup, "height:12px");
  });

  it("leaves directory rendering to the shared folder fallback", () => {
    assert.isNull(resolvePierreIconForEntry("packages/client-runtime", "directory"));
  });

  it("normalizes common markdown fence language aliases", () => {
    assert.equal(syntheticFileNameForLanguageId("typescript"), "file.ts");
    assert.equal(syntheticFileNameForLanguageId("shellscript"), "file.sh");
    assert.equal(syntheticFileNameForLanguageId("python"), "file.py");
  });

  it("recognizes well-known extensionless files in path-only chips", () => {
    assert.equal(inferEntryKindFromPath("Dockerfile"), "file");
    assert.equal(inferEntryKindFromPath(".babelrc"), "file");
    assert.equal(inferEntryKindFromPath(".gitkeep"), "file");
    assert.equal(inferEntryKindFromPath(".gitignore"), "file");
    assert.equal(inferEntryKindFromPath(".nvmrc"), "file");
    assert.equal(inferEntryKindFromPath("tools/Makefile"), "file");
    assert.equal(inferEntryKindFromPath("LICENSE"), "file");
    assert.equal(inferEntryKindFromPath("Dockerfile/"), "directory");
    assert.equal(inferEntryKindFromPath(".github"), "directory");
    assert.equal(inferEntryKindFromPath("packages/client-runtime"), "directory");
  });
});
