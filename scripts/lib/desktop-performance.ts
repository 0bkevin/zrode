export interface DesktopPerformanceSample {
  readonly elapsedMs: number;
  readonly usedHeapBytes: number;
  readonly totalHeapBytes: number;
  readonly documentCount: number;
  readonly nodeCount: number;
  readonly listenerCount: number;
}

export interface DesktopPerformanceSummary {
  readonly sampleCount: number;
  readonly durationMs: number;
  readonly initialUsedHeapBytes: number;
  readonly finalUsedHeapBytes: number;
  readonly usedHeapGrowthBytes: number;
  readonly usedHeapGrowthPercent: number;
  readonly maxNodeCount: number;
  readonly maxListenerCount: number;
}

export function summarizeDesktopPerformanceSamples(
  samples: ReadonlyArray<DesktopPerformanceSample>,
): DesktopPerformanceSummary {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      durationMs: 0,
      initialUsedHeapBytes: 0,
      finalUsedHeapBytes: 0,
      usedHeapGrowthBytes: 0,
      usedHeapGrowthPercent: 0,
      maxNodeCount: 0,
      maxListenerCount: 0,
    };
  }
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const growth = last.usedHeapBytes - first.usedHeapBytes;
  return {
    sampleCount: samples.length,
    durationMs: Math.max(0, last.elapsedMs - first.elapsedMs),
    initialUsedHeapBytes: first.usedHeapBytes,
    finalUsedHeapBytes: last.usedHeapBytes,
    usedHeapGrowthBytes: growth,
    usedHeapGrowthPercent: first.usedHeapBytes === 0 ? 0 : (growth / first.usedHeapBytes) * 100,
    maxNodeCount: Math.max(...samples.map((sample) => sample.nodeCount)),
    maxListenerCount: Math.max(...samples.map((sample) => sample.listenerCount)),
  };
}

export interface DesktopArtifactMeasurement {
  readonly platform: string;
  readonly arch: string;
  readonly artifactPath: string;
  readonly artifactBytes: number;
  readonly measuredAt: string;
}

export function artifactSizeRegressionPercent(currentBytes: number, baselineBytes: number): number {
  if (baselineBytes <= 0) return 0;
  return ((currentBytes - baselineBytes) / baselineBytes) * 100;
}

export function evaluateDesktopSmokeFailures(input: {
  readonly output: string;
  readonly timedOut: boolean;
  readonly requireMilestones: boolean;
  readonly appReadyMs: number | null;
  readonly rendererLoadedMs: number | null;
}): ReadonlyArray<string> {
  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => input.output.includes(pattern));
  if (input.timedOut) failures.push("desktop smoke test timed out");
  if (input.requireMilestones && (input.appReadyMs === null || input.rendererLoadedMs === null)) {
    failures.push("startup milestones were not observed");
  }
  return failures;
}
