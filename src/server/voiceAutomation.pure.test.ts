import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONNECTION_KINDS,
  DEFAULT_LOCKED_BEFORE_HANDOFF,
  DEFAULT_VOICE_AUTOMATION_SETTINGS,
  MANAGED_CFG_FIELDS,
  SETTING_PATHS,
  UNMANAGED_CFG_FIELDS,
  cfgPatchFor,
  compileCfg,
  connectionIdFromRemoteId,
  connectionNameFor,
  detectDrift,
  diffSettings,
  isMakeAuthorisationUrl,
  lockedFieldViolations,
  mergeSettingsPatch,
  normaliseLockedFields,
  projectManagedCfg,
  requiredConnections,
  validateSettings,
  type VoiceAutomationSettings,
} from "./voiceAutomation.pure";
import {
  assertAdapterShape,
  assertNotifierShape,
  bindConnection,
  boundConnections,
  ensureGmailRoutes,
  moduleIds,
  modulesCalling,
  notifierIgnoresNone,
  type Blueprint,
} from "./voiceAutomationBlueprint.pure";
import { planApply, usableConnection, type ConnectionReading } from "./voiceAutomationPlan.pure";

/*
 * The fixtures are the two blueprints the NPC CRM-independent stack runs, copied
 * verbatim from the clone repository's `voice-agents/crm-independent/make/`
 * (`bp_adapter.json`, `bp_notifier.json`). They carry no secret: the stack's
 * shared secret lives in its CFG record, which a blueprint only references.
 */
