// Client agreements — the DocuSign engine behind /agreements.
//
// Mirrors the prime repo's manage-agency-agreements flow on a Cloudflare
// Worker: JWT-grant auth (an RS256 JWT signed with the integration key's
// RSA private key — hand-rolled with WebCrypto, since the DocuSign SDK
// assumes Node), an envelope built from the Aurixa SLA template PDF with
// anchor-token tabs, polling for envelope status, signed-document download,
// and void. The template carries invisible anchor tokens (~6pt text painted
// in the exact colour of the panel it sits on, so it vanishes on the dark
// execution page); DocuSign's text scanner places signature, date
// and name tabs on them, and locked text tabs prefill the client's details
// — so the document every client sees is the branded Gamma layout, not a
// generated form.
//
// DocuSign is configured entirely through Worker env secrets and the whole
// feature reports "not configured" until they exist — the Twilio softphone
// pattern. Nothing here invents a credential.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";
import type { Database, Json } from "@/integrations/supabase/types";

/* --------------------------------- config --------------------------------- */

export type DocusignConfig = {
  ready: boolean;
  missing: string[];
  integrationKey: string;
  userId: string;
  rsaPrivateKey: string;
  accountId: string;
  baseUrl: string;
  oauthHost: string;
  countersignerName: string | null;
  countersignerEmail: string | null;
};

const REQUIRED_ENV = [
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_RSA_PRIVATE_KEY",
  "DOCUSIGN_ACCOUNT_ID",
] as const;

export function docusignRestBaseUrl(raw?: string): string {
  const configured = (
    raw ??
    process.env.DOCUSIGN_BASE_URL ??
    "https://demo.docusign.net/restapi"
  ).trim();
  const normalized = configured.replace(/\/+$/, "");
  return normalized.toLowerCase().endsWith("/restapi") ? normalized : `${normalized}/restapi`;
}

export function docusignOauthHost(restBaseUrl: string): string {
  const explicit = process.env.DOCUSIGN_OAUTH_HOST?.trim();
  if (explicit) return explicit;
  const lower = restBaseUrl.toLowerCase();
  const isProduction =
    lower.includes("//www.docusign.net") ||
    lower.includes("//na") ||
    lower.includes("//eu") ||
    lower.includes("//au");
  return isProduction ? "account.docusign.com" : "account-d.docusign.com";
}

export function docusignConfig(): DocusignConfig {
  const values = Object.fromEntries(REQUIRED_ENV.map((k) => [k, (process.env[k] ?? "").trim()]));
  const missing = REQUIRED_ENV.filter((k) => !values[k]);
  const baseUrl = docusignRestBaseUrl();
  return {
    ready: missing.length === 0,
    missing: [...missing],
    integrationKey: values.DOCUSIGN_INTEGRATION_KEY,
    userId: values.DOCUSIGN_USER_ID,
    rsaPrivateKey: values.DOCUSIGN_RSA_PRIVATE_KEY,
    accountId: values.DOCUSIGN_ACCOUNT_ID,
    baseUrl,
    oauthHost: docusignOauthHost(baseUrl),
    countersignerName: process.env.DOCUSIGN_COUNTERSIGNER_NAME?.trim() || null,
    countersignerEmail: process.env.DOCUSIGN_COUNTERSIGNER_EMAIL?.trim() || null,
  };
}

