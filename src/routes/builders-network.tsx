import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Building2,
  Cable,
  CheckCircle2,
  Copy,
  EyeOff,
  FileSignature,
  Inbox,
  KeyRound,
  Loader2,
  ChevronDown,
  ChevronRight,
  Mail,
  PauseCircle,
  Pencil,
  Pin,
  PlayCircle,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  Snowflake,
  Trophy,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildersNetworkStatus,
  listNetworkOrganisations,
  listNetworkJoinRequests,
  listNetworkAccessRequests,
  listShadowConnections,
  listClonesForNetwork,
  approveNetworkOrganisation,
  suspendNetworkOrganisation,
  reinstateNetworkOrganisation,
  registerWorkspaceOnNetwork,
  createNetworkConnection,
  revokeNetworkConnection,
  setNetworkConnectionTransport,
  listNetworkRanking,
  explainNetworkRanking,
  setNetworkRankingOverride,
  clearNetworkRankingOverride,
  setNetworkRankingFreeze,
  setNetworkCommercialPlacement,
  clearNetworkCommercialPlacement,
  type NetworkOrganisation,
  type NetworkRankedBuilder,
  type NetworkSignalReading,
} from "@/server/builders-network.functions";
import { installCloneNetworkTransport } from "@/server/buildersTransportInstall.functions";
import { readNetworkFailure } from "@/lib/buildersNetworkFailure.pure";
import { AccessRequestsPanel } from "@/components/builders-network-access-requests";
import {
  CloseOrganisationDialog,
  InviteOwnerDialog,
  OrganisationFormDialog,
} from "@/components/builders-network-organisation-dialogs";

/**
 * The Builders Network operator console (extraction plan §5).
 *
 * Deliberately at /builders-network — never /modules/builder, which is the
 * unrelated Module Builder entitlement. Every mutation travels to the
 * NETWORK's admin API as a federation-asserted call; MC holds no network
 * service-role key, and the NULL-clone builders:operate key row is the
 * revocable switch the status strip reads. Approving an organisation also
 * ensures its per-organisation tenant (plan §10: metering identity is per
 * builder organisation), so the ledger exists from the day of approval.
 */
