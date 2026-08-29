import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { CheckCircle2, Circle, CircleDot, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  getCloneTurnstileIdentity,
  probeCloneTurnstileAccess,
  provisionCloneTurnstile,
  refreshCloneTurnstile,
  revokeCloneTurnstile,
  rotateCloneTurnstileSecret,
} from "@/lib/turnstile-identity.functions";

type StepState = "done" | "open" | "blocked";
type Step = { id: string; state: StepState; detail: string };

const STEP_LABEL: Record<string, string> = {
  cloudflare: "Cloudflare configured",
  widget: "Own Turnstile widget",
  secret_written: "Secret on the clone",
  site_key_published: "Site key in the build",
  fail_closed: "Fails closed",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (state === "open") return <CircleDot className="h-4 w-4 text-info" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />;
}

/**
 * The clone's own CAPTCHA identity.
 *
 * A clone must never render the prime's Turnstile widget: a token is bound to
 * a (site key, secret) pair and no login handler here checks the hostname
 * `siteverify` reports, so one shared widget lets a token farmed from any
 * tenant's login page satisfy the CAPTCHA on every other tenant.
 */
export function CloneTurnstileCard({ cloneId }: { cloneId: string }) {
  const loadFn = useServerFn(getCloneTurnstileIdentity);
  const provisionFn = useServerFn(provisionCloneTurnstile);
  const refreshFn = useServerFn(refreshCloneTurnstile);
  const rotateFn = useServerFn(rotateCloneTurnstileSecret);
  const revokeFn = useServerFn(revokeCloneTurnstile);

  const [busy, setBusy] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-turnstile-identity", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
  });

  // The identity state reports whether the token EXISTS. That is the wrong
  // question, and answering it is how a configured token still read "not
  // configured" — and how a token scoped for DNS would have read "Connected"
  // right up until the button failed. This probe asks Cloudflare whether this
  // deployment can actually list Turnstile widgets, which is the capability
  // minting one needs.
  const probeFn = useServerFn(probeCloneTurnstileAccess);
  const tokenQ = useQuery({
    queryKey: ["turnstile-access-probe"],
    queryFn: async () => probeFn(),
    staleTime: 60_000,
  });

  const state = data?.ok ? data : null;
  const row = state?.row ?? null;
  const steps: Step[] = state?.readiness.steps ?? [];
  const live = state?.readiness.live ?? false;
  const tokenPresent = tokenQ.data?.tokenPresent ?? state?.cloudflareConfigured ?? false;
  const tokenError = tokenQ.data?.error ?? null;
  const accountConfigured = tokenQ.data?.accountConfigured ?? state?.accountConfigured ?? false;
  // Usable, not merely present. A token Cloudflare refuses mints nothing, and
  // enabling the buttons for it produces an opaque vendor error on click.
  const cloudflareReady = Boolean(tokenQ.data?.canMint);

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res.ok) toast.success(`${label} — done`);
      else toast.error(res.error ?? `${label} failed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      await refetch();
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" aria-hidden /> Sign-in CAPTCHA
            </CardTitle>
            <CardDescription>
              This clone's own Cloudflare Turnstile widget. Never the prime's — a shared widget lets
              a token farmed from one tenant's login page satisfy the check on every other.
            </CardDescription>
          </div>
          {live ? (
            <Badge variant="default">Own widget live</Badge>
          ) : row?.site_key ? (
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
            {/*
              The Cloudflare reading, always shown rather than only on failure.
              "Nothing about Cloudflare on the clone's page" is what made a
              configured token look unconfigured: absence of a statement reads
              as a negative one.
            */}
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Cloudflare account</span>
              {tokenQ.isLoading ? (
                <span className="text-muted-foreground">Checking…</span>
              ) : cloudflareReady ? (
                <Badge variant="default">Connected</Badge>
              ) : tokenPresent && !accountConfigured ? (
                <Badge variant="secondary">No account id</Badge>
              ) : tokenPresent ? (
                <Badge variant="destructive">Token cannot mint</Badge>
              ) : (
                <Badge variant="outline">No token</Badge>
              )}
            </div>

            {!cloudflareReady && !tokenQ.isLoading && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
                {!tokenPresent ? (
                  <>
                    <p className="font-medium">Mission Control has no Cloudflare token</p>
                    <p className="text-muted-foreground">
                      Set <code>CLOUDFLARE_API_TOKEN</code> in this deployment's own environment —
                      not the clone's. The name is read exactly; a secret stored under any other
                      name reads here as no token at all.
                    </p>
                  </>
                ) : accountConfigured ? (
                  <>
                    <p className="font-medium">The token cannot reach Turnstile</p>
                    <p className="text-muted-foreground">
                      Cloudflare has the token and will not serve Turnstile with it
                      {tokenError ? `: ${tokenError}` : "."} Minting a widget needs{" "}
                      <strong>Account · Turnstile: Edit</strong>. The scopes this deployment was set
                      up with — Zone Read, Zone Settings Edit, Analytics Read — verify as an active
                      token and refuse this, which is why the check is the capability rather than
                      the token.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">No Cloudflare account id</p>
                    <p className="text-muted-foreground">
                      A Turnstile widget is created against an account, so
                      <code> cloudflare_account_id</code> must be set in the hosting configuration.
                    </p>
                  </>
                )}
                <p className="mt-1 text-muted-foreground">
                  Until then this clone keeps whatever secret it already has.
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

            {row?.site_key && (
              <p className="text-xs text-muted-foreground">
                Site key{" "}
                <span className="inline-flex items-center gap-1 font-mono">
                  {row.site_key} <CopyButton value={row.site_key} />
                </span>
                {row.secret_last4 ? ` · secret …${row.secret_last4}` : ""}
                {row.domains?.length ? ` · ${row.domains.join(", ")}` : ""}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || !cloudflareReady}
                onClick={() => run("Provision", () => provisionFn({ data: { cloneId } }))}
              >
                {row?.site_key ? "Advance" : "Provision own widget"}
              </Button>
              {row?.site_key && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !cloudflareReady}
                    onClick={() => run("Re-check", () => refreshFn({ data: { cloneId } }))}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden /> Re-check
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !cloudflareReady}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Rotate this widget's secret? The old one stops verifying immediately, and the new one is written to the clone in the same step.",
                        )
                      )
                        return;
                      void run("Rotate secret", () => rotateFn({ data: { cloneId } }));
                    }}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" aria-hidden /> Rotate secret
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={busy || !cloudflareReady}
                    onClick={() => {
                      if (
                        !window.confirm(
                          "Delete this clone's Turnstile widget? Its secret stops verifying, and sign-in then depends on REQUIRE_TURNSTILE.",
                        )
                      )
                        return;
                      void run("Revoke", () => revokeFn({ data: { cloneId } }));
                    }}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
