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
  upsertTargets: [] as string[],
  // One answer per upsert, in order; a ledger without the generation column
  // answers the way PostgREST does (`PGRST204`).
  upsertErrors: [] as ({ message: string; code: string } | null)[],
  existingKeys: new Set<string>(),
  suppressionQueries: [] as string[][],
  sweepWindows: {} as Record<string, Record<string, unknown>[]>,
  sweepErrors: {} as Record<string, { message: string } | null>,
  // The batch lead read can FAIL, and a double that cannot express that
  // cannot reach the branch where failing is confused with being absent.
  leadReadError: null as { message: string } | null,
  // Email → Lead emails: who sends each stage, the copy, the minted links.
  settingsRow: null as Record<string, unknown> | null,
  settingsError: null as { message: string; code?: string } | null,
  templateRows: [] as Record<string, unknown>[],
  templatesError: null as { message: string; code?: string } | null,
  links: [] as Record<string, unknown>[],
  // What the lead row says beyond the Stage 1 basics, per case.
  leadOver: {} as Record<string, unknown>,
  // What a re-read of the lead says once a link is minted: a correction can
  // land between the batch read and the send.
  leadNow: null as Record<string, unknown> | null,
  linksClosed: [] as { patch: Record<string, unknown>; token: string }[],
}));

