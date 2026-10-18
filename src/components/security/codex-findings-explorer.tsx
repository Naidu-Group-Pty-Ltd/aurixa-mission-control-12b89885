// The findings explorer on /security/scans: every finding Mission Control
// holds, filterable, with triage and each finding's own history.
//
// Until this existed a finding could only be seen inside the scan that first
// reported it, and nothing could dismiss one — so a known false positive sat
// in every open count, PR check and gate indefinitely.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Clock,
  ExternalLink,
  Filter,
  History,
  Search,
  ShieldQuestion,
  Ticket,
  UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  assignFindings,
  bulkTriageFindings,
  getFindingDetail,
  listAssignableUsers,
  listFindings,
  triageFinding,
} from "@/lib/codex-findings.functions";
import { linkExternalTicket } from "@/lib/security-intake.functions";
import { FINDING_SLA_DAYS, slaStatus } from "@/lib/codex-finding-sla";
import { SECRET_SCANNERS, STATE_MEANING, type TriageState } from "@/lib/codex-finding-lifecycle";
import { formatDistanceToNow } from "@/lib/format";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const SCANNERS = ["gitleaks", "gitleaks-history", "semgrep", "osv-scanner", "codex"] as const;

const sevBadge: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-slate-500 text-white",
};

/** What a state filter preset shows. */
const STATE_PRESETS: Record<string, { label: string; states: string[] }> = {
  active: { label: "Needs a decision", states: ["open", "triaging"] },
  in_flight: { label: "Fix in flight", states: ["fix_drafted", "pr_open", "fix_merged"] },
  decided: { label: "Dismissed / false positive", states: ["dismissed", "false_positive"] },
  resolved: { label: "Resolved", states: ["resolved"] },
  everything: {
    label: "Everything",
    states: [
      "open",
      "triaging",
      "fix_drafted",
      "pr_open",
      "fix_merged",
      "resolved",
      "dismissed",
      "false_positive",
    ],
  },
};

const TRIAGE_ACTIONS: { to: TriageState; label: string; needsReason: boolean }[] = [
  { to: "triaging", label: "Mark triaging", needsReason: false },
  { to: "dismissed", label: "Dismiss (accept risk)", needsReason: true },
  { to: "false_positive", label: "False positive", needsReason: true },
  { to: "resolved", label: "Mark resolved", needsReason: true },
  { to: "open", label: "Reopen", needsReason: false },
];

const PAGE = 50;

export type FindingsScope = "all" | "prime" | "fleet";

/** Response times in words, for the explorer's description. */
const SLA_LINE = (["critical", "high", "medium", "low"] as const)
  .map((s) => `${s} ${FINDING_SLA_DAYS[s]} days`)
  .join(", ");

