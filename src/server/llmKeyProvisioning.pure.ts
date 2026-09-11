/**
 * A model key per clone, minted on our account — and the one decision that
 * keeps it from costing us money instead of attributing it.
 *
 * ## What this is for
 *
 * Aurixa supplies the model keys a workspace boots with: OpenAI, Gemini,
 * Anthropic, Perplexity and OpenRouter, all on Aurixa's own provider accounts.
 * Today every clone gets the SAME forwarded key, so the provider's own
 * dashboard shows one undifferentiated bill and the only per-tenant figure
 * anywhere is the one this platform computes for itself from
 * `api_usage_events`. Minting a key per clone makes the vendor's own ledger
 * agree with ours — which is what makes a disputed charge answerable.
 *
 * ## Four of the five can be minted. One cannot, and that is final.
 *
 * Measured 10 Sep 2026 against each vendor's published API:
 *
 *   OpenRouter   `POST /api/v1/keys` under a provisioning key. Carries a
 *                per-key credit `limit` and `limit_reset`, can be disabled by
 *                PATCH and deleted. The only one that can cap its own spend.
 *   OpenAI       `POST /v1/organization/projects`, then
 *                `/projects/{id}/service_accounts`, which returns the key
 *                unredacted exactly once. Per-project spend is a first-class
 *                reading in OpenAI's own dashboard.
 *   Perplexity   `POST /generate_auth_token`, revoked by `/revoke_auth_token`.
 *   Gemini       `apikeys.googleapis.com/v2/…/keys` is a long-running
 *                operation and the value is fetched separately with
 *                `getKeyString`; restrictable to the Generative Language API.
 *   Anthropic    **No such endpoint exists.** From its own documentation:
 *                "Can I create new API keys through the Admin API? No. You
 *                create API keys in the Claude Console."
 *
 * Anthropic is therefore `console_only`, and this module SAYS that rather than
 * reporting a missing credential. The distinction is the whole reason the
 * field exists: "we hold no provisioning key for this vendor" sends an
 * operator to go and set one, and for Anthropic there is nothing to set. Its
 * workspaces ARE creatable through the Admin API and its keys are
 * workspace-scoped with spend limits, so the attribution is reachable — by a
 * person, once, in the Console — and the remedy names that instead.
 *
 * ## The rule that carries the money
 *
 * A minted key is still AURIXA'S money. It is not the tenant's, and recording
 * it like one is the reported failure inverted.
 *
 * `resolve_api_key_billability` reads `clone_backend_secrets.status` and rates
 * `inherited` billable, `set` as `byok` — not billable, zero cost — and
 * **everything it does not recognise as `no_key`, which is also not billable**.
 * So a minted key recorded as `set` would be charged at nothing, and a minted
 * key recorded under a new status the function was never taught would ALSO be
 * charged at nothing. Both spend Aurixa's money and recharge no one, silently,
 * and the ledger would look healthy throughout.
 *
 * `MINTED_STATUS` is that new status, and `minted` must be added to the CHECK
 * constraint and to the rating function IN THE SAME MIGRATION. A test asserts
 * both, because the failure mode of getting it half-right is invisible.
 *
 * ## And a tenant's own key is never overwritten
 *
 * `set` means the workspace supplied its own credential through its
 * Integrations page, and from that moment the platform charges nothing for it.
 * Minting over it would put Aurixa back on the hook for calls the tenant
 * believes they are paying for themselves — which is exactly what the tenant
 * was promised would not happen. `tenant_supplied` is a permanent stand-down,
 * not a deferral.
 *
 * Pure: no network, no database, no Node globals.
 */

/** Every secret name a model call can spend. Mirrors the prime's `llmUsageBinding`. */
export const LLM_SECRET_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

export type LlmSecretName = (typeof LLM_SECRET_NAMES)[number];

/**
 * The ledger status a minted key carries.
 *
 * Not `set`: that means the TENANT supplied it and the platform charges
 * nothing. Not `inherited`: that means the prime's one key was forwarded, and
 * the remedy for a bad one is to fix it on Mission Control and re-forward,
 * where the remedy for a bad minted key is to revoke it at the vendor.
 */
