import type { OrchestrationThreadDetailSnapshot, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

export type ThreadSnapshotLoadResult =
  | { readonly kind: "found"; readonly snapshot: OrchestrationThreadDetailSnapshot }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<ThreadSnapshotLoadResult>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ThreadSnapshotLoader.of({
      load: (prepared, threadId) =>
        fetchEnvironmentThreadSnapshot({ prepared, threadId, signer }).pipe(
          Effect.map(
            (snapshot): ThreadSnapshotLoadResult => ({
              kind: "found",
              snapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchTag("EnvironmentResourceNotFoundError", () =>
            Effect.logDebug("Thread snapshot not found over HTTP.").pipe(
              Effect.annotateLogs({ threadId }),
              Effect.as<ThreadSnapshotLoadResult>({ kind: "missing" }),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as<ThreadSnapshotLoadResult>({ kind: "unavailable" }),
            ),
          ),
        ),
    });
  }),
);
