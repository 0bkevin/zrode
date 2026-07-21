/**
 * Always-visible runtime status button for the chat pane's bottom toolbar.
 * The popover combines local server controls with live provider and terminal
 * resource usage for the active thread's environment.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DiscoveredLocalServer, ScopedThreadRef } from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as Option from "effect/Option";
import {
  Check,
  Copy,
  ExternalLink,
  Info,
  LoaderCircle,
  RadioTower,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { openDiscoveredPort } from "~/components/preview/openDiscoveredPort";
import { formatRuntimeBytes } from "~/components/runtimeResourceFormatting";
import {
  RuntimeResourceUsageSections,
  runtimeTerminalKey,
} from "~/components/RuntimeResourceUsageStatus";
import { RuntimeStatusAccordion } from "~/components/RuntimeStatusAccordion";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { useSidebarVisibility } from "~/components/ui/sidebar";
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
/** Docker stop already waits up to five seconds; allow one scan after that. */
const DOCKER_FORCE_STOP_DELAY_MS = 8_000;

type StopState = "stopping" | "force";

function stopKey(server: DiscoveredLocalServer): string | null {
  if (server.container != null) return `docker:${server.container.id}`;
  return server.pid === null ? null : `process:${server.pid}`;
}

export function LocalServersStatusButton({ threadRef }: LocalServersStatusButtonProps) {
  const { servers } = useDiscoveredServerSnapshot(threadRef.environmentId);
  const sidebarVisible = useSidebarVisibility();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const signalServerProcess = useAtomCommand(serverEnvironment.signalProcess, {
    reportFailure: false,
  });
  const [stopStateByKey, setStopStateByKey] = useState<ReadonlyMap<string, StopState>>(new Map());
  const stopTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearStopTracking = useCallback((key: string) => {
    const timer = stopTimersRef.current.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      stopTimersRef.current.delete(key);
    }
    setStopStateByKey((current) => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);

  // A pid disappearing from the snapshot means the stop worked — drop its
  // in-flight state so the map doesn't accumulate dead entries.
  useEffect(() => {
    setStopStateByKey((current) => {
      if (current.size === 0) return current;
      const alive = new Set(
        servers.flatMap((server) => {
          const key = stopKey(server);
          return key === null ? [] : [key];
        }),
      );
      let changed = false;
      const next = new Map(current);
      for (const key of current.keys()) {
        if (alive.has(key)) continue;
        next.delete(key);
        const timer = stopTimersRef.current.get(key);
        if (timer !== undefined) {
          clearTimeout(timer);
          stopTimersRef.current.delete(key);
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

  const representedTerminalKeys = useMemo(
    () =>
      new Set(
        servers.flatMap((server) =>
          server.terminal === null ? [] : [runtimeTerminalKey(server.terminal)],
        ),
      ),
    [servers],
  );

  // One process or Docker container can listen on several ports. Count each
  // owner once and avoid attributing Docker Desktop's shared memory to an
  // individual container.
  const { processCount, totalMemoryBytes } = useMemo(() => {
    const owners = new Set<string>();
    const memoryByOwner = new Map<string, number>();
    for (const server of servers) {
      const key = stopKey(server) ?? `port:${server.host}:${server.port}`;
      owners.add(key);
      if (server.managedBy !== "docker" && server.memoryBytes != null) {
        memoryByOwner.set(key, server.memoryBytes);
      }
    }
    let totalMemory = 0;
    for (const memoryBytes of memoryByOwner.values()) totalMemory += memoryBytes;
    return {
      processCount: owners.size,
      totalMemoryBytes: memoryByOwner.size > 0 ? totalMemory : null,
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
      const key = stopKey(server);
      if (key === null) return;
      const force = stopStateByKey.get(key) === "force";
      if (
        force &&
        !window.confirm(
          server.container != null
            ? `Force stop Docker container ${server.container.name}? It will be killed immediately.`
            : `Force stop ${server.processName ?? `process ${pid}`}? SIGKILL cannot be handled by the process.`,
        )
      ) {
        return;
      }
      setStopStateByKey((current) => new Map(current).set(key, "stopping"));
      const existingTimer = stopTimersRef.current.get(key);
      if (existingTimer !== undefined) clearTimeout(existingTimer);
      stopTimersRef.current.set(
        key,
        setTimeout(
          () => {
            stopTimersRef.current.delete(key);
            // Still listening after the grace period — offer a force stop.
            setStopStateByKey((current) =>
              current.get(key) === "stopping" ? new Map(current).set(key, "force") : current,
            );
          },
          server.container != null ? DOCKER_FORCE_STOP_DELAY_MS : FORCE_STOP_DELAY_MS,
        ),
      );
      void (async () => {
        const result = await signalServerProcess({
          environmentId: threadRef.environmentId,
          input: {
            pid,
            signal: force ? "SIGKILL" : "SIGINT",
            port: server.port,
            ...(server.container != null ? { dockerContainerId: server.container.id } : {}),
          },
        });
        if (result._tag === "Failure") {
          clearStopTracking(key);
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
          clearStopTracking(key);
          const message = Option.getOrUndefined(result.value.message);
          toastManager.add({
            type: "error",
            title: "Can't stop this server",
            description: message ?? `Process ${pid} did not accept the signal.`,
          });
        }
        // When the signal landed, keep the "Stopping…" state until the row
        // disappears from the scan (handled by the eviction effect) or the
        // grace timer escalates to a force-stop offer.
      })();
    },
    [clearStopTracking, signalServerProcess, stopStateByKey, threadRef.environmentId],
  );

  const openTerminal = useCallback(
    (terminalId: string) => {
      useRightPanelStore.getState().openTerminal(threadRef, terminalId);
    },
    [threadRef],
  );

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label="Show runtime status"
        title="Show runtime status"
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground opacity-80 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-popup-open:bg-accent data-popup-open:text-foreground"
      >
        <StatusDot listening={processCount > 0} />
        <span className="tabular-nums">
          {processCount === 0
            ? "No servers"
            : `${processCount} ${processCount === 1 ? "server" : "servers"}`}
        </span>
        {!sidebarVisible && totalMemoryBytes != null ? (
          <span className="tabular-nums">· {formatRuntimeBytes(totalMemoryBytes)}</span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        alignOffset={16}
        collisionPadding={16}
        sideOffset={8}
        className="w-[25rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        viewportClassName="!overflow-hidden p-0 [--viewport-inline-padding:--spacing(0)]"
        style={{
          maxWidth: "min(100%, calc(100vw - 1rem))",
          maxHeight: "min(var(--available-height), 28rem, 60dvh)",
        }}
      >
        <div
          className="flex w-full min-h-0 flex-col overflow-hidden"
          style={{ maxHeight: "min(var(--available-height), 28rem, 60dvh)" }}
        >
          <div className="shrink-0 border-b px-3 py-2.5">
            <div className="text-sm font-medium text-foreground">Runtime status</div>
            <div className="text-[10px] leading-4 text-muted-foreground">
              Local servers and other activity in this environment.
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <RuntimeStatusAccordion
              icon={<RadioTower className="size-3" />}
              label="Local servers"
              count={processCount}
              summary={[
                `${servers.length} ${servers.length === 1 ? "port" : "ports"}`,
                `${processCount} ${processCount === 1 ? "process" : "processes"}`,
                totalMemoryBytes == null ? null : formatRuntimeBytes(totalMemoryBytes),
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {servers.length === 0 ? (
                <div className="px-3 py-3 text-[11px] text-muted-foreground">
                  No local servers listening
                </div>
              ) : (
                <div className="flex flex-col gap-1 p-1">
                  {groups.map((group) => (
                    <div key={group.key} className="flex flex-col">
                      {groups.length > 1 ? (
                        <h3 className="px-2 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
                          {group.title}
                        </h3>
                      ) : null}
                      {group.servers.map((server) => {
                        const terminal = server.terminal;
                        const key = stopKey(server);
                        return (
                          <LocalServerRow
                            key={`${server.host}:${server.port}:${server.pid ?? "unknown"}`}
                            server={server}
                            resolvedUrl={resolveDiscoveredServerUrl(
                              threadRef.environmentId,
                              server.url,
                            )}
                            stopState={key === null ? null : (stopStateByKey.get(key) ?? null)}
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
            </RuntimeStatusAccordion>
            <RuntimeResourceUsageSections
              environmentId={threadRef.environmentId}
              representedTerminalKeys={representedTerminalKeys}
            />
          </div>
        </div>
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
    server.container?.name ??
    server.processName ??
    (server.pid !== null ? `PID ${server.pid}` : "Unknown process");
  const cpuPercent = server.container == null ? server.cpuPercent : null;
  const isUnresolvedDockerProcess = server.managedBy === "docker" && server.container == null;
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1 transition-colors hover:bg-accent/50">
      <span className="flex h-5 items-center">
        <StatusDot listening />
      </span>
      <button
        type="button"
        onClick={onOpen}
        title={
          server.container != null
            ? `Docker container ${server.container.name} (${server.container.id.slice(0, 12)})`
            : (server.commandLine ?? undefined)
        }
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-left"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          {server.container != null ? (
            <span className="shrink-0 rounded bg-sky-500/10 px-1 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400">
              Docker
            </span>
          ) : null}
          {server.pid !== null && server.processName !== null && server.container == null ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
              {server.pid}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
          <span className="truncate">
            {server.host}:{server.port}
          </span>
          {server.container != null ? (
            <span className="truncate">· Container {server.container.id.slice(0, 12)}</span>
          ) : null}
          {cpuPercent != null ? (
            <>
              <span aria-hidden>·</span>
              <CpuUsage cpuPercent={cpuPercent} />
            </>
          ) : null}
          {server.container == null && server.memoryBytes != null ? (
            <span className="truncate">· {formatRuntimeBytes(server.memoryBytes)}</span>
          ) : null}
        </span>
        {server.cwd != null && server.container == null ? (
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
        {server.pid !== null && !isUnresolvedDockerProcess ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopState === "stopping"}
            aria-label={
              stopState === "stopping"
                ? "Stopping server"
                : stopState === "force"
                  ? "Force stop server"
                  : "Stop server"
            }
            title={
              stopState === "force"
                ? server.container != null
                  ? "The container did not stop gracefully — kill only this container"
                  : "The server ignored SIGINT — send SIGKILL"
                : server.container != null
                  ? `Stop only the ${server.container.name} container`
                  : "Stop this process and every port it owns"
            }
            className="ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-destructive/90 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            {stopState === "stopping" ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3 fill-current" />
            )}
          </button>
        ) : isUnresolvedDockerProcess ? (
          <span
            className="ml-1 max-w-24 text-right text-[10px] leading-3 text-muted-foreground"
            title="Zrode could not identify which container owns this port, so stopping the shared Docker backend is disabled."
          >
            Managed by Docker
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CpuUsage({ cpuPercent }: { cpuPercent: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center gap-0.5">
            {cpuPercent}% CPU
            <Info className="size-3" />
          </span>
        }
      />
      <TooltipPopup side="top" className="max-w-72 text-pretty">
        CPU is measured per logical core. 100% uses one full core, so multi-core processes can
        exceed 100%.
      </TooltipPopup>
    </Tooltip>
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
              "flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
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
