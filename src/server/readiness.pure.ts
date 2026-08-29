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
