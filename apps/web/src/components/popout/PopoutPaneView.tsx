import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "~/components/ChatView";
import { FileSearchPalette } from "~/components/FileSearchPalette";
import { FileDocumentCloseDialog } from "~/components/files/FileDocumentCloseDialog";
import { useFileCloseShortcutRouter } from "~/components/files/useFileCloseShortcutRouter";
import { OpenEditorsSection } from "~/components/files/WorkspaceOpenEditors";
import {
  fileDocumentStore,
  prepareFileDocumentForClose,
  useFileDocumentBeforeUnloadProtection,
  useFileDocumentCloseDecisionPrompt,
  useFileDocumentStoreVersion,
} from "~/components/files/fileDocumentRuntime";
import { isFileDocumentSnapshotUnsafe } from "~/components/files/fileDocumentStore";
import { ThreadTerminalPanel, type TerminalPanelSurface } from "~/components/ThreadTerminalPanel";
import { toastManager } from "~/components/ui/toast";
import { getConfiguredPreviewUrls } from "~/components/preview/previewEmptyStateLogic";
import { useClaimedPreviewTabIds, usePaneClaimPublisher } from "~/lib/paneTerminalClaims";
import { useThreadPreviewState } from "~/previewStateStore";
import type { FileRevealTarget } from "~/rightPanelStore";
import { useProject, useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { MAX_TERMINALS_PER_GROUP, type Project } from "~/types";

import { PopoutFileTabs } from "./PopoutFileTabs";
import {
  activatePopoutFileTab,
  closePopoutFileTabs,
  createPopoutFileTabsState,
  openPopoutFileTab,
} from "./popoutFileTabState";

const FilePreviewPanel = lazy(() => import("~/components/files/FilePreviewPanel"));
const PreviewPanel = lazy(() =>
  import("~/components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);

export interface PopoutPaneSearch {
  // null = unrecognized kind; the view renders an error instead of guessing
  // (a mistyped popout URL must not, say, spawn a terminal session).
  kind: "terminal" | "files" | "chat" | "preview" | null;
  // Comma-separated terminal ids for kind=terminal.
  terminalIds?: string;
  activeTerminalId?: string;
  // Relative file path to open for kind=files.
  path?: string;
  // Preview tab id for kind=preview.
  tabId?: string;
}

/**
 * A single pane (terminal or files) hosted in its own OS window at a
 * /popout/ route, outside the app shell. All pane content is server-owned
 * (PTY buffers, filesystem), so this window reconstructs it over its own
 * connection; only view state (active tab, open file) lives here.
 */
export function PopoutPaneView({
  threadRef,
  search,
}: {
  threadRef: ScopedThreadRef;
  search: PopoutPaneSearch;
}) {
  useFileCloseShortcutRouter();
  const serverThread = useThread(threadRef);
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : null;
  const project = useProject(projectRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const worktreePath = serverThread?.worktreePath ?? null;
  const workspaceRoot = worktreePath ?? project?.workspaceRoot ?? null;
  const environmentShellState = useEnvironmentQuery(
    environmentShell.stateAtom(threadRef.environmentId),
  );
  // Once the environment has bootstrapped, a missing thread is gone for good
  // (deleted or never existed) — not still loading.
  const environmentReady = environmentShellState.data?.snapshot._tag === "Some";
  const threadMissing = environmentReady && !serverThread;

  if (search.kind === null) {
    return <PopoutErrorFrame title="Zrode" message="This pane link is not recognized." />;
  }

  if (threadMissing) {
    return (
      <PopoutErrorFrame
        title="Zrode"
        message="This thread is no longer available. You can close this window."
      />
    );
  }

  if (search.kind === "preview") {
    if (!search.tabId) {
      return <PopoutErrorFrame title="Browser" message="This pane link is missing its tab." />;
    }
    if (!serverThread) {
      return <PopoutConnectingFrame title="Browser" />;
    }
    return (
      <PopoutPreviewPane
        threadRef={threadRef}
        tabId={search.tabId}
        configuredUrls={getConfiguredPreviewUrls(project?.scripts)}
        environmentReady={environmentReady}
      />
    );
  }

  // Chat derives everything from the thread itself; it must not wait on the
  // project gate below (ChatView handles a missing project gracefully).
  if (search.kind === "chat") {
    if (!serverThread) {
      return <PopoutConnectingFrame title="Chat" />;
    }
    return (
      <PopoutPaneFrame
        title={project ? `${serverThread.title} — ${project.title}` : serverThread.title}
      >
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          reserveTitleBarControlInset={false}
        />
      </PopoutPaneFrame>
    );
  }

  if (!project || !workspaceRoot) {
    return <PopoutConnectingFrame title={search.kind === "terminal" ? "Terminal" : "Files"} />;
  }

  if (search.kind === "terminal") {
    const terminalIds = parseTerminalIds(search.terminalIds);
    // Never conjure a session from a bare URL: terminal popouts must carry
    // the ids of the live sessions they were opened for.
    if (terminalIds.length === 0) {
      return (
        <PopoutErrorFrame title="Terminal" message="This pane link is missing its terminal." />
      );
    }
    return (
      <PopoutTerminalPane
        threadRef={threadRef}
        project={project}
        initialTerminalIds={terminalIds}
        initialActiveTerminalId={search.activeTerminalId ?? null}
        keybindings={keybindings}
      />
    );
  }

  return (
    <PopoutFilesPane
      threadRef={threadRef}
      project={project}
      workspaceRoot={workspaceRoot}
      initialPath={search.path ?? null}
      keybindings={keybindings}
      availableEditors={availableEditors}
    />
  );
}

function parseTerminalIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const ids: string[] = [];
  for (const entry of raw.split(",")) {
    const terminalId = entry.trim();
    if (terminalId.length > 0 && !ids.includes(terminalId)) {
      ids.push(terminalId);
    }
  }
  return ids;
}

function PopoutPaneFrame({ title, children }: { title: string; children: React.ReactNode }) {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      {children}
    </div>
  );
}

function PopoutConnectingFrame({ title }: { title: string }) {
  return (
    <PopoutPaneFrame title={title}>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Connecting…
      </div>
    </PopoutPaneFrame>
  );
}

function PopoutErrorFrame({ title, message }: { title: string; message: string }) {
  return (
    <PopoutPaneFrame title={title}>
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {message}
      </div>
    </PopoutPaneFrame>
  );
}

function PopoutTerminalPane({
  threadRef,
  project,
  initialTerminalIds,
  initialActiveTerminalId,
  keybindings,
}: {
  threadRef: ScopedThreadRef;
  project: Project;
  initialTerminalIds: string[];
  initialActiveTerminalId: string | null;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const knownTerminalIds = useMemo(
    () => knownTerminalSessions.map((session) => session.target.terminalId),
    [knownTerminalSessions],
  );
  const [surface, setSurface] = useState<TerminalPanelSurface>(() => {
    const primaryId = initialTerminalIds[0]!;
    return {
      id: `terminal:${primaryId}`,
      kind: "terminal",
      resourceId: primaryId,
      terminalIds: initialTerminalIds,
      activeTerminalId:
        initialActiveTerminalId !== null && initialTerminalIds.includes(initialActiveTerminalId)
          ? initialActiveTerminalId
          : primaryId,
    };
  });
  const [focusRequestId, setFocusRequestId] = useState(1);
  // Claim these terminals so the main window's drawer doesn't re-adopt them.
  const claimResources = useMemo(
    () => ({ terminalIds: surface.terminalIds, previewTabIds: [] }),
    [surface.terminalIds],
  );
  usePaneClaimPublisher(threadRef, claimResources);

  const addTerminal = useCallback(
    (direction?: "horizontal" | "vertical") => {
      if (surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return;
      const terminalId = nextTerminalId([...knownTerminalIds, ...surface.terminalIds]);
      setSurface((current) => ({
        ...current,
        terminalIds: [...current.terminalIds, terminalId],
        activeTerminalId: terminalId,
        ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
      }));
      setFocusRequestId((value) => value + 1);
    },
    [knownTerminalIds, surface.terminalIds],
  );

  const handleNewTerminal = useCallback(() => addTerminal(), [addTerminal]);
  const handleSplitTerminal = useCallback(() => addTerminal("horizontal"), [addTerminal]);
  const handleSplitTerminalVertical = useCallback(() => addTerminal("vertical"), [addTerminal]);

  const handleActiveTerminalChange = useCallback((terminalId: string) => {
    setSurface((current) =>
      current.terminalIds.includes(terminalId)
        ? { ...current, activeTerminalId: terminalId }
        : current,
    );
    setFocusRequestId((value) => value + 1);
  }, []);

  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      const closeCommand = closeTerminal({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
      });
      const remaining = surface.terminalIds.filter((id) => id !== terminalId);
      if (remaining.length === 0) {
        // Closing the last terminal closes the window — but only after the
        // close command settles, otherwise tearing down this window's socket
        // races the send and the PTY survives on the server.
        void closeCommand.finally(() => window.close());
        return;
      }
      setSurface((current) => ({
        ...current,
        terminalIds: remaining,
        activeTerminalId:
          current.activeTerminalId === terminalId
            ? (remaining.at(-1) ?? remaining[0]!)
            : current.activeTerminalId,
      }));
      setFocusRequestId((value) => value + 1);
    },
    [closeTerminal, surface.terminalIds, threadRef],
  );

  const handleAddTerminalContext = useCallback(() => {
    toastManager.add({
      type: "warning",
      title: "Not available here",
      description: "Adding terminal output to the chat requires the main window.",
    });
  }, []);

  return (
    <PopoutPaneFrame title={`Terminal — ${project.title}`}>
      <ThreadTerminalPanel
        threadRef={threadRef}
        surface={surface}
        launchContext={null}
        focusRequestId={focusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={handleAddTerminalContext}
        onSplitTerminal={handleSplitTerminal}
        onSplitTerminalVertical={handleSplitTerminalVertical}
        onNewTerminal={handleNewTerminal}
        onActiveTerminalChange={handleActiveTerminalChange}
        onCloseTerminal={handleCloseTerminal}
      />
    </PopoutPaneFrame>
  );
}

const SESSION_LOST_GRACE_MS = 8_000;

function PopoutPreviewPane({
  threadRef,
  tabId,
  configuredUrls,
  environmentReady,
}: {
  threadRef: ScopedThreadRef;
  tabId: string;
  configuredUrls: ReadonlyArray<string>;
  environmentReady: boolean;
}) {
  const previewState = useThreadPreviewState(threadRef);
  const hasSession = (previewState.sessions[tabId] ?? null) !== null;
  const snapshot = previewState.sessions[tabId] ?? null;
  // Another window still claims this tab (a second popout for the same tab,
  // or a not-yet-released source window). Wait reactively instead of
  // fighting over the webview registration; during a normal move the source
  // releases within milliseconds of this window booting.
  const remotelyHosted = useClaimedPreviewTabIds().has(tabId);
  // The server session disappearing (tab closed elsewhere / server restart
  // without it) is terminal for this window: the fixed tabId can never be
  // revived. Grace covers subscription lag right after boot.
  const [sessionLost, setSessionLost] = useState(false);
  useEffect(() => {
    if (hasSession || !environmentReady || remotelyHosted) {
      return;
    }
    const timer = window.setTimeout(() => setSessionLost(true), SESSION_LOST_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [environmentReady, hasSession, remotelyHosted]);

  // Claim the tab so this window's ElectronBrowserHost mounts its webview and
  // the main window's host releases it (without closing the desktop tab).
  // No claim while another window holds it or the session is gone.
  const shouldClaim = !remotelyHosted && !sessionLost;
  const claimResources = useMemo(
    () => ({ terminalIds: [], previewTabIds: shouldClaim ? [tabId] : [] }),
    [shouldClaim, tabId],
  );
  usePaneClaimPublisher(threadRef, claimResources);

  if (sessionLost && !hasSession) {
    return (
      <PopoutErrorFrame
        title="Browser"
        message="This browser tab was closed. You can close this window."
      />
    );
  }
  if (remotelyHosted) {
    return (
      <PopoutErrorFrame title="Browser" message="This browser tab is open in another window." />
    );
  }

  const title =
    snapshot && snapshot.navStatus._tag !== "Idle" && snapshot.navStatus.title.trim().length > 0
      ? snapshot.navStatus.title
      : "Browser";

  return (
    <PopoutPaneFrame title={title}>
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={threadRef}
          tabId={tabId}
          configuredUrls={configuredUrls}
          visible
        />
      </Suspense>
    </PopoutPaneFrame>
  );
}

function PopoutFilesPane({
  threadRef,
  project,
  workspaceRoot,
  initialPath,
  keybindings,
  availableEditors,
}: {
  threadRef: ScopedThreadRef;
  project: Project;
  workspaceRoot: string;
  initialPath: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: React.ComponentProps<typeof FilePreviewPanel>["availableEditors"];
}) {
  useFileDocumentBeforeUnloadProtection();
  const fileDocumentStoreVersion = useFileDocumentStoreVersion();
  const [fileTabsState, setFileTabsState] = useState(() => createPopoutFileTabsState(initialPath));
  const activeFile =
    fileTabsState.tabs.find((tab) => tab.relativePath === fileTabsState.activePath) ?? null;
  const activePath = activeFile?.relativePath ?? null;
  const openEditorFiles = useMemo(
    () =>
      fileTabsState.tabs.map((tab) => ({
        id: tab.relativePath,
        relativePath: tab.relativePath,
      })),
    [fileTabsState.tabs],
  );
  const pendingPaths = useMemo(() => {
    const pending = new Set<string>();
    for (const snapshot of fileDocumentStore.getUnsafeSnapshots()) {
      if (
        snapshot.key.environmentId === project.environmentId &&
        snapshot.key.cwd === workspaceRoot
      ) {
        pending.add(snapshot.key.relativePath);
      }
    }
    return pending;
  }, [fileDocumentStoreVersion, project.environmentId, workspaceRoot]);
  const {
    prompt: fileDocumentClosePrompt,
    requestDecision: requestFileDocumentCloseDecision,
    resolveDecision: resolveFileDocumentCloseDecision,
  } = useFileDocumentCloseDecisionPrompt();
  const handleOpenFile = useCallback((relativePath: string, revealTarget?: FileRevealTarget) => {
    setFileTabsState((current) => openPopoutFileTab(current, relativePath, revealTarget ?? null));
  }, []);
  const handleActivateFile = useCallback((relativePath: string) => {
    setFileTabsState((current) => activatePopoutFileTab(current, relativePath));
  }, []);
  const closeFiles = useCallback(
    async (relativePaths: readonly string[]) => {
      for (const relativePath of relativePaths) {
        const key = {
          environmentId: project.environmentId,
          cwd: workspaceRoot,
          relativePath,
        };
        setFileTabsState((current) => activatePopoutFileTab(current, relativePath));
        if (!(await prepareFileDocumentForClose(key, requestFileDocumentCloseDecision))) {
          toastManager.add({
            type: "warning",
            title: "File kept open",
            description: `Resolve or save the changes to ${relativePath} before closing.`,
          });
          return false;
        }
        const currentSnapshot = fileDocumentStore.getSnapshot(key);
        if (currentSnapshot && isFileDocumentSnapshotUnsafe(currentSnapshot)) {
          toastManager.add({
            type: "warning",
            title: "File kept open",
            description: `${relativePath} changed while it was closing. Try again.`,
          });
          return false;
        }
      }

      const paths = new Set(relativePaths);
      const becameUnsafe = relativePaths.find((relativePath) => {
        const snapshot = fileDocumentStore.getSnapshot({
          environmentId: project.environmentId,
          cwd: workspaceRoot,
          relativePath,
        });
        return snapshot !== null && isFileDocumentSnapshotUnsafe(snapshot);
      });
      if (becameUnsafe) {
        toastManager.add({
          type: "warning",
          title: relativePaths.length === 1 ? "File kept open" : "Editors kept open",
          description: `${becameUnsafe} changed while the editors were closing. Try again.`,
        });
        return false;
      }

      setFileTabsState((current) => closePopoutFileTabs(current, paths));
      return true;
    },
    [project.environmentId, requestFileDocumentCloseDecision, workspaceRoot],
  );
  const handleCloseFile = useCallback(
    (relativePath: string) => {
      void closeFiles([relativePath]);
    },
    [closeFiles],
  );
  const handleCloseAllFiles = useCallback(() => {
    void closeFiles(fileTabsState.tabs.map((tab) => tab.relativePath));
  }, [closeFiles, fileTabsState.tabs]);
  const handleCloseActiveFile = useCallback(() => {
    if (activePath) handleCloseFile(activePath);
  }, [activePath, handleCloseFile]);
  const title = activePath
    ? `${activePath.slice(activePath.lastIndexOf("/") + 1)} — ${project.title}`
    : `Files — ${project.title}`;

  return (
    <PopoutPaneFrame title={title}>
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${project.environmentId}:${workspaceRoot}`}
          environmentId={project.environmentId}
          cwd={workspaceRoot}
          projectName={project.title}
          layoutMode="standalone"
          threadRef={threadRef}
          composerDraftTarget={threadRef}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={activePath}
          revealTarget={activeFile?.revealTarget ?? null}
          revealRequestId={activeFile?.revealRequestId ?? 0}
          editorTabBar={
            <PopoutFileTabs
              tabs={fileTabsState.tabs}
              activePath={activePath}
              pendingPaths={pendingPaths}
              onActivate={handleActivateFile}
              onClose={handleCloseFile}
            />
          }
          openEditors={
            <OpenEditorsSection
              files={openEditorFiles}
              activeFileId={activePath}
              pendingFileIds={pendingPaths}
              onActivateFile={(file) => handleActivateFile(file.relativePath)}
              onCloseFile={(file) => handleCloseFile(file.relativePath)}
              onCloseAllFiles={handleCloseAllFiles}
            />
          }
          onOpenFile={handleOpenFile}
          {...(activePath ? { onCloseActiveFile: handleCloseActiveFile } : {})}
        />
      </Suspense>
      <FileSearchPalette
        projectContext={{
          threadRef,
          cwd: workspaceRoot,
          projectTitle: project.title,
        }}
        openFilePaths={openEditorFiles.map((file) => file.relativePath)}
        onOpenFile={handleOpenFile}
      />
      <FileDocumentCloseDialog
        prompt={fileDocumentClosePrompt}
        onDecision={resolveFileDocumentCloseDecision}
      />
    </PopoutPaneFrame>
  );
}
