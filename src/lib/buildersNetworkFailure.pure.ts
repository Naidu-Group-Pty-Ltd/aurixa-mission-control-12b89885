/**
 * What an operator reads when the Builders Network console cannot act.
 *
 * The console reported failures by printing the transport's own discriminant
 * into the page: an operator looking at a live deployment was told the reason
 * the network could not be read was `operate_switch_off`. That is a correct
 * diagnosis in the vocabulary of `NetworkAdminResult` and no sentence at all
 * in the vocabulary of the person who has to fix it.
 *
 * Four rules shape this module.
 *
 *  * **A failure says which kind it was.** `blocking` separates a fault this
 *    deployment can repair from one that belongs to the network and from one
 *    we do not recognise. The three are different sentences and, more
 *    importantly, different next steps — sending an operator to Mission
 *    Control's own settings for a fault on the network's side wastes the one
 *    thing a status page is for.
 *
 *  * **A remedy is named only where one can be performed.** `remedy` carries a
 *    route ONLY for the fault whose repair is a page in this application. The
 *    two environment faults name the variable instead, because a link to a
 *    page that cannot set them is a dead control — and this codebase has paid
 *    for dead controls before.
 *
 *  * **An unrecognised code is humanised, never paraphrased.** The network's
 *    admin API answers with an open vocabulary, some of it already sentence-
 *    shaped (`only_a_suspended_organisation_reinstates`). Inventing a friendly
 *    meaning for a code we do not know would state something nobody measured,
 *    so an unknown code is mechanically unslugged and its raw form is kept on
 *    `code` for anyone reading it as a technical detail.
 *
 *  * **"We could not check" is not "you do not have it."** A status that did
 *    not load is `status_unreadable` — its own reading, carrying no remedy —
 *    rather than the switched-off one. Every card here reads the same status
 *    object, and `gate?.enabled` is `undefined` when that read fails, which is
 *    falsy: without a reading of its own each card falls through to its
 *    unhappy state and asserts on no evidence that the console is off.
 */

/** Where a fault can be repaired, when that place is a page in this app. */
export type NetworkFailureRemedy = {
  /** What the control says. Names the act, never the destination's title. */
  label: string;
  /** A route in this application. */
  to: string;
  /** Search params the destination validates. */
  search?: Record<string, string>;
};

export type NetworkFailureReading = {
  /** The raw code, kept so a technical reader loses nothing. */
  code: string;
  /** One sentence an operator can act on, for a body with room for it. */
  sentence: string;
  /**
   * The same statement in one clause, for a status card.
   *
   * Both live here rather than the card carrying its own literal: the status
   * strip and the empty state describe the SAME fault, and two literals is how
   * one screen comes to say something the other does not.
   */
  short: string;
  /** Present only where the repair is a page here. */
  remedy: NetworkFailureRemedy | null;
  /** Whose fault it is, which decides whether a remedy can exist at all. */
  /**
   * Where the remedy is. `operator` is the newest and the narrowest:
   * neither deployment is misconfigured and the network is answering
   * correctly — what was typed is the thing to change.
   */
  blocking: "mission_control" | "network" | "operator" | "unknown";
};

/** The one place the operate key is minted. There must not be a second. */
export const MINT_OPERATE_KEY_REMEDY: NetworkFailureRemedy = {
  label: "Mint the operate key",
  to: "/settings/billing",
  search: { tab: "keys" },
};

type Authored = Omit<NetworkFailureReading, "code">;

/**
 * Faults this deployment owns. Each names what is missing and what closes it.
 *
 * `operate_switch_off` is deliberately NOT worded as a malfunction: the key
 * row IS the switch, so its absence is the console being off rather than
 * broken, and an operator who reads "failed" goes looking for a fault that
 * does not exist.
 */
const MISSION_CONTROL: Record<string, Authored> = {
  operate_switch_off: {
    short: "Switched off — no live platform key carries the operate scope",
    sentence:
      "This console is switched off. It acts on the network with a platform key — a key minted " +
      "against the prime repo rather than a workspace, carrying the Builders Network operate " +
      "scope — and no live key of that shape exists. Minting one turns the console on; revoking " +
      "it later turns the console off again.",
    remedy: MINT_OPERATE_KEY_REMEDY,
    blocking: "mission_control",
  },
  /**
   * The status itself did not load.
   *
   * "We could not check" is not "you do not have it". The card fell through to
   * the switched-off wording whenever the status query failed, which told an
   * operator their console was off — and offered to mint a key — on no
   * evidence at all. It carries no remedy for the same reason.
   */
  status_unreadable: {
    short: "Could not be checked — the status did not load",
    sentence:
      "Whether this console can act is unknown: Mission Control could not read its own status. " +
      "This is not a statement that the console is switched off.",
    remedy: null,
    blocking: "mission_control",
  },
  read_failed: {
    short: "The operate key could not be read",
    sentence:
      "The operate key could not be read, so whether this console is switched on is unknown. " +
      "This is a fault in Mission Control's own database rather than a statement about the key.",
    remedy: null,
    blocking: "mission_control",
  },
  signing_key_missing: {
    short: "Not set — ANTHROPIC_FEDERATION_PRIVATE_KEY is missing",
    sentence:
      "Mission Control cannot sign for itself. Every call to the network is authorised by a " +
      "short-lived assertion signed with the platform's federation key, and " +
      "ANTHROPIC_FEDERATION_PRIVATE_KEY is not set in this deployment's environment.",
    remedy: null,
    blocking: "mission_control",
  },
  network_url_unconfigured: {
    short: "Set BUILDERS_NETWORK_ADMIN_URL to the network's admin function",
    sentence:
      "This deployment does not know where the network answers. Set BUILDERS_NETWORK_ADMIN_URL " +
      "to the https address of the network's builder-network-admin function.",
    remedy: null,
    blocking: "mission_control",
  },
};

