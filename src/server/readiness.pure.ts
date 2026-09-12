/**
 * What this deployment can actually DO, and what is stopping it.
 *
 * ## Why this exists
 *
 * The way you found out that hosting was unconfigured was a clone stuck at
 * `pending_platform` with `status_detail: "No hosting provider token
 * configured."` — a row, in a table, that nothing surfaced. Every credential
 * gap in this platform reports the same way: not at all, until the feature that
 * needs it is attempted and parks.
 *
 * `/api/health` already checks seven names, but it is deliberately anonymous
 * and deliberately terse — it answers a monitor, and it refuses to name a
 * missing secret to a caller holding no credential, because that is a map of
 * what is worth probing. This is the other half: admin-gated, so it can name
 * everything, and organised by CAPABILITY rather than by variable, because the
 * question an operator has is "can I clone?" and not "is `SB_ORG_ID` set?".
 *
 * ## The rule that keeps this honest
 *
 * **Presence is not validity.** Everything here reads `Boolean(process.env.X)`
 * and nothing else. A token that is set but revoked, expired, or scoped to the
 * wrong account looks exactly like a working one from here.
 *
 * So a capability is never reported as *working*. It is reported as `blocked`
 * — which this can establish, because a credential that is absent cannot
 * possibly work — or as `ready`, which means only *nothing here is missing, so
 * it is worth attempting*. Reporting "ready" as "healthy" would produce exactly
 * the class of green light this codebase keeps finding: one that is true about
 * the check and false about the world.
 *
 * Proving a credential VALID means spending it against the vendor, which costs
 * a request, a rate-limit slot and sometimes money, on a page an operator
 * refreshes. That is a different feature and it is not this one.
 *
 * ## Configuration is not always a secret
 *
 * Cloudflare needs an API token AND a zone bound in `platform_hosting_config`;
 * `cloudflare_account_id` and `cloudflare_zone_id` were both NULL while the
 * token question looked answered. A card that read only `process.env` would
 * have called DNS ready while nothing could write a record. So a capability
 * carries `config` checks beside its credentials, and both can block it.
 */

/** Present in the environment, or not. Never "valid". */
export type CredentialState = "set" | "missing";

export type CredentialCheck = {
  readonly name: string;
  /** What stops working without it, in the operator's terms. */
  readonly purpose: string;
  readonly required: boolean;
  readonly state: CredentialState;
};

/**
 * A non-secret precondition — a row, a column, a binding. Judged separately
 * from credentials because the remedy is a different place entirely: a UI
 * screen rather than a secrets panel.
 */
export type ConfigCheck = {
  readonly label: string;
  /** `null` when this side cannot answer. Never coerced to false. */
  readonly ok: boolean | null;
  readonly detail: string;
  /** Where an operator goes to fix it. */
  readonly remedy: string;
};

export type CapabilityVerdict =
  /** Nothing required is missing. NOT a claim that it works. */
  | "ready"
  /** Something required is absent, so this cannot work. */
  | "blocked"
  /** Works, with something optional absent. */
  | "degraded"
  /** A precondition this side cannot see. */
  | "unknown";

export type Capability = {
  readonly key: string;
  readonly title: string;
  /** What breaks while this is blocked. */
  readonly consequence: string;
  readonly verdict: CapabilityVerdict;
  readonly credentials: readonly CredentialCheck[];
  readonly config: readonly ConfigCheck[];
  /** One line per thing to fix, ready to render. */
  readonly blockers: readonly string[];
};

type CredentialSpec = { name: string; purpose: string; required: boolean };
type CapabilitySpec = {
  key: string;
  title: string;
  consequence: string;
  credentials: readonly CredentialSpec[];
};

/**
 * The catalog.
 *
 * Every entry was read off a call site rather than remembered:
 * `backend-provisioning.server.ts` throws `"SB_MGMT_API_TOKEN secret is not
 * configured"`, `hosting/vercel-client.ts` gates on `VERCEL_API_TOKEN`,
 * `cloudflare.functions.ts` returns `configured: false` without
 * `CLOUDFLARE_API_TOKEN`, and so on. Adding a vendor means adding it here, in
 * the order the clone pipeline needs it.
 */
