import type { MessageId } from "@t3tools/contracts";
import {
  Clock3Icon,
  CornerDownRightIcon,
  LoaderCircleIcon,
  PaperclipIcon,
  XIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { queuedTurnPreview } from "./ComposerQueuePanel.logic";

interface ComposerQueuedTurn {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}

interface ComposerQueuePanelProps {
  readonly queuedTurns: ReadonlyArray<ComposerQueuedTurn>;
  readonly onCancel: (messageId: MessageId) => void;
  readonly onSteer: (messageId: MessageId) => void;
  readonly canSteer: boolean;
  readonly steeringMessageIds: ReadonlySet<MessageId>;
}

export function ComposerQueuePanel({
  queuedTurns,
  onCancel,
  onSteer,
  canSteer,
  steeringMessageIds,
}: ComposerQueuePanelProps) {
  if (queuedTurns.length === 0) {
    return null;
  }

  const queueLabel = `${queuedTurns.length} queued message${queuedTurns.length === 1 ? "" : "s"}`;

  return (
    <section
      aria-label={queueLabel}
      data-chat-composer-queue="true"
      className="relative z-0 mx-auto -mb-3 w-[calc(100%-1rem)] max-w-[47rem] overflow-hidden rounded-xl border border-border/30 bg-card/45 pb-3 shadow-sm shadow-black/5 backdrop-blur-md sm:w-[calc(100%-1.5rem)] sm:max-w-[46.5rem]"
    >
      <div className="flex h-7 items-center gap-1.5 px-2.5 text-[11px]">
        <Clock3Icon className="size-3 text-muted-foreground/70" aria-hidden="true" />
        <span className="font-medium text-foreground/75">Queue</span>
        <span className="flex min-w-4 items-center justify-center rounded-full bg-muted/45 px-1 py-0.5 font-medium text-[9px] text-muted-foreground/75 leading-none">
          {queuedTurns.length}
        </span>
        <span className="ml-auto hidden text-[10px] text-muted-foreground/55 sm:inline">
          Sends after the current turn
        </span>
      </div>

      <ol className="max-h-24 divide-y divide-border/25 overflow-y-auto border-border/25 border-t">
        {queuedTurns.map((turn, index) => {
          const preview = queuedTurnPreview(turn);
          const attachmentCount = turn.attachments.length;
          const isSteering = steeringMessageIds.has(turn.messageId);

          return (
            <li
              key={turn.messageId}
              className="group/queued-turn flex min-h-8 min-w-0 items-center gap-1.5 px-2 py-1"
            >
              <span
                className="flex size-4.5 shrink-0 items-center justify-center rounded bg-muted/40 font-medium text-[9px] text-muted-foreground/65 tabular-nums"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-foreground/65"
                title={preview}
              >
                {preview}
              </span>
              {attachmentCount > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground/55 tabular-nums">
                  <PaperclipIcon className="size-2.5" aria-hidden="true" />
                  {attachmentCount}
                </span>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={!canSteer || isSteering}
                className="shrink-0 rounded-full px-1.5 text-muted-foreground/60 hover:text-foreground/80"
                aria-label={`Steer queued message ${index + 1} after the current tool call`}
                title="Steer after the current tool call"
                onClick={() => onSteer(turn.messageId)}
              >
                {isSteering ? (
                  <LoaderCircleIcon className="size-3 animate-spin" />
                ) : (
                  <CornerDownRightIcon className="size-3" />
                )}
                <span>Steer</span>
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={isSteering}
                className="shrink-0 rounded-full text-muted-foreground/50 hover:text-foreground/80"
                aria-label={`Remove queued message ${index + 1}`}
                onClick={() => onCancel(turn.messageId)}
              >
                <XIcon className="size-3" />
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