export const Route = createFileRoute("/builders-network")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <BuildersNetworkConsole />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Builders Network — Aurixa Systems Mission Control" }] }),
});

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending_verification: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  pending_activation: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  suspended: "bg-red-500/15 text-red-600 dark:text-red-400",
  closed: "bg-muted text-muted-foreground",
  invited: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  revoked: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function StatusBadge({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={STATUS_TONE[value] ?? ""}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

/**
 * Why the console could not act, and — where one exists here — the act that
 * fixes it.
 *
 * This replaces three sites that printed the transport's own discriminant as
 * the explanation: a live deployment told an operator the network could not be
 * read because `operate_switch_off`. `readNetworkFailure` is the single place
 * that wording lives, so the three cannot drift, and the remedy is a LINK to
 * the page that already mints the key rather than a second mint built here —
 * two mint paths is how one of them comes to be wrong.
 *
 * The raw code is deliberately not drawn beside the sentence. For the faults
 * Mission Control owns the sentence is complete and the code adds nothing; for
 * every other code the sentence IS the code, unslugged, so nothing is lost.
 */
function NetworkFailureNotice({ title, code }: { title: string; code: string | null | undefined }) {
  const reading = readNetworkFailure(code);
  return (
    <EmptyState
      icon={<ShieldAlert className="h-8 w-8" aria-hidden />}
      title={title}
      description={reading.sentence}
      action={
        reading.remedy ? (
          <Button asChild size="sm">
            <Link to={reading.remedy.to} search={reading.remedy.search}>
              <KeyRound className="mr-2 h-4 w-4" aria-hidden />
              {reading.remedy.label}
            </Link>
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * THE MARKETPLACE RANKING.
 *
 * Every Aurixa workspace draws the same builder stock from this network, in an
 * order the network computes hourly from measured evidence. This panel is where
 * that order is READ and where the three manual instruments live.
 *
 * What it deliberately cannot do is edit a score. A merit score is a statement
 * about a builder that the evidence produced, and an operator who could type
 * one could tell a builder a number nothing measured — after which the
 * confidence figure, the band and the "not measured" list beside it would all
 * be decoration. Pin, suppress and freeze sit BESIDE the computed answer; the
 * score stays true and the intervention stays visible as an intervention.
 *
 * CONFIDENCE IS DRAWN BESIDE EVERY SCORE, never behind it. A 70 evidenced on a
 * tenth of the signals and a 70 evidenced on all of them are different claims,
 * and the network is young enough that most builders are the first kind.
 */
function RankingPanel() {
  const queryClient = useQueryClient();
  const rankingFn = useServerFn(listNetworkRanking);
  const overrideFn = useServerFn(setNetworkRankingOverride);
  const clearOverrideFn = useServerFn(clearNetworkRankingOverride);
  const freezeFn = useServerFn(setNetworkRankingFreeze);
  const placementFn = useServerFn(setNetworkCommercialPlacement);
  const clearPlacementFn = useServerFn(clearNetworkCommercialPlacement);

  const ranking = useQuery({ queryKey: ["bn-ranking"], queryFn: () => rankingFn() });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["bn-ranking"] });

  const data = ranking.data?.ok ? ranking.data : null;
  const state = data?.state ?? null;
  const builders = data?.builders ?? [];

  /**
   * Every instrument asks for a reason it will not proceed without.
   *
   * An intervention nobody wrote down is indistinguishable from the algorithm's
   * own answer six months later, and this is the one surface where that
   * distinction is the entire point. The floor is the same ten characters the
   * database enforces, so the prompt and the constraint cannot become two
   * different standards.
   */
  const askReason = (what: string): string | null => {
    const reason = window.prompt(
      `${what}\n\nRecord why. This is kept with the override and shown to whoever reviews the marketplace next.`,
    );
    if (reason === null) return null;
    if (reason.trim().length < 10) {
      toast.error("A reason of at least 10 characters is required.");
      return null;
    }
    return reason.trim();
  };

  const act = async (key: string, run: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key);
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? "The network refused that.");
      else {
        toast.success("Recorded.");
        refresh();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not go through.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">Marketplace ranking</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          {state?.last_run_at ? (
            <span className="text-xs text-muted-foreground">
              Last run {new Date(state.last_run_at).toLocaleString("en-AU")}
              {state.last_run_items !== null ? ` · ${state.last_run_items} properties` : ""}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Not yet run</span>
          )}
          <Button
            size="sm"
            variant={state?.frozen ? "default" : "outline"}
            disabled={busy === "freeze"}
            onClick={() => {
              if (state?.frozen) {
                void act("freeze", () => freezeFn({ data: { frozen: false } }));
                return;
              }
              const reason = askReason("Freeze the marketplace ranking");
              if (reason) void act("freeze", () => freezeFn({ data: { frozen: true, reason } }));
            }}
          >
            {busy === "freeze" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Snowflake className="mr-2 h-4 w-4" aria-hidden />
            )}
            {state?.frozen ? "Release the freeze" : "Freeze the ranking"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/*
         * A FREEZE IS ANNOUNCED, NOT INFERRED. A frozen ranking that nobody can
         * see is frozen looks exactly like a scheduler that quietly stopped.
         */}
        {state?.frozen ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="font-medium">The published order is frozen.</p>
            <p className="mt-1 text-muted-foreground">
              {state.frozen_reason}
              {state.frozen_at ? ` — ${new Date(state.frozen_at).toLocaleString("en-AU")}` : ""}
              {state.frozen_by ? `, by ${state.frozen_by}` : ""}
            </p>
            <p className="mt-1 text-muted-foreground">
              Hourly runs still start and write nothing. Every clone keeps drawing the last
              published order.
            </p>
          </div>
        ) : null}

        {state?.last_run_error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium">The last run did not finish.</p>
            <p className="mt-1 text-muted-foreground">{state.last_run_error}</p>
          </div>
        ) : null}

        {ranking.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the ranking…</p>
        ) : !ranking.data?.ok ? (
          <NetworkFailureNotice title="The ranking could not be read" code={ranking.data?.error} />
        ) : builders.length === 0 ? (
          <EmptyState
            icon={<Trophy className="h-8 w-8" aria-hidden />}
            title="No builder has been ranked yet"
            description="The first hourly run scores every active builder. Until then the marketplace orders newest first, exactly as it did before."
          />
        ) : (
          <div className="space-y-2">
            {builders.map((builder: NetworkRankedBuilder) => (
              <RankingRow
                key={builder.organisation_id}
                builder={builder}
                busy={busy}
                onPin={() => {
                  const raw = window.prompt(
                    "Pin this builder to which position? (1 is the top of the marketplace)",
                  );
                  if (raw === null) return;
                  const position = Number(raw);
                  if (!Number.isInteger(position) || position < 1) {
                    toast.error("A position must be a whole number of 1 or more.");
                    return;
                  }
                  const reason = askReason(
                    `Pin ${builder.trading_name ?? builder.legal_name} at position ${position}`,
                  );
                  if (!reason) return;
                  void act(builder.organisation_id, () =>
                    overrideFn({
                      data: {
                        organisationId: builder.organisation_id,
                        kind: "pin",
                        position,
                        reason,
                      },
                    }),
                  );
                }}
                onSuppress={() => {
                  const reason = askReason(
                    `Take ${builder.trading_name ?? builder.legal_name} out of the marketplace`,
                  );
                  if (!reason) return;
                  void act(builder.organisation_id, () =>
                    overrideFn({
                      data: { organisationId: builder.organisation_id, kind: "suppress", reason },
                    }),
                  );
                }}
                onClearOverride={(kind) =>
                  void act(builder.organisation_id, () =>
                    clearOverrideFn({ data: { organisationId: builder.organisation_id, kind } }),
                  )
                }
                onPlace={(tier) =>
                  void act(builder.organisation_id, () =>
                    placementFn({ data: { organisationId: builder.organisation_id, tier } }),
                  )
                }
                onClearPlacement={() =>
                  void act(builder.organisation_id, () =>
                    clearPlacementFn({ data: { organisationId: builder.organisation_id } }),
                  )
                }
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const BAND_LABEL = ["Established", "Strong", "Standard", "Developing", "Unrated"];

/**
 * WHY A BUILDER RANKS WHERE THEY RANK, read rather than recomputed.
 *
 * The snapshot stores every signal's reading and the evidence it came from, so
 * this explains the score the marketplace was actually ordered by. Recomputing
 * to explain is how an explanation comes to differ from the decision it is
 * explaining — and an operator defending a position to a builder needs the two
 * to be the same thing.
 *
 * It reads only when asked. Thirteen signal readings per builder is a lot to
 * fetch for a list nobody has questioned.
 */
function RankingExplanation({ organisationId }: { organisationId: string }) {
  const explainFn = useServerFn(explainNetworkRanking);
  const query = useQuery({
    queryKey: ["bn-ranking-explain", organisationId],
    queryFn: () => explainFn({ data: { organisationId } }),
  });

  if (query.isPending) {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Reading the signals…
      </p>
    );
  }

  /*
   * A read that FAILED is not a builder with no evidence. The distinction is
   * the same one the recompute makes when it abandons a run rather than
   * scoring against data that did not load.
   */
  const snapshot = query.data?.ok ? query.data.snapshot : null;
  if (!snapshot) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        The signals could not be read.{" "}
        {query.data && !query.data.ok ? readNetworkFailure(query.data.error).short : null}
      </p>
    );
  }

  const readings = Object.entries(snapshot.signals ?? {}) as Array<[string, NetworkSignalReading]>;
  const measured = readings
    .filter(([, r]) => r.state === "measured")
    .sort((a, b) => (b[1] as { value: number }).value - (a[1] as { value: number }).value);
  const unmeasured = readings.filter(([, r]) => r.state === "not_measured");

  const label = (key: string) => key.replace(/_/g, " ");

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <p className="text-xs text-muted-foreground">
        Measured {new Date(snapshot.computed_at).toLocaleString("en-AU")}
        {" · "}method version {snapshot.ranking_version}
      </p>

      {measured.length ? (
        <ul className="mt-2 space-y-1">
          {measured.map(([key, reading]) => (
            <li key={key} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="capitalize">{label(key)}</span>
              <span className="tabular-nums font-medium">
                {(reading as { value: number }).value.toFixed(0)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Nothing about this builder has been measured yet. The score is the neutral prior alone.
        </p>
      )}

      {/*
       * The unmeasured list is the point, not a footnote. A score built on two
       * signals out of thirteen is a different claim from the same score built
       * on all of them, and an operator about to act on a position needs to
       * see which it is. None of these counted against the builder.
       */}
      {unmeasured.length ? (
        <div className="mt-3 border-t pt-2">
          <p className="text-xs font-medium">Not measured — and not counted against them</p>
          <ul className="mt-1 space-y-1">
            {unmeasured.map(([key, reading]) => (
              <li
                key={key}
                className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground"
              >
                <span className="capitalize">{label(key)}</span>
                <span>{(reading as { reason: string }).reason.replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RankingRow({
  builder,
  busy,
  onPin,
  onSuppress,
  onClearOverride,
  onPlace,
  onClearPlacement,
}: {
  builder: NetworkRankedBuilder;
  busy: string | null;
  onPin: () => void;
  onSuppress: () => void;
  onClearOverride: (kind: "pin" | "suppress") => void;
  onPlace: (tier: "partner" | "premium" | "featured") => void;
  onClearPlacement: () => void;
}) {
  const working = busy === builder.organisation_id;
  const override = builder.override;
  const placement = builder.placement;
  const confidence = Math.round((builder.confidence ?? 0) * 100);
  const [explaining, setExplaining] = useState(false);

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-[14rem] flex-1">
          <p className="text-sm font-medium">
            {builder.trading_name ?? builder.legal_name ?? builder.organisation_id}
          </p>
          <p className="text-xs text-muted-foreground">
            {builder.live_stock} live {builder.live_stock === 1 ? "property" : "properties"}
            {" · "}
            {BAND_LABEL[builder.band] ?? BAND_LABEL[BAND_LABEL.length - 1]}
          </p>
        </div>

        <div className="text-right">
          <p className="text-lg font-semibold tabular-nums">
            {Number(builder.merit_score).toFixed(1)}
          </p>
          {/*
           * The confidence is not decoration. While the network is young most
           * of what a builder would be ranked on has never happened, so a
           * score's evidence base is the thing an operator needs to read
           * before treating the number as a judgement about the builder.
           */}
          <p className="text-xs text-muted-foreground">{confidence}% of signals measured</p>
          {/*
           * Directly under the confidence figure, because this is what that
           * figure is short for. A percentage an operator cannot open is a
           * number they have to take on trust, and the evidence is already
           * stored precisely so they do not have to.
           */}
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            aria-expanded={explaining}
            onClick={() => setExplaining((open) => !open)}
          >
            {explaining ? (
              <ChevronDown className="mr-1 h-3 w-3" aria-hidden />
            ) : (
              <ChevronRight className="mr-1 h-3 w-3" aria-hidden />
            )}
            Why this score
          </Button>
        </div>
      </div>

      {explaining ? <RankingExplanation organisationId={builder.organisation_id} /> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {override?.kind === "pin" ? (
          <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
            <Pin className="mr-1 h-3 w-3" aria-hidden />
            Pinned at {override.position}
            {override.expires_at
              ? ` until ${new Date(override.expires_at).toLocaleDateString("en-AU")}`
              : " (standing)"}
          </Badge>
        ) : null}
        {override?.kind === "suppress" ? (
          <Badge
            variant="outline"
            className="border-destructive/40 bg-destructive/10 text-destructive"
          >
            <EyeOff className="mr-1 h-3 w-3" aria-hidden />
            Out of the marketplace
            {override.expires_at
              ? ` until ${new Date(override.expires_at).toLocaleDateString("en-AU")}`
              : ""}
          </Badge>
        ) : null}
        {placement ? (
          <Badge variant="outline" className="border-warning/40 bg-warning/10 text-warning">
            <Trophy className="mr-1 h-3 w-3" aria-hidden />
            {placement.tier}
            {placement.ends_at
              ? ` until ${new Date(placement.ends_at).toLocaleDateString("en-AU")}`
              : ""}
          </Badge>
        ) : null}
      </div>

      {override ? (
        <p className="mt-2 text-xs text-muted-foreground">
          “{override.reason}” — {override.created_by}
          {override.created_at
            ? `, ${new Date(override.created_at).toLocaleDateString("en-AU")}`
            : ""}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {override?.kind === "pin" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => onClearOverride("pin")}
          >
            Remove the pin
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={working} onClick={onPin}>
            {working ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Pin className="mr-2 h-4 w-4" aria-hidden />
            )}
            Pin to a position
          </Button>
        )}
        {override?.kind === "suppress" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={working}
            onClick={() => onClearOverride("suppress")}
          >
            Return to the marketplace
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={working} onClick={onSuppress}>
            <EyeOff className="mr-2 h-4 w-4" aria-hidden />
            Take out of the marketplace
          </Button>
        )}
        {placement ? (
          <Button size="sm" variant="ghost" disabled={working} onClick={onClearPlacement}>
            End the placement
          </Button>
        ) : (
          <Select
            disabled={working}
            onValueChange={(value) => onPlace(value as "partner" | "premium" | "featured")}
          >
            <SelectTrigger className="h-9 w-[12rem]">
              <SelectValue placeholder="Commercial placement" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="partner">Partner</SelectItem>
              <SelectItem value="premium">Premium partner</SelectItem>
              <SelectItem value="featured">Featured partner</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

function BuildersNetworkConsole() {
  const queryClient = useQueryClient();
  const statusFn = useServerFn(buildersNetworkStatus);
  const orgsFn = useServerFn(listNetworkOrganisations);
  const joinsFn = useServerFn(listNetworkJoinRequests);
  const accessRequestsFn = useServerFn(listNetworkAccessRequests);
  const shadowFn = useServerFn(listShadowConnections);
  const clonesFn = useServerFn(listClonesForNetwork);
  const approveFn = useServerFn(approveNetworkOrganisation);
  const suspendFn = useServerFn(suspendNetworkOrganisation);
  const reinstateFn = useServerFn(reinstateNetworkOrganisation);
  const registerFn = useServerFn(registerWorkspaceOnNetwork);
  const createConnFn = useServerFn(createNetworkConnection);
  const revokeConnFn = useServerFn(revokeNetworkConnection);
  const transportFn = useServerFn(setNetworkConnectionTransport);
  const installFn = useServerFn(installCloneNetworkTransport);

  const status = useQuery({ queryKey: ["bn-status"], queryFn: () => statusFn() });
  const organisations = useQuery({ queryKey: ["bn-orgs"], queryFn: () => orgsFn({ data: {} }) });
  const joins = useQuery({ queryKey: ["bn-joins"], queryFn: () => joinsFn() });
  const accessRequests = useQuery({
    queryKey: ["bn-access-requests"],
    queryFn: () => accessRequestsFn(),
  });
  const shadow = useQuery({ queryKey: ["bn-shadow"], queryFn: () => shadowFn() });
  const clones = useQuery({ queryKey: ["bn-clones"], queryFn: () => clonesFn() });

  const [busyOrg, setBusyOrg] = useState<string | null>(null);
  // Null means the form is closed; `undefined` subject means "create".
  const [orgFormOpen, setOrgFormOpen] = useState(false);
  const [orgBeingEdited, setOrgBeingEdited] = useState<NetworkOrganisation | null>(null);
  const [orgBeingClosed, setOrgBeingClosed] = useState<NetworkOrganisation | null>(null);
  const [orgBeingSeeded, setOrgBeingSeeded] = useState<NetworkOrganisation | null>(null);
  // Hoisted so each button reads as the act it is, and so "create" and "edit"
  // cannot drift apart: they are the same form on a different subject.
  const openOrganisationForm = (organisation: NetworkOrganisation | null) => {
    setOrgBeingEdited(organisation);
    setOrgFormOpen(true);
  };
  const closeOrganisationForm = (next: boolean) => {
    setOrgFormOpen(next);
    if (!next) setOrgBeingEdited(null);
  };
  const [connClone, setConnClone] = useState("");
  const [connOrg, setConnOrg] = useState("");
  const [creatingConn, setCreatingConn] = useState(false);
  const [mintedInvite, setMintedInvite] = useState<{ code: string; expires: string } | null>(null);
  const [transportDrafts, setTransportDrafts] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState<string | null>(null);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["bn-status"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-orgs"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-joins"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-access-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-shadow"] });
  };

  const act = async (
    organisation: NetworkOrganisation,
    action: "approve" | "suspend" | "reinstate",
  ) => {
    setBusyOrg(organisation.id);
    try {
      if (action === "approve") {
        const result = await approveFn({
          data: { organisationId: organisation.id, legalName: organisation.legal_name },
        });
        if (!result.ok) throw new Error(result.error);
        toast.success(
          result.tenant.ok
            ? `${organisation.legal_name} approved — metering tenant ready`
            : `${organisation.legal_name} approved — TENANT FAILED: ${result.tenant.error}`,
        );
      } else if (action === "suspend") {
        const reason = window.prompt(`Reason for suspending ${organisation.legal_name}?`)?.trim();
        if (!reason) return;
        const result = await suspendFn({ data: { organisationId: organisation.id, reason } });
        if (!result.ok) throw new Error(result.error);
        toast.success(`${organisation.legal_name} suspended`);
      } else {
        const result = await reinstateFn({ data: { organisationId: organisation.id } });
        if (!result.ok) throw new Error(result.error);
        toast.success(`${organisation.legal_name} reinstated`);
      }
      refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The network refused the action");
    } finally {
      setBusyOrg(null);
    }
  };

  const createConnection = async () => {
    if (!connClone || !connOrg) {
      toast.error("Choose a workspace and an organisation");
      return;
    }
    setCreatingConn(true);
    try {
      // The directory row travels first, so the network can resolve the clone.
      const registered = await registerFn({ data: { cloneId: connClone } });
      if (!registered.ok) throw new Error(registered.error);
      const result = await createConnFn({
        data: { cloneId: connClone, builderOrganisationId: connOrg },
      });
      if (!result.ok) throw new Error(result.error);
      setMintedInvite({ code: result.invite_code, expires: result.expires_at });
      refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The connection could not be created");
    } finally {
      setCreatingConn(false);
    }
  };

  const gate = status.data?.switch;
  const overview = status.data?.overview;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="Platform"
        title="Builders Network"
        description="Vet organisations, mint workspace connections and watch the sync plane of builders.aurixasystems.com.au."
        icon={<Building2 className="h-5 w-5" aria-hidden />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => openOrganisationForm(null)}
              disabled={!gate?.enabled}
              title={gate?.enabled ? undefined : "The operate switch is off"}
            >
              <Plus className="mr-2 h-4 w-4" aria-hidden /> New organisation
            </Button>
            <Button variant="outline" size="sm" onClick={refreshAll}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Refresh
            </Button>
          </div>
        }
      />

      {/* ---------------------------------------------------------- status */}
      {/*
        Three preconditions govern every call this console makes, and
        `callBuilderNetworkAdmin` reports only the FIRST that fails. So all
        three are drawn at once: fixing the switch must not reveal a signing
        key nobody had been shown.
      */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden /> Operate switch
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {status.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : !status.data ? (
              // The status did not load. Falling through to the switched-off
              // wording here told an operator their console was off, and
              // offered to mint a key, on no evidence at all.
              <div className="flex items-start gap-2 text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{readNetworkFailure("status_unreadable").short}</span>
              </div>
            ) : gate?.enabled ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
                <span>Live NULL-clone key{gate.label ? ` — ${gate.label}` : ""}</span>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-start gap-2 text-red-500">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {status.data?.switch &&
                    !status.data.switch.enabled &&
                    status.data.switch.reason === "read_failed"
                      ? readNetworkFailure("read_failed").short
                      : readNetworkFailure("operate_switch_off").short}
                  </span>
                </div>
                {/* The act, beside the statement that it is owed. Naming a
                    remedy an operator cannot reach is what this card did
                    before: the page that mints the key is titled "Billing &
                    Tokens", which shares no word with what they are doing. */}
                {status.data?.switch?.enabled === false &&
                status.data.switch.reason === "no_live_operate_key" ? (
                  <Button asChild size="sm" variant="outline">
                    <Link to="/settings/billing" search={{ tab: "keys" }}>
                      <KeyRound className="mr-2 h-4 w-4" aria-hidden /> Mint the operate key
                    </Link>
                  </Button>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <FileSignature className="h-4 w-4 text-primary" aria-hidden /> Platform signing key
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {status.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : !status.data ? (
              <div className="flex items-start gap-2 text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{readNetworkFailure("status_unreadable").short}</span>
              </div>
            ) : status.data.signing_key_present ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
                <span>Assertions can be signed</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-red-500">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>{readNetworkFailure("signing_key_missing").short}</span>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Plug className="h-4 w-4 text-primary" aria-hidden /> Network endpoint
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {!status.data ? (
              <span className="text-muted-foreground">
                {readNetworkFailure("status_unreadable").short}
              </span>
            ) : status.data.network_url_configured ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                BUILDERS_NETWORK_ADMIN_URL configured
              </span>
            ) : (
              <span className="text-red-500">
                {readNetworkFailure("network_url_unconfigured").short}
              </span>
            )}
            {status.data?.overview_error && (
              <p className="mt-1 text-xs text-muted-foreground">
                Last call: {readNetworkFailure(status.data.overview_error).short}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4 text-primary" aria-hidden /> Network counts
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {overview ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(overview.organisations).map(([key, count]) => (
                  <span key={`o-${key}`}>
                    {key.replaceAll("_", " ")}: <strong>{count}</strong>
                  </span>
                ))}
                <span>
                  join requests: <strong>{overview.pending_join_requests}</strong>
                </span>
                <span>
                  dead letters:{" "}
                  <strong className={overview.dead_letters ? "text-red-500" : ""}>
                    {overview.dead_letters}
                  </strong>
                </span>
              </div>
            ) : (
              <span className="text-muted-foreground">Not available</span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* --------------------------------------------------- organisations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organisations</CardTitle>
        </CardHeader>
        <CardContent>
          {organisations.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : !organisations.data?.ok ? (
            <NetworkFailureNotice
              title="The network could not be read"
              code={organisations.data?.error}
            />
          ) : organisations.data.organisations.length === 0 ? (
            <EmptyState
              icon={<Building2 className="h-5 w-5" aria-hidden />}
              title="No organisations yet"
              description="Registrations appear here for vetting."
            />
          ) : (
            <div className="divide-y divide-border">
              {organisations.data.organisations.map((organisation) => (
                <div key={organisation.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="truncate font-medium">{organisation.legal_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {organisation.org_type.replaceAll("_", " ")}
                      {organisation.abn ? ` · ABN ${organisation.abn}` : ""}
                      {organisation.state ? ` · ${organisation.state}` : ""}
                      {organisation.contact_email ? ` · ${organisation.contact_email}` : ""}
                    </p>
                    {organisation.suspension_reason && (
                      <p className="truncate text-xs text-red-500">
                        Suspended: {organisation.suspension_reason}
                      </p>
                    )}
                  </div>
                  <StatusBadge value={organisation.status} />
                  <div className="flex gap-2">
                    {(organisation.status === "pending_verification" ||
                      organisation.status === "pending_activation") && (
                      <Button
                        size="sm"
                        disabled={busyOrg === organisation.id}
                        onClick={() => void act(organisation, "approve")}
                      >
                        {busyOrg === organisation.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        ) : (
                          <PlayCircle className="mr-1 h-4 w-4" aria-hidden />
                        )}
                        Approve
                      </Button>
                    )}
                    {organisation.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyOrg === organisation.id}
                        onClick={() => void act(organisation, "suspend")}
                      >
                        <PauseCircle className="mr-1 h-4 w-4" aria-hidden /> Suspend
                      </Button>
                    )}
                    {organisation.status === "suspended" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyOrg === organisation.id}
                        onClick={() => void act(organisation, "reinstate")}
                      >
                        <PlayCircle className="mr-1 h-4 w-4" aria-hidden /> Reinstate
                      </Button>
                    )}
                    {/* A closed organisation is terminal: nothing here may act
                        on one, which is why every control below is withheld. */}
                    {organisation.status !== "closed" && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openOrganisationForm(organisation)}
                        >
                          <Pencil className="mr-1 h-4 w-4" aria-hidden /> Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setOrgBeingSeeded(organisation)}
                        >
                          <Mail className="mr-1 h-4 w-4" aria-hidden /> Invite owner
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setOrgBeingClosed(organisation)}
                        >
                          <XCircle className="mr-1 h-4 w-4" aria-hidden /> Close
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <OrganisationFormDialog
        open={orgFormOpen}
        onOpenChange={closeOrganisationForm}
        organisation={orgBeingEdited}
        onSaved={refreshAll}
      />
      <CloseOrganisationDialog
        organisation={orgBeingClosed}
        onOpenChange={(next) => {
          if (!next) setOrgBeingClosed(null);
        }}
        onClosed={refreshAll}
      />
      <InviteOwnerDialog
        organisation={orgBeingSeeded}
        onOpenChange={(next) => {
          if (!next) setOrgBeingSeeded(null);
        }}
      />

      {/* ----------------------------------------------------- connections */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Workspace (clone)</p>
              <Select value={connClone} onValueChange={setConnClone}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a workspace…" />
                </SelectTrigger>
                <SelectContent>
                  {(clones.data?.ok ? clones.data.clones : []).map((clone) => (
                    <SelectItem key={clone.id} value={clone.id}>
                      {clone.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-64 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Builder organisation</p>
              <Select value={connOrg} onValueChange={setConnOrg}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an organisation…" />
                </SelectTrigger>
                <SelectContent>
                  {(organisations.data?.ok ? organisations.data.organisations : [])
                    .filter((organisation) => organisation.status === "active")
                    .map((organisation) => (
                      <SelectItem key={organisation.id} value={organisation.id}>
                        {organisation.legal_name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void createConnection()} disabled={creatingConn}>
              {creatingConn ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Cable className="mr-2 h-4 w-4" aria-hidden />
              )}
              Mint connection invite
            </Button>
          </div>

          {mintedInvite && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">Invitation code — shown once, only the hash is stored:</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="break-all rounded bg-background px-2 py-1 text-xs">
                  {mintedInvite.code}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(mintedInvite.code);
                    toast.success("Copied");
                  }}
                >
                  <Copy className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Hand it to the organisation's owner out of band; they accept it in their portal.
                Expires {new Date(mintedInvite.expires).toLocaleString("en-AU")}.
              </p>
            </div>
          )}

          {shadow.data?.ok && shadow.data.connections.length > 0 && (
            <div className="divide-y divide-border">
              {shadow.data.connections.map((connection) => (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="truncate text-sm font-medium">
                      {connection.builder_org_label ?? connection.builder_org_ref}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      clone {connection.clone_id} · network {connection.network_connection_id}
                    </p>
                  </div>
                  <StatusBadge value={connection.state} />
                  {connection.state !== "revoked" && (
                    <>
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 w-72 text-xs"
                          placeholder="https://…/builder-network-inbound"
                          value={transportDrafts[connection.network_connection_id] ?? ""}
                          onChange={(event) =>
                            setTransportDrafts((drafts) => ({
                              ...drafts,
                              [connection.network_connection_id]: event.target.value,
                            }))
                          }
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const inboundUrl = (
                              transportDrafts[connection.network_connection_id] ?? ""
                            ).trim();
                            const result = await transportFn({
                              data: { connectionId: connection.network_connection_id, inboundUrl },
                            });
                            if (result.ok) toast.success("Transport configured");
                            else toast.error(result.error);
                          }}
                        >
                          Set inbound URL
                        </Button>
                      </div>
                      {/*
                       * The act the network has always expected and nothing
                       * performed: take the one-shot transport grant and write
                       * it into this workspace's own connection row. Until
                       * this existed the row was uncreatable, so every
                       * deployment's Builders Network sat dark behind an empty
                       * table. The grant never reaches this component — the
                       * server fetches and installs it in one act and answers
                       * with a status.
                       */}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={installing === connection.network_connection_id}
                        onClick={async () => {
                          const id = connection.network_connection_id;
                          setInstalling(id);
                          try {
                            const result = await installFn({ data: { connectionId: id } });
                            if (result.ok) {
                              toast.success("Transport installed on the workspace");
                              refreshAll();
                              return;
                            }
                            /*
                             * A grant handed out once already. Rotating is the
                             * only way to a usable one, and it invalidates
                             * whatever the workspace holds — so it is said
                             * before it is done, never retried silently.
                             */
                            if (result.remedy) {
                              const go = window.confirm(
                                `${result.remedy}\n\nRotate now? Any delivery signed with the ` +
                                  `previous credential stops verifying immediately.`,
                              );
                              if (!go) return;
                              const rotated = await installFn({
                                data: { connectionId: id, rotate: true },
                              });
                              if (rotated.ok) {
                                toast.success("Transport rotated and installed");
                                refreshAll();
                              } else toast.error(rotated.error);
                              return;
                            }
                            toast.error(result.error);
                          } finally {
                            setInstalling(null);
                          }
                        }}
                      >
                        {installing === connection.network_connection_id
                          ? "Installing…"
                          : "Install on workspace"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          const reason = window
                            .prompt("Reason for revoking this connection?")
                            ?.trim();
                          if (!reason) return;
                          const result = await revokeConnFn({
                            data: { connectionId: connection.network_connection_id, reason },
                          });
                          if (result.ok) {
                            toast.success("Connection revoked");
                            refreshAll();
                          } else toast.error(result.error);
                        }}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------- access applications */}
      {/* Placed under the organisations it creates and above the join
          requests, because that is the order the work happens in: a lead
          applies, an organisation appears, and only then does anybody ask
          to join it. */}
      <AccessRequestsPanel
        loading={accessRequests.isLoading}
        requests={accessRequests.data?.ok ? accessRequests.data.access_requests : null}
        error={accessRequests.data && !accessRequests.data.ok ? accessRequests.data.error : null}
      />

      {/* --------------------------------------------------- join requests */}
      <Card>
        <RankingPanel />

        <CardHeader>
          <CardTitle className="text-base">Join requests</CardTitle>
          <p className="text-xs text-muted-foreground">
            Visibility only — organisation owners decide membership, never the platform.
          </p>
        </CardHeader>
        <CardContent>
          {!joins.data?.ok || joins.data.join_requests.length === 0 ? (
            <EmptyState
              icon={<Inbox className="h-8 w-8" aria-hidden />}
              title="No join requests"
              description="ABN-matched registrations appear here while their owners decide."
            />
          ) : (
            <div className="divide-y divide-border">
              {joins.data.join_requests.map((request) => (
                <div key={request.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 basis-64 truncate">
                    <strong>{request.requester?.name ?? request.builder_user_id}</strong>
                    {request.requester?.email ? ` <${request.requester.email}>` : ""} →{" "}
                    {request.organisation_legal_name ?? request.organisation_id}
                  </span>
                  <StatusBadge value={request.status} />
                  <span className="text-xs text-muted-foreground">
                    {new Date(request.created_at).toLocaleString("en-AU")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
