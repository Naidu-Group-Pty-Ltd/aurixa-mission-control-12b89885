/**
 * THE WORDS A MEMBRANE IS READ BACK IN.
 *
 * Two panels print a channel — the vertical membrane's and the lateral
 * boundary's — and a vocabulary written twice is a vocabulary that drifts: the
 * day a species is labelled in one and not the other, an operator is shown
 * `crm_routing_layer` on one screen and "CRM routing layer" on the next. So
 * it lives once, here, and both panels import it.
 *
 * It is a `.ts` module rather than a constant exported from a component file,
 * because a `.tsx` that exports anything but components loses Fast Refresh.
 *
 * Two rules it answers to.
 *
 * A state is never carried by colour alone. Every channel prints the WORD
 * ("Open" / "Closed" / "Gated") beside its dot, because the fleet's amber and
 * its red are one hue apart in dark mode and a reader who cannot separate them
 * would otherwise be told nothing.
 *
 * And database vocabulary never reaches the operator — the rule
 * `partnerRoster.pure.ts` answers to in the clones. `ExclusionReason` spells
 * `manual_reconcile`; a panel prints "Held for a person to reconcile". Both
 * maps are exhaustive BY TYPE rather than by a fallback: `Record<IonSpeciesName,
 * …>` means a species added without a label fails the typecheck, where
 * `Record<string, …>` with a `?? channel.species` would quietly print the
 * identifier at somebody.
 */

import type { IonChannel } from "@/lib/cascade/membrane/membrane.pure";
import type { IonSpeciesName } from "@/lib/cascade/membrane/ionSpecies.pure";

/** The scene's own palette for a channel's state, in the register `tree-node.tsx` established. */
export const CHANNEL_INK: Record<IonChannel["state"], string> = {
  open: "oklch(0.78 0.18 150)",
  closed: "oklch(0.66 0.24 25)",
  gated: "oklch(0.82 0.17 80)",
};

export const CHANNEL_WORD: Record<IonChannel["state"], string> = {
  open: "Open",
  closed: "Closed",
  gated: "Gated",
};

/** What each species is, in the operator's words rather than the engine's. */
export const SPECIES_LABEL: Record<IonSpeciesName, string> = {
  routed_crm_name: "Routed CRM function name",
  security_baseline: "Security inventory baseline",
  function_declaration: "Edge function declaration",
  spec: "Test specification",
  backend_ref: "Backend project reference",
  crm_routing_layer: "CRM routing layer",
  edge_function: "Edge function source",
  migration: "Schema migration",
  hosting_ref: "Hosting project reference",
};

/** `ExclusionReason` never reaches the page as written. Exhaustive for the same reason. */
export const REASON_LABEL: Record<IonChannel["reason"], string> = {
  protected: "Never crosses",
  manual_reconcile: "Held for a person to reconcile",
  oversize: "Too large to carry",
};
