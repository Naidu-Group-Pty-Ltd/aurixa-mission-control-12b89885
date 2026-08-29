/**
 * What the clone page should say about Cloudflare.
 *
 * The Edge security card reported `clone_edge_config` — the OPTIONAL WAF/CDN
 * wrapper — and nothing else, so its empty state read "No edge provider
 * attached". That sentence was true about the wrapper and false about
 * Cloudflare, which was carrying the clone's subdomain DNS at that moment, had
 * been for a day, and had a failed job listed three lines below saying so.
 *
 * A page that answers a narrower question than the one its reader is asking is
 * worse than one that says nothing: the operator concluded Cloudflare was not
 * set up, which sent them to attach it again.
 *
 * So the reading is derived here, separately from the wrapper, and it is
 * allowed to be uncomfortable. `untracked` is a real state — the record exists
 * at Cloudflare and Mission Control has no row for it — and it is the state
 * that produced the failing resync, so it gets its own name rather than being
 * rounded to either "fine" or "missing".
 */

export type CloudflareDnsFacts = {
  fqdn: string;
  status: string | null;
  zoneId: string | null;
  zoneName: string | null;
  desiredType: string | null;
  desiredContent: string | null;
  desiredProxied: boolean | null;
  trackedRecordId: string | null;
  trackedType: string | null;
  trackedContent: string | null;
  trackedProxied: boolean | null;
};

export type DnsTone = "live" | "untracked" | "drifted" | "pending" | "unconfigured";

export type CloudflareDnsReading = {
  tone: DnsTone;
  headline: string;
  detail: string;
  /** The record as one line, when there is one to show. */
  record: string | null;
};

const recordLine = (type: string | null, content: string | null, proxied: boolean | null) =>
  type && content
    ? `${type} → ${content}${proxied === null ? "" : proxied ? " · proxied" : " · DNS only"}`
    : null;

export function readCloudflareDns(facts: CloudflareDnsFacts | null): CloudflareDnsReading {
  if (!facts || !facts.zoneId) {
    return {
      tone: "unconfigured",
      headline: "Cloudflare DNS is not configured",
      detail:
        "No Cloudflare zone is set in the hosting configuration, so this deployment's subdomain " +
        "is not managed here.",
      record: null,
    };
  }

  const zone = facts.zoneName ?? facts.zoneId;
  const desired = recordLine(facts.desiredType, facts.desiredContent, facts.desiredProxied);
  const tracked = recordLine(facts.trackedType, facts.trackedContent, facts.trackedProxied);

  if (!facts.trackedRecordId) {
    return {
      tone: facts.status === "active" ? "untracked" : "pending",
      headline:
        facts.status === "active"
          ? `Serving ${facts.fqdn} — record not tracked here`
          : `${facts.fqdn} is not live yet`,
      detail:
        facts.status === "active"
          ? `Cloudflare is resolving this hostname in zone ${zone}, but Mission Control has no ` +
            "row for the record — so a resync cannot update it and will try to CREATE one, which " +
            "Cloudflare refuses as a duplicate. The next run adopts the existing record instead."
          : `Zone ${zone} is configured and the subdomain has not been provisioned yet.`,
      record: desired,
    };
  }

  const matches =
    (facts.trackedType ?? "").toUpperCase() === (facts.desiredType ?? "").toUpperCase() &&
    (facts.trackedContent ?? "").toLowerCase() === (facts.desiredContent ?? "").toLowerCase() &&
    facts.trackedProxied === facts.desiredProxied;

  if (!matches) {
    return {
      tone: "drifted",
      headline: `${facts.fqdn} does not match the hosting configuration`,
      detail: `Tracked as ${tracked ?? "—"}; the configuration asks for ${desired ?? "—"}. A resync brings it back.`,
      record: tracked,
    };
  }

  return {
    tone: "live",
    headline: `Serving ${facts.fqdn}`,
    detail: `Zone ${zone}, record tracked by Mission Control and matching the hosting configuration.`,
    record: tracked,
  };
}
