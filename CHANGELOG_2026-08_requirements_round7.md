# 2026-08 Requirements Pass — ROUND 7 Changelog

Supplements the round-1 through round-6 changelogs. Covers the 13-section
"Required Fixes and Changes" document (MRI-time Blood Drawing creation,
Edit Schedule consolidation, Blood Drawing TA reassignment, participant
confirmation/cancellation ↔ Blood Drawing linkage, the TA Availability
Portal, and a systemic exact-change/blank-field email bug touching MRI
deletion, Day 1 deletion, and booking unbooking).

Several sections of the source document turned out to already be fully
implemented in earlier rounds — most notably the three-PDF export
(section 7) and multi-MRI "push to schedule" (section 2, including the Day
2 Session Language field) — and needed no changes. This round focuses on
what was actually missing or broken.

## Setup

No new sheets. One schema addition: `BloodDrawingSlots` gains an
`MRISlotID` column, added automatically (by header name, via the same
`ensureNamedColumn_` pattern already used for the soft-delete columns) the
first time it's needed — no manual migration, existing rows are unaffected.

No new triggers.

## 1. MRI Slot Created

Blood Drawing slot creation moved from schedule/Day 1 creation to MRI
creation. `bulkCreateMriSlots` (the only MRI-creation entry point — see
round 10's note that single-slot creation was removed) now calls
`autoCreateBloodDrawingSlotForMri_` for every MRI slot it writes: the
Blood Drawing slot covers the first `BLOOD_DRAWING_DEFAULT_MINUTES` (30)
minutes of where Day 1 would start by default — i.e. the first 30 minutes
of the (default 90-minute) "time required before MRI" window — computed
straight from the MRI's own start time and offset, since no Day 1 slot
exists yet. It runs the existing TA-availability rule
(`findAvailableNonConflictingTA_`, same one used everywhere else) and
auto-assigns a TA if one is free at that time, else leaves it Unassigned.
The MRI slot itself is still emailed per the Email Control Matrix
(`mriSlotCreated`, unchanged); Blood Drawing assignment results are
batched into the same consolidated notice as the rest of the bulk
operation (`notifyBloodDrawingAssignmentsBatch_`), not emailed per slot.

When an MRI slot is later pushed into a full schedule (`createScheduleFromMriInternal_`,
i.e. Build Schedule / Push to Schedule), it no longer creates a second
Blood Drawing slot — `linkOrCreateBloodDrawingForSchedule_` finds the one
already created at MRI-creation time (via the new `MRISlotID` link),
attaches it to the new Day 1 slot, and:
- if the actual Day 1 start still matches what was assumed at MRI-creation
  time, just records the Day 1 staff member as the default Blood Drawing
  staff and leaves the TA/calendar event alone;
- if the admin used a non-default "Time Before MRI" so the time actually
  shifted, moves the slot and re-runs the TA-availability check at the new
  time.
Legacy MRI slots created before this round (with no linked Blood Drawing
slot) fall back to the old create-on-push behaviour, so nothing breaks for
existing data.

`deleteMriSlot` (an unused/unpushed MRI slot) now also removes its linked
Blood Drawing slot if it's still unbooked, so no orphan is left behind.

## 2. Push MRI Slots to Schedule / Build Schedule

Already fully implemented — no changes. `bulkCreateMriSlots` +
`renderBulkMriPushTable_`/`onPushBulkMriToSchedule_` already let an admin
select multiple validated MRI slots, configure each one with the full
individual scheduling dialog (Session Language included, for both existing
and newly-created Day 2 rows), and push them all into the schedule in a
single `bulkCreateSchedulesFromMri` transaction with one consolidated set
of notifications. "Could not save the schedule." / success-path emails per
the Email Control Matrix were already in place from round 12/13.

## 3. Edit Schedule

**Day 1 time is now locked.** `editDay1Slot` no longer accepts
date/start/duration — only Session Language. Overlap/scheduling
validation still runs on the slot's current time (in case the Scheduling
Rules matrix itself changed since the slot was created). The email is now
an exact-change diff (see section 8).

