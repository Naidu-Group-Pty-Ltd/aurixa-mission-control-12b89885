/**
 * Per-clone Turnstile identity — orchestration.
 *
 * Gives a clone its OWN Cloudflare Turnstile widget and wires both halves of
 * it into the tenant: the SECRET onto the clone's Supabase project as
 * `TURNSTILE_SECRET_KEY`, and the public SITE KEY into the clone's hosting
 * environment as `VITE_TURNSTILE_SITE_KEY` so its login bundle renders its own
 * widget instead of the prime's.
 *
 * Why not share the prime's widget: `cloneTurnstileIdentity.pure.ts` carries
 * the full reasoning. In one line — a Turnstile token is bound to a (site key,
 * secret) pair and nothing here checks the hostname `siteverify` reports, so
 * one widget across the fleet lets a token farmed from any tenant's login page
 * satisfy the CAPTCHA on every other tenant.
 *
 * Rules, in the order they bite:
 *
 *  - **The secret exists in memory for one flow.** Cloudflare returns it on
 *    create and on rotate and never again. It is written to the clone in the
 *    same call that obtained it; only its last four characters are stored.
 *  - **A widget this call created and could not deliver is deleted.** An
 *    orphan widget nobody holds the secret for is litter, not a retry.
 *    A widget that was merely ADOPTED is never deleted on failure.
 *  - **Fail closed, once it can.** The same write that installs the secret
 *    sets `REQUIRE_TURNSTILE=true`, so a later secret loss refuses sign-in
 *    visibly rather than silently serving a login with no CAPTCHA.
 *  - **Every clone-project write goes through `resolveCloneSecretTarget`**, so
 *    a mistyped ref can never reach the prime.
 *  - **Dormant without `CLOUDFLARE_API_TOKEN`**, with a named refusal.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  canRotateSecret,
  decideTurnstileSweep,
  deriveWidgetDomains,
  deriveWidgetName,
  secretLast4,
  turnstileReadiness,
  type TurnstileIdentityRow,
  type TurnstileReadiness,
} from "./cloneTurnstileIdentity.pure";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

export const CLONE_TURNSTILE_SECRET = "TURNSTILE_SECRET_KEY";
export const CLONE_TURNSTILE_SITE_KEY_ENV = "VITE_TURNSTILE_SITE_KEY";
export const REQUIRE_TURNSTILE_SECRET = "REQUIRE_TURNSTILE";

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function isCloudflareConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim());
}

export type TurnstileIdentityState = {
  ok: true;
  cloudflareConfigured: boolean;
  accountConfigured: boolean;
  row: TurnstileIdentityRow | null;
  readiness: TurnstileReadiness;
  suggestedDomains: string[];
};

function rowFrom(data: Record<string, unknown> | null): TurnstileIdentityRow | null {
  if (!data) return null;
  return {
    ...(data as unknown as TurnstileIdentityRow),
    domains: ((data.domains as string[] | null) ?? []) as string[],
  };
}

async function readIdentity(supabase: Db, cloneId: string): Promise<TurnstileIdentityRow | null> {
  const { data, error } = await supabase
    .from("clone_turnstile_identities")
    .select("*")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone's Turnstile identity: ${error.message}`);
  return rowFrom(data as Record<string, unknown> | null);
}

async function readCloneFacts(supabase: Db, cloneId: string) {
  const { data, error } = await supabase
    .from("clones")
    .select("slug, subdomain_fqdn, deploy_url")
    .eq("id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read clone ${cloneId}: ${error.message}`);
  if (!data) throw new Error(`Clone ${cloneId} not found`);
  return data;
}

async function readAccountId(supabase: Db): Promise<string | null> {
  const { data, error } = await supabase
    .from("platform_hosting_config")
    .select("cloudflare_account_id")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw new Error(`Could not read the hosting configuration: ${error.message}`);
  return data?.cloudflare_account_id ?? null;
}

async function persist(
  supabase: Db,
  cloneId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("clone_turnstile_identities")
    .upsert({ clone_id: cloneId, ...patch } as never, { onConflict: "clone_id" });
  if (error) throw new Error(`Could not store the Turnstile identity: ${error.message}`);
}

/** Read-only state for the operator panel. No vendor calls. */
export async function getTurnstileIdentityState(
  supabase: Db,
  cloneId: string,
): Promise<TurnstileIdentityState | Fail> {
  try {
    const [row, clone, accountId] = await Promise.all([
      readIdentity(supabase, cloneId),
      readCloneFacts(supabase, cloneId),
      readAccountId(supabase).catch(() => null),
    ]);
    const opts = {
      cloudflareConfigured: isCloudflareConfigured(),
      accountConfigured: Boolean(accountId),
    };
    return {
      ok: true,
      ...opts,
      row,
      readiness: turnstileReadiness(row, opts),
      suggestedDomains: row?.domains?.length ? row.domains : deriveWidgetDomains(clone),
    };
  } catch (e) {
    return fail(msg(e));
  }
}

