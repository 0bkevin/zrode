import {
  DEFAULT_APPEARANCE_RADIUS_PX,
  type AppearanceColorPreset,
  type AppearanceColorTokenOverrides,
  type ClientAppearanceSettings,
} from "@t3tools/contracts/settings";

export type ResolvedTheme = "light" | "dark";
export type AppearanceColorToken = keyof AppearanceColorTokenOverrides;
export type AppearanceColorValues = Partial<Record<AppearanceColorToken, string>>;

export interface AppearanceColorTokenDefinition {
  readonly key: AppearanceColorToken;
  readonly label: string;
  readonly description: string;
}

export const APPEARANCE_COLOR_TOKEN_DEFINITIONS: readonly AppearanceColorTokenDefinition[] = [
  {
    key: "appChromeBackground",
    label: "Window",
    description: "Outer app chrome.",
  },
  {
    key: "background",
    label: "Workspace",
    description: "Main content background.",
  },
  {
    key: "foreground",
    label: "Text",
    description: "Primary text.",
  },
  {
    key: "card",
    label: "Panel",
    description: "Cards and settings panels.",
  },
  {
    key: "cardForeground",
    label: "Panel text",
    description: "Text on panels.",
  },
  {
    key: "popover",
    label: "Popover",
    description: "Menus and floating surfaces.",
  },
  {
    key: "primary",
    label: "Primary",
    description: "Primary actions and highlights.",
  },
  {
    key: "primaryForeground",
    label: "Primary text",
    description: "Text on primary actions.",
  },
  {
    key: "muted",
    label: "Muted",
    description: "Subtle row and chip backgrounds.",
  },
  {
    key: "mutedForeground",
    label: "Muted text",
    description: "Secondary labels.",
  },
  {
    key: "accent",
    label: "Accent",
    description: "Hover and selected backgrounds.",
  },
  {
    key: "accentForeground",
    label: "Accent text",
    description: "Text on accent backgrounds.",
  },
  {
    key: "border",
    label: "Border",
    description: "Dividers and outlines.",
  },
  {
    key: "input",
    label: "Input",
    description: "Input borders and filled controls.",
  },
  {
    key: "ring",
    label: "Focus ring",
    description: "Keyboard focus outline.",
  },
];

const COLOR_TOKEN_TO_CSS_VARIABLE: Record<AppearanceColorToken, string> = {
  accent: "--accent",
  accentForeground: "--accent-foreground",
  appChromeBackground: "--app-chrome-background",
  background: "--background",
  border: "--border",
  card: "--card",
  cardForeground: "--card-foreground",
  foreground: "--foreground",
  input: "--input",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  ring: "--ring",
};

export const APPEARANCE_MANAGED_CSS_VARIABLES = [
  "--radius",
  ...Object.values(COLOR_TOKEN_TO_CSS_VARIABLE),
] as const;

interface AppearancePresetDefinition {
  readonly id: AppearanceColorPreset;
  readonly label: string;
  readonly description: string;
  readonly tokens: Record<ResolvedTheme, Required<AppearanceColorValues>>;
}

