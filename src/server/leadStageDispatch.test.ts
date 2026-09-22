// The dispatcher's recipient path, driven with real code and a fake transport.
//
// Every case here was found by execution rather than by reading, and each one
// reported as normal operation before it was fixed: a suppressed colleague
// looked like a healthy `sent`, an unreadable register looked like a register
// that said no, and a stale recipient list looked like a delivery to five
// people that reached one.
import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  claimed: [] as Record<string, unknown>[],
  suppressionRows: [] as { email_key: string }[],
  suppressionError: null as { message: string } | null,
  settles: [] as { id: string; patch: Record<string, unknown> }[],
  notices: [] as Record<string, unknown>[],
  sent: [] as { mailbox: string; message: Record<string, unknown> }[],
  outcome: { kind: "sent", status: 202, requestId: "rq" } as Record<string, unknown>,
  upserts: [] as Record<string, unknown>[][],
  existingKeys: new Set<string>(),
  suppressionQueries: [] as string[][],
  sweepWindows: {} as Record<string, Record<string, unknown>[]>,
  sweepErrors: {} as Record<string, { message: string } | null>,
  // The batch lead read can FAIL, and a double that cannot express that
  // cannot reach the branch where failing is confused with being absent.
  leadReadError: null as { message: string } | null,
}));

vi.mock("@/server/graph-client", () => ({
  isGraphConfigured: () => true,
  defaultMailbox: () => "hello@aurixasystems.com.au",
  sendMail: async (mailbox: string, message: Record<string, unknown>) => {
    state.sent.push({ mailbox, message });
    return state.outcome;
  },
}));

vi.mock("@/server/audit.server", () => ({
  notifyOperators: async (notice: Record<string, unknown>) => {
    state.notices.push(notice);
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: async () => ({ data: state.claimed, error: null }),
    from(table: string) {
      if (table === "waitlist_leads") {
        return {
          select: () => ({
            // The sweep reads one window per column: .gte(col, since).order().limit()
            gte: (column: string) => ({
              order: () => ({
                limit: async () => ({
                  data: state.sweepWindows[column] ?? [],
                  error: state.sweepErrors[column] ?? null,
                }),
              }),
            }),
            in: async () => ({
              data: state.leadReadError
                ? null
                : [
                    {
                      id: "lead-1",
                      email: "applicant@example.com",
                      first_name: "Ada",
                      last_name: "Lovelace",
                      application_id: "AX-0000000001",
                      created_at: "2026-09-22T00:00:00.000Z",
                      submitted_at: "2026-09-22T00:00:00.000Z",
                      enrichment_synced_at: "2026-09-22T01:00:00.000Z",
                    },
                  ],
              error: state.leadReadError,
            }),
          }),
        };
      }
      if (table === "email_suppressions") {
        return {
          select: () => ({
            // The double HONOURS its own `in` list, and that is not a detail.
            // A version that ignored the keys returned every suppression row
            // whatever was asked about, so a bug where the register is asked
            // about one set of addresses and enforced on another was invisible
            // to every test here — code and double agreeing while only the
            // server would have disagreed. That is the `.or()`-regex-double
            // failure this platform has already paid for twice.
            in: async (_column: string, keys: string[]) => {
              state.suppressionQueries.push(keys);
              return {
                data: state.suppressionRows.filter((r) => keys.includes(r.email_key)),
                error: state.suppressionError,
              };
            },
          }),
        };
      }
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            state.settles.push({ id, patch });
            return { error: null };
          },
        }),
        upsert: (batch: Record<string, unknown>[]) => {
          state.upserts.push(batch);
          return {
            // The real upsert carries `ignoreDuplicates`, so a row that exists
            // is NOT returned. Modelled here, because that is the mechanism
            // that made a terminal row permanent.
            select: async () => ({
              data: batch.filter((r) => {
                const key = `${r.lead_id}/${r.stage}/${r.audience}`;
                if (state.existingKeys.has(key)) return false;
                state.existingKeys.add(key);
                return true;
              }),
              error: null,
            }),
          };
        },
      };
    },
  },
}));

