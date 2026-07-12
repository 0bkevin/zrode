import type {
  ProjectFileDiskRevision as ContractProjectFileDiskRevision,
  ProjectReadFileResult,
  ProjectWriteFilePrecondition,
  ProjectWriteFileResult,
} from "@t3tools/contracts";

export interface FileDocumentKey {
  readonly environmentId: string;
  readonly cwd: string;
  readonly relativePath: string;
}

export type ProjectFileDiskRevision = ContractProjectFileDiskRevision;
export type FileDocumentWritePrecondition = ProjectWriteFilePrecondition;
export type FileDocumentReadResult = ProjectReadFileResult;

export interface FileDocumentWriteRequest extends FileDocumentKey {
  readonly contents: string;
  readonly precondition: FileDocumentWritePrecondition;
}

export type FileDocumentWriteResult = ProjectWriteFileResult;

export type FileDocumentFailureKind = "conflict" | "transient" | "orphaned" | "permanent";
export type FileDocumentOperation = "read" | "write";

export interface FileDocumentAdapters {
  readonly read: (key: FileDocumentKey) => Promise<FileDocumentReadResult>;
  readonly write: (request: FileDocumentWriteRequest) => Promise<FileDocumentWriteResult>;
  readonly classifyError?: (
    error: unknown,
    operation: FileDocumentOperation,
  ) => FileDocumentFailureKind;
}

export type FileDocumentStatus =
  | "loading"
  | "clean"
  | "dirty"
  | "saving"
  | "retrying"
  | "conflict"
  | "error"
  | "orphaned";

export interface FileDocumentRemoteSnapshot {
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly diskRevision: ProjectFileDiskRevision | null;
}

export interface FileDocumentSnapshot {
  readonly identity: string;
  readonly key: FileDocumentKey;
  readonly status: FileDocumentStatus;
  readonly contents: string;
  readonly baseDiskRevision: ProjectFileDiskRevision | null;
  readonly latestRemote: FileDocumentRemoteSnapshot | null;
  readonly editVersion: number;
  readonly savedEditVersion: number;
  readonly isDirty: boolean;
  readonly readOnly: boolean;
  readonly viewCount: number;
  readonly error: unknown | null;
}

export interface FileDocumentStoreOptions {
  readonly debounceMs?: number;
  readonly retryMinDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly cleanTtlMs?: number;
  /** Maximum number of safe, unmounted documents retained before LRU eviction. */
  readonly maxCachedDocuments?: number;
  /** Set to null to disable visible-document reconciliation polling. */
  readonly pollIntervalMs?: { readonly min: number; readonly max: number } | null;
  readonly random?: () => number;
  /** Automatically pause background reads in hidden tabs and reconcile on focus. */
  readonly listenToBrowserFocus?: boolean;
}

export interface FileDocumentHandle {
  readonly identity: string;
  readonly ready: Promise<FileDocumentSnapshot>;
  getSnapshot(): FileDocumentSnapshot;
  subscribe(listener: () => void): () => void;
  edit(contents: string): void;
  flush(): Promise<FileDocumentSnapshot>;
  /** Retry a dirty document after a permanent write error. Conflicts remain explicit. */
  retry(): Promise<FileDocumentSnapshot>;
  refresh(): Promise<FileDocumentSnapshot>;
  /**
   * Re-read the current disk revision and save against it. This is deliberately a rebased CAS,
   * not a blind unconditional write, so another concurrent change can still surface a conflict.
   */
  overwrite(): Promise<FileDocumentSnapshot>;
  reload(): Promise<FileDocumentSnapshot>;
  discard(): Promise<FileDocumentSnapshot>;
  /** Pause/resume reconciliation reads for this mounted view. */
  setPollingEnabled(enabled: boolean): void;
  /**
   * Stop debounce and retry timers while a close decision is being presented.
   * Explicit flush/discard operations still work. The returned function is
   * idempotent and restores automatic persistence when the last guard ends.
   */
  suspendAutosave(): () => void;
  release(): Promise<void>;
}