vi.mock("@/server/graph-client", () => ({
  isGraphConfigured: () => true,
  defaultMailbox: () => "hello@aurixasystems.com.au",
  defaultGraphConfig: () => ({
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    mailbox: "hello@aurixasystems.com.au",
  }),
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
            // The re-read after a Stage 1 link is minted.
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: "lead-1", ...state.leadOver, ...(state.leadNow ?? {}) },
                error: null,
              }),
            }),
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
                      ...state.leadOver,
                    },
                  ],
              error: state.leadReadError,
            }),
          }),
        };
      }
      if (table === "lead_email_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.settingsRow, error: state.settingsError }),
            }),
          }),
        };
      }
      if (table === "lead_email_templates") {
        return {
          select: async () => ({ data: state.templateRows, error: state.templatesError }),
        };
      }
      if (table === "lead_questionnaire_links") {
        return {
          insert: async (link: Record<string, unknown>) => {
            state.links.push(link);
            return { error: null };
          },
          update: (patch: Record<string, unknown>) => ({
            eq: async (_column: string, token: string) => {
              state.linksClosed.push({ patch, token });
              return { error: null };
            },
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
        upsert: (batch: Record<string, unknown>[], options: { onConflict?: string } = {}) => {
          const error = state.upsertErrors.shift() ?? null;
          state.upserts.push(batch);
          state.upsertTargets.push(options.onConflict ?? "");
          return {
            // The real upsert carries `ignoreDuplicates`, so a row that exists
            // is NOT returned. Modelled here, because that is the mechanism
            // that made a terminal row permanent. The key is the index's own:
            // an applicant email belongs to its address generation.
            select: async () =>
              error
                ? { data: null, error }
                : {
                    data: batch.filter((r) => {
                      const key = `${r.lead_id}/${r.stage}/${r.audience}/${r.generation ?? 0}`;
                      if (state.existingKeys.has(key)) return false;
                      state.existingKeys.add(key);
                      return true;
                    }),
                    error: null,
                  },
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
  state.upsertTargets = [];
  state.upsertErrors = [];
  state.existingKeys = new Set();
  state.suppressionQueries = [];
  state.sweepWindows = {};
  state.sweepErrors = {};
  state.settingsRow = null;
  state.settingsError = null;
  state.templateRows = [];
  state.templatesError = null;
  state.links = [];
  state.leadOver = {};
  state.leadNow = null;
  state.linksClosed = [];
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
    reason: "no team alert recipients set — only the sending mailbox was told",
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
    application_id: "AX-0000000001",
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
    // six-hourly mirror has read the record and it still carries no receipt.
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
    application_id: "AX-0000000001",
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

describe("an applicant who corrected their address (docs/LEAD_EMAILS.md)", () => {
  const OWNED = {
    id: true,
    stage1_sender: "mission_control",
    stage2_sender: "mission_control",
    stage3_sender: "mission_control",
    tenant_id: null,
    from_mailbox: null,
    from_name: null,
    reply_to: null,
    internal_recipients: null,
    internal_stages: null,
    updated_at: "2026-10-29T00:00:00.000Z",
    updated_by: null,
  };
  const fresh = (over: Record<string, unknown> = {}) => ({
    id: "lead-1",
    email: "jordan@firm.com.au",
    application_id: "AX-0000000001",
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
    enrichment_synced_at: new Date().toISOString(),
    ...over,
  });
  const raised = () => state.upserts.flat();

  it("raises the applicant email for the lead's address generation, and team alerts at 0", async () => {
    state.settingsRow = OWNED;
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: fresh({ applicant_email_generation: 2 }),
      trigger: "ingest",
    });
    expect(state.upsertTargets[0]).toBe("lead_id,stage,audience,generation");
    expect(raised().find((r) => r.audience === "applicant")?.generation).toBe(2);
    expect(raised().find((r) => r.audience === "internal")?.generation).toBe(0);
  });

  it("owes the Stage 1 email again at the corrected address, beside the one already sent", async () => {
    state.settingsRow = OWNED;
    await enqueueStageEmails({ leadId: "lead-1", lead: fresh(), trigger: "ingest" });
    const second = await enqueueStageEmails({
      leadId: "lead-1",
      lead: fresh({ email: "jordan@firm.com", applicant_email_generation: 1 }),
      trigger: "ingest",
    });
    const corrected = state.upserts[1]?.find((r) => r.audience === "applicant");
    expect(corrected).toMatchObject({
      status: "pending",
      generation: 1,
      recipients: ["jordan@firm.com"],
    });
    // The team alert is about the lead, not the address: not raised twice.
    expect(second).toMatchObject({ queued: 1, existing: 1 });
  });

  it("settles an email for the old address superseded rather than sending it", async () => {
    state.leadOver = { applicant_email_generation: 1, email: "jordan@firm.com" };
    state.claimed = [
      row({ audience: "applicant", recipients: ["jordan@firm.com.au"], generation: 0 }),
    ];
    const result = await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(patch()).toMatchObject({
      status: "skipped",
      reason: "superseded: the applicant corrected their address",
    });
    expect(result).toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
  });

  it("closes the link and does not send when the correction lands mid-send", async () => {
    // The batch read the lead before the correction; the re-read after the
    // link is minted sees it.
    state.settingsRow = OWNED;
    state.claimed = [
      row({ audience: "applicant", recipients: ["jordan@firm.com.au"], generation: 0 }),
    ];
    state.leadNow = { applicant_email_generation: 1, email: "jordan@firm.com" };
    const result = await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(state.links).toHaveLength(1);
    expect(state.linksClosed).toEqual([
      { patch: { expires_at: expect.any(String) }, token: state.links[0]?.token_sha256 },
    ]);
    expect(patch()).toMatchObject({
      status: "skipped",
      reason: "superseded: the applicant corrected their address",
    });
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
  });

  it("sends the email for the current address", async () => {
    state.leadOver = { applicant_email_generation: 1, email: "jordan@firm.com" };
    state.claimed = [
      row({ audience: "applicant", recipients: ["jordan@firm.com"], generation: 1 }),
    ];
    await dispatchStageEmails();
    expect(wire()).toEqual(["jordan@firm.com"]);
  });

  it("still raises every email under the old key while the ledger has no generation", async () => {
    // A halted migration queue must not stop the stage emails: before
    // 20261029170200 every row is generation 0 and the old key is the rule.
    state.settingsRow = OWNED;
    state.upsertErrors = [{ code: "PGRST204", message: "Could not find the 'generation' column" }];
    const result = await enqueueStageEmails({ leadId: "lead-1", lead: fresh(), trigger: "ingest" });
    expect(state.upsertTargets).toEqual([
      "lead_id,stage,audience,generation",
      "lead_id,stage,audience",
    ]);
    expect(state.upserts[1]?.every((r) => !("generation" in r))).toBe(true);
    expect(result.queued).toBe(2);
  });

  it("does not raise a corrected address's email under the old key, where it would collide", async () => {
    state.settingsRow = OWNED;
    state.upsertErrors = [{ code: "42P10", message: "no unique or exclusion constraint" }];
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: fresh({ applicant_email_generation: 1 }),
      trigger: "ingest",
    });
    expect(state.upserts[1]?.map((r) => r.audience)).toEqual(["internal"]);
  });
});

describe("the team alerts set on Email → Lead emails", () => {
  const CONSOLE_TEAM = ["admin@aurixasystems.com.au", "rugesh@aurixasystems.com.au"];
  const settings = (over: Record<string, unknown> = {}) => ({
    id: true,
    stage1_sender: "mission_control",
    stage2_sender: "mission_control",
    stage3_sender: "mission_control",
    tenant_id: null,
    from_mailbox: null,
    from_name: null,
    reply_to: null,
    internal_recipients: CONSOLE_TEAM,
    internal_stages: [1, 2, 3],
    updated_at: "2026-10-29T00:00:00.000Z",
    updated_by: null,
    ...over,
  });
  const internal = (stage: number) =>
    state.upserts.flat().find((r) => r.audience === "internal" && r.stage === stage);
  const fresh = (over: Record<string, unknown> = {}) => ({
    id: "lead-1",
    email: "applicant@firm.com.au",
    application_id: "AX-0000000001",
    created_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
    enrichment_synced_at: new Date().toISOString(),
    ...over,
  });

  it("raises the alert to the console's list, over the environment's", async () => {
    state.settingsRow = settings();
    await enqueueStageEmails({ leadId: "lead-1", lead: fresh(), trigger: "ingest" });
    expect(internal(1)?.recipients).toEqual(CONSOLE_TEAM);
    expect(internal(1)?.recipient_source).toBe("configured");
  });

  it("sends to the console's list, whatever the row was raised with", async () => {
    state.settingsRow = settings();
    state.claimed = [row({ recipients: ["hello@aurixasystems.com.au"] })];
    await dispatchStageEmails();
    expect(wire()).toEqual(CONSOLE_TEAM);
  });

  it("raises nothing for a stage the console switched off", async () => {
    state.settingsRow = settings({ internal_stages: [1, 3] });
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: fresh({ stage2_completed_at: new Date().toISOString() }),
      trigger: "ingest",
    });
    expect(internal(1)?.status).toBe("pending");
    expect(internal(2)?.status).toBe("skipped");
    expect(String(internal(2)?.reason)).toContain("switched off for stage 2");
  });

  it("leaves the environment's list in force until a list is saved", async () => {
    state.settingsRow = settings({ internal_recipients: null, internal_stages: null });
    await enqueueStageEmails({ leadId: "lead-1", lead: fresh(), trigger: "ingest" });
    expect(internal(1)?.recipients).toEqual(TEAM);
  });
});

