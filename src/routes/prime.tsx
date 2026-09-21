/**
 * The prime repository's own health.
 *
 * Every other observability surface in this console looks DOWNSTREAM — fleet
 * health walks the clones, drift lists what they have diverged on, cascades
 * report what was delivered. This one looks at the source, because the fleet
 * cannot be healthier than the repository it is copied from and nothing here
 * could answer "is the prime green?" without opening GitHub.
 *
 * ## The one thing this page must not imply
 *
 * It is a MIRROR, not a gate. A push to prime's default branch fans out to
 * every clone immediately — `hooks.github.tsx` resolves `prime_config`,
 * confirms the ref and calls `createCascadeForAllClones` without consulting a
 * single check run. So a verdict rendered here in red does not stop anything,
 * and an operator who believes it does is worse off than one who never opened
 * the page.
 *
 * That is why `GateStanding` is drawn permanently rather than as a tooltip or
 * a footnote: a control that does not exist must not be implied by a light
 * that looks like one. This repository has already paid for the inverse — a
 * dead "Approve the gate" button that did nothing when pressed — and the rule
 * it bought applies in both directions.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Database,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  PlayCircle,
  Wrench,
  RefreshCw,
  Stethoscope,
  ShieldQuestion,
  SplitSquareHorizontal,
  Waves,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { RecordRow } from "@/components/record-row";
import { MetricCell } from "@/components/metric-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { fetchPrimeHealth } from "@/server/prime-health.functions";
import { fetchCloneComparison, fetchPrimeMigrationLedger } from "@/server/prime-ledger.functions";
import {
  applyPrimeMigration,
  fetchMigrationDiagnosis,
  fetchMigrationRepairPlan,
  proposePrimeMigrationRepair,
} from "@/server/prime-migration-fix.functions";
import {
  REFUSAL_WORDS,
  REMEDY_TONE,
  REMEDY_WORDS,
  REPAIR_WORDS,
  RERUN_TONE,
  RERUN_WORDS,
} from "@/lib/migrationRepairLabels";
// Types only, and through the server-function module rather than the pure one.
// A route is bundled for the browser, so importing `src/server/**` for a VALUE
// is refused by TanStack Start's import protection — correctly. Every
// judgement this page draws is therefore made on the server and travels in the
// payload; nothing here re-derives one.
import type {
  PrimeHealth,
  PrimeCommitReading,
  DeliveryReading,
  HeadCheckReading,
  PullRequestCi,
  PullRequestReading,
  SafetyTone,
  WorkflowSummary,
} from "@/server/prime-health.functions";
import type {
  CloneComparison as CloneComparisonReading,
  ComparedBlocker,
  ComparisonVerdict,
  PrimeLedgerReading,
  WithheldRow,
} from "@/server/prime-ledger.functions";
import type {
  DiagnosisVerdict,
  Hazard,
  HazardKind,
  MigrationDiagnosis,
  Repair,
  RepairPlanReport,
  RepairRefusal,
  VersionCollision,
} from "@/server/prime-migration-fix.functions";

export const Route = createFileRoute("/prime")({
  errorComponent: RouteError,
  /*
    One optional search param, so the migration list can hand a file over.

    `/prime-migrations` reads every held-back migration cheaply and cannot say
    whether any of them APPLIES — only a trial run against the prime does
    that, and it lives here. A list that could not send you to the answer
    would be a dead end, so the row carries the version and the doctor below
    opens on it.

    Validated to the one shape a version is ever written in. Anything else
    resolves to none rather than throwing, because a mistyped URL must land on
    the page it names rather than on an error boundary.
  */
  validateSearch: (raw: Record<string, unknown>): { migration?: string } => {
    const v = raw.migration;
    return typeof v === "string" && /^\d{14}$/.test(v) ? { migration: v } : {};
  },
  component: () => (
    <ProtectedRoute>
      <PrimeRepositoryPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Prime repository — Aurixa Systems Mission Control" },
      {
        name: "description",
        content:
          "The health of the repository every clone is copied from: whether its head has " +
          "been built, whether that commit is travelling, and what is queued behind it.",
      },
    ],
  }),
});

const PRIME_KEY = ["prime-health"] as const;