/**
 * Deliver a freshly obtained secret to the clone: the secret itself, and
 * `REQUIRE_TURNSTILE=true` beside it so the clone fails closed from now on.
 */
async function deliverSecret(
  supabase: Db,
  cloneId: string,
  secret: string,
  actorUserId: string | null,
): Promise<{ ok: true } | Fail> {
  let target;
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    const reason = e instanceof CloneSecretTargetError ? ` (${e.reason})` : "";
    return fail(`Refusing to write the clone's Turnstile secret${reason}: ${msg(e)}`);
  }

  const { setCloneSecretValue } = await import("./backend-provisioning.server");
  const wrote = await setCloneSecretValue(target.projectRef, CLONE_TURNSTILE_SECRET, secret);
  if (!wrote.ok) return fail(`Could not write ${CLONE_TURNSTILE_SECRET}: ${wrote.error}`);

  // Fail-closed flag. Non-fatal on its own: the secret is already in place, and
  // reporting the whole provision as failed would invite a retry that mints a
  // second widget.
  const closed = await setCloneSecretValue(target.projectRef, REQUIRE_TURNSTILE_SECRET, "true");
  if (!closed.ok) {
    console.error("[turnstile-identity] REQUIRE_TURNSTILE not set:", closed.error);
  }

  const now = new Date().toISOString();
  const { error: ledgerErr } = await supabase.from("clone_backend_secrets").upsert(
    {
      clone_id: cloneId,
      name: CLONE_TURNSTILE_SECRET,
      status: "set",
      last_set_at: now,
      last_error: null,
      set_by: actorUserId,
    },
    { onConflict: "clone_id,name" },
  );
  if (ledgerErr) console.error("[turnstile-identity] ledger upsert failed:", ledgerErr.message);

  await persist(supabase, cloneId, {
    secret_last4: secretLast4(secret),
    secret_written_at: now,
    ...(closed.ok ? { fail_closed_at: now } : {}),
    status: "provisioned",
    last_error: null,
  });
  return { ok: true };
}

/**
 * Publish the PUBLIC site key into the clone's hosting environment.
 *
 * Public by design — it is rendered in the login page's HTML — which is why it
 * carries a `VITE_` name that the env policy permits. It only takes effect on
 * the clone's next build, and that is said rather than assumed.
 */
async function publishSiteKey(
  supabase: Db,
  cloneId: string,
  siteKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const { data: deployment } = await supabase
    .from("clone_deployments")
    .select("project_id, team_id")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (!deployment?.project_id) {
    return { ok: false, detail: "no hosting project — publish the site key when one exists" };
  }
  try {
    const { vercelApi, isVercelConfigured } = await import("./hosting/vercel-client");
    if (!isVercelConfigured()) return { ok: false, detail: "VERCEL_API_TOKEN not configured" };
    await vercelApi.upsertEnv(
      deployment.project_id,
      [
        {
          key: CLONE_TURNSTILE_SITE_KEY_ENV,
          value: siteKey,
          type: "plain",
          target: ["production", "preview", "development"],
        },
      ],
      deployment.team_id,
    );
    return { ok: true, detail: "published — takes effect on the clone's next deployment" };
  } catch (e) {
    return { ok: false, detail: msg(e) };
  }
}

export type ProvisionResult = (TurnstileIdentityState & { advanced: string[] }) | Fail;

