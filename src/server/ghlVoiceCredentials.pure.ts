/**
 * The tenant's GoHighLevel credentials for a CRM-dependent voice stack — the
 * rules, with no I/O.
 *
 * ## Why they are always required
 *
 * A dependent clone's agents look up, create and book the tenant's contacts
 * in the tenant's OWN GoHighLevel location. A stack built without that
 * location's key either fails on its first call or, if anything of the head's
 * survived the copy, writes into the head's location. So the owner's rule
 * (11 Oct 2026) is absolute: no dependent stack is built until the tenant's
 * API key and location are held AND verified (`judgeStackProvision`).
 *
 * ## What the key is used for
 *
 * 1. **Verification.** One read of the location the operator named, with the
 *    key. GoHighLevel answers the location only to a key that may read it, so
 *    a key for a different location — or a different agency — is refused
 *    before anything is built.
 * 2. **The stack's CFG record.** Scenarios that call GoHighLevel over HTTP read
 *    the key from the stack's own CFG at run time (a private-integration
 *    token, the way the head's booking router was designed to). It is never
 *    written into a blueprint (`voiceStackMake.pure.ts`).
 * 3. **The OAuth grant's check.** Make's GoHighLevel modules authenticate with
 *    a Location OAuth grant rather than a key (`highlevel3`; the key-based
 *    connection type is deprecated). The tenant authorises it once, and the
 *    grant is accepted only where Make reports the SAME location the key
 *    reads — never a grant for another location, which would put one tenant's
 *    contacts in another's CRM.
 *
 * Pure: tested beside it.
 */

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
/** The API version header GoHighLevel's v2 API requires on location reads. */
export const GHL_API_VERSION = "2021-07-28";

export type GhlInput = { apiKey: string; locationId: string };

export function validateGhlInput(
  input: unknown,
): { ok: true; value: GhlInput } | { ok: false; errors: string[] } {
  const i = (input ?? {}) as Record<string, unknown>;
  const apiKey = typeof i.apiKey === "string" ? i.apiKey.trim() : "";
  const locationId = typeof i.locationId === "string" ? i.locationId.trim() : "";
  const errors: string[] = [];
  // A private-integration token reads `pit-<uuid>`; a legacy location key is
  // a JWT. Either is accepted here; GoHighLevel decides whether it works.
  if (
    !/^pit-[0-9a-f-]{20,}$/i.test(apiKey) &&
    !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(apiKey)
  )
    errors.push(
      "The API key is neither a private-integration token (pit-…) nor a location API key.",
    );
  if (!/^[A-Za-z0-9]{10,40}$/.test(locationId))
    errors.push(
      "The location id is the 10–40 character id GoHighLevel shows under Settings → Business Profile.",
    );
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { apiKey, locationId } };
}

export function ghlLocationRequest(locationId: string): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: `${GHL_API_BASE}/locations/${encodeURIComponent(locationId)}`,
    headers: { Version: GHL_API_VERSION, Accept: "application/json" },
  };
}

export type GhlVerification =
  | { ok: true; locationName: string }
  | {
      ok: false;
      reason: "key_refused" | "location_not_found" | "wrong_location" | "unavailable";
      message: string;
    };

/** Read GoHighLevel's answer to the location read. */
export function judgeGhlVerification(
  status: number,
  body: unknown,
  locationId: string,
): GhlVerification {
  const loc = (body as { location?: { id?: unknown; name?: unknown } } | null)?.location;
  if (status === 200) {
    if (!loc || typeof loc.id !== "string")
      return {
        ok: false,
        reason: "unavailable",
        message: "GoHighLevel answered without a location.",
      };
    if (loc.id !== locationId)
      return {
        ok: false,
        reason: "wrong_location",
        message: "GoHighLevel answered with a different location than the one named.",
      };
    const name = typeof loc.name === "string" && loc.name.trim() ? loc.name.trim() : locationId;
    return { ok: true, locationName: name.slice(0, 200) };
  }
  if (status === 401 || status === 403)
    return {
      ok: false,
      reason: "key_refused",
      message:
        "GoHighLevel refused the key for this location. Use a private-integration token created IN this location.",
    };
  if (status === 400 || status === 404 || status === 422)
    return {
      ok: false,
      reason: "location_not_found",
      message: "GoHighLevel has no location with that id for this key.",
    };
  return {
    ok: false,
    reason: "unavailable",
    message: `GoHighLevel could not be reached (HTTP ${status}). Try again.`,
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether an authorised Make GoHighLevel connection is for the location the
 * key reads. Make labels a Location OAuth connection `Location: <name>`.
 * Absent a label nothing is assumed: the grant is not accepted.
 */
export function grantMatchesLocation(
  connectionLabel: string | null,
  verifiedLocationName: string | null,
): boolean {
  if (!connectionLabel || !verifiedLocationName) return false;
  const m = /^location:\s*(.+)$/i.exec(connectionLabel.trim());
  const name = m ? m[1] : connectionLabel;
  return norm(name) === norm(verifiedLocationName);
}

/** The CFG fields a dependent stack's scenarios read the credentials from. */
export function ghlCfgFields(
  fields: { apiKey: string; locationId: string } | null,
  creds: GhlInput,
): Record<string, string> | null {
  if (!fields) return null;
  return { [fields.apiKey]: creds.apiKey, [fields.locationId]: creds.locationId };
}
