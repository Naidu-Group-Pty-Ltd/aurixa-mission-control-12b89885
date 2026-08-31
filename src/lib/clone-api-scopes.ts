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
    | "gate";
  label: string;
  description: string;
  default?: boolean;
};

export const CLONE_API_SCOPES: CloneApiScope[] = [
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
