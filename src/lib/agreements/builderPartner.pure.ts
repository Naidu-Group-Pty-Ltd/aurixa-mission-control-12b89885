/**
 * Builder Partner Agreements — the agreement a builder signs before the
 * Builder Portal opens to them. Everything here is pure: no network, no
 * database, no clock but the one passed in.
 *
 * WHERE IT SITS. A builder reaches the Builder Portal through a pipeline that
 * runs without a person in it — the Aurixa website's waitlist posts to
 * /api/public/builders/apply, the Builders Network's `submit_access_request`
 * creates the organisation (pending) and emails its owner an invitation. That
 * pipeline is not touched by anything here. What it deliberately never does is
 * grant access: `approve_organisation` stays the only route from pending to
 * `active`, and it is an admin's decision. The agreement slots in exactly
 * there:
 *
 *   application → organisation (pending) + owner invite   [unchanged]
 *     → Builder Partner Agreement sent, signed, retained   [this]
 *     → approve_organisation → Builder Portal access        [gated by this]
 *
 * THE TERMS ARE PLUGGED IN LATER. Nothing here invents a clause. The terms are
 * whatever file an admin registers (a PDF or a Word document, held by digest),
 * and the envelope carries them as its first document. What Mission Control
 * generates is the SECOND document — the Execution Schedule
 * (`builderPartnerSchedule.pure.ts`): the partner's particulars, the terms
 * identified by name, version and SHA-256, the execution statement, and the
 * signature blocks DocuSign acts on. So any terms file works the day it is
 * supplied, with no anchors to author and no fields to map, and a signature
 * binds the partner to exactly the bytes the schedule names.
 *
 * Four rules carry it.
 *
 *  * **A control that cannot be satisfied is an outage, not a control.** The
 *    access gate is enforced only while terms are in force. Until the terms are
 *    installed, approval behaves exactly as it always has — and the basis it
 *    was given on is still written down.
 *
 *  * **Absent evidence is not agreement.** Only a SIGNED agreement satisfies
 *    the gate. An agreement that is sent, delivered or merely drafted is named
 *    as in flight, never counted.
 *
 *  * **A waiver is a decision, and a decision carries its reason.** An admin
 *    may approve without an agreement, but only by writing why — the same
 *    ten-character floor the marketplace's manual instruments use — and the
 *    reason travels to the network's own activity log.
 *
 *  * **The automatic grant never re-decides a refusal.** A grant the network
 *    refused (a closed organisation, a suspended one) needs a person; only a
 *    transport failure is retried by the sweep.
 */
import { z } from "zod";
import {
  AGREEMENT_ID_CUSTOM_FIELD,
  envelopeSubject,
  issuingDay,
  OFFER_REFERENCE_CUSTOM_FIELD,
} from "./subscriptionIssue.pure";
import {
  isValidAbn as isValidAbnDigits,
  isValidAcn as isValidAcnDigits,
} from "./subscriptionPricing.pure";

export const BUILDER_PARTNER_KIND = "builder_partner" as const;

/** The document's own name, as every surface prints it. */
export const BUILDER_PARTNER_DOCUMENT_NAME = "Builder Partner Agreement";

/** How an envelope is traced back to the organisation it admits. */
export const BUILDER_ORGANISATION_CUSTOM_FIELD = "mc_builder_organisation_id";

/** The registered terms' private bucket (see the 20260928110000 migration). */
export const BUILDER_PARTNER_TEMPLATE_BUCKET = "agreement-templates";

/** The bucket's own ceiling, and DocuSign's comfortable document size. */
export const TEMPLATE_MAX_BYTES = 15 * 1024 * 1024;

export const TEMPLATE_MEDIA_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type TemplateExtension = keyof typeof TEMPLATE_MEDIA_TYPES;
export type TemplateMediaType = (typeof TEMPLATE_MEDIA_TYPES)[TemplateExtension];

export const EXECUTION_STATEMENT_MIN = 20;
export const EXECUTION_STATEMENT_MAX = 1200;

/**
 * What the schedule says above the signatures when an admin registers terms
 * without writing their own. It incorporates the terms by their identity, which
 * the schedule prints in full, so it is true of any file.
 */
export const DEFAULT_EXECUTION_STATEMENT =
  "Executed as an agreement. The Builder Partner accepts the Builder Partner Agreement terms " +
  "identified in this Execution Schedule, and each person signing below confirms that they are " +
  "authorised to sign for the party they sign for.";

/** The same floor the database and the marketplace's manual instruments use. */
export const WAIVER_REASON_MIN = 10;
export const WAIVER_REASON_MAX = 1000;

/**
 * The agreement page's switch that arms access on signature. The Builders
 * Network console tells an admin to switch it on, by name, so the name is
 * written once: two copies of a control's label is how a dialog comes to
 * point at a switch that does not exist.
 */
export const GRANT_ON_SIGNATURE_LABEL = "Admit the builder automatically once signed";

export const PORTAL_ACCESS_STATUSES = ["pending", "granted", "failed", "refused"] as const;
export type PortalAccessStatus = (typeof PORTAL_ACCESS_STATUSES)[number];

/**
 * How long an access attempt may hold its claim before the sweep or a person
 * may take it over. One network call is fifteen seconds at most; this is ample.
 */
export const STALE_GRANT_ATTEMPT_MS = 10 * 60_000;

/** Organisation states an approval can move (the network's own list). */
export const APPROVABLE_ORGANISATION_STATUSES = ["pending_verification", "pending_activation"];

/** Every organisation state the network's `builder_organisations_status_check` admits. */
export const NETWORK_ORGANISATION_STATUSES = [
  "pending_verification",
  "pending_activation",
  "active",
  "suspended",
  "closed",
] as const;

/**
 * How many rows the network's listing operations return at most, newest
 * first. A listing shorter than this is the whole table; one this long is a
 * page, and an organisation missing from a page is not missing.
 */
export const NETWORK_LISTING_PAGE = 200;

/**
 * The wire codes meaning the schema this feature reads has not been applied
 * here yet — a relation or column PostgREST's schema cache does not hold
 * (`PGRST205`, `PGRST204`), or Postgres's own answer where a statement got that
 * far (`42P01`, `42703`). Observed on the wire, never assumed from the database
 * that raises them: a supabase-js caller sees PostgREST's codes, not Postgres's.
 *
 * It matters because migrations reach this database after the code that reads
 * them ships. A registry that does not exist yet holds no terms, so the access
 * gate reads it as "not in force" rather than failing every approval — while a
 * read that FAILED for any other reason still fails closed.
 */
const SCHEMA_ABSENT_CODES = new Set(["PGRST205", "PGRST204", "42P01", "42703"]);

export function isSchemaAbsent(error: { code?: string | null } | null | undefined): boolean {
  return Boolean(error?.code && SCHEMA_ABSENT_CODES.has(error.code));
}

