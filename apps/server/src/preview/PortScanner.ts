/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format), then enriches the listeners with each
 * process's working directory (`lsof -a -p <pids> -d cwd -F pn`) and command
 * line, CPU, and memory usage (`ps -p <pids> -o pid= -o %cpu= -o rss= -o args=`)
 * on a best-effort basis.
 *
 * Windows / lsof missing: checks a curated list of common dev ports through
 * the shared Net service.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import { ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: () => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    /** Last scan result without triggering a new scan (fresh while retained). */
    readonly current: Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

const POLL_INTERVAL = Duration.seconds(3);
const LSOF_TIMEOUT_MS = 5_000;
const WINDOWS_LISTENER_TIMEOUT_MS = 5_000;

const EMPTY_CWD_METADATA: ReadonlyMap<number, string> = new Map();
const EMPTY_PROCESS_STATS: ReadonlyMap<number, ProcessStats> = new Map();

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ScannerState {
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
  /**
   * Per-pid working-directory cache (null = probed but unresolved). A process
   * cwd rarely changes, so each pid is probed once and evicted when it stops
   * listening.
   */
  readonly cwdByProcessId: ReadonlyMap<number, string | null>;
  readonly listeners: ReadonlySet<Listener>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseLsofOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
        cwd: null,
        commandLine: null,
        cpuPercent: null,
        memoryBytes: null,
        terminal: pid === null ? null : (terminalByProcessId.get(pid) ?? null),
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
};

/** Contracts cap `cwd`/`commandLine` at 2048 characters. */
const MAX_METADATA_TEXT_LENGTH = 2048;

/** lsof appends failure notes to the name field, e.g. `/path (stat: Permission denied)`. */
const stripLsofNameSuffix = (value: string): string =>
  value.replace(/ \((?:stat|readlink)[^)]*\)$/, "");

/**
 * Parses `lsof -a -p <pids> -d cwd -F pn` output into a pid → cwd map. The
 * field format emits `p<pid>` process markers followed by `n<path>` name
 * lines (plus `f` descriptor lines we ignore).
 */
export const parseLsofCwdOutput = (raw: string): ReadonlyMap<number, string> => {
  const cwdByProcessId = new Map<number, string>();
  let pid: number | null = null;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      continue;
    }
    if (tag === "n" && pid !== null && !cwdByProcessId.has(pid)) {
      const cwd = stripLsofNameSuffix(value.trim()).slice(0, MAX_METADATA_TEXT_LENGTH).trim();
      if (cwd.length > 0) cwdByProcessId.set(pid, cwd);
    }
  }
  return cwdByProcessId;
};

export interface ProcessStats {
  readonly cpuPercent: number | null;
  readonly memoryBytes: number | null;
  readonly commandLine: string | null;
}

const MEMORY_QUANT_BYTES = 1024 * 1024;

/** Round CPU to whole percent so idle jitter doesn't defeat change detection. */
export const quantizeCpuPercent = (raw: number): number | null =>
  Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;

/** Round memory to whole MiB (min 1 MiB when nonzero) for the same reason. */
export const quantizeMemoryBytes = (rawBytes: number): number | null => {
  if (!Number.isFinite(rawBytes) || rawBytes < 0) return null;
  if (rawBytes === 0) return 0;
  return Math.max(
    MEMORY_QUANT_BYTES,
    Math.round(rawBytes / MEMORY_QUANT_BYTES) * MEMORY_QUANT_BYTES,
  );
};

/**
 * Parses `ps -p <pids> -o pid= -o %cpu= -o rss= -o args=` output into a
 * pid → stats map. `rss` is reported in kilobytes on macOS and Linux. Stats
 * are quantized so unchanged servers produce identical snapshots and the
 * scanner only broadcasts on meaningful change.
 */
export const parsePsStatsOutput = (raw: string): ReadonlyMap<number, ProcessStats> => {
  const statsByProcessId = new Map<number, ProcessStats>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
    if (match === null) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(pid) || pid <= 0 || statsByProcessId.has(pid)) continue;
    const cpuPercent = Number.parseFloat(match[2]!);
    const rssKilobytes = Number.parseInt(match[3]!, 10);
    const commandLine = (match[4] ?? "").trim().slice(0, MAX_METADATA_TEXT_LENGTH).trim();
    statsByProcessId.set(pid, {
      cpuPercent: quantizeCpuPercent(cpuPercent),
      memoryBytes:
        Number.isFinite(rssKilobytes) && rssKilobytes >= 0
          ? quantizeMemoryBytes(rssKilobytes * 1024)
          : null,
      commandLine: commandLine.length > 0 ? commandLine : null,
    });
  }
  return statsByProcessId;
};

