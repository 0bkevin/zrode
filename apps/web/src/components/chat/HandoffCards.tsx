import type { EnvironmentId, ThreadHandoffMethod, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "../../state/shell";

function handoffMethodLabel(method: ThreadHandoffMethod | null): string {
  return method === "summary" ? "summary" : "full transcript";
}

function HandoffLinkCard(props: {
  title: string;
  subtitle: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  className?: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={cn(
        "flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-border/70 bg-card px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent/30",
        props.className,
      )}
      onClick={() => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: props.environmentId,
            threadId: props.threadId,
          },
        });
      }}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
        <ArrowRightLeftIcon className="size-3.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-sm">{props.title}</span>
        <span className="truncate text-muted-foreground text-xs">{props.subtitle}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

/**
 * Rendered at the top of a thread created by a handoff, linking back to the
 * source thread the context was carried over from.
 */
export function HandoffSourceCard(props: {
  environmentId: EnvironmentId;
  sourceThreadId: ThreadId;
  sourceTitle: string | null;
  method: ThreadHandoffMethod;
}) {
  return (
    <HandoffLinkCard
      environmentId={props.environmentId}
      threadId={props.sourceThreadId}
      title={`Handed off from ${props.sourceTitle ?? "another thread"}`}
      subtitle={`Context transferred as ${handoffMethodLabel(props.method)}. The original thread is still available.`}
    />
  );
}

interface HandoffTargetPayload {
  readonly targetThreadId: ThreadId;
  readonly method: ThreadHandoffMethod | null;
}

/**
 * Best-effort decode of the `handoff.target-created` activity payload emitted
 * by the decider. Returns null when the payload doesn't carry a target id.
 */
export function parseHandoffTargetPayload(payload: unknown): HandoffTargetPayload | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as { targetThreadId?: unknown; method?: unknown };
  if (typeof record.targetThreadId !== "string" || record.targetThreadId.length === 0) {
    return null;
  }
  return {
    targetThreadId: record.targetThreadId as ThreadId,
    method: record.method === "summary" || record.method === "transcript" ? record.method : null,
  };
}

/**
 * Rendered in the source thread's timeline where a handoff happened, linking
 * to the thread that continued the work. The target may have been deleted
 * (e.g. a handoff that failed to start was cleaned up), in which case a muted
 * non-navigating card is shown instead of a dead link.
 */
export function HandoffTargetCard(props: {
  environmentId: EnvironmentId;
  targetThreadId: ThreadId;
  method: ThreadHandoffMethod | null;
}) {
  const shellState = useEnvironmentQuery(environmentShell.stateAtom(props.environmentId));
  const snapshot = shellState.data?.snapshot;
  const targetShell =
    snapshot && snapshot._tag === "Some"
      ? (snapshot.value.threads.find((thread) => thread.id === props.targetThreadId) ?? null)
      : null;

  if (snapshot && snapshot._tag === "Some" && targetShell === null) {
    return (
      <div className="flex w-full items-center gap-2.5 rounded-xl border border-border/50 border-dashed bg-card/50 px-3 py-2.5 text-left opacity-70">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
          <ArrowRightLeftIcon className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-sm">Handoff thread unavailable</span>
          <span className="truncate text-muted-foreground text-xs">
            The thread this conversation was handed off to was deleted or archived.
          </span>
        </span>
      </div>
    );
  }

  return (
    <HandoffLinkCard
      environmentId={props.environmentId}
      threadId={props.targetThreadId}
      title={targetShell ? `Handed off to ${targetShell.title}` : "Handed off to a new thread"}
      subtitle={`Context transferred as ${handoffMethodLabel(props.method)}.`}
    />
  );
}
