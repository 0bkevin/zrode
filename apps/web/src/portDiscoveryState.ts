import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  return useDiscoveredServerSnapshot(environmentId).servers;
}

export function useDiscoveredServerSnapshot(environmentId: EnvironmentId | null): {
  readonly servers: ReadonlyArray<DiscoveredLocalServer>;
  readonly scannedAt: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return useMemo(
    () => ({
      servers: query.data?.servers ?? EMPTY_PORTS,
      scannedAt: query.data?.scannedAt ?? null,
    }),
    [query.data],
  );
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId
        ? ports.filter((port) => port.terminal?.threadId === input.threadId)
        : EMPTY_PORTS,
    [input.threadId, ports],
  );
}

export function useTerminalDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.threadId && input.terminalId
        ? ports.filter(
            (port) =>
              port.terminal?.threadId === input.threadId &&
              port.terminal.terminalId === input.terminalId,
          )
        : EMPTY_PORTS,
    [input.terminalId, input.threadId, ports],
  );
}