export const APPEARANCE_COLOR_PRESETS = [
  {
    id: "default",
    label: "Default",
    description: "Native Zrode colors.",
    tokens: {
      light: {
        accent: "#f5f5f5",
        accentForeground: "#262626",
        appChromeBackground: "#ffffff",
        background: "#ffffff",
        border: "#e7e7e7",
        card: "#ffffff",
        cardForeground: "#262626",
        foreground: "#262626",
        input: "#dedede",
        muted: "#f5f5f5",
        mutedForeground: "#666666",
        popover: "#ffffff",
        popoverForeground: "#262626",
        primary: "#4f5feb",
        primaryForeground: "#ffffff",
        ring: "#4f5feb",
      },
      dark: {
        accent: "#1f2026",
        accentForeground: "#f4f4f5",
        appChromeBackground: "#0f1013",
        background: "#0f1013",
        border: "#282a31",
        card: "#15161a",
        cardForeground: "#f4f4f5",
        foreground: "#f4f4f5",
        input: "#2c2e36",
        muted: "#1d1f25",
        mutedForeground: "#a2a4ad",
        popover: "#17181d",
        popoverForeground: "#f4f4f5",
        primary: "#6574ff",
        primaryForeground: "#ffffff",
        ring: "#6574ff",
      },
    },
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Calm gray surfaces.",
    tokens: {
      light: {
        accent: "#e8e8e5",
        accentForeground: "#20211f",
        appChromeBackground: "#efefec",
        background: "#f7f7f4",
        border: "#d9d9d3",
        card: "#ffffff",
        cardForeground: "#20211f",
        foreground: "#20211f",
        input: "#d0d0c9",
        muted: "#ecece8",
        mutedForeground: "#65665f",
        popover: "#ffffff",
        popoverForeground: "#20211f",
        primary: "#3e5f59",
        primaryForeground: "#ffffff",
        ring: "#3e5f59",
      },
      dark: {
        accent: "#272927",
        accentForeground: "#f1f1ed",
        appChromeBackground: "#111210",
        background: "#151614",
        border: "#31332f",
        card: "#1b1c19",
        cardForeground: "#f1f1ed",
        foreground: "#f1f1ed",
        input: "#363833",
        muted: "#232522",
        mutedForeground: "#a2a49c",
        popover: "#1d1e1b",
        popoverForeground: "#f1f1ed",
        primary: "#80a49c",
        primaryForeground: "#10201d",
        ring: "#80a49c",
      },
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep blue-green contrast.",
    tokens: {
      light: {
        accent: "#dceef2",
        accentForeground: "#102f3a",
        appChromeBackground: "#e8f3f5",
        background: "#f6fbfc",
        border: "#bfd8de",
        card: "#ffffff",
        cardForeground: "#102f3a",
        foreground: "#102f3a",
        input: "#aacdd5",
        muted: "#e5f2f5",
        mutedForeground: "#4f6870",
        popover: "#ffffff",
        popoverForeground: "#102f3a",
        primary: "#0d7285",
        primaryForeground: "#ffffff",
        ring: "#0d7285",
      },
      dark: {
        accent: "#12313b",
        accentForeground: "#e8fbff",
        appChromeBackground: "#071419",
        background: "#091a20",
        border: "#1d4652",
        card: "#0d2229",
        cardForeground: "#e8fbff",
        foreground: "#e8fbff",
        input: "#28525e",
        muted: "#102932",
        mutedForeground: "#9fc1c9",
        popover: "#0e242c",
        popoverForeground: "#e8fbff",
        primary: "#35b8ce",
        primaryForeground: "#06242c",
        ring: "#35b8ce",
      },
    },
  },
  {
    id: "forest",
    label: "Forest",
    description: "Grounded green accents.",
    tokens: {
      light: {
        accent: "#e5eee2",
        accentForeground: "#172b1f",
        appChromeBackground: "#eef4eb",
        background: "#f8fbf6",
        border: "#cbdcc5",
        card: "#ffffff",
        cardForeground: "#172b1f",
        foreground: "#172b1f",
        input: "#bfd4b7",
        muted: "#ebf2e7",
        mutedForeground: "#5d6f58",
        popover: "#ffffff",
        popoverForeground: "#172b1f",
        primary: "#357a45",
        primaryForeground: "#ffffff",
        ring: "#357a45",
      },
      dark: {
        accent: "#183025",
        accentForeground: "#ecf7ef",
        appChromeBackground: "#0b1510",
        background: "#0e1b14",
        border: "#274435",
        card: "#13231a",
        cardForeground: "#ecf7ef",
        foreground: "#ecf7ef",
        input: "#305240",
        muted: "#172b20",
        mutedForeground: "#a7bea9",
        popover: "#15271d",
        popoverForeground: "#ecf7ef",
        primary: "#6fc17f",
        primaryForeground: "#082014",
        ring: "#6fc17f",
      },
    },
  },
  {
    id: "rose",
    label: "Rose",
    description: "Warm neutral surfaces.",
    tokens: {
      light: {
        accent: "#f4e7e4",
        accentForeground: "#3a2221",
        appChromeBackground: "#f8eeee",
        background: "#fff8f6",
        border: "#e5cec9",
        card: "#ffffff",
        cardForeground: "#3a2221",
        foreground: "#3a2221",
        input: "#dabeb8",
        muted: "#f7ece9",
        mutedForeground: "#7a625e",
        popover: "#ffffff",
        popoverForeground: "#3a2221",
        primary: "#b84a62",
        primaryForeground: "#ffffff",
        ring: "#b84a62",
      },
      dark: {
        accent: "#3a2026",
        accentForeground: "#fff1f1",
        appChromeBackground: "#180e11",
        background: "#211316",
        border: "#53303a",
        card: "#2a181d",
        cardForeground: "#fff1f1",
        foreground: "#fff1f1",
        input: "#633945",
        muted: "#321d23",
        mutedForeground: "#d3aeb4",
        popover: "#2d1a20",
        popoverForeground: "#fff1f1",
        primary: "#f08aa0",
        primaryForeground: "#331019",
        ring: "#f08aa0",
      },
    },
  },
] satisfies readonly AppearancePresetDefinition[];

const DEFAULT_PRESET = APPEARANCE_COLOR_PRESETS[0]!;

function findPreset(preset: AppearanceColorPreset): AppearancePresetDefinition {
  return APPEARANCE_COLOR_PRESETS.find((candidate) => candidate.id === preset) ?? DEFAULT_PRESET;
}

export function normalizeAppearanceHexColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const short = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(normalized)) {
    return normalized;
  }
  return null;
}