const load = (name: string): Blueprint =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/voice-automation/${name}.blueprint.json`, import.meta.url),
      "utf8",
    ),
  );
const adapter = () => load("adapter");
const notifier = () => load("notifier");

/** The settings the NPC stack runs with today. */
const npc: VoiceAutomationSettings = {
  calendar: {
    provider: "internal",
    outlookCalendarBase: "/v1.0/me/calendar",
    googleCalendarId: "primary",
    timezone: "Australia/Sydney",
    businessStartHour: 13,
    businessEndHour: 18,
    slotStepMinutes: 30,
    bufferMinutes: 0,
    maxSlots: 6,
    searchDays: 5,
  },
  email: {
    provider: "outlook",
    adminEmail: "property@npcservices.com.au",
    businessName: "NPC Services",
    notifyClient: true,
    zoomLink: "",
    testRedirectTo: "property@npcservices.com.au",
  },
};

const conn = (
  kind: ConnectionReading["kind"],
  id: number | null,
  state = "authorized",
): ConnectionReading => ({
  kind,
  state,
  makeConnectionId: id,
});

describe("validateSettings", () => {
  it("accepts the live NPC settings", () => {
    expect(validateSettings(npc)).toEqual({ ok: true, settings: npc });
  });

  it("accepts the defaults (internal calendar, no email)", () => {
    expect(validateSettings(DEFAULT_VOICE_AUTOMATION_SETTINGS).ok).toBe(true);
  });

  it("never coerces — a string hour is an error, not a number", () => {
    const r = validateSettings({ ...npc, calendar: { ...npc.calendar, businessStartHour: "13" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain("calendar.businessStartHour");
  });

  it("requires closing after opening", () => {
    const r = validateSettings({
      ...npc,
      calendar: { ...npc.calendar, businessStartHour: 17, businessEndHour: 9 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].field).toBe("calendar.businessEndHour");
  });

  it("requires an admin address and a business name only while email is on", () => {
    const off = {
      ...npc,
      email: { ...npc.email, provider: "none", adminEmail: "", businessName: "" },
    };
    expect(validateSettings(off).ok).toBe(true);
    const on = { ...off, email: { ...off.email, provider: "outlook" } };
    const r = validateSettings(on);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.map((e) => e.field).sort()).toEqual([
        "email.adminEmail",
        "email.businessName",
      ]);
  });

  it("refuses Make formula syntax and markup in text that reaches an email", () => {
    for (const businessName of ["{{2.adapter_secret}}", "<b>NPC</b>", "NPC\nServices", " NPC"]) {
      const r = validateSettings({ ...npc, email: { ...npc.email, businessName } });
      expect(r.ok, businessName).toBe(false);
    }
  });

  it("refuses an unknown time zone, a non-https zoom link and a bad graph path", () => {
    expect(
      validateSettings({ ...npc, calendar: { ...npc.calendar, timezone: "Mars/Olympus" } }).ok,
    ).toBe(false);
    expect(
      validateSettings({ ...npc, email: { ...npc.email, zoomLink: "http://zoom.us/j/1" } }).ok,
    ).toBe(false);
    expect(
      validateSettings({
        ...npc,
        calendar: { ...npc.calendar, outlookCalendarBase: "/v1.0/me/../users" },
      }).ok,
    ).toBe(false);
    expect(
      validateSettings({
        ...npc,
        calendar: {
          ...npc.calendar,
          outlookCalendarBase: "https://graph.microsoft.com/v1.0/me/calendar",
        },
      }).ok,
    ).toBe(false);
    expect(
      validateSettings({
        ...npc,
        calendar: {
          ...npc.calendar,
          outlookCalendarBase: "/v1.0/users/bookings@npc.com.au/calendars/AAMkAD=",
        },
      }).ok,
    ).toBe(true);
  });

  it("refuses unknown fields rather than ignoring them", () => {
    const r = validateSettings({ ...npc, email: { ...npc.email, adapterSecret: "x" } });
    expect(r.ok).toBe(false);
  });
});

describe("mergeSettingsPatch", () => {
  it("overlays only what the writer sent and reports what it touched", () => {
    const r = mergeSettingsPatch(npc, { calendar: { businessStartHour: 9 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.touched).toEqual(["calendar.businessStartHour"]);
      const v = validateSettings(r.merged);
      expect(v.ok && v.settings.calendar.businessStartHour).toBe(9);
      expect(v.ok && v.settings.email).toEqual(npc.email);
    }
  });

  it("refuses an unknown path by name", () => {
    const r = mergeSettingsPatch(npc, { email: { adapter_secret: "x" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain("email.adapter_secret");
  });
});

describe("locks", () => {
  it("locks the test gate before hand-off by default", () => {
    expect(DEFAULT_LOCKED_BEFORE_HANDOFF).toEqual(["email.testRedirectTo"]);
  });

  it("names a locked field a write changes, and ignores one it leaves alone", () => {
    const next = { ...npc, email: { ...npc.email, testRedirectTo: "" } };
    expect(lockedFieldViolations(diffSettings(npc, next), ["email.testRedirectTo"])).toEqual([
      "email.testRedirectTo",
    ]);
    const other = { ...npc, calendar: { ...npc.calendar, maxSlots: 4 } };
    expect(lockedFieldViolations(diffSettings(npc, other), ["email.testRedirectTo"])).toEqual([]);
  });

  it("drops lock names it does not know", () => {
    expect(
      normaliseLockedFields(["email.testRedirectTo", "email.nope", 3, "email.testRedirectTo"]),
    ).toEqual(["email.testRedirectTo"]);
  });
});

describe("CFG compilation", () => {
  it("writes exactly the managed fields, and never a secret, URL or launcher field", () => {
    const cfg = compileCfg(npc);
    expect(Object.keys(cfg).sort()).toEqual([...MANAGED_CFG_FIELDS].sort());
    for (const f of UNMANAGED_CFG_FIELDS) {
      expect(MANAGED_CFG_FIELDS).not.toContain(f);
      expect(cfg).not.toHaveProperty(f);
    }
    expect(SETTING_PATHS.length).toBe(MANAGED_CFG_FIELDS.length);
  });

  it("matches the field names the stack's scenarios read (make/config_spec.json)", () => {
    expect(compileCfg(npc)).toMatchObject({
      provider: "internal",
      outlook_calendar_base: "/v1.0/me/calendar",
      google_calendar_id: "primary",
      timezone: "Australia/Sydney",
      business_start_hour: 13,
      business_end_hour: 18,
      slot_step_minutes: 30,
      buffer_minutes: 0,
      max_slots: 6,
      search_days: 5,
      email_provider: "outlook",
      admin_email: "property@npcservices.com.au",
      business_name: "NPC Services",
      notify_client: true,
      zoom_link: "",
      email_redirect_to: "property@npcservices.com.au",
    });
  });

  it("projects a live record down to the managed fields — the secret never survives the read", () => {
    const live = {
      ...compileCfg(npc),
      adapter_secret: "s3cret",
      adapter_url: "https://hook",
      outbound_assistants: "{}",
    };
    const projected = projectManagedCfg(live);
    expect(projected).not.toHaveProperty("adapter_secret");
    expect(JSON.stringify(projected)).not.toContain("s3cret");
  });

  it("patches only what differs, reading legacy boolean spellings as equal", () => {
    const live = { ...compileCfg(npc), notify_client: "true", max_slots: 6 };
    expect(cfgPatchFor(npc, live)).toEqual({});
    expect(cfgPatchFor({ ...npc, calendar: { ...npc.calendar, maxSlots: 3 } }, live)).toEqual({
      max_slots: 3,
    });
    expect(Object.keys(cfgPatchFor(npc, null)).length).toBe(MANAGED_CFG_FIELDS.length);
  });

  it("reads an empty numeric field as drift, not as zero", () => {
    const live = { ...compileCfg(npc), buffer_minutes: "" };
    expect(detectDrift(npc, live).map((d) => d.field)).toEqual(["calendar.bufferMinutes"]);
  });
});

describe("connections", () => {
  it("requires exactly the connections the chosen providers call", () => {
    expect(requiredConnections(npc)).toEqual(["outlook_mail"]);
    expect(
      requiredConnections({
        ...npc,
        calendar: { ...npc.calendar, provider: "google" },
        email: { ...npc.email, provider: "google" },
      }),
    ).toEqual(["google_calendar", "gmail"]);
    expect(requiredConnections(DEFAULT_VOICE_AUTOMATION_SETTINGS)).toEqual([]);
  });

  it("names a connection after its clone, kind and a nonce", () => {
    expect(connectionNameFor("NPC CRM Independent!", "outlook_calendar", "AbC-123def45")).toBe(
      "aurixa-npc-crm-independent-outlook-calendar-abc123def4",
    );
  });

  it("reads a numeric remote id and nothing else", () => {
    expect(connectionIdFromRemoteId(12345)).toBe(12345);
    expect(connectionIdFromRemoteId("12345")).toBe(12345);
    expect(connectionIdFromRemoteId("abc")).toBeNull();
    expect(connectionIdFromRemoteId(null)).toBeNull();
    expect(connectionIdFromRemoteId(-1)).toBeNull();
  });

  it("hands out only Make's own authorisation links", () => {
    expect(isMakeAuthorisationUrl("https://us2.make.com/credentials-requests/public/abc")).toBe(
      true,
    );
    expect(isMakeAuthorisationUrl("https://make.com.evil.example/x")).toBe(false);
    expect(isMakeAuthorisationUrl("http://us2.make.com/x")).toBe(false);
  });
});

describe("blueprint binding", () => {
  it("the fixtures are the shape the applier expects", () => {
    expect(assertAdapterShape(adapter())).toBeNull();
    expect(assertNotifierShape(notifier())).toBeNull();
  });

  it("binds the Outlook calendar into the adapter's Outlook module only", () => {
    const before = adapter();
    const r = bindConnection(before, "outlook_calendar", 555);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changes).toEqual([
      { moduleId: 6, module: "microsoft-calendar:makeApiCall", from: 10496840, to: 555 },
    ]);
    expect(boundConnections(r.blueprint).outlook_calendar).toEqual([555]);
    expect(boundConnections(r.blueprint).google_calendar).toEqual(
      boundConnections(before).google_calendar,
    );
    // Nothing but that one parameter moved.
    const strip = (bp: Blueprint) => JSON.stringify(bp).replace(/"__IMTCONN__":\d+/g, "");
    expect(strip(r.blueprint)).toBe(strip(before));
    // The input was not mutated.
    expect(boundConnections(before).outlook_calendar).toEqual([10496840]);
  });

  it("is idempotent — rebinding the same id reports no change", () => {
    const first = bindConnection(adapter(), "google_calendar", 777);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = bindConnection(first.blueprint, "google_calendar", 777);
    expect(again.ok && again.changes).toEqual([]);
  });

  it("binds both Outlook mail modules in the notifier", () => {
    const r = bindConnection(notifier(), "outlook_mail", 888);
    expect(r.ok && r.changes.map((c) => c.moduleId)).toEqual([7, 8]);
  });

  it("refuses to bind a kind the blueprint does not call", () => {
    expect(bindConnection(notifier(), "outlook_calendar", 1)).toEqual({
      ok: false,
      error: "no_module:microsoft-calendar:makeApiCall",
    });
  });

  it("adds the Gmail routes once, then rebinds them", () => {
    const r = ensureGmailRoutes(notifier(), 999);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const gm = modulesCalling(r.blueprint, CONNECTION_KINDS.gmail.module);
    expect(gm.map((m) => m.id)).toEqual([9, 10]);
    expect(gm.every((m) => (m.parameters as { __IMTCONN__: number }).__IMTCONN__ === 999)).toBe(
      true,
    );
    // Unique ids across the whole blueprint.
    const ids = moduleIds(r.blueprint);
    expect(new Set(ids).size).toBe(ids.length);
    // Gmail only sends when email_provider is google; the client route also needs send_client.
    const filters = gm.map((m) => JSON.stringify(m.filter));
    expect(filters.every((f) => f.includes('"b":"google"'))).toBe(true);
    expect(filters[1]).toContain("send_client");
    const again = ensureGmailRoutes(r.blueprint, 1000);
    expect(again.ok && modulesCalling(again.blueprint, CONNECTION_KINDS.gmail.module).length).toBe(
      2,
    );
    expect(again.ok && again.changes.map((c) => c.to)).toEqual([1000, 1000]);
  });

  it("knows a notifier that still sends for 'none'", () => {
    expect(notifierIgnoresNone(notifier())).toBe(false);
    const legacy = JSON.parse(
      JSON.stringify(notifier()).replace(
        /"o":"text:equal","b":"outlook"/g,
        '"o":"text:notequal","b":"google"',
      ),
    );
    expect(notifierIgnoresNone(legacy)).toBe(true);
  });
});

describe("planApply", () => {
  const base = { adapter: adapter(), notifier: notifier() };

  it("blocks — writing nothing — when the chosen calendar is not connected", () => {
    const settings = { ...npc, calendar: { ...npc.calendar, provider: "outlook" as const } };
    const p = planApply({
      ...base,
      settings,
      connections: [conn("outlook_mail", 10496840)],
      liveManagedCfg: compileCfg(npc),
    });
    expect(p.status).toBe("blocked");
    if (p.status === "blocked")
      expect(p.blocks).toEqual([
        expect.objectContaining({ reason: "connection_required", kind: "outlook_calendar" }),
      ]);
  });

  it("a pending connection is not a connection", () => {
    expect(usableConnection([conn("gmail", 5, "pending")], "gmail")).toBeNull();
    expect(usableConnection([conn("gmail", null, "authorized")], "gmail")).toBeNull();
  });

  it("binds first and patches CFG with only the changed fields", () => {
    const settings = {
      ...npc,
      calendar: { ...npc.calendar, provider: "outlook" as const, businessStartHour: 9 },
    };
    const p = planApply({
      ...base,
      settings,
      connections: [conn("outlook_mail", 10496840), conn("outlook_calendar", 4242)],
      liveManagedCfg: compileCfg(npc),
    });
    expect(p.status).toBe("ready");
    if (p.status !== "ready") return;
    expect(p.adapter?.changes).toEqual([
      { moduleId: 6, module: "microsoft-calendar:makeApiCall", from: 10496840, to: 4242 },
    ]);
    expect(p.notifier).toBeNull();
    expect(p.cfgPatch).toEqual({ provider: "outlook", business_start_hour: 9 });
    expect(p.noop).toBe(false);
  });

  it("binds an authorised connection even while another provider is selected", () => {
    const p = planApply({
      ...base,
      settings: npc,
      connections: [conn("outlook_mail", 10496840), conn("google_calendar", 31)],
      liveManagedCfg: compileCfg(npc),
    });
    expect(p.status === "ready" && p.adapter?.changes.map((c) => c.to)).toEqual([31]);
  });

  it("is a no-op when the live stack already matches", () => {
    const p = planApply({
      ...base,
      settings: npc,
      connections: [conn("outlook_mail", 10496840)],
      liveManagedCfg: compileCfg(npc),
    });
    expect(p.status === "ready" && p.noop).toBe(true);
  });

  it("refuses 'no email' on a notifier that would ignore it", () => {
    const legacy = JSON.parse(
      JSON.stringify(notifier()).replace(
        /"o":"text:equal","b":"outlook"/g,
        '"o":"text:notequal","b":"google"',
      ),
    );
    const settings = { ...npc, email: { ...npc.email, provider: "none" as const } };
    const p = planApply({
      adapter: adapter(),
      notifier: legacy,
      settings,
      connections: [],
      liveManagedCfg: null,
    });
    expect(p.status === "blocked" && p.blocks[0].reason).toBe("notifier_cannot_disable");
  });

  it("adds Gmail and selects it in one apply", () => {
    const settings = { ...npc, email: { ...npc.email, provider: "google" as const } };
    const p = planApply({
      ...base,
      settings,
      connections: [conn("gmail", 77)],
      liveManagedCfg: compileCfg(npc),
    });
    expect(p.status).toBe("ready");
    if (p.status !== "ready") return;
    expect(p.notifier?.changes.map((c) => c.moduleId)).toEqual([9, 10]);
    expect(p.cfgPatch).toEqual({ email_provider: "google" });
  });
});