export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    key: "core",
    title: "Core platform",
    consequence: "Nothing runs. The app cannot reach its own database.",
    credentials: [
      { name: "SUPABASE_URL", purpose: "This deployment's own database", required: true },
      {
        name: "SUPABASE_SERVICE_ROLE_KEY",
        purpose: "Every server-side read and write",
        required: true,
      },
      {
        name: "CREDENTIALS_ENC_KEY",
        purpose:
          "Encrypts stored clone service-role keys, database passwords and client PATs. " +
          "Unset, they are written in plaintext into columns named `..._ciphertext`.",
        required: true,
      },
      {
        name: "CRON_SECRET",
        purpose: "Authenticates all 34 scheduled workers and the migration pipeline",
        required: true,
      },
    ],
  },
  {
    key: "clone_backend",
    title: "Clone backend provisioning",
    consequence:
      "A clone cannot get its own Supabase project. Provisioning stops before anything is created.",
    credentials: [
      {
        name: "SB_MGMT_API_TOKEN",
        purpose: "Creates the clone's Supabase project (supabase.com → account → tokens)",
        required: true,
      },
      {
        name: "SB_ORG_ID",
        purpose: "Which Supabase org the project is created in",
        required: true,
      },
      {
        name: "SB_ORG_PROJECT_SOFT_LIMIT",
        purpose: "Refuses to provision past this many org projects. Defaults when unset.",
        required: false,
      },
    ],
  },
  {
    key: "repository",
    title: "Repository automation",
    consequence: "No clone repo is created, and no cascade can open a PR against an existing one.",
    credentials: [
      { name: "GITHUB_APP_ID", purpose: "Identifies the Aurixa GitHub App", required: true },
      {
        name: "GITHUB_APP_PRIVATE_KEY",
        purpose: "Signs the App's token requests",
        required: true,
      },
      {
        name: "GITHUB_APP_INSTALLATION_ID",
        purpose: "Which installation to act as",
        required: true,
      },
      {
        name: "GITHUB_WEBHOOK_SECRET",
        purpose: "Verifies inbound GitHub webhooks. Without it, events are polled instead.",
        required: false,
      },
    ],
  },
  {
    key: "hosting",
    title: "Hosting — Vercel",
    consequence:
      "A clone is never built or served. Its deployment row parks at `pending_platform`.",
    credentials: [
      {
        name: "VERCEL_API_TOKEN",
        purpose: "Creates the project and triggers builds",
        required: true,
      },
      {
        name: "VERCEL_TEAM_ID",
        purpose: "Only needed when the Vercel account is a Team rather than personal",
        required: false,
      },
      {
        name: "VERCEL_WEBHOOK_SECRET",
        purpose: "Push build status. Without it, build state is polled and lags.",
        required: false,
      },
    ],
  },
  {
    key: "dns",
    title: "DNS & CAPTCHA — Cloudflare",
    consequence:
      "A clone builds and serves, but its subdomain never resolves and it gets no Turnstile " +
      "widget of its own — so its login page cannot answer its own security check.",
    credentials: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        purpose:
          "Writes the clone's CNAME and mints its own Turnstile widget. Needs Zone:DNS:Edit, " +
          "Zone:Zone:Read AND Account:Turnstile:Edit — the first two verify as an active token " +
          "and refuse widget creation, so scope is not something token validity reports.",
        required: true,
      },
    ],
  },
  {
    key: "email",
    title: "Outbound email — Resend",
    consequence:
      "A clone cannot be given a sending identity of its own, so its outbound mail either " +
      "rides the prime's shared key or does not send at all — password resets, portal " +
      "invites and notifications included.",
    credentials: [
      {
        name: "RESEND_MASTER_API_KEY",
        purpose:
          "Full-access key on the platform's own Resend team. Used for exactly two things: " +
          "registering each clone's sending domain, and minting that clone's key. It is " +
          "NEVER written to a clone — what a clone receives is a sending_access key scoped " +
          "by domain_id, which cannot list domains, mint keys, or send as anybody else.",
        required: true,
      },
    ],
  },
  {
    key: "agreements",
    title: "Agreements — DocuSign",
    consequence:
      "A signed agreement cannot provision a clone. Drafts can still be prepared and the " +
      "operator wizard still works; only the signature-driven path is dormant.",
    credentials: [
      {
        name: "DOCUSIGN_INTEGRATION_KEY",
        purpose: "The app's integration key (GUID) — Settings → Apps & Keys",
        required: true,
      },
      {
        name: "DOCUSIGN_USER_ID",
        purpose: "API User ID of the impersonated user; JWT grant acts as them",
        required: true,
      },
      {
        name: "DOCUSIGN_RSA_PRIVATE_KEY",
        purpose:
          "Private half of the integration key's RSA pair. PKCS#1 is converted and escaped " +
          "newlines are normalised, so paste it as the console gives it.",
        required: true,
      },
      { name: "DOCUSIGN_ACCOUNT_ID", purpose: "API Account ID (GUID)", required: true },
      {
        name: "DOCUSIGN_CONNECT_HMAC_KEY",
        purpose:
          "Signs Connect deliveries. Unset, the webhook answers 503 to EVERY delivery — it " +
          "refuses to act on an unauthenticated one — so signature-driven provisioning waits " +
          "for the 10-minute poll instead of being instant.",
        required: true,
      },
      {
        name: "DOCUSIGN_BASE_URL",
        purpose:
          "REST base. Defaults to demo; a production account must set its own (this one is " +
          "https://au.docusign.net/restapi). Wrong here and the OAuth host is wrong too, " +
          "because it is derived from this.",
        required: false,
      },
      {
        name: "DOCUSIGN_COUNTERSIGNER_EMAIL",
        purpose: "An Aurixa signatory routed SECOND. Omit and the envelope is client-only.",
        required: false,
      },
    ],
  },
  {
    key: "billing",
    title: "Billing — Stripe",
    consequence: "Plans, seats and add-ons cannot be charged or reconciled.",
    credentials: [
      { name: "STRIPE_SECRET_KEY", purpose: "Charges, subscriptions, seats", required: true },
      {
        name: "STRIPE_WEBHOOK_SECRET",
        purpose: "Verifies Stripe callbacks; without it payment state drifts",
        required: true,
      },
    ],
  },
  {
    key: "models",
    title: "Model routing",
    consequence: "Anything that calls a model — report prose, analysis, the design agent — fails.",
    credentials: [
      {
        name: "LOVABLE_API_KEY",
        purpose: "The gateway every model call goes through",
        required: true,
      },
      {
        name: "OPENAI_API_KEY",
        purpose: "Codex security scans and remediation patches",
        required: false,
      },
    ],
  },
  {
    /*
     * Separate from `models` on purpose. That capability asks whether a model
     * call can be made at all; this one asks whose line it lands on, and the
     * two fail independently — every clone can be calling Claude perfectly
     * while the whole fleet's spend arrives as one undifferentiated figure.
     *
     * Anthropic publishes no endpoint that creates an API key, so the
     * per-clone credential the other four model vendors get cannot exist. The
     * unit of attribution is the WORKSPACE, which is creatable, and federation
     * then removes the key entirely.
     */
    key: "anthropic_attribution",
    title: "Anthropic attribution",
    consequence:
      "Every clone's Claude usage lands on one organisation line, so no tenant can be recharged for what they actually spent.",
    credentials: [
      {
        name: "ANTHROPIC_ADMIN_KEY",
        purpose:
          "Creates a workspace per clone, which is what makes that clone's model spend a separate figure. Not the key a clone spends — an Admin key manages the organisation and cannot make a model call",
        required: true,
      },
      /*
       * The four below are Phase 2 and all-or-nothing: absent any one of them
       * every clone keeps the organisation key and its own workspace header,
       * which is a working deployment rather than a broken one. So they are
       * optional — the capability reads `degraded`, which is exactly the
       * truth, and the config check beside them says how far it has got.
       */
      {
        name: "ANTHROPIC_FEDERATION_PRIVATE_KEY",
        purpose:
          "Signs the short-lived assertion that lets a clone obtain a token with no key of its own (PKCS8 PEM)",
        required: false,
      },
      {
        name: "ANTHROPIC_ORGANIZATION_ID",
        purpose: "Names the organisation a clone's token is minted in",
        required: false,
      },
      {
        name: "ANTHROPIC_BOOTSTRAP_RULE_ID",
        purpose:
          "The one federation rule a person creates in the Claude Console; Anthropic refuses to let a workload grant itself organisation-admin",
        required: false,
      },
      {
        name: "ANTHROPIC_BOOTSTRAP_SERVICE_ACCOUNT_ID",
        purpose: "The service account that rule targets",
        required: false,
      },
    ],
  },
  {
    /*
     * Minting a per-clone key at the four vendors that publish an endpoint for
     * it. Separate from `anthropic_attribution` because Anthropic is the one
     * that CANNOT — no endpoint of theirs creates an API key — so a capability
     * covering all five would have to report a permanent, correct state as a
     * gap.
     *
     * Every credential here is OPTIONAL, and that is the design rather than
     * caution. A fleet with none of them set runs on the prime's forwarded
     * keys, metered and recharged per tenant; minting improves the ATTRIBUTION
     * at the vendor's own dashboard and is never worth a clone that will not
     * start, which is why `llmKeyProvisioning.server.ts` refuses to fail a
     * provisioning run for it.
     *
     * They are independent of one another too. OpenAI on and Perplexity off is
     * a deliberate state, not a half-finished one — so there is no
     * all-or-nothing rule of the kind the federation bootstrap needs.
     */
    key: "llm_key_provisioning",
    title: "Per-clone model keys",
    consequence:
      "Every clone spends the prime's own forwarded model keys, so each vendor's dashboard shows one figure for the whole fleet and per-tenant spend can only be reconstructed from our own meter.",
    credentials: [
      {
        name: "OPENROUTER_PROVISIONING_KEY",
        purpose:
          "Mints one OpenRouter key per clone. The only vendor of the five whose minted key carries its own spend ceiling, so a runaway workspace is bounded by the vendor rather than by our meter noticing afterwards",
        required: false,
      },
      {
        name: "OPENAI_ADMIN_KEY",
        purpose:
          "An organisation Admin key (sk-admin-...), never a project key. Creates one OpenAI project per clone and a service account inside it, because OpenAI reports spend per project",
        required: false,
      },
      {
        name: "PERPLEXITY_PROVISIONING_KEY",
        purpose:
          "An existing Perplexity key, used as the authority to mint one per clone within the API group",
        required: false,
      },
      {
        name: "GOOGLE_APIKEYS_SERVICE_ACCOUNT",
        purpose:
          "Mints one Google Cloud API key per clone, restricted to the Generative Language API. Needs GOOGLE_APIKEYS_PROJECT_ID beside it",
        required: false,
      },
      {
        name: "GOOGLE_APIKEYS_PROJECT_ID",
        purpose: "The Google Cloud project those keys are created in",
        required: false,
      },
    ],
  },
];

