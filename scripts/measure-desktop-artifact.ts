// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Standalone measurement CLI.
// oxlint-disable zrode/no-global-process-runtime -- Standalone cross-platform measurement CLI.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  artifactSizeRegressionPercent,
  type DesktopArtifactMeasurement,
} from "./lib/desktop-performance.ts";

interface Arguments {
  readonly artifactPath: string;
  readonly platform: string;
  readonly arch: string;
  readonly outputPath: string;
  readonly baselinePath?: string;
  readonly maxGrowthPercent: number;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseDesktopArtifactMeasurementArguments(args: readonly string[]): Arguments {
  const artifactPath = readFlag(args, "--artifact");
  if (!artifactPath) throw new Error("--artifact <path> is required.");
  const maxGrowthPercent = Number(readFlag(args, "--max-growth-percent") ?? 5);
  if (!Number.isFinite(maxGrowthPercent) || maxGrowthPercent < 0) {
    throw new Error("--max-growth-percent must be a non-negative number.");
  }
  return {
    artifactPath: NodePath.resolve(artifactPath),
    platform: readFlag(args, "--platform") ?? NodeOS.platform(),
    arch: readFlag(args, "--arch") ?? NodeOS.arch(),
    outputPath: NodePath.resolve(readFlag(args, "--output") ?? "desktop-artifact-size.json"),
    ...(readFlag(args, "--baseline")
      ? { baselinePath: NodePath.resolve(readFlag(args, "--baseline")!) }
      : {}),
    maxGrowthPercent,
  };
}

export function measurePathBytes(path: string): number {
  const info = NodeFS.statSync(path);
  if (!info.isDirectory()) return info.size;
  return NodeFS.readdirSync(path).reduce(
    (total, entry) => total + measurePathBytes(NodePath.join(path, entry)),
    0,
  );
}

export function compareDesktopArtifactMeasurement(
  current: DesktopArtifactMeasurement,
  baseline: DesktopArtifactMeasurement,
  maxGrowthPercent: number,
) {
  const growthPercent = artifactSizeRegressionPercent(
    current.artifactBytes,
    baseline.artifactBytes,
  );
  return {
    growthBytes: current.artifactBytes - baseline.artifactBytes,
    growthPercent,
    exceedsBudget: growthPercent > maxGrowthPercent,
  };
}

function main() {
  const args = parseDesktopArtifactMeasurementArguments(process.argv.slice(2));
  const measurement: DesktopArtifactMeasurement = {
    platform: args.platform,
    arch: args.arch,
    artifactPath: args.artifactPath,
    artifactBytes: measurePathBytes(args.artifactPath),
    measuredAt: new Date().toISOString(),
  };
  let comparison: ReturnType<typeof compareDesktopArtifactMeasurement> | undefined;
  if (args.baselinePath) {
    const baseline = JSON.parse(
      NodeFS.readFileSync(args.baselinePath, "utf8"),
    ) as DesktopArtifactMeasurement;
    if (baseline.platform !== measurement.platform || baseline.arch !== measurement.arch) {
      throw new Error(
        `Baseline target ${baseline.platform}/${baseline.arch} does not match ${measurement.platform}/${measurement.arch}.`,
      );
    }
    comparison = compareDesktopArtifactMeasurement(measurement, baseline, args.maxGrowthPercent);
  }
  NodeFS.mkdirSync(NodePath.dirname(args.outputPath), { recursive: true });
  NodeFS.writeFileSync(
    args.outputPath,
    `${JSON.stringify({ measurement, comparison: comparison ?? null }, null, 2)}\n`,
  );
  console.log(
    `${measurement.platform}/${measurement.arch}: ${measurement.artifactBytes} bytes (${args.outputPath})`,
  );
  if (comparison?.exceedsBudget) {
    throw new Error(
      `Desktop artifact grew ${comparison.growthPercent.toFixed(2)}%, exceeding the ${args.maxGrowthPercent}% budget.`,
    );
  }
}

if (import.meta.main) main();
