/**
 * The operator console's organisation controls, and the lines they hold.
 *
 * The network's `builder_organisations` ties `status`, `is_active`,
 * `activated_at` and `suspended_at` together with three CHECK constraints, so
 * a form that could write one of them would be a second way to move a
 * lifecycle — and the two would disagree the first time one forgot a stamp.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AU_STATES, ORGANISATION_FIELDS } from "./builders-network.functions";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FUNCTIONS = "src/server/builders-network.functions.ts";
const CONSOLE = "src/routes/builders-network.tsx";
const DIALOGS = "src/components/builders-network-organisation-dialogs.tsx";

const LIFECYCLE = ["status", "is_active", "activated_at", "suspended_at", "suspension_reason"];

describe("what an operator may write", () => {
  it("names description only — never a lifecycle column", () => {
    for (const column of LIFECYCLE) {
      expect(ORGANISATION_FIELDS).not.toContain(column as never);
    }
    expect(ORGANISATION_FIELDS).toContain("legal_name" as never);
  });

  it("strips anything outside that list before it travels", () => {
    // The allow-list is applied server-side, so a crafted payload cannot
    // smuggle `status` through to the network.
    const source = read(FUNCTIONS);
    expect(source).toContain("organisationFieldsOnly");
    expect(source).toMatch(/for \(const key of ORGANISATION_FIELDS\)/);
    for (const op of ["create_organisation", "update_organisation"]) {
      const at = source.indexOf(op);
      expect(at, op).toBeGreaterThan(-1);
      expect(source.slice(at, at + 400), op).toContain("organisationFieldsOnly");
    }
  });

  it("offers no status control in the form", () => {
    const form = read(DIALOGS);
    const start = form.indexOf("function OrganisationFormDialog");
    const end = form.indexOf("function CloseOrganisationDialog");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = form.slice(start, end);
    for (const column of LIFECYCLE) {
      expect(body, column).not.toMatch(new RegExp(`["'\`]${column}["'\`]`));
    }
  });
});

/**
 * What the network's columns require, offered rather than discovered.
 *
 * `builder_organisations` makes `legal_name` and `org_type` NOT NULL and
 * CHECKs the shape of `abn`, `acn`, `postcode` and `state`. Measured before
 * this was written: six of eight realistic inputs to this form reached
 * Postgres and came back as an unattributed 500, rendered to the operator as
 * "The organisation could not be saved". A form must not offer a save the
 * server is certain to refuse.
 */
