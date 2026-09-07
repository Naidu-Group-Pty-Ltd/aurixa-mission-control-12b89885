/**
 * The clone's link back to Mission Control — the environment half.
 *
 * ## What this fixes
 *
 * Every clone is issued a Mission Control API key at creation and that key is
 * committed into the clone's repository as `.aurixa/credentials.json`, "so the
 * clone's frontend can read it at build time". Nothing reads that file — not
 * in the prime, not in any clone, not in a workflow. What DOES read the key is
 * the prime's edge functions: `_shared/missionControl.ts`,
 * `missionControlCatalog.ts`, `missionControlSeats.ts`,
 * `missionControlDevices.ts` and four more, every one through
 * `Deno.env.get("MISSION_CONTROL_URL")` and
 * `Deno.env.get("MISSION_CONTROL_CLONE_API_KEY")`. Neither name was ever
 * written to a clone's environment, so every token reservation, seat check
 * and catalogue read on every clone failed with "MISSION_CONTROL_URL or
 * MISSION_CONTROL_CLONE_API_KEY missing". Measured 6 Sep 2026: every key in
 * `clone_api_keys` had `last_used_at` NULL — no clone had ever presented one —
 * and one clone had no key row at all.
 *
 * The webhook half was the same shape. `fireTokenWebhook` signs each event
 * with the endpoint row's secret and the clone's `mission-control-webhook`
 * function verifies against `MISSION_CONTROL_WEBHOOK_SECRET`; no clone had an
 * endpoint row, and the one row that existed was global and pointed at a
 * misspelt prime hostname (every delivery since May answered `error code:
 * 1016`).
 *
 * ## The rules
 *
 * **The link is written to the place that reads it.** Four names, one batch:
 * the URL, the key, the agency name and the webhook secret, all in ONE
 * secrets request so a half-written link cannot exist.
 *
 * **The key is minted where it is delivered, and never rotated on a repair.**
 * A key's plaintext exists once, at mint. A live key already delivered to
 * THIS project is left alone; a new one is minted only when none is, and the
 * link keys an earlier pass minted but never delivered (or delivered to a
 * project the clone no longer has) are revoked when it lands. The repository
 * cascade is untouched — it is somebody else's decision whether a credential
 * nobody reads should keep being committed.
 *
 * **The webhook endpoint is the readable half.** Its secret lives in
 * `token_webhook_endpoints` (that is what the sender signs with), so a pass
 * reuses it and re-asserts the environment — the same convergence rule the
 * signing pair follows. The link owns exactly one endpoint per clone,
 * recognised by URL shape; an endpoint an operator registered by hand is
 * never touched.
 *
 * Pure: no I/O.
 */

export const ENV_MISSION_CONTROL_URL = "MISSION_CONTROL_URL";
export const ENV_MISSION_CONTROL_CLONE_API_KEY = "MISSION_CONTROL_CLONE_API_KEY";
export const ENV_MISSION_CONTROL_AGENCY_NAME = "MISSION_CONTROL_AGENCY_NAME";
export const ENV_MISSION_CONTROL_WEBHOOK_SECRET = "MISSION_CONTROL_WEBHOOK_SECRET";

export const MISSION_CONTROL_LINK_ENV_NAMES = [
  ENV_MISSION_CONTROL_URL,
  ENV_MISSION_CONTROL_CLONE_API_KEY,
  ENV_MISSION_CONTROL_AGENCY_NAME,
  ENV_MISSION_CONTROL_WEBHOOK_SECRET,
] as const;

/** The label every key this step mints carries; how the sweep tells its own keys apart. */
export const MISSION_CONTROL_LINK_KEY_LABEL = "mission-control-link";

export const DEFAULT_MISSION_CONTROL_ORIGIN = "https://mission-control.aurixasystems.com.au";

/** Every event the clone's receiver handles (`mission-control-webhook`). */
export const CLONE_WEBHOOK_EVENTS = [
  "tokens.balance.updated",
  "tokens.key.revoked",
  "tokens.key.rotated",
  "tokens.alert",
] as const;