/** Faults that are the network's answer, not ours. No remedy lives here. */
const NETWORK: Record<string, Authored> = {
  network_unreachable: {
    short: "The network did not answer",
    sentence:
      "The network did not answer. Mission Control is configured and signed correctly; the " +
      "request to builders.aurixasystems.com.au timed out or was refused.",
    remedy: null,
    blocking: "network",
  },
  unauthorised: {
    short: "The network refused Mission Control's assertion",
    sentence:
      "The network refused Mission Control's assertion. It verifies offline against the published " +
      "key set, so this is a trust-anchor disagreement rather than a missing setting here.",
    remedy: null,
    blocking: "network",
  },
  federation_unconfigured: {
    short: "The network holds no trust anchor for Mission Control",
    sentence:
      "The network has not been given a trust anchor, so it cannot verify any assertion Mission " +
      "Control sends. The remedy is on the network rather than in this deployment.",
    remedy: null,
    blocking: "network",
  },

  /*
   * `builder_organisations` carries three unique indexes, and a collision on
   * any of them used to reach an operator as a bare 500 — "The organisation
   * could not be saved", naming none of the ten fields on the form. Measured
   * in production on 18 Sep 2026: an operator re-used the ABN from the form's
   * own placeholder and lost the rest of the run to it, because the
   * organisation was never created and so its owner was never invited.
   *
   * The value is deliberately not repeated back. It is another
   * organisation's registration number, and this console is not the place to
   * confirm who holds it.
   */
  an_organisation_type_is_required: {
    short: "Choose a type",
    sentence:
      "An organisation type is required — the network stores it on every organisation and has no " +
      "default to fall back on.",
    remedy: null,
    blocking: "operator",
  },
  a_legal_name_is_required: {
    short: "A legal name is required",
    sentence: "An organisation cannot be created or left without a legal name.",
    remedy: null,
    blocking: "operator",
  },
  abn_must_be_11_digits: {
    short: "An ABN is eleven digits",
    sentence:
      "An ABN is exactly eleven digits. Spacing is yours to write however you like — " +
      "\u201c12 345 678 901\u201d and \u201c12345678901\u201d are the same number.",
    remedy: null,
    blocking: "operator",
  },
  acn_must_be_9_digits: {
    short: "An ACN is nine digits",
    sentence:
      "An ACN is exactly nine digits. Spacing and hyphens are yours to write however you like.",
    remedy: null,
    blocking: "operator",
  },
  postcode_must_be_4_digits: {
    short: "A postcode is four digits",
    sentence: "An Australian postcode is exactly four digits.",
    remedy: null,
    blocking: "operator",
  },
  state_is_not_an_australian_state: {
    short: "Choose a state",
    sentence:
      "The network stores one of the eight Australian state and territory codes, so the state has " +
      "to be chosen from the list rather than typed.",
    remedy: null,
    blocking: "operator",
  },
  contact_email_is_not_an_email: {
    short: "That is not an email address",
    sentence: "The contact address does not look like an email address.",
    remedy: null,
    blocking: "operator",
  },
  organisation_already_has_members: {
    short: "This organisation already has members",
    sentence:
      "Seeding the first owner is offered only while an organisation has nobody in it. From then " +
      "on its own owner invites their colleagues, which is not an operator\u2019s decision to make.",
    remedy: null,
    blocking: "operator",
  },
  that_account_has_been_withdrawn: {
    short: "That account has been withdrawn",
    sentence:
      "That person\u2019s access to the network was withdrawn. Bootstrapping a new organisation is " +
      "not a way around that decision, so it has to be reversed on their account first.",
    remedy: null,
    blocking: "operator",
  },
  a_closed_organisation_is_terminal: {
    short: "That organisation is closed",
    sentence:
      "Closing is final \u2014 a closed organisation cannot be edited, approved or given an owner. " +
      "Create a new organisation instead.",
    remedy: null,
    blocking: "operator",
  },

  /*
   * The unattended application pipeline's own vocabulary. It reaches an
   * operator through `outcome_detail` on a refused application rather than
   * through a toast, so these are written as a statement of what HAPPENED to
   * an application somebody else submitted — not as an instruction.
   */
  a_contact_name_is_required: {
    short: "The application named nobody to write to",
    sentence: "The application did not name a person to write to, so it was refused.",
    remedy: null,
    blocking: "operator",
  },
  a_valid_email_is_required: {
    short: "The application carried no usable email address",
    sentence:
      "The address on the application was not an email address, so there was nowhere to send " +
      "the invitation and it was refused.",
    remedy: null,
    blocking: "operator",
  },
  org_type_is_not_recognised: {
    short: "The application named a type the network does not hold",
    sentence:
      "The application named a kind of business the network does not store, so it was refused.",
    remedy: null,
    blocking: "operator",
  },
  an_application_for_that_address_is_already_with_us: {
    short: "A second application from the same address within a day",
    sentence:
      "That address had already applied within the last day. The window exists so one mailbox " +
      "cannot be mailed repeatedly; a second attempt usually means the first invitation never " +
      "arrived, so check whether it sent.",
    remedy: null,
    blocking: "operator",
  },
  application_not_recorded: {
    short: "The application could not be written down",
    sentence:
      "The network could not record the application at all, so nothing was created and the " +
      "applicant was told to try again. This is a fault on the network rather than the form.",
    remedy: null,
    blocking: "network",
  },
  organisation_not_created: {
    short: "The organisation could not be created",
    sentence:
      "The application was recorded and its organisation could not be created. The application " +
      "is kept so the details are not lost.",
    remedy: null,
    blocking: "network",
  },
  owner_not_created: {
    short: "The owner account could not be created",
    sentence:
      "The organisation was created and its owner account was not. Use Invite owner on that " +
      "organisation to finish it.",
    remedy: null,
    blocking: "network",
  },
  owner_not_attached: {
    short: "The owner could not be joined to the organisation",
    sentence:
      "The organisation and the owner account both exist and the membership between them was " +
      "not written. Use Invite owner on that organisation to finish it.",
    remedy: null,
    blocking: "network",
  },
  invite_not_issued: {
    short: "The invitation could not be stamped on the account",
    sentence:
      "The account exists and no invitation credential was recorded against it, so nothing was " +
      "sent. Use Invite owner on that organisation to mint a fresh one.",
    remedy: null,
    blocking: "network",
  },
  invite_service_unavailable: {
    short: "No invitation could be minted",
    sentence:
      "The network could not mint an invitation, so the application was refused rather than " +
      "creating an organisation nobody could reach.",
    remedy: null,
    blocking: "network",
  },

  abn_already_registered: {
    short: "That ABN is already registered",
    sentence:
      "Another organisation on the network is already registered with that ABN. An ABN identifies " +
      "one entity, so either this is the same business under a new name — in which case edit the " +
      "organisation that already holds it — or the number needs checking.",
    remedy: null,
    blocking: "operator",
  },
  acn_already_registered: {
    short: "That ACN is already registered",
    sentence:
      "Another organisation on the network is already registered with that ACN. An ACN identifies " +
      "one company, so either this is the same entity under a new name — in which case edit the " +
      "organisation that already holds it — or the number needs checking.",
    remedy: null,
    blocking: "operator",
  },
  legal_name_already_registered: {
    short: "That legal name is already taken",
    sentence:
      "Another organisation on the network already has that legal name. Names are compared " +
      "ignoring case and surrounding spaces, so a near-identical spelling still collides.",
    remedy: null,
    blocking: "operator",
  },
};

