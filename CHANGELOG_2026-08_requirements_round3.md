# 2026-08 Requirements Pass — ROUND 3 Changelog

Supplements the round-1 and round-2 changelogs. Covers the 6-section
"Bulk Scheduling / simplified rules / responsive dialog" document.

## Setup

No new sheets, columns, or triggers. Paste the files in and redeploy the
web apps. (If you skipped round 2's `initializeSpreadsheet` run, do it once.)

## Section-by-section

**1. Rename to "Bulk Scheduling"** — Renamed everywhere: the dashboard
button, the dialog heading, and internal identifiers/comments. No
occurrences of the old name remain.

**2. Bulk = Individual parity** — Instead of maintaining a second scheduling
UI (which would inevitably drift), the Bulk Scheduling workflow now *reuses
the actual individual scheduling dialog*. After the MRI slots are saved,
each row in stage 2 has a "Configure…" button that opens the exact same
`Build Schedule` dialog in a new "configure-only" mode, where Save captures
the configuration instead of committing it. "Push Selected to Schedule"
then submits every captured configuration through the same
`bulkCreateSchedulesFromMri` → `createScheduleFromMriInternal_` path used by
individual scheduling, in one transaction. Because it is literally the same
dialog and the same server code, bulk automatically has: Day 1 config, Day 2
config, compatible Day 2 slot selection, Day 1/Day 2 staff assignment, all
validation messages, all scheduling conflicts, and the schedule preview.
Blood Drawing staff + TA are auto-assigned by the existing round-2
`autoCreateBloodDrawingSlot_`/`autoAssignBloodDrawingStaffAndTA_` path that
fires whenever a Day 1 slot is created (including via bulk), so those
assignments happen for bulk exactly as for individual scheduling. A shared
`collectSchedulePayload_()` guarantees both paths build an identical payload.

**3. Simplified scheduling rules** — All previous overlap rules were replaced
by a single validator, `validateBehaviouralSlot_()`:
  - **MRI vs MRI** — always an error; the MRI slot cannot be created
    (enforced in `addMriSlot` and bulk MRI validation).
  - **Behaviour vs Behaviour** — always an error, for available, booked,
    and unbooked slots alike, regardless of staff. ("Behavioural" = Day 1,
    whose stored span already includes the 90-minute pre-MRI period, and
    Day 2.)
  - **Behaviour vs MRI** — a warning only (never blocks), showing the MRI
    slot, the behavioural slot, the overlapping slot's assigned staff, and
    the time of overlap — EXCEPT that if the same staff member would be on
    both sides, it becomes an error requiring different staff.
Removed as part of this: round-1's "behavioural overlap is OK if the staff
differs" rule, and round-2's "pre-MRI window must not hit another MRI slot"
hard block (and its now-dead `evaluateMriPrewindowConflict_` function).

**4. Individual = Bulk rules** — Both workflows call the same
`validateBehaviouralSlot_()`, so they are functionally identical by
construction. The independent Day-2 creation path was also routed through
the same validator. A redundant per-staff MRI-window pre-check that used to
run before the main validation in the schedule path was removed, so the
rule set is applied exactly once, consistently.

**5. Day 2 time-selection clipping** — Root cause: the `.day2-row` layout was
a rigid `grid-template-columns: 1fr 1fr 1fr auto auto`. Grid items default
to `min-width: auto`, so inside the width-capped dialog the `1fr` tracks
couldn't shrink below their inputs' intrinsic width, and the trailing
`auto` columns pushed the Day 2 time controls outside the visible panel.
Replaced with an auto-fit grid (`repeat(auto-fit, minmax(150px, 1fr))`) plus
explicit `min-width: 0` and `width: 100%` on the row's children, so every
control shrinks and wraps instead of clipping.

**6. Responsive scheduling dialog** — The scheduling dialog got its own
`.modal-schedule` class: a wider cap (`min(900px, 96vw)`), grows vertically
with its content up to `calc(100vh - 40px)` then scrolls internally rather
than clipping. The two Day 2 lists (existing compatible slots, and new Day 2
rows) scroll inside themselves (`max-height` + `overflow-y: auto`) so they
can never push content out of view. The Cancel/Save action bar is sticky to
the bottom of the dialog so it stays visible no matter how much is shown.
The mobile media query was extended for the new class.

## Notes / scope

- Editing/deleting MRI slots "before submission" (spec #1) is supported in
  stage 1 via each row's Remove button and re-validation; once slots are
  committed in stage 1 they become real MRI slots managed through the normal
  MRI overview (delete/reschedule) rather than the bulk grid.
- The bulk stage-2 "Configure" step reuses the individual dialog one MRI slot
  at a time (open, configure, save-config, next), which keeps behaviour
  identical to individual scheduling; configurations accumulate and are then
  pushed together in a single transaction.