export type ReadinessInput = {
  /** Names present in the environment. Values are never passed in. */
  readonly present: ReadonlySet<string>;
  /** Extra, non-secret preconditions, keyed by capability. */
  readonly config: Readonly<Record<string, readonly ConfigCheck[]>>;
};

export type ReadinessReport = {
  readonly capabilities: readonly Capability[];
  /** Capabilities that cannot work. The only number worth acting on. */
  readonly blocked: number;
  readonly degraded: number;
  readonly unknown: number;
  /** True when nothing required is missing anywhere. */
  readonly cloneReady: boolean;
  /**
   * What these verdicts are allowed to mean. Carried ON the report rather
   * than imported by whatever renders it: a caller cannot hold the answer
   * without also holding the qualification on it.
   */
  readonly caveat: string;
};

/** The capabilities a clone needs end to end, in the order it needs them. */
export const CLONE_PATH = ["core", "clone_backend", "repository", "hosting", "dns"] as const;

export function judgeReadiness(input: ReadinessInput): ReadinessReport {
  const capabilities: Capability[] = CAPABILITIES.map((spec) => {
    const credentials: CredentialCheck[] = spec.credentials.map((c) => ({
      ...c,
      state: input.present.has(c.name) ? "set" : "missing",
    }));
    const config = input.config[spec.key] ?? [];

    const missingRequired = credentials.filter((c) => c.required && c.state === "missing");
    const missingOptional = credentials.filter((c) => !c.required && c.state === "missing");
    const failedConfig = config.filter((c) => c.ok === false);
    // `null` is "this side cannot answer". It must never collapse into either
    // direction: false would raise a false alarm, true would hide a real gap.
    const unknownConfig = config.filter((c) => c.ok === null);

    const blockers = [
      ...missingRequired.map((c) => `${c.name} is not set — ${c.purpose}`),
      ...failedConfig.map((c) => `${c.detail} — ${c.remedy}`),
    ];

    let verdict: CapabilityVerdict;
    if (blockers.length > 0) verdict = "blocked";
    else if (unknownConfig.length > 0) verdict = "unknown";
    else if (missingOptional.length > 0) verdict = "degraded";
    else verdict = "ready";

    return {
      key: spec.key,
      title: spec.title,
      consequence: spec.consequence,
      verdict,
      credentials,
      config,
      blockers,
    };
  });

  const count = (v: CapabilityVerdict) => capabilities.filter((c) => c.verdict === v).length;

  return {
    capabilities,
    blocked: count("blocked"),
    degraded: count("degraded"),
    unknown: count("unknown"),
    // Only the clone path decides this. A blocked Stripe is a real problem and
    // is NOT a reason to tell somebody they cannot clone — conflating the two
    // is how a readiness screen stops being read.
    cloneReady: capabilities
      .filter((c) => (CLONE_PATH as readonly string[]).includes(c.key))
      .every((c) => c.verdict !== "blocked"),
    caveat: PRESENCE_CAVEAT,
  };
}