function parseHexColor(hexColor: string): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  const normalized = normalizeAppearanceHexColor(hexColor);
  if (!normalized) {
    return { red: 0, green: 0, blue: 0 };
  }
  return {
    red: Number.parseInt(normalized.slice(1, 3), 16),
    green: Number.parseInt(normalized.slice(3, 5), 16),
    blue: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function channelToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string): number {
  const color = parseHexColor(hexColor);
  return (
    0.2126 * channelToLinear(color.red) +
    0.7152 * channelToLinear(color.green) +
    0.0722 * channelToLinear(color.blue)
  );
}

function contrastTextForHexColor(hexColor: string): string {
  return relativeLuminance(hexColor) > 0.42 ? "#171717" : "#ffffff";
}

function withDerivedColors(
  colors: AppearanceColorValues,
  customColors: AppearanceColorTokenOverrides,
): AppearanceColorValues {
  const next = { ...colors };
  if (
    next.background &&
    (!next.foreground || (customColors.background && !customColors.foreground))
  ) {
    next.foreground = contrastTextForHexColor(next.background);
  }
  if (next.card && (!next.cardForeground || (customColors.card && !customColors.cardForeground))) {
    next.cardForeground = next.foreground ?? contrastTextForHexColor(next.card);
  }
  if (
    next.popover &&
    (!next.popoverForeground || (customColors.popover && !customColors.popoverForeground))
  ) {
    next.popoverForeground = next.foreground ?? contrastTextForHexColor(next.popover);
  }
  if (
    next.primary &&
    (!next.primaryForeground || (customColors.primary && !customColors.primaryForeground))
  ) {
    next.primaryForeground = contrastTextForHexColor(next.primary);
  }
  if (
    next.accent &&
    (!next.accentForeground || (customColors.accent && !customColors.accentForeground))
  ) {
    next.accentForeground = next.foreground ?? contrastTextForHexColor(next.accent);
  }
  if (
    next.muted &&
    (!next.mutedForeground || (customColors.muted && !customColors.mutedForeground))
  ) {
    next.mutedForeground = next.foreground ?? contrastTextForHexColor(next.muted);
  }
  if (next.primary && (!next.ring || (customColors.primary && !customColors.ring))) {
    next.ring = next.primary;
  }
  return next;
}

export function resolveAppearanceColorValues(
  appearance: ClientAppearanceSettings,
  resolvedTheme: ResolvedTheme,
  options: { readonly includeDefaultPreset?: boolean } = {},
): AppearanceColorValues {
  const preset = findPreset(appearance.colorPreset);
  const presetTokens =
    preset.id === "default" && options.includeDefaultPreset !== true
      ? {}
      : preset.tokens[resolvedTheme];
  return withDerivedColors(
    {
      ...presetTokens,
      ...appearance.customColors,
    },
    appearance.customColors,
  );
}

function formatRadius(radiusPx: number): string {
  if (radiusPx === 0) {
    return "0px";
  }
  const rem = radiusPx / 16;
  return `${Number.isInteger(rem) ? rem.toFixed(0) : rem.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}rem`;
}

export function resolveAppearanceStyleVariables(
  appearance: ClientAppearanceSettings,
  resolvedTheme: ResolvedTheme,
): Record<string, string> {
  const variables: Record<string, string> = {};
  if (appearance.radiusPx !== DEFAULT_APPEARANCE_RADIUS_PX) {
    variables["--radius"] = formatRadius(appearance.radiusPx);
  }

  const colors = resolveAppearanceColorValues(appearance, resolvedTheme);
  for (const [token, value] of Object.entries(colors) as Array<[AppearanceColorToken, string]>) {
    variables[COLOR_TOKEN_TO_CSS_VARIABLE[token]] = value;
  }
  return variables;
}

export function applyClientAppearance(
  appearance: ClientAppearanceSettings,
  resolvedTheme: ResolvedTheme,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const variable of APPEARANCE_MANAGED_CSS_VARIABLES) {
    root.style.removeProperty(variable);
  }
  const variables = resolveAppearanceStyleVariables(appearance, resolvedTheme);
  for (const [variable, value] of Object.entries(variables)) {
    root.style.setProperty(variable, value);
  }
}
