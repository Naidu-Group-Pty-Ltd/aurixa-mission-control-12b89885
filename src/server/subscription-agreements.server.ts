/**
 * Subscription Agreements on the wire: completing the approved template for
 * one offer, sending it through DocuSign, and keeping what comes back.
 *
 * `agreements.server.ts` is the DocuSign engine both kinds of agreement share
 * — the JWT grant, status folding, void, the lifecycle, the refresh cron and
 * the Connect webhook all reach an agreement through it. This module is the
 * part only a Subscription Agreement has, and it is shaped by the agreement's
 * own clause 1.2:
 *
 *   "Aurixa makes an offer by authorised issue of the completed document …
 *    An uncompleted template is not an offer … We retain the accepted
 *    document and commercial snapshot before activating the purchase; missing
 *    acceptance evidence cannot be replaced by recording an assumed earlier
 *    signature."
 *
 * So, in the order a send runs:
 *
 *  1. **The template is the approved file or nothing.** It is fetched from
 *     the Worker's own origin and its SHA-256 compared with the committed
 *     digest before a byte of it is used.
 *  2. **The offer is complete or nothing.** `toDocumentFill` refuses a
 *     composition with any gap, and the fill engine refuses a document that
 *     still carries a control, a placeholder or a missing signing anchor.
 *  3. **One press, one envelope.** A send CLAIMS the offer first, by
 *     compare-and-set on `issued_at`, so a double click or two operators
 *     produce one envelope. A claim left behind by a send that died is taken
 *     over only after DocuSign has been asked whether that send's envelope
 *     exists — every envelope carries its agreement id as a custom field for
 *     exactly this question.
 *  4. **The commercial snapshot is written before the envelope is created.**
 *  5. **An ambiguous failure is never retried blind.** When DocuSign's answer
 *     does not say whether an envelope was created, the claim is kept and the
 *     next press asks DocuSign first. Releasing it would let the retry send
 *     the customer a second offer.
 *  6. **The accepted document is retained.** When the envelope completes, the
 *     combined signed PDF with DocuSign's certificate of completion is copied
 *     into the private `agreement-records` bucket and its digest recorded;
 *     provisioning refuses a subscription agreement whose record is not held.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import {
  completeSubscriptionDocument,
  sha256Hex,
  type CompletedDocument,
} from "@/lib/agreements/docxPackage.pure";
import {
  AGREEMENT_ID_CUSTOM_FIELD,
  AGREEMENT_RECORDS_BUCKET,
  agreementColumnsFromOffer,
  buildIssuedSnapshot,
  buildSubscriptionEnvelopeDefinition,
  issuedDocumentMeta,
  issuedDocumentName,
  issuingDay,
  looksLikePdf,
  pickRecoveredEnvelope,
  previewDocumentName,
  provisioningSelectionFromOffer,
  selectionMatches,
  sendClaimState,
  signedRecordPath,
  STALE_SEND_CLAIM_MS,
  type IssuedSnapshot,
} from "@/lib/agreements/subscriptionIssue.pure";
import {
  composeSubscriptionOffer,
  offerTitle,
  subscriptionOfferSchema,
  toDocumentFill,
  type ComposedOffer,
  type RateCard,
  type SubscriptionOffer,
} from "@/lib/agreements/subscriptionOffer.pure";
import {
  SUBSCRIPTION_ANCHOR_LIST,
  SUBSCRIPTION_TEMPLATES,
  type SubscriptionTierSlug,
} from "@/lib/agreements/subscriptionTemplates";
import {
  agreementAssetUrl,
  bytesToBase64,
  docusignConfig,
  getDocusignAccessToken,
  mapEnvelopeStatus,
  type DocusignConfig,
} from "@/server/agreements.server";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { indexVersion } from "@/server/report-cost-index.server";

const encoder = new TextEncoder();

/* ───────────────────────────── reading ───────────────────────────── */

const SUBSCRIPTION_SELECT =
  "id, document_kind, status, offer, offer_reference, issued_at, issued_snapshot, " +
  "docusign_envelope_id, plan_slug, addon_slugs, provision_on_signature, signed_record_path, " +
  "signed_record_sha256, client_name";

