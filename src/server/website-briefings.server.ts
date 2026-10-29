/**
 * Website videos — the Briefing Room listings on the Aurixa Systems website
 * (docs/WEBSITE_VIDEOS.md). The rules are in `websiteBriefings.pure.ts`; this
 * is the reading and writing.
 *
 * Three things happen here that happen nowhere else:
 *
 *   • Upload grants. The video lives in the website's own Supabase project,
 *     which Mission Control holds no key to. A grant is a single-use token for
 *     one listing's next version folder and the files it will hold; the
 *     website's `briefing-upload-sign` function asks `verifyUploadGrant`
 *     before it signs anything. Only the token's SHA-256 is stored.
 *   • Reading the stream back. `finalizeUpload` fetches what was uploaded from
 *     the public bucket — master playlist, every rendition, the poster — and
 *     only then points the listing at it, with the running time and
 *     orientation measured from the stream rather than typed.
 *   • Rebuilding the website. The website renders its pages at build time, so
 *     a change to a live listing asks Vercel for a production build through a
 *     deploy hook (`WEBSITE_DEPLOY_HOOK_URL`).
 */
import crypto from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json, Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { asRow } from "@/lib/json-cast";
import {
  LIVE_STATUSES,
  UPLOAD_GRANT_HOURS,
  UPLOAD_PATH,
  affectsWebsite,
  mediaFieldsFor,
  nextVersion,
  orientationOf,
  parseMasterPlaylist,
  planUpload,
  playlistDuration,
  premiereProblems,
  publishProblems,
  resolveWithin,
  sydneyDate,
  toPublicListing,
  type BriefingStatus,
  type PublicListing,
} from "@/lib/websiteBriefings.pure";
import { writeAuditLog } from "./audit.server";

export type WebsiteBriefingRow = Tables<"website_briefings">;
export type WebsiteBriefingUploadRow = Tables<"website_briefing_uploads">;

const DEFAULT_MEDIA_ORIGIN =
  "https://moeyytuduycrvvncdtme.supabase.co/storage/v1/object/public/marketing-media";
const DEFAULT_SIGNER_URL =
  "https://moeyytuduycrvvncdtme.supabase.co/functions/v1/briefing-upload-sign";

/** Where the website's video media is publicly readable. */
export function websiteMediaOrigin(): string {
  return (process.env.WEBSITE_MEDIA_ORIGIN?.trim() || DEFAULT_MEDIA_ORIGIN).replace(/\/+$/, "");
}

/** The website's signing function, which the operator's browser calls with a grant. */
export function websiteMediaSignerUrl(): string {
  return process.env.WEBSITE_MEDIA_SIGNER_URL?.trim() || DEFAULT_SIGNER_URL;
}

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function isSchemaPending(error: { code?: string | null } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listWebsiteBriefings(): Promise<
  { ok: true; rows: WebsiteBriefingRow[] } | { ok: false; error: string; schemaPending: boolean }
> {
  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message, schemaPending: isSchemaPending(error) };
  return { ok: true, rows: (data ?? []) as WebsiteBriefingRow[] };
}

export async function readWebsiteBriefing(
  id: string,
): Promise<{ ok: true; row: WebsiteBriefingRow | null } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: (data as WebsiteBriefingRow | null) ?? null };
}

/** What the website build reads: premiere and published listings, in library order. */
export async function listPublicListings(): Promise<
  { ok: true; listings: PublicListing[] } | { ok: false; error: string }
> {
  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .select("*")
    .in("status", [...LIVE_STATUSES])
    .order("sort_order", { ascending: true })
    .order("published_on", { ascending: false, nullsFirst: false });
  if (error) return { ok: false, error: error.message };
  const listings = ((data ?? []) as WebsiteBriefingRow[])
    .map(toPublicListing)
    .filter((l): l is PublicListing => l !== null);
  return { ok: true, listings };
}

// ── Writes ──────────────────────────────────────────────────────────────────

/** The editable copy. Media, status and the stamps are written by their own acts. */
export type BriefingCopy = Pick<
  WebsiteBriefingRow,
  | "title"
  | "kicker"
  | "summary"
  | "series"
  | "artwork"
  | "artwork_position"
  | "takeaways"
  | "explore_label"
  | "explore_to"
  | "orientation"
  | "disclaimer"
  | "transcript"
  | "sort_order"
