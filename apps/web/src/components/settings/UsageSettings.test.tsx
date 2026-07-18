import type { ProviderTokenActivityKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCalendar,
  computeStats,
  formatTokens,
  isActiveUsage,
  makeTokenLevelScale,
  ProviderSpendBreakdown,
  ProviderUsageCard,
  StatsRow,
  toDayKey,
  usageLevel,
  UsageHeatmap,
  type DayUsage,
} from "./UsageSettings";

// Thursday, June 18 2026 — mid-week so the calendar has future cells.
const TODAY = new Date(2026, 5, 18);

function usage(
  provider: ProviderTokenActivityKind,
  overrides: Partial<Omit<DayUsage, "provider">> = {},
): DayUsage {
  return {
    provider,
    tokens: 0,
    peakSessionPercent: null,
    peakWeeklyPercent: null,
    ...overrides,
  };
}

describe("formatTokens", () => {
  it("compacts token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_200)).toBe("1.2K");
    expect(formatTokens(3_400_000)).toBe("3.4M");
    expect(formatTokens(2_400_000_000)).toBe("2.4B");
  });
});

describe("token level scale", () => {
  it("ranks days against the user's own activity percentiles", () => {
    const scale = makeTokenLevelScale([100, 200, 300, 400]);
    expect(scale(0)).toBe(0);
    expect(scale(100)).toBe(1);
    expect(scale(250)).toBe(2);
    expect(scale(350)).toBe(3);
    // The busiest day always lands in the top level.
    expect(scale(400)).toBe(4);
    expect(scale(999_999)).toBe(4);
  });

  it("puts a lone active day in the top level", () => {
    const scale = makeTokenLevelScale([100]);
    expect(scale(100)).toBe(4);
  });

  it("falls back to sampled percent when a day has no token data", () => {
    const scale = makeTokenLevelScale([100]);
    expect(usageLevel(usage("claude", { peakSessionPercent: 10 }), scale)).toBe(1);
    expect(usageLevel(usage("claude", { peakSessionPercent: 90 }), scale)).toBe(4);
    // Weekly-only sampled days count too (they used to be dropped).
    expect(usageLevel(usage("claude", { peakWeeklyPercent: 60 }), scale)).toBe(3);
    expect(usageLevel(usage("claude"), scale)).toBe(0);
  });
});

describe("isActiveUsage", () => {
  it("treats weekly-only sampled days as active", () => {
    expect(isActiveUsage(usage("claude", { peakWeeklyPercent: 5 }))).toBe(true);
    expect(isActiveUsage(usage("claude", { tokens: 1 }))).toBe(true);
    expect(isActiveUsage(usage("claude"))).toBe(false);
  });
});

describe("buildCalendar", () => {
  it("lays out weeks Sunday-first ending on the week containing today", () => {
    const calendar = buildCalendar({ byDay: new Map(), weeksCount: 4, today: TODAY });

    expect(calendar.weeks).toHaveLength(4);
    expect(calendar.weeks.every((week) => week.length === 7)).toBe(true);
    expect(calendar.startKey).toBe("2026-05-24");
    const lastWeek = calendar.weeks[3]!;
    expect(lastWeek[0]!.key).toBe("2026-06-14"); // Sunday
    expect(lastWeek[4]!.key).toBe(toDayKey(TODAY));
    expect(lastWeek[4]!.isFuture).toBe(false);
    expect(lastWeek[5]!.isFuture).toBe(true); // Friday after today
    expect(lastWeek[6]!.isFuture).toBe(true);
  });

  it("labels the column that contains the 1st of a month", () => {
    const calendar = buildCalendar({ byDay: new Map(), weeksCount: 4, today: TODAY });

    // June 1, 2026 is a Monday, inside the week starting Sunday May 31.
    expect(calendar.monthLabels.map((month) => month.label)).toEqual(["", "Jun", "", ""]);
  });

  it("marks each day's most-used subscription as top, by tokens", () => {
    const byDay = new Map([
      [
        "2026-06-16",
        [
          usage("claude", { tokens: 500_000, peakSessionPercent: 90 }),
          usage("codex", { tokens: 900_000, peakSessionPercent: 10 }),
          usage("opencode", { tokens: 1_200_000 }),
        ],
      ],
    ]);
    const calendar = buildCalendar({ byDay, weeksCount: 2, today: TODAY });
    const cell = calendar.weeks.flat().find((candidate) => candidate.key === "2026-06-16")!;

    expect(cell.usages).toHaveLength(3);
    expect(cell.top?.provider).toBe("opencode");
  });
});

