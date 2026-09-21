/**
 * Whether the prime's held-back migrations are safe to run — all of them, at
 * once.
 *
 * `/prime` already diagnoses ONE migration properly: it reads the file, asks
 * the prime's catalogue about it and tries it inside a transaction that is
 * always rolled back. That is the right depth for the file an operator has
 * chosen, and it is the wrong shape for choosing one. The drop-down that feeds
 * it lists filenames and nothing else, so the question "which of these
 * twenty-five is the problem?" could only be answered by opening them one at a
 * time.
 *
 * This page answers it in one read, at a price that scales: the corpus
 * listing, the prime's ledger, and the newest withheld bodies. No trial run,
 * no catalogue read, no statement against the prime's database beyond the one
 * the ledger card already makes.
 *
 * ## The two things it says about each file, which are not the same thing
 *
 * **What stands in its way** (`SurveyStanding`) — is it blocked behind an
 * earlier migration, is it an undo, does it collide on version, do its own
 * statements forbid a trial run. That is about running it ONCE.
 *
 * **What a second run would do** (`Idempotency`) — because
 * `apply-migration.yml` runs `psql` with no `--single-transaction`, so a file
 * that fails half way leaves everything before the failure applied and the
 * repair is to dispatch it again. An operator standing in front of that
 * decision needs to know whether the second run stops harmlessly or writes
 * rows twice, and until this page there was nowhere in the product that said.
 *
 * ## What it must not imply
 *
 * A healthy row here reads "not tried", never "ready". A survey has no
 * evidence that a body applies — only that nothing in the file forbids trying
 * — and `SurveyStanding` deliberately shares no word with the diagnosis
 * verdicts so a list cannot make a promise a trial run did not back. The
 * Diagnose link beside each row is where that promise is obtained.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  Copy,
  Database,
  FileWarning,
  RefreshCw,
  RotateCcw,
  Stethoscope,
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
import { fetchPrimeCorpusHealth } from "@/server/prime-migration-health.functions";
// Types only, through the server-function door. A route is bundled for the
// browser, so importing `src/server/**` for a VALUE is refused — correctly.
// Every judgement drawn here was made on the server and travels in the payload.
import type {
  CorpusFacts,
  IdempotencyReading,
  MigrationSurvey,
  PrimeCorpusHealth,
  SurveyStanding,
} from "@/server/prime-migration-health.functions";
import type { SafetyTone } from "@/server/prime-health.functions";

export const Route = createFileRoute("/prime-migrations")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <PrimeMigrationsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Migration health — Aurixa Systems Mission Control" },
      {
        name: "description",
        content:
          "Every migration the prime is holding back, read from its own bytes: what stands " +
          "in its way, and what running it a second time would do.",
      },
    ],
  }),
});

const HEALTH_KEY = ["prime-corpus-health"] as const;

function PrimeMigrationsPage() {
  const fetchFn = useServerFn(fetchPrimeCorpusHealth);
  const query = useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => fetchFn(),
    // One tree walk plus up to twenty-five blob reads a visit. Refetching on
    // window focus would spend the installation's hourly window on tab
    // switching, which is the reason `/prime` gives for the same setting.
    refetchOnWindowFocus: false,
  });

  const health = query.data?.ok ? query.data : null;
  const why = query.error
    ? query.error instanceof Error
      ? query.error.message
      : "The read failed."
    : query.data && !query.data.ok
      ? query.data.error
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="prime · sql"
        title="Migration health"
        description="Every migration the prime has not run, read from its own bytes. Nothing here applies anything, and nothing here is tried against the prime's database."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", query.isFetching && "animate-spin")} />
            Read again
          </Button>
        }
      />

      {query.isPending ? (
        <LoadingShape />
      ) : why ? (
        <Unreadable what="The prime's migrations" why={why} />
      ) : health ? (
        <HealthBody health={health} />
      ) : null}
    </div>
  );
}

function HealthBody({ health }: { health: PrimeCorpusHealth }) {
  const { ledger, facts, surveys } = health;

  return (
    <div className="space-y-6">
      <CorpusStanding health={health} />

      {health.notes.length > 0 && (
        <div className="glass-inset spine spine-idle space-y-1.5 p-3">
          <p className="label-mono">what this read did not cover</p>
          {health.notes.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      )}

      <RerunSummary surveys={surveys} withheldCount={ledger.withheldCount} />

      <Card className="spine spine-idle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Held back by the prime
          </CardTitle>
          <CardDescription>
            Newest first. The standing is about running it once; the re-run reading is about running
            it again after a half-finished apply.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {surveys.length === 0 ? (
            <EmptyState
              icon={<Database className="h-5 w-5" />}
              title={
                ledger.withheldCount === 0
                  ? "Nothing is held back"
                  : "No migration was read on this pass"
              }
              description={
                ledger.withheldCount === 0
                  ? "Every migration on the prime's branch is one it has run, so there is nothing here to weigh."
                  : "The list of held-back migrations was not read, so nothing below is a statement about the prime."
              }
            />
          ) : (
            surveys.map((s) => <SurveyRow key={`${s.id}-${s.name}`} survey={s} />)
          )}
        </CardContent>
      </Card>

      {facts && <CorpusNotices facts={facts} />}
    </div>
  );
}

/* ──────────────────────────── the corpus standing ─────────────────────────── */