function PrimeRepositoryPage() {
  const fetchFn = useServerFn(fetchPrimeHealth);
  const query = useQuery({
    queryKey: PRIME_KEY,
    queryFn: () => fetchFn(),
    // Six GitHub calls a visit. Refetching on every window focus would spend
    // the installation's hourly window on tab switching.
    refetchOnWindowFocus: false,
  });

  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="source of the fleet"
        title="Prime repository"
        description={
          data?.configured
            ? `${data.repo.owner}/${data.repo.repo} · ${data.repo.defaultBranch} — the tree every clone is copied from.`
            : "The repository every clone is copied from."
        }
        actions={
          <>
            {data?.configured && (
              <Button variant="ghost" size="sm" asChild>
                <a href={data.repo.htmlUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  GitHub
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-label="Re-read prime health"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn("mr-1.5 h-4 w-4", query.isFetching && "animate-spin")} />
              {query.isFetching ? "Reading…" : "Re-read"}
            </Button>
          </>
        }
      />

      {query.isPending ? (
        <LoadingShape />
      ) : query.error ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Could not read prime health"
          description={
            query.error instanceof Error ? query.error.message : "The read failed on the server."
          }
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Retry
            </Button>
          }
        />
      ) : data && !data.configured ? (
        <EmptyState
          icon={<ShieldQuestion />}
          title="No prime is configured"
          description={data.reason}
          action={
            <Button variant="outline" asChild>
              <Link to="/settings/github-access">Open GitHub settings</Link>
            </Button>
          }
        />
      ) : data ? (
        <PrimeReading data={data} />
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── the reading ─────────────────────────────── */

type Configured = Extract<PrimeHealth, { configured: true }>;

function PrimeReading({ data }: { data: Configured }) {
  return (
    <div className="space-y-6">
      <Verdict data={data} />
      <Numbers data={data} />
      <GateStanding data={data} />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <CommitLedger data={data} />
        <div className="space-y-6">
          <HeadChecks data={data} />
          <OpenPullRequests data={data} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <WorkflowTrendPanel data={data} />
        <LastDelivery data={data} />
      </div>

      <PrimeSqlLedger />
      <MigrationDoctor />
      <ClonesHeldAgainstPrime />

      <Provenance data={data} />
    </div>
  );
}

/** The single answer, with the commit it is about. */
function Verdict({ data }: { data: Configured }) {
  const { posture, gate, head, coverage } = data;
  return (
    <Card className={cn("spine", SPINE[posture.tone])}>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <span className={cn("font-display text-[2rem] leading-none", TONE_TEXT[posture.tone])}>
            {posture.word}
          </span>
          {/* A basis, not bare `flex-1`. `flex: 1 1 0%` contributes zero to the
              hypothetical size, so a sibling that does not overflow on its own
              never forces the wrap and this sentence takes whatever is left —
              which on the AUSTRAC hub was eighteen pixels and a heading 532px
              tall. A column that must not be crushed declares its width. */}
          <p className="min-w-0 flex-1 basis-64 text-sm">{posture.sentence}</p>
        </div>

        {head ? (
          <div className="glass-inset flex flex-wrap items-center gap-x-3 gap-y-1 p-3 font-mono text-[11px]">
            <a
              href={head.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
            >
              {head.shortSha}
            </a>
            <span className="min-w-0 flex-1 truncate font-sans text-xs text-foreground">
              {head.headline || "(no commit message)"}
            </span>
            <span className="text-muted-foreground">
              {head.author ?? "unknown"} · {formatDistanceToNow(head.authoredAt)}
            </span>
          </div>
        ) : (
          <Unreadable what="Prime's head commit" why={data.headError} />
        )}

        <dl className="grid gap-3 sm:grid-cols-2">
          <Reading label="checks on this commit" body={gate.verdict.why} />
          <Reading label="is it travelling" body={coverage.why} />
        </dl>

        {gate.remedy && (
          <p className="border-l-2 border-warning/60 pl-3 text-xs text-muted-foreground">
            {gate.remedy}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Reading({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <dt className="label-mono">{label}</dt>
      <dd className="mt-1 text-xs text-muted-foreground">{body}</dd>
    </div>
  );
}

/**
 * The numbers.
 *
 * `—` rather than `0` wherever the reading is absent. A repository whose
 * workflows could not be listed has no success rate, and rendering 0% would
 * report a healthy prime as entirely broken — which is the defect this fleet
 * has already shipped twice, under the name "absent is never zero".
 */
function Numbers({ data }: { data: Configured }) {
  const checks = data.headChecks;
  const decided = checks.filter((c) => c.outcome !== "running");
  const green = checks.filter((c) => c.outcome === "passing");
  const prsFailing = data.pullRequests.filter((p) => p.ci === "failing").length;
  const rate = data.trend.totals.successRate;
  const streak = data.trend.consecutiveFailures;
  const landed = data.delivery
    ? data.delivery.clones.filter((c) => c.status === "succeeded").length
    : null;

  // The alarm is the gate's own verdict rather than a count this cell
  // recomputes: `in_flight` is not something to act on, and `unproven` is,
  // which no ratio of green-to-total can express.
  const gateTone = data.gate.tone;

  return (
    <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-3 lg:grid-cols-6">
      <MetricCell
        label="head checks"
        size="sm"
        value={checks.length === 0 ? "—" : `${green.length}/${checks.length}`}
        note={
          checks.length === 0
            ? "nothing reported"
            : data.gate.proven
              ? "fit to travel"
              : `${decided.length} finished`
        }
        tone={gateTone === "bad" ? "destructive" : "warning"}
        alarm={gateTone === "bad" || gateTone === "warn"}
      />
      <MetricCell
        label="main success"
        size="sm"
        value={rate === null ? "—" : `${rate}%`}
        note={
          rate === null
            ? "nothing decided"
            : `${data.trend.totals.failed} failed of ${data.trend.totals.succeeded + data.trend.totals.failed}`
        }
        tone="warning"
        alarm={rate !== null && rate < 80}
      />
      <MetricCell
        label="red in a row"
        value={data.trend.empty ? "—" : streak}
        note={data.trend.empty ? "no decided run" : "on the default branch"}
        tone="destructive"
        alarm={streak > 0}
      />
      <MetricCell
        label="open PRs"
        value={data.pullRequestsError ? "—" : data.pullRequests.length}
        note={
          data.pullRequestsError
            ? "unreadable"
            : prsFailing > 0
              ? `${prsFailing} failing`
              : "next payloads"
        }
        tone="warning"
        alarm={prsFailing > 0}
      />
      <MetricCell
        label="last cascade"
        size="sm"
        value={data.delivery ? data.delivery.status : "—"}
        note={
          data.delivery
            ? `${landed} of ${data.delivery.clones.length} landed`
            : (data.deliveryError ?? "no cascade recorded")
        }
        tone="destructive"
        alarm={data.delivery?.status === "failed"}
      />
      <MetricCell
        label="api window"
        size="sm"
        value={data.rateLimitRemaining === null ? "—" : data.rateLimitRemaining}
        note={data.rateLimitRemaining === null ? "unread" : "calls left this hour"}
        tone="warning"
        alarm={data.rateLimitRemaining !== null && data.rateLimitRemaining < 500}
      />
    </div>
  );
}

/**
 * What the verdict above does and does not do.
 *
 * Permanent, and deliberately not dismissible. The whole value of the reading
 * collapses if an operator reads the red band as a stop sign, and the honest
 * statement is short enough that it costs a line.
 */
function GateStanding({ data }: { data: Configured }) {
  const mode = data.repo.cascadeMode;
  return (
    <div className="glass-inset spine spine-idle p-4">
      <p className="label-mono">how this commit reaches the fleet</p>
      <p className="mt-2 text-xs text-muted-foreground">
        A push to <span className="font-mono text-foreground">{data.repo.defaultBranch}</span>{" "}
        creates a cascade to every clone immediately, in{" "}
        <span className="font-mono text-foreground">{mode}</span> mode. Prime&rsquo;s own check runs
        are not consulted before that happens — this page reports the verdict, it does not enforce
        it.
        {mode === "notify" ? (
          <> Clones are notified rather than written to, so nothing lands unattended.</>
        ) : (
          <>
            {" "}
            {mode === "auto_merge"
              ? "The engine reads each clone's checks as it opens the proposal and merges a green one straight away."
              : "Each clone receives a pull request rather than a direct push."}{" "}
            Either way the merge drain merges any open proposal once{" "}
            <span className="font-mono">verify</span> and{" "}
            <span className="font-mono">security</span> pass <em>on the clone</em> — it claims every
            row at <span className="font-mono">pr_opened</span> and does not filter by mode. So a
            red prime does not land; it stops the fleet receiving code, quietly.
          </>
        )}
      </p>
    </div>
  );
}

/* ───────────────────────────── the commit ledger ─────────────────────────── */

/**
 * The last commits on prime, each with what built it and what carried it.
 *
 * This is the page's centre. Every other panel answers a question about now;
 * this one answers "did something go out that should not have?", which is the
 * question an operator arrives with after a clone breaks.
 */
function CommitLedger({ data }: { data: Configured }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitCommitHorizontal className="h-4 w-4 text-muted-foreground" />
          Recent commits on {data.repo.defaultBranch}
        </CardTitle>
        <CardDescription>
          What built each commit, and which cascade carried it. A commit with no cascade of its own
          folded into one already queued — the engine reads prime&rsquo;s head when it runs.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.commitsError ? (
          <Unreadable what="Prime's commit history" why={data.commitsError} />
        ) : data.commits.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No commits were returned for this branch.
          </p>
        ) : (
          data.commits.map((c) => <CommitRow key={c.sha} commit={c} />)
        )}
      </CardContent>
    </Card>
  );
}

function CommitRow({ commit }: { commit: PrimeCommitReading }) {
  return (
    <RecordRow
      spine={CI_SPINE[commit.ci]}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
    >
      <a
        href={commit.htmlUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="font-mono text-[11px] text-primary hover:underline"
      >
        {commit.shortSha}
      </a>
      <span className="min-w-0 flex-1 basis-40 truncate text-xs">
        {commit.headline || "(no commit message)"}
      </span>
      <CiWord ci={commit.ci} />
      {commit.cascadeEventId ? (
        <Link
          to="/cascades/$eventId"
          params={{ eventId: commit.cascadeEventId }}
          className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase hover:text-primary"
        >
          cascade {commit.cascadeStatus}
        </Link>
      ) : (
        <span
          className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground/50 uppercase"
          title="No cascade event names this commit. It folded into one already queued, or the push webhook never arrived."
        >
          folded / none
        </span>
      )}
      <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
        {formatDistanceToNow(commit.authoredAt)}
      </span>
    </RecordRow>
  );
}

/* ──────────────────────────────── the detail ─────────────────────────────── */

function HeadChecks({ data }: { data: Configured }) {
  const checks = [...data.headChecks].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Checks on the head</CardTitle>
        <CardDescription>
          Judged by the same rule the cascade applies to every clone&rsquo;s pull request —{" "}
          <span className="font-mono">verify</span> and <span className="font-mono">security</span>{" "}
          must have reported and passed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.headChecksError ? (
          <Unreadable what="The check runs on prime's head" why={data.headChecksError} />
        ) : checks.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing has reported on this commit.
          </p>
        ) : (
          checks.map((c) => <CheckRow key={`${c.name}:${c.started_at ?? ""}`} check={c} />)
        )}
      </CardContent>
    </Card>
  );
}

function CheckRow({ check }: { check: HeadCheckReading }) {
  // The outcome arrives already decided, from the module that owns
  // `PASSING_CONCLUSIONS`. A list inlined here would be a copy of that rule
  // living in JSX, where no test reaches it.
  const { outcome } = check;
  const tone: SafetyTone = outcome === "running" ? "live" : outcome === "passing" ? "ok" : "bad";
  // The row shows GitHub's own word rather than the verdict's, because an
  // operator scanning for "why" needs `timed_out` and `cancelled` told apart.
  const word =
    outcome === "running" ? check.status.replace("_", " ") : (check.conclusion ?? "no conclusion");
  return (
    <RecordRow spine={tone} className="flex items-center justify-between gap-3 p-2.5">
      <span className="min-w-0 truncate font-mono text-[11px]">{check.name}</span>
      <span
        className={cn(
          "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
          TONE_TEXT[tone],
        )}
      >
        {word}
      </span>
    </RecordRow>
  );
}

function OpenPullRequests({ data }: { data: Configured }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
          Open pull requests
        </CardTitle>
        <CardDescription>
          Whichever of these merges next becomes the fleet&rsquo;s next cascade. CI is read from the
          same run window as the trend, so a head the window does not name reads{" "}
          <span className="font-mono">unobserved</span> rather than green.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.pullRequestsError ? (
          <Unreadable what="Prime's open pull requests" why={data.pullRequestsError} />
        ) : data.pullRequests.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing is open against prime.
          </p>
        ) : (
          data.pullRequests.map((pr) => <PullRequestRow key={pr.number} pr={pr} />)
        )}
      </CardContent>
    </Card>
  );
}

