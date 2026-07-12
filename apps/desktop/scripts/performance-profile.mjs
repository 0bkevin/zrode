import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { chromium } from "playwright-core";

import { summarizeDesktopPerformanceSamples } from "../../../scripts/lib/desktop-performance.ts";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const outputDir = NodePath.resolve(
  process.env.ZRODE_PROFILE_OUTPUT_DIR ?? NodePath.join(desktopDir, "performance-results"),
);
const durationMs = Number(process.env.ZRODE_PROFILE_DURATION_MS ?? 30_000);
const sampleIntervalMs = Number(process.env.ZRODE_PROFILE_SAMPLE_INTERVAL_MS ?? 5_000);
const captureHeapSnapshot = process.argv.includes("--heap-snapshot");
const mainEntry = NodePath.join(desktopDir, "dist-electron", "main.cjs");
const cdpCommandTimeoutMs = Number(process.env.ZRODE_PROFILE_CDP_TIMEOUT_MS ?? 15_000);

if (!NodeFS.existsSync(mainEntry)) {
  throw new Error("Desktop bundle is missing. Run `vp run build:desktop` before profiling.");
}
if (!Number.isFinite(durationMs) || durationMs < 1_000) {
  throw new Error("ZRODE_PROFILE_DURATION_MS must be at least 1000.");
}
if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 250) {
  throw new Error("ZRODE_PROFILE_SAMPLE_INTERVAL_MS must be at least 250.");
}
if (!Number.isFinite(cdpCommandTimeoutMs) || cdpCommandTimeoutMs < 1_000) {
  throw new Error("ZRODE_PROFILE_CDP_TIMEOUT_MS must be at least 1000.");
}

NodeFS.mkdirSync(outputDir, { recursive: true });

async function reservePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a debug port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron DevTools endpoint did not become ready.", { cause: lastError });
}

async function waitForOutput(readOutput, marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron output did not contain ${JSON.stringify(marker)}.`);
}

async function waitForRenderer(browser, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    const renderer = pages.find((page) => {
      const url = page.url();
      return (
        url !== "about:blank" && !url.startsWith("devtools://") && !url.startsWith("chrome://")
      );
    });
    if (renderer) {
      const rendererUrl = renderer.url();
      await renderer.waitForLoadState("load", {
        timeout: Math.max(1, deadline - Date.now()),
      });
      // Electron exposes the initial about:blank target before the custom
      // protocol navigation commits. Give the committed renderer a short
      // stability window so the CDP session is not invalidated underneath the
      // first profiling command by a renderer-process swap.
      await renderer.waitForTimeout(500);
      if (!renderer.isClosed() && renderer.url() === rendererUrl) return renderer;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron renderer did not become available.");
}

async function withTimeout(promise, timeoutMs, operation) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function terminateChild(child, graceMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Electron profiler process did not terminate.")), graceMs),
    ),
  ]);
}

function metricValue(metrics, name) {
  return metrics.find((metric) => metric.name === name)?.value ?? 0;
}

const port = await reservePort();
const launchedAt = performance.now();
const electronCommand = resolveElectronLaunchCommand([
  `--remote-debugging-port=${port}`,
  mainEntry,
]);
const isolatedHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zrode-profile-"));
const childEnv = {
  ...process.env,
  ELECTRON_ENABLE_LOGGING: "1",
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  APPDATA: NodePath.join(isolatedHome, "AppData", "Roaming"),
  XDG_CONFIG_HOME: NodePath.join(isolatedHome, ".config"),
  ZRODE_HOME: NodePath.join(isolatedHome, ".t3"),
};
delete childEnv.ELECTRON_RUN_AS_NODE;
delete childEnv.VITE_DEV_SERVER_URL;
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  cwd: desktopDir,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));

let browser;
try {
  await waitForCdp(port);
  // Connecting while Electron still exposes its initial about:blank target can
  // bind Playwright to the renderer that is replaced during custom-protocol
  // navigation. Wait for Electron's did-finish-load milestone first.
  await waitForOutput(() => output, "main window renderer loaded");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitForRenderer(browser);
  const rendererReadyMs = performance.now() - launchedAt;
  const cdp = await page.context().newCDPSession(page);
  await withTimeout(cdp.send("Performance.enable"), cdpCommandTimeoutMs, "CDP Performance.enable");
  await withTimeout(
    cdp.send("HeapProfiler.enable"),
    cdpCommandTimeoutMs,
    "CDP HeapProfiler.enable",
  );
  await withTimeout(cdp.send("Profiler.enable"), cdpCommandTimeoutMs, "CDP Profiler.enable");
  await withTimeout(cdp.send("Profiler.start"), cdpCommandTimeoutMs, "CDP Profiler.start");

  const profileStartedAt = performance.now();
  const samples = [];
  while (performance.now() - profileStartedAt <= durationMs) {
    const [heap, counters, performanceMetrics] = await Promise.all([
      withTimeout(
        cdp.send("Runtime.getHeapUsage"),
        cdpCommandTimeoutMs,
        "CDP Runtime.getHeapUsage",
      ),
      withTimeout(
        cdp.send("Memory.getDOMCounters"),
        cdpCommandTimeoutMs,
        "CDP Memory.getDOMCounters",
      ),
      withTimeout(
        cdp.send("Performance.getMetrics"),
        cdpCommandTimeoutMs,
        "CDP Performance.getMetrics",
      ),
    ]);
    samples.push({
      elapsedMs: performance.now() - profileStartedAt,
      usedHeapBytes: heap.usedSize,
      totalHeapBytes: heap.totalSize,
      documentCount: counters.documents,
      nodeCount: counters.nodes,
      listenerCount: counters.jsEventListeners,
      taskDurationSeconds: metricValue(performanceMetrics.metrics, "TaskDuration"),
      scriptDurationSeconds: metricValue(performanceMetrics.metrics, "ScriptDuration"),
      layoutDurationSeconds: metricValue(performanceMetrics.metrics, "LayoutDuration"),
    });
    await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
  }

  const cpuProfile = await withTimeout(
    cdp.send("Profiler.stop"),
    cdpCommandTimeoutMs,
    "CDP Profiler.stop",
  );
  const cpuProfilePath = NodePath.join(outputDir, "renderer.cpuprofile");
  NodeFS.writeFileSync(cpuProfilePath, `${JSON.stringify(cpuProfile.profile)}\n`);

  let heapSnapshotPath = null;
  if (captureHeapSnapshot) {
    heapSnapshotPath = NodePath.join(outputDir, "renderer.heapsnapshot");
    NodeFS.writeFileSync(heapSnapshotPath, "");
    const onChunk = ({ chunk }) => NodeFS.appendFileSync(heapSnapshotPath, chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    await withTimeout(
      cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }),
      Math.max(cdpCommandTimeoutMs, 60_000),
      "CDP HeapProfiler.takeHeapSnapshot",
    );
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  }

  const report = {
    measuredAt: new Date().toISOString(),
    rendererUrl: page.url(),
    rendererReadyMs,
    durationMs,
    sampleIntervalMs,
    samples,
    summary: summarizeDesktopPerformanceSamples(samples),
    cpuProfilePath,
    heapSnapshotPath,
  };
  const reportPath = NodePath.join(outputDir, "renderer-performance.json");
  NodeFS.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Desktop renderer profile written to ${reportPath}`);
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (browser) {
    await withTimeout(browser.close(), cdpCommandTimeoutMs, "Playwright browser close").catch(
      () => undefined,
    );
  }
  try {
    await terminateChild(child);
  } finally {
    NodeFS.rmSync(isolatedHome, { recursive: true, force: true });
  }
}
