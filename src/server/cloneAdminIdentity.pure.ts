/**
 * Which identity a seeded admin actually gets, and whether it can sign in.
 *
 * ## The defect this exists for
 *
 * `seedAdminUser` created a Supabase Auth user and granted it `super_admin`
 * in `public.user_roles`. Against the prime this product clones, all three
 * halves of that were wrong, and every one of them failed SILENTLY because
 * the grant was wrapped in `EXCEPTION WHEN others THEN RAISE WARNING`:
 *
 *   1. The product does not authenticate through Supabase Auth. It reads
 *      `public.custom_users`, comparing a bcrypt `password_hash` in
 *      `_shared/password.ts`. `auth.users` is not consulted by any login path.
 *   2. `public.user_roles.user_id` is a foreign key to `public.custom_users`,
 *      so an `auth.users` id cannot be written to it at all — 23503.
 *   3. `public.app_role` spells the top role `superadmin`. There is no
 *      `super_admin` label, so the insert would have been 22P02 even had the
 *      foreign key allowed it.
 *
 * Measured on the first clone (`plisdzywzleljorrphxv`) on 1 Sep 2026:
 * `auth.users` held ZERO rows after a provisioning run that reported the admin
 * step as done.
 *
 * ## The rule
 *
 * **A seeded admin that cannot sign in is worse than no admin at all**,
 * because the clone looks finished. So the seed names the identity store the
 * product actually reads, chooses a role label the column will actually
 * accept, and the caller VERIFIES the credential round-trips rather than
 * assuming the write worked.
 */

/**
 * Role labels this platform's primes use for "the most privileged operator",
 * most preferred first.
 *
 * Ordered rather than guessed: two spellings of the same idea are live in one
 * database — `custom_users.role` is the free text `super_admin` while
 * `user_roles.role` is the enum `superadmin` — so the label that goes into a
 * column is chosen from what that column actually admits.
 */
export const ADMIN_ROLE_PREFERENCE = ["super_admin", "superadmin", "owner", "admin"] as const;

/**
 * Pick the most privileged label the column will accept.
 *
 * Returns null when it admits none of them — which is a REFUSAL, never a
 * fallback to the first entry: writing `admin` where the schema meant
 * something else grants the wrong authority, and writing a label the column
 * rejects is the silent failure this module exists for.
 */
export function chooseRoleLabel(available: readonly string[]): string | null {
  const set = new Set(available.map((v) => v.trim()).filter(Boolean));
  for (const preferred of ADMIN_ROLE_PREFERENCE) {
    if (set.has(preferred)) return preferred;
  }
  return null;
}

/**
 * A single-quoted SQL literal for a CREDENTIAL, or a throw.
 *
 * `runSqlOnProject` takes raw SQL, so a password reaches the clone as text in
 * a statement. Doubling quotes is correct for every character this platform's
 * `generateSecurePassword` can emit; anything it cannot carry safely — a
 * backslash, a NUL, a newline — is REFUSED rather than escaped by guesswork,
 * because a mis-escaped credential is a syntax error at best and a broken
 * login at worst.
 */
export function sqlCredentialLiteral(value: string): string {
  if (/[\\\r\n\0]/.test(value)) {
    throw new Error(
      "cloneAdminIdentity: credential contains characters that cannot be carried in a SQL literal",
    );
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** What one seeding attempt actually achieved on the clone. */
export type AdminSeedReport = {
  /** A row in the store the product's login path reads. */
  readonly product_identity: boolean;
  /** The stored credential verifies against the password we set. */
  readonly password_verifies: boolean;
  /** A role row was written, and with which label. */
  readonly role_label: string | null;
  /** A Supabase Auth user exists (irrelevant to products that do not use it). */
  readonly auth_user: boolean;
  /** Anything the clone declined to do, in its own words. */
  readonly notes: readonly string[];
};

/**
 * Is this a clone somebody can actually sign in to?
 *
 * The auth user is deliberately NOT sufficient on its own: it is what the
 * broken version produced, and it let a clone with no usable operator report
 * success.
 */
export function seedIsUsable(report: AdminSeedReport): boolean {
  return report.product_identity && report.password_verifies;
}

/** One sentence for the provisioning status line. */
export function describeSeed(report: AdminSeedReport, adminEmail: string): string {
  if (seedIsUsable(report)) {
    const role = report.role_label ? ` as ${report.role_label}` : " with no role row";
    return `Seeded ${adminEmail}${role}; the stored credential verifies.`;
  }
  if (report.product_identity && !report.password_verifies) {
    return `Wrote ${adminEmail} but the stored credential did NOT verify — nobody can sign in to this clone.`;
  }
  if (report.auth_user) {
    return (
      `Created a Supabase Auth user for ${adminEmail}, but this prime authenticates ` +
      `against its own identity table and no row was written there — nobody can sign in.`
    );
  }
  return `No usable admin identity was created for ${adminEmail}.`;
}