/* ───────────────────────────── the reference ───────────────────────────── */

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const BUILDER_PARTNER_REFERENCE_PATTERN = /^AUR-BPA-\d{8}-[A-HJ-NP-Z2-9]{6}$/;

/**
 * An agreement's reference: `AUR-BPA-<Sydney day>-<six characters>`. The
 * alphabet has 32 letters, so a byte maps onto it without bias, and it leaves
 * out the pairs a person reading one aloud confuses (0/O, 1/I).
 */
export function newBuilderPartnerReference(now: Date, random: (n: number) => Uint8Array): string {
  const bytes = random(6);
  let suffix = "";
  for (const b of bytes) suffix += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length];
  const ymd = issuingDay(now).replace(/-/g, "");
  return `AUR-BPA-${ymd}-${suffix}`;
}

/* ───────────────────────────── ABN and ACN ───────────────────────────── */

/**
 * The digits of a typed number, with the grouping and a leading "ABN"/"ACN"
 * label a person naturally types taken off. The check digits themselves are
 * `subscriptionPricing.pure.ts`'s — one implementation of the ABR's and
 * ASIC's rules, whichever agreement is being prepared.
 */
function registerDigits(raw: string): string {
  return raw
    .trim()
    .replace(/^(ABN|ACN)\s*:?\s*/i, "")
    .replace(/[\s-]/g, "");
}

/** The ABR's check digit, on a number as a person types it. */
export function isValidAbn(raw: string): boolean {
  return isValidAbnDigits(registerDigits(raw));
}

/** `51824753556` → `51 824 753 556`; anything that is not an ABN is returned trimmed. */
export function formatAbn(raw: string): string {
  const d = registerDigits(raw);
  if (!/^\d{11}$/.test(d)) return raw.trim();
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
}

/** ASIC's check digit, on a number as a person types it. */
export function isValidAcn(raw: string): boolean {
  return isValidAcnDigits(registerDigits(raw));
}

