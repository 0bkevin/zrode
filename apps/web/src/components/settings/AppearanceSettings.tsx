import { CheckIcon, PaintbrushIcon, SunMoonIcon } from "lucide-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_APPEARANCE_RADIUS_PX,
  MIN_APPEARANCE_RADIUS_PX,
  type AppearanceColorPreset,
  type ClientAppearanceSettings,
} from "@t3tools/contracts/settings";
import { useCallback, useMemo } from "react";

import {
  APPEARANCE_COLOR_PRESETS,
  APPEARANCE_COLOR_TOKEN_DEFINITIONS,
  normalizeAppearanceHexColor,
  resolveAppearanceColorValues,
  type AppearanceColorToken,
  type ResolvedTheme,
} from "../../appearance";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { DraftInput } from "../ui/draft-input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const RADIUS_PRESETS: ReadonlyArray<{
  readonly label: string;
  readonly value: ClientAppearanceSettings["radiusPx"];
}> = [
  { label: "Sharp", value: 0 },
  { label: "Compact", value: 6 },
  { label: "Default", value: 10 },
  { label: "Round", value: 16 },
  { label: "Soft", value: 24 },
];

function isThemeValue(value: string): value is (typeof THEME_OPTIONS)[number]["value"] {
  return value === "system" || value === "light" || value === "dark";
}

function clampRadiusPx(value: number | null): ClientAppearanceSettings["radiusPx"] {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_UNIFIED_SETTINGS.appearance.radiusPx;
  }
  return Math.min(
    MAX_APPEARANCE_RADIUS_PX,
    Math.max(MIN_APPEARANCE_RADIUS_PX, Math.round(value)),
  ) as ClientAppearanceSettings["radiusPx"];
}

function updateCustomColor(
  appearance: ClientAppearanceSettings,
  token: AppearanceColorToken,
  value: string,
): ClientAppearanceSettings {
  const normalized = normalizeAppearanceHexColor(value);
  if (!normalized) return appearance;
  return {
    ...appearance,
    customColors: {
      ...appearance.customColors,
      [token]: normalized,
    },
  };
}

function clearCustomColor(
  appearance: ClientAppearanceSettings,
  token: AppearanceColorToken,
): ClientAppearanceSettings {
  const nextCustomColors = { ...appearance.customColors };
  delete nextCustomColors[token];
  return {
    ...appearance,
    customColors: nextCustomColors,
  };
}

function ColorPresetButton({
  preset,
  selected,
  resolvedTheme,
  onSelect,
}: {
  readonly preset: (typeof APPEARANCE_COLOR_PRESETS)[number];
  readonly selected: boolean;
  readonly resolvedTheme: ResolvedTheme;
  readonly onSelect: (preset: AppearanceColorPreset) => void;
}) {
  const colors = preset.tokens[resolvedTheme];
  const swatches = [
    { key: "background", color: colors.background },
    { key: "card", color: colors.card },
    { key: "primary", color: colors.primary },
    { key: "accent", color: colors.accent },
    { key: "border", color: colors.border },
  ] as const;

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "relative min-h-25 rounded-xl border p-3 text-left outline-none transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/8 shadow-xs shadow-primary/20"
          : "border-border bg-background hover:bg-accent/40",
      )}
      onClick={() => onSelect(preset.id)}
    >
      <div
        className="mb-3 flex h-10 overflow-hidden rounded-lg border border-black/10 dark:border-white/10"
        aria-hidden
      >
        {swatches.map((swatch) => (
          <span
            key={`${preset.id}-${swatch.key}`}
            className="min-w-0 flex-1"
            style={{ backgroundColor: swatch.color }}
          />
        ))}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] font-semibold text-foreground">{preset.label}</span>
        {selected ? (
          <span className="ms-auto grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-3" />
          </span>
        ) : null}
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/80">{preset.description}</p>
    </button>
  );
}

function RadiusPresetButton({
  label,
  value,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly value: ClientAppearanceSettings["radiusPx"];
  readonly selected: boolean;
  readonly onSelect: (value: ClientAppearanceSettings["radiusPx"]) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "flex min-h-16 min-w-0 flex-col justify-between rounded-xl border p-3 text-left outline-none transition-[border-color,box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "border-primary bg-primary/8 shadow-xs shadow-primary/20"
          : "border-border bg-background hover:bg-accent/40",
      )}
      onClick={() => onSelect(value)}
    >
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <span
        className="block h-5 w-12 border border-primary/55 bg-primary/16"
        style={{ borderRadius: `${value}px` }}
        aria-hidden
      />
    </button>
  );
}

