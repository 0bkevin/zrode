import { describe, expect, it } from "vite-plus/test";

import { buildHeatmapGrid, formatCompactTokens } from "./ShareProfileCard";

describe("formatCompactTokens", () => {
  it("compacts token counts like the rest of the page", () => {
    expect(formatCompactTokens(950)).toBe("950");
    expect(formatCompactTokens(1_200)).toBe("1.2K");
    expect(formatCompactTokens(3_400_000)).toBe("3.4M");
    expect(formatCompactTokens(2_400_000_000)).toBe("2.4B");
  });
});

describe("buildHeatmapGrid", () => {
  it("lays out Sunday-first weeks ending on today's week with future cells blanked", () => {
    // Thursday, June 18 2026.
    const grid = buildHeatmapGrid({ heatmap: [], todayKey: "2026-06-18", weeksCount: 4 });
    expect(grid.weeks).toHaveLength(4);
    expect(grid.weeks.every((week) => week.length === 7)).toBe(true);
    expect(grid.monthLabels).toHaveLength(4);
    const lastWeek = grid.weeks[3]!;
    // Sun–Thu are past/today (level 0, no data), Fri/Sat are future (-1).
    expect(lastWeek.slice(0, 5).map((cell) => cell.level)).toEqual([0, 0, 0, 0, 0]);
    expect(lastWeek[5]!.level).toBe(-1);
    expect(lastWeek[6]!.level).toBe(-1);
  });

  it("labels a week column when it rolls into a new month", () => {
    // 8 weeks back from mid-June crosses May→June.
    const grid = buildHeatmapGrid({ heatmap: [], todayKey: "2026-06-18", weeksCount: 8 });
    expect(grid.monthLabels[0]).toBe(""); // leading partial week is never labeled
    expect(grid.monthLabels.some((label) => label === "Jun")).toBe(true);
  });

  it("ranks day totals into quartile levels and keeps each day's dominant hue", () => {
    const heatmap = [
      { day: "2026-06-14", total: 100, colorVar: "var(--color-orange-600)" },
      { day: "2026-06-15", total: 200, colorVar: "var(--color-sky-600)" },
      { day: "2026-06-16", total: 300, colorVar: "var(--color-emerald-600)" },
      { day: "2026-06-17", total: 4_000_000, colorVar: "var(--color-sky-600)" },
    ];
    const grid = buildHeatmapGrid({ heatmap, todayKey: "2026-06-18", weeksCount: 1 });
    const week = grid.weeks[0]!;
    // Sun 6/14 … Wed 6/17 carry the four totals; Thu (today) has none.
    expect(week[0]).toEqual({ level: 1, colorVar: "var(--color-orange-600)" }); // 100 — lowest quartile
    expect(week[3]).toEqual({ level: 4, colorVar: "var(--color-sky-600)" }); // 4M — busiest, top level
    expect(week[4]).toEqual({ level: 0, colorVar: null }); // today, no data
    expect(week[5]!.level).toBe(-1); // future
  });
});
