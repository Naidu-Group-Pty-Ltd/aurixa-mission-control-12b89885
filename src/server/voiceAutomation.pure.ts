/**
 * The calendar and email settings of a CRM-independent clone's voice agents —
 * the one vocabulary every writer goes through.
 *
 * ## What this governs
 *
 * A clone on the CRM-independent line answers its phone with Vapi agents whose
 * tools are Make.com scenarios (availability, booking, reschedule/cancel, and
 * the booking email notifier). Those scenarios read ONE configuration record —
 * the `default` row of the stack's CFG data store — and two of them carry
 * connections baked into their blueprints: the calendar adapter (Outlook
 * calendar, Google Calendar) and the notifier (Outlook mail, Gmail). Everything
 * a tenant can sensibly decide about "which calendar, which mailbox, what hours,
 * who is told" is one of the fields below, and each one maps onto exactly one
 * CFG field or one connection binding.
 *
 * ## Three writers, one record
 *
 * The settings start life at PROVISIONING (an operator fills them in and applies
 * them before the clone is handed over), and change afterwards from TWO places:
 * the clone's own Settings page (a tenant administrator) and the operator card
 * in Mission Control. All three write the SAME row, through this module's
 * `validateSettings`, as a new REVISION — there is no second copy anywhere that
 * could disagree. A write names the revision it read (`expectedRevision`), so an
 * operator and a tenant editing at the same moment cannot silently overwrite
 * each other: the second write is refused with the current revision and has to
 * be re-made against it.
 *
 * ## What a tenant may not change
 *
 * An operator can LOCK fields. Before hand-off the test gate
 * (`email.testRedirectTo`) is locked by default, because clearing it starts
 * real customers receiving real mail and that is a go-live decision, not a
 * setting. A locked field is still SHOWN to the tenant, with the reason, and a
 * write that changes it is refused naming the field — never silently dropped,
 * because a save that half-applies reads as a save that worked.
 *
 * ## What is never managed here
 *
 * The CFG record also holds the stack's shared secret, its internal hook URLs
 * and the outbound launcher's assistant map. None of those is a tenant decision
 * and none of them is in `MANAGED_CFG_FIELDS`: `compileCfgPatch` cannot emit
 * them, and `projectManagedCfg` drops them the moment a live record is read,
 * because Make's record endpoints answer with the WHOLE record — secret
 * included — and nothing downstream of this boundary should ever hold it.
 *
 * Pure: no I/O, no environment. Tested beside it.
 */

export const VOICE_AUTOMATION_SCHEMA_VERSION = 1 as const;

export const CALENDAR_PROVIDERS = ["internal", "outlook", "google"] as const;
export type CalendarProvider = (typeof CALENDAR_PROVIDERS)[number];

export const EMAIL_PROVIDERS = ["outlook", "google", "none"] as const;
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export const SLOT_STEPS = [15, 20, 30, 45, 60] as const;

export type CalendarSettings = {
  /** Which calendar the agents read free time from and write bookings to. */
  provider: CalendarProvider;
  /** Microsoft Graph path of the calendar, e.g. `/v1.0/me/calendar`. */
  outlookCalendarBase: string;
  /** Google Calendar id: `primary` or a calendar address. */
  googleCalendarId: string;
  /** IANA time zone the business hours are in. */
  timezone: string;
  /** First hour a booking may start (0–23). */
  businessStartHour: number;
  /** Hour by which a booking must end (1–24), later than the start. */
  businessEndHour: number;
  slotStepMinutes: number;
  /** Padding kept free around every existing appointment. */
  bufferMinutes: number;
  /** How many times the agent offers in one answer. */
  maxSlots: number;
  /** How many business days ahead the agent looks. */
  searchDays: number;
};

