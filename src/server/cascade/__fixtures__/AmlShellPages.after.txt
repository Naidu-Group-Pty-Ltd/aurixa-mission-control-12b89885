/**
 * Re-exports for the AML surfaces the shell routes to.
 *
 * This file used to also DEFINE one: `AmlIntakeQueue`, which rendered the
 * shared placeholder shell with no children — an alert reading "Data wires in
 * a later phase" and a card headed "Placeholder workspace". It made no data
 * call and offered no action, and it had shipped to production. It is deleted
 * rather than unmounted, along with `AmlShellPage` itself, because a
 * placeholder that still exists is one route away from being back in the
 * navigation.
 */
export { default as AmlVerification } from "./AmlVerification";
export { default as AmlScreening } from "./AmlScreening";

export { default as AmlRisk } from "./AmlRisk";

export { default as AmlCounterparty } from "./AmlCounterparty";

export { default as AmlFinance } from "./AmlFinance";

export { default as AmlTransactions } from "./AmlTransactions";

export { default as AmlMonitoring } from "./AmlMonitoring";

export { default as AmlInvestigations } from "./AmlInvestigations";

export { default as AmlAustracReporting } from "./AmlAustracReporting";

export { default as AmlRecords } from "./AmlRecords";

export { default as AmlGovernance } from "./AmlGovernance";


export { default as AmlConfiguration } from "./AmlConfiguration";

