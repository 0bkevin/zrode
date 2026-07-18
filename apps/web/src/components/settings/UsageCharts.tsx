/**
 * From-scratch SVG charts for the subscription usage page.
 *
 * No charting dependency — the codebase ships none, so these are hand-built
 * responsive SVGs that follow the project's dataviz conventions: 2px lines,
 * ~14%-opacity area fills, hairline recessive gridlines, a crosshair +
 * single tooltip listing every series, and identity carried by the fixed
 * per-subscription hue rather than by text.
 *
 * Geometry is computed in real pixels from a measured container width so
 * text and circular markers never distort (as they would under a stretched
 * viewBox).
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { ProviderTokenActivityKind } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

// ── Shared series model (pure, exported for tests) ───────────────────

/** Token-activity providers, in a fixed order for stacking/legends. */
export const TOKEN_PROVIDERS: ReadonlyArray<ProviderTokenActivityKind> = [
  "claude",
  "codex",
  "grok",
  "kilocode",
  "opencode",
];

type TokenValues = Record<ProviderTokenActivityKind, number>;

function emptyTokenValues(): TokenValues {
  return { claude: 0, codex: 0, grok: 0, kilocode: 0, opencode: 0 };
}

function sumValues(values: TokenValues): number {
  return TOKEN_PROVIDERS.reduce((total, provider) => total + values[provider], 0);
}

export interface TokenSeriesPoint {
  /** Local calendar day, YYYY-MM-DD. */
  readonly day: string;
  readonly values: Readonly<TokenValues>;
  readonly total: number;
}

export interface DaySeriesInput {
  readonly provider: ProviderTokenActivityKind;
  readonly tokens: number;
}

function nextDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year!, month! - 1, day! + 1);
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/**
 * Dense daily series from `startKey` through `endKey` inclusive — every day
 * present (zeros filled) so the x-axis is evenly spaced in real calendar time
 * rather than compressing gaps between active days.
 */
export function buildTokenSeries(
  byDay: ReadonlyMap<string, ReadonlyArray<DaySeriesInput>>,
  startKey: string,
  endKey: string,
): ReadonlyArray<TokenSeriesPoint> {
  if (startKey > endKey) return [];
  const points: TokenSeriesPoint[] = [];
  let cursor = startKey;
  // Bound the loop defensively so a malformed range can't spin forever.
  for (let guard = 0; guard < 1_000 && cursor <= endKey; guard += 1) {
    const entries = byDay.get(cursor) ?? [];
    const values = emptyTokenValues();
    for (const entry of entries) {
      values[entry.provider] += entry.tokens;
    }
    points.push({ day: cursor, values, total: sumValues(values) });
    cursor = nextDayKey(cursor);
  }
  return points;
}

/** Running-total variant of a token series (per provider and total). */
export function toCumulativeSeries(
  series: ReadonlyArray<TokenSeriesPoint>,
): ReadonlyArray<TokenSeriesPoint> {
  const running = emptyTokenValues();
  return series.map((point) => {
    for (const provider of TOKEN_PROVIDERS) {
      running[provider] += point.values[provider];
    }
    const values = { ...running };
    return { day: point.day, values, total: sumValues(values) };
  });
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface WeekdayDatum {
  readonly label: string;
  readonly values: Readonly<TokenValues>;
  readonly total: number;
}

/**
 * Mean tokens for each weekday across the series — the "typical Monday"
 * profile. Days with no activity count as zero so the average reflects real
 * cadence, not just the busy days.
 */
export function weekdayAverages(
  series: ReadonlyArray<TokenSeriesPoint>,
): ReadonlyArray<WeekdayDatum> {
  const totals: TokenValues[] = WEEKDAY_LABELS.map(() => emptyTokenValues());
  const counts = WEEKDAY_LABELS.map(() => 0);
  for (const point of series) {
    const [year, month, day] = point.day.split("-").map(Number);
    if (!year || !month || !day) continue;
    const weekday = new Date(year, month - 1, day).getDay();
    for (const provider of TOKEN_PROVIDERS) {
      totals[weekday]![provider] += point.values[provider];
    }
    counts[weekday]! += 1;
  }
  return WEEKDAY_LABELS.map((label, index) => {
    const divisor = Math.max(1, counts[index]!);
    const values = emptyTokenValues();
    for (const provider of TOKEN_PROVIDERS) {
      values[provider] = totals[index]![provider] / divisor;
    }
    return { label, values, total: sumValues(values) };
  });
}

// ── Measured width ───────────────────────────────────────────────────

/** Width used before the container has been measured (SSR / first paint). */
const FALLBACK_WIDTH = 640;

function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  // Render at a fallback until measured so the chart is never a blank frame;
  // the observer refines it (and clips any brief overshoot) within a frame.
  return [ref, width > 0 ? width : FALLBACK_WIDTH] as const;
}

