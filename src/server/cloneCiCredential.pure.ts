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
 *
 * ## And the service-role key beside it (26 Oct 2026)
 *
 * The prime's sanctions, PEP and RBA refreshes write with the project's
 * service-role key, and every clone receives those workflows. No clone
 * received the key. Measured 26 Oct 2026: on all four clones every scheduled
 * run of all three had failed at its credential check, every day, so each
 * clone's sanctions register and office-holder index stood where the one-off
 * reference copy left them in September and no clone held a single RBA
 * observation. The key is the clone's OWN — read from `clone_backends`, where
 * provisioning stored it — and it reaches the one project the database URL
 * already reaches, so it travels under the same rule: a clone is only ever
 * handed its own. `judgeServiceRoleKey` holds it to that.
 *
 * ## Both live in the production environment, never the repository
 *
 * A repository secret is readable by every job on every branch. Every
 * workflow that reads either credential names `supabase-production`, which is
 * where the prime keeps its own (`docs/operations/DEPLOYMENT_PROTECTION.md`),
 * so that is where a clone's are written.
 *
 * An environment is only a boundary if it says which refs may enter it, and
 * the clones' were created saying nothing. The pass now creates it admitting
 * the clone's default branch alone, as the prime's admits `main`, and brings
 * an existing one to that before it writes anything into it
 * (`environmentBranchPolicy.pure.ts`).
 *
 * ## A password nobody kept
 *
 * Measured the same day: no clone had a stored password, so this sweep had
 * reported "cannot" for all four every half hour since it was written.
 * Provisioning generated one, gave it to Supabase, and persisted only the
 * project ref at creation; the run then paused while the project came up, and
 * the resumed run knew no password to store. Creation now persists it with
 * the ref. A clone already without one is given a fresh one, by Supabase's
 * own endpoint, but only where its repository holds no deploy token of its
 * own: where it does, the tenant operates the backend, and the database and
 * its password are the owner's (`decidePasswordSet`).
 */

/** The Actions secret a clone's `apply-migration.yml` and `migration-drift.yml` read. */
export const CI_DB_URL_SECRET = "SUPABASE_DB_URL";

/** The Actions secret a clone's sanctions, PEP and RBA refreshes read. */
export const CI_SERVICE_ROLE_SECRET = "SUPABASE_SERVICE_ROLE_KEY";

/** The environment every job that reads either credential names. */
export const CI_ENVIRONMENT = "supabase-production";

/**
 * The name a report files the environment's branch policy under, beside the
 * two credentials it guards. The policy is the clone's default branch only,
 * the rule the prime keeps on its own copy (`environmentBranchPolicy.pure.ts`).
 */
export const CI_ENVIRONMENT_POLICY = `${CI_ENVIRONMENT} branch policy`;

/** Not a credential: which project the repository belongs to, readable by anyone who can read it. */
export const CI_PROJECT_REF_VARIABLE = "SUPABASE_PROJECT_REF";

/** Supavisor's session-mode port. Transaction mode (6543) is never used here. */
export const SESSION_POOLER_PORT = 5432;

export type PoolerFacts = {
  /** e.g. `aws-1-ap-southeast-2.pooler.supabase.com` */
  host: string | null;
  /** e.g. `postgres.plisdzywzleljorrphxv` */
  user: string | null;
  /**
   * Whatever Supabase reports. On the shared pooler this is the port of the
   * project's DEFAULT pool mode, which is transaction (6543); the session
   * port on the same host is 5432 regardless, and that is the one used.
   */
  port: number | null;
};

/**
 * Supavisor's shared pooler: one host per region serving BOTH modes, the port
 * choosing which (5432 session, 6543 transaction). Anything else — a dedicated
 * pooler on the project's own host — is not known to serve session mode on
 * 5432, so a non-session port there is still refused.
 */
const SHARED_POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;

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
  // Measured 26 Oct 2026, the first time any clone had a password to compose
  // with: all four projects' pooler config reported port 6543. That is the
  // default mode's port, not a statement about which modes the host serves —
  // the shared pooler takes session connections on 5432 on the same host
  // (Supabase, "Connect to your database"). Refusing it refused every clone.
  if (
    !SHARED_POOLER_HOST.test(host) &&
    input.pooler.port !== null &&
    input.pooler.port !== SESSION_POOLER_PORT
  ) {
    return {
      ok: false,
      reason: `Supabase reported pooler port ${input.pooler.port} on ${host}, which is not the shared pooler; only the session port ${SESSION_POOLER_PORT} is used`,
    };
  }

  const password = encodeURIComponent(input.password);
  const url = `postgresql://${user}:${password}@${host}:${SESSION_POOLER_PORT}/postgres?sslmode=require`;
  return { ok: true, url, host, user };
}

