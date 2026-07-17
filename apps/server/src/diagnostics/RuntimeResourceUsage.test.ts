import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSession,
  type ServerProcessDiagnosticsEntry,
  type ServerProcessDiagnosticsResult,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { aggregateRuntimeResourceUsage } from "./RuntimeResourceUsage.ts";

const readAt = DateTime.makeUnsafe("2026-07-17T12:00:00.000Z");

function processRow(
  pid: number,
  ppid: number,
  cpuPercent: number,
  rssBytes: number,
): ServerProcessDiagnosticsEntry {
  return {
    pid,
    ppid,
    pgid: Option.none(),
    status: "S",
    cpuPercent,
    rssBytes,
    elapsed: "00:01",
    command: `process-${pid}`,
    depth: 0,
    childPids: [],
  };
}

function terminal(terminalId: string, pid: number | null): TerminalSummary {
  return {
    threadId: "thread-1",
    terminalId,
    cwd: "/tmp/project",
    worktreePath: null,
    status: pid === null ? "exited" : "running",
    pid,
    exitCode: pid === null ? 0 : null,
    exitSignal: null,
    hasRunningSubprocess: pid !== null,
    label: terminalId,
    updatedAt: "2026-07-17T12:00:00.000Z",
  };
}

const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-work");
const providerThreadId = ThreadId.make("provider-thread");
const providerSession: ProviderSession = {
  provider,
  providerInstanceId,
  threadId: providerThreadId,
  status: "running",
  runtimeMode: "full-access",
  cwd: "/tmp/project",
  model: "gpt-5",
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:00:00.000Z",
};

function diagnostics(
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>,
): ServerProcessDiagnosticsResult {
  return {
    serverPid: 1,
    readAt,
    processCount: processes.length,
    totalRssBytes: processes.reduce((total, row) => total + row.rssBytes, 0),
    totalCpuPercent: processes.reduce((total, row) => total + row.cpuPercent, 0),
    processes,
    error: Option.none(),
  };
}

describe("aggregateRuntimeResourceUsage", () => {
  it("attributes provider and terminal descendants without double-counting", () => {
    const snapshot = aggregateRuntimeResourceUsage({
      terminals: [terminal("term-1", 10), terminal("term-2", 20)],
      providerSessions: [providerSession],
      providerProcesses: [{ provider, providerInstanceId, threadId: providerThreadId, pid: 11 }],
      diagnostics: diagnostics([
        processRow(10, 1, 1, 100),
        processRow(11, 10, 2, 200),
        processRow(12, 11, 3, 300),
        processRow(20, 1, 4, 400),
      ]),
    });

    expect(snapshot.providers[0]).toMatchObject({
      rootPids: [11],
      cpuPercent: 5,
      rssBytes: 500,
      processCount: 2,
    });
    expect(snapshot.terminals[0]).toMatchObject({ cpuPercent: 1, rssBytes: 100, processCount: 1 });
    expect(snapshot.terminals[1]).toMatchObject({ cpuPercent: 4, rssBytes: 400, processCount: 1 });
    expect(snapshot).toMatchObject({ totalCpuPercent: 10, totalRssBytes: 1_000, processCount: 4 });
  });

  it("retains sessions with no local process and ignores overlapping roots", () => {
    const snapshot = aggregateRuntimeResourceUsage({
      terminals: [terminal("term-1", 10), terminal("term-2", 11), terminal("term-3", null)],
      providerSessions: [providerSession],
      providerProcesses: [],
      diagnostics: diagnostics([processRow(10, 1, 1, 100), processRow(11, 10, 2, 200)]),
    });

    expect(snapshot.providers[0]).toMatchObject({
      rootPids: [],
      cpuPercent: 0,
      rssBytes: 0,
      processCount: 0,
    });
    expect(
      snapshot.terminals.map(({ cpuPercent, rssBytes, processCount }) => ({
        cpuPercent,
        rssBytes,
        processCount,
      })),
    ).toEqual([
      { cpuPercent: 3, rssBytes: 300, processCount: 2 },
      { cpuPercent: 0, rssBytes: 0, processCount: 0 },
      { cpuPercent: 0, rssBytes: 0, processCount: 0 },
    ]);
  });
});
