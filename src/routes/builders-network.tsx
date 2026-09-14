import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Building2, Cable, CheckCircle2, Copy, Inbox, KeyRound, Loader2,
  PauseCircle, PlayCircle, Plug, RefreshCw, ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  buildersNetworkStatus,
  listNetworkOrganisations,
  listNetworkJoinRequests,
  listShadowConnections,
  listClonesForNetwork,
  approveNetworkOrganisation,
  suspendNetworkOrganisation,
  reinstateNetworkOrganisation,
  registerWorkspaceOnNetwork,
  createNetworkConnection,
  revokeNetworkConnection,
  setNetworkConnectionTransport,
  type NetworkOrganisation,
} from "@/server/builders-network.functions";

/**
 * The Builders Network operator console (extraction plan §5).
 *
 * Deliberately at /builders-network — never /modules/builder, which is the
 * unrelated Module Builder entitlement. Every mutation travels to the
 * NETWORK's admin API as a federation-asserted call; MC holds no network
 * service-role key, and the NULL-clone builders:operate key row is the
 * revocable switch the status strip reads. Approving an organisation also
 * ensures its per-organisation tenant (plan §10: metering identity is per
 * builder organisation), so the ledger exists from the day of approval.
 */
export const Route = createFileRoute("/builders-network")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <BuildersNetworkConsole />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Builders Network — Aurixa Systems Mission Control" }] }),
});

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending_verification: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  pending_activation: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  suspended: "bg-red-500/15 text-red-600 dark:text-red-400",
  closed: "bg-muted text-muted-foreground",
  invited: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  revoked: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function StatusBadge({ value }: { value: string }) {
  return (
    <Badge variant="outline" className={STATUS_TONE[value] ?? ""}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}

function BuildersNetworkConsole() {
  const queryClient = useQueryClient();
  const statusFn = useServerFn(buildersNetworkStatus);
  const orgsFn = useServerFn(listNetworkOrganisations);
  const joinsFn = useServerFn(listNetworkJoinRequests);
  const shadowFn = useServerFn(listShadowConnections);
  const clonesFn = useServerFn(listClonesForNetwork);
  const approveFn = useServerFn(approveNetworkOrganisation);
  const suspendFn = useServerFn(suspendNetworkOrganisation);
  const reinstateFn = useServerFn(reinstateNetworkOrganisation);
  const registerFn = useServerFn(registerWorkspaceOnNetwork);
  const createConnFn = useServerFn(createNetworkConnection);
  const revokeConnFn = useServerFn(revokeNetworkConnection);
  const transportFn = useServerFn(setNetworkConnectionTransport);

  const status = useQuery({ queryKey: ["bn-status"], queryFn: () => statusFn() });
  const organisations = useQuery({ queryKey: ["bn-orgs"], queryFn: () => orgsFn({ data: {} }) });
  const joins = useQuery({ queryKey: ["bn-joins"], queryFn: () => joinsFn() });
  const shadow = useQuery({ queryKey: ["bn-shadow"], queryFn: () => shadowFn() });
  const clones = useQuery({ queryKey: ["bn-clones"], queryFn: () => clonesFn() });

  const [busyOrg, setBusyOrg] = useState<string | null>(null);
  const [connClone, setConnClone] = useState("");
  const [connOrg, setConnOrg] = useState("");
  const [creatingConn, setCreatingConn] = useState(false);
  const [mintedInvite, setMintedInvite] = useState<{ code: string; expires: string } | null>(null);
  const [transportDrafts, setTransportDrafts] = useState<Record<string, string>>({});

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["bn-status"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-orgs"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-joins"] });
    void queryClient.invalidateQueries({ queryKey: ["bn-shadow"] });
  };

  const act = async (organisation: NetworkOrganisation, action: "approve" | "suspend" | "reinstate") => {
    setBusyOrg(organisation.id);
    try {
      if (action === "approve") {
        const result = await approveFn({
          data: { organisationId: organisation.id, legalName: organisation.legal_name },
        });
        if (!result.ok) throw new Error(result.error);
        toast.success(
          result.tenant.ok
            ? `${organisation.legal_name} approved — metering tenant ready`
            : `${organisation.legal_name} approved — TENANT FAILED: ${result.tenant.error}`,
        );
      } else if (action === "suspend") {
        const reason = window.prompt(`Reason for suspending ${organisation.legal_name}?`)?.trim();
        if (!reason) return;
        const result = await suspendFn({ data: { organisationId: organisation.id, reason } });
        if (!result.ok) throw new Error(result.error);
        toast.success(`${organisation.legal_name} suspended`);
      } else {
        const result = await reinstateFn({ data: { organisationId: organisation.id } });
        if (!result.ok) throw new Error(result.error);
        toast.success(`${organisation.legal_name} reinstated`);
      }
      refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The network refused the action");
    } finally {
      setBusyOrg(null);
    }
  };

  const createConnection = async () => {
    if (!connClone || !connOrg) {
      toast.error("Choose a workspace and an organisation");
      return;
    }
    setCreatingConn(true);
    try {
      // The directory row travels first, so the network can resolve the clone.
      const registered = await registerFn({ data: { cloneId: connClone } });
      if (!registered.ok) throw new Error(registered.error);
      const result = await createConnFn({
        data: { cloneId: connClone, builderOrganisationId: connOrg },
      });
      if (!result.ok) throw new Error(result.error);
      setMintedInvite({ code: result.invite_code, expires: result.expires_at });
      refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The connection could not be created");
    } finally {
      setCreatingConn(false);
    }
  };

  const gate = status.data?.switch;
  const overview = status.data?.overview;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="Platform"
        title="Builders Network"
        description="Vet organisations, mint workspace connections and watch the sync plane of builders.aurixasystems.com.au."
        icon={<Building2 className="h-5 w-5" aria-hidden />}
        actions={
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Refresh
          </Button>
        }
      />

      {/* ---------------------------------------------------------- status */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <KeyRound className="h-4 w-4 text-primary" aria-hidden /> Operate switch
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {status.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : gate?.enabled ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
                <span>Live NULL-clone key{gate.label ? ` — ${gate.label}` : ""}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-red-500">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <span>
                  {status.data?.switch && !status.data.switch.enabled && status.data.switch.reason === "read_failed"
                    ? "Key read failed"
                    : "No live builders:operate key — mint a NULL-clone key to enable this console"}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Plug className="h-4 w-4 text-primary" aria-hidden /> Network endpoint
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {status.data?.network_url_configured
              ? <span className="text-emerald-600 dark:text-emerald-400">BUILDERS_NETWORK_ADMIN_URL configured</span>
              : <span className="text-red-500">Set BUILDERS_NETWORK_ADMIN_URL to the network's builder-network-admin function</span>}
            {status.data?.overview_error && (
              <p className="mt-1 text-xs text-muted-foreground">Last call: {status.data.overview_error}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4 text-primary" aria-hidden /> Network counts
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {overview ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(overview.organisations).map(([key, count]) => (
                  <span key={`o-${key}`}>{key.replaceAll("_", " ")}: <strong>{count}</strong></span>
                ))}
                <span>join requests: <strong>{overview.pending_join_requests}</strong></span>
                <span>dead letters: <strong className={overview.dead_letters ? "text-red-500" : ""}>{overview.dead_letters}</strong></span>
              </div>
            ) : (
              <span className="text-muted-foreground">Not available</span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* --------------------------------------------------- organisations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organisations</CardTitle>
        </CardHeader>
        <CardContent>
          {organisations.isLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : !organisations.data?.ok ? (
            <EmptyState
              icon={<ShieldAlert className="h-8 w-8" aria-hidden />}
              title="The network could not be read"
              description={organisations.data?.error ?? "Unknown error"}
            />
          ) : organisations.data.organisations.length === 0 ? (
            <EmptyState icon={<Building2 className="h-5 w-5" aria-hidden />} title="No organisations yet" description="Registrations appear here for vetting." />
          ) : (
            <div className="divide-y divide-border">
              {organisations.data.organisations.map((organisation) => (
                <div key={organisation.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="truncate font-medium">{organisation.legal_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {organisation.org_type.replaceAll("_", " ")}
                      {organisation.abn ? ` · ABN ${organisation.abn}` : ""}
                      {organisation.state ? ` · ${organisation.state}` : ""}
                      {organisation.contact_email ? ` · ${organisation.contact_email}` : ""}
                    </p>
                    {organisation.suspension_reason && (
                      <p className="truncate text-xs text-red-500">Suspended: {organisation.suspension_reason}</p>
                    )}
                  </div>
                  <StatusBadge value={organisation.status} />
                  <div className="flex gap-2">
                    {(organisation.status === "pending_verification" || organisation.status === "pending_activation") && (
                      <Button size="sm" disabled={busyOrg === organisation.id} onClick={() => void act(organisation, "approve")}>
                        {busyOrg === organisation.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="mr-1 h-4 w-4" aria-hidden />}
                        Approve
                      </Button>
                    )}
                    {organisation.status === "active" && (
                      <Button size="sm" variant="outline" disabled={busyOrg === organisation.id} onClick={() => void act(organisation, "suspend")}>
                        <PauseCircle className="mr-1 h-4 w-4" aria-hidden /> Suspend
                      </Button>
                    )}
                    {organisation.status === "suspended" && (
                      <Button size="sm" variant="outline" disabled={busyOrg === organisation.id} onClick={() => void act(organisation, "reinstate")}>
                        <PlayCircle className="mr-1 h-4 w-4" aria-hidden /> Reinstate
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ----------------------------------------------------- connections */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace connections</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Workspace (clone)</p>
              <Select value={connClone} onValueChange={setConnClone}>
                <SelectTrigger><SelectValue placeholder="Choose a workspace…" /></SelectTrigger>
                <SelectContent>
                  {(clones.data?.ok ? clones.data.clones : []).map((clone) => (
                    <SelectItem key={clone.id} value={clone.id}>{clone.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-64 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Builder organisation</p>
              <Select value={connOrg} onValueChange={setConnOrg}>
                <SelectTrigger><SelectValue placeholder="Choose an organisation…" /></SelectTrigger>
                <SelectContent>
                  {(organisations.data?.ok ? organisations.data.organisations : [])
                    .filter((organisation) => organisation.status === "active")
                    .map((organisation) => (
                      <SelectItem key={organisation.id} value={organisation.id}>{organisation.legal_name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => void createConnection()} disabled={creatingConn}>
              {creatingConn ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Cable className="mr-2 h-4 w-4" aria-hidden />}
              Mint connection invite
            </Button>
          </div>

          {mintedInvite && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <p className="font-medium">Invitation code — shown once, only the hash is stored:</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="break-all rounded bg-background px-2 py-1 text-xs">{mintedInvite.code}</code>
                <Button
                  size="sm" variant="ghost"
                  onClick={() => { void navigator.clipboard.writeText(mintedInvite.code); toast.success("Copied"); }}
                >
                  <Copy className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Hand it to the organisation's owner out of band; they accept it in their portal. Expires {new Date(mintedInvite.expires).toLocaleString("en-AU")}.
              </p>
            </div>
          )}

          {shadow.data?.ok && shadow.data.connections.length > 0 && (
            <div className="divide-y divide-border">
              {shadow.data.connections.map((connection) => (
                <div key={connection.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-64">
                    <p className="truncate text-sm font-medium">
                      {connection.builder_org_label ?? connection.builder_org_ref}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      clone {connection.clone_id} · network {connection.network_connection_id}
                    </p>
                  </div>
                  <StatusBadge value={connection.state} />
                  {connection.state !== "revoked" && (
                    <>
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 w-72 text-xs"
                          placeholder="https://…/builder-network-inbound"
                          value={transportDrafts[connection.network_connection_id] ?? ""}
                          onChange={(event) => setTransportDrafts((drafts) => ({
                            ...drafts, [connection.network_connection_id]: event.target.value,
                          }))}
                        />
                        <Button
                          size="sm" variant="outline"
                          onClick={async () => {
                            const inboundUrl = (transportDrafts[connection.network_connection_id] ?? "").trim();
                            const result = await transportFn({
                              data: { connectionId: connection.network_connection_id, inboundUrl },
                            });
                            if (result.ok) toast.success("Transport configured");
                            else toast.error(result.error);
                          }}
                        >
                          Set transport
                        </Button>
                      </div>
                      <Button
                        size="sm" variant="outline"
                        onClick={async () => {
                          const reason = window.prompt("Reason for revoking this connection?")?.trim();
                          if (!reason) return;
                          const result = await revokeConnFn({
                            data: { connectionId: connection.network_connection_id, reason },
                          });
                          if (result.ok) { toast.success("Connection revoked"); refreshAll(); }
                          else toast.error(result.error);
                        }}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------------- join requests */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Join requests</CardTitle>
          <p className="text-xs text-muted-foreground">
            Visibility only — organisation owners decide membership, never the platform.
          </p>
        </CardHeader>
        <CardContent>
          {!joins.data?.ok || joins.data.join_requests.length === 0 ? (
            <EmptyState icon={<Inbox className="h-8 w-8" aria-hidden />} title="No join requests" description="ABN-matched registrations appear here while their owners decide." />
          ) : (
            <div className="divide-y divide-border">
              {joins.data.join_requests.map((request) => (
                <div key={request.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 basis-64 truncate">
                    <strong>{request.requester?.name ?? request.builder_user_id}</strong>
                    {request.requester?.email ? ` <${request.requester.email}>` : ""} → {request.organisation_legal_name ?? request.organisation_id}
                  </span>
                  <StatusBadge value={request.status} />
                  <span className="text-xs text-muted-foreground">
                    {new Date(request.created_at).toLocaleString("en-AU")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
