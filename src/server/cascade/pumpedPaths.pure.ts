/**
 * The paths the cascade composes for each clone instead of copying prime's.
 *
 * ## What a pump is
 *
 * Eight files state something about THIS repository's own function set, its
 * own backend, its own type errors or its own anon key, so prime's copy is
 * wrong on a clone whose set differs. The engine reconciles each one from both sides — prime's
 * additions merged into the clone's own copy — and writes the result in place
 * of prime's bytes. Each reconciler names its path and exports it; this is
 * where the eight are gathered, from those exports and never retyped.
 *
 * ## Why the list lives here and not inside the engine
 *
 * It did live inside the engine, as a local set the variant merge consulted so
 * that a pump's file is never also merged (two writers of one path is how a
 * summary comes to name a merge the tree does not carry). The convergence
 * auditor needed the same list and had none, so it compared these files by
 * blob identity — and a pump's output never matches prime's blob, by design.
 *
 * Measured 27 Oct 2026: no mirror had converged since 8 Oct 00:22 UTC, and
 * each had read `falling_behind` about 1,820 times since 06:37 that day,
 * owing at the end exactly `SECURITY_INVENTORY.json`,
 * `mobile/api-surface.json`, `auditRemediation.spec.ts` and
 * `SECURITY_REGISTRY.json`. 399 `unclassified` blockages opened behind that
 * reading in 30 days, and it filed an audit row on every tick. The baseline
 * reconcile that composes the first and third shipped at 09:41 the same day
 * (4f39fcc).
 *
 * A second list in the auditor would drift the same way the first did: a pump
 * added to the engine and not to the auditor reads as owed for ever. So both
 * read this one.
 *
 * Client-safe: pure, and its only imports are the reconcilers' own path
 * constants.
 */
import { API_SURFACE_PATH } from "./apiSurfaceReconcile.pure";
import { CONFIG_TOML_PATH } from "./configTomlReconcile.pure";
import { DEPLOY_WORKFLOW_PATH } from "./deployWorkflowReconcile.pure";
import { EDGE_TYPECHECK_BASELINE_PATH } from "./edgeTypecheckBaselineReconcile.pure";
import { GITLEAKS_CONFIG_PATH } from "./gitleaksReconcile.pure";
import { SECURITY_REGISTRY_PATH } from "./securityRegistryReconcile.pure";
import { FUNCTION_COUNT_RATCHET_PATH, SECURITY_INVENTORY_PATH } from "./securityInventoryHold.pure";

/** Every path a reconcile pump composes per clone. */
export const PUMPED_PATHS: ReadonlySet<string> = new Set([
  CONFIG_TOML_PATH,
  SECURITY_REGISTRY_PATH,
  SECURITY_INVENTORY_PATH,
  FUNCTION_COUNT_RATCHET_PATH,
  API_SURFACE_PATH,
  DEPLOY_WORKFLOW_PATH,
  EDGE_TYPECHECK_BASELINE_PATH,
  GITLEAKS_CONFIG_PATH,
]);