> & { chapters: Array<{ at: number; label: string }> };

export async function createWebsiteBriefing(input: {
  slug: string;
  title: string;
  actorId: string;
}): Promise<{ ok: true; row: WebsiteBriefingRow } | { ok: false; error: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .insert(
      asRow<TablesInsert<"website_briefings">>({
        slug: input.slug,
        title: input.title,
        status: "draft",
        created_by: input.actorId,
        updated_by: input.actorId,
        created_at: now,
        updated_at: now,
      }),
    )
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505")
      return { ok: false, error: `A video already uses /watch/${input.slug}.` };
    if (isSchemaPending(error)) return { ok: false, error: "schema_pending" };
    return { ok: false, error: error.message };
  }
  const row = data as WebsiteBriefingRow;
  await writeAuditLog({
    action: "website_briefing.created",
    entityType: "website_briefing",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { slug: row.slug, title: row.title },
  });
  return { ok: true, row };
}

/**
 * Save a listing's copy. The slug can change only while no media has been
 * uploaded, because the media folder is named after it. A live listing is
 * re-checked against the rules it went live under before the save lands: an
 * edit must not take a published video off the website by breaking a rule the
 * build then enforces.
 */
export async function saveWebsiteBriefing(input: {
  id: string;
  slug: string;
  copy: BriefingCopy;
  actorId: string;
}): Promise<
  | { ok: true; row: WebsiteBriefingRow; rebuild: RebuildResult | null }
  | { ok: false; error: string; problems?: string[] }
> {
  const current = await readWebsiteBriefing(input.id);
  if (!current.ok) return { ok: false, error: current.error };
  if (!current.row) return { ok: false, error: "That video no longer exists." };
  const before = current.row;
  if (input.slug !== before.slug && before.media_version) {
    return {
      ok: false,
      error: "The slug is fixed once media has been uploaded: the media folder is named after it.",
    };
  }

  const next = {
    ...before,
    ...input.copy,
    slug: input.slug,
    chapters: input.copy.chapters as unknown as Json,
  };
  const problems =
    before.status === "published"
      ? publishProblems(next)
      : before.status === "premiere"
        ? premiereProblems(next)
        : [];
  if (problems.length > 0) {
    return {
      ok: false,
      error: "This video is on the website, and the edit would break it.",
      problems,
    };
  }

  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .update(
      asRow<TablesUpdate<"website_briefings">>({
        ...input.copy,
        chapters: input.copy.chapters,
        slug: input.slug,
        updated_by: input.actorId,
        updated_at: new Date().toISOString(),
      }),
    )
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505")
      return { ok: false, error: `A video already uses /watch/${input.slug}.` };
    return { ok: false, error: error.message };
  }
  const row = data as WebsiteBriefingRow;
  await writeAuditLog({
    action: "website_briefing.saved",
    entityType: "website_briefing",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { slug: row.slug, status: row.status },
  });
  const rebuild = affectsWebsite(before, row)
    ? await requestWebsiteRebuild({ reason: `Edited "${row.title}"`, actorId: input.actorId })
    : null;
  return { ok: true, row, rebuild };
}

/**
 * Move a listing between draft, premiere, published and archived. Going live
 * is checked against the website's rules first; a first publish is stamped
 * with today's Sydney date, and a republish keeps the date it first went up.
 */
export async function setWebsiteBriefingStatus(input: {
  id: string;
  status: BriefingStatus;
  actorId: string;
}): Promise<
  | { ok: true; row: WebsiteBriefingRow; rebuild: RebuildResult | null }
  | { ok: false; error: string; problems?: string[] }