type SubscriptionRow = {
  id: string;
  document_kind: string;
  status: string;
  offer: Json | null;
  offer_reference: string | null;
  issued_at: string | null;
  issued_snapshot: Json | null;
  docusign_envelope_id: string | null;
  plan_slug: string | null;
  addon_slugs: string[] | null;
  provision_on_signature: boolean;
  signed_record_path: string | null;
  signed_record_sha256: string | null;
  client_name: string;
};

async function readSubscriptionRow(agreementId: string): Promise<SubscriptionRow> {
  const { data, error } = await supabaseAdmin
    .from("client_agreements")
    .select(SUBSCRIPTION_SELECT)
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw new Error(`The agreement could not be read: ${error.message}`);
  if (!data) throw new Error("agreement_not_found");
  const row = data as unknown as SubscriptionRow;
  if (row.document_kind !== "subscription") throw new Error("not_a_subscription_agreement");
  if (!row.offer_reference) throw new Error("The agreement has no offer reference.");
  return row;
}

function storedOffer(value: Json | null): SubscriptionOffer {
  const parsed = subscriptionOfferSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `The stored offer is not a valid offer${issue ? ` (${issue.path.join(".")}: ${issue.message})` : ""}.`,
    );
  }
  return parsed.data;
}

/**
 * The live report rate card Schedule A4 quotes: every active report cost, in
 * the catalogue's order, versioned exactly as the public pricing catalogue
 * versions it — so the version printed on an offer is the version every clone
 * was charging under. Null when it cannot be read, which the composer turns
 * into a gap rather than an offer that states no costs.
 */
export async function readRateCard(): Promise<RateCard | null> {
  const { data, error } = await supabaseAdmin
    .from("report_credit_costs")
    .select("slug, name, credit_cost, updated_at")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("[subscription-agreements] rate card read failed:", error.message);
    return null;
  }
  const rows = data ?? [];
  const version = indexVersion(rows);
  if (!rows.length || !version) return null;
  return {
    rows: rows.map((r) => ({ slug: r.slug, name: r.name, credit_cost: r.credit_cost })),
    version,
  };
}

/* ───────────────────────────── the document ───────────────────────────── */

/**
 * Verified template bytes, per isolate. Only a file whose digest matched is
 * ever cached, so the cache cannot hold an unapproved template.
 */
const templateCache = new Map<SubscriptionTierSlug, Uint8Array>();

