import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { memo, startTransition, useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import {
  LARGE_STREAMING_MARKDOWN_THRESHOLD,
  resolveLargeStreamingMarkdownParts,
} from "./MessagesTimeline.logic";

interface StreamingAssistantMarkdownProps {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly isStreaming: boolean;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}

interface RenderedStreamingState {
  readonly text: string;
  readonly isStreaming: boolean;
}

function streamingPresentationInterval(textLength: number): number {
  if (textLength < 8_000) return 32;
  if (textLength <= LARGE_STREAMING_MARKDOWN_THRESHOLD) return 64;
  return 40;
}

function useCoalescedStreamingState(text: string, isStreaming: boolean): RenderedStreamingState {
  const [rendered, setRendered] = useState<RenderedStreamingState>({ text, isStreaming });
  const latestRef = useRef<RenderedStreamingState>({ text, isStreaming });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCallbackRef = useRef<number | null>(null);
  const lastCommitAtRef = useRef(Date.now());

  useEffect(() => {
    latestRef.current = { text, isStreaming };

    const cancelIdleCommit = () => {
      if (idleCallbackRef.current === null || typeof window === "undefined") return;
      window.cancelIdleCallback(idleCallbackRef.current);
      idleCallbackRef.current = null;
    };

    const commitLatest = () => {
      timerRef.current = null;
      idleCallbackRef.current = null;
      lastCommitAtRef.current = Date.now();
      const latest = latestRef.current;
      startTransition(() => {
        setRendered((current) =>
          current.text === latest.text && current.isStreaming === latest.isStreaming
            ? current
            : latest,
        );
      });
    };

    if (!isStreaming) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      cancelIdleCommit();
      if (text.length <= LARGE_STREAMING_MARKDOWN_THRESHOLD) {
        commitLatest();
      } else if (
        typeof window !== "undefined" &&
        typeof window.requestIdleCallback === "function"
      ) {
        const requiredBudgetMs = text.length > 100_000 ? 40 : 20;
        const idleWaitStartedAt = Date.now();
        const commitWhenIdle: IdleRequestCallback = (deadline) => {
          idleCallbackRef.current = null;
          if (
            deadline.didTimeout ||
            deadline.timeRemaining() >= requiredBudgetMs ||
            Date.now() - idleWaitStartedAt >= 2_000
          ) {
            commitLatest();
            return;
          }
          idleCallbackRef.current = window.requestIdleCallback(commitWhenIdle, { timeout: 2_000 });
        };
        idleCallbackRef.current = window.requestIdleCallback(commitWhenIdle, { timeout: 2_000 });
      } else {
        // Older browsers lack idle callbacks. Give current interactions and
        // sibling thread streams a chance to commit before the final parse.
        timerRef.current = setTimeout(commitLatest, 250);
      }
      return;
    }

    cancelIdleCommit();

    if (timerRef.current !== null) {
      return;
    }

    const interval = streamingPresentationInterval(text.length);
    const elapsed = Date.now() - lastCommitAtRef.current;
    timerRef.current = setTimeout(commitLatest, Math.max(0, interval - elapsed));
  }, [isStreaming, text]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      if (idleCallbackRef.current !== null && typeof window !== "undefined") {
        window.cancelIdleCallback(idleCallbackRef.current);
      }
    },
    [],
  );

  return rendered;
}

/**
 * Keeps streaming Markdown responsive as a response grows. Small responses
 * retain live Markdown formatting; large responses keep a stable formatted
 * prefix and append the live tail as plain text until the final render.
 */
export const StreamingAssistantMarkdown = memo(function StreamingAssistantMarkdown({
  text,
  cwd,
  threadRef,
  isStreaming,
  skills,
}: StreamingAssistantMarkdownProps) {
  const rendered = useCoalescedStreamingState(text, isStreaming);
  const frozenPrefixRef = useRef<string | null>(null);

  if (!rendered.isStreaming) {
    return <ChatMarkdown text={rendered.text} cwd={cwd} threadRef={threadRef} skills={skills} />;
  }

  // Completion deliberately defers the expensive full-document parse. Show
  // the authoritative final bytes in the cheap tail immediately while that
  // parse waits for an idle window.
  const streamingText = isStreaming ? rendered.text : text;

  const frozenPrefix = frozenPrefixRef.current;
  if (frozenPrefix !== null && !streamingText.startsWith(frozenPrefix)) {
    frozenPrefixRef.current = null;
  }
  if (frozenPrefixRef.current === null) {
    frozenPrefixRef.current = resolveLargeStreamingMarkdownParts(streamingText)?.prefix ?? null;
  }

  const stablePrefix = frozenPrefixRef.current;
  if (stablePrefix === null) {
    return (
      <ChatMarkdown
        text={streamingText}
        cwd={cwd}
        threadRef={threadRef}
        isStreaming
        skills={skills}
      />
    );
  }

  return (
    <div className="min-w-0" data-large-streaming-markdown="true">
      {stablePrefix.length > 0 ? (
        <ChatMarkdown
          text={stablePrefix}
          cwd={cwd}
          threadRef={threadRef}
          isStreaming
          skills={skills}
        />
      ) : null}
      <div
        className="w-full min-w-0 whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground/80"
        data-streaming-markdown-tail="true"
      >
        {streamingText.slice(stablePrefix.length)}
      </div>
    </div>
  );
});
