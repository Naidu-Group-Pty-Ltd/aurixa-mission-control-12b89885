/**
 * One workspace's mobile apps: its gateway, its six release subscriptions,
 * and every grant — who may hold which app, on which device.
 *
 * The page does three things and only three: grant access, issue a link, and
 * revoke. Each goes through the same server function the gateway itself uses,
 * so nothing here can produce a state the gateway would refuse.
 *
 * A provisioned URL is shown ONCE, in the answer to the click that minted it,
 * because it carries a live activation ticket and Mission Control keeps only
 * the ticket's hash. A magic link is never shown to anybody: it is emailed to
 * the grant's own address, and that is the whole point of it.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Link2, Mail, RefreshCcw, ShieldOff, Smartphone, UserPlus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createMobileGrant,
  getCloneMobile,
  issueMobileLink,
  repairMobileGateway,
  revokeMobileGrant,
} from "@/lib/mobile.functions";
import { MOBILE_PORTALS, PORTAL_APPS, isMobilePortal } from "@/lib/mobile/portals.pure";

export const Route = createFileRoute("/clones/$cloneId/mobile")({
  head: () => ({ meta: [{ title: "Mobile apps · Aurixa Mission Control" }] }),
  component: CloneMobilePage,
});

/** Gateway refusals say `message`; a repair refusal says `error`. Both reach the toast. */
type Refusal = { ok: false; message?: string; error?: string };
const isRefusal = (v: unknown): v is Refusal =>
  typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

function portalLabel(p: string): string {
  return isMobilePortal(p) ? PORTAL_APPS[p].label : p;
}

const STATUS_WORD: Record<
  string,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  issuable: { label: "No link yet", variant: "outline" },
  active: { label: "Link sent", variant: "secondary" },
  device_bound: { label: "On a device", variant: "default" },
  revoked: { label: "Revoked", variant: "destructive" },
};

