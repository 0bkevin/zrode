import {
  ProjectFileDiskRevision,
  ProjectWriteFileConflictError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { saveProjectFileWithReplaceConfirmation } from "./saveProjectFileWithConfirmation";

const environmentId = "local" as EnvironmentId;

describe("saveProjectFileWithReplaceConfirmation", () => {
  it("creates a new export without asking to replace", async () => {
    const write = vi.fn().mockResolvedValue(
      AsyncResult.success({
        relativePath: "plan.md",
        diskRevision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:4",
        created: true,
      }),
    );
    const confirmReplace = vi.fn();

    const outcome = await saveProjectFileWithReplaceConfirmation({
      environmentId,
      file: { cwd: "/workspace", relativePath: "plan.md", contents: "plan" },
      write,
      confirmReplace,
    });

    expect(outcome._tag).toBe("Saved");
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(write.mock.calls[0]?.[0].input.precondition).toEqual({ _tag: "must-not-exist" });
  });

  it("replaces an existing export only after confirmation", async () => {
    const conflict = new ProjectWriteFileConflictError({
      cwd: "/workspace",
      relativePath: "plan.md",
      precondition: { _tag: "must-not-exist" },
      actualExists: true,
      actualDiskRevision: null,
    });
    const write = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(conflict)))
      .mockResolvedValueOnce(
        AsyncResult.success({
          relativePath: "plan.md",
          diskRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:4",
          created: false,
        }),
      );

    const outcome = await saveProjectFileWithReplaceConfirmation({
      environmentId,
      file: { cwd: "/workspace", relativePath: "plan.md", contents: "plan" },
      write,
      confirmReplace: async () => true,
    });

    expect(outcome._tag).toBe("Saved");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0].input.precondition).toEqual({ _tag: "unconditional" });
  });

  it("uses the conflict revision so a second external change cannot be overwritten", async () => {
    const actualDiskRevision = ProjectFileDiskRevision.make(
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:4",
    );
    const conflict = new ProjectWriteFileConflictError({
      cwd: "/workspace",
      relativePath: "plan.md",
      precondition: { _tag: "must-not-exist" },
      actualExists: true,
      actualDiskRevision,
    });
    const write = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(conflict)))
      .mockResolvedValueOnce(
        AsyncResult.success({
          relativePath: "plan.md",
          diskRevision: actualDiskRevision,
          created: false,
        }),
      );

    await saveProjectFileWithReplaceConfirmation({
      environmentId,
      file: { cwd: "/workspace", relativePath: "plan.md", contents: "plan" },
      write,
      confirmReplace: () => true,
    });

    expect(write.mock.calls[1]?.[0].input.precondition).toEqual({
      _tag: "match",
      diskRevision: actualDiskRevision,
    });
  });

  it("leaves the existing export untouched when replacement is declined", async () => {
    const conflict = new ProjectWriteFileConflictError({
      cwd: "/workspace",
      relativePath: "plan.md",
      precondition: { _tag: "must-not-exist" },
      actualExists: true,
      actualDiskRevision: null,
    });
    const write = vi.fn().mockResolvedValue(AsyncResult.failure(Cause.fail(conflict)));

    const outcome = await saveProjectFileWithReplaceConfirmation({
      environmentId,
      file: { cwd: "/workspace", relativePath: "plan.md", contents: "plan" },
      write,
      confirmReplace: () => false,
    });

    expect(outcome._tag).toBe("Cancelled");
    expect(write).toHaveBeenCalledTimes(1);
  });
});
