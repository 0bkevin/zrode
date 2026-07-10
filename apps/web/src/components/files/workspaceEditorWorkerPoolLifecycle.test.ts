import { describe, expect, it, vi } from "@effect/vitest";

import {
  createWorkspaceEditorWorkerPoolLifecycle,
  resolveWorkspaceEditorWorkerPoolSize,
  type WorkspaceEditorPageLifecycleTarget,
} from "./workspaceEditorWorkerPoolLifecycle";

class FakePageLifecycleTarget implements WorkspaceEditorPageLifecycleTarget {
  readonly listeners = new Map<"pagehide" | "pageshow", Set<EventListener>>();

  addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: "pagehide" | "pageshow"): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
}

describe("workspace editor worker pool lifecycle", () => {
  it("caps the workspace pool at two workers", () => {
    expect(resolveWorkspaceEditorWorkerPoolSize(undefined)).toBe(2);
    expect(resolveWorkspaceEditorWorkerPoolSize(16)).toBe(2);
    expect(resolveWorkspaceEditorWorkerPoolSize(2)).toBe(2);
    expect(resolveWorkspaceEditorWorkerPoolSize(1)).toBe(1);
    expect(resolveWorkspaceEditorWorkerPoolSize(0)).toBe(1);
  });

  it("lazily shares one realm pool and replaces it after pagehide", () => {
    const target = new FakePageLifecycleTarget();
    const firstPool = { terminate: vi.fn() };
    const secondPool = { terminate: vi.fn() };
    const createPool = vi.fn().mockReturnValueOnce(firstPool).mockReturnValueOnce(secondPool);
    const lifecycle = createWorkspaceEditorWorkerPoolLifecycle({
      createPool,
      getPageLifecycleTarget: () => target,
    });
    const subscriber = vi.fn();
    lifecycle.subscribe(subscriber);

    expect(createPool).not.toHaveBeenCalled();
    expect(lifecycle.getOrCreate("dark")).toBe(firstPool);
    expect(lifecycle.getOrCreate("light")).toBe(firstPool);
    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool).toHaveBeenCalledWith("dark");

    target.dispatch("pagehide");
    expect(firstPool.terminate).toHaveBeenCalledOnce();
    expect(lifecycle.getOrCreate("dark")).toBeUndefined();
    expect(subscriber).toHaveBeenCalledTimes(1);

    target.dispatch("pageshow");
    expect(lifecycle.getOrCreate("light")).toBe(secondPool);
    expect(createPool).toHaveBeenCalledTimes(2);
    expect(subscriber).toHaveBeenCalledTimes(2);

    lifecycle.dispose();
    expect(secondPool.terminate).toHaveBeenCalledOnce();
    expect(target.listeners.get("pagehide")?.size).toBe(0);
    expect(target.listeners.get("pageshow")?.size).toBe(0);
  });

  it("does not create workers outside a browser realm", () => {
    const createPool = vi.fn(() => ({ terminate: vi.fn() }));
    const lifecycle = createWorkspaceEditorWorkerPoolLifecycle({
      createPool,
      getPageLifecycleTarget: () => undefined,
    });

    expect(lifecycle.getOrCreate("dark")).toBeUndefined();
    expect(createPool).not.toHaveBeenCalled();
  });
});
