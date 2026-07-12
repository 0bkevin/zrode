/**
 * Subscription usage settings page.
 *
 * GitHub-style calendar heatmaps of each provider subscription's real usage
 * over time. Intensity comes from **daily token activity** backfilled from
 * the provider CLIs' local session logs (so history reaches back months),
 * with the rate-limit utilization samples zrode records (see
 * `ProviderUsageHistory` on the server) layered into tooltips and used as a
 * fallback for days that have a sample but no parsed tokens. One combined
 * calendar colors each day by the subscription that was used most (a fixed
 * hue per subscription), followed by one single-hue calendar per
 * subscription.
 *
 * Day buckets are computed in the *server's* timezone; the calendar anchors
 * to the server-reported `today` so a remote environment in another timezone
 * still lines up with its own data.
 */
import {
  ActivityIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FlameIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ProviderTokenActivityKind } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import {
  ClaudeAI,
  CursorIcon,
  DevinIcon,
  GrokIcon,
  KiloCodeIcon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
import { isUnmeteredProviderEligible } from "../providerUsageEligibility";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import {
  buildTokenSeries,
  toCumulativeSeries,
  UsageAreaChart,
  weekdayAverages,
  WeekdayBarChart,
  type ChartSeries,
} from "./UsageCharts";
import { ShareProfileButton, type ShareProfileData } from "./ShareProfileCard";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

const HISTORY_FETCH_DAYS = 371;

/**
 * Fixed hue per subscription (identity), shared by light and dark mode —
 * orange-600/sky-600 pass the palette checks on both surfaces. Intensity
 * (magnitude) is mixed from the hue per day.
 */
const PROVIDER_HUE: Record<ProviderTokenActivityKind, string> = {
  claude: "var(--color-orange-600)",
  codex: "var(--color-sky-600)",
  grok: "var(--color-violet-600)",
  kilocode: "var(--color-pink-600)",
  opencode: "var(--color-emerald-600)",
};

/**
 * Concrete hex mirrors of the provider hues, for the share card's canvas —
 * a `<canvas>` fillStyle can't resolve Tailwind `var(--color-*)` reliably, so
 * the shareable image gets the brand colors as literal values.
 */
const PROVIDER_SHARE_HEX: Record<ProviderTokenActivityKind, string> = {
  claude: "#ea580c",
  codex: "#0284c7",
  grok: "#7c3aed",
  kilocode: "#db2777",
  opencode: "#059669",
};

const PROVIDER_LABEL: Record<ProviderTokenActivityKind, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  kilocode: "Kilo Code",
  opencode: "OpenCode",
};

/** Providers with backfillable local token history, in a fixed display order. */
const HISTORY_PROVIDERS: ReadonlyArray<ProviderTokenActivityKind> = [
  "claude",
  "codex",
  "grok",
  "kilocode",
  "opencode",
];

function ProviderIcon({
  provider,
  className,
}: {
  provider: ProviderTokenActivityKind;
  className?: string;
}) {
  switch (provider) {
    case "claude":
      return <ClaudeAI className={className} />;
    case "codex":
      return <OpenAI className={className} />;
    case "grok":
      return <GrokIcon className={className} />;
    case "kilocode":
      return <KiloCodeIcon className={className} />;
    case "opencode":
      return <OpenCodeIcon className={className} />;
  }
}

// ── Local-day helpers ────────────────────────────────────────────────
//
// Day keys are YYYY-MM-DD strings bucketed in the server's timezone. The
// client only does calendar arithmetic on those keys, so it never re-buckets.

