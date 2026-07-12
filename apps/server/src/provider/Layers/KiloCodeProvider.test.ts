import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { KiloCodeSettings } from "@t3tools/contracts";

import {
  buildInitialKiloCodeProviderSnapshot,
  parseKiloCodeCliVersion,
} from "./KiloCodeProvider.ts";

const decodeSettings = Schema.decodeSync(KiloCodeSettings);

describe("Kilo Code provider", () => {
  it("parses regular CLI semantic versions", () => {
    expect(parseKiloCodeCliVersion("Kilo Code CLI v1.2.3")).toBe("1.2.3");
    expect(parseKiloCodeCliVersion("kilo 0.45.0-beta.2")).toBe("0.45.0-beta.2");
  });

  it.effect("builds a disabled first-party snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiloCodeProviderSnapshot(decodeSettings({}));
      expect(snapshot.displayName).toBe("Kilo Code");
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.message).toContain("disabled");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.auth.status).toBe("unknown");
    }),
  );
});
