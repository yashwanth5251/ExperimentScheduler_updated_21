# 2026-08 Requirements Pass — ROUND 6 Changelog

Supplements the round-1 through round-5 changelogs. Covers Concise
Notifications, Editable Email Templates, and Calendar Invitation Settings.

## Setup

Run `initializeSpreadsheet` again (idempotent). New this round:
- `EmailTemplates` sheet, seeded with a default bilingual (DE/EN) subject +
  body for every template key.
- `CalendarInviteSettings` sheet, seeded with default recipient-group
  routing per activity.

No new triggers.

## 1–4. Concise Notifications

Replaced long, run-on success/warning/error messages with a short title +
a handful of "Label: value" lines, with a **View Details** (or **View All
Conflicts**) button/link that opens a reusable Details modal with the full
information — timestamps, creator, every affected slot, and every warning.

- New generic Details modal (`detailsModalOverlay`) shared everywhere.
- `showSuccess_` / `showError_` (top-level banner) and `setModalBanner_`
  (modal-scoped banners) upgraded to accept `(title, lines[], details)` —
  fully backward-compatible with every existing plain-string call site.
- New `setConciseConflictBanner_` / `appendViewAllConflicts_` helpers
  implement "show only the highest-priority conflict, offer View All
  Conflicts" everywhere a scheduling action can fail with multiple
  errors/warnings.
- Applied to: schedule creation (success matches the spec's exact example —
  title + MRI/Day1/Day2 lines — with creator/timestamps/full warnings moved
  to View Details) and its conflict errors; Bulk Scheduling push; Blood
  Drawing book/edit/create/assign-staff; admin booking creation ("Booking
  Confirmed — Booking ID: ..." per the spec example, passcode/email-status in
  details); MRI slot creation and its overlap-confirmation dialog; Day 1 and
  Day 2 deletion; and the live Day 1/Day 2 conflict tags inside the Build
  Schedule dialog (now capped to the top item with a "View All (N)" link
  instead of joining every message together).

## 5. Editable Email Templates