> {
  const current = await readWebsiteBriefing(input.id);
  if (!current.ok) return { ok: false, error: current.error };
  if (!current.row) return { ok: false, error: "That video no longer exists." };
  const before = current.row;
  if (before.status === input.status) return { ok: true, row: before, rebuild: null };

  const published_on =
    input.status === "published" ? (before.published_on ?? sydneyDate()) : before.published_on;
  const candidate = { ...before, status: input.status, published_on };
  const problems =
    input.status === "published"
      ? publishProblems(candidate)
      : input.status === "premiere"
        ? premiereProblems(candidate)
        : [];
  if (problems.length > 0) {
    return {
      ok: false,
      error: `It cannot be ${input.status === "published" ? "published" : "shown as a premiere"} yet.`,
      problems,
    };
  }

  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .update(
      asRow<TablesUpdate<"website_briefings">>({
        status: input.status,
        published_on,
        updated_by: input.actorId,
        updated_at: new Date().toISOString(),
      }),
    )
    .eq("id", input.id)
    // Only from the status the operator was shown, so two operators acting on
    // one listing cannot each believe their act was the one that landed.
    .eq("status", before.status)
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data)
    return {
      ok: false,
      error: "The video changed while you were looking at it. Reload and try again.",
    };
  const row = data as WebsiteBriefingRow;
  await writeAuditLog({
    action: "website_briefing.status_changed",
    entityType: "website_briefing",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { slug: row.slug, from: before.status, to: row.status },
  });
  const rebuild = affectsWebsite(before, row)
    ? await requestWebsiteRebuild({
        reason: `"${row.title}" ${before.status} → ${row.status}`,
        actorId: input.actorId,
      })
    : null;
  return { ok: true, row, rebuild };
}

/** A draft that never went anywhere can be deleted outright; anything else is archived instead. */
export async function deleteDraftWebsiteBriefing(input: {
  id: string;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .delete()
    .eq("id", input.id)
    .eq("status", "draft")
    .is("media_version", null)
    .select("id, slug");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "Only a draft with no media can be deleted. Archive it instead." };
  }
  await writeAuditLog({
    action: "website_briefing.deleted",
    entityType: "website_briefing",
    entityId: input.id,
    actorUserId: input.actorId,
    metadata: { slug: (data[0] as { slug: string }).slug },
  });
  return { ok: true };
}

// ── Upload grants ───────────────────────────────────────────────────────────

/**
 * Grant an upload of these files into this listing's next version folder.
 * Returns the token once; only its hash is kept.
 */
export async function createUploadGrant(input: {
  briefingId: string;
  paths: string[];
  actorId: string;
}): Promise<
  | {
      ok: true;
      uploadId: string;
      token: string;
      version: string;
      prefix: string;
      signerUrl: string;
      expiresAt: string;
    }
  | { ok: false; error: string; problems?: string[] }
> {
  const plan = planUpload(input.paths);
  if (!plan.ok)
    return { ok: false, error: "That folder cannot be uploaded.", problems: plan.problems };

  const current = await readWebsiteBriefing(input.briefingId);
  if (!current.ok) return { ok: false, error: current.error };
  if (!current.row) return { ok: false, error: "That video no longer exists." };
  const briefing = current.row;

  const { data: grants, error: grantsError } = await supabaseAdmin
    .from("website_briefing_uploads")
    .select("version")
    .eq("briefing_id", briefing.id);
  if (grantsError) return { ok: false, error: grantsError.message };
  const version = nextVersion([briefing.media_version, ...(grants ?? []).map((g) => g.version)]);

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + UPLOAD_GRANT_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("website_briefing_uploads")
    .insert(
      asRow<TablesInsert<"website_briefing_uploads">>({
        briefing_id: briefing.id,
        version,
        token_sha256: sha256(token),
        paths: plan.files.map((f) => f.path),
        expires_at: expiresAt,
        created_by: input.actorId,
      }),
    )
    .select("id")
    .single();
  if (error) {
    // 23505: another operator took this version a moment ago. Asking again
    // takes the next one.
    if (error.code === "23505")
      return { ok: false, error: "Another upload just started for this video. Try again." };
    return { ok: false, error: error.message };
  }
  await writeAuditLog({
    action: "website_briefing.upload_granted",
    entityType: "website_briefing",
    entityId: briefing.id,
    actorUserId: input.actorId,
    metadata: { slug: briefing.slug, version, files: plan.files.length },
  });
  return {
    ok: true,
    uploadId: (data as { id: string }).id,
    token,
    version,
    prefix: `videos/${briefing.slug}/${version}/`,
    signerUrl: websiteMediaSignerUrl(),
    expiresAt,
  };
}

