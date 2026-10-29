// /email/lead-emails — the three emails a free trial applicant receives, and
// who sends them (docs/LEAD_EMAILS.md).
//
// Each stage's email is edited here, section by section, against a live
// preview drawn by the same code the dispatcher sends with. Every stage starts
// on Make; handing one to Mission Control is an admin act, taken after the
// matching email modules are removed from Make, so an applicant is never sent the
// same email twice.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  Mail,
  Monitor,
  Plus,
  RotateCcw,
  Save,
  Send,
  Smartphone,
  Trash2,
  Undo2,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { PageHeaderSkeleton } from "@/components/route-loading";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import { RefreshButton } from "@/components/refresh-button";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import { MailboxPicker } from "@/components/email/mailbox-picker";
import { TenantSelect } from "@/components/email/tenant-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/auth";
import { useUserRoles } from "@/lib/use-user-roles";
import { cn } from "@/lib/utils";
import {
  LEAD_STAGES,
  LIMITS,
  MAKE_EMAIL_MODULE,
  STAGE_NAMES,
  STAGE_PURPOSE,
  mergeFieldsFor,
  renderLeadEmail,
  sampleContext,
  templateProblems,
  templatesEqual,
  templateWarnings,
  type EmailFact,
  type EmailStep,
  type LeadEmailSender,
  type LeadEmailTemplate,
  type LeadStage,
} from "@/lib/leadEmailTemplates.pure";
import {
  getLeadEmailsFn,
  listPreviewLeadsFn,
  previewLeadEmailFn,
  resetLeadEmailTemplateFn,
  saveLeadEmailSettingsFn,
  saveLeadEmailTemplateFn,
  sendLeadEmailTestFn,
  setLeadEmailSenderFn,
} from "@/server/lead-emails.functions";

export const Route = createFileRoute("/email/lead-emails")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <LeadEmailsPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Lead emails — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "The three emails a free trial applicant receives — application received, questionnaire received, review confirmed — edited here and sent by Mission Control.",
      },
    ],
  }),
});

const QUERY_KEY = ["email", "lead-emails"] as const;

type Overview = Awaited<ReturnType<typeof getLeadEmailsFn>>;
type TemplateRecord = Overview["templates"][number];

