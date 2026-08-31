import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, ExternalLink, Lock, ShieldCheck, Timer } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { MetricBar } from "@/components/metric-bar";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { RefreshButton } from "@/components/refresh-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CloneGateActions } from "@/components/clone-gate-actions";
import {
  armCloneGate,
  listCloneGates,
  setGateDefaults,
  type GateListRow,
} from "@/server/payment-gate.functions";
import {
  GATE_DEFAULT_HOURS,
  describeGateReason,
  formatRemaining,
  gateTone,
  normaliseGraceHours,
} from "@/lib/clonePaymentGate.pure";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/billing/gates")({
  component: () => (
    <ProtectedRoute>
      <PaymentGatesPage />
    </ProtectedRoute>
  ),
  errorComponent: RouteError,
  head: () => ({ meta: [{ title: "Payment Gates — Mission Control" }] }),
});

const TONE_TO_SPINE: Record<ReturnType<typeof gateTone>, SpineTone> = {
  neutral: "idle",
  success: "ok",
  warning: "warn",
  danger: "bad",
};

/** One word per state. Deliberately says which RULE produced the answer, not
 *  just open/locked: "unlocked by an operator" and "paid" are the same status
 *  and completely different facts. */
const REASON_WORD: Record<string, string> = {
  not_gated: "not gated",
  operator_unlocked: "held open",
  operator_locked: "held shut",
  paid: "paid",
  no_deadline: "no deadline",
  within_grace: "counting down",
  grace_expired: "locked",
};

type Filter = "all" | "locked" | "counting" | "unpaid" | "paid" | "ungated" | "not_gated";

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All clones" },
  { key: "locked", label: "Locked" },
  { key: "counting", label: "Counting down" },
  { key: "unpaid", label: "Unpaid" },
  { key: "paid", label: "Paid" },
  { key: "ungated", label: "Paid plan, no gate" },
  { key: "not_gated", label: "Not gated" },
];

