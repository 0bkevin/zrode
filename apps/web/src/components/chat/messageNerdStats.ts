import {
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  TurnId,
} from "@t3tools/contracts";
import type { ChatMessage } from "../../types";

const REASONING_OPTION_IDS = ["reasoningEffort", "reasoning", "effort", "variant"] as const;

export interface AssistantNerdStats {
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly modeLabel: string | null;
  readonly reasoningLabel: string | null;
  readonly tokenLabel: string | null;
  readonly tooltipLines: ReadonlyArray<string>;
}

interface RequestedTurnStats {
  readonly messageId: MessageId;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
}

interface RuntimeTurnStartedStats {
  readonly provider: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly effort: string | null;
}

interface RuntimeTurnCompletedStats {
  readonly provider: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly usage: unknown;
  readonly modelUsage: unknown;
  readonly totalCostUsd: number | null;
}

interface RuntimeModelRerouteStats {
  readonly provider: ProviderDriverKind | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly fromModel: string | null;
  readonly toModel: string | null;
  readonly reason: string | null;
}

interface TokenBreakdown {
  readonly total: number;
  readonly input: number | null;
  readonly cached: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
}

export function deriveAssistantNerdStatsByMessageId(input: {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyMap<MessageId, AssistantNerdStats> {
  const requestsByMessageId = new Map<MessageId, RequestedTurnStats[]>();
  const startedByTurnId = new Map<TurnId, RuntimeTurnStartedStats>();
  const completedByTurnId = new Map<TurnId, RuntimeTurnCompletedStats>();
  const rerouteByTurnId = new Map<TurnId, RuntimeModelRerouteStats>();
  const usageByTurnId = new Map<TurnId, TokenBreakdown>();
  let openTurnId: TurnId | null = null;

  for (const activity of [...input.activities].toSorted(compareActivitiesByOrder)) {
    const payload = asRecord(activity.payload);

    if (activity.kind === "turn.requested" && payload) {
      const messageId = asString(payload.messageId);
      if (messageId) {
        const key = MessageId.make(messageId);
        const requests = requestsByMessageId.get(key) ?? [];
        requests.push({
          messageId: MessageId.make(messageId),
          createdAt: activity.createdAt,
          modelSelection: asModelSelection(payload.modelSelection),
          runtimeMode: asRuntimeMode(payload.runtimeMode),
          interactionMode: asInteractionMode(payload.interactionMode),
        });
        requestsByMessageId.set(key, requests);
      }
      continue;
    }

    const turnId = activity.turnId ? TurnId.make(activity.turnId) : null;

    if (activity.kind === "model.rerouted" && payload) {
      const effectiveTurnId = turnId ?? openTurnId;
      if (effectiveTurnId) {
        rerouteByTurnId.set(effectiveTurnId, {
          provider: asProviderDriverKind(payload.provider),
          providerInstanceId: asProviderInstanceId(payload.providerInstanceId),
          fromModel: asString(payload.fromModel),
          toModel: asString(payload.toModel),
          reason: asString(payload.reason),
        });
      }
      continue;
    }

    if (!turnId) {
      continue;
    }

    if (activity.kind === "turn.started" && payload) {
      openTurnId = turnId;
      startedByTurnId.set(turnId, {
        provider: asProviderDriverKind(payload.provider),
        providerInstanceId: asProviderInstanceId(payload.providerInstanceId),
        model: asString(payload.model),
        effort: asString(payload.effort),
      });
      continue;
    }

    if (activity.kind === "turn.completed" && payload) {
      if (openTurnId === turnId) {
        openTurnId = null;
      }
      completedByTurnId.set(turnId, {
        provider: asProviderDriverKind(payload.provider),
        providerInstanceId: asProviderInstanceId(payload.providerInstanceId),
        usage: payload.usage,
        modelUsage: payload.modelUsage,
        totalCostUsd:
          typeof payload.totalCostUsd === "number" && Number.isFinite(payload.totalCostUsd)
            ? payload.totalCostUsd
            : null,
      });
      const usage = tokenBreakdownFromUnknown(payload.usage);
      if (usage) {
        usageByTurnId.set(turnId, usage);
      }
      continue;
    }

    if (activity.kind === "context-window.updated") {
      const usage = tokenBreakdownFromUnknown(payload);
      if (usage) {
        usageByTurnId.set(turnId, usage);
      }
    }
  }

  const requestedByTurnId = mapTurnRequests(input.messages, requestsByMessageId);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.messages);
  const result = new Map<MessageId, AssistantNerdStats>();

  for (const message of input.messages) {
    if (
      message.role !== "assistant" ||
      !message.turnId ||
      !terminalAssistantMessageIds.has(message.id)
    ) {
      continue;
    }

    const turnId = TurnId.make(message.turnId);
    const stats = buildAssistantNerdStats({
      requested: requestedByTurnId.get(turnId) ?? null,
      started: startedByTurnId.get(turnId) ?? null,
      completed: completedByTurnId.get(turnId) ?? null,
      reroute: rerouteByTurnId.get(turnId) ?? null,
      usage: usageByTurnId.get(turnId) ?? null,
    });
    if (stats) {
      result.set(message.id, stats);
    }
  }

  return result;
}

function buildAssistantNerdStats(input: {
  readonly requested: RequestedTurnStats | null;
  readonly started: RuntimeTurnStartedStats | null;
  readonly completed: RuntimeTurnCompletedStats | null;
  readonly reroute: RuntimeModelRerouteStats | null;
  readonly usage: TokenBreakdown | null;
}): AssistantNerdStats | null {
  const provider =
    input.reroute?.provider ?? input.completed?.provider ?? input.started?.provider ?? null;
  const providerInstanceId =
    input.reroute?.providerInstanceId ??
    input.completed?.providerInstanceId ??
    input.started?.providerInstanceId ??
    input.requested?.modelSelection?.instanceId ??
    null;
  const providerLabel = formatProviderLabel(provider, providerInstanceId);
  const requestedModel = input.requested?.modelSelection?.model ?? null;
  const modelLabel = input.reroute?.toModel ?? input.started?.model ?? requestedModel;
  const modeLabel = formatModeLabel(input.requested?.interactionMode, input.requested?.runtimeMode);
  const reasoningLabel = formatReasoningLabel({
    runtimeEffort: input.started?.effort ?? null,
    modelSelection: input.requested?.modelSelection ?? null,
  });
  const tokenLabel = input.usage ? `${formatTokenCount(input.usage.total)} tok` : null;

  if (!providerLabel && !modelLabel && !modeLabel && !reasoningLabel && !tokenLabel) {
    return null;
  }

  const tooltipLines: string[] = [];
  if (providerLabel) tooltipLines.push(`Provider: ${providerLabel}`);
  if (modelLabel) tooltipLines.push(`Model: ${modelLabel}`);
  if (input.reroute?.fromModel && input.reroute.toModel) {
    tooltipLines.push(`Rerouted: ${input.reroute.fromModel} -> ${input.reroute.toModel}`);
  }
  if (input.reroute?.reason) tooltipLines.push(`Reroute reason: ${input.reroute.reason}`);
  if (modeLabel) tooltipLines.push(`Mode: ${modeLabel}`);
  if (reasoningLabel) tooltipLines.push(`Reasoning: ${reasoningLabel}`);
  if (input.usage) {
    tooltipLines.push(`Tokens burned: ${formatTokenCount(input.usage.total)}`);
    if (input.usage.input !== null) {
      tooltipLines.push(`Input: ${formatTokenCount(input.usage.input)}`);
    }
    if (input.usage.cached !== null) {
      tooltipLines.push(`Cached input: ${formatTokenCount(input.usage.cached)}`);
    }
    if (input.usage.output !== null) {
      tooltipLines.push(`Output: ${formatTokenCount(input.usage.output)}`);
    }
    if (input.usage.reasoning !== null) {
      tooltipLines.push(`Reasoning tokens: ${formatTokenCount(input.usage.reasoning)}`);
    }
  }
  if (input.completed?.totalCostUsd !== null && input.completed?.totalCostUsd !== undefined) {
    tooltipLines.push(`Cost: $${input.completed.totalCostUsd.toFixed(4)}`);
  }

  return {
    providerLabel,
    modelLabel,
    modeLabel,
    reasoningLabel,
    tokenLabel,
    tooltipLines,
  };
}

function mapTurnRequests(
  messages: ReadonlyArray<ChatMessage>,
  requestsByMessageId: ReadonlyMap<MessageId, ReadonlyArray<RequestedTurnStats>>,
): ReadonlyMap<TurnId, RequestedTurnStats> {
  const result = new Map<TurnId, RequestedTurnStats>();
  let pendingRequests: RequestedTurnStats[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      pendingRequests = [...(requestsByMessageId.get(message.id) ?? [])];
      continue;
    }
    if (message.role !== "assistant" || !message.turnId) {
      continue;
    }
    const turnId = TurnId.make(message.turnId);
    if (!result.has(turnId)) {
      const requestIndex = findRequestIndexForAssistant(pendingRequests, message.createdAt);
      const request = requestIndex >= 0 ? pendingRequests.splice(requestIndex, 1)[0] : undefined;
      if (request) {
        result.set(turnId, request);
      }
    }
  }

  return result;
}

