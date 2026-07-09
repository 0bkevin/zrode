import type { ServerProcessDiagnosticsEntry } from "@t3tools/contracts";

const AGENT_PROCESS_COMMAND_PATTERN = /\b(codex|claude|opencode|cursor|devin(?:\s+acp)?)\b/i;

export function formatProcessType(
  process: Pick<ServerProcessDiagnosticsEntry, "command" | "depth">,
): string {
  if (process.depth > 0) return "Subprocess";
  if (AGENT_PROCESS_COMMAND_PATTERN.test(process.command)) return "Agent";
  return "Process";
}