async function approvedTemplate(tier: SubscriptionTierSlug): Promise<Uint8Array> {
  const cached = templateCache.get(tier);
  if (cached) return cached;
  const t = SUBSCRIPTION_TEMPLATES[tier];
  const res = await fetch(agreementAssetUrl(t.path));
  if (!res.ok) {
    throw new Error(`The ${t.tierName} template could not be fetched (HTTP ${res.status}).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (digest !== t.sha256) {
    throw new Error(
      `The ${t.tierName} template served at ${t.path} is not the approved file ` +
        `(SHA-256 ${digest.slice(0, 12)}…, approved ${t.sha256.slice(0, 12)}…). Nothing was issued.`,
    );
  }
  templateCache.set(tier, bytes);
  return bytes;
}

async function completeOffer(input: {
  offer: SubscriptionOffer;
  offerReference: string;
  issuedAt: string;
  rateCard: RateCard | null;
  preview: boolean;
}): Promise<{ composed: ComposedOffer; document: CompletedDocument }> {
  const composed = composeSubscriptionOffer(input.offer, {
    offerReference: input.offerReference,
    rateCard: input.rateCard,
    today: issuingDay(new Date(input.issuedAt)),
    preview: input.preview,
  });
  const fill = toDocumentFill(composed);
  const template = await approvedTemplate(input.offer.tier);
  const document = await completeSubscriptionDocument(template, fill, {
    anchors: SUBSCRIPTION_ANCHOR_LIST,
    meta: issuedDocumentMeta({
      tier: input.offer.tier,
      offerReference: input.offerReference,
      customerLegalName: input.offer.customer.legalName,
      issuedAt: input.issuedAt,
      preview: input.preview,
    }),
  });
  return { composed, document };
}

function readSnapshot(value: Json | null): IssuedSnapshot | null {
  const s = value as Partial<IssuedSnapshot> | null;
  if (!s || s.schema !== 1 || !s.issuedAt || !s.rateCard || !s.document?.documentXmlSha256) {
    return null;
  }
  return s as IssuedSnapshot;
}

/**
 * The offer as a Word document. Before it is sent, a PREVIEW — composed from
 * the working offer and the live rate card, and marked in its title, file
 * name and acceptance field as not an offer. After it is sent, the ISSUED
 * offer, reproduced from its record (the frozen offer, the snapshot's rate
 * card and issue time) and served only if its document text hashes to what
 * the snapshot recorded — so this can never hand an operator a document that
 * differs from the one the customer received.
 */
export async function downloadSubscriptionDocument(agreementId: string): Promise<{
  base64: string;
  filename: string;
  kind: "preview" | "issued";
}> {
  const row = await readSubscriptionRow(agreementId);
  const offer = storedOffer(row.offer);
  const reference = row.offer_reference as string;

  if (row.docusign_envelope_id) {
    const snapshot = readSnapshot(row.issued_snapshot);
    if (!snapshot) {
      throw new Error(
        "This offer has no commercial snapshot to reproduce it from. The document as sent is in DocuSign.",
      );
    }
    const { document } = await completeOffer({
      offer,
      offerReference: reference,
      issuedAt: snapshot.issuedAt,
      rateCard: snapshot.rateCard,
      preview: false,
    });
    const xmlSha = await sha256Hex(encoder.encode(document.documentXml));
    if (xmlSha !== snapshot.document.documentXmlSha256) {
      throw new Error(
        "The issued offer could not be reproduced exactly — the template or the composer has " +
          "changed since it was sent. Nothing is served rather than a document that differs from " +
          "the one the customer received; the document as sent is in DocuSign.",
      );
    }
    return {
      base64: bytesToBase64(document.bytes),
      filename: snapshot.document.name,
      kind: "issued",
    };
  }

  const { document } = await completeOffer({
    offer,
    offerReference: reference,
    issuedAt: new Date().toISOString(),
    rateCard: await readRateCard(),
    preview: true,
  });
  return {
    base64: bytesToBase64(document.bytes),
    filename: previewDocumentName(offer.tier, reference),
    kind: "preview",
  };
}

/* ───────────────────────────── sending ───────────────────────────── */

type EnvelopeLookup =
  | { envelopeId: string; status: string; sentDateTime: string | null }
  | null
  | "unknown";

/**
 * Ask DocuSign whether an envelope for this agreement exists — the question
 * that makes taking over a dead send safe. "unknown" when DocuSign could not
 * be asked; a caller must then do nothing, because silence is not absence.
 */
async function findEnvelopeForAgreement(
  config: DocusignConfig,
  token: string,
  agreementId: string,
  since: string,
): Promise<EnvelopeLookup> {
  const from = new Date(Date.parse(since) - 24 * 60 * 60_000);
  const params = new URLSearchParams({
    from_date: Number.isFinite(from.getTime()) ? from.toISOString() : since,
    custom_field: `${AGREEMENT_ID_CUSTOM_FIELD}=${agreementId}`,
  });
  try {
    const res = await fetch(
      `${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    );
    if (!res.ok) return "unknown";
    return pickRecoveredEnvelope(await res.json());
  } catch {
    return "unknown";
  }
}

async function releaseClaim(agreementId: string, claimAt: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("client_agreements")
    .update({ issued_at: null, issued_snapshot: null })
    .eq("id", agreementId)
    .eq("issued_at", claimAt)
    .is("docusign_envelope_id", null);
  if (error) console.error("[subscription-agreements] claim release failed:", error.message);
}

/**
 * Record the envelope against the claim that created it. Retried, because an
 * envelope DocuSign has accepted and Mission Control has not recorded is the
 * worst state this flow has: the customer holds an offer the platform cannot
 * see. If the record cannot be written the claim is left in place, so the
 * next press recovers the envelope by its custom field instead of sending a
 * second one — and an operator is told either way.
 */
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
    title: "Subscription offer sent but not recorded",
    body:
      `DocuSign accepted envelope ${envelope.envelopeId}, but it could not be recorded on the ` +
      `agreement (${lastError}). Do not raise a new offer: pressing Send again on this agreement ` +
      `finds the envelope in DocuSign and records it.`,
    url: `/agreements/${agreementId}`,
    metadata: { agreement_id: agreementId, envelope_id: envelope.envelopeId },
  });
  throw new Error(
    `DocuSign accepted envelope ${envelope.envelopeId}, but it could not be recorded (${lastError}). ` +
      "Do not raise a new offer — press Send again to recover it.",
  );
}

