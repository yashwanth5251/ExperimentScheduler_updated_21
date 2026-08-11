# Experiment Scheduling System — Setup & Deployment Guide

A 2-day experiment booking app built on Google Apps Script + Google Sheets, with a
password-protected Admin portal for managing slots.

- Participants choose English or German, pick a Day 1 slot, see only the Day 2 slots
  that automatically fall 22–26 hours later, enter their details, and get a bilingual
  confirmation email — race-condition-safe against double booking.
- Admins get a separate, gated portal to view all upcoming slots and add new ones,
  with the 22–26 hour rule enforced whenever a new Day 1 slot is created.

## Files in this project

| File                 | Purpose                                                              |
|----------------------|-----------------------------------------------------------------------|
| `Code.gs`             | All server-side logic: booking, Sheets I/O, locking, email, admin     |
| `Index.html`          | Participant booking page structure                                    |
| `JavaScript.html`     | Participant booking client logic + translations                       |
| `Styles.html`         | Participant booking CSS                                               |
| `Admin.html`          | Admin portal page structure                                           |
| `AdminJavaScript.html`| Admin portal client logic                                             |
| `AdminStyles.html`    | Admin portal CSS                                                      |

## 1. Create the Google Sheet

Create a new Google Sheet, then create these tabs with these **exact** names and header rows:

**Day1Slots**
| SlotID | Date | StartTime | EndTime | Booked | MRISlotID | AssignedStaff | CalendarEventID |
|--------|------|-----------|---------|--------|-----------|---------------|-----------------|

**Day2Slots**
| SlotID | Date | StartTime | EndTime | Booked | AssignedStaff | CalendarEventID |
|--------|------|-----------|---------|--------|---------------|-----------------|

**Bookings** (leave empty — the app fills this in)
| Timestamp | ParticipantID | Name | Email | Day1SlotID | Day2SlotID |
|-----------|----------------|------|-------|-------------|-------------|

**MRISlots** (Phase 2 — every slot is fixed at 90 minutes)
| SlotID | Date | StartTime | EndTime | Booked | AssignedStaff |
|--------|------|-----------|---------|--------|---------------|

**Staff** (populate this yourself — who can be ASSIGNED to slots)
| Name | Email |
|------|-------|

**Admins** (who can LOG IN — auto-seeded on first run; see section 4)
| Name | Email | Role | PasswordHash | PasswordSalt | Active | CreatedAt |
|------|-------|------|--------------|--------------|--------|-----------|

> Tip: paste in the code (step 2) first, then run `initializeSpreadsheet` once from
> the Apps Script editor — it creates any missing sheets with correct headers and
> checkboxes automatically, and seeds the initial admin password.

**Do not type directly into `Day1Slots`/`Day2Slots`/`MRISlots` to add new rows.**
SlotIDs (`D1-001`, `D2-001`, `MRI-001`, …) are now assigned automatically, only
through the Admin portal — see section 5. You can still edit existing rows by hand
(e.g. to fix a typo or manually mark something `Booked`), and the `ParticipantID`
column in `Bookings` is left blank by design for your own numbering.

**The `Staff` sheet IS meant to be typed into directly** — add one row per staff
member (Name, Email) to populate the "Assigned Staff" dropdowns in the Admin portal.

**The Assigned Staff dropdowns list every *active admin* (Main Admin included) plus
anyone extra in the `Staff` sheet.** So you only need to add `Staff` rows for people
who run sessions but never log into the portal (e.g. student assistants) — admins
appear automatically, labelled with their role. Duplicates are merged by email.

Never edit the `Admins` password columns by hand; use the portal's Manage Admins and
Change Password screens.

## 2. Create the Apps Script project

1. In your Google Sheet, go to **Extensions → Apps Script**.
2. Delete the default `Code.gs` content and paste in this project's `Code.gs`.
3. Create six new HTML files (**File → New → HTML file**) named exactly:
   `Index`, `JavaScript`, `Styles`, `Admin`, `AdminJavaScript`, `AdminStyles`
   and paste in the matching contents.