function PullRequestRow({ pr }: { pr: PullRequestReading }) {
  return (
    <RecordRow
      spine={pr.draft ? "idle" : CI_SPINE[pr.ci]}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
    >
      <a
        href={pr.htmlUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="font-mono text-[11px] text-primary hover:underline"
      >
        #{pr.number}
      </a>
      <span className="min-w-0 flex-1 basis-32 truncate text-xs">{pr.title}</span>
      {pr.draft && (
        <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          draft
        </span>
      )}
      <CiWord ci={pr.ci} />
      <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
        {formatDistanceToNow(pr.updatedAt)}
      </span>
    </RecordRow>
  );
}

/* ───────────────────────────────── the trend ─────────────────────────────── */

function WorkflowTrendPanel({ data }: { data: Configured }) {
  const { trend, trendWindow } = data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workflow history</CardTitle>
        <CardDescription>
          {trendWindow.oldest
            ? `The ${trendWindow.runs} most recent runs on this repository, back to ${formatDistanceToNow(trendWindow.oldest)} — default-branch runs only.`
            : "How often each workflow breaks on the default branch."}{" "}
          Cancelled and skipped runs are counted separately from failures; a rate over no decided
          run is <span className="font-mono">—</span>, never 0%.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.trendError ? (
          <Unreadable what="Prime's workflow runs" why={data.trendError} />
        ) : trend.workflows.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No workflow run in the window targeted {data.repo.defaultBranch}.
          </p>
        ) : (
          trend.workflows.map((w) => <WorkflowRow key={w.name} workflow={w} />)
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowRow({ workflow: w }: { workflow: WorkflowSummary }) {
  const tone: SafetyTone =
    w.successRate === null
      ? "idle"
      : w.successRate === 100
        ? "ok"
        : w.successRate < 80
          ? "bad"
          : "warn";
  return (
    <RecordRow spine={tone} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
      <span className="min-w-0 flex-1 basis-32 truncate font-mono text-[11px]">{w.name}</span>
      <span className={cn("numeral text-sm", TONE_TEXT[tone])}>
        {w.successRate === null ? "—" : `${w.successRate}%`}
      </span>
      <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
        {w.failed} failed · {w.succeeded} passed
        {w.running > 0 && ` · ${w.running} running`}
        {w.inconclusive > 0 && ` · ${w.inconclusive} inconclusive`}
      </span>
      {w.lastFailureAt && (
        <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground/70">
          last red {formatDistanceToNow(w.lastFailureAt)}
        </span>
      )}
    </RecordRow>
  );
}

/* ─────────────────────────────── the delivery ────────────────────────────── */

function LastDelivery({ data }: { data: Configured }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Waves className="h-4 w-4 text-muted-foreground" />
          Where the last cascade got to
        </CardTitle>
        <CardDescription>
          Prime&rsquo;s health is only interesting because of what it reaches. This is the most
          recent cascade, clone by clone.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.deliveryError ? (
          <Unreadable what="The cascade ledger" why={data.deliveryError} />
        ) : !data.delivery ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No cascade has been recorded.
          </p>
        ) : (
          <DeliveryBody delivery={data.delivery} />
        )}
      </CardContent>
    </Card>
  );
}

function DeliveryBody({ delivery }: { delivery: DeliveryReading }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1">
        <Link
          to="/cascades/$eventId"
          params={{ eventId: delivery.eventId }}
          className="font-mono text-[11px] text-primary hover:underline"
        >
          {delivery.sourceSha ? delivery.sourceSha.slice(0, 7) : delivery.eventId.slice(0, 8)}
        </Link>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {delivery.summary ?? "(no summary)"}
        </span>
        <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
          {delivery.status} · {delivery.mode} · {formatDistanceToNow(delivery.createdAt)}
        </span>
      </div>
      {delivery.clones.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          This cascade has no per-clone result rows.
        </p>
      ) : (
        delivery.clones.map((c) => (
          <RecordRow
            key={c.cloneId}
            spine={RESULT_SPINE[c.status] ?? "idle"}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
          >
            <Link
              to="/clones/$cloneId"
              params={{ cloneId: c.cloneId }}
              className="min-w-0 flex-1 basis-32 truncate text-xs hover:text-primary"
            >
              {c.name}
            </Link>
            <span
              className={cn(
                "font-mono text-[10px] tracking-[0.12em] uppercase",
                TONE_TEXT[RESULT_SPINE[c.status] ?? "idle"],
              )}
            >
              {c.status.replace("_", " ")}
            </span>
            {c.filesChanged > 0 && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {c.filesChanged} files
              </span>
            )}
            {c.prUrl && (
              <a
                href={c.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-[10px] text-primary hover:underline"
              >
                PR
              </a>
            )}
            {c.errorMessage && (
              <span
                className="w-full truncate font-mono text-[10px] text-destructive"
                title={c.errorMessage}
              >
                {c.errorMessage}
              </span>
            )}
          </RecordRow>
        ))
      )}
    </>
  );
}

/* ───────────────────────────────── provenance ────────────────────────────── */

/**
 * The two halves.
 *
 * `docs/PRIME_HAS_TWO_HALVES.md` records what it cost to conflate them: every
 * clone-provisioning path that said "replicate from the prime" replicated from
 * Mission Control's own database instead, succeeded, and produced confident
 * wrong results. A page called "prime" that showed only the repository would
 * invite the same reading, so the backend half is named here even though
 * nothing on this page measures it.
 */
function Provenance({ data }: { data: Configured }) {
  return (
    <div className="glass-inset grid gap-4 p-4 sm:grid-cols-3">
      <Fact label="prime repo" value={`${data.repo.owner}/${data.repo.repo}`} />
      <Fact
        label="prime backend"
        value={data.repo.supabaseProjectRef ?? "not set"}
        muted={!data.repo.supabaseProjectRef}
        note={
          data.repo.supabaseProjectRef
            ? "the project clones are replicated from"
            : "clone-backend provisioning refuses until this is set"
        }
      />
      <Fact
        label="read at"
        value={formatDistanceToNow(data.readAt)}
        note={data.repo.followsLineage ? "cascade follows lineage" : "cascade follows head"}
      />
    </div>
  );
}