/**
 * Create (or adopt, then keep current) this clone's own Turnstile widget and
 * deliver both halves of it. Safe to call repeatedly: an existing widget is
 * adopted and its domain list re-synced rather than a second one being made.
 */
export async function provisionTurnstileIdentity(
  supabase: Db,
  cloneId: string,
  opts: { mode: "provision" | "refresh"; actorUserId?: string | null },
): Promise<ProvisionResult> {
  if (!isCloudflareConfigured()) {
    return fail(
      "CLOUDFLARE_API_TOKEN is not configured on Mission Control, so no Turnstile widget can be " +
        "created. Add it in the project's environment, then run this again.",
    );
  }

  const advanced: string[] = [];
  try {
    const [clone, accountId] = await Promise.all([
      readCloneFacts(supabase, cloneId),
      readAccountId(supabase),
    ]);
    if (!accountId) {
      return fail(
        "No cloudflare_account_id in platform_hosting_config — Turnstile widgets are created " +
          "against an account, so there is nothing to create this one under.",
      );
    }

    let row = await readIdentity(supabase, cloneId);
    const domains = row?.domains?.length ? row.domains : deriveWidgetDomains(clone);
    if (domains.length === 0) {
      return fail(
        "This clone has no resolvable hostname, and a Turnstile widget with no domain issues no " +
          "token anywhere. Give the clone a subdomain or a deployment first.",
      );
    }

    const { cloudflareApi } = await import("./cloudflare/client");
    const name = row?.widget_name ?? deriveWidgetName(clone.slug);
    let mintedSecret: string | null = null;
    let createdHere = false;

    if (!row?.site_key) {
      if (opts.mode === "refresh") {
        return fail("Nothing to refresh — this clone has no Turnstile widget yet.");
      }
      const widget = await cloudflareApi.createTurnstileWidget(accountId, { name, domains });
      createdHere = true;
      mintedSecret = widget.secret ?? null;
      await persist(supabase, cloneId, {
        site_key: widget.sitekey,
        widget_name: name,
        domains,
        mode: "managed",
        status: "provisioned",
        created_by: opts.actorUserId ?? null,
        last_error: null,
      });
      advanced.push("widget_created");
      row = await readIdentity(supabase, cloneId);
    } else {
      // Adopt: keep the widget's domain list in step with the clone's origins.
      const live = await cloudflareApi.getTurnstileWidget(accountId, row.site_key);
      const wanted = deriveWidgetDomains(clone);
      const drifted =
        wanted.length > 0 && wanted.join(",") !== [...(live.domains ?? [])].sort().join(",");
      if (drifted) {
        await cloudflareApi.updateTurnstileWidget(accountId, row.site_key, { domains: wanted });
        await persist(supabase, cloneId, { domains: wanted });
        advanced.push("domains_synced");
        row = await readIdentity(supabase, cloneId);
      }
    }

    if (mintedSecret && row?.site_key) {
      const delivered = await deliverSecret(
        supabase,
        cloneId,
        mintedSecret,
        opts.actorUserId ?? null,
      );
      if (!delivered.ok) {
        // Undelivered secret, widget nobody can use: remove what this call made.
        if (createdHere) {
          await cloudflareApi.deleteTurnstileWidget(accountId, row.site_key).catch(() => {});
          await persist(supabase, cloneId, {
            site_key: null,
            status: "failed",
            last_error: delivered.error,
          });
        }
        return delivered;
      }
      advanced.push("secret_written");
      row = await readIdentity(supabase, cloneId);
    }

    if (row?.site_key && !row.site_key_published_at) {
      const published = await publishSiteKey(supabase, cloneId, row.site_key);
      if (published.ok) {
        await persist(supabase, cloneId, { site_key_published_at: new Date().toISOString() });
        advanced.push("site_key_published");
        row = await readIdentity(supabase, cloneId);
      } else {
        await persist(supabase, cloneId, {
          last_error: `Site key not published: ${published.detail}`,
        });
      }
    }

    const state = await getTurnstileIdentityState(supabase, cloneId);
    if (!state.ok) return state;
    return { ...state, advanced };
  } catch (e) {
    const error = msg(e);
    // UPSERT, not update. A clone that has never been provisioned has no row,
    // so an `.eq(clone_id)` update matched nothing and the failure was written
    // nowhere: the panel showed no error, and the sweep's cooling-off window —
    // which reads `last_error` off the row — never engaged, so a permanent
    // refusal was retried on every pass for ever.
    //
    // `status` moves to `failed` only when there is nothing working to
    // contradict: a widget that exists and merely failed a domain re-sync is
    // not a failed identity, and saying so would send an operator to re-mint
    // something that is fine.
    const existing = await readIdentity(supabase, cloneId).catch(() => null);
    await persist(supabase, cloneId, {
      last_error: error,
      ...(existing?.site_key ? {} : { status: "failed" }),
    }).catch(() => {});
    return fail(error);
  }
}

