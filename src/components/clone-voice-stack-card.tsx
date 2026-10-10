import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  ExternalLink,
  Inbox,
  KeyRound,
  Phone,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  advanceCloneVapiCustody,
  buildCloneVoiceStack,
  getCloneVoiceStack,
  markCloneVapiSignedUp,
  parkCloneVoiceStack,
  readCloneVapiInbox,
  recordCloneVapiOrg,
  requestCloneGhlGrant,
  retryCloneVoiceStackStep,
  revealCloneVapiLogin,
  setCloneGhlCredentials,
  setCloneVapiSuspended,
  setCloneVoiceIdentity,
} from "@/lib/voice-stack.functions";
import {
  LINE_REQUIREMENT_COPY,
  LINE_REQUIREMENTS,
  VAPI_CUSTODY_STATUS_COPY,
  VOICE_STACK_STATUS_COPY,
  isVapiCustodyStatus,
  isVoiceStackStatus,
} from "@/lib/voiceStack.pure";
import { CRM_MODE_COPY, isCrmMode } from "@/lib/crmMode.pure";

type Tone = "neutral" | "busy" | "good" | "warn" | "bad";
const TONE_VARIANT: Record<Tone, "default" | "secondary" | "destructive" | "outline"> = {
  good: "default",
  busy: "secondary",
  neutral: "outline",
  warn: "outline",
  bad: "destructive",
};

type InboxMessage = {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: string;
  fromVapi: boolean;
  codes: string[];
  links: string[];
};

/**
 * A clone's voice agents, end to end: the clone's OWN Vapi organisation (held
 * by Aurixa — the tenant never sees it), what the clone's CRM line requires
 * (the dependent line always needs the tenant's GoHighLevel key), the tenant's
 * business details that replace the line head's in every prompt, and the build
 * of the stack from the line's template, step by step.
 *
 * Nothing on this card shows a key or a token. The login password is shown
 * only after "Reveal", audited each time, and hidden again after a minute.
 */