import {
  dispatchStageEmails,
  enqueueStageEmails,
  sweepMissingStageEmails,
} from "./lead-stage-emails.server";
import { recipientReading } from "@/lib/leadStageEmailReading.pure";

const TEAM = ["admin", "rugesh", "lavan", "arvinraj", "mithrubanbupathy"].map(
  (name) => `${name}@aurixasystems.com.au`,
);

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  lead_id: "lead-1",
  stage: 1,
  audience: "internal",
  recipients: TEAM,
  reason: null,
  attempts: 1,
  ...over,
});

const wire = () =>
  ((state.sent[0]?.message.toRecipients as { emailAddress: { address: string } }[]) ?? []).map(
    (r) => r.emailAddress.address,
  );
const patch = () => state.settles[0]?.patch ?? {};

beforeEach(() => {
  state.claimed = [];
  state.suppressionRows = [];
  state.leadReadError = null;
  state.suppressionError = null;
  state.settles = [];
  state.notices = [];
  state.sent = [];
  state.outcome = { kind: "sent", status: 202, requestId: "rq" };
  state.upserts = [];
  state.existingKeys = new Set();
  state.suppressionQueries = [];
  state.sweepWindows = {};
  state.sweepErrors = {};
  process.env.MICROSOFT_MAILBOX_EMAIL = "hello@aurixasystems.com.au";
  process.env.LEAD_STAGE_INTERNAL_RECIPIENTS = TEAM.join(",");
  delete process.env.LEAD_STAGE_INTERNAL_STAGES;
});

describe("the whole team is on the wire", () => {
  it("puts every configured recipient on the message, not just the first", async () => {
    state.claimed = [row()];
    const result = await dispatchStageEmails();
    expect(wire()).toEqual(TEAM);
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
  });
});

describe("a recipient list that has gone stale", () => {
  it("re-resolves an internal send from the CURRENT deployment, not from the row", async () => {
    // Measured: the ledger upserts with `ignoreDuplicates`, so a row raised
    // while the recipient list was unset keeps the fallback FOR EVER, and the
    // unique index means it can never be raised again. The ordinary cutover
    // sequence — deploy, notice the list is not set, set it — left every
    // queued lead notifying one address while the console read `sent`.
    state.claimed = [row({ recipients: ["hello@aurixasystems.com.au"] })];
    await dispatchStageEmails();
    expect(wire()).toEqual(TEAM);
    expect(String(patch().reason)).toContain("re-resolved at send");
  });

  it("says nothing extra when the row already agrees with the deployment", async () => {
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(patch().reason).toBeNull();
  });

  it("keeps the row's own recipients when the deployment has only a fallback", async () => {
    // A `mailbox_fallback` is not an answer about who should be told, it is an
    // admission that nobody is configured. Letting it overrule a row that
    // already names real recipients would be the same five-to-one collapse
    // this re-resolution exists to prevent, arrived at from the other side.
    delete process.env.LEAD_STAGE_INTERNAL_RECIPIENTS;
    state.claimed = [row({ recipients: ["standing@aurixasystems.com.au"] })];
    await dispatchStageEmails();
    expect(wire()).toEqual(["standing@aurixasystems.com.au"]);
    expect(patch().reason).toBeNull();
  });

  it("leaves an APPLICANT row alone — their address is a fact about the lead", async () => {
    state.claimed = [row({ audience: "applicant", recipients: ["applicant@example.com"] })];
    await dispatchStageEmails();
    expect(wire()).toEqual(["applicant@example.com"]);
  });
});