/**
 * Turn a snake_cased code into a sentence without inventing meaning.
 *
 * `only_a_suspended_organisation_reinstates` is already a sentence wearing
 * underscores; unslugging it is faithful where a friendlier rewrite would not
 * be. A code that carries no information (`http_502`) still reads as itself.
 */
function humanise(code: string): string {
  // `http_502` is the shape `callBuilderNetworkAdmin` invents when the network
  // answered with a status and no body of its own. Unslugged it reads
  // "Http 502.", which is worse than saying what actually happened.
  const status = /^http_(\d{3})$/.exec(code);
  if (status) return `The network answered HTTP ${status[1]} and gave no reason.`;
  const words = code.replaceAll("_", " ").trim();
  if (!words) return "The network did not say why.";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

/**
 * Read a failure code as something an operator can act on.
 *
 * Never throws and never returns null: every surface that shows a failure
 * shows one of these, so a code nobody anticipated still renders a page
 * rather than an empty area.
 */
export function readNetworkFailure(code: string | null | undefined): NetworkFailureReading {
  const raw = typeof code === "string" ? code.trim() : "";
  if (!raw) {
    return {
      code: "",
      short: "The network did not answer",
      sentence: "The network did not answer, and gave no reason.",
      remedy: null,
      blocking: "unknown",
    };
  }
  const authored = MISSION_CONTROL[raw] ?? NETWORK[raw];
  if (authored) return { code: raw, ...authored };
  const sentence = humanise(raw);
  return {
    code: raw,
    // An unrecognised code has one statement, not two: inventing a shorter
    // paraphrase would say something nobody measured.
    short: sentence,
    sentence,
    // An HTTP status the network never explained is the network's, not ours.
    blocking: raw.startsWith("http_") ? "network" : "unknown",
    remedy: null,
  };
}