4. Save the project.
5. From the function dropdown, select `initializeSpreadsheet` and click **Run** once.
   Grant the requested permissions (Sheets, Gmail/MailApp, and Properties/Cache
   services). This also sets the initial admin password to `123456`.
6. Add at least one row to the **Staff** sheet (Name, Email) — otherwise the
   Assigned Staff dropdowns in the Admin portal will be empty and you won't be able
   to build a schedule yet.

Because the script is bound to the spreadsheet, `CONFIG.SPREADSHEET_ID` can stay blank.

## 3. Deploy — TWO separate Web Apps

This app deliberately uses **two deployments of the same script**, because Apps
Script's access control is set per-deployment, and the admin portal and the public
booking form need different rules:

### Deployment A — Public booking page (for participants)

1. **Deploy → New deployment → Web app**.
2. **Execute as:** Me
3. **Who has access:** Anyone
4. Deploy, authorize, and copy the URL. This is what you share with participants —
   it opens the booking flow by default (`?page=book`, which is also the default).

### Deployment B — Admin portal (for you only)

1. **Deploy → New deployment → Web app** again (a *second*, independent deployment).
2. **Execute as:** Me
3. **Who has access:** **Only myself**
4. Deploy, authorize, and copy the URL. You can bookmark it plain — since this
   deployment is restricted to your account, the app now recognizes you and opens
   straight into the Admin portal automatically, no query parameter required. If you
   ever need to force one view or the other (e.g. while testing), you can still append
   `?page=admin` or `?admin=true` for the admin view, or `?page=book` for the booking
   view — an explicit parameter always overrides the automatic detection.

With "Only myself" access, **Google itself blocks anyone but your own Google account
from loading that URL at all** — no admin code even runs for anyone else. That's what
makes the admin portal "only visible if logged in as the code's owner." The password
system (next section) is a second, independent layer on top of that. `CONFIG.ADMIN_OWNER_EMAIL`
must match the Google account you deploy this second Web App under — that's what the
automatic-routing check in `isOwnerVisiting_()` compares against.

> If your Google account ever changes (e.g. you transfer script ownership), redeploy
> Deployment B under the new account so the "Only myself" restriction follows it.

Every time you edit the code, push updates to **both** deployments via **Manage
deployments → Edit → New version** for each.

## 4. Admin portal — accounts, roles & passwords

Each admin now has **their own account** (email + password) stored in the `Admins`
sheet — there is no longer a single shared password.

**First login:** running `initializeSpreadsheet` seeds one `MainAdmin` account using
`CONFIG.ADMIN_OWNER_EMAIL` / `CONFIG.ADMIN_DEFAULT_PASSWORD` (`123456`) *only if the
Admins sheet is empty*. Log in with that email and password, then change the password
immediately.

**Roles and permissions** are defined entirely in `CONFIG` — to add a role or grant a
new capability, edit these two values and nothing else:
```js
ADMIN_ROLES: ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator', 'Viewer'],
ROLE_PERMISSIONS: {
  MainAdmin:        ['view', 'manage_slots', 'manage_admins'],
  SchedulingAdmin:  ['view', 'manage_slots'],
  StudyCoordinator: ['view', 'manage_slots'],
  Viewer:           ['view']
}
```
- `view` — see the dashboard and all slot tables (read-only)
- `manage_slots` — add/delete MRI, Day 1 and Day 2 slots, build schedules, reassign staff
- `manage_admins` — create/edit/deactivate/remove admins and reset their passwords

Every mutating server function calls `requirePermission_(session, '<perm>')`. The
browser also hides controls the role lacks, but **that is only cosmetic** — the
server check is the real boundary, so a tampered client gains nothing.

**Manage Admins** (MainAdmin only, via the dashboard button): create admins (they're
emailed their login details), change roles inline, deactivate/reactivate, remove, and
reset passwords. The system refuses to remove, deactivate, or demote the **last active
MainAdmin**, so you can never lock yourself out.