/** `004085616` → `004 085 616`; anything that is not an ACN is returned trimmed. */
export function formatAcn(raw: string): string {
  const d = registerDigits(raw);
  if (!/^\d{9}$/.test(d)) return raw.trim();
  return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/**
 * Whether an ABN is the one a company's ACN produces. It is for a company;
 * it is not for a trust trading through a corporate trustee — the trust's ABN
 * and the trustee's ACN are different numbers — so a mismatch is a question
 * for a person, never a refusal.
 */
export function abnContainsAcn(abn: string, acn: string): boolean {
  const a = registerDigits(abn);
  const c = registerDigits(acn);
  return /^\d{11}$/.test(a) && /^\d{9}$/.test(c) && a.slice(2) === c;
}

/* ───────────────────────────── the particulars ───────────────────────────── */

export const builderPartnerParticularsSchema = z.object({
  schema: z.literal(1),
  partner: z.object({
    legalName: z.string().max(200),
    tradingName: z.string().max(200),
    abn: z.string().max(20),
    acn: z.string().max(20),
    address: z.string().max(400),
    email: z.string().max(200),
    phone: z.string().max(40),
  }),
  signatory: z.object({
    name: z.string().max(160),
    email: z.string().max(200),
    title: z.string().max(120),
  }),
});

/**
 * Who the agreement is with and who signs it for them. Held in the agreement
 * row's `offer` column, frozen with it once an envelope exists.
 */
export type BuilderPartnerParticulars = z.infer<typeof builderPartnerParticularsSchema>;

export function emptyParticulars(): BuilderPartnerParticulars {
  return {
    schema: 1,
    partner: {
      legalName: "",
      tradingName: "",
      abn: "",
      acn: "",
      address: "",
      email: "",
      phone: "",
    },
    signatory: { name: "", email: "", title: "" },
  };
}

/** What the network holds about an organisation, as the console reads it. */
export type ParticularsOrganisationSource = {
  legal_name: string;
  trading_name?: string | null;
  abn?: string | null;
  state?: string | null;
  contact_email?: string | null;
};

/** What the website's application recorded, when one exists. */
export type ParticularsAccessRequestSource = {
  abn?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A draft's first particulars, from what the network already knows. Nothing
 * is guessed: the application records a contact and a locality, never a
 * street address or an ACN, so those stay blank for the admin to confirm, and
 * the signatory title is left for the partner's own word.
 */
export function seedParticulars(
  organisation: ParticularsOrganisationSource,
  accessRequest?: ParticularsAccessRequestSource | null,
): BuilderPartnerParticulars {
  const request = accessRequest ?? {};
  const abnRaw = clean(organisation.abn) || clean(request.abn);
  const locality = [
    clean(request.suburb),
    clean(request.state) || clean(organisation.state),
    clean(request.postcode),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    schema: 1,
    partner: {
      legalName: clean(organisation.legal_name).slice(0, 200),
      tradingName: clean(organisation.trading_name).slice(0, 200),
      abn: (abnRaw && isValidAbn(abnRaw) ? formatAbn(abnRaw) : abnRaw).slice(0, 20),
      acn: "",
      address: locality.slice(0, 400),
      email: (clean(organisation.contact_email) || clean(request.contact_email)).slice(0, 200),
      phone: clean(request.contact_phone).slice(0, 40),
    },
    signatory: {
      name: clean(request.contact_name).slice(0, 160),
      email: (clean(request.contact_email) || clean(organisation.contact_email)).slice(0, 200),
      title: "",
    },
  };
}

/** Whitespace collapsed, valid numbers written the way the registers write them. */
export function normaliseParticulars(p: BuilderPartnerParticulars): BuilderPartnerParticulars {
  const abn = clean(p.partner.abn);
  const acn = clean(p.partner.acn);
  return {
    schema: 1,
    partner: {
      legalName: clean(p.partner.legalName),
      tradingName: clean(p.partner.tradingName),
      abn: abn && isValidAbn(abn) ? formatAbn(abn) : abn,
      acn: acn && isValidAcn(acn) ? formatAcn(acn) : acn,
      address: clean(p.partner.address),
      email: clean(p.partner.email),
      phone: clean(p.partner.phone),
    },
    signatory: {
      name: clean(p.signatory.name),
      email: clean(p.signatory.email),
      title: clean(p.signatory.title),
    },
  };
}

/** A particulars object read back from the row, or null when it is not one. */
export function readParticulars(value: unknown): BuilderPartnerParticulars | null {
  const parsed = builderPartnerParticularsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Which particulars a save changed, by name (`partner.abn`, `signatory.email`)
 * — the audit record of a save. The values are not recorded: the row holds
 * them, and an audit trail of contact details is a second copy of them.
 */
export function particularsChanges(
  before: BuilderPartnerParticulars | null,
  after: BuilderPartnerParticulars,
): string[] {
  const a = normaliseParticulars(before ?? emptyParticulars());
  const b = normaliseParticulars(after);
  const changed: string[] = [];
  for (const key of Object.keys(b.partner) as Array<keyof BuilderPartnerParticulars["partner"]>) {
    if (a.partner[key] !== b.partner[key]) changed.push(`partner.${key}`);
  }
  for (const key of Object.keys(b.signatory) as Array<
    keyof BuilderPartnerParticulars["signatory"]
  >) {
    if (a.signatory[key] !== b.signatory[key]) changed.push(`signatory.${key}`);
  }
  return changed;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export type ParticularsGaps = {
  /** Each is a reason the agreement cannot be sent. */
  blockers: string[];
  /** Each is worth a look, and none stops a send. */
  warnings: string[];
};

/**
 * What stands between these particulars and an agreement that can be sent.
 * The page renders this list and the send refuses on the same one, so what an
 * admin is told and what the server accepts cannot become two standards.
 */
export function particularsGaps(input: BuilderPartnerParticulars): ParticularsGaps {
  const p = normaliseParticulars(input);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!p.partner.legalName) blockers.push("The Builder Partner's legal name is missing.");
  if (!p.signatory.name) blockers.push("The signatory's name is missing.");
  if (!p.signatory.email) blockers.push("The signatory's email address is missing.");
  else if (!looksLikeEmail(p.signatory.email))
    blockers.push("The signatory's email address is not a valid address.");
  if (p.partner.email && !looksLikeEmail(p.partner.email))
    blockers.push("The Builder Partner's notice email is not a valid address.");
  if (p.partner.abn && !isValidAbn(p.partner.abn))
    blockers.push("The ABN fails the ATO's check digit — check the number with the builder.");
  if (p.partner.acn && !isValidAcn(p.partner.acn))
    blockers.push("The ACN fails ASIC's check digit — check the number with the builder.");

  if (!p.partner.abn)
    warnings.push(
      "No ABN is recorded; the schedule will say so. A trading builder normally has one.",
    );
  if (!p.partner.address) warnings.push("No address is recorded; the schedule will say so.");
  if (!p.signatory.title)
    warnings.push(
      "No signatory title is recorded; the signer will be asked for it when they sign.",
    );
  if (
    p.partner.abn &&
    p.partner.acn &&
    isValidAbn(p.partner.abn) &&
    isValidAcn(p.partner.acn) &&
    !abnContainsAcn(p.partner.abn, p.partner.acn)
  ) {
    warnings.push(
      "The ABN does not contain the ACN. That is expected for a trust with a corporate trustee, and a mistake for a company.",
    );
  }
  return { blockers, warnings };
}

/**
 * The agreement row's own columns, as the particulars state them. The list,
 * the notifications and every search read these, so they follow the
 * particulars on every save. `client_name` and `client_email` are NOT NULL and
 * are only ever overwritten with something real.
 */
export function agreementColumnsFromParticulars(input: BuilderPartnerParticulars): {
  client_name?: string;
  client_email?: string;
  client_org: string | null;
  service_tier: string;
} {
  const p = normaliseParticulars(input);
  const name = p.signatory.name || p.partner.legalName;
  const email = looksLikeEmail(p.signatory.email) ? p.signatory.email : "";
  return {
    ...(name ? { client_name: name } : {}),
    ...(email ? { client_email: email } : {}),
    client_org: p.partner.legalName || null,
    service_tier: "Builder Partner",
  };
}

/* ───────────────────────────── the terms ───────────────────────────── */

/** A registered terms file, as the schedule and the envelope need it. */
export type BuilderPartnerTerms = {
  id: string;
  name: string;
  versionLabel: string;
  fileName: string;
  mediaType: TemplateMediaType;
  sha256: string;
  byteSize: number;
  pageCount: number | null;
  countersignatureRequired: boolean;
  executionStatement: string;
};

export const templateDetailsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  versionLabel: z.string().trim().min(1).max(60),
  countersignatureRequired: z.boolean(),
  executionStatement: z.string().trim().min(EXECUTION_STATEMENT_MIN).max(EXECUTION_STATEMENT_MAX),
  notes: z.string().trim().max(2000).default(""),
});

export type TemplateDetails = z.infer<typeof templateDetailsSchema>;

export function extensionForMediaType(mediaType: string): TemplateExtension | null {
  if (mediaType === TEMPLATE_MEDIA_TYPES.pdf) return "pdf";
  if (mediaType === TEMPLATE_MEDIA_TYPES.docx) return "docx";
  return null;
}

/**
 * What an uploaded file IS, read from its own first bytes. The name a browser
 * sends is a claim; the bytes are the file. A PDF starts `%PDF-`; a Word
 * document is a ZIP (`PK\x03\x04`) — the server then opens it as one.
 */
export function sniffTemplateBytes(bytes: Uint8Array): TemplateExtension | null {
  if (
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }
  if (
    bytes.length > 3 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    return "docx";
  }
  return null;
}

export type TemplateUploadCheck =
  | { ok: true; extension: TemplateExtension; mediaType: TemplateMediaType }
  | { ok: false; error: string };

/**
 * The checks an uploaded terms file passes before anything is stored: it has
 * bytes, it fits the bucket, it is a PDF or a Word document by its own bytes,
 * and the name it came with does not say it is the other one.
 */
export function checkTemplateUpload(bytes: Uint8Array, fileName: string): TemplateUploadCheck {
  if (bytes.length === 0) return { ok: false, error: "The file is empty." };
  if (bytes.length > TEMPLATE_MAX_BYTES) {
    return {
      ok: false,
      error: `The file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit is ${TEMPLATE_MAX_BYTES / 1024 / 1024} MB.`,
    };
  }
  const extension = sniffTemplateBytes(bytes);
  if (!extension) {
    return { ok: false, error: "The terms must be a PDF or a Word (.docx) document." };
  }
  const named = /\.([A-Za-z0-9]+)$/.exec(fileName.trim())?.[1]?.toLowerCase() ?? null;
  if (named === "doc") {
    return {
      ok: false,
      error: "Legacy .doc files are not accepted; save the terms as .docx or PDF.",
    };
  }
  if ((named === "pdf" || named === "docx") && named !== extension) {
    return {
      ok: false,
      error: `The file is named .${named} but its contents are a ${extension === "pdf" ? "PDF" : "Word document"}.`,
    };
  }
  return { ok: true, extension, mediaType: TEMPLATE_MEDIA_TYPES[extension] };
}

/** What the server reads out of a `.docx` before it may be registered as terms. */
export type WordPackageFacts = {
  partNames: readonly string[];
  contentTypesXml: string;
  /** `word/document.xml` and every header, footer, footnote and endnote part. */
  storyXml: readonly string[];
  /** `word/_rels/document.xml.rels`, when the package has one. */
  documentRelsXml: string | null;
};

export type WordTermsAssessment = { ok: true; warnings: string[] } | { ok: false; error: string };

/** A tracked insertion, deletion or move. `\b` keeps `<w:insideH>` (a table border) out. */
const REVISION_MARKUP = /<w:(ins|del|moveFrom|moveTo)\b/;
/** A run of text. `[\s>]` keeps `<w:tab>` and `<w:tbl>` out. */
const TEXT_RUN = /<w:t[\s>]/;
const COMMENT_REFERENCE = /<w:commentReference\b/;

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity.toLowerCase()] ?? "";
    const code =
      entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
}

