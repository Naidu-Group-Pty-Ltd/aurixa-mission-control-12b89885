/**
 * Per-clone Turnstile identity — the decisions, with no network in them.
 *
 * A clone gets its OWN Cloudflare Turnstile widget rather than rendering the
 * prime's. The reason is not tidiness: a Turnstile token is bound to a (site
 * key, secret) PAIR and `siteverify` reports the hostname it was issued for
 * without any login handler in this fleet checking it. One shared widget
 * therefore means a token farmed from any tenant's login page — or from the
 * prime's, which is public — verifies on every other tenant, and the CAPTCHA
 * stops being a per-deployment control. Per-clone widgets also bound the
 * rotation blast radius and keep every customer's hostname off the prime's
 * widget.
 *
 * Everything here is pure so each rule — which hostnames a widget covers, what
 * the next step is, when a secret may be rotated — can be asserted by name
 * without Cloudflare, Supabase, or a database.
 */

/** `clone_turnstile_identities` row, as the flow reads it. */
export type TurnstileIdentityRow = {
  id: string;
  clone_id: string;
  site_key: string | null;
  widget_name: string | null;
  domains: string[];
  mode: "managed" | "non-interactive" | "invisible";
  status: "unprovisioned" | "provisioned" | "failed" | "revoked";
  secret_last4: string | null;
  secret_written_at: string | null;
  fail_closed_at: string | null;
  site_key_published_at: string | null;
  last_error: string | null;
  /** Present on the stored row; the sweep's cooling-off window reads it. */
  updated_at?: string | null;
};

/** The clone facts the derivations read. */
export type CloneHostFacts = {
  slug: string;
  subdomain_fqdn: string | null;
  deploy_url: string | null;
};

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;

function hostOf(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (HOSTNAME.test(v)) return v;
  try {
    const h = new URL(v.includes("://") ? v : `https://${v}`).hostname.toLowerCase();
    return HOSTNAME.test(h) ? h : null;
  } catch {
    return null;
  }
}

/**
 * Every hostname this clone's login page is actually served from.
 *
 * Unlike the email identity — where a `*.vercel.app` host can never be
 * verified as a sending domain — a provider origin is a perfectly real place
 * to render a login page, so it belongs on the widget. A widget that omits a
 * host the clone is served from issues no token there, and the sign-in button
 * never enables.
 *
 * Returns an empty array when the clone has no resolvable host: a widget with
 * no domains issues nothing anywhere, so the caller refuses rather than
 * creating one.
 */
export function deriveWidgetDomains(clone: CloneHostFacts): string[] {
  const out = new Set<string>();
  for (const candidate of [clone.subdomain_fqdn, clone.deploy_url]) {
    const h = hostOf(candidate);
    if (h) out.add(h);
  }
  return [...out].sort();
}

/** Stable, greppable widget name in the Cloudflare dashboard. */
export function deriveWidgetName(slug: string): string {
  const s = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 40);
  return `aurixa-clone-${s || "unnamed"}`;
}

/** Identification without storage: the only part of a secret ever kept. */
export function secretLast4(secret: string): string {
  return secret.slice(-4);
}

/**
 * A clone must never be handed the PRIME's widget. The site key is public and
 * therefore comparable, so this is checkable rather than merely intended.
 */
export function isPrimeSiteKey(siteKey: string | null, primeSiteKey: string | null): boolean {
  if (!siteKey || !primeSiteKey) return false;
  return siteKey.trim() === primeSiteKey.trim();
}

// ─── Readiness — the server owns "what next" ─────────────────────────

export type TurnstileStepId =
  | "cloudflare"
  | "widget"
  | "secret_written"
  | "site_key_published"
  | "fail_closed";

export type TurnstileStep = {
  id: TurnstileStepId;
  state: "done" | "open" | "blocked";
  detail: string;
};

export type TurnstileReadiness = {
  steps: TurnstileStep[];
  next: TurnstileStepId | null;
  live: boolean;
};

/**
 * Arrange the stored facts as an ordered path with exactly one open step.
 * Derives nothing new; it only gives the facts an order.
 */
