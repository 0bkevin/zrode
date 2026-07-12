import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger, type DesktopLogAnnotations } from "./DesktopObservability.ts";

const CRASH_REPORT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const CRASH_REPORT_MAX_FILES = 20;

export interface DesktopCrashReportFile {
  readonly path: string;
  readonly modifiedAtMs: number;
  readonly size: number;
}

export function selectCrashReportsToPrune(
  reports: ReadonlyArray<DesktopCrashReportFile>,
  nowMs: number,
  maxAgeMs = CRASH_REPORT_MAX_AGE_MS,
  maxFiles = CRASH_REPORT_MAX_FILES,
): ReadonlyArray<DesktopCrashReportFile> {
  const newestFirst = [...reports].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  return newestFirst.filter(
    (report, index) => nowMs - report.modifiedAtMs > maxAgeMs || index >= maxFiles,
  );
}

export type ElectronDiagnosticLevel = "info" | "warning";

export interface ElectronDiagnosticRecord {
  readonly level: ElectronDiagnosticLevel;
  readonly message: string;
  readonly annotations: DesktopLogAnnotations;
}

type DiagnosticSink = (record: ElectronDiagnosticRecord) => void;

interface AppDiagnosticsTarget {
  readonly on: (eventName: "child-process-gone", listener: AppChildProcessGoneListener) => unknown;
  readonly removeListener: (
    eventName: "child-process-gone",
    listener: AppChildProcessGoneListener,
  ) => unknown;
  readonly getGPUFeatureStatus: () => Electron.GPUFeatureStatus;
}

type AppChildProcessGoneListener = (event: Electron.Event, details: Electron.Details) => void;

type WebContentsDiagnosticsTarget = Pick<Electron.WebContents, "id" | "on" | "removeListener">;

const gpuFeatureStatus = (
  app: Pick<AppDiagnosticsTarget, "getGPUFeatureStatus">,
): Electron.GPUFeatureStatus | { readonly unavailable: true } => {
  try {
    return app.getGPUFeatureStatus();
  } catch {
    return { unavailable: true };
  }
};

/**
 * Installs diagnostics for Electron utility processes. Renderer exits are emitted by
 * WebContents and are handled by attachWebContentsDiagnostics below.
 */
export function attachAppDiagnostics(input: {
  readonly app: AppDiagnosticsTarget;
  readonly onDiagnostic: DiagnosticSink;
}): () => void {
  const onChildProcessGone: AppChildProcessGoneListener = (_event, details) => {
    input.onDiagnostic({
      level: "warning",
      message: details.type === "GPU" ? "Electron GPU process gone" : "Electron child process gone",
      annotations: {
        processType: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        ...(details.name === undefined ? {} : { processName: details.name }),
        ...(details.serviceName === undefined ? {} : { serviceName: details.serviceName }),
        ...(details.type === "GPU" ? { gpuFeatureStatus: gpuFeatureStatus(input.app) } : {}),
      },
    });
  };

  input.app.on("child-process-gone", onChildProcessGone);
  return () => {
    input.app.removeListener("child-process-gone", onChildProcessGone);
  };
}

/**
 * Installs renderer crash and responsiveness diagnostics for one BrowserWindow.
 * The returned cleanup is idempotent and also runs when WebContents is destroyed.
 */
export function attachWebContentsDiagnostics(input: {
  readonly webContents: WebContentsDiagnosticsTarget;
  readonly logLabel: string;
  readonly onDiagnostic: DiagnosticSink;
  readonly now?: () => number;
}): () => void {
  const now = input.now ?? Date.now;
  let unresponsiveSince: number | undefined;
  let disposed = false;

  const onUnresponsive = () => {
    if (unresponsiveSince !== undefined) return;
    unresponsiveSince = now();
    input.onDiagnostic({
      level: "warning",
      message: `${input.logLabel} renderer unresponsive`,
      annotations: { webContentsId: input.webContents.id },
    });
  };
  const onResponsive = () => {
    const durationMs =
      unresponsiveSince === undefined ? undefined : Math.max(0, now() - unresponsiveSince);
    unresponsiveSince = undefined;
    input.onDiagnostic({
      level: "info",
      message: `${input.logLabel} renderer responsive`,
      annotations: {
        webContentsId: input.webContents.id,
        ...(durationMs === undefined ? {} : { unresponsiveDurationMs: durationMs }),
      },
    });
  };
  const onRenderProcessGone = (
    _event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ) => {
    const unresponsiveDurationMs =
      unresponsiveSince === undefined ? undefined : Math.max(0, now() - unresponsiveSince);
    unresponsiveSince = undefined;
    input.onDiagnostic({
      level: "warning",
      message: `${input.logLabel} render process gone`,
      annotations: {
        webContentsId: input.webContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
        ...(unresponsiveDurationMs === undefined ? {} : { unresponsiveDurationMs }),
      },
    });
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    input.webContents.removeListener("unresponsive", onUnresponsive);
    input.webContents.removeListener("responsive", onResponsive);
    input.webContents.removeListener("render-process-gone", onRenderProcessGone);
    input.webContents.removeListener("destroyed", cleanup);
  };

  input.webContents.on("unresponsive", onUnresponsive);
  input.webContents.on("responsive", onResponsive);
  input.webContents.on("render-process-gone", onRenderProcessGone);
  input.webContents.on("destroyed", cleanup);
  return cleanup;
}