/** What a reader sees of a stretch of story XML: its text runs, nothing else. */
function visibleText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) out += decodeXmlText(m[1]);
  return out;
}

/** Whitespace and non-breaking spaces do not make two readings of one figure differ. */
function sameReading(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\s\u00a0]+/g, " ").trim();
  return norm(a) === norm(b);
}

type FieldReading = { instruction: string; result: string };

/**
 * Every field in a story with the result Word last stored for it. Complex
 * fields (begin / instruction / separate / result / end) nest, and a nested
 * field's result is part of its parent's; simple fields carry both at once.
 */
function fieldsOf(xml: string): FieldReading[] {
  const out: FieldReading[] = [];
  for (const m of xml.matchAll(
    /<w:fldSimple\b[^>]*?\bw:instr="([^"]*)"[^>]*>([\s\S]*?)<\/w:fldSimple>/g,
  )) {
    out.push({ instruction: decodeXmlText(m[1]), result: visibleText(m[2]) });
  }
  const open: Array<FieldReading & { inResult: boolean }> = [];
  const token =
    /<w:fldChar\b[^>]*?\bw:fldCharType="(begin|separate|end)"[^>]*>|<w:instrText(?:\s[^>]*)?>([^<]*)<\/w:instrText>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  for (const m of xml.matchAll(token)) {
    if (m[1] === "begin") open.push({ instruction: "", result: "", inResult: false });
    else if (m[1] === "separate") {
      const top = open[open.length - 1];
      if (top) top.inResult = true;
    } else if (m[1] === "end") {
      const done = open.pop();
      if (done) out.push({ instruction: done.instruction, result: done.result });
    } else if (m[2] !== undefined) {
      const top = open[open.length - 1];
      if (top && !top.inResult) top.instruction += decodeXmlText(m[2]);
    } else if (m[3] !== undefined) {
      const text = decodeXmlText(m[3]);
      for (const field of open) if (field.inResult) field.result += text;
    }
  }
  return out;
}

/** Bookmark name → the text it marks, across every story. */
function bookmarksOf(storyXml: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const xml of storyXml) {
    for (const m of xml.matchAll(/<w:bookmarkStart\b([^>]*?)\/?>/g)) {
      const attrs = m[1] ?? "";
      const id = /\bw:id="([^"]*)"/.exec(attrs)?.[1];
      const name = /\bw:name="([^"]*)"/.exec(attrs)?.[1];
      if (id === undefined || !name) continue;
      const from = (m.index ?? 0) + m[0].length;
      const end = new RegExp(`<w:bookmarkEnd\\b[^>]*?\\bw:id="${id.replace(/[^\w-]/g, "")}"`).exec(
        xml.slice(from),
      );
      if (!end) continue;
      out.set(decodeXmlText(name), visibleText(xml.slice(from, from + end.index)));
    }
  }
  return out;
}

/**
 * A REF field whose result can be compared with the text it quotes: no switch
 * that turns the result into a paragraph number, a position or a changed case.
 * `\h` (a hyperlink) and the two formatting-preservation switches change
 * nothing a reader sees.
 */
function comparableRef(instruction: string): { bookmark: string } | null {
  const m = /^\s*REF\s+(\S+)(.*)$/i.exec(instruction);
  if (!m) return null;
  const switches = m[2].replace(/\\\*\s*(CHARFORMAT|MERGEFORMAT)/gi, "").replace(/\\h\b/gi, "");
  if (/\\/.test(switches)) return null;
  return { bookmark: m[1].replace(/^"|"$/g, "") };
}

export type StaleCrossReference = {
  bookmark: string;
  /** What the clause prints: the result Word last stored for the field. */
  shown: string;
  /** What the text it quotes now reads; null when that text is no longer marked. */
  source: string | null;
};

/**
 * Clause text that quotes another part of the document through a REF field
 * and has fallen out of step with it.
 *
 * A reference field prints the result Word stored the last time fields were
 * updated, and a converted copy — the one DocuSign shows a signer — prints
 * that stored result rather than recomputing it. So when the text a field
 * quotes is edited (a fee on the transaction-fee page, say) and the fields are
 * not updated, the document carries two different figures for one thing, and
 * the one in the clause is the one that is signed. A field whose bookmark has
 * gone — usually because the marked text was retyped over — is worse: it
 * becomes "Error! Reference source not found" on the next update.
 */
export function staleCrossReferences(storyXml: readonly string[]): StaleCrossReference[] {
  const bookmarks = bookmarksOf(storyXml);
  const out: StaleCrossReference[] = [];
  for (const xml of storyXml) {
    for (const field of fieldsOf(xml)) {
      const ref = comparableRef(field.instruction);
      if (!ref) continue;
      const source = bookmarks.get(ref.bookmark);
      if (source === undefined) {
        out.push({ bookmark: ref.bookmark, shown: field.result, source: null });
      } else if (!sameReading(source, field.result)) {
        out.push({ bookmark: ref.bookmark, shown: field.result, source });
      }
    }
  }
  return out;
}

function describeStaleReference(stale: StaleCrossReference): string {
  return stale.source === null
    ? `the reference to “${stale.bookmark}” shows “${stale.shown}”, but the text it quoted is no longer marked (it was probably retyped over)`
    : `the reference to “${stale.bookmark}” shows “${stale.shown}”, but the text it quotes now reads “${stale.source}”`;
}

function relationshipsOf(xml: string): Array<{ type: string; external: boolean }> {
  const out: Array<{ type: string; external: boolean }> = [];
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    out.push({
      type: /\bType=["']([^"']*)["']/.exec(attrs)?.[1] ?? "",
      external: /\bTargetMode=["']External["']/.test(attrs),
    });
  }
  return out;
}

