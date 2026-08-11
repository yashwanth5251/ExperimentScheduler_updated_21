# 2026-08 Requirements Pass — ROUND 5 Changelog

Supplements the round-1/2/3/4 changelogs. Covers the "Scheduling Engine
Update" document (unified config-driven validator, configurable scheduling
rules, automatic Blood Drawing validation, soft deletion).

## Setup

Run `initializeSpreadsheet` again (idempotent). New this round:
- A `SchedulingRules` sheet (created + seeded with the default overlap matrix).
- Soft-deletion columns (`Status`, `DeletedBy`, `DeletedOn`, `DeletionReason`)
  are auto-added to each data sheet the first time it is accessed — no manual
  migration needed. Existing rows are treated as active (blank Status).

No new triggers.

## Section-by-section

**1 & 2. Centralized, config-driven validator** — A single validator,
`validateSchedulingSlot_`, is now the only place overlap decisions are made.
It contains NO hardcoded overlap rules: for every time overlap it finds
against any slot type, it asks the configurable Scheduling Rules whether that
overlap is permitted, then applies:
  - overlap NOT allowed  -> ERROR (blocks), naming the conflicting slot, its
    type, the overlap period, and the assigned staff/TAs.
  - overlap allowed, SAME staff on both sides -> ERROR (blocks); requires a
    different staff member.
  - overlap allowed, a shared TA (Blood Drawing) -> ERROR (blocks); requires a
    different Technical Assistant.
  - overlap allowed, no staff/TA clash -> WARNING only (does not block).
Every scheduling workflow uses it: individual Day 1, individual Day 2, Build
Schedule, Bulk Scheduling, schedule editing, Blood Drawing creation, and
Blood Drawing editing. The previous behavioural call-sites reach it through a
thin `validateBehaviouralSlot_` shim so their existing result-shape keeps
working. Permitted-overlap warnings are now surfaced in the Build Schedule and
Bulk Scheduling result messages (previously only errors were shown).

**3. Configurable Scheduling Rules** — New `SchedulingRules` sheet plus a
"Scheduling Rules" section in Manage Roles. Each row is an unordered
experiment-type pair with an Overlap Allowed (YES/NO) flag. Seeded defaults:
MRI×MRI = No, MRI×Day1BeforeMri = Yes, MRI×Day2 = Yes, MRI×BloodDrawing = Yes,
Day1×Day2 = No, Day1×BloodDrawing = No, Day2×BloodDrawing = No,
BloodDrawing×BloodDrawing = No (plus sensible defaults for the remaining
pairs). The Main Admin can toggle any overlap permission, add new experiment
types, and delete custom types — all without code changes
(`getSchedulingRules` / `updateSchedulingRule` / `addSchedulingType` /
`deleteSchedulingType`). Built-in types can't be deleted (only their rules
changed). The validator reads exclusively from this config
(`getSchedulingRulesConfig_` / `isOverlapAllowed_`); unknown pairs default to
NOT-allowed (safe).

**4. Automatic Blood Drawing validation** — Because every Day 1 slot
auto-generates a linked Blood Drawing slot, the generated slot is now
validated through the same centralized validator at EVERY schedule-creation
state — including pushing MRI slots to the schedule (individual AND bulk).
`previewGeneratedBloodDrawingValidation_` runs inside
`createScheduleFromMriInternal_` (the shared core of individual scheduling,
push-to-schedule, and bulk), so a same-staff / same-TA Blood Drawing conflict
(or a not-permitted BD overlap) blocks creation with a clear error, and
permitted overlaps surface as warnings. `autoCreateBloodDrawingSlot_` also
validates on the actual create.

**5. Soft deletion** — No row is ever physically removed from a data sheet.
Each sheet carries `Status` / `DeletedBy` / `DeletedOn` / `DeletionReason`
columns (added by header name, so they work regardless of each sheet's
width). `getDataRows_` excludes soft-deleted rows from all normal reads by
default (with an `includeDeleted` flag for audit); `findSlotRow_` skips
deleted rows; `deleteSlotRow_` is now a soft delete. Converted every data
deletion — MRI / Day 1 / Day 2 / Blood Drawing slots, bookings, admin
accounts, and all cascade deletions (Day 1 deletion's linked Blood Drawing
cleanup, Day 2 cascade) — to soft deletion, preserving relationships for
audit. A new "Records & Audit" screen (Main-Admin only) lets the admin browse
any record type filtered by **Active / Deleted / All**, and restore a deleted
record (`getRecordsByStatus` / `restoreDeletedRecord`).

## Post-delivery fix