/**
 * The website's signing function asks this before it signs. A token is good
 * while it is unexpired and its upload unfinished, and only for the paths it
 * was granted.
 */
export async function verifyUploadGrant(input: {
  token: string;
  paths: string[];
}): Promise<{ ok: true; prefix: string } | { ok: false; error: string; status: number }> {
  if (!input.paths.every((p) => UPLOAD_PATH.test(p)))
    return { ok: false, error: "bad_paths", status: 400 };
  const { data, error } = await supabaseAdmin
    .from("website_briefing_uploads")
    .select("id, version, paths, expires_at, completed_at, website_briefings(slug)")
    .eq("token_sha256", sha256(input.token))
    .maybeSingle();
  if (error) return { ok: false, error: "unavailable", status: 503 };
  const grant = data as
    | (Pick<
        WebsiteBriefingUploadRow,
        "id" | "version" | "paths" | "expires_at" | "completed_at"
      > & {
        website_briefings: { slug: string } | null;
      })
    | null;
  if (!grant || !grant.website_briefings) return { ok: false, error: "unknown_grant", status: 403 };
  if (grant.completed_at) return { ok: false, error: "grant_used", status: 403 };
  if (Date.parse(grant.expires_at) <= Date.now())
    return { ok: false, error: "grant_expired", status: 403 };
  const allowed = new Set(grant.paths);
  if (!input.paths.every((p) => allowed.has(p)))
    return { ok: false, error: "path_not_granted", status: 403 };
  return { ok: true, prefix: `videos/${grant.website_briefings.slug}/${grant.version}/` };
}

// ── Reading the stream back ─────────────────────────────────────────────────

