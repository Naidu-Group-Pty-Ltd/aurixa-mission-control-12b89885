// Provider-neutral security intake adapters.
//
// Each adapter converts an upstream vendor payload into a normalized finding
// shape and persists it against `codex_findings` (our canonical findings table).
// This lets us plug in new scanners (Snyk, Semgrep, custom) or ticketing
// systems (Linear, Jira) without touching downstream consumers.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import {
  SECRET_SCANNERS,
  intakeReason,
  intakeResolution,
  resolveIntakeState,
  validateTriage,
} from "@/lib/codex-finding-lifecycle";
import type { FindingState } from "@/lib/codex-finding-state";

/**
 * A partner's status change that was refused. `status` is the HTTP answer:
 * 400 an unknown status word, 404 no such finding, 409 a change the triage
 * rules do not allow from the finding's current state.
 */
export class IntakeStatusError extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export type IntakeStatusResult = { changed: boolean; from?: string; to?: string };

export type NormalizedSeverity = "critical" | "high" | "medium" | "low" | "info";

export type NormalizedFinding = {
  external_id: string;
  title: string;
  severity: NormalizedSeverity;
  description?: string | null;
  affected_file?: string | null;
  affected_line?: number | null;
  cwe?: string | null;
  cvss?: number | null;
  auto_fix_confidence?: number | null;
  clone_id?: string | null;
  raw?: Record<string, unknown>;
};

export type IntakeSource = {
  slug: string;
  name: string;
  kind: "codex" | "manual" | "ticketing" | "generic";
  hmac_secret: string | null;
  active: boolean;
  metadata: Record<string, unknown>;
};

export interface SecurityIntakeAdapter {
  slug: string;
  ingestFinding(
    finding: NormalizedFinding,
    source: IntakeSource,
  ): Promise<{ id: string; created: boolean }>;
  updateStatus(
    externalId: string,
    state: string,
    source: IntakeSource,
    reason?: string | null,
  ): Promise<IntakeStatusResult>;
  linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ): Promise<{ id: string }>;
}

const admin = supabaseAdmin;

// Shared upsert used by codex/manual/generic adapters. Ticketing adapter does
// not create findings (it only links to existing ones).
async function upsertFinding(finding: NormalizedFinding, source: IntakeSource) {
  const externalKey = `${source.slug}:${finding.external_id}`;
  const row = {
    // Intake findings have no scan job; the column is nullable and a partial
    // unique index on codex_finding_id keeps this path idempotent.
    scan_job_id: null,
    clone_id: finding.clone_id ?? null,
    codex_finding_id: externalKey,
    // Same identity the scan pipeline uses, so intake findings take part in
    // cross-run carry-forward and regression detection too.
    fingerprint: externalKey,
    scanner: source.slug,
    last_seen_at: new Date().toISOString(),
    title: finding.title,
    severity: finding.severity,
    description: finding.description ?? null,
    affected_file: finding.affected_file ?? null,
    affected_line: finding.affected_line ?? null,
    cwe: finding.cwe ?? null,
    cvss: finding.cvss ?? null,
    auto_fix_confidence: finding.auto_fix_confidence ?? null,
    source_slug: source.slug,
    raw: asJson(finding.raw ?? {}),
  };

  // Try to find existing row (unique on codex_finding_id in most deployments,
  // but we don't rely on that constraint — we look up manually).
  const existing = await admin
    .from("codex_findings")
    .select("id")
    .eq("codex_finding_id", row.codex_finding_id)
    .maybeSingle();

  if (existing.data?.id) {
    const updated = await admin
      .from("codex_findings")
      .update(asRow<TablesUpdate<"codex_findings">>(row))
      .eq("id", existing.data.id);
    if (updated.error) throw new Error(updated.error.message);
    return { id: existing.data.id as string, created: false };
  }

  const inserted = await admin
    .from("codex_findings")
    .insert(asRow<TablesInsert<"codex_findings">>(row))
    .select("id")
    .single();
  if (inserted.error) {
    throw new Error(inserted.error.message);
  }
  return { id: inserted.data.id as string, created: true };
}

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""))
  );
}

/**
 * A partner changes the status of one of ITS findings (the codex_finding_id
 * carries the source slug, so a source can only ever reach its own).
 *
 * The same rules as a person's triage: the status word must map onto a state
 * a person may set, the move must be allowed from the finding's current
 * state, and a verdict carries a reason. Each change is recorded on the
 * finding's history. Before this a partner could set any state at all —
 * including the fix-in-flight states Mission Control owns — with no trace,
 * and an unknown word was dropped without an error.
 */
