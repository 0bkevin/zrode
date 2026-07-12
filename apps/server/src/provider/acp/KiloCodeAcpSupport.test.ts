import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyKiloCodeAcpModelSelection,
  buildKiloCodeAcpSpawnInput,
  resolveKiloCodeAcpBaseModelId,
} from "./KiloCodeAcpSupport.ts";

class UnsupportedModelError extends Schema.TaggedErrorClass<UnsupportedModelError>()(
  "UnsupportedModelError",
  { requested: Schema.String },
) {}

describe("Kilo Code ACP support", () => {
  it("spawns the first-party kilo ACP command and preserves environment overrides", () => {
    expect(buildKiloCodeAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kilo",
      args: ["acp"],
      cwd: "/tmp/project",
    });
    expect(
      buildKiloCodeAcpSpawnInput({ binaryPath: "/opt/kilo" }, "/tmp/project", { TOKEN: "x" }),
    ).toEqual({
      command: "/opt/kilo",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { TOKEN: "x" },
    });
  });

  it("keeps complete provider/model slugs opaque", () => {
    expect(resolveKiloCodeAcpBaseModelId("  openrouter/anthropic/claude-sonnet-4  ")).toBe(
      "openrouter/anthropic/claude-sonnet-4",
    );
    expect(resolveKiloCodeAcpBaseModelId("   ")).toBeUndefined();
    expect(resolveKiloCodeAcpBaseModelId(undefined)).toBeUndefined();
  });

  it.effect("switches models through a standard ACP model config option", () =>
    Effect.gen(function* () {
      const calls: Array<{ id: string; value: string | boolean }> = [];
      const option = {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "openai/gpt-5",
        options: [
          { value: "openai/gpt-5", name: "GPT-5" },
          { value: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
        ],
      } satisfies EffectAcpSchema.SessionConfigOption;

      const selected = yield* applyKiloCodeAcpModelSelection({
        runtime: {
          getConfigOptions: Effect.succeed([option]),
          setConfigOption: (id, value) =>
            Effect.sync(() => {
              calls.push({ id, value });
              return {};
            }),
          setSessionModel: () => Effect.succeed({}),
        },
        requestedModelId: "openrouter/anthropic/claude-sonnet-4",
        mapError: ({ cause }) => cause,
        unsupportedModelError: (requested) => new UnsupportedModelError({ requested }),
      });

      expect(calls).toEqual([{ id: "model", value: "openrouter/anthropic/claude-sonnet-4" }]);
      expect(selected).toBe("openrouter/anthropic/claude-sonnet-4");
    }),
  );

  it.effect(
    "rejects unadvertised model identifiers instead of silently keeping the current model",
    () =>
      Effect.gen(function* () {
        const error = yield* applyKiloCodeAcpModelSelection({
          runtime: {
            getConfigOptions: Effect.succeed([]),
            setConfigOption: () => Effect.succeed({}),
            setSessionModel: () => Effect.succeed({}),
          },
          currentModelId: "openai/gpt-5",
          availableModels: [],
          requestedModelId: "default",
          mapError: ({ cause }) => cause,
          unsupportedModelError: (requested) => new UnsupportedModelError({ requested }),
        }).pipe(Effect.flip);

        expect(error._tag).toBe("UnsupportedModelError");
        if (error._tag === "UnsupportedModelError") {
          expect(error.requested).toBe("default");
        }
      }),
  );
});