**Consolidation.** The separate "Edit" (date/time/duration/language) modal
that sat next to "Edit Schedule" on the Day 1/Day 2 tables has been
removed entirely; its fields (Day 1 Session Language; Day 2 date/start/
duration/Session Language, still unbooked-only) now live inside the Edit
Schedule modal alongside Day 1/Day 2/Blood Drawing staff and TA
reassignment — one entry point per row for every edit function, per the
spec. Saving still validates and applies staff/TA reassignment atomically
via `saveScheduleEdits` first, then applies whichever slot-level field
edits actually changed via the existing (already-atomic, already-diff-
emailing) `editDay1Slot`/`editDay2Slot` endpoints, surfaced to the admin as
one Save action.

**Staff Reassignment** was already living in Edit Schedule /
`saveScheduleEdits` (round 12) with full overlap/commitment validation
before saving and matrix-routed notification to both the previous and new
assignee — no changes needed there.

## 4. Blood Drawing TA Assignment

Editing the Blood Drawing TA list from Edit Schedule already validated
overlapping commitments via the centralized validator; it's now extended
to also check the new TA's *submitted availability*
(`taHasSubmittedAvailability_`, checked against the TA Availability
Portal's own records) — surfaced as a non-blocking warning, since an
admin's direct reassignment is a deliberate override, not something that
should be silently refused.

The previous-TA / new-TA notification is now its own dedicated
notification (`notifyBloodDrawingTAReassignment_`), routed through the
existing `bloodDrawingReassignment` Email Control Matrix entry —
independent of the generic `staffReassignment` event the rest of Edit
Schedule's staff changes use. Each removed TA is told they were
unassigned; each newly-added TA is told they were assigned; everyone else
resolved for the event (Main Admin, etc.) gets one broadcast summarizing
both lists.

## 5. Participant Confirmation

When a booking is confirmed — participant self-service (`submitBooking`)
or admin-created (`adminCreateBooking`) — the linked Blood Drawing slot
(found via its Day 1 slot) is now automatically updated:
`linkBloodDrawingToBooking_` adds the Booking ID and flips it from
Available to Booked. Previously this never happened at all (an explicit
comment in the old code said the tie-in "isn't needed here" — it is, per
this spec). TA/staff assignment on the Blood Drawing slot is left
untouched — an independent axis from "is a participant attached to it."

## 6. TA Availability Portal

The admin-only "Book Slot(s) (assigns Technical Assistant(s))" section is
gone, replaced by a self-service **My Blood Drawing Availability** panel:
- `getTABloodDrawingAvailabilitySlots` lists every upcoming Blood Drawing
  slot with its Booking ID, other assigned TA(s), and whether the calling
  TA is already on it.
- A checkbox per row lets a TA tick/untick as many slots as they like;
  nothing is sent to the server until **Save All Changes**.
- `saveTABloodDrawingAvailability` applies every change in one locked
  operation — adding/removing the calling TA from each slot's TA list,
  updating the Blood Drawing calendar event, and (per the spec) generating
  a Booking ID automatically for any slot that doesn't have one yet when
  the TA claims it.
- One consolidated email is sent for the whole save
  (`notifyTABloodDrawingAvailabilityBatch_`), routed through the existing
  `taAvailabilitySubmitted` Email Control Matrix entry — never one email
  per slot.
- "Participant Confirmation Number" is gone from this part of the portal;
  every reference is now "Booking ID," matching the rest of the app.

Admin-side TA (re)assignment on someone else's behalf remains in Edit
Schedule (section 4) — this portal is specifically the TA's own
self-service view, per the spec's "portal for Technical Assistants."

## 7. PDF Export

Already fully implemented — no changes. `generateCombinationsPdfSet`
already produces three separate, participant-facing, staff-free PDFs:
English-only, German-only, and "no language restriction" (both languages,
matching every available slot regardless of tagging).

## 8. Edit/Update Emails

Added a shared `diffLines_()` helper — given a list of
`{label, oldVal, newVal}` fields, returns one `Label: old → new` line per
field that actually changed, matching the spec's own example format
exactly. Applied to `editDay1Slot` (Language) and `editDay2Slot`
(Time, Language). Staff/TA reassignment notifications (`notifyStaffReassignment_`,
`notifyBloodDrawingTAReassignment_`) already state old/new explicitly.

**Root-cause fix**, closing sections 8/9/11 together: several email
templates (`mriSlotDeleted`, `scheduleDeleted`, `bookingCancelled`,
`bookingUnbooked`, `bookingRescheduled`, `staffReassignment`) referenced
named placeholders (`{{MriSlot}}`, `{{AdminName}}`, `{{BookingID}}`,
`{{ParticipantName}}`, `{{Day1Slot}}`, `{{Day2Slot}}`) that the functions
actually sending them (`notifyAdminOfChange_`, `notifyScheduleDeleted_`,
`notifyBookingChange_`) never populated — they only ever substitute
`{{Details}}`. Every missing placeholder silently resolves to an empty
string, so these fields rendered **blank** in the sent email — exactly the
defect sections 9 and 11 describe, and a real risk for section 8's "must
contain exactly what changed" requirement generally. Fixed by switching
these six templates to the same `{{Details}}`-based pattern already used
successfully for `day1SlotDeleted`/`day2SlotDeleted`/`bloodDrawingSlotDeleted`
(round 10), and enriching each call site's detail lines so the
concrete facts are always present (see sections 9–12 below). The
participant's own transactional confirmation/cancellation emails
(`sendConfirmationEmail_`, the inline body in `cancelBookingCore_`) were
unaffected by this bug — they build their own bodies directly and were
already correct.

## 9. MRI Slot Deletion Email

`deleteMriSlot`'s notification now spells out the MRI ID, Date/Time, and
"Deleted by" explicitly in its detail lines (previously these were meant
to come from the now-fixed `{{MriSlot}}`/`{{AdminName}}` placeholders,
which never populated):

```
MRI slot MRI-001 has been deleted.
Date/Time: 2026-08-15 09:00–10:30
Deleted by: Jane Admin
```

## 10. Day 1 Slot Deletion

Already fully implemented via `deleteDay1Slot`/`cleanUpLinkedBloodDrawingSlots_`
(round 4/5/11): cascades to orphaned Day 2 slot(s), soft-deletes the
linked Blood Drawing slot, releases the linked MRI slot back to Available,
and the notification already named all of that. Reformatted this round to
match the spec's literal example shape exactly:

```
Day 1 slot D1-001 has been deleted.

Day 2: D2-001
MRI: MRI-001
Deleted by: Main Admin
```

(Day 2 shows "(none affected)" and MRI shows "(none)" rather than being
omitted, so the line is never silently missing.)

## 11. Booking Unbooked

`handleBookedDay1Slot`'s `unbook` action now includes the Booking ID (a
field the summary previously never captured at all) as the literal
opening line, plus Day 1/Day 2/MRI/participant details:

