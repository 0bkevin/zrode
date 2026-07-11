import { memo, type PointerEventHandler } from "react";
import { ChevronDownIcon, ChevronLeftIcon, Clock3Icon, CornerDownRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onQueue: () => void;
  onSteer: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

function StopGenerationIcon({ className = "size-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  preserveComposerFocusOnPointerDown = false,
  onPreviousPendingQuestion,
  onInterrupt,
  onQueue,
  onSteer,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning) {
    if (hasSendableContent) {
      const messageActionDisabled = isSendBusy || isConnecting || isEnvironmentUnavailable;

      return (
        <div
          data-chat-composer-running-actions="true"
          className="flex h-8 items-center overflow-hidden rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-colors duration-150 hover:bg-destructive"
        >
          <button
            type="button"
            data-chat-composer-running-action="stop"
            className={cn(
              "flex h-full min-w-7 cursor-pointer items-center justify-center rounded-l-full py-0 pr-1 pl-2 transition-colors duration-150 hover:bg-white/10 active:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/75",
              compact && "min-w-6.5 pl-1.5",
            )}
            {...pointerFocusProps}
            onClick={onInterrupt}
            aria-label="Stop generation"
            title="Stop generation"
          >
            <StopGenerationIcon />
          </button>

          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-white/30" />

          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  data-chat-composer-running-action="message-menu"
                  className={cn(
                    "flex h-full min-w-5.5 cursor-pointer items-center justify-center rounded-r-full py-0 pr-1.5 pl-0.5 transition-colors duration-150 hover:bg-white/10 active:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/75",
                    compact && "min-w-5 pr-1 pl-0.5",
                  )}
                  {...pointerFocusProps}
                  aria-label="Choose how to send this message"
                  title="Choose how to send this message"
                />
              }
            >
              <ChevronDownIcon className="size-2.5 opacity-80" />
            </MenuTrigger>
            <MenuPopup align="end" side="top" sideOffset={8} className="w-64">
              <MenuItem
                className="items-start py-2"
                disabled={messageActionDisabled}
                onClick={onQueue}
              >
                <Clock3Icon className="mt-0.5" />
                <span className="grid min-w-0 gap-0.5">
                  <span>{isSendBusy ? "Queueing..." : "Queue message"}</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Send after the current turn finishes
                  </span>
                </span>
              </MenuItem>
              <MenuItem
                className="items-start py-2"
                disabled={messageActionDisabled}
                onClick={onSteer}
              >
                <CornerDownRightIcon className="mt-0.5" />
                <span className="grid min-w-0 gap-0.5">
                  <span>Steer current turn</span>
                  <span className="text-muted-foreground text-xs font-normal">
                    Send this as guidance right now
                  </span>
                </span>
              </MenuItem>
              <MenuItem variant="destructive" className="items-start py-2" onClick={onInterrupt}>
                <StopGenerationIcon className="mt-0.5 size-4" />
                <span className="grid min-w-0 gap-0.5">
                  <span>Stop generation</span>
                  <span className="text-current/70 text-xs font-normal">End the current turn</span>
                </span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      );
    }
    return (
      <button
        type="button"
        className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-destructive hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none sm:h-8 sm:w-8"
        {...pointerFocusProps}
        onClick={onInterrupt}
        aria-label="Stop generation"
      >
        <StopGenerationIcon />
      </button>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                aria-label="Implementation actions"
                {...pointerFocusProps}
                disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className="flex h-9 w-9 enabled:cursor-pointer items-center justify-center rounded-full bg-primary/90 text-primary-foreground shadow-xs enabled:shadow-primary/24 enabled:inset-shadow-[0_1px_--theme(--color-white/16%)] transition-all duration-150 hover:bg-primary hover:scale-105 active:inset-shadow-[0_1px_--theme(--color-black/8%)] active:shadow-none disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8"
      {...pointerFocusProps}
      disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent}
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isConnecting
            ? "Connecting"
            : isPreparingWorktree
              ? "Preparing worktree"
              : isSendBusy
                ? "Sending"
                : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <Spinner className="size-3.5" aria-hidden="true" />
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
});