interface DocumentSession {
  readonly identity: string;
  readonly key: FileDocumentKey;
  readonly listeners: Set<() => void>;
  readonly pollingViewIds: Set<number>;
  snapshot: FileDocumentSnapshot;
  readPromise: Promise<FileDocumentReadResult> | null;
  initialLoadPromise: Promise<FileDocumentSnapshot> | null;
  savePromise: Promise<void> | null;
  flushPromise: Promise<FileDocumentSnapshot> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  retryDelayMs: number;
  retryOperation: "save" | "overwrite" | null;
  uncertainWrite: { readonly contents: string; readonly editVersion: number } | null;
  controlEpoch: number;
  autosavePauseCount: number;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_RETRY_MIN_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;
const DEFAULT_CLEAN_TTL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = { min: 2_000, max: 3_000 } as const;

function documentIdentity(key: FileDocumentKey): string {
  // JSON stringification is unambiguous even when paths contain separator-like characters.
  return JSON.stringify([key.environmentId, key.cwd, key.relativePath]);
}

function remoteSnapshot(result: FileDocumentReadResult): FileDocumentRemoteSnapshot {
  return {
    contents: result.contents,
    byteLength: result.byteLength,
    truncated: result.truncated,
    diskRevision: result.diskRevision,
  };
}

// Runs after each save, so count UTF-8 bytes without allocating another full buffer.
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function defaultClassifyError(error: unknown): FileDocumentFailureKind {
  if (typeof error !== "object" || error === null) return "permanent";

  const candidate = error as {
    readonly _tag?: unknown;
    readonly failure?: unknown;
    readonly name?: unknown;
  };
  if (
    candidate._tag === "ProjectWriteFileConflictError" ||
    candidate.failure === "revision_conflict"
  ) {
    return "conflict";
  }
  if (
    candidate.failure === "path_not_file" ||
    candidate.failure === "path_not_found" ||
    candidate.failure === "file_not_found" ||
    candidate.failure === "resolved_path_not_found"
  ) {
    return "orphaned";
  }
  if (
    candidate._tag === "TransportError" ||
    candidate._tag === "RpcClientError" ||
    candidate.failure === "transport_failed" ||
    candidate.name === "NetworkError"
  ) {
    return "transient";
  }
  return "permanent";
}

function preconditionForRevision(
  diskRevision: ProjectFileDiskRevision | null,
): FileDocumentWritePrecondition {
  return diskRevision === null ? { _tag: "must-not-exist" } : { _tag: "match", diskRevision };
}

function snapshotIsUnsafe(snapshot: FileDocumentSnapshot): boolean {
  return snapshot.isDirty || snapshot.status === "saving" || snapshot.status === "retrying";
}

export class FileDocumentStore {
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly listeners = new Set<() => void>();
  private readonly debounceMs: number;
  private readonly retryMinDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly cleanTtlMs: number;
  private readonly maxCachedDocuments: number;
  private readonly pollIntervalMs: { readonly min: number; readonly max: number } | null;
  private readonly random: () => number;
  private browserPollingPaused = false;
  private removeBrowserListeners: (() => void) | null = null;
  private disposed = false;
  private nextViewId = 1;

  constructor(
    private readonly adapters: FileDocumentAdapters,
    options: FileDocumentStoreOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryMinDelayMs = options.retryMinDelayMs ?? DEFAULT_RETRY_MIN_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.cleanTtlMs = options.cleanTtlMs ?? DEFAULT_CLEAN_TTL_MS;
    this.maxCachedDocuments = Math.max(0, Math.trunc(options.maxCachedDocuments ?? 64));
    this.pollIntervalMs =
      options.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : options.pollIntervalMs;
    this.random = options.random ?? Math.random;
    if (options.listenToBrowserFocus !== false) this.installBrowserFocusListeners();
  }

  acquire(key: FileDocumentKey): FileDocumentHandle {
    const session = this.getOrCreateSession(key);
    // Map insertion order is the LRU order. Active and unsafe sessions are
    // never evicted, but touching a session keeps a recently reopened clean
    // document ahead of older idle entries.
    this.sessions.delete(session.identity);
    this.sessions.set(session.identity, session);
    const viewId = this.nextViewId++;
    session.pollingViewIds.add(viewId);
    this.clearTimer(session, "evictionTimer");
    this.updateSnapshot(session, { viewCount: session.snapshot.viewCount + 1 });
    const ready = this.ensureLoaded(session);
    this.schedulePoll(session);

    let released = false;
    return {
      identity: session.identity,
      ready,
      getSnapshot: () => session.snapshot,
      subscribe: (listener) => this.subscribeToSession(session, listener),
      edit: (contents) => this.editSession(session, contents),
      flush: () => this.flushSession(session),
      retry: () => this.retrySession(session),
      refresh: () => this.refreshSession(session),
      overwrite: () => this.overwriteSession(session),
      reload: () => this.reloadSession(session),
      discard: () => this.discardSession(session),
      setPollingEnabled: (enabled) => {
        if (released) return;
        if (enabled) {
          session.pollingViewIds.add(viewId);
          this.schedulePoll(session);
        } else {
          session.pollingViewIds.delete(viewId);
          if (session.pollingViewIds.size === 0) this.clearTimer(session, "pollTimer");
        }
      },
      suspendAutosave: () => this.suspendSessionAutosave(session),
      release: async () => {
        if (released) return;
        released = true;
        session.pollingViewIds.delete(viewId);
        if (session.pollingViewIds.size === 0) this.clearTimer(session, "pollTimer");
        await this.releaseSession(session);
      },
    };
  }

