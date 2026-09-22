// The Business Readiness Questionnaire, as a vocabulary rather than a blob.
//
// One definition, three readers: the Airtable mapper composes `stage2_summary`
// from it, the internal stage email renders it, and the Leads page draws it.
// Two copies of this list is how the same applicant comes to read one way in
// an operator's inbox and another on the console — so it lives here, in `lib`,
// where the browser can reach it, rather than beside either reader.
//
// ## Two rules
//
// **An answer the applicant gave is never silently dropped.** The first cut of
// this list named 34 keys while the mapper writes 40, so six real answers —
// `roleOther`, `authorityOther`, `informationManagementOther`,
// `customSystemOwner` and the two migration "not known" qualifiers — reached
// no summary, no email and no page. Four of them are the free-text box an
// applicant types in when no option fitted, which is the most informative
// answer a questionnaire collects. They are named below, and anything the
// vocabulary has not caught up with falls into `OTHER`, humanised, rather than
// disappearing.
//
// **Database vocabulary never reaches the operator.** A key with no label is
// rendered as words, never as `customSystemApi`.

export type QuestionnaireAnswers = Record<string, unknown>;

/** One answered question, ready to draw. `list` is set only for a multi-select. */
export type QuestionnaireItem = {
  key: string;
  label: string;
  /** The answer as one line — what a summary or a plain-text email prints. */
  text: string;
  /** The same answer as its parts, for a page that draws chips. */
  list: string[] | null;
};

export type QuestionnaireSection = { heading: string; items: QuestionnaireItem[] };

export const QUESTIONNAIRE_SECTIONS: { heading: string; keys: string[] }[] = [
  {
    heading: "ORGANISATION",
    keys: [
      "role",
      "roleOther",
      "authority",
      "authorityOther",
      "userCount",
      "entityStructure",
      "regions",
    ],
  },
  {
    heading: "CURRENT SYSTEMS",
    keys: [
      "systems",
      "systemProductNames",
      "systemsOther",
      "informationManagement",
      "informationManagementOther",
      "adminTime",
    ],
  },
  { heading: "PROBLEMS", keys: ["problems", "problemsOther", "difficultWorkflow"] },
  { heading: "WANTED", keys: ["capabilities"] },
  {
    heading: "INTEGRATION",
    keys: [
      "integrations",
      "phoneSystem",
      "customSystemName",
      "customSystemOwner",
      "customSystemApi",
      "customSystemWorkflow",
    ],
  },
  {
    heading: "MIGRATION",
    keys: [
      "migration",
      "migrationSources",
      "migrationRecords",
      "migrationRecordsNotKnown",
      "migrationDocuments",
      "migrationDocumentsNotKnown",
      "migrationQuality",
      "migrationTiming",
    ],
  },
  {
    heading: "SECURITY & PROCUREMENT",
    keys: [
      "security",
      "securityContext",
      "enterpriseSso",
      "enterpriseBoundaries",
      "enterpriseProcurement",
    ],
  },
  { heading: "COMMERCIAL", keys: ["timing", "nextStep", "investmentRange", "projectSponsor"] },
];

export const QUESTIONNAIRE_LABELS: Record<string, string> = {
  role: "Role",
  roleOther: "Role (in their words)",
  authority: "Purchase authority",
  authorityOther: "Purchase authority (in their words)",
  userCount: "Users needing access",
  entityStructure: "Office / entity structure",
  regions: "Operating locations",
  systems: "Systems in use",
  systemProductNames: "Named products",
  systemsOther: "Other systems",
  informationManagement: "Information managed by",
  informationManagementOther: "Information managed by (in their words)",
  adminTime: "Weekly admin time",
  problems: "Biggest operational problems",
  problemsOther: "Other problem",
  difficultWorkflow: "Hardest workflow",
  capabilities: "Capabilities wanted (ranked)",
  integrations: "Systems to integrate",
  phoneSystem: "Phone / VoIP system",
  customSystemName: "Custom system",
  customSystemOwner: "Who maintains the custom system",
  customSystemApi: "Custom system has an API",
  customSystemWorkflow: "Custom integration workflow",
  migration: "Data migration",
  migrationSources: "Migration sources",
  migrationRecords: "Records to migrate",
  migrationRecordsNotKnown: "Record count not yet known",
  migrationDocuments: "Documents to migrate",
  migrationDocumentsNotKnown: "Document count not yet known",
  migrationQuality: "Known data-quality concerns",
  migrationTiming: "Preferred migration timing",
  security: "Security & procurement requirements",
  securityContext: "Security context",
  enterpriseSso: "Enterprise SSO required",
  enterpriseBoundaries: "Entity-level boundaries required",
  enterpriseProcurement: "Procurement process expected",
  timing: "Implementation start",
  nextStep: "Preferred next step",
  investmentRange: "Approved investment range",
  projectSponsor: "Internal project sponsor",
};

/** `customSystemApi` → `Custom system api`. Only ever a fallback. */
export function humaniseKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/**
 * One stored answer, rendered. `null` where the record holds nothing — an
 * absent answer is omitted, never printed as "N/A" or as a dash.
 *
 * `false` and `0` are answers: "no" and "none" are things an applicant said.
 */
export function renderAnswer(value: unknown): { text: string; list: string[] | null } | null {
  if (value === undefined || value === null || value === "") return null;
  if (Array.isArray(value)) {
    const parts = value.map((v) => String(v).trim()).filter(Boolean);
    return parts.length ? { text: parts.join("; "), list: parts } : null;
  }
  if (typeof value === "boolean") return { text: value ? "yes" : "no", list: null };
  const text = String(value).trim();
  return text ? { text, list: null } : null;
}

/**
 * The answer set as sections, in the order a person reads them.
 *
 * A section with nothing answered in it is not drawn. A key no section names
 * lands in `OTHER ANSWERS` rather than vanishing, because a questionnaire that
 * grows a field must not take it away from whoever has to read it.
 */
export function stage2Sections(answers: QuestionnaireAnswers): QuestionnaireSection[] {
  const named = new Set(QUESTIONNAIRE_SECTIONS.flatMap((s) => s.keys));
  const sections: QuestionnaireSection[] = [];

  for (const section of QUESTIONNAIRE_SECTIONS) {
    const items: QuestionnaireItem[] = [];
    for (const key of section.keys) {
      const rendered = renderAnswer(answers[key]);
      if (!rendered) continue;
      items.push({ key, label: QUESTIONNAIRE_LABELS[key] ?? humaniseKey(key), ...rendered });
    }
    if (items.length) sections.push({ heading: section.heading, items });
  }

  const extras: QuestionnaireItem[] = [];
  for (const key of Object.keys(answers)) {
    if (named.has(key)) continue;
    const rendered = renderAnswer(answers[key]);
    if (!rendered) continue;
    extras.push({ key, label: QUESTIONNAIRE_LABELS[key] ?? humaniseKey(key), ...rendered });
  }
  if (extras.length) sections.push({ heading: "OTHER ANSWERS", items: extras });

  return sections;
}

/**
 * A readable account of the answer set, in the applicant's own vocabulary.
 *
 * This is the same field `readinessSubmission.ts` calls `summaryText` on the
 * website path. It states nothing the record does not hold, and an empty
 * answer set summarises to null rather than to a page of headings.
 */
export function summariseStage2(answers: QuestionnaireAnswers): string | null {
  const blocks = stage2Sections(answers).map(
    (section) =>
      `${section.heading}\n${section.items.map((i) => `${i.label}: ${i.text}`).join("\n")}`,
  );
  return blocks.length ? blocks.join("\n\n") : null;
}
