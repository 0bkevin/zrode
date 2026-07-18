/**
 * Shareable, zrode-branded usage-profile image.
 *
 * There's no rasterization dependency in the repo, so the card is hand-drawn
 * onto a hi-DPI `<canvas>` (1200×630 — the standard social/OG ratio) and
 * exported via `canvas.toBlob`. Every color is read from the *live* applied
 * theme (a probe element resolves `var(--…)` to concrete rgb), so the image
 * uses whatever palette, preset, custom overrides, and light/dark mode the
 * user has selected in Appearance. The user's accent (`--ring`) drives the
 * headline number and the activity heatmap, the way GitHub's green does.
 */
import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/react";
import { CheckIcon, CopyIcon, DownloadIcon, Share2Icon } from "lucide-react";
import { ZRODE_MARK_PATHS, ZRODE_MARK_VIEWBOX_SIZE } from "@t3tools/shared/brand";

import { APP_BASE_NAME } from "../../branding";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";

// ── Public data shape ────────────────────────────────────────────────

export interface ShareStatItem {
  readonly label: string;
  readonly value: string;
}

export interface ShareProviderTotal {
  readonly label: string;
  readonly tokens: number;
  readonly billingRequests?: number;
  readonly billingAiCredits?: number;
  /** CSS color expression (e.g. `var(--color-orange-600)`), resolved for canvas. */
  readonly colorVar: string;
}

export interface ShareHeatmapDay {
  readonly day: string;
  /** Total tokens that day (drives the intensity level). */
  readonly total: number;
  /** Unit-neutral activity intensity for request/credit/allowance-only days. */
  readonly activityLevel?: number;
  /** Hue of the subscription used most that day; null when idle. */
  readonly colorVar: string | null;
}

export interface ShareProfileData {
  readonly stats: ReadonlyArray<ShareStatItem>;
  readonly providerTotals: ReadonlyArray<ShareProviderTotal>;
  /** Dense daily activity (ascending) for the heatmap. */
  readonly heatmap: ReadonlyArray<ShareHeatmapDay>;
  /** Server-anchored current local day, YYYY-MM-DD. */
  readonly todayKey: string;
  readonly rangeLabel: string;
}

export interface ShareUser {
  readonly name: string | null;
  readonly handle: string | null;
}

// ── Pure helpers (exported for tests) ────────────────────────────────

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1e9) return `${(tokens / 1e9).toFixed(tokens >= 1e10 ? 0 : 1)}B`;
  if (tokens >= 1e6) return `${(tokens / 1e6).toFixed(tokens >= 1e7 ? 0 : 1)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(tokens >= 1e4 ? 0 : 1)}K`;
  return `${Math.round(tokens)}`;
}

