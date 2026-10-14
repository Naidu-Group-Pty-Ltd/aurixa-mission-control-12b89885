/**
 * Splitting a campaign's messages by a column of its list.
 *
 * Pick a column — `State`, say — and every message goes only to contacts who
 * share one segment of it, and each sending time gives every segment its own
 * share: six states, one message each, fifty contacts to a message. The
 * column's values come from the uploaded list itself, so whatever it carries
 * can be a segment; a column of Australian states is offered pre-grouped, so
 * `NSW` and `New South Wales` are one segment without anybody's data being
 * rewritten.
 *
 * Segments are drawn while the campaign is a draft or paused: a sending
 * time's share is counted per segment, and a segment redrawn mid-send would
 * change who the rest of that sending time goes to. Turning one on or off is
 * allowed at any time — its contacts simply wait.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { RecordRow } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import { useCampaignPlan } from "@/hooks/use-campaign-plan";
import type { ColumnProfile } from "@/lib/email/listProfile.pure";
import {
  importedDimensions,
  suggestSegments,
  type SegmentSuggestion,
} from "@/lib/email/segments.pure";
import {
  SEGMENT_EDITABLE_STATUSES,
  createSegments,
  deleteSegment,
  saveSegment,
  setSegmentDimension,
  setSegmentEnabled,
} from "@/lib/email-campaigns.functions";

export type SegmentListRow = {
  id: string;
  label: string;
  match_values: string[];
  enabled: boolean;
  position: number;
};

const NO_SPLIT = "__none__";

export function SegmentsPanel({
  campaignId,
  status,
  dimension,
  segments,
  imports,
}: {
  campaignId: string;
  status: string;
  dimension: string | null;
  segments: SegmentListRow[];
  imports: Record<string, unknown>[];
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const plan = useCampaignPlan(campaignId);
  const editable = (SEGMENT_EDITABLE_STATUSES as readonly string[]).includes(status);
  const columns = useMemo(() => importedDimensions(imports), [imports]);
  const column = columns.find((entry) => entry.key === dimension) ?? null;
  const [editing, setEditing] = useState<SegmentListRow | "new" | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["email"] });
  const fail = (error: Error) => toast.error(error.message);

  const chooseColumn = useMutation({
    mutationFn: (next: string | null) =>
      setSegmentDimension({ data: { campaignId, dimension: next } }),
    onSuccess: refresh,
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (segment: SegmentListRow) =>
      setSegmentEnabled({ data: { id: segment.id, enabled: !segment.enabled } }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSegment({ data: { id } }),
    onSuccess: () => {
      toast.success("Segment removed");
      refresh();
    },
    onError: fail,
  });

  const counts = new Map((plan.data?.segments ?? []).map((segment) => [segment.id, segment]));
  const outside = plan.data?.outside ?? null;
  const taken = (except: string | null) =>
    new Set(segments.filter((s) => s.id !== except).flatMap((s) => s.match_values));

  return (
    <div className="space-y-4">
      <div className="glass-inset flex items-start gap-3 px-4 py-3">
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Split messages by a column of the list and every message goes only to contacts who share
          one segment of it — one state per message — while each sending time gives every segment
          its own share, set on the Rules tab. The column can then be named in a message that
          carries many contacts: <code>{"{{state}}"}</code> reads as the segment&apos;s name.
          Contacts in no enabled segment wait; they are never sent while messages are split this
          way.
        </p>
      </div>

      {columns.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-6 w-6" />}
          title="No columns to split by yet"
          description="Attach a list on the Audience tab. Any column whose values repeat — a state, a region, a segment — can split the messages."
        />
      ) : (
        <div className="glass space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,20rem)_1fr] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="segment-column">Split messages by</Label>
              <Select
                value={dimension ?? NO_SPLIT}
                disabled={!editable || chooseColumn.isPending}
                onValueChange={async (value) => {
                  const next = value === NO_SPLIT ? null : value;
                  if (next === dimension) return;
                  if (segments.length > 0) {
                    const ok = await confirm({
                      title: next ? "Split by another column?" : "Stop splitting messages?",
                      description: `The ${segments.length} segment${segments.length === 1 ? "" : "s"} drawn on ${column?.header ?? dimension} will be removed. Messages already sent keep their record of which segment they went to.`,
                      confirmText: next ? "Change column" : "Stop splitting",
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  chooseColumn.mutate(next);
                }}
              >
                <SelectTrigger id="segment-column">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SPLIT}>Don&apos;t split — any contacts together</SelectItem>
                  {columns.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key}>
                      {entry.header || entry.key} — {entry.distinct} value
                      {entry.distinct === 1 ? "" : "s"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!editable && (
              <p className="font-mono text-[11px] text-muted-foreground">
                {status === "running"
                  ? "Pause the campaign to draw or change segments. Turning one on or off works while it sends."
                  : `Segments cannot change on a ${status} campaign.`}
              </p>
            )}
          </div>

          {dimension && !column && (
            <p className="font-mono text-[11px] text-warning">
              No attached list carries the &ldquo;{dimension}&rdquo; column any more — choose
              another, or attach a list that has it.
            </p>
          )}

          {dimension && column && segments.length === 0 && editable && (
            <SuggestionPicker
              key={column.key}
              campaignId={campaignId}
              column={column}
              replace={false}
              onDone={refresh}
            />
          )}

          {segments.length > 0 && (
            <div className="space-y-2">
              {segments.map((segment) => {
                const tally = counts.get(segment.id);
                return (
                  <RecordRow
                    key={segment.id}
                    spine={!segment.enabled ? "idle" : tally && tally.pending === 0 ? "ok" : "live"}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{segment.label}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {tally
                          ? `${tally.pending.toLocaleString("en-AU")} waiting · ${tally.sent.toLocaleString("en-AU")} sent${tally.lastServedAt ? ` · last message ${formatDistanceToNow(new Date(tally.lastServedAt), { addSuffix: true })}` : ""}`
                          : "counting…"}
                        {" · covers "}
                        {segment.match_values.join(", ")}
                      </p>
                    </div>
                    <Switch
                      checked={segment.enabled}
                      onCheckedChange={() => toggle.mutate(segment)}
                      aria-label={`Send to ${segment.label}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!editable || !column}
                      onClick={() => setEditing(segment)}
                      aria-label={`Edit ${segment.label}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!editable}
                      aria-label={`Remove ${segment.label}`}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${segment.label}?`,
                          description:
                            "Its contacts stay waiting, outside every segment, until another segment covers them.",
                          confirmText: "Remove",
                          destructive: true,
                        });
                        if (ok) remove.mutate(segment.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </RecordRow>
                );
              })}

              {outside && outside.pending > 0 && (
                <RecordRow spine="warn" className="px-4 py-3">
                  <p className="text-sm">
                    {outside.pending.toLocaleString("en-AU")} waiting contact
                    {outside.pending === 1 ? " is" : "s are"} in no enabled segment
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {outside.inDisabled > 0
                      ? `${outside.inDisabled.toLocaleString("en-AU")} in a disabled segment · `
                      : ""}
                    {outside.values.length > 0
                      ? `values no segment covers: ${outside.values
                          .slice(0, 8)
                          .map((v) => `${v.label} (${v.count.toLocaleString("en-AU")} in the list)`)
                          .join(", ")}`
                      : "the rest have this column blank"}
                    . They wait, and are not sent while messages are split this way.
                  </p>
                </RecordRow>
              )}

              {editable && column && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
                    <Plus className="mr-2 h-3 w-3" /> Add a segment
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRebuilding(true)}>
                    Redraw from the list
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {column && editing && (
        <SegmentDialog
          campaignId={campaignId}
          column={column}
          segment={editing === "new" ? null : editing}
          taken={taken(editing === "new" ? null : editing.id)}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}

      {column && (
        <Dialog open={rebuilding} onOpenChange={setRebuilding}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Redraw segments from the list</DialogTitle>
              <DialogDescription>
                Replaces every segment of this campaign with the ones ticked below. Messages already
                sent keep their record of which segment they went to.
              </DialogDescription>
            </DialogHeader>
            <SuggestionPicker
              key={column.key}
              campaignId={campaignId}
              column={column}
              replace
              onDone={() => {
                setRebuilding(false);
                refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** The segments a column suggests, each tickable, and the button that draws them. */
