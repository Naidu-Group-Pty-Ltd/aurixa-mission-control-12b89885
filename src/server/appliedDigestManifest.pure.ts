/**
 * `scripts/applied-migration-digests.txt`, rendered from what the queue ran.
 *
 * Two writers share this: `scripts/refresh-applied-digests.mjs` (a person
 * running `npm run migrations:digests`, importing this file directly through
 * Node's type stripping) and Mission Control proposing the refresh on Prime
 * after a migration push settles (`applied-digests-proposal.server.ts`). One
 * renderer, so the two can never write the file two ways and turn every
 * refresh into a diff of formatting.
 *
 * No imports, and nothing but erasable TypeScript: Node strips the types and
 * runs it as it stands.
 */

export type ManifestDigest = { version: string; sha256: string; name: string };

/** The comment and blank lines the manifest opens with, kept as a person wrote them. */
export function manifestHeader(existing: string): string {
  return existing
    .split("\n")
    .filter((l) => l.startsWith("#") || l.trim() === "")
    .join("\n")
    .replace(/\n+$/, "\n");
}

/** The whole file: the existing header, then one line per settled version, oldest first. */
export function renderManifest(existing: string, digests: readonly ManifestDigest[]): string {
  return (
    manifestHeader(existing) +
    digests
      .slice()
      .sort((a, b) => a.version.localeCompare(b.version))
      .map((d) => `${d.version}  ${d.sha256}  ${d.name}`)
      .join("\n") +
    "\n"
  );
}