export const applyProcessMetadata = (
  servers: ReadonlyArray<DiscoveredLocalServer>,
  cwdByProcessId: ReadonlyMap<number, string | null>,
  statsByProcessId: ReadonlyMap<number, ProcessStats>,
): ReadonlyArray<DiscoveredLocalServer> =>
  servers.map((server) => {
    if (server.pid === null) return server;
    const stats = statsByProcessId.get(server.pid);
    return {
      ...server,
      cwd: cwdByProcessId.get(server.pid) ?? null,
      commandLine: stats?.commandLine ?? null,
      cpuPercent: stats?.cpuPercent ?? null,
      memoryBytes: stats?.memoryBytes ?? null,
    };
  });

const parseWindowsListenerOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const [hostRaw, portRaw, pidRaw, processNameRaw, workingSetRaw] = line.trim().split("|", 5);
    const host = hostRaw?.trim() ?? "";
    if (!LSOF_LOCAL_HOST_TOKENS.has(host) && host !== "::") continue;
    const port = Number(portRaw);
    const pid = Number(pidRaw);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
    const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    if (seen.has(port)) continue;
    const workingSetBytes = Number(workingSetRaw);
    seen.set(port, {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      processName: processNameRaw?.trim() || null,
      pid: normalizedPid,
      cwd: null,
      commandLine: null,
      cpuPercent: null,
      memoryBytes:
        Number.isFinite(workingSetBytes) && workingSetBytes > 0
          ? quantizeMemoryBytes(workingSetBytes)
          : null,
      terminal: normalizedPid === null ? null : (terminalByProcessId.get(normalizedPid) ?? null),
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.processName !== b.processName ||
      a.pid !== b.pid ||
      a.cwd !== b.cwd ||
      a.commandLine !== b.commandLine ||
      a.cpuPercent !== b.cpuPercent ||
      a.memoryBytes !== b.memoryBytes ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId
    ) {
      return false;
    }
  }
  return true;
};