/* ------------------------- PKCS#1 → PKCS#8 conversion ---------------------- */
// DocuSign's console hands out PKCS#1 RSA keys ("BEGIN RSA PRIVATE KEY");
// WebCrypto imports only PKCS#8. Ported from the prime repo's converter.

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function wrapAsn1(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: Uint8Array;
  if (len < 128) header = new Uint8Array([tag, len]);
  else if (len < 256) header = new Uint8Array([tag, 0x81, len]);
  else if (len < 65536) header = new Uint8Array([tag, 0x82, (len >> 8) & 0xff, len & 0xff]);
  else header = new Uint8Array([tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return concatBytes(header, content);
}

export function convertPkcs1ToPkcs8Pem(pem: string): string {
  if (pem.includes("BEGIN PRIVATE KEY")) return pem;
  const b64 = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const pkcs1Der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const algoId = wrapAsn1(0x30, concatBytes(rsaOid, new Uint8Array([0x05, 0x00])));
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const keyOctet = wrapAsn1(0x04, pkcs1Der);
  const pkcs8Der = wrapAsn1(0x30, concatBytes(version, algoId, keyOctet));
  let bin = "";
  for (const b of pkcs8Der) bin += String.fromCharCode(b);
  const lines = btoa(bin).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

/* ------------------------------ JWT grant auth ----------------------------- */

const encoder = new TextEncoder();

function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importRsaKey(pem: string): Promise<CryptoKey> {
  const pkcs8 = convertPkcs1ToPkcs8Pem(pem.replace(/\\n/g, "\n"));
  const b64 = pkcs8
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function signDocusignJwt(
  config: Pick<DocusignConfig, "integrationKey" | "userId" | "rsaPrivateKey" | "oauthHost">,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: config.integrationKey,
    sub: config.userId,
    aud: config.oauthHost,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    scope: "signature impersonation",
  };
  const signingInput = `${base64UrlFromBytes(encoder.encode(JSON.stringify(header)))}.${base64UrlFromBytes(encoder.encode(JSON.stringify(payload)))}`;
  const key = await importRsaKey(config.rsaPrivateKey);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(sig))}`;
}

export class DocusignConsentRequiredError extends Error {
  consentUrl: string;
  constructor(consentUrl: string) {
    super(
      "DocuSign consent required: open the consent URL in a browser, sign in as the impersonated user, and click Accept.",
    );
    this.consentUrl = consentUrl;
  }
}

export async function getDocusignAccessToken(config: DocusignConfig): Promise<string> {
  const assertion = await signDocusignJwt(config);
  const res = await fetch(`https://${config.oauthHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    if (data.error === "consent_required") {
      throw new DocusignConsentRequiredError(
        `https://${config.oauthHost}/oauth/auth?response_type=code&scope=signature%20impersonation&client_id=${config.integrationKey}&redirect_uri=https://www.docusign.com`,
      );
    }
    throw new Error(
      `DocuSign token exchange failed: ${data.error_description || data.error || res.status}`,
    );
  }
  return data.access_token;
}

/* ------------------------------ anchor tokens ------------------------------ */
// Embedded in the SLA template's execution page as ~6pt text in the panel's
// own colour — invisible to humans, found by DocuSign's text scanner. The
// build script
// (scripts/agreements/build-sla-template.mjs) is the one place that writes
// them into the PDF; these constants must match it exactly.

export const ANCHORS = {
  clientSig: "\\sig_client_1\\",
  clientDate: "\\date_client_1\\",
  clientName: "\\name_client_1\\",
  providerSig: "\\sig_provider\\",
  providerDate: "\\date_provider\\",
  providerName: "\\name_provider\\",
  fieldClientName: "\\field_client_name\\",
  fieldClientOrg: "\\field_client_org\\",
  fieldTier: "\\field_service_tier\\",
  fieldCommencement: "\\field_commencement\\",
} as const;

type AnchorTab = Record<string, string>;

function anchoredTab(
  anchor: string,
  yOffset: string,
  extra: Record<string, string> = {},
): AnchorTab {
  return {
    anchorString: anchor,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: yOffset,
    anchorIgnoreIfNotPresent: "true",
    anchorCaseSensitive: "true",
    anchorMatchWholeWord: "false",
    ...extra,
  };
}

