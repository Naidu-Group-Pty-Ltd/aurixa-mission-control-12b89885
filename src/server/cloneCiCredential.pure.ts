/**
 * The credential a clone's own CI may hold to reach a database.
 *
 * ## Why this is not a Supabase access token
 *
 * The obvious answer to "let each clone apply its own migrations" is to give
 * each clone repository a `SUPABASE_ACCESS_TOKEN`. It does not survive contact
 * with how Supabase issues them:
 *
 *  - A personal access token **cannot be minted through any API.** It is
 *    created by hand, in the dashboard, by a signed-in human. There is no
 *    endpoint, so there is no "at scale" — every clone would be one more
 *    manual step, for ever.
 *  - A **classic** token carries the whole account: every organization and
 *    every project it can reach, including ones created after the token was
 *    issued. The one Mission Control holds creates and deletes projects. In a
 *    tenant's repository — where that tenant's own developers have write
 *    access — it is a credential that can delete the prime.
 *  - **Scoped** tokens (public alpha, `sbp_fc…`) do narrow to chosen projects
 *    and permissions, which is the right shape, but they are still created one
 *    at a time from one human account. They fix the blast radius, not the
 *    scale.
 *  - The **OAuth app** flow does issue tokens programmatically, with refresh
 *    tokens. It authorizes an integration against somebody else's
 *    organizations, which is a different problem: every clone here lives in
 *    the one organization Mission Control already administers, so the flow
 *    would add a consent dance and a token store while granting exactly the
 *    same org-wide reach.
 *
 * ## What does scale
 *
 * The credential Supabase already mints per project, automatically, at
 * creation: the database password. Mission Control generates it in
 * `createProject`, stores it encrypted in `clone_backends.db_pass`, and can
 * compose a connection string from it for any clone without asking anyone for
 * anything. It reaches ONE database — not another project, not billing, not
 * the project's own deletion — and rotating it for one clone touches no other.
 *
 * For the job in hand it is also simply better: `psql` has no request-size
 * ceiling, so the 39 MB template-library seed is one file rather than 55
 * chunked Management API calls.
 *
 * ## Two rules this module enforces
 *
 * **A clone is only ever handed its own database.** The pooler user encodes
 * the project ref, so the composed URL is checked against the ref the caller
 * asked for. That is the one mistake that would matter here, and it is the
 * mistake this fleet has already made once in the other direction — a mirrored
 * workflow whose target defaulted to the prime.
 *
 * **Session mode, never transaction mode.** Supavisor's 6543 port pools by
 * transaction: no prepared statements, no session state, and a `psql -f` of a
 * migration behaves in ways that are hard to predict and worse to debug. 5432
 * is the session port and is IPv4 on every tier, which GitHub's runners need.
 */

/** The Actions secret a clone's `apply-migration.yml` reads. */
export const CI_DB_URL_SECRET = "SUPABASE_DB_URL";

/** Supavisor's session-mode port. Transaction mode (6543) is never used here. */
export const SESSION_POOLER_PORT = 5432;

export type PoolerFacts = {
  /** e.g. `aws-1-ap-southeast-2.pooler.supabase.com` */
  host: string | null;
  /** e.g. `postgres.plisdzywzleljorrphxv` */
  user: string | null;
  /** Whatever Supabase reports; only 5432 is accepted. */
  port: number | null;
};

export type ComposeResult =
  | { ok: true; url: string; host: string; user: string }
  | { ok: false; reason: string };

/**
 * Compose the session-pooler URL for one project, or say why it cannot be.
 *
 * Never returns a partial string. A URL assembled from a missing part is a
 * credential that fails at connect time in a CI job somebody else is reading,
 * and "could not compose" is a far better thing for an operator to see.
 */
export function composeSessionPoolerUrl(input: {
  projectRef: string;
  password: string | null;
  pooler: PoolerFacts;
}): ComposeResult {
  const ref = input.projectRef.trim();
  if (!/^[a-z]{20}$/.test(ref)) {
    return { ok: false, reason: `"${ref}" is not a Supabase project ref` };
  }
  if (!input.password) {
    return { ok: false, reason: "no database password is stored for this clone" };
  }
  const host = (input.pooler.host ?? "").trim();
  if (!host) return { ok: false, reason: "Supabase reported no pooler host for this project" };
  const user = (input.pooler.user ?? "").trim();
  if (!user) return { ok: false, reason: "Supabase reported no pooler user for this project" };

  // The guard that matters. The pooler user is `postgres.<ref>`, so a user that
  // does not carry THIS ref is a connection string for somebody else's
  // database, and handing one to a tenant's CI is the worst outcome this
  // module could produce.
  if (!user.endsWith(`.${ref}`)) {
    return {
      ok: false,
      reason: `the pooler user "${user}" is not this project's (${ref}) — refusing to hand a clone another database`,
    };
  }
  if (input.pooler.port !== null && input.pooler.port !== SESSION_POOLER_PORT) {
    return {
      ok: false,
      reason: `Supabase reported pooler port ${input.pooler.port}; only the session port ${SESSION_POOLER_PORT} is used`,
    };
  }

  const password = encodeURIComponent(input.password);
  const url = `postgresql://${user}:${password}@${host}:${SESSION_POOLER_PORT}/postgres?sslmode=require`;
  return { ok: true, url, host, user };
}

export type CredentialOutcome =
  /** Written, or already present and identical. */
  | { repo: string; state: "distributed" }
  /** The clone has no provisioned backend yet; nothing to distribute. */
  | { repo: string; state: "no_backend" }
  /** Composed nothing, and said why. */
  | { repo: string; state: "cannot"; reason: string }
  /** GitHub or Supabase refused. */
  | { repo: string; state: "failed"; reason: string };

export type CredentialSweep = {
  considered: number;
  distributed: string[];
  noBackend: string[];
  cannot: Array<{ repo: string; reason: string }>;
  failed: Array<{ repo: string; reason: string }>;
};

export function emptyCredentialSweep(): CredentialSweep {
  return { considered: 0, distributed: [], noBackend: [], cannot: [], failed: [] };
}

export function recordOutcome(sweep: CredentialSweep, outcome: CredentialOutcome): CredentialSweep {
  sweep.considered += 1;
  if (outcome.state === "distributed") sweep.distributed.push(outcome.repo);
  else if (outcome.state === "no_backend") sweep.noBackend.push(outcome.repo);
  else if (outcome.state === "cannot") sweep.cannot.push({ repo: outcome.repo, reason: outcome.reason });
  else sweep.failed.push({ repo: outcome.repo, reason: outcome.reason });
  return sweep;
}

/**
 * Is this pass worth an audit row?
 *
 * A settled fleet writes the same secret to the same repositories every half
 * hour. Filing that is how an audit log becomes something nobody reads.
 */
export function sweepIsNoteworthy(sweep: CredentialSweep): boolean {
  return sweep.distributed.length > 0 || sweep.cannot.length > 0 || sweep.failed.length > 0;
}

/**
 * A one-line summary. Names repositories and reasons; never the credential,
 * and never any part of it.
 */
export function describeCredentialSweep(sweep: CredentialSweep): string {
  if (sweep.considered === 0) return "No clone repositories to consider.";
  const parts = [`${sweep.considered} considered`];
  if (sweep.distributed.length) parts.push(`${sweep.distributed.length} distributed`);
  if (sweep.noBackend.length) parts.push(`${sweep.noBackend.length} without a backend`);
  if (sweep.cannot.length) parts.push(`${sweep.cannot.length} could not be composed`);
  if (sweep.failed.length) parts.push(`${sweep.failed.length} failed`);
  return `${parts.join(" · ")}.`;
}
