// Waitlist lead capture console.
//
// Every lead captured by the Aurixa Systems landing-page waitlist form lands
// in `waitlist_leads` (via /api/public/leads/capture) and shows up here:
// full history with filters + triage, live-updating via Supabase realtime so
// a new lead appears (with a toast) the moment the CTA fires on the website.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useCallback, useEffect, useState } from "react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { recipientReading } from "@/lib/leadStageEmailReading.pure";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UserPlus,
  Filter,
  X,
  Inbox,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Mail,
  Phone,
  Building2,
  Globe,
  CalendarClock,
  Sparkles,
  Briefcase,
  Hash,
  Route as RouteIcon,
  CalendarCheck,
  Clock,
  Users,
  Wallet,
  ShieldCheck,
  Send,
  KeyRound,
  ListChecks,
  Gauge,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { RefreshButton } from "@/components/refresh-button";
import { MetricCell } from "@/components/metric-bar";
import { toast } from "sonner";
import { convertLead } from "@/lib/crm.functions";
import {
  stage2Sections,
  type QuestionnaireAnswers,
  type QuestionnaireSection,
} from "@/lib/leadQuestionnaire.pure";

type Lead = Database["public"]["Tables"]["waitlist_leads"]["Row"];
type StageEmailRow = Database["public"]["Tables"]["lead_stage_emails"]["Row"];

/**
 * What the console knows about a lead's stage emails.
 *
 * Three readings, not two. `unavailable` is its own answer because the table
 * arrives with a migration, and a deployment the migration has not reached
 * answers `PGRST205` on the wire — rendering that as an empty list would tell
 * an operator nothing was sent when the truth is we could not look.
 */
type StageEmails = { kind: "rows"; rows: StageEmailRow[] } | { kind: "unavailable" };
type LeadStatus = Database["public"]["Enums"]["lead_status"];

const PAGE_SIZE = 25;

const STATUS_VALUES = [
  "all",
  "new",
  "contacted",
  "qualified",
  "disqualified",
  "converted",
] as const;

const STATUS_OPTIONS: { value: (typeof STATUS_VALUES)[number]; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "disqualified", label: "Disqualified" },
  { value: "converted", label: "Converted" },
];

/**
 * The waitlist form's "Organisation Type" options
 * (`ORGANISATION_TYPE_OPTIONS`, form version stage-1-priority-access-v3).
 *
 * These are the values that can actually arrive today, and they are what the
 * filter offers. Slugs are stable by contract — the website will not rename
 * one — so a value missing from this map means the form gained an option and
 * this list needs the same one, not that the lead is malformed.
 */
const CLASSIFICATION_LABELS: Record<string, string> = {
  buyers_agent: "Buyer's Agency",
  property_advisory: "Property Advisory",
  real_estate_agency: "Real Estate Agency",
  mortgage_finance: "Mortgage or Finance Brokerage",
  developer: "Property Development",
  construction: "Construction or Building",
  accounting_smsf: "Accounting or SMSF Advisory",
  conveyancing_legal: "Conveyancing or Legal Services",
  property_management: "Property Management",
  multi_service_group: "Multi-service Property Group",
  technology_partner: "Technology or Integration Partner",
  other: "Other",
};

/**
 * Vocabularies the form used to send. Leads captured under them are still in
 * the table and still need to read as something, but they are not offered as
 * filters — nothing new will ever arrive with one.
 */
const LEGACY_CLASSIFICATION_LABELS: Record<string, string> = {
  wealth_advisor: "Wealth Management Firm (retired)",
  financial_planner: "Financial Planning Office (retired)",
  investment_group: "Investment Group (retired)",
  enterprise: "Enterprise Aggregate (retired)",
  enterprise_property_network: "Enterprise Property Network (retired)",
};

/**
 * The form's "Approximate Annual Client or Transaction Volume" brackets.
 *
 * These are counts of clients or transactions. The dollar brackets that used
 * to live here (`tier_1`…`tier_4`) measured something else entirely, so every
 * live lead rendered as a raw slug and every volume filter matched nothing.
 */
