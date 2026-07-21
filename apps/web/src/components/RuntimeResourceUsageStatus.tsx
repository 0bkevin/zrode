import { Activity, RefreshCw } from "lucide-react";
import type {
  EnvironmentId,
  ProviderRuntimeResourceUsage,
  TerminalRuntimeResourceUsage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { formatRuntimeBytes, formatRuntimeCpu } from "./runtimeResourceFormatting";
import { RuntimeStatusAccordion } from "./RuntimeStatusAccordion";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

function ResourceNumbers({
  cpuPercent,
  rssBytes,
  processCount,
}: {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}) {
  return (
    <div className="grid shrink-0 grid-cols-[3.5rem_4.5rem] gap-2 text-right text-[10px] tabular-nums text-muted-foreground">
      <span title="CPU usage, measured as a percentage of one logical core">
        {formatRuntimeCpu(cpuPercent)}
      </span>
      <span title={`${processCount} process${processCount === 1 ? "" : "es"}`}>
        {formatRuntimeBytes(rssBytes)}
      </span>
    </div>
  );
}

function providerStatus(status: ProviderRuntimeResourceUsage["session"]["status"]): {
  readonly label: string;
  readonly dotClassName: string;
} {
  switch (status) {
    case "running":
      return { label: "Running", dotClassName: "bg-success" };
    case "ready":
      return { label: "Ready", dotClassName: "bg-sky-500" };
    case "connecting":
      return { label: "Connecting", dotClassName: "animate-pulse bg-amber-500" };
    case "error":
      return { label: "Error", dotClassName: "bg-destructive" };
    case "closed":
      return { label: "Closed", dotClassName: "bg-muted-foreground/35" };
  }
}

function ProviderResourceRow({ usage }: { readonly usage: ProviderRuntimeResourceUsage }) {
  const { session } = usage;
  const status = providerStatus(session.status);
  const label = session.providerInstanceId ?? session.provider;
  const detail = ["Agent", session.model, session.cwd].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <span className={cn("size-2 shrink-0 rounded-full", status.dotClassName)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">{label}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{status.label}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground/55" title={detail}>
          {detail || session.threadId}
        </div>
      </div>
      <ResourceNumbers {...usage} />
    </div>
  );
}

function terminalStatus(usage: TerminalRuntimeResourceUsage): {
  readonly label: string;
  readonly dotClassName: string;
} {
  const { terminal } = usage;
  if (terminal.status === "error") return { label: "Error", dotClassName: "bg-destructive" };
  if (terminal.status === "starting") {
    return { label: "Starting", dotClassName: "animate-pulse bg-amber-500" };
  }
  if (terminal.status === "exited") {
    return { label: "Exited", dotClassName: "bg-muted-foreground/35" };
  }
  if (terminal.hasRunningSubprocess) return { label: "Active", dotClassName: "bg-success" };
  return { label: "Idle", dotClassName: "bg-sky-500" };
}

function TerminalResourceRow({ usage }: { readonly usage: TerminalRuntimeResourceUsage }) {
  const status = terminalStatus(usage);
  const detail = ["Terminal task", usage.terminal.cwd].join(" · ");
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <span className={cn("size-2 shrink-0 rounded-full", status.dotClassName)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-medium text-foreground">
            {usage.terminal.label}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground/60">{status.label}</span>
        </div>
        <div className="truncate text-[10px] text-muted-foreground/55" title={detail}>
          {detail}
        </div>
      </div>
      <ResourceNumbers {...usage} />
    </div>
  );
}

function totalUsage(
  usages: ReadonlyArray<{ readonly cpuPercent: number; readonly rssBytes: number }>,
): { readonly cpuPercent: number; readonly rssBytes: number } {
  return usages.reduce(
    (total, usage) => ({
      cpuPercent: total.cpuPercent + usage.cpuPercent,
      rssBytes: total.rssBytes + usage.rssBytes,
    }),
    { cpuPercent: 0, rssBytes: 0 },
  );
}

function activitySummary(
  providers: ReadonlyArray<ProviderRuntimeResourceUsage>,
  terminals: ReadonlyArray<TerminalRuntimeResourceUsage>,
): string {
  const errorCount =
    providers.filter(({ session }) => session.status === "error").length +
    terminals.filter(({ terminal }) => terminal.status === "error").length;
  const usage = totalUsage([...providers, ...terminals]);
  const processCount = [...providers, ...terminals].reduce(
    (total, item) => total + item.processCount,
    0,
  );
  return [
    errorCount > 0 ? `${errorCount} ${errorCount === 1 ? "error" : "errors"}` : null,
    providers.length > 0
      ? `${providers.length} ${providers.length === 1 ? "agent" : "agents"}`
      : null,
    terminals.length > 0
      ? `${terminals.length} ${terminals.length === 1 ? "terminal task" : "terminal tasks"}`
      : null,
    processCount > 0 ? `${formatRuntimeCpu(usage.cpuPercent)} CPU` : null,
    processCount > 0 ? formatRuntimeBytes(usage.rssBytes) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function runtimeTerminalKey(terminal: {
  readonly threadId: string;
  readonly terminalId: string;
}): string {
  return `${terminal.threadId}\u0000${terminal.terminalId}`;
}

export function RuntimeResourceUsageSections({
  environmentId,
  representedTerminalKeys,
}: {
  readonly environmentId: EnvironmentId;
  readonly representedTerminalKeys: ReadonlySet<string>;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.runtimeResourceUsage({ environmentId, input: {} }),
  );
  const snapshotError = query.data ? Option.getOrNull(query.data.error) : null;
  const providers =
    query.data?.providers.filter(({ session }) => session.status !== "closed") ?? [];
  const terminals =
    query.data?.terminals.filter(
      ({ terminal }) =>
        !representedTerminalKeys.has(runtimeTerminalKey(terminal)) &&
        (terminal.hasRunningSubprocess ||
          terminal.status === "starting" ||
          terminal.status === "error"),
    ) ?? [];
  const activityCount = providers.length + terminals.length;
  const activityUsage = totalUsage([...providers, ...terminals]);
  const activityProcessCount = [...providers, ...terminals].reduce(
    (total, usage) => total + usage.processCount,
    0,
  );

  return (
    <section>
      {query.error || snapshotError ? (
        <div className="flex items-start gap-2 border-t px-3 py-3 text-pretty text-[11px] text-destructive">
          <span className="min-w-0 flex-1">{query.error ?? snapshotError?.message}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 shrink-0"
            onClick={query.refresh}
            aria-label="Retry activity"
          >
            <RefreshCw className={cn("size-3", query.isPending && "animate-spin")} />
          </Button>
        </div>
      ) : query.data ? (
        <>
          {activityCount > 0 ? (
            <RuntimeStatusAccordion
              icon={<Activity className="size-3" />}
              label="Other activity"
              count={activityCount}
              summary={activitySummary(providers, terminals)}
              attention={
                providers.some(({ session }) => session.status === "error") ||
                terminals.some(({ terminal }) => terminal.status === "error")
              }
            >
              <div className="divide-y">
                {providers.map((usage) => (
                  <ProviderResourceRow
                    key={`${usage.session.providerInstanceId}:${usage.session.threadId}`}
                    usage={usage}
                  />
                ))}
                {terminals.map((usage) => (
                  <TerminalResourceRow
                    key={`${usage.terminal.threadId}:${usage.terminal.terminalId}`}
                    usage={usage}
                  />
                ))}
              </div>
            </RuntimeStatusAccordion>
          ) : null}
          <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[10px] text-muted-foreground/65">
            <span
              className="min-w-0 flex-1 truncate"
              title="CPU is per logical core. Memory includes descendant processes."
            >
              {activityCount === 0
                ? "No other activity"
                : activityProcessCount === 0
                  ? "No local resource usage"
                  : `${activityProcessCount} ${activityProcessCount === 1 ? "process" : "processes"} · ${formatRuntimeCpu(activityUsage.cpuPercent)} CPU · ${formatRuntimeBytes(activityUsage.rssBytes)}`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0"
              onClick={query.refresh}
              aria-label="Refresh activity"
            >
              <RefreshCw className={cn("size-3", query.isPending && "animate-spin")} />
            </Button>
          </div>
        </>
      ) : (
        <div className="space-y-2 border-t px-3 py-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      )}
    </section>
  );
}
