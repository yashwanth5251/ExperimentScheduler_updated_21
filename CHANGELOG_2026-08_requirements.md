# 2026-08 Requirements Pass — Implementation Changelog

This documents what changed in `Code.gs` / the HTML files to implement the
11-section requirements document, and where the implementation is
intentionally scoped/simplified.

## Setup after uploading this version

1. Paste the updated `Code.gs` and all HTML files into the Apps Script
   project (same file names as before).
2. Run `initializeSpreadsheet` once. This adds four new sheets — `Roles`,
   `BloodDrawingSlots`, `TAAvailability`, `StaffColors` — and seeds `Roles`
   from the default permission set. It also adds `Title` and
   `CreatedByAdmin` columns to `Bookings` (existing rows are unaffected;
   new bookings populate them).
3. Run `installReminderTriggers` once to schedule the Monday/Wednesday
   reminder emails (a single daily trigger that no-ops on other days).
4. Redeploy both Web Apps (Manage deployments → Edit → New version).
5. To use the TA role: create an admin account with role `TA` from Manage
   Admins. TAs only see the Blood Drawing / TA Availability screens.

## Section-by-section

**1. Participant Title** — Required dropdown (Mr./Ms./Mrs./Mx./Dr./Prof.)
added to the booking form, stored on the `Bookings` row, and used in
calendar event titles as "Title LastName". `CONFIG.TITLES` controls the
option list.

**2. Participant Emails** — Removed the assigned-staff block and the
"contact the research team directly" sentence from confirmation emails
(EN + DE); participants are pointed to the Manage Appointment link instead.

**3. Admin Booking Portal** — New `adminCreateBooking` (email optional —
skips the confirmation email but still creates Booking ID/passcode,
calendar entries, and admin notification), `adminUpdateParticipantDetails`,
and `adminRecordNextAvailability`. A "Create Booking" button/modal was
added to the Admin Portal, gated by the new `manage_bookings` permission.
Existing admin reschedule/cancel/edit functions already covered the rest.

**4. TA Blood Drawing Bookings** — New `TA` role, scoped by default to only
the `book_blood_drawing` permission (so TAs can't reach scheduling,
participant, or other admin screens unless the Main Admin explicitly grants
more via Manage Roles).

**5. Admin Portal Display** — Dashboard tables and the Reassign modal now
show staff **names** (`assignedStaffName`/`day1StaffName`/`day2StaffName`),
not emails. `getAdminBookingsList` already excluded staff info entirely.
*Scope note:* a few secondary warning banners (MRI-overlap conflict lists)
still interpolate the raw staff object from the server, which currently
carries an email; tightening every such banner to a display name was not
completed for time — flagging this so it's not mistaken for a completed
audit.

**6. Day 1/Day 2 Scheduling Validation** — New `evaluateBehaviouralOverlap_`
implements the spec's rule: outside the MRI period, a new Day 1/Day 2 slot
may overlap another behavioural experiment only if a **different** staff
member is assigned; if the same staff member is already assigned to the
overlap, saving is blocked with a specific message until different staff is
chosen. Wired into `createScheduleFromMri` for both the Day 1 slot and new
Day 2 rows, returning the full conflict list (`conflicts`) for display.
*Scope note:* the legacy manual `addDay1SlotWithDay2_` / independent Day 2
paths still hard-block any experiment overlap (stricter than required, not
under-validated) — narrowing those to the same staff-aware rule was not
done this pass, consistent with how the prior README already flagged that
path as legacy/manual.

**7. Email Validation** — Centralized in `validateEmailFormat_`, used by
participant booking, `sendHelpMessage`, and `adminCreateBooking`. Duplicate
detection (`emailAlreadyBooked_`) is reused for admin-created bookings too.

**8. Calendar Events** — Rewrote `upsertStaffCalendarEvent_` and
`upsertParticipantCalendarEvents_` to: use the spec's exact title formats
("Day 1 / Staff: Name" for scheduled slots, "Day 1 / Participant: Title
LastName / Staff: Name" for booked slots); invite the assigned staff member
as a calendar guest (previously they were deliberately *not* invited — this
is a behavior reversal per the new spec); assign each staff member a
stable, unique colour via new `getStaffColorId_`/`applyStaffColor_`
(persisted in the `StaffColors` sheet) and apply it consistently across
schedule creation, bookings, Blood Drawing, rescheduling, cancellation, and
reassignment; and de-duplicate invite recipients via
`buildDedupedGuestList_`. A dedicated, synced Blood Drawing calendar event
(`upsertBloodDrawingCalendarEvent_`/`deleteBloodDrawingCalendarEvent_`) was
added.

**9. Automatic Reminder Emails** — `checkAndSendReminders_` (installed via
`installReminderTriggers`, a daily trigger that only acts on Monday/
Wednesday) emails the Main Admin a summary of unbooked/unassigned Day 1/2
slots in the next `CONFIG.REMINDER_WINDOW_DAYS` (14) days.

**10. Role-Based Access Control** — Permissions moved from hardcoded
`CONFIG.ROLE_PERMISSIONS` to a `Roles` sheet, editable at runtime via new
`getRolesConfig`/`updateRolePermissions`/`createRole` (MainAdmin-only, via
a "Manage Roles" screen), with a 5-minute cache for performance.
`CONFIG.ROLE_PERMISSIONS` remains only as the seed/fallback. Full
permission catalog added per the spec's suggested list.

**11. Blood Drawing Management** — Full module: `BloodDrawingSlots` sheet,
CRUD for slots (`createBloodDrawingSlot`/`editBloodDrawingSlot`/
`deleteBloodDrawingSlot`, `manage_blood_drawing_schedules`-gated, TA-only
assignment), automatic 30-minute slot creation on every new Day 1 slot
(both the MRI-based and legacy manual creation paths), a Blood Drawing
Portal screen in the Admin Portal, a TA Availability Portal
(`submitTAAvailability`/`getTAAvailability`) with bilingual (DE/EN)
notification emails on save, and a Monday/Wednesday reminder
(`sendBloodDrawingAssignmentReminder_`) listing unassigned slots to the
Main Admin and Blood Drawing managers.

## Known scope boundaries (being upfront about depth vs. breadth)

Given the size of this request (11 substantial feature areas across a
~5,000-line project), the backend (`Code.gs`) implementation was prioritized
for completeness and correctness. The new admin-facing UI (Create Booking,
Blood Drawing Portal, TA Availability, Manage Roles) is fully functional but
deliberately simpler than the existing, heavily-polished screens (e.g. no
live conflict-checking widgets on the Blood Drawing form) — every button
calls a real, tested server function and reflects the result, but some of
the richer inline validation UX from the older screens wasn't reproduced.
