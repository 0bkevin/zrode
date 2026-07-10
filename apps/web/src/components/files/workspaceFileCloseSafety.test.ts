import { describe, expect, it } from "vite-plus/test";

import {
  capturedFileDocumentsAreSafe,
  fileDocumentNeedsCloseProtection,
} from "./workspaceFileCloseSafety";

describe("workspace file close safety", () => {
  it("aborts when a captured document becomes dirty while another close prompt is open", () => {
    const surfaces = [{ relativePath: "a.ts" }, { relativePath: "b.ts" }];
    const snapshots = new Map<string, { isDirty: boolean; status: "clean" | "dirty" }>([
      ["a.ts", { isDirty: false, status: "clean" }],
      ["b.ts", { isDirty: false, status: "clean" }],
    ]);

    expect(capturedFileDocumentsAreSafe(surfaces, (path) => snapshots.get(path) ?? null)).toBe(
      true,
    );
    snapshots.set("a.ts", { isDirty: true, status: "dirty" });
    expect(capturedFileDocumentsAreSafe(surfaces, (path) => snapshots.get(path) ?? null)).toBe(
      false,
    );
  });

  it("protects saving and retrying documents even before their dirty flag updates", () => {
    expect(fileDocumentNeedsCloseProtection({ isDirty: false, status: "saving" })).toBe(true);
    expect(fileDocumentNeedsCloseProtection({ isDirty: false, status: "retrying" })).toBe(true);
    expect(fileDocumentNeedsCloseProtection({ isDirty: false, status: "clean" })).toBe(false);
  });
});