const VOLUME_LABELS: Record<string, string> = {
  pre_launch_under_10: "Pre-launch or fewer than 10",
  "10_to_25": "10 – 25",
  "26_to_75": "26 – 75",
  "76_to_150": "76 – 150",
  "151_to_300": "151 – 300",
  "301_to_500": "301 – 500",
  over_500: "More than 500",
  not_yet_known: "Not yet known",
};

const LEGACY_VOLUME_LABELS: Record<string, string> = {
  tier_1: "Under $50M (retired)",
  tier_2: "$50M – $150M (retired)",
  tier_3: "$150M – $500M (retired)",
  tier_4: "$500M+ (retired)",
};

const STAGE_VALUES = ["all", "1", "2", "3"] as const;

const STAGE_OPTIONS: { value: (typeof STAGE_VALUES)[number]; label: string }[] = [
  { value: "all", label: "All stages" },
  { value: "1", label: "Stage 1 — application" },
  { value: "2", label: "Stage 2 — questionnaire" },
  { value: "3", label: "Stage 3 — review booked" },
];

const STAGE_LABELS: Record<number, string> = {
  1: "Stage 1",
  2: "Stage 2",
  3: "Stage 3",
};

const CLASSIFICATION_VALUES = ["all", ...Object.keys(CLASSIFICATION_LABELS)] as const;
const VOLUME_VALUES = ["all", ...Object.keys(VOLUME_LABELS)] as const;

const searchSchema = z.object({
  status: fallback(z.enum(STATUS_VALUES), "all").default("all"),
  classification: fallback(z.string(), "all").default("all"),
  volume: fallback(z.string(), "all").default("all"),
  stage: fallback(z.enum(STAGE_VALUES), "all").default("all"),
  q: fallback(z.string(), "").default(""),
  page: fallback(z.number().int().min(0).max(10_000), 0).default(0),
});