/**
 * Replace this clone's Turnstile secret. Cloudflare invalidates the old one
 * immediately, so the write to the clone follows in the same flow — a rotation
 * that mints and fails to deliver leaves sign-in refusing, which is why the
 * failure is reported loudly rather than swallowed.
 */
export async function rotateTurnstileSecret(
  supabase: Db,
  cloneId: string,
  actorUserId: string | null,
): Promise<{ ok: true; last4: string } | Fail> {
  if (!isCloudflareConfigured()) return fail("CLOUDFLARE_API_TOKEN is not configured.");
  try {
    const row = await readIdentity(supabase, cloneId);
    const gate = canRotateSecret(row);
    if (!gate.ok) return fail(gate.reason!);
    const accountId = await readAccountId(supabase);
    if (!accountId) return fail("No cloudflare_account_id in platform_hosting_config.");

    const { cloudflareApi } = await import("./cloudflare/client");
    const rotated = await cloudflareApi.rotateTurnstileSecret(accountId, row!.site_key!);
    if (!rotated.secret) {
      return fail("Cloudflare rotated the widget but returned no secret — nothing to deliver.");
    }
    const delivered = await deliverSecret(supabase, cloneId, rotated.secret, actorUserId);
    if (!delivered.ok) {
      await persist(supabase, cloneId, {
        status: "failed",
        last_error:
          `Secret rotated at Cloudflare but NOT delivered to the clone — sign-in will refuse ` +
          `until it is: ${delivered.error}`,
      });
      return delivered;
    }
    return { ok: true, last4: secretLast4(rotated.secret) };
  } catch (e) {
    return fail(msg(e));
  }
}

/**
 * Delete this clone's widget at Cloudflare. The value already on the clone
 * stops verifying the moment the widget goes, so the ledger is marked missing
 * — the operator needs to know sign-in now depends on what
 * `REQUIRE_TURNSTILE` says.
 */
export async function revokeTurnstileIdentity(
  supabase: Db,
  cloneId: string,
  actorUserId: string | null,
): Promise<{ ok: true } | Fail> {
  if (!isCloudflareConfigured()) return fail("CLOUDFLARE_API_TOKEN is not configured.");
  try {
    const row = await readIdentity(supabase, cloneId);
    if (!row?.site_key) return fail("This clone has no Turnstile widget to revoke.");
    const accountId = await readAccountId(supabase);
    if (!accountId) return fail("No cloudflare_account_id in platform_hosting_config.");

    const { cloudflareApi } = await import("./cloudflare/client");
    await cloudflareApi.deleteTurnstileWidget(accountId, row.site_key).catch(() => {});

    await persist(supabase, cloneId, {
      status: "revoked",
      site_key: null,
      secret_last4: null,
      secret_written_at: null,
      site_key_published_at: null,
      last_error: null,
    });
    const { error: ledgerErr } = await supabase.from("clone_backend_secrets").upsert(
      {
        clone_id: cloneId,
        name: CLONE_TURNSTILE_SECRET,
        status: "missing",
        last_set_at: null,
        last_error: "Turnstile widget revoked — the value on the clone no longer verifies",
        set_by: actorUserId,
      },
      { onConflict: "clone_id,name" },
    );
    if (ledgerErr) console.error("[turnstile-identity] revoke ledger failed:", ledgerErr.message);
    return { ok: true };
  } catch (e) {
    return fail(msg(e));
  }
}