/**
 * What "ready" is allowed to mean, rendered wherever a verdict is.
 *
 * Declared here and returned as `ReadinessReport.caveat` rather than imported
 * by the component: it is part of the answer, not decoration around it, so a
 * redesign that drops it has to drop a field off the payload rather than
 * delete a line of JSX.
 *
 * Shipping it on the report is also what keeps this module server-only. It
 * lives under `src/server/**`, which TanStack Start's import-protection plugin
 * denies to the client bundle — a component importing this VALUE fails the
 * build (importing the types is fine; they erase). Answering with the caveat
 * rather than exporting it to the renderer satisfies both constraints at once.
 */
export const PRESENCE_CAVEAT =
  "Presence only. A credential that is set may still be revoked, expired or " +
  "scoped to the wrong account — proving one valid means spending it against " +
  "the vendor, which this page deliberately does not do.";

/** What the Anthropic attribution checks are computed from. */
/** One vendor's minting state, as the two tables hold it. */
export interface LlmProviderFacts {
  readonly label: string;
  /** Mission Control holds the credential that authorises minting. */
  readonly credentialPresent: boolean;
  /**
   * Clones that could carry a minted key — a backend exists and the ledger
   * does not stand the clone down. A tenant's own key and a withheld one are
   * both correct states that must leave the denominator rather than fail it,
   * exactly as they do for the Anthropic workspace count.
   */
  readonly eligible: number;
  /** Of those, how many carry `minted`. */
  readonly minted: number;
}

