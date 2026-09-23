/**
 * LATERAL BOUNDARY DETAIL — what crosses between the two parents, each way,
 * and what the lane last did about it.
 *
 * Three things, in the order an operator needs them.
 *
 * **The rule, both ways.** A lateral boundary is two membranes, one INTO each
 * parent, and they are not mirror images: the CRM line runs opposite ways
 * across it. So the panel shows one direction at a time, chosen explicitly,
 * rather than two lists of near-identical channels an operator would have to
 * diff by eye to find the one that differs. A key to the band's own drawing
 * sits above it, folded: the passage and the arch are new to this diagram,
 * and a mark nobody has been told the meaning of is a mark read as decoration.
 *
 * **What happened.** The lane records every pass in `audit_log`, and this
 * panel reads that row back — never GitHub, so opening it costs no
 * installation calls. A reader without the operator role is told so in a
 * sentence: `audit_log` refuses them, and a panel that rendered the refusal as
 * "nothing has crossed" would be the confident-empty reading this product has
 * had to unlearn more than once.
 *
 * **What an operator may do.** Preview a pass (it writes nothing anywhere),
 * run one, or pause the boundary. A run can open pull requests on two
 * deployments, so it asks twice. A pause is the brake, so it asks once and is
 * never gated behind the thing it stops.
 *
 * Every word the engine uses internally is translated here: an outcome, a
 * mode and a hold reason each print as a sentence, never as the identifier.
 * The maps are exhaustive BY TYPE, so a new outcome fails the typecheck
 * rather than printing `closed_stale` at somebody.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeftRight,
  ArrowRight,
  ExternalLink,
  Eye,
  Pause,
  Play,
  RotateCw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { LateralBoundary } from "@/lib/cascade/membrane/lateralMembranes.pure";
import {
  readLateralExchange,
  runLateralExchangeNow,
  setLateralExchangePausedFn,
  type LateralBoundaryOutcome,
  type LateralBoundaryReport,
  type LateralDirectionOutcome,
  type LateralDirectionReport,
  type LateralLedgerView,
  type LateralMode,
  type LateralReconcileState,
} from "@/server/lateral-exchange.functions";
import { formatDistanceToNow } from "@/lib/format";
import {
  ChannelStateIcon,
  ChannelStateWord,
  MembraneChannelList,
  MembraneStandingList,
} from "./membrane-lists";
import { REASON_LABEL } from "./membraneVocabulary";
import { lateralPores } from "./lateralBand.pure";

interface Props {
  boundary: LateralBoundary;
  onClose: () => void;
}

const BOUNDARY_OUTCOME: Record<LateralBoundaryOutcome, string> = {
  ran: "Ran",
  skipped: "Nothing had changed on either side",
  paused: "Paused — the slot did not run",
  refused: "Refused before anything was judged",
  deferred: "Part of it is waiting for the next slot",
  failed: "Failed",
};

const DIRECTION_OUTCOME: Record<LateralDirectionOutcome, string> = {
  proposed: "Proposed",
  updated: "Proposal updated",
  unchanged: "Proposal already carries this",
  recorded: "Recorded, not proposed",
  dry_run: "Preview — nothing written",
  nothing: "Nothing to carry",
  closed_stale: "Closed a proposal with nothing left to offer",
  deferred: "Waiting for the next slot",
  refused: "Refused",
  failed: "Failed",
};

const MODE_WORD: Record<LateralMode, string> = {
  pr: "Proposes; a person merges",
  auto_merge: "Proposes, and merges once checks pass",
  notify: "Records what would cross; proposes nothing",
};

const PROPOSAL_WORD: Record<LateralReconcileState, string> = {
  open: "Open",
  merged: "Merged",
  declined: "Declined by a person",
  superseded: "Closed by the lane",
  unreadable: "Could not be read",
};

const EVENT_WORD: Record<string, string> = {
  exchange: "Exchange",
  paused: "Paused",
  resumed: "Resumed",
};

type LedgerRead =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; view: LateralLedgerView | null };

/**
 * Whether a server function refused the caller's ROLE, or failed.
 *
 * `requireOperator` throws a 403 `Response`; the transport may also surface
 * it as an Error carrying the refusal's code. Both are the same answer, and
 * neither is "the lane has done nothing".
 */