export function turnstileReadiness(
  row: TurnstileIdentityRow | null,
  opts: { cloudflareConfigured: boolean; accountConfigured: boolean },
): TurnstileReadiness {
  const steps: TurnstileStep[] = [];
  let open = false;
  const push = (id: TurnstileStepId, done: boolean, detail: string) => {
    const state = done ? "done" : open ? "blocked" : "open";
    if (!done) open = true;
    steps.push({ id, state, detail });
  };

  const cfReady = opts.cloudflareConfigured && opts.accountConfigured;
  push(
    "cloudflare",
    cfReady,
    !opts.cloudflareConfigured
      ? "Set CLOUDFLARE_API_TOKEN in Mission Control's environment"
      : !opts.accountConfigured
        ? "Set cloudflare_account_id in the platform hosting configuration"
        : "Cloudflare is configured",
  );
  push(
    "widget",
    Boolean(row?.site_key),
    row?.site_key
      ? `Widget ${row.site_key} covers ${row.domains.join(", ") || "no domain"}`
      : "Create this clone's own Turnstile widget",
  );
  push(
    "secret_written",
    Boolean(row?.secret_written_at),
    row?.secret_written_at
      ? `Secret (…${row.secret_last4 ?? "????"}) written to the clone as TURNSTILE_SECRET_KEY`
      : "Write the widget's secret onto the clone's Supabase project",
  );
  push(
    "site_key_published",
    Boolean(row?.site_key_published_at),
    row?.site_key_published_at
      ? "Site key published to the clone's hosting environment"
      : "Publish VITE_TURNSTILE_SITE_KEY to the clone's deployment, then redeploy so the bundle carries it",
  );
  push(
    "fail_closed",
    Boolean(row?.fail_closed_at),
    row?.fail_closed_at
      ? "REQUIRE_TURNSTILE=true — a missing secret refuses sign-in instead of disabling the CAPTCHA"
      : "Set REQUIRE_TURNSTILE=true so the clone fails closed",
  );

  const next = steps.find((s) => s.state === "open")?.id ?? null;
  return { steps, next, live: next === null };
}

/**
 * A secret may be rotated only for a widget that exists. Rotation invalidates
 * the old secret immediately at Cloudflare, so it is refused when there is
 * nothing to rotate rather than creating one implicitly.
 */
export function canRotateSecret(row: TurnstileIdentityRow | null): {
  ok: boolean;
  reason?: string;
} {
  if (!row?.site_key) {
    return { ok: false, reason: "This clone has no Turnstile widget yet — provision one first" };
  }
  if (row.status === "revoked") {
    return { ok: false, reason: "This clone's widget was revoked — provision a new one instead" };
  }
  return { ok: true };
}

/* ── The repair sweep ────────────────────────────────────────────────────── */

/**
 * What a clone's Turnstile identity needs, decided from stored facts alone.
 *
 * The deployment drain mints a widget in `syncing_env`, which covers every
 * clone provisioned from now on and no clone provisioned before — including
 * the one clone in the fleet, which was built by hand and went live months
 * earlier. A feature that only reaches future tenants is the shape
 * `allowed-origins-reconcile` already exists to fix, and this is the same
 * answer: a sweep that repairs what the pipeline missed.
 *
 * Pure so every state can be asserted by name rather than the two that happen
 * to occur in a dev fleet.
 */
export type TurnstileSweepFacts = {
  /** A hosting project must exist — the site key is published into its env. */
  hasProject: boolean;
  /** The clone's own Supabase project must exist — the secret is written to it. */
  backendReady: boolean;
  identity: TurnstileIdentityRow | null;
  /** What the clone's hostnames say the widget should cover, right now. */
  wantedDomains: string[];
  /** For the cooling-off window; pass the run's own clock. */
  now: number;
};

export type TurnstileSweepAction = "provision" | "rotate" | "refresh";

export type TurnstileSweepSkip =
  /**
   * Publishing `VITE_TURNSTILE_SITE_KEY` needs a hosting project. MINTING does
   * not, which is the distinction this union used to collapse: a single
   * `no_hosting_project` refused the whole act, so a manually served clone —
   * which is every clone in this fleet — never got a widget at all.
   */
  | "no_hosting_project_to_publish_to"
  /** A widget scoped to no hostname issues no token anywhere. */
  | "no_hostname_yet"
  | "backend_not_ready"
  | "revoked"
  | "cooling_off"
  | "complete";

export type TurnstileSweepVerdict =
  | { act: true; action: TurnstileSweepAction; why: string }
  | { act: false; reason: TurnstileSweepSkip };

/**
 * How long to leave a failed identity alone. A sweep that retries a permanent
 * refusal every minute turns one misconfiguration into 1,440 Cloudflare calls a
 * day and buries the real errors in the log.
 */
export const TURNSTILE_SWEEP_COOLDOWN_MS = 30 * 60 * 1000;