export interface LlmProvisioningFacts {
  readonly providers: readonly LlmProviderFacts[];
  /**
   * Vendors that publish no endpoint which creates a key.
   *
   * Named rather than omitted. A reader who sees four vendors where the
   * product has five goes looking for a credential that cannot exist, which is
   * the wasted search `manualRemedy` exists to prevent.
   */
  readonly consoleOnly: readonly string[];
}

/**
 * The per-clone model key checks.
 *
 * Two rules, and both are the OPPOSITE of the federation bootstrap's beside
 * them, which is why they are written down rather than inferred from it.
 *
 * **Nothing configured is not a fault.** A fleet with no provisioning
 * credential runs on the prime's forwarded keys, metered and recharged. That
 * is the documented working state, so it reads `null` — nothing measured — and
 * never `false`, which `judgeReadiness` turns into a blocker.
 *
 * **Partial is not a fault either.** Each credential is its own switch, so
 * OpenAI on and Perplexity off is a choice. The bootstrap's all-or-nothing
 * rule exists because four values that cannot mint a token together are an
 * outage; nothing of that kind is true here.
 *
 * What IS worth alarming on is a credential that is set and producing nothing:
 * minting switched on, clones eligible, not one key minted. That state is
 * otherwise invisible, because a mint failure is deliberately never written to
 * the ledger — the clone is still running correctly on the forwarded key, and
 * marking it `failed` would stop its usage being recharged.
 */
