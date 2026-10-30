/**
 * The prime credentials Mission Control's forward policy sends to one clone.
 *
 * ## Why the comparison with the prime needs this
 *
 * `diffSecrets` compared a clone's credential NAMES with the prime's and
 * called every absent one a mismatch. Measured 30 Oct 2026, that put every
 * clone in the fleet at `risk_level: blocking` on credentials alone
 * (`missing_secrets` 4, 58, 58, 72 and 72): DocuSign, Microsoft and Meta Ads
 * keys a tenant supplies or goes without, and settings a clone leaves unset on
 * purpose, `STEP_UP_ENFORCED` among them. A comparison that fails every clone
 * says nothing about any of them.
 *
 * The owner decided (30 Oct 2026, the provisioning session's PF-27) that the
 * forward policy decides: a credential a clone lacks is a mismatch only when
 * that policy sends it to the clone. Every other one is still listed, as
 * information.
 *
 * ## One policy, read as the code that applies it reads it
 *
 * Nothing here restates the policy. The fleet half is `planFleetForwards`,
 * the decision the fleet sweep takes for every clone each half hour, and the
 * per-clone half is `planCloneForwards`, the decision the push takes. Both
 * refuse by class first, then by the clone's CRM line, then by a fleet
 * `inherit = false`, so a name either refuses is not counted as sent. A fleet
 * row marked `inherit` does not make a signing key or a CAPTCHA pair travel,
 * and it does not make one owed here either.
 *
 * A name authorised for which Mission Control holds no value is still SENT by
 * policy. It is counted: its absence on the clone is a real gap, and the
 * remedy, a value in Mission Control's environment, is stated on the clone's
 * secrets page. Whether a value is held is therefore not asked here.
 */
import type { SecretClass } from "./prime-backend.server";
import { planCloneForwards, planFleetForwards } from "./cloneSecretForward.pure";

export function forwardedSecretNames(input: {
  /** Every fleet row, INCLUDING `inherit = false`, which refuses a per-clone row. */
  readonly fleet: ReadonlyArray<{ readonly name: string; readonly inherit: boolean }>;
  /** Names authorised for this clone alone (`clone_secret_forwards`). */
  readonly authorised: readonly string[];
  /** The clone's recorded CRM line. */
  readonly crmMode: string | null;
  readonly classOf: (name: string) => SecretClass;
}): string[] {
  const fleet = new Map(input.fleet.map((r) => [r.name, r.inherit]));
  const sent = new Set<string>();
  // Policy, not availability or delivery: see the header. With no value
  // asked and nothing settled, every name the fleet sends reads `forward`.
  const fleetPlan = planFleetForwards({
    fleet,
    classOf: input.classOf,
    envHas: () => true,
    settled: new Set(),
    crmMode: input.crmMode,
  });
  for (const outcome of fleetPlan) {
    if (outcome.act !== "refuse" && outcome.act !== "not_inherited") sent.add(outcome.name);
  }
  const clonePlan = planCloneForwards({
    authorised: input.authorised,
    fleet,
    classOf: input.classOf,
    envHas: () => true,
    crmMode: input.crmMode,
  });
  for (const outcome of clonePlan) if (outcome.act !== "refuse") sent.add(outcome.name);
  return [...sent].sort();
}