/* ── The repair sweep ────────────────────────────────────────────────────── */

export type TurnstileSweepOutcome = {
  cloneId: string;
  slug: string | null;
  /** What was decided, and what came of it. Both, because they differ. */
  decision: string;
  ok: boolean;
  advanced?: string[];
  redeploy?: string;
  error?: string;
};

export type TurnstileSweepReport = {
  cloudflareConfigured: boolean;
  accountConfigured: boolean;
  /** Whether this deployment can mint at all, and why not when it cannot. */
  probe?: TurnstileAccessProbe;
  /** Named refusal when the sweep could not run at all. */
  skipped?: string;
  considered: number;
  acted: TurnstileSweepOutcome[];
  skippedByReason: Record<string, number>;
};

/** Cloudflare is rate-limited and this runs on a schedule; act on a few. */
const SWEEP_MAX_PER_RUN = 3;

/**
 * Give every eligible clone the Turnstile widget the pipeline did not.
 *
 * The deployment drain mints one in `syncing_env`, which reaches every clone
 * provisioned from now on and none provisioned before it existed. This is the
 * other half — and it is the same shape as `reconcileAllowedOrigins`, for the
 * same reason: a per-tenant credential that only new tenants get is a feature
 * the existing fleet does not have.
 *
 * It runs inside Mission Control, so it is also the honest test of whether
 * `CLOUDFLARE_API_TOKEN` is actually visible to this deployment — the report
 * says so either way rather than silently doing nothing.
 */
