import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { AlertTriangle, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getCloneAccess, issueCloneAccess } from "@/lib/clone-access.functions";
import { issueConfirmation, type CloneAccessState } from "@/lib/cloneAccessCredentials.pure";

type Issued = { password: string; email: string; signInUrl: string | null; detail: string };

/**
 * The operator login for this clone — for auditing it before it ships, and for
 * handing it to the client.
 *
 * It ISSUES rather than reveals, and the panel says so in those words. Nothing
 * stores a clone's admin password: `queued_admin_password_enc` is cleared on
 * every terminal outcome, deliberately, so there is no original to recall. See
 * `cloneAccessCredentials.pure.ts`.
 */
export function CloneAccessCredentialsCard({ cloneId }: { cloneId: string }) {
  const readFn = useServerFn(getCloneAccess);
  const issueFn = useServerFn(issueCloneAccess);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-access", cloneId],
    queryFn: async () => readFn({ data: { cloneId } }),
  });

  const state: CloneAccessState | null = data?.ok ? data.state : null;
  const readError = data && !data.ok ? data.error : null;
  const confirmation = state ? issueConfirmation(state) : null;

  async function issue() {
    if (!confirmation) return;
    if (!window.confirm(confirmation)) return;
    setBusy(true);
    setIssued(null);
    try {
      const res = await issueFn({ data: { cloneId } });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setIssued({
        password: res.password,
        email: res.email,
        signInUrl: res.signInUrl,
        detail: res.detail,
      });
      toast.success("Credentials issued — copy them now, they cannot be shown again.");
      void refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" aria-hidden /> Access credentials
        </CardTitle>
        <CardDescription>
          A working administrator login for this clone — for auditing it, and for handing it over.
          Issuing SETS a new password and shows it once; nothing here can recall a password that was
          set earlier, because none is ever stored.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

        {readError && (
          <p className="text-xs text-destructive">Could not read the access state: {readError}</p>
        )}

        {state && state.kind !== "ready" && (
          <p className="text-xs text-muted-foreground">{state.reason}</p>
        )}

        {state?.kind === "ready" && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="text-muted-foreground">Administrator</span>
              <span className="inline-flex items-center gap-1 font-mono">
                {state.adminEmail}
                <CopyButton value={state.adminEmail} label="administrator address" />
              </span>
              {state.rotates ? (
                <Badge variant="secondary">Issued before</Badge>
              ) : (
                <Badge variant="outline">Never issued</Badge>
              )}
            </div>

            {state.lastIssuedAt && (
              <p className="text-xs text-muted-foreground">
                Last issued {new Date(state.lastIssuedAt).toLocaleString("en-AU")}.
              </p>
            )}

            {state.rotates && (
              <p className="flex items-start gap-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  Issuing again replaces the current password. Anyone still using the previous one —
                  including a client you have already handed it to — is locked out until you send
                  them the new one.
                </span>
              </p>
            )}

            <Button onClick={issue} disabled={busy}>
              <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
              {busy ? "Issuing…" : state.rotates ? "Issue new credentials" : "Issue credentials"}
            </Button>
          </>
        )}

        {issued && (
          <div className="space-y-3 rounded-md border border-warning/40 bg-warning/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="h-4 w-4 text-success" aria-hidden />
              Shown once — copy it now
            </p>
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Email</dt>
                <dd className="inline-flex items-center gap-1 font-mono">
                  {issued.email}
                  <CopyButton value={issued.email} label="email" />
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Password</dt>
                <dd className="inline-flex items-center gap-1 break-all font-mono">
                  {issued.password}
                  <CopyButton value={issued.password} label="password" />
                </dd>
              </div>
              {issued.signInUrl && (
                <div className="flex flex-wrap items-center gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">Sign in</dt>
                  <dd className="inline-flex items-center gap-1">
                    <a
                      className="inline-flex items-center gap-1 underline"
                      href={issued.signInUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {issued.signInUrl}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                    <CopyButton value={issued.signInUrl} label="sign-in URL" />
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-muted-foreground">
              {issued.detail} This password is not stored by Mission Control and cannot be shown
              again — issue new credentials if it is lost.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