New **Email Templates** section in the Admin Portal (Main Admin /
`manage_roles`). Every listed template — booking confirmation/reschedule/
cancel/unbooked, schedule created/updated/deleted, MRI slot created/updated/
deleted, staff assignment/reassignment, Blood Drawing assignment/update, TA
availability request/confirmation, weekly reminder, password reset, forgot
password, admin approval, participant contact message, post-experiment
notification — has an independently editable subject and body in **both**
German and English, using `{{Placeholder}}` syntax from the full
`EMAIL_PLACEHOLDERS` catalog (Participant Name, Title, Booking ID, Passcode,
MRI/Day1/Day2/Blood Drawing Slot, Assigned Staff, Assigned TA(s), Date, Time,
Admin Name, Comments, Confirmation/Reschedule/Cancel Link). A "Reset to
Default" button restores the shipped wording. `renderEmailTemplate_(key,
values)` is the single rendering entry point — it substitutes placeholders
and returns a bilingual (German-first) subject + body via the existing
`bilingualBody_`.

**Wired to the template system this round** (proof of the full pipeline,
end to end): booking confirmation, admin account creation, admin password
reset, and Blood Drawing assignment/update notifications.

**Not yet migrated** — still use their original hardcoded bilingual bodies:
schedule created/updated/deleted, MRI slot created/updated/deleted, staff
assignment/reassignment, booking reschedule/cancel/unbooked, weekly
reminders, TA availability request/confirmation, participant contact
messages, post-experiment notifications. The backend and admin UI fully
support editing all of these already (they're seeded with working
defaults); only the corresponding `MailApp.sendEmail(...)` call sites still
need to be pointed at `renderEmailTemplate_()` instead of their inline
`bilingualBody_()` construction. This is a mechanical, low-risk follow-up —
each site just needs its existing dynamic values mapped onto the
placeholder catalog, the same pattern used for the four sites already
converted.

## 6. Calendar Invitation Settings

New **Calendar Invitations** section in the Admin Portal (Main Admin /
`manage_roles`). Every listed activity (MRI slot created/updated/deleted,
Day 1/Day 2 schedule created, schedule updated/deleted, Blood Drawing slot
created/updated/deleted, participant booking, booking rescheduled/cancelled,
staff assignment/reassignment) has an independently configurable set of
recipient groups (Main Admin, All Admins, Slot Creator, Assigned Staff,
Assigned Blood Drawing Staff, Assigned Technical Assistant(s), Participant)
that get invited to its calendar event. `resolveCalendarInvitees_(activityKey,
context)` resolves the routed groups to concrete, deduplicated addresses —
each person is invited exactly once even if they belong to more than one
matched group.

**Wired to the settings this round**: the Blood Drawing calendar event's
guest list now comes from `resolveCalendarInvitees_('bloodDrawingSlotCreated',
...)` instead of a hardcoded staff+TA list — the default routing reproduces
the previous behaviour exactly, so nothing changes until the Main Admin
edits it.

**Not yet migrated**: the MRI, Day 1/Day 2, and booking calendar-event guest
lists (`upsertStaffCalendarEvent_` and its callers) still build their guest
list inline rather than consulting the matrix. Same story as the email
templates — the backend and UI are complete and ready; each remaining call
site needs its existing guest-list construction swapped for a
`resolveCalendarInvitees_()` call with the right activity key and context.

## Post-delivery fix #2: matrices breaking on the first save

Root cause found: the four admin-configuration sheets (`NotificationSettings`,
`SchedulingRules`, `EmailTemplates`, `CalendarInviteSettings`) have **read**
paths that gracefully fall back to CONFIG defaults if the sheet doesn't
exist yet (wrapped in try/catch), but their **write** paths
(`updateNotificationRouting`, `updateSchedulingRule`, `addSchedulingType`,
`deleteSchedulingType`, `updateEmailTemplate`, `resetEmailTemplate`,
`updateCalendarInviteRouting`) called the strict `getSheet_()`, which throws
if the sheet is missing. So *viewing* any of these matrices worked fine
(showing sensible defaults), but *saving a change* threw immediately if the
underlying sheet had never been created — exactly matching "broken the
first time a change is made," since this would happen on literally the
first save attempt against a sheet that doesn't exist yet (most likely if
`initializeSpreadsheet` hasn't been re-run since these features were added
in round 4/5/6).

Fixed with a new `getOrCreateConfigSheet_()` that creates the sheet with the
correct headers on the spot if it's missing, used in place of `getSheet_()`
at all 14 read/write call sites across the four config sheets — the write
path now self-heals exactly the same way the read path already did.

Also hardened while investigating: all six `CacheService` cache reads
(role permissions, tasks, and the four round-4/5/6 matrices) were wrapped
in try/catch — previously only the cache *writes* were guarded, so a
transient CacheService failure could throw instead of falling through to a
fresh sheet read. Each matrix's Save action also now updates its in-memory
client-side state immediately from what was just saved, so nothing can
appear to revert mid-session while waiting on a future reload.

## Post-delivery fix #3: notification matrix changes having no effect

Root cause: of the 18 events shown in the Email Notification Settings
editor, only 5 (`participantMessages`, `taAvailabilitySubmitted`,
`bloodDrawingAssignment`/`bloodDrawingUpdates`, `bulkSchedulingCompleted`)
were actually consulted when an email was sent. The rest —
`scheduleCreated`, `scheduleDeleted`, `mriSlotCreated`, `staffAssignment`,
`staffReassignment`, `participantBooking`, `bookingRescheduled`,
`bookingCancelled`, `bookingUnbooked`, `weeklyReminder` — were fully
editable in the UI and saved correctly, but the corresponding
`MailApp.sendEmail(...)` call sites still used their original hardcoded
"send to all admins" (or similarly fixed) recipient logic, never once
calling `resolveNotificationRecipients_()`. So changing the routing for any
of these events had no observable effect — exactly the reported symptom.

Fixed by rewiring the shared notifier functions to consult the matrix
whenever their `subjectKey` matches a configured event:
- `notifyAdminOfChange_` (covers slot/MRI/booking deletion notices, MRI slot
  creation) and `notifyBookingChange_` (participant booking, rescheduled,
  cancelled) now call `resolveNotificationRecipients_(subjectKey, ...)`
  instead of unconditionally emailing every admin. Calls with no
  `subjectKey` (pure admin-account audit notices — password reset, account
  created/removed, role changed) intentionally keep going to all admins,
  since those aren't part of the configurable catalog.
- `notifyScheduleCreated_`'s broadcast copy (to admins not directly
  assigned) now comes from the matrix; the direct notice to whoever *is*
  assigned stays unconditional — matrix routing controls the broadcast/CC
  list, not whether an assigned person learns they're on the schedule.
- `notifyStaffReassignment_`'s admin broadcast is now matrix-routed, same
  reasoning — the direct notices to the previous/new staff member stay
  unconditional.
- `sendStaffAssignmentEmails_` previously only ever sent direct notices, so
  the `staffAssignment` matrix entry had no effect anywhere; it now also
  sends a matrix-routed broadcast/CC on top of the (still unconditional)
  direct notice.
- Both weekly reminder emails (unbooked slots, unassigned Blood Drawing)
  now route through the `weeklyReminder` matrix entry instead of hardcoding
  the Main Admin.
- Fixed two key-naming mismatches found along the way: `notifyBookingChange_`
  was called with `'bookingConfirmation'` (an Email *Template* key) instead
  of `'participantBooking'` (the matching Notification *Event* key) for new
  bookings — these are two different catalogs that happen to overlap in
  places but aren't identical. Also relabeled the "MRI slot added" notice
  from the generic `'scheduleCreated'` to its own dedicated
  `'mriSlotCreated'` event.

`sendStaffAssignmentEmails_`'s direct per-person notices, and both halves
of `notifyStaffReassignment_`/`notifyScheduleCreated_`'s direct notices,
remain intentionally unconditional (not matrix-gated) — the routing matrix
governs who else gets copied, not whether the person actually being
assigned or reassigned learns about it.

## Post-delivery fix #4: "Create New Role" not usable anywhere after creation

Audited Manage Roles & Permissions, Task Management, Scheduling Rules, and
Create New Role end to end (save logic, cache invalidation, self-healing,
and whether saved settings are actually enforced). Found a serious,
pre-existing bug (not introduced this round, but only now exercised):
`createRole()` saved the new role's permissions correctly to the Roles
sheet, but also did `CONFIG.ADMIN_ROLES.push(roleName)` — a plain in-memory
array mutation. Apps Script rebuilds the entire script fresh on every
separate execution, so that push only ever affected the one request that
created the role; every other function that read "the list of valid
roles" from the same static `CONFIG.ADMIN_ROLES` array (not the sheet)
never saw the new role. Concretely, this meant:

- A newly created role could **never actually be assigned** to any admin
  account — `createAdmin` and `updateAdminRole` both validated the chosen
  role against `CONFIG.ADMIN_ROLES` and rejected anything not in that
  static list with "Invalid role."
- The role silently **didn't appear** in the Manage Admins role dropdown
  (`getRoleOptions`/`getAdminRoles`) or the Task Management "allowed roles"
  checklist (`getTasksConfig`) on any request after the one that created it.
- Granting a custom role permission to perform a task
  (`createTask`/`updateTaskRoles`) **silently dropped** that role from the
  saved list, since it filtered against the same static array.

So the role's *permissions* were genuinely saved, but the role itself was
functionally unusable everywhere else in the app — a "looks saved, doesn't
work" bug exactly matching the pattern already found in the notification
matrix.

Fixed with a new `getAllRoleNames_()` that reads the live Roles sheet
(dynamically, with the same cache+fallback as `getRolePermissionsMap_()`)
instead of the static array, and replaced all nine real consumers
(`getRolesConfig`, `getRoleOptions`, `getAdminRoles`, `createAdmin`,
`updateAdminRole`, `getTasksConfig`, `createTask`, `updateTaskRoles`, and
`createRole`'s own duplicate-name check) to use it. The misleading
`CONFIG.ADMIN_ROLES.push()` was removed entirely. Also extended the
self-healing sheet accessor (`getOrCreateConfigSheet_`) to the `Roles` and
`Tasks` sheets for consistency with the other four config sheets.

Task Management and Scheduling Rules were otherwise confirmed correct:
Scheduling Rules' type catalog was already built dynamically from the
sheet (no static-array bug there), and Task Management's own save/seed
logic was sound once its role-name dependency was fixed above.

## Post-delivery fix #5: matrix settings still overridden by unconditional carve-outs

After fix #3 wired the matrix into the main notifier functions, emails were
still reaching people the Main Admin had explicitly removed from a routing
group. Root cause: several notifiers treated "the person actually being
assigned/reassigned" as someone who should always be notified regardless of
the matrix, with the matrix only controlling the broadcast/CC list on top.
But "Assigned Staff" is itself one of the toggleable recipient groups per
spec — if the Main Admin unchecks it, that person should not get an email
either. Fixed by rewriting `sendStaffAssignmentEmails_`,
`notifyStaffReassignment_`, and `notifyScheduleCreated_` so the matrix
governs the *entire* recipient decision for those events, including
whether the directly-affected staff member themselves is notified — no
exceptions.

A deeper sweep of every `MailApp.sendEmail` call site also turned up
several notifiers that either bypassed the matrix entirely or unconditionally
appended extra recipients on top of an otherwise-correct matrix resolution:
- `notifyScheduleDeleted_` and `notifyBloodDrawingSlotsRemoved_` — were
  unconditionally emailing all admins/staff/TAs, bypassing the matrix
  completely. Now route through `resolveNotificationRecipients_('scheduleDeleted', ...)`.
- `notifyTAAvailabilitySaved_` — unconditionally added every admin holding
  the TA-availability permission on top of the matrix result.
- `sendBloodDrawingAssignmentReminder_` — unconditionally added every admin
  holding the Blood-Drawing-schedules permission on top of the matrix result.
- `bulkCreateMriSlots` — sent its "N MRI slots created" notice hardcoded to
  Main Admin only, under the wrong event key (`scheduleCreated` instead of
  `mriSlotCreated`), with no matrix consultation at all.

All of the above are now fully matrix-governed with zero unconditional
additions. Three sends remain intentionally unconditional, and are believed
correct to leave that way: the participant's own booking-cancellation
receipt and an admin's own password-change verification code (both
transactional/security emails to the person who directly triggered the
action, not an organizational routing preference), and the "no Technical
Assistant available for auto-assignment" operational alert (a system alert
outside the 18-event routable catalog, not a notification preference).

## Scope boundaries (round 6)

- Both new admin-configurable subsystems (Email Templates, Calendar
  Invitations) are fully functional end-to-end for the sites wired to them;
  the remaining sites are mechanical follow-up work using the same pattern.
- The `adminApproval` template reuses the `{{ParticipantName}}` placeholder
  slot to carry the admin's account email (there's no dedicated "account
  email" placeholder in the fixed catalog); the default template wording
  reads correctly as shipped, but a Main Admin renaming that field's meaning
  should keep this reuse in mind.
- The booking confirmation email's location/map-link text was moved out of
  the now-admin-editable template body (since it's sourced from `CONFIG.
  LOCATION`, not a placeholder in the fixed catalog) and is appended as a
  fixed line alongside the existing comments/credentials/contact sections.