describe("the do-not-send register", () => {
  it("holds the batch rather than burning it when the register cannot be read", async () => {
    // `suppressed` is terminal. Recording it on a statement timeout drops the
    // notification permanently and records a reason that says the opposite of
    // what happened — nobody was on the register, the register was not read.
    state.suppressionError = { message: "57014 statement timeout" };
    state.claimed = [row()];
    const result = await dispatchStageEmails();

    expect(state.sent).toHaveLength(0);
    expect(patch().status).toBe("pending");
    expect(patch().claimed_at).toBeNull();
    expect(String(patch().last_error)).toContain("could not be read");
    expect(patch().reason).toBeUndefined();
    expect(result.suppressed).toBe(0);
  });

  it("raises the unreadable register to an operator, because nothing else would", async () => {
    state.suppressionError = { message: "57014 statement timeout" };
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(state.notices).toHaveLength(1);
    expect(String(state.notices[0].title)).toContain("could not be read");
  });

  it("still refuses when the register ANSWERED and named everybody", async () => {
    state.suppressionRows = TEAM.map((email_key) => ({ email_key }));
    state.claimed = [row()];
    const result = await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(patch().status).toBe("suppressed");
    expect(result.suppressed).toBe(1);
  });

  it("raises a suppressed COLLEAGUE, who otherwise stops being told in silence", async () => {
    // A team recipient on the register is anomalous — nobody unsubscribes
    // themselves from their own lead alerts. Once this is the sole notifier,
    // the failure is that one person is never told again while every ledger
    // row reads `sent`.
    state.suppressionRows = [{ email_key: "rugesh@aurixasystems.com.au" }];
    state.claimed = [row()];
    await dispatchStageEmails();

    expect(wire()).toHaveLength(4);
    expect(patch().status).toBe("sent");
    expect(String(patch().reason)).toContain("1 recipient(s) suppressed");
    expect(state.notices).toHaveLength(1);
    expect(String(state.notices[0].body)).toContain("rugesh@aurixasystems.com.au");
  });

  it("raises nothing for a suppressed APPLICANT — that is the register working", async () => {
    state.suppressionRows = [{ email_key: "applicant@example.com" }];
    state.claimed = [
      row({ audience: "applicant", recipients: ["applicant@example.com", "cc@example.com"] }),
    ];
    await dispatchStageEmails();
    expect(state.notices).toHaveLength(0);
  });
});

describe("what reaches Microsoft Graph", () => {
  it("never carries an address the register cannot key", async () => {
    // Graph refuses the WHOLE message for one bad recipient, and an address
    // `emailKey` cannot read is invisible to the suppression lookup — so one
    // malformed entry either silences the notification for everybody or mails
    // somebody who asked us to stop.
    process.env.LEAD_STAGE_INTERNAL_RECIPIENTS = `${TEAM[0]}, Rugesh Naidu, ${TEAM[1]}\\`;
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(wire()).toEqual([TEAM[0]]);
    expect(state.sent).toHaveLength(1);
  });

  it("answers the applicant on an internal send, because reply is the act", async () => {
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(state.sent[0].message.replyTo).toEqual([
      { emailAddress: { address: "applicant@example.com" } },
    ]);
  });
});

describe("the tick answers with its own readiness", () => {
  // Three facts decide whether this mailer works and all three live on the
  // deployment, where no test in this repository can see them. The schedule it
  // hangs off is allowed to fail silently — the migration wraps
  // `cron.schedule` in `EXCEPTION WHEN OTHERS THEN RAISE WARNING` — so an
  // authenticated tick that reports what it would have done is the one
  // assertion by EFFECT available before the Airtable automation is retired.
  it("names the recipient count and how it was resolved", async () => {
    state.claimed = [];
    const result = await dispatchStageEmails();
    expect(result.readiness).toMatchObject({
      graph: true,
      mailbox: true,
      recipients: 5,
      recipientSource: "configured",
      internalStages: [1, 2, 3],
      applicantMode: "auto",
    });
  });

  it("says `mailbox_fallback` out loud, because one told looks like five told", async () => {
    delete process.env.LEAD_STAGE_INTERNAL_RECIPIENTS;
    const result = await dispatchStageEmails();
    expect(result.readiness).toMatchObject({ recipients: 1, recipientSource: "mailbox_fallback" });
  });

  it("carries what the list dropped, so a typo is visible before it costs a send", async () => {
    process.env.LEAD_STAGE_INTERNAL_RECIPIENTS = "good@x.com, Rugesh Naidu";
    const result = await dispatchStageEmails();
    expect(result.readiness.droppedRecipients).toEqual([
      { value: "Rugesh Naidu", reason: "not an address this deployment can send to" },
    ]);
  });

  it("reports readiness even when it cannot send at all", async () => {
    // The reading a deployment with no credentials most needs is the one that
    // says which credential is missing — so it comes BEFORE the early return.
    delete process.env.LEAD_STAGE_INTERNAL_RECIPIENTS;
    const result = await dispatchStageEmails();
    expect(result.readiness.graph).toBe(true);
    expect(result.readiness.recipientSource).toBe("mailbox_fallback");
  });

  it("names which stages it would tell the team about", async () => {
    // The stage already covered by a FIRING Airtable automation is the one to
    // exclude; this is how an operator checks that landed.
    process.env.LEAD_STAGE_INTERNAL_STAGES = "2,3";
    const result = await dispatchStageEmails();
    expect(result.readiness.internalStages).toEqual([2, 3]);
  });
});

