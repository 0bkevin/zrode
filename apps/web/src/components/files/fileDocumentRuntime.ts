import type { EnvironmentId, ProjectWriteFilePrecondition } from "@t3tools/contracts";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

import {
  FileDocumentStore,
  fileDocumentIdentity,
  isFileDocumentSnapshotUnsafe,
  type FileDocumentFailureKind,
  type FileDocumentHandle,
  type FileDocumentKey,
  type FileDocumentOperation,
  type FileDocumentSnapshot,
} from "./fileDocumentStore";
import { getProjectFileInspectQueryAtom, getProjectFileQueryAtom } from "./projectFilesQueryState";

function taggedError(error: unknown): {
  readonly _tag?: unknown;
  readonly failure?: unknown;
  readonly cause?: unknown;
  readonly code?: unknown;
  readonly name?: unknown;
} {
  return typeof error === "object" && error !== null ? error : {};
}

function hasNotFoundCode(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    const candidate = taggedError(current);
    if (candidate.code === "ENOENT") return true;
    current = candidate.cause;
  }
  return false;
}

export function classifyFileDocumentError(
  error: unknown,
  _operation: FileDocumentOperation,
): FileDocumentFailureKind {
  const candidate = taggedError(error);
  if (candidate._tag === "ProjectWriteFileConflictError") return "conflict";
  if (
    candidate._tag === "EnvironmentRpcUnavailableError" ||
    candidate._tag === "EnvironmentNotRegisteredError" ||
    candidate._tag === "ConnectionTransientError" ||
    candidate._tag === "TransportError" ||
    candidate._tag === "RpcClientError" ||
    candidate.name === "NetworkError"
  ) {
    return "transient";
  }
  if (hasNotFoundCode(error) || candidate.failure === "path_not_found") {
    return "orphaned";
  }
  return "permanent";
}

export const fileDocumentStore = new FileDocumentStore(
  {
    inspect: async (key) => {
      const atom = getProjectFileInspectQueryAtom(
        key.environmentId as EnvironmentId,
        key.cwd,
        key.relativePath,
      );
      appAtomRegistry.refresh(atom);
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        label: "workspace-file:inspect",
        reportDefect: false,
        reportFailure: false,
      });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    read: async (key) => {
      const atom = getProjectFileQueryAtom(
        key.environmentId as EnvironmentId,
        key.cwd,
        key.relativePath,
      );
      appAtomRegistry.refresh(atom);
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        label: "workspace-file:reconcile",
        reportDefect: false,
        reportFailure: false,
      });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    write: async (request) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        projectEnvironment.writeFile,
        {
          environmentId: request.environmentId as EnvironmentId,
          input: {
            cwd: request.cwd,
            relativePath: request.relativePath,
            contents: request.contents,
            precondition: request.precondition as ProjectWriteFilePrecondition,
          },
        },
        {
          label: "workspace-file:save",
          reportDefect: false,
          reportFailure: false,
        },
      );
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    classifyError: classifyFileDocumentError,
  },
  { debounceMs: 500 },
);

export interface UseFileDocumentResult {
  readonly handle: FileDocumentHandle | null;
  readonly snapshot: FileDocumentSnapshot | null;
}

/**
 * Attach a React view to the canonical document for a workspace file.
 *
 * Acquisition happens in an effect so React's development-mode effect replay
 * cannot leak a view reference. Existing documents are reconciled immediately
 * when they become visible again; the store owns subsequent bounded polling.
 */
export function useFileDocument(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  pollingEnabled = true,
): UseFileDocumentResult {
  const [handle, setHandle] = useState<FileDocumentHandle | null>(null);
  const expectedIdentity =
    relativePath === null
      ? null
      : fileDocumentIdentity({ environmentId, cwd, relativePath } satisfies FileDocumentKey);

  useEffect(() => {
    if (relativePath === null) {
      setHandle(null);
      return;
    }

    const key = { environmentId, cwd, relativePath } satisfies FileDocumentKey;
    const wasAlreadyLoaded = fileDocumentStore.getSnapshot(key) !== null;
    const nextHandle = fileDocumentStore.acquire(key);
    setHandle(nextHandle);
    if (wasAlreadyLoaded) {
      void nextHandle.ready.then(() => nextHandle.refresh());
    }
    return () => {
      void nextHandle.release();
    };
  }, [cwd, environmentId, relativePath]);

  const activeHandle = handle?.identity === expectedIdentity ? handle : null;
  useEffect(() => {
    activeHandle?.setPollingEnabled(pollingEnabled);
  }, [activeHandle, pollingEnabled]);
  const subscribe = useCallback(
    (listener: () => void) => activeHandle?.subscribe(listener) ?? (() => undefined),
    [activeHandle],
  );
  const getSnapshot = useCallback(() => activeHandle?.getSnapshot() ?? null, [activeHandle]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => null);

  return { handle: activeHandle, snapshot };
}

