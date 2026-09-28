/**
 * Builder Partner Agreements: the terms, the send, the signed record, and the
 * Builder Portal access a signature opens.
 *
 * A builder reaches the network through the website's waitlist, and that
 * pipeline is not touched here: the application still creates the
 * organisation and the builder's account, pending. What this adds sits at the
 * one point the pipeline already has a person — an admin approving the
 * organisation — and makes that approval wait for a signed Builder Partner
 * Agreement while terms are in force:
 *
 *  - the TERMS are a registered file (supplied later, as whatever the
 *    agreement is), put in force by an admin, verified by digest every time
 *    they are sent or served;
 *  - the SEND is the Subscription Agreement's claimed send: claim, write the
 *    issued snapshot, create the envelope, record it — so a lost answer is
 *    recovered from DocuSign rather than sent twice;
 *  - the SIGNED RECORD is copied out of DocuSign into the private records
 *    bucket before anything is granted on it — evidence before action;
 *  - ACCESS is the network's own `approve_organisation`, run by an admin from
 *    the agreement or armed to run on signature. A builder is admitted, never
 *    provisioned: nothing here creates a clone.
 *
 * Every rule a person could be told is decided in `builderPartner.pure.ts`;
 * this module reads, writes and calls, and names each refusal.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import { sha256Hex } from "@/lib/agreements/docxPackage.pure";
import {
  AGREEMENT_RECORDS_BUCKET,
  issuingDay,
  looksLikePdf,
  sendClaimState,
  STALE_SEND_CLAIM_MS,
} from "@/lib/agreements/subscriptionIssue.pure";
import { issuingProfileSchema } from "@/lib/agreements/subscriptionOffer.pure";
import {
  agreementColumnsFromParticulars,
  announcesGrantOutcome,
  base64ToBytes,
  BUILDER_PARTNER_DOCUMENT_NAME,
  BUILDER_PARTNER_KIND,
  BUILDER_PARTNER_TEMPLATE_BUCKET,
  buildBuilderPartnerEnvelopeDefinition,
  builderPartnerSignedRecordPath,
  builderPartnerSnapshotSchema,
  classifyApproveResult,
  decideBuilderAccessGate,
  decideGrantAttempt,
  describeApprovalCode,
  grantApprovalReason,
  isSchemaAbsent,
  NETWORK_LISTING_PAGE,
  NETWORK_ORGANISATION_STATUSES,
  newBuilderPartnerReference,
  normaliseParticulars,
  organisationAgreementState,
  particularsChanges,
  particularsGaps,
  readBuilderPartnerSnapshot,
  readParticulars,
  registeredFileName,
  scheduleDocumentName,
  seedParticulars,
  templateDetailsSchema,
  templateStoragePath,
  termsDocumentName,
  termsFromRegistryRow,
  toAgreementSummary,
  WAIVER_REASON_MAX,
  WAIVER_REASON_MIN,
  type AccessGateDecision,
  type BuilderAgreementSummary,
  type BuilderPartnerIssuedSnapshot,
  type BuilderPartnerParticulars,
  type BuilderPartnerTerms,
  type GrantSkipReason,
  type GrantTrigger,
  type OrganisationAgreementState,
  type ParticularsAccessRequestSource,
  type ParticularsGaps,
  type TemplateExtension,
} from "@/lib/agreements/builderPartner.pure";
import {
  buildExecutionSchedule,
  SCHEDULE_LAYOUT_VERSION,
  scheduleAnchors,
  type ExecutionScheduleTerms,
} from "@/lib/agreements/builderPartnerSchedule.pure";
import { inspectTermsFile } from "@/lib/agreements/builderPartnerTermsFile.pure";
import { builderOrgTenantRef } from "@/lib/buildersNetworkTenant.pure";
import {
  bytesToBase64,
  docusignConfig,
  findEnvelopeForAgreement,
  getDocusignAccessToken,
  mapEnvelopeStatus,
  type DocusignConfig,
} from "@/server/agreements.server";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { callBuilderNetworkAdmin } from "@/server/buildersNetworkAdmin.server";
import { ensureTenant } from "@/server/clone-api-keys.server";

const NOT_INSTALLED_MESSAGE =
  "Builder Partner Agreements are not installed on this database yet — the migration that adds them has not been applied.";
const NO_TERMS_MESSAGE =
  "No Builder Partner Agreement terms are in force. Register the terms file and put it in force first.";

/* ───────────────────────────── the terms ───────────────────────────── */

const TEMPLATES = "builder_partner_agreement_templates" as const;
const TEMPLATE_SELECT =
  "id, name, version_label, file_name, media_type, sha256, byte_size, page_count, countersignature_required, execution_statement, notes, storage_path, status, uploaded_by, activated_at, activated_by, retired_at, retired_by, created_at, updated_at";

type TemplateRow = Database["public"]["Tables"]["builder_partner_agreement_templates"]["Row"];

export type RegisteredTerms = {
  id: string;
  name: string;
  versionLabel: string;
  fileName: string;
  mediaType: string;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  countersignatureRequired: boolean;
  executionStatement: string;
  notes: string | null;
  status: string;
  uploadedAt: string;
  updatedAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  /** Agreements issued under this registration; null when the count could not be read. */
  issuedCount: number | null;
};

function toRegisteredTerms(row: TemplateRow, issuedCount: number | null): RegisteredTerms {
  return {
    id: row.id,
    name: row.name,
    versionLabel: row.version_label,
    fileName: row.file_name,
    mediaType: row.media_type,
    sha256: row.sha256,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    countersignatureRequired: row.countersignature_required,
    executionStatement: row.execution_statement,
    notes: row.notes,
    status: row.status,
    uploadedAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    issuedCount,
  };
}

export type TermsInForce =
  | { state: "in_force"; terms: BuilderPartnerTerms; storagePath: string }
  | { state: "none" }
  | { state: "not_installed" };

/**
 * The terms agreements are sent under now. A read that FAILED throws: whether
 * terms are in force decides whether approval waits for a signature, and "we
 * could not look" is not "there are none".
 */
export async function readTermsInForce(): Promise<TermsInForce> {
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .select(TEMPLATE_SELECT)
    .eq("status", "active")
    .maybeSingle();
  if (error) {
    if (isSchemaAbsent(error)) return { state: "not_installed" };
    throw new Error(`The Builder Partner terms in force could not be read: ${error.message}`);
  }
  if (!data) return { state: "none" };
  const terms = termsFromRegistryRow(data);
  if (!terms) {
    throw new Error(
      `The terms in force ("${data.name}") are recorded as ${data.media_type}, which this cannot read.`,
    );
  }
  return { state: "in_force", terms, storagePath: data.storage_path };
}

async function readTemplateRow(templateId: string): Promise<TemplateRow> {
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .select(TEMPLATE_SELECT)
    .eq("id", templateId)
    .maybeSingle();
  if (error) {
    if (isSchemaAbsent(error)) throw new Error(NOT_INSTALLED_MESSAGE);
    throw new Error(`The terms could not be read: ${error.message}`);
  }
  if (!data) throw new Error("terms_not_found");
  return data;
}

/** One verified copy per isolate: sending re-reads the file only when the terms change. */
let verifiedTerms: { path: string; sha256: string; bytes: Uint8Array } | null = null;

/** The terms file's bytes, served only while they still hash to what was registered. */
async function verifiedTermsBytes(path: string, sha256: string): Promise<Uint8Array> {
  if (verifiedTerms?.path === path && verifiedTerms.sha256 === sha256) return verifiedTerms.bytes;
  const { data, error } = await supabaseAdmin.storage
    .from(BUILDER_PARTNER_TEMPLATE_BUCKET)
    .download(path);
  if (error || !data) {
    throw new Error(`The terms file could not be read from storage: ${error?.message ?? "empty"}.`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha256) {
    throw new Error(
      `The stored terms file no longer matches its registered SHA-256 (${sha256.slice(0, 12)}…). ` +
        "A changed file is not the registered terms; register the file again.",
    );
  }
  verifiedTerms = { path, sha256, bytes };
  return bytes;
}

/**
 * Store a file under its digest. An object already at that name is this file
 * — unless an earlier attempt was cut off part-way, which the digest shows —
 * so it is kept when it matches and replaced when it does not.
 */
async function storeTermsFile(
  path: string,
  bytes: Uint8Array,
  mediaType: string,
  sha256: string,
): Promise<void> {
  const bucket = supabaseAdmin.storage.from(BUILDER_PARTNER_TEMPLATE_BUCKET);
  const first = await bucket.upload(path, bytes, { contentType: mediaType, upsert: false });
  if (!first.error) return;
  const existing = await bucket.download(path);
  if (existing.error || !existing.data) {
    throw new Error(`The terms file could not be stored: ${first.error.message}`);
  }
  const held = new Uint8Array(await existing.data.arrayBuffer());
  if ((await sha256Hex(held)) === sha256) return;
  const replaced = await bucket.upload(path, bytes, { contentType: mediaType, upsert: true });
  if (replaced.error) {
    throw new Error(`The terms file could not be stored: ${replaced.error.message}`);
  }
  console.warn(`[builder-partner] replaced an incomplete object at ${path}`);
}

export async function listRegisteredTerms(): Promise<{
  installed: boolean;
  terms: RegisteredTerms[];
}> {
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .select(TEMPLATE_SELECT)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isSchemaAbsent(error)) return { installed: false, terms: [] };
    throw new Error(`The registered terms could not be read: ${error.message}`);
  }
  const rows = data ?? [];
  const counts = await Promise.all(
    rows.map(async (row) => {
      const { count, error: countError } = await supabaseAdmin
        .from("client_agreements")
        .select("id", { count: "exact", head: true })
        .eq("template_id", row.id);
      return countError ? null : (count ?? 0);
    }),
  );
  return { installed: true, terms: rows.map((row, i) => toRegisteredTerms(row, counts[i])) };
}