  async open(key: FileDocumentKey): Promise<FileDocumentHandle> {
    const handle = this.acquire(key);
    await handle.ready;
    return handle;
  }

  getSnapshot(key: FileDocumentKey): FileDocumentSnapshot | null {
    return this.sessions.get(documentIdentity(key))?.snapshot ?? null;
  }

  getSnapshots(): readonly FileDocumentSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot);
  }

  getUnsafeSnapshots(): readonly FileDocumentSnapshot[] {
    return this.getSnapshots().filter(snapshotIsUnsafe);
  }

  hasUnsafeDocuments(): boolean {
    for (const session of this.sessions.values()) {
      if (snapshotIsUnsafe(session.snapshot)) return true;
    }
    return false;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reconcile only documents that currently have a mounted view. */
  async refreshVisible(): Promise<void> {
    if (this.disposed || this.browserPollingPaused) return;
    const visible = [...this.sessions.values()].filter(
      (session) => session.snapshot.viewCount > 0 && session.pollingViewIds.size > 0,
    );
    await Promise.all(visible.map((session) => this.refreshSession(session)));
    for (const session of visible) this.schedulePoll(session);
  }

  /** Stop browser listeners and timers when the owning application runtime is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeBrowserListeners?.();
    this.removeBrowserListeners = null;
    for (const session of this.sessions.values()) {
      this.clearTimer(session, "debounceTimer");
      this.clearTimer(session, "retryTimer");
      this.clearTimer(session, "pollTimer");
      this.clearTimer(session, "evictionTimer");
    }
  }

  private getOrCreateSession(key: FileDocumentKey): DocumentSession {
    const identity = documentIdentity(key);
    const existing = this.sessions.get(identity);
    if (existing) return existing;

    const stableKey = { ...key };
    const snapshot: FileDocumentSnapshot = {
      identity,
      key: stableKey,
      status: "loading",
      contents: "",
      baseDiskRevision: null,
      latestRemote: null,
      editVersion: 0,
      savedEditVersion: 0,
      isDirty: false,
      readOnly: false,
      viewCount: 0,
      error: null,
    };
    const session: DocumentSession = {
      identity,
      key: stableKey,
      listeners: new Set(),
      pollingViewIds: new Set(),
      snapshot,
      readPromise: null,
      initialLoadPromise: null,
      savePromise: null,
      flushPromise: null,
      debounceTimer: null,
      retryTimer: null,
      pollTimer: null,
      evictionTimer: null,
      retryDelayMs: 0,
      retryOperation: null,
      uncertainWrite: null,
      controlEpoch: 0,
      autosavePauseCount: 0,
    };
    this.sessions.set(identity, session);
    this.emitStore();
    return session;
  }

  private ensureLoaded(session: DocumentSession): Promise<FileDocumentSnapshot> {
    if (session.initialLoadPromise) return session.initialLoadPromise;
    const initialEditVersion = session.snapshot.editVersion;
    session.initialLoadPromise = this.fetchRemote(session)
      .then((result) => {
        const remote = remoteSnapshot(result);
        const wasEditedWhileLoading = session.snapshot.editVersion !== initialEditVersion;
        if (wasEditedWhileLoading) {
          this.updateSnapshot(session, {
            status: "dirty",
            baseDiskRevision: result.diskRevision,
            latestRemote: remote,
            readOnly: result.truncated,
            error: null,
          });
        } else {
          this.adoptRemote(session, remote);
        }
        return session.snapshot;
      })
      .catch((error: unknown) => {
        const kind = this.classifyError(error, "read");
        this.updateSnapshot(session, {
          status: kind === "orphaned" ? "orphaned" : "error",
          error,
        });
        return session.snapshot;
      })
      .finally(() => {
        this.scheduleEvictionIfSafe(session);
      });
    return session.initialLoadPromise;
  }

  private subscribeToSession(session: DocumentSession, listener: () => void): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  private editSession(session: DocumentSession, contents: string): void {
    if (session.snapshot.readOnly) {
      throw new Error(`Cannot edit truncated file '${session.key.relativePath}'.`);
    }
    if (contents === session.snapshot.contents) return;

    this.clearTimer(session, "evictionTimer");
    const editVersion = session.snapshot.editVersion + 1;
    const preserveTerminalState =
      session.snapshot.status === "conflict" || session.snapshot.status === "orphaned";
    const preserveRetryState = session.snapshot.status === "retrying";
    this.updateSnapshot(session, {
      contents,
      editVersion,
      isDirty: true,
      status:
        session.snapshot.status === "saving"
          ? "saving"
          : preserveRetryState
            ? "retrying"
            : preserveTerminalState
              ? session.snapshot.status
              : "dirty",
      error: preserveTerminalState ? session.snapshot.error : null,
    });

    if (!preserveTerminalState && !preserveRetryState) this.scheduleDebouncedSave(session);
  }

  private async flushSession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");
    if (session.flushPromise) return session.flushPromise;

    session.flushPromise = this.runFlush(session).finally(() => {
      session.flushPromise = null;
      this.scheduleEvictionIfSafe(session);
    });
    return session.flushPromise;
  }

  private async retrySession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    if (!session.snapshot.isDirty || session.snapshot.status !== "error") return session.snapshot;
    this.updateSnapshot(session, { status: "dirty", error: null });
    return this.flushSession(session);
  }

  private async runFlush(session: DocumentSession): Promise<FileDocumentSnapshot> {
    while (session.snapshot.isDirty) {
      if (
        session.snapshot.status === "conflict" ||
        session.snapshot.status === "error" ||
        session.snapshot.status === "orphaned"
      ) {
        break;
      }

      await this.saveCaptured(session, preconditionForRevision(session.snapshot.baseDiskRevision));
      if (session.snapshot.status === "retrying") break;
    }
    return session.snapshot;
  }

  private async saveCaptured(
    session: DocumentSession,
    precondition: FileDocumentWritePrecondition,
  ): Promise<void> {
    if (session.savePromise) {
      await session.savePromise;
      return;
    }

    const capturedContents = session.snapshot.contents;
    const capturedEditVersion = session.snapshot.editVersion;
    const capturedEpoch = session.controlEpoch;

    const operation = async () => {
      if (await this.reconcileUncertainWriteBeforeSave(session, capturedEpoch)) return;
      if (session.controlEpoch !== capturedEpoch) return;
      this.updateSnapshot(session, { status: "saving", error: null });

      try {
        const result = await this.adapters.write({
          ...session.key,
          contents: capturedContents,
          precondition,
        });
        if (session.controlEpoch !== capturedEpoch) return;
        session.retryDelayMs = 0;
        session.retryOperation = null;
        session.uncertainWrite = null;
        const hasNewerEdit = session.snapshot.editVersion !== capturedEditVersion;
        this.updateSnapshot(session, {
          status: hasNewerEdit ? "dirty" : "clean",
          baseDiskRevision: result.diskRevision,
          latestRemote: {
            contents: capturedContents,
            byteLength: utf8ByteLength(capturedContents),
            truncated: false,
            diskRevision: result.diskRevision,
          },
          savedEditVersion: capturedEditVersion,
          isDirty: hasNewerEdit,
          error: null,
        });
      } catch (error: unknown) {
        if (session.controlEpoch !== capturedEpoch) return;
        const kind = this.classifyError(error, "write");
        if (kind === "conflict") {
          const latestRemote = await this.tryFetchRemote(session);
          if (session.controlEpoch !== capturedEpoch) return;
          if (
            latestRemote !== null &&
            latestRemote.diskRevision !== null &&
            latestRemote.contents === capturedContents
          ) {
            this.acknowledgeRemoteWrite(session, latestRemote, {
              contents: capturedContents,
              editVersion: capturedEditVersion,
            });
            return;
          }
          const missingOnDisk =
            latestRemote === null &&
            typeof error === "object" &&
            error !== null &&
            "actualExists" in error &&
            error.actualExists === false;
          this.updateSnapshot(session, {
            status: missingOnDisk ? "orphaned" : "conflict",
            latestRemote: latestRemote ?? session.snapshot.latestRemote,
            isDirty: true,
            error,
          });
          session.retryOperation = null;
          session.uncertainWrite = null;
          return;
        }
        if (kind === "transient") {
          session.retryOperation = "save";
          session.uncertainWrite = {
            contents: capturedContents,
            editVersion: capturedEditVersion,
          };
          this.updateSnapshot(session, { status: "retrying", isDirty: true, error });
          this.scheduleRetry(session);
          return;
        }
        this.updateSnapshot(session, {
          status: kind === "orphaned" ? "orphaned" : "error",
          isDirty: true,
          error,
        });
        session.retryOperation = null;
        session.uncertainWrite = null;
      }
    };

    session.savePromise = operation().finally(() => {
      session.savePromise = null;
    });
    await session.savePromise;
  }

  private async refreshSession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    await this.ensureLoaded(session);
    if (session.savePromise) await session.savePromise;

    const capturedControlEpoch = session.controlEpoch;
    const capturedEditVersion = session.snapshot.editVersion;
    const capturedBaseDiskRevision = session.snapshot.baseDiskRevision;

    try {
      const result = await this.fetchRemote(session);
      if (
        session.controlEpoch !== capturedControlEpoch ||
        session.snapshot.editVersion !== capturedEditVersion ||
        session.snapshot.baseDiskRevision !== capturedBaseDiskRevision ||
        session.savePromise !== null
      ) {
        return session.snapshot;
      }
      const remote = remoteSnapshot(result);
      const uncertainWrite = session.uncertainWrite;
      if (
        uncertainWrite !== null &&
        remote.diskRevision !== null &&
        remote.contents === uncertainWrite.contents
      ) {
        const hasNewerEdit = this.acknowledgeRemoteWrite(session, remote, uncertainWrite);
        if (hasNewerEdit) this.scheduleDebouncedSave(session);
        return session.snapshot;
      }
      const remoteChanged =
        result.diskRevision === null && session.snapshot.baseDiskRevision === null
          ? remote.contents !== session.snapshot.latestRemote?.contents ||
            remote.byteLength !== session.snapshot.latestRemote?.byteLength ||
            remote.truncated !== session.snapshot.latestRemote?.truncated
          : result.diskRevision !== session.snapshot.baseDiskRevision;
      if (!session.snapshot.isDirty) {
        if (
          remoteChanged ||
          session.snapshot.status !== "clean" ||
          session.snapshot.error !== null
        ) {
          this.adoptRemote(session, remote);
        }
      } else if (remoteChanged) {
        this.clearTimer(session, "debounceTimer");
        this.clearTimer(session, "retryTimer");
        this.updateSnapshot(session, {
          status: "conflict",
          latestRemote: remote,
          error: null,
        });
      } else if (session.snapshot.status === "conflict" || session.snapshot.status === "orphaned") {
        this.updateSnapshot(session, {
          status: "dirty",
          latestRemote: remote,
          error: null,
        });
        this.scheduleDebouncedSave(session);
      } else {
        const latestRemote = session.snapshot.latestRemote;
        if (
          latestRemote === null ||
          latestRemote.contents !== remote.contents ||
          latestRemote.byteLength !== remote.byteLength ||
          latestRemote.truncated !== remote.truncated ||
          latestRemote.diskRevision !== remote.diskRevision
        ) {
          this.updateSnapshot(session, { latestRemote: remote });
        }
      }
    } catch (error: unknown) {
      if (
        session.controlEpoch !== capturedControlEpoch ||
        session.snapshot.editVersion !== capturedEditVersion ||
        session.snapshot.baseDiskRevision !== capturedBaseDiskRevision
      ) {
        return session.snapshot;
      }
      const kind = this.classifyError(error, "read");
      if (kind === "orphaned" && session.snapshot.isDirty) {
        this.clearTimer(session, "debounceTimer");
        this.clearTimer(session, "retryTimer");
        this.updateSnapshot(session, { status: "orphaned", error });
      } else if (kind === "orphaned") {
        this.updateSnapshot(session, { status: "orphaned", error });
      } else if (!session.snapshot.isDirty && session.snapshot.status === "loading") {
        this.updateSnapshot(session, { status: "error", error });
      }
      // A polling/network read failure must not replace usable editor contents.
    }
    return session.snapshot;
  }

  private async overwriteSession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    await this.ensureLoaded(session);
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");
    session.controlEpoch += 1;
    const actionEpoch = session.controlEpoch;
    if (session.savePromise) await session.savePromise;
    if (session.controlEpoch !== actionEpoch) return session.snapshot;

    let precondition: FileDocumentWritePrecondition;
    try {
      const result = await this.fetchRemote(session);
      if (session.controlEpoch !== actionEpoch) return session.snapshot;
      const remote = remoteSnapshot(result);
      precondition =
        result.diskRevision === null
          ? { _tag: "unconditional" }
          : { _tag: "match", diskRevision: result.diskRevision };
      this.updateSnapshot(session, {
        status: "dirty",
        baseDiskRevision: result.diskRevision,
        latestRemote: remote,
        isDirty: true,
        error: null,
      });
      session.retryOperation = null;
      session.uncertainWrite = null;
    } catch (error: unknown) {
      if (session.controlEpoch !== actionEpoch) return session.snapshot;
      const kind = this.classifyError(error, "read");
      if (kind === "orphaned") {
        precondition = { _tag: "must-not-exist" };
        this.updateSnapshot(session, {
          status: "dirty",
          baseDiskRevision: null,
          isDirty: true,
          error: null,
        });
        session.retryOperation = null;
        session.uncertainWrite = null;
      } else {
        session.retryOperation = kind === "transient" ? "overwrite" : null;
        this.updateSnapshot(session, {
          status: kind === "transient" ? "retrying" : "error",
          error,
        });
        if (kind === "transient") this.scheduleRetry(session);
        return session.snapshot;
      }
    }

    await this.saveCaptured(session, precondition);
    if (session.snapshot.status === "dirty" && session.snapshot.isDirty) {
      return this.flushSession(session);
    }
    return session.snapshot;
  }

  private async reloadSession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");
    const requestedEditVersion = session.snapshot.editVersion;
    session.controlEpoch += 1;
    const actionEpoch = session.controlEpoch;
    if (session.savePromise) await session.savePromise;

    if (
      session.controlEpoch !== actionEpoch ||
      session.snapshot.editVersion !== requestedEditVersion
    ) {
      this.preserveEditsAfterControlRace(session);
      return session.snapshot;
    }

    try {
      const result = await this.fetchRemote(session);
      if (
        session.controlEpoch !== actionEpoch ||
        session.snapshot.editVersion !== requestedEditVersion
      ) {
        this.preserveEditsAfterControlRace(session);
        return session.snapshot;
      }
      session.retryOperation = null;
      session.uncertainWrite = null;
      this.adoptRemote(session, remoteSnapshot(result));
    } catch (error: unknown) {
      if (
        session.controlEpoch !== actionEpoch ||
        session.snapshot.editVersion !== requestedEditVersion
      ) {
        this.preserveEditsAfterControlRace(session);
        return session.snapshot;
      }
      const kind = this.classifyError(error, "read");
      if (kind === "orphaned") {
        const editVersion = session.snapshot.editVersion + 1;
        this.updateSnapshot(session, {
          status: "orphaned",
          contents: "",
          baseDiskRevision: null,
          latestRemote: null,
          editVersion,
          savedEditVersion: editVersion,
          isDirty: false,
          error,
        });
      } else {
        this.updateSnapshot(session, { status: "error", error });
      }
    }
    this.scheduleEvictionIfSafe(session);
    return session.snapshot;
  }

  private async discardSession(session: DocumentSession): Promise<FileDocumentSnapshot> {
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");
    const requestedEditVersion = session.snapshot.editVersion;
    session.controlEpoch += 1;
    const actionEpoch = session.controlEpoch;
    if (session.savePromise) await session.savePromise;

    if (
      session.controlEpoch !== actionEpoch ||
      session.snapshot.editVersion !== requestedEditVersion
    ) {
      this.preserveEditsAfterControlRace(session);
      return session.snapshot;
    }

    session.retryOperation = null;
    session.uncertainWrite = null;

    if (session.snapshot.status !== "orphaned" && session.snapshot.latestRemote) {
      this.adoptRemote(session, session.snapshot.latestRemote);
    } else {
      const editVersion = session.snapshot.editVersion + 1;
      this.updateSnapshot(session, {
        status: "orphaned",
        contents: "",
        baseDiskRevision: null,
        latestRemote: null,
        editVersion,
        savedEditVersion: editVersion,
        isDirty: false,
        error: null,
      });
    }
    this.scheduleEvictionIfSafe(session);
    return session.snapshot;
  }

  private async releaseSession(session: DocumentSession): Promise<void> {
    const viewCount = Math.max(0, session.snapshot.viewCount - 1);
    this.updateSnapshot(session, { viewCount });
    if (viewCount > 0) return;

    this.clearTimer(session, "pollTimer");
    if (session.snapshot.isDirty) await this.flushSession(session);
    this.scheduleEvictionIfSafe(session);
    this.enforceCacheBudget();
  }

  private enforceCacheBudget(): void {
    const idleSafe = [...this.sessions.values()].filter(
      (candidate) =>
        candidate.snapshot.viewCount === 0 &&
        !snapshotIsUnsafe(candidate.snapshot) &&
        !candidate.savePromise &&
        !candidate.readPromise,
    );
    const overflow = idleSafe.length - this.maxCachedDocuments;
    if (overflow <= 0) return;
    for (const candidate of idleSafe.slice(0, overflow)) {
      this.clearTimer(candidate, "evictionTimer");
      this.sessions.delete(candidate.identity);
    }
    this.emitStore();
  }

  private adoptRemote(session: DocumentSession, remote: FileDocumentRemoteSnapshot): void {
    const editVersion = session.snapshot.editVersion + 1;
    session.retryDelayMs = 0;
    session.retryOperation = null;
    session.uncertainWrite = null;
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");
    this.updateSnapshot(session, {
      status: "clean",
      contents: remote.contents,
      baseDiskRevision: remote.diskRevision,
      latestRemote: remote,
      editVersion,
      savedEditVersion: editVersion,
      isDirty: false,
      readOnly: remote.truncated,
      error: null,
    });
  }

  private acknowledgeRemoteWrite(
    session: DocumentSession,
    remote: FileDocumentRemoteSnapshot,
    candidate: { readonly contents: string; readonly editVersion: number },
  ): boolean {
    if (remote.diskRevision === null) return false;
    const hasNewerEdit = session.snapshot.editVersion !== candidate.editVersion;
    session.retryDelayMs = 0;
    session.retryOperation = null;
    session.uncertainWrite = null;
    this.clearTimer(session, "retryTimer");
    this.updateSnapshot(session, {
      status: hasNewerEdit ? "dirty" : "clean",
      baseDiskRevision: remote.diskRevision,
      latestRemote: remote,
      savedEditVersion: candidate.editVersion,
      isDirty: hasNewerEdit,
      error: null,
    });
    return hasNewerEdit;
  }

  /**
   * A transient write failure has an ambiguous outcome: the server may have
   * committed before the response was lost. Resolve that candidate before
   * sending any later text so one bounded candidate is sufficient.
   */
  private async reconcileUncertainWriteBeforeSave(
    session: DocumentSession,
    capturedEpoch: number,
  ): Promise<boolean> {
    const candidate = session.uncertainWrite;
    if (candidate === null) return false;

    try {
      const result = await this.fetchRemote(session);
      if (session.controlEpoch !== capturedEpoch) return true;
      const remote = remoteSnapshot(result);
      if (remote.diskRevision !== null && remote.contents === candidate.contents) {
        this.acknowledgeRemoteWrite(session, remote, candidate);
        return true;
      }

      if (
        session.snapshot.baseDiskRevision !== null &&
        remote.diskRevision === session.snapshot.baseDiskRevision
      ) {
        // The server still has the pre-write baseline, so the ambiguous write
        // definitely did not commit and the current candidate may be sent.
        session.retryDelayMs = 0;
        session.retryOperation = null;
        session.uncertainWrite = null;
        return false;
      }

      this.clearTimer(session, "retryTimer");
      session.retryOperation = null;
      session.uncertainWrite = null;
      this.updateSnapshot(session, {
        status: "conflict",
        latestRemote: remote,
        isDirty: true,
        error: null,
      });
      return true;
    } catch (error: unknown) {
      if (session.controlEpoch !== capturedEpoch) return true;
      const kind = this.classifyError(error, "read");
      if (kind === "orphaned" && session.snapshot.baseDiskRevision === null) {
        // A failed creation is known not to have committed if the path is
        // still absent, so retry it with must-not-exist.
        session.retryDelayMs = 0;
        session.retryOperation = null;
        session.uncertainWrite = null;
        return false;
      }

      if (kind === "transient") {
        session.retryOperation = "save";
        this.updateSnapshot(session, { status: "retrying", isDirty: true, error });
        this.scheduleRetry(session);
        return true;
      }

      if (kind === "orphaned") {
        session.retryOperation = null;
        session.uncertainWrite = null;
        this.updateSnapshot(session, { status: "orphaned", isDirty: true, error });
        return true;
      }

      session.retryOperation = null;
      this.updateSnapshot(session, { status: "error", isDirty: true, error });
      return true;
    }
  }

  private fetchRemote(session: DocumentSession): Promise<FileDocumentReadResult> {
    if (session.readPromise) return session.readPromise;
    session.readPromise = this.adapters.read(session.key).finally(() => {
      session.readPromise = null;
    });
    return session.readPromise;
  }

  private async tryFetchRemote(
    session: DocumentSession,
  ): Promise<FileDocumentRemoteSnapshot | null> {
    try {
      return remoteSnapshot(await this.fetchRemote(session));
    } catch {
      return null;
    }
  }

  private scheduleDebouncedSave(session: DocumentSession): void {
    this.clearTimer(session, "debounceTimer");
    if (this.disposed || session.autosavePauseCount > 0) return;
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null;
      if (this.disposed) return;
      void this.flushSession(session);
    }, this.debounceMs);
  }

  private scheduleRetry(session: DocumentSession): void {
    if (this.disposed || session.retryTimer || session.autosavePauseCount > 0) return;
    session.retryDelayMs = Math.min(
      Math.max(session.retryDelayMs * 2, this.retryMinDelayMs),
      this.retryMaxDelayMs,
    );
    session.retryTimer = setTimeout(() => {
      session.retryTimer = null;
      if (this.disposed) return;
      if (session.snapshot.status === "retrying" && session.snapshot.isDirty) {
        const operation = session.retryOperation;
        if (operation === "overwrite") {
          void this.overwriteSession(session);
        } else {
          this.updateSnapshot(session, { status: "dirty" });
          void this.flushSession(session);
        }
      }
    }, session.retryDelayMs);
  }

  private preserveEditsAfterControlRace(session: DocumentSession): void {
    if (!session.snapshot.isDirty) return;
    if (session.snapshot.status === "saving") {
      this.updateSnapshot(session, { status: "dirty", error: null });
    }
    if (session.autosavePauseCount === 0 && session.snapshot.status === "dirty") {
      this.scheduleDebouncedSave(session);
    }
  }

  private suspendSessionAutosave(session: DocumentSession): () => void {
    session.autosavePauseCount += 1;
    this.clearTimer(session, "debounceTimer");
    this.clearTimer(session, "retryTimer");

    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      session.autosavePauseCount = Math.max(0, session.autosavePauseCount - 1);
      if (session.autosavePauseCount > 0 || !session.snapshot.isDirty) return;
      if (session.snapshot.status === "retrying") {
        this.scheduleRetry(session);
      } else if (session.snapshot.status === "dirty") {
        this.scheduleDebouncedSave(session);
      }
    };
  }

  private schedulePoll(session: DocumentSession): void {
    if (
      this.disposed ||
      this.browserPollingPaused ||
      this.pollIntervalMs === null ||
      session.pollTimer ||
      session.snapshot.viewCount === 0 ||
      session.pollingViewIds.size === 0
    ) {
      return;
    }
    const { min, max } = this.pollIntervalMs;
    const delay = min + Math.max(0, max - min) * this.random();
    session.pollTimer = setTimeout(() => {
      session.pollTimer = null;
      if (session.snapshot.viewCount === 0 || session.pollingViewIds.size === 0) return;
      void this.refreshSession(session).finally(() => this.schedulePoll(session));
    }, delay);
  }

  private installBrowserFocusListeners(): void {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    this.browserPollingPaused = document.visibilityState === "hidden";
    const onVisibilityChange = () => {
      this.browserPollingPaused = document.visibilityState === "hidden";
      if (this.browserPollingPaused) {
        for (const session of this.sessions.values()) this.clearTimer(session, "pollTimer");
        return;
      }
      void this.refreshVisible();
    };
    const onFocus = () => {
      if (document.visibilityState !== "hidden") void this.refreshVisible();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    this.removeBrowserListeners = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }

  private scheduleEvictionIfSafe(session: DocumentSession): void {
    if (
      session.snapshot.viewCount > 0 ||
      snapshotIsUnsafe(session.snapshot) ||
      session.savePromise ||
      session.readPromise ||
      session.evictionTimer
    ) {
      return;
    }
    session.evictionTimer = setTimeout(() => {
      session.evictionTimer = null;
      if (
        session.snapshot.viewCount === 0 &&
        !snapshotIsUnsafe(session.snapshot) &&
        !session.savePromise &&
        !session.readPromise
      ) {
        this.sessions.delete(session.identity);
        this.emitStore();
      }
    }, this.cleanTtlMs);
  }

  private updateSnapshot(
    session: DocumentSession,
    patch: Partial<Omit<FileDocumentSnapshot, "identity" | "key">>,
  ): void {
    session.snapshot = { ...session.snapshot, ...patch };
    for (const listener of session.listeners) listener();
    this.emitStore();
  }

  private emitStore(): void {
    for (const listener of this.listeners) listener();
  }

  private classifyError(error: unknown, operation: FileDocumentOperation): FileDocumentFailureKind {
    return this.adapters.classifyError?.(error, operation) ?? defaultClassifyError(error);
  }

  private clearTimer(
    session: DocumentSession,
    key: "debounceTimer" | "retryTimer" | "pollTimer" | "evictionTimer",
  ): void {
    const timer = session[key];
    if (timer === null) return;
    clearTimeout(timer);
    session[key] = null;
  }
}

export function isFileDocumentSnapshotUnsafe(snapshot: FileDocumentSnapshot): boolean {
  return snapshotIsUnsafe(snapshot);
}

export function fileDocumentIdentity(key: FileDocumentKey): string {
  return documentIdentity(key);
}