async function fetchText(
  url: string,
): Promise<{ ok: true; text: string } | { ok: false; status: number }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, text: await response.text() };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** Is there an object at this URL? A one-byte GET, because Storage answers HEAD with cache headers of its own. */
async function exists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { range: "bytes=0-0" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check the uploaded package from the public bucket, the way a viewer's
 * player will see it, and point the listing at it.
 *
 * The master playlist, every rendition and alternate rendition it names, the
 * poster and any card and fallback must all answer. The running time is the
 * first rendition's segments summed, and the orientation is the largest
 * rendition's shape. Nothing is pointed at until all of that holds; the grant
 * is then spent, so its token can sign nothing more.
 */
export async function finalizeUpload(input: { uploadId: string; actorId: string }): Promise<
  | {
      ok: true;
      row: WebsiteBriefingRow;
      durationSeconds: number | null;
      orientation: "landscape" | "portrait";
      rebuild: RebuildResult | null;
    }
  | { ok: false; error: string; problems?: string[] }
> {
  const { data: grantData, error: grantError } = await supabaseAdmin
    .from("website_briefing_uploads")
    .select("*")
    .eq("id", input.uploadId)
    .maybeSingle();
  if (grantError) return { ok: false, error: grantError.message };
  const grant = grantData as WebsiteBriefingUploadRow | null;
  if (!grant) return { ok: false, error: "That upload no longer exists." };
  if (grant.completed_at) return { ok: false, error: "That upload has already been finished." };

  const current = await readWebsiteBriefing(grant.briefing_id);
  if (!current.ok) return { ok: false, error: current.error };
  if (!current.row) return { ok: false, error: "That video no longer exists." };
  const before = current.row;

  const origin = websiteMediaOrigin();
  const prefix = `videos/${before.slug}/${grant.version}/`;
  const fields = mediaFieldsFor(prefix, grant.paths);
  const problems: string[] = [];
  let durationSeconds: number | null = null;
  let orientation: "landscape" | "portrait" =
    before.orientation === "portrait" ? "portrait" : "landscape";

  if (fields.media_hls) {
    const master = await fetchText(`${origin}/${fields.media_hls}`);
    if (!master.ok) {
      problems.push(`master.m3u8 does not answer (HTTP ${master.status}).`);
    } else {
      const parsed = parseMasterPlaylist(master.text);
      if (parsed.variants.length === 0) problems.push("master.m3u8 lists no renditions.");
      orientation = orientationOf(parsed);
      const uris = [...parsed.variants.map((v) => v.uri), ...parsed.media];
      for (const [index, uri] of uris.entries()) {
        const path = resolveWithin(prefix, uri);
        if (!path) {
          problems.push(`master.m3u8 points outside its folder: ${uri}`);
          continue;
        }
        const playlist = await fetchText(`${origin}/${path}`);
        if (!playlist.ok) {
          problems.push(`${uri} does not answer (HTTP ${playlist.status}).`);
          continue;
        }
        if (index === 0) durationSeconds = Math.round(playlistDuration(playlist.text)) || null;
      }
    }
  }
  for (const [label, path] of [
    ["poster.jpg", fields.media_poster],
    ["the share card", fields.media_card],
    ["the fallback MP4", fields.media_mp4],
    ["the captions", fields.media_captions],
  ] as const) {
    if (path && !(await exists(`${origin}/${path}`))) problems.push(`${label} does not answer.`);
  }
  if (!fields.media_hls && !fields.media_mp4) problems.push("The package has nothing to play.");
  if (fields.media_hls && !durationSeconds)
    problems.push("The running time could not be read from the stream.");
  if (!fields.media_hls && fields.media_mp4) {
    // A progressive-only package carries no playlist to measure. Its running
    // time has to come from the listing, and Publish will say so if it is unset.
    durationSeconds = before.duration_seconds;
  }
  if (problems.length > 0) {
    return { ok: false, error: "The upload is not complete — nothing was changed.", problems };
  }

  const { data, error } = await supabaseAdmin
    .from("website_briefings")
    .update(
      asRow<TablesUpdate<"website_briefings">>({
        ...fields,
        media_version: grant.version,
        duration_seconds: durationSeconds,
        orientation,
        updated_by: input.actorId,
        updated_at: new Date().toISOString(),
      }),
    )
    .eq("id", before.id)
    .eq("slug", before.slug)
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data)
    return {
      ok: false,
      error: "The video changed while uploading. Nothing was pointed at the new media.",
    };

  const { error: spendError } = await supabaseAdmin
    .from("website_briefing_uploads")
    .update(
      asRow<TablesUpdate<"website_briefing_uploads">>({ completed_at: new Date().toISOString() }),
    )
    .eq("id", grant.id);
  if (spendError) {
    // The listing already points at the media; an unspent grant expires on
    // its own within hours. Logged, not fatal.
    console.error("[website-briefings] could not spend upload grant", grant.id, spendError.message);
  }

  const row = data as WebsiteBriefingRow;
  await writeAuditLog({
    action: "website_briefing.media_uploaded",
    entityType: "website_briefing",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: {
      slug: row.slug,
      version: grant.version,
      duration_seconds: durationSeconds,
      orientation,
    },
  });
  const rebuild =
    row.status === "published"
      ? await requestWebsiteRebuild({
          reason: `New media for "${row.title}"`,
          actorId: input.actorId,
        })
      : null;
  return { ok: true, row, durationSeconds, orientation, rebuild };
}

// ── Rebuilding the website ──────────────────────────────────────────────────

/**
 * How long Mission Control waits for Vercel to answer the hook. On 29 Oct 2026
 * Vercel took longer than the 15 seconds this used to allow: Mission Control
 * gave up and said the rebuild had failed, and the production build the hook
 * had started went live 40 seconds later.
 */
export const REBUILD_TIMEOUT_MS = 25_000;

export type RebuildResult =
  | { requested: true; at: string; job: string | null }
  | {
      requested: false;
      /**
       * `unconfirmed`: the hook was called and Vercel had not answered when the
       * wait ran out. Vercel may still be starting the build, so this is not a
       * failure — the console waits for the build to read the listings.
       */
      reason: "not_configured" | "failed" | "unconfirmed";
      detail?: string;
    };

const isTimeout = (err: unknown) =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** The job id Vercel answers a deploy hook with, if it said one. */
async function hookJob(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { job?: { id?: unknown } };
    return typeof body?.job?.id === "string" ? body.job.id : null;
  } catch {
    return null;
  }
}

/**
 * Ask Vercel for a production build of the website. The hook is a Vercel
 * deploy hook URL (Project → Settings → Git → Deploy Hooks), held as the
 * Lovable secret `WEBSITE_DEPLOY_HOOK_URL`. Without it nothing is requested,
 * and the console says the change reaches the website on its next deploy.
 *
 * The request carries an empty body, so it is sent with `Content-Length: 0`
 * rather than as a POST of unstated length for the other end to wait out.
 */