function SuggestionPicker({
  campaignId,
  column,
  replace,
  onDone,
}: {
  campaignId: string;
  column: ColumnProfile;
  replace: boolean;
  onDone: () => void;
}) {
  const suggestions = useMemo(() => suggestSegments(column), [column]);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(suggestions.map((suggestion) => suggestion.label)),
  );
  const picked: SegmentSuggestion[] = suggestions.filter((s) => chosen.has(s.label));

  const draw = useMutation({
    mutationFn: () =>
      createSegments({
        data: {
          campaignId,
          dimension: column.key,
          replace,
          segments: picked.map((s) => ({ label: s.label, matchValues: s.matchValues })),
        },
      }),
    onSuccess: (result) => {
      toast.success(`${result.created} segment${result.created === 1 ? "" : "s"} drawn`);
      onDone();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="space-y-3">
      <p className="label-mono">segments in {column.header || column.key}</p>
      <div className="max-h-72 space-y-1 overflow-y-auto border border-border/50 p-2">
        {suggestions.map((suggestion) => (
          <label
            key={suggestion.label}
            className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-foreground/[0.04]"
          >
            <Checkbox
              checked={chosen.has(suggestion.label)}
              onCheckedChange={(checked) =>
                setChosen((current) => {
                  const next = new Set(current);
                  if (checked) next.add(suggestion.label);
                  else next.delete(suggestion.label);
                  return next;
                })
              }
            />
            <span className="w-32 truncate font-medium">{suggestion.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {suggestion.matchValues.length > 1 ? suggestion.matchValues.join(", ") : ""}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {suggestion.contacts.toLocaleString("en-AU")}
            </span>
          </label>
        ))}
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        Counts are rows of the attached lists. A column of Australian states is grouped by state, so
        every spelling your list uses lands in one segment; untick any you do not want sent — its
        contacts wait, outside every segment.
      </p>
      <div className="flex justify-end">
        <Button onClick={() => draw.mutate()} disabled={picked.length === 0 || draw.isPending}>
          {replace ? "Replace with" : "Draw"} {picked.length} segment
          {picked.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

/** Add a segment, or change which values one covers and what it is called. */
function SegmentDialog({
  campaignId,
  column,
  segment,
  taken,
  onClose,
  onSaved,
}: {
  campaignId: string;
  column: ColumnProfile;
  segment: SegmentListRow | null;
  /** Values another segment already covers: a contact can be in only one. */
  taken: Set<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(segment?.label ?? "");
  const [selected, setSelected] = useState<string[]>(segment?.match_values ?? []);
  const available = column.values.filter((value) => !taken.has(value.value));

  const save = useMutation({
    mutationFn: () =>
      saveSegment({
        data: { id: segment?.id, campaignId, label: label.trim(), matchValues: selected },
      }),
    onSuccess: () => {
      toast.success(segment ? "Segment saved" : "Segment added");
      onSaved();
      onClose();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{segment ? `Edit ${segment.label}` : "Add a segment"}</DialogTitle>
          <DialogDescription>
            Name it, and tick the values of {column.header || column.key} it covers. Values another
            segment covers are not offered: a contact can be in only one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="segment-label">Name</Label>
            <Input
              id="segment-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="NSW"
            />
            <p className="font-mono text-[10px] text-muted-foreground">
              What <code>{`{{${column.key}}}`}</code> reads as in this segment&apos;s messages.
            </p>
          </div>
          <div className="space-y-2">
            <Label>Values</Label>
            <div className="max-h-56 space-y-1 overflow-y-auto border border-border/50 p-2">
              {available.length === 0 && (
                <p className="px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  Every value is already in a segment.
                </p>
              )}
              {available.map((value) => (
                <label
                  key={value.value}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm hover:bg-foreground/[0.04]"
                >
                  <Checkbox
                    checked={selected.includes(value.value)}
                    onCheckedChange={(checked) =>
                      setSelected((current) =>
                        checked
                          ? [...new Set([...current, value.value])]
                          : current.filter((entry) => entry !== value.value),
                      )
                    }
                  />
                  <span className="flex-1 truncate">{value.label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {value.count.toLocaleString("en-AU")}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={!label.trim() || selected.length === 0 || save.isPending}
          >
            {segment ? "Save segment" : "Add segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