function LeadEmailsPage() {
  const qc = useQueryClient();
  const roles = useUserRoles();
  const confirm = useConfirm();
  const overview = useQuery({ queryKey: QUERY_KEY, queryFn: () => getLeadEmailsFn() });
  const [stage, setStage] = useState<LeadStage>(1);
  // A draft exists only for a stage that has been edited and not yet saved.
  const [drafts, setDrafts] = useState<Partial<Record<LeadStage, LeadEmailTemplate>>>({});

  const records = overview.data?.templates ?? [];
  const recordFor = (s: LeadStage) => records.find((record) => record.stage === s);
  const dirtyStages = LEAD_STAGES.filter((s) => {
    const draft = drafts[s];
    const record = recordFor(s);
    return draft && record && !templatesEqual(draft, record.template);
  });
  const dirtyRef = useRef(false);
  dirtyRef.current = dirtyStages.length > 0;

  useBlocker({
    shouldBlockFn: async () => {
      if (!dirtyRef.current) return false;
      const leave = await confirm({
        title: "Leave without saving?",
        description: "A lead email has changes that have not been saved.",
        confirmText: "Discard changes",
        cancelText: "Keep editing",
        destructive: true,
      });
      return !leave;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  if (overview.isPending || roles.loading) {
    return (
      <div className="space-y-6 p-6">
        <PageHeaderSkeleton />
        <CardRowSkeleton />
        <CardRowSkeleton />
      </div>
    );
  }
  if (overview.error) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="The lead emails could not be loaded"
          description={(overview.error as Error).message}
          action={
            <Button variant="outline" onClick={() => void overview.refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    );
  }

  const data = overview.data;
  const canEdit = roles.isAdmin && !data.schemaPending;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow={<BackLink />}
        title="Lead emails"
        description="The three emails a free trial applicant receives. Edit the copy here and Mission Control sends it, through the same Microsoft Graph sender as campaigns and past the same do-not-send register. Each stage moves off Make on its own, once its email modules are removed from Make."
        actions={
          <RefreshButton
            onRefresh={() => qc.invalidateQueries({ queryKey: QUERY_KEY })}
            loading={overview.isFetching}
            lastUpdated={overview.dataUpdatedAt ? new Date(overview.dataUpdatedAt) : null}
          />
        }
      />

      {data.schemaPending && (
        <div className="glass spine spine-warn p-4 text-sm text-muted-foreground">
          The database does not have the lead email tables yet — the migration that adds them has
          not applied. The copy below is the default; nothing can be saved until it applies.
        </div>
      )}
      {data.error && (
        <div className="glass spine spine-bad p-4 text-sm text-muted-foreground">{data.error}</div>
      )}
      {!roles.isAdmin && (
        <div className="glass spine spine-idle p-4 text-sm text-muted-foreground">
          Only an administrator can change these emails or who sends them: every applicant receives
          them. You can read the copy, preview it and see what was sent.
        </div>
      )}
      <DeploymentNotices
        applicantMode={data.applicantMode}
        applicantStages={data.applicantStages as LeadStage[]}
      />

      <StageStrip
        senders={data.settings?.senders ?? null}
        records={records}
        dirty={dirtyStages}
        onPick={setStage}
      />

      <IdentityPanel
        key={data.settings?.updatedAt ?? "unsaved"}
        overview={data}
        canEdit={canEdit}
      />

      <Tabs value={String(stage)} onValueChange={(value) => setStage(Number(value) as LeadStage)}>
        <TabsList>
          {LEAD_STAGES.map((s) => (
            <TabsTrigger key={s} value={String(s)}>
              {s}. {STAGE_NAMES[s]}
              {dirtyStages.includes(s) ? " •" : ""}
            </TabsTrigger>
          ))}
        </TabsList>
        {LEAD_STAGES.map((s) => {
          const record = recordFor(s);
          if (!record) return null;
          return (
            <TabsContent key={s} value={String(s)} className="space-y-6">
              <SenderPanel
                stage={s}
                sender={data.settings?.senders[s] ?? "make"}
                canEdit={canEdit}
                identityOk={data.identity?.ok ?? false}
              />
              <StageEditor
                stage={s}
                record={record}
                draft={drafts[s] ?? record.template}
                onDraft={(next) => setDrafts((current) => ({ ...current, [s]: next }))}
                onSettled={() =>
                  setDrafts((current) => {
                    const next = { ...current };
                    delete next[s];
                    return next;
                  })
                }
                canEdit={canEdit}
                overview={data}
              />
            </TabsContent>
          );
        })}
      </Tabs>

      <RecentSends rows={data.recent} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/email" className="inline-flex items-center gap-1 hover:underline">
      <ArrowLeft className="h-3 w-3" /> email campaigns
    </Link>
  );
}

// ── What the deployment overrides ───────────────────────────────────────────

function DeploymentNotices({
  applicantMode,
  applicantStages,
}: {
  applicantMode: string;
  applicantStages: LeadStage[];
}) {
  const off = LEAD_STAGES.filter((s) => !applicantStages.includes(s));
  if (applicantMode !== "off" && off.length === 0) return null;
  return (
    <div className="glass spine spine-warn p-4 text-sm text-muted-foreground">
      {applicantMode === "off" ? (
        <>
          <code>LEAD_STAGE_APPLICANT_MODE=off</code> is set on this deployment, so Mission Control
          sends no applicant email whatever is chosen below. Remove it before handing a stage over.
        </>
      ) : (
        <>
          <code>LEAD_STAGE_APPLICANT_STAGES</code> leaves out stage {off.join(" and ")} on this
          deployment, so Mission Control sends no applicant email for{" "}
          {off.length === 1 ? "it" : "them"} whatever is chosen below.
        </>
      )}
    </div>
  );
}

function StageStrip({
  senders,
  records,
  dirty,
  onPick,
}: {
  senders: Record<LeadStage, LeadEmailSender> | null;
  records: TemplateRecord[];
  dirty: LeadStage[];
  onPick: (stage: LeadStage) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {LEAD_STAGES.map((s) => {
        const record = records.find((r) => r.stage === s);
        const owned = senders?.[s] === "mission_control";
        const problems = record?.problems.length ?? 0;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className={cn(
              "glass spine p-4 text-left transition-colors hover:bg-foreground/5",
              problems ? "spine-bad" : owned ? "spine-ok" : "spine-idle",
            )}
          >
            <p className="label-mono">stage {s}</p>
            <p className="mt-1 font-medium">{STAGE_NAMES[s]}</p>
            <p className="mt-2 flex flex-wrap gap-1.5">
              <Badge
                variant="outline"
                className={cn("font-mono text-[10px]", owned && "text-success")}
              >
                {owned ? "Mission Control sends" : "Make sends"}
              </Badge>
              <Badge variant="outline" className="font-mono text-[10px]">
                {record?.isDefault ? "default copy" : "edited"}
              </Badge>
              {dirty.includes(s) && (
                <Badge variant="outline" className="font-mono text-[10px] text-warning">
                  unsaved
                </Badge>
              )}
              {problems > 0 && (
                <Badge variant="outline" className="font-mono text-[10px] text-destructive">
                  {problems} to fix
                </Badge>
              )}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// ── Sending identity ────────────────────────────────────────────────────────

function IdentityPanel({ overview, canEdit }: { overview: Overview; canEdit: boolean }) {
  const qc = useQueryClient();
  const settings = overview.settings;
  const [tenantId, setTenantId] = useState<string | null>(settings?.tenantId ?? null);
  const [tenantLabel, setTenantLabel] = useState<string | undefined>(undefined);
  const [fromMailbox, setFromMailbox] = useState(settings?.fromMailbox ?? "");
  const [fromName, setFromName] = useState(settings?.fromName ?? "");
  const [replyTo, setReplyTo] = useState(settings?.replyTo ?? "");

  const dirty =
    (settings?.tenantId ?? null) !== tenantId ||
    (settings?.fromMailbox ?? "") !== fromMailbox ||
    (settings?.fromName ?? "") !== fromName ||
    (settings?.replyTo ?? "") !== replyTo;

  const save = useMutation({
    mutationFn: () =>
      saveLeadEmailSettingsFn({
        data: {
          tenantId,
          fromMailbox: fromMailbox.trim() || null,
          fromName: fromName.trim() || null,
          replyTo: replyTo.trim() || null,
        },
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error("The sending identity was not saved", { description: result.error });
        return;
      }
      toast.success("Sending identity saved");
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const identity = overview.identity;
  return (
    <div className="glass space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-mono">sent as</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The tenant and mailbox every applicant email sends from, for all three stages, and where
            a reply goes. The team's own notification sends from it too and, while no{" "}
            <code>LEAD_STAGE_INTERNAL_RECIPIENTS</code> list is set, goes to it. A blank mailbox is
            the tenant's default — for the deployment's own tenant,{" "}
            {overview.envMailbox ? <code>{overview.envMailbox}</code> : "none is set"}.
          </p>
        </div>
        {identity &&
          (identity.ok ? (
            <Badge variant="outline" className="font-mono text-[10px] text-success">
              sends from {identity.mailbox}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-mono text-[10px] text-destructive">
              cannot send: {identity.error}
            </Badge>
          ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="lead-tenant">Microsoft tenant</Label>
          <TenantSelect
            id="lead-tenant"
            value={tenantId}
            disabled={!canEdit}
            disabledReason="Only an administrator can change who the applicant emails send as."
            onChange={(next, label) => {
              if (next === tenantId) return;
              setTenantId(next);
              setTenantLabel(label);
              // A mailbox belongs to one tenant: start from the new one's default.
              setFromMailbox("");
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lead-mailbox">Send from</Label>
          <MailboxPicker
            id="lead-mailbox"
            value={fromMailbox}
            onChange={setFromMailbox}
            tenantId={tenantId}
            tenantLabel={tenantLabel}
            disabled={!canEdit}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lead-from-name">Sender name</Label>
          <Input
            id="lead-from-name"
            value={fromName}
            maxLength={80}
            disabled={!canEdit}
            onChange={(event) => setFromName(event.target.value)}
            placeholder="Aurixa Systems"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lead-reply-to">Reply to</Label>
          <Input
            id="lead-reply-to"
            value={replyTo}
            maxLength={254}
            disabled={!canEdit}
            onChange={(event) => setReplyTo(event.target.value)}
            placeholder="admin@aurixasystems.com.au"
          />
          <p className="font-mono text-[10px] text-muted-foreground">
            Also what <code>{"{{support_email}}"}</code> says in the emails.
          </p>
        </div>
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            <Save className="mr-2 h-4 w-4" /> Save sending identity
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Who sends a stage ───────────────────────────────────────────────────────

function SenderPanel({
  stage,
  sender,
  canEdit,
  identityOk,
}: {
  stage: LeadStage;
  sender: LeadEmailSender;
  canEdit: boolean;
  identityOk: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [makeOff, setMakeOff] = useState(false);
  const make = MAKE_EMAIL_MODULE[stage];
  const owned = sender === "mission_control";

  const change = useMutation({
    mutationFn: (next: LeadEmailSender) =>
      setLeadEmailSenderFn({
        data: { stage, sender: next, makeOff: next === "mission_control" && makeOff },
      }),
    onSuccess: (result, next) => {
      if (!result.ok) {
        toast.error("Nothing changed", { description: result.error });
        return;
      }
      toast.success(
        next === "mission_control"
          ? `Mission Control now sends the stage ${stage} email`
          : `Make sends the stage ${stage} email again`,
      );
      setOpen(false);
      setMakeOff(false);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const handBack = async () => {
    const ok = await confirm({
      title: `Hand stage ${stage} back to Make?`,
      description: `Put modules ${make.modules} back in Make scenario ${make.scenarioId} (${make.scenario}) straight after this — the scenario's version history restores the version before they were deleted. Until you do, Mission Control only backstops this email, so an applicant may receive it late or — for a stage Make leaves no receipt for — not at all.`,
      confirmText: "Hand back to Make",
    });
    if (ok) change.mutate("make");
  };

  return (
    <div className={cn("glass spine p-5", owned ? "spine-ok" : "spine-idle")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl space-y-1">
          <p className="label-mono">who sends it</p>
          <p className="text-sm">{STAGE_PURPOSE[stage]}</p>
          <p className="text-sm text-muted-foreground">
            {owned ? (
              <>
                <strong className="text-foreground">Mission Control sends this email</strong>,
                within a minute of the stage landing, in the copy below.
              </>
            ) : (
              <>
                <strong className="text-foreground">Make sends this email</strong> — scenario{" "}
                {make.scenarioId} ({make.scenario}), modules {make.modules} — in the copy held in
                Make, not the copy below. Mission Control only stands by as a backstop, using this
                copy, when Make has not sent it.
              </>
            )}
          </p>
        </div>
        {canEdit &&
          (owned ? (
            <Button variant="outline" onClick={() => void handBack()} disabled={change.isPending}>
              <ArrowRightLeft className="mr-2 h-4 w-4" /> Hand back to Make
            </Button>
          ) : (
            <Dialog
              open={open}
              onOpenChange={(next) => {
                setOpen(next);
                if (!next) setMakeOff(false);
              }}
            >
              <DialogTrigger asChild>
                <Button>
                  <ArrowRightLeft className="mr-2 h-4 w-4" /> Send it from Mission Control
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Send stage {stage} from Mission Control</DialogTitle>
                  <DialogDescription>
                    Make keeps sending this email until its email modules are gone. Remove them
                    first, or every applicant receives it twice.
                  </DialogDescription>
                </DialogHeader>
                <ol className="list-decimal space-y-2 pl-5 text-sm">
                  <li>
                    In Make, open scenario <strong>{make.scenarioId}</strong> ({make.scenario}).
                  </li>
                  {make.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                  <li>
                    Save the scenario and leave it on. Then confirm below: Mission Control sends the
                    next applicant's email.
                  </li>
                </ol>
                {!identityOk && (
                  <p className="text-sm text-destructive">
                    The sending identity above cannot send yet. Fix it first, or the emails wait
                    until it can.
                  </p>
                )}
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={makeOff}
                    onCheckedChange={(value) => setMakeOff(value === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I have deleted modules {make.modules} from Make scenario {make.scenarioId}.
                  </span>
                </label>
                <DialogFooter>
                  <Button
                    onClick={() => change.mutate("mission_control")}
                    disabled={!makeOff || change.isPending}
                  >
                    Send it from Mission Control
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ))}
      </div>
    </div>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

type Path = (string | number)[];

function getAt(value: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
    value,
  );
}

function setAt<T>(value: T, path: Path, next: unknown): T {
  if (path.length === 0) return next as T;
  const [head, ...rest] = path;
  const copy = (Array.isArray(value) ? [...value] : { ...(value as object) }) as Record<
    string | number,
    unknown
  >;
  copy[head] = setAt(copy[head], rest, next);
  return copy as T;
}

/** The field a merge chip writes into: the last one the cursor was in. */
type FocusTarget = {
  el: HTMLInputElement | HTMLTextAreaElement;
  apply: (value: string) => void;
};
const FocusContext = createContext<{ current: FocusTarget | null } | null>(null);

function StageEditor({
  stage,
  record,
  draft,
  onDraft,
  onSettled,
  canEdit,
  overview,
}: {
  stage: LeadStage;
  record: TemplateRecord;
  draft: LeadEmailTemplate;
  onDraft: (next: LeadEmailTemplate) => void;
  onSettled: () => void;
  canEdit: boolean;
  overview: Overview;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const focus = useRef<FocusTarget | null>(null);
  const dirty = !templatesEqual(draft, record.template);
  const problems = useMemo(() => templateProblems(stage, draft), [stage, draft]);
  const warnings = useMemo(() => templateWarnings(stage, draft), [stage, draft]);

  const field = (path: Path) => ({
    value: String(getAt(draft, path) ?? ""),
    onChange: (value: string) => onDraft(setAt(draft, path, value)),
  });
  const flag = (path: Path) => ({
    checked: Boolean(getAt(draft, path)),
    onCheckedChange: (value: boolean) => onDraft(setAt(draft, path, value)),
  });

  const save = useMutation({
    mutationFn: () => saveLeadEmailTemplateFn({ data: { stage, template: draft } }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.error, {
          description:
            "problems" in result && result.problems ? result.problems.join(" · ") : undefined,
        });
        return;
      }
      toast.success(`Stage ${stage} email saved`, {
        description: "It is the copy the next applicant receives.",
      });
      onSettled();
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reset = useMutation({
    mutationFn: () => resetLeadEmailTemplateFn({ data: { stage } }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error("Nothing changed", { description: result.error });
        return;
      }
      toast.success(`Stage ${stage} is back on the default copy`);
      onSettled();
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const resetToDefault = async () => {
    const ok = await confirm({
      title: `Put stage ${stage} back on the default copy?`,
      description:
        "Every edit saved for this email is removed, and it sends as Mission Control ships it — including any later improvement to the default.",
      confirmText: "Reset to default",
      destructive: true,
    });
    if (ok) reset.mutate();
  };

  const c = draft.content;
  return (
    <FocusContext.Provider value={focus}>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <MergeFields stage={stage} />

          <Section title="Subject and inbox">
            <TextField
              id={`s${stage}-subject`}
              label="Subject"
              max={LIMITS.subject}
              disabled={!canEdit}
              {...field(["subject"])}
            />
            <TextField
              id={`s${stage}-preheader`}
              label="Inbox preview line"
              hint="The line most inboxes show after the subject. Hidden in the email itself."
              max={LIMITS.short}
              disabled={!canEdit}
              {...field(["content", "preheader"])}
            />
          </Section>

          <Section title="Header">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`s${stage}-badge`}
                label="Badge"
                max={LIMITS.short}
                disabled={!canEdit}
                {...field(["content", "badge"])}
              />
              <TextField
                id={`s${stage}-eyebrow`}
                label="Eyebrow"
                max={LIMITS.short}
                disabled={!canEdit}
                {...field(["content", "eyebrow"])}
              />
            </div>
            <TextField
              id={`s${stage}-heading`}
              label="Heading"
              max={LIMITS.short}
              disabled={!canEdit}
              {...field(["content", "heading"])}
            />
            <TextField
              id={`s${stage}-intro`}
              label="Introduction"
              multiline
              rows={3}
              max={LIMITS.text}
              disabled={!canEdit}
              {...field(["content", "intro"])}
            />
          </Section>

          <Section title="Message">
            <TextField
              id={`s${stage}-greeting`}
              label="Greeting"
              max={LIMITS.short}
              disabled={!canEdit}
              {...field(["content", "greeting"])}
            />
            <TextField
              id={`s${stage}-paragraphs`}
              label="Paragraphs"
              hint="A blank line starts a new paragraph. **Two asterisks** make text bold."
              multiline
              rows={8}
              max={LIMITS.paragraphs}
              disabled={!canEdit}
              {...field(["content", "paragraphs"])}
            />
          </Section>

          <Section
            title="Next step card"
            toggle={{ disabled: !canEdit, ...flag(["content", "card", "enabled"]) }}
          >
            {c.card.enabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-[6rem_minmax(0,1fr)]">
                  <TextField
                    id={`s${stage}-card-index`}
                    label="Number"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "card", "index"])}
                  />
                  <TextField
                    id={`s${stage}-card-label`}
                    label="Label"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "card", "label"])}
                  />
                </div>
                <TextField
                  id={`s${stage}-card-title`}
                  label="Title"
                  max={LIMITS.short}
                  disabled={!canEdit}
                  {...field(["content", "card", "title"])}
                />
                <TextField
                  id={`s${stage}-card-text`}
                  label="Text"
                  multiline
                  rows={3}
                  max={LIMITS.text}
                  disabled={!canEdit}
                  {...field(["content", "card", "text"])}
                />
                <PairList
                  idPrefix={`s${stage}-card-fact`}
                  label="Facts"
                  items={c.card.facts}
                  max={LIMITS.facts}
                  disabled={!canEdit}
                  onChange={(items) => onDraft(setAt(draft, ["content", "card", "facts"], items))}
                />
              </>
            )}
          </Section>

          <Section title="Main button">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`s${stage}-primary-label`}
                label="Label"
                max={LIMITS.short}
                disabled={!canEdit}
                {...field(["content", "primaryButton", "label"])}
              />
              <TextField
                id={`s${stage}-primary-url`}
                label="Link"
                hint="https://, mailto: or a link merge field. Empty leaves the button out."
                max={LIMITS.url}
                disabled={!canEdit}
                {...field(["content", "primaryButton", "url"])}
              />
            </div>
          </Section>

          <Section
            title="Security note"
            toggle={{ disabled: !canEdit, ...flag(["content", "securityNote", "enabled"]) }}
          >
            {c.securityNote.enabled && (
              <>
                <TextField
                  id={`s${stage}-note-tagline`}
                  label="Tagline"
                  max={LIMITS.short}
                  disabled={!canEdit}
                  {...field(["content", "securityNote", "tagline"])}
                />
                <TextField
                  id={`s${stage}-note-text`}
                  label="Text"
                  multiline
                  rows={3}
                  max={LIMITS.text}
                  disabled={!canEdit}
                  {...field(["content", "securityNote", "text"])}
                />
                <TextField
                  id={`s${stage}-note-prompt`}
                  label="Fallback prompt"
                  max={LIMITS.short}
                  disabled={!canEdit}
                  {...field(["content", "securityNote", "fallbackPrompt"])}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`s${stage}-note-label`}
                    label="Fallback link text"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "securityNote", "fallbackLabel"])}
                  />
                  <TextField
                    id={`s${stage}-note-url`}
                    label="Fallback link"
                    max={LIMITS.url}
                    disabled={!canEdit}
                    {...field(["content", "securityNote", "fallbackUrl"])}
                  />
                </div>
              </>
            )}
          </Section>

          <Section
            title="Details"
            toggle={{ disabled: !canEdit, ...flag(["content", "details", "enabled"]) }}
          >
            {c.details.enabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`s${stage}-details-label`}
                    label="Label"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "details", "label"])}
                  />
                  <TextField
                    id={`s${stage}-details-title`}
                    label="Title"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "details", "title"])}
                  />
                </div>
                <PairList
                  idPrefix={`s${stage}-details-row`}
                  label="Rows"
                  hint="A row whose value comes out empty is left out."
                  items={c.details.rows}
                  max={LIMITS.rows}
                  disabled={!canEdit}
                  onChange={(items) => onDraft(setAt(draft, ["content", "details", "rows"], items))}
                />
                <TextField
                  id={`s${stage}-details-note`}
                  label="Note"
                  max={LIMITS.text}
                  disabled={!canEdit}
                  {...field(["content", "details", "notePrompt"])}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`s${stage}-details-link-label`}
                    label="Note link text"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "details", "noteLinkLabel"])}
                  />
                  <TextField
                    id={`s${stage}-details-link-url`}
                    label="Note link"
                    max={LIMITS.url}
                    disabled={!canEdit}
                    {...field(["content", "details", "noteLinkUrl"])}
                  />
                </div>
              </>
            )}
          </Section>

          <Section
            title="Next steps"
            toggle={{ disabled: !canEdit, ...flag(["content", "steps", "enabled"]) }}
          >
            {c.steps.enabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`s${stage}-steps-label`}
                    label="Label"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "steps", "label"])}
                  />
                  <TextField
                    id={`s${stage}-steps-title`}
                    label="Title"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "steps", "title"])}
                  />
                </div>
                <StepList
                  idPrefix={`s${stage}-step`}
                  items={c.steps.items}
                  disabled={!canEdit}
                  onChange={(items) => onDraft(setAt(draft, ["content", "steps", "items"], items))}
                />
                <TextField
                  id={`s${stage}-steps-closing`}
                  label="Closing line"
                  multiline
                  rows={2}
                  max={LIMITS.text}
                  disabled={!canEdit}
                  {...field(["content", "steps", "closing"])}
                />
              </>
            )}
          </Section>

          <Section
            title="Second button"
            toggle={{ disabled: !canEdit, ...flag(["content", "secondaryButton", "enabled"]) }}
          >
            {c.secondaryButton.enabled && (
              <>
                <TextField
                  id={`s${stage}-secondary-prompt`}
                  label="Prompt"
                  max={LIMITS.short}
                  disabled={!canEdit}
                  {...field(["content", "secondaryButton", "prompt"])}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    id={`s${stage}-secondary-label`}
                    label="Label"
                    max={LIMITS.short}
                    disabled={!canEdit}
                    {...field(["content", "secondaryButton", "label"])}
                  />
                  <TextField
                    id={`s${stage}-secondary-url`}
                    label="Link"
                    max={LIMITS.url}
                    disabled={!canEdit}
                    {...field(["content", "secondaryButton", "url"])}
                  />
                </div>
              </>
            )}
          </Section>

          <Section title="Footer">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={`s${stage}-footer-tagline`}
                label="Tagline"
                max={LIMITS.short}
                disabled={!canEdit}
                {...field(["content", "footer", "tagline"])}
              />
              <TextField
                id={`s${stage}-footer-badge`}
                label="Badge"
                max={LIMITS.short}
                disabled={!canEdit}
                {...field(["content", "footer", "badge"])}
              />
            </div>
            <TextField
              id={`s${stage}-footer-compliance`}
              label="Compliance line"
              multiline
              rows={3}
              max={LIMITS.text}
              disabled={!canEdit}
              {...field(["content", "footer", "compliance"])}
            />
            <TextField
              id={`s${stage}-title`}
              label="Document title"
              hint="The HTML <title>. A few email clients show it; most never do."
              max={LIMITS.short}
              disabled={!canEdit}
              {...field(["content", "title"])}
            />
          </Section>
        </div>

        <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          {(problems.length > 0 || warnings.length > 0) && (
            <div
              className={cn(
                "glass spine space-y-2 p-4 text-sm",
                problems.length ? "spine-bad" : "spine-warn",
              )}
            >
              {problems.length > 0 && (
                <>
                  <p className="label-mono">fix before saving</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </>
              )}
              {warnings.length > 0 && (
                <>
                  <p className="label-mono">worth a second look</p>
                  <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                    {warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="glass flex flex-wrap items-center gap-2 p-4">
            <p className="mr-auto font-mono text-[11px] text-muted-foreground">
              {dirty
                ? "Unsaved changes"
                : record.isDefault
                  ? "The default copy"
                  : record.updatedAt
                    ? `Saved ${formatDistanceToNow(new Date(record.updatedAt), { addSuffix: true })}`
                    : "Saved"}
            </p>
            {canEdit && (
              <>
                {dirty && (
                  <Button variant="ghost" size="sm" onClick={onSettled}>
                    <Undo2 className="mr-1.5 h-4 w-4" /> Discard changes
                  </Button>
                )}
                {!record.isDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void resetToDefault()}
                    disabled={reset.isPending}
                  >
                    <RotateCcw className="mr-1.5 h-4 w-4" /> Reset to default
                  </Button>
                )}
                <TestSendDialog stage={stage} template={draft} disabled={problems.length > 0} />
                <Button
                  size="sm"
                  onClick={() => save.mutate()}
                  disabled={!dirty || problems.length > 0 || save.isPending}
                >
                  <Save className="mr-1.5 h-4 w-4" /> Save
                </Button>
              </>
            )}
          </div>

          <Preview stage={stage} template={draft} overview={overview} />
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Section({
  title,
  toggle,
  children,
}: {
  title: string;
  toggle?: { checked: boolean; onCheckedChange: (value: boolean) => void; disabled?: boolean };
  children: React.ReactNode;
}) {
  return (
    <div className="glass space-y-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <p className="label-mono">{title}</p>
        {toggle && (
          <label className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            {toggle.checked ? "shown" : "left out"}
            <Switch
              checked={toggle.checked}
              onCheckedChange={toggle.onCheckedChange}
              disabled={toggle.disabled}
              aria-label={`Show the ${title.toLowerCase()}`}
            />
          </label>
        )}
      </div>
      {children}
    </div>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  onChange,
  multiline,
  rows,
  max,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  max: number;
  disabled?: boolean;
}) {
  const focus = useContext(FocusContext);
  const track = (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (focus) focus.current = { el: event.currentTarget, apply: onChange };
  };
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          rows={rows}
          maxLength={max}
          disabled={disabled}
          onFocus={track}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={value}
          maxLength={max}
          disabled={disabled}
          onFocus={track}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint && <p className="font-mono text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function MergeFields({ stage }: { stage: LeadStage }) {
  const focus = useContext(FocusContext);
  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const target = focus?.current;
    if (!target || !target.el.isConnected || target.el.disabled) {
      void navigator.clipboard?.writeText(token).then(
        () =>
          toast.success(`Copied ${token}`, {
            description: "Click into a field to insert it there instead.",
          }),
        () => toast.message(token),
      );
      return;
    }
    const { el } = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    target.apply(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <div className="glass space-y-3 p-5">
      <div>
        <p className="label-mono">merge fields</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Click one to put it where the cursor is. Each is filled in for the applicant when the
          email goes, and anything it is filled with is escaped, so an applicant's own text cannot
          break the email.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {mergeFieldsFor(stage).map((mergeField) => (
          <button
            key={mergeField.key}
            type="button"
            title={`${mergeField.label} — e.g. ${mergeField.sample}`}
            // Keep the field's focus and selection: the click inserts there.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => insert(mergeField.key)}
            className="rounded border border-border/60 bg-background/40 px-2 py-0.5 font-mono text-[11px] hover:bg-foreground/10"
          >
            {`{{${mergeField.key}}}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function PairList({
  idPrefix,
  label,
  hint,
  items,
  max,
  disabled,
  onChange,
}: {
  idPrefix: string;
  label: string;
  hint?: string;
  items: EmailFact[];
  max: number;
  disabled?: boolean;
  onChange: (items: EmailFact[]) => void;
}) {
  const update = (index: number, patch: Partial<EmailFact>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        {!disabled && items.length < max && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...items, { label: "", value: "" }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      {items.length === 0 && (
        <p className="font-mono text-[11px] text-muted-foreground">None — the list is left out.</p>
      )}
      {items.map((item, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
          <PairInput
            id={`${idPrefix}-${index}-label`}
            aria-label={`${label} ${index + 1} label`}
            placeholder="Label"
            value={item.label}
            disabled={disabled}
            onValue={(value) => update(index, { label: value })}
          />
          <PairInput
            id={`${idPrefix}-${index}-value`}
            aria-label={`${label} ${index + 1} value`}
            placeholder="Value"
            value={item.value}
            disabled={disabled}
            onValue={(value) => update(index, { value })}
          />
          {!disabled && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              onClick={() => onChange(items.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      {hint && <p className="font-mono text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PairInput({
  onValue,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "onChange" | "onFocus"> & {
  value: string;
  onValue: (value: string) => void;
}) {
  const focus = useContext(FocusContext);
  return (
    <Input
      {...props}
      maxLength={LIMITS.short}
      onFocus={(event) => {
        if (focus) focus.current = { el: event.currentTarget, apply: onValue };
      }}
      onChange={(event) => onValue(event.target.value)}
    />
  );
}

function StepList({
  idPrefix,
  items,
  disabled,
  onChange,
}: {
  idPrefix: string;
  items: EmailStep[];
  disabled?: boolean;
  onChange: (items: EmailStep[]) => void;
}) {
  const update = (index: number, patch: Partial<EmailStep>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Steps</Label>
        {!disabled && items.length < LIMITS.steps && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange([...items, { title: "", text: "" }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add a step
          </Button>
        )}
      </div>
      {items.map((item, index) => (
        <RecordRow key={index} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">{index + 1}</span>
            <PairInput
              id={`${idPrefix}-${index}-title`}
              aria-label={`Step ${index + 1} title`}
              placeholder="Title"
              value={item.title}
              disabled={disabled}
              onValue={(value) => update(index, { title: value })}
            />
            {!disabled && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove step ${index + 1}`}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          <StepText
            id={`${idPrefix}-${index}-text`}
            value={item.text}
            disabled={disabled}
            onValue={(value) => update(index, { text: value })}
          />
        </RecordRow>
      ))}
    </div>
  );
}

function StepText({
  id,
  value,
  disabled,
  onValue,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  onValue: (value: string) => void;
}) {
  const focus = useContext(FocusContext);
  return (
    <Textarea
      id={id}
      aria-label="Step text"
      rows={2}
      value={value}
      maxLength={LIMITS.text}
      disabled={disabled}
      onFocus={(event) => {
        if (focus) focus.current = { el: event.currentTarget, apply: onValue };
      }}
      onChange={(event) => onValue(event.target.value)}
    />
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

const SAMPLE = "sample";

function Preview({
  stage,
  template,
  overview,
}: {
  stage: LeadStage;
  template: LeadEmailTemplate;
  overview: Overview;
}) {
  const [as, setAs] = useState(SAMPLE);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [view, setView] = useState<"html" | "text">("html");
  const leadId = as === SAMPLE ? null : as;
  const supportEmail = overview.identity?.ok ? overview.identity.supportEmail : undefined;

  const candidates = useQuery({
    queryKey: [...QUERY_KEY, "preview-leads", stage],
    queryFn: () => listPreviewLeadsFn({ data: { stage } }),
    staleTime: 5 * 60_000,
  });

  // The sample preview is drawn here, as the template is typed. A real
  // applicant's needs their record, so it is asked for once typing pauses.
  const sample = useMemo(
    () =>
      renderLeadEmail(template, {
        ...sampleContext(stage),
        ...(supportEmail ? { support_email: supportEmail } : {}),
      }),
    [template, stage, supportEmail],
  );
  const settledTemplate = useDebounced(template, 400);
  const real = useQuery({
    queryKey: [...QUERY_KEY, "preview", stage, leadId, JSON.stringify(settledTemplate)],
    queryFn: () => previewLeadEmailFn({ data: { stage, template: settledTemplate, leadId } }),
    enabled: leadId !== null,
    placeholderData: (previous) => previous,
  });

  const rendered = leadId && real.data ? real.data.rendered : sample;
  const identity = overview.identity;
  const fromName = overview.settings?.fromName;

  return (
    <div className="glass space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="label-mono mr-auto">preview</p>
        <Select value={as} onValueChange={setAs}>
          <SelectTrigger className="h-8 w-56" aria-label="Preview it for">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SAMPLE}>Sample applicant</SelectItem>
            {(candidates.data?.leads ?? []).map((lead) => (
              <SelectItem key={lead.id} value={lead.id}>
                {lead.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex rounded border border-border/60">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 rounded-none", width === "desktop" && "bg-foreground/10")}
            aria-label="Desktop width"
            onClick={() => setWidth("desktop")}
          >
            <Monitor className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 rounded-none", width === "mobile" && "bg-foreground/10")}
            aria-label="Phone width"
            onClick={() => setWidth("mobile")}
          >
            <Smartphone className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex rounded border border-border/60">
          {(["html", "text"] as const).map((v) => (
            <Button
              key={v}
              variant="ghost"
              size="sm"
              className={cn(
                "h-8 rounded-none font-mono text-[11px]",
                view === v && "bg-foreground/10",
              )}
              onClick={() => setView(v)}
            >
              {v === "html" ? "Email" : "Plain text"}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1 border-y border-border/40 py-2 font-mono text-[11px] text-muted-foreground">
        <p>
          From:{" "}
          {identity?.ok
            ? fromName
              ? `${fromName} <${identity.mailbox}>`
              : identity.mailbox
            : "— (the sending identity cannot send yet)"}
        </p>
        {leadId && real.data?.recipient && <p>To: {real.data.recipient}</p>}
        <p className="text-sm text-foreground">
          <Mail className="mr-1.5 inline h-3.5 w-3.5" />
          {rendered.subject || "(no subject)"}
        </p>
      </div>

      {leadId && real.isError && (
        <p className="text-sm text-destructive">
          That applicant's preview could not be drawn: {(real.error as Error).message}
        </p>
      )}

      {view === "html" ? (
        <div className="flex justify-center overflow-hidden rounded bg-[#eef2f6]">
          <iframe
            title={`Stage ${stage} email preview`}
            // Nothing in the preview may run or navigate: links are inert here.
            sandbox=""
            srcDoc={rendered.html}
            className={cn(
              "h-[46rem] border-0 bg-white",
              width === "mobile" ? "w-[375px]" : "w-full",
            )}
          />
        </div>
      ) : (
        <pre className="max-h-[46rem] overflow-auto whitespace-pre-wrap rounded border border-border/50 bg-background/40 p-3 font-mono text-xs">
          {rendered.text}
        </pre>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">
        {leadId
          ? "As this applicant would receive it now. The questionnaire link shown is a placeholder: a real one is minted when the email is sent."
          : "Sample values. Choose an applicant above to see their own."}
      </p>
    </div>
  );
}

// ── Test send ───────────────────────────────────────────────────────────────

function TestSendDialog({
  stage,
  template,
  disabled,
}: {
  stage: LeadStage;
  template: LeadEmailTemplate;
  disabled?: boolean;
}) {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  useEffect(() => {
    if (open && !to && session?.user.email) setTo(session.user.email);
  }, [open, to, session]);

  const send = useMutation({
    mutationFn: () => sendLeadEmailTestFn({ data: { stage, template, to } }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error("Test not sent", { description: result.error });
        return;
      }
      toast.success("Test sent", { description: `from ${result.mailbox} to ${to}` });
      setOpen(false);
    },
    onError: (error: Error) => toast.error("Test failed", { description: error.message }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          <Send className="mr-1.5 h-4 w-4" /> Send a test
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send a test of the stage {stage} email</DialogTitle>
          <DialogDescription>
            Sends this version — saved or not — to one address, with sample values, from the sending
            identity above. The subject starts with [Test], nothing is recorded against an
            applicant, and its questionnaire link opens nothing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`test-to-${stage}`}>Send to</Label>
          <Input
            id={`test-to-${stage}`}
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="you@aurixasystems.com.au"
          />
        </div>
        <DialogFooter>
          <Button onClick={() => send.mutate()} disabled={!to.trim() || send.isPending}>
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── What was sent ───────────────────────────────────────────────────────────

const STATUS_SPINE: Record<string, SpineTone> = {
  sent: "ok",
  pending: "live",
  claimed: "live",
  failed: "bad",
  unconfirmed: "warn",
  suppressed: "warn",
  skipped: "idle",
};

function RecentSends({ rows }: { rows: Overview["recent"] }) {
  return (
    <div className="glass space-y-3 p-5">
      <div>
        <p className="label-mono">recent applicant emails</p>
        <p className="mt-1 text-sm text-muted-foreground">
          What Mission Control raised for applicants, newest first — sent, waiting, or skipped with
          the reason. An email Make sent is recorded in Make and Airtable, not here.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground">Nothing yet.</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <RecordRow
              key={row.id}
              spine={STATUS_SPINE[row.status] ?? "idle"}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="font-mono text-[11px] text-muted-foreground">stage {row.stage}</span>
              <Badge variant="outline" className="font-mono text-[10px]">
                {row.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {row.to_address ?? "—"}
                {row.subject ? (
                  <span className="text-muted-foreground"> · {row.subject}</span>
                ) : null}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {formatDistanceToNow(new Date(row.sent_at ?? row.created_at), { addSuffix: true })}
              </span>
              {(row.last_error || (row.status !== "sent" && row.reason)) && (
                <span className="w-full font-mono text-[11px] text-muted-foreground">
                  {row.last_error ?? row.reason}
                </span>
              )}
            </RecordRow>
          ))}
        </div>
      )}
    </div>
  );
}
