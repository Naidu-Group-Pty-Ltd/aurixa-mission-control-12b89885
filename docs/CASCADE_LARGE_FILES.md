# A file too large to hold is not a file too large to carry

Read this before changing `CASCADE_MAX_FILE_BYTES`, `blobStreamCarry.pure.ts`,
`copyBlobByStream` or the size rule in `convergence.pure.ts`.

## The sentence that was doing two jobs

`CASCADE_MAX_FILE_BYTES` has been 8 MB since 2 Sep 2026 and its reasoning was
right. `getFileContent` takes a blob whole — base64 inside a JSON envelope,
decoded to a buffer, decoded again to a string — and a 40 MB file is a 53 MB
response plus a buffer plus a string, inside a Worker isolate with 128 MB.
Measured that day: the pending cascade to `npc-client-dashboard` was 48 files,
one of them a 39 MB migration seed, and the pass died on that one file on
every attempt while a 55-file cascade with nothing large in it landed first
time. Holding the file was the fix and it was the correct fix.

The constant was called *"the most a cascade will carry in one file"*, and
that is one sentence answering two questions. **What an invocation can HOLD
and what a cascade can MOVE are different numbers.** Reading them as one
turned a memory limit into a delivery policy, and the delivery policy had no
remedy in it: `oversizeHold`'s own note said *"No approval can release a
ceiling — bring the file across by hand."*

Measured at `prime@cc530dfa`, 22 Sep 2026 — every tracked file over the
ceiling:

| bytes | path |
|---:|---|
| 41,780,944 | `…_seed_template_library_v16_verdict_and_running_head.sql` |
| 41,765,254 | `…_seed_template_library_v18_assessment_share_of_grade.sql` |
| 41,763,785 | `…_seed_template_library_v17_running_head_chapter_only.sql` |
| 41,700,544 | `…_seed_template_library_v15_running_head_and_columns.sql` |
| 41,678,125 | `…_seed_template_library_v14_tier_separation.sql` |
| 41,671,969 | `…_seed_template_library_v13_cash_flow_foots.sql` |
| 41,606,505 | `…_seed_template_library_v11_render_parts_conditional_rows.sql` |
| 41,598,555 | `…_seed_template_library_v12_guarded_verdict_line.sql` |
| 41,200,323 | `…_seed_template_library_v10_tier_identity_contents_figures.sql` |
| 41,006,340 | `…_seed_template_library_v9_report_part_numbering.sql` |
| 41,006,340 | `…_seed_template_library_v8_investment_narrative.sql` |
| 37,504,468 | `…_seed_template_library_v7_voice_disclaimer.sql` |
| 37,423,074 | `…_seed_template_library_v6_binding_fixes.sql` |
| 37,339,474 | `…_seed_template_library_v5_borrowing_capacity_portfolio.sql` |
| 9,180,921 | `docs/integrations/airtable/npc-emails/records/emails.source.json` |

Fifteen files, none over 40 MB, and **the last one is not a migration** —
which settles the question of whether this was a seed problem. It was not.
`docs/**` is a repository invariant, so that fixture is in scope for every
clone including the module-scoped one, and the migration lane that rescues a
seed into a clone's *database* has nothing to say about it at all.

Seven of the fourteen seeds were added in five days. **A remedy whose cost
grows with the fleet AND with the release cadence is not a remedy** — it is a
standing instruction to do the work by hand, four clones at a time, for ever.

## The lane

The bytes never have to enter the isolate.

```
prime  GET /git/blobs/{sha}   Accept: …raw+json     → raw bytes
       → base64 TransformStream                     → ASCII
       → {"encoding":"base64","content":"…"}        → streamed body
clone  POST /git/blobs                              → sha
```

`blobStreamCarry.pure.ts` owns every decision in it and holds at most one
chunk plus two carried bytes, whatever the file's size. The read half was
already proven: `fetchBlobTextStream` has streamed prime's blobs under the
same media type since the migration lane learned to chunk a seed.

Four properties make it safe to do at all.

**Base64 needs no JSON escaping.** The alphabet is `A–Z a–z 0–9 + / =` and
not one of those is a character JSON escapes, so the body is a literal
prefix, the encoder's own output and a literal suffix — nothing between them
has to be inspected.

**The length is arithmetic, not measurement.** base64 of `n` bytes is
`4 × ceil(n / 3)` characters, all single-byte, so `Content-Length` is known
before a byte moves. Without it the body goes out chunked, and a chunked POST
is a thing GitHub might refuse for reasons that would read as a transfer
failure. `blobRequestContentLength` is checked against the encoder's real
output at eight lengths, because a body that disagrees with its own header
fails on the wire with nothing saying which number was wrong.

