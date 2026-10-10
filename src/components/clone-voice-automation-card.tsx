import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CalendarClock, ExternalLink, PlugZap, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  applyCloneVoiceAutomation,
  checkCloneVoiceAutomationDrift,
  connectCloneVoiceAutomation,
  getCloneVoiceAutomation,
  handOffCloneVoiceAutomation,
  refreshCloneVoiceAutomationConnection,
  registerCloneVoiceAutomation,
  registerCloneVoiceAutomationConnection,
  updateCloneVoiceAutomation,
} from "@/lib/voice-automation.functions";

type Settings = {
  calendar: Record<string, string | number | boolean>;
  email: Record<string, string | number | boolean>;
};

type FieldDef = {
  path: string;
  label: string;
  kind: "text" | "number" | "bool" | "select";
  options?: readonly (string | number)[];
  hint?: string;
};

const FIELDS: FieldDef[] = [
  {
    path: "calendar.provider",
    label: "Calendar",
    kind: "select",
    options: ["internal", "outlook", "google"],
  },
  {
    path: "calendar.outlookCalendarBase",
    label: "Outlook calendar path",
    kind: "text",
    hint: "/v1.0/me/calendar",
  },
  { path: "calendar.googleCalendarId", label: "Google calendar id", kind: "text", hint: "primary" },
  { path: "calendar.timezone", label: "Time zone", kind: "text" },
  { path: "calendar.businessStartHour", label: "First bookable hour", kind: "number" },
  { path: "calendar.businessEndHour", label: "Bookings end by", kind: "number" },
  {
    path: "calendar.slotStepMinutes",
    label: "Slot every (min)",
    kind: "select",
    options: [15, 20, 30, 45, 60],
  },
  { path: "calendar.bufferMinutes", label: "Buffer (min)", kind: "number" },
  { path: "calendar.maxSlots", label: "Times offered", kind: "number" },
  { path: "calendar.searchDays", label: "Days ahead", kind: "number" },
  {
    path: "email.provider",
    label: "Email",
    kind: "select",
    options: ["outlook", "google", "none"],
  },
  { path: "email.adminEmail", label: "Business recipient", kind: "text" },
  { path: "email.businessName", label: "Signed as", kind: "text" },
  { path: "email.notifyClient", label: "Email the customer", kind: "bool" },
  { path: "email.zoomLink", label: "Zoom joining link", kind: "text" },
  {
    path: "email.testRedirectTo",
    label: "Test gate (send all mail to)",
    kind: "text",
    hint: "empty = live",
  },
];

const get = (s: Settings, path: string) => {
  const [g, k] = path.split(".") as ["calendar" | "email", string];
  return s[g]?.[k];
};
const set = (s: Settings, path: string, v: string | number | boolean): Settings => {
  const [g, k] = path.split(".") as ["calendar" | "email", string];
  return { ...s, [g]: { ...s[g], [k]: v } };
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  applied: "default",
  pending: "secondary",
  applying: "secondary",
  blocked: "outline",
  failed: "destructive",
};

const DEFAULT_SETTINGS: Settings = {
  calendar: {
    provider: "internal",
    outlookCalendarBase: "/v1.0/me/calendar",
    googleCalendarId: "primary",
    timezone: "Australia/Sydney",
    businessStartHour: 9,
    businessEndHour: 17,
    slotStepMinutes: 30,
    bufferMinutes: 0,
    maxSlots: 6,
    searchDays: 5,
  },
  email: {
    provider: "none",
    adminEmail: "",
    businessName: "",
    notifyClient: true,
    zoomLink: "",
    testRedirectTo: "",
  },
};

/**
 * A CRM-independent clone's voice agents: which calendar they book into and
 * which mailbox confirms a booking, held as revisioned settings that the clone's
 * own administrators can also change. This card is where an operator PROVISIONS
 * them before hand-off, holds the go-live decisions (locks, the test gate), and
 * sees what the tenant changed and whether it reached Make.
 *
 * Desired and applied are drawn apart on purpose: a revision can be accepted and
 * still be blocked on a connection nobody has authorised yet.
 */