function parseDayKey(key: string): Date | null {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function toDayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export interface HeatmapCell {
  /** Intensity 0–4, or -1 for a future day (not drawn). */
  readonly level: number;
  /** Hue of that day's dominant subscription; null when idle/future. */
  readonly colorVar: string | null;
}

export interface HeatmapGrid {
  /** Columns of 7 cells; Sunday first, oldest week first. */
  readonly weeks: ReadonlyArray<ReadonlyArray<HeatmapCell>>;
  /** Short month label per week column ("" unless the month changes there). */
  readonly monthLabels: ReadonlyArray<string>;
}

const SHORT_MONTHS = [
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

/**
 * Build a GitHub-style grid ending on `todayKey`. Each cell's intensity is
 * the quartile rank of the day's total against the user's own active days (so
 * the busiest day lands at the top level), and its hue is the subscription
 * that was used most that day.
 */
export function buildHeatmapGrid(input: {
  readonly heatmap: ReadonlyArray<ShareHeatmapDay>;
  readonly todayKey: string;
  readonly weeksCount: number;
}): HeatmapGrid {
  const byDay = new Map(input.heatmap.map((point) => [point.day, point]));
  const active = input.heatmap
    .map((point) => point.total)
    .filter((total) => total > 0)
    .sort((left, right) => left - right);
  const levelOf = (total: number): number => {
    if (total <= 0) return 0;
    if (active.length === 0) return 2;
    let low = 0;
    let high = active.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (active[mid]! <= total) low = mid + 1;
      else high = mid;
    }
    const percentile = low / active.length;
    if (percentile <= 0.25) return 1;
    if (percentile <= 0.5) return 2;
    if (percentile <= 0.75) return 3;
    return 4;
  };

  const today = parseDayKey(input.todayKey) ?? new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const lastWeekStart = new Date(end);
  lastWeekStart.setDate(lastWeekStart.getDate() - end.getDay());
  const firstWeekStart = new Date(lastWeekStart);
  firstWeekStart.setDate(firstWeekStart.getDate() - 7 * (input.weeksCount - 1));

  const weeks: HeatmapCell[][] = [];
  const monthLabels: string[] = [];
  let lastLabeledMonth = -1;
  for (let w = 0; w < input.weeksCount; w += 1) {
    const weekStart = new Date(firstWeekStart);
    weekStart.setDate(weekStart.getDate() + w * 7);
    // Label a column when its week rolls into a new month (skip the very
    // first column so a partial leading week doesn't get a stray label).
    const month = weekStart.getMonth();
    if (w > 0 && month !== lastLabeledMonth) {
      monthLabels.push(SHORT_MONTHS[month]!);
      lastLabeledMonth = month;
    } else {
      monthLabels.push("");
      if (w === 0) lastLabeledMonth = month;
    }
    const column: HeatmapCell[] = [];
    for (let d = 0; d < 7; d += 1) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + d);
      if (date.getTime() > end.getTime()) {
        column.push({ level: -1, colorVar: null });
        continue;
      }
      const point = byDay.get(toDayKey(date));
      const activityLevel = Math.max(0, Math.min(4, point?.activityLevel ?? 0));
      const level = Math.max(levelOf(point?.total ?? 0), activityLevel);
      column.push({ level, colorVar: level > 0 ? (point?.colorVar ?? null) : null });
    }
    weeks.push(column);
  }
  return { weeks, monthLabels };
}

// ── Color resolution (live theme → concrete rgb) ─────────────────────

type ColorKey =
  | "background"
  | "foreground"
  | "card"
  | "cardForeground"
  | "primary"
  | "primaryForeground"
  | "mutedForeground"
  | "border"
  | "accent";

const COLOR_EXPR: Record<ColorKey, string> = {
  background: "var(--background)",
  foreground: "var(--foreground)",
  card: "var(--card)",
  cardForeground: "var(--card-foreground)",
  primary: "var(--primary)",
  primaryForeground: "var(--primary-foreground)",
  mutedForeground: "var(--muted-foreground)",
  border: "var(--border)",
  accent: "var(--ring)",
};

/**
 * Resolve CSS color expressions against the live document, normalized to a
 * plain `rgb(r, g, b)` triple.
 *
 * getComputedStyle returns whatever color space the theme uses — modern
 * themes yield `oklch(…)` / `color(srgb …)`, not `rgb(…)`. A 1×1 canvas
 * rasterizes any of those to concrete sRGB bytes, so downstream `withAlpha`
 * and luminance math never have to parse an unknown format (parsing an
 * `oklch()` string as if it were rgb produces near-black — the source of the
 * washed-out swatches/empty cells this fixes).
 */
