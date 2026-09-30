import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Lock,
  LockOpen,
  Timer,
  BadgeDollarSign,
  RotateCcw,
  CreditCard,
  Copy,
  ExternalLink,
  CalendarPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  extendCloneGateTrial,
  mintCloneGatePaymentLink,
  recordCloneGatePayment,
  setCloneGateOverride,
  setCloneGateWindow,
} from "@/server/payment-gate.functions";
import {
  GATE_DEFAULT_HOURS,
  GATE_MIN_HOURS,
  TRIAL_EXTENSION_PRESET_DAYS,
  describeTrialExtensionRefusal,
  formatRemaining,
  gateFactsOf,
  normaliseGraceHours,
  planTrialExtension,
  trialExtensionsOf,
  type GateFactsRow,
  type GateState,
  type TrialExtensionPlan,
} from "@/lib/clonePaymentGate.pure";

const HOUR_MS = 3_600_000;

/**
 * The acts an operator can perform on one gate.
 *
 * Every one of them demands a reason, and the field is not decoration: a gate
 * is the difference between a customer working and not, and the event log's
 * only value is that it says who decided and why. The server enforces the same
 * floor, so a caller that skips the dialog is refused rather than recorded
 * anonymously.
 */
export type GateActionsProps = {
  cloneId: string;
  cloneName: string;
  state: GateState;
  /**
   * The stored gate, or null for a clone that has none — then nothing renders.
   *
   * The trial extension previews from it through `gateFactsOf`, the reader the
   * server act uses on the row it re-reads, and sends back the deadline and
   * override it read: the act refuses a gate that has moved since, so the
   * deadline the dialog shows is the deadline written, or nothing is.
   */
  gate: GateActionsGate | null;
  graceHours: number | null;
  paid: boolean;
  onDone: () => void;
  /** `sm` in a dense list row. */
  size?: "sm" | "default";
};

/**
 * The columns the actions read off a gate. Structural, so the console and the
 * clone card hand over the row they already hold. The trial bookkeeping is
 * optional because a row read before its migration has none.
 */
export type GateActionsGate = GateFactsRow & {
  manual_override_reason?: string | null;
  trial_extension_count?: number | null;
  trial_extended_at?: string | null;
  trial_extension_reason?: string | null;
};

type OpenDialog = "lock" | "unlock" | "clear" | "window" | "trial" | "payment" | "link" | null;

type PlannedExtension = Extract<TrialExtensionPlan, { ok: true }>;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

/** Where the trial stands, read off the plan's own `before`. */
function trialPosition(plan: PlannedExtension): string {
  const trial =
    plan.base === "now"
      ? `The trial ended ${when(plan.previousLocksAt)}`
      : `The trial runs until ${when(plan.previousLocksAt)}`;
  switch (plan.before.reason) {
    case "operator_locked":
      return `Locked by an operator. ${trial}.`;
    case "operator_unlocked":
      return `Held open by an operator. ${trial}.`;
    case "within_grace":
      return `${trial} — ${formatRemaining(plan.before.msRemaining)} left.`;
    default:
      return `${trial}, and the workspace is locked.`;
  }
}

/**
 * What confirming does, read off the same plan the act will write. The one
 * thing the preview cannot pin is the minute a lapsed trial is counted from,
 * which is the moment of the click — so that case says "around".
 */
function trialOutcome(plan: PlannedExtension): string {
  const opens = plan.before.locked ? "Reopens as soon as you confirm, then locks" : "Locks";
  if (plan.base === "deadline") {
    return `${opens} by itself at ${when(plan.locksAt)} unless the activation payment lands — ${formatRemaining(plan.after.msRemaining)} from now. The time is added to the current deadline, so none of what the customer had left is lost.`;
  }
  return `${opens} by itself ${formatRemaining(plan.hours * HOUR_MS)} after you confirm — around ${when(plan.locksAt)} — unless the activation payment lands. The old deadline has passed, so the time counts from the moment you confirm.`;
}

