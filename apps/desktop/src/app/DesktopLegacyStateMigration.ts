import {
  inspectZrodeStateMigration,
  migrateZrodeState,
  recordFreshZrodeStateDecision,
  type ZrodeStateMigrationFailure,
  type ZrodeStateMigrationProgress,
} from "@t3tools/shared/zrodeStateMigration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const IMPORT_BUTTON = 0;
const START_FRESH_BUTTON = 1;
const QUIT_BUTTON = 2;

const PROGRESS_DOCUMENT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark light">
    <style>
      :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; padding: 36px; background: #171717; color: #f5f5f5; }
      h1 { margin: 0 0 14px; font-size: 21px; font-weight: 650; }
      p { margin: 0; color: #b8b8b8; font-size: 14px; line-height: 1.5; }
      .bar { height: 5px; margin-top: 28px; overflow: hidden; border-radius: 4px; background: #343434; }
      .bar::after { content: ""; display: block; width: 45%; height: 100%; border-radius: inherit;
        background: #4f7cff; animation: move 1.2s ease-in-out infinite alternate; }
      @keyframes move { from { transform: translateX(-85%); } to { transform: translateX(205%); } }
    </style>
  </head>
  <body>
    <h1>Importing your Zrode history…</h1>
    <p>Verifying and copying the existing database. Keep T3 Code closed. The original data will not be changed.</p>
    <div class="bar" aria-hidden="true"></div>
  </body>
</html>`;

export function formatMigrationBytes(bytes: number): string {
  const gibibyte = 1024 * 1024 * 1024;
  if (bytes >= gibibyte) {
    return `${(bytes / gibibyte).toFixed(1)} GiB`;
  }
  return `${Math.max(1, Math.ceil(bytes / (1024 * 1024)))} MiB`;
}

function progressTitle(progress: ZrodeStateMigrationProgress): string {
  switch (progress.phase) {
    case "preflight":
      return "Checking existing state…";
    case "backup-database":
      return "Copying database…";
    case "copy-durable-files":
      return "Copying attachments and settings…";
    case "reset-machine-identity":
      return "Separating machine identity…";
    case "validate":
      return "Verifying imported history…";
    case "cutover":
      return "Finishing import…";
  }
}

function updateProgressWindow(
  window: Electron.BrowserWindow,
  progress: ZrodeStateMigrationProgress,
): void {
  if (window.isDestroyed()) return;
  window.setTitle(progressTitle(progress));
  const ratio = progress.total > 0 ? progress.completed / progress.total : 0;
  window.setProgressBar(Math.min(1, Math.max(0, ratio)), {
    mode: progress.phase === "backup-database" && progress.total > 0 ? "normal" : "indeterminate",
  });
}

function failureDetail(error: ZrodeStateMigrationFailure): string {
  if (error._tag === "ZrodeStateMigrationBusyStateError") {
    return `${error.message}\n\nQueued turns: ${error.queuedTurnCount}\nPending approvals: ${error.pendingApprovalCount}`;
  }
  if (error._tag === "ZrodeStateMigrationInsufficientSpaceError") {
    return `${error.message}\n\nRequired: ${formatMigrationBytes(error.requiredBytes)}\nAvailable: ${formatMigrationBytes(error.availableBytes)}`;
  }
  if (error._tag === "ZrodeStateMigrationError") {
    const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return `${error.message}\n\nOperation: ${error.operation}\n${cause}`;
  }
  return error.message;
}

export class DesktopLegacyStateMigration extends Context.Service<
  DesktopLegacyStateMigration,
  {
    /**
     * Runs before any service is allowed to create the new state directory.
     * `false` means startup must stop because the user quit or migration could
     * not safely continue.
     */
    readonly run: Effect.Effect<boolean, ElectronDialog.ElectronDialogShowMessageBoxError>;
  }
>()("@t3tools/desktop/app/DesktopLegacyStateMigration") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const windows = yield* ElectronWindow.ElectronWindow;

  const input = {
    sourceBaseDir: environment.legacyBaseDir,
    destinationBaseDir: environment.baseDir,
    appVersion: environment.appVersion,
  };

  const startFresh = recordFreshZrodeStateDecision(input).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      dialog
        .showMessageBox({
          type: "error",
          title: "Zrode could not create isolated state",
          message: "Zrode did not change either application’s data.",
          detail: failureDetail(error),
          buttons: ["Quit"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        .pipe(Effect.as(false)),
    ),
  );

  const withProgressWindow = <A, E, R>(
    operation: (
      onProgress: (progress: ZrodeStateMigrationProgress) => void,
    ) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      windows
        .create({
          title: "Importing Zrode history…",
          width: 520,
          height: 240,
          resizable: false,
          minimizable: true,
          maximizable: false,
          closable: false,
          show: false,
          backgroundColor: "#171717",
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        })
        .pipe(
          Effect.flatMap((window) =>
            Effect.tryPromise(() =>
              window.loadURL(
                `data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_DOCUMENT)}`,
              ),
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  window.show();
                  window.setProgressBar(2, { mode: "indeterminate" });
                }),
              ),
              Effect.as(Option.some(window)),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<Electron.BrowserWindow>()),
        ),
      (window) =>
        operation((progress) => {
          if (Option.isSome(window)) {
            try {
              updateProgressWindow(window.value, progress);
            } catch {
              // Progress rendering is best-effort and must never abort a safe database copy.
            }
          }
        }),
      (window) =>
        Effect.sync(() => {
          if (Option.isSome(window) && !window.value.isDestroyed()) {
            window.value.setProgressBar(-1);
            window.value.destroy();
          }
        }),
    );

  const importExisting: Effect.Effect<boolean, ElectronDialog.ElectronDialogShowMessageBoxError> =
    Effect.suspend(() =>
      withProgressWindow((onProgress) =>
        migrateZrodeState({
          ...input,
          onProgress,
        }),
      ).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            dialog
              .showMessageBox({
                type: "info",
                title: "Zrode history imported",
                message: "Zrode now has its own independent state.",
                detail:
                  "Your original T3 Code data remains untouched. Future Zrode activity will be stored under ~/.zrode.",
                buttons: ["Continue"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              })
              .pipe(Effect.as(true)),
          onFailure: (error) =>
            dialog
              .showMessageBox({
                type: "error",
                title: "Zrode could not safely import the existing state",
                message: "No imported state was activated.",
                detail: `${failureDetail(error)}\n\nClose T3 Code completely before retrying. You may also start Zrode with a clean history; the original T3 Code data will remain untouched.`,
                buttons: ["Retry Import", "Start Fresh", "Quit"],
                defaultId: IMPORT_BUTTON,
                cancelId: QUIT_BUTTON,
                noLink: true,
              })
              .pipe(
                Effect.flatMap((result) => {
                  if (result.response === IMPORT_BUTTON) return importExisting;
                  if (result.response === START_FRESH_BUTTON) return startFresh;
                  return Effect.succeed(false);
                }),
              ),
        }),
      ),
    );

  const run: Effect.Effect<boolean, ElectronDialog.ElectronDialogShowMessageBoxError> =
    Effect.suspend(() => {
      if (environment.isDevelopment || !environment.isPackaged || !environment.usesDefaultBaseDir) {
        return Effect.succeed(true);
      }

      return inspectZrodeStateMigration(input).pipe(
        Effect.matchEffect({
          onSuccess: (inspection) => {
            if (inspection.status === "not-needed") {
              return Effect.succeed(true);
            }
            if (inspection.status === "destination-conflict") {
              return dialog
                .showMessageBox({
                  type: "error",
                  title: "Zrode state directory needs attention",
                  message:
                    "Zrode found unrecognized data in ~/.zrode and stopped before changing it.",
                  detail: `Move or inspect this directory, then reopen Zrode:\n${inspection.destinationBaseDir}`,
                  buttons: ["Quit"],
                  defaultId: 0,
                  cancelId: 0,
                  noLink: true,
                })
                .pipe(Effect.as(false));
            }

            const source = inspection.sourceDatabase;
            return dialog
              .showMessageBox({
                type: "question",
                title: "Separate Zrode from T3 Code",
                message: "Import your existing Zrode history into independent storage?",
                detail:
                  `Zrode and T3 Code currently share ${inspection.sourceDatabasePath}. ` +
                  "To prevent database locks and disconnects, Zrode will use ~/.zrode from now on.\n\n" +
                  `History: ${source.threadCount} threads, ${source.messageCount} messages\n` +
                  `Database: ${formatMigrationBytes(inspection.sourceDatabaseSizeBytes)}\n` +
                  `Queued turns: ${source.queuedTurnCount}; pending approvals: ${source.pendingApprovalCount}\n\n` +
                  "Close T3 Code completely before importing. The original ~/.t3 data will not be moved or deleted.",
                buttons: ["Import History", "Start Fresh", "Quit"],
                defaultId: IMPORT_BUTTON,
                cancelId: QUIT_BUTTON,
                noLink: true,
              })
              .pipe(
                Effect.flatMap((result) => {
                  if (result.response === IMPORT_BUTTON) return importExisting;
                  if (result.response === START_FRESH_BUTTON) return startFresh;
                  return Effect.succeed(false);
                }),
              );
          },
          onFailure: (error) =>
            dialog
              .showMessageBox({
                type: "error",
                title: "Zrode could not inspect the shared state",
                message: "Zrode stopped before changing any data.",
                detail: `${failureDetail(error)}\n\nYou can start fresh without modifying ~/.t3, or quit and inspect the database.`,
                buttons: ["Retry", "Start Fresh", "Quit"],
                defaultId: IMPORT_BUTTON,
                cancelId: QUIT_BUTTON,
                noLink: true,
              })
              .pipe(
                Effect.flatMap((result) => {
                  if (result.response === IMPORT_BUTTON) return run;
                  if (result.response === START_FRESH_BUTTON) return startFresh;
                  return Effect.succeed(false);
                }),
              ),
        }),
      );
    });

  return DesktopLegacyStateMigration.of({ run });
});

export const layer = Layer.effect(DesktopLegacyStateMigration, make);