/**
 * The checks an offer must pass to be sent that the composer cannot make,
 * because they are about the row rather than the document: armed provisioning
 * must provision what the offer sells. Saving the offer keeps the two in step
 * and disarms on a change, so a mismatch is a row edited around the editor.
 */
function assertIssuable(
  offer: SubscriptionOffer,
  row: Pick<SubscriptionRow, "plan_slug" | "addon_slugs" | "provision_on_signature">,
): void {
  const selection = provisioningSelectionFromOffer(offer);
  if (row.provision_on_signature && !selectionMatches(row, selection)) {
    const armedFor = [row.plan_slug ?? "no plan", ...(row.addon_slugs ?? [])].join(" + ");
    const sold = [selection.planSlug, ...selection.addonSlugs].join(" + ");
    throw new Error(
      `Provisioning is armed for ${armedFor}, but this ${SUBSCRIPTION_TEMPLATES[offer.tier].tierName} ` +
        `offer sells ${sold}. Re-arm provisioning from the offer, or disarm it, before sending.`,
    );
  }
}

export type SubscriptionSendResult = {
  envelopeId: string;
  status: string;
  /** True when a lost send's envelope was found and recorded rather than a new one created. */
  recovered: boolean;
};

export async function sendSubscriptionEnvelope(
  agreementId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<SubscriptionSendResult> {
  const config = docusignConfig();
  if (!config.ready) {
    throw new Error(`DocuSign not configured; missing: ${config.missing.join(", ")}`);
  }
  const row = await readSubscriptionRow(agreementId);
  const reference = row.offer_reference as string;

  const now = Date.now();
  const state = sendClaimState(row, now);
  if (state === "sent") throw new Error("agreement_already_sent");
  if (row.status !== "draft") {
    throw new Error(
      `This offer is ${row.status}. An offer that was withdrawn is not sent again — duplicate it to raise a new one.`,
    );
  }
  if (state === "in_flight") {
    throw new Error(
      "This offer is already being sent. Refresh in a moment — pressing Send again does not send a second envelope.",
    );
  }
  // Refuse an unreadable or mis-armed offer before anything is claimed. The
  // same checks run again on the offer as it stood at the claim, which is the
  // one that is actually issued.
  assertIssuable(storedOffer(row.offer), row);

  const token = await getDocusignAccessToken(config);

  if (state === "stale") {
    // A send died between claiming the offer and recording its envelope. Ask
    // DocuSign whether it got as far as creating one before trying again.
    const found = await findEnvelopeForAgreement(
      config,
      token,
      agreementId,
      row.issued_at as string,
    );
    if (found === "unknown") {
      throw new Error(
        "An earlier send of this offer did not finish, and DocuSign could not be asked whether it " +
          "created the envelope. Nothing was sent — try again shortly.",
      );
    }
    if (found) {
      await recordEnvelope(agreementId, row.issued_at as string, found);
      await writeAuditLog({
        action: "agreement.subscription_recovered",
        entityType: "client_agreement",
        entityId: agreementId,
        actorUserId: opts.actorUserId ?? null,
        metadata: { offer_reference: reference, envelope_id: found.envelopeId },
      });
      return { envelopeId: found.envelopeId, status: found.status, recovered: true };
    }
  }

  // ── Claim ────────────────────────────────────────────────────────────
  // The claim returns the offer as it stands at that instant, and that is the
  // offer issued: a save is refused once `issued_at` is set, so nothing can
  // change it between here and the envelope. Issuing the copy read before the
  // claim would let an edit that landed in between reach the row but not the
  // document — a record that disagrees with what the customer received.
  const claimAt = new Date(now).toISOString();
  // A fresh claim needs no claim on the row; taking over a stale one needs
  // exactly the claim that was judged stale, so two presses cannot both win.
  const previousClaim = state === "stale" ? (row.issued_at as string) : null;
  const { data: claimed, error: claimError } = await supabaseAdmin
    .from("client_agreements")
    .update({ issued_at: claimAt, issued_snapshot: null })
    .eq("id", agreementId)
    .eq("status", "draft")
    .is("docusign_envelope_id", null)
    .filter("issued_at", previousClaim === null ? "is" : "eq", previousClaim)
    .select("id, offer, plan_slug, addon_slugs, provision_on_signature");
  if (claimError)
    throw new Error(`The offer could not be claimed for sending: ${claimError.message}`);
  if (!claimed?.length) {
    throw new Error("Another send of this offer started at the same moment. Refresh to see it.");
  }

  // ── Issue, and write the snapshot, before anything leaves ─────────────
  let definition: Record<string, unknown>;
  let snapshot: IssuedSnapshot;
  let offer: SubscriptionOffer;
  try {
    const held = claimed[0] as unknown as Pick<
      SubscriptionRow,
      "offer" | "plan_slug" | "addon_slugs" | "provision_on_signature"
    >;
    offer = storedOffer(held.offer);
    assertIssuable(offer, held);
    const rateCard = await readRateCard();
    if (!rateCard) {
      throw new Error(
        "The report rate card could not be read, and Schedule A4 must state it. Nothing was sent.",
      );
    }
    const { composed, document } = await completeOffer({
      offer,
      offerReference: reference,
      issuedAt: claimAt,
      rateCard,
      preview: false,
    });
    const carbonCopy = config.countersignerEmail
      ? { name: config.countersignerName, email: config.countersignerEmail }
      : null;
    snapshot = buildIssuedSnapshot({
      offerReference: reference,
      issuedAt: claimAt,
      tier: offer.tier,
      composed,
      rateCard,
      document: {
        name: issuedDocumentName(offer.tier, reference),
        sha256: document.sha256,
        bytes: document.bytes.length,
        documentXmlSha256: await sha256Hex(encoder.encode(document.documentXml)),
      },
      signer: { name: offer.signatory.name, email: offer.signatory.email },
      carbonCopy: carbonCopy?.email ?? null,
    });
    const { data: recorded, error: snapshotError } = await supabaseAdmin
      .from("client_agreements")
      .update({ issued_snapshot: asJson(snapshot), ...agreementColumnsFromOffer(offer) })
      .eq("id", agreementId)
      .eq("issued_at", claimAt)
      .is("docusign_envelope_id", null)
      .select("id");
    if (snapshotError) {
      throw new Error(`The commercial snapshot could not be recorded: ${snapshotError.message}`);
    }
    if (!recorded?.length) {
      throw new Error("The send lost its claim before the envelope was created.");
    }
    definition = buildSubscriptionEnvelopeDefinition({
      agreementId,
      offerReference: reference,
      tier: offer.tier,
      title: offerTitle(offer.tier, offer.customer.legalName),
      documentBase64: bytesToBase64(document.bytes),
      signer: { name: offer.signatory.name, email: offer.signatory.email },
      customerLegalName: offer.customer.legalName,
      correctionRoute: offer.service.correctionRoute,
      carbonCopy,
    });
  } catch (err) {
    // Nothing has left Mission Control: the offer is free to be sent again.
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
      action: "agreement.subscription_sent",
      entityType: "client_agreement",
      entityId: agreementId,
      actorUserId: opts.actorUserId ?? null,
      metadata: {
        offer_reference: reference,
        envelope_id: envelope.envelopeId,
        tier: offer.tier,
        template_id: snapshot.template.id,
        document_sha256: snapshot.document.sha256,
        rate_card_version: snapshot.rateCard.version,
      },
    });
    return { ...envelope, recovered: false };
  }

  if (response && response.status >= 400 && response.status < 500) {
    // DocuSign refused the request outright: no envelope exists.
    await releaseClaim(agreementId, claimAt);
    throw new Error(
      `DocuSign refused the envelope: ${body.message || body.errorCode || `HTTP ${response.status}`}`,
    );
  }

  // The answer does not say whether an envelope was created. Look once; if it
  // is not there yet, KEEP the claim — a blind retry is how a customer gets
  // two offers — and let the next press ask DocuSign again.
  const found = await findEnvelopeForAgreement(config, token, agreementId, claimAt);
  if (found && found !== "unknown") {
    await recordEnvelope(agreementId, claimAt, found);
    return { envelopeId: found.envelopeId, status: found.status, recovered: true };
  }
  const retryAt = new Date(now + STALE_SEND_CLAIM_MS).toLocaleTimeString("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    minute: "2-digit",
  });
  throw new Error(
    `DocuSign did not confirm the envelope (${transportError || (response ? `HTTP ${response.status}` : "no response")}). ` +
      `So the customer cannot receive this offer twice, it is held until ${retryAt} Sydney time; ` +
      "pressing Send after that first checks DocuSign for the envelope.",
  );
}