describe("Mission Control sends the applicant's own email (Email → Lead emails)", () => {
  const SETTINGS = {
    id: true,
    stage1_sender: "mission_control",
    stage2_sender: "mission_control",
    stage3_sender: "make",
    tenant_id: null,
    from_mailbox: "trials@aurixasystems.com.au",
    from_name: "Aurixa Systems",
    reply_to: "admin@aurixasystems.com.au",
    updated_at: "2026-10-29T00:00:00.000Z",
    updated_by: null,
  };
  // A Stage 2 email is owed only once a questionnaire is in, and the send gate
  // asks the lead row at send time, as Make's filter did.
  const applicantRow = (stage: number) => {
    if (stage >= 2) state.leadOver = { stage2_completed_at: "2026-09-22T00:30:00.000Z" };
    return row({ audience: "applicant", stage, recipients: ["applicant@example.com"] });
  };
  const html = () =>
    String((state.sent[0]?.message.body as { content?: string } | undefined)?.content ?? "");

  it("sends Stage 1 with a questionnaire link it minted, keeping only the token's hash", async () => {
    state.settingsRow = SETTINGS;
    state.claimed = [applicantRow(1)];
    const result = await dispatchStageEmails();

    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(state.sent[0]?.mailbox).toBe("trials@aurixasystems.com.au");
    expect(state.sent[0]?.message.subject).toBe(
      "Application received — your Aurixa Systems free trial",
    );
    expect(state.links).toHaveLength(1);
    const stored = String(state.links[0]?.token_sha256);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);

    const link = /href="(https:\/\/[^"]+\/questionnaire\?[^"]+)"/.exec(html())?.[1];
    expect(link).toBeDefined();
    const url = new URL(link!.replace(/&amp;/g, "&"));
    expect(url.searchParams.get("ref")).toBe("AX-0000000001");
    const token = url.searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(30);
    // The email carries the token; the database never does.
    expect(stored).not.toBe(token);
    expect(JSON.stringify(state.links)).not.toContain(token);
  });

  it("sends as the identity chosen on the console", async () => {
    state.settingsRow = SETTINGS;
    state.claimed = [applicantRow(2)];
    await dispatchStageEmails();
    expect(state.sent[0]?.message.replyTo).toEqual([
      { emailAddress: { address: "admin@aurixasystems.com.au" } },
    ]);
    expect(state.sent[0]?.message.from).toEqual({
      emailAddress: { address: "trials@aurixasystems.com.au", name: "Aurixa Systems" },
    });
  });

  it("sends the team's notification from the chosen mailbox too, to the whole list", async () => {
    state.settingsRow = SETTINGS;
    state.claimed = [row()];
    await dispatchStageEmails();
    expect(state.sent[0]?.mailbox).toBe("trials@aurixasystems.com.au");
    expect(wire()).toEqual(TEAM);
  });

  it("tells the chosen mailbox, not the deployment's, when no recipient list is set", async () => {
    // "Only the sending mailbox was told" has to be true of the mailbox that
    // sent: on production the deployment's own mailbox is another company's.
    delete process.env.LEAD_STAGE_INTERNAL_RECIPIENTS;
    state.settingsRow = SETTINGS;
    state.claimed = [row({ recipients: [] })];
    const result = await dispatchStageEmails();
    expect(state.sent[0]?.mailbox).toBe("trials@aurixasystems.com.au");
    expect(wire()).toEqual(["trials@aurixasystems.com.au"]);
    expect(result.readiness).toMatchObject({ recipients: 1, recipientSource: "mailbox_fallback" });
  });

  it("raises the team's obligation against the chosen mailbox", async () => {
    delete process.env.LEAD_STAGE_INTERNAL_RECIPIENTS;
    state.settingsRow = SETTINGS;
    await enqueueStageEmails({
      leadId: "lead-1",
      lead: {
        id: "lead-1",
        email: "applicant@example.com",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        submitted_at: new Date(Date.now() - 60_000).toISOString(),
      },
      trigger: "ingest",
    });
    const internal = state.upserts.flat().find((r) => r.audience === "internal" && r.stage === 1);
    expect(internal).toMatchObject({
      mailbox: "trials@aurixasystems.com.au",
      recipients: ["trials@aurixasystems.com.au"],
      recipient_source: "mailbox_fallback",
    });
  });

  it("asks the send gate again at send time, as Make re-read the record", async () => {
    // Disqualified on the Leads page after the email was raised.
    state.settingsRow = SETTINGS;
    state.claimed = [applicantRow(1)];
    state.leadOver = { status: "disqualified" };
    await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(patch()).toMatchObject({
      status: "skipped",
      reason: "held by the send gate: Application declined",
    });
  });

  it("holds a confirmation for a booking cancelled before it went", async () => {
    state.settingsRow = SETTINGS;
    state.claimed = [applicantRow(3)];
    state.leadOver = {
      ...state.leadOver,
      stage3_booked_at: "2026-09-22T01:00:00.000Z",
      stage3_session_start: "2026-09-29T01:00:00.000Z",
      stage3_cancelled_at: "2026-09-22T01:00:30.000Z",
    };
    await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(patch()).toMatchObject({ reason: "held by the send gate: Booking cancelled" });
  });

  it("sends the copy an operator saved, not the default", async () => {
    state.settingsRow = SETTINGS;
    state.templateRows = [
      {
        stage: 2,
        subject: "Thanks {{first_name}}, we have your answers",
        content: {},
        updated_at: "2026-10-29T00:00:00.000Z",
        updated_by: null,
      },
    ];
    state.claimed = [applicantRow(2)];
    await dispatchStageEmails();
    expect(state.sent[0]?.message.subject).toBe("Thanks Ada, we have your answers");
  });

  it("holds the applicant's email a tick when the copy cannot be read", async () => {
    state.settingsRow = SETTINGS;
    state.templatesError = { message: "57014 statement timeout" };
    state.claimed = [applicantRow(2)];
    await dispatchStageEmails();
    expect(state.sent).toHaveLength(0);
    expect(patch()).toMatchObject({ status: "pending", claimed_at: null });
  });

  it("claims nothing when it cannot tell who sends", async () => {
    // Neither guess is safe: Make for a stage whose module is off writes a
    // terminal skip; Mission Control for one still on Make sends a duplicate.
    state.settingsError = { message: "57014 statement timeout" };
    state.claimed = [applicantRow(1)];
    const result = await dispatchStageEmails();
    expect(result.claimed).toBe(0);
    expect(state.sent).toHaveLength(0);
    expect(result.note).toContain("could not be read");
  });

  describe("raising the obligation", () => {
    const lead = (over: Record<string, unknown> = {}) => ({
      id: "lead-1",
      email: "applicant@example.com",
      application_id: "AX-0000000001",
      created_at: new Date(Date.now() - 60_000).toISOString(),
      submitted_at: new Date(Date.now() - 60_000).toISOString(),
      enrichment_synced_at: null,
      ...over,
    });
    const applicant = (stage: number) =>
      state.upserts.flat().find((r) => r.audience === "applicant" && r.stage === stage);

    it("raises a stage Mission Control owns at once — there is no Make to wait for", async () => {
      state.settingsRow = SETTINGS;
      await enqueueStageEmails({ leadId: "lead-1", lead: lead(), trigger: "ingest" });
      expect(applicant(1)?.status).toBe("pending");
    });

    it("still waits out the grace period for a stage left on Make", async () => {
      state.settingsRow = { ...SETTINGS, stage1_sender: "make" };
      await enqueueStageEmails({ leadId: "lead-1", lead: lead(), trigger: "ingest" });
      expect(applicant(1)).toBeUndefined();
    });

    it("decides nothing, for anyone, when the settings cannot be read", async () => {
      state.settingsError = { message: "57014 statement timeout" };
      await enqueueStageEmails({
        leadId: "lead-1",
        lead: lead({ stage2_completed_at: new Date().toISOString() }),
        trigger: "ingest",
      });
      expect(applicant(1)).toBeUndefined();
      expect(applicant(2)).toBeUndefined();
      // Who is on the team alert, and at which stages, is the console's answer
      // too: raised now, it would go to the environment's list at stages the
      // console may have switched off, and the ledger keeps the first raise.
      // The sweep raises it once the settings answer.
      expect(state.upserts.flat().some((r) => r.audience === "internal")).toBe(false);
    });

    it("does not invite an applicant to a questionnaire they have finished", async () => {
      state.settingsRow = SETTINGS;
      await enqueueStageEmails({
        leadId: "lead-1",
        lead: lead({ stage2_completed_at: new Date().toISOString() }),
        trigger: "ingest",
      });
      expect(applicant(1)?.status).toBe("skipped");
      expect(applicant(2)?.status).toBe("pending");
    });

    it("reads the settings once for the whole sweep", async () => {
      state.settingsRow = SETTINGS;
      const reads = { n: 0 };
      const original = state.settingsRow;
      Object.defineProperty(state, "settingsRow", {
        configurable: true,
        get: () => {
          reads.n += 1;
          return original;
        },
        set: () => {},
      });
      state.sweepWindows = {
        created_at: [lead({ id: "a" }), lead({ id: "b" }), lead({ id: "c" })],
      };
      await sweepMissingStageEmails();
      Object.defineProperty(state, "settingsRow", {
        configurable: true,
        writable: true,
        value: null,
      });
      expect(reads.n).toBe(1);
    });
  });
});