export function CloneVoiceStackCard({ cloneId }: { cloneId: string }) {
  const loadFn = useServerFn(getCloneVoiceStack);
  const advanceFn = useServerFn(advanceCloneVapiCustody);
  const inboxFn = useServerFn(readCloneVapiInbox);
  const revealFn = useServerFn(revealCloneVapiLogin);
  const signedUpFn = useServerFn(markCloneVapiSignedUp);
  const recordFn = useServerFn(recordCloneVapiOrg);
  const suspendFn = useServerFn(setCloneVapiSuspended);
  const ghlFn = useServerFn(setCloneGhlCredentials);
  const grantFn = useServerFn(requestCloneGhlGrant);
  const identityFn = useServerFn(setCloneVoiceIdentity);
  const buildFn = useServerFn(buildCloneVoiceStack);
  const retryFn = useServerFn(retryCloneVoiceStackStep);
  const parkFn = useServerFn(parkCloneVoiceStack);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-voice-stack", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [login, setLogin] = useState<{ email: string; password: string } | null>(null);
  const [inbox, setInbox] = useState<InboxMessage[] | null>(null);
  const [org, setOrg] = useState({ orgId: "", privateKey: "", publicKey: "", orgName: "" });
  const [ghl, setGhl] = useState({ locationId: "", apiKey: "" });
  const [authoriser, setAuthoriser] = useState({ name: "", email: "" });
  const [label, setLabel] = useState("");
  const [replacements, setReplacements] = useState<{ from: string; to: string }[]>([]);
  const [parkReason, setParkReason] = useState("");

  useEffect(() => {
    if (!login) return;
    const t = setTimeout(() => setLogin(null), 60_000);
    return () => clearTimeout(t);
  }, [login]);

  const stack = data?.view.stack ?? null;
  useEffect(() => {
    if (!stack) return;
    setLabel(stack.cloneLabel ?? "");
    setReplacements(stack.replacements.length > 0 ? stack.replacements : []);
  }, [stack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      toast.success(`${name} — done`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refetch();
    }
  };

  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Loading voice agents…
        </CardContent>
      </Card>
    );
  }

  const { view, custody } = data;
  const mode = isCrmMode(view.crmMode) ? view.crmMode : null;
  const custodyCopy = isVapiCustodyStatus(custody.readiness.status)
    ? VAPI_CUSTODY_STATUS_COPY[custody.readiness.status]
    : { label: custody.readiness.status, tone: "neutral" as Tone };
  const stackCopy =
    stack && isVoiceStackStatus(stack.status) ? VOICE_STACK_STATUS_COPY[stack.status] : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 basis-80 flex-1">
            <CardTitle className="flex items-center gap-2">
              <Phone className="h-4 w-4" aria-hidden /> Voice agents — this clone's own stack
            </CardTitle>
            <CardDescription>
              Built in this clone's own Vapi organisation from its CRM line's template, the way its
              code comes from its line's head. When the clone changes line, its voice agents change
              with it.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {mode && <Badge variant="outline">{CRM_MODE_COPY[mode].title}</Badge>}
            {view.isLineHead ? (
              <Badge variant="secondary">Template for its line</Badge>
            ) : stackCopy ? (
              <Badge variant={TONE_VARIANT[stackCopy.tone]}>{stackCopy.label}</Badge>
            ) : (
              <Badge variant="outline">Not provisioned</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Lineage */}
        <section className="space-y-1 text-sm">
          {!mode ? (
            <p className="text-muted-foreground">
              This clone's CRM line is not recorded, so neither voice stack can be chosen for it.
            </p>
          ) : view.isLineHead ? (
            <p>
              This clone <strong>heads the {CRM_MODE_COPY[mode].title.toLowerCase()} line</strong>.
              Its voice stack is the template every other clone on the line is copied from, so it is
              never rebuilt from itself.
            </p>
          ) : (
            <p>
              Copied from <strong>{view.lineHeadName ?? "the line head (not recorded)"}</strong>,
              the head of the {CRM_MODE_COPY[mode].title.toLowerCase()} line
              {view.template?.label
                ? ` (template “${view.template.label}”, v${view.template.version})`
                : ""}
              .
            </p>
          )}
          {view.template && !view.template.enabled && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
              <span className="font-medium">Template switched off. </span>
              {view.template.disabledReason}
            </p>
          )}
          {view.template && view.template.problems.length > 0 && (
            <p className="text-xs text-destructive">
              Template does not validate: {view.template.problems.join("; ")}
            </p>
          )}
          {mode && (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {LINE_REQUIREMENTS[mode].map((r) => (
                <li key={r} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {LINE_REQUIREMENT_COPY[r].title}.
                  </span>{" "}
                  {LINE_REQUIREMENT_COPY[r].detail}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Vapi custody */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4" aria-hidden /> The clone's own Vapi organisation
            </p>
            <Badge variant={TONE_VARIANT[custodyCopy.tone as Tone]}>{custodyCopy.label}</Badge>
          </div>
          <ol className="space-y-1">
            {custody.readiness.steps.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm">
                {s.done ? (
                  <CheckCircle2
                    className="mt-0.5 h-4 w-4 shrink-0 text-success"
                    aria-label="done"
                  />
                ) : s.open ? (
                  <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-label="open" />
                ) : (
                  <Circle
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-label="to do"
                  />
                )}
                <span className="min-w-0">
                  <span className={s.open ? "font-medium" : ""}>{s.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {s.blockedBy ?? s.detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {custody.lastError && <p className="text-xs text-destructive">{custody.lastError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => run("Advance", () => advanceFn({ data: { cloneId } }))}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Advance
            </Button>
            {custody.loginEmail && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run("Reveal login", async () => {
                      const r = await revealFn({ data: { cloneId } });
                      setLogin({ email: r.email, password: r.password });
                    })
                  }
                >
                  Reveal login
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    run("Read inbox", async () => {
                      const r = await inboxFn({ data: { cloneId } });
                      setInbox(r.messages);
                    })
                  }
                >
                  <Inbox className="mr-1 h-3.5 w-3.5" aria-hidden /> Read inbox
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <a href="https://dashboard.vapi.ai" target="_blank" rel="noreferrer">
                    Vapi dashboard <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden />
                  </a>
                </Button>
              </>
            )}
          </div>
          {login && (
            <div className="rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                Shown once, audited, hidden again in a minute.
              </p>
              <p>
                <span className="text-muted-foreground">Login </span>
                <code className="select-all">{login.email}</code>
              </p>
              <p>
                <span className="text-muted-foreground">Password </span>
                <code className="select-all">{login.password}</code>
              </p>
            </div>
          )}
          {inbox && (
            <div className="space-y-2 rounded-md border p-3">
              {inbox.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing has arrived for {custody.loginEmail} yet.
                </p>
              ) : (
                inbox.map((m) => (
                  <div key={m.id} className="text-sm">
                    <p className="font-medium">{m.subject ?? "(no subject)"}</p>
                    <p className="text-xs text-muted-foreground">
                      {m.from} · {new Date(m.receivedAt).toLocaleString("en-AU")}
                      {m.fromVapi ? "" : " · not from Vapi, not opened"}
                    </p>
                    {m.codes.length > 0 && (
                      <p>
                        Code: <code className="select-all text-base">{m.codes.join(" / ")}</code>
                      </p>
                    )}
                    {m.links.map((l) => (
                      <a
                        key={l}
                        href={l}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-xs underline"
                      >
                        {l}
                      </a>
                    ))}
                  </div>
                ))
              )}
            </div>
          )}
          {custody.readiness.open === "signup" && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => run("Signed up", () => signedUpFn({ data: { cloneId } }))}
            >
              I've signed up and created the organisation
            </Button>
          )}
          {(custody.readiness.open === "org_key" || custody.readiness.open === "signup") && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="vs-org-id" className="text-xs">
                  Organisation id
                </Label>
                <Input
                  id="vs-org-id"
                  value={org.orgId}
                  onChange={(e) => setOrg({ ...org, orgId: e.target.value })}
                  placeholder="Org Settings → Org ID"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vs-org-name" className="text-xs">
                  Organisation name
                </Label>
                <Input
                  id="vs-org-name"
                  value={org.orgName}
                  onChange={(e) => setOrg({ ...org, orgName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vs-org-key" className="text-xs">
                  Private API key
                </Label>
                <Input
                  id="vs-org-key"
                  type="password"
                  autoComplete="off"
                  value={org.privateKey}
                  onChange={(e) => setOrg({ ...org, privateKey: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vs-org-pub" className="text-xs">
                  Public key (optional)
                </Label>
                <Input
                  id="vs-org-pub"
                  autoComplete="off"
                  value={org.publicKey}
                  onChange={(e) => setOrg({ ...org, publicKey: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <Button
                  size="sm"
                  disabled={busy !== null || !org.orgId || !org.privateKey}
                  onClick={() =>
                    run("Verify and hold the key", async () => {
                      await recordFn({ data: { cloneId, ...org } });
                      setOrg({ orgId: "", privateKey: "", publicKey: "", orgName: "" });
                    })
                  }
                >
                  Verify and hold the key
                </Button>
              </div>
            </div>
          )}
          {custody.keyFingerprint && (
            <p className="text-xs text-muted-foreground">
              Org <code>{custody.vapiOrgId}</code>
              {custody.vapiOrgName ? ` (${custody.vapiOrgName})` : ""} · key{" "}
              {custody.keyFingerprint}
            </p>
          )}
          {custody.keyFingerprint && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                if (custody.suspendedAt)
                  return run("Resume", () => suspendFn({ data: { cloneId, suspended: false } }));
                const reason = window.prompt("Why suspend this clone's Vapi organisation?") ?? "";
                return run("Suspend", () =>
                  suspendFn({ data: { cloneId, suspended: true, reason } }),
                );
              }}
            >
              {custody.suspendedAt ? "Resume the organisation" : "Suspend the organisation"}
            </Button>
          )}
        </section>

        {/* The dependent line's GoHighLevel requirement */}
        {mode === "dependent" && !view.isLineHead && (
          <section className="space-y-3">
            <p className="text-sm font-medium">GoHighLevel — required on this line</p>
            {view.ghl ? (
              <p className="text-xs text-muted-foreground">
                Location <code>{view.ghl.locationId}</code>
                {view.ghl.locationName ? ` (${view.ghl.locationName})` : ""} · key{" "}
                {view.ghl.fingerprint} ·{" "}
                {view.ghl.verifiedAt ? (
                  "verified"
                ) : (
                  <span className="text-destructive">{view.ghl.lastError ?? "not verified"}</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No key held. The stack is not built until the tenant's GoHighLevel key and location
                are verified.
              </p>
            )}
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="vs-ghl-loc" className="text-xs">
                  Location id
                </Label>
                <Input
                  id="vs-ghl-loc"
                  value={ghl.locationId}
                  onChange={(e) => setGhl({ ...ghl, locationId: e.target.value })}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="vs-ghl-key" className="text-xs">
                  Private-integration token
                </Label>
                <Input
                  id="vs-ghl-key"
                  type="password"
                  autoComplete="off"
                  value={ghl.apiKey}
                  onChange={(e) => setGhl({ ...ghl, apiKey: e.target.value })}
                  placeholder="pit-…"
                />
              </div>
            </div>
            <Button
              size="sm"
              disabled={busy !== null || !ghl.locationId || !ghl.apiKey}
              onClick={() =>
                run("Verify GoHighLevel", async () => {
                  await ghlFn({ data: { cloneId, ...ghl } });
                  setGhl({ locationId: "", apiKey: "" });
                })
              }
            >
              Verify with GoHighLevel
            </Button>
            {view.ghl?.verifiedAt && view.ghlGrant && view.ghlGrant.state !== "authorised" && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  Make's GoHighLevel modules need a Location OAuth grant for the same location. Send
                  the link to the tenant's GoHighLevel administrator; the stack switches on by
                  itself once they authorise it.
                </p>
                {view.ghlGrant.authorisationUrl ? (
                  <a
                    href={view.ghlGrant.authorisationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm underline"
                  >
                    Open the authorisation link{" "}
                    <ExternalLink className="ml-1 inline h-3.5 w-3.5" aria-hidden />
                  </a>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-3">
                  <Input
                    aria-label="Authoriser name"
                    placeholder="Name"
                    value={authoriser.name}
                    onChange={(e) => setAuthoriser({ ...authoriser, name: e.target.value })}
                  />
                  <Input
                    aria-label="Authoriser email"
                    placeholder="Email"
                    value={authoriser.email}
                    onChange={(e) => setAuthoriser({ ...authoriser, email: e.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !authoriser.email}
                    onClick={() =>
                      run("Request the grant", () => grantFn({ data: { cloneId, ...authoriser } }))
                    }
                  >
                    {view.ghlGrant.state === "requested" ? "Request again" : "Request the grant"}
                  </Button>
                </div>
              </div>
            )}
            {view.ghlGrant?.state === "authorised" && (
              <p className="text-xs">GoHighLevel connection authorised for this location.</p>
            )}
          </section>
        )}

        {/* The tenant's business */}
        {mode && !view.isLineHead && (
          <section className="space-y-3">
            <p className="text-sm font-medium">The tenant's business</p>
            <p className="text-xs text-muted-foreground">
              The template's agents speak as the line head's business. Every word on its deny-list (
              <span className="font-mono">{view.template?.denylist.join(", ")}</span>) must be
              replaced before an assistant is created in this clone's org.
            </p>
            {stack && stack.identityResidue.length > 0 && (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                Still in the template's prose under the current replacements:{" "}
                {stack.identityResidue.join(", ")}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="vs-label" className="text-xs">
                Business label (names the agents and the stack)
              </Label>
              <Input
                id="vs-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Acme Realty"
              />
            </div>
            <div className="space-y-2">
              {replacements.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <Input
                    aria-label={`Replace ${i + 1}`}
                    value={r.from}
                    onChange={(e) =>
                      setReplacements(
                        replacements.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)),
                      )
                    }
                    placeholder="Naidu Property Consulting Services"
                  />
                  <Input
                    aria-label={`With ${i + 1}`}
                    value={r.to}
                    onChange={(e) =>
                      setReplacements(
                        replacements.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)),
                      )
                    }
                    placeholder="Acme Realty"
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setReplacements(replacements.filter((_, j) => j !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReplacements([...replacements, { from: "", to: "" }])}
                >
                  Add a replacement
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== null || label.trim().length < 2}
                  onClick={() =>
                    run("Save business details", () =>
                      identityFn({ data: { cloneId, cloneLabel: label, replacements } }),
                    )
                  }
                >
                  Save business details
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* The build */}
        {mode && !view.isLineHead && (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">The build</p>
              {stack && (
                <span className="text-xs text-muted-foreground">
                  {stack.reading.done} of {stack.reading.total} steps done
                </span>
              )}
            </div>
            {stack && stack.blocks.length > 0 && (
              <ul className="space-y-1 rounded-md border border-warning/40 bg-warning/10 p-3">
                {stack.blocks.map((b) => (
                  <li key={b.code} className="text-xs">
                    {b.message}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => run("Build now", () => buildFn({ data: { cloneId } }))}
              >
                Build now
              </Button>
              {stack && stack.status !== "parked" && mode && (
                <>
                  <Input
                    aria-label="Reason to park"
                    className="h-8 max-w-xs"
                    placeholder="Reason to park (10+ characters)"
                    value={parkReason}
                    onChange={(e) => setParkReason(e.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || parkReason.trim().length < 10}
                    onClick={() =>
                      run("Park", () =>
                        parkFn({ data: { cloneId, crmMode: mode, reason: parkReason } }),
                      )
                    }
                  >
                    Park (switch off, keep everything)
                  </Button>
                </>
              )}
            </div>
            {stack?.lastError && <p className="text-xs text-destructive">{stack.lastError}</p>}
            {stack && stack.warnings.length > 0 && (
              <ul className="space-y-1">
                {stack.warnings.map((w) => (
                  <li key={w} className="text-xs text-muted-foreground">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {stack && (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Every step
                </summary>
                <ol className="mt-2 space-y-1">
                  {stack.steps.map((s) => (
                    <li key={s.key} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <Badge
                        variant={
                          s.status === "done"
                            ? "default"
                            : s.status === "failed"
                              ? "destructive"
                              : s.status === "retrying"
                                ? "secondary"
                                : "outline"
                        }
                      >
                        {s.status === "retrying" ? `retrying (${s.attempts})` : s.status}
                      </Badge>
                      <span>{s.label}</span>
                      {s.detail && <span className="text-muted-foreground">— {s.detail}</span>}
                      {(s.status === "failed" || s.status === "retrying") && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2"
                          onClick={() =>
                            run("Retry", () => retryFn({ data: { cloneId, stepKey: s.key } }))
                          }
                        >
                          Retry
                        </Button>
                      )}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
        )}

        {view.otherLines.length > 0 && (
          <section className="space-y-1">
            <p className="text-sm font-medium">Other lines</p>
            {view.otherLines.map((o) => (
              <p key={o.crmMode} className="text-xs text-muted-foreground">
                {CRM_MODE_COPY[o.crmMode].title}:{" "}
                {isVoiceStackStatus(o.status) ? VOICE_STACK_STATUS_COPY[o.status].label : o.status}
                {o.parkedReason ? ` — ${o.parkedReason}` : ""}. Converting back resumes it.
              </p>
            ))}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
