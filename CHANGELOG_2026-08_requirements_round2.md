# 2026-08 Requirements Pass — ROUND 2 Changelog

This supplements `CHANGELOG_2026-08_requirements.md` (the first 11-section
pass). It covers the second, 14-section requirements document.

## Setup after uploading this version

1. Paste all files into the Apps Script project (same names as before).
2. Run `initializeSpreadsheet` again. It's idempotent — existing sheets/data
   are untouched; it only adds what's missing:
   - Three new sheets: `GenderOptions`, `Tasks`, `PostExperimentRecords`.
   - Three new columns on `Bookings`: `Gender`, `FirstName`, `LastName`.
   - One new column on `BloodDrawingSlots`: `AssignedStaff` (independent of
     `AssignedTA`).
   - Seeds `GenderOptions` and `Tasks` from `CONFIG.GENDERS_DEFAULT` /
     `CONFIG.DEFAULT_TASKS` if empty.
3. No new triggers to install for this round.

## Section-by-section

**1. Participant Registration** — Booking forms (participant + Admin Create
Booking) now collect Title, Gender (configurable dropdown, editable via
`updateGenderOptions`), First Name, and Last Name separately. The
previously-existing combined `Name` column is kept and populated
automatically (`FirstName + ' ' + LastName`) so every existing email/
calendar/admin-list code path that already reads `.NAME` keeps working
unchanged — Gender/FirstName/LastName are additive, not a breaking rename.
Email remains optional only via the Admin Booking Portal, as before.

**2. Role & Task Management** — New `Tasks` sheet-backed system
(`getTasksConfig`/`createTask`/`updateTaskRoles`/`deleteTask`,
MainAdmin-only via the `manage_roles` permission), editable from a new
"Task Management" section inside the Manage Roles screen. `roleCanPerformTask_`/
`requireTask_` exist as the enforcement primitives.
*Scope note:* the infrastructure is fully wired and persisted, but — given
the size of this pass — actual `requireTask_()` calls were not added
throughout every existing endpoint; the existing permission system
(`requirePermission_`) remains the primary access-control layer. Treat Task
Management as an additive, configurable catalog layered on top, ready to be
wired into specific endpoints as needed.

**3. Slot Creator Information** — New `creatorDisplayName_()` strips the
email off a stored "Name <email>" provenance string. Day 1 and Day 2
overview tables now have a "Created By" column showing the name only; the
MRI table's existing "Created By" column was switched from the raw
string to the clean name. Emails are never sent to the client for this
field outside Manage Admins.

**4. Email Subjects** — New `EMAIL_SUBJECTS_` map + `emailSubject_()`
helper, using the exact subject lines from the spec's list. Wired into
every relevant notification: booking confirmation/reschedule/cancel,
admin-created bookings, schedule created/updated/deleted, staff
assignment/reassignment, Blood Drawing assignment/availability, and both
reminder emails.

**5. Day 1/Day 2/MRI Scheduling Rules** — Generalizes round 1's staff-aware
overlap rule. The only two conditions that still block schedule creation:
(a) the same staff member double-booked across overlapping behavioural
experiments (unchanged from round 1), and (b) a slot's "Time Required
Before MRI" window colliding with another MRI slot's own reserved time
(new: `evaluateMriPrewindowConflict_`, wired into single MRI creation,
single schedule creation, and bulk MRI validation). Every other overlap —
different-staff behavioural conflicts, MRI-vs-experiment overlaps outside
the prep window — is warning-only and never disables the Create button.

**6. Terminology** — "Teaching Assistant" replaced with "Technical
Assistant" everywhere it appeared (code comments, Admin Portal UI, emails).
The "(TA)" abbreviation and all `TA`-prefixed identifiers/role names are
unchanged, per the spec's own phrasing.

**7. Blood Drawing Dual Assignment** — `BloodDrawingSlots` now has an
independent `AssignedStaff` column alongside `AssignedTA`. New
`assignBloodDrawingStaff()` edits it independently (its own permission
check, its own calendar-guest/colour sync, its own dedicated notification).
The Blood Drawing Portal has two separate subforms — "Assign Staff" and
"Book a Slot" (TA) — so either can be changed without touching the other.