function CloneMobilePage() {
  const { cloneId } = Route.useParams();
  const getFn = useServerFn(getCloneMobile);
  const createFn = useServerFn(createMobileGrant);
  const issueFn = useServerFn(issueMobileLink);
  const revokeFn = useServerFn(revokeMobileGrant);
  const repairFn = useServerFn(repairMobileGateway);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["clone-mobile", cloneId],
    queryFn: () => getFn({ data: { cloneId } }),
  });

  const [busy, setBusy] = useState<string | null>(null);
  const [newPortal, setNewPortal] = useState<string>("command-centre");
  const [newEmail, setNewEmail] = useState("");
  const [shownLink, setShownLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [reason, setReason] = useState("");

  async function act<T>(
    key: string,
    fn: () => Promise<T>,
    done: (r: Exclude<T, { ok: false }>) => void,
  ) {
    setBusy(key);
    try {
      const r = await fn();
      if (isRefusal(r)) toast.error(r.message ?? r.error ?? "Refused.");
      else done(r as Exclude<T, { ok: false }>);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const gateway = data?.gateway;
  const grants = data?.grants;
  const subs = data?.subscriptions;

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 basis-80 flex-1">
            <div className="text-sm text-muted-foreground">
              <Link to="/clones/$cloneId" params={{ cloneId }}>
                ← Back to clone
              </Link>
            </div>
            <h1 className="font-display text-[1.75rem] leading-[1.1]">
              Mobile apps{data?.cloneName ? ` · ${data.cloneName}` : ""}
            </h1>
            <p className="text-sm text-muted-foreground">
              No app is listed on any store. Access is a link from mobile.aurixasystems.com.au,
              minted here, and each link works once.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={busy === "repair"}
            onClick={() =>
              act(
                "repair",
                () => repairFn({ data: { cloneId } }),
                (r) =>
                  toast.success(
                    r.changed ? "Gateway wiring repaired." : "Gateway already complete.",
                  ),
              )
            }
          >
            <RefreshCcw className="mr-1.5 h-4 w-4" /> Check wiring
          </Button>
        </div>

        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && (
          <p className="text-sm text-destructive">
            The mobile state could not be read:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {gateway && (
          <section className="glass space-y-2 rounded-lg p-4">
            <h2 className="font-medium">Gateway</h2>
            {gateway.error ? (
              <p className="text-sm text-destructive">Could not be read: {gateway.error}</p>
            ) : !gateway.rows ? (
              <p className="text-sm text-muted-foreground">
                This workspace has no gateway yet. It is wired when its backend is provisioned, and
                the half-hourly sweep wires any that were born before. Use “Check wiring” to run it
                now.
              </p>
            ) : (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <dt className="text-muted-foreground">Gateway id</dt>
                <dd className="font-mono">{gateway.rows.gateway_id}</dd>
                <dt className="text-muted-foreground">Credential</dt>
                <dd className="font-mono">{gateway.rows.credential_prefix}…</dd>
                <dt className="text-muted-foreground">Delivered to</dt>
                <dd className="font-mono">
                  {gateway.rows.delivered_project_ref ?? "not yet delivered"}
                </dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{gateway.rows.status}</dd>
                <dt className="text-muted-foreground">Licensed apps</dt>
                <dd>{gateway.rows.licensed_portals.map(portalLabel).join(", ")}</dd>
                <dt className="text-muted-foreground">Last asked for an update</dt>
                <dd>{when(gateway.rows.last_seen_at)}</dd>
              </dl>
            )}
            {subs && (
              <div className="pt-2 text-sm">
                <span className="text-muted-foreground">Release subscriptions: </span>
                {subs.error !== null ? (
                  <span className="text-destructive">could not be read — {subs.error}</span>
                ) : subs.rows.length === 0 ? (
                  <span>none</span>
                ) : (
                  subs.rows.map((s) => (
                    <Badge
                      key={s.portal}
                      variant={s.enabled ? "secondary" : "outline"}
                      className="mr-1"
                    >
                      {portalLabel(s.portal)} · {s.channel}
                      {s.enabled ? "" : " · off"}
                    </Badge>
                  ))
                )}
              </div>
            )}
          </section>
        )}

        <section className="glass space-y-3 rounded-lg p-4">
          <h2 className="font-medium">Grant access</h2>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                "create",
                () => createFn({ data: { cloneId, portal: newPortal, email: newEmail } }),
                (r) => {
                  toast.success(r.existed ? "That person already has a grant." : "Access granted.");
                  setNewEmail("");
                },
              );
            }}
          >
            <label className="text-sm">
              <span className="block text-muted-foreground">App</span>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={newPortal}
                onChange={(e) => setNewPortal(e.target.value)}
              >
                {MOBILE_PORTALS.map((p) => (
                  <option key={p} value={p}>
                    {PORTAL_APPS[p].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-0 flex-1 basis-60 text-sm">
              <span className="block text-muted-foreground">Their email</span>
              <Input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="person@business.com.au"
              />
            </label>
            <Button type="submit" disabled={!newEmail.trim() || busy === "create"}>
              <UserPlus className="mr-1.5 h-4 w-4" /> Grant
            </Button>
          </form>
        </section>

        <section className="space-y-2">
          <h2 className="font-medium">Grants</h2>
          {grants && grants.error !== null && (
            <p className="text-sm text-destructive">Could not be read: {grants.error}</p>
          )}
          {grants && grants.error === null && grants.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">Nobody has been granted an app yet.</p>
          )}
          {grants &&
            grants.error === null &&
            grants.rows.map((g) => {
              const st = STATUS_WORD[g.status] ?? { label: g.status, variant: "outline" as const };
              const live = g.status !== "revoked";
              return (
                <div key={g.id} className="glass flex flex-wrap items-start gap-3 rounded-lg p-3">
                  <Smartphone className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1 basis-64 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{portalLabel(g.portal)}</span>
                      <Badge variant={st.variant}>{st.label}</Badge>
                      <span className="text-muted-foreground">{g.principal_kind}</span>
                    </div>
                    <div className="truncate">{g.principal_email ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">
                      {g.bound_at ? `On a device since ${when(g.bound_at)}` : "No device yet"}
                      {g.latest_ticket &&
                        ` · last link ${g.latest_ticket.kind === "magic_link" ? "emailed" : "provisioned"} ${when(
                          g.latest_ticket.created_at,
                        )}${g.latest_ticket.consumed_at ? ", used" : `, expires ${when(g.latest_ticket.expires_at)}`}`}
                      {g.revoked_reason && ` · revoked: ${g.revoked_reason}`}
                    </div>
                  </div>
                  {live && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === `url:${g.id}`}
                        onClick={() =>
                          act(
                            `url:${g.id}`,
                            () =>
                              issueFn({
                                data: { cloneId, grantId: g.id, kind: "provisioned_url" },
                              }),
                            (r) => {
                              if (r.link) setShownLink({ link: r.link, expiresAt: r.expiresAt });
                              if (r.reissued) toast.info("The old device was signed out.");
                            },
                          )
                        }
                      >
                        <Link2 className="mr-1.5 h-4 w-4" /> Provisioned link
                      </Button>
                      {g.principal_email && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === `mail:${g.id}`}
                          onClick={() =>
                            act(
                              `mail:${g.id}`,
                              () =>
                                issueFn({ data: { cloneId, grantId: g.id, kind: "magic_link" } }),
                              (r) =>
                                toast.success(
                                  `Emailed to ${r.emailedTo}. It works once, for 15 minutes.${
                                    r.reissued ? " The old device was signed out." : ""
                                  }`,
                                ),
                            )
                          }
                        >
                          <Mail className="mr-1.5 h-4 w-4" /> Email link
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          setReason("");
                          setRevoking({
                            id: g.id,
                            label: `${portalLabel(g.portal)} · ${g.principal_email ?? g.grant_ref}`,
                          });
                        }}
                      >
                        <ShieldOff className="mr-1.5 h-4 w-4" /> Revoke
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
        </section>
      </div>

      <Dialog open={shownLink !== null} onOpenChange={(o) => !o && setShownLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Provisioned link</DialogTitle>
            <DialogDescription>
              Shown once — Mission Control keeps only its hash. It works once, until{" "}
              {when(shownLink?.expiresAt)}. Send it to the person by a channel you trust.
            </DialogDescription>
          </DialogHeader>
          <Input readOnly value={shownLink?.link ?? ""} onFocus={(e) => e.currentTarget.select()} />
          <DialogFooter>
            <Button
              onClick={async () => {
                if (!shownLink) return;
                await navigator.clipboard.writeText(shownLink.link);
                toast.success("Copied.");
              }}
            >
              <Copy className="mr-1.5 h-4 w-4" /> Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke access</DialogTitle>
            <DialogDescription>
              {revoking?.label}. Any unused link stops working now, and the device is signed out
              within fifteen minutes. The record is kept.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why (at least ten characters)"
          />
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 10 || busy === "revoke"}
              onClick={() =>
                revoking &&
                act(
                  "revoke",
                  () => revokeFn({ data: { cloneId, grantId: revoking.id, reason } }),
                  () => {
                    toast.success("Revoked.");
                    setRevoking(null);
                  },
                )
              }
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