export function buildSignerTabs(sig: string, date: string, name: string) {
  return {
    signHereTabs: [anchoredTab(sig, "-30", { scaleValue: "0.7" })],
    dateSignedTabs: [anchoredTab(date, "-2", { font: "Helvetica", fontSize: "Size10" })],
    fullNameTabs: [anchoredTab(name, "-2", { font: "Helvetica", fontSize: "Size10" })],
  };
}

export type AgreementFields = {
  clientName: string;
  clientEmail: string;
  clientOrg: string | null;
  serviceTier: string | null;
  commencementDate: string | null;
};

/** Locked, prefilled text tabs that personalise the template per client. */
export function buildFieldTabs(fields: AgreementFields): AnchorTab[] {
  const entries: Array<[string, string | null]> = [
    [ANCHORS.fieldClientName, fields.clientName],
    [ANCHORS.fieldClientOrg, fields.clientOrg],
    [ANCHORS.fieldTier, fields.serviceTier],
    [ANCHORS.fieldCommencement, fields.commencementDate],
  ];
  return entries
    .filter((e): e is [string, string] => Boolean(e[1]))
    .map(([anchor, value]) =>
      anchoredTab(anchor, "-2", {
        value,
        locked: "true",
        font: "Helvetica",
        fontSize: "Size10",
      }),
    );
}

export function buildEnvelopeDefinition(input: {
  base64Pdf: string;
  fields: AgreementFields;
  countersignerName: string | null;
  countersignerEmail: string | null;
}): Record<string, unknown> {
  const clientTabs = {
    ...buildSignerTabs(ANCHORS.clientSig, ANCHORS.clientDate, ANCHORS.clientName),
    textTabs: buildFieldTabs(input.fields),
  };
  const signers: Array<Record<string, unknown>> = [
    {
      email: input.fields.clientEmail,
      name: input.fields.clientName,
      recipientId: "1",
      routingOrder: "1",
      tabs: clientTabs,
    },
  ];
  if (input.countersignerEmail) {
    signers.push({
      email: input.countersignerEmail,
      name: input.countersignerName || "Aurixa Systems",
      recipientId: "2",
      routingOrder: "2",
      tabs: buildSignerTabs(ANCHORS.providerSig, ANCHORS.providerDate, ANCHORS.providerName),
    });
  }
  return {
    emailSubject: `Aurixa Systems Service Level Agreement — ${input.fields.clientName}`,
    emailBlurb:
      `Dear ${input.fields.clientName},\n\n` +
      `Please review and sign the attached Aurixa Systems Service Level Agreement.\n\n` +
      `Kind regards,\nAurixa Systems`,
    documents: [
      {
        documentBase64: input.base64Pdf,
        name: "Aurixa Systems Service Level Agreement.pdf",
        fileExtension: "pdf",
        documentId: "1",
      },
    ],
    recipients: { signers },
    status: "sent",
  };
}

/* ------------------------------ status mapping ----------------------------- */

/** Fold DocuSign's envelope status into the agreement lifecycle. */
export function mapEnvelopeStatus(docusignStatus: string): string | null {
  switch (docusignStatus.toLowerCase()) {
    case "completed":
      return "signed";
    case "delivered":
      return "delivered";
    case "sent":
      return "sent";
    case "declined":
      return "declined";
    case "voided":
      return "voided";
    default:
      return null;
  }
}

/* --------------------------------- actions --------------------------------- */

const TEMPLATE_PATH = "/agreements/aurixa-sla-template.pdf";
const PUBLIC_ORIGIN = (
  process.env.PUBLIC_APP_URL ?? "https://mission-control.aurixasystems.com.au"
).replace(/\/+$/, "");

