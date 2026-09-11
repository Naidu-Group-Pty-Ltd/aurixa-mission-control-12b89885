/**
 * Catalog of API key scopes — safe to import from both client and server.
 * Used by the Mission Control "Issue key" dialog (scope picker) and by
 * `resolveCloneApiKey` on the server as the source of truth.
 */
export type CloneApiScope = {
  value: string;
  group:
    | "tokens"
    | "seats"
    | "devices"
    | "pricing"
    | "billing"
    | "webhooks"
    | "edge"
    | "health"
    | "usage"
    | "gate"
    | "clones"
    | "verification"
    | "listings"
    | "integrations"
    | "anthropic";
  label: string;
  description: string;
  default?: boolean;
};

export const CLONE_API_SCOPES: CloneApiScope[] = [
  {
    value: "verification:run",
    group: "verification",
    label: "Identity verification — run",
    description:
      "Run this clone's own identity verifications through Mission Control's Didit credential. " +
      "On by default: the credential is deliberately NOT forwarded to any clone, because a Didit " +
      "key can list every session in its application — including other tenants' customers' " +
      "passport portraits — so brokering is the only way a clone can verify at all. Grants the " +
      "three write operations of a verification sequence and nothing readable.",
    default: true,
  },
  {
    value: "listings:read",
    group: "listings",
    label: "Listings — read the shared Airtable marketplace",
    description:
      "Read the Property Intake Master table that the Listings and Overview pages are built from, " +
      "through Mission Control's Airtable credential. On by default: the token is deliberately NOT " +
      "forwarded to any clone, because an Airtable personal access token carries its whole scope — " +
      "every base and every permission it was minted with — and nothing in it narrows it to one " +
      "table. Grants two read operations against a base and table this clone cannot name, and no " +
      "write of any kind.",
    default: true,
  },
  {
    value: "anthropic:federate",
    group: "anthropic",
    label: "Anthropic — obtain a workspace-scoped identity",
    description:
      "Let this workspace ask Mission Control for a five-minute assertion naming itself, which it " +
      "exchanges at Anthropic for a token bound to its own workspace and nothing else. On by " +
      "default: it is what lets a clone reach Anthropic with NO static key — today every clone " +
      "holds an organisation key that can act in every workspace the organisation has. It grants " +
      "no credential of Mission Control's own, names no workspace but this clone's, and the " +
      "assertion it returns is useful against exactly one federation rule.",
    default: true,
  },
  {
    value: "integrations:write",
    group: "integrations",
    label: "Integrations — set this workspace's own vendor keys",
    description:
      "Let this workspace write a vendor credential typed on its own Integrations page into its " +
      "own Supabase project's function environment. On by default: the page is how a tenant " +
      "brings its own GoHighLevel, Domain or OpenAI key, and without this the only button that " +
      "reaches the runtime needs a Supabase personal access token — which is scoped to an " +
      "ACCOUNT, not a project, and must never sit on a tenant's project. Mission Control decides " +
      "WHICH project from this key alone (the caller cannot name one) and refuses every name " +
      "that decides who a deployment is.",
    default: true,
  },
  {
    value: "tokens:meter",
    group: "tokens",
    label: "Tokens — meter",
    description: "Reserve, commit, cancel report credits and read tenant balance.",
    default: true,
  },
  {
    value: "tokens:read",
    group: "tokens",
    label: "Tokens — read",
    description: "Read-only access to token packs and balance endpoints.",
    default: true,
  },
  {
    value: "seats:manage",
    group: "seats",
    label: "Seats — manage",
    description: "Reserve, commit, release user seats and read seat entitlement.",
    default: true,
  },
  {
    value: "devices:manage",
    group: "devices",
    label: "Devices — manage",
    description: "Register, heartbeat, release per-seat devices and enforce device caps.",
    default: true,
  },
  {
    value: "pricing:read",
    group: "pricing",
    label: "Pricing — read catalog",
    description: "Read seat plans, roles, addons, setup packages, and per-report credit costs.",
    default: true,
  },
  {
    value: "billing:handoff",
    group: "billing",
    label: "Billing — mint handoffs",
    description:
      "Mint single-use attributed deep links into the pricing/topup pages, carrying the originating command-center user.",
    default: true,
  },
  {
    value: "webhooks:emit",
    group: "webhooks",
    label: "Webhooks — emit",
    description: "Allow this key to trigger outbound webhook deliveries on usage events.",
    default: false,
  },
  {
    value: "edge:read",
    group: "edge",
    label: "Edge — read status",
    description:
      "Read-only access to this clone's edge/CDN provider status, posture, and last sync.",
    default: false,
  },
  {
    value: "usage:report",
    group: "usage",
    label: "API usage — report",
    description:
      "Report third-party API consumption (AI tokens, emails, property lookups) made on keys forwarded from the prime, so piggybacked spend can be recharged. Keys the clone supplies itself are metered but never billed.",
    // On by default: a clone provisioned with our forwarded vendor keys spends
    // our money from its first request, and a key issued without this scope
    // meters nothing at all — the gap is silent and unrecoverable.
    default: true,
  },
  {
    value: "usage:read",
    group: "usage",
    label: "API usage — read",
    description:
      "Read this clone's own API usage totals and current-period charge, so a workspace can show its operators what it is spending.",
    default: false,
  },
  {
    value: "gate:read",
    group: "gate",
    label: "Activation gate — read",
    description:
      "Read this clone's own activation-gate status and start the activation checkout. On by default: a gated clone that cannot read its gate has no way to tell a customer why it is locked, or how to pay.",
    default: true,
  },
  {
    value: "clones:rotate",
    group: "clones",
    label: "Clone — rotate its own key",
    description:
      "Let this clone replace its own Mission Control key through the public rotate endpoint, receiving the new one in the response.",
    // On by default, and it was not in this catalogue at all until now. The
    // endpoint required it and the only key that ever carried it was the
    // `auto-provisioned` one, delivered solely by committing its plaintext to
    // the clone's repository — a file with no readers. So the scope existed,
    // the endpoint existed, and no credential anybody could present had it:
    // self-rotation was unreachable from the day it shipped. It belongs on the
    // key that is actually delivered.
    default: true,
  },
  {
    value: "health:beacon",
    group: "health",
    label: "Health — emit beacon",
    description:
      "Post-handoff observability: clone-owned backend pings Mission Control with project status, DB size, connections, and severity.",
    default: false,
  },
];

export const DEFAULT_SCOPES = CLONE_API_SCOPES.filter((s) => s.default).map((s) => s.value);
export const SCOPE_VALUES = CLONE_API_SCOPES.map((s) => s.value);