export type EmailSettings = {
  /** Which mailbox sends the confirmations; `none` sends nothing. */
  provider: EmailProvider;
  /** Who in the business is told about every booking, cancellation and move. */
  adminEmail: string;
  /** The name the emails are signed with. */
  businessName: string;
  /** Whether the customer is emailed too (only when an address is known). */
  notifyClient: boolean;
  /** Joining link written into Zoom bookings; empty prints a placeholder. */
  zoomLink: string;
  /**
   * Test gate: when set, EVERY email (admin and customer) goes here instead,
   * subject-prefixed with the real recipient. Empty means live.
   */
  testRedirectTo: string;
};

export type VoiceAutomationSettings = {
  calendar: CalendarSettings;
  email: EmailSettings;
};

export const DEFAULT_VOICE_AUTOMATION_SETTINGS: VoiceAutomationSettings = Object.freeze({
  calendar: Object.freeze({
    provider: "internal",
    outlookCalendarBase: "/v1.0/me/calendar",
    googleCalendarId: "primary",
    timezone: "Australia/Sydney",
    businessStartHour: 9,
    businessEndHour: 17,
    slotStepMinutes: 30,
    bufferMinutes: 0,
    maxSlots: 6,
    searchDays: 5,
  }),
  email: Object.freeze({
    provider: "none",
    adminEmail: "",
    businessName: "",
    notifyClient: true,
    zoomLink: "",
    testRedirectTo: "",
  }),
}) as VoiceAutomationSettings;

/**
 * Every field a writer may name, as `group.key`, with the CFG field it compiles
 * to. The order is the order the clone's form and the operator card draw them.
 */
export const SETTING_FIELDS = [
  { path: "calendar.provider", cfg: "provider" },
  { path: "calendar.outlookCalendarBase", cfg: "outlook_calendar_base" },
  { path: "calendar.googleCalendarId", cfg: "google_calendar_id" },
  { path: "calendar.timezone", cfg: "timezone" },
  { path: "calendar.businessStartHour", cfg: "business_start_hour" },
  { path: "calendar.businessEndHour", cfg: "business_end_hour" },
  { path: "calendar.slotStepMinutes", cfg: "slot_step_minutes" },
  { path: "calendar.bufferMinutes", cfg: "buffer_minutes" },
  { path: "calendar.maxSlots", cfg: "max_slots" },
  { path: "calendar.searchDays", cfg: "search_days" },
  { path: "email.provider", cfg: "email_provider" },
  { path: "email.adminEmail", cfg: "admin_email" },
  { path: "email.businessName", cfg: "business_name" },
  { path: "email.notifyClient", cfg: "notify_client" },
  { path: "email.zoomLink", cfg: "zoom_link" },
  { path: "email.testRedirectTo", cfg: "email_redirect_to" },
] as const;

export type SettingPath = (typeof SETTING_FIELDS)[number]["path"];
export const SETTING_PATHS: readonly SettingPath[] = SETTING_FIELDS.map((f) => f.path);

/** The CFG fields this module may write. Nothing else in the record is ours. */
export const MANAGED_CFG_FIELDS: readonly string[] = SETTING_FIELDS.map((f) => f.cfg);

/**
 * CFG fields that exist and must never be written or returned by anything that
 * goes through this module. Named rather than merely absent, so a test can
 * assert they stay out of `MANAGED_CFG_FIELDS` if somebody extends the list.
 */
export const UNMANAGED_CFG_FIELDS = [
  "adapter_secret",
  "adapter_url",
  "notifier_url",
  "outbound_assistants",
  "vapi_phone_number_id",
  "admin_name",
] as const;

/** Locked until hand-off unless an operator says otherwise. */
export const DEFAULT_LOCKED_BEFORE_HANDOFF: readonly SettingPath[] = ["email.testRedirectTo"];

export type FieldError = { field: SettingPath | "settings"; message: string };
export type Validation =
  | { ok: true; settings: VoiceAutomationSettings }
  | { ok: false; errors: FieldError[] };

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const OUTLOOK_BASE_RE =
  /^\/v1\.0\/(me|users\/[A-Za-z0-9._%+@-]{1,254})(\/calendar|\/calendars\/[A-Za-z0-9=_-]{1,400})$/;
