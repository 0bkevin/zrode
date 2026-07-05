/**
 * Always-visible status button for the chat pane's bottom toolbar. Shows how
 * many local server processes are currently listening (with their combined
 * memory) and opens a popover listing each listener with live CPU/memory
 * usage plus open / copy / stop actions. Data arrives over the shared
 * `subscribeDiscoveredLocalServers` stream, so it stays live without any
 * component-side polling.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Option from "effect/Option";
import { Check, Copy, ExternalLink, RadioTower, TerminalSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { openDiscoveredPort } from "~/components/preview/openDiscoveredPort";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { useDiscoveredServerSnapshot } from "~/portDiscoveryState";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

interface LocalServersStatusButtonProps {
  threadRef: ScopedThreadRef;
}

interface ServerGroup {
  readonly key: "this-thread" | "other-threads" | "external";
  readonly title: string;
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
}

/** SIGINT grace period before the row offers a SIGKILL force stop. */
const FORCE_STOP_DELAY_MS = 5_000;

type StopState = "stopping" | "force";

export function LocalServersStatusButton({ threadRef }: LocalServersStatusButtonProps) {
  const { servers } = useDiscoveredServerSnapshot(threadRef.environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [stopStateByPid, setStopStateByPid] = useState<ReadonlyMap<number, StopState>>(new Map());
  const stopTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearStopTracking = useCallback((pid: number) => {
    const timer = stopTimersRef.current.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      stopTimersRef.current.delete(pid);
    }
    setStopStateByPid((current) => {
      if (!current.has(pid)) return current;
      const next = new Map(current);
      next.delete(pid);
      return next;
    });
  }, []);

  // A pid disappearing from the snapshot means the stop worked — drop its
  // in-flight state so the map doesn't accumulate dead entries.
  useEffect(() => {
    setStopStateByPid((current) => {
      if (current.size === 0) return current;
      const alive = new Set(servers.flatMap((server) => (server.pid === null ? [] : [server.pid])));
      let changed = false;
      const next = new Map(current);
      for (const pid of current.keys()) {
        if (alive.has(pid)) continue;
        next.delete(pid);
        const timer = stopTimersRef.current.get(pid);
        if (timer !== undefined) {
          clearTimeout(timer);
          stopTimersRef.current.delete(pid);
        }
        changed = true;
      }
      return changed ? next : current;
    });
  }, [servers]);

  useEffect(
    () => () => {
      for (const timer of stopTimersRef.current.values()) clearTimeout(timer);
    },
    [],
  );

  const groups = useMemo<ReadonlyArray<ServerGroup>>(() => {
    const thisThread: DiscoveredLocalServer[] = [];
    const otherThreads: DiscoveredLocalServer[] = [];
    const external: DiscoveredLocalServer[] = [];
    for (const server of servers) {
      if (server.terminal === null) external.push(server);
      else if (server.terminal.threadId === threadRef.threadId) thisThread.push(server);
      else otherThreads.push(server);
    }
    return [
      { key: "this-thread" as const, title: "This thread", servers: thisThread },
      { key: "other-threads" as const, title: "Other threads", servers: otherThreads },
      { key: "external" as const, title: "Other processes", servers: external },
    ].filter((group) => group.servers.length > 0);
  }, [servers, threadRef.threadId]);

  // One process can listen on several ports (several rows); count and sum
  // memory per unique pid so the trigger doesn't double-count.
  const { processCount, totalMemoryBytes } = useMemo(() => {
    const memoryByPid = new Map<number, number>();
    const pids = new Set<number>();
    let pidlessCount = 0;
    for (const server of servers) {
      if (server.pid === null) {
        pidlessCount += 1;
        continue;
      }
      pids.add(server.pid);
      if (server.memoryBytes != null) memoryByPid.set(server.pid, server.memoryBytes);
    }
    let total = 0;
    for (const bytes of memoryByPid.values()) total += bytes;
    return {
      processCount: pids.size + pidlessCount,
      totalMemoryBytes: memoryByPid.size > 0 ? total : null,
    };
  }, [servers]);

  const openServer = useCallback(
    (server: DiscoveredLocalServer) => {
      if (isPreviewSupportedInRuntime()) {
        void openDiscoveredPort({ threadRef, port: server, openPreview });
        return;
      }
      window.open(
        resolveDiscoveredServerUrl(threadRef.environmentId, server.url),
        "_blank",
        "noopener",
      );
    },
    [openPreview, threadRef],
  );

  const stopServer = useCallback(
    (server: DiscoveredLocalServer) => {
      const pid = server.pid;
      if (pid === null) return;
      const force = stopStateByPid.get(pid) === "force";
      if (
        force &&
        !window.confirm(
          `Force stop ${server.processName ?? `process ${pid}`}? SIGKILL cannot be handled by the process.`,
        )
      ) {
        return;
      }
      setStopStateByPid((current) => new Map(current).set(pid, "stopping"));
      const existingTimer = stopTimersRef.current.get(pid);
      if (existingTimer !== undefined) clearTimeout(existingTimer);
      stopTimersRef.current.set(
        pid,
        setTimeout(() => {
          stopTimersRef.current.delete(pid);
          // Still listening after the grace period — offer a force stop.
          setStopStateByPid((current) =>
            current.get(pid) === "stopping" ? new Map(current).set(pid, "force") : current,
          );
        }, FORCE_STOP_DELAY_MS),
      );
      void (async () => {
        const result = await signalServerProcess({
          environmentId: threadRef.environmentId,
          input: { pid, signal: force ? "SIGKILL" : "SIGINT" },
        });
        if (result._tag === "Failure") {
          clearStopTracking(pid);
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: "Could not stop server",
              description:
                error instanceof Error ? error.message : `Failed to signal process ${pid}.`,
            });
          }
          return;
        }
        if (!result.value.signaled) {
          clearStopTracking(pid);
          const message = Option.getOrUndefined(result.value.message);
          toastManager.add({
            type: "error",
            title: "Can't stop this server",
            description: message?.includes("descendant")
              ? "This server wasn't started from Zrode, so it can't be stopped here. Stop it from its own terminal."
              : (message ?? `Process ${pid} did not accept the signal.`),
          });
        }
        // When the signal landed, keep the "Stopping…" state until the row
        // disappears from the scan (handled by the eviction effect) or the
        // grace timer escalates to a force-stop offer.
      })();
    },
    [clearStopTracking, signalServerProcess, stopStateByPid, threadRef.environmentId],
  );

  const openTerminal = useCallback(
    (terminalId: string) => {
      useRightPanelStore.getState().openTerminal(threadRef, terminalId);
    },
    [threadRef],
  );

  return (
    <Popover>
      <PopoverTrigger className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground opacity-60 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100">
        <StatusDot listening={processCount > 0} />
        <span className="tabular-nums">
          {processCount === 0
            ? "No servers"
            : `${processCount} ${processCount === 1 ? "server" : "servers"}`}
        </span>
        {totalMemoryBytes != null ? (
          <span className="hidden tabular-nums sm:inline">· {formatBytes(totalMemoryBytes)}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-[26rem] max-w-[calc(100vw-1.5rem)] p-0">
        {servers.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
            <RadioTower className="size-4.5 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">No local servers</p>
            <p className="text-xs text-muted-foreground">
              Run a dev script in a terminal. Listening localhost ports show up here automatically.
            </p>
          </div>
        ) : (
          <div className="flex max-h-96 flex-col gap-2 overflow-y-auto p-1.5">
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col">
                {groups.length > 1 ? (
                  <h3 className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    {group.title}
                  </h3>
                ) : null}
                {group.servers.map((server) => {
                  const terminal = server.terminal;
                  return (
                    <LocalServerRow
                      key={`${server.host}:${server.port}:${server.pid ?? "unknown"}`}
                      server={server}
                      resolvedUrl={resolveDiscoveredServerUrl(threadRef.environmentId, server.url)}
                      stopState={
                        server.pid === null ? null : (stopStateByPid.get(server.pid) ?? null)
                      }
                      onOpen={() => openServer(server)}
                      onStop={() => stopServer(server)}
                      onOpenTerminal={
                        group.key === "this-thread" && terminal !== null
                          ? () => openTerminal(terminal.terminalId)
                          : null
                      }
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

interface LocalServerRowProps {
  server: DiscoveredLocalServer;
  resolvedUrl: string;
  stopState: StopState | null;
  onOpen: () => void;
  onStop: () => void;
  onOpenTerminal: (() => void) | null;
}

function LocalServerRow({
  server,
  resolvedUrl,
  stopState,
  onOpen,
  onStop,
  onOpenTerminal,
}: LocalServerRowProps) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "server URL" });
  const title =
    server.processName ?? (server.pid !== null ? `PID ${server.pid}` : "Unknown process");
  const meta = [
    `${server.host}:${server.port}`,
    server.cpuPercent != null ? `${server.cpuPercent}% CPU` : null,
    server.memoryBytes != null ? formatBytes(server.memoryBytes) : null,
  ].filter((part): part is string => part !== null);
  return (
    <div className="group flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-accent/50">
      <span className="flex h-5 items-center">
        <StatusDot listening />
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={server.commandLine ?? undefined}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {server.pid !== null && server.processName !== null ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {server.pid}
            </span>
          ) : null}
        </span>
        <span className="truncate text-xs tabular-nums text-muted-foreground">
          {meta.join(" · ")}
        </span>
        {server.cwd != null ? (
          <span className="truncate text-[11px] text-muted-foreground/60" title={server.cwd}>
            {server.cwd}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-0.5 self-center">
        <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onOpenTerminal !== null && server.terminal !== null ? (
            <RowAction
              label={`Open ${getTerminalLabel(server.terminal.terminalId)}`}
              onClick={onOpenTerminal}
            >
              <TerminalSquare className="size-3.5" />
            </RowAction>
          ) : null}
          <RowAction label="Open in browser" onClick={onOpen}>
            <ExternalLink className="size-3.5" />
          </RowAction>
          <RowAction
            label={isCopied ? "Copied" : "Copy URL"}
            onClick={() => copyToClipboard(resolvedUrl, undefined)}
          >
            {isCopied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          </RowAction>
        </span>
        {server.pid !== null ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopState === "stopping"}
            title={stopState === "force" ? "The server ignored SIGINT — send SIGKILL" : undefined}
            className="ml-1 flex h-6 shrink-0 items-center rounded-md px-2 text-xs font-medium text-destructive/90 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            {stopState === "stopping" ? "Stopping…" : stopState === "force" ? "Force stop" : "Stop"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
            className={cn(
              "flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function StatusDot({ listening }: { listening: boolean }) {
  if (!listening) {
    return (
      <span
        aria-label="No servers listening"
        className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
      />
    );
  }
  return (
    <span aria-label="Listening" className="relative inline-flex size-2 shrink-0">
      <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-success" />
    </span>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next >= 10 ? Math.round(next) : next.toFixed(1)} ${units[unitIndex]}`;
}
