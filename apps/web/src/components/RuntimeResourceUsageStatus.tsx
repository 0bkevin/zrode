import { Activity, Bot, MemoryStick, RefreshCw, TerminalSquare } from "lucide-react";
import type {
  EnvironmentId,
  ProviderRuntimeResourceUsage,
  TerminalRuntimeResourceUsage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "../state/environments";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";

function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let amount = value;
  let unitIndex = -1;
  do {
    amount /= 1_024;
    unitIndex += 1;
  } while (amount >= 1_024 && unitIndex < units.length - 1);
  return `${amount >= 10 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`;
}

function formatCpu(value: number): string {
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}%`;
}

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
        {formatCpu(cpuPercent)}
      </span>
      <span title={`${processCount} process${processCount === 1 ? "" : "es"}`}>
        {formatBytes(rssBytes)}
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
  const detail = [session.model, session.cwd].filter(Boolean).join(" · ");
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
        <div className="truncate text-[10px] text-muted-foreground/55" title={usage.terminal.cwd}>
          {usage.terminal.cwd}
        </div>
      </div>
      <ResourceNumbers {...usage} />
    </div>
  );
}

function GroupHeader({ icon, label }: { readonly icon: React.ReactNode; readonly label: string }) {
  return (
    <div className="flex h-7 items-center gap-1.5 border-y bg-muted/20 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground first:border-t-0">
      {icon}
      {label}
    </div>
  );
}

function EnvironmentResourceUsage({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.runtimeResourceUsage({ environmentId, input: {} }),
  );
  const snapshotError = query.data ? Option.getOrNull(query.data.error) : null;

  return (
    <section className="border-b last:border-b-0">
      <div className="flex h-9 items-center gap-2 bg-muted/35 px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{label}</span>
        {query.data ? (
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatCpu(query.data.totalCpuPercent)} CPU · {formatBytes(query.data.totalRssBytes)}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5"
          onClick={query.refresh}
          aria-label={`Refresh ${label} runtime resources`}
        >
          <RefreshCw className={cn("size-3", query.isPending && "animate-spin")} />
        </Button>
      </div>
      {query.error || snapshotError ? (
        <div className="px-3 py-3 text-pretty text-[11px] text-destructive">
          {query.error ?? snapshotError?.message}
        </div>
      ) : query.data ? (
        query.data.providers.length > 0 || query.data.terminals.length > 0 ? (
          <>
            {query.data.providers.length > 0 ? (
              <>
                <GroupHeader icon={<Bot className="size-3" />} label="Provider instances" />
                <div className="divide-y">
                  {query.data.providers.map((usage) => (
                    <ProviderResourceRow
                      key={`${usage.session.providerInstanceId}:${usage.session.threadId}`}
                      usage={usage}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {query.data.terminals.length > 0 ? (
              <>
                <GroupHeader icon={<TerminalSquare className="size-3" />} label="Terminals" />
                <div className="divide-y">
                  {query.data.terminals.map((usage) => (
                    <TerminalResourceRow
                      key={`${usage.terminal.threadId}:${usage.terminal.terminalId}`}
                      usage={usage}
                    />
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            No running provider or terminal sessions
          </div>
        )
      ) : (
        <div className="space-y-2 px-3 py-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      )}
    </section>
  );
}

function UnavailableEnvironment({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  return (
    <section className="flex items-center gap-2 border-b px-3 py-2.5 last:border-b-0">
      <span className="size-2 shrink-0 rounded-full bg-muted-foreground/35" />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{environment.label}</span>
      <span className="text-[10px] capitalize text-muted-foreground">
        {environment.connection.phase}
      </span>
    </section>
  );
}

function ResourceUsagePopoverContent() {
  const { environments } = useEnvironments();
  return (
    <div className="flex max-h-[min(32rem,var(--available-height))] flex-col">
      <div className="flex items-start gap-2 border-b px-3 py-3">
        <MemoryStick className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium">Runtime resources</div>
          <div className="text-[10px] leading-4 text-muted-foreground">
            Live status, CPU, and memory for provider instances and terminals.
          </div>
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto">
        {environments.length === 0 ? (
          <div className="px-3 py-5 text-center text-[11px] text-muted-foreground">
            No environments configured
          </div>
        ) : (
          environments.map((environment) =>
            environment.connection.phase === "connected" ? (
              <EnvironmentResourceUsage
                key={environment.environmentId}
                environmentId={environment.environmentId}
                label={environment.label}
              />
            ) : (
              <UnavailableEnvironment key={environment.environmentId} environment={environment} />
            ),
          )
        )}
      </div>
      <div className="border-t px-3 py-2 text-[10px] text-muted-foreground/65">
        CPU is per logical core. Memory includes descendant processes.
      </div>
    </div>
  );
}

export function RuntimeResourceUsageStatus() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="group inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-muted-foreground/55 outline-none transition-colors hover:bg-accent hover:text-foreground data-[pressed]:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Runtime resource usage"
          >
            <Activity className="size-3" />
          </button>
        }
      />
      <PopoverPopup
        side="top"
        align="end"
        className="w-[min(27rem,var(--available-width))] max-w-none p-0"
        viewportClassName="p-0 [--viewport-inline-padding:--spacing(0)]"
      >
        {open ? <ResourceUsagePopoverContent /> : null}
      </PopoverPopup>
    </Popover>
  );
}