export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const stateRef = yield* Ref.make<ScannerState>({
    lastSnapshot: [],
    cwdByProcessId: new Map(),
    listeners: new Set(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: "unbounded" },
    );
    return results
      .filter((result) => result.listening)
      .map<DiscoveredLocalServer>((result) => ({
        host: "localhost",
        port: result.port,
        url: `http://localhost:${result.port}`,
        processName: null,
        pid: null,
        cwd: null,
        commandLine: null,
        cpuPercent: null,
        memoryBytes: null,
        terminal: null,
      }));
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  const logMetadataProbeFailure =
    (probe: "lsof-cwd" | "ps-stats") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process metadata probe failed; keeping servers unenriched", {
        cause: error,
        probe,
        platform: hostPlatform,
      });

  const recoverCwdProbeFailure = (error: ProcessRunner.ProcessRunError) =>
    logMetadataProbeFailure("lsof-cwd")(error).pipe(Effect.as(EMPTY_CWD_METADATA));
  const recoverStatsProbeFailure = (error: ProcessRunner.ProcessRunError) =>
    logMetadataProbeFailure("ps-stats")(error).pipe(Effect.as(EMPTY_PROCESS_STATS));

  // Best-effort second pass (macOS/Linux): resolve each listener's working
  // directory and command line / CPU / memory so the UI can attribute servers
  // to a project. Probe failures degrade to null fields, never to a failed
  // scan. Working directories are cached per pid — only new pids are probed.
  const enrichProcessMetadata = Effect.fn("PortDiscovery.enrichProcessMetadata")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const pids = [
      ...new Set(servers.flatMap((server) => (server.pid === null ? [] : [server.pid]))),
    ];
    if (pids.length === 0) return servers;
    const cachedCwd = (yield* Ref.get(stateRef)).cwdByProcessId;
    const pidsNeedingCwd = pids.filter((pid) => !cachedCwd.has(pid));
    const cwdProbe: Effect.Effect<ReadonlyMap<number, string>> =
      pidsNeedingCwd.length === 0
        ? Effect.succeed(EMPTY_CWD_METADATA)
        : processRunner
            .run({
              command: "lsof",
              args: ["-a", "-p", pidsNeedingCwd.join(","), "-d", "cwd", "-F", "pn"],
              timeout: Duration.millis(LSOF_TIMEOUT_MS),
              maxOutputBytes: 1024 * 1024,
              outputMode: "truncate",
            })
            .pipe(
              Effect.map((result) => parseLsofCwdOutput(result.stdout)),
              Effect.catchTags({
                ProcessSpawnError: recoverCwdProbeFailure,
                ProcessStdinError: recoverCwdProbeFailure,
                ProcessOutputLimitError: recoverCwdProbeFailure,
                ProcessReadError: recoverCwdProbeFailure,
                ProcessTimeoutError: recoverCwdProbeFailure,
              }),
            );
    const statsProbe: Effect.Effect<ReadonlyMap<number, ProcessStats>> = processRunner
      .run({
        command: "ps",
        args: ["-p", pids.join(","), "-o", "pid=", "-o", "%cpu=", "-o", "rss=", "-o", "args="],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => parsePsStatsOutput(result.stdout)),
        Effect.catchTags({
          ProcessSpawnError: recoverStatsProbeFailure,
          ProcessStdinError: recoverStatsProbeFailure,
          ProcessOutputLimitError: recoverStatsProbeFailure,
          ProcessReadError: recoverStatsProbeFailure,
          ProcessTimeoutError: recoverStatsProbeFailure,
        }),
      );
    const [freshCwd, statsByProcessId] = yield* Effect.all([cwdProbe, statsProbe], {
      concurrency: 2,
    });
    // Merge fresh results into the cache (unresolved probes cached as null so
    // unreadable pids aren't re-probed every tick) and evict gone pids.
    const cwdByProcessId = new Map<number, string | null>();
    for (const pid of pids) {
      cwdByProcessId.set(pid, freshCwd.get(pid) ?? cachedCwd.get(pid) ?? null);
    }
    yield* Ref.update(stateRef, (state) => ({ ...state, cwdByProcessId }));
    return applyProcessMetadata(servers, cwdByProcessId, statsByProcessId);
  });

  const scanOnce = Effect.fn("PortDiscovery.scan")(function* () {
    const state = yield* Ref.get(stateRef);
    const terminalByProcessId = new Map<number, TerminalProcessOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalByProcessId.set(processId, registration.owner);
      }
    }
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      const command =
        'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; Write-Output "$($_.LocalAddress)|$($_.LocalPort)|$($_.OwningProcess)|$($proc.ProcessName)|$($proc.WorkingSet64)" }';
      const listeners = yield* processRunner
        .run({
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", command],
          timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          maxOutputBytes: 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => parseWindowsListenerOutput(result.stdout, terminalByProcessId)),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      if (listeners !== null) return listeners;
      return yield* probeCommonPorts();
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => parseLsofOutput(result.stdout, terminalByProcessId)),
        Effect.catchTags({
          ProcessSpawnError: recoverLsofProbeFailure,
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    if (lsofResult !== null) return yield* enrichProcessMetadata(lsofResult);
    return yield* probeCommonPorts();
  });

  const broadcast = Effect.fn("PortDiscovery.broadcast")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const listeners = (yield* Ref.get(stateRef)).listeners;
    yield* Effect.forEach(listeners, (listener) => listener(servers), { discard: true });
  });

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const next = yield* scanOnce();
      const changed = yield* Ref.modify(stateRef, (state) =>
        serversEqual(state.lastSnapshot, next)
          ? [false, state]
          : [true, { ...state, lastSnapshot: next }],
      );
      if (changed) yield* broadcast(next);
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks are no-ops when no client is
  // currently retained, so the cost is one Ref.get every POLL_INTERVAL.
  yield* Effect.forkScoped(pollTick().pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait up to POLL_INTERVAL for the first emission.
      yield* pollTick();
    }
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(acquireRetention(), () =>
    Ref.update(stateRef, (state) => ({
      ...state,
      retainCount: Math.max(0, state.retainCount - 1),
    })),
  );

  const subscribe: PortDiscovery["Service"]["subscribe"] = Effect.fn("PortDiscovery.subscribe")(
    (listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => ({
          ...state,
          listeners: new Set([...state.listeners, listener]),
        })),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Set(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      yield* Ref.update(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        if (processIds.size === 0) {
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds });
        }
        return { ...state, terminalProcesses };
      });
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    yield* Ref.update(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      terminalProcesses.delete(terminalOwnerKey(input));
      return { ...state, terminalProcesses };
    });
  });

  const current: PortDiscovery["Service"]["current"] = Ref.get(stateRef).pipe(
    Effect.map((state) => state.lastSnapshot),
  );

  return PortDiscovery.of({
    scan: scanOnce,
    current,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