function findRequestIndexForAssistant(
  requests: ReadonlyArray<RequestedTurnStats>,
  assistantCreatedAt: string,
): number {
  let latestEligibleIndex = -1;
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    if (request && request.createdAt.localeCompare(assistantCreatedAt) <= 0) {
      latestEligibleIndex = index;
    }
  }
  return latestEligibleIndex >= 0 ? latestEligibleIndex : requests.length > 0 ? 0 : -1;
}

function deriveTerminalAssistantMessageIds(messages: ReadonlyArray<ChatMessage>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, MessageId>();
  let nullTurnResponseIndex = 0;

  for (const message of messages) {
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

function tokenBreakdownFromUnknown(value: unknown): TokenBreakdown | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const normalized = tokenBreakdownFromThreadUsage(record);
  if (normalized) {
    return normalized;
  }
  return tokenBreakdownFromRawUsage(record);
}

function tokenBreakdownFromThreadUsage(record: Record<string, unknown>): TokenBreakdown | null {
  const usedTokens = asNonNegativeNumber(record.usedTokens);
  const lastUsedTokens = asNonNegativeNumber(record.lastUsedTokens);
  if (usedTokens === null && lastUsedTokens === null) {
    return null;
  }

  const input =
    asNonNegativeNumber(record.lastInputTokens) ?? asNonNegativeNumber(record.inputTokens);
  const cached =
    asNonNegativeNumber(record.lastCachedInputTokens) ??
    asNonNegativeNumber(record.cachedInputTokens);
  const output =
    asNonNegativeNumber(record.lastOutputTokens) ?? asNonNegativeNumber(record.outputTokens);
  const reasoning =
    asNonNegativeNumber(record.lastReasoningOutputTokens) ??
    asNonNegativeNumber(record.reasoningOutputTokens);
  const summed = sumKnown([input, cached, output, reasoning]);
  const total = lastUsedTokens ?? usedTokens ?? (summed > 0 ? summed : null);

  return total !== null && total > 0 ? { total, input, cached, output, reasoning } : null;
}

function tokenBreakdownFromRawUsage(record: Record<string, unknown>): TokenBreakdown | null {
  const directInput =
    asNonNegativeNumber(record.input_tokens) ??
    asNonNegativeNumber(record.inputTokens) ??
    asNonNegativeNumber(record.input);
  const cacheCreation = asNonNegativeNumber(record.cache_creation_input_tokens);
  const cacheRead =
    asNonNegativeNumber(record.cache_read_input_tokens) ??
    asNonNegativeNumber(record.cached_input_tokens) ??
    asNonNegativeNumber(record.cachedInputTokens);
  const cached = sumNullable([cacheCreation, cacheRead]);
  const output =
    asNonNegativeNumber(record.output_tokens) ??
    asNonNegativeNumber(record.outputTokens) ??
    asNonNegativeNumber(record.output);
  const reasoning =
    asNonNegativeNumber(record.reasoning_output_tokens) ??
    asNonNegativeNumber(record.reasoningOutputTokens) ??
    asNonNegativeNumber(record.reasoning);
  const total =
    asNonNegativeNumber(record.total_tokens) ??
    asNonNegativeNumber(record.totalTokens) ??
    asNonNegativeNumber(record.total) ??
    sumNullable([directInput, cached, output, reasoning]);

  return total !== null && total > 0
    ? { total, input: directInput, cached, output, reasoning }
    : null;
}

function formatProviderLabel(
  provider: ProviderDriverKind | null,
  providerInstanceId: ProviderInstanceId | null,
) {
  const providerLabel = provider
    ? (PROVIDER_DISPLAY_NAMES[provider] ?? formatSlugLabel(provider))
    : null;
  const providerInstanceLabel =
    providerInstanceId && String(providerInstanceId) !== String(provider)
      ? formatSlugLabel(providerInstanceId)
      : null;
  if (providerLabel && providerInstanceLabel) {
    return `${providerLabel} - ${providerInstanceLabel}`;
  }
  if (provider) {
    return providerLabel;
  }
  return providerInstanceId ? formatSlugLabel(providerInstanceId) : null;
}

function formatModeLabel(
  interactionMode: ProviderInteractionMode | null | undefined,
  runtimeMode: RuntimeMode | null | undefined,
): string | null {
  const labels = [formatInteractionMode(interactionMode), formatRuntimeMode(runtimeMode)].filter(
    (label): label is string => Boolean(label),
  );
  return labels.length > 0 ? labels.join(" / ") : null;
}

function formatInteractionMode(value: ProviderInteractionMode | null | undefined): string | null {
  switch (value) {
    case "plan":
      return "Plan";
    case "default":
      return "Build";
    default:
      return null;
  }
}

function formatRuntimeMode(value: RuntimeMode | null | undefined): string | null {
  switch (value) {
    case "approval-required":
      return "Supervised";
    case "auto-accept-edits":
      return "Auto edits";
    case "full-access":
      return "Full access";
    default:
      return null;
  }
}

function formatReasoningLabel(input: {
  readonly runtimeEffort: string | null;
  readonly modelSelection: ModelSelection | null;
}): string | null {
  const runtimeEffort = trimOrNull(input.runtimeEffort);
  const selectedEffort =
    runtimeEffort ??
    findStringOption(input.modelSelection, REASONING_OPTION_IDS) ??
    (findBooleanOption(input.modelSelection, "thinking") === true ? "thinking" : null);
  if (!selectedEffort) {
    return null;
  }

  const fastMode = findBooleanOption(input.modelSelection, "fastMode") === true;
  const label = formatOptionValue(selectedEffort);
  return fastMode ? `${label} fast` : label;
}

function findStringOption(
  modelSelection: ModelSelection | null,
  ids: ReadonlyArray<string>,
): string | null {
  const options = modelSelection?.options;
  if (!Array.isArray(options)) {
    return null;
  }
  for (const id of ids) {
    const value = options.find((option) => option.id === id)?.value;
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function findBooleanOption(modelSelection: ModelSelection | null, id: string): boolean | null {
  const options = modelSelection?.options;
  if (!Array.isArray(options)) {
    return null;
  }
  const value = options.find((option) => option.id === id)?.value;
  return typeof value === "boolean" ? value : null;
}

function formatOptionValue(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) =>
      part.length <= 4 || part.toLowerCase() === "xhigh"
        ? part.toUpperCase()
        : `${part[0]?.toUpperCase()}${part.slice(1)}`,
    )
    .join(" ");
}

function formatTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 10_000) return `${trimFixed(value / 1_000, 1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${trimFixed(value / 1_000_000, 1)}m`;
}

