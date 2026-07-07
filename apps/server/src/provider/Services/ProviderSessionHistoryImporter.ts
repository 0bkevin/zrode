import type { ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProviderSessionHistoryImportInput {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<ProviderDriverKind>;
  readonly requestedAt: string;
}

export interface ProviderSessionHistoryImporterShape {
  readonly importProjectHistory: (input: ProviderSessionHistoryImportInput) => Effect.Effect<void>;
}

export class ProviderSessionHistoryImporter extends Context.Service<
  ProviderSessionHistoryImporter,
  ProviderSessionHistoryImporterShape
>()("t3/provider/Services/ProviderSessionHistoryImporter") {}
