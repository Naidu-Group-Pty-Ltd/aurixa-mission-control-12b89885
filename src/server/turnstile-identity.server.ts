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
    await supabase
      .from("clone_turnstile_identities")
      .update({ last_error: error })
      .eq("clone_id", cloneId);
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