describe("the form cannot offer a save the network will refuse", () => {
  const dialogSource = read(DIALOGS);

  it("withholds Create until both NOT NULL columns are answered", () => {
    expect(dialogSource).toMatch(
      /const canSave = Boolean\(values\.legal_name\.trim\(\) && values\.org_type\.trim\(\)\)/,
    );
    expect(dialogSource).toMatch(/disabled=\{saving \|\| !canSave\}/);
  });

  it("marks both of them required where the operator is looking", () => {
    expect(dialogSource).toContain("Legal name (required)");
    expect(dialogSource).toContain("Type (required)");
  });

  it("offers the eight states rather than a free-text box", () => {
    // `vic` and `Victoria` are both plainly meant and the column takes
    // neither, so the operator chooses from the set instead of guessing it.
    expect(AU_STATES).toEqual(["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"]);
    expect(dialogSource).toContain("AU_STATES.map");
    expect(dialogSource).not.toMatch(/field\("state"/);
  });
});

describe("the console mounts what this file checks", () => {
  it("renders all four dialogs from the module they live in", () => {
    // The rules below are asserted against the dialogs' own file, so a
    // component that stopped being rendered would keep passing them. This
    // repo has shipped that exact defect: three builder-portal components
    // written, documented and deployed with zero call sites.
    const consoleSource = read(CONSOLE);
    expect(consoleSource).toContain('from "@/components/builders-network-organisation-dialogs"');
    for (const component of [
      "OrganisationFormDialog",
      "CloseOrganisationDialog",
      "ReopenOrganisationDialog",
      "InviteOwnerDialog",
    ]) {
      // `<${component}` alone is satisfied by `<InviteOwnerDialogX`, so the
      // element name has to actually end where the component's name does.
      expect(consoleSource, component).toMatch(new RegExp(`<${component}(?![A-Za-z0-9_])`));
      expect(read(DIALOGS), component).toContain(`export function ${component}(`);
    }
  });
});

describe("closing", () => {
  const dialogSource = read(DIALOGS);
  const consoleSource = read(CONSOLE);

  it("is its own act, not a status a dropdown could pick", () => {
    expect(read(FUNCTIONS)).toContain("close_organisation");
    expect(dialogSource).toContain("function CloseOrganisationDialog");
  });

  it("will not proceed without a reason", () => {
    const source = read(FUNCTIONS);
    const at = source.indexOf("closeNetworkOrganisation");
    expect(source.slice(at, at + 500)).toContain("reason required");
    const start = dialogSource.indexOf("function CloseOrganisationDialog");
    const body = dialogSource.slice(start, start + 2600);
    expect(body).toMatch(/disabled=\{busy \|\| !reason\.trim\(\)\}/);
  });

  it("says what closing keeps and that it can be undone, and names suspension", () => {
    // It used to say "Closing is final — a closed organisation cannot be
    // reopened", while the network had only ever written the status: every
    // member, listing and record survived, with no way back to them. A
    // finality nothing enforces is a promise the operator plans around.
    const start = dialogSource.indexOf("function CloseOrganisationDialog");
    const end = dialogSource.indexOf("function ReopenOrganisationDialog");
    const body = dialogSource.slice(start, end);
    expect(body).not.toMatch(/cannot be reopened|Close permanently|Closing is final/i);
    expect(body).toMatch(/Nothing is deleted/);
    expect(body).toMatch(/can be\s+reopened/i);
    expect(body).toMatch(/suspend it instead/i);
  });

  it("offers a closed organisation nothing but Reopen", () => {
    // Edit, invite and a second close all wait until it is open — the
    // network refuses each on a closed row.
    expect(consoleSource).toMatch(/organisation\.status !== "closed" && \(/);
    const at = consoleSource.indexOf('organisation.status === "closed" && (');
    expect(at).toBeGreaterThan(-1);
    const control = consoleSource.slice(at, at + 400);
    expect(control).toMatch(/setOrgBeingReopened\(organisation\)/);
    expect(control).toMatch(/Reopen/);
    expect(control).not.toMatch(/openOrganisationForm|setOrgBeingSeeded|setOrgBeingClosed/);
  });
});

describe("reopening", () => {
  const dialogSource = read(DIALOGS);
  const functions = read(FUNCTIONS);
  const start = dialogSource.indexOf("function ReopenOrganisationDialog");
  const body = dialogSource.slice(start, dialogSource.indexOf("type InviteResult", start));

  it("is its own act on the network, and will not proceed without a reason", () => {
    const at = functions.indexOf("export const reopenNetworkOrganisation");
    expect(at).toBeGreaterThan(-1);
    const fn = functions.slice(at, at + 1200);
    expect(fn).toContain('callBuilderNetworkAdmin("reopen_organisation"');
    expect(fn).toContain("reason required");
    expect(body).toMatch(/disabled=\{busy \|\| !reason\.trim\(\)\}/);
  });

  it("restores access only when asked, and only where there was access to restore", () => {
    // The network brings an approved organisation back SUSPENDED unless the
    // operator asks for access back in the same act; one never approved goes
    // back to the approval queue whatever is sent.
    const fn = functions.slice(functions.indexOf("export const reopenNetworkOrganisation"));
    expect(fn).toMatch(/reinstate: data\.reinstate === true/);
    expect(body).toMatch(/const wasApproved = Boolean\(organisation\?\.activated_at\)/);
    expect(body).toMatch(/reinstate: wasApproved && reinstate/);
    expect(body).toMatch(/useState\(false\)/);
    expect(body).toMatch(/\{wasApproved \? \(\s*<div[\s\S]{0,200}id="reopen-reinstate"/);
  });

  it("says where the organisation landed, so the operator knows what is left to do", () => {
    expect(body).toMatch(/result\.status === "active"/);
    expect(body).toMatch(/result\.status === "suspended"/);
    expect(body).toMatch(/approval queue/);
    expect(body).toMatch(/result\.alreadyOpen/);
  });
});

describe("the first owner's invite link", () => {
  const dialogSource = read(DIALOGS);
  const start = dialogSource.indexOf("function InviteOwnerDialog");
  const body = dialogSource.slice(start);

  it("is rendered as a value, not a placeholder", () => {
    // `placeholder` is not a value — the uncopyable empty box this codebase
    // has already shipped twice.
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/<Input\s+readOnly\s+value=\{result\.invite_url \?\? ""\}/);
    expect(body).not.toMatch(/placeholder=\{result\.invite_url/);
  });

  it("can be copied, and says it cannot be read again", () => {
    expect(body).toContain('navigator.clipboard.writeText(result.invite_url ?? "")');
    expect(body).toMatch(/shown once/i);
    expect(body).toMatch(/mint another/i);
  });

  it("states when it expires", () => {
    expect(body).toMatch(/Expires in \{result\.expires_in_hours\}/);
  });

  it("explains that the operator stops after the first owner", () => {
    expect(body).toMatch(/its owner invites their own colleagues/i);
  });
});

/**
 * Two outcomes, because the network has two.
 *
 * Closing an organisation leaves its members' accounts standing, and there is
 * no `add_member` on the operator plane — so refusing an established account
 * meant anyone who had ever used the network could never be made the first
 * owner of a new one. The network attaches them now, mints nothing, and says
 * which of the two happened.
 */
describe("an account that already exists", () => {
  const dialogSource = read(DIALOGS);

  it("is handled as its own outcome, not coerced into an empty link box", () => {
    // `String(undefined ?? "")` would have drawn a copy box with nothing in
    // it — the uncopyable-empty-box defect this codebase has paid for twice.
    expect(read(FUNCTIONS)).toMatch(/const attached = result\.body\.outcome === "attached"/);
    expect(read(FUNCTIONS)).toMatch(
      /const inviteUrl =\s*!attached && typeof result\.body\.invite_url === "string"/,
    );
    expect(read(FUNCTIONS)).toMatch(/invite_url: inviteUrl,/);
    expect(dialogSource).toMatch(/result\.outcome === "attached"/);
  });

  it("is told plainly that nothing needs passing on", () => {
    const at = dialogSource.indexOf('result.outcome === "attached"');
    const branch = dialogSource.slice(at, at + 900);
    expect(branch).toMatch(/already had an account/i);
    expect(branch).toMatch(/no invitation was\s+needed/i);
    // And no link is offered, because none exists.
    expect(branch).not.toContain("Copy the invite link");
  });
});

/**
 * A link minted and deliberately not handed over.
 *
 * When the address already belongs to another organisation (a closed one
 * counts), the network sends the invitation to the invitee's own inbox and
 * answers `invite_url: null, link_withheld: true`. The console used to turn
 * that null into `""` and draw an empty box to copy it from.
 */
describe("an invitation whose link is withheld", () => {
  const dialogSource = read(DIALOGS);

  it("keeps the null a null on the way to the dialog", () => {
    expect(read(FUNCTIONS)).not.toMatch(/String\(result\.body\.invite_url/);
    expect(read(FUNCTIONS)).toMatch(
      /link_withheld: !attached && \(result\.body\.link_withheld === true/,
    );
  });

  it("explains instead of drawing a copy box", () => {
    const at = dialogSource.indexOf("result.link_withheld || !result.invite_url ? (");
    expect(at).toBeGreaterThan(-1);
    const branch = dialogSource.slice(at, at + 900);
    expect(branch).toMatch(/link is not shown/);
    expect(branch).not.toContain("Copy the invite link");
    expect(branch).not.toContain("navigator.clipboard");
    // And it comes BEFORE the branch that draws the box.
    expect(at).toBeLessThan(
      dialogSource.indexOf('navigator.clipboard.writeText(result.invite_url ?? "")'),
    );
  });

  it("claims delivery to the inbox only when the email went", () => {
    // The paragraph said "It is sent only to their own inbox" whatever the
    // send did, directly above a status line saying it could not be sent.
    const at = dialogSource.indexOf("result.link_withheld || !result.invite_url ? (");
    const branch = dialogSource.slice(at, dialogSource.indexOf("navigator.clipboard", at));
    const sentGuard = branch.indexOf("result.email_sent ? (");
    expect(sentGuard).toBeGreaterThan(-1);
    expect(branch).not.toMatch(/It is sent only to their own inbox/);
    // Every mention of the inbox sits behind the guard.
    for (const m of branch.matchAll(/inbox/g)) {
      expect(m.index!).toBeGreaterThan(sentGuard);
    }
  });

  it("says nothing reached them when the link was withheld and no email was asked for", () => {
    const at = dialogSource.indexOf(
      ') : result.outcome === "invited" && (result.link_withheld || !result.invite_url) ? (',
    );
    expect(at).toBeGreaterThan(-1);
    const branch = dialogSource.slice(at, at + 700);
    expect(branch).toMatch(/No email was sent/);
    expect(branch).toMatch(/Invite owner again/);
  });

  it("does not tell the operator to pass on a link they were never given", () => {
    const at = dialogSource.indexOf("result.link_withheld || (result.outcome");
    expect(at).toBeGreaterThan(-1);
    const branch = dialogSource.slice(at, at + 600);
    expect(branch).not.toMatch(/pass the link on yourself/);
    expect(branch).toMatch(/Invite owner again/);
  });

  it("says when an earlier link stopped working", () => {
    expect(read(FUNCTIONS)).toMatch(/reissued: result\.body\.reissued === true/);
    expect(dialogSource).toMatch(/result\.reissued \? \(/);
  });
});

describe("sending the invitation", () => {
  const dialogSource = read(DIALOGS);

  it("is offered, and the link is still shown either way", () => {
    expect(dialogSource).toContain('id="invite-send-email"');
    expect(dialogSource).toMatch(/sendEmail/);
    expect(read(FUNCTIONS)).toMatch(/send_email: data\.sendEmail === true/);
  });

  it("reports what happened rather than that a key was set", () => {
    // `!!resendApiKey` reported a send that a 403 from an unverified sender
    // domain had refused.
    expect(dialogSource).toMatch(/result\.email_sent/);
    // USED, not merely declared. A lookup table nothing reads is the
    // shipped-but-unmounted defect this repo has paid for in three
    // components and twenty-eight CSS rules.
    const declaration = dialogSource.indexOf("const EMAIL_FAILURE");
    const uses = [...dialogSource.matchAll(/EMAIL_FAILURE\[/g)];
    expect(declaration).toBeGreaterThan(-1);
    expect(uses.length, "EMAIL_FAILURE is read").toBeGreaterThan(0);
    expect(uses.some((m) => m.index! > declaration)).toBe(true);
  });

  it("names the remedy for each kind of failure, which differ", () => {
    for (const reason of ["not_configured", "refused", "unreachable"]) {
      expect(dialogSource, reason).toContain(reason);
    }
    // Every one tells the operator to pass the link on themselves.
    const at = dialogSource.indexOf("const EMAIL_FAILURE");
    const map = dialogSource.slice(at, dialogSource.indexOf("};", at));
    expect(map.match(/pass the link on yourself/g)?.length).toBe(3);
  });
});

describe("the console does not offer what the switch cannot do", () => {
  it("withholds creation while the operate switch is off", () => {
    // Anchored on the header button's own handler — "New organisation" also
    // appears as the dialog's title, which is not the control being checked.
    const consoleSource = read(CONSOLE);
    const at = consoleSource.indexOf("onClick={() => openOrganisationForm(null)}");
    expect(at).toBeGreaterThan(-1);
    const button = consoleSource.slice(at, at + 400);
    expect(button).toMatch(/disabled=\{!gate\?\.enabled\}/);
    // And says why, rather than being mysteriously dead.
    expect(button).toMatch(/The operate switch is off/);
  });
});
