/**
 * Read a project's PROJECT-level settings through the Management API, for the
 * parity section that judges them (`projectSettingsParity.pure.ts`).
 *
 * These are the settings catalog introspection cannot see: they are not in
 * the database, so no `select` reaches them and no migration repairs them.
 * That is precisely why parity was blind to the class.
 *
 * Every failure is CAUGHT and returned as `unavailable` rather than thrown.
 * A parity run must not fail because a settings read did — the twenty
 * database sections are still worth having — but it must not report the
 * settings as matching either, which is what an uncaught null would become.
 */
import {
  type ProjectSettingsSnapshot,
  type SettingReading,
} from "./projectSettingsParity.pure";

const MGMT_API = "https://api.supabase.com/v1";

function headers(): Record<string, string> {
  const token = process.env.SUPABASE_ACCESS_TOKEN ?? "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function readOne<T>(
  url: string,
  pick: (body: unknown) => T | null,
): Promise<SettingReading<T>> {
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) {
      // The body is the Management API's own message. Truncated because it
      // reaches an operator's screen, never a log nobody reads.
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { state: "unavailable", error: `${res.status}${detail ? ` — ${detail}` : ""}` };
    }
    return { state: "read", value: pick(await res.json()) };
  } catch (err) {
    return { state: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function readProjectSettings(projectRef: string): Promise<ProjectSettingsSnapshot> {
  const [exposedSchemas, uploadLimitBytes] = await Promise.all([
    readOne<string>(`${MGMT_API}/projects/${projectRef}/postgrest`, (body) => {
      const v = (body as { db_schema?: unknown })?.db_schema;
      return typeof v === "string" ? v : null;
    }),
    readOne<number>(`${MGMT_API}/projects/${projectRef}/config/storage`, (body) => {
      const v = (body as { fileSizeLimit?: unknown })?.fileSizeLimit;
      return typeof v === "number" ? v : null;
    }),
  ]);
  return { exposedSchemas, uploadLimitBytes };
}

/**
 * No access token configured is a distinct answer from a failed call, and it
 * is the commonest one in a local or test environment. Named so the summary
 * says "not judged: no Management API token" rather than a bare 401.
 */
export function managementApiUnavailable(): ProjectSettingsSnapshot | null {
  if ((process.env.SUPABASE_ACCESS_TOKEN ?? "").trim().length > 0) return null;
  const reason: SettingReading<never> = {
    state: "unavailable",
    error: "no Management API token is configured for Mission Control",
  };
  return { exposedSchemas: reason, uploadLimitBytes: reason };
}
