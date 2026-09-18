/**
 * What a builder lead is told when their application cannot be accepted.
 *
 * The network answers this form with the SAME refusal vocabulary it answers
 * the operator console with, and `buildersNetworkFailure.pure.ts` already
 * authors a sentence for most of those codes — but it authors them for an
 * OPERATOR. Its reading of `abn_already_registered` ends "edit the
 * organisation that already holds it", which is a correct next step for
 * somebody holding the console and an impossible one for a stranger filling
 * in a form. Handing the console's wording to an applicant would tell them to
 * perform an act they have no way to perform, which is the dead-control
 * failure this codebase keeps paying for, pointed at the public.
 *
 * Three rules shape this module.
 *
 *  * **An applicant is only ever told what an applicant can do.** Every
 *    sentence here resolves to one of three things: fix a field they typed,
 *    wait, or write to us. Nothing names a console, a route, an environment
 *    variable or a record they cannot reach, and a test asserts that by
 *    scanning the prose rather than trusting it.
 *
 *  * **A collision is never explained.** `abn_already_registered` tells the
 *    applicant their details are already on the network and to get in touch —
 *    it does not confirm WHICH organisation holds the number, because this
 *    page is unauthenticated and an open form that reports whether an ABN is
 *    registered is a lookup service for somebody else's business.
 *
 *  * **An unrecognised code is an apology, not a paraphrase.** The console
 *    can afford to unslug a code it does not know, because its reader is
 *    technical and the raw form is information. An applicant reading
 *    "Owner not created." learns nothing and is alarmed by it, so anything
 *    unauthored falls through to one sentence that is true of every fault:
 *    it did not go through and it is ours to fix.
 */

/** The organisation kinds the network stores. Mirrors its own ORG_TYPES. */
export const ORG_TYPE_LABEL: Record<string, string> = {
  builder: "Builder",
  developer: "Developer",
  builder_developer: "Builder & developer",
  sales_representative: "Sales representative",
};

/** Australian states and territories, as the network's CHECK spells them. */
export const APPLICATION_STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"] as const;

export type ApplicationRefusalKind =
  /** Something they typed. The form can point at it. */
  | "field"
  /** True of the application but not of one field — nothing to highlight. */
  | "application"
  /** Ours. They did nothing wrong and cannot fix it. */
  | "ours";

export interface ApplicationRefusal {
  readonly code: string;
  readonly sentence: string;
  /** The form field to focus, where the refusal names one. */
  readonly field: string | null;
  readonly kind: ApplicationRefusalKind;
}

type Authored = Omit<ApplicationRefusal, "code">;

/**
 * The codes `submit_access_request` can answer with, in the applicant's
 * words. Kept as one table so the page carries no literals of its own — the
 * form and any later surface read the same sentence, which is what stops one
 * screen saying something another does not.
 */
const AUTHORED: Record<string, Authored> = {
  // --- what they typed -------------------------------------------------
  a_legal_name_is_required: {
    sentence: "Please give the registered name of your business.",
    field: "legal_name",
    kind: "field",
  },
  a_contact_name_is_required: {
    sentence: "Please tell us who we are writing to.",
    field: "contact_name",
    kind: "field",
  },
  a_valid_email_is_required: {
    sentence:
      "That does not look like an email address, and it is where your access link is sent — " +
      "so it has to be one you can open.",
    field: "contact_email",
    kind: "field",
  },
  an_organisation_type_is_required: {
    sentence: "Please choose whether you build, develop, or both.",
    field: "org_type",
    kind: "field",
  },
  org_type_is_not_recognised: {
    sentence: "Please choose one of the listed types of business.",
    field: "org_type",
    kind: "field",
  },
  abn_must_be_11_digits: {
    sentence:
      "An ABN is eleven digits. Spacing is yours — “12 345 678 901” and " +
      "“12345678901” are the same number.",
    field: "abn",
    kind: "field",
  },
  acn_must_be_9_digits: {
    sentence: "An ACN is nine digits. Spacing and hyphens are yours to write however you like.",
    field: "acn",
    kind: "field",
  },
  postcode_must_be_4_digits: {
    sentence: "An Australian postcode is four digits.",
    field: "postcode",
    kind: "field",
  },
  state_is_not_an_australian_state: {
    sentence: "Please choose your state or territory from the list.",
    field: "state",
    kind: "field",
  },

  // --- true of the application ------------------------------------------
  /*
   * The window is a day, and saying so is the whole point: an applicant who
   * is told only "already with us" tries again immediately, which is exactly
   * the behaviour the window exists to stop.
   */
  an_application_for_that_address_is_already_with_us: {
    sentence:
      "We already have an application from this address today. Check your inbox — including " +
      "your spam folder — for a message from us, and get in touch if nothing arrived.",
    field: "contact_email",
    kind: "application",
  },
  /*
   * Deliberately says nothing about WHICH organisation holds the number. An
   * unauthenticated form that confirms an ABN is registered is a lookup
   * service for other people's businesses.
   */
  abn_already_registered: {
    sentence:
      "That ABN is already on the network. If your business is already here, ask whoever set it " +
      "up to invite you — or get in touch and we will sort it out.",
    field: "abn",
    kind: "application",
  },
  acn_already_registered: {
    sentence:
      "That ACN is already on the network. If your business is already here, ask whoever set it " +
      "up to invite you — or get in touch and we will sort it out.",
    field: "acn",
    kind: "application",
  },
  legal_name_already_registered: {
    sentence:
      "A business is already registered under that name. If it is yours, ask whoever set it up " +
      "to invite you — or get in touch and we will sort it out.",
    field: "legal_name",
    kind: "application",
  },
  that_account_has_been_withdrawn: {
    sentence:
      "We cannot open an account for that email address. Please get in touch so we can look at " +
      "it with you.",
    field: "contact_email",
    kind: "application",
  },
};

/** One sentence true of every fault that is ours rather than theirs. */
export const APPLICATION_FAULT_SENTENCE =
  "Something went wrong on our side and your application was not submitted. " +
  "Please try again in a few minutes, or get in touch if it keeps happening.";

/**
 * Read a refusal as something the applicant can act on.
 *
 * Never throws and never returns null: the page renders one of these
 * whatever came back, so an unanticipated code still draws a sentence
 * rather than an empty alert.
 */
export function readApplicationRefusal(code: string | null | undefined): ApplicationRefusal {
  const raw = typeof code === "string" ? code.trim() : "";
  const authored = raw ? AUTHORED[raw] : undefined;
  if (authored) return { code: raw, ...authored };
  return { code: raw, sentence: APPLICATION_FAULT_SENTENCE, field: null, kind: "ours" };
}

/** Every code this module authors, for tests and for nothing else. */
export const AUTHORED_APPLICATION_REFUSALS = Object.freeze(Object.keys(AUTHORED));
