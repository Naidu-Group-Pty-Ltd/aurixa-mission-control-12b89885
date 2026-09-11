// What this deployment can do, and what is stopping it.
//
// Admin-gated on purpose. `/api/health` answers anonymous monitors and
// deliberately refuses to NAME a missing secret to a caller holding no
// credential, because that is a map of what is unconfigured and therefore worth
// probing. This is the other half of that trade: an operator who is already
// authenticated gets the names, because they are the person who has to fix it.
//
// Values are never read. Only `Boolean(process.env.X)`, and only on the server.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import type { ReadinessReport, ConfigCheck } from "@/server/readiness.pure";

export type { ReadinessReport } from "@/server/readiness.pure";

export const fetchReadiness = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<ReadinessReport> => {
    const { supabaseAdmin } = await import(
      /* @vite-ignore */ "@/integrations/supabase/client.server"
    );
    const { judgeReadiness, CAPABILITIES } = await import(
      /* @vite-ignore */ "@/server/readiness.pure"
    );

    // Presence, gathered from the catalog rather than from a second list. Two
    // lists of credential names is how one of them goes stale and a gap stops
    // being reported.
    const present = new Set<string>();
    for (const cap of CAPABILITIES) {
      for (const cred of cap.credentials) {
        if (process.env[cred.name]) present.add(cred.name);
      }
    }

    // Non-secret preconditions. A read that FAILS is `null` — "this side cannot
    // answer" — and never `false`, which would raise an alarm about a database
    // blip rather than about the configuration.
    const config: Record<string, ConfigCheck[]> = {};

    const { data: hosting, error: hostingError } = await supabaseAdmin
      .from("platform_hosting_config")
      .select(
        "hosting_provider_slug, cloudflare_account_id, cloudflare_zone_id, cloudflare_zone_name, primary_domain",
      )
      .limit(1)
      .maybeSingle();

    if (hostingError) {
      const unreadable: ConfigCheck = {
        label: "Hosting configuration",
        ok: null,
        detail: "platform_hosting_config could not be read",
        remedy: "Retry; if it persists the database is the problem, not the configuration.",
      };
      config.dns = [unreadable];
      config.hosting = [unreadable];
    } else {
      // The token alone is not enough: `cloudflare_account_id` and
      // `cloudflare_zone_id` were both NULL while the token question looked
      // answered, and nothing could write a DNS record.
      const zoneBound = Boolean(hosting?.cloudflare_account_id && hosting?.cloudflare_zone_id);
      config.dns = [
        {
          label: "Cloudflare zone bound",
          ok: zoneBound,
          detail: zoneBound
            ? `Zone ${hosting?.cloudflare_zone_name ?? "(unnamed)"} is bound`
            : "No Cloudflare account and zone are bound, so no DNS record can be written",
          remedy: "Settings → Domains: pick the account and zone",
        },
      ];
      config.hosting = [
        {
          label: "Platform hosting provider",
          ok: Boolean(hosting?.hosting_provider_slug),
          detail: hosting?.hosting_provider_slug
            ? `Clones deploy to ${hosting.hosting_provider_slug}`
            : "No default hosting provider is set, so a new clone gets no deployment",
          remedy: "Settings → Domains",
        },
      ];
    }

    const { data: prime, error: primeError } = await supabaseAdmin
      .from("prime_config")
      .select("github_owner, github_repo, supabase_project_ref")
      .limit(1)
      .maybeSingle();

    config.repository = primeError
      ? [
          {
            label: "Prime repository",
            ok: null,
            detail: "prime_config could not be read",
            remedy: "Retry; a failed read is not a missing configuration.",
          },
        ]
      : [
          {
            label: "Prime repository",
            ok: Boolean(prime?.github_owner && prime?.github_repo),
            detail:
              prime?.github_owner && prime?.github_repo
                ? `Cloning from ${prime.github_owner}/${prime.github_repo}`
                : "No prime repository is configured, so there is nothing to clone from",
            remedy: "Settings → the prime configuration",
          },
        ];

    config.clone_backend = primeError
      ? []
      : [
          {
            label: "Prime backend ref",
            ok: Boolean(prime?.supabase_project_ref),
            detail: prime?.supabase_project_ref
              ? `Schema is introspected from ${prime.supabase_project_ref}`
              : "No prime backend ref, so a new clone has no schema to copy",
            remedy: "Settings → the prime configuration",
          },
        ];

    /*
     * Anthropic attribution is measured from the LEDGER, not from the
     * environment, because the environment cannot tell you whether anything
     * happened. Five names being set is the precondition; how many clones
     * actually carry a workspace, and how many have stopped needing a key at
     * all, is the outcome — and those are the two questions an operator is
     * really asking.
     */
    const { data: identities, error: identityError } = await supabaseAdmin
      .from("clone_anthropic_identity")
      .select("clone_id, workspace_id, federation_rule_id, verified_at, last_error");

    if (identityError) {
      config.anthropic_attribution = [
        {
          label: "Per-clone workspaces",
          ok: null,
          detail: "clone_anthropic_identity could not be read",
          remedy: "Retry; a failed read is not a missing configuration.",
        },
      ];
    } else {
      const rows = identities ?? [];
      const withWorkspace = rows.filter((r) => Boolean(r.workspace_id)).length;
      const federated = rows.filter((r) => Boolean(r.federation_rule_id)).length;
      const proved = rows.filter((r) => Boolean(r.verified_at)).length;
      const failing = rows.filter((r) => Boolean(r.last_error)).length;

      const bootstrapNames = [
        "ANTHROPIC_FEDERATION_PRIVATE_KEY",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_BOOTSTRAP_RULE_ID",
        "ANTHROPIC_BOOTSTRAP_SERVICE_ACCOUNT_ID",
      ];
      const bootstrapSet = bootstrapNames.filter((n) => present.has(n)).length;

      config.anthropic_attribution = [
        {
          label: "Per-clone workspaces",
          // Zero is a real answer rather than a fault: a fleet with no clone
          // provisioned since this shipped has nothing to attribute yet.
          ok: rows.length === 0 ? null : withWorkspace === rows.length,
          detail:
            rows.length === 0
              ? "No clone carries an Anthropic identity yet"
              : `${withWorkspace} of ${rows.length} clones carry their own Anthropic workspace`,
          remedy: "Clones → the secrets reconcile hook, which provisions any that are missing",
        },
        {
          label: "Federation bootstrap",
          /*
           * All four or none. Anthropic refuses to let a workload grant itself
           * organisation-admin, so the rule behind these is a person's one act
           * in the Console — partial is the state that produces a confusing
           * failure, because four names look like configuration and a rule
           * that does not exist looks like an outage.
           */
          ok: bootstrapSet === 0 ? false : bootstrapSet === bootstrapNames.length,
          detail:
            bootstrapSet === bootstrapNames.length
              ? `Federation is configured; ${federated} of ${rows.length} clones hold no Anthropic key at all`
              : bootstrapSet === 0
                ? "Federation is not configured, so every clone keeps the organisation key and its own workspace header"
                : `Only ${bootstrapSet} of ${bootstrapNames.length} federation values are set, which cannot mint a token`,
          remedy:
            "Create one org:admin federation rule in the Claude Console against a dedicated issuer, then set the four ANTHROPIC_* values it returns",
        },
        {
          label: "Proved reachable",
          /*
           * Configuration is not reachability. Every reading above is true
           * about this side and says nothing about whether a clone can obtain
           * a credential — which is the fault this platform has already had on
           * three tenants that were green and had never completed a single
           * verification.
           */
          ok: rows.length === 0 ? null : failing === 0 && proved > 0,
          detail:
            rows.length === 0
              ? "Nothing to probe yet"
              : `${proved} of ${rows.length} clones have proved they can reach Anthropic` +
                (failing > 0 ? `; ${failing} reported a fault on the last probe` : ""),
          remedy: "Clones → a clone → Anthropic attribution → Run self-test",
        },
      ];
    }

    return judgeReadiness({ present, config });
  });
