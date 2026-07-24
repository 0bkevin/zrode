import * as NodeOS from "node:os";

const workspaceRoot = process.cwd();
const beforeCutoffSeconds = Date.parse("2026-01-01T00:00:00.000Z") / 1_000;
const afterCutoffSeconds = Date.parse("2026-01-01T00:00:03.000Z") / 1_000;

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string, result: unknown): void {
  writeMessage({ id, result });
}

function respondError(id: number | string, method: string): void {
  writeMessage({
    id,
    error: {
      code: -32601,
      message: `Unhandled request: ${method}`,
    },
  });
}

function threadSummary(input: {
  readonly id: string;
  readonly cwd: string;
  readonly parentThreadId?: string;
  readonly createdAt?: number;
}) {
  return {
    id: input.id,
    sessionId: input.id,
    cliVersion: "codex-history-test",
    createdAt: input.createdAt ?? beforeCutoffSeconds,
    updatedAt: input.createdAt ?? beforeCutoffSeconds + 1,
    cwd: input.cwd,
    ephemeral: false,
    modelProvider: "openai",
    name: input.id === "codex-main" ? "Imported Codex fixture" : null,
    parentThreadId: input.parentThreadId ?? null,
    preview: input.id,
    source: input.parentThreadId ? { subAgent: "review" } : "cli",
    status: { type: "idle" },
    turns: [],
  };
}

function threadDetail(id: string) {
  const summary = threadSummary({
    id,
    cwd: workspaceRoot,
    ...(id === "codex-child" ? { parentThreadId: "codex-main" } : {}),
    ...(id === "codex-after-cutoff" ? { createdAt: afterCutoffSeconds } : {}),
  });

  return {
    ...summary,
    turns: [
      {
        id: `${id}-turn`,
        status: "completed",
        startedAt: id === "codex-after-cutoff" ? afterCutoffSeconds : beforeCutoffSeconds,
        completedAt: id === "codex-after-cutoff" ? afterCutoffSeconds : beforeCutoffSeconds + 1,
        itemsView: "full",
        items: [
          {
            id: `${id}-user`,
            type: "userMessage",
            content: [
              { type: "text", text: `User message from ${id}` },
              { type: "image", url: "https://example.invalid/image.png" },
            ],
          },
          {
            id: `${id}-assistant`,
            type: "agentMessage",
            text: `Assistant message from ${id}`,
            phase: "final_answer",
          },
          {
            id: `${id}-command`,
            type: "commandExecution",
            command: "echo hidden",
            commandActions: [],
            cwd: workspaceRoot,
            status: "completed",
          },
        ],
      },
    ],
  };
}

function handleRequest(message: Record<string, unknown>): void {
  const id = message.id;
  const method = message.method;
  if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") {
    return;
  }
  if (method === "initialize") {
    // oxlint-disable-next-line zrode/no-global-process-runtime -- Standalone mock peer process has no Effect runtime.
    const platform = NodeOS.platform();
    respond(id, {
      userAgent: "codex-history-test",
      codexHome: process.env.CODEX_HOME ?? workspaceRoot,
      platformFamily: platform === "win32" ? "windows" : "unix",
      platformOs: platform === "darwin" ? "macos" : platform,
    });
    return;
  }

  if (method === "thread/list") {
    const params = (message.params ?? {}) as {
      readonly archived?: boolean;
      readonly cursor?: string | null;
      readonly sourceKinds?: ReadonlyArray<string>;
    };
    const expectedSourceKinds = ["cli", "vscode", "exec", "appServer", "unknown"];
    if (
      params.sourceKinds?.length !== expectedSourceKinds.length ||
      expectedSourceKinds.some((kind, index) => params.sourceKinds?.[index] !== kind)
    ) {
      respondError(id, "thread/list sourceKinds");
      return;
    }
    if (params.archived === true) {
      respond(id, {
        data: [threadSummary({ id: "codex-main", cwd: workspaceRoot })],
        nextCursor: null,
      });
      return;
    }
    if (params.cursor === "page-2") {
      respond(id, {
        data: [
          threadSummary({
            id: "codex-after-cutoff",
            cwd: workspaceRoot,
            createdAt: afterCutoffSeconds,
          }),
        ],
        nextCursor: null,
      });
      return;
    }
    respond(id, {
      data: [
        threadSummary({ id: "codex-main", cwd: workspaceRoot }),
        threadSummary({
          id: "codex-child",
          cwd: workspaceRoot,
          parentThreadId: "codex-main",
        }),
        threadSummary({ id: "codex-other", cwd: `${workspaceRoot}-other` }),
      ],
      nextCursor: "page-2",
    });
    return;
  }

  if (method === "thread/read") {
    const params = (message.params ?? {}) as { readonly threadId?: string };
    respond(id, { thread: threadDetail(params.threadId ?? "missing") });
    return;
  }

  respondError(id, method);
}

let remainder = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  remainder += chunk;
  const lines = remainder.split("\n");
  remainder = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const message = JSON.parse(trimmed) as Record<string, unknown>;
    if ("method" in message) {
      handleRequest(message);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
