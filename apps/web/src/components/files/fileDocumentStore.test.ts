import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FileDocumentStore,
  type FileDocumentAdapters,
  type FileDocumentFailureKind,
  type FileDocumentKey,
  type FileDocumentReadResult,
  type FileDocumentWriteResult,
  type ProjectFileDiskRevision,
} from "./fileDocumentStore";

const baseKey: FileDocumentKey = {
  environmentId: "local",
  cwd: "/workspace/one",
  relativePath: "src/index.ts",
};

function readResult(contents: string, diskRevision: string): FileDocumentReadResult {
  return {
    relativePath: baseKey.relativePath,
    contents,
    byteLength: contents.length,
    truncated: false,
    diskRevision: diskRevision as ProjectFileDiskRevision,
  };
}

function writeResult(diskRevision: string): FileDocumentWriteResult {
  return {
    relativePath: baseKey.relativePath,
    diskRevision: diskRevision as ProjectFileDiskRevision,
    created: false,
  };
}

function failure(
  kind: FileDocumentFailureKind,
): Error & { readonly kind: FileDocumentFailureKind } {
  return Object.assign(new Error(kind), { kind });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createStore(adapters: FileDocumentAdapters, cleanTtlMs = 100): FileDocumentStore {
  return new FileDocumentStore(adapters, {
    debounceMs: 10_000,
    retryMinDelayMs: 1_000,
    retryMaxDelayMs: 2_000,
    cleanTtlMs,
    pollIntervalMs: null,
  });
}

const classifyError: NonNullable<FileDocumentAdapters["classifyError"]> = (error) => {
  if (typeof error === "object" && error !== null && "kind" in error) {
    return (error as { readonly kind: FileDocumentFailureKind }).kind;
  }
  return "permanent";
};

describe("FileDocumentStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures save versions and queues an edit made while a save is in flight", async () => {
    const firstWrite = deferred<FileDocumentWriteResult>();
    const secondWrite = deferred<FileDocumentWriteResult>();
    const write = vi
      .fn<FileDocumentAdapters["write"]>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    const store = createStore({
      read: async () => readResult("initial", "r0"),
      write,
      classifyError,
    });
    const handle = await store.open(baseKey);

    handle.edit("first edit");
    const flush = handle.flush();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0]?.[0].precondition).toEqual({
      _tag: "match",
      diskRevision: "r0",
    });

    handle.edit("second edit");
    firstWrite.resolve(writeResult("r1"));
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      contents: "second edit",
      precondition: { _tag: "match", diskRevision: "r1" },
    });
    secondWrite.resolve(writeResult("r2"));
    await flush;

    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "second edit",
      baseDiskRevision: "r2",
      isDirty: false,
      editVersion: 3,
      savedEditVersion: 3,
    });
  });

  it("stops on a revision conflict without retrying or sending an unconditional write", async () => {
    const write = vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(failure("conflict"));
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValue(readResult("remote", "r0"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);

    handle.edit("local edit");
    await handle.flush();

    expect(handle.getSnapshot()).toMatchObject({
      status: "conflict",
      contents: "local edit",
      isDirty: true,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].precondition._tag).toBe("match");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reconciles a committed save whose transport response was lost", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce(readResult("saved text", "r1"));
    const write = vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(failure("transient"));
    const store = new FileDocumentStore(
      { read, write, classifyError },
      {
        debounceMs: 10_000,
        retryMinDelayMs: 100,
        retryMaxDelayMs: 100,
        pollIntervalMs: null,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);

    handle.edit("saved text");
    await handle.flush();
    expect(handle.getSnapshot().status).toBe("retrying");

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(handle.getSnapshot().status).toBe("clean"));
    expect(handle.getSnapshot()).toMatchObject({
      contents: "saved text",
      baseDiskRevision: "r1",
      isDirty: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("lets polling acknowledge a committed save whose response was lost", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce(readResult("saved text", "r1"));
    const write = vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(failure("transient"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);

    handle.edit("saved text");
    await handle.flush();
    expect(handle.getSnapshot().status).toBe("retrying");

    await handle.refresh();

    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "saved text",
      baseDiskRevision: "r1",
      isDirty: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reconciles an uncertain candidate before sending a newer edit", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce(readResult("first edit", "r1"));
    const write = vi
      .fn<FileDocumentAdapters["write"]>()
      .mockRejectedValueOnce(failure("transient"))
      .mockResolvedValueOnce(writeResult("r2"));
    const store = new FileDocumentStore(
      { read, write, classifyError },
      {
        debounceMs: 10_000,
        retryMinDelayMs: 100,
        retryMaxDelayMs: 100,
        pollIntervalMs: null,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);
    handle.edit("first edit");
    await handle.flush();
    handle.edit("newer edit");

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(handle.getSnapshot().status).toBe("clean"));

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      contents: "newer edit",
      precondition: { _tag: "match", diskRevision: "r1" },
    });
    expect(handle.getSnapshot()).toMatchObject({
      contents: "newer edit",
      baseDiskRevision: "r2",
      isDirty: false,
    });
  });

  it("treats a save conflict against a deleted disk file as orphaned", async () => {
    const deletedConflict = Object.assign(failure("conflict"), { actualExists: false });
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("remote", "r0"))
      .mockRejectedValue(failure("orphaned"));
    const store = createStore({
      read,
      write: vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(deletedConflict),
      classifyError,
    });
    const handle = await store.open(baseKey);

    handle.edit("local edit");
    await handle.flush();

    expect(handle.getSnapshot()).toMatchObject({
      status: "orphaned",
      contents: "local edit",
      isDirty: true,
    });
  });

  it("adopts an external revision when the document is clean", async () => {
    let remote = readResult("first", "r0");
    const store = createStore({
      read: async () => remote,
      write: async () => writeResult("unused"),
      classifyError,
    });
    const handle = await store.open(baseKey);

    remote = readResult("changed externally", "r1");
    await handle.refresh();

    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "changed externally",
      baseDiskRevision: "r1",
      isDirty: false,
    });
  });

  it("preserves local text and enters conflict when a dirty file changes externally", async () => {
    let remote = readResult("first", "r0");
    const write = vi.fn<FileDocumentAdapters["write"]>();
    const store = createStore({ read: async () => remote, write, classifyError });
    const handle = await store.open(baseKey);

    handle.edit("unsaved local text");
    remote = readResult("changed externally", "r1");
    await handle.refresh();

    expect(handle.getSnapshot()).toMatchObject({
      status: "conflict",
      contents: "unsaved local text",
      baseDiskRevision: "r0",
      latestRemote: { contents: "changed externally", diskRevision: "r1" },
      isDirty: true,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("does not let a stale poll response replace a newer successful save", async () => {
    const staleRead = deferred<FileDocumentReadResult>();
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockImplementationOnce(() => staleRead.promise);
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r1"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);

    const refresh = handle.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    handle.edit("new saved text");
    await handle.flush();
    staleRead.resolve(readResult("stale disk text", "r0"));
    await refresh;

    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "new saved text",
      baseDiskRevision: "r1",
      isDirty: false,
    });
  });

  it("does not let a delayed reload erase an edit made while reading", async () => {
    const reloadRead = deferred<FileDocumentReadResult>();
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockImplementationOnce(() => reloadRead.promise);
    const store = createStore({
      read,
      write: async () => writeResult("unused"),
      classifyError,
    });
    const handle = await store.open(baseKey);
    handle.edit("edit before reload");

    const reload = handle.reload();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    handle.edit("edit during reload");
    reloadRead.resolve(readResult("remote", "r1"));
    await reload;

    expect(handle.getSnapshot()).toMatchObject({
      status: "dirty",
      contents: "edit during reload",
      isDirty: true,
    });
  });

  it("does not publish a delayed overwrite after the user discards", async () => {
    const overwriteRead = deferred<FileDocumentReadResult>();
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce(readResult("remote", "r1"))
      .mockImplementationOnce(() => overwriteRead.promise);
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r2"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);
    handle.edit("local");
    await handle.refresh();
    expect(handle.getSnapshot().status).toBe("conflict");

    const overwrite = handle.overwrite();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await handle.discard();
    overwriteRead.resolve(readResult("remote", "r1"));
    await overwrite;

    expect(write).not.toHaveBeenCalled();
    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "remote",
      baseDiskRevision: "r1",
      isDirty: false,
    });
  });

  it("drains an edit made while an overwrite write is in flight", async () => {
    const firstWrite = deferred<FileDocumentWriteResult>();
    const write = vi
      .fn<FileDocumentAdapters["write"]>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce(writeResult("r3"));
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce(readResult("remote", "r1"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);
    handle.edit("overwrite text");

    const overwrite = handle.overwrite();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    handle.edit("edit during overwrite");
    firstWrite.resolve(writeResult("r2"));
    await overwrite;

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]?.[0]).toMatchObject({
      contents: "edit during overwrite",
      precondition: { _tag: "match", diskRevision: "r2" },
    });
    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "edit during overwrite",
      baseDiskRevision: "r3",
      isDirty: false,
    });
  });

  it("flushes once on release and does not replay a successfully saved edit", async () => {
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r1"));
    const store = createStore({
      read: async () => readResult("first", "r0"),
      write,
      classifyError,
    });
    const handle = await store.open(baseKey);

    handle.edit("saved on release");
    await handle.release();
    await vi.advanceTimersByTimeAsync(50_000);

    expect(write).toHaveBeenCalledTimes(1);
    expect(store.hasUnsafeDocuments()).toBe(false);
  });

  it("retains a failed released document past the clean eviction TTL", async () => {
    const write = vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(failure("permanent"));
    const store = createStore(
      {
        read: async () => readResult("first", "r0"),
        write,
        classifyError,
      },
      50,
    );
    const handle = await store.open(baseKey);

    handle.edit("must not be evicted");
    await handle.release();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.hasUnsafeDocuments()).toBe(true);
    expect(store.getUnsafeSnapshots()).toHaveLength(1);
    expect(store.getSnapshot(baseKey)).toMatchObject({
      status: "error",
      contents: "must not be evicted",
      viewCount: 0,
    });
  });

  it("retries a dirty permanent failure only after an explicit retry", async () => {
    const write = vi
      .fn<FileDocumentAdapters["write"]>()
      .mockRejectedValueOnce(failure("permanent"))
      .mockResolvedValueOnce(writeResult("r1"));
    const store = createStore({
      read: async () => readResult("first", "r0"),
      write,
      classifyError,
    });
    const handle = await store.open(baseKey);

    handle.edit("eventually saved");
    await handle.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(handle.getSnapshot().status).toBe("error");

    await handle.retry();
    expect(write).toHaveBeenCalledTimes(2);
    expect(handle.getSnapshot()).toMatchObject({ status: "clean", isDirty: false });
  });

  it("retries a transient overwrite re-read instead of staying retrying forever", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockRejectedValueOnce(failure("transient"))
      .mockResolvedValueOnce(readResult("remote", "r1"));
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r2"));
    const store = new FileDocumentStore(
      { read, write, classifyError },
      {
        retryMinDelayMs: 100,
        retryMaxDelayMs: 100,
        pollIntervalMs: null,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);
    handle.edit("local");

    await handle.overwrite();
    expect(handle.getSnapshot().status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(handle.getSnapshot().status).toBe("clean"));

    expect(read).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "local",
        precondition: { _tag: "match", diskRevision: "r1" },
      }),
    );
  });

  it("uses an explicit unconditional write when overwrite finds an oversized file", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("initial", "r0"))
      .mockResolvedValueOnce({
        relativePath: baseKey.relativePath,
        contents: "remote preview",
        byteLength: 2 * 1024 * 1024,
        truncated: true,
        diskRevision: null,
      });
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r1"));
    const store = createStore({ read, write, classifyError });
    const handle = await store.open(baseKey);
    handle.edit("local replacement");

    await handle.overwrite();

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: "local replacement",
        precondition: { _tag: "unconditional" },
      }),
    );
    expect(handle.getSnapshot()).toMatchObject({ status: "clean", isDirty: false });
  });

  it("classifies RpcClientError as transient by default", async () => {
    const store = new FileDocumentStore(
      {
        read: async () => readResult("initial", "r0"),
        write: vi
          .fn<FileDocumentAdapters["write"]>()
          .mockRejectedValue(Object.assign(new Error("socket closed"), { _tag: "RpcClientError" })),
      },
      {
        retryMinDelayMs: 60_000,
        retryMaxDelayMs: 60_000,
        pollIntervalMs: null,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);
    handle.edit("local");

    await handle.flush();

    expect(handle.getSnapshot()).toMatchObject({ status: "retrying", isDirty: true });
  });

  it("discards to the last known disk snapshot without requiring a network read", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("disk baseline", "r0"));
    const store = createStore({
      read,
      write: vi.fn<FileDocumentAdapters["write"]>().mockRejectedValue(failure("permanent")),
      classifyError,
    });
    const handle = await store.open(baseKey);
    handle.edit("local text");
    await handle.flush();

    await handle.discard();

    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "disk baseline",
      baseDiskRevision: "r0",
      isDirty: false,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not autosave while a close decision is pending", async () => {
    const write = vi.fn<FileDocumentAdapters["write"]>().mockResolvedValue(writeResult("r1"));
    const store = new FileDocumentStore(
      {
        read: async () => readResult("disk baseline", "r0"),
        write,
        classifyError,
      },
      {
        debounceMs: 100,
        pollIntervalMs: null,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);
    handle.edit("local text");

    const resumeAutosave = handle.suspendAutosave();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled();

    await handle.discard();
    resumeAutosave();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(write).not.toHaveBeenCalled();
    expect(handle.getSnapshot()).toMatchObject({
      status: "clean",
      contents: "disk baseline",
      isDirty: false,
    });
  });

  it("marks a clean document orphaned when it disappears on disk", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("first", "r0"))
      .mockRejectedValueOnce(failure("orphaned"));
    const store = createStore({
      read,
      write: async () => writeResult("unused"),
      classifyError,
    });
    const handle = await store.open(baseKey);

    await handle.refresh();

    expect(handle.getSnapshot()).toMatchObject({
      status: "orphaned",
      contents: "first",
      isDirty: false,
    });
  });

  it("can explicitly discard local changes after the disk file is removed", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockResolvedValueOnce(readResult("first", "r0"))
      .mockRejectedValue(failure("orphaned"));
    const store = createStore({
      read,
      write: async () => writeResult("unused"),
      classifyError,
    });
    const handle = await store.open(baseKey);
    handle.edit("local text");

    await handle.refresh();
    expect(handle.getSnapshot()).toMatchObject({ status: "orphaned", isDirty: true });

    await handle.discard();
    expect(handle.getSnapshot()).toMatchObject({
      status: "orphaned",
      contents: "",
      isDirty: false,
    });
    expect(store.hasUnsafeDocuments()).toBe(false);
  });

  it("pauses reconciliation polling for a disconnected mounted view", async () => {
    const read = vi.fn<FileDocumentAdapters["read"]>().mockResolvedValue(readResult("first", "r0"));
    const store = new FileDocumentStore(
      { read, write: async () => writeResult("unused"), classifyError },
      {
        pollIntervalMs: { min: 100, max: 100 },
        random: () => 0,
        listenToBrowserFocus: false,
      },
    );
    const handle = await store.open(baseKey);
    handle.setPollingEnabled(false);

    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(1);

    handle.setPollingEnabled(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("uses cwd as part of document identity", async () => {
    const read = vi
      .fn<FileDocumentAdapters["read"]>()
      .mockImplementation(async (key) => readResult(key.cwd, `revision:${key.cwd}`));
    const store = createStore({
      read,
      write: async () => writeResult("unused"),
      classifyError,
    });
    const first = await store.open(baseKey);
    const second = await store.open({ ...baseKey, cwd: "/workspace/two" });

    expect(first.identity).not.toBe(second.identity);
    expect(first.getSnapshot().contents).toBe("/workspace/one");
    expect(second.getSnapshot().contents).toBe("/workspace/two");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
