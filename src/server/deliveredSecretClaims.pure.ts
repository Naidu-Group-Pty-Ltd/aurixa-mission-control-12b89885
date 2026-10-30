/**
 * What the ledger says about a name Mission Control delivers itself, set
 * against the project's own list of names (key audit A1, 30 Oct 2026).
 *
 * Two names are written by Mission Control and never re-sent once delivered:
 * the link key (only its hash is kept, so a repair cannot re-send it, and
 * never rotates it) and the Turnstile secret (delivered once per widget). So
 * a ledger row written before the delivery, or by a pass that failed, is never
 * corrected by the pass that owns the name. Measured 30 Oct: the link key read
 * `failed` on the dashboard, NPC Test and Preflight (502 and 503 from
 * September) and `missing` on the CRM, while every clone's link was
 * re-asserted every half hour; the Turnstile secret read `missing` on three
 * clones whose widgets Mission Control had minted and delivered.
 *
 * The correction needs both facts: Mission Control's record that it
 * delivered the value to this project, and the project's own list naming it.
 * Then the row reads `set`. A delivered name the project no longer lists
 * reads `missing`, with the reason, because nothing will put it back by
 * itself. A name without a delivery record is not this rule's to touch, and a
 * row already saying the right thing is left alone.
 *
 * Pure: no I/O.
 */

export type DeliveredLedgerRow = { name: string; status: string | null };

export type DeliveredCorrection = {
  name: string;
  status: "set" | "missing";
  last_error: string | null;
};

export const DELIVERED_BUT_UNLISTED =
  "Mission Control delivered this value, and the project no longer lists the name. A repair cannot re-send it: rotate it.";

export function deliveredNameCorrections(input: {
  ledger: readonly DeliveredLedgerRow[];
  /** Names Mission Control's own records say it delivered to this project. */
  delivered: readonly string[];
  /** The project's own list of names, read successfully. */
  held: readonly string[];
}): DeliveredCorrection[] {
  const held = new Set(input.held);
  const status = new Map(input.ledger.map((r) => [r.name, r.status]));
  const out: DeliveredCorrection[] = [];
  for (const name of Array.from(new Set(input.delivered)).sort()) {
    const recorded = status.get(name) ?? null;
    if (held.has(name)) {
      if (recorded !== "set") out.push({ name, status: "set", last_error: null });
    } else if (recorded === "set" || recorded === null) {
      out.push({ name, status: "missing", last_error: DELIVERED_BUT_UNLISTED });
    }
  }
  return out;
}