export function llmProvisioningConfig(facts: LlmProvisioningFacts): ConfigCheck[] {
  const on = facts.providers.filter((p) => p.credentialPresent);
  const consoleOnly =
    facts.consoleOnly.length > 0
      ? ` ${facts.consoleOnly.join(", ")} publishes no endpoint that creates a key, so no credential exists for it.`
      : "";

  if (on.length === 0) {
    return [
      {
        label: "Minting",
        ok: null,
        detail: `No provisioning credential is set, so every clone spends the prime's forwarded model keys.${consoleOnly}`,
        remedy:
          "Optional. Set any provisioning credential in Mission Control's own environment; each one switches on its own vendor and nothing else changes.",
      },
    ];
  }

  // Only a switched-on vendor can be short, and only where a clone could have
  // carried a key at all.
  const measurable = on.filter((p) => p.eligible > 0);
  const short = measurable.filter((p) => p.minted < p.eligible);

  return [
    {
      label: "Minting",
      ok: true,
      detail: `${on.map((p) => p.label).join(", ")} can mint a key per clone.${consoleOnly}`,
      remedy: "Each credential is its own switch; the others are optional and independent.",
    },
    {
      label: "Per-clone coverage",
      ok: measurable.length === 0 ? null : short.length === 0,
      detail:
        measurable.length === 0
          ? "No clone is eligible for a minted key yet."
          : measurable.map((p) => `${p.label} ${p.minted} of ${p.eligible}`).join(" · "),
      remedy:
        "Clones -> the secrets reconcile hook, which mints for any clone still without one. A vendor switched on that has minted nothing is the reading to check first.",
    },
  ];
}

export interface AnthropicAttributionFacts {
  /** Clones with a backend — the population that COULD carry a workspace. */
  readonly provisionedClones: number;
  /** Rows in `clone_anthropic_identity`. */
  readonly identities: number;
  /**
   * Of those, how many are actually ATTRIBUTED — by either of the two routes
   * that settle it.
   *
   * A clone's spend lands on its own workspace when the workspace id was
   * written onto its project (`delivered_at`), OR when it holds a federated
   * credential: `ensureRule` binds the token to `workspace_id` at the vendor,
   * so a federated clone names its workspace without the header and needs no
   * delivery at all. Counting delivery alone reported a working federated
   * clone as uncovered for ever whenever the secret write had failed.
   *
   * Completed federation is the KEY LEDGER's `federated` status, never the
   * presence of a rule: `federated_at` and `federation_rule_id` are stamped
   * before `withdrawAnthropicKey` runs, so both exist on a clone whose
   * federation did not finish.
   *
   * Required rather than optional: an omitted count must never read as "all
   * attributed", which is the reading that put this check where the review
   * found it.
   */
  readonly attributed: number;
  /** Of those, how many carry a federation rule. */
  readonly federated: number;
  /** Of those, how many have proved they can reach Anthropic. */
  readonly proved: number;
  /** Of those, how many reported a fault on their last probe. */
  readonly failing: number;
  /** How many of the four federation bootstrap values are set. */
  readonly bootstrapSet: number;
  readonly bootstrapTotal: number;
}

