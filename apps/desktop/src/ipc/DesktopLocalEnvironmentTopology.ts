import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";

export function localEnvironmentBootstrapsEqual(
  left: ReadonlyArray<DesktopEnvironmentBootstrap>,
  right: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.label === candidate.label &&
        entry.runningDistro === candidate.runningDistro &&
        entry.httpBaseUrl === candidate.httpBaseUrl &&
        entry.wsBaseUrl === candidate.wsBaseUrl &&
        entry.bootstrapToken === candidate.bootstrapToken
      );
    })
  );
}

export function makeLocalEnvironmentTopologyChangeDetector() {
  let previous: ReadonlyArray<DesktopEnvironmentBootstrap> | undefined;
  return (next: ReadonlyArray<DesktopEnvironmentBootstrap>): boolean => {
    if (previous !== undefined && localEnvironmentBootstrapsEqual(previous, next)) return false;
    previous = next;
    return true;
  };
}