// ── Formatting ───────────────────────────────────────────────────────

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

// ── Area / line chart ────────────────────────────────────────────────

export interface ChartSeries {
  readonly key: ProviderTokenActivityKind;
  readonly label: string;
  readonly colorVar: string;
  readonly values: ReadonlyArray<number>;
}

interface AreaTooltipState {
  readonly index: number;
  readonly left: number;
}

const AREA_HEIGHT = 168;
const AREA_PAD = { top: 10, right: 6, bottom: 2, left: 6 } as const;

export function buildAreaBands(series: ReadonlyArray<ChartSeries>) {
  return series.map((layer) => ({
    layer,
    band: layer.values.map((value) => ({ base: 0, top: value ?? 0 })),
  }));
}

/**
 * Area+line chart over an evenly-spaced day axis. Every provider is plotted
 * from the same zero baseline so a provider's line always represents its own
 * usage. Hovering shows a crosshair and one tooltip listing every series plus
 * the combined total.
 */
export function UsageAreaChart({
  dayLabels,
  series,
  formatValue,
  maxValueOverride,
  height = AREA_HEIGHT,
  ariaLabel,
}: {
  /** Formatted label per point, aligned to every series' values. */
  readonly dayLabels: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ChartSeries>;
  readonly formatValue: (value: number) => string;
  /** Fix the y-axis maximum (e.g. 100 for a percentage chart). */
  readonly maxValueOverride?: number;
  readonly height?: number;
  readonly ariaLabel: string;
}) {
  const [ref, width] = useMeasuredWidth();
  const [tooltip, setTooltip] = useState<AreaTooltipState | null>(null);

  const pointCount = dayLabels.length;
  const innerW = Math.max(0, width - AREA_PAD.left - AREA_PAD.right);
  const innerH = height - AREA_PAD.top - AREA_PAD.bottom;

  const maxValue = useMemo(() => {
    if (maxValueOverride !== undefined) return maxValueOverride;
    let max = 0;
    for (let i = 0; i < pointCount; i += 1) {
      for (const layer of series) {
        max = Math.max(max, layer.values[i] ?? 0);
      }
    }
    return niceCeil(max);
  }, [series, pointCount, maxValueOverride]);

  const xAt = (index: number) =>
    pointCount <= 1
      ? AREA_PAD.left + innerW / 2
      : AREA_PAD.left + (index / (pointCount - 1)) * innerW;
  const yAt = (value: number) => AREA_PAD.top + innerH - (value / maxValue) * innerH;

  // Every band starts at zero. Stacking made the top provider's line look
  // like its own usage included every provider rendered below it.
  const bands = useMemo(() => buildAreaBands(series), [series]);

  // Path strings are memoized so hover re-renders (tooltip/crosshair state)
  // don't rebuild ~371-point strings per series at pointer-move rate.
  const paths = useMemo(() => {
    if (pointCount === 0) return [];
    return bands.map(({ layer, band }) => {
      const top = band.map((point, index) => `${xAt(index)},${yAt(point.top)}`);
      const bottom = band.map((point, index) => `${xAt(index)},${yAt(point.base)}`).toReversed();
      return {
        layer,
        area: `M${top.join("L")}L${bottom.join("L")}Z`,
        line: `M${top.join("L")}`,
      };
    });
    // xAt/yAt are stable given these inputs.
  }, [bands, pointCount, innerW, innerH, maxValue]);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (pointCount === 0 || innerW <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left - AREA_PAD.left) / innerW;
    const index = Math.max(0, Math.min(pointCount - 1, Math.round(fraction * (pointCount - 1))));
    // Skip the state update (and re-render) when the snapped index is unchanged.
    setTooltip((previous) => (previous?.index === index ? previous : { index, left: xAt(index) }));
  };

  const totalAt = (index: number) =>
    series.reduce((sum, layer) => sum + (layer.values[index] ?? 0), 0);

  const gridValues = [0.25, 0.5, 0.75, 1].map((fraction) => fraction * maxValue);
  const hovered = tooltip ? bands.map(({ band }) => band[tooltip.index]!) : null;

  return (
    <div ref={ref} className="relative">
      <div
        className="relative overflow-hidden"
        style={{ height }}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setTooltip(null)}
        role="img"
        aria-label={ariaLabel}
      >
        {width > 0 ? (
          <svg width={width} height={height} className="block">
            {gridValues.map((value) => (
              <line
                key={value}
                x1={AREA_PAD.left}
                x2={AREA_PAD.left + innerW}
                y1={yAt(value)}
                y2={yAt(value)}
                className="stroke-border/50"
                strokeWidth={1}
              />
            ))}
            {paths.map(({ layer, area }) => (
              <path
                key={`area-${layer.key}`}
                d={area}
                fill={layer.colorVar}
                opacity={series.length > 1 ? 0.08 : 0.14}
              />
            ))}
            {paths.map(({ layer, line }) => (
              <path
                key={`line-${layer.key}`}
                d={line}
                fill="none"
                stroke={layer.colorVar}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {tooltip && hovered ? (
              <>
                <line
                  x1={xAt(tooltip.index)}
                  x2={xAt(tooltip.index)}
                  y1={AREA_PAD.top}
                  y2={AREA_PAD.top + innerH}
                  className="stroke-foreground/25"
                  strokeWidth={1}
                />
                {hovered.map((point, layerIndex) => (
                  <circle
                    key={bands[layerIndex]!.layer.key}
                    cx={xAt(tooltip.index)}
                    cy={yAt(point.top)}
                    r={3}
                    fill={bands[layerIndex]!.layer.colorVar}
                    className="stroke-background"
                    strokeWidth={2}
                  />
                ))}
              </>
            ) : null}
          </svg>
        ) : null}
        <span className="pointer-events-none absolute left-1 top-0 text-[9px] tabular-nums text-muted-foreground/50">
          {formatValue(maxValue)}
        </span>
        {tooltip ? (
          <div
            className="pointer-events-none absolute top-1 z-10 w-max max-w-56 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
            style={{
              left: Math.max(70, Math.min(tooltip.left, Math.max(70, width - 70))),
            }}
          >
            <div className="font-medium text-foreground">{dayLabels[tooltip.index]}</div>
            {series.map((layer) => (
              <div key={layer.key} className="flex items-center gap-1.5">
                <span
                  className="h-0.5 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: layer.colorVar }}
                  aria-hidden
                />
                <span className="text-muted-foreground">
                  <span className="tabular-nums text-foreground">
                    {formatValue(layer.values[tooltip.index] ?? 0)}
                  </span>{" "}
                  {layer.label}
                </span>
              </div>
            ))}
            {series.length > 1 ? (
              <div className="mt-0.5 border-t border-border/50 pt-0.5 text-muted-foreground">
                <span className="tabular-nums text-foreground">
                  {formatValue(totalAt(tooltip.index))}
                </span>{" "}
                total
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/60">
        <span>{dayLabels[0] ?? ""}</span>
        <span>{pointCount > 1 ? "Today" : ""}</span>
      </div>
    </div>
  );
}

// ── Weekday bar chart ────────────────────────────────────────────────

interface BarTooltipState {
  readonly index: number;
  readonly left: number;
}

const BAR_HEIGHT = 132;
const BAR_PAD = { top: 10, right: 6, bottom: 16, left: 6 } as const;
const BAR_MAX_WIDTH = 24;

/**
 * Average-tokens-per-weekday, stacked by subscription. Each bar is its own
 * hover target (no crosshair — the mark is the target), lifting slightly and
 * showing the weekday's per-provider breakdown.
 */
export function WeekdayBarChart({
  data,
  series,
  formatValue,
  ariaLabel,
}: {
  readonly data: ReadonlyArray<WeekdayDatum>;
  readonly series: ReadonlyArray<{
    key: ProviderTokenActivityKind;
    label: string;
    colorVar: string;
  }>;
  readonly formatValue: (value: number) => string;
  readonly ariaLabel: string;
}) {
  const [ref, width] = useMeasuredWidth();
  const [tooltip, setTooltip] = useState<BarTooltipState | null>(null);

  const innerW = Math.max(0, width - BAR_PAD.left - BAR_PAD.right);
  const innerH = BAR_HEIGHT - BAR_PAD.top - BAR_PAD.bottom;
  const maxValue = niceCeil(Math.max(0, ...data.map((datum) => datum.total)));
  const slot = data.length > 0 ? innerW / data.length : innerW;
  const barWidth = Math.min(BAR_MAX_WIDTH, slot * 0.62);
  const yAt = (value: number) => BAR_PAD.top + innerH - (value / maxValue) * innerH;
  const centerAt = (index: number) => BAR_PAD.left + slot * (index + 0.5);

  return (
    <div ref={ref} className="relative">
      <div
        className="relative overflow-hidden"
        style={{ height: BAR_HEIGHT }}
        role="img"
        aria-label={ariaLabel}
      >
        {width > 0 ? (
          <svg width={width} height={BAR_HEIGHT} className="block">
            <line
              x1={BAR_PAD.left}
              x2={BAR_PAD.left + innerW}
              y1={yAt(0)}
              y2={yAt(0)}
              className="stroke-border/60"
              strokeWidth={1}
            />
            {data.map((datum, index) => {
              const center = centerAt(index);
              let cursorY = yAt(0);
              return (
                <g
                  key={datum.label}
                  onPointerEnter={() => setTooltip({ index, left: center })}
                  onPointerLeave={() => setTooltip(null)}
                  className={cn(tooltip?.index === index ? "opacity-100" : "opacity-90")}
                >
                  {/* Transparent full-height hit target wider than the bar. */}
                  <rect
                    x={center - slot / 2}
                    y={BAR_PAD.top}
                    width={slot}
                    height={innerH}
                    fill="transparent"
                  />
                  {series.map((layer) => {
                    const value = datum.values[layer.key];
                    if (value <= 0) return null;
                    const top = yAt(
                      series
                        .slice(0, series.indexOf(layer) + 1)
                        .reduce((sum, entry) => sum + datum.values[entry.key], 0),
                    );
                    const segmentHeight = Math.max(0, cursorY - top);
                    cursorY = top;
                    return (
                      <rect
                        key={layer.key}
                        x={center - barWidth / 2}
                        y={top}
                        width={barWidth}
                        height={segmentHeight}
                        rx={2}
                        fill={layer.colorVar}
                      />
                    );
                  })}
                  <text
                    x={center}
                    y={BAR_HEIGHT - 4}
                    textAnchor="middle"
                    className="fill-muted-foreground/60 text-[9px]"
                  >
                    {datum.label}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}
        <span className="pointer-events-none absolute left-1 top-0 text-[9px] tabular-nums text-muted-foreground/50">
          {formatValue(maxValue)}
        </span>
        {tooltip ? (
          <div
            className="pointer-events-none absolute top-1 z-10 w-max max-w-56 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
            style={{ left: Math.max(70, Math.min(tooltip.left, Math.max(70, width - 70))) }}
          >
            <div className="font-medium text-foreground">{data[tooltip.index]!.label} average</div>
            {series.map((layer) => (
              <div key={layer.key} className="flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: layer.colorVar }}
                  aria-hidden
                />
                <span className="text-muted-foreground">
                  <span className="tabular-nums text-foreground">
                    {formatValue(data[tooltip.index]!.values[layer.key])}
                  </span>{" "}
                  {layer.label}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
