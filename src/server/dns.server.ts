/**
 * DNS, over HTTPS — the Worker has no resolver of its own.
 *
 * Cloudflare's resolver first and Google's if it fails, both through their
 * JSON APIs (`email-identity.server.ts` already resolves Resend's records the
 * same way). Every answer, including "no such name", is a result; only a
 * lookup that did not complete is an `error`, and callers treat that as no
 * evidence either way.
 *
 * Answers are cached per isolate: a campaign asking about the same fifty
 * recipient domains every minute, or a page refreshed every thirty seconds,
 * should not ask the internet each time.
 */
import type { DnsAnswer, DnsLookup } from "@/lib/email/domainAuth.pure";

export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";

const RESOLVERS = [
  (name: string, type: RecordType) =>
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
  (name: string, type: RecordType) =>
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
];

const TIMEOUT_MS = 4_000;
/** How long an answer is reused. A failed lookup is retried soon. */
const ANSWER_TTL_MS = 10 * 60_000;
const ERROR_TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { at: number; lookup: DnsLookup }>();

async function ask(url: string): Promise<DnsLookup> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, error: `resolver answered ${response.status}` };
    const body = (await response.json()) as { Status?: number; Answer?: DnsAnswer[] };
    if (typeof body.Status !== "number") return { ok: false, error: "resolver gave no status" };
    // SERVFAIL and REFUSED are the resolver's trouble, not the domain's answer.
    if (body.Status === 2 || body.Status === 5) {
      return { ok: false, error: `resolver answered rcode ${body.Status}` };
    }
    return {
      ok: true,
      rcode: body.Status,
      answers: (body.Answer ?? []).filter(
        (answer): answer is DnsAnswer =>
          typeof answer?.type === "number" && typeof answer?.data === "string",
      ),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** One record type for one name. */
export async function resolveDns(name: string, type: RecordType): Promise<DnsLookup> {
  const key = `${name.toLowerCase()}|${type}`;
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < (cached.lookup.ok ? ANSWER_TTL_MS : ERROR_TTL_MS)) {
    return cached.lookup;
  }
  let lookup: DnsLookup = { ok: false, error: "no resolver was tried" };
  for (const resolver of RESOLVERS) {
    lookup = await ask(resolver(name, type));
    if (lookup.ok) break;
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, lookup });
  return lookup;
}