/**
 * Whether a Word document can be registered as the terms, read from its own
 * parts. A PDF is a fixed page; a Word document is a program's saved state,
 * and four things it can carry decide something.
 *
 *  * **Active content is refused.** A macro project, an ActiveX control, or a
 *    macro-enabled document renamed to `.docx` is code, and the terms are text
 *    a builder is asked to accept.
 *  * **Tracked changes are refused.** A document with revisions in it holds two
 *    texts, and whichever one a converter shows is the one that gets signed.
 *    Terms are a settled text: the changes are accepted or rejected first.
 *  * **A stale cross-reference is refused.** A clause that quotes another part
 *    of the document through a REF field (BD1's clauses 14.3 and 14.4 quote
 *    the fees on "Your transaction-fee arrangement") prints what Word last
 *    stored, so the quoted text and the quote must agree when it is uploaded —
 *    see `staleCrossReferences`.
 *  * **A master document is refused.** Its sections live in other files, so the
 *    fingerprint the Execution Schedule prints would not cover them.
 *
 * Comments, a linked (rather than embedded) picture or template, and a document
 * with no text in it are worth a person's look and stop nothing.
 */
export function assessWordTerms(facts: WordPackageFacts): WordTermsAssessment {
  const names = facts.partNames.map((n) => n.toLowerCase());
  if (
    names.some((n) => /(^|\/)vbaproject\.bin$/.test(n) || n.startsWith("word/activex/")) ||
    /macroenabled/i.test(facts.contentTypesXml)
  ) {
    return {
      ok: false,
      error:
        "The document contains macros or other active content. Save the terms as a plain .docx (or a PDF) and upload that.",
    };
  }
  if (facts.storyXml.some((xml) => REVISION_MARKUP.test(xml))) {
    return {
      ok: false,
      error:
        "The document still has tracked changes in it. Accept or reject every change so the terms are one settled text, then upload it again.",
    };
  }
  const stale = staleCrossReferences(facts.storyXml);
  if (stale.length) {
    const listed = stale.slice(0, 3).map(describeStaleReference).join("; ");
    const more = stale.length > 3 ? `; and ${stale.length - 3} more` : "";
    return {
      ok: false,
      error:
        `Clause text that quotes another part of the document is out of step with it: ${listed}${more}. ` +
        "The clause would be signed with the old figure. In Word, select all (Ctrl+A), press F9 to update fields, check the result, save, and upload again.",
    };
  }
  const relationships = relationshipsOf(facts.documentRelsXml ?? "");
  if (relationships.some((r) => /\/subDocument$/i.test(r.type))) {
    return {
      ok: false,
      error:
        "The document is a master document whose sections live in other files, so its fingerprint would not cover them. Save it as one document and upload that.",
    };
  }

  const warnings: string[] = [];
  if (
    names.includes("word/comments.xml") ||
    facts.storyXml.some((xml) => COMMENT_REFERENCE.test(xml))
  ) {
    warnings.push(
      "The document carries comments. They are not part of the terms, and a converted copy can show them — remove them before the terms are put in force.",
    );
  }
  const linked = relationships.filter((r) => r.external && !/\/hyperlink$/i.test(r.type));
  if (linked.length) {
    warnings.push(
      `The document links to ${linked.length === 1 ? "a file" : `${linked.length} files`} outside itself (a linked picture or template). What is linked is not in the file the schedule fingerprints; embed it instead.`,
    );
  }
  if (!facts.storyXml.some((xml) => TEXT_RUN.test(xml))) {
    warnings.push(
      "The document has no text in it — it may be scanned pages pasted in as pictures. It can be registered, but check it is the terms.",
    );
  }
  return { ok: true, warnings };
}

/**
 * The name a registered file is listed and downloaded under: the uploaded name
 * without any folder a browser sent, with the extension its bytes earned.
 */
export function registeredFileName(raw: string, extension: TemplateExtension): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const stem = safeFileName(base.replace(/\.(pdf|docx?)$/i, ""));
  return `${stem || "terms"}.${extension}`;
}

/** A registry row, as the database returns it. */
export type RegistryTermsRow = {
  id: string;
  name: string;
  version_label: string;
  file_name: string;
  media_type: string;
  sha256: string;
  byte_size: number;
  page_count: number | null;
  countersignature_required: boolean;
  execution_statement: string;
};

/** A registry row as terms, or null for a row whose media type is not one this reads. */
export function termsFromRegistryRow(row: RegistryTermsRow): BuilderPartnerTerms | null {
  const extension = extensionForMediaType(row.media_type);
  if (!extension) return null;
  return {
    id: row.id,
    name: row.name,
    versionLabel: row.version_label,
    fileName: row.file_name,
    mediaType: TEMPLATE_MEDIA_TYPES[extension],
    sha256: row.sha256,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    countersignatureRequired: row.countersignature_required,
    executionStatement: row.execution_statement,
  };
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An uploaded file's bytes, from the base64 a browser sends. A `data:` URL's
 * prefix and any line breaks are tolerated — both are how a browser hands a
 * file over — and anything else that is not base64 is refused by name rather
 * than decoded into bytes nobody sent.
 */
export function base64ToBytes(input: string): Uint8Array {
  const body = input.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (body.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    throw new Error("The file did not arrive intact (it is not valid base64). Choose it again.");
  }
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Where a terms file is stored: by its digest, so the path IS its identity. */
export function templateStoragePath(sha256: string, extension: TemplateExtension): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("template_sha256_malformed");
  return `builder-partner/${sha256}.${extension}`;
}

/** A name any file system and DocuSign accept: no path, reserved or control characters. */
function safeFileName(name: string): string {
  let out = "";
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp < 0x20 || cp === 0x7f || '\\/:*?"<>|'.includes(ch) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 120);
}

/** The terms document's name as the signer sees it in DocuSign. */
export function termsDocumentName(
  terms: Pick<BuilderPartnerTerms, "name" | "versionLabel" | "mediaType">,
): string {
  const extension = extensionForMediaType(terms.mediaType) ?? "pdf";
  return `${safeFileName(`${terms.name} (${terms.versionLabel})`)}.${extension}`;
}

/** The generated schedule's name. A preview says what it is before anyone opens it. */
export function scheduleDocumentName(reference: string, preview: boolean): string {
  return `${preview ? "PREVIEW - " : ""}Execution Schedule ${safeFileName(reference)}.pdf`;
}

/** The signed record's object path: one per agreement and envelope. */
export function builderPartnerSignedRecordPath(agreementId: string, envelopeId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");
  return `builder-partner/${safe(agreementId)}/${safe(envelopeId)}-signed.pdf`;
}

/** The envelope's title and email subject. */
export function builderPartnerTitle(legalName: string): string {
  const name = clean(legalName) || "Builder Partner";
  return `Aurixa Systems ${BUILDER_PARTNER_DOCUMENT_NAME} — ${name}`;
}

/* ───────────────────────────── the envelope ───────────────────────────── */