function ColorTokenRow({
  token,
  label,
  description,
  previewValue,
  customValue,
  onSetColor,
  onClearColor,
}: {
  readonly token: AppearanceColorToken;
  readonly label: string;
  readonly description: string;
  readonly previewValue: string;
  readonly customValue: string | undefined;
  readonly onSetColor: (token: AppearanceColorToken, value: string) => void;
  readonly onClearColor: (token: AppearanceColorToken) => void;
}) {
  const colorInputValue = customValue ?? previewValue;

  return (
    <SettingsRow
      title={label}
      description={description}
      resetAction={
        customValue ? (
          <SettingResetButton label={label} onClick={() => onClearColor(token)} />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <input
            type="color"
            aria-label={`${label} color`}
            className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1 shadow-xs/5 sm:h-7"
            value={colorInputValue}
            onChange={(event) => onSetColor(token, event.currentTarget.value)}
          />
          <DraftInput
            className="w-full sm:w-28"
            value={customValue ?? ""}
            onCommit={(next) => {
              if (next.trim() === "") {
                onClearColor(token);
                return;
              }
              onSetColor(token, next);
            }}
            placeholder={previewValue}
            spellCheck={false}
            aria-label={`${label} hex color`}
          />
        </div>
      }
    />
  );
}

export function AppearanceSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const appearance = settings.appearance;
  const resolvedColors = useMemo(
    () => resolveAppearanceColorValues(appearance, resolvedTheme, { includeDefaultPreset: true }),
    [appearance, resolvedTheme],
  );

  const updateAppearance = useCallback(
    (nextAppearance: ClientAppearanceSettings) => {
      updateSettings({ appearance: nextAppearance });
    },
    [updateSettings],
  );

  const handlePresetChange = useCallback(
    (colorPreset: AppearanceColorPreset) => {
      updateAppearance({ ...appearance, colorPreset });
    },
    [appearance, updateAppearance],
  );

  const handleRadiusChange = useCallback(
    (radiusPx: number | null) => {
      updateAppearance({ ...appearance, radiusPx: clampRadiusPx(radiusPx) });
    },
    [appearance, updateAppearance],
  );

  const handleTokenSet = useCallback(
    (token: AppearanceColorToken, value: string) => {
      updateAppearance(updateCustomColor(appearance, token, value));
    },
    [appearance, updateAppearance],
  );

  const handleTokenClear = useCallback(
    (token: AppearanceColorToken) => {
      updateAppearance(clearCustomColor(appearance, token));
    },
    [appearance, updateAppearance],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Appearance" icon={<PaintbrushIcon className="size-3.5" />}>
        <SettingsRow
          title="Color mode"
          description="Match the system theme or pin the app to light or dark."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="color mode" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (typeof value === "string" && isThemeValue(value)) {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Color mode">
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Palette"
          description="Pick the base color set for surfaces, text, borders, and accents."
          resetAction={
            appearance.colorPreset !== DEFAULT_UNIFIED_SETTINGS.appearance.colorPreset ? (
              <SettingResetButton
                label="palette"
                onClick={() =>
                  updateAppearance({
                    ...appearance,
                    colorPreset: DEFAULT_UNIFIED_SETTINGS.appearance.colorPreset,
                  })
                }
              />
            ) : null
          }
        >
          <div className="grid gap-2 pb-4 sm:grid-cols-2 lg:grid-cols-3">
            {APPEARANCE_COLOR_PRESETS.map((preset) => (
              <ColorPresetButton
                key={preset.id}
                preset={preset}
                selected={appearance.colorPreset === preset.id}
                resolvedTheme={resolvedTheme}
                onSelect={handlePresetChange}
              />
            ))}
          </div>
        </SettingsRow>

        <SettingsRow
          title="Corner radius"
          description="Controls rounded corners across buttons, panels, menus, and inputs."
          resetAction={
            appearance.radiusPx !== DEFAULT_UNIFIED_SETTINGS.appearance.radiusPx ? (
              <SettingResetButton
                label="corner radius"
                onClick={() =>
                  updateAppearance({
                    ...appearance,
                    radiusPx: DEFAULT_UNIFIED_SETTINGS.appearance.radiusPx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={appearance.radiusPx}
                min={MIN_APPEARANCE_RADIUS_PX}
                max={MAX_APPEARANCE_RADIUS_PX}
                step={1}
                size="sm"
                className="w-32"
                onValueChange={handleRadiusChange}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement aria-label="Decrease corner radius" />
                  <NumberFieldInput aria-label="Corner radius in pixels" inputMode="numeric" />
                  <NumberFieldIncrement aria-label="Increase corner radius" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">px</span>
            </div>
          }
        >
          <div className="grid gap-2 pb-4 sm:grid-cols-5">
            {RADIUS_PRESETS.map((preset) => (
              <RadiusPresetButton
                key={preset.label}
                label={preset.label}
                value={preset.value}
                selected={appearance.radiusPx === preset.value}
                onSelect={handleRadiusChange}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Color Tokens" icon={<SunMoonIcon className="size-3.5" />}>
        {APPEARANCE_COLOR_TOKEN_DEFINITIONS.map((definition) => {
          const previewValue = resolvedColors[definition.key] ?? "#000000";
          return (
            <ColorTokenRow
              key={definition.key}
              token={definition.key}
              label={definition.label}
              description={definition.description}
              previewValue={previewValue}
              customValue={appearance.customColors[definition.key]}
              onSetColor={handleTokenSet}
              onClearColor={handleTokenClear}
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
