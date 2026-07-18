import type { ProviderTokenActivityKind } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  buildAreaBands,
  buildTokenSeries,
  toCumulativeSeries,
  UsageAreaChart,
  weekdayAverages,
  WeekdayBarChart,
  type ChartSeries,
  type DaySeriesInput,
} from "./UsageCharts";

function day(...entries: ReadonlyArray<[ProviderTokenActivityKind, number]>): DaySeriesInput[] {
  return entries.map(([provider, tokens]) => ({ provider, tokens }));
}

describe("buildTokenSeries", () => {
  it("fills a dense day range with zeros for gaps", () => {
    const byDay = new Map<string, DaySeriesInput[]>([
      ["2026-06-01", day(["claude", 100], ["codex", 40])],
      ["2026-06-03", day(["codex", 10])],
    ]);
    const series = buildTokenSeries(byDay, "2026-06-01", "2026-06-04");

    expect(series.map((point) => point.day)).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
      "2026-06-04",
    ]);
    expect(series[0]).toEqual({
      day: "2026-06-01",
      values: { claude: 100, codex: 40, grok: 0, kilocode: 0, opencode: 0 },
      total: 140,
    });
    expect(series[1]!.total).toBe(0); // gap day filled
    expect(series[2]!.values.codex).toBe(10);
  });

  it("crosses month boundaries and returns nothing for an inverted range", () => {
    const series = buildTokenSeries(new Map(), "2026-01-30", "2026-02-02");
    expect(series.map((point) => point.day)).toEqual([
      "2026-01-30",
      "2026-01-31",
      "2026-02-01",
      "2026-02-02",
    ]);
    expect(buildTokenSeries(new Map(), "2026-02-02", "2026-01-30")).toEqual([]);
  });
});

describe("toCumulativeSeries", () => {
  it("accumulates per provider and total, including opencode", () => {
    const daily = buildTokenSeries(
      new Map<string, DaySeriesInput[]>([
        ["2026-06-01", day(["claude", 100], ["opencode", 30])],
        ["2026-06-02", day(["claude", 50], ["codex", 20], ["opencode", 10])],
      ]),
      "2026-06-01",
      "2026-06-02",
    );
    const cumulative = toCumulativeSeries(daily);
    expect(cumulative[0]!.total).toBe(130);
    expect(cumulative[1]!.values.claude).toBe(150);
    expect(cumulative[1]!.values.codex).toBe(20);
    expect(cumulative[1]!.values.opencode).toBe(40);
    expect(cumulative[1]!.total).toBe(210);
  });
});

describe("weekdayAverages", () => {
  it("averages daily totals per weekday, counting empty days as zero", () => {
    // 2026-06-01 is a Monday. Two Mondays: 100 and 0 → avg 50.
    const daily = buildTokenSeries(
      new Map<string, DaySeriesInput[]>([
        ["2026-06-01", day(["claude", 100])],
        ["2026-06-08", day()],
      ]),
      "2026-06-01",
      "2026-06-08",
    );
    const averages = weekdayAverages(daily);
    const monday = averages.find((entry) => entry.label === "Mon")!;
    expect(monday.values.claude).toBe(50);
    expect(averages).toHaveLength(7);
  });
});

describe("chart rendering", () => {
  const dayLabels = ["Jun 1, 2026", "Jun 2, 2026", "Jun 3, 2026"];
  const series: ChartSeries[] = [
    { key: "claude", label: "Claude", colorVar: "var(--color-orange-600)", values: [100, 0, 300] },
    { key: "codex", label: "Codex", colorVar: "var(--color-sky-600)", values: [0, 50, 20] },
    {
      key: "opencode",
      label: "OpenCode",
      colorVar: "var(--color-emerald-600)",
      values: [10, 5, 0],
    },
  ];

  it("plots every provider from zero instead of stacking providers together", () => {
    const bands = buildAreaBands(series);

    expect(bands.find((entry) => entry.layer.key === "claude")!.band[0]).toEqual({
      base: 0,
      top: 100,
    });
    expect(bands.find((entry) => entry.layer.key === "opencode")!.band[0]).toEqual({
      base: 0,
      top: 10,
    });
  });

  it("renders an accessible area chart with all series hues", () => {
    const markup = renderToStaticMarkup(
      <UsageAreaChart
        dayLabels={dayLabels}
        series={series}
        formatValue={(value) => `${value}`}
        ariaLabel="Tokens per day"
      />,
    );
    expect(markup).toContain('aria-label="Tokens per day"');
    expect(markup).toContain("var(--color-orange-600)");
    expect(markup).toContain("var(--color-sky-600)");
    expect(markup).toContain("var(--color-emerald-600)");
    expect(markup).toContain("Today");
  });

  it("renders a labeled weekday bar chart", () => {
    const markup = renderToStaticMarkup(
      <WeekdayBarChart
        data={weekdayAverages(buildTokenSeries(new Map(), "2026-06-01", "2026-06-07"))}
        series={[{ key: "claude", label: "Claude", colorVar: "var(--color-orange-600)" }]}
        formatValue={(value) => `${value}`}
        ariaLabel="Average tokens by weekday"
      />,
    );
    expect(markup).toContain('aria-label="Average tokens by weekday"');
    expect(markup).toContain(">Mon<");
  });
});