function CorpusStanding({ health }: { health: PrimeCorpusHealth }) {
  const { ledger, facts } = health;
  const tone = LEDGER_TONE[ledger.standing];

  return (
    <Card className={cn("spine", SPINE[tone])}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-muted-foreground" />
          The prime&rsquo;s SQL position
        </CardTitle>
        <CardDescription className={TONE_TEXT[tone]}>{ledger.headline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
          <MetricCell
            label="migration files"
            size="sm"
            value={facts?.files ?? ledger.corpusCount ?? "—"}
            note="on the prime's branch"
          />
          <MetricCell
            label="held back"
            size="sm"
            value={ledger.withheldCount ?? "—"}
            note={ledger.withheldCount === null ? "not established" : "not run by the prime"}
            tone="warning"
            alarm={(ledger.withheldCount ?? 0) > 0}
          />
          <MetricCell
            label="duplicate versions"
            size="sm"
            value={facts ? facts.collisions.length : "—"}
            note="can never be recorded"
            tone="warning"
            alarm={(facts?.collisions.length ?? 0) > 0}
          />
          <MetricCell
            label="too large to read"
            size="sm"
            value={facts ? facts.oversize.length : "—"}
            note={
              facts && facts.sizeUnknown > 0
                ? `${facts.sizeUnknown} unsized`
                : "past this console's ceiling"
            }
            tone="warning"
            alarm={(facts?.oversize.length ?? 0) > 0}
          />
        </div>

        {ledger.remedy && (
          <div className={cn("glass-inset spine p-3", SPINE[tone])}>
            <p className="label-mono">what clears it</p>
            <p className="mt-1.5 text-xs text-muted-foreground">{ledger.remedy}</p>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          Read from{" "}
          {health.repo ? (
            <span className="font-mono">
              {health.repo.owner}/{health.repo.repo}@{(health.headSha ?? "").slice(0, 7)}
            </span>
          ) : (
            "no configured repository"
          )}
          . A fuller reading of any one file — including a trial run against the prime that is
          always rolled back — is on{" "}
          <Link to="/prime" className="underline underline-offset-2">
            Prime Repo
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────── the re-run summary ──────────────────────────── */

/**
 * What a second run of each surveyed file would do, counted.
 *
 * Three readings rather than one flag, because a boolean drawn over this
 * corpus would be red on a quarter of it and say nothing. The one worth
 * reacting to is `rewrites_data`: it is the outcome that does not stop.
 */
function RerunSummary({
  surveys,
  withheldCount,
}: {
  surveys: MigrationSurvey[];
  withheldCount: number | null;
}) {
  if (surveys.length === 0) return null;
  const count = (r: IdempotencyReading) =>
    surveys.filter((s) => s.idempotency.reading === r).length;

  return (
    <Card className="spine spine-idle">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Copy className="h-4 w-4 text-muted-foreground" />
          If any of these is applied twice
        </CardTitle>
        <CardDescription>
          The prime&rsquo;s apply workflow runs each file statement by statement and stops at the
          first error, leaving everything before it applied — so a half-finished migration is fixed
          and dispatched again, over statements that already ran.
          {withheldCount !== null && withheldCount > surveys.length
            ? ` Read here: ${surveys.length} of ${withheldCount}.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
          <MetricCell
            label="writes rows again"
            size="sm"
            value={count("rewrites_data")}
            note="succeeds, and duplicates"
            tone="warning"
            alarm={count("rewrites_data") > 0}
          />
          <MetricCell
            label="stops on its own"
            size="sm"
            value={count("fails_loudly")}
            note="nothing written twice"
          />
          <MetricCell
            label="changes nothing"
            size="sm"
            value={count("rerunnable")}
            note="written to be repeated"
          />
          <MetricCell
            label="not read"
            size="sm"
            value={count("unreadable")}
            note="no body to measure"
          />
        </div>
      </CardContent>
    </Card>
  );
}

/* ───────────────────────────────── one row ───────────────────────────────── */

function SurveyRow({ survey }: { survey: MigrationSurvey }) {
  const tone = STANDING_TONE[survey.standing];
  const rerun = survey.idempotency;
  const rerunTone = RERUN_TONE[rerun.reading];

  return (
    <RecordRow spine={tone} className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="min-w-0 basis-[22rem] truncate font-mono text-[11px] text-foreground">
          {survey.name}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[tone],
          )}
        >
          {STANDING_WORDS[survey.standing]}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] tracking-[0.12em] whitespace-nowrap uppercase",
            TONE_TEXT[rerunTone],
          )}
          title={rerun.summary}
        >
          twice: {RERUN_WORDS[rerun.reading]}
        </span>
        <Link
          to="/prime"
          search={{ migration: survey.id }}
          className="ml-auto text-[10px] whitespace-nowrap text-muted-foreground underline underline-offset-2"
        >
          Diagnose
        </Link>
      </div>

      <p className="text-[11px] text-muted-foreground">{survey.note}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground/70">
        <span>
          {survey.statementCount === null ? "— statements" : `${survey.statementCount} statements`}
        </span>
        <span>
          {survey.bytes === null ? "— KB" : `${Math.max(1, Math.round(survey.bytes / 1024))} KB`}
        </span>
        {survey.destructiveCount > 0 && (
          <span className="text-destructive">{survey.destructiveCount} destroy data</span>
        )}
        {survey.dataRewriteCount > 0 && (
          <span className="text-warning">{survey.dataRewriteCount} write rows again</span>
        )}
        {survey.blockedByCount !== null && survey.blockedByCount > 0 && (
          <span>{survey.blockedByCount} in front of it</span>
        )}
        {rerun.opaqueBlocks > 0 && <span>{rerun.opaqueBlocks} unread blocks</span>}
      </div>

      {/* The statements the reading turns on, so a chip is never the whole
          answer. Capped by the server; the counts above are exact. */}
      {rerun.rewrites.length > 0 && <RerunNotes notes={rerun.rewrites} tone="warn" />}
      {rerun.rewrites.length === 0 && rerun.collides.length > 0 && (
        <RerunNotes notes={rerun.collides} tone="idle" />
      )}
    </RecordRow>
  );
}

function RerunNotes({
  notes,
  tone,
}: {
  notes: MigrationSurvey["idempotency"]["collides"];
  tone: SafetyTone;
}) {
  return (
    <div className="space-y-1">
      {notes.slice(0, 2).map((n, i) => (
        <div key={`${n.line}-${i}`} className="glass-inset p-2">
          <p className={cn("font-mono text-[10px]", TONE_TEXT[tone])}>
            line {n.line} — {n.what}
          </p>
          <pre className="mt-1 overflow-x-auto font-mono text-[10px] leading-relaxed text-foreground/60">
            {n.excerpt}
          </pre>
        </div>
      ))}
      {notes.length > 2 && (
        <p className="text-[10px] text-muted-foreground">
          {notes.length - 2} more like it in this file.
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── corpus-wide, from the listing ─────────────────── */

/**
 * The three facts a per-file reading cannot show.
 *
 * A duplicate version is the sharpest: `schema_migrations.version` is the
 * primary key, so a version two files carry can only ever record one of them,
 * and no amount of running anything closes the hole.
 */
function CorpusNotices({ facts }: { facts: CorpusFacts }) {
  if (
    facts.collisions.length === 0 &&
    facts.oversize.length === 0 &&
    facts.rollbackScripts.length === 0
  ) {
    return null;
  }
  return (
    <Card className="spine spine-warn">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileWarning className="h-4 w-4 text-muted-foreground" />
          True of the whole corpus
        </CardTitle>
        <CardDescription>
          Read from the file listing alone — no body was opened for any of this, and none of it is
          cleared by running something.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {facts.collisions.length > 0 && (
          <div className="glass-inset spine spine-bad space-y-1.5 p-3">
            <p className="label-mono">
              {facts.collisions.length} version
              {facts.collisions.length === 1 ? "" : "s"} carried by more than one file
            </p>
            <p className="text-[11px] text-muted-foreground">
              The prime&rsquo;s ledger records a version once, so only one file of each pair can
              ever be stamped. Renaming one of them in the prime repository is the only repair.
            </p>
            {facts.collisions.slice(0, 5).map((c) => (
              <p key={c.version} className="font-mono text-[10px] break-all text-muted-foreground">
                {c.version} — {c.names.join("  ·  ")}
              </p>
            ))}
            {facts.collisions.length > 5 && (
              <p className="text-[10px] text-muted-foreground">
                and {facts.collisions.length - 5} more.
              </p>
            )}
          </div>
        )}

        {facts.oversize.length > 0 && (
          <div className="glass-inset spine spine-warn space-y-1.5 p-3">
            <p className="label-mono">
              {facts.oversize.length} file{facts.oversize.length === 1 ? "" : "s"} past this
              console&rsquo;s reading ceiling
            </p>
            <p className="text-[11px] text-muted-foreground">
              Nothing is wrong with them. They are applied through the prime&rsquo;s own workflow,
              which streams a file of this size in one piece.
            </p>
            {facts.oversize.slice(0, 5).map((f) => (
              <p key={f.id} className="font-mono text-[10px] break-all text-muted-foreground">
                {f.name} — {Math.round(f.bytes / (1024 * 1024))} MB
              </p>
            ))}
            {facts.oversize.length > 5 && (
              <p className="text-[10px] text-muted-foreground">
                and {facts.oversize.length - 5} more.
              </p>
            )}
          </div>
        )}

        {facts.rollbackScripts.length > 0 && (
          <div className="glass-inset spine spine-idle space-y-1.5 p-3">
            <p className="label-mono">
              <RotateCcw className="mr-1 inline h-3 w-3" />
              {facts.rollbackScripts.length} file
              {facts.rollbackScripts.length === 1 ? " is" : "s are"} named as an undo
            </p>
            <p className="text-[11px] text-muted-foreground">
              Withheld on purpose and never dispatched from a console. They stay held back for ever,
              and that is correct.
            </p>
            {facts.rollbackScripts.slice(0, 5).map((n) => (
              <p key={n} className="font-mono text-[10px] break-all text-muted-foreground">
                {n}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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

const LEDGER_TONE: Record<PrimeCorpusHealth["ledger"]["standing"], SafetyTone> = {
  aligned: "ok",
  holding: "warn",
  unreadable: "idle",
};

/**
 * What each standing is CALLED on the page.
 *
 * `database vocabulary never reaches the operator` — the rule a test in the
 * product repo enforces by refusing any underscore-cased identifier in a
 * rendered field. None of these words appears in the diagnosis vocabulary
 * either: a list may not promise what a trial run has not established.
 */
const STANDING_WORDS: Record<SurveyStanding, string> = {
  must_not_run: "an undo — never apply",
  cannot_be_recorded: "duplicate version",
  applied: "already run",
  blocked: "waiting on an earlier one",
  hand_apply: "apply by hand",
  too_large: "too large to read here",
  unknown: "not read",
  needs_a_trial_run: "not tried",
};

const STANDING_TONE: Record<SurveyStanding, SafetyTone> = {
  must_not_run: "bad",
  cannot_be_recorded: "bad",
  applied: "ok",
  blocked: "warn",
  hand_apply: "warn",
  too_large: "warn",
  unknown: "idle",
  // Amber rather than green: nothing has tried it, and a green row on a page
  // that never opened a database would be a promise nobody made.
  needs_a_trial_run: "warn",
};

const RERUN_WORDS: Record<IdempotencyReading, string> = {
  rerunnable: "changes nothing",
  fails_loudly: "stops on its own",
  rewrites_data: "writes rows again",
  unreadable: "not measured",
};

const RERUN_TONE: Record<IdempotencyReading, SafetyTone> = {
  rerunnable: "ok",
  fails_loudly: "idle",
  rewrites_data: "bad",
  unreadable: "idle",
};

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
      <Skeleton className="h-52 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
