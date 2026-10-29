/**
 * A team recipient list, read the one way the sender reads it.
 *
 * Shared by the dispatcher (`src/server/leadStageEmailPolicy.pure.ts`, which
 * re-exports it) and the console's Team alerts box on Email → Lead emails, so
 * what the box refuses as you type is exactly what the save and the send
 * refuse. Pure: a page may import it.
 */
import { emailKey, unwrapAddress } from "@/lib/email/emailAddress.pure";

export type RecipientSource = "configured" | "mailbox_fallback" | "applicant" | "none";

export type DroppedRecipient = { value: string; reason: string };

export type RecipientResolution = {
  recipients: string[];
  source: RecipientSource;
  dropped: DroppedRecipient[];
};

/**
 * A RECIPIENT list, split on separators a person would type deliberately.
 *
 * Not the policy's `list()` (leadStageEmailPolicy.pure.ts), which splits on
 * whitespace too. Whitespace is the right
 * separator for a stage list (`"1 2 3"`) and the wrong one for addresses: it
 * shreds `Rugesh Naidu <rugesh@…>` into three tokens, which is exactly how an
 * address arrives when somebody pastes a contact out of Outlook, and it makes
 * the `unwrapAddress` reading below unreachable. Splitting on comma, semicolon
 * and newline keeps the display-name form intact for `unwrapAddress` to read,
 * and a leading or trailing space is still trimmed off each entry. The
 * console's Team alerts box splits what is typed into it the same way.
 */
export function addressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Why a repeated address was left off a list. A repeat is sent once, not refused. */
export const REPEATED_ADDRESS = "the same address, already listed";

/**
 * Who the team's notification actually goes to, and how that was decided.
 *
 * Three things happen here that all exist because of one live defect. The
 * Airtable automation this mailer replaces carries a LEADING SPACE on four of
 * its five recipients (` rugesh@…`, ` lavan@…`, ` arvinraj@…`,
 * ` mithrubanbupathy@…`; only `admin@` is clean) and nothing anywhere records
 * whether they are trimmed before the send. If they are not, four people have
 * never received a lead alert and no surface says so.
 *
 * So: whitespace is trimmed (and a test pins that, naming the defect); an
 * address repeated in a different case is collapsed rather than mailed twice;
 * and anything that cannot be an address is dropped WITH ITS REASON rather
 * than passed to Graph to fail on — which matters more than it looks, because
 * Graph refuses the WHOLE message for one bad recipient, so a single typo in
 * this variable silences the notification for everybody on it.
 *
 * The reading of an address is `emailKey`/`unwrapAddress` and never a private
 * regex. An earlier version of this function carried its own shallow pattern,
 * and a second reading of an address is precisely the defect that lets an
 * address the SUPPRESSION REGISTER cannot key reach the wire: the register is
 * asked `emailKey(address)`, so anything this function admits that `emailKey`
 * rejects is invisible to it and is mailed however many times somebody has
 * asked us to stop. One reading, or the two disagree in the gap.
 *
 * The fallback to the sending mailbox is kept — refusing would mean nobody is
 * told, which is worse than one person being told — but it is NAMED, because
 * as the sole notifier a silent collapse from five recipients to one is the
 * same failure in a different place.
 */
export function resolveInternalRecipients(
  explicit: string[],
  mailbox: string | null,
): RecipientResolution {
  const dropped: DroppedRecipient[] = [];
  const seen = new Map<string, string>();

  for (const entry of explicit) {
    // `unwrapAddress` is what strips the leading space, the angle brackets a
    // copied Outlook contact arrives in, and a `mailto:` prefix.
    const address = unwrapAddress(entry);
    const key = emailKey(address);
    if (!key) {
      dropped.push({ value: entry, reason: "not an address this deployment can send to" });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ value: entry, reason: REPEATED_ADDRESS });
      continue;
    }
    // Stored as spelled (trimmed), keyed by identity: `Rugesh@…` renders as
    // typed and still collapses against `rugesh@…`.
    seen.set(key, address);
  }

  const recipients = [...seen.values()];
  if (recipients.length) return { recipients, source: "configured", dropped };

  const fallback = mailbox ? unwrapAddress(mailbox) : "";
  if (fallback && emailKey(fallback)) {
    return { recipients: [fallback], source: "mailbox_fallback", dropped };
  }
  return { recipients: [], source: "none", dropped };
}