/**
 * The invisible tokens the Execution Schedule paints and the envelope's tabs
 * are placed on. `builderPartnerSchedule.pure.ts` writes each exactly once,
 * and a test reads every one back out of the generated PDF — a drifted token is
 * a tab that never places, so the tabs are STRICT and DocuSign refusing the
 * envelope is the outcome, never an envelope with nowhere to sign.
 */
export const BUILDER_PARTNER_ANCHORS = {
  partnerSignature: "\\bpa_partner_sign\\",
  partnerTitle: "\\bpa_partner_title\\",
  partnerDate: "\\bpa_partner_date\\",
  aurixaSignature: "\\bpa_aurixa_sign\\",
  aurixaDate: "\\bpa_aurixa_date\\",
} as const;

type AnchorTab = Record<string, string>;

function strictAnchorTab(
  anchor: string,
  yOffset: string,
  extra: Record<string, string> = {},
): AnchorTab {
  return {
    anchorString: anchor,
    anchorUnits: "pixels",
    anchorXOffset: "0",
    anchorYOffset: yOffset,
    anchorIgnoreIfNotPresent: "false",
    anchorCaseSensitive: "true",
    anchorMatchWholeWord: "false",
    ...extra,
  };
}

export type BuilderPartnerEnvelopeInput = {
  agreementId: string;
  builderOrganisationId: string;
  reference: string;
  partnerLegalName: string;
  terms: { name: string; extension: TemplateExtension; base64: string };
  schedule: { name: string; base64: string };
  signer: { name: string; email: string; title: string | null };
  /** Aurixa's signatory, when the terms require a countersignature. */
  countersigner: { name: string; email: string } | null;
  /** Aurixa's copy of the completed agreement, when no countersignature is required. */
  carbonCopy: { name: string | null; email: string } | null;
  /** Who to contact when something is wrong, named in the invitation. */
  correctionContact: string | null;
};

export function buildBuilderPartnerEnvelopeDefinition(
  input: BuilderPartnerEnvelopeInput,
): Record<string, unknown> {
  const signerTabs: Record<string, AnchorTab[]> = {
    signHereTabs: [
      strictAnchorTab(BUILDER_PARTNER_ANCHORS.partnerSignature, "-30", { scaleValue: "0.7" }),
    ],
    dateSignedTabs: [
      strictAnchorTab(BUILDER_PARTNER_ANCHORS.partnerDate, "-2", {
        font: "Helvetica",
        fontSize: "Size10",
      }),
    ],
  };
  // A title the particulars do not know is asked of the signer; one they do
  // know is printed, and a tab over printed text would be a second answer.
  if (!input.signer.title?.trim()) {
    signerTabs.titleTabs = [
      strictAnchorTab(BUILDER_PARTNER_ANCHORS.partnerTitle, "-2", {
        font: "Helvetica",
        fontSize: "Size10",
        required: "true",
        width: "180",
      }),
    ];
  }
  const signer = {
    email: input.signer.email.trim(),
    name: input.signer.name.trim(),
    recipientId: "1",
    routingOrder: "1",
    tabs: signerTabs,
  };
  const recipients: Record<string, unknown> = { signers: [signer] };
  if (input.countersigner) {
    recipients.signers = [
      signer,
      {
        email: input.countersigner.email.trim(),
        name: input.countersigner.name.trim() || "Aurixa Systems",
        recipientId: "2",
        routingOrder: "2",
        tabs: {
          signHereTabs: [
            strictAnchorTab(BUILDER_PARTNER_ANCHORS.aurixaSignature, "-30", { scaleValue: "0.7" }),
          ],
          dateSignedTabs: [
            strictAnchorTab(BUILDER_PARTNER_ANCHORS.aurixaDate, "-2", {
              font: "Helvetica",
              fontSize: "Size10",
            }),
          ],
        },
      },
    ];
  } else if (input.carbonCopy) {
    recipients.carbonCopies = [
      {
        email: input.carbonCopy.email.trim(),
        name: input.carbonCopy.name?.trim() || "Aurixa Systems",
        recipientId: "2",
        routingOrder: "2",
      },
    ];
  }
  const legalName = clean(input.partnerLegalName) || "your organisation";
  const correction = input.correctionContact?.trim() ?? "";
  return {
    emailSubject: envelopeSubject(builderPartnerTitle(input.partnerLegalName)),
    emailBlurb:
      `Dear ${signer.name},\n\n` +
      `Aurixa Systems has issued the ${BUILDER_PARTNER_DOCUMENT_NAME} for ${legalName} ` +
      `(reference ${input.reference}). It is in two documents: the agreement's terms, and the ` +
      `Execution Schedule that identifies those terms and records your organisation's particulars. ` +
      `Please read both before you sign — signing the Execution Schedule is what enters the agreement.\n\n` +
      `Access to the Aurixa Builder Portal follows once the agreement is signed and your organisation is approved.\n\n` +
      (correction
        ? `If anything in the particulars is not right, please do not sign — contact ${correction} and we will issue a corrected agreement.\n\n`
        : "") +
      `Kind regards,\nAurixa Systems`,
    documents: [
      {
        documentBase64: input.terms.base64,
        name: input.terms.name,
        fileExtension: input.terms.extension,
        documentId: "1",
      },
      {
        documentBase64: input.schedule.base64,
        name: input.schedule.name,
        fileExtension: "pdf",
        documentId: "2",
      },
    ],
    recipients,
    customFields: {
      textCustomFields: [
        {
          name: AGREEMENT_ID_CUSTOM_FIELD,
          value: input.agreementId,
          show: "false",
          required: "false",
        },
        {
          name: OFFER_REFERENCE_CUSTOM_FIELD,
          value: input.reference,
          show: "false",
          required: "false",
        },
        {
          name: BUILDER_ORGANISATION_CUSTOM_FIELD,
          value: input.builderOrganisationId,
          show: "false",
          required: "false",
        },
      ],
    },
    status: "sent",
  };
}

/* ───────────────────────────── the snapshot ───────────────────────────── */

export const builderPartnerSnapshotSchema = z.object({
  schema: z.literal(1),
  kind: z.literal(BUILDER_PARTNER_KIND),
  reference: z.string(),
  issuedAt: z.string(),
  issuingDay: z.string(),
  builderOrganisationId: z.string(),
  particulars: builderPartnerParticularsSchema,
  terms: z.object({
    templateId: z.string(),
    name: z.string(),
    versionLabel: z.string(),
    fileName: z.string(),
    mediaType: z.string(),
    sha256: z.string(),
    bytes: z.number(),
    pageCount: z.number().nullable(),
    countersignatureRequired: z.boolean(),
    executionStatement: z.string(),
    documentName: z.string(),
  }),
  schedule: z.object({
    name: z.string(),
    sha256: z.string(),
    bytes: z.number(),
    layoutVersion: z.number(),
    pageCount: z.number(),
    /** The exact schedule DocuSign received, so the record can be re-served. */
    base64: z.string(),
  }),
  signer: z.object({ name: z.string(), email: z.string(), title: z.string().nullable() }),
  countersigner: z.object({ name: z.string(), email: z.string() }).nullable(),
  carbonCopy: z.object({ name: z.string().nullable(), email: z.string() }).nullable(),
  grantAccessOnSignature: z.boolean(),
});

