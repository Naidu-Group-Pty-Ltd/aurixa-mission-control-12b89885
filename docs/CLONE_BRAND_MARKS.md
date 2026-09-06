# The marks a workspace prints

A provisioned workspace needs **six** brand marks. Four dress the interface and
two are for paper, and they are read out of two different places — which is how
a workspace came to look fully branded while every document it generated came
out with no mark on it at all.

| Mark | `BrandConfig` field | `whitelabel_settings` column | `logo_config` key |
|---|---|---|---|
| Logo | `logo_light_url` | `auth_logo`, `sidebar_logo` | `auth`, `sidebar` |
| Logo (dark variant) | `logo_dark_url` | — | — |
| Icon | `icon_url` | `sidebar_icon` | `sidebarIcon` |
| Favicon | `favicon_url` | `favicon` | `favicon` |
| Report mark | `report_logo_url` | — | `report` |
| Report mark — knockout | `report_logo_mono_url` | — | `reportMono` |

`src/server/branding/marks.ts` is that table. The brand-profile editor draws its
uploads from it, the cascade derives both its column writes and its
`logo_config` keys from it, and `sql.test.ts` pins it against the key set the
workspace's own renderer reads.

## The two faults this closes

**The cascade filled the columns and never the map.** `assets.pure.ts` resolves
a document's mark out of `whitelabel_settings.logo_config`, walking
`report → sidebar → auth → sidebarIcon`. The cascade deliberately never wrote
that column — for a good reason, that pouring the whole bundle into a column
nine renderers parse would replace their schema with a foreign one. So the
sign-in page and the sidebar carried the right logo and every PDF was unmarked.
The rule that lets it be written now is the same one that governs the columns
beside it: the **named** keys above, merged one at a time, and nothing else. A
key the workspace set for itself, and a key this platform has never heard of,
both survive.

**Assets were mirrored into a bucket that does not exist.** The apply pipeline
passed `cloneBucket: "branding"`. The prime's bucket is `branding-assets`,
public, and so is every clone's, because a clone is built from the prime's
schema. Storage answers `404 Bucket not found`, mirroring is best-effort by
design, and so the brand applied with every asset silently dropped and the
cascade reported success. The bucket is named once now
(`mirror.ts` → `CLONE_BRAND_BUCKET`), a missing bucket is reported in those
words rather than as one failure among many, and a test asserts the pipeline
passes the constant rather than a literal beside it.

## Where an operator does this

Uploads live on a **brand profile** (`/branding`) because a profile can serve
several workspaces. Applying is per workspace, from the **Brand marks** section
on the clone's own page, which lists the six, says which are set, and reports
how many marks actually reached the workspace rather than only that the apply
succeeded.

`/clones/new` carries the same section as an explanation and no upload: there is
no workspace to copy the files into until provisioning has given it a backend.

## Two things that are deliberately not here

**`logo_dark_url` is cascaded nowhere.** "Logo (dark)" means the dark lockup for
a light ground in half the brand kits that ship one and the knockout lockup for
a dark ground in the other half. `reportMono` prints on the cover's obsidian
ground, where guessing wrong renders an invisible mark on a client's document.
The knockout has a slot of its own that says what it is for; the ambiguous field
keeps its place in the bundle and reaches no column.

**A missing mark is not an error.** The renderer's fallback chain means a
workspace with only a sidebar logo still gets a branded document. Every row says
what the mark is for and whether it is set; nothing blocks, and nothing is
inherited from another deployment — a workspace that has uploaded no mark gets
no mark rather than somebody else's.
