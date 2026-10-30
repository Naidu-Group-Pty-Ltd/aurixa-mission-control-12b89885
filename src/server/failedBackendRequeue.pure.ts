/**
 * How a lever that holds no operator password re-queues a FAILED backend.
 *
 * Two levers re-queue a failed backend without asking anybody for a password:
 * `POST /hooks/backend-provisioning-retry` and the dashboard's bulk
 * reprovision. Both minted one with `generateSecurePassword`, which nobody is
 * shown, and the seed writes it over an existing admin account's password
 * (`seedProductAdminIdentity` updates `password_hash` unconditionally). So on
 * a backend whose seed had already run — the demo clone's had, twice, with the
 * password its owner holds — either lever would have locked that owner out,
 * and the platform's password reset needs a sending identity a new clone may
 * not have yet. Found 29 Oct 2026, provisioning `tutorial-demo-orrimere-c158c7`.
 *
 * Minting is right only where it replaces nothing. So the account is read
 * first, on the clone's own project, and the lever does the one thing that is
 * safe for what it found:
 *
 *  - no project yet, or no account on it: provision with a minted password,
 *    which creates the account (the reset flow is its front door, as before);
 *  - an account exists: converge the backend as a REPAIR, which seeds nobody,
 *    so the password whoever holds it keeps working;
 *  - unreadable: neither. A repair over a missing account would finish a
 *    clone nobody can enter, and a minted password over a present one is the
 *    lock-out. The clone page's retry takes the admin's own password.
 */

/** Whether the clone's project holds its admin account: read, or `unknown` when it could not be. */
export type AdminPresence = "present" | "absent" | "unknown";

export type FailedRequeue =
  | { kind: "provision"; why: string }
  | { kind: "repair"; why: string }
  | { kind: "refuse"; why: string };

export function chooseFailedRequeue(input: {
  /** The project an earlier pass created, or null when none was. */
  projectRef: string | null;
  /** Read on that project; null when there is no project to read. */
  adminPresence: AdminPresence | null;
}): FailedRequeue {
  if (!input.projectRef) {
    return {
      kind: "provision",
      why: "no project exists yet, so no admin account can, and a minted password replaces nothing",
    };
  }
  if (input.adminPresence === "absent") {
    return {
      kind: "provision",
      why: "the project holds no admin account yet, so a minted password creates it and replaces nothing",
    };
  }
  if (input.adminPresence === "present") {
    return {
      kind: "repair",
      why: "the admin account exists, so its password belongs to whoever holds it: the backend is converged as a repair and the account is left alone",
    };
  }
  return {
    kind: "refuse",
    why: "whether the admin account exists could not be read, so neither a minted password nor a repair is safe — retry it from the clone page with the admin's own password",
  };
}