export function toDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parse a YYYY-MM-DD key into a timezone-agnostic calendar Date. */
function parseDayKey(key: string): Date | null {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  return `${MONTH_LABELS[month - 1]} ${day}, ${year}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(tokens >= 1e10 ? 0 : 1)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(tokens >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(tokens)}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

// ── Unmetered subscriptions (no local token data) ────────────────────
//
// Cursor, Devin, and Grok integrate with zrode but keep no local per-message
// token usage on disk (Cursor records code-authorship stats; Grok's local logs
// only hold a constant system-prompt size), so there is nothing to backfill. We
// still surface them honestly with a link to the vendor's own dashboard.

type UnmeteredKind = "cursor" | "devin";

const UNMETERED_DRIVER_TO_KIND: Readonly<Record<string, UnmeteredKind>> = {
  cursor: "cursor",
  devin: "devin",
};

const UNMETERED_META: Record<
  UnmeteredKind,
  { label: string; dashboardUrl: string; icon: typeof CursorIcon }
> = {
  cursor: { label: "Cursor", dashboardUrl: "https://cursor.com/dashboard", icon: CursorIcon },
  devin: { label: "Devin", dashboardUrl: "https://app.devin.ai", icon: DevinIcon },
};

function openDashboard(url: string): void {
  const api = readLocalApi();
  if (!api) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void api.shell.openExternal(url).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title: "Unable to open dashboard",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  });
}

// ── Calendar model ───────────────────────────────────────────────────

export interface DayUsage {
  readonly provider: ProviderTokenActivityKind;
  /** Total tokens the subscription processed that day (0 when unknown). */
  readonly tokens: number;
  /** Peak session-window utilization sampled that day, when recorded. */
  readonly peakSessionPercent: number | null;
  readonly peakWeeklyPercent: number | null;
}

interface DayCell {
  readonly key: string;
  readonly usages: ReadonlyArray<DayUsage>;
  /** The most-used subscription that day; colors the combined cell. */
  readonly top: DayUsage | null;
  readonly isFuture: boolean;
}

/** The hardest-hit sampled window of the day, session or weekly. */
function peakPercent(usage: DayUsage): number {
  return Math.max(usage.peakSessionPercent ?? 0, usage.peakWeeklyPercent ?? 0);
}

function usageRank(usage: DayUsage): number {
  // Tokens dominate; percent breaks ties for token-less sampled days.
  return usage.tokens > 0 ? usage.tokens : peakPercent(usage) / 1_000;
}

export function isActiveUsage(usage: DayUsage): boolean {
  return usage.tokens > 0 || peakPercent(usage) > 0;
}

/**
 * Percentile-rank scale over the visible window's nonzero daily token
 * totals — like GitHub's contribution shades, each day is ranked against the
 * user's own activity, and the busiest day always lands in the top level.
 */
export function makeTokenLevelScale(values: ReadonlyArray<number>): (tokens: number) => number {
  const sorted = values.filter((value) => value > 0).toSorted((left, right) => left - right);
  if (sorted.length === 0) {
    return (tokens) => (tokens > 0 ? 2 : 0);
  }
  return (tokens) => {
    if (tokens <= 0) return 0;
    // Fraction of active days with a total at or below this one.
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid]! <= tokens) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const percentile = low / sorted.length;
    if (percentile <= 0.25) return 1;
    if (percentile <= 0.5) return 2;
    if (percentile <= 0.75) return 3;
    return 4;
  };
}

/** 1–4 heat level for a day: token percentile, percent buckets as fallback. */
export function usageLevel(usage: DayUsage, tokenScale: (tokens: number) => number): number {
  if (usage.tokens > 0) {
    return tokenScale(usage.tokens);
  }
  const percent = peakPercent(usage);
  if (percent <= 0) return 0;
  if (percent < 25) return 1;
  if (percent < 50) return 2;
  if (percent < 75) return 3;
  return 4;
}

const LEVEL_MIX_PERCENT = [0, 30, 55, 80, 100] as const;

function cellColor(provider: ProviderTokenActivityKind, level: number): string | undefined {
  const mix = LEVEL_MIX_PERCENT[Math.max(0, Math.min(4, level))]!;
  if (mix === 0) return undefined;
  return `color-mix(in oklab, ${PROVIDER_HUE[provider]} ${mix}%, transparent)`;
}

interface CalendarModel {
  /** Columns of 7 day-cells (Sunday first), oldest week first. */
  readonly weeks: ReadonlyArray<ReadonlyArray<DayCell>>;
  /** Month label per week column, keyed by the week's start day. */
  readonly monthLabels: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  /** First day of the visible grid (YYYY-MM-DD). */
  readonly startKey: string;
}

export function buildCalendar(input: {
  readonly byDay: ReadonlyMap<string, ReadonlyArray<DayUsage>>;
  readonly weeksCount: number;
  readonly today: Date;
}): CalendarModel {
  const end = startOfLocalDay(input.today);
  // Last column is the week containing today; walk back to its Sunday.
  const lastWeekStart = addDays(end, -end.getDay());
  const firstWeekStart = addDays(lastWeekStart, -7 * (input.weeksCount - 1));

  const weeks: DayCell[][] = [];
  const monthLabels: Array<{ key: string; label: string }> = [];
  for (let weekIndex = 0; weekIndex < input.weeksCount; weekIndex += 1) {
    const weekStart = addDays(firstWeekStart, weekIndex * 7);
    const cells: DayCell[] = [];
    // A column is labeled when it contains the 1st of a month — the same
    // convention GitHub uses, so labels sit on the month boundary itself.
    let monthLabel = "";
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = addDays(weekStart, dayIndex);
      if (date.getDate() === 1) {
        monthLabel = MONTH_LABELS[date.getMonth()]!;
      }
      const key = toDayKey(date);
      const usages = input.byDay.get(key) ?? [];
      const top = usages.reduce<DayUsage | null>(
        (best, usage) => (best === null || usageRank(usage) > usageRank(best) ? usage : best),
        null,
      );
      cells.push({ key, usages, top, isFuture: date.getTime() > end.getTime() });
    }
    monthLabels.push({ key: toDayKey(weekStart), label: monthLabel });
    weeks.push(cells);
  }
  return { weeks, monthLabels, startKey: toDayKey(firstWeekStart) };
}

// ── Streaks & summary stats ──────────────────────────────────────────

interface UsageStats {
  readonly activeDays: number;
  readonly currentStreak: number;
  readonly longestStreak: number;
  readonly totalTokens: number;
  readonly peakDay: {
    readonly key: string;
    readonly tokens: number;
    readonly percent: number | null;
  } | null;
}

export function computeStats(
  byDay: ReadonlyMap<string, ReadonlyArray<DayUsage>>,
  today: Date,
): UsageStats {
  const activeKeys = new Set<string>();
  let totalTokens = 0;
  let peakDay: UsageStats["peakDay"] = null;
  for (const [key, usages] of byDay) {
    if (!usages.some(isActiveUsage)) continue;
    activeKeys.add(key);
    const dayTokens = usages.reduce((total, usage) => total + usage.tokens, 0);
    totalTokens += dayTokens;
    const dayPercent = Math.max(0, ...usages.map(peakPercent));
    const rank = dayTokens > 0 ? dayTokens : dayPercent / 1_000;
    const bestRank =
      peakDay === null ? -1 : peakDay.tokens > 0 ? peakDay.tokens : (peakDay.percent ?? 0) / 1_000;
    if (rank > bestRank) {
      peakDay = { key, tokens: dayTokens, percent: dayPercent > 0 ? dayPercent : null };
    }
  }

  let longestStreak = 0;
  for (const key of activeKeys) {
    const start = parseDayKey(key);
    if (!start) continue;
    if (activeKeys.has(toDayKey(addDays(start, -1)))) continue; // not a streak start
    let length = 0;
    let cursor = start;
    while (activeKeys.has(toDayKey(cursor))) {
      length += 1;
      cursor = addDays(cursor, 1);
    }
    longestStreak = Math.max(longestStreak, length);
  }

  // A current streak may still be alive today even if today has no sample yet.
  let currentStreak = 0;
  let cursor = startOfLocalDay(today);
  if (!activeKeys.has(toDayKey(cursor))) {
    cursor = addDays(cursor, -1);
  }
  while (activeKeys.has(toDayKey(cursor))) {
    currentStreak += 1;
    cursor = addDays(cursor, -1);
  }

  return { activeDays: activeKeys.size, currentStreak, longestStreak, totalTokens, peakDay };
}

// ── Heatmap ──────────────────────────────────────────────────────────

const CELL_PX = 11;
const CELL_GAP_PX = 3;
/** Keep the tooltip's center this far from the container edges. */
const TOOLTIP_EDGE_PX = 90;

interface HeatmapTooltipState {
  readonly key: string;
  readonly left: number;
  readonly top: number;
  /** Render below the cell when it sits too close to the top edge. */
  readonly below: boolean;
}

function usageSummary(usage: DayUsage): string {
  const parts: string[] = [];
  if (usage.tokens > 0) {
    parts.push(`${formatTokens(usage.tokens)} tokens`);
  }
  if (usage.peakSessionPercent !== null && usage.peakSessionPercent > 0) {
    parts.push(`session peak ${Math.round(usage.peakSessionPercent)}%`);
  }
  if (usage.peakWeeklyPercent !== null && usage.peakWeeklyPercent > 0) {
    parts.push(`weekly peak ${Math.round(usage.peakWeeklyPercent)}%`);
  }
  return parts.length > 0 ? parts.join(", ") : "no activity";
}

function cellAriaLabel(cell: DayCell): string {
  const active = cell.usages.filter(isActiveUsage);
  if (active.length === 0) {
    return `${formatDayLabel(cell.key)}: no usage recorded`;
  }
  const parts = active.map((usage) => `${PROVIDER_LABEL[usage.provider]} ${usageSummary(usage)}`);
  return `${formatDayLabel(cell.key)}: ${parts.join("; ")}`;
}

function HeatmapTooltipContent({ cell }: { cell: DayCell }) {
  const active = cell.usages.filter(isActiveUsage);
  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-foreground">{formatDayLabel(cell.key)}</div>
      {active.length === 0 ? (
        <div className="text-muted-foreground/70">No usage recorded</div>
      ) : (
        active.map((usage) => (
          <div key={usage.provider} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: PROVIDER_HUE[usage.provider] }}
              aria-hidden
            />
            <span className="text-muted-foreground">
              {PROVIDER_LABEL[usage.provider]}{" "}
              {usage.tokens > 0 ? (
                <>
                  <span className="tabular-nums text-foreground">{formatTokens(usage.tokens)}</span>
                  <span className="text-muted-foreground/60"> tokens</span>
                </>
              ) : null}
              {usage.peakSessionPercent !== null && usage.peakSessionPercent > 0 ? (
                <span className="text-muted-foreground/60">
                  {usage.tokens > 0 ? " · " : " "}
                  session {Math.round(usage.peakSessionPercent)}%
                </span>
              ) : null}
              {usage.peakWeeklyPercent !== null && usage.peakWeeklyPercent > 0 ? (
                <span className="text-muted-foreground/60">
                  {" "}
                  · wk {Math.round(usage.peakWeeklyPercent)}%
                </span>
              ) : null}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Calendar heatmap. When `provider` is set every cell uses that
 * subscription's hue; otherwise each day wears the hue of its most-used
 * subscription. Intensity is the day's token-activity percentile. Cells can
 * be inspected by mouse, touch, or keyboard (focus the grid, then arrows).
 */
export function UsageHeatmap({
  calendar,
  provider,
  tokenScale,
  label,
}: {
  calendar: CalendarModel;
  provider?: ProviderTokenActivityKind;
  tokenScale: (tokens: number) => number;
  label: string;
}) {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const gridId = useId();
  const [tooltip, setTooltip] = useState<HeatmapTooltipState | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const pastCells = useMemo(
    () => calendar.weeks.flat().filter((cell) => !cell.isFuture),
    [calendar],
  );
  const cellsByKey = useMemo(() => new Map(pastCells.map((cell) => [cell.key, cell])), [pastCells]);

  const cellDomId = (key: string) => `${gridId}-${key}`;

  const showTooltipFor = (key: string, element: HTMLElement) => {
    const outer = outerRef.current;
    if (!outer) return;
    const cellRect = element.getBoundingClientRect();
    const outerRect = outer.getBoundingClientRect();
    const rawLeft = cellRect.left - outerRect.left + cellRect.width / 2;
    const below = cellRect.top - outerRect.top < 72;
    setTooltip({
      key,
      left: Math.max(TOOLTIP_EDGE_PX, Math.min(rawLeft, outerRect.width - TOOLTIP_EDGE_PX)),
      top: below ? cellRect.bottom - outerRect.top + 6 : cellRect.top - outerRect.top - 6,
      below,
    });
  };

  const handleMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!target) {
      setTooltip(null);
      return;
    }
    showTooltipFor(target.dataset.day!, target);
  };

  const moveActive = (fromKey: string | null, deltaDays: number): void => {
    const fallback = pastCells[pastCells.length - 1]?.key ?? null;
    const from = fromKey ?? fallback;
    if (from === null) return;
    const date = parseDayKey(from);
    if (!date) return;
    const nextKey = deltaDays === 0 ? from : toDayKey(addDays(date, deltaDays));
    if (!cellsByKey.has(nextKey)) return;
    setActiveKey(nextKey);
    const element = outerRef.current?.querySelector<HTMLElement>(`[data-day="${nextKey}"]`);
    if (element) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      showTooltipFor(nextKey, element);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Columns are weeks: left/right jump a week, up/down move a day.
    const delta =
      event.key === "ArrowLeft"
        ? -7
        : event.key === "ArrowRight"
          ? 7
          : event.key === "ArrowUp"
            ? -1
            : event.key === "ArrowDown"
              ? 1
              : null;
    if (delta !== null) {
      event.preventDefault();
      moveActive(activeKey, delta);
      return;
    }
    if (event.key === "Escape") {
      setActiveKey(null);
      setTooltip(null);
    }
  };

  const tooltipCell = tooltip ? cellsByKey.get(tooltip.key) : undefined;
  const columnTemplate = `repeat(${calendar.weeks.length}, ${CELL_PX}px)`;

  return (
    <div ref={outerRef} className="relative">
      <div className="overflow-x-auto pt-1">
        <div
          className="inline-flex flex-col gap-1"
          onMouseOver={handleMouseOver}
          onMouseLeave={() => {
            // Keep the tooltip when it is anchored by keyboard navigation.
            if (activeKey === null) setTooltip(null);
          }}
        >
          <div
            className="grid text-[9px] leading-none text-muted-foreground/60"
            style={{ gridTemplateColumns: columnTemplate, columnGap: `${CELL_GAP_PX}px` }}
            aria-hidden
          >
            {calendar.monthLabels.map((month) => (
              <span key={month.key} className="overflow-visible whitespace-nowrap">
                {month.label}
              </span>
            ))}
          </div>
          <div className="flex gap-1.5">
            <div
              className="grid shrink-0 text-[9px] leading-none text-muted-foreground/60"
              style={{ gridTemplateRows: `repeat(7, ${CELL_PX}px)`, rowGap: `${CELL_GAP_PX}px` }}
              aria-hidden
            >
              {(
                [
                  ["sun", ""],
                  ["mon", "Mon"],
                  ["tue", ""],
                  ["wed", "Wed"],
                  ["thu", ""],
                  ["fri", "Fri"],
                  ["sat", ""],
                ] as const
              ).map(([key, dayLabel]) => (
                <span key={key} className="flex items-center">
                  {dayLabel}
                </span>
              ))}
            </div>
            <div
              className="grid grid-flow-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              style={{
                gridTemplateRows: `repeat(7, ${CELL_PX}px)`,
                gridTemplateColumns: columnTemplate,
                gap: `${CELL_GAP_PX}px`,
              }}
              role="group"
              aria-label={`${label} — use arrow keys to inspect days`}
              tabIndex={0}
              aria-activedescendant={activeKey !== null ? cellDomId(activeKey) : undefined}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (activeKey === null) moveActive(null, 0);
              }}
              onBlur={() => {
                setActiveKey(null);
                setTooltip(null);
              }}
            >
              {calendar.weeks.map((week) =>
                week.map((cell) => {
                  if (cell.isFuture) {
                    return <span key={cell.key} aria-hidden />;
                  }
                  const usage =
                    provider === undefined
                      ? cell.top
                      : (cell.usages.find((entry) => entry.provider === provider) ?? null);
                  const level = usage ? usageLevel(usage, tokenScale) : 0;
                  const background = usage ? cellColor(usage.provider, level) : undefined;
                  return (
                    <div
                      key={cell.key}
                      id={cellDomId(cell.key)}
                      data-day={cell.key}
                      role="img"
                      aria-label={cellAriaLabel(cell)}
                      className={cn(
                        "rounded-[2.5px]",
                        background === undefined && "bg-muted/50",
                        activeKey === cell.key && "ring-2 ring-ring",
                      )}
                      style={background === undefined ? undefined : { backgroundColor: background }}
                    />
                  );
                }),
              )}
            </div>
          </div>
        </div>
      </div>
      {tooltip && tooltipCell ? (
        <div
          className={cn(
            "pointer-events-none absolute z-10 w-max max-w-60 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-2 text-[11px] shadow-md",
            !tooltip.below && "-translate-y-full",
          )}
          style={{ left: tooltip.left, top: tooltip.top }}
        >
          <HeatmapTooltipContent cell={tooltipCell} />
        </div>
      ) : null}
    </div>
  );
}

function HeatmapLegend({ provider }: { provider?: ProviderTokenActivityKind }) {
  const providers = provider === undefined ? HISTORY_PROVIDERS : [provider];
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      {provider === undefined ? (
        <div className="flex items-center gap-3">
          {providers.map((kind) => (
            <span
              key={kind}
              className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
            >
              <span
                className="size-2.5 rounded-[2px]"
                style={{ backgroundColor: PROVIDER_HUE[kind] }}
                aria-hidden
              />
              {PROVIDER_LABEL[kind]}
            </span>
          ))}
        </div>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
        Less
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className={cn("size-2.5 rounded-[2px]", level === 0 && "bg-muted/50")}
            style={
              level === 0
                ? undefined
                : { backgroundColor: cellColor(providers[0] ?? "claude", level) }
            }
            aria-hidden
          />
        ))}
        More
      </div>
    </div>
  );
}

// ── Stats row ────────────────────────────────────────────────────────

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
        {label}
      </span>
      <span className="text-base font-semibold tracking-[-0.01em] text-foreground">{value}</span>
      {hint ? <span className="truncate text-[10px] text-muted-foreground/60">{hint}</span> : null}
    </div>
  );
}

function peakDayValue(stats: UsageStats): string {
  if (!stats.peakDay) return "—";
  if (stats.peakDay.tokens > 0) return formatTokens(stats.peakDay.tokens);
  return stats.peakDay.percent !== null ? `${Math.round(stats.peakDay.percent)}%` : "—";
}

function StatsRow({ stats }: { stats: UsageStats }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-3">
      <StatTile label="Total tokens" value={formatTokens(stats.totalTokens)} />
      <StatTile label="Active days" value={`${stats.activeDays}`} />
      <StatTile
        label="Current streak"
        value={`${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}`}
      />
      <StatTile
        label="Longest streak"
        value={`${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`}
      />
      <StatTile
        label="Peak day"
        value={peakDayValue(stats)}
        hint={stats.peakDay ? formatDayLabel(stats.peakDay.key) : undefined}
      />
    </div>
  );
}

// ── Table fallback (accessibility relief for the color encoding) ─────

interface ActivityTableRow {
  readonly day: string;
  readonly provider: ProviderTokenActivityKind;
  readonly usage: DayUsage;
}

function activityRows(byDay: ReadonlyMap<string, ReadonlyArray<DayUsage>>): ActivityTableRow[] {
  const rows: ActivityTableRow[] = [];
  for (const [day, usages] of byDay) {
    for (const usage of usages) {
      if (isActiveUsage(usage)) {
        rows.push({ day, provider: usage.provider, usage });
      }
    }
  }
  return rows.toSorted(
    (left, right) =>
      right.day.localeCompare(left.day) || left.provider.localeCompare(right.provider),
  );
}

function RecentActivityTable({ byDay }: { byDay: ReadonlyMap<string, ReadonlyArray<DayUsage>> }) {
  const recent = useMemo(() => activityRows(byDay).slice(0, 30), [byDay]);
  if (recent.length === 0) {
    return null;
  }
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-[11px] text-muted-foreground/70 hover:text-foreground">
        View recent activity as a table
      </summary>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full min-w-max text-left text-[11px]">
          <thead>
            <tr className="text-muted-foreground/60">
              <th className="py-1 pr-3 font-medium">Day</th>
              <th className="py-1 pr-3 font-medium">Subscription</th>
              <th className="py-1 pr-3 font-medium">Tokens</th>
              <th className="py-1 pr-3 font-medium">Peak session</th>
              <th className="py-1 font-medium">Peak weekly</th>
            </tr>
          </thead>
          <tbody className="text-muted-foreground">
            {recent.map((row) => (
              <tr key={`${row.day}-${row.provider}`} className="border-t border-border/40">
                <td className="py-1 pr-3">{formatDayLabel(row.day)}</td>
                <td className="py-1 pr-3">{PROVIDER_LABEL[row.provider]}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {row.usage.tokens > 0 ? formatTokens(row.usage.tokens) : "—"}
                </td>
                <td className="py-1 pr-3 tabular-nums">
                  {row.usage.peakSessionPercent !== null
                    ? `${Math.round(row.usage.peakSessionPercent)}%`
                    : "—"}
                </td>
                <td className="py-1 tabular-nums">
                  {row.usage.peakWeeklyPercent !== null
                    ? `${Math.round(row.usage.peakWeeklyPercent)}%`
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ── CSV export ───────────────────────────────────────────────────────

function csvField(value: string): string {
  return value.includes(",") || value.includes('"') ? `"${value.replaceAll('"', '""')}"` : value;
}

function exportUsageCsv(byDay: ReadonlyMap<string, ReadonlyArray<DayUsage>>, todayKey: string) {
  const lines = ["day,provider,tokens,peak_session_percent,peak_weekly_percent"];
  for (const row of activityRows(byDay)) {
    lines.push(
      [
        csvField(row.day),
        csvField(row.provider),
        `${row.usage.tokens}`,
        row.usage.peakSessionPercent !== null ? `${row.usage.peakSessionPercent}` : "",
        row.usage.peakWeeklyPercent !== null ? `${row.usage.peakWeeklyPercent}` : "",
      ].join(","),
    );
  }
  const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `zrode-usage-${todayKey}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// ── Panel ────────────────────────────────────────────────────────────

const RANGE_OPTIONS = [
  { label: "3m", weeks: 14 },
  { label: "6m", weeks: 27 },
  { label: "12m", weeks: 53 },
] as const;

interface MutableDayUsage {
  provider: ProviderTokenActivityKind;
  tokens: number;
  peakSessionPercent: number | null;
  peakWeeklyPercent: number | null;
}

/**
 * Isolated so its 30s relative-time tick re-renders one span instead of the
 * whole dashboard (4 heatmaps × ~371 cells + every chart).
 */
function LastScanLabel({ lastScanAt }: { lastScanAt: number | null }) {
  useRelativeTimeTick(30_000);
  return (
    <span className="text-[10px] text-muted-foreground/50">
      {lastScanAt !== null
        ? `Logs scanned ${formatRelativeTimeLabel(new Date(lastScanAt).toISOString())}`
        : "Logs not scanned yet this session"}
    </span>
  );
}

export function UsageSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const [weeksCount, setWeeksCount] = useState<number>(53);
  const [tokenMode, setTokenMode] = useState<"daily" | "cumulative">("daily");
  const [rescanRequested, setRescanRequested] = useState(false);
  const rescanBaselineRef = useRef<number | null>(null);

  const {
    data: historyData,
    error: historyError,
    isPending: isHistoryPending,
    refresh: refreshHistory,
  } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.providerUsageHistory({
          environmentId,
          input: rescanRequested
            ? { days: HISTORY_FETCH_DAYS, rescan: true }
            : { days: HISTORY_FETCH_DAYS },
        }),
  );
  const isBackfilling = historyData?.isBackfilling ?? false;
  const lastScanAt = historyData?.lastScanAt ?? null;

  // A requested rescan is "delivered" as soon as any response for it arrives
  // (running observed, a newer scan completed, or the server absorbed the
  // force into its own spacing); drop the flag promptly so subsequent polls
  // send plain reads instead of repeatedly forcing disk sweeps.
  useEffect(() => {
    if (!rescanRequested || historyData === null) return;
    if (isBackfilling || lastScanAt !== rescanBaselineRef.current) {
      setRescanRequested(false);
    }
  }, [rescanRequested, historyData, isBackfilling, lastScanAt]);
  // Fallback: if the server absorbed the force into its own spacing (no new
  // scan observed), still stop sending the force after a few seconds.
  useEffect(() => {
    if (!rescanRequested) return;
    const id = setTimeout(() => setRescanRequested(false), 10_000);
    return () => clearTimeout(id);
  }, [rescanRequested]);

  // While the server scans local session logs, poll so the calendar fills in
  // as the backfill progresses — but only while this tab is actually visible;
  // a backgrounded window just picks the result up when it returns.
  useEffect(() => {
    if (!isBackfilling) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshHistory();
      }
    }, 3_000);
    return () => clearInterval(id);
  }, [isBackfilling, refreshHistory]);

  // Anchor the calendar to the server's current day; fall back to the
  // browser clock (kept fresh across midnight) until data arrives.
  const [localTodayKey, setLocalTodayKey] = useState(() => toDayKey(new Date()));
  useEffect(() => {
    const id = setInterval(() => {
      const key = toDayKey(new Date());
      setLocalTodayKey((previous) => (previous === key ? previous : key));
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const todayKey = historyData?.today ?? localTodayKey;
  const today = useMemo(() => parseDayKey(todayKey) ?? new Date(), [todayKey]);

  /** day → per-provider usage, merged from token activity + limit samples. */
  const byDayAll = useMemo(() => {
    const map = new Map<string, Map<ProviderTokenActivityKind, MutableDayUsage>>();
    const upsert = (day: string, provider: ProviderTokenActivityKind): MutableDayUsage => {
      const providers = map.get(day) ?? new Map<ProviderTokenActivityKind, MutableDayUsage>();
      map.set(day, providers);
      const usage =
        providers.get(provider) ??
        ({
          provider,
          tokens: 0,
          peakSessionPercent: null,
          peakWeeklyPercent: null,
        } satisfies MutableDayUsage);
      providers.set(provider, usage);
      return usage;
    };
    for (const activity of historyData?.tokenActivity ?? []) {
      upsert(activity.day, activity.provider).tokens += activity.tokens;
    }
    for (const sample of historyData?.days ?? []) {
      const usage = upsert(sample.day, sample.provider);
      usage.peakSessionPercent = sample.peakSessionPercent;
      usage.peakWeeklyPercent = sample.peakWeeklyPercent;
    }
    const result = new Map<string, ReadonlyArray<DayUsage>>();
    for (const [day, providers] of map) {
      result.set(day, [...providers.values()]);
    }
    return result;
  }, [historyData]);

  const calendar = useMemo(
    () => buildCalendar({ byDay: byDayAll, weeksCount, today }),
    [byDayAll, weeksCount, today],
  );

  /** Only the days inside the selected range — stats, scales, table, CSV. */
  const visibleByDay = useMemo(() => {
    const map = new Map<string, ReadonlyArray<DayUsage>>();
    for (const [day, usages] of byDayAll) {
      if (day >= calendar.startKey && day <= todayKey) {
        map.set(day, usages);
      }
    }
    return map;
  }, [byDayAll, calendar.startKey, todayKey]);

  const combinedStats = useMemo(() => computeStats(visibleByDay, today), [visibleByDay, today]);
  const combinedTokenScale = useMemo(
    () => makeTokenLevelScale([...visibleByDay.values()].flat().map((usage) => usage.tokens)),
    [visibleByDay],
  );

  const hasAnyActivity = useMemo(
    () => [...visibleByDay.values()].some((usages) => usages.some(isActiveUsage)),
    [visibleByDay],
  );

  // Enabled Cursor/Devin subscriptions — shown with a dashboard link
  // since they expose no local usage to chart.
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const unmeteredSubs = useMemo(() => {
    const seen = new Set<UnmeteredKind>();
    const result: Array<{ kind: UnmeteredKind; displayName: string; authLabel: string | null }> =
      [];
    for (const provider of serverProviders) {
      const kind = UNMETERED_DRIVER_TO_KIND[provider.driver];
      if (kind === undefined || seen.has(kind) || !isUnmeteredProviderEligible(provider)) {
        continue;
      }
      seen.add(kind);
      result.push({
        kind,
        displayName: provider.displayName ?? UNMETERED_META[kind].label,
        authLabel: provider.auth.label ?? null,
      });
    }
    return result;
  }, [serverProviders]);

  // Dense daily token series over the selected range (zeros filled) — the
  // basis for every time chart. Cumulative is derived from the same daily.
  const dailySeries = useMemo(
    () => buildTokenSeries(visibleByDay, calendar.startKey, todayKey),
    [visibleByDay, calendar.startKey, todayKey],
  );
  const tokenSeries = useMemo(
    () => (tokenMode === "cumulative" ? toCumulativeSeries(dailySeries) : dailySeries),
    [dailySeries, tokenMode],
  );
  const dayLabels = useMemo(
    () => tokenSeries.map((point) => formatDayLabel(point.day)),
    [tokenSeries],
  );
  const weekdayData = useMemo(() => weekdayAverages(dailySeries), [dailySeries]);

  /** Chart layers for the providers that actually have tokens in the range. */
  const activeChartProviders = useMemo(
    () =>
      HISTORY_PROVIDERS.filter((provider) =>
        dailySeries.some((point) => point.values[provider] > 0),
      ),
    [dailySeries],
  );
  const combinedChartSeries = useMemo<ReadonlyArray<ChartSeries>>(
    () =>
      activeChartProviders.map((provider) => ({
        key: provider,
        label: PROVIDER_LABEL[provider],
        colorVar: PROVIDER_HUE[provider],
        values: tokenSeries.map((point) => point.values[provider]),
      })),
    [activeChartProviders, tokenSeries],
  );

  // The share card is a "year in review" artifact: it always covers the full
  // fetched history (not the page's 3m/6m/12m selector), so the heatmap reads
  // as a rich 12-month calendar regardless of what's on screen.
  const shareData = useMemo<ShareProfileData>(() => {
    const fullStats = computeStats(byDayAll, today);
    const providerTotalMap = new Map<ProviderTokenActivityKind, number>();
    const heatmap: Array<{ day: string; total: number; colorVar: string | null }> = [];
    for (const [day, usages] of byDayAll) {
      let total = 0;
      let topProvider: ProviderTokenActivityKind | null = null;
      for (const usage of usages) {
        total += usage.tokens;
        if (usage.tokens > 0) {
          providerTotalMap.set(
            usage.provider,
            (providerTotalMap.get(usage.provider) ?? 0) + usage.tokens,
          );
          const topValue = topProvider
            ? (usages.find((u) => u.provider === topProvider)?.tokens ?? 0)
            : 0;
          if (usage.tokens > topValue) topProvider = usage.provider;
        }
      }
      heatmap.push({
        day,
        total,
        colorVar: topProvider ? PROVIDER_SHARE_HEX[topProvider] : null,
      });
    }
    return {
      stats: [
        { label: "Total tokens", value: formatTokens(fullStats.totalTokens) },
        { label: "Active days", value: `${fullStats.activeDays}` },
        { label: "Current streak", value: `${fullStats.currentStreak}d` },
        { label: "Longest streak", value: `${fullStats.longestStreak}d` },
        {
          label: "Peak day",
          value: fullStats.peakDay ? formatTokens(fullStats.peakDay.tokens) : "—",
        },
      ],
      providerTotals: HISTORY_PROVIDERS.flatMap((provider) => {
        const total = providerTotalMap.get(provider) ?? 0;
        return total > 0
          ? [
              {
                label: PROVIDER_LABEL[provider],
                tokens: total,
                colorVar: PROVIDER_SHARE_HEX[provider],
              },
            ]
          : [];
      }),
      heatmap,
      todayKey,
      rangeLabel: "Last 12 months",
    };
  }, [byDayAll, today, todayKey]);

  /**
   * Per-provider section models, computed once per data/range change instead
   * of inside the render map — the page re-renders for cheap reasons (chart
   * hover state, poll ticks) and must not rebuild series each time.
   */
  const providerSections = useMemo(
    () =>
      HISTORY_PROVIDERS.map((provider) => {
        const providerByDay = new Map<string, ReadonlyArray<DayUsage>>();
        for (const [day, usages] of visibleByDay) {
          const usage = usages.find((entry) => entry.provider === provider);
          if (usage) {
            providerByDay.set(day, [usage]);
          }
        }
        const stats = computeStats(providerByDay, today);
        const providerTokenScale = makeTokenLevelScale(
          [...providerByDay.values()].flat().map((usage) => usage.tokens),
        );
        const providerDaily = buildTokenSeries(providerByDay, calendar.startKey, todayKey);
        const providerPoints =
          tokenMode === "cumulative" ? toCumulativeSeries(providerDaily) : providerDaily;
        const providerDayLabels = providerPoints.map((point) => formatDayLabel(point.day));
        const providerTokenChart: ReadonlyArray<ChartSeries> =
          stats.totalTokens > 0
            ? [
                {
                  key: provider,
                  label: PROVIDER_LABEL[provider],
                  colorVar: PROVIDER_HUE[provider],
                  values: providerPoints.map((point) => point.values[provider]),
                },
              ]
            : [];
        // Peak allowance utilization over the range, aligned to the token axis.
        const sampleByDay = new Map<string, number>();
        for (const sample of historyData?.days ?? []) {
          if (
            sample.provider === provider &&
            sample.day >= calendar.startKey &&
            sample.day <= todayKey
          ) {
            sampleByDay.set(
              sample.day,
              Math.max(sample.peakSessionPercent ?? 0, sample.peakWeeklyPercent ?? 0),
            );
          }
        }
        const sampledDayCount = sampleByDay.size;
        const pressureDayLabels = providerDaily.map((point) => formatDayLabel(point.day));
        const pressureSeries: ReadonlyArray<ChartSeries> = [
          {
            key: provider,
            label: "Peak allowance",
            colorVar: PROVIDER_HUE[provider],
            values: providerDaily.map((point) => sampleByDay.get(point.day) ?? 0),
          },
        ];
        return {
          provider,
          stats,
          providerTokenScale,
          providerDayLabels,
          providerTokenChart,
          pressureDayLabels,
          pressureSeries,
          sampledDayCount,
        };
      }),
    [visibleByDay, today, calendar.startKey, todayKey, tokenMode, historyData?.days],
  );

  const requestRescan = () => {
    rescanBaselineRef.current = lastScanAt;
    setRescanRequested(true);
  };

  const rangeSelector = (
    <div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.label}
          type="button"
          className={cn(
            "cursor-pointer rounded-[5px] px-1.5 py-0.5 text-[10px] transition-colors",
            option.weeks === weeksCount
              ? "bg-background font-medium text-foreground shadow-xs"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
          onClick={() => setWeeksCount(option.weeks)}
          aria-pressed={option.weeks === weeksCount}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Subscription usage"
        icon={<ActivityIcon className="size-3" />}
        headerAction={
          <div className="flex items-center gap-2">
            {rangeSelector}
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
              disabled={isHistoryPending}
              onClick={refreshHistory}
              aria-label="Refresh usage history"
            >
              <RefreshCwIcon className={cn("size-3", isHistoryPending && "animate-spin")} />
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
          <p className="text-xs text-muted-foreground/80">
            Daily token activity of your subscriptions, read from each provider's local session
            logs, with the rate-limit peaks Zrode samples layered in. Each day wears the color of
            the subscription you used most.
          </p>
          {historyData === null ? (
            historyError !== null && !isHistoryPending ? (
              <p className="text-xs text-muted-foreground">
                Usage history could not be loaded from this environment.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-3 w-40" />
              </div>
            )
          ) : (
            <>
              <StatsRow stats={combinedStats} />
              <UsageHeatmap
                calendar={calendar}
                tokenScale={combinedTokenScale}
                label="All subscriptions usage calendar"
              />
              <HeatmapLegend />
              {isBackfilling ? (
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                  <RefreshCwIcon className="size-3 animate-spin" aria-hidden />
                  Scanning local session logs — the calendar fills in as the scan progresses…
                </p>
              ) : null}
              {combinedChartSeries.length > 0 ? (
                <div className="flex flex-col gap-3 border-t border-border/40 pt-4">
                  <div className="flex items-end justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                        Tokens
                      </span>
                      <span className="text-xl font-semibold tracking-[-0.01em] text-foreground">
                        {formatTokens(combinedStats.totalTokens)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60">
                        {tokenMode === "cumulative" ? "Cumulative over range" : "Per day"}
                      </span>
                    </div>
                    <div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5">
                      {(["daily", "cumulative"] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={tokenMode === mode}
                          className={cn(
                            "cursor-pointer rounded-[5px] px-2 py-0.5 text-[10px] capitalize transition-colors",
                            tokenMode === mode
                              ? "bg-background font-medium text-foreground shadow-xs"
                              : "text-muted-foreground/70 hover:text-foreground",
                          )}
                          onClick={() => setTokenMode(mode)}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                  </div>
                  <UsageAreaChart
                    dayLabels={dayLabels}
                    series={combinedChartSeries}
                    formatValue={formatTokens}
                    ariaLabel="Tokens processed per day by subscription"
                  />
                </div>
              ) : null}
              {combinedChartSeries.length > 0 ? (
                <div className="flex flex-col gap-3 border-t border-border/40 pt-4">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                      Activity by weekday
                    </span>
                    <span className="text-[11px] text-muted-foreground/70">
                      Average tokens per day of week across this range.
                    </span>
                  </div>
                  <WeekdayBarChart
                    data={weekdayData}
                    series={activeChartProviders.map((provider) => ({
                      key: provider,
                      label: PROVIDER_LABEL[provider],
                      colorVar: PROVIDER_HUE[provider],
                    }))}
                    formatValue={formatTokens}
                    ariaLabel="Average tokens by weekday"
                  />
                </div>
              ) : null}
              {!hasAnyActivity && !isBackfilling ? (
                <p className="text-xs text-muted-foreground/70">
                  No usage activity found in this range. Zrode reads past activity from your local
                  Claude Code and Codex session logs and samples live usage from the footer meter.
                </p>
              ) : (
                <RecentActivityTable byDay={visibleByDay} />
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
                <LastScanLabel lastScanAt={lastScanAt} />
                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={isBackfilling || rescanRequested}
                    onClick={requestRescan}
                  >
                    <RefreshCwIcon className="size-3" />
                    Rescan logs
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    disabled={!hasAnyActivity}
                    onClick={() => exportUsageCsv(visibleByDay, todayKey)}
                  >
                    <DownloadIcon className="size-3" />
                    Export CSV
                  </Button>
                  {hasAnyActivity ? <ShareProfileButton data={shareData} /> : null}
                </div>
              </div>
            </>
          )}
        </div>
      </SettingsSection>

      {providerSections.map((section) => {
        const {
          provider,
          stats,
          providerTokenScale,
          providerDayLabels,
          providerTokenChart,
          pressureDayLabels,
          pressureSeries,
          sampledDayCount,
        } = section;
        return (
          <SettingsSection
            key={provider}
            title={PROVIDER_LABEL[provider]}
            icon={<ProviderIcon provider={provider} className="size-3" />}
          >
            <div className="flex flex-col gap-4 px-4 py-4 sm:px-5">
              {historyData === null ? (
                <Skeleton className="h-24 w-full" />
              ) : stats.activeDays === 0 ? (
                <p className="text-xs text-muted-foreground/70">
                  No recorded usage for {PROVIDER_LABEL[provider]} in this range.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-6 gap-y-3">
                    <StatTile label="Total tokens" value={formatTokens(stats.totalTokens)} />
                    <StatTile label="Active days" value={`${stats.activeDays}`} />
                    <StatTile
                      label="Longest streak"
                      value={`${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`}
                    />
                    <StatTile
                      label="Peak day"
                      value={peakDayValue(stats)}
                      hint={stats.peakDay ? formatDayLabel(stats.peakDay.key) : undefined}
                    />
                  </div>
                  <UsageHeatmap
                    calendar={calendar}
                    provider={provider}
                    tokenScale={providerTokenScale}
                    label={`${PROVIDER_LABEL[provider]} usage calendar`}
                  />
                  <HeatmapLegend provider={provider} />
                  {providerTokenChart.length > 0 ? (
                    <div className="flex flex-col gap-2 border-t border-border/40 pt-4">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                        Tokens {tokenMode === "cumulative" ? "(cumulative)" : "per day"}
                      </span>
                      <UsageAreaChart
                        dayLabels={providerDayLabels}
                        series={providerTokenChart}
                        formatValue={formatTokens}
                        ariaLabel={`${PROVIDER_LABEL[provider]} tokens over time`}
                      />
                    </div>
                  ) : null}
                  {sampledDayCount >= 2 ? (
                    <div className="flex flex-col gap-2 border-t border-border/40 pt-4">
                      <span className="text-[10px] uppercase tracking-[0.06em] text-muted-foreground/60">
                        Rate-limit pressure
                      </span>
                      <span className="text-[11px] text-muted-foreground/70">
                        Peak allowance utilization sampled while Zrode was running.
                      </span>
                      <UsageAreaChart
                        dayLabels={pressureDayLabels}
                        series={pressureSeries}
                        formatValue={formatPercent}
                        maxValueOverride={100}
                        ariaLabel={`${PROVIDER_LABEL[provider]} peak allowance utilization over time`}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </SettingsSection>
        );
      })}

      {unmeteredSubs.length > 0 ? (
        <SettingsSection title="Other subscriptions" icon={<ExternalLinkIcon className="size-3" />}>
          <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
            <p className="text-xs text-muted-foreground/80">
              These subscriptions don't record token usage locally, so there's no history to chart.
              Check their usage on the provider's own dashboard.
            </p>
            {unmeteredSubs.map((sub) => {
              const Icon = UNMETERED_META[sub.kind].icon;
              return (
                <div
                  key={sub.kind}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-foreground">
                        {sub.displayName}
                      </div>
                      {sub.authLabel ? (
                        <div className="truncate text-[10px] text-muted-foreground/60">
                          {sub.authLabel}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => openDashboard(UNMETERED_META[sub.kind].dashboardUrl)}
                  >
                    <ExternalLinkIcon className="size-3" />
                    Dashboard
                  </Button>
                </div>
              );
            })}
          </div>
        </SettingsSection>
      ) : null}

      {historyData !== null ? (
        <p className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground/50">
          <FlameIcon className="size-3" aria-hidden />
          Token activity comes from each provider's local session logs on this machine; rate-limit
          peaks are sampled from the subscriptions' own APIs while Zrode runs. Data is kept for{" "}
          {historyData.retentionDays} days.
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
