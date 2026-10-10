/**
 * What applying a revision of a clone's voice-automation settings WRITES to
 * Make, decided in one place before anything is written.
 *
 * ## The order, and why it is not negotiable
 *
 *   1. Bind connections into the adapter and the notifier (scenario updates).
 *   2. Then write the CFG record (one partial update).
 *
 * CFG is what SELECTS a provider. Writing it first would point live calls at a
 * calendar or a mailbox whose connection is not yet in the blueprint, and every
 * booking in that window would fail. Binding first is harmless on its own: a
 * bound connection nothing selects is never called.
 *
 * ## Blocked is all-or-nothing
 *
 * If the chosen calendar or mailbox has no authorised connection, the revision
 * is BLOCKED and nothing at all is written — not the bindings, not the hours,
 * not the admin address. A partial apply would leave the live stack at a state
 * nobody chose (the new hours under the old provider) and the record saying
 * "applied". The previous revision stays live, the block names the missing
 * connection, and the tenant's next act — connect it — clears it.
 *
 * ## Every authorised connection is bound, selected or not
 *
 * So that switching provider later is a CFG write alone, and so a connection a
 * tenant authorised is in service the moment they choose it.
 *
 * Pure. Takes readings; returns a plan; performs nothing.
 */

import {
  CONNECTION_KINDS,
  cfgPatchFor,
  requiredConnections,
  type CfgValue,
  type ConnectionKind,
  type VoiceAutomationSettings,
} from "./voiceAutomation.pure";
import {
  assertAdapterShape,
  assertNotifierShape,
  bindConnection,
  ensureGmailRoutes,
  notifierIgnoresNone,
  type BindingChange,
  type Blueprint,
} from "./voiceAutomationBlueprint.pure";

export type ConnectionReading = {
  kind: ConnectionKind;
  state: string;
  makeConnectionId: number | null;
};

export type ApplyInput = {
  settings: VoiceAutomationSettings;
  connections: readonly ConnectionReading[];
  adapter: Blueprint;
  notifier: Blueprint;
  /** Managed CFG fields as Make holds them now, or null when unread. */
  liveManagedCfg: Record<string, unknown> | null;
};

export type ApplyBlock = { reason: string; kind?: ConnectionKind; message: string };

export type ApplyPlan =
  | { status: "blocked"; blocks: ApplyBlock[] }
  | {
      status: "ready";
      adapter: { blueprint: Blueprint; changes: BindingChange[] } | null;
      notifier: { blueprint: Blueprint; changes: BindingChange[] } | null;
      cfgPatch: Record<string, CfgValue>;
      /** True when the plan writes nothing — the live stack already matches. */
      noop: boolean;
    };

/** The usable connection id for a kind: only an authorised one counts. */
export function usableConnection(
  connections: readonly ConnectionReading[],
  kind: ConnectionKind,
): number | null {
  const c = connections.find(
    (x) => x.kind === kind && x.state === "authorized" && x.makeConnectionId,
  );
  return c?.makeConnectionId ?? null;
}

export function planApply(input: ApplyInput): ApplyPlan {
  const blocks: ApplyBlock[] = [];

  const adapterShape = assertAdapterShape(input.adapter);
  if (adapterShape)
    blocks.push({
      reason: adapterShape,
      message: "The calendar adapter scenario is not the shape this applier expects.",
    });
  const notifierShape = assertNotifierShape(input.notifier);
  if (notifierShape)
    blocks.push({
      reason: notifierShape,
      message: "The email notifier scenario is not the shape this applier expects.",
    });

  for (const kind of requiredConnections(input.settings)) {
    if (!usableConnection(input.connections, kind)) {
      blocks.push({
        reason: "connection_required",
        kind,
        message: `${CONNECTION_KINDS[kind].label} is selected but not connected yet. Connect it, then the change applies.`,
      });
    }
  }

  if (
    !notifierShape &&
    input.settings.email.provider === "none" &&
    notifierIgnoresNone(input.notifier)
  ) {
    blocks.push({
      reason: "notifier_cannot_disable",
      message:
        "This stack's notifier still sends through Outlook when email is set to none. It must be redeployed from the current generator before email can be switched off.",
    });
  }

  if (blocks.length) return { status: "blocked", blocks };

  let adapter = input.adapter;
  const adapterChanges: BindingChange[] = [];
  for (const kind of ["outlook_calendar", "google_calendar"] as const) {
    const id = usableConnection(input.connections, kind);
    if (!id) continue;
    const r = bindConnection(adapter, kind, id);
    if (!r.ok)
      return {
        status: "blocked",
        blocks: [
          {
            reason: r.error,
            kind,
            message: `Could not bind ${CONNECTION_KINDS[kind].label} into the adapter.`,
          },
        ],
      };
    adapter = r.blueprint;
    adapterChanges.push(...r.changes);
  }

  let notifier = input.notifier;
  const notifierChanges: BindingChange[] = [];
  const outlookMail = usableConnection(input.connections, "outlook_mail");
  if (outlookMail) {
    const r = bindConnection(notifier, "outlook_mail", outlookMail);
    if (!r.ok)
      return {
        status: "blocked",
        blocks: [
          {
            reason: r.error,
            kind: "outlook_mail",
            message: "Could not bind the Outlook mailbox into the notifier.",
          },
        ],
      };
    notifier = r.blueprint;
    notifierChanges.push(...r.changes);
  }
  const gmail = usableConnection(input.connections, "gmail");
  if (gmail) {
    const r = ensureGmailRoutes(notifier, gmail);
    if (!r.ok)
      return {
        status: "blocked",
        blocks: [
          {
            reason: r.error,
            kind: "gmail",
            message: "Could not add the Gmail routes to the notifier.",
          },
        ],
      };
    notifier = r.blueprint;
    notifierChanges.push(...r.changes);
  }

  const cfgPatch = cfgPatchFor(input.settings, input.liveManagedCfg);
  const plan = {
    status: "ready" as const,
    adapter: adapterChanges.length ? { blueprint: adapter, changes: adapterChanges } : null,
    notifier: notifierChanges.length ? { blueprint: notifier, changes: notifierChanges } : null,
    cfgPatch,
    noop: false,
  };
  plan.noop = !plan.adapter && !plan.notifier && Object.keys(cfgPatch).length === 0;
  return plan;
}

// ---------------------------------------------------------------------------
// Retry schedule for the drain

/** Back-off after a FAILED apply (not a blocked one — that waits on a person). */
export function nextAttemptDelayMs(attempts: number): number {
  const minutes = [1, 5, 15, 60, 240][Math.min(Math.max(attempts, 1), 5) - 1];
  return minutes * 60_000;
}

/** After this many failures the drain stops retrying and an operator is told. */
export const MAX_APPLY_ATTEMPTS = 8;