/** Who may own findings, for the assign controls. */
function useAssignableUsers() {
  return useQuery({
    queryKey: ["codex-assignable-users"],
    queryFn: () => listAssignableUsers(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function AssignSelect({
  value,
  onChange,
  disabled,
  placeholder = "Assign to…",
}: {
  value: string | null;
  onChange: (assigneeId: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const usersQ = useAssignableUsers();
  const users: Array<{ id: string; name: string | null }> = usersQ.data?.users ?? [];
  return (
    <Select
      value={value ?? "__none"}
      disabled={disabled || usersQ.isLoading}
      onValueChange={(v) => onChange(v === "__none" ? null : v)}
    >
      <SelectTrigger className="h-7 w-[180px] text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__none">Nobody</SelectItem>
        {users.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name ?? u.id.slice(0, 8)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CodexFindingsExplorer({
  scope,
  onScopeChange,
  initialOverdue = false,
}: {
  scope: FindingsScope;
  onScopeChange: (s: FindingsScope) => void;
  /** Start with the overdue filter on — the daily digest links here. */
  initialOverdue?: boolean;
}) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState("active");
  const [severity, setSeverity] = useState<string>("any");
  const [scanner, setScanner] = useState<string>("any");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [includePrs, setIncludePrs] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openFinding, setOpenFinding] = useState<string | null>(null);
  const [bulkAction, setBulkAction] = useState<TriageState | null>(null);
  const [assignment, setAssignment] = useState<"any" | "me" | "unassigned">("any");
  const [overdue, setOverdue] = useState(initialOverdue);

  const filters = useMemo(
    () => ({
      scope,
      includePullRequests: includePrs,
      assignment,
      overdue,
      states: STATE_PRESETS[preset].states as any,
      severities: severity === "any" ? undefined : ([severity] as any),
      scanner: scanner === "any" ? undefined : scanner,
      search: appliedSearch || undefined,
      limit: PAGE,
      offset: page * PAGE,
    }),
    [scope, includePrs, assignment, overdue, preset, severity, scanner, appliedSearch, page],
  );

  const listQ = useQuery({
    queryKey: ["codex-findings", filters],
    queryFn: () => listFindings({ data: filters }),
    refetchInterval: 30_000,
  });
  const bulkFn = useServerFn(bulkTriageFindings);
  const assignFn = useServerFn(assignFindings);
  const bulkAssign = useMutation({
    mutationFn: (assigneeId: string | null) =>
      assignFn({ data: { findingIds: [...selected], assigneeId } }),
    onSuccess: (r: any) => {
      toast.success(`${r.updated} finding${r.updated === 1 ? "" : "s"} reassigned`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["codex-findings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const bulk = useMutation({
    mutationFn: (input: { state: TriageState; reason?: string }) =>
      bulkFn({ data: { findingIds: [...selected], state: input.state, reason: input.reason } }),
    onSuccess: (r: any) => {
      if (r.failed?.length) {
        toast.warning(
          `${r.updated} updated, ${r.failed.length} not: ${r.failed[0].error}${r.failed.length > 1 ? " …" : ""}`,
        );
      } else {
        toast.success(`${r.updated} finding${r.updated === 1 ? "" : "s"} updated`);
      }
      setSelected(new Set());
      setBulkAction(null);
      qc.invalidateQueries({ queryKey: ["codex-findings"] });
      qc.invalidateQueries({ queryKey: ["codex-prime-posture"] });
      qc.invalidateQueries({ queryKey: ["codex-fleet-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows: any[] = listQ.data?.findings ?? [];
  const total = listQ.data?.total ?? 0;
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));

  const resetPage = () => {
    setPage(0);
    setSelected(new Set());
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4" /> Findings
        </CardTitle>
        <CardDescription>
          One record per issue per repository, across every scan. Decide on a finding here — a
          dismissal or false positive needs a reason, and both stay on the finding&apos;s history.
          Response times: {SLA_LINE}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Where</Label>
            <Select
              value={scope}
              onValueChange={(v) => {
                onScopeChange(v as FindingsScope);
                resetPage();
              }}
            >
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Prime + fleet</SelectItem>
                <SelectItem value="prime">Prime</SelectItem>
                <SelectItem value="fleet">Clones</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select
              value={preset}
              onValueChange={(v) => {
                setPreset(v);
                resetPage();
              }}
            >
              <SelectTrigger className="h-8 w-[190px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STATE_PRESETS).map(([k, p]) => (
                  <SelectItem key={k} value={k}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Severity</Label>
            <Select
              value={severity}
              onValueChange={(v) => {
                setSeverity(v);
                resetPage();
              }}
            >
              <SelectTrigger className="h-8 w-[110px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Scanner</Label>
            <Select
              value={scanner}
              onValueChange={(v) => {
                setScanner(v);
                resetPage();
              }}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any</SelectItem>
                {SCANNERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <form
            className="flex items-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setAppliedSearch(search.trim());
              resetPage();
            }}
          >
            <div className="space-y-1">
              <Label className="text-xs">Search</Label>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="title, file or rule"
                className="h-8 w-[200px] text-xs"
              />
            </div>
            <Button type="submit" size="sm" variant="outline" className="h-8">
              <Search className="h-3 w-3" />
            </Button>
          </form>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={includePrs}
              onCheckedChange={(v) => {
                setIncludePrs(v);
                resetPage();
              }}
            />
            Include open pull requests
          </label>
          <div className="space-y-1">
            <Label className="text-xs">Owner</Label>
            <Select
              value={assignment}
              onValueChange={(v) => {
                setAssignment(v as "any" | "me" | "unassigned");
                resetPage();
              }}
            >
              <SelectTrigger className="h-8 w-[130px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Anyone</SelectItem>
                <SelectItem value="me">Mine</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={overdue}
              onCheckedChange={(v) => {
                setOverdue(v);
                resetPage();
              }}
            />
            Overdue only
          </label>
        </div>

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border bg-muted/30 p-2 text-xs">
            <Filter className="h-3 w-3" />
            {selected.size} selected
            {TRIAGE_ACTIONS.map((a) => (
              <Button
                key={a.to}
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={bulk.isPending}
                onClick={() => (a.needsReason ? setBulkAction(a.to) : bulk.mutate({ state: a.to }))}
              >
                {a.label}
              </Button>
            ))}
            <AssignSelect
              value={null}
              disabled={bulkAssign.isPending}
              onChange={(id) => bulkAssign.mutate(id)}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </Button>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allOnPage}
                  onCheckedChange={(v) => {
                    const next = new Set(selected);
                    for (const r of rows) {
                      if (v) next.add(r.id);
                      else next.delete(r.id);
                    }
                    setSelected(next);
                  }}
                  aria-label="Select page"
                />
              </TableHead>
              <TableHead>Finding</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Owner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f) => (
              <TableRow key={f.id} className="cursor-pointer" onClick={() => setOpenFinding(f.id)}>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selected.has(f.id)}
                    onCheckedChange={(v) => {
                      const next = new Set(selected);
                      if (v) next.add(f.id);
                      else next.delete(f.id);
                      setSelected(next);
                    }}
                    aria-label="Select finding"
                  />
                </TableCell>
                <TableCell className="max-w-[420px]">
                  <div className="flex items-center gap-2">
                    <Badge className={`${sevBadge[f.severity]} text-[10px]`}>{f.severity}</Badge>
                    <span className="truncate font-medium">{f.title}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {f.scanner ?? "intake"}
                    {f.affected_file
                      ? ` · ${f.affected_file}${f.affected_line ? `:${f.affected_line}` : ""}`
                      : ""}
                  </div>
                </TableCell>
                <TableCell className="text-xs">
                  {f.clone_id ? (f.clone_name ?? "clone") : "Prime"}
                  {f.pr_number ? (
                    <span className="text-muted-foreground"> · PR #{f.pr_number}</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className="text-[10px]"
                    title={STATE_MEANING[f.state as keyof typeof STATE_MEANING]}
                  >
                    {f.state.replace("_", " ")}
                  </Badge>
                  {f.absent_since && SECRET_SCANNERS.has(f.scanner) && f.state === "open" && (
                    <div className="mt-1 text-[10px] text-amber-500">
                      gone from the files — rotate it
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <AgeCell finding={f} />
                </TableCell>
                <TableCell className="text-xs">
                  {f.assigned_to ? (
                    <span className="inline-flex items-center gap-1">
                      <UserRound className="h-3 w-3" />
                      {f.assigned_to_name ?? "someone"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {f.tickets?.length > 0 && (
                    <div
                      className="mt-0.5 inline-flex items-center gap-1 text-muted-foreground"
                      title={f.tickets.map((t: any) => `${t.provider}: ${t.status}`).join(", ")}
                    >
                      <Ticket className="h-3 w-3" />
                      {f.tickets.length}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!listQ.isLoading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  Nothing matches these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {total === 0 ? "0" : `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}`} of{" "}
            {total}
            {listQ.data &&
              !listQ.data.lifecycle &&
              " · apply migration 20261018090000 for PR targets and triage history"}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={(page + 1) * PAGE >= total}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </CardContent>

      <ReasonDialog
        action={bulkAction}
        count={selected.size}
        pending={bulk.isPending}
        onCancel={() => setBulkAction(null)}
        onConfirm={(reason) => bulkAction && bulk.mutate({ state: bulkAction, reason })}
      />

      <Sheet open={!!openFinding} onOpenChange={(v) => !v && setOpenFinding(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          {openFinding && <FindingDetail findingId={openFinding} />}
        </SheetContent>
      </Sheet>
    </Card>
  );
}

/**
 * Where this finding is tracked outside Mission Control. A ticket's status is
 * shown, never applied: a ticket closed is not a finding fixed.
 */
function TicketsSection({ findingId, tickets }: { findingId: string; tickets: any[] }) {
  const qc = useQueryClient();
  const linkFn = useServerFn(linkExternalTicket);
  const [provider, setProvider] = useState("");
  const [externalId, setExternalId] = useState("");
  const [url, setUrl] = useState("");
  const link = useMutation({
    mutationFn: () =>
      linkFn({
        data: {
          findingId,
          sourceSlug: "manual",
          provider: provider.trim(),
          externalId: externalId.trim(),
          url: url.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Ticket linked");
      setProvider("");
      setExternalId("");
      setUrl("");
      qc.invalidateQueries({ queryKey: ["codex-finding-detail", findingId] });
      qc.invalidateQueries({ queryKey: ["codex-findings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const urlOk = !url.trim() || /^https?:\/\//i.test(url.trim());
  return (
    <div>
      <h3 className="mb-1 flex items-center gap-1 text-sm font-semibold">
        <Ticket className="h-3 w-3" /> Tickets
      </h3>
      {tickets.length > 0 ? (
        <div className="mb-2 space-y-1 text-xs">
          {tickets.map((t) => (
            <div key={t.id} className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {t.provider}
              </Badge>
              {t.url ? (
                <a
                  href={t.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-500 hover:underline"
                >
                  {t.external_id} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="font-mono">{t.external_id}</span>
              )}
              <span className="text-muted-foreground">{t.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">Not tracked anywhere else.</p>
      )}
      <form
        className="flex flex-wrap items-end gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          link.mutate();
        }}
      >
        <Input
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="jira, linear…"
          className="h-7 w-[100px] text-xs"
        />
        <Input
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="ticket id"
          className="h-7 w-[110px] text-xs"
        />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… (optional)"
          className="h-7 w-[200px] text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={!provider.trim() || !externalId.trim() || !urlOk || link.isPending}
        >
          Link ticket
        </Button>
      </form>
    </div>
  );
}

/** How long a finding has been open, against its severity's response time. */
function AgeCell({ finding }: { finding: any }) {
  const sla = slaStatus(finding);
  return (
    <span
      className={sla.overdue ? "font-medium text-red-500" : "text-muted-foreground"}
      title={
        sla.dueInDays == null
          ? `first seen ${formatDistanceToNow(finding.first_seen_at)}; no response time while ${finding.state.replace("_", " ")}`
          : sla.overdue
            ? `past its ${FINDING_SLA_DAYS[finding.severity as keyof typeof FINDING_SLA_DAYS]}-day response time`
            : `due in ${sla.dueInDays} day${sla.dueInDays === 1 ? "" : "s"}`
      }
    >
      <Clock className="mr-0.5 inline h-3 w-3" />
      {sla.ageDays}d{sla.overdue ? " · overdue" : ""}
    </span>
  );
}

function ReasonDialog({
  action,
  count,
  pending,
  onCancel,
  onConfirm,
}: {
  action: TriageState | null;
  count: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const label = TRIAGE_ACTIONS.find((a) => a.to === action)?.label ?? "";
  return (
    <Dialog open={!!action} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {label} — {count} finding{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            {action === "resolved"
              ? "Mark resolved only when the issue is really gone. A committed credential can only be resolved once it has been rotated — that is what this records for secrets."
              : "The reason is recorded on each finding's history and in the audit log, where the next reviewer will read it."}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why — e.g. “public anon key, safe by design” or “rotated 18 Oct, old key revoked”"
          className="min-h-[80px] text-sm"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={pending || reason.trim().length < 3}
            onClick={() => {
              onConfirm(reason.trim());
              setReason("");
            }}
          >
            {pending ? "Saving…" : label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingDetail({ findingId }: { findingId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["codex-finding-detail", findingId],
    queryFn: () => getFindingDetail({ data: { findingId } }),
  });
  const triageFn = useServerFn(triageFinding);
  const [action, setAction] = useState<TriageState | null>(null);
  const triage = useMutation({
    mutationFn: (input: { state: TriageState; reason?: string }) =>
      triageFn({ data: { findingId, state: input.state, reason: input.reason } }),
    onSuccess: () => {
      toast.success("Recorded");
      setAction(null);
      qc.invalidateQueries({ queryKey: ["codex-finding-detail", findingId] });
      qc.invalidateQueries({ queryKey: ["codex-findings"] });
      qc.invalidateQueries({ queryKey: ["codex-prime-posture"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const assignFn = useServerFn(assignFindings);
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) =>
      assignFn({ data: { findingIds: [findingId], assigneeId } }),
    onSuccess: () => {
      toast.success("Owner updated");
      qc.invalidateQueries({ queryKey: ["codex-finding-detail", findingId] });
      qc.invalidateQueries({ queryKey: ["codex-findings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d: any = q.data;
  if (!d) return <p className="text-muted-foreground">Loading…</p>;
  const f = d.finding;
  const isSecret = SECRET_SCANNERS.has(f.scanner);
  const sla = slaStatus(f);

  return (
    <div className="space-y-4">
      <SheetHeader>
        <SheetTitle className="flex items-start gap-2 text-left">
          <Badge className={`${sevBadge[f.severity]} mt-0.5`}>{f.severity}</Badge>
          <span>{f.title}</span>
        </SheetTitle>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <span className="text-muted-foreground">Where</span>
        <span>
          {f.clone_id ? (f.clone_name ?? f.clone_id) : "Prime"}
          {f.pr_number ? ` · pull request #${f.pr_number}` : ""}
        </span>
        <span className="text-muted-foreground">State</span>
        <span title={STATE_MEANING[f.state as keyof typeof STATE_MEANING]}>
          {f.state.replace("_", " ")}
          {f.resolution ? ` (${f.resolution.replace("_", " ")})` : ""}
        </span>
        <span className="text-muted-foreground">Scanner / rule</span>
        <span className="break-all font-mono">
          {f.scanner ?? "intake"}
          {f.rule_id ? ` · ${f.rule_id}` : ""}
        </span>
        {f.affected_file && (
          <>
            <span className="text-muted-foreground">Location</span>
            <span className="break-all font-mono">
              {f.affected_file}
              {f.affected_line ? `:${f.affected_line}` : ""}
            </span>
          </>
        )}
        {(f.cwe || f.cvss != null) && (
          <>
            <span className="text-muted-foreground">CWE / CVSS</span>
            <span>
              {f.cwe ?? "—"} / {f.cvss ?? "—"}
            </span>
          </>
        )}
        <span className="text-muted-foreground">First / last seen</span>
        <span>
          {formatDistanceToNow(f.first_seen_at)} / {formatDistanceToNow(f.last_seen_at)}
        </span>
        <span className="text-muted-foreground">Response time</span>
        <span className={sla.overdue ? "text-red-500" : undefined}>
          {sla.dueInDays == null
            ? "none — not waiting on a decision"
            : sla.overdue
              ? `overdue by ${-sla.dueInDays} day${sla.dueInDays === -1 ? "" : "s"}`
              : `due in ${sla.dueInDays} day${sla.dueInDays === 1 ? "" : "s"}`}
        </span>
        <span className="text-muted-foreground">Owner</span>
        <span>
          {"assigned_to" in f ? (
            <AssignSelect
              value={f.assigned_to ?? null}
              disabled={assign.isPending}
              onChange={(id) => assign.mutate(id)}
            />
          ) : (
            <span className="text-muted-foreground">needs migration 20261018110000</span>
          )}
        </span>
        {f.missed_scans > 0 && (
          <>
            <span className="text-muted-foreground">Missing from</span>
            <span>
              the last {f.missed_scans} complete scan{f.missed_scans === 1 ? "" : "s"}
              {f.absent_since ? ` (since ${formatDistanceToNow(f.absent_since)})` : ""}
            </span>
          </>
        )}
        {f.triage_reason && (
          <>
            <span className="text-muted-foreground">Decision</span>
            <span>
              “{f.triage_reason}”{d.triagedByName ? ` — ${d.triagedByName}` : ""}
            </span>
          </>
        )}
      </div>

      {isSecret && f.state === "open" && (
        <p className="border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
          A committed credential stays exposed in the repository&apos;s history even after it is
          deleted from the files. Rotate it, then mark it resolved — Mission Control never resolves
          a secret on its own.
        </p>
      )}

      {f.description && <p className="whitespace-pre-wrap text-xs">{f.description}</p>}
      {f.snippet && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border bg-muted/30 p-2 font-mono text-[11px]">
          {f.snippet}
        </pre>
      )}

      <div className="flex flex-wrap gap-1">
        {TRIAGE_ACTIONS.filter((a) => a.to !== f.state).map((a) => (
          <Button
            key={a.to}
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={triage.isPending}
            onClick={() => (a.needsReason ? setAction(a.to) : triage.mutate({ state: a.to }))}
          >
            {a.label}
          </Button>
        ))}
      </div>

      <TicketsSection findingId={findingId} tickets={d.tickets ?? []} />

      {d.remediations.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Fix attempts</h3>
          <div className="space-y-1 text-xs">
            {d.remediations.map((r: any) => (
              <div key={r.id} className="flex flex-wrap items-center gap-2 border p-2">
                <Badge variant="outline" className="text-[10px]">
                  {r.status}
                </Badge>
                {r.pr_url && (
                  <a
                    href={r.pr_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-blue-500 hover:underline"
                  >
                    PR #{r.pr_number} <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {r.fix_confirmed_at && (
                  <Badge className="bg-blue-600 text-[10px]">confirmed by re-scan</Badge>
                )}
                <span className="text-muted-foreground">{formatDistanceToNow(r.created_at)}</span>
                {r.last_error && <span className="text-red-500">{r.last_error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-1 flex items-center gap-1 text-sm font-semibold">
          <History className="h-3 w-3" /> History
        </h3>
        {d.events.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recorded history yet.</p>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto text-xs">
            {d.events.map((e: any) => (
              <div key={e.id} className="flex gap-2">
                <span className="shrink-0 font-mono text-muted-foreground">
                  {e.created_at.slice(0, 16).replace("T", " ")}
                </span>
                <span>
                  {e.event_type.replace(/[._]/g, " ")}
                  {e.from_state && e.to_state && e.from_state !== e.to_state
                    ? ` · ${e.from_state} → ${e.to_state}`
                    : ""}
                  {e.actor_name ? ` · ${e.actor_name}` : ""}
                  {e.reason ? <span className="text-muted-foreground"> — {e.reason}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {d.observations.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-semibold">Seen by</h3>
          <div className="space-y-0.5 text-xs">
            {d.observations.map((o: any) => (
              <div key={o.job_id} className="flex gap-2">
                <span className="font-mono text-muted-foreground">
                  {o.observed_at.slice(0, 16).replace("T", " ")}
                </span>
                <span>{o.job?.kind ?? "scan"}</span>
                {o.job?.workflow_run_url && (
                  <a
                    href={o.job.workflow_run_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
                  >
                    run <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ReasonDialog
        action={action}
        count={1}
        pending={triage.isPending}
        onCancel={() => setAction(null)}
        onConfirm={(reason) => action && triage.mutate({ state: action, reason })}
      />
    </div>
  );
}