function parseDetails(value: unknown) {
  const parsed = templateDetailsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The terms' details are not complete: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "details"} ${issue.message}`)
        .join("; ")}.`,
    );
  }
  return parsed.data;
}

/**
 * Register an uploaded file as terms, staged. Nothing is sent under it until
 * an admin puts it in force; registering the same bytes again is allowed (the
 * details freeze once in force, so a correction is a new registration of the
 * same file), but only one registration of a file waits at a time.
 */
export async function registerTermsFile(input: {
  actorUserId: string;
  fileName: string;
  base64: string;
  details: unknown;
}): Promise<{ terms: RegisteredTerms; warnings: string[] }> {
  const details = parseDetails(input.details);
  const bytes = base64ToBytes(input.base64);
  const inspection = await inspectTermsFile(bytes, input.fileName);
  if (!inspection.ok) throw new Error(inspection.error);
  const sha256 = await sha256Hex(bytes);

  const { data: waiting, error: waitingError } = await supabaseAdmin
    .from(TEMPLATES)
    .select("id, name, version_label")
    .eq("sha256", sha256)
    .eq("status", "staged")
    .limit(1);
  if (waitingError) {
    if (isSchemaAbsent(waitingError)) throw new Error(NOT_INSTALLED_MESSAGE);
    throw new Error(`The registered terms could not be checked: ${waitingError.message}`);
  }
  if (waiting?.length) {
    throw new Error(
      `This file is already registered and waiting to be put in force as "${waiting[0].name}" ` +
        `(${waiting[0].version_label}). Edit that registration instead.`,
    );
  }

  const path = templateStoragePath(sha256, inspection.extension);
  await storeTermsFile(path, bytes, inspection.mediaType, sha256);
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .insert({
      name: details.name,
      version_label: details.versionLabel,
      file_name: registeredFileName(input.fileName, inspection.extension),
      media_type: inspection.mediaType,
      sha256,
      byte_size: bytes.length,
      page_count: inspection.pageCount,
      countersignature_required: details.countersignatureRequired,
      execution_statement: details.executionStatement,
      notes: details.notes || null,
      storage_path: path,
      status: "staged",
      uploaded_by: input.actorUserId,
    })
    .select(TEMPLATE_SELECT)
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error("This file was registered at the same moment. Refresh to see it.");
    }
    throw new Error(`The terms could not be registered: ${error.message}`);
  }
  await writeAuditLog({
    action: "agreement.builder_partner_terms_registered",
    entityType: "builder_partner_terms",
    entityId: data.id,
    actorUserId: input.actorUserId,
    metadata: {
      name: data.name,
      version_label: data.version_label,
      sha256,
      bytes: bytes.length,
      media_type: inspection.mediaType,
      warnings: inspection.warnings,
    },
  });
  return { terms: toRegisteredTerms(data, 0), warnings: inspection.warnings };
}

/**
 * Change a registration's details. Staged terms may change anything; terms
 * that have been in force keep what they were sent under and may change only
 * their notes — correcting anything else is a new registration of the file.
 */
export async function updateRegisteredTerms(input: {
  actorUserId: string;
  templateId: string;
  details: unknown;
  expectedUpdatedAt?: string | null;
}): Promise<RegisteredTerms> {
  const details = parseDetails(input.details);
  const row = await readTemplateRow(input.templateId);
  const frozenChanged =
    details.name !== row.name ||
    details.versionLabel !== row.version_label ||
    details.countersignatureRequired !== row.countersignature_required ||
    details.executionStatement !== row.execution_statement;
  if (row.status !== "staged" && frozenChanged) {
    throw new Error(
      "These terms have been in force, so what agreements were sent under cannot change. Only the " +
        "notes can be edited; register the same file again to correct anything else.",
    );
  }
  const patch =
    row.status === "staged"
      ? {
          name: details.name,
          version_label: details.versionLabel,
          countersignature_required: details.countersignatureRequired,
          execution_statement: details.executionStatement,
          notes: details.notes || null,
        }
      : { notes: details.notes || null };
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .update(patch)
    .eq("id", row.id)
    .eq("status", row.status)
    .eq("updated_at", input.expectedUpdatedAt ?? row.updated_at)
    .select(TEMPLATE_SELECT);
  if (error) throw new Error(`The terms could not be updated: ${error.message}`);
  if (!data?.length) {
    throw new Error("These terms changed while you were editing them. Refresh and edit again.");
  }
  await writeAuditLog({
    action: "agreement.builder_partner_terms_updated",
    entityType: "builder_partner_terms",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: { fields: Object.keys(patch), status: row.status },
  });
  return toRegisteredTerms(data[0], null);
}

/**
 * Put staged terms in force. Refused while no agreement could actually be
 * sent under them — DocuSign unconfigured, or a countersignature required
 * with nobody to countersign — because terms in force make approval wait for
 * a signature, and a signature nobody can collect is an outage, not a control.
 */
export async function putTermsInForce(input: {
  actorUserId: string;
  templateId: string;
}): Promise<{ activated: boolean; previousId: string | null }> {
  const row = await readTemplateRow(input.templateId);
  if (row.status === "active") return { activated: false, previousId: null };
  if (row.status !== "staged") {
    throw new Error("Retired terms are not put back in force. Register the file again instead.");
  }
  const config = docusignConfig();
  if (!config.ready) {
    throw new Error(
      `DocuSign is not configured (missing: ${config.missing.join(", ")}). Terms in force make ` +
        "Builder Portal approval wait for a signed agreement, and none could be sent.",
    );
  }
  if (row.countersignature_required && !config.countersignerEmail) {
    throw new Error(
      "These terms require Aurixa's countersignature and no countersigner is configured " +
        "(DOCUSIGN_COUNTERSIGNER_NAME / DOCUSIGN_COUNTERSIGNER_EMAIL).",
    );
  }
  await verifiedTermsBytes(row.storage_path, row.sha256);
  const previous = await readTermsInForce();
  const previousId =
    previous.state === "in_force" && previous.terms.id !== row.id ? previous.terms.id : null;
  const { error } = await supabaseAdmin.rpc("activate_builder_partner_agreement_template", {
    p_template_id: row.id,
    p_actor: input.actorUserId,
  });
  if (error) throw new Error(`The terms could not be put in force: ${error.message}`);
  await writeAuditLog({
    action: "agreement.builder_partner_terms_activated",
    entityType: "builder_partner_terms",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: {
      name: row.name,
      version_label: row.version_label,
      sha256: row.sha256,
      previous_id: previousId,
    },
  });
  return { activated: true, previousId };
}

/**
 * Take the terms in force out of force. With none in force, approval no
 * longer waits for a signature, so this asks why and records it.
 */
export async function retireTermsInForce(input: {
  actorUserId: string;
  templateId: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < WAIVER_REASON_MIN) {
    throw new Error(
      `Say why these terms are being retired (at least ${WAIVER_REASON_MIN} characters): with none in ` +
        "force, Builder Portal approval stops waiting for a signed agreement.",
    );
  }
  const row = await readTemplateRow(input.templateId);
  if (row.status !== "active") throw new Error("Only the terms in force can be retired.");
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .update({
      status: "retired",
      retired_at: new Date().toISOString(),
      retired_by: input.actorUserId,
    })
    .eq("id", row.id)
    .eq("status", "active")
    .select("id");
  if (error) throw new Error(`The terms could not be retired: ${error.message}`);
  if (!data?.length) throw new Error("These terms changed a moment ago. Refresh to see them.");
  await writeAuditLog({
    action: "agreement.builder_partner_terms_retired",
    entityType: "builder_partner_terms",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: {
      name: row.name,
      version_label: row.version_label,
      reason: reason.slice(0, WAIVER_REASON_MAX),
    },
  });
}

/** Delete a registration nothing was ever sent under. Terms that were in force are kept. */
export async function deleteStagedTerms(input: {
  actorUserId: string;
  templateId: string;
}): Promise<void> {
  const row = await readTemplateRow(input.templateId);
  if (row.status !== "staged") {
    throw new Error(
      "Only terms that were never put in force can be deleted. Retire these instead.",
    );
  }
  const { data, error } = await supabaseAdmin
    .from(TEMPLATES)
    .delete()
    .eq("id", row.id)
    .eq("status", "staged")
    .select("id");
  if (error) {
    if (error.code === "23503") {
      throw new Error("An agreement refers to these terms, so they are kept.");
    }
    throw new Error(`The terms could not be deleted: ${error.message}`);
  }
  if (!data?.length) throw new Error("These terms changed a moment ago. Refresh to see them.");
  // The object is the file's digest, shared by every registration of it.
  const { count, error: countError } = await supabaseAdmin
    .from(TEMPLATES)
    .select("id", { count: "exact", head: true })
    .eq("storage_path", row.storage_path);
  if (!countError && count === 0) {
    const removed = await supabaseAdmin.storage
      .from(BUILDER_PARTNER_TEMPLATE_BUCKET)
      .remove([row.storage_path]);
    if (removed.error)
      console.error("[builder-partner] terms object not removed:", removed.error.message);
  }
  await writeAuditLog({
    action: "agreement.builder_partner_terms_deleted",
    entityType: "builder_partner_terms",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: { name: row.name, version_label: row.version_label, sha256: row.sha256 },
  });
}

/** A registered terms file, verified against its digest before it is served. */
export async function readRegisteredTermsFile(
  templateId: string,
): Promise<{ base64: string; filename: string; mediaType: string }> {
  const row = await readTemplateRow(templateId);
  const bytes = await verifiedTermsBytes(row.storage_path, row.sha256);
  return { base64: bytesToBase64(bytes), filename: row.file_name, mediaType: row.media_type };
}

/* ───────────────────────────── the agreement row ───────────────────────────── */

const BUILDER_SELECT =
  "id, document_kind, status, offer, offer_reference, issued_at, issued_snapshot, template_id, builder_organisation_id, docusign_envelope_id, docusign_status, docusign_sent_at, docusign_signed_at, created_at, created_by, grant_access_on_signature, portal_access_status, portal_access_attempted_at, portal_access_granted_at, portal_access_detail, signed_record_path, signed_record_sha256, client_name, client_email, client_org, updated_at";

type BuilderRow = {
  id: string;
  document_kind: string;
  status: string;
  offer: Json | null;
  offer_reference: string | null;
  issued_at: string | null;
  issued_snapshot: Json | null;
  template_id: string | null;
  builder_organisation_id: string | null;
  docusign_envelope_id: string | null;
  docusign_status: string | null;
  docusign_sent_at: string | null;
  docusign_signed_at: string | null;
  created_at: string;
  created_by: string | null;
  grant_access_on_signature: boolean;
  portal_access_status: string | null;
  portal_access_attempted_at: string | null;
  portal_access_granted_at: string | null;
  portal_access_detail: string | null;
  signed_record_path: string | null;
  signed_record_sha256: string | null;
  client_name: string;
  client_email: string;
  client_org: string | null;
  updated_at: string;
};

async function readBuilderRow(agreementId: string): Promise<BuilderRow> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select(BUILDER_SELECT)
    .eq("id", agreementId)
    .maybeSingle();
  if (error) {
    if (isSchemaAbsent(error)) throw new Error(NOT_INSTALLED_MESSAGE);
    throw new Error(`The agreement could not be read: ${error.message}`);
  }
  if (!data) throw new Error("agreement_not_found");
  const row = data as unknown as BuilderRow;
  if (row.document_kind !== BUILDER_PARTNER_KIND)
    throw new Error("not_a_builder_partner_agreement");
  return row;
}

function partnerLabel(row: Pick<BuilderRow, "client_org" | "client_name">): string {
  return row.client_org?.trim() || row.client_name;
}

/* ───────────────────────────── the network ───────────────────────────── */

type NetworkOrganisation = {
  id: string;
  legal_name: string;
  status: string;
  trading_name?: string | null;
  abn?: string | null;
  state?: string | null;
  contact_email?: string | null;
};

type OrganisationLookup =
  | { kind: "found"; organisation: NetworkOrganisation }
  | { kind: "absent" }
  /** The listing is full and the organisation is not in it: nothing can be said. */
  | { kind: "not_listed" }
  | { kind: "unreachable"; error: string };

function readOrganisations(body: Record<string, unknown>): NetworkOrganisation[] {
  const list = Array.isArray(body.organisations) ? body.organisations : [];
  return list.filter(
    (o): o is NetworkOrganisation =>
      typeof o === "object" && o !== null && typeof (o as { id?: unknown }).id === "string",
  );
}

/**
 * Where the network stands on one organisation. The listing is newest-first
 * and capped, so a miss on a full page is "not listed", never "absent": only
 * a page that ended short can say an organisation does not exist.
 */
async function findNetworkOrganisation(organisationId: string): Promise<OrganisationLookup> {
  const first = await callBuilderNetworkAdmin("list_organisations", {});
  if (!first.ok) return { kind: "unreachable", error: first.error };
  const all = readOrganisations(first.body);
  const hit = all.find((o) => o.id === organisationId);
  if (hit) return { kind: "found", organisation: hit };
  if (all.length < NETWORK_LISTING_PAGE) return { kind: "absent" };

  const pages = await Promise.all(
    NETWORK_ORGANISATION_STATUSES.map((status) =>
      callBuilderNetworkAdmin("list_organisations", { status }),
    ),
  );
  let complete = true;
  for (const page of pages) {
    if (!page.ok) return { kind: "unreachable", error: page.error };
    const orgs = readOrganisations(page.body);
    const found = orgs.find((o) => o.id === organisationId);
    if (found) return { kind: "found", organisation: found };
    if (orgs.length >= NETWORK_LISTING_PAGE) complete = false;
  }
  return complete ? { kind: "absent" } : { kind: "not_listed" };
}

/** What the website's application recorded for the organisation, newest first; null if nothing. */
async function findLatestAccessRequest(
  organisationId: string,
): Promise<ParticularsAccessRequestSource | null> {
  const result = await callBuilderNetworkAdmin("list_access_requests", {});
  if (!result.ok || !Array.isArray(result.body.access_requests)) return null;
  const mine = (result.body.access_requests as Array<Record<string, unknown>>)
    .filter((r) => r && r.organisation_id === organisationId)
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  if (!mine.length) return null;
  const request = mine[0];
  const requester =
    typeof request.requester === "object" && request.requester !== null
      ? (request.requester as Record<string, unknown>)
      : {};
  const text = (key: string): string | null => {
    const value = request[key] ?? requester[key];
    return typeof value === "string" && value.trim() ? value : null;
  };
  return {
    abn: text("abn"),
    contact_name: text("contact_name") ?? text("name") ?? text("full_name"),
    contact_email: text("contact_email") ?? text("email"),
    contact_phone: text("contact_phone") ?? text("phone"),
    suburb: text("suburb"),
    state: text("state"),
    postcode: text("postcode"),
  };
}

const OPEN_AGREEMENT_STATUSES = ["draft", "sent", "delivered"];

async function findOpenAgreement(
  organisationId: string,
): Promise<{ id: string; offer_reference: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, offer_reference")
    .eq("document_kind", BUILDER_PARTNER_KIND)
    .eq("builder_organisation_id", organisationId)
    .in("status", OPEN_AGREEMENT_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isSchemaAbsent(error)) throw new Error(NOT_INSTALLED_MESSAGE);
    throw new Error(`The organisation's agreements could not be read: ${error.message}`);
  }
  return data?.[0] ?? null;
}

