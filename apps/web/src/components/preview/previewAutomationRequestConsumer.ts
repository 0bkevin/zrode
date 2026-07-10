import type {
  PreviewAutomationHost,
  PreviewAutomationRequest,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  PreviewAutomationOperationError,
  PreviewAutomationRequestExpiredError,
  type PreviewAutomationOperationContext,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

type AutomationStreamResult<E> = AsyncResult.AsyncResult<PreviewAutomationStreamEvent, E>;
type RoutedPreviewAutomationRequest = PreviewAutomationRequest & {
  readonly sessionKey: string;
  readonly deadlineAt: number;
};

export function serializePreviewAutomationError(
  error: unknown,
  context: PreviewAutomationOperationContext,
): NonNullable<PreviewAutomationResponse["error"]> {
  return serializePreviewAutomationHostError(
    PreviewAutomationOperationError.fromCause({ ...context, cause: error }),
  );
}

export function createPreviewAutomationRequestConsumerAtom<E>(options: {
  readonly requestsAtom: Atom.Atom<AutomationStreamResult<E>>;
  readonly clientId: PreviewAutomationHost["clientId"];
  readonly connectionAtom: Atom.Writable<PreviewAutomationStreamEvent["connectionId"] | null>;
  readonly environmentId: PreviewAutomationHost["environmentId"];
  readonly requestHandlerAtom: Atom.Atom<{
    readonly handle: (request: PreviewAutomationRequest) => Promise<unknown>;
  }>;
  readonly respond: (response: PreviewAutomationResponse) => Promise<unknown>;
  readonly label: string;
}): Atom.Atom<void> {
  return Atom.make((get) => {
    get.mount(options.connectionAtom);
    get.mount(options.requestHandlerAtom);
    let disposed = false;
    let activeConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let connectionExplicitlyAnnounced = false;
    let reportedConnectionId: PreviewAutomationStreamEvent["connectionId"] | null = null;
    let requestsVersion = 0;
    const sessionQueues = new Map<string, Promise<void>>();

    const execute = async (
      request: RoutedPreviewAutomationRequest,
      connectionId: PreviewAutomationStreamEvent["connectionId"],
    ): Promise<void> => {
      if (disposed || activeConnectionId !== connectionId) return;
      let response: PreviewAutomationResponse;
      try {
        const remainingMs = request.deadlineAt - Date.now();
        if (remainingMs <= 0) {
          throw new PreviewAutomationRequestExpiredError({
            requestId: request.requestId,
            environmentId: options.environmentId,
            threadId: request.threadId,
            deadlineAt: request.deadlineAt,
          });
        }
        const value = await get.once(options.requestHandlerAtom).handle({
          ...request,
          timeoutMs: Math.min(request.timeoutMs, remainingMs),
        });
        response = {
          clientId: options.clientId,
          connectionId,
          requestId: request.requestId,
          ok: true,
          ...(value === undefined ? {} : { result: value }),
        };
      } catch (error) {
        response = {
          clientId: options.clientId,
          connectionId,
          requestId: request.requestId,
          ok: false,
          error: serializePreviewAutomationError(error, {
            requestId: request.requestId,
            operation: request.operation,
            environmentId: options.environmentId,
            threadId: request.threadId,
            tabId: request.tabId ?? null,
          }),
        };
      }
      if (disposed || activeConnectionId !== connectionId) return;
      await options.respond(response);
    };

    const enqueue = (
      request: PreviewAutomationRequest,
      connectionId: PreviewAutomationStreamEvent["connectionId"],
    ) => {
      if (disposed || activeConnectionId !== connectionId) return;
      const routedRequest: RoutedPreviewAutomationRequest = {
        ...request,
        sessionKey: request.sessionKey ?? request.threadId,
        // The server and desktop may run on different machines. Convert the
        // relative wire budget to this host's clock when the request arrives.
        deadlineAt: Date.now() + request.timeoutMs,
      };
      const previous = sessionQueues.get(routedRequest.sessionKey) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => execute(routedRequest, connectionId))
        .catch(() => undefined)
        .finally(() => {
          if (sessionQueues.get(routedRequest.sessionKey) === current) {
            sessionQueues.delete(routedRequest.sessionKey);
          }
        });
      sessionQueues.set(routedRequest.sessionKey, current);
    };

    const consume = (result: AutomationStreamResult<E>) => {
      if (!AsyncResult.isSuccess(result)) return;
      const event = result.value;
      if (event.type === "connected") {
        if (activeConnectionId !== null && activeConnectionId !== event.connectionId) {
          sessionQueues.clear();
        }
        activeConnectionId = event.connectionId;
        connectionExplicitlyAnnounced = true;
      } else if (activeConnectionId === null) {
        activeConnectionId = event.connectionId;
      } else if (activeConnectionId !== event.connectionId) {
        if (connectionExplicitlyAnnounced) return;
        sessionQueues.clear();
        activeConnectionId = event.connectionId;
      }
      if (reportedConnectionId !== event.connectionId) {
        reportedConnectionId = event.connectionId;
        get.set(options.connectionAtom, event.connectionId);
      }
      if (event.type === "connected") {
        return;
      }
      const request = event.request;
      enqueue(request, event.connectionId);
    };

    get.addFinalizer(() => {
      disposed = true;
      sessionQueues.clear();
    });
    const initialRequest = get.once(options.requestsAtom);
    if (AsyncResult.isSuccess(initialRequest)) {
      activeConnectionId = initialRequest.value.connectionId;
      connectionExplicitlyAnnounced = initialRequest.value.type === "connected";
      if (initialRequest.value.type === "connected") {
        reportedConnectionId = initialRequest.value.connectionId;
        get.set(options.connectionAtom, initialRequest.value.connectionId);
      }
    }
    get.subscribe(options.requestsAtom, (result) => {
      requestsVersion += 1;
      consume(result);
    });
    queueMicrotask(() => {
      const initialConnectionWasSkipped =
        AsyncResult.isSuccess(initialRequest) &&
        initialRequest.value.connectionId === activeConnectionId &&
        initialRequest.value.connectionId !== reportedConnectionId;
      if (!disposed && (requestsVersion === 0 || initialConnectionWasSkipped)) {
        consume(initialRequest);
      }
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));
}