/** Force a render only when the set of unsafe documents changes. */
export function useFileDocumentStoreVersion(): number {
  const [version, setVersion] = useState(0);
  const unsafeIdentitySignatureRef = useRef(
    fileDocumentStore
      .getUnsafeSnapshots()
      .map((snapshot) => snapshot.identity)
      .sort()
      .join("\n"),
  );
  useEffect(
    () =>
      fileDocumentStore.subscribe(() => {
        const nextSignature = fileDocumentStore
          .getUnsafeSnapshots()
          .map((snapshot) => snapshot.identity)
          .sort()
          .join("\n");
        if (nextSignature === unsafeIdentitySignatureRef.current) return;
        unsafeIdentitySignatureRef.current = nextSignature;
        setVersion((current) => current + 1);
      }),
    [],
  );
  return version;
}

/** Protect unsafe in-memory documents from browser/window teardown. */
export function useFileDocumentBeforeUnloadProtection(): void {
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!fileDocumentStore.hasUnsafeDocuments()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
}

export function fileDocumentErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The workspace file operation failed.";
}

export type FileDocumentCloseDecision = "save" | "discard" | "cancel";

export interface FileDocumentClosePrompt {
  readonly relativePath: string;
  readonly kind: "dirty" | "conflict" | "orphaned";
}

export type RequestFileDocumentCloseDecision = (
  prompt: FileDocumentClosePrompt,
) => Promise<FileDocumentCloseDecision>;

/** Own the one-at-a-time close prompt used by any workspace file host. */
export function useFileDocumentCloseDecisionPrompt(): {
  readonly prompt: FileDocumentClosePrompt | null;
  readonly requestDecision: RequestFileDocumentCloseDecision;
  readonly resolveDecision: (decision: FileDocumentCloseDecision) => void;
} {
  const [prompt, setPrompt] = useState<FileDocumentClosePrompt | null>(null);
  const resolverRef = useRef<((decision: FileDocumentCloseDecision) => void) | null>(null);
  const requestDecision = useCallback(
    (nextPrompt: FileDocumentClosePrompt) =>
      new Promise<FileDocumentCloseDecision>((resolve) => {
        resolverRef.current?.("cancel");
        resolverRef.current = resolve;
        setPrompt(nextPrompt);
      }),
    [],
  );
  const resolveDecision = useCallback((decision: FileDocumentCloseDecision) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    resolve?.(decision);
  }, []);

  useEffect(
    () => () => {
      resolverRef.current?.("cancel");
      resolverRef.current = null;
    },
    [],
  );

  return { prompt, requestDecision, resolveDecision };
}

const closePreparationByIdentity = new Map<string, Promise<boolean>>();

/**
 * Make a file document safe before removing its final tab or moving it to a
 * separate window. The caller owns the presentation of the single
 * save/discard/cancel decision.
 */
export async function prepareFileDocumentForClose(
  key: FileDocumentKey,
  requestDecision: RequestFileDocumentCloseDecision,
): Promise<boolean> {
  const identity = fileDocumentIdentity(key);
  const activePreparation = closePreparationByIdentity.get(identity);
  if (activePreparation) return activePreparation;

  const preparation = runFileDocumentClosePreparation(key, requestDecision).finally(() => {
    if (closePreparationByIdentity.get(identity) === preparation) {
      closePreparationByIdentity.delete(identity);
    }
  });
  closePreparationByIdentity.set(identity, preparation);
  return preparation;
}

async function runFileDocumentClosePreparation(
  key: FileDocumentKey,
  requestDecision: RequestFileDocumentCloseDecision,
): Promise<boolean> {
  const existing = fileDocumentStore.getSnapshot(key);
  if (!existing || !isFileDocumentSnapshotUnsafe(existing)) return true;

  const handle = fileDocumentStore.acquire(key);
  const resumeAutosave = handle.suspendAutosave();
  try {
    let current = handle.getSnapshot();
    if (!isFileDocumentSnapshotUnsafe(current)) return true;
    if (current.status === "saving") {
      await handle.flush();
      current = handle.getSnapshot();
      if (!isFileDocumentSnapshotUnsafe(current)) return true;
    }
    const kind =
      current.status === "conflict"
        ? "conflict"
        : current.status === "orphaned"
          ? "orphaned"
          : "dirty";
    const decision = await requestDecision({ relativePath: key.relativePath, kind });
    if (decision === "cancel") return false;
    if (decision === "discard") {
      const discarded = await handle.discard();
      return !isFileDocumentSnapshotUnsafe(discarded);
    }

    current = handle.getSnapshot();
    if (!isFileDocumentSnapshotUnsafe(current)) return true;
    if (current.status === "saving") {
      await handle.flush();
      current = handle.getSnapshot();
      if (!isFileDocumentSnapshotUnsafe(current)) return true;
    }
    const saved =
      current.status === "conflict" || current.status === "orphaned"
        ? await handle.overwrite()
        : current.status === "error"
          ? await handle.retry()
          : await handle.flush();
    return !isFileDocumentSnapshotUnsafe(saved);
  } finally {
    resumeAutosave();
    await handle.release();
  }
}