/* ───────────────────────────── drafting ───────────────────────────── */

/**
 * Draft an agreement for an organisation, seeded from what the network holds.
 * An organisation has at most one open agreement: asking again returns it.
 */
export async function prepareBuilderPartnerAgreement(input: {
  actorUserId: string;
  organisationId: string;
}): Promise<{ agreementId: string; reference: string; existing: boolean }> {
  const open = await findOpenAgreement(input.organisationId);
  if (open) return { agreementId: open.id, reference: open.offer_reference ?? "", existing: true };

  const lookup = await findNetworkOrganisation(input.organisationId);
  if (lookup.kind === "unreachable") {
    throw new Error(
      `The Builders Network could not be asked about this organisation (${lookup.error}). Nothing was drafted.`,
    );
  }
  if (lookup.kind === "absent") {
    throw new Error("The Builders Network has no such organisation. Nothing was drafted.");
  }
  if (lookup.kind === "not_listed") {
    throw new Error(
      "The Builders Network's listing did not include this organisation, so it could not be confirmed. Nothing was drafted.",
    );
  }
  const organisation = lookup.organisation;
  if (organisation.status === "closed") {
    throw new Error("This organisation is closed on the Builders Network. Nothing was drafted.");
  }
  const accessRequest = await findLatestAccessRequest(input.organisationId);
  const particulars = seedParticulars(organisation, accessRequest);
  const columns = agreementColumnsFromParticulars(particulars);

  for (let attempt = 0; attempt < 3; attempt++) {
    const reference = newBuilderPartnerReference(new Date(), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const { data, error } = await supabaseAdmin
      .from("client_agreements")
      .insert({
        document_kind: BUILDER_PARTNER_KIND,
        status: "draft",
        builder_organisation_id: input.organisationId,
        offer: asJson(particulars),
        offer_reference: reference,
        client_name: columns.client_name ?? (organisation.legal_name || "Builder Partner"),
        client_email: columns.client_email ?? "",
        client_org: columns.client_org,
        service_tier: columns.service_tier,
        created_by: input.actorUserId,
        grant_access_on_signature: false,
      })
      .select("id")
      .single();
    if (!error) {
      await writeAuditLog({
        action: "agreement.builder_partner_created",
        entityType: "client_agreement",
        entityId: data.id,
        actorUserId: input.actorUserId,
        metadata: {
          reference,
          builder_organisation_id: input.organisationId,
          organisation_status: organisation.status,
          seeded_from_access_request: accessRequest !== null,
        },
      });
      return { agreementId: data.id, reference, existing: false };
    }
    if (isSchemaAbsent(error)) throw new Error(NOT_INSTALLED_MESSAGE);
    if (error.code !== "23505")
      throw new Error(`The agreement could not be drafted: ${error.message}`);
    // Either another draft for this organisation won the race, or the reference collided.
    const raced = await findOpenAgreement(input.organisationId);
    if (raced)
      return { agreementId: raced.id, reference: raced.offer_reference ?? "", existing: true };
  }
  throw new Error("A unique agreement reference could not be issued. Try again.");
}

/** Save the particulars of a draft that has not started sending. */
export async function recordBuilderPartnerParticulars(input: {
  actorUserId: string;
  agreementId: string;
  particulars: unknown;
  expectedUpdatedAt?: string | null;
}): Promise<{ particulars: BuilderPartnerParticulars; gaps: ParticularsGaps; updatedAt: string }> {
  const incoming = readParticulars(input.particulars);
  if (!incoming) throw new Error("The particulars are not in a form this can read.");
  const particulars = normaliseParticulars(incoming);
  const row = await readBuilderRow(input.agreementId);
  if (row.status !== "draft" || sendClaimState(row, Date.now()) !== "unclaimed") {
    throw new Error("This agreement has started sending, so its particulars are fixed.");
  }
  const before = readParticulars(row.offer);
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .update({ offer: asJson(particulars), ...agreementColumnsFromParticulars(particulars) })
    .eq("id", row.id)
    .eq("status", "draft")
    .is("issued_at", null)
    .is("docusign_envelope_id", null)
    .eq("updated_at", input.expectedUpdatedAt ?? row.updated_at)
    .select("updated_at");
  if (error) throw new Error(`The particulars could not be saved: ${error.message}`);
  if (!data?.length) {
    throw new Error("This agreement changed while you were editing it. Refresh and save again.");
  }
  await writeAuditLog({
    action: "agreement.builder_partner_particulars_saved",
    entityType: "client_agreement",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: { reference: row.offer_reference, changed: particularsChanges(before, particulars) },
  });
  return { particulars, gaps: particularsGaps(particulars), updatedAt: data[0].updated_at };
}

/**
 * Arm or disarm Builder Portal access on signature. Arming is an admin
 * deciding in advance that a signature is enough; a signed agreement is not
 * armed after the fact — access is granted from it directly instead.
 */
export async function armGrantOnSignature(input: {
  actorUserId: string;
  agreementId: string;
  armed: boolean;
}): Promise<void> {
  const row = await readBuilderRow(input.agreementId);
  if (row.grant_access_on_signature === input.armed) return;
  if (input.armed && !OPEN_AGREEMENT_STATUSES.includes(row.status)) {
    throw new Error(
      row.status === "signed"
        ? "This agreement is already signed. Grant access from it directly."
        : `This agreement is ${row.status}; nothing will be signed to grant access on.`,
    );
  }
  if (
    !input.armed &&
    (row.portal_access_status === "granted" || row.portal_access_status === "pending")
  ) {
    throw new Error("Access has already been granted, or is being granted, from this agreement.");
  }
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .update({ grant_access_on_signature: input.armed })
    .eq("id", row.id)
    .eq("status", row.status)
    .filter(
      "portal_access_status",
      row.portal_access_status === null ? "is" : "eq",
      row.portal_access_status,
    )
    .select("id");
  if (error) throw new Error(`The setting could not be saved: ${error.message}`);
  if (!data?.length) throw new Error("This agreement changed a moment ago. Refresh and try again.");
  await writeAuditLog({
    action: input.armed
      ? "agreement.builder_partner_access_armed"
      : "agreement.builder_partner_access_disarmed",
    entityType: "client_agreement",
    entityId: row.id,
    actorUserId: input.actorUserId,
    metadata: {
      reference: row.offer_reference,
      builder_organisation_id: row.builder_organisation_id,
    },
  });
}

/* ───────────────────────────── sending ───────────────────────────── */

type Issuable = {
  particulars: BuilderPartnerParticulars;
  terms: BuilderPartnerTerms;
  storagePath: string;
};

/** The checks a send must pass, run before the claim and again on what the claim holds. */
function assertIssuable(
  particulars: BuilderPartnerParticulars | null,
  termsInForce: TermsInForce,
  config: DocusignConfig,
): Issuable {
  if (termsInForce.state === "not_installed") throw new Error(NOT_INSTALLED_MESSAGE);
  if (termsInForce.state === "none") throw new Error(NO_TERMS_MESSAGE);
  if (!particulars) {
    throw new Error(
      "This agreement's particulars could not be read. Save them again before sending.",
    );
  }
  const gaps = particularsGaps(particulars);
  if (gaps.blockers.length) {
    throw new Error(`This agreement cannot be sent yet: ${gaps.blockers.join("; ")}.`);
  }
  if (termsInForce.terms.countersignatureRequired && !config.countersignerEmail) {
    throw new Error(
      "The terms in force require Aurixa's countersignature and no countersigner is configured " +
        "(DOCUSIGN_COUNTERSIGNER_NAME / DOCUSIGN_COUNTERSIGNER_EMAIL).",
    );
  }
  return { particulars, terms: termsInForce.terms, storagePath: termsInForce.storagePath };
}

function scheduleTerms(terms: BuilderPartnerTerms): ExecutionScheduleTerms {
  return {
    name: terms.name,
    versionLabel: terms.versionLabel,
    fileName: terms.fileName,
    sha256: terms.sha256,
    byteSize: terms.byteSize,
    pageCount: terms.pageCount,
    executionStatement: terms.executionStatement,
    countersignatureRequired: terms.countersignatureRequired,
  };
}

function termsExtension(terms: BuilderPartnerTerms): TemplateExtension {
  return terms.mediaType === "application/pdf" ? "pdf" : "docx";
}

/** Who a partner writes to when something in the agreement is wrong, from the issuing profile. */
async function correctionContact(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("agreement_issuing_profile")
    .select("facts")
    .eq("singleton", true)
    .maybeSingle();
  if (error || !data) return null;
  const parsed = issuingProfileSchema.safeParse(data.facts ?? {});
  const route = parsed.success ? parsed.data.service.correctionRoute?.trim() : "";
  return route || null;
}

async function releaseClaim(agreementId: string, claimAt: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("client_agreements")
    .update({ issued_at: null, issued_snapshot: null, template_id: null })
    .eq("id", agreementId)
    .eq("issued_at", claimAt)
    .is("docusign_envelope_id", null);
  if (error) console.error("[builder-partner] claim release failed:", error.message);
}

/** Record the envelope against the claim that created it; see the Subscription send for why it retries. */
async function recordEnvelope(
  agreementId: string,
  claimAt: string,
  envelope: { envelopeId: string; status: string },
): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabaseAdmin
      .from("client_agreements")
      .update({
        status: mapEnvelopeStatus(envelope.status) ?? "sent",
        docusign_envelope_id: envelope.envelopeId,
        docusign_status: envelope.status,
        docusign_sent_at: new Date().toISOString(),
      })
      .eq("id", agreementId)
      .eq("issued_at", claimAt)
      .is("docusign_envelope_id", null)
      .select("id");
    if (!error) {
      if (data?.length) return;
      lastError = "the send's claim was no longer held";
      break;
    }
    lastError = error.message;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  await notifyOperators({
    kind: "agreement_attention",
    severity: "error",
    title: "Builder Partner Agreement sent but not recorded",
    body:
      `DocuSign accepted envelope ${envelope.envelopeId}, but it could not be recorded on the ` +
      `agreement (${lastError}). Do not draft a new agreement: pressing Send again on this one ` +
      "finds the envelope in DocuSign and records it.",
    url: `/agreements/${agreementId}`,
    metadata: { agreement_id: agreementId, envelope_id: envelope.envelopeId },
  });
  throw new Error(
    `DocuSign accepted envelope ${envelope.envelopeId}, but it could not be recorded (${lastError}). ` +
      "Do not draft a new agreement — press Send again to recover it.",
  );
}