export function decideTurnstileSweep(facts: TurnstileSweepFacts): TurnstileSweepVerdict {
  const id = facts.identity;

  // An operator deliberately took this widget away. A sweep must never read
  // that as a gap and hand it back — the same reason `decideRedeploy` refuses
  // to rebuild a `detached` deployment.
  if (id?.status === "revoked") return { act: false, reason: "revoked" };

  // The secret has to land somewhere: it is written to the clone's own
  // Supabase project, so without a ready backend there is nothing to write to.
  if (!facts.backendReady) return { act: false, reason: "backend_not_ready" };

  // NOTE what is deliberately NOT required here: a hosting project.
  //
  // This used to read `if (!facts.hasProject) return { reason:
  // "no_hosting_project" }`, justified as "a clone with no hosting project is
  // mid-pipeline, and the drain will mint its widget when it reaches
  // `syncing_env`". That is true of a clone Vercel is building and FALSE of
  // every other kind. `syncing_env` opens `if (!row.project_id) return`, and
  // provisioning writes the deployment row as `not_requested` for `manual` and
  // `none`, and `pending_platform` when no Vercel token is configured. A
  // deployment in any of those three states never advances — so the drain
  // never mints, and this sweep refused the same clone every ten minutes for
  // ever, each time naming a step that was never coming. `MODULES_TO_CLONES.md`
  // records that every clone in this fleet is served manually.
  //
  // Minting without a project was already supported: `publishSiteKey` returns
  // "no hosting project — publish the site key when one exists" rather than
  // throwing. The widget is created, the secret reaches the clone's backend,
  // and only the `VITE_TURNSTILE_SITE_KEY` publish waits. A clone with its own
  // widget and an unpublished site key is strictly better off than one with no
  // widget at all, because the second has no security check to publish.

  if (id?.last_error && id.updated_at) {
    const since = facts.now - Date.parse(id.updated_at);
    if (Number.isFinite(since) && since >= 0 && since < TURNSTILE_SWEEP_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }

  if (!id?.site_key) {
    // A widget has to be scoped to something. `provisionTurnstileIdentity`
    // refuses a clone with no resolvable hostname for the reason it states —
    // "a Turnstile widget with no domain issues no token anywhere" — so
    // refusing here saves a Cloudflare round trip rather than changing the
    // outcome.
    //
    // Asked HERE and not above, because it is a precondition of MINTING and
    // not of the identity being healthy. Hoisting it ahead of these branches
    // made an already-complete identity whose hostnames had gone away report
    // `no_hostname_yet` instead of `complete` — which the test below had
    // already pinned, for the reason it gives: reading that as drift retries
    // it every ten minutes for ever.
    if (facts.wantedDomains.length === 0) return { act: false, reason: "no_hostname_yet" };
    return { act: true, action: "provision", why: "no widget yet" };
  }

  // A widget whose secret was never delivered cannot be repaired by provision:
  // Cloudflare returns a secret on CREATE and on ROTATE and never on a read, so
  // adopting an existing widget yields nothing to write. Rotation is the only
  // operation that produces one. It is safe here and nowhere else — nothing is
  // verifying against the old secret precisely because it was never delivered.
  if (!id.secret_written_at) {
    return {
      act: true,
      action: "rotate",
      why: "widget exists but no secret ever reached the clone",
    };
  }

  if (!id.site_key_published_at) {
    // Publishing is the one step that genuinely needs a hosting project —
    // `VITE_TURNSTILE_SITE_KEY` is written to it. Acting without one would
    // re-attempt a publish that cannot succeed on every pass, for ever, and
    // bury the identities that can still be advanced under a permanent queue
    // of ones that cannot. The widget is already minted and its secret already
    // delivered by the time we get here; what is outstanding is a key the
    // operator can read off the clone page and set on their own host.
    if (!facts.hasProject) {
      return { act: false, reason: "no_hosting_project_to_publish_to" };
    }
    return { act: true, action: "provision", why: "site key not published to the deployment" };
  }

  // Domain drift is compared LOCALLY — stored list against derived list — so
  // the common case costs no Cloudflare call at all. It matters because a
  // custom domain attached after provisioning is a hostname the widget does
  // not cover, and a widget that does not cover the login page issues no
  // token there: the sign-in button never enables.
  const have = [...(id.domains ?? [])].sort().join(",");
  const want = [...facts.wantedDomains].sort().join(",");
  if (facts.wantedDomains.length > 0 && have !== want) {
    return { act: true, action: "refresh", why: "the clone's hostnames changed" };
  }

  return { act: false, reason: "complete" };
}