/**
 * The Anthropic attribution config checks, as a function.
 *
 * Pure, and here rather than inline in the server function, for one reason: a
 * capability test that passed `config: {}` reported this capability as
 * `degraded` while production passed a check that made it `blocked`. The test
 * agreed with an empty fixture and disagreed with the world — the exact shape
 * of the SAMPLE_REPORT_DATA trap this codebase keeps re-finding. What the
 * server builds is now what a test can exercise.
 */
export function anthropicAttributionConfig(facts: AnthropicAttributionFacts): ConfigCheck[] {
  const {
    provisionedClones,
    identities,
    attributed,
    federated,
    proved,
    failing,
    bootstrapSet,
    bootstrapTotal,
  } = facts;

  /*
   * Coverage is ATTRIBUTED, never merely recorded.
   *
   * It was `identities` — the count of rows that exist — which reported N of N
   * and green over exactly the gap this check was built to find, for the whole
   * fleet, the moment `20260911090000` clears every presumed stamp.
   *
   * It is not `delivered` either, which was the first correction and was too
   * narrow: a federated clone is attributed by the RULE's binding rather than
   * by the header, so a persistent secret-write failure would have left a
   * working clone permanently uncovered. `attributed` is the union, and the
   * caller is the one place that computes it.
   *
   * `federated`, `proved` and `failing` deliberately stay on `identities`:
   * a federation rule, a reachability probe and a recorded fault are facts
   * about the identity record, and each is true whether or not the id was
   * delivered.
   */
  const withWorkspace = attributed;

  return [
    {
      label: "Per-clone workspaces",
      /*
       * The denominator is the clones that COULD carry a workspace, never the
       * identity table: `workspace_id` is NOT NULL, so counting inside that
       * table is tautologically "N of N" however many clones have no row —
       * one attributed clone beside nine unattributed read "1 of 1" and green.
       *
       * Zero provisioned clones is a real answer rather than a fault.
       */
      ok: provisionedClones === 0 ? null : withWorkspace >= provisionedClones,
      detail:
        provisionedClones === 0
          ? "No clone has a backend to attribute yet"
          : `${withWorkspace} of ${provisionedClones} provisioned clones carry their own Anthropic workspace`,
      remedy: "Clones → the secrets reconcile hook, which provisions any that are missing",
    },
    {
      label: "Federation bootstrap",
      /*
       * Absent ENTIRELY is not a failure. Phase 1 — a workspace per clone,
       * every clone still on the organisation key — is a working deployment,
       * which is why these four are declared optional. `judgeReadiness` turns
       * any false config check into a blocker AHEAD of the optional flags, so
       * `false` here reported the documented working setup as broken.
       *
       * PARTIAL is the failure: four names look like configuration while a
       * rule that cannot mint a token looks like an outage.
       */
      ok: bootstrapSet === 0 ? true : bootstrapSet === bootstrapTotal,
      detail:
        bootstrapSet === bootstrapTotal
          ? `Federation is configured; ${federated} of ${provisionedClones} provisioned clones hold no Anthropic key at all`
          : bootstrapSet === 0
            ? "Federation is not configured, so every clone keeps the organisation key and its own workspace header"
            : `Only ${bootstrapSet} of ${bootstrapTotal} federation values are set, which cannot mint a token`,
      remedy:
        "Create one org:admin federation rule in the Claude Console against a dedicated issuer, then set the four ANTHROPIC_* values it returns",
    },
    {
      label: "Proved reachable",
      /*
       * EVERY identity, not merely one. `proved > 0` went green the moment a
       * single clone was probed, because an unprobed clone has neither a stamp
       * nor an error — so 1 of 100 read as proved while ninety-nine clones'
       * keys, scopes and rules stayed unverified, with the detail line saying
       * "1 of 100" right beside the green.
       */
      ok: identities === 0 ? null : failing === 0 && proved >= identities,
      detail:
        identities === 0
          ? "Nothing to probe yet"
          : `${proved} of ${identities} clones with an identity have proved they can reach Anthropic` +
            (failing > 0 ? `; ${failing} reported a fault on the last probe` : ""),
      remedy: "Clones → a clone → Anthropic attribution → Run self-test",
    },
  ];
}