describe("what the row says afterwards is what the page draws", () => {
  // The ledger answers one question — was this person told? — so a settled row
  // has to describe the send that HAPPENED, not the one that was raised. With
  // re-resolution in place these can differ, and the row is the only record.
  const STALE = {
    id: "row-1",
    lead_id: "lead-1",
    stage: 1,
    audience: "internal",
    recipients: ["hello@aurixasystems.com.au"],
    recipient_source: "mailbox_fallback",
    to_address: "hello@aurixasystems.com.au",
    reason: "no LEAD_STAGE_INTERNAL_RECIPIENTS set — only the sending mailbox was told",
    attempts: 1,
  };

  it("rewrites the row to the five who were mailed, not the one who was owed", async () => {
    // Without this the row keeps `["hello@…"]` and `mailbox_fallback` after a
    // send that reached five people, and the Leads page draws
    // "hello@… · sending mailbox only" over it — the exact defect the
    // re-resolution exists to fix, surviving one layer up.
    state.claimed = [{ ...STALE }];
    await dispatchStageEmails();

    expect(wire()).toEqual(TEAM);
    expect(patch().recipients).toEqual(TEAM);
    expect(patch().recipient_source).toBe("configured");
    expect(String(patch().reason)).toContain("re-resolved at send");
  });

  it("draws the send that happened, read through the page's own function", async () => {
    state.claimed = [{ ...STALE }];
    await dispatchStageEmails();
    const after = { ...STALE, ...patch() } as never;
    expect(recipientReading(after)).toBe("admin@aurixasystems.com.au +4");
  });

  it("records only who was actually mailed when the register blocked somebody", async () => {
    // "Five were owed, four were told" is the fact, and the row is where it
    // lives. `reason` says how many were suppressed; `recipients` says who got
    // it, so the two together answer the question for each named person.
    state.suppressionRows = [{ email_key: "rugesh@aurixasystems.com.au" }];
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(patch().recipients).toHaveLength(4);
    expect(patch().recipients).not.toContain("rugesh@aurixasystems.com.au");
    expect(String(patch().reason)).toContain("1 recipient(s) suppressed");
  });

  it("holds the batch when the LEAD read fails, rather than calling the lead deleted", async () => {
    // `leadRows` is null on a failed query exactly as it is on an empty one,
    // and the branch below it settled TERMINAL `failed` reading "the lead this
    // obligation belongs to no longer exists". That sentence cannot be true:
    // `lead_id` is ON DELETE CASCADE, so a deleted lead takes its ledger rows
    // with it and there is nothing left to settle. One statement timeout
    // therefore left every applicant in the batch permanently unacknowledged,
    // notified nobody, and wrote on the Leads page that the lead had been
    // deleted — beside the lead.
    state.leadReadError = { message: "canceling statement due to statement timeout" };
    state.claimed = [row(), row({ id: "row-2" })];
    await dispatchStageEmails();

    expect(state.sent).toHaveLength(0);
    for (const settled of state.settles) {
      const patched = settled.patch;
      expect(patched.status).toBe("pending");
      expect(patched.claimed_at).toBeNull();
      expect(String(patched.last_error)).toContain("could not be read");
    }
    expect(state.notices.some((n) => String(n.title).includes("lead rows could not be read"))).toBe(
      true,
    );
  });

  it("is not vacuous — the same batch settles normally when the read succeeds", async () => {
    // A knob nothing turns proves nothing about the branch it guards.
    state.claimed = [row(), row({ id: "row-2" })];
    await dispatchStageEmails();
    expect(state.sent).toHaveLength(2);
    expect(state.settles.every((settled) => settled.patch.status === "sent")).toBe(true);
  });

  it("leaves an applicant row's own address alone", async () => {
    state.claimed = [row({ audience: "applicant", recipients: ["applicant@example.com"] })];
    await dispatchStageEmails();
    expect(patch().recipients).toEqual(["applicant@example.com"]);
    expect(patch().recipient_source).toBe("applicant");
  });
});