```
Booking ID BK-001 has been removed from the schedule.

Booking ID: BK-001
Day 1 slot: D1-001
Day 2 slot: D2-001
MRI slot: MRI-001
Participant: Jane Doe
Actioned by: Jane Admin
```

(The bilingual German line — "Buchungs-ID BK-001 wurde aus dem Zeitplan
entfernt." — comes from `bilingualBody_`'s existing German-first
convention.) Also returns the linked Blood Drawing slot to Available (see
section 12) and calls the new Main-Admin-unconditional calendar-deletion
notice if a calendar event was actually removed (see section 13).

## 12. Booking Cancellation

Previously, cancelling or unbooking a booking updated only the Day 1/Day 2
slots and the participant calendar — the linked Blood Drawing slot was
never touched. Two new helpers close this gap:
- `linkBloodDrawingToBooking_` (section 5) — Available → Booked + Booking ID.
- `unlinkBloodDrawingFromBooking_` — clears the Booking ID/participant
  tie-in and returns the slot to Available (its TA/staff assignment is
  left in place, ready for the next participant routed to that Day 1
  slot).

Wired into `cancelBookingCore_` (participant/admin cancel),
`handleBookedDay1Slot` (unbook and permanent-delete), and
`rescheduleBookingCore_` (when Day 1 itself changes — unlinks the old Day
1's Blood Drawing slot, links the new one's). Calendar events and
notifications continue to route through the existing, matrix-governed
paths; `cancelBookingCore_`'s admin-facing detail lines now also include
the linked MRI slot.

## 13. Calendar Deletion Notifications

