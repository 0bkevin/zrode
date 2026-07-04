import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeAppearanceHexColor,
  resolveAppearanceColorValues,
  resolveAppearanceStyleVariables,
} from "./appearance";

describe("appearance settings", () => {
  it("does not inline default palette variables", () => {
    expect(resolveAppearanceStyleVariables(DEFAULT_CLIENT_SETTINGS.appearance, "dark")).toEqual({});
  });

  it("normalizes user-entered hex colors", () => {
    expect(normalizeAppearanceHexColor(" #AbC ")).toBe("#aabbcc");
    expect(normalizeAppearanceHexColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeAppearanceHexColor("red")).toBeNull();
  });

  it("applies preset and custom token variables", () => {
    const variables = resolveAppearanceStyleVariables(
      {
        ...DEFAULT_CLIENT_SETTINGS.appearance,
        colorPreset: "ocean",
        radiusPx: 16,
        customColors: {
          background: "#102030",
          primary: "#ffee99",
        },
      },
      "dark",
    );

    expect(variables).toMatchObject({
      "--background": "#102030",
      "--foreground": "#ffffff",
      "--primary": "#ffee99",
      "--primary-foreground": "#171717",
      "--radius": "1rem",
      "--ring": "#ffee99",
    });
  });

  it("returns preview values for the default preset", () => {
    const colors = resolveAppearanceColorValues(DEFAULT_CLIENT_SETTINGS.appearance, "light", {
      includeDefaultPreset: true,
    });

    expect(colors.background).toBe("#ffffff");
    expect(colors.primary).toBe("#4f5feb");
  });
});