**8 & 13. Bulk MRI Creation / Scheduling** — New two-stage "Bulk MRI
Scheduling" screen:
- Stage 1 (`validateBulkMriSlots`/`bulkCreateMriSlots`): add any number of
  candidate MRI slots (date, start, duration, time-before-MRI), validate
  them together — each independently *and* cross-checked against each
  other in the same batch — with inline pass/fail shown per row, fix
  invalid ones without touching the rest, then save all in one
  transaction with one consolidated Main Admin email.
- Stage 2 (`bulkCreateSchedulesFromMri`): select some or all of the
  newly-created MRI slots, assign Day 1 + Day 2 staff per row, and push
  them into full schedules (Day 1, a new Day 2 slot ~24h later, and the
  auto-created Blood Drawing slot) in a single transaction, stopping
  cleanly (nothing partially committed) if any entry fails, with one
  consolidated notification at the end.
*Scope note:* stage 2's Day 2 slot is always newly created at a fixed
~24h-later offset with matching duration — there's no UI to pick an
*existing* Day 2 slot per row in bulk mode (the single-schedule screen
still supports that). This keeps the bulk workflow's per-row UI compact;
extending it to mirror the full existing/new Day 2 picker would be
straightforward but was out of scope for this pass.

**9. Blood Drawing Notifications** — `notifyBloodDrawingChange_` (Main
Admin + assigned Staff + assigned TA, deduplicated) fires on every
assignment/booking change. `notifyTAsOfNewMriSlots_` emails every active TA
when new MRI slots are created (both single and bulk), prompting them to
submit Blood Drawing availability.

**10 & 11. Post-Experiment Updates & Records** — New "Post-Experiment
Updates" screen: one row per booked participant, four completion
checkboxes (Day 1 / Blood Drawing / MRI / Day 2) plus a comments field,
independently editable, saved via `updatePostExperimentRecord` — which
deliberately sends no emails or notifications. Records live in a new
dedicated `PostExperimentRecords` sheet (`findOrCreatePostExperimentRecord_`
populates a row lazily from current Bookings/slot data the first time a
booking is touched, then only the completion fields + comments are
updated after that — so it captures a snapshot of assignments at that
point rather than continuously re-syncing if staff are later reassigned).

**12. Automatic Blood Drawing Assignment** — Extends round 1's
auto-created-on-Day-1-creation Blood Drawing slot: `autoAssignBloodDrawingStaffAndTA_`
now also defaults the Blood Drawing Staff to the Day 1 staff member and
tries to auto-assign an available TA via `findAvailableNonConflictingTA_`,
which checks submitted TA availability for that date/time window *and*
excludes TAs already assigned to another overlapping Blood Drawing slot.
If no TA is available, the slot is left unassigned, the Main Admin is
emailed immediately, and — because it's simply an unassigned Blood Drawing
slot — it's automatically picked up by the existing Monday/Wednesday
reminder (`sendBloodDrawingAssignmentReminder_`) with no separate code
path needed.

**14. Responsive UI** — All ten admin tables (Day 1/2/MRI overview,
Bookings, Blood Drawing, TA Availability, Post-Experiment, Bulk MRI ×2,
Manage Admins) are now wrapped in a horizontally-scrolling container
instead of overflowing their panel. Every modal sizes itself to content up
to `min(640px, 96vw)` wide / `calc(100vh - 40px)` tall with internal
scrolling — never taller or wider than the viewport. `.form-row` switched
from a fixed 3-column grid to `auto-fit`, so fields naturally wrap on
narrow screens instead of squeezing. Form inputs/selects fill their
container width. The mobile media query was expanded to stack the
dashboard header/action buttons, tighten modal padding, and let buttons
and validation banners wrap instead of overflowing. On the participant
side, a real bug from round 1 was caught and fixed here: the Title (and
now Gender) `<select>` elements had no CSS rule at all and were rendering
as unstyled, narrower browser-default dropdowns next to styled text
inputs — a `select` rule matching the existing input styling (full width,
same border/radius/focus state) was added.

## Known scope boundaries (round 2)

- Task Management's enforcement (`requireTask_`) is implemented but not
  threaded through every existing endpoint — see section 2 above.
- Bulk scheduling's Day 2 slot is always new, not pickable from existing
  slots — see sections 8/13 above.
- As in round 1, the new screens (Blood Drawing dual-assignment forms,
  Task Management, Post-Experiment Updates, Bulk MRI Scheduling) are fully
  functional but simpler than the most polished existing screens — no
  live inline conflict-checking widgets beyond what's described above.