**Change Password** (any admin): two-step and email-verified — enter your current and
new password, receive a 6-digit code **at your own admin email address**, then confirm.
The code expires after 10 minutes.

Sessions expire after 30 minutes of inactivity (sliding). Passwords are stored only as
salted SHA-256 hashes in the `Admins` sheet — never in plaintext.

## 5. Admin portal — scheduling workflow

### One shared time-conflict domain
MRI, Day 1, and Day 2 slots all use the same room, so **no two slots of any of these
three types may overlap in time** — booked or unbooked. `findOverlappingSlot_()`
checks a candidate against all three sheets at once, so adding an MRI slot that
clashes with a Day 2 slot (or vice versa) is blocked with a message naming the exact
conflicting slot.

### Adding MRI slots
Enter date, start time, and **duration** (defaults to 90 minutes but is editable). The
end time is calculated and read-only. A live, debounced conflict check runs as you
type and disables **Add MRI Slot** if it clashes.

### Building a schedule from an MRI slot
1. In the **MRI Slots** table, pick a **Day 1 staff** member on an available row and
   click **Add to Schedule**.
2. In the builder, set **Time Before MRI** (default 90) and **MRI Duration** (seeded
   from that slot's actual current length). Day 1 is derived as:
   - **Day 1 Start = MRI Start − Time Before MRI**
   - **Day 1 End = MRI End** (= MRI Start + MRI Duration)

   So editing the MRI duration moves Day 1's end time automatically. All three derived
   fields are read-only and recalculate live, with a conflict check on each change. If
   you changed the duration, a note warns that saving will also resize the MRI slot —
   and that resize is itself conflict-checked.
3. Pick Day 2 slots: tick any of the **existing available slots in the 22–26h window**
   (already filtered to exclude booked slots and anything conflicting), and/or add new
   Day 2 rows inline with live compatibility + conflict badges.
4. Choose **Day 2 staff independently** of Day 1 staff.
5. **Save Schedule** stays disabled until Day 1 is conflict-free, both staff members
   are chosen, and at least one Day 2 slot is selected or valid.

Everything is re-validated server-side inside a lock before anything is written, so a
stale browser or a simultaneous second admin can't produce a bad schedule.

### Creating Day 2 slots independently
The **Create Day 2 Slot Independently** panel makes a Day 2 slot without building a new
MRI/Day 1 schedule. As you type, the server checks the candidate and either lists
**every available Day 1 slot it's compatible with** or explains why it's invalid
(conflicts with an MRI/Day 1/Day 2 slot, or no Day 1 slot sits 22–26h before it). Staff
assignment is required before saving.

### Staff assignment & reassignment
- **On schedule creation:** if Day 1 and Day 2 have the *same* staff member, they get
  **one combined email** covering both; if *different*, each gets a separate email
  containing only their own assignment.
- **Calendar:** each session is added to the **code owner's Google Calendar only**, as
  a single central view of the study schedule. Staff are **not** added as guests and
  receive **no calendar invitations** — they are informed by plain email, with the
  assigned staff member recorded in the event title and description. There is **no
  Outlook synchronisation**.
- **Reassign** buttons on both the Day 1 and Day 2 tables change the assigned staff at
  any time. The previous staff member is emailed that their assignment was removed, the
  new staff member is emailed their assignment, the owner's calendar event is updated,
  and **all admins are notified**.
- Deleting a slot also removes its event from the owner's calendar.

### Deleting slots
- An **available Day 1 slot** first checks whether any available Day 2 slot is
  compatible *only* with it, and warns you exactly which will also be deleted. Its
  linked MRI slot returns to Available.
- A **booked Day 1 slot** offers **Unbook** (clear the booking, return both slots to
  Available) or **Delete Completely** (remove both slots and the booking record).
- **Available Day 2 slots** delete directly; booked ones are managed via their Day 1 slot.
- Every add, delete, reassign, and unbook emails a summary to **every active admin**
  in the `Admins` sheet, Main Admin included.

**SlotIDs are assigned automatically** (`MRI-001`, `D1-001`, `D2-001`, …) — this portal
is the only way new slot rows are created.

### Status as of the 2026-07-31 bugfix pass
This section used to list several features as "not yet built." Since then, participant
reschedule/cancel via Confirmation Number + Passcode, booking comments, hiding Slot IDs,
the "Confused? Write us a message" form, and Forgot Password have all been implemented
(see changelog below). Still open: a formal admin approval/activation workflow (new
admins are created directly by an existing MainAdmin today, not via a self-service
request+approval flow).

**Outlook synchronisation is deliberately out of scope** and will not be added.

### Changelog — 2026-07-31 additional-requirements pass
- **Pre-MRI Window check:** Add MRI Slot now also takes "Time Required Before
  MRI" and warns (non-blocking, same pattern as the existing MRI-vs-experiment
  warning) if that window overlaps Day 1/Day 2 slots.