const GOOGLE_CAL_RE = /^(primary|[A-Za-z0-9._%+-]{1,200}@[A-Za-z0-9.-]{1,200})$/;
/**
 * Free text that reaches an email body. Angle brackets, braces and control
 * characters are refused: the value is interpolated by the notifier's code
 * into HTML, and `{{…}}` is Make's own formula syntax.
 */
const hasControlChar = (v: string) =>
  [...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
const SAFE_TEXT = (v: string) => !/[<>{}]/.test(v) && !hasControlChar(v);

export { hasControlChar };

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function isTimeZone(value: string): boolean {
  if (!value || value.length > 64 || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isZoomLink(value: string): boolean {
  if (value.length > 500 || /[\s"'<>{}]/.test(value)) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Judge a COMPLETE settings object. Every field is required and typed exactly;
 * nothing is coerced, because a coerced value is one the writer did not choose.
 * Returns every error at once so a form can mark all of them.
 */
export function validateSettings(input: unknown): Validation {
  const errors: FieldError[] = [];
  const err = (field: FieldError["field"], message: string) => errors.push({ field, message });

  if (!input || typeof input !== "object")
    return { ok: false, errors: [{ field: "settings", message: "Settings must be an object." }] };
  const root = input as Record<string, unknown>;
  const extraRoot = Object.keys(root).filter((k) => k !== "calendar" && k !== "email");
  if (extraRoot.length) err("settings", `Unknown setting group: ${extraRoot.join(", ")}.`);
  const cal = (root.calendar ?? {}) as Record<string, unknown>;
  const em = (root.email ?? {}) as Record<string, unknown>;
  if (typeof root.calendar !== "object" || root.calendar === null)
    err("settings", "The calendar group is missing.");
  if (typeof root.email !== "object" || root.email === null)
    err("settings", "The email group is missing.");

  for (const [group, obj] of [
    ["calendar", cal],
    ["email", em],
  ] as const) {
    for (const k of Object.keys(obj)) {
      if (!SETTING_PATHS.includes(`${group}.${k}` as SettingPath))
        err("settings", `Unknown setting: ${group}.${k}.`);
    }
  }

  if (!CALENDAR_PROVIDERS.includes(cal.provider as CalendarProvider))
    err("calendar.provider", "Choose Internal, Outlook or Google.");
  if (typeof cal.outlookCalendarBase !== "string" || !OUTLOOK_BASE_RE.test(cal.outlookCalendarBase))
    err(
      "calendar.outlookCalendarBase",
      "Use a Microsoft Graph calendar path such as /v1.0/me/calendar.",
    );
  if (typeof cal.googleCalendarId !== "string" || !GOOGLE_CAL_RE.test(cal.googleCalendarId))
    err(
      "calendar.googleCalendarId",
      "Use primary, or the calendar's id (it looks like an email address).",
    );
  if (typeof cal.timezone !== "string" || !isTimeZone(cal.timezone))
    err("calendar.timezone", "Use an IANA time zone such as Australia/Sydney.");
  if (!isInt(cal.businessStartHour) || cal.businessStartHour < 0 || cal.businessStartHour > 23)
    err("calendar.businessStartHour", "The first bookable hour is a whole hour from 0 to 23.");
  if (!isInt(cal.businessEndHour) || cal.businessEndHour < 1 || cal.businessEndHour > 24)
    err("calendar.businessEndHour", "The closing hour is a whole hour from 1 to 24.");
  else if (isInt(cal.businessStartHour) && cal.businessEndHour <= cal.businessStartHour)
    err("calendar.businessEndHour", "The closing hour must be later than the first bookable hour.");
  if (!SLOT_STEPS.includes(cal.slotStepMinutes as (typeof SLOT_STEPS)[number]))
    err("calendar.slotStepMinutes", `Slots start every ${SLOT_STEPS.join(", ")} minutes.`);
  if (!isInt(cal.bufferMinutes) || cal.bufferMinutes < 0 || cal.bufferMinutes > 120)
    err("calendar.bufferMinutes", "The buffer is 0 to 120 minutes.");
  if (!isInt(cal.maxSlots) || cal.maxSlots < 1 || cal.maxSlots > 12)
    err("calendar.maxSlots", "Offer between 1 and 12 times.");
  if (!isInt(cal.searchDays) || cal.searchDays < 1 || cal.searchDays > 10)
    err("calendar.searchDays", "Look 1 to 10 business days ahead.");

  if (!EMAIL_PROVIDERS.includes(em.provider as EmailProvider))
    err("email.provider", "Choose Outlook, Gmail or no email.");
  const sending = em.provider === "outlook" || em.provider === "google";
  if (typeof em.adminEmail !== "string" || (em.adminEmail !== "" && !isEmail(em.adminEmail)))
    err("email.adminEmail", "Enter one email address.");
  else if (sending && em.adminEmail === "")
    err("email.adminEmail", "Name who in the business is told about bookings.");
  if (
    typeof em.businessName !== "string" ||
    em.businessName.trim() !== em.businessName ||
    em.businessName.length > 120 ||
    !SAFE_TEXT(em.businessName)
  )
    err(
      "email.businessName",
      "Up to 120 characters, without < > { } or line breaks, and no leading or trailing spaces.",
    );
  else if (sending && em.businessName === "")
    err("email.businessName", "Name the business the emails are signed with.");
  if (typeof em.notifyClient !== "boolean")
    err("email.notifyClient", "Choose whether customers are emailed.");
  if (typeof em.zoomLink !== "string" || (em.zoomLink !== "" && !isZoomLink(em.zoomLink)))
    err("email.zoomLink", "Use an https:// joining link, or leave it empty.");
  if (
    typeof em.testRedirectTo !== "string" ||
    (em.testRedirectTo !== "" && !isEmail(em.testRedirectTo))
  )
    err("email.testRedirectTo", "Enter one email address, or leave it empty to send for real.");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      calendar: {
        provider: cal.provider as CalendarProvider,
        outlookCalendarBase: cal.outlookCalendarBase as string,
        googleCalendarId: cal.googleCalendarId as string,
        timezone: cal.timezone as string,
        businessStartHour: cal.businessStartHour as number,
        businessEndHour: cal.businessEndHour as number,
        slotStepMinutes: cal.slotStepMinutes as number,
        bufferMinutes: cal.bufferMinutes as number,
        maxSlots: cal.maxSlots as number,
        searchDays: cal.searchDays as number,
      },
      email: {
        provider: em.provider as EmailProvider,
        adminEmail: em.adminEmail as string,
        businessName: em.businessName as string,
        notifyClient: em.notifyClient as boolean,
        zoomLink: em.zoomLink as string,
        testRedirectTo: em.testRedirectTo as string,
      },
    },
  };
}

/** Read one field by path. */
export function readSetting(settings: VoiceAutomationSettings, path: SettingPath): unknown {
  const [group, key] = path.split(".") as ["calendar" | "email", string];
  return (settings[group] as Record<string, unknown>)[key];
}

/**
 * Overlay a PARTIAL write onto the current settings. A writer sends only what
 * it changed; the result is then judged whole by `validateSettings`, because a
 * field is only valid relative to the others (closing after opening, an admin
 * address once email is on).
 */
export function mergeSettingsPatch(
  current: VoiceAutomationSettings,
  patch: unknown,
): { ok: true; merged: unknown; touched: SettingPath[] } | { ok: false; errors: FieldError[] } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    return { ok: false, errors: [{ field: "settings", message: "A change must be an object." }] };
  const p = patch as Record<string, unknown>;
  const errors: FieldError[] = [];
  const merged: Record<string, Record<string, unknown>> = {
    calendar: { ...current.calendar },
    email: { ...current.email },
  };
  const touched: SettingPath[] = [];
  for (const [group, value] of Object.entries(p)) {
    if (group !== "calendar" && group !== "email") {
      errors.push({ field: "settings", message: `Unknown setting group: ${group}.` });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ field: "settings", message: `The ${group} group must be an object.` });
      continue;
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const path = `${group}.${key}` as SettingPath;
      if (!SETTING_PATHS.includes(path)) {
        errors.push({ field: "settings", message: `Unknown setting: ${path}.` });
        continue;
      }
      merged[group][key] = v;
      touched.push(path);
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, merged, touched };
}

export type SettingChange = { field: SettingPath; from: unknown; to: unknown };

/** The fields whose value differs, in form order. What a ledger row records. */
export function diffSettings(
  a: VoiceAutomationSettings,
  b: VoiceAutomationSettings,
): SettingChange[] {
  const out: SettingChange[] = [];
  for (const path of SETTING_PATHS) {
    const from = readSetting(a, path);
    const to = readSetting(b, path);
    if (from !== to) out.push({ field: path, from, to });
  }
  return out;
}

/** Of the fields a write CHANGES, the ones an operator has locked. */
export function lockedFieldViolations(
  changes: readonly SettingChange[],
  lockedFields: readonly string[],
): SettingPath[] {
  const locked = new Set(lockedFields);
  return changes.filter((c) => locked.has(c.field)).map((c) => c.field);
}

/** Keep only names this module knows; an unknown lock is a typo, not a lock. */
export function normaliseLockedFields(input: unknown): SettingPath[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(input.filter((f): f is SettingPath => SETTING_PATHS.includes(f as SettingPath))),
  );
}

export type CfgValue = string | number | boolean;

/** The CFG record values the scenarios read, for these settings. */
export function compileCfg(settings: VoiceAutomationSettings): Record<string, CfgValue> {
  const out: Record<string, CfgValue> = {};
  for (const f of SETTING_FIELDS) out[f.cfg] = readSetting(settings, f.path) as CfgValue;
  return out;
}

/**
 * Only the managed fields of a CFG record as Make returned it. Applied at the
 * boundary, the moment a record is read, so the secret the same response
 * carries never travels further than the function that received it.
 */
export function projectManagedCfg(record: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!record || typeof record !== "object") return out;
  for (const k of MANAGED_CFG_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, k))
      out[k] = (record as Record<string, unknown>)[k];
  }
  return out;
}

