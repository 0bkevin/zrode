import { describe, expect, it } from "vite-plus/test";

import {
  buildHandoffSeedPrompt,
  buildHandoffSummaryRequestPrompt,
  buildHandoffThreadTitle,
  serializeThreadTranscript,
} from "./threadHandoff";

function message(
  role: "user" | "assistant" | "system",
  text: string,
  overrides?: {
    streaming?: boolean;
    attachments?: ReadonlyArray<{ name: string }>;
  },
) {
  return {
    role,
    text,
    streaming: overrides?.streaming ?? false,
    ...(overrides?.attachments !== undefined ? { attachments: overrides.attachments } : {}),
  };
}

describe("serializeThreadTranscript", () => {
  it("renders role-labelled markdown in message order", () => {
    const result = serializeThreadTranscript({
      title: "Thread",
      messages: [message("user", "Fix the bug"), message("assistant", "Done, see commit.")],
    });

    expect(result.text).toBe("## User\n\nFix the bug\n\n## Assistant\n\nDone, see commit.");
    expect(result.truncated).toBe(false);
    expect(result.includedCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  it("skips streaming and empty messages", () => {
    const result = serializeThreadTranscript({
      title: "Thread",
      messages: [
        message("user", "Hello"),
        message("assistant", "", { streaming: true }),
        message("assistant", "   "),
      ],
    });

    expect(result.totalCount).toBe(1);
    expect(result.text).toBe("## User\n\nHello");
  });

  it("renders attachments as placeholders", () => {
    const result = serializeThreadTranscript({
      title: "Thread",
      messages: [message("user", "See screenshot", { attachments: [{ name: "error.png" }] })],
    });

    expect(result.text).toContain("[attached image: error.png]");
  });

  it("drops oldest messages first when over budget and notes the omission", () => {
    const result = serializeThreadTranscript(
      {
        title: "Thread",
        messages: [
          message("user", "a".repeat(60)),
          message("assistant", "b".repeat(60)),
          message("user", "c".repeat(60)),
        ],
      },
      { maxChars: 160 },
    );

    expect(result.truncated).toBe(true);
    expect(result.includedCount).toBeLessThan(result.totalCount);
    expect(result.text).toContain("earlier message");
    expect(result.text).toContain("c".repeat(60));
    expect(result.text).not.toContain("a".repeat(60));
  });

  it("handles an empty thread", () => {
    const result = serializeThreadTranscript({ title: "Thread", messages: [] });

    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.includedCount).toBe(0);
    expect(result.totalCount).toBe(0);
  });

  it("truncates a single oversized message instead of returning nothing", () => {
    const result = serializeThreadTranscript(
      {
        title: "Thread",
        messages: [message("user", "x".repeat(500))],
      },
      { maxChars: 120 },
    );

    expect(result.includedCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(140);
    expect(result.text).toContain("[...truncated]");
  });
});

describe("buildHandoffSeedPrompt", () => {
  it("describes a transcript handoff", () => {
    const prompt = buildHandoffSeedPrompt({
      method: "transcript",
      sourceTitle: "Fix login bug",
      body: "## User\n\nhello",
    });

    expect(prompt).toContain('thread: "Fix login bug"');
    expect(prompt).toContain("a transcript of that conversation");
    expect(prompt).toContain("do not replay or re-execute");
    expect(prompt.endsWith("## User\n\nhello")).toBe(true);
  });

  it("describes a summary handoff", () => {
    const prompt = buildHandoffSeedPrompt({
      method: "summary",
      sourceTitle: "Fix login bug",
      body: "Goal: fix login",
    });

    expect(prompt).toContain("handoff summary written by the previous agent");
  });
});

describe("buildHandoffSummaryRequestPrompt", () => {
  it("asks for the handoff document sections without side effects", () => {
    const prompt = buildHandoffSummaryRequestPrompt();

    expect(prompt).toContain("Goal");
    expect(prompt).toContain("Open items");
    expect(prompt).toContain("Do not modify any files");
  });
});

describe("buildHandoffThreadTitle", () => {
  it("prefixes the source title", () => {
    expect(buildHandoffThreadTitle("Fix login bug")).toBe("Handoff: Fix login bug");
  });

  it("falls back when the source title is empty", () => {
    expect(buildHandoffThreadTitle("   ")).toBe("Handoff");
  });
});