export function CloneGateActions({
  cloneId,
  cloneName,
  state,
  gate,
  graceHours,
  paid,
  onDone,
  size = "sm",
}: GateActionsProps) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState<string>(graceHours === null ? "" : String(graceHours));
  const [restartClock, setRestartClock] = useState(false);
  /** The extension being previewed, in hours. Blank until the operator picks
   *  one: a pre-chosen week is a week nobody decided on. */
  const [trialHours, setTrialHours] = useState("");
  const [liftLock, setLiftLock] = useState(false);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  /** The minted Stripe URL, held so it can be copied rather than re-minted. */
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<{ error: string; pricingUrl: string | null } | null>(
    null,
  );

  const setOverride = useServerFn(setCloneGateOverride);
  const setWindow = useServerFn(setCloneGateWindow);
  const recordPayment = useServerFn(recordCloneGatePayment);
  const mintLink = useServerFn(mintCloneGatePaymentLink);
  const extendTrial = useServerFn(extendCloneGateTrial);

  if (!gate) return null;

  const close = () => {
    setDialog(null);
    setReason("");
    setRestartClock(false);
    setTrialHours("");
    setLiftLock(false);
    setAmount("");
    setLinkUrl(null);
    setLinkError(null);
  };

  /**
   * Whether sending this customer to Stripe would achieve anything.
   *
   * Unpaid is not enough. An operator lock outranks the money — the resolver
   * reads the override before `paid_at` and settling never clears it — so a
   * link minted against one of those would take a payment and leave the
   * workspace exactly as shut. The server refuses it for the same reason; this
   * is the same rule said in the UI so the button is not offered and then
   * rejected.
   */
  const canSendToStripe = !paid && state.reason !== "operator_locked";

  async function createLink() {
    setBusy(true);
    setLinkError(null);
    try {
      const result = (await mintLink({ data: { cloneId } })) as {
        ok: boolean;
        url?: string;
        error?: string;
        pricingUrl?: string | null;
      };
      if (result.ok && result.url) {
        setLinkUrl(result.url);
        return;
      }
      setLinkError({
        error: result.error ?? "checkout_failed",
        pricingUrl: result.pricingUrl ?? null,
      });
    } catch (err) {
      setLinkError({
        error: err instanceof Error ? err.message : "checkout_failed",
        pricingUrl: null,
      });
    } finally {
      setBusy(false);
    }
  }

  const reasonTooShort = reason.trim().length < 5;

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      const result = (await fn()) as { ok?: boolean; error?: string };
      if (result && result.ok === false) {
        toast.error(result.error ?? "The change was refused");
        return;
      }
      toast.success(success);
      close();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The change failed");
    } finally {
      setBusy(false);
    }
  }

  const hoursParsed = normaliseGraceHours(hours);
  const windowPreview = hoursParsed.ok
    ? hoursParsed.hours === null
      ? "No deadline — the gate will not close on its own."
      : `Locks ${formatRemaining(hoursParsed.hours * 3_600_000)} after ${restartClock ? "now" : "the clone was created"}.`
    : "Enter a whole number of hours, or leave blank for no deadline.";

  // ── The trial extension ──────────────────────────────────────────────────
  //
  // Previewed with `planTrialExtension`, the function the server act writes
  // from, over `gateFactsOf`, the reader it uses — so there is one rule and one
  // reading of the row, and the date on this screen is the date that is
  // written.
  const trialFacts = gateFactsOf(gate);
  const now = new Date();
  /**
   * Offered exactly where the smallest extension would be accepted. Asked with
   * the lock lifted, because a gate an operator locked can still have its
   * trial extended — once the dialog has made the operator say so.
   */
  const trialProbe = planTrialExtension(
    trialFacts,
    { hours: GATE_MIN_HOURS, liftOperatorLock: true },
    now,
  );
  const canExtendTrial = trialProbe.ok;
  const heldShut = trialFacts?.manualOverride === "locked";
  const trialPlan = planTrialExtension(
    trialFacts,
    { hours: trialHours, liftOperatorLock: liftLock && heldShut },
    now,
  );
  const extensionsSoFar = trialExtensionsOf(gate);

  async function extendTrialNow() {
    if (!trialFacts || !trialPlan.ok) return;
    setBusy(true);
    try {
      const result = (await extendTrial({
        data: {
          cloneId,
          hours: trialPlan.hours,
          liftOperatorLock: liftLock && heldShut,
          // What this dialog planned from. The act refuses a gate that has
          // moved since, rather than planning a deadline nobody was shown.
          expected: { locksAt: trialFacts.locksAt, manualOverride: trialFacts.manualOverride },
          reason,
        },
      })) as { ok: boolean; error?: string; locksAt?: string };
      if (!result.ok) {
        toast.error(
          result.error ? describeTrialExtensionRefusal(result.error) : "The extension was refused",
        );
        // "Look again" should show the gate as it now is, not the copy that
        // was just refused.
        if (result.error === "gate_changed") onDone();
        return;
      }
      toast.success(
        `Trial extended — ${cloneName} locks by itself at ${when(result.locksAt)} unless the activation payment lands`,
      );
      close();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The extension failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {/* First, because for a lapsed trial it is the act the operator
            usually means: more time that ends by itself, rather than an
            unlock somebody has to remember to undo. */}
        {canExtendTrial && (
          <Button size={size} variant="outline" onClick={() => setDialog("trial")}>
            <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
            Extend trial
          </Button>
        )}
        {state.locked ? (
          <Button size={size} variant="outline" onClick={() => setDialog("unlock")}>
            <LockOpen className="mr-1.5 h-3.5 w-3.5" />
            Unlock
          </Button>
        ) : (
          <Button size={size} variant="outline" onClick={() => setDialog("lock")}>
            <Lock className="mr-1.5 h-3.5 w-3.5" />
            Lock
          </Button>
        )}
        {/* Only offered when there is something to clear. A button that undoes
            a decision nobody made reads as a third state. */}
        {state.reason === "operator_locked" || state.reason === "operator_unlocked" ? (
          <Button size={size} variant="ghost" onClick={() => setDialog("clear")}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Clear override
          </Button>
        ) : null}
        <Button size={size} variant="ghost" onClick={() => setDialog("window")}>
          <Timer className="mr-1.5 h-3.5 w-3.5" />
          Window
        </Button>
        {/* Offered only where paying would actually open the gate — see
            `canSendToStripe`. A button that mints a link the server will
            refuse is worse than no button. */}
        {canSendToStripe && (
          <Button size={size} variant="ghost" onClick={() => setDialog("link")}>
            <CreditCard className="mr-1.5 h-3.5 w-3.5" />
            Payment link
          </Button>
        )}
        {!paid && (
          <Button size={size} variant="ghost" onClick={() => setDialog("payment")}>
            <BadgeDollarSign className="mr-1.5 h-3.5 w-3.5" />
            Record payment
          </Button>
        )}
      </div>

      {/* ── Lock / Unlock / Clear ─────────────────────────────────────────── */}
      <Dialog
        open={dialog === "lock" || dialog === "unlock" || dialog === "clear"}
        onOpenChange={(o) => !o && close()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog === "lock"
                ? `Lock ${cloneName}`
                : dialog === "unlock"
                  ? `Unlock ${cloneName}`
                  : `Hand ${cloneName} back to the clock`}
            </DialogTitle>
            <DialogDescription>
              {dialog === "lock"
                ? "The workspace is blocked immediately, and stays blocked even if a payment lands. Use this to suspend, not to collect."
                : dialog === "unlock"
                  ? "The workspace opens immediately and stays open, paid or not, until this override is cleared."
                  : "The gate goes back to being decided by the deadline and the payment."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "unlock" && canExtendTrial && state.reason === "grace_expired" && (
            <div className="space-y-2 rounded-md border border-border/60 p-3">
              <p className="text-xs text-muted-foreground">
                Giving the customer more time? Extending the trial reopens the workspace until a new
                deadline and locks it again by itself. An unlock stays open until somebody remembers
                to lock it.
              </p>
              <Button size="sm" variant="outline" onClick={() => setDialog("trial")}>
                <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
                Extend the trial instead
              </Button>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="gate-reason">Reason</Label>
            <Textarea
              id="gate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What you are doing and why — this is the record."
              rows={3}
            />
            {reasonTooShort && (
              <p className="text-xs text-muted-foreground">
                At least five characters. The server requires one too.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || reasonTooShort}
              onClick={() =>
                run(
                  () =>
                    setOverride({
                      data: {
                        cloneId,
                        override:
                          dialog === "lock" ? "locked" : dialog === "unlock" ? "unlocked" : null,
                        reason,
                      },
                    }),
                  dialog === "lock"
                    ? "Workspace locked"
                    : dialog === "unlock"
                      ? "Workspace unlocked"
                      : "Override cleared",
                )
              }
            >
              {dialog === "lock" ? "Lock" : dialog === "unlock" ? "Unlock" : "Clear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Window ────────────────────────────────────────────────────────── */}
      <Dialog open={dialog === "window"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activation window — {cloneName}</DialogTitle>
            <DialogDescription>
              How long this workspace has before it locks. Measured from when the clone was created,
              so setting 72 hours on a clone made yesterday still means three days from creation —
              which is what the customer was told.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {canExtendTrial && (
              <p className="text-xs text-muted-foreground">
                To give a customer more time, use Extend trial instead — it adds to the deadline
                rather than setting it afresh.
              </p>
            )}
            {extensionsSoFar > 0 && (
              <p className="text-xs text-warning">
                This trial has been extended{" "}
                {extensionsSoFar === 1 ? "once" : `${extensionsSoFar} times`}. Saving a window sets
                the deadline afresh from {restartClock ? "now" : "when the clone was created"},
                replacing the extended one ({when(gate.locks_at)}).
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="gate-hours">Hours</Label>
              <Input
                id="gate-hours"
                inputMode="numeric"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder={`${GATE_DEFAULT_HOURS} — blank for no deadline`}
              />
              <p className="text-xs text-muted-foreground">{windowPreview}</p>
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="gate-restart">Restart the clock from now</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  A larger act than extending: it moves the arm time, so the customer gets the full
                  window again from this moment.
                </p>
              </div>
              <Switch id="gate-restart" checked={restartClock} onCheckedChange={setRestartClock} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gate-window-reason">Reason</Label>
              <Textarea
                id="gate-window-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this window is changing."
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || reasonTooShort || !hoursParsed.ok}
              onClick={() =>
                run(
                  () =>
                    setWindow({
                      data: {
                        cloneId,
                        graceHours: hoursParsed.ok ? hoursParsed.hours : null,
                        restartClock,
                        reason,
                      },
                    }),
                  "Activation window updated",
                )
              }
            >
              Save window
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Extend the trial ───────────────────────────────────────────────── */}
      <Dialog open={dialog === "trial"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Extend the trial — {cloneName}</DialogTitle>
            <DialogDescription>
              Moves the deadline later, and nothing else. The workspace is open until the new
              deadline and then locks by itself unless the activation payment lands — there is no
              second step, and nothing for anybody to remember.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {trialProbe.ok && <p className="text-sm">{trialPosition(trialProbe)}</p>}

            {extensionsSoFar > 0 && (
              <p className="text-xs text-muted-foreground">
                <span className="label-mono mr-2">extended ×{extensionsSoFar}</span>
                Most recently {when(gate.trial_extended_at)}
                {gate.trial_extension_reason ? ` — “${gate.trial_extension_reason}”` : ""}
              </p>
            )}

            <div className="space-y-2">
              <Label id="gate-trial-add">Add</Label>
              <div role="group" aria-labelledby="gate-trial-add" className="flex flex-wrap gap-1.5">
                {TRIAL_EXTENSION_PRESET_DAYS.map((days) => {
                  const value = String(days * 24);
                  const active = trialHours.trim() === value;
                  return (
                    <Button
                      key={days}
                      type="button"
                      size="sm"
                      variant={active ? "default" : "outline"}
                      aria-pressed={active}
                      onClick={() => setTrialHours(value)}
                    >
                      {days === 1 ? "1 day" : `${days} days`}
                    </Button>
                  );
                })}
              </div>
              <Label htmlFor="gate-trial-hours" className="sr-only">
                Hours to add
              </Label>
              <Input
                id="gate-trial-hours"
                inputMode="numeric"
                value={trialHours}
                onChange={(e) => setTrialHours(e.target.value)}
                placeholder="or a number of hours, e.g. 36"
                className="max-w-xs"
              />
            </div>

            {heldShut && (
              <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
                <div>
                  <Label htmlFor="gate-trial-lift">Lift the operator lock</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {gate.manual_override_reason
                      ? `Locked because: “${gate.manual_override_reason}”. `
                      : ""}
                    An extension never lifts a lock by itself — suspending a workspace and giving it
                    more time are different decisions.
                  </p>
                </div>
                <Switch id="gate-trial-lift" checked={liftLock} onCheckedChange={setLiftLock} />
              </div>
            )}

            {/* The probe failing is a fact about the GATE (paid, no deadline,
                a year out) and outranks anything about the hours typed. It
                only happens if the gate moved while this dialog was open. */}
            {!trialProbe.ok ? (
              <p className="text-xs text-destructive">
                {describeTrialExtensionRefusal(trialProbe.refusal)}
              </p>
            ) : trialPlan.ok ? (
              <div className="space-y-1 border-l-2 border-primary/60 pl-3">
                <p className="text-sm font-medium">New deadline: {when(trialPlan.locksAt)}</p>
                <p className="text-xs text-muted-foreground">{trialOutcome(trialPlan)}</p>
                {trialPlan.clearsOverride === "unlocked" && (
                  <p className="text-xs text-muted-foreground">
                    It is held open by hand now. Extending hands it back to the clock: the unlock is
                    cleared, so nobody has to remember to lock it again.
                  </p>
                )}
                {trialPlan.clearsOverride === "locked" && (
                  <p className="text-xs text-muted-foreground">
                    The operator lock is lifted with this extension.
                  </p>
                )}
              </div>
            ) : !trialHours.trim() ? (
              <p className="text-xs text-muted-foreground">Choose how much time to add.</p>
            ) : (
              <p className="text-xs text-destructive">
                {describeTrialExtensionRefusal(trialPlan.refusal)}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="gate-trial-reason">Reason</Label>
              <Textarea
                id="gate-trial-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Finance approval lands Friday — a week so onboarding isn't interrupted."
                rows={2}
              />
              {reasonTooShort && (
                <p className="text-xs text-muted-foreground">
                  At least five characters. The server requires one too.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || reasonTooShort || !trialPlan.ok}
              onClick={() => void extendTrialNow()}
            >
              {trialPlan.ok
                ? `Extend by ${formatRemaining(trialPlan.hours * HOUR_MS)}`
                : "Extend trial"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Send the customer to Stripe ───────────────────────────────────── */}
      <Dialog open={dialog === "link"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activation payment link — {cloneName}</DialogTitle>
            <DialogDescription>
              The same Stripe Checkout the workspace&rsquo;s own lock screen opens, minted here so
              you can send it to whoever actually pays. It charges exactly what this gate was armed
              for, and the gate opens by itself the moment Stripe captures it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!linkUrl && !linkError && (
              <p className="text-sm text-muted-foreground">
                Creating the link opens a Stripe Checkout Session and may create a Stripe Customer.
                Nothing is charged until the customer completes it, and nothing about this gate
                changes until they do.
              </p>
            )}

            {linkUrl && (
              <div className="space-y-2">
                <Label htmlFor="gate-link">Payment link</Label>
                {/* A VALUE, never a placeholder. An uncopyable empty box is a
                    defect this platform has already shipped once. */}
                <div className="flex gap-2">
                  <Input id="gate-link" readOnly value={linkUrl} className="font-mono text-xs" />
                  <Button
                    variant="outline"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(linkUrl)
                        .then(() => toast.success("Payment link copied"))
                        .catch(() => toast.error("Could not copy — select the text instead"));
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span className="sr-only">Copy payment link</span>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Stripe Checkout links expire. Mint a fresh one if the customer does not use it
                  promptly.
                </p>
              </div>
            )}

            {linkError && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-sm font-medium">The link could not be created</p>
                <p className="text-xs text-muted-foreground">
                  {linkError.error === "already_paid"
                    ? "This gate is already settled — there is nothing to pay."
                    : linkError.error === "operator_locked"
                      ? "This workspace is locked by an operator. Paying would not open it: clear the override first, then mint a link."
                      : linkError.error === "plan_not_purchasable"
                        ? "The gate's plan has no purchasable catalogue row at the price it quoted. Use the pricing page, where a person chooses and sees the number before paying it."
                        : linkError.error === "no_plan_on_gate"
                          ? "This gate carries no plan, so there is nothing to charge for."
                          : `Stripe refused the request (${linkError.error}).`}
                </p>
                {linkError.pricingUrl && (
                  <a
                    href={linkError.pricingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-4"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open the pricing page
                  </a>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {linkUrl ? "Done" : "Cancel"}
            </Button>
            {linkUrl ? (
              <Button asChild>
                <a href={linkUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open checkout
                </a>
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void createLink()}>
                {busy ? "Creating…" : linkError ? "Try again" : "Create payment link"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Record a payment that did not come through Stripe ─────────────── */}
      <Dialog open={dialog === "payment"} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record an activation payment — {cloneName}</DialogTitle>
            <DialogDescription>
              For money that reached Aurixa outside Stripe Checkout — a bank transfer, an invoice
              settled by hand. It writes the same stamp Stripe writes, so the gate opens the same
              way, and it is attributed to you rather than to Stripe.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="gate-amount">Amount received (cents, optional)</Label>
              <Input
                id="gate-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="86000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gate-payment-reason">What was received, and how</Label>
              <Textarea
                id="gate-payment-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. EFT received 31 Aug, ref NPC-0042, matched to invoice INV-118."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              disabled={busy || reasonTooShort}
              onClick={() =>
                run(
                  () =>
                    recordPayment({
                      data: {
                        cloneId,
                        amountPaidCents: amount.trim() ? Number(amount.trim()) : null,
                        reason,
                      },
                    }),
                  "Payment recorded — the gate is open",
                )
              }
            >
              Record payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
