// oxlint-disable zrode/no-global-process-runtime -- Standalone cross-platform smoke benchmark.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { evaluateDesktopSmokeFailures } from "../../../scripts/lib/desktop-performance.ts";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");

console.log("\nLaunching Electron smoke test...");
const launchedAt = performance.now();

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const isolatedHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zrode-smoke-"));
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
  stdio: ["pipe", "pipe", "pipe"],
  env: childEnv,
});

let output = "";
let appReadyMs = null;
let rendererLoadedMs = null;
let timedOut = false;
let terminationRequested = false;
const requestTermination = () => {
  if (terminationRequested) return;
  terminationRequested = true;
  child.kill();
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2_000);
  forceKill.unref();
};
const captureMilestones = () => {
  if (appReadyMs === null && output.includes("app ready")) {
    appReadyMs = performance.now() - launchedAt;
  }
  if (rendererLoadedMs === null && output.includes("main window renderer loaded")) {
    rendererLoadedMs = performance.now() - launchedAt;
  }
  if (appReadyMs !== null && rendererLoadedMs !== null) requestTermination();
};
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
  captureMilestones();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
  captureMilestones();
});
child.on("error", (error) => {
  output += `\nElectron process error: ${error.stack ?? error.message}\n`;
});

const timeout = setTimeout(() => {
  timedOut = true;
  requestTermination();
}, 8_000);

child.on("close", () => {
  clearTimeout(timeout);

  const reportPath = process.env.ZRODE_STARTUP_REPORT_PATH;
  if (reportPath) {
    NodeFS.mkdirSync(NodePath.dirname(reportPath), { recursive: true });
    NodeFS.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          platform: process.platform,
          arch: process.arch,
          appReadyMs,
          rendererLoadedMs,
        },
        null,
        2,
      )}\n`,
    );
  }
  const failures = evaluateDesktopSmokeFailures({
    output,
    timedOut,
    requireMilestones: true,
    appReadyMs,
    rendererLoadedMs,
  });

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    NodeFS.rmSync(isolatedHome, { recursive: true, force: true });
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  NodeFS.rmSync(isolatedHome, { recursive: true, force: true });
  process.exit(0);
});