- **Independent Day 1/Day 2 rescheduling:** participants (and now admins) can
  change just Day 1 or just Day 2 — after picking a new Day 1, if the current
  Day 2 is still compatible you can keep it; a standalone "Change Day 2 Only"
  path skips Day 1 entirely.
- **Privacy fix:** the participant-facing Manage Appointment page was sending
  the assigned staff member's email straight to the browser and displaying
  it. Removed — participants now only ever see date/time/location.
- **Admin Booking Management:** a new "Bookings" screen in the Admin Portal
  lists every booking (Booking ID, Passcode, Name, Email, Day 1/Day 2,
  Status — no staff info) and lets any admin with slot-management permission
  reschedule (same independent Day 1/Day 2 logic as the participant flow) or
  cancel a booking by Booking ID, including recording the participant's next
  possible availability on cancellation.
- Reschedule/cancel logic was refactored into shared `*Core_` functions so
  the participant and admin paths run the exact same tested code rather than
  two copies that could drift.

### Not addressed this pass
- The "must not overlap the first 90 minutes of an existing Day 1 slot"
  refinement wasn't implemented — the current rule (full-slot overlap
  blocking) is stricter, not looser, so nothing is under-validated, but the
  exact intended semantics need confirming before narrowing it.
- Admin Portal UI copy/clutter cleanup.
- Dedicated "Notifications" / "Calendar Sync" / "Audit Log" sheets — the
  app currently logs via live email notifications and per-row Calendar
  Event ID columns rather than separate log sheets; adding those would be a
  new logging subsystem, not a bug fix.
- **Root-cause fix:** `AdminJavaScript.html`'s startup routine referenced 14 client-side
  handler functions (password-change modal, Manage Admins, Reassign, Delete Day 1/Day 2,
  Booked-slot Unbook/Delete) that were never written. Since the first one was wired
  before most of the rest of the setup code, the resulting `ReferenceError` silently
  aborted startup partway through — which is why default MRI/Day 2 durations, live
  end-time calculation, Add MRI Slot, Save Schedule, and the whole Manage Admins screen
  all appeared broken at once. All 14 functions have been implemented against the
  existing (and already-correct) server-side API.
- **Forgot Password:** added end-to-end (login screen → email → 6-digit code → new
  password), for admins who are locked out rather than just changing a known password.
- **Confused? Write us a message:** implemented on the participant booking page —
  previously only a translation string existed with no form or server handler.
- Verified already working and unchanged: Confirmation Number/Passcode generation,
  storage, and inclusion in booking emails and the on-screen confirmation panel; the
  Manage Appointment link; hiding Slot IDs from participants; booking comments.

## 6. Other configuration reference (top of `Code.gs`)

