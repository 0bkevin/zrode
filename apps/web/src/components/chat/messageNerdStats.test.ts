import { describe, expect, it } from "vite-plus/test";
import { MessageId, ProviderDriverKind, ProviderInstanceId, TurnId } from "@t3tools/contracts";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import type { ChatMessage } from "../../types";
import { deriveAssistantNerdStatsByMessageId } from "./messageNerdStats";

const USER_ID = MessageId.make("user-1");
const ASSISTANT_ID = MessageId.make("assistant-1");
const TURN_ID = TurnId.make("turn-1");

function message(input: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    text: "",
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

function activity(
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "kind" | "payload">,
): OrchestrationThreadActivity {
  return {
    id: `event-${input.kind}` as never,
    tone: "info",
    summary: input.kind,
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}

describe("deriveAssistantNerdStatsByMessageId", () => {
  it("combines request mode, runtime model, reasoning, and normalized turn tokens", () => {
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: ASSISTANT_ID, role: "assistant", turnId: TURN_ID }),
      ],
      activities: [
        activity({
          kind: "turn.requested",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        }),
        activity({
          kind: "turn.started",
          turnId: TURN_ID,
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.5",
            effort: "xhigh",
          },
        }),
        activity({
          kind: "context-window.updated",
          turnId: TURN_ID,
          payload: {
            usedTokens: 1_234,
            lastUsedTokens: 1_234,
            lastInputTokens: 1_000,
            lastOutputTokens: 200,
            lastReasoningOutputTokens: 34,
          },
        }),
      ],
    });

    const stats = statsByMessageId.get(ASSISTANT_ID);
    expect(stats).toMatchObject({
      providerLabel: "Codex",
      modelLabel: "gpt-5.5",
      modeLabel: "Build / Full access",
      reasoningLabel: "XHIGH",
      tokenLabel: "1.2k tok",
    });
    expect(stats?.tooltipLines).toContain("Tokens burned: 1.2k");
    expect(stats?.tooltipLines).toContain("Input: 1k");
    expect(stats?.tooltipLines).toContain("Reasoning tokens: 34");
  });

  it("attaches stats only to the terminal assistant message for a turn", () => {
    const interimId = MessageId.make("assistant-interim");
    const finalId = MessageId.make("assistant-final");
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: interimId, role: "assistant", turnId: TURN_ID }),
        message({
          id: finalId,
          role: "assistant",
          turnId: TURN_ID,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
      activities: [
        activity({
          kind: "turn.requested",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
              options: [{ id: "effort", value: "high" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        }),
      ],
    });

    expect(statsByMessageId.has(interimId)).toBe(false);
    expect(statsByMessageId.get(finalId)?.modeLabel).toBe("Plan / Supervised");
    expect(statsByMessageId.get(finalId)?.reasoningLabel).toBe("HIGH");
  });

  it("falls back to raw provider usage payloads when normalized snapshots are absent", () => {
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: ASSISTANT_ID, role: "assistant", turnId: TURN_ID }),
      ],
      activities: [
        activity({
          kind: "turn.completed",
          turnId: TURN_ID,
          payload: {
            provider: ProviderDriverKind.make("claudeAgent"),
            usage: {
              input_tokens: 500,
              cache_read_input_tokens: 100,
              output_tokens: 50,
            },
          },
        }),
      ],
    });

    const stats = statsByMessageId.get(ASSISTANT_ID);
    expect(stats?.providerLabel).toBe("Claude");
    expect(stats?.tokenLabel).toBe("650 tok");
    expect(stats?.tooltipLines).toContain("Cached input: 100");
  });

  it("correlates Codex reroutes that were persisted without an activity turn id", () => {
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: ASSISTANT_ID, role: "assistant", turnId: TURN_ID }),
      ],
      activities: [
        activity({
          kind: "turn.started",
          turnId: TURN_ID,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5",
          },
        }),
        activity({
          kind: "model.rerouted",
          turnId: null,
          createdAt: "2026-01-01T00:00:01.000Z",
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            fromModel: "gpt-5",
            toModel: "gpt-5-codex",
            reason: "highRiskCyberActivity",
          },
        }),
      ],
    });

    const stats = statsByMessageId.get(ASSISTANT_ID);
    expect(stats?.modelLabel).toBe("gpt-5-codex");
    expect(stats?.tooltipLines).toContain("Rerouted: gpt-5 -> gpt-5-codex");
  });

  it("uses usedTokens instead of summing normalized token fields when lastUsedTokens is absent", () => {
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: ASSISTANT_ID, role: "assistant", turnId: TURN_ID }),
      ],
      activities: [
        activity({
          kind: "context-window.updated",
          turnId: TURN_ID,
          payload: {
            usedTokens: 1_000,
            inputTokens: 700,
            cachedInputTokens: 1_000,
            outputTokens: 200,
          },
        }),
      ],
    });

    expect(statsByMessageId.get(ASSISTANT_ID)?.tokenLabel).toBe("1k tok");
  });

  it("consumes repeated turn requests separately for retries of the same user message", () => {
    const retryAssistantId = MessageId.make("assistant-retry");
    const retryTurnId = TurnId.make("turn-retry");
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({
          id: ASSISTANT_ID,
          role: "assistant",
          turnId: TURN_ID,
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
        message({
          id: retryAssistantId,
          role: "assistant",
          turnId: retryTurnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      ],
      activities: [
        activity({
          id: "event-request-original" as never,
          kind: "turn.requested",
          sequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-original",
              options: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        }),
        activity({
          id: "event-request-retry" as never,
          kind: "turn.requested",
          sequence: 2,
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-retry",
              options: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        }),
      ],
    });

    expect(statsByMessageId.get(ASSISTANT_ID)?.modelLabel).toBe("gpt-original");
    expect(statsByMessageId.get(retryAssistantId)?.modelLabel).toBe("gpt-retry");
    expect(statsByMessageId.get(retryAssistantId)?.modeLabel).toBe("Plan / Supervised");
  });

  it("ignores older request metadata when the original assistant response is no longer visible", () => {
    const retryAssistantId = MessageId.make("assistant-retry");
    const retryTurnId = TurnId.make("turn-retry");
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({
          id: retryAssistantId,
          role: "assistant",
          turnId: retryTurnId,
          createdAt: "2026-01-01T00:00:03.000Z",
        }),
      ],
      activities: [
        activity({
          id: "event-request-original" as never,
          kind: "turn.requested",
          sequence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-original",
              options: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        }),
        activity({
          id: "event-request-retry" as never,
          kind: "turn.requested",
          sequence: 2,
          createdAt: "2026-01-01T00:00:02.000Z",
          payload: {
            messageId: USER_ID,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-retry",
              options: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
          },
        }),
      ],
    });

    expect(statsByMessageId.get(retryAssistantId)?.modelLabel).toBe("gpt-retry");
    expect(statsByMessageId.get(retryAssistantId)?.modeLabel).toBe("Plan / Supervised");
  });

  it("shows non-default provider instance ids in the provider label", () => {
    const statsByMessageId = deriveAssistantNerdStatsByMessageId({
      messages: [
        message({ id: USER_ID, role: "user" }),
        message({ id: ASSISTANT_ID, role: "assistant", turnId: TURN_ID }),
      ],
      activities: [
        activity({
          kind: "turn.started",
          turnId: TURN_ID,
          payload: {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex_personal"),
            model: "gpt-5",
          },
        }),
      ],
    });

    expect(statsByMessageId.get(ASSISTANT_ID)?.providerLabel).toBe("Codex - Codex Personal");
  });
});
