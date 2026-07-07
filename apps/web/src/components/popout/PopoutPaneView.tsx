import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import ChatView from "~/components/ChatView";
import { ThreadTerminalPanel, type TerminalPanelSurface } from "~/components/ThreadTerminalPanel";
import { toastManager } from "~/components/ui/toast";
import { usePaneTerminalClaimPublisher } from "~/lib/paneTerminalClaims";
import { useProject, useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { primaryServerAvailableEditorsAtom, primaryServerKeybindingsAtom } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useKnownTerminalSessions } from "~/state/terminalSessions";
import { useAtomCommand } from "~/state/use-atom-command";
import { MAX_TERMINALS_PER_GROUP, type Project } from "~/types";

const FilePreviewPanel = lazy(() => import("~/components/files/FilePreviewPanel"));

export interface PopoutPaneSearch {
  // null = unrecognized kind; the view renders an error instead of guessing
  // (a mistyped popout URL must not, say, spawn a terminal session).
  kind: "terminal" | "files" | "chat" | null;
  // Comma-separated terminal ids for kind=terminal.
  terminalIds?: string;
  activeTerminalId?: string;
  // Relative file path to open for kind=files.
  path?: string;
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
        worktreePath={worktreePath}
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
  worktreePath,
  initialTerminalIds,
  initialActiveTerminalId,
  keybindings,
}: {
  threadRef: ScopedThreadRef;
  project: Project;
  worktreePath: string | null;
  initialTerminalIds: string[];
  initialActiveTerminalId: string | null;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
  });
  const knownTerminalIds = useMemo(
    () => knownTerminalSessions.map((session) => session.target.terminalId),
    [knownTerminalSessions],
  );
  const cwd = projectScriptCwd({ project: { cwd: project.workspaceRoot }, worktreePath });

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
  usePaneTerminalClaimPublisher(threadRef, surface.terminalIds);

  const launchTerminal = useCallback(
    (terminalId: string) => {
      void openTerminal({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          terminalId,
          cwd,
          ...(worktreePath != null ? { worktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath,
          }),
        },
      });
    },
    [cwd, openTerminal, project.workspaceRoot, threadRef, worktreePath],
  );

  const addTerminal = useCallback(
    (direction?: "horizontal" | "vertical") => {
      if (surface.terminalIds.length >= MAX_TERMINALS_PER_GROUP) return;
      const terminalId = nextTerminalId([...knownTerminalIds, ...surface.terminalIds]);
      launchTerminal(terminalId);
      setSurface((current) => ({
        ...current,
        terminalIds: [...current.terminalIds, terminalId],
        activeTerminalId: terminalId,
        ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
      }));
      setFocusRequestId((value) => value + 1);
    },
    [knownTerminalIds, launchTerminal, surface.terminalIds],
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
  const [activePath, setActivePath] = useState<string | null>(initialPath);
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
          threadRef={threadRef}
          composerDraftTarget={threadRef}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={activePath}
          revealLine={null}
          revealRequestId={0}
          onOpenFile={setActivePath}
          onPendingChange={() => undefined}
        />
      </Suspense>
    </PopoutPaneFrame>
  );
}