export const MINTED_STATUS = "minted";

/** How a key for this provider comes into existence. */
export type MintMethod =
  /** A documented endpoint returns a usable key. */
  | "api"
  /** No such endpoint exists. A person creates it in the vendor's console. */
  | "console_only";

export type LlmProvider = {
  readonly secretName: LlmSecretName;
  /** The vendor, as an operator would say it. */
  readonly label: string;
  readonly mint: MintMethod;
  /**
   * The Mission Control environment variable holding the credential that
   * authorises minting. Null where no such credential can exist.
   */
  readonly provisioningEnv: string | null;
  /** What the vendor's own dashboard will attribute the spend to. */
  readonly attribution: string;
  /**
   * What an operator does when this provider cannot mint. Written for the
   * person, and never "set a credential" where no credential exists.
   */
  readonly manualRemedy: string | null;
  /** True where the vendor lets a minted key carry its own spend ceiling. */
  readonly supportsSpendCap: boolean;
};

export const LLM_PROVIDERS: readonly LlmProvider[] = [
  {
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    mint: "api",
    provisioningEnv: "OPENROUTER_PROVISIONING_KEY",
    attribution: "one OpenRouter key per clone, named for the clone",
    manualRemedy: null,
    // The only one of the five that can cap itself. Worth knowing: it is the
    // provider where a runaway workspace is bounded by the vendor rather than
    // only by our own meter noticing afterwards.
    supportsSpendCap: true,
  },
  {
    secretName: "OPENAI_API_KEY",
    label: "OpenAI",
    mint: "api",
    provisioningEnv: "OPENAI_ADMIN_KEY",
    attribution: "one OpenAI project per clone, with its own service account",
    manualRemedy: null,
    supportsSpendCap: false,
  },
  {
    secretName: "PERPLEXITY_API_KEY",
    label: "Perplexity",
    mint: "api",
    provisioningEnv: "PERPLEXITY_PROVISIONING_KEY",
    attribution: "one Perplexity key per clone within the API group",
    manualRemedy: null,
    supportsSpendCap: false,
  },
  {
    secretName: "GEMINI_API_KEY",
    label: "Gemini",
    mint: "api",
    provisioningEnv: "GOOGLE_APIKEYS_SERVICE_ACCOUNT",
    attribution: "one Google Cloud API key per clone, restricted to the Generative Language API",
    manualRemedy: null,
    supportsSpendCap: false,
  },
  {
    secretName: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    mint: "console_only",
    // Deliberately null. There IS an Admin API and it can create workspaces —
    // but it cannot create a key, so naming a credential here would promise
    // something no credential can deliver.
    provisioningEnv: null,
    attribution: "one Anthropic workspace per clone, with the key bound to it",
    manualRemedy:
      "Anthropic publishes no endpoint that creates an API key — its own documentation says so, " +
      "and an Admin key does not change that. Create this clone's workspace (the Admin API can " +
      "do that part), create one key inside it in the Claude Console, set a workspace spend " +
      "limit, and paste the key onto this clone's secrets. Nothing here is missing or " +
      "misconfigured.",
    supportsSpendCap: false,
  },
];

const BY_NAME = new Map<string, LlmProvider>(LLM_PROVIDERS.map((p) => [p.secretName, p]));

/** The provider that spends this secret, or null where the name is not a model key. */
export function llmProviderFor(secretName: string): LlmProvider | null {
  return BY_NAME.get(secretName) ?? null;
}

export type MintVerdict =
  | { act: true; provider: LlmProvider }
  | {
      act: false;
      reason:
        | "not_an_llm_secret"
        | "no_provisioning_api"
        | "no_credential"
        | "not_provisioned"
        | "tenant_supplied"
        | "withheld"
        | "already_minted";
      /** Said to an operator. Names the rule where there is nothing to fix. */
      message: string;
      /** False where nothing an operator does on this deployment would change it. */
      actionable: boolean;
    };