/**
 * What was issued, written BEFORE the envelope is created and refused any
 * change after by the database: the particulars, the terms' identity and
 * digest, the generated schedule itself, and who was sent what.
 */
export type BuilderPartnerIssuedSnapshot = z.infer<typeof builderPartnerSnapshotSchema>;

export function readBuilderPartnerSnapshot(value: unknown): BuilderPartnerIssuedSnapshot | null {
  const parsed = builderPartnerSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* ───────────────────────────── the access gate ───────────────────────────── */

/** An agreement, as the gate needs to see it. */
export type BuilderAgreementSummary = {
  id: string;
  status: string;
  reference: string | null;
  signedAt: string | null;
  createdAt: string;
  signedRecordPath: string | null;
  portalAccessStatus: string | null;
  grantAccessOnSignature: boolean;
};

const OPEN_STATUSES = new Set(["draft", "sent", "delivered"]);

export type AccessGateDecision =
  | { allow: true; basis: "signed"; agreement: BuilderAgreementSummary }
  | { allow: true; basis: "waived"; waiverReason: string }
  | { allow: true; basis: "not_enforced" }
  | {
      allow: false;
      reason: "agreement_required" | "agreement_in_flight" | "waiver_reason_too_short";
      detail: string;
      openAgreement: BuilderAgreementSummary | null;
    };

/** The organisation's latest signed agreement, if it has one. */
export function latestSignedAgreement(
  agreements: readonly BuilderAgreementSummary[],
): BuilderAgreementSummary | null {
  const signed = agreements.filter((a) => a.status === "signed");
  signed.sort((a, b) => (b.signedAt ?? b.createdAt).localeCompare(a.signedAt ?? a.createdAt));
  return signed[0] ?? null;
}

/** The organisation's agreement in flight (drafted, sent or delivered), if any. */
export function openAgreement(
  agreements: readonly BuilderAgreementSummary[],
): BuilderAgreementSummary | null {
  const open = agreements.filter((a) => OPEN_STATUSES.has(a.status));
  open.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return open[0] ?? null;
}

/** The agreement row's columns the gate and the console read. */
export type BuilderAgreementRowFacts = {
  id: string;
  status: string;
  offer_reference: string | null;
  docusign_signed_at: string | null;
  created_at: string;
  signed_record_path: string | null;
  portal_access_status: string | null;
  grant_access_on_signature: boolean | null;
};

export function toAgreementSummary(row: BuilderAgreementRowFacts): BuilderAgreementSummary {
  return {
    id: row.id,
    status: row.status,
    reference: row.offer_reference,
    signedAt: row.docusign_signed_at,
    createdAt: row.created_at,
    signedRecordPath: row.signed_record_path,
    portalAccessStatus: row.portal_access_status,
    grantAccessOnSignature: row.grant_access_on_signature === true,
  };
}

/**
 * What the Builders Network console says about one organisation's agreements:
 * the signature that satisfies the gate (and a re-papering in flight beside
 * it), the agreement in flight, or none — naming the last one that ended, so
 * "declined last week" is not read as "never sent".
 */
export type OrganisationAgreementState =
  | {
      kind: "signed";
      agreement: BuilderAgreementSummary;
      inFlight: BuilderAgreementSummary | null;
    }
  | { kind: "in_flight"; agreement: BuilderAgreementSummary }
  | { kind: "none"; lastEnded: BuilderAgreementSummary | null };

export function organisationAgreementState(
  agreements: readonly BuilderAgreementSummary[],
): OrganisationAgreementState {
  const signed = latestSignedAgreement(agreements);
  const open = openAgreement(agreements);
  if (signed) return { kind: "signed", agreement: signed, inFlight: open };
  if (open) return { kind: "in_flight", agreement: open };
  const ended = agreements
    .filter((a) => a.status === "declined" || a.status === "voided")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { kind: "none", lastEnded: ended[0] ?? null };
}

/**
 * Whether an organisation may be approved into the Builder Portal, and on what
 * basis. The basis is always written down — it travels to the network as the
 * approval's reason — so an approval is explainable from the record alone.
 *
 *  1. A signed agreement satisfies the gate, whatever terms it was signed on.
 *  2. With no terms in force the gate is not enforced: a gate nobody can
 *     satisfy would stop every approval, which is an outage, not a control.
 *  3. Otherwise an admin may waive it, in words.
 *  4. Otherwise the approval is refused, naming the agreement in flight.
 */
export function decideBuilderAccessGate(input: {
  termsInForce: boolean;
  agreements: readonly BuilderAgreementSummary[];
  waiverReason?: string | null;
}): AccessGateDecision {
  const signed = latestSignedAgreement(input.agreements);
  if (signed) return { allow: true, basis: "signed", agreement: signed };
  if (!input.termsInForce) return { allow: true, basis: "not_enforced" };

  const open = openAgreement(input.agreements);
  const waiver = input.waiverReason?.replace(/\s+/g, " ").trim() ?? "";
  if (waiver) {
    if (waiver.length < WAIVER_REASON_MIN) {
      return {
        allow: false,
        reason: "waiver_reason_too_short",
        detail: `A reason of at least ${WAIVER_REASON_MIN} characters is required to approve without a signed ${BUILDER_PARTNER_DOCUMENT_NAME}.`,
        openAgreement: open,
      };
    }
    return { allow: true, basis: "waived", waiverReason: waiver.slice(0, WAIVER_REASON_MAX) };
  }
  if (open) {
    return {
      allow: false,
      reason: "agreement_in_flight",
      detail: `${BUILDER_PARTNER_DOCUMENT_NAME} ${open.reference ?? ""} is ${
        open.status === "draft" ? "still a draft" : `${open.status} and not yet signed`
      }. Access follows its signature.`.replace(/\s+/g, " "),
      openAgreement: open,
    };
  }
  return {
    allow: false,
    reason: "agreement_required",
    detail: `This builder has not signed a ${BUILDER_PARTNER_DOCUMENT_NAME}. Send one first, or record why access is granted without one.`,
    openAgreement: null,
  };
}

/** The reason an approval carries to the network's activity log. */
export function approvalBasisReason(
  decision: Extract<AccessGateDecision, { allow: true }>,
): string {
  switch (decision.basis) {
    case "signed":
      return `${BUILDER_PARTNER_DOCUMENT_NAME} ${decision.agreement.reference ?? decision.agreement.id} signed${
        decision.agreement.signedAt ? ` ${issuingDay(new Date(decision.agreement.signedAt))}` : ""
      } (Mission Control agreement ${decision.agreement.id}).`;
    case "waived":
      return `Approved without a signed ${BUILDER_PARTNER_DOCUMENT_NAME}: ${decision.waiverReason}`;
    case "not_enforced":
      return `No ${BUILDER_PARTNER_DOCUMENT_NAME} terms were in force at approval.`;
  }
}

/* ───────────────────────────── granting access ───────────────────────────── */

export type GrantFacts = {
  document_kind: string;
  status: string;
  builder_organisation_id: string | null;
  grant_access_on_signature: boolean;
  portal_access_status: string | null;
  portal_access_attempted_at: string | null;
  signed_record_path: string | null;
};

export type GrantSkipReason =
  | "not_builder_partner"
  | "no_organisation"
  | "not_armed"
  | "not_signed"
  | "not_retained"
  | "already_granted"
  | "in_flight"
  | "refused_needs_person";

export type GrantDecision =
  | { action: "grant" }
  | { action: "skip"; reason: GrantSkipReason; detail: string };

/**
 * Whether an attempt to approve the organisation may start now. Every refusal
 * is named, so a skipped grant is explainable from its row alone.
 *
 * The automatic path (signature, sweep) needs the agreement armed, signed and
 * its signed copy retained — evidence before action — and never retries a
 * refusal. The manual path (an admin pressing the button) needs only the
 * signature; pressing it is the decision, and it may retry anything but a
 * grant that already happened or is running.
 */
export function decideGrantAttempt(
  row: GrantFacts,
  now: number,
  opts: { manual: boolean },
): GrantDecision {
  if (row.document_kind !== BUILDER_PARTNER_KIND) {
    return {
      action: "skip",
      reason: "not_builder_partner",
      detail: `Only a ${BUILDER_PARTNER_DOCUMENT_NAME} admits a builder`,
    };
  }
  if (!row.builder_organisation_id) {
    return { action: "skip", reason: "no_organisation", detail: "No organisation is recorded" };
  }
  if (!opts.manual && !row.grant_access_on_signature) {
    return {
      action: "skip",
      reason: "not_armed",
      detail: "The agreement was not armed to grant access on signature",
    };
  }
  if (row.status !== "signed") {
    return {
      action: "skip",
      reason: "not_signed",
      detail: `The agreement is ${row.status}, not signed`,
    };
  }
  if (row.portal_access_status === "granted") {
    return { action: "skip", reason: "already_granted", detail: "Access was already granted" };
  }
  if (row.portal_access_status === "pending") {
    const at = Date.parse(row.portal_access_attempted_at ?? "");
    if (Number.isFinite(at) && now - at < STALE_GRANT_ATTEMPT_MS) {
      return { action: "skip", reason: "in_flight", detail: "An attempt is already running" };
    }
  }
  if (!opts.manual && row.portal_access_status === "refused") {
    return {
      action: "skip",
      reason: "refused_needs_person",
      detail: "The network refused the last attempt; a person must look before it is tried again",
    };
  }
  if (!opts.manual && !row.signed_record_path) {
    return {
      action: "skip",
      reason: "not_retained",
      detail: "The signed agreement has not been retained yet",
    };
  }
  return { action: "grant" };
}

/** The network's answers that no retry will change. */
export const APPROVAL_REFUSALS = new Set([
  "organisation_not_found",
  "a_closed_organisation_is_terminal",
  "not_approvable_from_current_status",
]);

export type ApproveOutcome =
  | { kind: "granted"; alreadyActive: boolean }
  | { kind: "refused"; code: string }
  | { kind: "failed"; code: string };

/**
 * What `approve_organisation` answered, in the grant's vocabulary. A refusal is
 * the network saying no about THIS organisation (closed, suspended, gone) and
 * needs a person; everything else — a switched-off console, a missing key, an
 * unreachable network, a 5xx — is ours or transient, and the sweep retries it.
 */
export function classifyApproveResult(
  result: { ok: true; body: Record<string, unknown> } | { ok: false; error: string },
): ApproveOutcome {
  if (result.ok) return { kind: "granted", alreadyActive: result.body.already_active === true };
  if (APPROVAL_REFUSALS.has(result.error)) return { kind: "refused", code: result.error };
  return { kind: "failed", code: result.error };
}

/** What set an access attempt going. */
export type GrantTrigger = "signature" | "sweep" | "manual";

/**
 * A network answer about an approval, as a sentence a person can act on. The
 * agreement page, the notification and the console all print this, so one
 * refusal is never described three ways.
 */
export function describeApprovalCode(code: string): string {
  switch (code) {
    case "organisation_not_found":
      return "The Builders Network has no such organisation.";
    case "a_closed_organisation_is_terminal":
      return "The organisation is closed on the Builders Network. Reopen it from the Builders Network console first — everything it had is kept.";
    case "not_approvable_from_current_status":
      return "The organisation is not awaiting approval on the Builders Network — it may be suspended. Review it from the Builders Network console.";
    case "operate_switch_off":
      return "The Builders Network console is switched off (there is no live operate key), so the network was not asked.";
    case "signing_key_missing":
      return "Mission Control's platform signing key is not configured, so the request to the network could not be signed.";
    case "network_url_unconfigured":
      return "The Builders Network's admin address (BUILDERS_NETWORK_ADMIN_URL) is not configured.";
    case "network_unreachable":
      return "The Builders Network did not answer.";
    default:
      return `The Builders Network answered "${code}".`;
  }
}

/**
 * The reason a grant carries to the network's activity log: the agreement it
 * rests on, and who decided — an admin pressing the button, or an admin who
 * armed the agreement to grant on signature.
 */
export function grantApprovalReason(
  agreement: BuilderAgreementSummary,
  trigger: GrantTrigger,
): string {
  const basis = approvalBasisReason({ allow: true, basis: "signed", agreement });
  return trigger === "manual"
    ? `${basis} Access granted by an admin from the agreement.`
    : `${basis} Access granted on signature, as armed by an admin.`;
}

/**
 * Whether an attempt's outcome is announced to operators. A grant is always
 * recorded. A failure nobody watched is announced; one an admin just caused by
 * pressing the button is shown to them instead. And a sweep that fails again
 * on an attempt already marked failed stays quiet — a retry every quarter of
 * an hour is not news every quarter of an hour.
 */
export function announcesGrantOutcome(input: {
  outcome: "granted" | "refused" | "failed";
  trigger: GrantTrigger;
  previousStatus: string | null;
}): boolean {
  if (input.outcome === "granted") return true;
  if (input.trigger === "manual") return false;
  if (input.outcome === "refused") return true;
  return input.trigger === "signature" || input.previousStatus === null;
}
