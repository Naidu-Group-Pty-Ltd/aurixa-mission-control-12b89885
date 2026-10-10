/**
 * Binding a tenant's own calendar and mailbox connections into its Make
 * scenarios — by editing the blueprint Make holds, and nothing else in it.
 *
 * ## Why a blueprint edit at all
 *
 * A Make module calls its app through a connection named in the blueprint
 * (`parameters.__IMTCONN__`), not in data. So the one thing a CFG field cannot
 * do is move the calendar adapter from one Outlook account to another, or give
 * the notifier a Gmail mailbox: that is a scenario update. Everything ELSE a
 * tenant changes is a CFG field (`voiceAutomation.pure.ts`), and once a
 * connection is bound, switching between Outlook, Google and the internal
 * calendar is a CFG write too — which is why every authorised connection is
 * bound, whichever provider is currently selected.
 *
 * ## Why modules are found by WHAT they are, never by their id
 *
 * The generator in the clone repository assigns ids (6 and 11 on the adapter, 7
 * and 8 on the notifier), and a hand edit in the Make designer renumbers
 * freely. A module is identified by its `module` string — the app and
 * operation it calls — which is also exactly what decides which connection
 * type it can take. An adapter with no calendar module, or a notifier with no
 * Outlook mail module, is refused by name rather than "bound" to nothing: an
 * update that changed nothing would report success over a stack that was not
 * the shape this code was written for.
 *
 * ## The Gmail route
 *
 * The notifier's Gmail half exists only once Gmail is bound: a Gmail module
 * needs a Gmail connection to validate, and a tenant on Outlook has none. So
 * `ensureGmailRoutes` ADDS the two routes the first time and re-binds them after
 * that. The routes are the same two the clone repository's generator emits
 * when `NOTIFIER_GMAIL_CONN` is set (`make/gen_ci.py`), with the same ids, so a
 * stack regenerated from source and a stack edited from here converge.
 *
 * Pure. Every function returns a NEW blueprint; the input is never mutated.
 */

import { CONNECTION_KINDS, type ConnectionKind } from "./voiceAutomation.pure";

export type BlueprintModule = {
  id: number;
  module: string;
  version?: number;
  parameters?: Record<string, unknown> | null;
  mapper?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  filter?: unknown;
  onerror?: BlueprintModule[];
  routes?: { flow: BlueprintModule[] }[];
  [k: string]: unknown;
};