export async function reconcileTurnstileIdentities(
  supabase: Db,
  opts: { limit?: number; cloneId?: string } = {},
): Promise<TurnstileSweepReport> {
  const cloudflareConfigured = isCloudflareConfigured();
  const accountId = await readAccountId(supabase).catch(() => null);
  const probe = await probeTurnstileAccess(supabase);
  const base = {
    cloudflareConfigured,
    accountConfigured: Boolean(accountId),
    probe,
    considered: 0,
    acted: [] as TurnstileSweepOutcome[],
    skippedByReason: {} as Record<string, number>,
  };

  // Ask once whether this deployment can mint at all, and stop here when it
  // cannot. Attempting anyway spends one Cloudflare call per clone to collect
  // the same refusal N times, and records it as N clone-specific failures —
  // which reads as a fleet problem rather than the one credential problem it
  // is. "Nothing happened" is also the reading a healthy fleet gives, so the
  // refusal is always NAMED.
  if (!probe.canMint) {
    return { ...base, skipped: probe.diagnosis };
  }

  const cloneQuery = supabase.from("clones").select("id, slug, subdomain_fqdn, deploy_url");
  const { data: clones, error: cloneErr } = opts.cloneId
    ? await cloneQuery.eq("id", opts.cloneId)
    : await cloneQuery;
  if (cloneErr) throw new Error(`Could not list clones: ${cloneErr.message}`);

  const ids = (clones ?? []).map((c) => c.id);
  if (ids.length === 0) return base;

  const [deployments, backends, identities] = await Promise.all([
    supabase.from("clone_deployments").select("clone_id, project_id, status").in("clone_id", ids),
    supabase
      .from("clone_backends")
      .select("clone_id, status, supabase_project_ref")
      .in("clone_id", ids),
    supabase.from("clone_turnstile_identities").select("*").in("clone_id", ids),
  ]);
  // A read that FAILED is not a fleet that is EMPTY. Treating an unreadable
  // table as "no deployments" would make every clone look ineligible and the
  // run report a clean pass over a fleet it never saw.
  for (const [name, res] of [
    ["clone_deployments", deployments],
    ["clone_backends", backends],
    ["clone_turnstile_identities", identities],
  ] as const) {
    if (res.error) throw new Error(`Could not read ${name}: ${res.error.message}`);
  }

  const byDeployment = new Map((deployments.data ?? []).map((d) => [d.clone_id, d]));
  const byBackend = new Map((backends.data ?? []).map((b) => [b.clone_id, b]));
  const byIdentity = new Map(
    (identities.data ?? []).map((i) => [
      (i as { clone_id: string }).clone_id,
      rowFrom(i as Record<string, unknown>)!,
    ]),
  );

  const now = Date.now();
  const limit = opts.limit ?? SWEEP_MAX_PER_RUN;
  const report: TurnstileSweepReport = { ...base, considered: ids.length };

  for (const clone of clones ?? []) {
    if (report.acted.length >= limit) break;

    const deployment = byDeployment.get(clone.id);
    const backend = byBackend.get(clone.id);
    const verdict = decideTurnstileSweep({
      hasProject: Boolean(deployment?.project_id),
      backendReady: Boolean(backend?.supabase_project_ref) && backend?.status === "ready",
      identity: byIdentity.get(clone.id) ?? null,
      wantedDomains: deriveWidgetDomains(clone),
      now,
    });

    if (!verdict.act) {
      report.skippedByReason[verdict.reason] = (report.skippedByReason[verdict.reason] ?? 0) + 1;
      continue;
    }

    const outcome: TurnstileSweepOutcome = {
      cloneId: clone.id,
      slug: clone.slug,
      decision: `${verdict.action}: ${verdict.why}`,
      ok: false,
    };

    try {
      if (verdict.action === "rotate") {
        const rotated = await rotateTurnstileSecret(supabase, clone.id, null);
        outcome.ok = rotated.ok;
        if (!rotated.ok) outcome.error = rotated.error;
        else outcome.advanced = ["secret_rotated"];
      } else {
        const provisioned = await provisionTurnstileIdentity(supabase, clone.id, {
          mode: verdict.action === "refresh" ? "refresh" : "provision",
        });
        outcome.ok = provisioned.ok;
        if (!provisioned.ok) outcome.error = provisioned.error;
        else outcome.advanced = provisioned.advanced;
      }

      // A published site key does not reach a browser until the clone is BUILT
      // again — Vite inlines `VITE_*` at build time. Publishing without asking
      // for a rebuild leaves the clone in the state this whole change exists to
      // end: a login page that cannot answer its own CAPTCHA. Only on the pass
      // that actually published, so this cannot loop.
      if (outcome.ok && outcome.advanced?.includes("site_key_published")) {
        const { requestRedeployAfterPush } = await import("./hosting/redeploy.server");
        const asked = await requestRedeployAfterPush({
          cloneId: clone.id,
          reason: "Turnstile site key published",
        });
        outcome.redeploy = asked.queued ? `queued from ${asked.from}` : `skipped: ${asked.reason}`;
      }
    } catch (e) {
      outcome.error = msg(e);
    }

    report.acted.push(outcome);
  }

  return report;
}

/**
 * Can this Mission Control actually mint a widget?
 *
 * `verifyToken` answers "is this token real", which is not the question. A
 * Cloudflare token is a set of scoped permissions, and the one this deployment
 * was set up with is documented as Zone Read / Zone Settings Edit / Analytics
 * Read — none of which includes Turnstile. Such a token verifies as **active**
 * and then refuses widget creation, so a panel that trusts `verifyToken` says
 * "Connected" and the button fails with a vendor error code.
 *
 * So the probe is the capability itself: listing widgets is the cheapest call
 * that requires Turnstile permission on the account. It reads and creates
 * nothing.
 */
export type TurnstileAccessProbe = {
  tokenPresent: boolean;
  accountConfigured: boolean;
  /** Whether Cloudflare accepts the token at all, independently of scope. */
  tokenValid: boolean;
  /**
   * Cloudflare's id for the token this deployment is holding — an identifier,
   * not a credential, and the last few characters of the id are the ones the
   * dashboard URL shows. It is here because "the permission was added to a
   * different token" and "the permission was not saved" are indistinguishable
   * from the error, and this tells them apart in one glance.
   */
  tokenId?: string;
  /** Accounts the token can actually see, and whether ours is among them. */
  visibleAccounts?: Array<{ id: string; name: string }>;
  accountInScope?: boolean;
  /** True only when Cloudflare actually served a Turnstile read. */
  canMint: boolean;
  widgetCount?: number;
  error?: string;
  /** The remedy, in one line, for whichever of the four states this is. */
  diagnosis: string;
};

