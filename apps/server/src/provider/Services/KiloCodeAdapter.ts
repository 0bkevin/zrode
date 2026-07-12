/**
 * KiloCodeAdapter — shape type for the KiloCode ACP provider adapter.
 *
 * The driver model bundles one adapter per instance as a captured closure,
 * so this module only retains the shape interface as a naming anchor for the
 * driver bundle.
 *
 * @module KiloCodeAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface KiloCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
