/**
 * WHICH CRM A DEPLOYMENT RUNS — the vocabulary, in one place.
 *
 * The fleet holds two kinds of deployment and they are different TREES, not
 * different settings:
 *
 *   dependent    GoHighLevel. Clients, Client Tracker, Conversations and
 *                Calendar are GoHighLevel's; the browser layer calls
 *                `send-ghl-message`, `ghl-calendar` and
 *                `sync-ghl-conversations` directly. The tree of
 *                `npc-client-dashboard`.
 *   independent  Its own Postgres. The same four surfaces answer out of the
 *                deployment's own tables behind `crmProvider.ts` /
 *                `_shared/crm/crmProvider.pure.ts`, and it carries three edge
 *                functions the prime does not (`crm-calendar`,
 *                `crm-inbound-message`, `crm-send-message`). The tree of
 *                `npc-crm-independent-6505dc`.
 *
 * A clone BECOMES one or the other by the tree it is created from, which is
 * why the choice is a parent rather than a flag: provisioning creates the new
 * repository from the chosen line's parent clone and records that parent, and
 * every cascade afterwards reaches it through that parent.
 *
 * Client-safe on purpose. The wizard draws these words, the cascade membrane
 * reads the mode, and the server judges the parent — three readers of one
 * vocabulary, so the page cannot describe a mode the server spells
 * differently.
 */

export const CRM_MODES = ["dependent", "independent"] as const;

export type CrmMode = (typeof CRM_MODES)[number];

export function isCrmMode(value: unknown): value is CrmMode {
  return value === "dependent" || value === "independent";
}

export function oppositeCrmMode(mode: CrmMode): CrmMode {
  return mode === "dependent" ? "independent" : "dependent";
}

/**
 * The `prime_config` column that names each line's parent clone.
 *
 * A column rather than a repository name in code, because which clone heads
 * each line is a fact about THIS fleet and an operator must be able to change
 * it without a deploy.
 */
export const CRM_PARENT_COLUMN = {
  dependent: "crm_dependent_parent_clone_id",
  independent: "crm_independent_parent_clone_id",
} as const satisfies Record<CrmMode, string>;

export type CrmParentColumn = (typeof CRM_PARENT_COLUMN)[CrmMode];

/** What an operator is shown. `provider` is the CRM the deployment talks to. */
export const CRM_MODE_COPY: Record<
  CrmMode,
  { title: string; provider: string; summary: string; consequence: string }
> = {
  dependent: {
    title: "CRM dependent",
    provider: "GoHighLevel",
    summary:
      "Clients, conversations and the calendar live in GoHighLevel. The clone is created from the " +
      "CRM-dependent parent and receives every change through it.",
    consequence:
      "Needs a GoHighLevel location and its credentials before the CRM screens show anything.",
  },
  independent: {
    title: "CRM independent",
    provider: "Native CRM",
    summary:
      "Clients, conversations and the calendar live in the clone's own database, routed through its " +
      "provider table. The clone is created from the CRM-independent parent and receives every " +
      "change through it.",
    consequence:
      "Carries its own crm-* edge functions; SMS needs the clone's own Twilio number and credentials.",
  },
};

/**
 * One line for a recorded mode, including the state where nobody has said.
 *
 * NULL is its own answer and never a default: a clone registered before the
 * column existed, or without a repository, is not "dependent" because most
 * clones are.
 */
export function crmModeLabel(mode: CrmMode | string | null | undefined): string {
  if (mode === "dependent" || mode === "independent") {
    return `${CRM_MODE_COPY[mode].title} (${CRM_MODE_COPY[mode].provider})`;
  }
  return "CRM not recorded";
}