**Padding means end of document.** base64 is defined on 3-byte groups and a
stream does not arrive in them, so each chunk encodes the largest 3-byte
aligned prefix it can and 0–2 bytes wait for the next one. A per-chunk
encoder pads at every boundary and produces a string that is well-formed
base64 and decodes to the wrong bytes — a failure nothing downstream could
see. The transform is checked against `Buffer` at thirteen chunk sizes from 1
to 8192, and the carry is *copied* out of the incoming chunk rather than kept
as a view, because a platform that reuses a read buffer would otherwise
rewrite bytes the transform still owed.

**A git blob is content-addressed, so the copy proves itself.** The sha is
`sha1("blob " + length + "\0" + bytes)` and depends on nothing else — not on
the repository. So the sha the clone returns must equal the sha prime holds,
and where it does not, the bytes differ. That is an exact check on a transfer
no part of this process ever looked at, and it costs nothing.

## The ceiling that is left

`CASCADE_STREAM_MAX_FILE_BYTES` is **40 MiB, and it is GitHub's number, not
ours**: past it the create-blob endpoint will not take the request, so there
is nothing to make. Saying so is the point — a file over it is refused by the
API rather than by a budget an operator could argue with, and the hold should
send them to the only remedy that exists.

It said 100 MB until 26 Sep 2026, read from the endpoint's documentation, and
the documentation is wrong about it. Measured against `npc-client-dashboard`,
where the lane had been carrying every seed since 22 Sep:

| seed | bytes | create-blob |
|---|---:|---|
| v16 | 41,780,944 | taken, landed byte-identical |
| v19 | 41,773,244 | taken, landed byte-identical |
| v20 | 42,195,218 | HTTP 422, *"Sorry, your input was too large to process"* |
| v21 | 42,246,310 | HTTP 422, every pass |
| v22 | 42,406,114 | HTTP 422, every pass |

40 MiB (41,943,040 bytes) sits between the largest file the endpoint has
taken and the smallest it has refused. A number that is too high is not
harmless headroom. At 100 MB each pass streamed about 127 MB into three
certain refusals. It spent its window on work that could never land, and the
hold told the operator the next pass would retry, so nobody moved the files.
And the auditor imports the ceiling (below), so it counted all three as owed
and would have escalated a healthy clone as stalled.

A file past this ceiling can still be **pushed**: git takes a file up to
100 MB. So the hold's remedy now depends on which side of that the file is. A
42 MB seed names the push from a local clone, and only a file past 100 MB is
told it has to become smaller or stay out of the tree.

`CASCADE_STREAM_BYTES_PER_PASS` is 128 MB and is pacing rather than policy.
`shouldStop` already reserves against the slowest file a pass has seen, and a
40 MB carry makes itself the slowest file — so after the first one the
ordinary budget takes over and this is never reached. It exists for the first
one, where the pass has no measurement to reserve against yet. Counted in
bytes rather than files because that is what costs the invocation: a 39.8 MB
seed and an 8.8 MB fixture are not the same work.

## What it does not change

**It does not raise what an invocation may hold.** `CASCADE_MAX_FILE_BYTES`
still governs every read that produces a string, and every judgement made on
a file's text — the spec membrane, the import closure, the stale-export
sweep — still runs on files under it. A streamed file crosses as bytes and is
judged by none of them, which is right for the shapes that reach this lane
(a seed, a fixture, an image) and is why the lane is not the default.

**It cannot make a cascade worse than it was.** The lane is reached only from
the refusal that already held the file, and every way it can decline returns
to that same hold. The floor is yesterday's behaviour.

**The hold is not deleted, it is narrowed** — and it now says which of two
states it is, because they send an operator opposite ways. Past GitHub's
ceiling: nothing retries it, no approval releases it, and a person pushes it
by hand or the file becomes smaller. A carry that failed: the next pass tries
again by itself, and telling somebody to copy it by hand there would have
them racing the engine for the same path.

## The auditor moved with it, and the danger reversed

`convergence.pure.ts` refuses to report a path as owed when the engine would
never deliver it — its own rule is *"the auditor must refuse exactly what the
engine refuses."* That rule is unchanged; **which ceiling satisfies it is
not.**

While the engine refused at 8 MB, an auditor refusing later would have
reported debt nobody could discharge — two seeds reading `delivering` for
ninety minutes and then `stalled`, permanently, on a fleet behaving exactly
as designed. Now that the engine streams, an auditor still refusing at 8 MB
does the opposite and worse: a 41.7 MB seed that has **not** crossed scores
as *not owed*, and a clone genuinely missing fourteen files measures as
converged. Concealing a gap is the failure this reading exists to stop, so
the number here is the one the engine actually refuses at.

## What shipped against

Measured 22 Sep 2026, after the by-hand carry earlier the same day: prime
holds 1,026 migrations and every clone holds all of them —
`npc-client-dashboard` 1,026, `npc-crm-independent` 1,027 (one of its own),
`npc-test-76b3b3` 1,026, `preflight-property-group` 1,026, zero missing on
any of them. **So this delivers no backlog.** What it changes is the next
one: the fifteenth oversized file, and every one after it, travels without
anybody being told to carry it.