function money(cents: number | null | undefined, currency = "AUD"): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(cents / 100);
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function PaymentGatesPage() {
  const qc = useQueryClient();
  const list = useServerFn(listCloneGates);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const query = useQuery({
    queryKey: ["clone-payment-gates"],
    queryFn: () => list(),
    // Gates move on a clock. A stale count of what is locked is the one number
    // on this page that must not be wrong, so it re-reads rather than caching.
    refetchInterval: 60_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["clone-payment-gates"] });

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const term = search.trim().toLowerCase();
    return all.filter((r) => {
      if (term && !`${r.clone.name} ${r.clone.slug}`.toLowerCase().includes(term)) return false;
      switch (filter) {
        case "locked":
          return r.state.locked;
        case "counting":
          return r.state.counting;
        case "unpaid":
          return r.gate !== null && !r.state.paid;
        case "paid":
          return r.state.paid;
        case "ungated":
          return r.ungatedPaidPlan;
        case "not_gated":
          return r.gate === null;
        default:
          return true;
      }
    });
  }, [query.data, filter, search]);

  const s = query.data?.summary;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="activation"
        title="Payment Gates"
        description="A clone provisioned onto a paid plan boots on a clock and locks when it runs out, until Stripe captures its activation payment. The prime and every clone created before this feature are not gated and never will be."
        actions={<RefreshButton onRefresh={refresh} loading={query.isFetching} />}
      />

      {s && (
        <MetricBar
          metrics={[
            { label: "gated", value: s.gated, note: `${s.total} clones` },
            { label: "locked", value: s.locked, tone: "destructive", alarm: s.locked > 0 },
            { label: "counting down", value: s.counting, tone: "warning", alarm: s.counting > 0 },
            { label: "paid", value: s.paid, tone: "success", alarm: false },
            { label: "unpaid", value: s.unpaid, tone: "warning", alarm: s.unpaid > 0 },
            {
              label: "gap",
              value: s.ungatedPaidPlan,
              tone: "warning",
              alarm: s.ungatedPaidPlan > 0,
              note: "paid plan, no gate",
            },
          ]}
        />
      )}

      <DefaultsPanel
        hours={query.data?.defaults.hours ?? GATE_DEFAULT_HOURS}
        enabled={query.data?.defaults.enabled ?? true}
        onSaved={refresh}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="glass flex flex-wrap overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "label-mono -ml-px border-l border-border/50 px-3 py-2 transition-colors",
                filter === f.key
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-foreground/[0.04]",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name or slug"
          className="max-w-xs"
        />
      </div>

      {query.isLoading ? (
        <CardRowSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Could not read the gates"
          description={query.error instanceof Error ? query.error.message : "Unknown error"}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing here"
          description={
            filter === "all"
              ? "No clones on this deployment."
              : "No clone matches this filter right now."
          }
        />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <GateRow key={row.clone.id} row={row} onDone={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function GateRow({ row, onDone }: { row: GateListRow; onDone: () => void }) {
  const arm = useServerFn(armCloneGate);
  const [busy, setBusy] = useState(false);
  const tone = gateTone(row.state);
  const gate = row.gate;

  async function armNow() {
    setBusy(true);
    try {
      const result = (await arm({ data: { cloneId: row.clone.id } })) as {
        ok: boolean;
        error?: string;
      };
      if (!result.ok) toast.error(`Not armed: ${result.error}`);
      else {
        toast.success("Activation gate armed");
        onDone();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Arming failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <RecordRow spine={TONE_TO_SPINE[tone]} className="p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              to="/clones/$cloneId"
              params={{ cloneId: row.clone.id }}
              className="font-display truncate text-base hover:underline"
            >
              {row.clone.name}
            </Link>
            <span
              className={cn(
                "font-mono text-[10px] tracking-[0.18em] uppercase whitespace-nowrap",
                tone === "danger"
                  ? "text-destructive"
                  : tone === "warning"
                    ? "text-warning"
                    : tone === "success"
                      ? "text-success"
                      : "text-muted-foreground",
              )}
            >
              <span
                aria-hidden
                className="mr-1.5 inline-block h-1.5 w-1.5 bg-current align-middle"
              />
              {REASON_WORD[row.state.reason] ?? row.state.reason}
            </span>
            {row.ungatedPaidPlan && (
              <span className="font-mono text-[10px] tracking-[0.18em] text-warning uppercase">
                · no gate on a paid plan
              </span>
            )}
          </div>

          <p className="text-sm text-muted-foreground">{describeGateReason(row.state)}</p>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
            <span>{row.clone.slug}</span>
            <span aria-hidden>·</span>
            <span>{gate?.plan_slug ?? row.clone.entitled_plan_slug ?? "no plan"}</span>
            {gate && (
              <>
                <span aria-hidden>·</span>
                <span>{money(gate.amount_due_cents, gate.currency ?? "AUD")}</span>
                <span aria-hidden>·</span>
                <span>
                  {gate.locks_at
                    ? row.state.counting
                      ? `locks in ${formatRemaining(row.state.msRemaining)}`
                      : `deadline ${when(gate.locks_at)}`
                    : "no deadline"}
                </span>
                {row.state.paid && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="text-success">
                      paid {when(gate.paid_at)} via {gate.payment_source ?? "stripe"}
                    </span>
                  </>
                )}
                <span aria-hidden>·</span>
                {/* A gate the deployment has never read is indistinguishable
                    from a working one unless this is on the page. */}
                <span className={cn(gate.check_count === 0 && "text-warning")}>
                  {gate.check_count === 0
                    ? "never checked by the clone"
                    : `last checked ${when(gate.last_checked_at)}`}
                </span>
              </>
            )}
            {row.clone.deploy_url && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={row.clone.deploy_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  open <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>

          {gate?.manual_override_reason && (
            <p className="text-xs text-muted-foreground">
              <span className="label-mono mr-2">override</span>
              {gate.manual_override_reason}
            </p>
          )}
        </div>

        <div className="shrink-0 lg:pl-4">
          {gate ? (
            <CloneGateActions
              cloneId={row.clone.id}
              cloneName={row.clone.name}
              state={row.state}
              hasGate
              graceHours={gate.grace_hours}
              paid={row.state.paid}
              onDone={onDone}
            />
          ) : row.ungatedPaidPlan ? (
            <Button size="sm" variant="outline" onClick={armNow} disabled={busy}>
              <Timer className="mr-1.5 h-3.5 w-3.5" />
              Arm gate
            </Button>
          ) : (
            <span className="label-mono text-muted-foreground">no gate</span>
          )}
        </div>
      </div>
    </RecordRow>
  );
}

/**
 * The platform default, and the master switch.
 *
 * The switch turns off ARMING, not existing gates — a feature flag that
 * silently unlocked a fleet on being toggled would be a much larger act than
 * the word "enabled" suggests, so the panel says which one it is.
 */
function DefaultsPanel({
  hours,
  enabled,
  onSaved,
}: {
  hours: number;
  enabled: boolean;
  onSaved: () => void;
}) {
  const save = useServerFn(setGateDefaults);
  const [value, setValue] = useState(String(hours));
  const [busy, setBusy] = useState(false);
  const parsed = normaliseGraceHours(value);
  const valid = parsed.ok && parsed.hours !== null;

  async function commit(patch: { hours?: number; enabled?: boolean }) {
    setBusy(true);
    try {
      const result = (await save({ data: patch })) as { ok: boolean; error?: string };
      if (!result.ok) toast.error(result.error ?? "Could not save");
      else {
        toast.success("Defaults saved");
        onSaved();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass p-5">
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="label-mono">platform default</p>
          <h2 className="font-display text-lg">New paid clones get {hours} hours</h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            The window every newly provisioned paid clone is armed with. Changing it affects the
            next clone, never one that already exists — an armed gate keeps the window its customer
            was told about.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-2">
            <Label htmlFor="default-hours">Hours</Label>
            <div className="flex gap-2">
              <Input
                id="default-hours"
                inputMode="numeric"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-28"
              />
              <Button
                variant="outline"
                disabled={busy || !valid || Number(value) === hours}
                onClick={() => commit({ hours: Number(value) })}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="gate-enabled" className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5" />
              Arm new gates
            </Label>
            <div className="flex h-9 items-center gap-3">
              <Switch
                id="gate-enabled"
                checked={enabled}
                disabled={busy}
                onCheckedChange={(next) => commit({ enabled: next })}
              />
              <span className="font-mono text-[11px] text-muted-foreground">
                {enabled ? "on — new paid clones are gated" : "off — existing gates are untouched"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