async function loadTemplateBase64(): Promise<string> {
  const res = await fetch(PUBLIC_ORIGIN + TEMPLATE_PATH);
  if (!res.ok) throw new Error(`SLA template fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (!head.startsWith("%PDF")) throw new Error("SLA template is not a PDF");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

type AgreementRow = {
  id: string;
  client_name: string;
  client_email: string;
  client_org: string | null;
  service_tier: string | null;
  commencement_date: string | null;
  status: string;
  docusign_envelope_id: string | null;
  metadata: Json;
};

export async function sendAgreementEnvelope(agreementId: string): Promise<{
  envelopeId: string;
  status: string;
}> {
  const config = docusignConfig();
  if (!config.ready)
    throw new Error(`DocuSign not configured; missing: ${config.missing.join(", ")}`);

  const { data: agreement, error } = await supabaseAdmin
    .from("client_agreements")
    .select(
      "id, client_name, client_email, client_org, service_tier, commencement_date, status, docusign_envelope_id, metadata",
    )
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!agreement) throw new Error("agreement_not_found");
  const row = agreement as AgreementRow;
  if (row.docusign_envelope_id) throw new Error("agreement_already_sent");

  const token = await getDocusignAccessToken(config);
  const base64Pdf = await loadTemplateBase64();
  const definition = buildEnvelopeDefinition({
    base64Pdf,
    fields: {
      clientName: row.client_name,
      clientEmail: row.client_email,
      clientOrg: row.client_org,
      serviceTier: row.service_tier,
      commencementDate: row.commencement_date,
    },
    countersignerName: config.countersignerName,
    countersignerEmail: config.countersignerEmail,
  });

  const res = await fetch(`${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(definition),
  });
  const text = await res.text();
  let data: { envelopeId?: string; status?: string; message?: string; errorCode?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `DocuSign returned a non-JSON response (status ${res.status}) — check DOCUSIGN_BASE_URL (demo accounts use https://demo.docusign.net/restapi).`,
    );
  }
  if (!res.ok || !data.envelopeId) {
    throw new Error(`DocuSign error: ${data.message || data.errorCode || res.status}`);
  }

  const { error: updateError } = await supabaseAdmin
    .from("client_agreements")
    .update({
      status: "sent",
      docusign_envelope_id: data.envelopeId,
      docusign_status: data.status ?? "sent",
      docusign_sent_at: new Date().toISOString(),
    })
    .eq("id", agreementId);
  if (updateError) console.error("[agreements] sent update failed:", updateError.message);

  return { envelopeId: data.envelopeId, status: data.status ?? "sent" };
}