/**
 * Is this stored key the clone's own service-role key, in the form its
 * workflows can use?
 *
 * Only a JWT passes. `rba-tables-ingest` sits behind the gateway's JWT check
 * (`verify_jwt = true`), which does not admit an `sb_secret_` key, and a JWT
 * is the one form that says which project it belongs to. Its `ref` must be
 * this clone's: a key for any other project — the prime's above all — in a
 * tenant's repository is the worst outcome this module could produce, so it
 * is refused rather than written.
 */
export function judgeServiceRoleKey(input: {
  projectRef: string;
  key: string | null;
}): { ok: true; key: string } | { ok: false; reason: string } {
  const key = (input.key ?? "").trim();
  if (!key) return { ok: false, reason: "no service-role key is stored for this clone" };
  const parts = key.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason:
        "the stored service-role key is not a JWT, and the gateway in front of " +
        "rba-tables-ingest admits only a JWT",
    };
  }
  let claims: { ref?: unknown; role?: unknown };
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as typeof claims;
  } catch {
    return { ok: false, reason: "the stored service-role key's claims could not be read" };
  }
  if (claims.role !== "service_role") {
    return {
      ok: false,
      reason: `the stored key's role is "${String(claims.role)}", not service_role`,
    };
  }
  if (claims.ref !== input.projectRef) {
    return {
      ok: false,
      reason:
        `the stored key belongs to project ${String(claims.ref)}, not this clone's ` +
        `(${input.projectRef}) — refusing to hand a clone another project's key`,
    };
  }
  return { ok: true, key };
}

/**
 * May Mission Control give this clone's database a password?
 *
 * Only where none is stored, and only where Mission Control operates the
 * backend. A tenant whose own CI deploys holds its own credentials, may have
 * set its own password, and would lose every connection made with it.
 *
 * The signal is the deploy token, never `BACKEND_DEPLOYED_BY`. The declaration
 * sweep writes that variable on EVERY clone repository, a tenant's included,
 * because the deploy workflow lets a token outrank it
 * (`cloneDeployerDeclaration.pure.ts`), so it says nothing about who operates
 * the backend. A repository holding its own deploy token (`ACCESS_TOKEN_SECRET`
 * in `cloneBackendDeploy.server.ts`) does say it, the way `deriveDeployRoute`
 * reads it. A listing that failed is not an absent
 * token, so it leaves the password alone too.
 */
export function decidePasswordSet(input: {
  passwordStored: boolean;
  /**
   * Whether the repository, or its production environment, holds a deploy
   * token of its own. Null when GitHub could not be asked.
   */
  tenantDeployTokenHeld: boolean | null;
}): { set: true } | { set: false; reason: string | null } {
  if (input.passwordStored) return { set: false, reason: null };
  if (input.tenantDeployTokenHeld === null) {
    return {
      set: false,
      reason:
        "no database password is stored for this clone, and whether its repository holds a " +
        "deploy token of its own could not be read, so none is set",
    };
  }
  if (input.tenantDeployTokenHeld) {
    return {
      set: false,
      reason:
        "no database password is stored for this clone, and its repository holds a deploy " +
        "token of its own, so the tenant operates the backend, the password is the owner's, " +
        "and none is set",
    };
  }
  return { set: true };
}

/**
 * A database password Mission Control has CLAIMED for a clone and not yet
 * confirmed Supabase holds.
 *
 * The claim is written to the row before Supabase is told, so two overlapping
 * passes cannot both reset the database. But a pass can also stop between the
 * claim and the reset, or between the reset and the confirmation, and a claim
 * stored as a plain password would then read, to every later pass, as a
 * credential the database takes when it may not. So a claim is stored marked:
 * no pass ever hands a marked value out, and any pass that finds one sends
 * the same password to Supabase again (setting a password it already holds
 * changes nothing) and then stores it plain.
 */
export const PENDING_PASSWORD_PREFIX = "pending:";

/** The stored form of a claim: the marker, then the sealed password. */
export function pendingPassword(sealed: string): string {
  return `${PENDING_PASSWORD_PREFIX}${sealed}`;
}

