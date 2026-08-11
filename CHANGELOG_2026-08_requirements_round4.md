# 2026-08 Requirements Pass — ROUND 4 Changelog

Supplements the round-1/2/3 changelogs. Covers the 9-section document
(multi-TA Blood Drawing, unified validation, combinations PDF, Day 2 cascade,
TA restrictions, Day 1 deletion, notification matrix, bilingual emails).

## Setup

Run `initializeSpreadsheet` again (idempotent). New this round:
- A `NotificationSettings` sheet (created + seeded with the default routing).
- The `BloodDrawingSlots.AssignedTA` column now holds a COMMA-SEPARATED list
  of TA emails. No migration needed — an existing single email is a valid
  one-element list.

No new triggers.

## Section-by-section

**1. Blood Drawing slot editing** — `editBloodDrawingSlot` is now a full
editor: date, start time, end time, assigned Blood Drawing staff, and the
list of assigned TAs. It updates the sheet + calendar event and notifies
everyone affected (previous and new staff/TAs, deduplicated). A new "Edit"
button on each Blood Drawing row opens a modal with the date/time fields, a
staff dropdown, and a multi-select TA picker preloaded with the current
assignees.

**2. Unified Behaviour × MRI validation** — Every behavioural-slot *creation*
path (individual MRI-driven schedule, individual Day 1/Day 2, bulk, and the
edit-via-schedule flow) already routes through the single
`validateBehaviouralSlot_()` from round 3, which implements "warning if
different staff, error if same staff" for Behaviour × MRI (and the
unconditional Behaviour × Behaviour / MRI × MRI blocks). Rescheduling moves a
participant between already-validated existing slots, so it introduces no new
overlap and needs no re-check ("where applicable"). No workflow has its own
divergent copy of the rule.

**3. Generate all compatible combinations + bilingual PDF** — A new "Schedule
Combinations" screen lists every valid Day 1 + compatible Day 2 pairing
(respecting the compatibility window), with a scope toggle (available-only vs
all slots) and a live text filter. "Export PDF (EN + DE)" generates a
two-section PDF — English page first, then a German page — listing the Day 1
slot, its linked MRI slot, the Day 2 slot, and the assigned staff for each,
with a count + timestamp summary. The PDF is saved to Drive (shareable link)
and also downloaded directly in the browser. Backend:
`buildCompatibleCombinations_`, `getCompatibleCombinations`,
`generateCombinationsPdf`, `buildCombinationsHtml_`.
*Scope note:* the compatibility model pairs Day 1 with Day 2 by the
mapping-window rule; the Blood Drawing slot is auto-derived from the Day 1
slot in this system, so the PDF centres on the Day 1/MRI/Day 2 trio plus
staff. "Selected MRI slots" is expressed as the available/all scope toggle
plus the filter rather than a per-MRI checkbox list.

**4. Day 2 deletion cascade validation** — Before deleting a Day 2 slot,
`getDay2DeletionImpact_` checks whether it is the ONLY compatible Day 2 slot
for any available Day 1 slot. If so, `deleteDay2Slot` returns a confirmation
request naming the affected Day 1 slot(s) and their MRI slot(s), and the
admin is warned that those Day 1 schedules will also be removed. On confirm,
it cascade-deletes the Day 2 slot, the stranded Day 1 slot(s), and their
linked Blood Drawing slot(s), updating sheets + calendars and sending
notifications. The front-end shows the two-step warning/confirm flow.

**5. Staff assignment restrictions** — Technical Assistants are now excluded
from `getApprovedStaffList_`, which is both the source for every Day 1/Day 2
"Assigned Staff" dropdown AND the server-side validation list used when
saving a schedule. So a TA can be assigned only to Blood Drawing slots, and
the restriction is enforced in the UI and on the server.

**6. Day 1 deletion** — Deleting a Day 1 slot now always removes its linked
Blood Drawing slot(s) (booked or not), clears the assignments, updates the
calendar, and notifies the assigned Blood Drawing staff, all assigned TAs,
and the Main Admin — deduplicated so each person gets one email
(`notifyBloodDrawingSlotsRemoved_`, bilingual).

**7. Multiple Technical Assistants** — `BloodDrawingSlots.AssignedTA` is a
comma-separated list, with `parseTaEmails_` / `serializeTaEmails_` /
`validateTaEmails_` helpers. All assigned TAs are displayed (table + edit
form), all are invited to the calendar event (deduplicated with the staff
member), and all are notified. Reassignment passes previous + new TA lists to
the deduplicating notifier, so both removed and newly added TAs are informed.

**8. Email Notification Settings** — A new "Email Notification Settings"
section in Manage Roles (Main Admin, `manage_roles`) shows a matrix of every
event × recipient-group checkboxes, editable and persisted to the
`NotificationSettings` sheet (`getNotificationMatrix` /
`updateNotificationRouting`). `resolveNotificationRecipients_(eventKey,
context)` turns a routed group list into concrete, deduplicated addresses
given the event's context (assigned staff, blood-drawing staff, TAs,
participants). The notifiers that map cleanly to a matrix event — Blood
Drawing assignment/updates, TA availability, participant messages — now route
their recipients through the matrix.
*Scope note:* purely internal admin audit notices (e.g. the generic
"schedule change" / slot-added / slot-deleted admin emails via
`notifyAdminOfChange_`) keep their existing "all active admins" dedup logic
rather than being matrix-gated, since they are operational audit trail
messages rather than the participant/staff-facing events the matrix is aimed
at. The matrix, resolver, and defaults are all in place to extend routing to
further events without code changes to the resolver.

**9. Bilingual emails** — A `bilingualBody_(germanBody, englishBody)` helper
formats every system email with the GERMAN section first, then the English
translation. Converted across the system: booking confirmation, reschedule,
cancellation, and unbooked; schedule created / updated / deleted; staff
assignment and reassignment; Blood Drawing assignment / updates; Day 1
deletion; weekly reminder emails; participant contact messages; TA
availability request + confirmation; password reset; and admin account
creation. Calendar invitations carry a bilingual description/title where the
event body is set by this system.

## Known scope boundaries (round 4)

- Notification-matrix routing is wired into the participant/staff-facing
  notifiers; internal admin audit emails remain on their prior recipient
  logic (see section 8).
- The combinations screen expresses "selected MRI slots" via the scope
  toggle + filter rather than a per-MRI multi-select (see section 3).
- As before, the newer admin screens are fully functional but simpler than
  the most polished existing screens.
