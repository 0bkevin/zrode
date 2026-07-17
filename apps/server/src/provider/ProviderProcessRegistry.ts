import type { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface ProviderProcessOwner {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
}

export interface ProviderProcessRegistration extends ProviderProcessOwner {
  readonly pid: number;
}

const registrations = new Map<symbol, ProviderProcessRegistration>();

/**
 * Associate a locally spawned provider process with its canonical session.
 * The returned idempotent disposer must be tied to the same lifetime as the child.
 */
export function registerProviderProcess(registration: ProviderProcessRegistration): () => void {
  const key = Symbol(
    `${registration.providerInstanceId}:${registration.threadId}:${registration.pid}`,
  );
  registrations.set(key, registration);
  return () => {
    registrations.delete(key);
  };
}

export function listProviderProcesses(): ReadonlyArray<ProviderProcessRegistration> {
  return [...registrations.values()];
}
