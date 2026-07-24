import type { ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export interface ProviderSessionHistoryImportInput {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ProviderDriverKind>;
  readonly requestedAt: string;
}

export interface ProviderSessionHistoryImportFailure {
  readonly provider: ProviderDriverKind;
  readonly detail: string;
}

export class ProviderSessionHistoryImportError extends Data.TaggedError(
  "ProviderSessionHistoryImportError",
)<{
  readonly projectId: ProjectId;
  readonly failures: ReadonlyArray<ProviderSessionHistoryImportFailure>;
}> {}

export interface ProviderSessionHistoryImporterShape {
  readonly importProjectHistory: (
    input: ProviderSessionHistoryImportInput,
  ) => Effect.Effect<void, ProviderSessionHistoryImportError>;
}

export class ProviderSessionHistoryImporter extends Context.Service<
  ProviderSessionHistoryImporter,
  ProviderSessionHistoryImporterShape
>()("t3/provider/Services/ProviderSessionHistoryImporter") {}