export async function requestWebsiteRebuild(input: {
  reason: string;
  actorId: string | null;
}): Promise<RebuildResult> {
  const hook = process.env.WEBSITE_DEPLOY_HOOK_URL?.trim();
  if (!hook) return { requested: false, reason: "not_configured" };
  const started = Date.now();
  let result: RebuildResult;
  try {
    const response = await fetch(hook, {
      method: "POST",
      body: "",
      signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
    });
    result = response.ok
      ? { requested: true, at: new Date().toISOString(), job: await hookJob(response) }
      : { requested: false, reason: "failed", detail: `HTTP ${response.status}` };
  } catch (err) {
    result = isTimeout(err)
      ? {
          requested: false,
          reason: "unconfirmed",
          detail: `Vercel had not answered after ${REBUILD_TIMEOUT_MS / 1000} seconds`,
        }
      : { requested: false, reason: "failed", detail: (err as Error).message };
  }
  const elapsedMs = Date.now() - started;
  await writeAuditLog({
    action: result.requested
      ? "website.rebuild_requested"
      : result.reason === "unconfirmed"
        ? "website.rebuild_unconfirmed"
        : "website.rebuild_failed",
    entityType: "website",
    entityId: null,
    actorUserId: input.actorId,
    metadata: {
      reason: input.reason,
      elapsed_ms: elapsedMs,
      ...(result.requested ? { job: result.job } : { detail: result.detail ?? result.reason }),
    },
  });
  return result;
}

export type LastRebuild = {
  at: string;
  reason: string | null;
  outcome: "requested" | "unconfirmed";
};

/** When the website was last asked to rebuild, for the console. */
export async function lastWebsiteRebuild(): Promise<LastRebuild | null> {
  const { data, error } = await supabaseAdmin
    .from("audit_log")
    .select("created_at, action, metadata")
    .in("action", ["website.rebuild_requested", "website.rebuild_unconfirmed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const metadata = (data.metadata ?? {}) as { reason?: string };
  return {
    at: data.created_at as string,
    reason: metadata.reason ?? null,
    outcome: data.action === "website.rebuild_unconfirmed" ? "unconfirmed" : "requested",
  };
}

/**
 * A website build announcing that it read the listings — the effect a rebuild
 * request exists to cause, and the only proof one happened that does not rest
 * on Vercel's answer. `scripts/sync-briefings.ts` (aurixa-systems) sends these
 * on a Vercel build: the build's environment and its deployment id.
 */
export type BuildAnnouncement = { env: string; build: string };

const BUILD_ENVS = new Set(["production", "preview", "development"]);
const BUILD_ID = /^[A-Za-z0-9._-]{1,120}$/;

export function buildAnnouncementFrom(headers: Headers): BuildAnnouncement | null {
  const env = (headers.get("x-aurixa-build-env") ?? "").trim().toLowerCase();
  const build = (headers.get("x-aurixa-build-id") ?? "").trim();
  if (!BUILD_ENVS.has(env) || !BUILD_ID.test(build)) return null;
  return { env, build };
}

/** Records that a website build read the listings, and what it was given. */
export async function recordWebsiteBuildRead(
  announcement: BuildAnnouncement,
  read: { ok: boolean; listings: number },
): Promise<void> {
  await writeAuditLog({
    action: "website.build_read_listings",
    entityType: "website",
    entityId: null,
    actorUserId: null,
    metadata: { ...announcement, ok: read.ok, listings: read.listings },
  });
}

/** When a production build of the website last read the listings. */
export async function lastWebsiteBuildRead(): Promise<{ at: string; build: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("audit_log")
    .select("created_at, metadata")
    .eq("action", "website.build_read_listings")
    .eq("metadata->>env", "production")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const metadata = (data.metadata ?? {}) as { build?: string };
  return { at: data.created_at as string, build: metadata.build ?? "" };
}

export const websiteRebuildConfigured = () => Boolean(process.env.WEBSITE_DEPLOY_HOOK_URL?.trim());