function resolveColors(extra: ReadonlyArray<string>): {
  tokens: Record<ColorKey, string>;
  extra: Record<string, string>;
} {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.opacity = "0";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const norm = document.createElement("canvas");
  norm.width = 1;
  norm.height = 1;
  const nctx = norm.getContext("2d", { willReadFrequently: true });
  const read = (expr: string): string => {
    probe.style.color = "";
    probe.style.color = expr;
    const computed = getComputedStyle(probe).color || "rgb(0, 0, 0)";
    if (!nctx) return computed;
    nctx.clearRect(0, 0, 1, 1);
    nctx.fillStyle = "#000";
    nctx.fillStyle = computed; // ignored if the browser can't parse it
    nctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = nctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const tokens = Object.fromEntries(
    (Object.keys(COLOR_EXPR) as ColorKey[]).map((key) => [key, read(COLOR_EXPR[key])]),
  ) as Record<ColorKey, string>;
  const extraResolved: Record<string, string> = {};
  for (const expr of extra) extraResolved[expr] = read(expr);
  document.body.removeChild(probe);
  return { tokens, extra: extraResolved };
}

function withAlpha(rgb: string, alpha: number): string {
  const match = rgb.match(/-?\d+(\.\d+)?/g);
  if (!match || match.length < 3) return rgb;
  const [r, g, b] = match;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function isLightColor(rgb: string): boolean {
  const match = rgb.match(/-?\d+(\.\d+)?/g);
  if (!match || match.length < 3) return false;
  const [r, g, b] = match.map(Number);
  // Perceived luminance (sRGB) — pick ink that contrasts with a fill.
  return 0.299 * r! + 0.587 * g! + 0.114 * b! > 150;
}

function formatCompactQuantity(value: number): string {
  if (value >= 1_000) return formatCompactTokens(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatProviderActivity(entry: ShareProviderTotal): string {
  const values: string[] = [];
  if (entry.tokens > 0) values.push(formatCompactTokens(entry.tokens));
  if ((entry.billingRequests ?? 0) > 0) {
    values.push(`${formatCompactQuantity(entry.billingRequests ?? 0)} req`);
  }
  if ((entry.billingAiCredits ?? 0) > 0) {
    values.push(`${formatCompactQuantity(entry.billingAiCredits ?? 0)} cr`);
  }
  return values.length > 0 ? values.join(" · ") : "activity";
}

// ── Canvas drawing ───────────────────────────────────────────────────

const CARD_W = 1200;
const CARD_H = 630;
const PAD = 56;
const FONT = '"DM Sans Variable", system-ui, -apple-system, sans-serif';
/** 53 columns ≈ one year — the natural "wrapped" scope for a share image. */
const HEATMAP_WEEKS = 53;
const HEATMAP_CELL = 16;
const HEATMAP_GAP = 4;
/** Provider-hue opacity per intensity level; bright so cells read clearly. */
const LEVEL_ALPHA = [0, 0.45, 0.65, 0.82, 1] as const;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

interface DrawInput {
  readonly data: ShareProfileData;
  readonly user: ShareUser | null;
}

function drawZrodeMark(
  ctx: CanvasRenderingContext2D,
  input: {
    readonly x: number;
    readonly y: number;
    readonly size: number;
    readonly color: string;
    readonly lineWidth?: number;
  },
) {
  if (typeof Path2D === "undefined") {
    ctx.fillStyle = input.color;
    ctx.font = `700 ${Math.round(input.size * 0.68)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(APP_BASE_NAME.slice(0, 1), input.x + input.size / 2, input.y + input.size / 2);
    return;
  }

  ctx.save();
  ctx.translate(input.x, input.y);
  ctx.scale(input.size / ZRODE_MARK_VIEWBOX_SIZE, input.size / ZRODE_MARK_VIEWBOX_SIZE);
  ctx.strokeStyle = input.color;
  ctx.lineWidth = input.lineWidth ?? 36;
  ctx.lineJoin = "round";
  for (const path of ZRODE_MARK_PATHS) {
    ctx.stroke(new Path2D(path));
  }
  ctx.restore();
}

function drawShareCard(ctx: CanvasRenderingContext2D, input: DrawInput): void {
  const { data, user } = input;
  // Resolve every hue used by the legend and by any day-cell in one probe pass.
  const colorExprs = new Set<string>();
  for (const entry of data.providerTotals) colorExprs.add(entry.colorVar);
  for (const point of data.heatmap) {
    if (point.colorVar) colorExprs.add(point.colorVar);
  }
  const { tokens: c, extra } = resolveColors([...colorExprs]);
  const accent = c.accent;
  const dark = !isLightColor(c.background);
  // Elevated surface for panels — a touch above the page background either way.
  const panel = withAlpha(c.foreground, dark ? 0.05 : 0.03);
  const hairline = withAlpha(c.foreground, dark ? 0.1 : 0.08);

  ctx.clearRect(0, 0, CARD_W, CARD_H);

  // Background + layered accent glows (top-right strong, bottom-left faint)
  // for depth without washing out the content.
  ctx.fillStyle = c.background;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow = ctx.createRadialGradient(CARD_W - 40, -60, 40, CARD_W - 40, -60, 860);
  glow.addColorStop(0, withAlpha(accent, 0.26));
  glow.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const glow2 = ctx.createRadialGradient(80, CARD_H + 60, 20, 80, CARD_H + 60, 560);
  glow2.addColorStop(0, withAlpha(accent, 0.08));
  glow2.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Framed edge + a bright accent seam along the very top.
  ctx.strokeStyle = hairline;
  ctx.lineWidth = 1;
  roundRect(ctx, 10.5, 10.5, CARD_W - 21, CARD_H - 21, 24);
  ctx.stroke();
  const seam = ctx.createLinearGradient(PAD, 0, CARD_W - PAD, 0);
  seam.addColorStop(0, withAlpha(accent, 0));
  seam.addColorStop(0.5, withAlpha(accent, 0.9));
  seam.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = seam;
  ctx.fillRect(PAD, 11, CARD_W - PAD * 2, 2);

  // ── Header: brand mark + wordmark, meta on the right ──
  const markY = 44;
  const markSize = 44;
  drawZrodeMark(ctx, {
    x: PAD,
    y: markY,
    size: markSize,
    color: c.foreground,
  });

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const wordX = PAD + markSize + 15;
  const wordY = markY + 30;
  ctx.font = `700 25px ${FONT}`;
  ctx.fillStyle = c.mutedForeground;
  ctx.fillText(APP_BASE_NAME.toUpperCase(), wordX, wordY);

  ctx.textAlign = "right";
  ctx.font = `600 14px ${FONT}`;
  ctx.fillStyle = c.foreground;
  ctx.fillText(data.rangeLabel.toUpperCase(), CARD_W - PAD, markY + 18);
  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = c.mutedForeground;
  ctx.fillText("AI CODING USAGE", CARD_W - PAD, markY + 37);
  ctx.textAlign = "left";

  // ── Identity: name + subtitle (no avatar — cleaner, brand mark is enough) ──
  const idY = 118;
  ctx.fillStyle = c.foreground;
  ctx.font = `600 40px ${FONT}`;
  ctx.fillText(user?.name ?? "My usage", PAD, idY + 30);
  ctx.fillStyle = c.mutedForeground;
  ctx.font = `500 17px ${FONT}`;
  ctx.fillText(user?.handle ? `@${user.handle}` : `Powered by ${APP_BASE_NAME}`, PAD, idY + 58);

  // ── Stat bar: one elevated pill, values split by hairline dividers ──
  const barY = 202;
  const barH = 92;
  roundRect(ctx, PAD, barY, CARD_W - PAD * 2, barH, 18);
  ctx.fillStyle = panel;
  ctx.fill();
  ctx.strokeStyle = hairline;
  ctx.lineWidth = 1;
  ctx.stroke();
  const count = Math.max(1, data.stats.length);
  const segW = (CARD_W - PAD * 2) / count;
  data.stats.forEach((stat, index) => {
    const segX = PAD + index * segW;
    if (index > 0) {
      ctx.strokeStyle = withAlpha(c.foreground, dark ? 0.08 : 0.06);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(segX, barY + 20);
      ctx.lineTo(segX, barY + barH - 20);
      ctx.stroke();
    }
    ctx.fillStyle = index === 0 ? accent : c.foreground;
    ctx.font = `700 29px ${FONT}`;
    ctx.fillText(stat.value, segX + 22, barY + 44);
    ctx.fillStyle = c.mutedForeground;
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText(stat.label.toUpperCase(), segX + 22, barY + 68);
  });

  // ── Heatmap (full-width centerpiece, coloured by dominant subscription) ──
  const grid = buildHeatmapGrid({
    heatmap: data.heatmap,
    todayKey: data.todayKey,
    weeksCount: HEATMAP_WEEKS,
  });
  const step = HEATMAP_CELL + HEATMAP_GAP;
  const monthsY = barY + barH + 42;
  const gridTop = monthsY + 12;
  const emptyFill = withAlpha(c.foreground, dark ? 0.09 : 0.07);

  ctx.font = `500 12px ${FONT}`;
  ctx.fillStyle = c.mutedForeground;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  grid.monthLabels.forEach((label, wIndex) => {
    if (label) ctx.fillText(label, PAD + wIndex * step, monthsY);
  });

  // Match the in-app calendar's orientation labels so the exported image is
  // a complete, immediately readable heatmap rather than an unlabeled grid.
  ctx.font = `500 11px ${FONT}`;
  ctx.fillStyle = c.mutedForeground;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const [dayIndex, label] of [
    [1, "Mon"],
    [3, "Wed"],
    [5, "Fri"],
  ] as const) {
    ctx.fillText(label, PAD - 9, gridTop + dayIndex * step + HEATMAP_CELL / 2);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const cellColorFor = (colorVar: string | null, level: number): string => {
    if (level <= 0) return emptyFill;
    const hue = colorVar ? (extra[colorVar] ?? accent) : accent;
    return withAlpha(hue, LEVEL_ALPHA[level]!);
  };
  grid.weeks.forEach((column, wIndex) => {
    column.forEach((entry, dIndex) => {
      if (entry.level < 0) return;
      const x = PAD + wIndex * step;
      const y = gridTop + dIndex * step;
      roundRect(ctx, x, y, HEATMAP_CELL, HEATMAP_CELL, 3);
      ctx.fillStyle = cellColorFor(entry.colorVar, entry.level);
      ctx.fill();
    });
  });

  // ── Footer row: provider legend (left) + intensity key (right) ──
  const footY = gridTop + 7 * step + 26;
  let legendX = PAD;
  let legendY = footY;
  const legendRight = CARD_W - PAD - 190;
  ctx.textBaseline = "middle";
  for (const entry of data.providerTotals) {
    ctx.font = `600 15px ${FONT}`;
    const labelW = ctx.measureText(entry.label).width;
    ctx.font = `500 15px ${FONT}`;
    const value = formatProviderActivity(entry);
    const valueW = ctx.measureText(value).width;
    const entryW = 20 + labelW + 8 + valueW + 30;
    if (legendX > PAD && legendX + entryW > legendRight) {
      legendX = PAD;
      legendY += 26;
    }
    const color = extra[entry.colorVar] ?? accent;
    ctx.fillStyle = color;
    roundRect(ctx, legendX, legendY - 6, 12, 12, 3);
    ctx.fill();
    ctx.fillStyle = c.foreground;
    ctx.font = `600 15px ${FONT}`;
    ctx.fillText(entry.label, legendX + 20, legendY);
    ctx.fillStyle = c.mutedForeground;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(value, legendX + 20 + labelW + 8, legendY);
    legendX += entryW;
  }

  ctx.textAlign = "right";
  ctx.fillStyle = c.foreground;
  ctx.font = `500 13px ${FONT}`;
  let keyX = CARD_W - PAD;
  ctx.fillText("More", keyX, footY);
  keyX -= ctx.measureText("More").width + 8;
  // Clearly-visible neutral ramp: even the lowest step reads against the bg,
  // and the empty step keeps a hairline so it's not lost.
  const keyAlpha = [0.22, 0.44, 0.63, 0.81, 1];
  for (let level = 4; level >= 0; level -= 1) {
    keyX -= 12;
    roundRect(ctx, keyX, footY - 6, 12, 12, 3);
    ctx.fillStyle = withAlpha(c.foreground, keyAlpha[level]!);
    ctx.fill();
    if (level === 0) {
      ctx.strokeStyle = withAlpha(c.foreground, 0.25);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    keyX -= 4;
  }
  keyX -= 4;
  ctx.fillStyle = c.foreground;
  ctx.fillText("Less", keyX, footY);
  ctx.textAlign = "left";

  // ── Baseline footer ──
  ctx.fillStyle = c.mutedForeground;
  ctx.font = `500 13px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`Made with ${APP_BASE_NAME} · usage read locally on your device`, PAD, CARD_H - 30);
}

// ── Component ────────────────────────────────────────────────────────

const EXPORT_SCALE = 2;

export function ShareProfileCardDialog({
  open,
  onOpenChange,
  data,
  user,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ShareProfileData;
  user: ShareUser | null;
}) {
  // Callback ref (not useRef): the canvas lives inside a portalled dialog that
  // mounts a tick after `open` flips, so we key drawing off the node actually
  // attaching rather than an effect that may run before the ref is set.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!canvas) return;
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = CARD_W * EXPORT_SCALE;
      canvas.height = CARD_H * EXPORT_SCALE;
      ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
      drawShareCard(ctx, { data, user });
    };
    // Draw immediately, then again once fonts are ready so the wordmark and
    // numbers settle onto the real face instead of a fallback.
    render();
    if (document.fonts?.ready) {
      void document.fonts.ready.then(render);
    }
    return () => {
      cancelled = true;
    };
  }, [canvas, data, user]);

  const fileName = `${APP_BASE_NAME.toLowerCase()}-usage-${user?.handle ?? data.todayKey}.png`;

  const toBlob = (): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (!canvas) {
        resolve(null);
        return;
      }
      canvas.toBlob((blob) => resolve(blob), "image/png");
    });

  const handleDownload = async () => {
    setBusy(true);
    try {
      const blob = await toBlob();
      if (!blob) throw new Error("Could not render image.");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save image",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setBusy(false);
    }
  };

  const canCopy =
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function" &&
    typeof window !== "undefined" &&
    "ClipboardItem" in window;

  const handleCopy = async () => {
    setBusy(true);
    try {
      const blob = await toBlob();
      if (!blob) throw new Error("Could not render image.");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't copy image",
        description: error instanceof Error ? error.message : "Clipboard access was denied.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2Icon className="size-4" />
            Share your usage
          </DialogTitle>
          <DialogDescription>
            A branded card of your subscription usage, drawn with your current theme colors. Save it
            or copy it straight to your clipboard.
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 pb-4 sm:px-6">
          <div className="overflow-hidden rounded-xl border shadow-sm">
            <canvas
              ref={setCanvas}
              className="block h-auto w-full"
              style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}
              role="img"
              aria-label="Usage profile share card preview"
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {canCopy ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={handleCopy}>
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                {copied ? "Copied" : "Copy image"}
              </Button>
            ) : null}
            <Button size="sm" disabled={busy} onClick={handleDownload}>
              <DownloadIcon className="size-4" />
              Download PNG
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** Wrapper that pulls in the Clerk user only when cloud auth is configured. */
export function ShareProfileButton({
  data,
  className,
}: {
  data: ShareProfileData;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className={cn(
          "h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <Share2Icon className="size-3" />
        Share
      </Button>
      {open ? <ShareProfileGate open={open} onOpenChange={setOpen} data={data} /> : null}
    </>
  );
}

/**
 * `useUser` may only be called under a ClerkProvider, which mounts only when
 * cloud auth is configured — so the Clerk-reading variant is a separate
 * component chosen by a stable runtime check.
 */
function ShareProfileGate(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ShareProfileData;
}) {
  return hasCloudPublicConfig() ? (
    <ClerkShareProfileDialog {...props} />
  ) : (
    <ShareProfileCardDialog {...props} user={null} />
  );
}

function ClerkShareProfileDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: ShareProfileData;
}) {
  const { isSignedIn, user } = useUser();
  const shareUser: ShareUser | null =
    isSignedIn && user
      ? {
          name: user.fullName ?? user.firstName ?? user.username ?? null,
          handle: user.username ?? null,
        }
      : null;
  return <ShareProfileCardDialog {...props} user={shareUser} />;
}