`previewDay1FromMri` — the endpoint powering the live "Conflicts with ..."
text under the Day 1 fields in the Build Schedule dialog — was a leftover
from before the round-5 rules engine and called the raw overlap scanner
directly, so it kept showing a hard block for Day1×Day1 overlaps even after
the admin set that pair to "Allowed" in Scheduling Rules (Save itself was
already correct; only the live preview was stale/misleading). Fixed by
routing it through the same `validateSchedulingSlot_` used by Save, so the
preview now shows a dismissible warning (does not disable Save) for
permitted overlaps and only a hard block for genuinely not-permitted ones or
an MRI-resize collision. The dialog now distinguishes the two visually
(`tag-bad` for blocking, `tag-warn` for informational).

## Post-delivery fix (extended audit)

What started as a report that Save stayed disabled after a permitted-overlap
warning turned into a full audit of every scheduling-validation code path,
because the root cause was systemic: **the round-5 configurable Scheduling
Rules engine had only been wired into some workflows.** Several pre-round-5
endpoints still made hardcoded overlap/staff decisions that never consulted
the Scheduling Rules config, so different parts of the app could disagree
with each other and with what Save would actually do.

**Client-side root cause of the reported bug**: `refreshScheduleSaveState_`
checked whether the Day-1 collision message element was merely *visible*
rather than tracking an explicit block state — since the (correct) warning
banner for a permitted overlap is intentionally shown, this tripped the same
gate as a real error and kept Save disabled. Fixed with an explicit
`state.day1Blocked` flag driven directly by the validator's `errors` array.

**Found and fixed, in the actual Save path (not just previews)**:
- `addMriSlot` (real MRI creation) — MRI×MRI was hardcoded, ignoring the
  Scheduling Rules; Blood Drawing wasn't scanned at all.
- `createScheduleFromMriInternal_`'s MRI-resize-during-save check — the live
  preview had been fixed but the actual save decision still called the old
  hardcoded `findMriMriOverlap_`, so the two could disagree.
- `createScheduleFromMriInternal_`'s existing-Day-2-selection loop — used
  legacy staff-busy/MRI-only checks instead of the centralized validator, and
  never checked full time-overlap against Day1/Day2/Blood Drawing at all.
- `createScheduleFromMriInternal_`'s new-Day-2 loop — ran redundant legacy
  checks alongside the correct ones, risking contradictory results.
- `getIndependentDay2Options` — hardcoded Day1×Day2 as always-blocking; since
  `createIndependentDay2Slot` returns immediately on this function's failure,
  a Scheduling Rules change could never even reach the correct check that
  runs afterward.

**Found and fixed in live previews** (so what you see while typing always
matches what Save will do): `previewDay1FromMri` (also now threads the
selected staff email — previously hardcoded blank, so a same-staff conflict
could never be detected pre-save), `previewMriSlot`, `checkSlotOverlap`,
`validateBulkMriSlots`, `getDay2SlotsInWindowForAdmin`.

**New/fixed UI behaviour**: the Day 1 staff dropdown now re-triggers
validation on change (previously it didn't, so switching staff never
re-checked for a same-staff conflict). New Day 2 rows' staff dropdown now
also triggers their live check (previously only the date/time fields did —
changing just the staff never re-validated). Existing Day 2 rows gained a
proper live, staff-aware, config-driven check (previously a static hint
computed once with no staff and never updated). All of these now show the
validator's own message text, which names the conflicting slot **and the
assigned staff member**, and gate Save on a real error vs. a mere warning.

**Dead code removed**: retired the entire old parallel "staff availability"
system (`checkStaffAvailability`, `findStaffConflicts_`,
`describeStaffConflicts_`) and an orphaned legacy manual Day1+Day2 creation
path (`addDay1SlotWithDay2_`) together with its unreachable helper chain
(`findOverlappingSlot_`, `findExperimentBlockingOverlap_`,
`findMriOverlapsForExperiment_`, `findStaffBusyConflicts_`,
`describeStaffBusyConflict_`) — all of it either fully unreachable or
superseded by the centralized `validateSchedulingSlot_` engine, and left in
place would have kept posing the same "two engines can disagree" risk.

## Scope boundaries (round 5)

- Configuration entries (Tasks, the Scheduling Rules rows themselves) are not
  data records and are still edited/removed in place — soft deletion applies
  to scheduling / booking / participant / assignment data as specified.
- Cascade deletions record `system` as the actor (they are automated), while
  direct user-initiated deletions record the acting admin where the actor is
  in scope.
- The `Day1BeforeMri` experiment type is available in the rules matrix for
  fine-grained control; a full Day 1 row validates as type `Day1` (its stored
  span already includes the pre-MRI period), and its own MRI slot is excluded
  from its overlap check so a slot never conflicts with itself.
