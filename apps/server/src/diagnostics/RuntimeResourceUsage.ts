import type {
  ProviderRuntimeResourceUsage,
  ProviderSession,
  RuntimeResourceSnapshot,
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  TerminalRuntimeResourceUsage,
  TerminalSummary,
} from "@t3tools/contracts";

import type { ProviderProcessRegistration } from "../provider/ProviderProcessRegistry.ts";

interface ProcessIndex {
  readonly byPid: ReadonlyMap<number, ServerProcessDiagnosticsEntry>;
  readonly childrenByPid: ReadonlyMap<number, ReadonlyArray<number>>;
}

function indexProcesses(processes: ReadonlyArray<ServerProcessDiagnosticsEntry>): ProcessIndex {
  const byPid = new Map<number, ServerProcessDiagnosticsEntry>();
  const childrenByPid = new Map<number, number[]>();
  for (const process of processes) {
    byPid.set(process.pid, process);
    const siblings = childrenByPid.get(process.ppid) ?? [];
    siblings.push(process.pid);
    childrenByPid.set(process.ppid, siblings);
  }
  return { byPid, childrenByPid };
}

/** Walk a process and all descendants using one host-wide index. */
export function collectRuntimeProcessIds(index: ProcessIndex, rootPid: number): number[] {
  const result: number[] = [];
  const visited = new Set<number>();
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || visited.has(pid)) continue;
    visited.add(pid);
    if (index.byPid.has(pid)) result.push(pid);
    for (const childPid of index.childrenByPid.get(pid) ?? []) pending.push(childPid);
  }
  return result;
}

interface ResourceTotals {
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
}

function claimProcessTrees(
  index: ProcessIndex,
  rootPids: ReadonlyArray<number>,
  claimedPids: Set<number>,
): ResourceTotals {
  let cpuPercent = 0;
  let rssBytes = 0;
  let processCount = 0;
  for (const rootPid of rootPids) {
    for (const pid of collectRuntimeProcessIds(index, rootPid)) {
      if (claimedPids.has(pid)) continue;
      const process = index.byPid.get(pid);
      if (process === undefined) continue;
      claimedPids.add(pid);
      cpuPercent += Math.max(0, process.cpuPercent);
      rssBytes += Math.max(0, process.rssBytes);
      processCount += 1;
    }
  }
  return { cpuPercent, rssBytes, processCount };
}

function sessionKey(session: Pick<ProviderSession, "providerInstanceId" | "threadId">): string {
  return `${session.providerInstanceId ?? ""}\u0000${session.threadId}`;
}

export function aggregateRuntimeResourceUsage(input: {
  readonly terminals: ReadonlyArray<TerminalSummary>;
  readonly providerSessions: ReadonlyArray<ProviderSession>;
  readonly providerProcesses: ReadonlyArray<ProviderProcessRegistration>;
  readonly diagnostics: ServerProcessDiagnosticsResult;
}): RuntimeResourceSnapshot {
  const index = indexProcesses(input.diagnostics.processes);
  const claimedPids = new Set<number>();
  const rootsBySession = new Map<string, number[]>();
  for (const process of input.providerProcesses) {
    const roots = rootsBySession.get(sessionKey(process)) ?? [];
    roots.push(process.pid);
    rootsBySession.set(sessionKey(process), roots);
  }

  // Provider roots are explicit ownership records. Claim them before terminal
  // trees so unusual nested/supervised layouts still attribute each PID once.
  const providers: ProviderRuntimeResourceUsage[] = input.providerSessions.map((session) => {
    const rootPids = [...new Set(rootsBySession.get(sessionKey(session)) ?? [])];
    return {
      session,
      rootPids,
      ...claimProcessTrees(index, rootPids, claimedPids),
    };
  });

  const terminals: TerminalRuntimeResourceUsage[] = input.terminals.map((terminal) => ({
    terminal,
    ...claimProcessTrees(index, terminal.pid === null ? [] : [terminal.pid], claimedPids),
  }));

  return {
    terminals,
    providers,
    totalCpuPercent: [...providers, ...terminals].reduce(
      (total, usage) => total + usage.cpuPercent,
      0,
    ),
    totalRssBytes: [...providers, ...terminals].reduce((total, usage) => total + usage.rssBytes, 0),
    processCount: claimedPids.size,
    collectedAt: input.diagnostics.readAt,
    error: input.diagnostics.error,
  };
}