/**
 * Where a clone reaches Mission Control. `PUBLIC_APP_URL` where it is set and
 * is an https origin; the custom domain otherwise — the `.lovable.app` origin
 * answers the hooks 401 and is never the right value for a tenant to hold.
 */
export function resolveMissionControlOrigin(env: { PUBLIC_APP_URL?: string | undefined }): string {
  const raw = (env.PUBLIC_APP_URL ?? "").trim();
  if (!raw) return DEFAULT_MISSION_CONTROL_ORIGIN;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" || !u.hostname || u.hostname === "localhost") {
      return DEFAULT_MISSION_CONTROL_ORIGIN;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return DEFAULT_MISSION_CONTROL_ORIGIN;
  }
}

export function cloneWebhookUrl(projectRef: string): string {
  return `https://${projectRef}.supabase.co/functions/v1/mission-control-webhook`;
}

/** The shape of an endpoint this step owns — any project's `mission-control-webhook` function. */
export function isMissionControlWebhookUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/mission-control-webhook$/.test(url.trim());
}

export function agencyNameFor(cloneName: string | null | undefined): string | null {
  const s = (cloneName ?? "").trim().replace(/\s+/g, " ");
  return s.length > 0 ? s.slice(0, 120) : null;
}

export type LinkKeyFact = {
  id: string;
  label: string | null;
  revokedAt: string | null;
  revokeAt: string | null;
  deliveredProjectRef: string | null;
  deliveredEnvAt: string | null;
  /** What the key may do. Snapshotted at mint, so it goes stale — see `grantScopes`. */
  scopes: string[];
};

export type LinkEndpointFact = {
  id: string;
  url: string;
  isActive: boolean;
  events: string[];
};

export type MissionControlLinkFacts = {
  projectRef: string;
  cloneName: string | null;
  keys: LinkKeyFact[];
  endpoints: LinkEndpointFact[];
  now: number;
  /** The catalogue's current defaults, passed in so this module stays pure. */
  defaultScopes: string[];
};

export type MissionControlLinkPlan = {
  mintKey: boolean;
  /** Link keys to revoke once the new one has landed in the environment. */
  revokeKeyIds: string[];
  /**
   * Default scopes a live link key is missing, to be added to what it has.
   *
   * A key's scopes are snapshotted at mint, so a scope added to the catalogue
   * afterwards reaches no key that already exists — and a delivered key is
   * deliberately never re-minted, because a repair must not rotate a live
   * credential. Those two correct rules together are why `clones:rotate`
   * shipped "on by default" and, measured on 7 Sep 2026, was carried by none
   * of the three delivered keys: the scope existed, the endpoint existed, and
   * no credential anybody could present had it.
   *
   * Widening a key is not rotating it — nothing is re-delivered and no
   * environment changes — so this converges exactly as the webhook events
   * beside it already do.
   */
  grantScopes: { keyId: string; add: string[] }[];
  endpoint: {
    action: "create" | "update" | "reuse";
    id: string | null;
    url: string;
    events: string[];
    changes: string[];
  };
  agencyName: string | null;
  why: string[];
};

export function isLinkKeyLive(key: LinkKeyFact, now: number): boolean {
  if (key.revokedAt) return false;
  if (!key.revokeAt) return true;
  const at = Date.parse(key.revokeAt);
  return !Number.isFinite(at) || at > now;
}

function deliveredHere(key: LinkKeyFact, projectRef: string): boolean {
  return key.deliveredProjectRef === projectRef && Boolean(key.deliveredEnvAt);
}

