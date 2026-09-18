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
  blocking: "mission_control" | "network" | "unknown";
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
