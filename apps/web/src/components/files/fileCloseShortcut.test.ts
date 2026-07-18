import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import {
  isCloseActiveFileShortcut,
  registerActiveFileCloseHandler,
  requestActiveFileClose,
} from "./fileCloseShortcut";

const shortcutEvent = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    altKey: false,
    ctrlKey: false,
    key: "w",
    metaKey: true,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe("file close shortcut", () => {
  it("recognizes the unmodified Cmd/Ctrl+W shortcut", () => {
    expect(isCloseActiveFileShortcut(shortcutEvent())).toBe(true);
    expect(isCloseActiveFileShortcut(shortcutEvent({ metaKey: false, ctrlKey: true }))).toBe(true);
    expect(isCloseActiveFileShortcut(shortcutEvent({ shiftKey: true }))).toBe(false);
    expect(isCloseActiveFileShortcut(shortcutEvent({ key: "p" }))).toBe(false);
  });

  it("routes a close request only while an active file handler is registered", () => {
    const close = vi.fn();
    expect(requestActiveFileClose()).toBe(false);

    unregister = registerActiveFileCloseHandler(close);
    expect(requestActiveFileClose()).toBe(true);
    expect(close).toHaveBeenCalledOnce();

    unregister();
    unregister = undefined;
    expect(requestActiveFileClose()).toBe(false);
  });

  it("does not let stale cleanup remove a newer registration", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerActiveFileCloseHandler(first);
    unregister = registerActiveFileCloseHandler(second);

    unregisterFirst();
    expect(requestActiveFileClose()).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