export function planMissionControlLink(facts: MissionControlLinkFacts): MissionControlLinkPlan {
  const why: string[] = [];

  const live = facts.keys.filter((k) => isLinkKeyLive(k, facts.now));
  const delivered = live.filter((k) => deliveredHere(k, facts.projectRef));
  const mintKey = delivered.length === 0;
  const revokeKeyIds = mintKey
    ? live
        .filter((k) => k.label === MISSION_CONTROL_LINK_KEY_LABEL && !deliveredHere(k, facts.projectRef))
        .map((k) => k.id)
    : [];
  why.push(
    mintKey
      ? `no live key has been delivered to ${facts.projectRef} — minting one` +
          (revokeKeyIds.length ? ` and revoking ${revokeKeyIds.length} undelivered link key(s)` : "")
      : "a live key is already delivered to this project — left alone, never rotated on a repair",
  );

  /*
   * Only the key THIS engine mints. An operator's own key in the Keys tab was
   * scoped by a person on purpose, and widening it because a default changed
   * would grant an authority nobody asked for — the engine owns the scopes of
   * the key the engine owns, and nothing else.
   */
  const grantScopes = live
    .filter((k) => k.label === MISSION_CONTROL_LINK_KEY_LABEL)
    .map((k) => ({
      keyId: k.id,
      // Union, never replacement: a scope granted deliberately on top of the
      // defaults survives.
      add: facts.defaultScopes.filter((scope) => !k.scopes.includes(scope)),
    }))
    .filter((g) => g.add.length > 0);
  if (grantScopes.length) {
    why.push(
      `granting ${grantScopes.length} link key(s) default scope(s) they predate: ` +
        Array.from(new Set(grantScopes.flatMap((g) => g.add))).join(", "),
    );
  }

  const url = cloneWebhookUrl(facts.projectRef);
  const owned = facts.endpoints.find((e) => isMissionControlWebhookUrl(e.url)) ?? null;
  const events = [...CLONE_WEBHOOK_EVENTS];
  let endpoint: MissionControlLinkPlan["endpoint"];
  if (!owned) {
    endpoint = { action: "create", id: null, url, events, changes: ["created"] };
    why.push("no webhook endpoint for this clone's receiver — creating one");
  } else {
    const changes: string[] = [];
    if (owned.url.trim() !== url) changes.push(`re-pointed from ${owned.url}`);
    if (!owned.isActive) changes.push("re-activated");
    const missing = events.filter((e) => !owned.events.includes(e));
    if (missing.length) changes.push(`subscribed to ${missing.join(", ")}`);
    endpoint = {
      action: changes.length ? "update" : "reuse",
      id: owned.id,
      url,
      events: Array.from(new Set([...owned.events, ...events])),
      changes,
    };
    why.push(
      changes.length
        ? `webhook endpoint ${changes.join("; ")}`
        : "webhook endpoint already correct — secret reused, environment re-asserted",
    );
  }

  const agencyName = agencyNameFor(facts.cloneName);
  if (!agencyName) why.push(`${ENV_MISSION_CONTROL_AGENCY_NAME} not written: the clone has no name`);

  return { mintKey, revokeKeyIds, grantScopes, endpoint, agencyName, why };
}

export type MissionControlLinkRepairFacts = {
  projectRef: string | null;
  /** The ledger row for `MISSION_CONTROL_CLONE_API_KEY`, absent when nothing recorded it. */
  ledgerStatus: string | null;
  lastError: string | null;
  updatedAt: string | null;
  now: number;
};

export type MissionControlLinkRepairSkip = "no_backend" | "cooling_off";

export type MissionControlLinkRepairVerdict =
  | { act: true; why: string }
  | { act: false; reason: MissionControlLinkRepairSkip };

export const MISSION_CONTROL_LINK_REPAIR_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * A ledger `set` does not settle the sweep — the delivery record on the key
 * row does, and the plan reads that. What a recent `failed` row buys is a
 * cool-off, so a project whose secrets API refuses the write is not hammered.
 */
export function decideMissionControlLinkRepair(
  facts: MissionControlLinkRepairFacts,
): MissionControlLinkRepairVerdict {
  if (!facts.projectRef) return { act: false, reason: "no_backend" };
  if (facts.lastError && facts.updatedAt && facts.ledgerStatus === "failed") {
    const since = facts.now - Date.parse(facts.updatedAt);
    if (Number.isFinite(since) && since >= 0 && since < MISSION_CONTROL_LINK_REPAIR_COOLDOWN_MS) {
      return { act: false, reason: "cooling_off" };
    }
  }
  return {
    act: true,
    why: facts.ledgerStatus === null ? "no ledger row yet" : `ledger says ${facts.ledgerStatus} — the delivery record decides`,
  };
}