function Fact({
  label,
  value,
  note,
  muted,
}: {
  label: string;
  value: string;
  note?: string;
  muted?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="label-mono">{label}</p>
      <p
        className={cn(
          "mt-1 truncate font-mono text-xs",
          muted ? "text-warning" : "text-foreground",
        )}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-[10px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/* ─────────────────────────── the prime's SQL ledger ───────────────────────── */

const LEDGER_KEY = ["prime-migration-ledger"] as const;

/**
 * What the prime holds in SQL, and what it has actually run.
 *
 * Its own query rather than a field on the health payload, for two reasons.
 * It touches a different service — the Management API against the prime's own
 * project — so a Supabase refusal must not blank the six GitHub readings above
 * it. And it yields at the GitHub scan floor, so on a spent window this panel
 * says why while the rest of the page is unaffected.
 */
function PrimeSqlLedger() {
  const fetchFn = useServerFn(fetchPrimeMigrationLedger);
  const query = useQuery({
    queryKey: LEDGER_KEY,
    queryFn: () => fetchFn(),
    refetchOnWindowFocus: false,
  });

  const result = query.data;
  const reading = result?.ok ? result.reading : null;

  return (
    <Card className={cn("spine", SPINE[reading?.tone ?? "idle"])}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          SQL migration ledger
        </CardTitle>
        <CardDescription>
          The migrations on this branch against the ones the prime&rsquo;s own database records as
          run. A clone is never sent a migration the prime has not run, so anything missing here
          holds the whole fleet at the version before it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? (
          <Skeleton className="h-28 w-full" />
        ) : query.error ? (
          <Unreadable
            what="The prime's SQL position"
            why={query.error instanceof Error ? query.error.message : "The read failed."}
          />
        ) : result && !result.ok ? (
          <Unreadable what="The prime's SQL position" why={result.error} />
        ) : reading ? (
          <LedgerBody reading={reading} primeRef={result?.ok ? result.primeRef : null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function LedgerBody({
  reading,
  primeRef,
}: {
  reading: PrimeLedgerReading;
  primeRef: string | null;
}) {
  return (
    <>
      <p className={cn("text-sm", TONE_TEXT[reading.tone])}>{reading.headline}</p>

      {reading.standing !== "unreadable" && (
        <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
          <MetricCell
            label="on this branch"
            size="sm"
            value={reading.corpusCount ?? "—"}
            note="migration files"
          />
          <MetricCell
            label="deliverable"
            size="sm"
            value={reading.runnableCount ?? "—"}
            note="the prime has run these"
          />
          <MetricCell
            label="held back"
            size="sm"
            value={reading.withheldCount ?? "—"}
            note={
              reading.skewSuspected
                ? `${reading.skewSuspected} may be a timestamp skew`
                : "no clone may run these"
            }
            tone="warning"
            alarm={(reading.withheldCount ?? 0) > 0}
          />
          <MetricCell
            label="ledger rows"
            size="sm"
            value={reading.ledgerCount ?? "—"}
            note={
              reading.unmatchedLedgerRows === null
                ? "on the prime"
                : `${reading.unmatchedLedgerRows} match no file here`
            }
          />
        </div>
      )}

      {reading.frontier && (
        <p className="text-xs text-muted-foreground">
          Every clone is measured against{" "}
          <span className="font-mono text-foreground">{reading.frontier}</span> — the newest version
          the prime has both merged and run
          {primeRef ? (
            <>
              {" "}
              on <span className="font-mono text-foreground">{primeRef}</span>
            </>
          ) : null}
          .
        </p>
      )}

      {reading.withheld.length > 0 && (
        <div className="space-y-2">
          <p className="label-mono">held back, newest first</p>
          {reading.withheld.map((row) => (
            <WithheldMigrationRow key={row.id} row={row} />
          ))}
          {reading.withheldCount !== null && reading.withheldCount > reading.withheld.length && (
            <p className="text-[10px] text-muted-foreground">
              {reading.withheldCount - reading.withheld.length} older file(s) not listed. The count
              above is exact; only this list is capped.
            </p>
          )}
        </div>
      )}

      {reading.remedy && (
        <div className="glass-inset spine spine-warn p-3">
          <p className="label-mono">what clears it</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{reading.remedy}</p>
        </div>
      )}
    </>
  );
}

function WithheldMigrationRow({ row }: { row: WithheldRow }) {
  // A skew suspicion is amber and never green: two migrations authored seconds
  // apart are indistinguishable to that test, so it is a hypothesis for a
  // person and not a clearance.
  const suspected = row.reason === "skew_suspected";
  return (
    <RecordRow spine={suspected ? "warn" : "bad"} className="flex flex-wrap gap-x-3 gap-y-1 p-2.5">
      {/* A basis, not bare `flex-1`: `flex: 1 1 0%` contributes nothing to the
          hypothetical size, so a filename beside a fixed-width note would be
          handed whatever is left however small that is. */}
      <span className="min-w-0 basis-[18rem] truncate font-mono text-[11px] text-foreground">
        {row.name}
      </span>
      <span
        className={cn(
          "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
          suspected ? TONE_TEXT.warn : TONE_TEXT.bad,
        )}
      >
        {suspected ? "skew suspected" : "never applied"}
      </span>
      {suspected && row.nearestPrimeVersion && (
        <span className="font-mono text-[10px] text-muted-foreground">
          nearest {row.nearestPrimeVersion}
          {row.skewSeconds === null ? "" : ` (${row.skewSeconds}s)`}
        </span>
      )}
    </RecordRow>
  );
}

/* ───────────────────── diagnose one migration, and fix it ────────────────── */

const DIAGNOSIS_KEY = (version: string | null) => ["prime-migration-diagnosis", version] as const;

/**
 * Open one of the prime's held-back migrations and say what is wrong with it.
 *
 * The ledger above says HOW MANY are holding the fleet back. This says why one
 * of them is, and — on the single verdict that earns it — offers to run it
 * through the prime's own `apply-migration.yml`.
 *
 * ## Why the button is so rarely drawn
 *
 * `dispatchable` is set by the server on one verdict out of nine, and this
 * page reads that field rather than the verdict word. Everything else explains
 * and offers nothing, because `a dead control is worse than no control` and
 * a live one here spends the prime's production database.
 *
 * Withholding the shortcut never withholds the act: `apply-migration.yml` is
 * still on the prime and still runnable by hand, which is exactly what the
 * remedy says to do.
 */
function MigrationDoctor() {
  // The version the migration list handed over, if it did. It seeds the
  // selection once; everything after that is the operator's choice, so
  // arriving with a link never fights a click.
  const handedOver = Route.useSearch().migration;
  const ledgerFn = useServerFn(fetchPrimeMigrationLedger);
  const ledger = useQuery({
    queryKey: LEDGER_KEY,
    queryFn: () => ledgerFn(),
    refetchOnWindowFocus: false,
  });

  // Controlled from empty rather than from `undefined`: a Select that starts
  // uncontrolled and gains a value switches mode mid-life and React warns.
  const [picked, setPicked] = useState(handedOver ?? "");
  const version = picked || null;

  const diagnoseFn = useServerFn(fetchMigrationDiagnosis);
  const diagnosis = useQuery({
    queryKey: DIAGNOSIS_KEY(version),
    queryFn: () => diagnoseFn({ data: { version: version! } }),
    enabled: version !== null,
    refetchOnWindowFocus: false,
  });

  /*
    Three states, not two.

    `withheld` is `[]` while the ledger is in flight, `[]` when the read
    FAILED, and `[]` when the prime is genuinely level — and only the third of
    those is "nothing is held back". Collapsing them is the rule this
    repository has paid for repeatedly (`a read that FAILED is not a row that
    is ABSENT`), most recently on a builder's own page, where `uploads.length`
    made a headline statement about a builder with six stock lists.
  */
  const ledgerRead = ledger.data?.ok === true;
  const ledgerWhy = ledger.error
    ? ledger.error instanceof Error
      ? ledger.error.message
      : "The read failed."
    : ledger.data && !ledger.data.ok
      ? ledger.data.error
      : null;
  const withheld = ledger.data?.ok ? ledger.data.reading.withheld : [];
  const report = diagnosis.data?.ok ? diagnosis.data : null;

  return (
    <Card className="spine spine-idle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          Diagnose a held-back migration
        </CardTitle>
        <CardDescription>
          Reads the file, asks the prime&rsquo;s own catalogue about it, and tries it inside a
          transaction that is always rolled back. Nothing is applied by looking.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* A basis rather than bare `flex-1`: `flex: 1 1 0%` contributes
              nothing to the hypothetical size, so a select beside a button
              would be handed the leftovers however narrow. */}
          <div className="min-w-0 flex-1 basis-[22rem]">
            <Select value={picked} onValueChange={setPicked} disabled={withheld.length === 0}>
              <SelectTrigger aria-label="Migration to diagnose">
                <SelectValue placeholder="Pick a held-back migration…" />
              </SelectTrigger>
              <SelectContent>
                {withheld.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {version && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void diagnosis.refetch()}
              disabled={diagnosis.isFetching}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", diagnosis.isFetching && "animate-spin")} />
              Read again
            </Button>
          )}
        </div>

        {ledgerWhy ? (
          <Unreadable what="The list of held-back migrations" why={ledgerWhy} />
        ) : ledgerRead && withheld.length === 0 ? (
          <EmptyState
            icon={<Database className="h-5 w-5" />}
            title="Nothing is held back"
            description="Every migration on this branch is one the prime has run, so there is nothing here to diagnose."
          />
        ) : null}

        {version === null ? null : diagnosis.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : diagnosis.error ? (
          <Unreadable
            what="This migration"
            why={diagnosis.error instanceof Error ? diagnosis.error.message : "The read failed."}
          />
        ) : diagnosis.data && !diagnosis.data.ok ? (
          <Unreadable what="This migration" why={diagnosis.data.error} />
        ) : report ? (
          <DiagnosisBody report={report} />
        ) : null}

        {report && report.collisions.length > 0 && <CollisionNotice rows={report.collisions} />}
      </CardContent>
    </Card>
  );
}

/** Verdict → the colour it is drawn in. Derived once, read everywhere below. */
const VERDICT_TONE: Record<DiagnosisVerdict, SafetyTone> = {
  ready: "ok",
  already_applied: "ok",
  rollback_script: "bad",
  version_collision: "bad",
  would_fail: "bad",
  blocked_by_prerequisite: "warn",
  unsafe_to_test: "warn",
  oversized: "warn",
  undiagnosed: "idle",
};

/**
 * What each verdict is CALLED on the page.
 *
 * `database vocabulary never reaches the operator` — the rule a test in the
 * product repo enforces by refusing any underscore-cased identifier in a
 * rendered field. These are the same enum values the server decides on,
 * translated once here rather than at each of the four places they are drawn.
 */
const VERDICT_WORDS: Record<DiagnosisVerdict, string> = {
  ready: "applies cleanly",
  already_applied: "already run",
  rollback_script: "an undo — never apply",
  version_collision: "duplicate version",
  would_fail: "would fail",
  blocked_by_prerequisite: "waiting on an earlier one",
  unsafe_to_test: "cannot be tried safely",
  oversized: "too large to read here",
  undiagnosed: "not diagnosed",
};

const HAZARD_WORDS: Record<HazardKind, string> = {
  transaction_control: "manages its own transaction",
  non_transactional: "cannot run in a transaction",
  enum_value_added: "adds an enum value",
  procedure: "a procedure, which can commit",
  destructive: "destroys data",
  data_rewrite: "duplicates rows if run twice",
};

const HAZARD_TONE: Record<HazardKind, SafetyTone> = {
  transaction_control: "warn",
  non_transactional: "warn",
  enum_value_added: "warn",
  procedure: "warn",
  destructive: "bad",
  data_rewrite: "warn",
};

function DiagnosisBody({
  report,
}: {
  report: { diagnosis: MigrationDiagnosis; primeRef: string | null; readAt: string };
}) {
  const d = report.diagnosis;
  const tone = VERDICT_TONE[d.verdict];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 basis-[20rem] truncate font-mono text-[11px] text-foreground">
          {d.path}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[tone],
          )}
        >
          {VERDICT_WORDS[d.verdict]}
        </span>
      </div>

      <p className={cn("text-sm", TONE_TEXT[tone])}>{d.headline}</p>

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <MetricCell
          label="statements"
          size="sm"
          value={d.statementCount ?? "—"}
          note={d.bytes === null ? "not read" : `${Math.max(1, Math.round(d.bytes / 1024))} KB`}
        />
        <MetricCell
          label="destroys data"
          size="sm"
          value={d.statementCount === null ? "—" : d.destructiveCount}
          note="statements"
          tone="warning"
          alarm={d.destructiveCount > 0}
        />
        <MetricCell
          label="not re-runnable"
          size="sm"
          value={d.statementCount === null ? "—" : d.dataRewriteCount}
          note="would duplicate rows"
          tone="warning"
          alarm={d.dataRewriteCount > 0}
        />
        <MetricCell
          label="trial run"
          size="sm"
          value={d.dryRun.ran ? (d.dryRun.ok ? `${d.dryRun.ms} ms` : "failed") : "—"}
          note={d.dryRun.ran ? (d.dryRun.ok ? "rolled back" : "rolled back") : "not attempted"}
          tone="warning"
          alarm={d.dryRun.ran && !d.dryRun.ok}
        />
      </div>

      {d.blockedBy !== null && d.blockedBy.length > 0 && (
        <div className="glass-inset spine spine-warn p-3">
          <p className="label-mono">the prime has not run these, and they come first</p>
          <p className="mt-1.5 font-mono text-[11px] break-all text-muted-foreground">
            {d.blockedBy.slice(0, 8).join("  ·  ")}
            {d.blockedBy.length > 8 ? `  ·  and ${d.blockedBy.length - 8} more` : ""}
          </p>
        </div>
      )}

      {d.catalogueNote && <p className="text-xs text-muted-foreground">{d.catalogueNote}</p>}

      {d.hazards.length > 0 && (
        <div className="space-y-2">
          <p className="label-mono">statements worth reading before it runs</p>
          {d.hazards.map((h, i) => (
            <HazardRow key={`${h.line}-${h.kind}-${i}`} hazard={h} />
          ))}
          {d.hazardCount > d.hazards.length && (
            <p className="text-[10px] text-muted-foreground">
              {d.hazardCount - d.hazards.length} more not listed. The counts above are exact; only
              this list is capped.
            </p>
          )}
        </div>
      )}

      {d.remedy && (
        <div className={cn("glass-inset spine p-3", SPINE[d.dispatchable ? "warn" : tone])}>
          <p className="label-mono">
            {d.dispatchable ? "read before dispatching" : "what clears it"}
          </p>
          <p className="mt-1.5 text-xs text-muted-foreground">{d.remedy}</p>
        </div>
      )}

      {/* Keyed on the migration for the reason `ApplyControl` is: React reuses
          a component at the same position, and a repair plan for the file an
          operator was looking at a moment ago, drawn under the filename of the
          one they are looking at now, is the worst sentence this panel could
          show. */}
      <RerunPanel key={`rerun-${d.id}`} diagnosis={d} />

      {/* Drawn on `dispatchable` and never on the verdict word. One field, set
          by the server, so a verdict added tomorrow cannot acquire a button
          by being spelled optimistically. */}
      {/* Keyed on the migration, so the outcome of dispatching one is never
          still on screen beside another. React reuses a component at the same
          position, and "Dispatched" under the wrong filename is the worst
          sentence this panel could show. */}
      {d.dispatchable && <ApplyControl key={d.id} diagnosis={d} primeRef={report.primeRef} />}
    </div>
  );
}

/* ────────────────── running it twice, and mending it if not ───────────────── */

const REPAIR_KEY = (version: string) => ["prime-migration-repair-plan", version] as const;

/**
 * What a second run of this file would do — and, where that is not "nothing",
 * what it would take to make it so.
 *
 * The chip is the same reading `/prime-migrations` draws on every row of the
 * withheld set, from the same table of words, so the list and the file cannot
 * disagree about one migration. What is new here is the second half: a repair
 * is PLANNED on a click rather than on arrival, because it costs a blob and a
 * statement against the prime's production project and most people opening
 * this panel came to read the diagnosis.
 *
 * Nothing here decides anything. `proposable` is set by the server, the same
 * way `dispatchable` is, and this page reads the field rather than the
 * outcome word.
 */
function RerunPanel({ diagnosis }: { diagnosis: MigrationDiagnosis }) {
  const rerun = diagnosis.idempotency;
  const tone = RERUN_TONE[rerun.reading];
  const mendable = rerun.reading === "fails_loudly" || rerun.reading === "rewrites_data";

  const [asked, setAsked] = useState(false);
  const planFn = useServerFn(fetchMigrationRepairPlan);
  const plan = useQuery({
    queryKey: REPAIR_KEY(diagnosis.id),
    queryFn: () => planFn({ data: { version: diagnosis.id } }),
    enabled: asked,
    refetchOnWindowFocus: false,
  });

  const report = plan.data?.ok ? plan.data : null;

  return (
    <div className={cn("glass-inset spine space-y-3 p-3", SPINE[tone])}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="label-mono">running it a second time</p>
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[tone],
          )}
        >
          {RERUN_WORDS[rerun.reading]}
        </span>
        {rerun.guardedByDrop > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {rerun.guardedByDrop} already guarded
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{rerun.summary}</p>

      {!mendable ? null : !asked ? (
        <Button size="sm" variant="outline" onClick={() => setAsked(true)}>
          <Wrench className="h-3.5 w-3.5" />
          Prepare a repair
        </Button>
      ) : plan.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : plan.error ? (
        <Unreadable
          what="A repair for this migration"
          why={plan.error instanceof Error ? plan.error.message : "The read failed."}
        />
      ) : plan.data && !plan.data.ok ? (
        <Unreadable what="A repair for this migration" why={plan.data.error} />
      ) : report ? (
        <RepairPlanBody report={report} />
      ) : null}
    </div>
  );
}

/**
 * The plan, its refusals, and — on the server's own say-so — the act.
 *
 * Both lists are drawn. A page that showed only what it would change would be
 * answering half the question: on 36 of the prime's files the statement that
 * matters is one this refuses to touch, and an operator who merged a repair
 * believing it made the file safe to re-run would have been misled by an
 * omission rather than by a sentence.
 */
function RepairPlanBody({ report }: { report: RepairPlanReport }) {
  const { plan } = report;
  const tone = REMEDY_TONE[plan.outcome];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[tone],
          )}
        >
          {REMEDY_WORDS[plan.outcome]}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {plan.repairCount} guarded · {plan.refusalCount} left alone
        </span>
      </div>

      <p className={cn("text-xs", TONE_TEXT[tone])}>{plan.summary}</p>

      {plan.discarded && (
        <p className="text-[11px] text-muted-foreground">Withdrawn because {plan.discarded}.</p>
      )}

      {plan.repairs.length > 0 && (
        <div className="space-y-1.5">
          <p className="label-mono">what would change</p>
          {plan.repairs.map((r, i) => (
            <RepairRow key={`${r.line}-${r.kind}-${i}`} repair={r} />
          ))}
          {plan.repairCount > plan.repairs.length && (
            <p className="text-[10px] text-muted-foreground">
              {plan.repairCount - plan.repairs.length} more of the same shapes. The counts above are
              exact; only this list is capped.
            </p>
          )}
        </div>
      )}

      {plan.refusals.length > 0 && (
        <div className="space-y-1.5">
          <p className="label-mono">what would deliberately be left alone</p>
          {plan.refusals.map((r, i) => (
            <RefusalRow key={`${r.line}-${r.kind}-${i}`} refusal={r} />
          ))}
          {plan.refusalCount > plan.refusals.length && (
            <p className="text-[10px] text-muted-foreground">
              {plan.refusalCount - plan.refusals.length} more of the same shapes.
            </p>
          )}
        </div>
      )}

      {report.blocked && (
        <div className="glass-inset spine spine-warn p-3">
          <p className="label-mono">not proposed</p>
          <p className="mt-1.5 text-xs text-muted-foreground">{report.blocked}</p>
        </div>
      )}

      {report.proposable && <ProposeControl key={report.target.version} report={report} />}
    </div>
  );
}