export async function refreshEnvelopeStatus(agreementId: string): Promise<{
  status: string;
  docusignStatus: string;
}> {
  const config = docusignConfig();
  if (!config.ready)
    throw new Error(`DocuSign not configured; missing: ${config.missing.join(", ")}`);

  const { data: agreement, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, status, client_name, docusign_envelope_id, metadata")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!agreement?.docusign_envelope_id) throw new Error("envelope_not_found");

  const token = await getDocusignAccessToken(config);
  const res = await fetch(
    `${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes/${agreement.docusign_envelope_id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = (await res.json().catch(() => ({}))) as {
    status?: string;
    completedDateTime?: string;
    voidedDateTime?: string;
    message?: string;
  };
  if (!res.ok || !data.status) throw new Error(`DocuSign: ${data.message || res.status}`);

  const applied = await applyDocusignStatus(agreementId, data.status, {
    completedDateTime: data.completedDateTime ?? null,
    voidedDateTime: data.voidedDateTime ?? null,
  });
  return { status: applied.status, docusignStatus: data.status };
}

/**
 * Fold a DocuSign envelope status into the agreement — the ONE place the
 * lifecycle moves, whichever way the status arrived (the operator's refresh
 * poll, the agreements-refresh cron, or the Connect webhook). Raises the
 * signed/declined notifications on a transition, and on the transition to
 * `signed` hands the agreement to the provisioning flow, which decides for
 * itself (by named refusal) whether a clone should be created.
 *
 * A provisioning failure never fails the status application: the signature
 * is a recorded fact either way, and the failure lands on the agreement row
 * as `provision_status = failed` where the operator can see and retrigger it.
 */
export async function applyDocusignStatus(
  agreementId: string,
  docusignStatus: string,
  times: { completedDateTime?: string | null; voidedDateTime?: string | null } = {},
): Promise<{ status: string; transitioned: boolean }> {
  const { data: agreement, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, status, client_name")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!agreement) throw new Error("agreement_not_found");

  const mapped = mapEnvelopeStatus(docusignStatus);
  const updates: Database["public"]["Tables"]["client_agreements"]["Update"] = {
    docusign_status: docusignStatus,
  };
  if (mapped) updates.status = mapped;
  if (mapped === "signed")
    updates.docusign_signed_at = times.completedDateTime || new Date().toISOString();
  if (mapped === "voided")
    updates.docusign_voided_at = times.voidedDateTime || new Date().toISOString();

  const transitioned = Boolean(mapped && mapped !== agreement.status);
  const { error: updateError } = await supabaseAdmin
    .from("client_agreements")
    .update(updates)
    .eq("id", agreementId);
  if (updateError) console.error("[agreements] status update failed:", updateError.message);

  if (transitioned && (mapped === "signed" || mapped === "declined")) {
    await notifyOperators({
      kind: mapped === "signed" ? "agreement_signed" : "agreement_declined",
      severity: mapped === "signed" ? "success" : "warning",
      title: mapped === "signed" ? "Agreement signed" : "Agreement declined",
      body: `${agreement.client_name}'s Service Level Agreement was ${mapped}.`,
      url: "/agreements",
      metadata: { agreement_id: agreementId },
    }).catch((err) => console.error("[agreements] notify failed:", (err as Error).message));
  }

  if (mapped === "signed") {
    try {
      const { provisionCloneFromAgreement } = await import("./agreement-provisioning.server");
      await provisionCloneFromAgreement(agreementId, { trigger: "signature" });
    } catch (err) {
      console.error(
        "[agreements] provision-on-signature failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { status: mapped ?? agreement.status, transitioned };
}

export async function downloadSignedPdf(agreementId: string): Promise<{
  base64: string;
  filename: string;
}> {
  const config = docusignConfig();
  if (!config.ready)
    throw new Error(`DocuSign not configured; missing: ${config.missing.join(", ")}`);

  const { data: agreement, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, client_name, docusign_envelope_id")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!agreement?.docusign_envelope_id) throw new Error("envelope_not_found");

  const token = await getDocusignAccessToken(config);
  const res = await fetch(
    `${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes/${agreement.docusign_envelope_id}/documents/combined`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DocuSign download failed: ${text.slice(0, 200)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    base64: btoa(bin),
    filename: `${agreement.client_name.replace(/[^a-z0-9]+/gi, "_")}_SLA_signed.pdf`,
  };
}

export async function voidEnvelope(agreementId: string, reason: string): Promise<void> {
  const { data: agreement, error } = await supabaseAdmin
    .from("client_agreements")
    .select("id, docusign_envelope_id")
    .eq("id", agreementId)
    .maybeSingle();
  if (error) throw error;
  if (!agreement) throw new Error("agreement_not_found");

  if (agreement.docusign_envelope_id) {
    const config = docusignConfig();
    if (config.ready) {
      try {
        const token = await getDocusignAccessToken(config);
        await fetch(
          `${config.baseUrl}/v2.1/accounts/${config.accountId}/envelopes/${agreement.docusign_envelope_id}`,
          {
            method: "PUT",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              status: "voided",
              voidedReason: reason || "Voided by operator",
            }),
          },
        );
      } catch (err) {
        console.error("[agreements] DocuSign void failed:", (err as Error).message);
      }
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from("client_agreements")
    .update({
      status: "voided",
      docusign_status: "voided",
      docusign_voided_at: new Date().toISOString(),
      void_reason: reason || null,
    })
    .eq("id", agreementId);
  if (updateError) console.error("[agreements] void update failed:", updateError.message);
}
