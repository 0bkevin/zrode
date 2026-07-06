import type { OrchestrationMessage, ThreadHandoffMethod } from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

/**
 * Character budget for the serialized transcript body. Leaves headroom under
 * the provider input cap for the handoff preamble and any outgoing prompt
 * formatting (effort prefixes etc.) added at send time.
 */
export const HANDOFF_TRANSCRIPT_MAX_CHARS = Math.min(100_000, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

export interface SerializedThreadTranscript {
  readonly text: string;
  readonly truncated: boolean;
  readonly includedCount: number;
  readonly totalCount: number;
}

interface TranscriptSourceThread {
  readonly title: string;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationMessage, "role" | "text" | "streaming"> & {
      readonly attachments?: ReadonlyArray<{ readonly name: string }> | undefined;
    }
  >;
}

const ROLE_HEADINGS = {
  user: "## User",
  assistant: "## Assistant",
  system: "## System",
} as const;

function renderMessage(message: TranscriptSourceThread["messages"][number]): string | null {
  const attachmentNotes = (message.attachments ?? []).map(
    (attachment) => `[attached image: ${attachment.name}]`,
  );
  const text = message.text.trim();
  if (text.length === 0 && attachmentNotes.length === 0) {
    return null;
  }
  const body = [text, ...attachmentNotes].filter((part) => part.length > 0).join("\n\n");
  return `${ROLE_HEADINGS[message.role]}\n\n${body}`;
}

/**
 * Serialize a thread's normalized message timeline into a markdown transcript
 * for cross-provider handoff. Tool/activity noise is intentionally excluded;
 * only settled user/assistant/system messages are carried over. When the
 * transcript exceeds `maxChars`, the oldest messages are dropped first so the
 * most recent context survives.
 */
export function serializeThreadTranscript(
  thread: TranscriptSourceThread,
  options?: { readonly maxChars?: number },
): SerializedThreadTranscript {
  const maxChars = options?.maxChars ?? HANDOFF_TRANSCRIPT_MAX_CHARS;
  const rendered = thread.messages
    .filter((message) => !message.streaming)
    .map(renderMessage)
    .filter((entry): entry is string => entry !== null);
  const totalCount = rendered.length;

  const included: string[] = [];
  let usedChars = 0;
  let slicedOversizedMessage = false;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const entry = rendered[index];
    if (entry === undefined) {
      continue;
    }
    const entryChars = entry.length + 2;
    if (included.length > 0 && usedChars + entryChars > maxChars) {
      break;
    }
    if (included.length === 0 && entryChars > maxChars) {
      const truncatedEntry = `${entry.slice(0, Math.max(0, maxChars - 16))}\n\n[...truncated]`;
      included.unshift(truncatedEntry);
      usedChars += truncatedEntry.length + 2;
      slicedOversizedMessage = true;
      break;
    }
    included.unshift(entry);
    usedChars += entryChars;
  }

  const includedCount = Math.min(included.length, totalCount);
  const truncated = includedCount < totalCount || slicedOversizedMessage;
  const omittedCount = totalCount - includedCount;
  const parts: string[] = [];
  if (omittedCount > 0) {
    parts.push(
      `> [... ${omittedCount} earlier message${omittedCount === 1 ? "" : "s"} omitted ...]`,
    );
  }
  parts.push(...included);

  return {
    text: parts.join("\n\n"),
    truncated,
    includedCount,
    totalCount,
  };
}

/**
 * Wrap the transferred context (transcript or summary) in a neutral preamble
 * so the receiving model treats it as background rather than instructions to
 * replay.
 */
export function buildHandoffSeedPrompt(input: {
  readonly method: ThreadHandoffMethod;
  readonly sourceTitle: string;
  readonly body: string;
}): string {
  const contextKind =
    input.method === "transcript"
      ? "a transcript of that conversation"
      : "a handoff summary written by the previous agent";
  return [
    `You are taking over work that was started in a previous session with a different agent (thread: "${input.sourceTitle}").`,
    `Below is ${contextKind}. Treat it as background context — do not replay or re-execute it.`,
    "Continue the work from its current state; the user's next messages take priority.",
    "",
    "---",
    "",
    input.body.trim(),
  ].join("\n");
}

/**
 * The final turn sent to the outgoing model when the user picks summary mode.
 */
export function buildHandoffSummaryRequestPrompt(): string {
  return [
    "Write a handoff document for another engineer/agent who is taking over this work. Include these sections:",
    "",
    "- **Goal** — what we are trying to accomplish overall",
    "- **Work completed** — what has been done so far",
    "- **Key decisions** — important choices made and why",
    "- **Current state** — the state of the code/work right now",
    "- **Open items** — remaining tasks and next steps",
    "- **Gotchas** — pitfalls, constraints, or context the next agent must know",
    "",
    "Output only the document as markdown. Do not modify any files or run any commands.",
  ].join("\n");
}

export function buildHandoffThreadTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  return trimmed.length > 0 ? `Handoff: ${trimmed}` : "Handoff";
}
