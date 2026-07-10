import { describe, expect, it } from "vite-plus/test";

import {
  adoptExternalEditorFileState,
  createEditorFileState,
  updateLocalEditorContents,
} from "./editableFileState";

describe("editableFileState", () => {
  it("keeps local edit identity stable but gives an external ABA revert a new generation", () => {
    const initial = createEditorFileState("/repo", "demo.ts", "A");
    const locallyEdited = updateLocalEditorContents(initial, "B");

    expect(locallyEdited.file).toBe(initial.file);
    expect(locallyEdited.file.cacheKey).toBe(initial.file.cacheKey);
    expect(locallyEdited.externalRevision).toBe(initial.externalRevision);

    const externalRevert = adoptExternalEditorFileState(locallyEdited, "/repo", "demo.ts", "A");

    expect(externalRevert.file).not.toBe(initial.file);
    expect(externalRevert.file.cacheKey).not.toBe(initial.file.cacheKey);
    expect(externalRevert.file.contents).toBe("A");
    expect(externalRevert.externalRevision).toBe(initial.externalRevision + 1);

    const nextLocalEdit = updateLocalEditorContents(externalRevert, "C");
    expect(nextLocalEdit.file).toBe(externalRevert.file);
    expect(nextLocalEdit.file.cacheKey).toBe(externalRevert.file.cacheKey);
  });
});