/* ───────────────────────────── the signed record ───────────────────────────── */

export type RetentionResult = { ok: true; path: string } | { ok: false; error: string };

/**
 * Copy the completed envelope — every document, with DocuSign's certificate
 * of completion — into the private records bucket, and record where and what.
 *
 * Idempotent in both directions: a record already on the row is returned as
 * is, and an object already in the bucket (a previous attempt that uploaded
 * and then failed to record) is recorded rather than replaced. Never throws;
 * the answer says why a record is missing, and provisioning names it.
 */
export async function retainSignedSubscriptionRecord(
  agreementId: string,
): Promise<RetentionResult> {
  try {
    const row = await readSubscriptionRow(agreementId);
    if (row.signed_record_path) return { ok: true, path: row.signed_record_path };
    if (row.status !== "signed") return { ok: false, error: "the agreement is not signed" };
    if (!row.docusign_envelope_id) return { ok: false, error: "the agreement has no envelope" };

    const config = docusignConfig();
    if (!config.ready) {
      return { ok: false, error: `DocuSign not configured; missing: ${config.missing.join(", ")}` };
    }
    const path = signedRecordPath(agreementId, row.docusign_envelope_id);
    const bucket = supabaseAdmin.storage.from(AGREEMENT_RECORDS_BUCKET);

    let bytes: Uint8Array | null = null;
    const existing = await bucket.download(path);
    if (!existing.error && existing.data) {
      bytes = new Uint8Array(await existing.data.arrayBuffer());
      if (!looksLikePdf(bytes)) {
        return { ok: false, error: `an object at ${path} exists but is not a PDF` };
      }
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
      if (!looksLikePdf(bytes)) {
        return { ok: false, error: "DocuSign's signed document is not a PDF" };
      }
      const { error: uploadError } = await bucket.upload(path, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploadError) {
        return { ok: false, error: `the signed PDF could not be stored: ${uploadError.message}` };
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
      // Another caller recorded it first — theirs is the record.
      const again = await readSubscriptionRow(agreementId);
      return again.signed_record_path
        ? { ok: true, path: again.signed_record_path }
        : { ok: false, error: "the retained record could not be noted" };
    }
    await writeAuditLog({
      action: "agreement.signed_record_retained",
      entityType: "client_agreement",
      entityId: agreementId,
      metadata: {
        offer_reference: row.offer_reference,
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

/**
 * The retained signed record, served only while its bytes still hash to what
 * was recorded when it was taken. A mismatch is refused, not explained away:
 * a record that has changed is not the record.
 */
export async function readRetainedSignedRecord(agreementId: string): Promise<{
  base64: string;
  filename: string;
} | null> {
  const row = await readSubscriptionRow(agreementId);
  if (!row.signed_record_path || !row.signed_record_sha256) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(AGREEMENT_RECORDS_BUCKET)
    .download(row.signed_record_path);
  if (error || !data) {
    throw new Error(`The retained signed record could not be read: ${error?.message ?? "empty"}`);
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== row.signed_record_sha256) {
    throw new Error(
      `The retained signed record no longer matches its recorded SHA-256 (${row.signed_record_sha256.slice(0, 12)}…).`,
    );
  }
  const tierName = (() => {
    try {
      return SUBSCRIPTION_TEMPLATES[storedOffer(row.offer).tier].tierName;
    } catch {
      return "Subscription";
    }
  })();
  return {
    base64: bytesToBase64(bytes),
    filename: `Aurixa ${tierName} Subscription Agreement ${row.offer_reference} - signed.pdf`,
  };
}