export const Route = createFileRoute("/leads")({
  errorComponent: RouteError,
  validateSearch: zodValidator(searchSchema),
  component: () => (
    <ProtectedRoute>
      <LeadsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Leads — Aurixa Systems Mission Control" }] }),
});

function statusTone(status: LeadStatus): string {
  switch (status) {
    case "new":
      return "border-primary/40 text-primary";
    case "contacted":
      return "border-info/40 text-info";
    case "qualified":
      return "border-success/40 text-success";
    case "converted":
      return "border-accent/40 text-accent";
    case "disqualified":
      return "border-muted-foreground/40 text-muted-foreground";
  }
}

function classificationLabel(value: string | null): string {
  if (!value) return "—";
  return (
    CLASSIFICATION_LABELS[value] ?? LEGACY_CLASSIFICATION_LABELS[value] ?? value.replace(/_/g, " ")
  );
}

function volumeLabel(value: string | null): string {
  if (!value) return "—";
  return VOLUME_LABELS[value] ?? LEGACY_VOLUME_LABELS[value] ?? value.replace(/_/g, " ");
}

/** How far into the priority-access funnel this applicant has come. */
function stageOf(lead: Lead): number {
  const recorded = Number((lead as { stage?: number | null }).stage ?? 1);
  return Number.isFinite(recorded) ? Math.min(Math.max(recorded, 1), 3) : 1;
}

function stageTone(stage: number): string {
  if (stage >= 3) return "border-accent/40 text-accent";
  if (stage === 2) return "border-success/40 text-success";
  return "border-border text-muted-foreground";
}

type Stats = {
  total: number;
  last24h: number;
  last7d: number;
  untriaged: number;
  stageTwo: number;
  stageThree: number;
};

function LeadsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/leads" });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [stageEmails, setStageEmails] = useState<Map<string, StageEmailRow[]> | null>(null);

  type SearchState = typeof search;

  const updateFilter = useCallback(
    (patch: Partial<SearchState>) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, ...patch, page: 0 }),
        replace: true,
      });
    },
    [navigate],
  );
  const setPage = useCallback(
    (page: number) => {
      void navigate({
        search: (prev: SearchState) => ({ ...prev, page }),
        replace: true,
      });
    },
    [navigate],
  );

  const loadStats = useCallback(async () => {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [totalQ, dayQ, weekQ, newQ, stageTwoQ, stageThreeQ] = await Promise.all([
      supabase.from("waitlist_leads").select("id", { count: "exact", head: true }),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayAgo),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", weekAgo),
      supabase
        .from("waitlist_leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "new"),
      supabase.from("waitlist_leads").select("id", { count: "exact", head: true }).gte("stage", 2),
      supabase.from("waitlist_leads").select("id", { count: "exact", head: true }).gte("stage", 3),
    ]);
    setStats({
      total: totalQ.count ?? 0,
      last24h: dayQ.count ?? 0,
      last7d: weekQ.count ?? 0,
      untriaged: newQ.count ?? 0,
      stageTwo: stageTwoQ.count ?? 0,
      stageThree: stageThreeQ.count ?? 0,
    });
  }, []);

  /**
   * The stage-email send record for the leads on screen, in one read.
   *
   * A failure sets `null` rather than an empty map: the panel then says the
   * record could not be read instead of drawing a lead who was emailed as one
   * who was not.
   */
  const loadStageEmails = useCallback(async (ids: string[]) => {
    if (!ids.length) {
      setStageEmails(new Map());
      return;
    }
    const { data, error } = await supabase
      .from("lead_stage_emails")
      .select("*")
      .in("lead_id", ids)
      .order("stage", { ascending: true });
    if (error) {
      setStageEmails(null);
      return;
    }
    const byLead = new Map<string, StageEmailRow[]>();
    for (const row of data ?? []) {
      const list = byLead.get(row.lead_id);
      if (list) list.push(row);
      else byLead.set(row.lead_id, [row]);
    }
    setStageEmails(byLead);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    const from = search.page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
    let q = supabase
      .from("waitlist_leads")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);
    if (search.status !== "all") q = q.eq("status", search.status);
    if (search.classification !== "all") q = q.eq("entity_classification", search.classification);
    if (search.volume !== "all") q = q.eq("transaction_volume", search.volume);
    if (search.stage !== "all") q = q.eq("stage", Number(search.stage));
    if (search.q) {
      const term = search.q.replace(/[%_,()]/g, " ").trim();
      if (term) {
        q = q.or(
          // The application reference is what an operator has in front of them
          // when a client quotes it off an email, so it is searchable too.
          `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,entity_name.ilike.%${term}%,application_id.ilike.%${term}%`,
        );
      }
    }
    const { data, count } = await q;
    setLeads(data ?? []);
    setTotal(count ?? 0);
    void loadStageEmails((data ?? []).map((l) => l.id));
    setLoading(false);
    setLastUpdated(new Date());
    void loadStats();
  }, [
    search.status,
    search.classification,
    search.volume,
    search.stage,
    search.q,
    search.page,
    loadStats,
    loadStageEmails,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live tie-up: a new lead captured on the website appears here instantly.
  useEffect(() => {
    const channel = supabase
      .channel(`leads:page:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "waitlist_leads" },
        (payload) => {
          const lead = payload.new as Lead;
          toast.success(`New waitlist lead: ${lead.first_name} ${lead.last_name}`, {
            description: `${lead.entity_name ?? "Unknown entity"} · ${lead.email}`,
          });
          void refresh();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "waitlist_leads" },
        (payload) => {
          // Stage 2 and Stage 3 arrive as updates to an existing lead, not as
          // new rows — without this they would refresh the list in silence and
          // the operator would never know the applicant had moved.
          const before = stageOf(payload.old as Lead);
          const after = stageOf(payload.new as Lead);
          if (after > before) {
            const lead = payload.new as Lead;
            toast.success(
              after >= 3
                ? `Strategic review booked: ${lead.first_name} ${lead.last_name}`
                : `Readiness questionnaire complete: ${lead.first_name} ${lead.last_name}`,
              { description: `${lead.entity_name ?? lead.email} · ${STAGE_LABELS[after]}` },
            );
          }
          void refresh();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refresh]);

  const setStatus = async (lead: Lead, status: LeadStatus) => {
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, status } : l)));
    const { error } = await supabase.from("waitlist_leads").update({ status }).eq("id", lead.id);
    if (error) {
      toast.error("Failed to update lead status", { description: error.message });
      void refresh();
    } else {
      void loadStats();
    }
  };

  const exportCsv = async () => {
    let q = supabase
      .from("waitlist_leads")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5000);
    if (search.status !== "all") q = q.eq("status", search.status);
    if (search.classification !== "all") q = q.eq("entity_classification", search.classification);
    if (search.volume !== "all") q = q.eq("transaction_volume", search.volume);
    if (search.stage !== "all") q = q.eq("stage", Number(search.stage));
    const { data, error } = await q;
    if (error) {
      toast.error("Export failed", { description: error.message });
      return;
    }
    const header = [
      "application_id",
      "created_at",
      "submitted_at",
      "first_name",
      "last_name",
      "email",
      "mobile_number",
      "entity_name",
      "entity_classification",
      "transaction_volume",
      "role",
      "primary_areas",
      "status",
      "stage",
      "stage2_status",
      "stage2_completed_at",
      // The qualification signals. An export that carries the funnel position
      // but not what the applicant answered is the gap this page had.
      "stage2_next_step",
      "stage2_investment",
      "stage2_timeline",
      "stage2_authority",
      "stage2_user_count",
      "stage2_entity_structure",
      "stage2_admin_time",
      "stage2_migration",
      "stage2_regions",
      "stage2_systems",
      "stage2_problems",
      "stage2_capabilities",
      "stage2_integrations",
      "stage2_security",
      "stage2_difficult_workflow",
      "stage3_status",
      "stage3_booked_at",
      "stage3_session_start",
      "stage3_local_time",
      "stage3_host_local_time",
      "stage3_time_zone",
      "stage3_duration_minutes",
      "stage3_booking_reference",
      "stage3_notes",
      "marketing_consent",
      "source",
      "page",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "tech_stack_bottlenecks",
    ];
    const csv = [header.join(",")]
      .concat(
        (data ?? []).map((r) =>
          header
            .map((k) => `"${String((r as Record<string, unknown>)[k] ?? "").replace(/"/g, '""')}"`)
            .join(","),
        ),
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `waitlist-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const hasFilters =
    search.status !== "all" ||
    search.classification !== "all" ||
    search.volume !== "all" ||
    search.stage !== "all" ||
    search.q.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const clearFilters = () =>
    navigate({
      search: () => ({
        status: "all",
        classification: "all",
        volume: "all",
        stage: "all",
        q: "",
        page: 0,
      }),
      replace: true,
    });

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
            <UserPlus className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="label-mono">lead capture</p>
            <h1 className="mt-1 font-display text-[2.125rem] leading-[1.05]">Waitlist Leads</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every lead captured by the Aurixa Systems waitlist form — live, with full history.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
          <RefreshButton onRefresh={refresh} loading={loading} lastUpdated={lastUpdated} />
        </div>
      </header>

      <div className="glass grid grid-cols-2 overflow-hidden lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Total leads" value={stats?.total} />
        <StatTile label="Last 24 hours" value={stats?.last24h} accent />
        <StatTile label="Last 7 days" value={stats?.last7d} />
        <StatTile label="Awaiting triage" value={stats?.untriaged} />
        <StatTile label="Stage 2 complete" value={stats?.stageTwo} />
        <StatTile label="Stage 3 booked" value={stats?.stageThree} accent />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
          <Select
            value={search.stage}
            onValueChange={(v) => updateFilter({ stage: v as typeof search.stage })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STAGE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.status}
            onValueChange={(v) => updateFilter({ status: v as typeof search.status })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.classification}
            onValueChange={(v) => updateFilter({ classification: v })}
          >
            <SelectTrigger>
              <SelectValue placeholder="All segments" />
            </SelectTrigger>
            <SelectContent>
              {CLASSIFICATION_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v === "all" ? "All segments" : CLASSIFICATION_LABELS[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={search.volume} onValueChange={(v) => updateFilter({ volume: v })}>
            <SelectTrigger>
              <SelectValue placeholder="All volume brackets" />
            </SelectTrigger>
            <SelectContent>
              {VOLUME_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v === "all" ? "All volume brackets" : VOLUME_LABELS[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Input
              placeholder="Search name, email, entity…"
              value={search.q}
              onChange={(e) => updateFilter({ q: e.target.value })}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-7 -translate-y-1/2 px-2"
                onClick={clearFilters}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardDescription className="font-mono text-[11px] uppercase tracking-wider">
            {total.toLocaleString()} {total === 1 ? "lead" : "leads"}
            {total > 0 && (
              <span className="ml-2 text-muted-foreground/70">
                · page {search.page + 1} of {totalPages}
              </span>
            )}
          </CardDescription>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={search.page === 0 || loading}
              onClick={() => setPage(search.page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={search.page + 1 >= totalPages || loading}
              onClick={() => setPage(search.page + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-14 animate-pulse bg-muted/40" />
              ))}
            </div>
          ) : leads.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Inbox />}
                title="No leads yet"
                description={
                  hasFilters
                    ? "Nothing matches these filters. Try clearing them to see all captured leads."
                    : "Leads captured by the website waitlist form will appear here the moment they come in."
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  emails={
                    stageEmails === null
                      ? { kind: "unavailable" }
                      : { kind: "rows", rows: stageEmails.get(lead.id) ?? [] }
                  }
                  expanded={expandedId === lead.id}
                  onToggle={() => setExpandedId((cur) => (cur === lead.id ? null : lead.id))}
                  onStatusChange={(status) => void setStatus(lead, status)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | undefined;
  accent?: boolean;
}) {
  return (
    <MetricCell
      label={label}
      value={value === undefined ? "—" : value.toLocaleString()}
      tone="accent"
      alarm={Boolean(accent)}
    />
  );
}

function LeadRow({
  lead,
  emails,
  expanded,
  onToggle,
  onStatusChange,
}: {
  lead: Lead;
  emails: StageEmails;
  expanded: boolean;
  onToggle: () => void;
  onStatusChange: (status: LeadStatus) => void;
}) {
  const meta = (lead.metadata ?? {}) as Record<string, unknown>;
  const row = lead as Lead & Record<string, unknown>;
  const stage = stageOf(lead);
  const areas = Array.isArray(row.primary_areas) ? (row.primary_areas as string[]) : [];
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform",
              expanded && "rotate-180",
            )}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {lead.first_name} {lead.last_name}
              </span>
              <Badge variant="outline" className={cn("text-[10px] uppercase", stageTone(stage))}>
                {STAGE_LABELS[stage]}
              </Badge>
              {lead.entity_classification && (
                <Badge variant="outline" className="text-[10px] uppercase">
                  {classificationLabel(lead.entity_classification)}
                </Badge>
              )}
              {lead.transaction_volume && (
                <Badge
                  variant="outline"
                  className="border-accent/40 text-[10px] uppercase text-accent"
                >
                  {volumeLabel(lead.transaction_volume)}
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {lead.entity_name ?? "—"}
              </span>
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3 w-3" /> {lead.email}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider">
                {formatDistanceToNow(lead.created_at)}
              </span>
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className={cn("text-[10px] uppercase", statusTone(lead.status))}>
            {lead.status}
          </Badge>
          <ConvertLeadButton lead={lead} />
          <Select value={lead.status} onValueChange={(v) => onStatusChange(v as LeadStatus)}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.filter((o) => o.value !== "all").map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {expanded && (
        <div className="ml-6 mt-3 space-y-3 border bg-surface p-3">
          <div className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <DetailItem
              icon={Hash}
              label="Application"
              // The reference is what ties this lead to its questionnaire and
              // its booking, in Airtable and everywhere else.
              value={(row.application_id as string | null) ?? "not issued"}
            />
            <DetailItem icon={Phone} label="Mobile" value={lead.mobile_number ?? "—"} />
            <DetailItem
              icon={Briefcase}
              label="Role"
              value={((row.role as string | null) ?? "—").replace(/_/g, " ")}
            />
            <DetailItem
              icon={Globe}
              label="Source"
              value={`${lead.source}${lead.page ? ` · ${lead.page}` : ""}`}
            />
            <DetailItem
              icon={CalendarClock}
              label="Submitted"
              value={
                lead.submitted_at ? new Date(lead.submitted_at).toLocaleString() : "not reported"
              }
            />
            <DetailItem
              icon={Sparkles}
              label="Channel"
              value={typeof meta.channel === "string" ? meta.channel.replace(/_/g, " ") : "—"}
            />
            <DetailItem
              icon={Mail}
              label="Marketing consent"
              value={
                row.marketing_consent === null || row.marketing_consent === undefined
                  ? "not recorded"
                  : row.marketing_consent
                    ? "opted in"
                    : "declined"
              }
            />
            <DetailItem
              icon={RouteIcon}
              label="Campaign"
              value={
                [row.utm_source, row.utm_medium, row.utm_campaign].filter(Boolean).join(" / ") ||
                "direct"
              }
            />
          </div>

          <StageTimeline lead={row} stage={stage} />

          <QualificationSignals lead={row} />
          <QuestionnairePanel lead={row} />
          <ReviewPanel lead={row} />
          <DeliveryPanel lead={row} emails={emails} />

          {areas.length > 0 && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Priority areas to improve
              </div>
              <div className="flex flex-wrap gap-1.5">
                {areas.map((area) => (
                  <Badge key={area} variant="secondary" className="text-[10px]">
                    {area.replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {lead.tech_stack_bottlenecks && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Current tech stack bottlenecks
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground/90">
                {lead.tech_stack_bottlenecks}
              </p>
            </div>
          )}
          {typeof row.additional_notes === "string" && row.additional_notes && (
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Additional notes
              </div>
              <p className="whitespace-pre-wrap text-sm text-foreground/90">
                {row.additional_notes}
              </p>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const stamp = (value: unknown): string | null =>
  typeof value === "string" && value ? new Date(value).toLocaleString() : null;

/**
 * The applicant's path through the three stages of priority access.
 *
 * Stage 2 and Stage 3 are the difference between a name on a waitlist and
 * somebody with a review in the diary, so they get shown here rather than left
 * for an operator to go and look up in Airtable.
 */
function StageTimeline({ lead, stage }: { lead: Record<string, unknown>; stage: number }) {
  const steps = [
    {
      key: 1,
      label: "Stage 1 — priority access application",
      at: stamp(lead.submitted_at) ?? stamp(lead.created_at),
      detail: [lead.form_version].filter(Boolean).join(" · "),
    },
    {
      key: 2,
      label: "Stage 2 — business readiness questionnaire",
      at: stamp(lead.stage2_completed_at),
      detail: [
        lead.stage2_status,
        lead.stage2_next_step,
        lead.stage2_investment,
        lead.stage2_timeline,
      ]
        .filter(Boolean)
        .join(" · "),
    },
    {
      key: 3,
      label: "Stage 3 — strategic review",
      at: stamp(lead.stage3_booked_at),
      detail: [
        lead.stage3_status,
        stamp(lead.stage3_session_start) ? `session ${stamp(lead.stage3_session_start)}` : "",
        lead.stage3_time_zone,
      ]
        .filter(Boolean)
        .join(" · "),
    },
  ];

  return (
    <div>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Funnel progress
      </div>
      <ol className="space-y-1.5">
        {steps.map((step) => {
          const done = stage >= step.key && (step.key === 1 || Boolean(step.at || step.detail));
          return (
            <li key={step.key} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  done ? "bg-success" : "bg-muted-foreground/30",
                )}
              />
              <div className="min-w-0">
                <span className={done ? "text-foreground/90" : "text-muted-foreground"}>
                  {step.label}
                </span>
                {step.at && <span className="ml-2 text-muted-foreground">{step.at}</span>}
                {step.detail && (
                  <div className="truncate text-[11px] text-muted-foreground">{step.detail}</div>
                )}
                {!done && <div className="text-[11px] text-muted-foreground/70">not reached</div>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type Fact = { label: string; value: string | null | undefined };

/** A fact grid. A row the record has nothing for is omitted, never dashed. */
function Facts({ facts }: { facts: Fact[] }) {
  const shown = facts.filter((f) => f.value !== null && f.value !== undefined && f.value !== "");
  if (!shown.length) return null;
  return (
    <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
      {shown.map((f) => (
        <div key={f.label} className="flex items-baseline gap-2">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {f.label}
          </span>
          <span className="min-w-0 text-foreground/90">{f.value}</span>
        </div>
      ))}
    </div>
  );
}

function Panel({
  icon: Icon,
  heading,
  count,
  children,
}: {
  icon: typeof Phone;
  heading: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span>{heading}</span>
        {count && <span className="text-muted-foreground/60">· {count}</span>}
      </div>
      {children}
    </section>
  );
}

const asText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const asList = (v: unknown): string | null =>
  Array.isArray(v) && v.length ? v.map(String).filter(Boolean).join(", ") || null : null;

/**
 * What an operator decides on.
 *
 * These are columns rather than reads into `stage2_answers`, because they are
 * what the register is filtered and exported on — the Airtable mirror lifts
 * them out of the blob for exactly this. Nothing here is a verdict: every
 * value is the applicant's own answer, and a signal the record does not hold
 * is absent rather than assumed.
 */
function QualificationSignals({ lead }: { lead: Record<string, unknown> }) {
  const facts: Fact[] = [
    { label: "Approved investment", value: asText(lead.stage2_investment) },
    { label: "Preferred next step", value: asText(lead.stage2_next_step) },
    { label: "Implementation start", value: asText(lead.stage2_timeline) },
    { label: "Purchase authority", value: asText(lead.stage2_authority) },
    { label: "Users needing access", value: asText(lead.stage2_user_count) },
    { label: "Weekly admin time", value: asText(lead.stage2_admin_time) },
    { label: "Entity structure", value: asText(lead.stage2_entity_structure) },
    { label: "Data migration", value: asText(lead.stage2_migration) },
    { label: "Operating locations", value: asList(lead.stage2_regions) },
    { label: "Security & procurement", value: asList(lead.stage2_security) },
  ];
  if (!facts.some((f) => f.value)) return null;
  return (
    <Panel icon={Gauge} heading="Qualification signals">
      <Facts facts={facts} />
    </Panel>
  );
}

/**
 * The questionnaire itself, drawn from the same vocabulary the mirror writes
 * the summary with and the internal email renders — one list, so an applicant
 * cannot read one way in an inbox and another here.
 *
 * It sits behind a disclosure because the signals above are what a decision
 * turns on and this is the forty-answer transcript behind them.
 */
function QuestionnairePanel({ lead }: { lead: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const answers = (lead.stage2_answers ?? {}) as QuestionnaireAnswers;
  const sections: QuestionnaireSection[] = stage2Sections(answers);
  const answered = sections.reduce((n, section) => n + section.items.length, 0);

  if (!answered) {
    // Completed with nothing mirrored is a real state, and a page that draws
    // nothing cannot be told apart from one that failed to load.
    if (!lead.stage2_completed_at) return null;
    return (
      <Panel icon={ListChecks} heading="Business readiness questionnaire">
        <p className="text-xs text-muted-foreground">
          Completed, but no answers have reached this console yet — they arrive on the next Airtable
          sync.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      icon={ListChecks}
      heading="Business readiness questionnaire"
      count={`${answered} answered`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-accent underline-offset-2 hover:underline"
      >
        {open ? "Hide the answers" : "Show every answer"}
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          {sections.map((section) => (
            <div key={section.heading}>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-accent/70">
                {section.heading}
              </div>
              <Facts
                facts={section.items.map((item) => ({ label: item.label, value: item.text }))}
              />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** The booked session, in all three readings the record keeps rather than one. */
function ReviewPanel({ lead }: { lead: Record<string, unknown> }) {
  const minutes = lead.stage3_duration_minutes;
  const access = [asText(lead.stage3_access_state), asText(lead.stage3_access_denied_reason)]
    .filter(Boolean)
    .join(" — ");
  const facts: Fact[] = [
    { label: "Status", value: asText(lead.stage3_status) },
    { label: "Booked", value: stamp(lead.stage3_booked_at) },
    { label: "Session", value: stamp(lead.stage3_session_start) },
    { label: "Their local time", value: asText(lead.stage3_local_time) },
    { label: "Aurixa local time", value: asText(lead.stage3_host_local_time) },
    { label: "Their time zone", value: asText(lead.stage3_time_zone) },
    { label: "Duration", value: typeof minutes === "number" ? `${minutes} minutes` : null },
    { label: "Booking reference", value: asText(lead.stage3_booking_reference) },
    { label: "Access", value: access || null },
  ];
  const notes = asText(lead.stage3_notes);
  if (!facts.some((f) => f.value) && !notes) return null;
  return (
    <Panel icon={CalendarCheck} heading="Strategic review">
      <Facts facts={facts} />
      {notes && (
        <div className="mt-1.5">
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            What they want to cover
          </div>
          <p className="whitespace-pre-wrap text-sm text-foreground/90">{notes}</p>
        </div>
      )}
    </Panel>
  );
}

function sendTone(status: string): string {
  if (status === "sent") return "border-success/40 text-success";
  if (status === "failed" || status === "unconfirmed")
    return "border-destructive/40 text-destructive";
  if (status === "pending" || status === "claimed") return "border-warning/40 text-warning";
  return "text-muted-foreground";
}

/**
 * What this applicant has actually been sent, and what is still owed.
 *
 * The ledger's three readings are kept apart: rows, no rows, and could-not-be-read.
 * A lost signal must never render as "nobody was emailed" — the table arrives
 * with a migration, and a deployment it has not reached answers `PGRST205`.
 */
function DeliveryPanel({ lead, emails }: { lead: Record<string, unknown>; emails: StageEmails }) {
  const invite = (at: unknown, count: unknown): string | null => {
    const when = stamp(at);
    if (!when) return null;
    const n = typeof count === "number" && count > 1 ? ` · ${count} sends` : "";
    return `${when}${n}`;
  };
  const tokenExpiry = stamp(lead.questionnaire_token_expires_at);
  const facts: Fact[] = [
    { label: "Stage 1 receipt", value: asText(lead.stage1_email_message_id) ? "delivered" : null },
    {
      label: "Questionnaire invite",
      value: invite(lead.stage2_invite_sent_at, lead.stage2_invite_count),
    },
    {
      label: "Questionnaire link",
      value:
        [asText(lead.questionnaire_token_status), tokenExpiry && `expires ${tokenExpiry}`]
          .filter(Boolean)
          .join(" · ") || null,
    },
    { label: "Review invite", value: invite(lead.stage3_invite_sent_at, lead.stage3_invite_count) },
    { label: "Booking confirmation", value: stamp(lead.stage3_confirmation_sent_at) },
    { label: "Last mirrored", value: stamp(lead.enrichment_synced_at) },
  ];

  const rows = emails.kind === "rows" ? emails.rows : [];
  if (!facts.some((f) => f.value) && emails.kind === "rows" && !rows.length) return null;

  return (
    <Panel icon={Send} heading="Email record">
      <Facts facts={facts} />
      {emails.kind === "unavailable" ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          The stage-email record could not be read. This is not a statement that nothing was sent.
        </p>
      ) : rows.length ? (
        <ul className="mt-1.5 space-y-1">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-2 text-xs">
              <Badge
                variant="outline"
                className={cn("text-[10px] uppercase", sendTone(row.status))}
              >
                {row.status}
              </Badge>
              <span className="text-foreground/90">
                Stage {row.stage} · {row.audience}
              </span>
              {row.sent_at && <span className="text-muted-foreground">{stamp(row.sent_at)}</span>}
              {recipientReading(row) && (
                <span className="truncate text-muted-foreground">{recipientReading(row)}</span>
              )}
              {(row.reason || row.last_error) && (
                <span className="text-muted-foreground/80">{row.reason ?? row.last_error}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

function DetailItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="truncate text-foreground/90">{value}</span>
    </div>
  );
}

/**
 * Promotes a captured lead into the CRM: creates (or reuses) a client account
 * plus its primary contact, marks the lead converted, and drops the operator
 * straight into the new account hub. Idempotent — `crm_convert_lead` returns
 * the existing account if this lead was already promoted.
 */
function ConvertLeadButton({ lead }: { lead: Lead }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  if (lead.status === "disqualified") return null;

  return (
    <Button
      variant={lead.status === "converted" ? "ghost" : "outline"}
      size="sm"
      className="h-8 text-xs"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // `crm_convert_lead` takes `lead_id` and answers with `idempotent`
          // when the lead was already promoted. Sending `leadId` failed input
          // validation before the call ever reached the database.
          const res = await convertLead({ data: { lead_id: lead.id } });
          if (!res?.ok || !res.account_id) {
            throw new Error(res?.error ?? "conversion_failed");
          }
          toast.success(
            res.idempotent ? "Opening existing client account" : "Lead converted to client",
          );
          navigate({ to: "/crm/accounts/$accountId", params: { accountId: res.account_id } });
        } catch (err) {
          toast.error("Conversion failed", {
            description: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Briefcase className="mr-1 h-3 w-3" />
      {lead.status === "converted" ? "Open client" : "Convert"}
    </Button>
  );
}