export type BuilderPartnerSendResult = { envelopeId: string; status: string; recovered: boolean };

export async function sendBuilderPartnerEnvelope(
  agreementId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<BuilderPartnerSendResult> {
  const config = docusignConfig();
  if (!config.ready) {
    throw new Error(`DocuSign not configured; missing: ${config.missing.join(", ")}`);
  }
  const row = await readBuilderRow(agreementId);
  const reference = row.offer_reference as string;
  const organisationId = row.builder_organisation_id as string;

  const now = Date.now();
  const state = sendClaimState(row, now);
  if (state === "sent") throw new Error("agreement_already_sent");
  if (row.status !== "draft") {
    throw new Error(
      `This agreement is ${row.status}. Draft a new one for the organisation instead.`,
    );
  }
  if (state === "in_flight") {
    throw new Error(
      "This agreement is already being sent. Refresh in a moment — pressing Send again does not send a second envelope.",
    );
  }
  assertIssuable(readParticulars(row.offer), await readTermsInForce(), config);

  const token = await getDocusignAccessToken(config);
  if (state === "stale") {
    const found = await findEnvelopeForAgreement(
      config,
      token,
      agreementId,
      row.issued_at as string,
    );
    if (found === "unknown") {
      throw new Error(
        "An earlier send of this agreement did not finish, and DocuSign could not be asked whether " +
          "it created the envelope. Nothing was sent — try again shortly.",
      );
    }
    if (found) {
      await recordEnvelope(agreementId, row.issued_at as string, found);
      await writeAuditLog({
        action: "agreement.builder_partner_recovered",
        entityType: "client_agreement",
        entityId: agreementId,
        actorUserId: opts.actorUserId ?? null,
        metadata: { reference, envelope_id: found.envelopeId },
      });
      return { envelopeId: found.envelopeId, status: found.status, recovered: true };
    }
  }

  // The organisation is asked once more before anything leaves: an agreement
  // is not sent to an organisation the network has closed or no longer has.
  // An unreachable network does not stop the send — the approval it leads to
  // asks the network again.
  const lookup = await findNetworkOrganisation(organisationId);
  if (lookup.kind === "absent") {
    throw new Error("The Builders Network no longer has this organisation. Nothing was sent.");
  }
  if (lookup.kind === "found" && lookup.organisation.status === "closed") {
    throw new Error("This organisation is closed on the Builders Network. Nothing was sent.");
  }

  // ── Claim ────────────────────────────────────────────────────────────
  const claimMs = Date.now();
  const claimAt = new Date(claimMs).toISOString();
  const previousClaim = state === "stale" ? (row.issued_at as string) : null;
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("client_agreements")
    .update({ issued_at: claimAt, issued_snapshot: null, template_id: null })
    .eq("id", agreementId)
    .eq("status", "draft")
    .is("docusign_envelope_id", null)
    .filter("issued_at", previousClaim === null ? "is" : "eq", previousClaim)
    .select("offer, grant_access_on_signature");
  if (claimError) {
    throw new Error(`The agreement could not be claimed for sending: ${claimError.message}`);
  }
  if (!claimed?.length) {
    throw new Error(
      "Another send of this agreement started at the same moment. Refresh to see it.",
    );
  }

  // ── Issue, and write the snapshot, before anything leaves ─────────────
  let definition: Record<string, unknown>;
  let snapshot: BuilderPartnerIssuedSnapshot;
  try {
    const held = claimed[0] as unknown as {
      offer: Json | null;
      grant_access_on_signature: boolean;
    };
    const issuable = assertIssuable(readParticulars(held.offer), await readTermsInForce(), config);
    const { particulars, terms } = issuable;
    const termsBytes = await verifiedTermsBytes(issuable.storagePath, terms.sha256);
    const countersigner =
      terms.countersignatureRequired && config.countersignerEmail
        ? { name: config.countersignerName ?? "Aurixa Systems", email: config.countersignerEmail }
        : null;
    const schedule = await buildExecutionSchedule({
      reference,
      issuedOn: issuingDay(new Date(claimMs)),
      preview: false,
      particulars,
      terms: scheduleTerms(terms),
      countersignerName: countersigner?.name ?? null,
    });
    const expectedAnchors = scheduleAnchors({
      signatoryTitle: particulars.signatory.title,
      countersignatureRequired: terms.countersignatureRequired,
    });
    if (schedule.anchors.join("|") !== expectedAnchors.join("|")) {
      throw new Error("The execution schedule did not carry its signing places. Nothing was sent.");
    }
    const scheduleName = scheduleDocumentName(reference, false);
    const signer = {
      name: particulars.signatory.name,
      email: particulars.signatory.email,
      title: particulars.signatory.title || null,
    };
    const carbonCopy =
      !countersigner && config.countersignerEmail
        ? { name: config.countersignerName, email: config.countersignerEmail }
        : null;
    snapshot = builderPartnerSnapshotSchema.parse({
      schema: 1,
      kind: BUILDER_PARTNER_KIND,
      reference,
      issuedAt: claimAt,
      issuingDay: issuingDay(new Date(claimMs)),
      builderOrganisationId: organisationId,
      particulars,
      terms: {
        templateId: terms.id,
        name: terms.name,
        versionLabel: terms.versionLabel,
        fileName: terms.fileName,
        mediaType: terms.mediaType,
        sha256: terms.sha256,
        bytes: terms.byteSize,
        pageCount: terms.pageCount,
        countersignatureRequired: terms.countersignatureRequired,
        executionStatement: terms.executionStatement,
        documentName: termsDocumentName(terms),
      },
      schedule: {
        name: scheduleName,
        sha256: await sha256Hex(schedule.bytes),
        bytes: schedule.bytes.length,
        layoutVersion: SCHEDULE_LAYOUT_VERSION,
        pageCount: schedule.pageCount,
        base64: bytesToBase64(schedule.bytes),
      },
      signer,
      countersigner,
      carbonCopy,
      grantAccessOnSignature: held.grant_access_on_signature === true,
    });
    const { data: recorded, error: snapshotError } = await supabaseAdmin
      .from("client_agreements")
      .update({
        issued_snapshot: asJson(snapshot),
        template_id: terms.id,
        ...agreementColumnsFromParticulars(particulars),
      })
      .eq("id", agreementId)
      .eq("issued_at", claimAt)
      .is("docusign_envelope_id", null)
      .select("id");
    if (snapshotError) {
      throw new Error(`The issued record could not be written: ${snapshotError.message}`);
    }
    if (!recorded?.length)
      throw new Error("The send lost its claim before the envelope was created.");
    definition = buildBuilderPartnerEnvelopeDefinition({
      agreementId,
      builderOrganisationId: organisationId,
      reference,
      partnerLegalName: particulars.partner.legalName,
      terms: {
        name: termsDocumentName(terms),
        extension: termsExtension(terms),
        base64: bytesToBase64(termsBytes),
      },
      schedule: { name: scheduleName, base64: snapshot.schedule.base64 },
      signer,
      countersigner,
      carbonCopy,
      correctionContact: await correctionContact(),
    });
  } catch (err) {
    await releaseClaim(agreementId, claimAt);
    throw err;
  }

  // ── Create the envelope ──────────────────────────────────────────────
  let response: Response | null = null;
  let transportError = "";
  try {
    response = await fetch(`${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  }
  const text = response ? await response.text().catch(() => "") : "";
  let body: { envelopeId?: string; status?: string; message?: string; errorCode?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (response?.ok && body.envelopeId) {
    const envelope = { envelopeId: body.envelopeId, status: body.status ?? "sent" };
    await recordEnvelope(agreementId, claimAt, envelope);
    await writeAuditLog({
      action: "agreement.builder_partner_sent",
      entityType: "client_agreement",
      entityId: agreementId,
      actorUserId: opts.actorUserId ?? null,
      metadata: {
        reference,
        envelope_id: envelope.envelopeId,
        builder_organisation_id: organisationId,
        template_id: snapshot.terms.templateId,
        terms_sha256: snapshot.terms.sha256,
        schedule_sha256: snapshot.schedule.sha256,
        organisation_checked: lookup.kind,
        grant_access_on_signature: snapshot.grantAccessOnSignature,
      },
    });
    return { ...envelope, recovered: false };
  }

  if (response && response.status >= 400 && response.status < 500) {
    await releaseClaim(agreementId, claimAt);
    throw new Error(
      `DocuSign refused the envelope: ${body.message || body.errorCode || `HTTP ${response.status}`}`,
    );
  }

  const found = await findEnvelopeForAgreement(config, token, agreementId, claimAt);
  if (found && found !== "unknown") {
    await recordEnvelope(agreementId, claimAt, found);
    return { envelopeId: found.envelopeId, status: found.status, recovered: true };
  }
  const retryAt = new Date(claimMs + STALE_SEND_CLAIM_MS).toLocaleTimeString("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
  });
  throw new Error(
    `DocuSign did not confirm the envelope (${transportError || (response ? `HTTP ${response.status}` : "no response")}). ` +
      `So the builder cannot receive this agreement twice, it is held until ${retryAt} Sydney time; ` +
      "pressing Send after that first checks DocuSign for the envelope.",
  );
}

/* ───────────────────────────── the signed record ───────────────────────────── */

export type BuilderRetentionResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Copy the completed envelope, with DocuSign's certificate of completion,
 * into the private records bucket and record where and what. Idempotent both
 * ways and never throws — the answer says why a record is missing, and
 * nothing is granted on a signature until it exists.
 */
export async function retainSignedBuilderPartnerRecord(
  agreementId: string,
): Promise<BuilderRetentionResult> {
  try {
    const row = await readBuilderRow(agreementId);
    if (row.signed_record_path) return { ok: true, path: row.signed_record_path };
    if (row.status !== "signed") return { ok: false, error: "the agreement is not signed" };
    if (!row.docusign_envelope_id) return { ok: false, error: "the agreement has no envelope" };
    const config = docusignConfig();
    if (!config.ready) {
      return { ok: false, error: `DocuSign not configured; missing: ${config.missing.join(", ")}` };
    }
    const path = builderPartnerSignedRecordPath(agreementId, row.docusign_envelope_id);
    const bucket = supabaseAdmin.storage.from(AGREEMENT_RECORDS_BUCKET);

    let bytes: Uint8Array;
    const existing = await bucket.download(path);
    if (!existing.error && existing.data) {
      bytes = new Uint8Array(await existing.data.arrayBuffer());
      if (!looksLikePdf(bytes))
        return { ok: false, error: `an object at ${path} exists but is not a PDF` };
    } else {
      const token = await getDocusignAccessToken(config);
      const res = await fetch(
        `${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes/${row.docusign_envelope_id}/documents/combined?certificate=true`,
        { headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" } },
      );
      if (!res.ok) {
        return {
          ok: false,
          error: `DocuSign would not supply the signed document (HTTP ${res.status})`,
        };
      }
      bytes = new Uint8Array(await res.arrayBuffer());
      if (!looksLikePdf(bytes))
        return { ok: false, error: "DocuSign's signed document is not a PDF" };
      const uploaded = await bucket.upload(path, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploaded.error) {
        return {
          ok: false,
          error: `the signed PDF could not be stored: ${uploaded.error.message}`,
        };
      }
    }

    const sha256 = await sha256Hex(bytes);
    const { data: recorded, error: recordError } = await supabaseAdmin
      .from("client_agreements")
      .update({
        signed_record_path: path,
        signed_record_sha256: sha256,
        signed_record_retained_at: new Date().toISOString(),
      })
      .eq("id", agreementId)
      .is("signed_record_path", null)
      .select("id");
    if (recordError) {
      return { ok: false, error: `the retained record could not be noted: ${recordError.message}` };
    }
    if (!recorded?.length) {
      const again = await readBuilderRow(agreementId);
      return again.signed_record_path
        ? { ok: true, path: again.signed_record_path }
        : { ok: false, error: "the retained record could not be noted" };
    }
    await writeAuditLog({
      action: "agreement.signed_record_retained",
      entityType: "client_agreement",
      entityId: agreementId,
      metadata: {
        document_kind: BUILDER_PARTNER_KIND,
        reference: row.offer_reference,
        envelope_id: row.docusign_envelope_id,
        path,
        sha256,
        bytes: bytes.length,
      },
    });
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The retained signed record, served only while it still hashes to what was recorded. */
export async function readRetainedBuilderPartnerRecord(
  agreementId: string,
): Promise<{ base64: string; filename: string } | null> {
  const row = await readBuilderRow(agreementId);
  if (!row.signed_record_path || !row.signed_record_sha256) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(AGREEMENT_RECORDS_BUCKET)
    .download(row.signed_record_path);
  if (error || !data) {
    throw new Error(`The retained signed record could not be read: ${error?.message ?? "empty"}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if ((await sha256Hex(bytes)) !== row.signed_record_sha256) {
    throw new Error(
      `The retained signed record no longer matches its recorded SHA-256 (${row.signed_record_sha256.slice(0, 12)}…).`,
    );
  }
  return {
    base64: bytesToBase64(bytes),
    filename: `Aurixa Builder Partner Agreement ${row.offer_reference ?? row.id} - signed.pdf`,
  };
}

/**
 * What a signature sets going: retain the record, then — if an admin armed
 * it — grant access. Called from the status fold; never throws, because the
 * fold has already recorded the signature and must not be undone by this.
 */
export async function completeSignedBuilderPartnerAgreement(
  agreementId: string,
  opts: { transitioned: boolean },
): Promise<void> {
  try {
    const retained = await retainSignedBuilderPartnerRecord(agreementId);
    if (!retained.ok && opts.transitioned) {
      await notifyOperators({
        kind: "agreement_attention",
        severity: "error",
        title: "Signed Builder Partner Agreement not yet retained",
        body:
          `The signed agreement could not be copied out of DocuSign (${retained.error}). Nothing is ` +
          "granted on it until it is; the agreements sweep retries every run.",
        url: `/agreements/${agreementId}`,
        metadata: { agreement_id: agreementId },
      });
    }
    await grantBuilderPortalAccess(agreementId, { trigger: "signature", actorUserId: null });
  } catch (err) {
    console.error("[builder-partner] completion failed:", err instanceof Error ? err.message : err);
  }
}

/* ───────────────────────────── access ───────────────────────────── */

export type GrantResult =
  | {
      outcome: "granted";
      alreadyActive: boolean;
      tenant: { ok: true; tenantId: string } | { ok: false; error: string };
    }
  | { outcome: "refused" | "failed"; code: string; detail: string }
  | { outcome: "skipped"; reason: GrantSkipReason | "raced"; detail: string };

/**
 * Approve the organisation on the network from a signed agreement. The
 * attempt is claimed on the row first, so a signature, a sweep and an admin
 * pressing the button cannot approve twice; what the network answered is
 * recorded on the row and said to the people who need it.
 */
export async function grantBuilderPortalAccess(
  agreementId: string,
  opts: { trigger: GrantTrigger; actorUserId: string | null },
): Promise<GrantResult> {
  const row = await readBuilderRow(agreementId);
  const decision = decideGrantAttempt(row, Date.now(), { manual: opts.trigger === "manual" });
  if (decision.action === "skip") {
    return { outcome: "skipped", reason: decision.reason, detail: decision.detail };
  }
  const organisationId = row.builder_organisation_id as string;
  const attemptAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("client_agreements")
    .update({
      portal_access_status: "pending",
      portal_access_attempted_at: attemptAt,
      portal_access_detail: null,
    })
    .eq("id", agreementId)
    .eq("status", "signed")
    .in("grant_access_on_signature", opts.trigger === "manual" ? [true, false] : [true])
    .filter(
      "portal_access_status",
      row.portal_access_status === null ? "is" : "eq",
      row.portal_access_status,
    )
    .filter(
      "portal_access_attempted_at",
      row.portal_access_attempted_at === null ? "is" : "eq",
      row.portal_access_attempted_at,
    )
    .select("id");
  if (claimError) {
    return {
      outcome: "failed",
      code: "claim_failed",
      detail: `The attempt could not be recorded: ${claimError.message}`,
    };
  }
  if (!claimed?.length) {
    return {
      outcome: "skipped",
      reason: "raced",
      detail: "Another attempt to grant access started at the same moment.",
    };
  }

  const summary = toAgreementSummary(row);
  const reference = row.offer_reference ?? row.id;
  const who = partnerLabel(row);
  const url = `/agreements/${agreementId}`;
  const result = await callBuilderNetworkAdmin("approve_organisation", {
    organisation_id: organisationId,
    reason: grantApprovalReason(summary, opts.trigger),
  });
  const outcome = classifyApproveResult(
    result.ok ? { ok: true, body: result.body } : { ok: false, error: result.error },
  );
  const announce = announcesGrantOutcome({
    outcome: outcome.kind,
    trigger: opts.trigger,
    previousStatus: row.portal_access_status,
  });

  if (outcome.kind === "granted") {
    const tenant = await ensureTenant(null, builderOrgTenantRef(organisationId), who);
    const { error: grantedError } = await supabaseAdmin
      .from("client_agreements")
      .update({
        portal_access_status: "granted",
        portal_access_granted_at: new Date().toISOString(),
        portal_access_detail: outcome.alreadyActive
          ? "The organisation was already active on the Builders Network."
          : null,
      })
      .eq("id", agreementId)
      .eq("portal_access_status", "pending")
      .eq("portal_access_attempted_at", attemptAt);
    if (grantedError) console.error("[builder-partner] grant not recorded:", grantedError.message);
    await writeAuditLog({
      action: "agreement.builder_partner_access_granted",
      entityType: "client_agreement",
      entityId: agreementId,
      actorUserId: opts.actorUserId,
      metadata: {
        reference,
        builder_organisation_id: organisationId,
        trigger: opts.trigger,
        already_active: outcome.alreadyActive,
        tenant: tenant.ok ? tenant.tenantId : `failed: ${tenant.error}`,
      },
    });
    if (announce) {
      await notifyOperators({
        kind: "agreement_provisioned",
        severity: "success",
        title: "Builder Portal access granted",
        body: `${who} signed the ${BUILDER_PARTNER_DOCUMENT_NAME} (reference ${reference}) and was admitted to the Builder Portal.`,
        url,
        metadata: { agreement_id: agreementId, builder_organisation_id: organisationId },
      });
    }
    if (!tenant.ok) {
      await notifyOperators({
        kind: "agreement_attention",
        severity: "warning",
        title: "Builder admitted, but its usage account was not created",
        body:
          `${who} was admitted to the Builder Portal, but its metering account could not be created ` +
          `(${tenant.error}). The agreements sweep creates it on its next run.`,
        url,
        metadata: { agreement_id: agreementId, builder_organisation_id: organisationId },
      });
    }
    return {
      outcome: "granted",
      alreadyActive: outcome.alreadyActive,
      tenant: tenant.ok
        ? { ok: true, tenantId: tenant.tenantId }
        : { ok: false, error: tenant.error },
    };
  }

  const detail = describeApprovalCode(outcome.code);
  const { error: outcomeError } = await supabaseAdmin
    .from("client_agreements")
    .update({ portal_access_status: outcome.kind, portal_access_detail: detail })
    .eq("id", agreementId)
    .eq("portal_access_status", "pending")
    .eq("portal_access_attempted_at", attemptAt);
  if (outcomeError) console.error("[builder-partner] outcome not recorded:", outcomeError.message);
  if (announce || opts.trigger === "manual" || outcome.kind === "refused") {
    await writeAuditLog({
      action:
        outcome.kind === "refused"
          ? "agreement.builder_partner_access_refused"
          : "agreement.builder_partner_access_failed",
      entityType: "client_agreement",
      entityId: agreementId,
      actorUserId: opts.actorUserId,
      metadata: {
        reference,
        builder_organisation_id: organisationId,
        trigger: opts.trigger,
        code: outcome.code,
      },
    });
  }
  if (announce) {
    await notifyOperators({
      kind: "agreement_attention",
      severity: outcome.kind === "refused" ? "warning" : "error",
      title:
        outcome.kind === "refused"
          ? "Builders Network refused Builder Portal access"
          : "Builder Portal access could not be granted yet",
      body:
        `${who} signed the ${BUILDER_PARTNER_DOCUMENT_NAME} (reference ${reference}). ${detail}` +
        (outcome.kind === "failed" ? " The agreements sweep tries again." : ""),
      url,
      metadata: {
        agreement_id: agreementId,
        builder_organisation_id: organisationId,
        code: outcome.code,
      },
    });
  }
  return { outcome: outcome.kind, code: outcome.code, detail };
}

/* ───────────────────────────── the approval gate ───────────────────────────── */

const SUMMARY_SELECT =
  "id, status, offer_reference, docusign_signed_at, created_at, signed_record_path, portal_access_status, grant_access_on_signature";

async function readOrganisationAgreements(
  organisationId: string,
): Promise<BuilderAgreementSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select(SUMMARY_SELECT)
    .eq("document_kind", BUILDER_PARTNER_KIND)
    .eq("builder_organisation_id", organisationId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isSchemaAbsent(error)) return [];
    throw new Error(`The organisation's agreements could not be read: ${error.message}`);
  }
  return (data ?? []).map((r) => toAgreementSummary(r as never));
}

/**
 * Whether an admin may approve this organisation from the Builders Network
 * console now. Throws when it cannot be told — a failed read is not a missing
 * agreement, and approving on a guess is what the gate exists to stop.
 */
export async function assessBuilderAccessGate(
  organisationId: string,
  waiverReason?: string | null,
): Promise<AccessGateDecision> {
  const terms = await readTermsInForce();
  if (terms.state === "not_installed") return { allow: true, basis: "not_enforced" };
  const agreements = await readOrganisationAgreements(organisationId);
  return decideBuilderAccessGate({
    termsInForce: terms.state === "in_force",
    agreements,
    waiverReason: waiverReason ?? null,
  });
}

/**
 * Record an approval the console made, on the basis it was allowed, and mark
 * the signed agreement it rested on as having granted access.
 */
export async function recordConsoleApproval(input: {
  organisationId: string;
  actorUserId: string;
  decision: Extract<AccessGateDecision, { allow: true }>;
  networkStatus: string;
  alreadyActive: boolean;
  tenant: { ok: true; tenantId: string } | { ok: false; error: string };
}): Promise<void> {
  const decision = input.decision;
  await writeAuditLog({
    action: "builders_network.organisation_approved",
    entityType: "builder_organisation",
    entityId: input.organisationId,
    actorUserId: input.actorUserId,
    metadata: {
      basis: decision.basis,
      agreement_id: decision.basis === "signed" ? decision.agreement.id : null,
      agreement_reference: decision.basis === "signed" ? decision.agreement.reference : null,
      waiver_reason: decision.basis === "waived" ? decision.waiverReason : null,
      network_status: input.networkStatus,
      already_active: input.alreadyActive,
      tenant: input.tenant.ok ? input.tenant.tenantId : `failed: ${input.tenant.error}`,
    },
  });
  if (decision.basis !== "signed") return;
  const previous = decision.agreement.portalAccessStatus;
  if (previous === "granted" || previous === "pending") return;
  const { error } = await supabaseAdmin
    .from("client_agreements")
    .update({
      portal_access_status: "granted",
      portal_access_granted_at: new Date().toISOString(),
      portal_access_detail: "Approved from the Builders Network console.",
    })
    .eq("id", decision.agreement.id)
    .filter("portal_access_status", previous === null ? "is" : "eq", previous);
  if (error) console.error("[builder-partner] console approval not noted:", error.message);
}

export type BuilderAgreementStates = {
  installed: boolean;
  terms: { state: TermsInForce["state"]; name: string | null; versionLabel: string | null };
  organisations: Record<string, OrganisationAgreementState>;
  /**
   * False when there were more agreements than the read walks. An organisation
   * missing from `organisations` is then UNKNOWN rather than unpapered, and
   * the console must say so rather than offer to send it a first agreement.
   */
  complete: boolean;
};

const STATES_PAGE = 1000;
const STATES_PAGES = 10;

/** Every organisation's agreement standing, for the Builders Network console. */
export async function readOrganisationAgreementStates(): Promise<BuilderAgreementStates> {
  const notInstalled: BuilderAgreementStates = {
    installed: false,
    terms: { state: "not_installed", name: null, versionLabel: null },
    organisations: {},
    complete: true,
  };
  const terms = await readTermsInForce();
  if (terms.state === "not_installed") return notInstalled;

  // Paged by id so a row written mid-walk cannot shift a page boundary and be
  // read twice or not at all; grouping does not care about order.
  const grouped = new Map<string, BuilderAgreementSummary[]>();
  let complete = false;
  for (let page = 0; page < STATES_PAGES; page++) {
    const { data, error } = await supabaseAdmin
      .from("client_agreements")
      .select(`builder_organisation_id, ${SUMMARY_SELECT}`)
      .eq("document_kind", BUILDER_PARTNER_KIND)
      .not("builder_organisation_id", "is", null)
      .order("id", { ascending: true })
      .range(page * STATES_PAGE, (page + 1) * STATES_PAGE - 1);
    if (error) {
      if (isSchemaAbsent(error)) return notInstalled;
      throw new Error(`The Builder Partner Agreements could not be read: ${error.message}`);
    }
    for (const raw of data ?? []) {
      const r = raw as unknown as { builder_organisation_id: string };
      const list = grouped.get(r.builder_organisation_id) ?? [];
      list.push(toAgreementSummary(raw as never));
      grouped.set(r.builder_organisation_id, list);
    }
    if ((data ?? []).length < STATES_PAGE) {
      complete = true;
      break;
    }
  }
  const organisations: Record<string, OrganisationAgreementState> = {};
  for (const [orgId, list] of grouped) organisations[orgId] = organisationAgreementState(list);
  return {
    installed: true,
    terms: {
      state: terms.state,
      name: terms.state === "in_force" ? terms.terms.name : null,
      versionLabel: terms.state === "in_force" ? terms.terms.versionLabel : null,
    },
    organisations,
    complete,
  };
}

/* ───────────────────────────── the sweep ───────────────────────────── */

export type BuilderPartnerSweep = {
  installed: boolean;
  retained: number;
  retentionFailures: number;
  granted: number;
  grantAttempts: number;
  tenantsRepaired: number;
  errors: string[];
};

/**
 * What the agreements refresh does for Builder Partner Agreements: retain
 * signed records DocuSign has not been asked for yet, grant armed access the
 * signature could not, retry grants that failed for reasons of ours, and
 * create any metering account a grant left missing. Never throws.
 */
export async function sweepBuilderPartnerAgreements(opts: {
  retention: boolean;
}): Promise<BuilderPartnerSweep> {
  const out: BuilderPartnerSweep = {
    installed: true,
    retained: 0,
    retentionFailures: 0,
    granted: 0,
    grantAttempts: 0,
    tenantsRepaired: 0,
    errors: [],
  };
  const base = () =>
    supabaseAdmin
      .from("client_agreements")
      .select("id, builder_organisation_id, client_org, client_name")
      .eq("document_kind", BUILDER_PARTNER_KIND)
      .eq("status", "signed");
  try {
    if (opts.retention) {
      const { data, error } = await base()
        .is("signed_record_path", null)
        .not("docusign_envelope_id", "is", null)
        .limit(25);
      if (error) {
        if (isSchemaAbsent(error)) return { ...out, installed: false };
        out.errors.push(`retention: ${error.message}`);
      }
      for (const row of data ?? []) {
        const retained = await retainSignedBuilderPartnerRecord(row.id);
        if (retained.ok) out.retained++;
        else out.retentionFailures++;
      }
    }

    const { data: armed, error: armedError } = await base()
      .eq("grant_access_on_signature", true)
      .not("signed_record_path", "is", null)
      .filter("portal_access_status", "is", null)
      .limit(10);
    const { data: retry, error: retryError } = await base()
      .eq("grant_access_on_signature", true)
      .in("portal_access_status", ["failed", "pending"])
      .limit(10);
    for (const err of [armedError, retryError]) {
      if (!err) continue;
      if (isSchemaAbsent(err)) return { ...out, installed: false };
      out.errors.push(`grants: ${err.message}`);
    }
    for (const row of [...(armed ?? []), ...(retry ?? [])]) {
      const result = await grantBuilderPortalAccess(row.id, {
        trigger: "sweep",
        actorUserId: null,
      });
      if (result.outcome !== "skipped") out.grantAttempts++;
      if (result.outcome === "granted") out.granted++;
    }

    // A grant whose metering account could not be created is repaired here:
    // the evidence is the tenants table itself, not a flag that could lie.
    const { data: granted, error: grantedError } = await base()
      .eq("portal_access_status", "granted")
      .not("builder_organisation_id", "is", null)
      .order("updated_at", { ascending: false })
      .limit(200);
    if (grantedError) out.errors.push(`tenants: ${grantedError.message}`);
    const byRef = new Map<string, { orgId: string; name: string }>();
    for (const row of granted ?? []) {
      const orgId = row.builder_organisation_id as string;
      byRef.set(builderOrgTenantRef(orgId), { orgId, name: row.client_org || row.client_name });
    }
    if (byRef.size) {
      const { data: tenants, error: tenantsError } = await supabaseAdmin
        .from("tenants")
        .select("external_ref")
        .in("external_ref", [...byRef.keys()])
        .is("clone_id", null);
      if (tenantsError) {
        out.errors.push(`tenants: ${tenantsError.message}`);
      } else {
        const present = new Set((tenants ?? []).map((t) => t.external_ref));
        const missing = [...byRef.entries()].filter(([ref]) => !present.has(ref)).slice(0, 10);
        for (const [ref, { name }] of missing) {
          const tenant = await ensureTenant(null, ref, name);
          if (tenant.ok) out.tenantsRepaired++;
          else out.errors.push(`tenant ${ref}: ${tenant.error}`);
        }
      }
    }
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}

/* ───────────────────────────── documents and the page ───────────────────────────── */

/**
 * The execution schedule: the one DocuSign received for an issued agreement
 * (verified against its recorded digest), or a preview under the terms in
 * force for a draft — marked as a preview on its face.
 */
export async function readBuilderPartnerSchedule(
  agreementId: string,
): Promise<{ base64: string; filename: string; issued: boolean }> {
  const row = await readBuilderRow(agreementId);
  const reference = row.offer_reference ?? row.id;
  const snapshot = row.docusign_envelope_id
    ? readBuilderPartnerSnapshot(row.issued_snapshot)
    : null;
  if (snapshot) {
    const bytes = new Uint8Array(Buffer.from(snapshot.schedule.base64, "base64"));
    if ((await sha256Hex(bytes)) !== snapshot.schedule.sha256) {
      throw new Error("The issued execution schedule no longer matches its recorded SHA-256.");
    }
    return {
      base64: snapshot.schedule.base64,
      filename: `${snapshot.schedule.name}.pdf`,
      issued: true,
    };
  }
  const terms = await readTermsInForce();
  if (terms.state === "not_installed") throw new Error(NOT_INSTALLED_MESSAGE);
  if (terms.state === "none") throw new Error(NO_TERMS_MESSAGE);
  const particulars = readParticulars(row.offer);
  if (!particulars) throw new Error("This agreement's particulars could not be read.");
  const config = docusignConfig();
  const schedule = await buildExecutionSchedule({
    reference,
    issuedOn: issuingDay(new Date()),
    preview: true,
    particulars,
    terms: scheduleTerms(terms.terms),
    countersignerName: terms.terms.countersignatureRequired ? config.countersignerName : null,
  });
  return {
    base64: bytesToBase64(schedule.bytes),
    filename: `${scheduleDocumentName(reference, true)}.pdf`,
    issued: false,
  };
}

/** The terms file this agreement was sent under — or, for a draft, the terms in force. */
export async function readBuilderPartnerAgreementTerms(
  agreementId: string,
): Promise<{ base64: string; filename: string; mediaType: string }> {
  const row = await readBuilderRow(agreementId);
  const snapshot = row.docusign_envelope_id
    ? readBuilderPartnerSnapshot(row.issued_snapshot)
    : null;
  if (snapshot) {
    const template = await readTemplateRow(snapshot.terms.templateId);
    if (template.sha256 !== snapshot.terms.sha256) {
      throw new Error(
        "The registered terms no longer match the ones this agreement was sent under.",
      );
    }
    return readRegisteredTermsFile(template.id);
  }
  const terms = await readTermsInForce();
  if (terms.state === "not_installed") throw new Error(NOT_INSTALLED_MESSAGE);
  if (terms.state === "none") throw new Error(NO_TERMS_MESSAGE);
  return readRegisteredTermsFile(terms.terms.id);
}

export type BuilderPartnerAgreementView = {
  id: string;
  reference: string | null;
  status: string;
  builderOrganisationId: string | null;
  particulars: BuilderPartnerParticulars | null;
  gaps: ParticularsGaps | null;
  sendState: ReturnType<typeof sendClaimState>;
  issued:
    | (Omit<BuilderPartnerIssuedSnapshot, "schedule" | "particulars"> & {
        schedule: { name: string; sha256: string; bytes: number; pageCount: number };
      })
    | null;
  termsInForce: {
    id: string;
    name: string;
    versionLabel: string;
    countersignatureRequired: boolean;
  } | null;
  termsState: TermsInForce["state"];
  grantAccessOnSignature: boolean;
  portalAccess: {
    status: string | null;
    attemptedAt: string | null;
    grantedAt: string | null;
    detail: string | null;
  };
  signedRecord: { retained: boolean; sha256: string | null };
  /** Whether the builder's metering account exists; null when it could not be read. */
  meteringAccount: boolean | null;
  docusignReady: boolean;
  updatedAt: string;
};

/** Everything the agreement page shows for a Builder Partner Agreement. */
export async function describeBuilderPartnerAgreement(
  agreementId: string,
): Promise<BuilderPartnerAgreementView> {
  const row = await readBuilderRow(agreementId);
  const particulars = readParticulars(row.offer);
  const snapshot = readBuilderPartnerSnapshot(row.issued_snapshot);
  const terms = await readTermsInForce().catch((): TermsInForce | null => null);
  let meteringAccount: boolean | null = null;
  if (row.builder_organisation_id && row.portal_access_status === "granted") {
    const { data, error } = await supabaseAdmin
      .from("tenants")
      .select("id")
      .eq("external_ref", builderOrgTenantRef(row.builder_organisation_id))
      .limit(1);
    meteringAccount = error ? null : Boolean(data?.length);
  }
  let issued: BuilderPartnerAgreementView["issued"] = null;
  if (snapshot) {
    const { schedule, particulars: _issuedParticulars, ...rest } = snapshot;
    void _issuedParticulars;
    issued = {
      ...rest,
      schedule: {
        name: schedule.name,
        sha256: schedule.sha256,
        bytes: schedule.bytes,
        pageCount: schedule.pageCount,
      },
    };
  }
  return {
    id: row.id,
    reference: row.offer_reference,
    status: row.status,
    builderOrganisationId: row.builder_organisation_id,
    particulars: snapshot?.particulars ?? particulars,
    gaps: particulars ? particularsGaps(particulars) : null,
    sendState: sendClaimState(row, Date.now()),
    issued,
    termsInForce:
      terms?.state === "in_force"
        ? {
            id: terms.terms.id,
            name: terms.terms.name,
            versionLabel: terms.terms.versionLabel,
            countersignatureRequired: terms.terms.countersignatureRequired,
          }
        : null,
    termsState: terms?.state ?? "none",
    grantAccessOnSignature: row.grant_access_on_signature,
    portalAccess: {
      status: row.portal_access_status,
      attemptedAt: row.portal_access_attempted_at,
      grantedAt: row.portal_access_granted_at,
      detail: row.portal_access_detail,
    },
    signedRecord: { retained: Boolean(row.signed_record_path), sha256: row.signed_record_sha256 },
    meteringAccount,
    docusignReady: docusignConfig().ready,
    updatedAt: row.updated_at,
  };
}
