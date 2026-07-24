// @effect-diagnostics nodeBuiltinImport:off - This test verifies the host-home fallback.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { resolveBaseDir } from "./os-jank.ts";

describe("resolveBaseDir", () => {
  it.effect("uses Zrode-owned state by default", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBaseDir(undefined), NodePath.join(NodeOS.homedir(), ".zrode"));
      assert.equal(yield* resolveBaseDir("  "), NodePath.join(NodeOS.homedir(), ".zrode"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves an explicit base directory", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveBaseDir("/tmp/custom-zrode"), "/tmp/custom-zrode");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