const { logInfo, logWarning } = makeComponentLogger("desktop-electron");

const collectCrashReportFiles = Effect.fn("desktop.electronDiagnostics.collectCrashReports")(
  function* (
    directory: string,
    depth = 0,
  ): Effect.fn.Return<
    ReadonlyArray<DesktopCrashReportFile>,
    never,
    FileSystem.FileSystem | Path.Path
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const reports: DesktopCrashReportFile[] = [];
    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const info = yield* fileSystem.stat(entryPath).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "Directory" && depth < 3) {
        reports.push(...(yield* collectCrashReportFiles(entryPath, depth + 1)));
        continue;
      }
      if (info.value.type !== "File" || (!entry.endsWith(".dmp") && !entry.endsWith(".zip"))) {
        continue;
      }
      reports.push({
        path: entryPath,
        modifiedAtMs: Option.match(info.value.mtime, {
          onNone: () => 0,
          onSome: (modified) => modified.getTime(),
        }),
        size: Number(info.value.size),
      });
    }
    return reports;
  },
);

/**
 * Enables Crashpad before Electron is ready and retains a bounded set of local
 * minidumps. Upload remains disabled: dumps can contain sensitive process memory
 * and require an explicit consented transport before leaving the machine.
 */
export const configureDesktopCrashReporting = Effect.fn(
  "desktop.electronDiagnostics.configureCrashReporting",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crashDirectory = path.join(environment.stateDir, "crash-dumps");
  yield* fileSystem.makeDirectory(crashDirectory, { recursive: true });

  yield* Effect.sync(() => {
    Electron.app.setPath("crashDumps", crashDirectory);
    Electron.crashReporter.start({
      productName: environment.displayName,
      companyName: "T3 Tools",
      submitURL: "",
      uploadToServer: false,
      compress: true,
      extra: {
        appVersion: environment.appVersion,
        appArch: environment.runtimeInfo.appArch,
        hostArch: environment.runtimeInfo.hostArch,
      },
    });
  });

  const reports = yield* collectCrashReportFiles(crashDirectory);
  const nowMs = yield* Clock.currentTimeMillis;
  const expired = selectCrashReportsToPrune(reports, nowMs);
  for (const report of expired) {
    yield* fileSystem.remove(report.path, { force: true }).pipe(Effect.ignore);
  }
  const retained = reports.filter((report) => !expired.includes(report));
  yield* logInfo("Electron crash reporting configured", {
    crashDirectory,
    retainedReportCount: retained.length,
    retainedReportBytes: retained.reduce((total, report) => total + report.size, 0),
    prunedReportCount: expired.length,
    uploadEnabled: false,
  });
});

export const registerDesktopElectronDiagnostics = Effect.fn("desktop.electronDiagnostics.register")(
  function* (): Effect.fn.Return<void, never, Scope.Scope> {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    const onDiagnostic: DiagnosticSink = ({ level, message, annotations }) => {
      void runPromise(
        level === "warning" ? logWarning(message, annotations) : logInfo(message, annotations),
      );
    };

    yield* Effect.acquireRelease(
      Effect.sync(() => attachAppDiagnostics({ app: Electron.app, onDiagnostic })),
      (cleanup) => Effect.sync(cleanup),
    ).pipe(Effect.asVoid);
  },
);

export const logGpuFeatureStatus = Effect.sync(() => gpuFeatureStatus(Electron.app)).pipe(
  Effect.flatMap((status) => logInfo("Electron GPU feature status", { status })),
);