/** Make stores a boolean field as a boolean, but older rows hold "true"/"1". */
function sameCfgValue(want: CfgValue, have: unknown): boolean {
  if (typeof want === "boolean") {
    if (typeof have === "boolean") return have === want;
    const s = String(have ?? "")
      .trim()
      .toLowerCase();
    const truthy = s === "true" || s === "1" || s === "yes";
    return want === truthy;
  }
  if (typeof want === "number") return Number(have) === want && have !== "" && have !== null;
  return (have ?? "") === want;
}

/**
 * The partial update that brings the live record to these settings: only the
 * fields that differ. With no live reading (`null`) every managed field is sent.
 */
export function cfgPatchFor(
  settings: VoiceAutomationSettings,
  liveManaged: Record<string, unknown> | null,
): Record<string, CfgValue> {
  const want = compileCfg(settings);
  if (!liveManaged) return want;
  const out: Record<string, CfgValue> = {};
  for (const [k, v] of Object.entries(want)) if (!sameCfgValue(v, liveManaged[k])) out[k] = v;
  return out;
}

/** Managed fields whose live value differs from what was last applied. */
export function detectDrift(
  applied: VoiceAutomationSettings,
  liveManaged: Record<string, unknown>,
): { field: SettingPath; expected: CfgValue; live: unknown }[] {
  const want = compileCfg(applied);
  const out: { field: SettingPath; expected: CfgValue; live: unknown }[] = [];
  for (const f of SETTING_FIELDS) {
    if (!sameCfgValue(want[f.cfg], liveManaged[f.cfg]))
      out.push({ field: f.path, expected: want[f.cfg], live: liveManaged[f.cfg] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connections

/**
 * The four connections a stack can hold, each the Make app module a scenario
 * calls through. A connection is an OAuth grant to the TENANT's own account —
 * created by the tenant authorising a Make credential request — and Mission
 * Control only ever records its numeric id.
 */
export const CONNECTION_KINDS = {
  outlook_calendar: {
    label: "Outlook calendar",
    appName: "microsoft-calendar",
    appVersion: 2,
    appModules: ["makeApiCall"],
    module: "microsoft-calendar:makeApiCall",
    scenario: "adapter",
  },
  google_calendar: {
    label: "Google Calendar",
    appName: "google-calendar",
    appVersion: 5,
    appModules: ["makeApiCall"],
    module: "google-calendar:makeApiCall",
    scenario: "adapter",
  },
  outlook_mail: {
    label: "Outlook mailbox",
    appName: "microsoft-email",
    appVersion: 2,
    appModules: ["createAndSendAMessage"],
    module: "microsoft-email:createAndSendAMessage",
    scenario: "notifier",
  },
  gmail: {
    label: "Gmail mailbox",
    appName: "google-email",
    appVersion: 4,
    appModules: ["sendAnEmail"],
    module: "google-email:sendAnEmail",
    scenario: "notifier",
  },
} as const;

export type ConnectionKind = keyof typeof CONNECTION_KINDS;
export const CONNECTION_KIND_VALUES = Object.keys(CONNECTION_KINDS) as ConnectionKind[];

export function isConnectionKind(v: unknown): v is ConnectionKind {
  return typeof v === "string" && (CONNECTION_KIND_VALUES as string[]).includes(v);
}

/** The connections the chosen providers cannot work without. */
export function requiredConnections(settings: VoiceAutomationSettings): ConnectionKind[] {
  const out: ConnectionKind[] = [];
  if (settings.calendar.provider === "outlook") out.push("outlook_calendar");
  if (settings.calendar.provider === "google") out.push("google_calendar");
  if (settings.email.provider === "outlook") out.push("outlook_mail");
  if (settings.email.provider === "google") out.push("gmail");
  return out;
}

/**
 * The name a connection is created under. Carries the clone and a nonce so a
 * connection can be found by name in the team even when Make's credential
 * request does not report its numeric id, and so two clones' grants can never
 * be confused for one another.
 */
export function connectionNameFor(cloneSlug: string, kind: ConnectionKind, nonce: string): string {
  const slug =
    cloneSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "clone";
  return `aurixa-${slug}-${kind.replace(/_/g, "-")}-${nonce
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 10)
    .toLowerCase()}`;
}

/** Make credential states, narrowed to what this programme acts on. */
export type CredentialState =
  | "pending"
  | "authorized"
  | "declined"
  | "invalid"
  | "incomplete"
  | "reauthorizing";

/** A numeric connection id from a credential's `remoteId`, or null. */
export function connectionIdFromRemoteId(remoteId: unknown): number | null {
  if (typeof remoteId === "number" && Number.isInteger(remoteId) && remoteId > 0) return remoteId;
  if (typeof remoteId === "string" && /^[1-9][0-9]{0,15}$/.test(remoteId)) return Number(remoteId);
  return null;
}

// ---------------------------------------------------------------------------
// Make zones

export const MAKE_ZONES = ["eu1", "eu2", "us1", "us2"] as const;
export type MakeZone = (typeof MAKE_ZONES)[number];

export function isMakeZone(v: unknown): v is MakeZone {
  return typeof v === "string" && (MAKE_ZONES as readonly string[]).includes(v);
}

export function makeApiBase(zone: MakeZone): string {
  return `https://${zone}.make.com/api/v2`;
}

/** The address a person opens to authorise a request, if it is one of Make's. */
export function isMakeAuthorisationUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      (u.hostname === "make.com" ||
        u.hostname.endsWith(".make.com") ||
        u.hostname.endsWith(".make.celonis.com"))
    );
  } catch {
    return false;
  }
}