```js
var CONFIG = {
  SPREADSHEET_ID: '',                 // fill in only for standalone deployments
  MAPPING_WINDOW_MIN_HOURS: 22,
  MAPPING_WINDOW_MAX_HOURS: 26,
  MRI_DURATION_MINUTES: 90,
  DAY1_TIME_BEFORE_MRI_DEFAULT_MINUTES: 90,
  DAY1_DEFAULT_DURATION_MINUTES: 180,
  DAY2_DEFAULT_DURATION_MINUTES: 60,
  EXPERIMENT_NAME: {                  // used in confirmation emails
    en: 'Two-Day Research Experiment',
    de: 'Zweitägiges Forschungsexperiment'
  },
  LOCATION: {
    address: 'Brenneckestraße 6, 39118 Magdeburg',
    mapsUrl: 'https://share.google/fGVtmqDfgzVR1vns8'
  },
  SIGNATURE: {
    name: 'Manoj Pandiri',
    roleEn: 'Doctoral Student, LIN',
    roleDe: 'Doktorand, LIN',
    email: 'neuropsychologie.lin@googlemail.com'
  },
  EMAIL_DUPLICATE_EXCEPTION: 'neuropsychologie.lin@googlemail.com', // may book more than once
  ADMIN_BCC_EMAIL: '',                // BCC every confirmation email to the team
  LOCK_TIMEOUT_MS: 30000,

  ADMIN_OWNER_EMAIL: 'altersstudie@lin-magdeburg.de',  // owner auto-routing + seeds the first MainAdmin
  ADMIN_DEFAULT_PASSWORD: '123456',   // seeded MainAdmin password; change on first login
  ADMIN_SESSION_TTL_SECONDS: 1800,
  ADMIN_OTP_TTL_SECONDS: 600,

  ADMIN_ROLES: ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator', 'Viewer'],
  ROLE_PERMISSIONS: { /* see section 4 — extend here to add capabilities */ }
};

// Password-change codes now go to each admin's OWN email address (from the
// Admins sheet), so there is no longer a single fixed OTP destination.
```

If the experiment location changes, update `CONFIG.LOCATION` in `Code.gs` **and** the
matching `LOCATION` constant near the top of `JavaScript.html` (the email uses the
server copy; the on-screen participant confirmation uses the client copy).

## How the requirements are met

- **Admin portal gated to the code owner** — enforced by deploying it as a separate
  "Only myself" Web App (section 3); Google blocks anyone else before any of our code
  runs. A password (default `123456`, changeable) is a second, independent layer.
- **Password changes require email verification** — a 6-digit code is always sent to
  the fixed address `altersstudie@lin-magdeburg.de`; the new password only takes
  effect once that code is confirmed.
- **Full slot overview from today onward** — `getAdminSlotsOverview()` filters both
  sheets to `Date >= today` and returns booked/available status for every row.
- **Guarded Day 1 slot creation** — `addDay1SlotWithDay2_()` refuses to write a new
  Day 1 slot unless at least one submitted Day 2 slot is 22–26 hours later; validation
  happens fully before any write, so partial/invalid saves are impossible.
- **Automatic SlotIDs, admin-only** — `generateNextSlotId_()` assigns sequential
  `D1-00X`/`D2-00X` IDs; there is no participant- or admin-facing way to set a SlotID
  manually, and slot rows are never created outside these admin functions.
- **No double booking, even simultaneously** — `submitBooking()` wraps the entire
  check-then-write sequence in `LockService.getScriptLock()`, re-validating from fresh
  data after acquiring the lock.
- **Bilingual participant flow, location, signature, no participant ID shown** — as
  before (see in-code comments in `Code.gs` / `JavaScript.html`).

## Extending further

- **Add a third language (participant side):** extend `MESSAGES`/`WEEKDAYS`/`MONTHS`
  in `Code.gs` and the `I18N` object in `JavaScript.html`, plus a language button in
  `Index.html`.
- **Add a Day 3:** duplicate the Day2Slots pattern and extend the admin guard function
  to also check a Day2→Day3 window; the generic helpers (`combineDateAndTime_`,
  `isSlotPairCompatible_`, `generateNextSlotId_`, etc.) are reusable as-is.
- **Run a second, independent experiment:** copy the Sheet and Apps Script project and
  point `CONFIG.EXPERIMENT_NAME`/`CONFIG.LOCATION` (and optionally `SPREADSHEET_ID`) at
  the new instance; redeploy both Web Apps for the new copy.
