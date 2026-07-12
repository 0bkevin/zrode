import { assert, describe, it } from "@effect/vitest";
import * as NodeEvents from "node:events";

import type * as Electron from "electron";

import {
  attachAppDiagnostics,
  attachWebContentsDiagnostics,
  selectCrashReportsToPrune,
  type ElectronDiagnosticRecord,
} from "./DesktopElectronDiagnostics.ts";

describe("DesktopElectronDiagnostics", () => {
  it("bounds persistent crash reports by age and newest-first count", () => {
    const reports = Array.from({ length: 4 }, (_, index) => ({
      path: `/crashes/${index}.dmp`,
      modifiedAtMs: index * 1_000,
      size: 10,
    }));

    assert.deepEqual(
      selectCrashReportsToPrune(reports, 4_000, 2_500, 2).map((report) => report.path),
      ["/crashes/1.dmp", "/crashes/0.dmp"],
    );
  });

  it("records child process failures and includes GPU status for GPU crashes", () => {
    const emitter = new NodeEvents.EventEmitter();
    const records: ElectronDiagnosticRecord[] = [];
    const app = Object.assign(emitter, {
      getGPUFeatureStatus: () => ({ gpu_compositing: "enabled" }),
    });
    const cleanup = attachAppDiagnostics({
      app: app as never,
      onDiagnostic: (record) => records.push(record),
    });

    emitter.emit("child-process-gone", {}, {
      type: "GPU",
      reason: "crashed",
      exitCode: 9,
      name: "GPU Process",
    } satisfies Electron.Details);

    assert.deepEqual(records, [
      {
        level: "warning",
        message: "Electron GPU process gone",
        annotations: {
          processType: "GPU",
          reason: "crashed",
          exitCode: 9,
          processName: "GPU Process",
          gpuFeatureStatus: { gpu_compositing: "enabled" },
        },
      },
    ]);

    cleanup();
    assert.equal(emitter.listenerCount("child-process-gone"), 0);
  });

  it("tracks renderer hangs, recovery duration, exits, and removes every listener", () => {
    const emitter = new NodeEvents.EventEmitter();
    const records: ElectronDiagnosticRecord[] = [];
    let currentTime = 1_000;
    const webContents = Object.assign(emitter, { id: 42 });
    const cleanup = attachWebContentsDiagnostics({
      webContents: webContents as unknown as Electron.WebContents,
      logLabel: "main window",
      onDiagnostic: (record) => records.push(record),
      now: () => currentTime,
    });

    emitter.emit("unresponsive");
    currentTime = 1_275;
    emitter.emit("unresponsive");
    emitter.emit("responsive");
    emitter.emit("render-process-gone", {}, { reason: "oom", exitCode: 7 });

    assert.deepEqual(records, [
      {
        level: "warning",
        message: "main window renderer unresponsive",
        annotations: { webContentsId: 42 },
      },
      {
        level: "info",
        message: "main window renderer responsive",
        annotations: { webContentsId: 42, unresponsiveDurationMs: 275 },
      },
      {
        level: "warning",
        message: "main window render process gone",
        annotations: { webContentsId: 42, reason: "oom", exitCode: 7 },
      },
    ]);

    cleanup();
    cleanup();
    assert.equal(emitter.listenerCount("unresponsive"), 0);
    assert.equal(emitter.listenerCount("responsive"), 0);
    assert.equal(emitter.listenerCount("render-process-gone"), 0);
    assert.equal(emitter.listenerCount("destroyed"), 0);
  });

  it("self-cleans when WebContents is destroyed", () => {
    const emitter = Object.assign(new NodeEvents.EventEmitter(), { id: 7 });
    attachWebContentsDiagnostics({
      webContents: emitter as unknown as Electron.WebContents,
      logLabel: "pane window",
      onDiagnostic: () => undefined,
    });

    emitter.emit("destroyed");

    assert.equal(emitter.eventNames().length, 0);
  });
});
