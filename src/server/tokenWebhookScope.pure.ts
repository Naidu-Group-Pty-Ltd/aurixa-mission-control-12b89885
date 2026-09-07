/**
 * Who a token webhook endpoint is allowed to be.
 *
 * ## The hazard
 *
 * `fireTokenWebhook` matches an endpoint like this:
 *
 * ```ts
 * if (e.clone_id == null) return true;                 // fleet-wide
 * return cloneId == null ? false : e.clone_id === cloneId;
 * ```
 *
 * A row with no `clone_id` therefore receives EVERY tenant's
 * `tokens.balance.updated`, `tokens.key.rotated`, `tokens.key.revoked` and
 * `tokens.alert` — payloads carrying `clone_id`, key ids, key prefixes and
 * balances. The register calls that scope "all clones", which is exactly what
 * it is and reads in the UI like a soft default.
 *
 * The database held one such row, created 18 May 2026, active, subscribed to
 * all four events, pointing at `https://command-centre.npc.services.com.au` —
 * a misspelling of `npcservices.com.au`, and the PRIME's own marketing site
 * rather than its `mission-control-webhook` function. Every delivery since May
 * answered Cloudflare `error code: 1016` (origin DNS), so nothing has ever
 * leaked. That is the whole of the protection: a typo.
 *
 * Correct the hostname — which looks like an obvious tidy-up, one character —
 * and every tenant's token events begin arriving at one tenant's origin. The
 * fix is not to correct the typo.
 *
 * ## The rule
 *
 * **A fleet-wide endpoint may not be a tenant's own host.** A scope that
 * receives every tenant's events must be somewhere that belongs to no single
 * tenant; the moment it resolves to one, that tenant is reading the others'.
 * Per-clone endpoints are unaffected — an endpoint scoped to a clone pointing
 * at that clone's host is the ordinary, correct arrangement, and every clone
 * now has one.
 *
 * It is enforced in both places, because one is where the mistake is made and
 * the other is where it would be paid for: `upsertWebhookEndpoint` refuses to
 * store it, and `fireTokenWebhook` refuses to deliver it — a row written
 * before this rule existed, or by any other path, must not be able to ship a
 * single event.
 *
 * Nothing here guesses. The tenant hosts are read from the clones the fleet
 * actually has, and an endpoint whose host matches none of them is allowed:
 * refusing on a hunch would break a legitimate aggregator, and this is
 * defending against a URL that demonstrably belongs to a tenant.
 */

/** Lowercased, port-stripped host of a URL, or null if it will not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.trim().toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

/**
 * `a.b.example.com` is "at" `example.com`. Compared on label boundaries so
 * `notexample.com` is not at `example.com`.
 */
export function hostIsAt(host: string, suffix: string): boolean {
  if (host === suffix) return true;
  return host.endsWith(`.${suffix}`);
}

export type TenantHost = {
  /** The clone this host belongs to — null for the prime's own hosts. */
  cloneId: string | null;
  /** A label for the refusal message. Never a credential. */
  label: string;
  host: string;
};

export type ScopeRefusal = {
  reason: "fleet_wide_endpoint_is_a_tenant_host" | "unparseable_url";
  message: string;
};

/**
 * Why this endpoint may not exist, or null if it may.
 *
 * `cloneId` is the endpoint's scope: null means fleet-wide.
 */
export function webhookEndpointRefusal(
  url: string,
  cloneId: string | null | undefined,
  tenantHosts: readonly TenantHost[],
): ScopeRefusal | null {
  const host = hostOf(url);
  if (!host) {
    return {
      reason: "unparseable_url",
      message: `"${url}" is not a URL with a host, so there is nothing to deliver to.`,
    };
  }

  // A scoped endpoint is somebody's own receiver by design. Only the
  // fleet-wide scope is constrained.
  if (cloneId != null) return null;

  const owner = tenantHosts.find((t) => hostIsAt(host, t.host));
  if (!owner) return null;

  return {
    reason: "fleet_wide_endpoint_is_a_tenant_host",
    message:
      `An endpoint with no clone scope receives every tenant's token events, and ${host} ` +
      `belongs to ${owner.label}. Pointing the fleet-wide scope at one tenant's host hands ` +
      `that tenant the others' balances, key ids and alerts. Scope this endpoint to ${owner.label}, ` +
      `or give the fleet-wide endpoint a host that belongs to no single tenant.`,
  };
}

/**
 * Build the tenant-host list from what the fleet holds.
 *
 * Every host a tenant answers on: its custom domain, its subdomain under the
 * platform zone, its hosting-provider URL, and its Supabase project host —
 * plus the prime's own project host, because the prime is a tenant of this
 * control plane too (it holds a key and meters against it).
 */
export function tenantHostsFrom(input: {
  clones: readonly {
    id: string;
    name: string | null;
    deploy_url: string | null;
    subdomain_fqdn: string | null;
  }[];
  deployments: readonly { clone_id: string; domain: string | null }[];
  backends: readonly { clone_id: string; supabase_project_ref: string | null }[];
  primeProjectRef?: string | null;
}): TenantHost[] {
  const out: TenantHost[] = [];
  const seen = new Set<string>();
  const push = (cloneId: string | null, label: string, raw: string | null | undefined) => {
    if (!raw) return;
    const host = raw.includes("://") ? hostOf(raw) : raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host) return;
    const key = `${cloneId ?? "prime"}:${host}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cloneId, label, host });
  };

  const nameOf = new Map(input.clones.map((c) => [c.id, c.name ?? "a clone"]));
  for (const c of input.clones) {
    push(c.id, c.name ?? "a clone", c.deploy_url);
    push(c.id, c.name ?? "a clone", c.subdomain_fqdn);
  }
  for (const d of input.deployments) push(d.clone_id, nameOf.get(d.clone_id) ?? "a clone", d.domain);
  for (const b of input.backends) {
    if (b.supabase_project_ref) {
      push(b.clone_id, nameOf.get(b.clone_id) ?? "a clone", `${b.supabase_project_ref}.supabase.co`);
    }
  }
  if (input.primeProjectRef) {
    push(null, "the prime", `${input.primeProjectRef}.supabase.co`);
  }
  return out;
}