async function readFailure(e: unknown): Promise<{ forbidden: boolean; message: string }> {
  if (e instanceof Response) {
    if (e.status === 401 || e.status === 403) return { forbidden: true, message: "" };
    let body = "";
    try {
      body = await e.text();
    } catch {
      // The status alone still says what failed.
    }
    return { forbidden: false, message: body ? `HTTP ${e.status}: ${body}` : `HTTP ${e.status}` };
  }
  const message = e instanceof Error ? e.message : String(e ?? "unknown error");
  // The role refusal's own code, and nothing looser: a GitHub 403 inside a
  // failed pass is a different answer and must read as one.
  if (/forbidden_[a-z_]+_required/.test(message)) return { forbidden: true, message: "" };
  return { forbidden: false, message };
}

const stamp = (iso: string) => new Date(iso).toLocaleString("en-AU");

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
      {children}
    </p>
  );
}

function DirectionLine({ d }: { d: LateralDirectionReport }) {
  return (
    <div className="border border-border/40 bg-muted/20 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <span className="text-foreground">{d.from}</span>
        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="text-foreground">{d.to}</span>
        <span className="ml-auto text-muted-foreground">{DIRECTION_OUTCOME[d.outcome]}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{d.why}</p>
      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
        {d.writes.length} to write · {d.deletes.length} to delete · {d.held.length} held
      </p>
      {d.pr ? (
        <a
          href={d.pr.url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-primary hover:underline"
        >
          Pull request #{d.pr.number}
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
      {d.merge ? (
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Merge: {d.merge}</p>
      ) : null}
      {d.held.length > 0 ? (
        <details className="mt-1.5">
          <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
            What was held, and why
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {d.held.map((h) => (
              <li key={h.path} className="text-[10px] leading-relaxed text-muted-foreground">
                <span className="font-mono text-foreground">{h.path}</span> ·{" "}
                {REASON_LABEL[h.reason]}
                {h.note ? <> — {h.note}</> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * What the band's marks mean, in the words the channel list uses: each state
 * is named by the list's own mark, so the key and the list below it cannot
 * call one state two things. A lane no rule speaks for is described only
 * where the boundary has one, because a key that explains a mark the drawing
 * does not make teaches the reader to look for it.
 */
function BandKey({ boundary }: { boundary: LateralBoundary }) {
  const undeclared = lateralPores(boundary).some(
    (p) => p.intoA === "undeclared" || p.intoB === "undeclared",
  );
  const lanes = [
    { state: "open", mark: "an arrow with a solid dot crossing — that kind crosses that way" },
    { state: "closed", mark: "a solid square — it never crosses that way" },
    { state: "gated", mark: "a hollow, dashed square — a person decides" },
  ] as const;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
        Reading the band
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          The opening at its centre, and the arch through it, carry parent-level work — both ways.
          Each pore beside it is one kind of file, with a lane into each parent:
        </p>
        <ul className="flex flex-col gap-1">
          {lanes.map(({ state, mark }) => (
            <li key={state} className="flex items-center gap-2">
              <ChannelStateIcon state={state} />
              <ChannelStateWord state={state} className="w-12 shrink-0" />
              <span>{mark}</span>
            </li>
          ))}
        </ul>
        {undeclared ? (
          <p>
            An arrow with a hollow dot, in the wall&apos;s grey: no rule speaks for that kind, so
            nothing stops it.
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** One pass, as a person reads it: the verdict, the reason, and each direction. */
function ExchangeReport({ report }: { report: LateralBoundaryReport }) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        <p className="text-xs font-medium text-foreground">{BOUNDARY_OUTCOME[report.outcome]}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{report.why}</p>
        {report.mode ? (
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {MODE_WORD[report.mode]}
          </p>
        ) : null}
      </div>
      {report.conflicts.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-mono text-[10px] text-warning">
            {report.conflicts.length} file{report.conflicts.length === 1 ? "" : "s"} changed on both
            sides — a person decides
          </summary>
          <ul className="mt-1 flex flex-col gap-1">
            {report.conflicts.map((c) => (
              <li key={c.path} className="text-[10px] leading-relaxed text-muted-foreground">
                <span className="font-mono text-foreground">{c.path}</span> — {c.why}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {report.directions.map((d) => (
        <DirectionLine key={`${d.from}->${d.to}`} d={d} />
      ))}
      {report.reconcile.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {report.reconcile.map((r) => (
            <a
              key={`${r.to}#${r.pr}`}
              href={r.url}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-muted-foreground hover:underline"
            >
              {r.to} #{r.pr} · {PROPOSAL_WORD[r.state]}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function LateralDetailPanel({ boundary, onClose }: Props) {
  const [nameA, nameB] = boundary.sides;
  const readFn = useServerFn(readLateralExchange);
  const runFn = useServerFn(runLateralExchangeNow);
  const pauseFn = useServerFn(setLateralExchangePausedFn);

  const [ledger, setLedger] = useState<LedgerRead>({ kind: "loading" });
  const [busy, setBusy] = useState<null | "preview" | "run" | "pause">(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [preview, setPreview] = useState<LateralBoundaryReport | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  // A response that lands after the panel closed must not write into it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLedger({ kind: "loading" });
    try {
      const views = await readFn();
      if (!live.current) return;
      setLedger({ kind: "ready", view: views.find((v) => v.boundary === boundary.id) ?? null });
    } catch (e) {
      const failure = await readFailure(e);
      if (!live.current) return;
      setLedger(
        failure.forbidden ? { kind: "forbidden" } : { kind: "failed", message: failure.message },
      );
    }
  }, [readFn, boundary.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (kind: "preview" | "run" | "pause", paused?: boolean) => {
      setBusy(kind);
      setActionNote(null);
      try {
        if (kind === "pause") {
          const result = await pauseFn({ data: { paused: paused === true } });
          if (!live.current) return;
          if (!result.ok) {
            setActionNote(result.error);
          } else {
            const failedDisarms = result.boundaries.flatMap((b) => b.disarmed.filter((d) => !d.ok));
            setActionNote(
              failedDisarms.length > 0
                ? `Paused, but ${failedDisarms.length} proposal(s) could not be disarmed: ` +
                    failedDisarms.map((d) => `${d.repo} #${d.pr} (${d.why})`).join("; ")
                : paused
                  ? "Paused. The slot will not run this boundary until it is resumed."
                  : "Resumed. The next slot runs this boundary.",
            );
          }
        } else {
          const report = await runFn({ data: { dryRun: kind === "preview" } });
          if (!live.current) return;
          const mine = report.boundaries.find((b) => b.boundary === boundary.id) ?? null;
          if (kind === "preview") setPreview(mine);
          setActionNote(mine ? null : report.why);
        }
        if (kind !== "preview") await refresh();
      } catch (e) {
        const failure = await readFailure(e);
        if (!live.current) return;
        setActionNote(
          failure.forbidden ? "Only an operator can do that." : `Failed: ${failure.message}`,
        );
      } finally {
        if (live.current) {
          setBusy(null);
          setConfirmRun(false);
        }
      }
    },
    [boundary.id, pauseFn, refresh, runFn],
  );

  const view = ledger.kind === "ready" ? ledger.view : null;
  const paused = view?.paused ?? false;
  // Acting on a boundary whose state could not be read is acting blind: a
  // pause button that does not know whether it is paused offers the wrong one.
  const mayAct = ledger.kind === "ready";
  // What a run started here may do, said on the button that starts it. A
  // paused boundary never merges, whatever its mode.
  const mode = view?.report?.mode ?? null;
  const runWarning =
    mode === "notify"
      ? "Confirm — this records, and proposes nothing"
      : mode === "auto_merge" && !paused
        ? "Confirm — this may open and merge pull requests"
        : "Confirm — this may open pull requests";

  return (
    <motion.div
      className="absolute bottom-4 left-4 z-40 max-h-[calc(100%-2rem)] w-96 overflow-y-auto border border-border/60 bg-background/95 p-5 shadow-2xl backdrop-blur-xl"
      initial={{ opacity: 0, x: -40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -40, scale: 0.95 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      // The diagram behind this panel pans on a pointer-down anywhere inside
      // it, and captures the pointer to do so — so a drag on this panel's
      // scrollbar, or across its text, would move the tree instead. The panel
      // is not the canvas.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>Lateral membrane</Eyebrow>
          <h3 className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-xs">
            <span className="text-foreground">{nameA}</span>
            <ArrowLeftRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="text-foreground">{nameB}</span>
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onClose}
          aria-label="Close lateral membrane detail"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{boundary.rationale}</p>

      <BandKey boundary={boundary} />

      <Tabs defaultValue={nameB} className="mt-4">
        <TabsList className="grid w-full grid-cols-2">
          {[nameB, nameA].map((into) => (
            <TabsTrigger
              key={into}
              value={into}
              className="min-w-0 font-mono text-[10px]"
              title={`What may enter ${into}`}
            >
              <span className="truncate">into {into}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {[nameB, nameA].map((into) => {
          const membrane = boundary.toward[into];
          return (
            <TabsContent key={into} value={into}>
              {membrane ? (
                <>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {membrane.rationale}
                  </p>
                  <div className="mt-3">
                    <Eyebrow>Ion channels · {membrane.channels.length}</Eyebrow>
                    <MembraneChannelList channels={membrane.channels} />
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  No membrane is declared into {into}, so nothing crosses this way.
                </p>
              )}
            </TabsContent>
          );
        })}
      </Tabs>

      <div className="mt-4">
        <Eyebrow>
          Runs at this boundary · {boundary.standing.length} filter
          {boundary.standing.length === 1 ? "" : "s"}
        </Eyebrow>
        <MembraneStandingList standing={boundary.standing} />
      </div>

      <div className="mt-4 border-t border-border/30 pt-3">
        <div className="flex items-center justify-between gap-2">
          <Eyebrow>Last exchange</Eyebrow>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => void refresh()}
            disabled={ledger.kind === "loading" || busy !== null}
            aria-label="Read the lane's ledger again"
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </div>

        {ledger.kind === "loading" ? (
          <p className="mt-2 text-[11px] text-muted-foreground">Reading the lane's ledger…</p>
        ) : ledger.kind === "forbidden" ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Only an operator can read this boundary's exchanges or run one. The rule above is the
            same for everyone.
          </p>
        ) : ledger.kind === "failed" ? (
          <p className="mt-2 text-[11px] leading-relaxed text-destructive">
            The lane's ledger could not be read: {ledger.message}
          </p>
        ) : view === null || view.lastEvent === null ? (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            No exchange has run across this boundary yet.
          </p>
        ) : (
          <>
            <p className="mt-2 font-mono text-[10px] text-muted-foreground">
              <span className={paused ? "text-warning" : "text-foreground"}>
                {paused ? "Paused" : "Active"}
              </span>{" "}
              · {EVENT_WORD[view.lastEvent.event] ?? "Exchange"}{" "}
              <span title={stamp(view.lastEvent.at)}>{formatDistanceToNow(view.lastEvent.at)}</span>
            </p>
            {view.report ? <ExchangeReport report={view.report} /> : null}
            {view.proposals.length > 0 ? (
              <div className="mt-2">
                <Eyebrow>Open proposals · {view.proposals.length}</Eyebrow>
                <div className="mt-1 flex flex-col gap-0.5">
                  {view.proposals.map((p) => (
                    <a
                      key={`${p.to}#${p.pr}`}
                      href={p.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[10px] text-primary hover:underline"
                    >
                      into {p.to} · #{p.pr} · {p.files} file{p.files === 1 ? "" : "s"}
                    </a>
                  ))}
                </div>
              </div>
            ) : null}
            {view.history.length > 1 ? (
              <details className="mt-2">
                <summary className="cursor-pointer font-mono text-[10px] text-muted-foreground">
                  Earlier passes
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {view.history.slice(1).map((h) => (
                    <li key={h.at} className="font-mono text-[10px] text-muted-foreground">
                      <span title={stamp(h.at)}>{formatDistanceToNow(h.at)}</span> ·{" "}
                      {EVENT_WORD[h.event] ?? "Exchange"}
                      {h.outcome ? (
                        <> · {BOUNDARY_OUTCOME[h.outcome as LateralBoundaryOutcome] ?? "—"}</>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}

        {mayAct ? (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-[11px]"
                disabled={busy !== null}
                onClick={() => void act("preview")}
              >
                <Eye className="mr-1.5 h-3 w-3" />
                {busy === "preview" ? "Previewing…" : "Preview"}
              </Button>
              {confirmRun ? (
                <>
                  <Button
                    size="sm"
                    variant="default"
                    className="font-mono text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void act("run")}
                  >
                    <Play className="mr-1.5 h-3 w-3" />
                    {busy === "run" ? "Running…" : runWarning}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="font-mono text-[11px]"
                    disabled={busy !== null}
                    onClick={() => setConfirmRun(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="font-mono text-[11px]"
                  disabled={busy !== null}
                  onClick={() => setConfirmRun(true)}
                >
                  <Play className="mr-1.5 h-3 w-3" />
                  Run now
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-[11px]"
                disabled={busy !== null}
                onClick={() => void act("pause", !paused)}
              >
                {paused ? (
                  <Play className="mr-1.5 h-3 w-3" />
                ) : (
                  <Pause className="mr-1.5 h-3 w-3" />
                )}
                {busy === "pause" ? "Saving…" : paused ? "Resume" : "Pause"}
              </Button>
            </div>
            {paused ? (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                While paused the slot skips this boundary. A run started here still proposes, and
                never merges.
              </p>
            ) : null}
            {actionNote ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground" role="status">
                {actionNote}
              </p>
            ) : null}
            {preview ? (
              <div className="border border-dashed border-border/60 p-2.5">
                <Eyebrow>Preview · nothing was written</Eyebrow>
                <ExchangeReport report={preview} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
