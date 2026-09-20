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
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ExternalLink,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  ShieldQuestion,
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
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { fetchPrimeHealth } from "@/server/prime-health.functions";
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

export const Route = createFileRoute("/prime")({
  errorComponent: RouteError,
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
