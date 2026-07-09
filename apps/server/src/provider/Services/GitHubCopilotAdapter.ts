/**
 * GitHubCopilotAdapter — shape type for the GitHub Copilot provider adapter.
 *
 * The driver model bundles one adapter per instance as a captured closure, so
 * this module only retains the shape interface as a naming anchor for the
 * driver bundle.
 *
 * @module GitHubCopilotAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * GitHubCopilotAdapterShape — per-instance GitHub Copilot adapter contract.
 */
export interface GitHubCopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