async function updateFindingState(
  externalId: string,
  source: IntakeSource,
  rawState: string,
  reason?: string | null,
): Promise<IntakeStatusResult> {
  const to = resolveIntakeState(rawState);
  if (!to) {
    throw new IntakeStatusError(
      `unknown status "${rawState}" — use open, triaging, resolved (rotated, for a credential), dismissed or false_positive`,
      400,
    );
  }
  const { data: f, error } = await admin
    .from("codex_findings")
    .select("id, state, scanner")
    .eq("codex_finding_id", `${source.slug}:${externalId}`)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!f) throw new IntakeStatusError("finding not found", 404);
  // Re-sending the status a finding already has is a no-op, not an error.
  if (f.state === to) return { changed: false, from: f.state, to };

  const why = intakeReason(source.name, to, reason);
  const verdict = validateTriage({
    from: f.state as FindingState,
    to,
    reason: why,
    scanner: f.scanner,
    resolution: to === "resolved" ? intakeResolution(rawState) : null,
  });
  if (!verdict.ok) {
    const secret = to === "resolved" && !!f.scanner && SECRET_SCANNERS.has(f.scanner);
    throw new IntakeStatusError(
      secret ? `${verdict.error} — send the status "rotated" once it has been` : verdict.error,
      409,
    );
  }

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { state: to, triaged_at: nowIso, triage_reason: why };
  if (to === "resolved") {
    patch.resolution = verdict.resolution;
    patch.resolved_at = nowIso;
  } else if (to === "open" || to === "triaging") {
    patch.resolution = null;
    patch.resolved_at = null;
  }
  const apply = (p: Record<string, unknown>) => {
    // Only from the state just read: a concurrent change wins.
    return admin
      .from("codex_findings")
      .update(asRow<TablesUpdate<"codex_findings">>(p))
      .eq("id", f.id)
      .eq("state", f.state)
      .select("id");
  };
  let res = await apply(patch);
  if (res.error && isMissingColumn(res.error)) {
    delete patch.triage_reason;
    delete patch.resolution;
    res = await apply(patch);
  }
  if (res.error) throw new Error(res.error.message);
  if (!res.data?.length)
    throw new IntakeStatusError("the finding changed meanwhile — send it again", 409);

  const { error: evErr } = await admin.from("codex_finding_events").insert({
    finding_id: f.id,
    event_type: "intake.status",
    from_state: f.state,
    to_state: to,
    reason: why,
    payload: asJson({ source: source.slug, status: rawState }),
  });
  if (evErr && !/does not exist|Could not find/i.test(evErr.message)) {
    console.warn("[security-intake] status history not recorded:", evErr.message);
  }
  return { changed: true, from: f.state, to };
}

async function linkTicket(
  findingId: string,
  ticket: { provider: string; external_id: string; url?: string; status?: string },
  source: IntakeSource,
  actorUserId?: string | null,
) {
  const payload = {
    codex_finding_id: findingId,
    source_slug: source.slug,
    provider: ticket.provider,
    external_id: ticket.external_id,
    url: ticket.url ?? null,
    status: ticket.status ?? "open",
    created_by: actorUserId ?? null,
  };
  const res = await admin
    .from("security_external_tickets")
    .upsert(asRow<TablesInsert<"security_external_tickets">>(payload), {
      onConflict: "source_slug,provider,external_id",
    })
    .select("id")
    .single();
  if (res.error) throw new Error(res.error.message);
  if (ticket.url) {
    const linked = await admin
      .from("codex_findings")
      .update({ external_ticket_url: ticket.url })
      .eq("id", findingId);
    if (linked.error) throw new Error(linked.error.message);
  }
  return { id: res.data.id as string };
}

class BaseAdapter implements SecurityIntakeAdapter {
  constructor(public slug: string) {}
  async ingestFinding(finding: NormalizedFinding, source: IntakeSource) {
    return upsertFinding(finding, source);
  }
  async updateStatus(
    externalId: string,
    state: string,
    source: IntakeSource,
    reason?: string | null,
  ) {
    return updateFindingState(externalId, source, state, reason);
  }
  async linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ) {
    return linkTicket(findingId, ticket, source, actorUserId);
  }
}

export class CodexAdapter extends BaseAdapter {
  constructor() {
    super("codex");
  }
}

export class ManualAdapter extends BaseAdapter {
  constructor() {
    super("manual");
  }
}

export class GenericAdapter extends BaseAdapter {}

// Ticketing adapter: cannot create findings (throws), only links tickets.
export class TicketingAdapter implements SecurityIntakeAdapter {
  constructor(public slug: string) {}
  async ingestFinding(): Promise<{ id: string; created: boolean }> {
    throw new Error("ticketing_adapter_cannot_ingest_findings");
  }
  async updateStatus(externalId: string, state: string): Promise<IntakeStatusResult> {
    // Ticketing status updates land on security_external_tickets instead. A
    // ticket closing does not close its finding: closed is not fixed, and the
    // finding shows the ticket's status for a person to act on.
    const { data, error } = await admin
      .from("security_external_tickets")
      .update({ status: state })
      .eq("source_slug", this.slug)
      .eq("external_id", externalId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new IntakeStatusError("ticket not found", 404);
    return { changed: true, to: state };
  }
  async linkExternalTicket(
    findingId: string,
    ticket: { provider: string; external_id: string; url?: string; status?: string },
    source: IntakeSource,
    actorUserId?: string | null,
  ) {
    return linkTicket(findingId, ticket, source, actorUserId);
  }
}

export function adapterFor(source: IntakeSource): SecurityIntakeAdapter {
  switch (source.kind) {
    case "codex":
      return new CodexAdapter();
    case "manual":
      return new ManualAdapter();
    case "ticketing":
      return new TicketingAdapter(source.slug);
    case "generic":
    default:
      return new GenericAdapter(source.slug);
  }
}

export async function loadSourceBySlug(slug: string): Promise<IntakeSource | null> {
  const res = await admin
    .from("security_intake_sources")
    .select("slug, name, kind, hmac_secret, active, metadata")
    .eq("slug", slug)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return res.data as IntakeSource;
}