export async function probeTurnstileAccess(supabase: Db): Promise<TurnstileAccessProbe> {
  const tokenPresent = isCloudflareConfigured();
  const accountId = await readAccountId(supabase).catch(() => null);
  if (!tokenPresent) {
    return {
      tokenPresent: false,
      accountConfigured: Boolean(accountId),
      tokenValid: false,
      canMint: false,
      diagnosis:
        "CLOUDFLARE_API_TOKEN is not set on Mission Control. The name is read exactly; a secret " +
        "stored under any other name reads as no token at all.",
    };
  }
  if (!accountId) {
    return {
      tokenPresent: true,
      accountConfigured: false,
      tokenValid: false,
      canMint: false,
      diagnosis:
        "platform_hosting_config.cloudflare_account_id is empty. A Turnstile widget is created " +
        "against an account, so there is nothing to create one under.",
    };
  }

  const { cloudflareApi } = await import("./cloudflare/client");

  // Validity and scope are separate questions and they are asked separately,
  // because the two failures have different remedies and Cloudflare reports
  // BOTH as "Authentication error" on the Turnstile endpoint. A token that
  // verifies and cannot list widgets is a scope problem; one that does not
  // verify is the wrong token.
  let tokenValid = false;
  let tokenId: string | undefined;
  try {
    const verified = await cloudflareApi.verifyToken();
    tokenValid = verified?.status === "active";
    tokenId = verified?.id;
  } catch {
    tokenValid = false;
  }

  try {
    const widgets = await cloudflareApi.listTurnstileWidgets(accountId);
    return {
      tokenPresent: true,
      accountConfigured: true,
      tokenValid,
      tokenId,
      canMint: true,
      widgetCount: widgets?.length ?? 0,
      diagnosis: "Cloudflare is serving Turnstile for this account.",
    };
  } catch (e) {
    const error = msg(e);

    // Which accounts DOES it reach? A token whose Account Resources do not
    // include ours fails here identically to one that simply lacks the
    // Turnstile permission, and identically again to the permission having
    // been added to some OTHER token. Naming the accounts separates all three,
    // and none of it is secret.
    let visibleAccounts: Array<{ id: string; name: string }> | undefined;
    try {
      const accounts = await cloudflareApi.listAccounts();
      visibleAccounts = (accounts ?? []).map((a) => ({ id: a.id, name: a.name }));
    } catch {
      visibleAccounts = undefined;
    }
    const accountInScope = visibleAccounts?.some((a) => a.id === accountId);

    let diagnosis: string;
    if (!tokenValid) {
      diagnosis = `Cloudflare does not accept this token at all. Cloudflare said: ${error}`;
    } else if (visibleAccounts && visibleAccounts.length === 0) {
      diagnosis =
        `Token ${tokenId ?? "(id unknown)"} is valid and can see NO accounts, so it holds no ` +
        "account-level permission at all. Turnstile is account-scoped. Either the change was not " +
        `saved, or it was made on a different token. Cloudflare said: ${error}`;
    } else if (visibleAccounts && !accountInScope) {
      diagnosis =
        `Token ${tokenId ?? "(id unknown)"} reaches ${visibleAccounts
          .map((a) => `${a.name} (${a.id})`)
          .join(", ")} — but NOT ${accountId}, which is the account this deployment provisions ` +
        `into. Point the token's Account Resources at that account, or correct ` +
        `platform_hosting_config.cloudflare_account_id. Cloudflare said: ${error}`;
    } else {
      diagnosis =
        `Token ${tokenId ?? "(id unknown)"} is valid and reaches account ${accountId}, and ` +
        "Cloudflare still refuses Turnstile — so the Turnstile permission itself is missing from " +
        "THIS token. Cloudflare applies permission edits immediately, so a change that is not " +
        "visible here was not saved, or was saved on a different token: compare the id above with " +
        `the one in the dashboard URL. Cloudflare said: ${error}`;
    }

    return {
      tokenPresent: true,
      accountConfigured: true,
      tokenValid,
      tokenId,
      visibleAccounts,
      accountInScope,
      canMint: false,
      error,
      diagnosis,
    };
  }
}
