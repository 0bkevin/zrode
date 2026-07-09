import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  applyDevinAcpModelSelection,
  availableDevinModelsFromSessionSetup,
  buildDevinAcpSpawnInput,
  currentDevinModelIdFromSessionSetup,
  extractDevinElicitationQuestions,
  hasDevinEnvironmentAuth,
  makeDevinElicitationResponse,
  resolveDevinAcpBaseModelId,
} from "./DevinAcpSupport.ts";

const adaptiveModelOption: EffectAcpSchema.SessionConfigOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "adaptive",
  options: [{ value: "adaptive", name: "Adaptive" }],
};

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    expect(buildDevinAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "devin",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("includes the configured binary and environment when present", () => {
    expect(
      buildDevinAcpSpawnInput({ binaryPath: "/usr/local/bin/devin" }, "/tmp/project", {
        WINDSURF_API_KEY: "secret",
      }),
    ).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: {
        WINDSURF_API_KEY: "secret",
      },
    });
  });
});

describe("hasDevinEnvironmentAuth", () => {
  it("detects non-empty WINDSURF_API_KEY credentials", () => {
    expect(hasDevinEnvironmentAuth({ WINDSURF_API_KEY: "  secret  " })).toBe(true);
    expect(hasDevinEnvironmentAuth({ WINDSURF_API_KEY: "  " })).toBe(false);
    expect(hasDevinEnvironmentAuth(undefined)).toBe(false);
  });
});

describe("resolveDevinAcpBaseModelId", () => {
  it("defaults empty model ids to adaptive", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("  adaptive  ")).toBe("adaptive");
  });
});

describe("Devin ACP session setup model helpers", () => {
  it("prefers ACP model state over config-option model state", () => {
    const setup = {
      sessionId: "session-1",
      models: {
        currentModelId: " sonnet ",
        availableModels: [
          { modelId: "sonnet", name: "Sonnet" },
          { modelId: "opus", name: "Opus" },
        ],
      },
      configOptions: [adaptiveModelOption],
    } satisfies EffectAcpSchema.NewSessionResponse;

    expect(currentDevinModelIdFromSessionSetup(setup)).toBe("sonnet");
    expect(availableDevinModelsFromSessionSetup(setup)?.map((model) => model.modelId)).toEqual([
      "sonnet",
      "opus",
    ]);
  });
});

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    failure?: EffectAcpErrors.AcpError,
  ) => {
    const configCalls: Array<{ configId: string; value: string | boolean }> = [];
    const sessionModelCalls: Array<string> = [];
    const runtime = {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.gen(function* () {
          configCalls.push({ configId, value });
          if (failure) return yield* failure;
          return {};
        }),
      setSessionModel: (modelId: string) =>
        Effect.sync(() => {
          sessionModelCalls.push(modelId);
          return {};
        }),
    };
    return { runtime, configCalls, sessionModelCalls };
  };

  it.effect("uses session/set_model when Devin advertises the requested ACP model", () =>
    Effect.gen(function* () {
      const { runtime, configCalls, sessionModelCalls } = makeRecordingRuntime([
        adaptiveModelOption,
      ]);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: undefined,
        availableModels: [{ modelId: "adaptive", name: "Adaptive" }],
        requestedModelId: "adaptive",
        mapError: ({ cause }) => cause.message,
      });
      expect(sessionModelCalls).toEqual(["adaptive"]);
      expect(configCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("sets the model when Devin advertises the requested value", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime([adaptiveModelOption]);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "adaptive",
        mapError: ({ cause }) => cause.message,
      });
      expect(configCalls).toEqual([{ configId: "model", value: "adaptive" }]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("skips selection when the model option is present but empty", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "",
          options: [],
        },
      ]);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: undefined,
        requestedModelId: "adaptive",
        mapError: ({ cause }) => cause.message,
      });
      expect(configCalls).toEqual([]);
      expect(result).toBeUndefined();
    }),
  );

  it.effect("skips selection when no model option is available", () =>
    Effect.gen(function* () {
      const { runtime, configCalls } = makeRecordingRuntime([]);
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "adaptive",
        mapError: ({ cause }) => cause.message,
      });
      expect(configCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("propagates config-option failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime([adaptiveModelOption], failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: undefined,
          requestedModelId: "adaptive",
          mapError: ({ cause }) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("Devin ACP elicitation mapping", () => {
  it("maps form elicitations to canonical user-input questions and ACP answers", () => {
    const request = {
      sessionId: "session-1",
      mode: "form",
      message: "Need deployment details",
      requestedSchema: {
        type: "object",
        title: "Deployment",
        properties: {
          environment: {
            type: "string",
            title: "Environment",
            oneOf: [
              { const: "staging", title: "Staging" },
              { const: "production", title: "Production" },
            ],
          },
          notify: {
            type: "boolean",
            title: "Notify team",
          },
        },
        required: ["environment"],
      },
    } satisfies EffectAcpSchema.ElicitationRequest;

    expect(extractDevinElicitationQuestions(request)).toEqual([
      {
        id: "environment",
        header: "Deployment",
        question: "Environment",
        options: [
          { label: "Staging", description: "staging" },
          { label: "Production", description: "production" },
        ],
      },
      {
        id: "notify",
        header: "Deployment",
        question: "Notify team",
        options: [
          { label: "Yes", description: "true" },
          { label: "No", description: "false" },
        ],
      },
    ]);

    expect(
      makeDevinElicitationResponse(request, {
        environment: "Production",
        notify: "Yes",
      }),
    ).toEqual({
      action: {
        action: "accept",
        content: {
          environment: "production",
          notify: true,
        },
      },
    });
  });
});
