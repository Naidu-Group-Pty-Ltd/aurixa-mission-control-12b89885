import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CloneGateActions } from "@/components/clone-gate-actions";
import { getCloneGate } from "@/server/payment-gate.functions";
import { describeGateReason, formatRemaining, gateTone } from "@/lib/clonePaymentGate.pure";
import { cn } from "@/lib/utils";

const TONE_CLASS = {
  neutral: "text-muted-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function money(cents: number | null | undefined, currency = "AUD"): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

/**
 * One clone's activation gate, on the clone's own page.
 *
 * The fleet console is where an operator finds the gate they are looking for;
 * this is where somebody already working on one clone sees its state without
 * having to go and find it. Both render the same server-derived status through
 * the same pure module, so they cannot disagree.
 *
 * Renders nothing at all for a clone with no gate — the prime's shape, and
 * every clone that pre-dates this. An "activation: none" panel on 40 clones
 * would be 40 panels saying nothing.
 */
export function ClonePaymentGateCard({
  cloneId,
  cloneName,
}: {
  cloneId: string;
  /** The clone's own name. The action dialogs say "Lock <name>", and a plan
   *  name there would have an operator confirming they are locking "Growth". */
  cloneName: string;
}) {
  const qc = useQueryClient();
  const get = useServerFn(getCloneGate);
  const query = useQuery({
    queryKey: ["clone-gate", cloneId],
    queryFn: () => get({ data: { cloneId } }),
    refetchInterval: 60_000,
  });

  if (query.isLoading) return <Skeleton className="h-32 w-full" />;
  const data = query.data;
  if (!data || !data.gate) return null;

  const tone = gateTone(data.state);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["clone-gate", cloneId] });
    void qc.invalidateQueries({ queryKey: ["clone-payment-gates"] });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-4 w-4" />
          Activation gate
        </CardTitle>
        <span className={cn("font-mono text-[10px] tracking-[0.18em] uppercase", TONE_CLASS[tone])}>
          <span aria-hidden className="mr-1.5 inline-block h-1.5 w-1.5 bg-current align-middle" />
          {data.state.locked ? "locked" : "open"}
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{describeGateReason(data.state)}</p>

        <dl className="grid gap-x-6 gap-y-2 font-mono text-[11px] text-muted-foreground sm:grid-cols-2">
          <div className="flex justify-between gap-3">
            <dt>Plan</dt>
            <dd className="text-foreground">{data.gate.plan_name ?? data.gate.plan_slug ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Activation fee</dt>
            <dd className="text-foreground">
              {money(data.gate.amount_due_cents, data.gate.currency ?? "AUD")}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Armed</dt>
            <dd className="text-foreground">{when(data.gate.armed_at)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>{data.state.counting ? "Locks in" : "Deadline"}</dt>
            <dd className="text-foreground">
              {data.gate.locks_at
                ? data.state.counting
                  ? formatRemaining(data.state.msRemaining)
                  : when(data.gate.locks_at)
                : "none"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Payment</dt>
            <dd className={cn(data.state.paid ? "text-success" : "text-warning")}>
              {data.state.paid
                ? `${when(data.gate.paid_at)} · ${data.gate.payment_source ?? "stripe"}`
                : "not received"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Clone has checked</dt>
            {/* A gate the deployment has never read is indistinguishable from
                a working one unless this is on the page. */}
            <dd className={cn(data.gate.check_count === 0 ? "text-warning" : "text-foreground")}>
              {data.gate.check_count === 0
                ? "never"
                : `${data.gate.check_count}× · ${when(data.gate.last_checked_at)}`}
            </dd>
          </div>
        </dl>

        <CloneGateActions
          cloneId={cloneId}
          cloneName={cloneName}
          state={data.state}
          hasGate
          graceHours={data.gate.grace_hours}
          paid={data.state.paid}
          onDone={refresh}
        />

        {data.events.length > 0 && (
          <details className="group">
            <summary className="label-mono cursor-pointer text-muted-foreground hover:text-foreground">
              History · {data.events.length}
            </summary>
            <ul className="mt-3 space-y-2 border-l border-border/50 pl-4">
              {data.events.slice(0, 12).map((e) => (
                <li key={e.id} className="text-xs">
                  <span className="label-mono mr-2">{e.kind.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground">{when(e.created_at)}</span>
                  {e.status_before !== e.status_after && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {e.status_before} → {e.status_after}
                    </span>
                  )}
                  {e.reason && <p className="mt-0.5 text-muted-foreground">{e.reason}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}

        <Link
          to="/billing/gates"
          className="label-mono block text-muted-foreground hover:underline"
        >
          Open the payment gates console →
        </Link>
      </CardContent>
    </Card>
  );
}
