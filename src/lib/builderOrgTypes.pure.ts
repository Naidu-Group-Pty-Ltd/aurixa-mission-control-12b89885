/**
 * The organisation kinds the Builders Network stores, in one place.
 *
 * `builder_organisations.org_type` is NOT NULL with no default and a CHECK
 * over four values. Three surfaces name them — the console's create/edit
 * dialog, the access-applications panel, and the public application form on
 * the Aurixa Systems site — and the first two are here.
 *
 * The third cannot be: it is another repository and another deployment, so
 * its copy is a deliberate duplicate at a boundary rather than an accident.
 * What keeps the two honest is that the NETWORK refuses a value outside its
 * own list (`org_type_is_not_recognised`), so a list that drifts produces a
 * named refusal rather than a row nobody meant.
 */
export const ORG_TYPE_LABEL: Record<string, string> = {
  builder: "Builder",
  developer: "Developer",
  builder_developer: "Builder & developer",
  sales_representative: "Sales representative",
};
