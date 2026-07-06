import type {
  ProviderInstanceId,
  ResolvedKeybindingsConfig,
  ServerProvider,
  ThreadHandoffMethod,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
  type AppModelOption,
} from "../../modelSelection";
import type { SerializedThreadTranscript } from "../../threadHandoff";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { ModelPickerContent } from "./ModelPickerContent";

export type ThreadHandoffPhase = "idle" | "generating-summary" | "creating-thread";

export interface ThreadHandoffTarget {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

/**
 * Dialog opened from the "Hand off" action on the last assistant message.
 * Lets the user pick the target provider instance + model and how the
 * conversation context should be transferred (full transcript vs a summary
 * written by the outgoing model), then kicks off the fork.
 */
export function ThreadHandoffDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceThreadTitle: string;
  currentInstanceId: ProviderInstanceId | null;
  providerStatuses: ReadonlyArray<ServerProvider>;
  settings: UnifiedSettings;
  keybindings?: ResolvedKeybindingsConfig;
  transcriptPreview: SerializedThreadTranscript | null;
  phase: ThreadHandoffPhase;
  /** When set, summary mode is disabled and this explains why. */
  summaryUnavailableReason?: string | null;
  onConfirm: (input: { target: ThreadHandoffTarget; method: ThreadHandoffMethod }) => void;
  onCancelGeneration: () => void;
}) {
  const { onConfirm, onCancelGeneration, onOpenChange } = props;
  const [method, setMethod] = useState<ThreadHandoffMethod>("transcript");
  const [target, setTarget] = useState<ThreadHandoffTarget | null>(null);

  const instanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(props.providerStatuses),
          props.settings,
        ),
      ),
    [props.providerStatuses, props.settings],
  );

  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of instanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(props.settings, entry));
    }
    return out;
  }, [instanceEntries, props.settings]);

  const defaultTarget = useMemo<ThreadHandoffTarget | null>(() => {
    const candidates = instanceEntries.filter(isProviderInstancePickerReady);
    const preferred =
      candidates.find((entry) => entry.instanceId !== props.currentInstanceId) ?? candidates[0];
    if (!preferred) {
      return null;
    }
    const model =
      resolveAppModelSelectionForInstance(
        preferred.instanceId,
        props.settings,
        props.providerStatuses,
        null,
      ) ?? modelOptionsByInstance.get(preferred.instanceId)?.[0]?.slug;
    if (!model) {
      return null;
    }
    return { instanceId: preferred.instanceId, model };
  }, [
    instanceEntries,
    modelOptionsByInstance,
    props.currentInstanceId,
    props.settings,
    props.providerStatuses,
  ]);

  // Re-seed the picker selection each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setTarget(null);
      setMethod("transcript");
    }
  }, [props.open]);

  const selectedTarget = target ?? defaultTarget;
  const busy = props.phase !== "idle";
  const transcript = props.transcriptPreview;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && props.phase === "generating-summary") {
        onCancelGeneration();
      }
      if (!open && props.phase === "creating-thread") {
        return;
      }
      onOpenChange(open);
    },
    [onCancelGeneration, onOpenChange, props.phase],
  );

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Hand off thread</DialogTitle>
          <DialogDescription>
            Continue “{props.sourceThreadTitle}” in a new thread on another provider. This thread
            stays intact, so you can always come back to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm">Hand off to</span>
            <div className="h-72 overflow-hidden rounded-lg border">
              <ModelPickerContent
                activeInstanceId={
                  selectedTarget?.instanceId ??
                  props.currentInstanceId ??
                  ("" as ProviderInstanceId)
                }
                model={selectedTarget?.model ?? ""}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                {...(props.keybindings !== undefined ? { keybindings: props.keybindings } : {})}
                modelOptionsByInstance={modelOptionsByInstance}
                terminalOpen={false}
                onInstanceModelChange={(instanceId, model) => {
                  if (!busy) {
                    setTarget({ instanceId, model });
                  }
                }}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-sm">Context to transfer</span>
            <RadioGroup
              value={method}
              onValueChange={(value) => {
                if (busy) {
                  return;
                }
                if (
                  value === "transcript" ||
                  (value === "summary" && !props.summaryUnavailableReason)
                ) {
                  setMethod(value);
                }
              }}
            >
              <label className="flex cursor-pointer items-start gap-2.5">
                <Radio value="transcript" className="mt-0.5" disabled={busy} />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">Full transcript</span>
                  <span className="text-muted-foreground text-xs">
                    Sends the conversation history to the new provider.
                    {transcript && transcript.truncated
                      ? ` This thread is long — only the most recent ${transcript.includedCount} of ${transcript.totalCount} messages will be included.`
                      : ""}{" "}
                    Images are referenced by name but not re-uploaded.
                  </span>
                </span>
              </label>
              <label
                className={
                  props.summaryUnavailableReason
                    ? "flex items-start gap-2.5 opacity-60"
                    : "flex cursor-pointer items-start gap-2.5"
                }
              >
                <Radio
                  value="summary"
                  className="mt-0.5"
                  disabled={busy || Boolean(props.summaryUnavailableReason)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">Summary written by the current agent</span>
                  <span className="text-muted-foreground text-xs">
                    {props.summaryUnavailableReason ??
                      "Runs one final turn in this thread asking the current model to write a handoff document, then seeds the new thread with it."}
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>
          {busy ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              {props.phase === "generating-summary"
                ? "Generating handoff summary in the current thread…"
                : "Creating the new thread…"}
            </div>
          ) : null}
          {!busy && selectedTarget === null ? (
            <p className="text-muted-foreground text-xs">
              No provider is ready to receive this thread. Enable and sign in to another provider in
              Settings first.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={props.phase === "creating-thread"}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || selectedTarget === null}
            onClick={() => {
              if (selectedTarget !== null) {
                onConfirm({ target: selectedTarget, method });
              }
            }}
          >
            Hand off
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