function trimFixed(value: number, fractionDigits: number): string {
  return value.toFixed(fractionDigits).replace(/\.0$/, "");
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? trimOrNull(value) : null;
}

function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function asModelSelection(value: unknown): ModelSelection | null {
  const record = asRecord(value);
  if (!record || typeof record.model !== "string" || typeof record.instanceId !== "string") {
    return null;
  }
  return record as ModelSelection;
}

function asRuntimeMode(value: unknown): RuntimeMode | null {
  return value === "approval-required" || value === "auto-accept-edits" || value === "full-access"
    ? value
    : null;
}

function asInteractionMode(value: unknown): ProviderInteractionMode | null {
  return value === "default" || value === "plan" ? value : null;
}

function asProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return typeof value === "string" && value.length > 0 ? ProviderDriverKind.make(value) : null;
}

function asProviderInstanceId(value: unknown): ProviderInstanceId | null {
  return typeof value === "string" && value.length > 0 ? ProviderInstanceId.make(value) : null;
}

function sumKnown(values: ReadonlyArray<number | null>): number {
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function sumNullable(values: ReadonlyArray<number | null>): number | null {
  const total = sumKnown(values);
  return values.some((value) => value !== null) ? total : null;
}

function formatSlugLabel(value: string): string {
  return value
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
