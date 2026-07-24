/**
 * Canonical names persisted in Effect SQL's migration ledger.
 *
 * The desktop state importer and the server migrator must share this exact
 * identity map: an id match with a different name can represent a forked
 * schema, as happened at migration 33 between T3 Code and Zrode.
 */
export const ZRODE_DATABASE_MIGRATION_NAMES_BY_ID = {
  1: "OrchestrationEvents",
  2: "OrchestrationCommandReceipts",
  3: "CheckpointDiffBlobs",
  4: "ProviderSessionRuntime",
  5: "Projections",
  6: "ProjectionThreadSessionRuntimeModeColumns",
  7: "ProjectionThreadMessageAttachments",
  8: "ProjectionThreadActivitySequence",
  9: "ProviderSessionRuntimeMode",
  10: "ProjectionThreadsRuntimeMode",
  11: "OrchestrationThreadCreatedRuntimeMode",
  12: "ProjectionThreadsInteractionMode",
  13: "ProjectionThreadProposedPlans",
  14: "ProjectionThreadProposedPlanImplementation",
  15: "ProjectionTurnsSourceProposedPlan",
  16: "CanonicalizeModelSelections",
  17: "ProjectionThreadsArchivedAt",
  18: "ProjectionThreadsArchivedAtIndex",
  19: "ProjectionSnapshotLookupIndexes",
  20: "AuthAccessManagement",
  21: "AuthSessionClientMetadata",
  22: "AuthSessionLastConnectedAt",
  23: "ProjectionThreadShellSummary",
  24: "BackfillProjectionThreadShellSummary",
  25: "CleanupInvalidProjectionPendingApprovals",
  26: "CanonicalizeModelSelectionOptions",
  27: "ProviderSessionRuntimeInstanceId",
  28: "ProjectionThreadSessionInstanceId",
  29: "ProjectionThreadDetailOrderingIndexes",
  30: "ProjectionThreadShellArchiveIndexes",
  31: "AuthAuthorizationScopes",
  32: "AuthPairingProofKeyThumbprint",
  33: "ProjectionThreadsHandoffSource",
  34: "ProviderUsageHistory",
  35: "ProviderTokenActivity",
  37: "ProjectionThreadTurnQueue",
  38: "ProviderTokenModelActivity",
  39: "ProviderTokenAccounting",
  40: "ProviderTokenAccountingCorrections",
  41: "ProviderGrokTokenIdentity",
  42: "OpenCodeRecordedCloudCosts",
  43: "GitHubCopilotTokenHistory",
  44: "OrchestrationEventTypeSequenceIndex",
  45: "OrchestrationActivityKindSequenceIndex",
  46: "ArchiveRetiredTitleGenerationEvents",
} as const;

export type ZrodeDatabaseMigrationId = keyof typeof ZRODE_DATABASE_MIGRATION_NAMES_BY_ID;
