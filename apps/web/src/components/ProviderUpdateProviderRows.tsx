import { useAtomValue } from "@effect/atom-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useRef, useState } from "react";

import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  firstFailedProviderUpdateMessage,
  getSingleProviderUpdateProgressToastView,
  isProviderUpdateActive,
  isTerminalProviderUpdatePhase,
  type ProviderUpdateCandidate,
  type ProviderUpdateRowStatus,
  type ProviderUpdateToastView,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdateRow } from "./ProviderUpdateRow";

const PENDING_EXPIRY_MS = 6 * 60_000;

function formatVersion(value: string | null): string {
  if (!value) {
    return "Unknown version";
  }
  return value.startsWith("v") ? value : `v${value}`;
}

function idleStatus(candidate: ProviderUpdateCandidate): ProviderUpdateRowStatus {
  return {
    kind: "idle",
    text: `${formatVersion(candidate.version)} → ${formatVersion(candidate.versionAdvisory.latestVersion)}`,
  };
}

function resolveProviderRowStatus(input: {
  readonly candidate: ProviderUpdateCandidate;
  readonly liveProvider: ServerProvider | undefined;
  readonly error: string | undefined;
  readonly result: ProviderUpdateToastView | undefined;
  readonly isPending: boolean;
}): ProviderUpdateRowStatus {
  if (input.error) {
    return { kind: "failed", text: input.error };
  }
  if (input.result) {
    switch (input.result.phase) {
      case "succeeded":
        return {
          kind: "success",
          text: `Updated to ${formatVersion(input.liveProvider?.version ?? input.candidate.versionAdvisory.latestVersion)}`,
        };
      case "failed":
        return { kind: "failed", text: input.result.description };
      case "unchanged":
        return { kind: "unchanged", text: input.result.description };
      case "running":
        return { kind: "loading", text: "Updating…" };
      case "initial":
        break;
    }
  }
  if (input.isPending || (input.liveProvider && isProviderUpdateActive(input.liveProvider))) {
    return { kind: "loading", text: "Updating…" };
  }
  return idleStatus(input.candidate);
}

/** The standard update toast body: one independently actionable row per provider. */
export function ProviderUpdateProviderRows({
  candidates,
  environmentId,
  onInteract,
  onOpenSettings,
}: {
  readonly candidates: ReadonlyArray<ProviderUpdateCandidate>;
  readonly environmentId: EnvironmentId;
  readonly onInteract?: () => void;
  readonly onOpenSettings: () => void;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const inFlightProviderIdsRef = useRef<Set<ProviderInstanceId>>(new Set());
  const requestVersionRef = useRef<Map<ProviderInstanceId, number>>(new Map());
  const [pendingProviderIds, setPendingProviderIds] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(),
  );
  const [errorByProviderId, setErrorByProviderId] = useState<
    ReadonlyMap<ProviderInstanceId, string>
  >(() => new Map());
  const [resultByProviderId, setResultByProviderId] = useState<
    ReadonlyMap<ProviderInstanceId, ProviderUpdateToastView>
  >(() => new Map());

  const liveProviderById = useMemo(
    () => new Map(providers.map((provider) => [provider.instanceId, provider] as const)),
    [providers],
  );
  const visibleCandidates = useMemo(() => {
    const byDriver = new Map(candidates.map((candidate) => [candidate.driver, candidate] as const));
    for (const candidate of collectProviderUpdateCandidates(providers)) {
      if (!byDriver.has(candidate.driver)) {
        byDriver.set(candidate.driver, candidate);
      }
    }
    return [...byDriver.values()];
  }, [candidates, providers]);

  const clearPending = useCallback((instanceId: ProviderInstanceId) => {
    setPendingProviderIds((previous) => {
      if (!previous.has(instanceId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(instanceId);
      return next;
    });
  }, []);

  const handleUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      const { instanceId } = candidate;
      if (inFlightProviderIdsRef.current.has(instanceId)) {
        return;
      }
      inFlightProviderIdsRef.current.add(instanceId);
      const requestVersion = (requestVersionRef.current.get(instanceId) ?? 0) + 1;
      requestVersionRef.current.set(instanceId, requestVersion);
      const isCurrentRequest = () => requestVersionRef.current.get(instanceId) === requestVersion;
      onInteract?.();
      setPendingProviderIds((previous) => new Set(previous).add(instanceId));
      setErrorByProviderId((previous) => {
        const next = new Map(previous);
        next.delete(instanceId);
        return next;
      });
      setResultByProviderId((previous) => {
        const next = new Map(previous);
        next.delete(instanceId);
        return next;
      });

      const expiry = setTimeout(() => {
        if (!isCurrentRequest()) {
          return;
        }
        inFlightProviderIdsRef.current.delete(instanceId);
        clearPending(instanceId);
        setErrorByProviderId((previous) =>
          new Map(previous).set(instanceId, "Update timed out — try again."),
        );
      }, PENDING_EXPIRY_MS);

      try {
        const result = await updateProvider({
          environmentId,
          input: { provider: candidate.driver, instanceId },
        });
        if (!isCurrentRequest()) {
          return;
        }
        if (result._tag === "Failure" && isAtomCommandInterrupted(result)) {
          return;
        }
        const failedMessage = firstFailedProviderUpdateMessage([result]);
        if (failedMessage) {
          setErrorByProviderId((previous) => new Map(previous).set(instanceId, failedMessage));
          return;
        }
        if (result._tag === "Failure") {
          return;
        }
        const updatedProvider = result.value.providers.find(
          (provider) => provider.instanceId === instanceId,
        );
        if (!updatedProvider) {
          setErrorByProviderId((previous) =>
            new Map(previous).set(instanceId, "The provider did not report an update result."),
          );
          return;
        }
        const view = getSingleProviderUpdateProgressToastView(updatedProvider);
        if (isTerminalProviderUpdatePhase(view.phase)) {
          setResultByProviderId((previous) => new Map(previous).set(instanceId, view));
        }
      } catch (error) {
        if (isCurrentRequest()) {
          setErrorByProviderId((previous) =>
            new Map(previous).set(
              instanceId,
              error instanceof Error ? error.message : "Provider update failed.",
            ),
          );
        }
      } finally {
        clearTimeout(expiry);
        if (isCurrentRequest()) {
          clearPending(instanceId);
          inFlightProviderIdsRef.current.delete(instanceId);
        }
      }
    },
    [clearPending, environmentId, onInteract, updateProvider],
  );

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {visibleCandidates.map((candidate) => {
        const liveProvider = liveProviderById.get(candidate.instanceId);
        const canUpdate = canOneClickUpdateProviderCandidate(candidate, providers);
        const status = resolveProviderRowStatus({
          candidate,
          liveProvider,
          error: errorByProviderId.get(candidate.instanceId),
          result: resultByProviderId.get(candidate.instanceId),
          isPending: pendingProviderIds.has(candidate.instanceId),
        });
        return (
          <ProviderUpdateRow
            key={candidate.instanceId}
            label={PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}
            status={status}
            canUpdate={canUpdate}
            onUpdate={() => handleUpdate(candidate)}
            onOpenSettings={onOpenSettings}
          />
        );
      })}
    </div>
  );
}