describe("the applicant backstop survives being enqueued too early", () => {
  // The ingest endpoint enqueues the moment the form is submitted — t=0, always
  // inside the grace period — and the sweep re-enqueues every five minutes.
  // The unique index keeps whatever the FIRST call wrote, so if t=0 records a
  // terminal verdict the backstop is dead for every lead that ever came
  // through the website.
  const applicantStage1 = (batch: Record<string, unknown>[]) =>
    batch.find((r) => r.audience === "applicant" && r.stage === 1);

  // `syncedMsAgo` is when the Airtable mirror last read this lead's record,
  // which is what turns a missing receipt into evidence about the WORKFLOW
  // rather than about the mirror. Defaulting it to "just now" is the ordinary
  // state of a row: the mirror is the only writer of `waitlist_leads`, so a
  // row exists because it ran.
  const lead = (agoMs: number, syncedMsAgo: number | null = 0) => ({
    id: "lead-1",
    email: "applicant@example.com",
    created_at: new Date(Date.now() - agoMs).toISOString(),
    submitted_at: new Date(Date.now() - agoMs).toISOString(),
    enrichment_synced_at:
      syncedMsAgo === null ? null : new Date(Date.now() - syncedMsAgo).toISOString(),
  });

  it("writes NO obligation while the grace period is still running", async () => {
    await enqueueStageEmails({ leadId: "lead-1", lead: lead(60_000), trigger: "ingest" });
    expect(applicantStage1(state.upserts[0] ?? [])).toBeUndefined();
  });

  it("raises it on a later tick, once the mirror has looked and found nothing", async () => {
    // t=0 from the website, then the sweep six hours later — by which time the
    // hourly mirror has read the record and it still carries no receipt.
    await enqueueStageEmails({ leadId: "lead-1", lead: lead(60_000), trigger: "ingest" });
    await enqueueStageEmails({ leadId: "lead-1", lead: lead(6 * 3_600_000), trigger: "manual" });

    const raised = applicantStage1(state.upserts[1] ?? []);
    expect(raised).toBeDefined();
    expect(raised?.status).toBe("pending");
  });

  it("raises NOTHING on that tick while the mirror is still behind", async () => {
    // The same six-hour-old lead, on a row nothing has read since the receipt
    // column began to be mapped. An absent receipt there is a statement about
    // the mirror, and acting on it sends a duplicate of an email the workflow
    // already sent. `none` — so the tick after the sync can still decide.
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: lead(6 * 3_600_000, null),
      trigger: "manual",
    });
    expect(applicantStage1(state.upserts[0] ?? [])).toBeUndefined();
  });

  it("still never raises one where the workflow's own receipt exists", async () => {
    // The backstop is a backstop. A receipt is the evidence that settles it,
    // and it must keep settling it — this is the guard against two
    // "Application received" emails four minutes apart.
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: { ...lead(6 * 3_600_000), stage1_email_message_id: "AAMk..." },
      trigger: "manual",
    });
    const raised = applicantStage1(state.upserts[0] ?? []);
    expect(raised?.status).toBe("skipped");
    expect(String(raised?.reason)).toContain("already emailed");
  });
});

