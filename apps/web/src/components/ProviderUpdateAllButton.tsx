import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, DownloadIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  canOneClickUpdateProviderCandidate,
  firstFailedProviderUpdateMessage,
  type ProviderUpdateCandidate,
} from "./ProviderUpdateLaunchNotification.logic";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

type UpdateAllPhase = "idle" | "loading" | "failed" | "succeeded";

/** Always-visible bulk action for the provider update notification. */
export function ProviderUpdateAllButton({
  candidates,
  environmentId,
  onInteract,
}: {
  readonly candidates: ReadonlyArray<ProviderUpdateCandidate>;
  readonly environmentId: EnvironmentId;
  readonly onInteract?: () => void;
}) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const inFlightRef = useRef(false);
  const [phase, setPhase] = useState<UpdateAllPhase>("idle");
  const updateCandidates = useMemo(
    () =>
      candidates.filter((candidate) => canOneClickUpdateProviderCandidate(candidate, providers)),
    [candidates, providers],
  );

  const handleUpdateAll = useCallback(async () => {
    if (inFlightRef.current || updateCandidates.length === 0) {
      return;
    }
    inFlightRef.current = true;
    setPhase("loading");
    onInteract?.();
    try {
      const results = await Promise.all(
        updateCandidates.map((candidate) =>
          updateProvider({
            environmentId,
            input: {
              provider: candidate.driver,
              instanceId: candidate.instanceId,
            },
          }),
        ),
      );
      const failedMessage = firstFailedProviderUpdateMessage(results);
      if (failedMessage) {
        setPhase("failed");
      } else if (
        results.some((result) => result._tag === "Failure" && isAtomCommandInterrupted(result))
      ) {
        setPhase("idle");
      } else {
        setPhase("succeeded");
      }
    } catch {
      setPhase("failed");
    } finally {
      inFlightRef.current = false;
    }
  }, [environmentId, onInteract, updateCandidates, updateProvider]);

  const isLoading = phase === "loading";
  const isSucceeded = phase === "succeeded";

  return (
    <Button
      aria-label="Update all providers"
      className="h-6 px-2 text-[11px] shadow-none"
      disabled={isLoading || isSucceeded || updateCandidates.length === 0}
      onClick={handleUpdateAll}
      size="xs"
      variant={phase === "failed" ? "outline" : "default"}
    >
      {isLoading ? (
        <Spinner className="size-3.5" />
      ) : isSucceeded ? (
        <CheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <DownloadIcon aria-hidden="true" className="size-3.5" />
      )}
      {isLoading
        ? "Updating all…"
        : isSucceeded
          ? "All updated"
          : phase === "failed"
            ? "Retry all"
            : "Update all"}
    </Button>
  );
}
