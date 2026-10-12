/**
 * Enrolling mailboxes in the warmup pool: one tenant at a time, any number of
 * its mailboxes, one schedule for all of them (each can be changed after).
 *
 * The list is the tenant's directory, as the campaign mailbox picker reads it,
 * with each mailbox marked by whether this tenant's application can use it.
 * Enrolment itself is the real test: the server prepares each mailbox —
 * credentials, permissions, its Warmup folder — and refuses any that fail,
 * with the reason, while the rest go ahead.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TenantSelect } from "@/components/email/tenant-select";
import { ScheduleFields } from "@/components/email/warmup/schedule-fields";
import { cn } from "@/lib/utils";
import { emailKey } from "@/lib/email/emailAddress.pure";
import type { MailboxAccess } from "@/lib/email/mailboxes.pure";
import {
  DEFAULT_SCHEDULE,
  scheduleProblems,
  type WarmupSchedule,
} from "@/lib/email/warmupPlan.pure";
import { listMailboxes } from "@/lib/email-campaigns.functions";
import { enrollWarmupMailboxes } from "@/lib/email-warmup.functions";

function accessLabel(access: MailboxAccess | null): {
  text: string;
  tone: "ok" | "bad" | "warn" | "idle";
} {
  switch (access?.state) {
    case "reachable":
      return { text: "can use", tone: "ok" };
    case "denied":
      return { text: "blocked", tone: "bad" };
    case "no_mailbox":
      return { text: "no mailbox", tone: "bad" };
    case "unknown":
      return { text: "not answered", tone: "warn" };
    case "unverifiable":
      return { text: "can't check", tone: "warn" };
    default:
      return { text: "unchecked", tone: "idle" };
  }
}

export function AddWarmupMailboxesDialog({
  open,
  onOpenChange,
  enrolled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Addresses already in the pool, lower-cased. */
  enrolled: Set<string>;
}) {
  const qc = useQueryClient();
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string | null>>(new Map());
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [schedule, setSchedule] = useState<WarmupSchedule>(DEFAULT_SCHEDULE);
  const [tidySent, setTidySent] = useState(true);
  const [failures, setFailures] = useState<{ address: string; reason: string | null }[]>([]);

  const directory = useQuery({
    queryKey: ["email", "mailboxes", tenantId ?? "default"],
    queryFn: () => listMailboxes({ data: { tenantId } }),
    enabled: open,
    staleTime: 60_000,
  });

  const options = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (directory.data?.options ?? []).filter(
      (option) =>
        !needle ||
        option.address.includes(needle) ||
        (option.displayName ?? "").toLowerCase().includes(needle),
    );
  }, [directory.data, search]);

  const problems = scheduleProblems(schedule);

  const enroll = useMutation({
    mutationFn: () =>
      enrollWarmupMailboxes({
        data: {
          tenantId,
          mailboxes: [...selected.entries()].map(([address, displayName]) => ({
            address,
            displayName,
          })),
          schedule,
          tidySent,
        },
      }),
    onSuccess: ({ results }) => {
      const done = results.filter((result) => result.ok);
      const refused = results.filter((result) => !result.ok);
      void qc.invalidateQueries({ queryKey: ["email", "warmup"] });
      if (done.length > 0) {
        toast.success(`${done.length} mailbox${done.length === 1 ? "" : "es"} started warming up`, {
          description:
            "The first messages go out within a few minutes, inside each mailbox's window.",
        });
      }
      if (refused.length === 0) {
        setSelected(new Map());
        onOpenChange(false);
        return;
      }
      // Keep the dialog open on the ones that did not go in, with why.
      setSelected(
        new Map(refused.map((result) => [result.address, selected.get(result.address) ?? null])),
      );
      setFailures(refused);
      toast.error(`${refused.length} could not be enrolled`);
    },
    onError: (error: Error) => toast.error("Nothing was enrolled", { description: error.message }),
  });

  const toggle = (address: string, displayName: string | null) =>
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(address)) next.delete(address);
      else next.set(address, displayName);
      return next;
    });

  const addTyped = () => {
    const key = emailKey(typed);
    if (!key) {
      toast.error("That is not a valid email address");
      return;
    }
    if (enrolled.has(key)) {
      toast.error(`${key} is already in the warmup pool`);
      return;
    }
    setSelected((current) => new Map(current).set(key, null));
    setTyped("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (!enroll.isPending ? onOpenChange(next) : undefined)}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add mailboxes to warmup</DialogTitle>
          <DialogDescription>
            Each mailbox writes to mailboxes in the pool's other organisations and answers some of
            what they send. Its tenant's application needs Mail.Send and Mail.ReadWrite; a folder
            named Warmup is created in each mailbox to keep warmup mail out of the inbox.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="warmup-tenant">Microsoft tenant</Label>
            <TenantSelect
              id="warmup-tenant"
              value={tenantId}
              onChange={(next) => {
                setTenantId(next);
                setSelected(new Map());
                setFailures([]);
              }}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Mailboxes</Label>
              <span className="font-mono text-[11px] text-muted-foreground">
                {selected.size} selected
              </span>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the tenant's mailboxes…"
              className="h-8 text-xs"
            />
            <div className="max-h-56 overflow-y-auto rounded border border-border/50">
              {directory.isLoading ? (
                <p className="flex items-center gap-2 p-3 font-mono text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Reading the tenant's mailboxes…
                </p>
              ) : directory.data && !directory.data.configured ? (
                <p className="p-3 font-mono text-xs text-muted-foreground">
                  {directory.data.problem ?? "This tenant cannot be used."}
                </p>
              ) : options.length === 0 ? (
                <p className="p-3 font-mono text-xs text-muted-foreground">
                  No mailboxes listed — type an address below.
                </p>
              ) : (
                options.map((option) => {
                  const warming = enrolled.has(option.address);
                  const blocked =
                    option.access?.state === "denied" || option.access?.state === "no_mailbox";
                  const badge = accessLabel(option.access);
                  return (
                    <label
                      key={option.address}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 border-b border-border/30 px-3 py-2 last:border-0",
                        (warming || blocked) && "cursor-not-allowed opacity-60",
                      )}
                      title={option.access?.reason ?? undefined}
                    >
                      <Checkbox
                        checked={selected.has(option.address)}
                        disabled={warming || blocked}
                        onCheckedChange={() => toggle(option.address, option.displayName)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {option.displayName ?? option.address}
                        </span>
                        {option.displayName ? (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {option.address}
                          </span>
                        ) : null}
                      </span>
                      {warming ? (
                        <Badge variant="secondary" className="font-mono text-[10px]">
                          warming
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className={cn(
                            "font-mono text-[10px]",
                            badge.tone === "ok" && "text-success",
                            badge.tone === "bad" && "text-destructive",
                            badge.tone === "warn" && "text-warning",
                          )}
                        >
                          {badge.text}
                        </Badge>
                      )}
                    </label>
                  );
                })
              )}
            </div>
            {directory.data?.directory.error ? (
              <p className="flex gap-2 font-mono text-[10px] leading-snug text-muted-foreground">
                <ShieldAlert className="h-3 w-3 shrink-0 text-warning" />
                {directory.data.directory.error}
              </p>
            ) : null}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                addTyped();
              }}
            >
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Or type an address in this tenant"
                className="h-8 text-xs"
              />
              <Button type="submit" size="sm" variant="outline" disabled={!typed.trim()}>
                <Plus className="mr-1 h-3 w-3" /> Add
              </Button>
            </form>
            {[...selected.keys()].filter((address) => !options.some((o) => o.address === address))
              .length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {[...selected.keys()]
                  .filter((address) => !options.some((o) => o.address === address))
                  .map((address) => (
                    <Badge
                      key={address}
                      variant="secondary"
                      className="cursor-pointer font-mono text-[10px]"
                      onClick={() => toggle(address, null)}
                      title="Remove"
                    >
                      {address} ×
                    </Badge>
                  ))}
              </div>
            ) : null}
          </div>

          <details className="rounded border border-border/50 px-3 py-2" open>
            <summary className="cursor-pointer text-sm">Schedule</summary>
            <div className="pt-3">
              <ScheduleFields value={schedule} onChange={setSchedule} idPrefix="add" />
              <label className="mt-4 flex items-center justify-between gap-3 text-sm">
                <span>
                  File sent copies too
                  <span className="block font-mono text-[10px] text-muted-foreground">
                    move warmup mail out of Sent Items into the Warmup folder
                  </span>
                </span>
                <Switch checked={tidySent} onCheckedChange={setTidySent} />
              </label>
            </div>
          </details>

          {problems.length > 0 ? (
            <ul className="space-y-1 font-mono text-[11px] text-destructive">
              {problems.map((problem) => (
                <li key={problem}>— {problem}</li>
              ))}
            </ul>
          ) : null}
          {failures.length > 0 ? (
            <div className="space-y-1 rounded border border-destructive/40 p-3">
              <p className="text-sm text-foreground">Not enrolled:</p>
              <ul className="space-y-1 font-mono text-[11px] text-muted-foreground">
                {failures.map((failure) => (
                  <li key={failure.address}>
                    <span className="text-foreground">{failure.address}</span> — {failure.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={enroll.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setFailures([]);
              enroll.mutate();
            }}
            disabled={selected.size === 0 || problems.length > 0 || enroll.isPending}
          >
            {enroll.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {enroll.isPending
              ? "Preparing mailboxes…"
              : `Start warming ${selected.size || ""} mailbox${selected.size === 1 ? "" : "es"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