/**
 * Whether to mint a key for this clone and this name, from facts already read.
 *
 * Refusing is the default and every refusal says whether there is anything to
 * be done about it — because two of them mean "correct, leave it alone" and
 * treating those as faults is how a readiness panel fills with red that nobody
 * can clear.
 */
export function decideLlmKeyMint(input: {
  secretName: string;
  /** `clone_backend_secrets.status` for this clone and name, or null when absent. */
  ledgerStatus: string | null;
  /** Whether Mission Control holds this provider's provisioning credential. */
  credentialPresent: boolean;
  /** Whether the clone has a Supabase project to write onto. */
  backendProvisioned: boolean;
}): MintVerdict {
  const provider = llmProviderFor(input.secretName);
  if (!provider) {
    return {
      act: false,
      reason: "not_an_llm_secret",
      message: `${input.secretName} is not a model credential; this step does not manage it.`,
      actionable: false,
    };
  }

  /*
   * The tenant's own key wins, and it wins BEFORE everything else.
   *
   * Ordered first on purpose. A workspace that supplied its own credential is
   * charged nothing for it, and minting over that value would put Aurixa back
   * on the hook for calls the tenant believes are theirs — the reported
   * failure inverted. No provisioning credential, no backend state and no
   * later condition may reach past this.
   */
  if (input.ledgerStatus === "set") {
    return {
      act: false,
      reason: "tenant_supplied",
      message:
        `This workspace supplied its own ${provider.label} key, so it is charged nothing for ` +
        `${provider.label} calls. Minting one here would replace it and put those calls back on ` +
        `Aurixa's account.`,
      actionable: false,
    };
  }

  /*
   * A credential somebody deliberately took OFF this clone.
   *
   * `withheld` is written only by an explicit withdrawal, and its own header
   * says why: "a status that a reconcile can reach is one a reconcile can
   * reach by accident". Minting is a reconcile. Putting a fresh key on a
   * project that a person deliberately cleared would undo that decision on a
   * half-hourly schedule, and the operator who made it would have no signal
   * at all — the ledger would simply read `minted` one tick later.
   *
   * No model key is withheld today. This is here so that adding one is a
   * decision rather than a discovery.
   */
  if (input.ledgerStatus === "withheld") {
    return {
      act: false,
      reason: "withheld",
      message:
        `${provider.label} was deliberately withheld from this clone. Minting a key here would ` +
        "put one back on the project that somebody explicitly cleared.",
      actionable: false,
    };
  }

  if (input.ledgerStatus === MINTED_STATUS) {
    return {
      act: false,
      reason: "already_minted",
      message: `This clone already holds a minted ${provider.label} key.`,
      actionable: false,
    };
  }

  if (provider.mint === "console_only") {
    return {
      act: false,
      reason: "no_provisioning_api",
      message: provider.manualRemedy ?? `${provider.label} publishes no key-creation endpoint.`,
      // A person can still do it — but not by configuring anything here, which
      // is what `actionable` is about.
      actionable: false,
    };
  }

  if (!input.backendProvisioned) {
    return {
      act: false,
      reason: "not_provisioned",
      message: "This clone has no Supabase project yet, so there is nowhere to write the key.",
      actionable: false,
    };
  }

  if (!input.credentialPresent) {
    return {
      act: false,
      reason: "no_credential",
      message:
        `Mission Control holds no ${provider.provisioningEnv}, so it cannot mint a ` +
        `${provider.label} key. Set it in Mission Control's own environment; the forwarded ` +
        `fleet key keeps working until then.`,
      actionable: true,
    };
  }

  return { act: true, provider };
}

/**
 * The name a minted key carries at the vendor.
 *
 * It exists to be read by a person looking at a provider dashboard trying to
 * work out whose spend a line is, so it leads with the clone and says who
 * made it. Bounded because vendors truncate, and truncation that cuts the
 * clone name off the front would defeat the whole purpose.
 */
export function mintedKeyLabel(cloneName: string, max = 64): string {
  const base = `aurixa-${cloneName}`.replace(/\s+/g, "-").toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]/g, "").replace(/-{2,}/g, "-");
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max).replace(/-+$/, "");
}