function RepairRow({ repair }: { repair: Repair }) {
  return (
    <RecordRow spine="ok" className="space-y-1 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
          line {repair.line}
        </span>
        <span className="font-mono text-[10px] tracking-[0.12em] whitespace-nowrap text-ok uppercase">
          {REPAIR_WORDS[repair.kind]}
        </span>
        <code className="min-w-0 truncate font-mono text-[10px] text-foreground">
          {repair.inserted}
        </code>
        <span className="min-w-0 basis-full text-[11px] text-muted-foreground">{repair.what}</span>
      </div>
      <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-foreground/70">
        {repair.statement}
      </pre>
    </RecordRow>
  );
}

function RefusalRow({ refusal }: { refusal: RepairRefusal }) {
  return (
    <RecordRow spine="warn" className="space-y-1 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
          line {refusal.line}
        </span>
        <span className="font-mono text-[10px] tracking-[0.12em] whitespace-nowrap text-warning uppercase">
          {REFUSAL_WORDS[refusal.kind]}
        </span>
        <span className="min-w-0 basis-full text-[11px] text-muted-foreground">{refusal.why}</span>
      </div>
      <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-foreground/70">
        {refusal.excerpt}
      </pre>
    </RecordRow>
  );
}

/**
 * Open the repair, behind a confirmation that names where it lands.
 *
 * Two clicks, and the second one says the thing that is easy to assume
 * otherwise: this changes a FILE in the prime repository and runs nothing. The
 * migration still has to be applied afterwards, by the button above or by the
 * prime's own workflow.
 */
