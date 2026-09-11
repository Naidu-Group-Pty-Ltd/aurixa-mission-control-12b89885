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
    const { judgeReadiness, CAPABILITIES, anthropicAttributionConfig } = await import(
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

    /*
     * The DENOMINATOR is the clones that could carry a workspace, read the
     * same way `reconcileAnthropicWorkspaces` reads its candidates.
     *
     * Counting inside the identity table alone is tautological:
     * `workspace_id` is NOT NULL, so every row that exists has one and
     * "N of N" is true however many clones have no row at all. One attributed
     * clone beside nine unattributed ones read "1 of 1" and green — a light
     * that is true about the check and false about the world, which is the
     * failure this whole module's header exists to warn about.
     */
    const { data: backends, error: backendError } = await supabaseAdmin
      .from("clone_backends")
      .select("clone_id, supabase_project_ref")
      .not("supabase_project_ref", "is", null);

    if (identityError || backendError) {
      config.anthropic_attribution = [
        {
          label: "Per-clone workspaces",
          ok: null,
          detail: "the Anthropic identity ledger could not be read",
          remedy: "Retry; a failed read is not a missing configuration.",
        },
      ];
    } else {
      const rows = identities ?? [];
      const bootstrapNames = [
        "ANTHROPIC_FEDERATION_PRIVATE_KEY",
        "ANTHROPIC_ORGANIZATION_ID",
        "ANTHROPIC_BOOTSTRAP_RULE_ID",
        "ANTHROPIC_BOOTSTRAP_SERVICE_ACCOUNT_ID",
      ];

      // Built by the pure module, so what production computes is what a test
      // can exercise — a capability test that passed `config: {}` is how the
      // bootstrap check came to report a working Phase 1 as blocked.
      config.anthropic_attribution = anthropicAttributionConfig({
        provisionedClones: (backends ?? []).length,
        identities: rows.length,
        federated: rows.filter((r) => Boolean(r.federation_rule_id)).length,
        proved: rows.filter((r) => Boolean(r.verified_at)).length,
        failing: rows.filter((r) => Boolean(r.last_error)).length,
        bootstrapSet: bootstrapNames.filter((n) => present.has(n)).length,
        bootstrapTotal: bootstrapNames.length,
      });
    }

    return judgeReadiness({ present, config });
  });