New `notifyMainAdminCalendarEventDeleted_(summaryLine, actionRecipients)`:
sends a short, unconditional notice to the Main Admin whenever a real
(non-empty) calendar event is deleted, skipping the send if the Main Admin
is already among the recipients resolved for that action's own
matrix-governed notification (so nobody gets a duplicate for the same
event). Wired into the genuine deletion endpoints — `deleteMriSlot`,
`deleteDay1Slot`, `deleteDay2Slot`, `deleteBloodDrawingSlot`,
`cleanUpLinkedBloodDrawingSlots_` (Day 1's cascade removal of its Blood
Drawing slot), and both branches of `handleBookedDay1Slot` (unbook and
permanent delete) — deliberately NOT into calendar-event *moves*
(reassignment's delete-then-recreate cycle inside `upsertStaffCalendarEvent_`),
which are not a "deletion" from the admin's point of view and would
otherwise spam this notice on every reassignment.

## Post-delivery update: "poll grid" layout for the TA Availability Portal

Per an explicit follow-up request with a reference screenshot, the TA
Availability Portal (section 6) was redesigned from a simple checkbox list
into a doodle-poll-style grid, matching that reference:
- A three-tier header — Month → Day → individual time-slot — built from
  every upcoming Blood Drawing slot (`getTABloodDrawingAvailabilityGrid`,
  replacing `getTABloodDrawingAvailabilitySlots`).
- One entry row directly under the header: the logged-in TA's name (shown
  read-only — availability is recorded against their authenticated
  account, not a free-typed name) plus one checkbox per slot column,
  pre-filled from their current assignments.
- A **Submit** button applies every ticked/unticked change together via
  the existing `saveTABloodDrawingAvailability` (one operation, one
  consolidated email — unchanged from the original section 6 work).
- Below that, a read-only matrix with one row per known Technical
  Assistant (green check / red cross per slot, calling TA's row pinned
  first) and a **Totals** row summing how many TAs are available per slot
  — giving every TA visibility into the whole team's coverage, not just
  their own picks.
- Left/right arrow buttons scroll the grid horizontally (the sticky
  left-hand name column stays in view while scrolling), since the slot
  list can run wider than the modal.

## Post-delivery update 2: Day 1 language clarity + multi-select push from the main MRI Slots table

Two follow-up requests, with reference screenshots of the individual
"Add to Schedule" dialog and the main MRI Slots panel:

- **Day 1 Session Language** was already present in the individual
  scheduling dialog (`schedLanguageSelect`, wired to `createScheduleFromMri`'s
  `language` field) — it just sits in the Day 1 section, above where the
  screenshot was scrolled to (Day 2). Relabeled it "Day 1 Session Language"
  (was "Session Language") so its scope is unambiguous at a glance.
- **Multi-select push from the main MRI Slots table.** Previously, pushing
  several MRI slots to schedule in one transaction was only reachable by
  creating them fresh inside the "Add MRI Slots" bulk-creation modal. Now
  the main MRI Slots panel (the always-visible "today onward" table) has a
  checkbox per available row and a **Push Selected to Schedule** button;
  ticking any number of existing slots and clicking it jumps straight into
  the exact same "Configure & Push to Schedule" step the bulk-creation flow
  already used — same per-slot configuration dialog (including Day 1
  Session Language), same validation, same single-transaction
  `bulkCreateSchedulesFromMri` push, same consolidated notifications. The
  "Add MRI Slots" modal's step 2 UI is reused as-is for this entry point
  (its step 1 "create new slots" section is simply hidden), so there are
  no new server functions and no duplicated logic — this is purely a new
  front-end entry point into functionality that already existed.

## Scope boundaries (round 7)


- Sections 2 and 7 needed no code changes — verified against the existing
  implementation and found already correct, including edge details (e.g.
  the "no language preference" PDF correctly includes every available
  slot regardless of language tag, not just untagged ones).
- The old `bookBloodDrawingSlot`/`bulkBookBloodDrawingSlots`/
  `cancelBloodDrawingBooking` server functions are no longer called from
  any UI (their panel was replaced per section 6) but are left in place
  rather than deleted, since removing working, still-referenceable server
  code isn't necessary to satisfy the spec and risks breaking anything
  that might call them directly.
- `taHasSubmittedAvailability_` (section 4) is a warning, not a hard
  block — an admin's direct Edit Schedule reassignment is treated as an
  authoritative override of a TA's own generic availability submission,
  consistent with how Edit Schedule already treats direct staff
  reassignment.