function ProposeControl({ report }: { report: RepairPlanReport }) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const proposeFn = useServerFn(proposePrimeMigrationRepair);

  const send = async () => {
    setSending(true);
    try {
      const r = await proposeFn({ data: { version: report.target.version } });
      setOutcome(
        r.ok
          ? {
              ok: true,
              text:
                r.state === "already_open"
                  ? `A repair for this migration is already open as #${r.number}.`
                  : `Opened #${r.number} on ${report.target.repo.owner}/${report.target.repo.repo}.`,
              url: r.url,
            }
          : { ok: false, text: r.error },
      );
      setConfirming(false);
    } catch (e) {
      setOutcome({
        ok: false,
        text: e instanceof Error ? e.message : "The repair could not be proposed.",
      });
    } finally {
      setSending(false);
    }
  };

  if (outcome) {
    return (
      <div className={cn("glass-inset spine p-3", SPINE[outcome.ok ? "live" : "bad"])}>
        <p className="label-mono">{outcome.ok ? "proposed" : "not proposed"}</p>
        <p className={cn("mt-1.5 text-xs", TONE_TEXT[outcome.ok ? "live" : "bad"])}>
          {outcome.text}
        </p>
        {outcome.url && (
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-info hover:underline"
            href={outcome.url}
            target="_blank"
            rel="noreferrer"
          >
            Read the pull request
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  if (!confirming) {
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        <GitPullRequest className="h-3.5 w-3.5" />
        Open a pull request on the prime
      </Button>
    );
  }

  return (
    <div className="glass-inset spine spine-warn space-y-2 p-3">
      <p className="label-mono">this changes a file, and runs nothing</p>
      <p className="text-xs text-muted-foreground">
        A pull request against{" "}
        <span className="font-mono text-foreground">
          {report.target.repo.owner}/{report.target.repo.repo}@{report.target.repo.branch}
        </span>{" "}
        will edit <span className="font-mono text-foreground">{report.target.path}</span> and
        nothing else. No migration is applied, no database is touched, and the prime&rsquo;s own
        checks run on it before anybody merges it. The patch is composed again from the file as it
        stands at the moment you click, not from what is drawn above.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send()} disabled={sending}>
          {sending ? "Opening…" : "Yes — open it"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={sending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function HazardRow({ hazard }: { hazard: Hazard }) {
  const tone = HAZARD_TONE[hazard.kind];
  return (
    <RecordRow spine={tone} className="space-y-1 p-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
          line {hazard.line}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[tone],
          )}
        >
          {HAZARD_WORDS[hazard.kind]}
        </span>
        <span className="min-w-0 basis-full text-[11px] text-muted-foreground">{hazard.note}</span>
      </div>
      <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-foreground/70">
        {hazard.excerpt}
      </pre>
    </RecordRow>
  );
}

/**
 * The act, behind a confirmation that names what it will do.
 *
 * Two clicks rather than one, and the second one restates the cautions the
 * diagnosis found — the same `remedy` sentence the card above draws, because
 * two statements of what is owed is how one screen comes to warn about
 * something the other does not.
 */
function ApplyControl({
  diagnosis,
  primeRef,
}: {
  diagnosis: MigrationDiagnosis;
  primeRef: string | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [sending, setSending] = useState(false);
  const applyFn = useServerFn(applyPrimeMigration);

  const send = async () => {
    setSending(true);
    try {
      const r = await applyFn({ data: { version: diagnosis.id } });
      setOutcome(
        r.ok
          ? { ok: true, text: `Dispatched ${r.file}.`, url: r.runsUrl }
          : { ok: false, text: r.error },
      );
      setConfirming(false);
    } catch (e) {
      setOutcome({
        ok: false,
        text: e instanceof Error ? e.message : "The dispatch failed. Nothing was applied.",
      });
    } finally {
      setSending(false);
    }
  };

  if (outcome) {
    return (
      <div className={cn("glass-inset spine p-3", SPINE[outcome.ok ? "live" : "bad"])}>
        <p className="label-mono">{outcome.ok ? "dispatched" : "not dispatched"}</p>
        <p className={cn("mt-1.5 text-xs", TONE_TEXT[outcome.ok ? "live" : "bad"])}>
          {outcome.text}
        </p>
        {outcome.url && (
          <a
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-info hover:underline"
            href={outcome.url}
            target="_blank"
            rel="noreferrer"
          >
            Watch the run on the prime
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  if (!confirming) {
    return (
      <Button size="sm" onClick={() => setConfirming(true)}>
        <PlayCircle className="h-3.5 w-3.5" />
        Apply it on the prime
      </Button>
    );
  }

  return (
    <div className="glass-inset spine spine-warn space-y-2 p-3">
      <p className="label-mono">this runs on the prime&rsquo;s own database</p>
      <p className="text-xs text-muted-foreground">
        <span className="font-mono text-foreground">{diagnosis.name}</span> will be applied by the
        prime&rsquo;s <span className="font-mono text-foreground">apply-migration.yml</span>
        {primeRef ? (
          <>
            {" "}
            against <span className="font-mono text-foreground">{primeRef}</span>
          </>
        ) : null}
        , and recorded in its ledger. It is applied one statement at a time and does not roll back
        part-way.
        {diagnosis.remedy ? ` ${diagnosis.remedy}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send()} disabled={sending}>
          {sending ? "Dispatching…" : "Yes — apply it"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={sending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Versions the repository carries twice.
 *
 * `schema_migrations.version` is the primary key, so one of each pair can
 * never be recorded — and a version the ledger cannot record is a hole no
 * amount of running will close. It is drawn here rather than in the ledger
 * card because the repair is a rename in the prime repository, which is the
 * act this whole panel is about.
 */
function CollisionNotice({ rows }: { rows: VersionCollision[] }) {
  const files = rows.reduce((n, r) => n + r.names.length, 0);
  return (
    <div className="glass-inset spine spine-bad space-y-2 p-3">
      <p className="label-mono">versions carried by more than one file</p>
      <p className="text-xs text-muted-foreground">
        {rows.length} version{rows.length === 1 ? "" : "s"} across {files} files.{" "}
        <span className="font-mono text-foreground">schema_migrations.version</span> is the primary
        key, so {files - rows.length} of those files can never be recorded — each one a hole every
        clone queues behind. Renaming them in the prime repository is the only thing that clears it.
      </p>
      <div className="space-y-1">
        {rows.slice(0, 6).map((r) => (
          <p key={r.version} className="font-mono text-[10px] break-all text-muted-foreground">
            <span className="text-foreground">{r.version}</span> — {r.names.join(", ")}
          </p>
        ))}
        {rows.length > 6 && (
          <p className="text-[10px] text-muted-foreground">and {rows.length - 6} more.</p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────── one clone, held against the prime ───────────────── */

const COMPARE_KEY = (cloneId: string | null) => ["prime-clone-comparison", cloneId] as const;

/**
 * Pick a clone and ask what the prime is doing to it.
 *
 * The fleet page answers "is this clone healthy". This answers the inverse,
 * which is the only question this page is entitled to ask: of everything wrong
 * with that clone, how much did the SOURCE cause?
 *
 * `clone_sync_blockages` has carried an owner on every row since the taxonomy
 * was written — its own header calls it "the field everything else turns
 * on" — and no surface had ever grouped by it. An operator looking at six open
 * blockages had six sentences and no way to see which two were theirs to fix
 * on the prime.
 */
function ClonesHeldAgainstPrime() {
  /*
    A STRING, never `undefined`.

    Radix reads `value={undefined}` as "uncontrolled" and switches mode the
    moment a value arrives, which React warns about and which loses the
    selection on the re-render that follows. The empty string is the
    unselected value here and `SelectValue` draws its placeholder over it; the
    conversion to `null` happens once, at the boundary the server validates.
  */
  const [cloneId, setCloneId] = useState("");
  const chosen = cloneId || null;
  const fetchFn = useServerFn(fetchCloneComparison);
  const query = useQuery({
    queryKey: COMPARE_KEY(chosen),
    queryFn: () => fetchFn({ data: { cloneId: chosen } }),
    refetchOnWindowFocus: false,
  });

  const data = query.data;
  const view = data?.comparison ?? null;

  return (
    <Card className={cn("spine", SPINE[view?.tone ?? "idle"])}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SplitSquareHorizontal className="h-4 w-4 text-muted-foreground" />
          Hold a clone against the prime
        </CardTitle>
        <CardDescription>
          Where one clone stands on this commit and on the prime&rsquo;s migration frontier, and
          every open blockage on it — separated by whether the act that clears it happens on the
          prime or here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={cloneId}
            onValueChange={(v) => setCloneId(v)}
            disabled={query.isPending || (data?.clones.length ?? 0) === 0}
          >
            <SelectTrigger className="w-full sm:w-72" aria-label="Choose a clone to compare">
              <SelectValue placeholder="Choose a clone…" />
            </SelectTrigger>
            <SelectContent>
              {(data?.clones ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", query.isFetching && "animate-spin")} />
              {query.isFetching ? "Reading…" : "Re-read"}
            </Button>
          )}
        </div>

        {/* A roster that FAILED is said, not drawn as an empty fleet. */}
        {data?.rosterError && <Unreadable what="The fleet roster" why={data.rosterError} />}

        {query.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : query.error ? (
          <Unreadable
            what="The comparison"
            why={query.error instanceof Error ? query.error.message : "The read failed."}
          />
        ) : !chosen ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {data && data.clones.length === 0 && !data.rosterError
              ? "This deployment has no clones."
              : "Choose a clone to see what the prime is holding it at."}
          </p>
        ) : view ? (
          <ComparisonBody view={view} error={data?.comparisonError ?? null} />
        ) : (
          <Unreadable what="This clone" why={data?.comparisonError} />
        )}
      </CardContent>
    </Card>
  );
}

function ComparisonBody({ view, error }: { view: CloneComparisonReading; error: string | null }) {
  const blockers = view.blockers;
  const prime = blockers?.filter((b) => b.side === "prime") ?? [];
  const clone = blockers?.filter((b) => b.side === "clone") ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={cn("font-display text-lg leading-none", TONE_TEXT[view.tone])}>
          {VERDICT_WORD[view.verdict]}
        </span>
        {view.repoFullName && (
          <span className="font-mono text-[11px] text-muted-foreground">{view.repoFullName}</span>
        )}
        {view.syncScope && (
          <span className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            {view.syncScope}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{view.headline}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <StandingPanel
          label="code"
          tone={view.code.tone}
          sentence={view.code.sentence}
          foot={
            view.code.syncedSha
              ? `last synced ${view.code.syncedSha.slice(0, 7)}`
              : "no synced commit recorded"
          }
        />
        <StandingPanel
          label="migrations"
          tone={view.migrations.tone}
          sentence={view.migrations.sentence}
          foot={
            view.migrations.recordedVersion
              ? `recorded at ${view.migrations.recordedVersion} — a cursor its last pass wrote, not a reading of the clone`
              : "no version recorded"
          }
        />
      </div>

      {view.migrations.blockedReason && (
        <div className="glass-inset spine spine-warn p-3">
          <p className="label-mono">its last migration pass stopped, and said why</p>
          <p className="mt-1.5 text-xs break-words text-muted-foreground">
            {view.migrations.blockedReason}
          </p>
        </div>
      )}

      {error && <Unreadable what="This clone's backend record" why={error} />}

      {blockers === null ? (
        <Unreadable what="This clone's open blockages" why={view.blockersError} />
      ) : blockers.length === 0 ? (
        <p className="glass-inset spine spine-ok p-3 text-xs text-muted-foreground">
          Nothing is open against this clone in the blockage ledger.
        </p>
      ) : (
        <div className="space-y-3">
          <BlockerGroup
            heading="the prime's to clear"
            note="Nothing in this console can discharge these. The act happens on the source."
            rows={prime}
            empty="None — nothing the prime shipped is holding this clone."
            tone="bad"
          />
          <BlockerGroup
            heading="this clone's to clear"
            note="A pass to re-run, a record to repair, or a decision owed here."
            rows={clone}
            empty="None."
            tone="warn"
          />
        </div>
      )}
    </div>
  );
}

function StandingPanel({
  label,
  tone,
  sentence,
  foot,
}: {
  label: string;
  tone: SafetyTone;
  sentence: string;
  foot: string;
}) {
  return (
    <div className={cn("glass-inset spine p-3", SPINE[tone])}>
      <p className="label-mono">{label}</p>
      <p className={cn("mt-1.5 text-xs", TONE_TEXT[tone])}>{sentence}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">{foot}</p>
    </div>
  );
}

function BlockerGroup({
  heading,
  note,
  rows,
  empty,
  tone,
}: {
  heading: string;
  note: string;
  rows: ComparedBlocker[];
  empty: string;
  tone: SafetyTone;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="label-mono">
          {heading} · {rows.length}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">{note}</p>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        rows.map((b) => <BlockerRow key={b.id} blocker={b} tone={tone} />)
      )}
    </div>
  );
}

function BlockerRow({ blocker, tone }: { blocker: ComparedBlocker; tone: SafetyTone }) {
  return (
    <RecordRow spine={tone} className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* `whoWord` translates the taxonomy's own vocabulary. Database words
            never reach an operator — the roster's test refuses any
            underscore-cased identifier in a rendered field, and the rule is
            the same one wherever the vocabulary is drawn. */}
        <span className={cn("font-mono text-[10px] tracking-[0.12em] uppercase", TONE_TEXT[tone])}>
          {OWNER_WORD[blocker.owner] ?? "somebody"}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {blocker.selfHeals ? "clears on a re-run" : "needs a decision"}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          open {formatDistanceToNow(blocker.firstSeenAt)}
        </span>
      </div>
      <p className="text-xs text-foreground">{blocker.what}</p>
      <p className="text-[11px] break-words text-muted-foreground">{blocker.detail}</p>
    </RecordRow>
  );
}

/* ──────────────────────────────── primitives ─────────────────────────────── */

const SPINE: Record<SafetyTone, string> = {
  ok: "spine-ok",
  warn: "spine-warn",
  bad: "spine-bad",
  live: "spine-live",
  idle: "spine-idle",
};

const TONE_TEXT: Record<SafetyTone, string> = {
  ok: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  live: "text-info",
  idle: "text-muted-foreground",
};

const CI_SPINE: Record<PullRequestCi, SafetyTone> = {
  passing: "ok",
  failing: "bad",
  running: "live",
  // Not green. A head nothing in the window built is unexamined, and the amber
  // says so rather than letting it pass as healthy.
  unobserved: "warn",
};

/**
 * The comparison's verdict as one word.
 *
 * Separate from the headline sentence because the two are read at different
 * distances: the word is scanned, the sentence is read. Keying it on the
 * verdict rather than the tone means two verdicts that happen to share a
 * colour still say different things.
 */
const VERDICT_WORD: Record<ComparisonVerdict, string> = {
  converged: "CONVERGED",
  prime_blocked: "HELD BY PRIME",
  clone_blocked: "HELD HERE",
  lagging: "BEHIND",
  unreadable: "UNREADABLE",
};

/**
 * Who has to act, in words an operator uses.
 *
 * `database vocabulary never reaches the operator` is the roster's rule and a
 * test enforces it there by refusing any underscore-cased identifier in a
 * rendered field. `prime_author` and `account_owner` are exactly that shape,
 * so they are translated here rather than printed.
 */
const OWNER_WORD: Record<string, string> = {
  machinery: "the machinery",
  operator: "an operator",
  prime_author: "whoever wrote it on prime",
  account_owner: "the account owner",
};

const RESULT_SPINE: Record<string, SafetyTone> = {
  succeeded: "ok",
  pr_opened: "live",
  pushing: "live",
  queued: "idle",
  skipped: "idle",
  failed: "bad",
};

function CiWord({ ci }: { ci: PullRequestCi }) {
  return (
    <span
      className={cn(
        "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
        TONE_TEXT[CI_SPINE[ci]],
      )}
      title={
        ci === "unobserved"
          ? "No run in the window built this commit. Unexamined, not passing."
          : undefined
      }
    >
      {ci}
    </span>
  );
}

/** A read that failed, said as one rather than drawn as an empty list. */
function Unreadable({ what, why }: { what: string; why: string | null | undefined }) {
  return (
    <div className="glass-inset spine spine-idle p-3">
      <p className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
        <AlertTriangle className="h-3 w-3" />
        unreadable
      </p>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {what} could not be read. This is no signal — not a good one.
      </p>
      {why && (
        <p className="mt-1 font-mono text-[10px] break-words text-muted-foreground/70">{why}</p>
      )}
    </div>
  );
}

function LoadingShape() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}