export type Blueprint = {
  name?: string;
  flow: BlueprintModule[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
};

export type BindingChange = {
  moduleId: number;
  module: string;
  from: number | null;
  to: number;
};

export type BindResult =
  | { ok: true; blueprint: Blueprint; changes: BindingChange[] }
  | { ok: false; error: string };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Visit every module, including those inside router routes and error handlers. */
export function walkModules(flow: BlueprintModule[], visit: (m: BlueprintModule) => void): void {
  for (const m of flow) {
    visit(m);
    for (const r of m.routes ?? []) walkModules(r.flow ?? [], visit);
    if (Array.isArray(m.onerror)) walkModules(m.onerror, visit);
  }
}

export function moduleIds(bp: Blueprint): number[] {
  const ids: number[] = [];
  walkModules(bp.flow, (m) => ids.push(m.id));
  return ids;
}

export function modulesCalling(bp: Blueprint, moduleName: string): BlueprintModule[] {
  const out: BlueprintModule[] = [];
  walkModules(bp.flow, (m) => {
    if (m.module === moduleName) out.push(m);
  });
  return out;
}

export function isBlueprint(v: unknown): v is Blueprint {
  return !!v && typeof v === "object" && Array.isArray((v as Blueprint).flow);
}

function currentConnection(m: BlueprintModule): number | null {
  const v = (m.parameters ?? {})["__IMTCONN__"];
  return typeof v === "number" ? v : null;
}

/**
 * Point every module that calls `kind`'s app at `connectionId`.
 * Refuses when the blueprint carries no such module.
 */
export function bindConnection(
  bp: Blueprint,
  kind: ConnectionKind,
  connectionId: number,
): BindResult {
  if (!Number.isInteger(connectionId) || connectionId <= 0)
    return { ok: false, error: "invalid_connection_id" };
  if (!isBlueprint(bp)) return { ok: false, error: "not_a_blueprint" };
  const next = clone(bp);
  const targets = modulesCalling(next, CONNECTION_KINDS[kind].module);
  if (targets.length === 0)
    return { ok: false, error: `no_module:${CONNECTION_KINDS[kind].module}` };
  const changes: BindingChange[] = [];
  for (const m of targets) {
    const from = currentConnection(m);
    if (from !== connectionId) {
      m.parameters = { ...(m.parameters ?? {}), __IMTCONN__: connectionId };
      changes.push({ moduleId: m.id, module: m.module, from, to: connectionId });
    }
  }
  return { ok: true, blueprint: next, changes };
}

/** The connection each kind is bound to now, as the blueprint says. */
export function boundConnections(bp: Blueprint): Partial<Record<ConnectionKind, number[]>> {
  const out: Partial<Record<ConnectionKind, number[]>> = {};
  for (const kind of Object.keys(CONNECTION_KINDS) as ConnectionKind[]) {
    const ids = modulesCalling(bp, CONNECTION_KINDS[kind].module)
      .map(currentConnection)
      .filter((v): v is number => v !== null);
    if (ids.length) out[kind] = Array.from(new Set(ids));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape checks — what the applier assumes before it touches anything.

export function assertAdapterShape(bp: unknown): string | null {
  if (!isBlueprint(bp)) return "adapter_not_a_blueprint";
  if (modulesCalling(bp, CONNECTION_KINDS.outlook_calendar.module).length === 0)
    return "adapter_missing_outlook_module";
  if (modulesCalling(bp, CONNECTION_KINDS.google_calendar.module).length === 0)
    return "adapter_missing_google_module";
  return null;
}

/** The router that fans the notifier out to its mail routes. */
function notifierRouter(bp: Blueprint): BlueprintModule | null {
  let found: BlueprintModule | null = null;
  walkModules(bp.flow, (m) => {
    if (found || m.module !== "builtin:BasicRouter") return;
    const carriesMail = (m.routes ?? []).some((r) =>
      (r.flow ?? []).some(
        (x) =>
          x.module === CONNECTION_KINDS.outlook_mail.module ||
          x.module === CONNECTION_KINDS.gmail.module,
      ),
    );
    if (carriesMail) found = m;
  });
  return found;
}

export function assertNotifierShape(bp: unknown): string | null {
  if (!isBlueprint(bp)) return "notifier_not_a_blueprint";
  if (modulesCalling(bp, CONNECTION_KINDS.outlook_mail.module).length === 0)
    return "notifier_missing_outlook_module";
  if (!notifierRouter(bp)) return "notifier_missing_router";
  return null;
}

// ---------------------------------------------------------------------------
// Gmail

export const GMAIL_ADMIN_MODULE_ID = 9;
export const GMAIL_CLIENT_MODULE_ID = 10;

const cond = (a: string, o: string, b: string) => ({ a, o, b });

function gmailRoute(
  id: number,
  who: "admin" | "client",
  connectionId: number,
  y: number,
): { flow: BlueprintModule[] } {
  const conditions = [
    cond("{{4.result.valid}}", "text:equal", "yes"),
    ...(who === "client" ? [cond("{{4.result.send_client}}", "text:equal", "yes")] : []),
    cond("{{2.email_provider}}", "text:equal", "google"),
  ];
  return {
    flow: [
      {
        id,
        module: CONNECTION_KINDS.gmail.module,
        version: CONNECTION_KINDS.gmail.appVersion,
        parameters: { __IMTCONN__: connectionId },
        mapper: {
          to: [`{{4.result.${who}_to}}`],
          subject: `{{4.result.${who}_subject}}`,
          bodyType: "rawHtml",
          content: `{{4.result.${who}_html}}`,
          attachments: [{ filename: "{{4.result.ics_name}}", data: "{{toBinary(4.result.ics)}}" }],
        },
        metadata: { designer: { x: 1500, y } },
        filter: { name: `${who} (gmail)`, conditions: [conditions] },
        onerror: [
          {
            id: id * 10 + 9,
            module: "builtin:Ignore",
            version: 1,
            parameters: {},
            mapper: {},
            metadata: { designer: { x: 1500, y: y + 200 } },
          },
        ],
      },
    ],
  };
}

/**
 * Bind Gmail into the notifier, adding its two routes if they are not there.
 * Refuses when the ids it would add are already taken by something else.
 */
export function ensureGmailRoutes(bp: Blueprint, connectionId: number): BindResult {
  if (!Number.isInteger(connectionId) || connectionId <= 0)
    return { ok: false, error: "invalid_connection_id" };
  const shape = assertNotifierShape(bp);
  if (shape) return { ok: false, error: shape };
  if (modulesCalling(bp, CONNECTION_KINDS.gmail.module).length > 0)
    return bindConnection(bp, "gmail", connectionId);

  const next = clone(bp);
  const router = notifierRouter(next)!;
  const taken = new Set(moduleIds(next));
  for (const id of [
    GMAIL_ADMIN_MODULE_ID,
    GMAIL_CLIENT_MODULE_ID,
    GMAIL_ADMIN_MODULE_ID * 10 + 9,
    GMAIL_CLIENT_MODULE_ID * 10 + 9,
  ]) {
    if (taken.has(id)) return { ok: false, error: `module_id_taken:${id}` };
  }
  router.routes = [
    ...(router.routes ?? []),
    gmailRoute(GMAIL_ADMIN_MODULE_ID, "admin", connectionId, 900),
    gmailRoute(GMAIL_CLIENT_MODULE_ID, "client", connectionId, 1200),
  ];
  return {
    ok: true,
    blueprint: next,
    changes: [
      {
        moduleId: GMAIL_ADMIN_MODULE_ID,
        module: CONNECTION_KINDS.gmail.module,
        from: null,
        to: connectionId,
      },
      {
        moduleId: GMAIL_CLIENT_MODULE_ID,
        module: CONNECTION_KINDS.gmail.module,
        from: null,
        to: connectionId,
      },
    ],
  };
}

/**
 * True when the notifier still sends through Outlook for `email_provider`
 * "none" — the filter the stack shipped with (`!= google`). An applier that
 * lets a tenant choose "no email" must refuse to apply that choice onto such a
 * notifier, because the choice would be recorded and ignored.
 */
export function notifierIgnoresNone(bp: Blueprint): boolean {
  let legacy = false;
  for (const m of modulesCalling(bp, CONNECTION_KINDS.outlook_mail.module)) {
    const f = m.filter as { conditions?: { a?: string; o?: string; b?: string }[][] } | undefined;
    const conds = (f?.conditions ?? []).flat();
    const gate = conds.find((c) => c.a === "{{2.email_provider}}");
    if (!gate || !(gate.o === "text:equal" && gate.b === "outlook")) legacy = true;
  }
  return legacy;
}
