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
  it("renders all three dialogs from the module they live in", () => {
    // The rules below are asserted against the dialogs' own file, so a
    // component that stopped being rendered would keep passing them. This
    // repo has shipped that exact defect: three builder-portal components
    // written, documented and deployed with zero call sites.
    const consoleSource = read(CONSOLE);
    expect(consoleSource).toContain('from "@/components/builders-network-organisation-dialogs"');
    for (const component of [
      "OrganisationFormDialog",
      "CloseOrganisationDialog",
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

  it("tells the operator it cannot be undone, and names the reversible option", () => {
    const start = dialogSource.indexOf("function CloseOrganisationDialog");
    const body = dialogSource.slice(start, start + 2600);
    expect(body).toMatch(/cannot be reopened/i);
    expect(body).toMatch(/suspend it instead/i);
  });

  it("offers nothing at all on an organisation already closed", () => {
    // Terminal means terminal: no edit, no invite, no second close.
    expect(consoleSource).toMatch(/organisation\.status !== "closed" && \(/);
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
    expect(body).toMatch(/<Input\s+readOnly\s+value=\{minted\.url\}/);
    expect(body).not.toMatch(/placeholder=\{minted/);
  });

  it("can be copied, and says it cannot be read again", () => {
    expect(body).toContain("navigator.clipboard.writeText(minted.url)");
    expect(body).toMatch(/shown once/i);
    expect(body).toMatch(/mint another/i);
  });

  it("states when it expires", () => {
    expect(body).toMatch(/Expires in \{minted\.hours\}/);
  });

  it("explains that the operator stops after the first owner", () => {
    expect(body).toMatch(/its owner invites their own colleagues/i);
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