describe("the sweep asks three windows and merges them", () => {
  // It is the only path that raises an applicant's acknowledgement once the
  // grace period has elapsed, so losing a window here is silent and total for
  // that stage.
  const lead = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    email: `${id}@example.com`,
    created_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    submitted_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    ...over,
  });

  it("reads every stage's own column, not just the first", async () => {
    state.sweepWindows = {
      created_at: [lead("a")],
      stage2_completed_at: [lead("b", { stage2_completed_at: new Date().toISOString() })],
      stage3_booked_at: [lead("c", { stage3_booked_at: new Date().toISOString() })],
    };
    await sweepMissingStageEmails();
    const seen = state.upserts.flat().map((r) => r.lead_id);
    expect(new Set(seen)).toEqual(new Set(["a", "b", "c"]));
  });

  it("enqueues a lead once when two windows both return it", async () => {
    const both = lead("a", { stage2_completed_at: new Date().toISOString() });
    state.sweepWindows = { created_at: [both], stage2_completed_at: [both] };
    await sweepMissingStageEmails();
    expect(state.upserts).toHaveLength(1);
  });

  it("keeps the windows that answered when one read fails", async () => {
    // A failed read is about us, not about the applicants — losing one window
    // must not lose the other two.
    state.sweepErrors = { stage2_completed_at: { message: "57014 statement timeout" } };
    state.sweepWindows = { created_at: [lead("a")], stage3_booked_at: [lead("c")] };
    await sweepMissingStageEmails();
    const seen = state.upserts.flat().map((r) => r.lead_id);
    expect(new Set(seen)).toEqual(new Set(["a", "c"]));
  });
});

describe("the register is asked about the addresses that will be sent to", () => {
  // Found by audit, and it was introduced by the re-resolution fix itself.
  // `readSuppressions` used to build its query from `row.recipients` — the
  // STORED list — while the send used the re-resolved one. Any address the
  // re-resolution added was therefore never asked about, and so could never
  // be blocked.
  const STALE_ROW = {
    id: "row-1",
    lead_id: "lead-1",
    stage: 1,
    audience: "internal",
    recipients: ["hello@aurixasystems.com.au"],
    recipient_source: "mailbox_fallback",
    to_address: "hello@aurixasystems.com.au",
    reason: null,
    attempts: 1,
  };

  it("asks about every address it is about to mail, not the ones it was raised with", async () => {
    state.claimed = [{ ...STALE_ROW }];
    await dispatchStageEmails();
    const asked = state.suppressionQueries.flat();
    for (const address of TEAM) expect(asked).toContain(address);
  });

  it("blocks a suppressed colleague the row was never raised with", async () => {
    // The cutover sequence exactly: the row predates the recipient list, and
    // one of the people that list adds is on the register. Before the fix all
    // five were mailed, the register was asked about one, nothing was blocked
    // and nothing was notified.
    state.claimed = [{ ...STALE_ROW }];
    state.suppressionRows = [{ email_key: "rugesh@aurixasystems.com.au" }];
    await dispatchStageEmails();

    expect(wire()).not.toContain("rugesh@aurixasystems.com.au");
    expect(wire()).toHaveLength(4);
    expect(String(patch().reason)).toContain("1 recipient(s) suppressed");
    expect(state.notices).toHaveLength(1);
  });

  it("the double is not vacuous — it filters, so an unasked key cannot match", async () => {
    // Proof the guard above can fail: a register row for somebody outside the
    // query must not come back.
    state.claimed = [{ ...STALE_ROW }];
    state.suppressionRows = [{ email_key: "nobody@elsewhere.example" }];
    await dispatchStageEmails();
    expect(wire()).toEqual(TEAM);
    expect(state.notices).toHaveLength(0);
  });
});
