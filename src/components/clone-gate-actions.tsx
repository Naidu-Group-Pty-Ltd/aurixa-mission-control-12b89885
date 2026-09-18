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
  mintCloneGatePaymentLink,
  recordCloneGatePayment,
  setCloneGateOverride,
  setCloneGateWindow,
} from "@/server/payment-gate.functions";
import {
  GATE_DEFAULT_HOURS,
  formatRemaining,
  normaliseGraceHours,
  type GateState,
} from "@/lib/clonePaymentGate.pure";

/**
 * The four acts an operator can perform on one gate.
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
  hasGate: boolean;
  graceHours: number | null;
  paid: boolean;
  onDone: () => void;
  /** `sm` in a dense list row. */
  size?: "sm" | "default";
};

type OpenDialog = "lock" | "unlock" | "clear" | "window" | "payment" | "link" | null;

export function CloneGateActions({
  cloneId,
  cloneName,
  state,
  hasGate,
  graceHours,
  paid,
  onDone,
  size = "sm",
}: GateActionsProps) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState<string>(graceHours === null ? "" : String(graceHours));
  const [restartClock, setRestartClock] = useState(false);
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

  if (!hasGate) return null;

  const close = () => {
    setDialog(null);
    setReason("");
    setRestartClock(false);
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

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
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
              so extending to 72 hours on a clone made yesterday still means three days from
              creation — which is what the customer was told.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
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