describe("computeStats", () => {
  it("computes token totals, active days, streaks, and the peak day", () => {
    const byDay = new Map([
      ["2026-06-15", [usage("claude", { tokens: 100_000 })]],
      ["2026-06-16", [usage("claude", { tokens: 800_000 }), usage("codex", { tokens: 50_000 })]],
      ["2026-06-17", [usage("codex", { peakSessionPercent: 10 })]],
      // A detached earlier single-day streak.
      ["2026-06-10", [usage("claude", { tokens: 5_000 })]],
    ]);
    const stats = computeStats(byDay, TODAY);

    expect(stats.activeDays).toBe(4);
    expect(stats.totalTokens).toBe(955_000);
    // Today (Jun 18) has no sample yet, so the streak counts back from Jun 17.
    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
    expect(stats.peakDay?.key).toBe("2026-06-16");
    expect(stats.peakDay?.tokens).toBe(850_000);
  });

  it("ignores days with neither tokens nor sampled usage", () => {
    const byDay = new Map([["2026-06-17", [usage("claude")]]]);
    const stats = computeStats(byDay, TODAY);

    expect(stats.activeDays).toBe(0);
    expect(stats.currentStreak).toBe(0);
    expect(stats.peakDay).toBeNull();
  });
});

describe("StatsRow", () => {
  it("keeps the complete overall summary visible at a glance", () => {
    const markup = renderToStaticMarkup(
      <StatsRow
        stats={{
          totalTokens: 12_000_000_000,
          activeDays: 116,
          currentStreak: 18,
          longestStreak: 24,
          peakDay: { key: "2026-07-12", tokens: 849_000_000, percent: null },
        }}
      />,
    );

    expect(markup).toContain("Total tokens");
    expect(markup).toContain("Active days");
    expect(markup).toContain("Current streak");
    expect(markup).toContain("Longest streak");
    expect(markup).toContain("Peak day");
    expect(markup).toContain("Avg. active day");
    expect(markup).toContain("12B");
    expect(markup).toContain("849M");
  });
});

describe("ProviderUsageCard", () => {
  it("shows a compact provider summary before its details are expanded", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageCard
        section={{
          provider: "codex",
          stats: {
            totalTokens: 2_400_000,
            activeDays: 8,
            currentStreak: 3,
            longestStreak: 5,
            peakDay: { key: "2026-06-16", tokens: 900_000, percent: null },
          },
          providerDayLabels: [],
          providerTokenChart: [],
          pressureDayLabels: [],
          pressureSeries: [],
          sampledDayCount: 0,
          topModel: null,
          estimatedCostUsd: 4.25,
        }}
        tokenMode="daily"
        modelRows={[]}
        totalTokens={12_000_000}
      />,
    );

    expect(markup).toContain("Codex");
    expect(markup).toContain("20% of recorded tokens");
    expect(markup).toContain("Top model");
    expect(markup).toContain("API estimate");
    expect(markup).toContain("Details");
    expect(markup).not.toContain("Current streak");
  });
});

describe("ProviderSpendBreakdown", () => {
  it("shows estimated spend and pricing coverage for each active provider", () => {
    const markup = renderToStaticMarkup(
      <ProviderSpendBreakdown
        estimate={{
          totalUsd: 12.5,
          pricedTokens: 100,
          totalTokens: 150,
          providerCosts: new Map([["claude", 12.5]]),
          models: [
            {
              provider: "claude",
              model: "claude-sonnet-5",
              totalTokens: 100,
              pricedTokens: 100,
              costUsd: 12.5,
            },
            {
              provider: "codex",
              model: "unknown",
              totalTokens: 50,
              pricedTokens: 0,
              costUsd: null,
            },
          ],
        }}
      />,
    );

    expect(markup).toContain("By provider");
    expect(markup).toContain("Claude");
    expect(markup).toContain("$12.50");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Not priced");
    expect(markup).toContain("0% covered");
  });
});

describe("UsageHeatmap", () => {
  const byDay = new Map([
    [
      "2026-06-16",
      [
        usage("claude", { tokens: 1_400_000, peakSessionPercent: 80 }),
        usage("codex", { tokens: 200_000 }),
      ],
    ],
  ]);
  const calendar = buildCalendar({ byDay, weeksCount: 2, today: TODAY });
  const tokenScale = makeTokenLevelScale([200_000, 1_400_000]);

  it("colors the combined view by the dominant subscription and labels cells accessibly", () => {
    const markup = renderToStaticMarkup(
      <UsageHeatmap calendar={calendar} tokenScale={tokenScale} label="All subscriptions" />,
    );

    expect(markup).toContain(
      'aria-label="Jun 16, 2026: Claude 1.4M tokens, session peak 80%; Codex 200K tokens"',
    );
    expect(markup).toContain("--color-orange-600"); // dominant claude hue
    expect(markup).toContain('aria-label="Jun 15, 2026: no usage recorded"');
    // The grid is keyboard-focusable for arrow-key inspection.
    expect(markup).toContain('tabindex="0"');
    // Columns share the available width; the heatmap never creates a horizontal scroller.
    expect(markup).toContain("repeat(2, minmax(0, 1fr))");
    expect(markup).not.toContain("overflow-x-auto");
  });

  it("filters to the given subscription's own hue in per-provider view", () => {
    const markup = renderToStaticMarkup(
      <UsageHeatmap calendar={calendar} provider="codex" tokenScale={tokenScale} label="Codex" />,
    );

    expect(markup).toContain("--color-sky-600");
    expect(markup).not.toContain("--color-orange-600");
  });
});
