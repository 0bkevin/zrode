import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly status: "loading"; readonly retry: () => void }
  | { readonly status: "error"; readonly message: string; readonly retry: () => void }
  | { readonly status: "ready"; readonly url: string; readonly retry: () => void };

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const retry = useCallback(() => refresh(), [refresh]);
  if (preparedConnection._tag === "None" || result._tag === "Initial") {
    return { status: "loading", retry };
  }
  if (result._tag === "Failure") {
    const error = Cause.squash(result.cause);
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The asset URL could not be prepared.",
      retry,
    };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  if (url === null) {
    return { status: "error", message: "The environment returned an invalid asset URL.", retry };
  }
  return { status: "ready", url, retry };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state.status === "ready" ? state.url : null;
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
