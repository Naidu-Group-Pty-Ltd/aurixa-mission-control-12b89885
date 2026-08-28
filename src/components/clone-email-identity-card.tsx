import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { CheckCircle2, Circle, CircleDot, KeyRound, Mail, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  alignCloneSender,
  checkCloneEmailIdentity,
  getCloneEmailIdentity,
  provisionCloneEmailIdentity,
  revokeCloneEmailIdentity,
  rotateCloneEmailKey,
} from "@/lib/email-identity.functions";

type StepState = "done" | "open" | "blocked";
type Step = { id: string; state: StepState; detail: string };
type DnsRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
};

const STEP_LABEL: Record<string, string> = {
  master_key: "Platform master key",
  domain: "Sending domain",
  dns: "DNS records",
  verified: "Domain verified",
  key_written: "Clone key written",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (state === "open") return <CircleDot className="h-4 w-4 text-info" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />;
}

/**
 * The clone's dedicated email identity: its own sending domain at Resend and
 * its own domain-scoped key, replacing the inherited prime key whose rotation
 * once took every clone's outbound mail down at once.
 *
 * The card leads with the PATH — five ordered steps, exactly one open — so an
 * operator always knows the next act rather than deciphering a status word.
 * DNS records render with copy buttons whenever the operator (not Mission
 * Control) has to install them.
 */
export function CloneEmailIdentityCard({ cloneId }: { cloneId: string }) {
  const loadFn = useServerFn(getCloneEmailIdentity);
  const provisionFn = useServerFn(provisionCloneEmailIdentity);
  const checkFn = useServerFn(checkCloneEmailIdentity);
  const rotateFn = useServerFn(rotateCloneEmailKey);
  const revokeFn = useServerFn(revokeCloneEmailIdentity);
  const alignFn = useServerFn(alignCloneSender);

  const [busy, setBusy] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-email-identity", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
  });

  const state = data?.ok ? data : null;
  const row = state?.row ?? null;
  const steps: Step[] = state?.readiness.steps ?? [];
  const live = state?.readiness.live ?? false;
  const next = state?.readiness.next ?? null;
  const resendConfigured = state?.resendConfigured ?? false;
  const records: DnsRecord[] = (row?.dns_records ?? []) as DnsRecord[];
  const showRecords =
    records.length > 0 &&
    row?.dns_installed_via !== "cloudflare" &&
    row?.domain_status !== "verified";

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(label);
    try {
      const res = await fn();
      if (res.ok) toast.success(`${label} — done`);
      else toast.error(res.error ?? `${label} failed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await refetch();
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4" aria-hidden /> Email identity
            </CardTitle>
            <CardDescription>
              This clone's own Resend sending domain and domain-scoped key — outbound mail that does
              not depend on the prime's shared credential.
            </CardDescription>
          </div>
          {live ? (
            <Badge variant="default">Dedicated key live</Badge>
          ) : row ? (
            <Badge variant="secondary">In progress</Badge>
          ) : (
            <Badge variant="outline">Not provisioned</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data?.ok ? (
          <p className="text-sm text-destructive">{data?.error ?? "Could not load the identity"}</p>
        ) : (
          <>
            {!resendConfigured && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="font-medium">Platform master key not configured yet</p>
                <p className="text-muted-foreground">
                  Add <code>RESEND_MASTER_API_KEY</code> (a full-access key on the platform's Resend
                  team) to Mission Control's own environment. Everything below stays ready and picks
                  up from this step — clones only ever receive sending-only keys scoped to their own
                  domain, never this one.
                </p>
              </div>
            )}

            <ol className="space-y-2">
              {steps.map((s) => (
                <li key={s.id} className="flex items-start gap-2 text-sm">
                  <StepIcon state={s.state} />
                  <div>
                    <span
                      className={s.state === "blocked" ? "text-muted-foreground" : "font-medium"}
                    >
                      {STEP_LABEL[s.id] ?? s.id}
                    </span>{" "}
                    <span className="text-muted-foreground">— {s.detail}</span>
                  </div>
                </li>
              ))}
            </ol>

            {row?.last_error && (
              <p className="text-sm text-destructive">Last error: {row.last_error}</p>
            )}

            {!row && (
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground" htmlFor="sending-domain">
                    Sending domain
                  </label>
                  <Input
                    id="sending-domain"
                    placeholder={state?.suggestedDomain ?? "send.your-clone-domain.com.au"}
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                  />
                </div>
              </div>
            )}

            {showRecords && (
              <div className="space-y-1">
                <p className="text-sm font-medium">DNS records to install</p>
                <p className="text-xs text-muted-foreground">
                  {row?.dns_installed_via === "manual"
                    ? "Install these at the domain's DNS host, then re-check."
                    : "These will be written automatically when the clone has a managed Cloudflare zone; otherwise install them at the DNS host."}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">Type</th>
                        <th className="py-1 pr-2 font-medium">Name</th>
                        <th className="py-1 pr-2 font-medium">Value</th>
                        <th className="py-1 pr-2 font-medium">Priority</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.map((r, i) => (
                        <tr key={`${r.name}-${r.type}-${i}`} className="border-t border-border/50">
                          <td className="py-1 pr-2 font-mono">{r.type}</td>
                          <td className="py-1 pr-2 font-mono">
                            <span className="inline-flex items-center gap-1">
                              {r.name} <CopyButton value={r.name} />
                            </span>
                          </td>
                          <td className="max-w-[16rem] truncate py-1 pr-2 font-mono">
                            <span className="inline-flex max-w-full items-center gap-1">
                              <span className="truncate">{r.value}</span>
                              <CopyButton value={r.value} />
                            </span>
                          </td>
                          <td className="py-1 pr-2 font-mono">{r.priority ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {row?.key_written_at && (
              <p className="text-xs text-muted-foreground">
                Key …{row.key_last4} written {new Date(row.key_written_at).toLocaleString()} as{" "}
                <code>RESEND_API_KEY</code>. Sender: <code>{row.default_from_address ?? "—"}</code>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy !== null || !resendConfigured}
                onClick={() =>
                  run("Provision", () =>
                    provisionFn({
                      data: {
                        cloneId,
                        ...(domainInput.trim() ? { sendingDomain: domainInput.trim() } : {}),
                      },
                    }),
                  )
                }
              >
                {row ? "Advance" : "Provision"}
              </Button>
              {row && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !resendConfigured}
                  onClick={() => run("Re-check", () => checkFn({ data: { cloneId } }))}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Re-check
                </Button>
              )}
              {row?.domain_status === "verified" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !resendConfigured}
                  onClick={() => run("Rotate key", () => rotateFn({ data: { cloneId } }))}
                >
                  <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden /> Rotate key
                </Button>
              )}
              {row?.domain_status === "verified" && next === null && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => run("Align sender", () => alignFn({ data: { cloneId } }))}
                >
                  Align sender address
                </Button>
              )}
              {row && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy !== null || !resendConfigured}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Revoke this clone's sending key at Resend? Outbound mail stops until a new identity is provisioned.",
                      )
                    )
                      return;
                    void run("Revoke", () => revokeFn({ data: { cloneId, deleteDomain: false } }));
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
