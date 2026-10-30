/**
 * What a handoff must decide about the credentials Aurixa pays for.
 *
 * `DEFAULT_ROTATION_PLAN` covers Stripe, Cloudflare and GitHub, and nothing
 * else (its Lovable row went with D6, below). A clone also holds the vendor
 * keys Mission Control forwarded to it, keys minted on Aurixa's own vendor
 * accounts for it, and the key that links it to Mission Control. Handed to its
 * client as it stands, the client
 * keeps spending Aurixa's accounts (key audit S4, 29 Oct 2026).
 *
 * The owner decided D6 on 30 Oct 2026: keep and bill them. A platform key
 * keeps running after handover and its usage is billed through the usage
 * forwarder, live since 09:00 that day; a key is withdrawn only when the
 * client brings its own value for it. The forwarder reports through the
 * clone's Mission Control link, so the link is never withdrawn by default:
 * billing the keys depends on it.
 *
 * So the plan's default is to keep. It still names every such key, read from
 * the clone's own ledger, so the handover records what Aurixa goes on paying
 * for, and nothing here deletes or rotates a value. Each row is bookkeeping
 * and closes on the operator's evidence (the `other` target's rule): skipped,
 * recording that the key is kept and billed, or, where the client has
 * supplied its own value through the clone's Integrations page, what replaced
 * Aurixa's and how Aurixa's was withdrawn.
 *
 * ## Not everything Aurixa supplied is billed
 *
 * The ledger also carries settings Mission Control forwards (the Listings
 * table name, the shared Didit application's workflow and thresholds, the
 * GitHub App's id) and a secret every clone shares (the one that signs Didit's
 * callbacks). They stay listed, because the handover record names everything
 * Aurixa supplied, but nothing bills them, so their rows say what each is and
 * what the operator does with it instead. What is billed is the rate table's
 * to say (`api_provider_rates`, an active billable row per key): measured 30 Oct 2026
 * it rated the seven keys on every clone's plan and none of the six others.
 *
 * ## The client's own value goes through the broker, never onto the project
 *
 * The Integrations page posts to Mission Control's broker
 * (`/api/public/integrations/secrets`), which writes the value and records it
 * `set` (`integrationLedgerStatus`). `resolve_api_key_billability` rates `set`
 * `byok`, so that record is what stops the recharge. A value put straight on
 * the client's project bypasses it: the ledger keeps Aurixa's status, so every
 * call on the client's own key goes on being recharged as Aurixa's, and the
 * passes that act on that status treat the value as Aurixa's (the fleet sweep
 * deletes a value it finds under a `federated` name, and the withdrawal levers
 * delete one under an `inherited` name). Which names the broker accepts is the
 * broker's own rule (`tenantSecretRefusal`), asked here rather than restated.
 *
 * Pure: no I/O.
 */

import { FLEET_CONFIGURATION } from "./cloneSecretForward.pure";
import { tenantSecretRefusal } from "./integrationSecretBroker.pure";

/** The ledger statuses whose value Aurixa supplied, and so must account for at handover. */
export const PLATFORM_PAID_STATUSES = ["inherited", "minted", "federated"] as const;
export type PlatformPaidStatus = (typeof PLATFORM_PAID_STATUSES)[number];

/** The clone's link to Mission Control, by the name its ledger records it under. */
export const MISSION_CONTROL_LINK_SECRET = "MISSION_CONTROL_CLONE_API_KEY";

/** The owner's decision every platform row states, in one place. */
export const D6_KEEP_AND_BILL =
  "owner decision D6, 30 Oct 2026: platform keys keep running after handover and their usage is billed through the usage forwarder";

export type PlannedRotation = {
  target: "other";
  key_ref: string;
  hint: string;
};

/** What closes a platform row by default: the key is kept, so the row is skipped, and says so. */
const KEPT =
  "By default it stays: mark this row skipped, with evidence that the key is kept and billed under D6.";

/** Where each kind of platform key came from. */
const ORIGIN: Record<PlatformPaidStatus, (name: string) => string> = {
  inherited: (name) => `${name} is Aurixa's key, forwarded by Mission Control.`,
  minted: (name) => `${name} was minted for this clone on Aurixa's own vendor account.`,
  federated: (name) => `${name} is a credential Mission Control issues for this clone.`,
};

/** The one way a client's own value replaces Aurixa's: the broker, which records it (see the header). */
const THROUGH_THE_BROKER = (name: string) =>
  `the client enters its own value for ${name} on the clone's Integrations page. Mission Control's broker writes it and records it as the client's own (\`set\`), and that record is what stops the recharge. Never set it directly on the client's project: that bypasses the record, so the client's own calls go on being recharged as Aurixa's`;

/** What withdraws Aurixa's once the ledger records the client's own value. */
const WITHDRAWAL: Record<PlatformPaidStatus, string> = {
  inherited:
    "The client's value then replaces Aurixa's on the project; record the clone's ledger reading `set` as evidence.",
  minted:
    "Once the clone's ledger reads `set`, revoke Aurixa's minted key at the vendor, and record both as evidence.",
  federated:
    "Once the clone's ledger reads `set`, end the federation, and record both as evidence.",
};

function platformHint(name: string, status: PlatformPaidStatus): string {
  const stays = `It stays after handover (${D6_KEEP_AND_BILL}).`;
  // A name the broker refuses has no client-side replacement at all, so the
  // hint must not send anyone to a page that answers no.
  if (tenantSecretRefusal(name) !== null) {
    return `${ORIGIN[status](name)} ${stays} The client cannot bring its own value for ${name}: the clone's Integrations page refuses it (Mission Control's broker does not let a tenant write ${name}), and it is never set directly on the client's project. ${KEPT}`;
  }
  return `${ORIGIN[status](name)} ${stays} It is withdrawn only when ${THROUGH_THE_BROKER(name)}. ${WITHDRAWAL[status]} ${KEPT}`;
}

