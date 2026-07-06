import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProviderUsageSnapshot, ProviderUsageWindow } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveThreadRouteRef } from "../threadRoutes";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../state/server";
import { useEnvironmentThread } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { ClaudeAI, CursorIcon, GrokIcon, OpenAI, OpenCodeIcon } from "./Icons";
import { useRelativeTimeTick } from "./settings/settingsLayout";
import { toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";

/** Providers whose rate-limit windows zrode can meter server-side. */
type UsageProviderKind = ProviderUsageSnapshot["provider"];
/** Providers zrode integrates but whose vendors expose no usage API yet. */
type UnmeteredProviderKind = "cursor" | "grok" | "opencode";
type AnyUsageProviderKind = UsageProviderKind | UnmeteredProviderKind;

/** An enabled + authenticated provider without a usage API. */
interface UnmeteredProvider {
  readonly kind: UnmeteredProviderKind;
  readonly displayName: string;
  readonly authLabel: string | null;
  readonly email: string | null;
}

/** Provider usage/limits dashboard opened by the popover's "View details" link. */
const PROVIDER_USAGE_URL: Record<AnyUsageProviderKind, string> = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
  cursor: "https://cursor.com/dashboard",
  grok: "https://accounts.x.ai",
  opencode: "https://opencode.ai",
};

/** Driver slug → usage-provider kind for every driver zrode ships. */
const DRIVER_TO_USAGE_KIND: Readonly<Record<string, AnyUsageProviderKind>> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
};

function openProviderUsagePage(url: string): void {
  const api = readLocalApi();
  if (!api) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void api.shell.openExternal(url).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Unable to open usage page",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}

function percentUsed(window: ProviderUsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.usedPercent)));
}

function usageColor(used: number): string {
  if (used >= 90) return "var(--color-red-500)";
  if (used >= 75) return "var(--color-amber-500)";
  return "var(--color-emerald-500)";
}

function formatDurationUntil(timestamp: number | null, nowMs: number): string | null {
  if (timestamp === null) return null;
  const diffMs = timestamp - nowMs;
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function providerDisplayName(provider: AnyUsageProviderKind): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
  }
}

function ProviderUsageIcon({
  provider,
  className,
}: {
  provider: AnyUsageProviderKind;
  className?: string;
}) {
  switch (provider) {
    case "claude":
      return <ClaudeAI className={className} />;
    case "codex":
      return <OpenAI className={className} />;
    case "cursor":
      return <CursorIcon className={className} />;
    case "grok":
      return <GrokIcon className={className} />;
    case "opencode":
      return <OpenCodeIcon className={className} />;
  }
}

/** The most constrained (highest used) of ALL the provider's limit windows. */
function maxPercentUsed(snapshot: ProviderUsageSnapshot): number | null {
  const values = [
    snapshot.session,
    snapshot.weekly,
    ...snapshot.extraLimits.flatMap((limit) => [limit.session, limit.weekly]),
  ]
    .filter((window): window is ProviderUsageWindow => window !== null)
    .map(percentUsed);
  return values.length > 0 ? Math.max(...values) : null;
}

function UsageBar({ used, label, className }: { used: number; label: string; className?: string }) {
  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-muted/50", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${used}%`, backgroundColor: usageColor(used) }}
      />
    </div>
  );
}

function UsageWindowRow({
  title,
  window,
  nowMs,
}: {
  title: string;
  window: ProviderUsageWindow | null;
  nowMs: number;
}) {
  if (!window) {
    return null;
  }
  const used = percentUsed(window);
  const reset = formatDurationUntil(window.resetsAt, nowMs);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-muted-foreground text-xs">{title}</span>
        {reset ? (
          <span className="text-[10px] text-muted-foreground/60">Resets in {reset}</span>
        ) : null}
      </div>
      <UsageBar used={used} label={`${title} usage`} />
      <div className="text-[10px] tabular-nums text-muted-foreground/60">{used}% used</div>
    </div>
  );
}