/** The sealed password inside a claim, or null when the stored value is not one. */
export function claimedSealedPassword(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith(PENDING_PASSWORD_PREFIX)) return null;
  const sealed = stored.slice(PENDING_PASSWORD_PREFIX.length);
  return sealed.length > 0 ? sealed : null;
}

export type CredentialOutcome =
  /** Written where the environment held none. */
  | { repo: string; secret: string; state: "distributed" }
  /** Written again over one already there. GitHub cannot say whether it changed. */
  | { repo: string; secret: string; state: "kept" }
  /** The clone has no provisioned backend yet; nothing to distribute. */
  | { repo: string; state: "no_backend" }
  /** The environment had to be brought to the default branch only; `detail` says how. */
  | { repo: string; state: "restricted"; detail: string }
  /** Composed nothing, and said why. */
  | { repo: string; secret: string; state: "cannot"; reason: string }
  /** GitHub or Supabase refused. */
  | { repo: string; secret: string; state: "failed"; reason: string };

export type CredentialSweep = {
  /** Repositories looked at. */
  considered: number;
  /** `owner/repo NAME`, written where none was. */
  distributed: string[];
  /** `owner/repo NAME`, re-asserted. Quiet: a settled fleet is all of these. */
  kept: string[];
  noBackend: string[];
  /** Repositories whose database Mission Control gave a password this pass. */
  passwordsSet: string[];
  /**
   * `owner/repo: what changed`, where the production environment admitted
   * more than the default branch and was brought to it. Empty once settled.
   */
  restricted: string[];
  cannot: Array<{ repo: string; secret: string; reason: string }>;
  failed: Array<{ repo: string; secret: string; reason: string }>;
};

export function emptyCredentialSweep(): CredentialSweep {
  return {
    considered: 0,
    distributed: [],
    kept: [],
    noBackend: [],
    passwordsSet: [],
    restricted: [],
    cannot: [],
    failed: [],
  };
}

export function recordOutcome(sweep: CredentialSweep, outcome: CredentialOutcome): CredentialSweep {
  if (outcome.state === "no_backend") sweep.noBackend.push(outcome.repo);
  else if (outcome.state === "restricted")
    sweep.restricted.push(`${outcome.repo}: ${outcome.detail}`);
  else if (outcome.state === "distributed")
    sweep.distributed.push(`${outcome.repo} ${outcome.secret}`);
  else if (outcome.state === "kept") sweep.kept.push(`${outcome.repo} ${outcome.secret}`);
  else if (outcome.state === "cannot") {
    sweep.cannot.push({ repo: outcome.repo, secret: outcome.secret, reason: outcome.reason });
  } else sweep.failed.push({ repo: outcome.repo, secret: outcome.secret, reason: outcome.reason });
  return sweep;
}

/**
 * Is this pass worth an audit row?
 *
 * A settled fleet re-asserts the same secrets in the same repositories every
 * half hour. Filing that is how an audit log becomes something nobody reads,
 * so a re-assertion (`kept`) is quiet and only a first write, a password set,
 * an environment that had to be restricted, a refusal or a failure is filed.
 * An environment already admitting only its default branch reports nothing.
 */
export function sweepIsNoteworthy(sweep: CredentialSweep): boolean {
  return (
    sweep.distributed.length > 0 ||
    sweep.passwordsSet.length > 0 ||
    sweep.restricted.length > 0 ||
    sweep.cannot.length > 0 ||
    sweep.failed.length > 0
  );
}

/**
 * A one-line summary. Names repositories and reasons; never the credential,
 * and never any part of it.
 */
export function describeCredentialSweep(sweep: CredentialSweep): string {
  if (sweep.considered === 0) return "No clone repositories to consider.";
  const parts = [`${sweep.considered} considered`];
  if (sweep.distributed.length) parts.push(`${sweep.distributed.length} distributed`);
  if (sweep.kept.length) parts.push(`${sweep.kept.length} kept`);
  if (sweep.passwordsSet.length) parts.push(`${sweep.passwordsSet.length} given a password`);
  if (sweep.restricted.length) {
    parts.push(`${sweep.restricted.length} restricted to the default branch`);
  }
  if (sweep.noBackend.length) parts.push(`${sweep.noBackend.length} without a backend`);
  if (sweep.cannot.length) parts.push(`${sweep.cannot.length} could not be composed`);
  if (sweep.failed.length) parts.push(`${sweep.failed.length} failed`);
  return `${parts.join(" · ")}.`;
}