const LINK_HINT = `The key that links this clone to Mission Control: usage reports, entitlements and the activation gate read it, and the usage forwarder that bills the platform keys after handover reports through it (${D6_KEEP_AND_BILL}). It is never withdrawn by default, and the client bringing its own keys does not withdraw it. Mark this row skipped, with evidence that the link is kept; withdrawing it is a separate decision to stop metering this clone.`;

/**
 * Platform names that are settings, not credentials: what each is, and why it
 * needs nothing at handover. The Listings settings are `FLEET_CONFIGURATION`'s
 * own; the rest are named by the fleet rows that forward them.
 */
const SHARED_DIDIT = "it configures the fleet's shared Didit application, and changes only with it";
const SETTINGS: ReadonlyMap<string, { what: string; atHandover: string }> = new Map([
  ...[...FLEET_CONFIGURATION].map(
    (name) =>
      [
        name,
        {
          what: "the Listings configuration this clone asks Mission Control's broker with",
          atHandover:
            "every fleet pass keeps it in step with Mission Control's own, and the clone's Integrations page refuses it",
        },
      ] as const,
  ),
  [
    "DIDIT_LIVENESS_THRESHOLD",
    {
      what: "compliance policy for the liveness check of the fleet's shared Didit application",
      atHandover: SHARED_DIDIT,
    },
  ],
  [
    "DIDIT_FACE_MATCH_THRESHOLD",
    {
      what: "compliance policy for the face match of the fleet's shared Didit application",
      atHandover: SHARED_DIDIT,
    },
  ],
  [
    "DIDIT_WORKFLOW_ID",
    {
      what: "the hosted-flow workflow of the fleet's shared Didit application",
      atHandover: SHARED_DIDIT,
    },
  ],
  [
    "GITHUB_APP_ID",
    {
      what: "the id of Aurixa's GitHub App",
      atHandover: "what the app may reach is decided by its installation, never by its id",
    },
  ],
]);

/**
 * Platform names that are secrets every clone shares: not this clone's own,
 * and not billed. Handing the clone over hands its client the value every
 * other clone uses, which the operator records; whether each clone gets its
 * own is the owner's decision still open.
 */
const SHARED_SECRETS: ReadonlyMap<string, { what: string; decision: string }> = new Map([
  [
    "DIDIT_WEBHOOK_SECRET",
    {
      what: "it signs Didit's callbacks, for the fleet's one Didit application",
      decision:
        "audit item D3, the owner's open decision on how Didit's callbacks are routed (docs/CLONE_MANAGEMENT_TOKEN.md)",
    },
  ],
]);

/** What the row says, by what the name is: a billed key, a setting, a shared secret, or none of those known. */
function hintFor(name: string, status: PlatformPaidStatus, billed: ReadonlySet<string>): string {
  if (billed.has(name)) return platformHint(name, status);
  const setting = SETTINGS.get(name);
  if (setting) {
    return `${name} is a setting Aurixa supplied, not a credential: ${setting.what}. Nothing is billed on it. At handover nothing is withdrawn: ${setting.atHandover}. Mark this row skipped, with evidence that the setting is kept.`;
  }
  const shared = SHARED_SECRETS.get(name);
  if (shared) {
    return `${name} is a secret shared by every clone, not one of this clone's own: ${shared.what}. Nothing is billed on it. At handover it stays, so the client holds the value every other clone uses too: record that on this row. Whether each clone gets its own is ${shared.decision}. Mark this row skipped, with evidence that it is kept and that the sharing is recorded.`;
  }
  // Aurixa's, and no billable rate covers it: a credential whose rate is
  // missing, or a setting nobody has named here. The row says which it can be.
  const own =
    tenantSecretRefusal(name) === null
      ? `the client may bring its own on the clone's Integrations page, never directly on the project`
      : `the clone's Integrations page refuses it, so the client cannot bring its own`;
  return `${name} is a value Aurixa supplied that no rate bills: it has no active billable row in api_provider_rates, so nothing is charged for it. It stays after handover. If it is a credential, its rate is missing and calls on it are charged to nobody, and ${own}; if it is a setting, nothing is withdrawn. Mark this row skipped, with evidence of which it is and that it is kept.`;
}

function isPlatformPaid(status: string): status is PlatformPaidStatus {
  return (PLATFORM_PAID_STATUSES as readonly string[]).includes(status);
}

/**
 * One row for each name the clone's ledger records as Aurixa's, in name order,
 * plus the Mission Control link whatever its status. A name whose value the
 * client brought (`set`) or that never reached the clone (`withheld`,
 * `authorised_no_value`) is not Aurixa's to account for.
 *
 * `billed` is every name an active billable rate covers (`api_provider_rates`), the
 * one record of what is billed; a row says it is billed only from there.
 */
export function platformCredentialRotations(
  ledger: ReadonlyArray<{ name: string; status: string }>,
  billed: ReadonlySet<string>,
): PlannedRotation[] {
  const rows: PlannedRotation[] = [];
  const names = new Set<string>();
  for (const entry of [...ledger].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === MISSION_CONTROL_LINK_SECRET || names.has(entry.name)) continue;
    if (!isPlatformPaid(entry.status)) continue;
    names.add(entry.name);
    rows.push({
      target: "other",
      key_ref: `platform.${entry.name}`,
      hint: hintFor(entry.name, entry.status, billed),
    });
  }
  rows.push({
    target: "other",
    key_ref: `platform.${MISSION_CONTROL_LINK_SECRET}`,
    hint: LINK_HINT,
  });
  return rows;
}