function ExtraLimitRow({
  limit,
  nowMs,
}: {
  limit: ProviderUsageSnapshot["extraLimits"][number];
  nowMs: number;
}) {
  const windows: Array<{ suffix: string | null; window: ProviderUsageWindow }> = [];
  if (limit.session) windows.push({ suffix: "5h", window: limit.session });
  if (limit.weekly) windows.push({ suffix: limit.session ? "wk" : null, window: limit.weekly });
  if (windows.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="truncate text-[10px] text-muted-foreground/70">{limit.label}</div>
      {windows.map(({ suffix, window }) => {
        const used = percentUsed(window);
        const reset = formatDurationUntil(window.resetsAt, nowMs);
        return (
          <div key={suffix ?? "single"} className="flex items-center gap-2">
            <UsageBar
              used={used}
              label={`${limit.label}${suffix ? ` ${suffix}` : ""} usage`}
              className="flex-1"
            />
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
              {used}%{suffix ? ` ${suffix}` : ""}
              {reset ? ` · ${reset}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function CodexResetCredits({
  snapshot,
  nowMs,
  onConsumed,
}: {
  snapshot: ProviderUsageSnapshot;
  nowMs: number;
  onConsumed: () => void;
}) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const consume = useAtomCommand(serverEnvironment.consumeCodexResetCredit, {
    reportFailure: false,
  });
  const [phase, setPhase] = useState<"idle" | "confirm" | "pending">("idle");
  const [error, setError] = useState<string | null>(null);

  const resetCredits = snapshot.resetCredits;

  const handleClick = useCallback(async () => {
    if (phase === "idle") {
      setPhase("confirm");
      setError(null);
      return;
    }
    if (phase !== "confirm" || environmentId === null) {
      return;
    }
    setPhase("pending");
    const result = await consume({ environmentId, input: {} });
    if (result._tag === "Success" && result.value.ok) {
      setPhase("idle");
      onConsumed();
    } else {
      setPhase("idle");
      setError(
        result._tag === "Success"
          ? (result.value.message ?? "Reset failed.")
          : "Reset request failed.",
      );
    }
  }, [consume, environmentId, onConsumed, phase]);

  if (!resetCredits || resetCredits.availableCount <= 0) {
    return null;
  }
  const expires = formatDurationUntil(resetCredits.nextExpiresAt, nowMs);
  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground">
            {resetCredits.availableCount} rate-limit reset
            {resetCredits.availableCount === 1 ? "" : "s"} available
          </div>
          {expires ? (
            <div className="text-[10px] text-muted-foreground/60">Next expires in {expires}</div>
          ) : null}
        </div>
        <Button
          size="xs"
          variant={phase === "confirm" ? "default" : "outline"}
          className="h-6 shrink-0 px-2 text-[11px]"
          disabled={phase === "pending" || environmentId === null}
          onClick={handleClick}
        >
          {phase === "pending" ? "Resetting…" : phase === "confirm" ? "Confirm reset" : "Reset now"}
        </Button>
      </div>
      <p className="text-pretty text-[10px] text-muted-foreground/50">
        Consumes one credit and fully resets the session and weekly limits.
      </p>
      <div aria-live="polite">
        {error ? <p className="text-[10px] text-red-500">{error}</p> : null}
      </div>
    </div>
  );
}

function ProviderUsagePopoverContent({
  snapshot,
  availableProviders,
  onSelectProvider,
  nowMs,
  isPending,
  refresh,
}: {
  snapshot: ProviderUsageSnapshot;
  availableProviders: ReadonlyArray<UsageProviderKind>;
  onSelectProvider: (provider: UsageProviderKind) => void;
  nowMs: number;
  isPending: boolean;
  refresh: () => void;
}) {
  const displayName = providerDisplayName(snapshot.provider);
  const hasWindows = snapshot.session !== null || snapshot.weekly !== null;
  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderUsageIcon provider={snapshot.provider} className="size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-sm">{displayName}</span>
            {snapshot.planLabel ? (
              <span className="truncate text-[10px] text-muted-foreground/60">
                {snapshot.planLabel}
              </span>
            ) : null}
          </div>
          <div className="text-[10px] text-muted-foreground/60">
            Updated {formatRelativeTimeLabel(new Date(snapshot.updatedAt).toISOString())}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {availableProviders.length > 1 ? (
            <div className="mr-1 flex items-center gap-0.5 rounded-sm bg-muted/40 p-0.5">
              {availableProviders.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  className={cn(
                    "flex size-4.5 cursor-pointer items-center justify-center rounded-[3px] transition-colors",
                    provider === snapshot.provider
                      ? "bg-background shadow-xs"
                      : "opacity-40 hover:opacity-80",
                  )}
                  onClick={() => onSelectProvider(provider)}
                  aria-label={`Show ${providerDisplayName(provider)} usage`}
                  aria-pressed={provider === snapshot.provider}
                >
                  <ProviderUsageIcon provider={provider} className="size-3" />
                </button>
              ))}
            </div>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground/60 hover:text-foreground"
            disabled={isPending}
            onClick={refresh}
            aria-label="Refresh usage data"
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground/60 hover:text-foreground"
            onClick={() => openProviderUsagePage(PROVIDER_USAGE_URL[snapshot.provider])}
            aria-label={`View ${displayName} usage details`}
          >
            <ExternalLinkIcon className="size-3" />
          </Button>
        </div>
      </div>

      {snapshot.status === "ok" && hasWindows ? (
        <>
          <UsageWindowRow title="Session" window={snapshot.session} nowMs={nowMs} />
          <UsageWindowRow title="Weekly (all models)" window={snapshot.weekly} nowMs={nowMs} />
          {snapshot.extraLimits.length > 0 ? (
            <div className="flex flex-col gap-2 border-t pt-2">
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                Model limits
              </div>
              {snapshot.extraLimits.map((limit) => (
                <ExtraLimitRow key={limit.label} limit={limit} nowMs={nowMs} />
              ))}
            </div>
          ) : null}
          {snapshot.extraUsage?.enabled ? (
            <div className="flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
              <span>Extra usage</span>
              <span className="tabular-nums text-muted-foreground/70">
                {snapshot.extraUsage.utilization !== null
                  ? `${Math.round(snapshot.extraUsage.utilization)}% used`
                  : "Enabled"}
              </span>
            </div>
          ) : null}
          {snapshot.credits && (snapshot.credits.hasCredits || snapshot.credits.unlimited) ? (
            <div className="flex items-center justify-between gap-2 border-t pt-2 text-[11px] text-muted-foreground">
              <span>Credits</span>
              <span className="tabular-nums text-muted-foreground/70">
                {snapshot.credits.unlimited
                  ? "Unlimited"
                  : (snapshot.credits.balance ?? "Available")}
              </span>
            </div>
          ) : null}
          <CodexResetCredits snapshot={snapshot} nowMs={nowMs} onConsumed={refresh} />
        </>
      ) : (
        <div className="text-pretty text-[11px] text-muted-foreground/70">
          {snapshot.message ?? "No usage data available."}
        </div>
      )}
    </div>
  );
}

/**
 * Enabled + authenticated providers that have no usage API: they still get a
 * footer tile (icon-only) whose popover shows the signed-in account and links
 * to the vendor's own usage dashboard.
 */
function useUnmeteredProviders(): ReadonlyArray<UnmeteredProvider> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(() => {
    const byKind = new Map<UnmeteredProviderKind, UnmeteredProvider>();
    for (const provider of providers) {
      const kind = DRIVER_TO_USAGE_KIND[provider.driver];
      if (kind !== "cursor" && kind !== "grok" && kind !== "opencode") {
        continue;
      }
      if (
        byKind.has(kind) ||
        !provider.enabled ||
        !provider.installed ||
        provider.auth.status !== "authenticated"
      ) {
        continue;
      }
      byKind.set(kind, {
        kind,
        displayName: provider.displayName ?? providerDisplayName(kind),
        authLabel: provider.auth.label ?? null,
        email: provider.auth.email ?? null,
      });
    }
    return Array.from(byKind.values());
  }, [providers]);
}

function UnmeteredProviderPill({ provider }: { provider: UnmeteredProvider }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex h-6 shrink-0 cursor-pointer items-center rounded-md px-1.5 outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-label={`${provider.displayName} subscription`}
          >
            <ProviderUsageIcon
              provider={provider.kind}
              className="size-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-90"
            />
          </button>
        }
      />
      <PopoverPopup side="top" align="end" className="w-72 max-w-none p-0">
        <div className="flex flex-col gap-2.5 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <ProviderUsageIcon provider={provider.kind} className="size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-medium text-sm">{provider.displayName}</span>
                {provider.authLabel ? (
                  <span className="truncate text-[10px] text-muted-foreground/60">
                    {provider.authLabel}
                  </span>
                ) : null}
              </div>
              {provider.email ? (
                <div className="truncate text-[10px] text-muted-foreground/60">
                  {provider.email}
                </div>
              ) : null}
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground/60 hover:text-foreground"
              onClick={() => openProviderUsagePage(PROVIDER_USAGE_URL[provider.kind])}
              aria-label={`View ${provider.displayName} usage details`}
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
          </div>
          <div className="text-pretty text-[11px] text-muted-foreground/70">
            {provider.displayName} doesn't expose live usage metering yet. Check your usage on the{" "}
            {provider.displayName} dashboard.
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

interface ActiveThreadUsageTarget {
  /** Usage-provider kind the open thread runs on, when resolvable. */
  readonly provider: AnyUsageProviderKind | null;
  /** Identity of the open thread, so callers can react to thread changes. */
  readonly threadKey: string | null;
}

/**
 * Resolve the usage-provider kind driving the thread currently open in the
 * route, so the footer meter reflects the subscription that thread spends.
 */
function useActiveThreadUsageProvider(
  primaryEnvironmentId: string | null,
): ActiveThreadUsageTarget {
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  // Usage is fetched from the primary environment, so only pin when the open
  // thread actually lives there — a thread on another environment may run on
  // a different account whose usage we are not showing.
  const isPrimaryEnvironmentThread =
    routeThreadRef !== null && routeThreadRef.environmentId === primaryEnvironmentId;
  const threadState = useEnvironmentThread(
    isPrimaryEnvironmentThread ? routeThreadRef.environmentId : null,
    isPrimaryEnvironmentThread ? routeThreadRef.threadId : null,
  );
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(() => {
    if (!isPrimaryEnvironmentThread) {
      return { provider: null, threadKey: null };
    }
    const threadKey = `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`;
    const thread = Option.getOrNull(threadState.data);
    const instanceId = thread?.modelSelection?.instanceId ?? null;
    if (instanceId === null) {
      return { provider: null, threadKey };
    }
    // Resolve the instance's driver; default instance ids equal their driver
    // slug, so fall back to that invariant only for the known defaults
    // instead of guessing from arbitrary custom instance ids.
    const driver =
      providers.find((provider) => provider.instanceId === instanceId)?.driver ??
      (instanceId in DRIVER_TO_USAGE_KIND ? instanceId : null);
    return {
      provider: driver === null ? null : (DRIVER_TO_USAGE_KIND[driver] ?? null),
      threadKey,
    };
  }, [isPrimaryEnvironmentThread, providers, routeThreadRef, threadState.data]);
}

function ProviderUsagePill({
  snapshot,
  availableProviders,
  onSelectProvider,
  showBar,
  nowMs,
  isPending,
  refresh,
}: {
  snapshot: ProviderUsageSnapshot;
  availableProviders: ReadonlyArray<UsageProviderKind>;
  onSelectProvider: (provider: UsageProviderKind) => void;
  /** Hide the micro-bar in multi-pill mode to keep the row compact. */
  showBar: boolean;
  nowMs: number;
  isPending: boolean;
  refresh: () => void;
}) {
  const displayName = providerDisplayName(snapshot.provider);
  const used = snapshot.status === "ok" ? maxPercentUsed(snapshot) : null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "group inline-flex h-6 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring",
            )}
            aria-label={`${displayName} subscription usage`}
          >
            <ProviderUsageIcon
              provider={snapshot.provider}
              className="size-3 shrink-0 opacity-50 transition-opacity group-hover:opacity-90"
            />
            {used !== null ? (
              <>
                {showBar ? (
                  <UsageBar
                    used={used}
                    label={`${displayName} usage`}
                    className="h-[3px] w-8 opacity-60 transition-opacity group-hover:opacity-100"
                  />
                ) : null}
                <span
                  className="shrink-0 text-[10px] tabular-nums transition-colors group-hover:text-muted-foreground"
                  style={{ color: showBar ? undefined : usageColor(used) }}
                >
                  {used}%
                </span>
              </>
            ) : (
              <span className="truncate text-[10px] text-muted-foreground/50 transition-colors group-hover:text-muted-foreground">
                {snapshot.status === "unauthenticated" ? "Sign in" : "—"}
              </span>
            )}
          </button>
        }
      />
      <PopoverPopup side="top" align="end" className="w-72 max-w-none p-0">
        <ProviderUsagePopoverContent
          snapshot={snapshot}
          availableProviders={availableProviders}
          onSelectProvider={onSelectProvider}
          nowMs={nowMs}
          isPending={isPending}
          refresh={refresh}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * Minimal subscription-usage meter sharing the sidebar footer row with the
 * Settings button. On a thread it pins to the provider that thread runs on
 * (one pill: icon + micro-bar + % used of the most constrained window),
 * switchable via the popover's provider selector. Outside a thread it shows
 * a general overview — one compact pill per active subscription, including
 * icon-only tiles for providers without a usage API (Cursor, Grok,
 * OpenCode) that link out to the vendor's dashboard. The popover details
 * session/weekly windows, model-scoped limits, credits, and Codex
 * rate-limit resets.
 */
export function ProviderUsageStatus() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.providerUsage({ environmentId, input: {} }),
  );
  const nowMs = useRelativeTimeTick(30_000);
  const threadTarget = useActiveThreadUsageProvider(environmentId);
  const threadProvider = threadTarget.provider;
  const unmeteredProviders = useUnmeteredProviders();
  const [manualProvider, setManualProvider] = useState<UsageProviderKind | null>(null);

  // Entering a thread — including another thread on the same provider —
  // re-pins the meter to that thread's provider until the user explicitly
  // switches again.
  useEffect(() => {
    setManualProvider(null);
  }, [threadTarget.threadKey, threadProvider]);

  if (environmentId === null) {
    return null;
  }

  // First load (or reconnect) before any usage data has arrived: hold the
  // pill's footprint with a skeleton so the footer row doesn't jump.
  if (data === null) {
    if (error !== null && !isPending) {
      return null;
    }
    return (
      <div
        className="flex h-6 shrink-0 items-center gap-1.5 px-1.5"
        aria-label="Loading subscription usage"
        aria-busy="true"
      >
        <Skeleton className="size-3 rounded-full" />
        <Skeleton className="h-[3px] w-8 rounded-full" />
        <Skeleton className="h-2 w-5" />
      </div>
    );
  }

  const snapshots = data.usage.filter((snapshot) => snapshot.status !== "unavailable");

  if (snapshots.length === 0 && unmeteredProviders.length === 0) {
    return null;
  }

  // On a thread: one pill pinned to that thread's provider, with the popover
  // selector available to peek at the other metered subscription. The manual
  // pick falls back to the thread's provider if its snapshot disappears
  // (e.g. the provider was just disabled); if the thread runs on a provider
  // without metering, its account tile is pinned instead. Anything else
  // falls through to the overview rather than silently substituting another
  // provider.
  const pinnedSnapshot =
    threadProvider === null
      ? undefined
      : (snapshots.find((entry) => entry.provider === (manualProvider ?? threadProvider)) ??
        snapshots.find((entry) => entry.provider === threadProvider));

  if (pinnedSnapshot !== undefined) {
    return (
      <ProviderUsagePill
        snapshot={pinnedSnapshot}
        availableProviders={snapshots.map((entry) => entry.provider)}
        onSelectProvider={setManualProvider}
        showBar
        nowMs={nowMs}
        isPending={isPending}
        refresh={refresh}
      />
    );
  }

  const pinnedUnmetered =
    threadProvider === null
      ? undefined
      : unmeteredProviders.find((provider) => provider.kind === threadProvider);

  if (pinnedUnmetered !== undefined) {
    return <UnmeteredProviderPill provider={pinnedUnmetered} />;
  }

  // No thread open (or the thread's provider is unavailable): general
  // overview of every active subscription.
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {snapshots.map((snapshot) => (
        <ProviderUsagePill
          key={snapshot.provider}
          snapshot={snapshot}
          availableProviders={[snapshot.provider]}
          onSelectProvider={setManualProvider}
          showBar={snapshots.length === 1}
          nowMs={nowMs}
          isPending={isPending}
          refresh={refresh}
        />
      ))}
      {unmeteredProviders.map((provider) => (
        <UnmeteredProviderPill key={provider.kind} provider={provider} />
      ))}
    </div>
  );
}
