/**
 * A workspace's own grant of a connection scope, on BOTH ends.
 *
 * A `workspace_to_builder` scope discloses this workspace's records to a
 * builder, so only the workspace may grant it, and two parties check it
 * independently:
 *
 *   - the network's compliance broker honours `aml:reliance` only from a
 *     `connection_scope_grants` row with `granted_by_side = 'workspace'`
 *     (written by `builder-network-admin` `grant_workspace_scope`);
 *   - the workspace re-checks its OWN `builder_network_connections.scopes` on
 *     every E4 read (`e4_scope_missing` when absent).
 *
 * Neither had a writer. The one act here writes both, so the two copies
 * cannot drift into disagreeing about who may read the Passport.
 *
 * ## The order is what makes a partial act safe
 *
 * Access needs BOTH copies, so a half-done act fails closed either way, and
 * the order only decides which half a failure leaves behind:
 *
 *   - **grant** writes the network first and the workspace second. A failure
 *     between them leaves a grant the workspace still refuses; repeating the
 *     act is idempotent on both sides.
 *   - **revoke** removes the workspace's copy first. That alone stops every
 *     read at the next request, before the network has been asked anything.
 *
 * ## What a grant must find on the workspace
 *
 * A grant is written only onto a workspace row that is live and names the
 * same builder organisation the connection was minted for. Granting onto a
 * row that names somebody else would let one organisation's connection carry
 * another's disclosure, so a disagreement refuses rather than repairs.
 */

/**
 * The scopes a workspace discloses. Mirrors the network catalogue's
 * `workspace_to_builder` direction; the network re-checks it from the
 * catalogue itself, so a mistake here can only refuse, never widen.
 */
export const WORKSPACE_GRANTABLE_SCOPES = ["aml:reliance", "collaboration:messages"] as const;
export type WorkspaceGrantableScope = (typeof WORKSPACE_GRANTABLE_SCOPES)[number];

export function isWorkspaceGrantableScope(key: string): key is WorkspaceGrantableScope {
  return (WORKSPACE_GRANTABLE_SCOPES as readonly string[]).includes(key);
}

/** The scope list after the act: sorted, de-duplicated, never null. */
export function scopesAfter(
  current: readonly string[] | null | undefined,
  scopeKey: string,
  grant: boolean,
): string[] {
  const set = new Set((current ?? []).filter((s) => typeof s === "string" && s.length > 0));
  if (grant) set.add(scopeKey);
  else set.delete(scopeKey);
  return [...set].sort();
}

export interface WorkspaceConnectionRow {
  network_connection_id: string;
  state: string | null;
  builder_organisation_id: string | null;
  scopes: string[] | null;
  identity_mismatch_since?: string | null;
}

/**
 * Whether a grant may be written onto this workspace row. Null when it may.
 */
export function workspaceRowRefusal(
  row: WorkspaceConnectionRow | null,
  expectedOrganisationId: string,
): string | null {
  if (!row) {
    return (
      "This workspace holds no row for that connection. Install the transport on the " +
      "workspace before granting it anything."
    );
  }
  if (row.state !== "active") {
    return `This workspace's row for that connection is "${row.state ?? "unknown"}", not active.`;
  }
  if (!row.builder_organisation_id) {
    return (
      "This workspace's row for that connection names no builder organisation. Reinstall the " +
      "transport, which records it, before granting."
    );
  }
  if (row.builder_organisation_id !== expectedOrganisationId) {
    return (
      "This workspace's row names a different builder organisation from the one the connection " +
      "was minted for. Nothing was granted; the disagreement needs resolving first."
    );
  }
  if (row.identity_mismatch_since) {
    return "This workspace has halted that connection on an identity mismatch. Nothing was granted.";
  }
  return null;
}

/** An outcome safe to return to a browser. */
export type ScopeOutcome =
  | {
      ok: true;
      networkConnectionId: string;
      scopeKey: string;
      granted: boolean;
      scopes: string[];
    }
  | { ok: false; error: string; remedy?: string };

export function redactScopeOutcome(outcome: ScopeOutcome): ScopeOutcome {
  if (outcome.ok) {
    return {
      ok: true,
      networkConnectionId: outcome.networkConnectionId,
      scopeKey: outcome.scopeKey,
      granted: outcome.granted,
      scopes: [...outcome.scopes],
    };
  }
  return outcome.remedy
    ? { ok: false, error: outcome.error, remedy: outcome.remedy }
    : { ok: false, error: outcome.error };
}
