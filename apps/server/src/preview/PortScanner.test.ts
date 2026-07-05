import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "PowerShell is not installed in the test environment",
        }),
      }),
    ),
});

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(TestProcessRunner, Net.layer, Layer.succeed(HostProcessPlatform, "win32")),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt("parseLsofCwdOutput maps pids to their working directory", () =>
  Effect.sync(() => {
    const raw = ["p123", "fcwd", "n/Users/dev/app", "p456", "fcwd", "n/tmp/other", ""].join("\n");
    const parsed = PortScanner.parseLsofCwdOutput(raw);
    expect(parsed.get(123)).toBe("/Users/dev/app");
    expect(parsed.get(456)).toBe("/tmp/other");
    expect(parsed.size).toBe(2);
  }),
);

effectIt("parseLsofCwdOutput strips lsof error suffixes from the path", () =>
  Effect.sync(() => {
    const raw = ["p123", "fcwd", "n/Users/dev/app (stat: Permission denied)", ""].join("\n");
    const parsed = PortScanner.parseLsofCwdOutput(raw);
    expect(parsed.get(123)).toBe("/Users/dev/app");
  }),
);

effectIt("parsePsStatsOutput maps pids to quantized cpu, memory, and command line", () =>
  Effect.sync(() => {
    const raw = [
      "  123   2.5  204800 node server.js --port 5173",
      "456 0.0 1024 python -m http.server",
      "",
      "garbage",
    ].join("\n");
    const parsed = PortScanner.parsePsStatsOutput(raw);
    expect(parsed.get(123)).toEqual({
      cpuPercent: 3,
      memoryBytes: 204800 * 1024,
      commandLine: "node server.js --port 5173",
    });
    expect(parsed.get(456)).toEqual({
      cpuPercent: 0,
      memoryBytes: 1024 * 1024,
      commandLine: "python -m http.server",
    });
    expect(parsed.size).toBe(2);
  }),
);

effectIt("parsePsStatsOutput tolerates missing args and placeholder columns", () =>
  Effect.sync(() => {
    const raw = ["123 0.3 2048", "456 - -"].join("\n");
    const parsed = PortScanner.parsePsStatsOutput(raw);
    expect(parsed.get(123)).toEqual({
      cpuPercent: 0,
      memoryBytes: 2 * 1024 * 1024,
      commandLine: null,
    });
    expect(parsed.get(456)).toEqual({
      cpuPercent: null,
      memoryBytes: null,
      commandLine: null,
    });
  }),
);

effectIt("quantizes stats so idle jitter cannot defeat change detection", () =>
  Effect.sync(() => {
    expect(PortScanner.quantizeCpuPercent(0.2)).toBe(0);
    expect(PortScanner.quantizeCpuPercent(Number.NaN)).toBeNull();
    expect(PortScanner.quantizeCpuPercent(-1)).toBeNull();
    expect(PortScanner.quantizeMemoryBytes(0)).toBe(0);
    // Small but nonzero memory clamps up to 1 MiB instead of rounding to 0.
    expect(PortScanner.quantizeMemoryBytes(200 * 1024)).toBe(1024 * 1024);
    expect(PortScanner.quantizeMemoryBytes(1024 * 1024 + 5)).toBe(1024 * 1024);
    expect(PortScanner.quantizeMemoryBytes(-5)).toBeNull();
  }),
);

effectIt("applyProcessMetadata enriches only servers with a known pid", () =>
  Effect.sync(() => {
    const base = {
      host: "localhost",
      url: "http://localhost:5173",
      processName: "node",
      cwd: null,
      commandLine: null,
      cpuPercent: null,
      memoryBytes: null,
      terminal: null,
    };
    const enriched = PortScanner.applyProcessMetadata(
      [
        { ...base, port: 5173, pid: 123 },
        { ...base, port: 3000, pid: null },
      ],
      new Map([[123, "/Users/dev/app"]]),
      new Map([[123, { cpuPercent: 1.5, memoryBytes: 2048, commandLine: "node server.js" }]]),
    );
    expect(enriched[0]?.cwd).toBe("/Users/dev/app");
    expect(enriched[0]?.commandLine).toBe("node server.js");
    expect(enriched[0]?.cpuPercent).toBe(1.5);
    expect(enriched[0]?.memoryBytes).toBe(2048);
    expect(enriched[1]?.cwd).toBeNull();
    expect(enriched[1]?.commandLine).toBeNull();
    expect(enriched[1]?.cpuPercent).toBeNull();
    expect(enriched[1]?.memoryBytes).toBeNull();
  }),
);

effectIt("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);