export function CloneVoiceAutomationCard({
  cloneId,
  crmMode,
}: {
  cloneId: string;
  crmMode: string | null | undefined;
}) {
  const loadFn = useServerFn(getCloneVoiceAutomation);
  const registerFn = useServerFn(registerCloneVoiceAutomation);
  const updateFn = useServerFn(updateCloneVoiceAutomation);
  const applyFn = useServerFn(applyCloneVoiceAutomation);
  const handOffFn = useServerFn(handOffCloneVoiceAutomation);
  const connectFn = useServerFn(connectCloneVoiceAutomation);
  const refreshFn = useServerFn(refreshCloneVoiceAutomationConnection);
  const registerConnFn = useServerFn(registerCloneVoiceAutomationConnection);
  const driftFn = useServerFn(checkCloneVoiceAutomationDrift);

  const enabled = crmMode === "independent";
  const {
    data: view,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["clone-voice-automation", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
    enabled,
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [locks, setLocks] = useState<string[]>([]);
  const [stack, setStack] = useState({
    makeZone: "us2",
    makeTeamId: "",
    cfgDataStoreId: "",
    adapterScenarioId: "",
    notifierScenarioId: "",
  });
  const [authoriser, setAuthoriser] = useState({ name: "", email: "" });
  const [existingConn, setExistingConn] = useState<Record<string, string>>({});

  useEffect(() => {
    if (view?.settings) setDraft(view.settings as unknown as Settings);
    if (view) setLocks(view.lockedFields ?? []);
  }, [view?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!view?.settings) return false;
    return (
      JSON.stringify(draft) !== JSON.stringify(view.settings) ||
      JSON.stringify([...locks].sort()) !== JSON.stringify([...(view.lockedFields ?? [])].sort())
    );
  }, [draft, locks, view]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      toast.success(`${label} — done`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refetch();
    }
  };

  if (!enabled) return null;

  const status = view?.applyStatus ?? null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4" aria-hidden /> Voice agents — calendar & email
            </CardTitle>
            <CardDescription>
              The Make stack behind this clone's voice agents: which calendar they book into, which
              mailbox confirms, and when. Set up here before hand-off; the clone's administrators
              change it afterwards from their Settings page, and every change lands here first.
            </CardDescription>
          </div>
          {view?.provisioned ? (
            <Badge variant={STATUS_VARIANT[status ?? "pending"] ?? "outline"}>
              {status === "applied" ? `Live · rev ${view.appliedRevision}` : status}
            </Badge>
          ) : (
            <Badge variant="outline">Not provisioned</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !view ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {!view.makeConfigured && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-medium">Make API token not configured</p>
                <p className="text-muted-foreground">
                  Add <code>MAKE_API_TOKEN</code> to Mission Control's environment (scopes:
                  scenarios, data stores and connections read/write, credential requests
                  read/write). Settings are accepted and kept until it is, and nothing reaches the
                  voice agents before.
                </p>
              </div>
            )}

            {!view.provisioned ? (
              <section className="space-y-3">
                <p className="text-sm font-medium">Register this clone's stack</p>
                <div className="grid gap-2 sm:grid-cols-5">
                  {(
                    [
                      "makeZone",
                      "makeTeamId",
                      "cfgDataStoreId",
                      "adapterScenarioId",
                      "notifierScenarioId",
                    ] as const
                  ).map((k) => (
                    <div key={k} className="space-y-1">
                      <Label htmlFor={`va-${k}`} className="text-xs">
                        {k}
                      </Label>
                      <Input
                        id={`va-${k}`}
                        value={stack[k]}
                        onChange={(e) => setStack({ ...stack, [k]: e.target.value })}
                      />
                    </div>
                  ))}
                </div>
                <SettingsForm draft={draft} setDraft={setDraft} locks={locks} setLocks={setLocks} />
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    run("Register stack", () =>
                      registerFn({
                        data: {
                          cloneId,
                          stack: {
                            makeZone: stack.makeZone,
                            makeTeamId: Number(stack.makeTeamId),
                            cfgDataStoreId: Number(stack.cfgDataStoreId),
                            adapterScenarioId: Number(stack.adapterScenarioId),
                            notifierScenarioId: Number(stack.notifierScenarioId),
                          },
                          settings: draft,
                        },
                      }),
                    )
                  }
                >
                  Register and apply
                </Button>
              </section>
            ) : (
              <>
                <section className="space-y-2 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
                    <span>
                      Revision {view.revision} by {view.updatedBy?.kind}
                      {view.updatedBy?.label ? ` (${view.updatedBy.label})` : ""}
                    </span>
                    <span>
                      Applied:{" "}
                      {view.appliedRevision
                        ? `rev ${view.appliedRevision} · ${new Date(view.appliedAt ?? "").toLocaleString("en-AU")}`
                        : "never"}
                    </span>
                    <span>
                      {view.handedOffAt
                        ? `Handed off ${new Date(view.handedOffAt).toLocaleDateString("en-AU")}`
                        : "Not handed off"}
                    </span>
                  </div>
                  {view.applyBlocks?.length > 0 && (
                    <ul className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                      {view.applyBlocks.map((b, i) => (
                        <li key={i}>{b.message}</li>
                      ))}
                    </ul>
                  )}
                  {view.applyError && <p className="text-destructive">{view.applyError}</p>}
                  {Array.isArray(view.drift) && view.drift.length > 0 && (
                    <p className="text-warning">
                      Edited in Make by hand: {JSON.stringify(view.drift)}
                    </p>
                  )}
                </section>

                <SettingsForm draft={draft} setDraft={setDraft} locks={locks} setLocks={setLocks} />

                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={!dirty || !!busy}
                    onClick={() =>
                      run("Save settings", () =>
                        updateFn({
                          data: {
                            cloneId,
                            expectedRevision: view.revision ?? 0,
                            settings: draft,
                            lockedFields: locks,
                          },
                        }),
                      )
                    }
                  >
                    Save as revision {(view.revision ?? 0) + 1}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => run("Apply", () => applyFn({ data: { cloneId } }))}
                  >
                    <RefreshCw className="mr-1 h-4 w-4" aria-hidden /> Apply now
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => run("Drift check", () => driftFn({ data: { cloneId } }))}
                  >
                    Check for hand edits
                  </Button>
                  {!view.handedOffAt && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={!!busy}
                        onClick={() =>
                          run("Hand off", () =>
                            handOffFn({ data: { cloneId, releaseLocks: false } }),
                          )
                        }
                      >
                        Hand off (keep locks)
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={!!busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              "Release every lock, including the test gate? The tenant will then be able to send real mail to customers.",
                            )
                          )
                            void run("Hand off and go live", () =>
                              handOffFn({ data: { cloneId, releaseLocks: true } }),
                            );
                        }}
                      >
                        Hand off and release locks
                      </Button>
                    </>
                  )}
                </div>

                <section className="space-y-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <PlugZap className="h-4 w-4" aria-hidden /> Connections
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Input
                      placeholder="Authoriser name"
                      value={authoriser.name}
                      onChange={(e) => setAuthoriser({ ...authoriser, name: e.target.value })}
                    />
                    <Input
                      placeholder="Authoriser email"
                      value={authoriser.email}
                      onChange={(e) => setAuthoriser({ ...authoriser, email: e.target.value })}
                    />
                  </div>
                  <ul className="divide-y rounded-lg border text-sm">
                    {view.connections.map((c) => (
                      <li
                        key={c.kind}
                        className="flex flex-wrap items-center justify-between gap-2 p-3"
                      >
                        <div>
                          <p className="font-medium">
                            {c.label}{" "}
                            {view.requiredConnections.includes(c.kind) && (
                              <Badge variant="outline">required</Badge>
                            )}
                          </p>
                          <p className="text-muted-foreground">
                            {c.state.replace("_", " ")}
                            {c.accountLabel ? ` · ${c.accountLabel}` : ""}
                            {c.lastError ? ` · ${c.lastError}` : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {c.authorisationUrl && (
                            <a
                              className="inline-flex items-center gap-1 text-primary underline"
                              href={c.authorisationUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Authorisation link <ExternalLink className="h-3 w-3" aria-hidden />
                            </a>
                          )}
                          {c.state === "requested" && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!!busy}
                              onClick={() =>
                                run("Check", () => refreshFn({ data: { cloneId, kind: c.kind } }))
                              }
                            >
                              Check
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!busy || !authoriser.email}
                            onClick={() =>
                              run("Request authorisation", async () => {
                                const r = await connectFn({
                                  data: {
                                    cloneId,
                                    kind: c.kind,
                                    name: authoriser.name,
                                    email: authoriser.email,
                                  },
                                });
                                if (r?.authorisationUrl)
                                  window.open(r.authorisationUrl, "_blank", "noopener");
                              })
                            }
                          >
                            {c.state === "authorized" ? "Replace" : "Request"}
                          </Button>
                          <Input
                            className="h-8 w-28"
                            placeholder="Existing id"
                            value={existingConn[c.kind] ?? ""}
                            onChange={(e) =>
                              setExistingConn({ ...existingConn, [c.kind]: e.target.value })
                            }
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy || !existingConn[c.kind]}
                            onClick={() =>
                              run("Register connection", () =>
                                registerConnFn({
                                  data: {
                                    cloneId,
                                    kind: c.kind,
                                    connectionId: Number(existingConn[c.kind]),
                                  },
                                }),
                              )
                            }
                          >
                            Use existing
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="space-y-1">
                  <p className="text-sm font-medium">History</p>
                  <ul className="max-h-56 space-y-1 overflow-auto text-xs text-muted-foreground">
                    {view.history.map((h) => (
                      <li key={h.revision}>
                        rev {h.revision} · {h.actorKind}
                        {h.actorLabel ? ` (${h.actorLabel})` : ""} ·{" "}
                        {new Date(h.at).toLocaleString("en-AU")} ·{" "}
                        {Array.isArray(h.changes)
                          ? (h.changes as { field: string }[]).map((c) => c.field).join(", ") ||
                            "initial"
                          : ""}
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsForm({
  draft,
  setDraft,
  locks,
  setLocks,
}: {
  draft: Settings;
  setDraft: (s: Settings) => void;
  locks: string[];
  setLocks: (l: string[]) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {FIELDS.map((f) => {
        const id = `va-field-${f.path}`;
        const value = get(draft, f.path);
        const locked = locks.includes(f.path);
        return (
          <div key={f.path} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={id} className="text-xs">
                {f.label}
              </Label>
              <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Checkbox
                  checked={locked}
                  onCheckedChange={(v) =>
                    setLocks(v ? [...locks, f.path] : locks.filter((l) => l !== f.path))
                  }
                  aria-label={`Lock ${f.label}`}
                />
                lock
              </label>
            </div>
            {f.kind === "bool" ? (
              <Switch
                id={id}
                checked={!!value}
                onCheckedChange={(v) => setDraft(set(draft, f.path, v))}
              />
            ) : f.kind === "select" ? (
              <select
                id={id}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={String(value ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  setDraft(
                    set(draft, f.path, typeof f.options?.[0] === "number" ? Number(raw) : raw),
                  );
                }}
              >
                {f.options?.map((o) => (
                  <option key={String(o)} value={String(o)}>
                    {String(o)}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={id}
                type={f.kind === "number" ? "number" : "text"}
                placeholder={f.hint}
                value={String(value ?? "")}
                onChange={(e) =>
                  setDraft(
                    set(
                      draft,
                      f.path,
                      f.kind === "number" ? Number(e.target.value) : e.target.value,
                    ),
                  )
                }
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
