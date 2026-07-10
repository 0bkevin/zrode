import { describe, expect, it } from "vite-plus/test";

import { classifyFileDocumentError } from "./fileDocumentRuntime";

describe("classifyFileDocumentError", () => {
  it("classifies wire-level path_not_found writes as orphaned", () => {
    expect(
      classifyFileDocumentError(
        { _tag: "ProjectWriteFileError", failure: "path_not_found" },
        "write",
      ),
    ).toBe("orphaned");
  });

  it("keeps non-not-found write failures permanent", () => {
    expect(
      classifyFileDocumentError(
        { _tag: "ProjectWriteFileError", failure: "operation_failed" },
        "write",
      ),
    ).toBe("permanent");
  });
});
