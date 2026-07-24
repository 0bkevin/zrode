import type { Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";

import type {
  ProviderUpdateCandidate,
  ProviderUpdateRowStatus,
} from "./ProviderUpdateLaunchNotification.logic";
import { ProviderUpdateAllButton } from "./ProviderUpdateAllButton";
import { ProviderUpdateRow } from "./ProviderUpdateRow";

const testState = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  updateProvider: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.providers }));
vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: Symbol("primaryServerProvidersAtom"),
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

import { ProviderUpdateProviderRows } from "./ProviderUpdateProviderRows";

const environmentId = "primary" as EnvironmentId;

function provider(driver: string, updateStatus?: "succeeded"): ServerProvider {
  const kind = ProviderDriverKind.make(driver);
  const latestVersion = "1.1.0";
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: kind,
    enabled: true,
    installed: true,
    version: updateStatus ? latestVersion : "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-18T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: updateStatus ? "current" : "behind_latest",
      currentVersion: updateStatus ? latestVersion : "1.0.0",
      latestVersion,
      updateCommand: `update ${driver}`,
      canUpdate: true,
      checkedAt: "2026-07-18T12:00:00.000Z",
      message: updateStatus ? "Up to date." : "Update available.",
    },
    ...(updateStatus
      ? {
          updateState: {
            status: updateStatus,
            startedAt: "2026-07-18T12:00:00.000Z",
            finishedAt: "2026-07-18T12:00:01.000Z",
            message: "Provider updated.",
            output: null,
          },
        }
      : {}),
  };
}

type RowElement = ReactElement<{
  readonly label: string;
  readonly status: ProviderUpdateRowStatus;
  readonly canUpdate: boolean;
  readonly onUpdate: () => void;
}>;

type UpdateAllButtonElement = ReactElement<{
  readonly "aria-label": string;
  readonly children: unknown;
  readonly disabled: boolean;
  readonly onClick: () => void;
}>;

type ElementWithChildren = ReactElement<{ readonly children?: unknown }>;

function renderContent(candidates: ReadonlyArray<ProviderUpdateCandidate>): ElementWithChildren {
  hooks.beginRender();
  return ProviderUpdateProviderRows({
    candidates,
    environmentId,
    onOpenSettings: vi.fn(),
  }) as ElementWithChildren;
}

function flattenElements(value: unknown): ElementWithChildren[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenElements);
  }
  return value && typeof value === "object" && "props" in value
    ? [value as ElementWithChildren]
    : [];
}

function renderRows(candidates: ReadonlyArray<ProviderUpdateCandidate>): RowElement[] {
  return flattenElements(renderContent(candidates).props.children)
    .filter((element) => element.type === ProviderUpdateRow)
    .map((element) => element as unknown as RowElement);
}

function renderUpdateAllButton(
  candidates: ReadonlyArray<ProviderUpdateCandidate>,
): UpdateAllButtonElement {
  hooks.beginRender();
  return ProviderUpdateAllButton({
    candidates,
    environmentId,
  }) as UpdateAllButtonElement;
}

function elementText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(elementText).join("");
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "props" in value) {
    return elementText((value as ElementWithChildren).props.children);
  }
  return "";
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderUpdateProviderRows", () => {
  beforeEach(() => {
    hooks.reset();
    testState.updateProvider.mockReset();
    testState.providers = [provider("codex"), provider("cursor")];
  });

  it("lists each provider and updates only the selected provider", async () => {
    const candidates = testState.providers as ProviderUpdateCandidate[];
    let resolveUpdate!: (value: ReturnType<typeof AsyncResult.success>) => void;
    testState.updateProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );

    const initialRows = renderRows(candidates);
    expect(initialRows.map((row) => row.props.label)).toEqual(["Codex", "Cursor"]);
    expect(initialRows.map((row) => row.props.status.text)).toEqual([
      "v1.0.0 → v1.1.0",
      "v1.0.0 → v1.1.0",
    ]);
    expect(initialRows.every((row) => row.props.canUpdate)).toBe(true);

    initialRows[1]!.props.onUpdate();

    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: {
        provider: ProviderDriverKind.make("cursor"),
        instanceId: ProviderInstanceId.make("cursor"),
      },
    });
    expect(renderRows(candidates).map((row) => row.props.status.kind)).toEqual(["idle", "loading"]);

    const updatedCursor = provider("cursor", "succeeded");
    testState.providers = [provider("codex"), updatedCursor];
    resolveUpdate(AsyncResult.success({ providers: [updatedCursor] }));
    await flushPromises();

    const finishedRows = renderRows(candidates);
    expect(finishedRows.map((row) => row.props.status.kind)).toEqual(["idle", "success"]);
    expect(finishedRows[1]!.props.status.text).toBe("Updated to v1.1.0");
  });

  it("updates every one-click provider from the leading update-all action", async () => {
    const candidates = testState.providers as ProviderUpdateCandidate[];
    testState.updateProvider.mockImplementation(({ input }: { input: { provider: string } }) =>
      Promise.resolve(AsyncResult.success({ providers: [provider(input.provider, "succeeded")] })),
    );

    const updateAllButton = renderUpdateAllButton(candidates);
    expect(updateAllButton.props["aria-label"]).toBe("Update all providers");
    expect(updateAllButton.props.disabled).toBe(false);

    updateAllButton.props.onClick();
    expect(elementText(renderUpdateAllButton(candidates).props.children)).toBe("Updating all…");
    await flushPromises();

    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: {
        provider: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
      },
    });
    expect(testState.updateProvider).toHaveBeenCalledWith({
      environmentId,
      input: {
        provider: ProviderDriverKind.make("cursor"),
        instanceId: ProviderInstanceId.make("cursor"),
      },
    });
    const finishedButton = renderUpdateAllButton(candidates);
    expect(finishedButton.props.disabled).toBe(true);
    expect(elementText(finishedButton.props.children)).toBe("All updated");
  });

  it("shows live bulk-update success when the provider rows are opened afterward", () => {
    const candidate = provider("codex") as ProviderUpdateCandidate;
    testState.providers = [provider("codex", "succeeded")];

    const [row] = renderRows([candidate]);
    expect(row?.props.status.kind).toBe("success");
    expect(row?.props.status.text).toBe("Updated to v1.1.0");
  });

  it("adds providers that become outdated while the card is already open", () => {
    const codex = provider("codex") as ProviderUpdateCandidate;
    testState.providers = [codex];

    expect(renderRows([codex]).map((row) => row.props.label)).toEqual(["Codex"]);

    testState.providers = [codex, provider("cursor")];
    expect(renderRows([codex]).map((row) => row.props.label)).toEqual(["Codex", "Cursor"]);
  });

  it("does not misreport an interrupted update as a provider failure", async () => {
    const candidates = [testState.providers[0] as ProviderUpdateCandidate];
    testState.providers = candidates;
    testState.updateProvider.mockResolvedValue(AsyncResult.failure(Cause.interrupt()));

    renderRows(candidates)[0]!.props.onUpdate();
    await flushPromises();

    expect(renderRows(candidates)[0]!.props.status.kind).toBe("idle");
  });
});
