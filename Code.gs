/**
 * ============================================================================
 *  EXPERIMENT SCHEDULING SYSTEM — Code.gs
 * ============================================================================
 *  Server-side Apps Script for a 2-day experiment booking web app, plus a
 *  role-gated Admin portal for MRI-based schedule building and slot
 *  management.
 *
 *  SHEET STRUCTURE EXPECTED (see README.md for setup instructions):
 *
 *    Day1Slots : SlotID | Date | StartTime | EndTime | Booked | MRISlotID | AssignedStaff | CalendarEventID
 *    Day2Slots : SlotID | Date | StartTime | EndTime | Booked | AssignedStaff | CalendarEventID
 *    MRISlots  : SlotID | Date | StartTime | EndTime | Booked | AssignedStaff
 *    Bookings  : Timestamp | ParticipantID | Name | Email | Day1SlotID | Day2SlotID
 *    Staff     : Name | Email   (roster available to assign to slots — edit directly)
 *    Admins    : Name | Email | Role | PasswordHash | PasswordSalt | Active | CreatedAt
 *
 *  All sheets use row 1 as headers; data starts at row 2.
 *  "Booked"/"Active" columns may be a checkbox (boolean) or the text
 *  TRUE/FALSE — both are handled by isBooked_().
 *
 *  DAY1 -> DAY2 COMPATIBILITY IS FULLY AUTOMATIC:
 *  A Day 2 slot is offered as compatible with a Day 1 slot whenever its
 *  start time falls between MAPPING_WINDOW_MIN_HOURS and
 *  MAPPING_WINDOW_MAX_HOURS after the Day 1 slot's start time (default:
 *  22–26 hours).
 *
 *  ONE SHARED TIME-CONFLICT DOMAIN, CONFIGURABLE PERMISSIONS:
 *  MRI, Day 1, Day 2, and Blood Drawing slots all draw on the same
 *  physical resource/room, so every candidate slot is checked against all
 *  four sheets — see validateSchedulingSlot_(), the single centralized
 *  validator every scheduling workflow uses. Whether a given pair of types
 *  is allowed to overlap in time is NOT hardcoded — it's read from the
 *  SchedulingRules sheet (Main Admin editable, no code changes) via
 *  isOverlapAllowed_(). A permitted overlap still hard-blocks if the same
 *  staff member (or, for Blood Drawing, a shared Technical Assistant) is
 *  assigned to both sides.
 *
 *  ADMIN PORTAL:
 *  Reached at this web app's URL (auto-detected for the "Only myself"
 *  deployment — see doGet()). Every admin logs in with their OWN email +
 *  password (Admins sheet), and every mutating action is permission-gated
 *  by role — see CONFIG.ROLE_PERMISSIONS and requirePermission_().
 * ============================================================================
 */

/**
 * ----------------------------------------------------------------------------
 * CONFIGURATION
 * ----------------------------------------------------------------------------
 */
var CONFIG = {
  // Leave SPREADSHEET_ID empty ('') to use a container-bound script.
  SPREADSHEET_ID: '',

  SHEETS: {
    DAY1: 'Day1Slots',
    DAY2: 'Day2Slots',
    BOOKINGS: 'Bookings',
    // ---- Phase 2: MRI-based scheduling ----
    MRI: 'MRISlots',
    STAFF: 'Staff',
    // ---- Multi-role admin accounts ----
    ADMINS: 'Admins',
    // ---- Phase 3 additions (2026-08 requirements pass, round 1) ----
    ROLES: 'Roles',                    // configurable role -> permissions mapping
    BLOOD_DRAWING: 'BloodDrawingSlots',
    TA_AVAILABILITY: 'TAAvailability',
    STAFF_COLORS: 'StaffColors',
    // ---- Phase 4 additions (2026-08 requirements pass, round 2) ----
    GENDER_OPTIONS: 'GenderOptions',
    TASKS: 'Tasks',
    POST_EXPERIMENT: 'PostExperimentRecords',
    // ---- 2026-08 requirements pass (round 4) ----
    NOTIFICATION_SETTINGS: 'NotificationSettings',
    // ---- 2026-08 requirements pass (round 5) ----
    SCHEDULING_RULES: 'SchedulingRules',
    // ---- 2026-08 requirements pass (round 6) ----
    EMAIL_TEMPLATES: 'EmailTemplates',
    CALENDAR_INVITE_SETTINGS: 'CalendarInviteSettings',
    // ---- round 10 ----
    PROJECT_SETTINGS: 'ProjectSettings'
  },

  // Column indexes (0-based) for Day1Slots / Day2Slots / MRISlots — all
  // three share this same first-5-column layout.
  SLOT_COLS: {
    SLOT_ID: 0,
    DATE: 1,
    START_TIME: 2,
    END_TIME: 3,
    BOOKED: 4
  },

  // Day1Slots has extra columns beyond the shared SLOT_COLS layout: which
  // MRI slot this Day 1 slot was derived from, which staff member is
  // assigned to it, and the Google Calendar event ID for that staff
  // member's invite (so it can be updated/cancelled on reassignment).
  DAY1_EXTRA_COLS: {
    MRI_SLOT_ID: 5,
    ASSIGNED_STAFF: 6,
    CALENDAR_EVENT_ID: 7,
    CREATED_BY: 8,
    CREATED_AT: 9,
    // ---- round 7: Session Language ----
    LANGUAGE: 10
  },

  // Day2Slots has extra columns: assigned staff (chosen per-slot,
  // independently of Day 1's), its own owner-calendar event ID, and
  // provenance.
  DAY2_EXTRA_COLS: {
    ASSIGNED_STAFF: 5,
    CALENDAR_EVENT_ID: 6,
    CREATED_BY: 7,
    CREATED_AT: 8,
    // ---- round 7: Session Language ----
    LANGUAGE: 9
  },

  // MRISlots records BOTH the Day 1 and Day 2 staff chosen when the
  // schedule was built from it, plus who created it and when, plus (round
  // 7) the Google Calendar event ID for its own MRI-slot calendar entry
  // (governed by the 'mriSlotCreated' activity in Calendar Invitation
  // Settings — separate from the Day 1/Day 2 staff calendar events).
  MRI_EXTRA_COLS: {
    DAY1_STAFF: 5,
    DAY2_STAFF: 6,
    CREATED_BY: 7,
    CREATED_AT: 8,
    CALENDAR_EVENT_ID: 9
  },

  // Column indexes (0-based) for the Staff sheet — an interim, manually
  // maintained roster of names/emails available to assign to Day 1/Day 2
  // slots. Separate from the Admins sheet (below), which is about who can
  // LOG IN to the admin portal, not who experiments can be assigned to —
  // a person can be in one, both, or neither.
  STAFF_COLS: {
    NAME: 0,
    EMAIL: 1
  },

  // Column indexes (0-based) for the Admins sheet — who can log into the
  // admin portal, and with what role. Passwords are stored as salted
  // SHA-256 hashes, never in plain text.
  ADMIN_COLS: {
    NAME: 0,
    EMAIL: 1,
    ROLE: 2,
    PW_HASH: 3,
    PW_SALT: 4,
    ACTIVE: 5,
    CREATED_AT: 6
  },

  // The set of valid admin roles. Extend this array (and ROLE_PERMISSIONS
  // below) to add new roles without touching any other code. 'TA' (Teaching
  // Assistant) is scoped, by default, to Blood Drawing only.
  ADMIN_ROLES: ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator', 'Viewer', 'TA'],

  // DEFAULT SEED for role -> permissions. As of the 2026-08 requirements
  // pass, this is now only used to seed the `Roles` sheet the first time it
  // is created — at runtime, permissions are read from that sheet (see
  // getRolePermissionsMap_()), and the Main Admin can create/edit roles and
  // permissions at any time from the "Manage Roles" screen without touching
  // code. This constant is kept as the source of truth for the *initial*
  // seed and as a fallback if the sheet is ever unreadable.
  //
  // Full permission catalog (see PERMISSIONS_CATALOG below for labels):
  //   view, manage_admins, manage_roles, manage_slots, manage_bookings,
  //   manage_participants, manage_calendar, manage_notifications,
  //   manage_checklists, manage_blood_drawing_schedules, book_blood_drawing,
  //   view_ta_availability, manage_ta_availability, view_reports
  ROLE_PERMISSIONS: {
    MainAdmin: ['view', 'manage_slots', 'manage_admins', 'manage_roles', 'manage_bookings',
      'manage_participants', 'manage_calendar', 'manage_notifications', 'manage_checklists',
      'manage_blood_drawing_schedules', 'book_blood_drawing', 'view_ta_availability',
      'manage_ta_availability', 'view_reports'],
    SchedulingAdmin: ['view', 'manage_slots', 'manage_bookings', 'manage_participants',
      'manage_blood_drawing_schedules', 'view_ta_availability', 'manage_ta_availability', 'view_reports'],
    StudyCoordinator: ['view', 'manage_slots', 'manage_bookings', 'manage_participants', 'view_reports'],
    Viewer: ['view', 'view_reports'],
    // TAs are restricted to the Blood Drawing module only, per spec section 4.
    TA: ['book_blood_drawing']
  },

  // Human-readable labels for every permission string, used to render the
  // "Manage Roles" checkbox grid. Keys must match ROLE_PERMISSIONS values.
  PERMISSIONS_CATALOG: [
    { key: 'view', label: 'View dashboard (read-only)' },
    { key: 'manage_admins', label: 'Manage administrators' },
    { key: 'manage_roles', label: 'Manage roles & permissions' },
    { key: 'manage_slots', label: 'Manage schedules' },
    { key: 'manage_bookings', label: 'Manage bookings' },
    { key: 'manage_participants', label: 'Manage participants' },
    { key: 'manage_calendar', label: 'Manage calendar integration' },
    { key: 'manage_notifications', label: 'Manage notifications' },
    { key: 'manage_checklists', label: 'Manage experiment checklists' },
    { key: 'manage_blood_drawing_schedules', label: 'Manage Blood Drawing schedules' },
    { key: 'book_blood_drawing', label: 'Book Blood Drawing appointments' },
    { key: 'view_ta_availability', label: 'View TA availability' },
    { key: 'manage_ta_availability', label: 'Manage TA availability' },
    { key: 'view_reports', label: 'View reports' }
  ],

  // Participant title options, offered as a required dropdown at booking
  // time and stored/used consistently in emails, calendar events, and
  // booking records.
  TITLES: ['Mr.', 'Ms.', 'Mrs.', 'Mx.', 'Dr.', 'Prof.'],

  // Default seed for the configurable Gender dropdown (see the
  // GenderOptions sheet / getGenderOptions() / updateGenderOptions() —
  // the Main Admin can edit this list at any time without a code change).
  GENDERS_DEFAULT: ['Female', 'Male', 'Non-binary', 'Prefer not to say'],

  // Every MRI slot defaults to this long, but the duration is editable per
  // slot (both at creation and, if needed, while building a schedule).
  MRI_DURATION_MINUTES: 90,

  // ---- 2026-08 requirements pass (round 7): Session Language ----
  // Day 1 and Day 2 slots can each optionally be tagged with the language
  // the session will be conducted in. 'any' (the default, and what every
  // pre-existing slot with no value is treated as) means no restriction —
  // it's shown to participants regardless of their selected language.
  // The participant portal's existing language picker (English/Deutsch,
  // asked before anything else) doubles as their language PREFERENCE for
  // slot visibility: only 'any' slots and slots matching that preference
  // are shown, in the participant portal, its self-service reschedule
  // flow, the Admin Booking Portal, and admin-side reschedule.
  SLOT_LANGUAGES: [
    { key: 'en', label: 'English' },
    { key: 'de', label: 'German' },
    { key: 'any', label: 'Any / No preference' }
  ],
  SLOT_LANGUAGE_DEFAULT: 'any',

  // Default "Time Before MRI" offset used to derive a new Day 1 slot's
  // start time from a chosen MRI slot's start time (Day1 Start = MRI Start
  // - this many minutes; Day1 End = MRI End). Editable per-schedule.
  DAY1_TIME_BEFORE_MRI_DEFAULT_MINUTES: 90,

  // Column indexes (0-based) for the Bookings sheet.
  BOOKING_COLS: {
    TIMESTAMP: 0,
    PARTICIPANT_ID: 1,
    NAME: 2,             // kept as the combined "First Last" display name for backward compatibility
    EMAIL: 3,
    DAY1_SLOT_ID: 4,
    DAY2_SLOT_ID: 5,
    // ---- Self-service booking management ----
    CONFIRMATION_NUMBER: 6,
    PASSCODE: 7,
    COMMENTS: 8,
    STATUS: 9,          // 'Booked' | 'Cancelled'
    AVAILABILITY: 10,   // future dates the participant offered on cancelling
    UPDATED_AT: 11,
    // ---- 2026-08 requirements pass (round 1) ----
    TITLE: 12,           // participant's selected title (Mr./Ms./Dr./...)
    CREATED_BY_ADMIN: 13, // admin email if this booking was created via the Admin Booking Portal; '' for self-service
    // ---- 2026-08 requirements pass (round 2) ----
    GENDER: 14,
    FIRST_NAME: 15,
    LAST_NAME: 16,
    // ---- round 7: Session Language ----
    // The participant's language preference (their selection at the start
    // of the portal) or, for admin-created bookings, whatever the admin
    // picked for them. Used to keep reschedule slot options consistent
    // with the language the participant originally booked in, even if the
    // admin viewing/rescheduling their booking is doing so in a different
    // UI language.
    LANGUAGE: 17
  },

  // Total width of a Bookings row, used when reading rows back.
  BOOKING_ROW_WIDTH: 18,

  // Column indexes (0-based) for the BloodDrawingSlots sheet.
  BLOOD_DRAWING_COLS: {
    SLOT_ID: 0,
    DATE: 1,
    START_TIME: 2,
    END_TIME: 3,
    BOOKED: 4,
    // ASSIGNED_TA holds a COMMA-SEPARATED list of TA emails (round 4, #1/#7:
    // multiple Technical Assistants may be assigned to one Blood Drawing
    // slot). A single email is simply a one-element list, so no data
    // migration is needed from earlier rounds. Read via getSlotTAEmails_().
    ASSIGNED_TA: 5,
    CALENDAR_EVENT_ID: 6,
    DAY1_SLOT_ID: 7,           // '' if manually added, not auto-derived from a Day 1 slot
    PARTICIPANT_CONFIRMATION: 8, // Bookings.ConfirmationNumber of the participant booked in, if any
    PARTICIPANT_NAME: 9,
    CREATED_BY: 10,
    CREATED_AT: 11,
    // ---- 2026-08 requirements pass (round 2) ----
    // Independent from ASSIGNED_TA (spec #7: "two independent assignments").
    // Defaults to the linked Day 1 slot's staff (spec #12) but is editable
    // separately at any time.
    ASSIGNED_STAFF: 12
  },

  // Default length of an auto-created Blood Drawing slot, covering the
  // first N minutes of a newly created Day 1 slot.
  BLOOD_DRAWING_DEFAULT_MINUTES: 30,

  // Column indexes (0-based) for the TAAvailability sheet.
  TA_AVAILABILITY_COLS: {
    TA_EMAIL: 0,
    TA_NAME: 1,
    DATE: 2,
    START_TIME: 3,
    END_TIME: 4,
    NOTES: 5,
    UPDATED_AT: 6
  },

  // Column indexes (0-based) for the StaffColors sheet — persists a stable,
  // unique Google Calendar colour per staff member so the same person's
  // events are always the same colour everywhere (schedule creation,
  // participant bookings, Blood Drawing, rescheduling, cancellations,
  // reassignment).
  STAFF_COLOR_COLS: {
    EMAIL: 0,
    COLOR_ID: 1
  },

  // Google Calendar event colour IDs (CalendarApp.EventColor / the numeric
  // "1".."11" palette) cycled through as new staff members are first
  // assigned a colour.
  CALENDAR_COLOR_CYCLE: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],

  // How many days ahead the Monday/Wednesday reminder emails look for
  // unbooked/unassigned Day1/Day2 slots and unassigned Blood Drawing slots.
  REMINDER_WINDOW_DAYS: 14,

  // Column indexes (0-based) for the new PostExperimentRecords sheet
  // (spec round 2, #11).
  POST_EXPERIMENT_COLS: {
    BOOKING_ID: 0,
    PARTICIPANT_TITLE: 1,
    PARTICIPANT_NAME: 2,
    PARTICIPANT_EMAIL: 3,
    MRI_SLOT_ID: 4,
    MRI_DATE_TIME: 5,
    DAY1_SLOT_ID: 6,
    DAY2_SLOT_ID: 7,
    BLOOD_DRAWING_SLOT_ID: 8,
    DAY1_STAFF: 9,
    DAY2_STAFF: 10,
    BLOOD_DRAWING_STAFF: 11,
    ASSIGNED_TA: 12,
    DAY1_COMPLETE: 13,
    BLOOD_DRAWING_COMPLETE: 14,
    MRI_COMPLETE: 15,
    DAY2_COMPLETE: 16,
    COMMENTS: 17,
    UPDATED_BY: 18,
    UPDATED_AT: 19
  },

  // Default Task Management catalog (spec round 2, #2) — the Main Admin can
  // create/edit/delete tasks and their allowed roles at any time from the
  // "Manage Tasks" screen; this list only seeds the Tasks sheet the first
  // time it's created.
  DEFAULT_TASKS: {
    'Day 1 Behaviour Experiment': ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator'],
    'Day 2 Behaviour Experiment': ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator'],
    'MRI': ['MainAdmin', 'SchedulingAdmin'],
    'Blood Drawing': ['MainAdmin', 'SchedulingAdmin', 'TA'],
    'Participant Booking': ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator'],
    'Blood Drawing Booking': ['MainAdmin', 'SchedulingAdmin', 'TA'],
    'Schedule Management': ['MainAdmin', 'SchedulingAdmin'],
    'Calendar Management': ['MainAdmin', 'SchedulingAdmin'],
    'Checklist Management': ['MainAdmin', 'StudyCoordinator'],
    'Reporting': ['MainAdmin', 'SchedulingAdmin', 'StudyCoordinator', 'Viewer']
  },

  // ---- 2026-08 requirements pass (round 4, #8): Email Notification Matrix ----
  // The set of notification EVENTS the Main Admin can route, and the set of
  // recipient GROUPS each event can be sent to. The actual event->groups
  // mapping lives in the NotificationSettings sheet (seeded from
  // NOTIFICATION_DEFAULTS), editable at any time from Manage Roles ->
  // Email Notification Settings. Keys are stable identifiers; labels are for
  // the UI only.
  NOTIFICATION_EVENTS: [
    { key: 'scheduleCreated', label: 'Schedule Created' },
    { key: 'scheduleUpdated', label: 'Schedule Updated' },
    { key: 'scheduleDeleted', label: 'Schedule Deleted' },
    { key: 'mriSlotCreated', label: 'MRI Slot Created' },
    { key: 'mriSlotUpdated', label: 'MRI Slot Updated' },
    { key: 'mriSlotDeleted', label: 'MRI Slot Deleted' },
    { key: 'day1SlotDeleted', label: 'Day 1 Slot Deleted' },
    { key: 'day2SlotDeleted', label: 'Day 2 Slot Deleted' },
    { key: 'day1SlotEdited', label: 'Day 1 Slot Edited (date/time/language)' },
    { key: 'day2SlotEdited', label: 'Day 2 Slot Edited (date/time/language)' },
    { key: 'bloodDrawingSlotDeleted', label: 'Blood Drawing Slot Deleted' },
    { key: 'bloodDrawingSlotCreated', label: 'Blood Drawing Slot Created' },
    { key: 'bulkSchedulingCompleted', label: 'Bulk Scheduling Completed' },
    { key: 'staffAssignment', label: 'Staff Assignment' },
    { key: 'staffReassignment', label: 'Staff Reassignment' },
    { key: 'bloodDrawingAssignment', label: 'Blood Drawing Assignment' },
    { key: 'bloodDrawingReassignment', label: 'Blood Drawing Reassignment' },
    { key: 'bloodDrawingUpdates', label: 'Blood Drawing Slot Updated' },
    { key: 'bloodDrawingSlotBooked', label: 'Blood Drawing Slot Booked' },
    { key: 'bloodDrawingSlotUnbooked', label: 'Blood Drawing Slot Unbooked' },
    { key: 'bloodDrawingUnassigned', label: 'Blood Drawing Slot Unassigned (no TA available)' },
    { key: 'day1ScheduleCreated', label: 'Day 1 Schedule Created' },
    { key: 'day2ScheduleCreated', label: 'Day 2 Schedule Created' },
    { key: 'participantBooking', label: 'Participant Booking' },
    { key: 'bookingRescheduled', label: 'Booking Rescheduled' },
    { key: 'bookingCancelled', label: 'Booking Cancelled' },
    { key: 'bookingUnbooked', label: 'Booking Unbooked (admin)' },
    { key: 'adminBookingUnbooked', label: 'Admin Unbooking' },
    { key: 'participantMessages', label: 'Participant Messages' },
    { key: 'taAvailabilitySubmitted', label: 'TA Availability Submitted' },
    { key: 'checklistUpdated', label: 'Experiment Checklist Updated' },
    { key: 'postExperimentUpdates', label: 'Post-Experiment Updates' },
    { key: 'weeklyReminder', label: 'Weekly Reminder Emails' },
    // ---- round 8: closing the last hardcoded "always all admins" gaps ----
    { key: 'participantDetailsUpdated', label: 'Participant Details Updated (Admin Edit)' },
    { key: 'adminAccountChanges', label: 'Admin Account Changes (created/removed/role/password)' }
  ],

  // Recipient groups an event can be routed to. Resolution to concrete email
  // addresses happens in resolveNotificationRecipients_(), given the context
  // of a specific event (assigned staff, TAs, participant, etc.).
  // 'MainAdmin' and 'OtherAdmins' are mutually exclusive and together make
  // up 'Admins' — 'OtherAdmins' is every ACTIVE admin EXCEPT whoever
  // currently holds the MainAdmin role, so the Main Admin can be routed
  // independently of the rest of the admin team (e.g. "notify every other
  // admin but not me").
  NOTIFICATION_GROUPS: [
    { key: 'MainAdmin', label: 'Main Admin' },
    { key: 'OtherAdmins', label: 'Other Admins (excl. Main Admin)' },
    { key: 'Admins', label: 'All Admins (incl. Main Admin)' },
    { key: 'AssignedStaff', label: 'Assigned Staff' },
    { key: 'BloodDrawingStaff', label: 'Blood Drawing Staff' },
    { key: 'TechnicalAssistants', label: 'Technical Assistants' },
    { key: 'Participants', label: 'Participants (where applicable)' }
  ],

  // Default event -> [groups] routing, seeded into NotificationSettings the
  // first time it's created.
  NOTIFICATION_DEFAULTS: {
    scheduleCreated: ['MainAdmin', 'AssignedStaff'],
    scheduleUpdated: ['MainAdmin', 'AssignedStaff'],
    scheduleDeleted: ['MainAdmin', 'AssignedStaff'],
    mriSlotCreated: ['MainAdmin', 'TechnicalAssistants'],
    mriSlotUpdated: ['MainAdmin'],
    mriSlotDeleted: ['MainAdmin'],
    day1SlotDeleted: ['MainAdmin', 'AssignedStaff'],
    day2SlotDeleted: ['MainAdmin', 'AssignedStaff'],
    day1SlotEdited: ['MainAdmin', 'AssignedStaff'],
    day2SlotEdited: ['MainAdmin', 'AssignedStaff'],
    bloodDrawingSlotDeleted: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotCreated: ['MainAdmin'],
    bulkSchedulingCompleted: ['MainAdmin'],
    staffAssignment: ['MainAdmin', 'AssignedStaff'],
    staffReassignment: ['MainAdmin', 'AssignedStaff'],
    bloodDrawingAssignment: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingReassignment: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingUpdates: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotBooked: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotUnbooked: ['MainAdmin', 'BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingUnassigned: ['MainAdmin'],
    day1ScheduleCreated: ['MainAdmin', 'AssignedStaff'],
    day2ScheduleCreated: ['MainAdmin', 'AssignedStaff'],
    participantBooking: ['MainAdmin', 'Participants'],
    bookingRescheduled: ['MainAdmin', 'AssignedStaff', 'Participants'],
    bookingCancelled: ['MainAdmin', 'AssignedStaff', 'Participants'],
    bookingUnbooked: ['MainAdmin', 'AssignedStaff'],
    adminBookingUnbooked: ['MainAdmin', 'AssignedStaff', 'BloodDrawingStaff', 'TechnicalAssistants'],
    participantMessages: ['MainAdmin', 'Admins'],
    taAvailabilitySubmitted: ['MainAdmin', 'TechnicalAssistants'],
    checklistUpdated: ['MainAdmin'],
    postExperimentUpdates: ['MainAdmin'],
    weeklyReminder: ['MainAdmin'],
    // ---- round 8 ----
    participantDetailsUpdated: ['MainAdmin'],
    adminAccountChanges: ['MainAdmin', 'OtherAdmins']
  },

  // ---- 2026-08 requirements pass (round 5, #3): Configurable Scheduling Rules ----
  // Experiment "types" the overlap engine reasons about. These map onto the
  // physical slot sheets/periods. The Main Admin can add/remove types and edit
  // the overlap matrix from the Admin Portal; these values only seed the
  // SchedulingRules sheet the first time it is created.
  //
  // Type keys and how they resolve to time spans during validation:
  //   MRI          -> an MRISlots row's [start,end]
  //   Day1BeforeMri-> the pre-MRI prep portion of a Day 1 slot (its span up to
  //                   the MRI start). Day 1's stored span already includes this.
  //   Day1         -> a Day1Slots row's full [start,end]
  //   Day2         -> a Day2Slots row's [start,end]
  //   BloodDrawing -> a BloodDrawingSlots row's [start,end]
  SCHEDULING_TYPES_DEFAULT: ['MRI', 'Day1BeforeMri', 'Day1', 'Day2', 'BloodDrawing'],

  // Default overlap permissions (Type A | Type B | allowed?). Order-independent:
  // the engine looks up {A,B} and {B,A}. "true" => overlap PERMITTED (a warning,
  // subject to the same-staff / same-TA hard block); "false" => overlap NOT
  // permitted (hard error). Anything not listed defaults to NOT allowed.
  SCHEDULING_RULES_DEFAULT: [
    { a: 'MRI', b: 'MRI', allowed: false },
    { a: 'MRI', b: 'Day1BeforeMri', allowed: true },
    { a: 'MRI', b: 'Day2', allowed: true },
    { a: 'MRI', b: 'BloodDrawing', allowed: true },
    { a: 'MRI', b: 'Day1', allowed: true },
    { a: 'Day1', b: 'Day2', allowed: false },
    { a: 'Day1', b: 'Day1', allowed: false },
    { a: 'Day2', b: 'Day2', allowed: false },
    { a: 'Day1', b: 'BloodDrawing', allowed: false },
    { a: 'Day2', b: 'BloodDrawing', allowed: false },
    { a: 'BloodDrawing', b: 'BloodDrawing', allowed: false },
    { a: 'Day1BeforeMri', b: 'Day1BeforeMri', allowed: false },
    { a: 'Day1BeforeMri', b: 'Day2', allowed: false },
    { a: 'Day1BeforeMri', b: 'BloodDrawing', allowed: false }
  ],

  // ---- 2026-08 requirements pass (round 6): Editable Email Templates ----
  // The placeholder catalog shown to the Main Admin in the Email Templates
  // editor. {{Name}} syntax; renderEmailTemplate_() substitutes whichever of
  // these a given template/context actually provides (missing ones resolve
  // to '').
  EMAIL_PLACEHOLDERS: [
    'ParticipantName', 'ParticipantTitle', 'BookingID', 'Passcode',
    'MriSlot', 'Day1Slot', 'Day2Slot', 'BloodDrawingSlot',
    'AssignedStaff', 'AssignedTAs', 'Date', 'Time',
    'AdminName', 'Comments', 'ConfirmationLink', 'RescheduleLink', 'CancelLink',
    'AdminPortalLink', 'Details'
  ],

  // Every editable template key, with its default bilingual subject + body.
  // Seeded into the EmailTemplates sheet the first time it's created; the
  // Main Admin can edit subject/body in both languages from the Admin
  // Portal without any code changes. Bodies use the same {{Placeholder}}
  // syntax as EMAIL_PLACEHOLDERS above.
  EMAIL_TEMPLATES_DEFAULT: {
    bookingConfirmation: {
      subjectDe: 'Buchungsbestätigung', subjectEn: 'Booking Confirmation',
      bodyDe: 'Hallo {{ParticipantName}},\n\nIhre Buchung ist bestätigt.\n\nBuchungs-ID: {{BookingID}}\nTag 1: {{Day1Slot}}\nTag 2: {{Day2Slot}}\n\nVerwalten Sie Ihren Termin: {{RescheduleLink}}',
      bodyEn: 'Hi {{ParticipantName}},\n\nYour booking is confirmed.\n\nBooking ID: {{BookingID}}\nDay 1: {{Day1Slot}}\nDay 2: {{Day2Slot}}\n\nManage your booking: {{RescheduleLink}}'
    },
    // ---- 2026-08 requirements pass (round 14, #8/#11): these are sent to
    // ADMINS/STAFF (via notifyBookingChange_ -> resolveNotificationRecipients_),
    // not to the participant (who already gets their own unconditional,
    // separately-worded confirmation/cancellation email) — so, like
    // day1SlotDeleted etc., they render from the event's own {{Details}}
    // lines rather than a "Hi {{ParticipantName}}" participant greeting.
    // Previously these named {{ParticipantName}}/{{BookingID}}/{{Day1Slot}}/
    // {{Day2Slot}} placeholders that were never populated by the caller,
    // so the email rendered with those fields blank — exactly the "missing/
    // blank Booking ID" defect spec #11 calls out. {{Details}} is always
    // populated by the caller with the concrete Booking ID, Day 1/Day 2
    // slot, participant, and MRI slot where relevant.
    bookingRescheduled: {
      subjectDe: 'Termin umgebucht', subjectEn: 'Booking Rescheduled',
      bodyDe: 'Ein Termin wurde umgebucht.\n\n{{Details}}',
      bodyEn: 'A booking has been rescheduled.\n\n{{Details}}'
    },
    bookingCancelled: {
      subjectDe: 'Termin storniert', subjectEn: 'Booking Cancelled',
      bodyDe: 'Ein Termin wurde storniert.\n\n{{Details}}',
      bodyEn: 'A booking has been cancelled.\n\n{{Details}}'
    },
    bookingUnbooked: {
      subjectDe: 'Termin abgesagt', subjectEn: 'Booking Unbooked',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    adminBookingUnbooked: {
      subjectDe: 'Admin-Absage', subjectEn: 'Admin Unbooking',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    bloodDrawingSlotBooked: {
      subjectDe: 'Blutentnahme gebucht', subjectEn: 'Blood Drawing Slot Booked',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    bloodDrawingSlotUnbooked: {
      subjectDe: 'Blutentnahme freigegeben', subjectEn: 'Blood Drawing Slot Unbooked',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    day1ScheduleCreated: {
      subjectDe: 'Tag-1-Zeitplan erstellt', subjectEn: 'Day 1 Schedule Created',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    day2ScheduleCreated: {
      subjectDe: 'Tag-2-Zeitplan erstellt', subjectEn: 'Day 2 Schedule Created',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    scheduleCreated: {
      subjectDe: 'Neuer Zeitplan erstellt', subjectEn: 'Schedule Created',
      bodyDe: 'Ein neuer Zeitplan wurde erstellt.\n\nMRT: {{MriSlot}}\nTag 1: {{Day1Slot}}\nTag 2: {{Day2Slot}}\nZugewiesenes Personal: {{AssignedStaff}}\nErstellt von: {{AdminName}}',
      bodyEn: 'A new schedule has been created.\n\nMRI: {{MriSlot}}\nDay 1: {{Day1Slot}}\nDay 2: {{Day2Slot}}\nAssigned staff: {{AssignedStaff}}\nCreated by: {{AdminName}}'
    },
    scheduleUpdated: {
      subjectDe: 'Zeitplan aktualisiert', subjectEn: 'Schedule Updated',
      bodyDe: 'Der Zeitplan wurde aktualisiert.\n\nMRT: {{MriSlot}}\nTag 1: {{Day1Slot}}\nTag 2: {{Day2Slot}}',
      bodyEn: 'The schedule has been updated.\n\nMRI: {{MriSlot}}\nDay 1: {{Day1Slot}}\nDay 2: {{Day2Slot}}'
    },
    scheduleDeleted: {
      subjectDe: 'Zeitplan gelöscht', subjectEn: 'Schedule Deleted',
      // Round 14 fix: was using {{Day1Slot}}/{{Day2Slot}}/{{AdminName}}
      // placeholders that the actual callers (notifyScheduleDeleted_ /
      // notifyAdminOfChange_) never populate — only {{Details}} — so this
      // rendered with those fields blank. See the note above bookingCancelled.
      bodyDe: 'Ein Zeitplan wurde gelöscht.\n\n{{Details}}',
      bodyEn: 'A schedule has been deleted.\n\n{{Details}}'
    },
    mriSlotCreated: {
      subjectDe: 'MRT-Termin(e) erstellt', subjectEn: 'MRI Slot(s) Created',
      bodyDe: 'Neue MRT-Termine wurden erstellt:\n\n{{Details}}\n\n' +
        'Technische Assistenz: Bitte reichen Sie Ihre Verfügbarkeit für die zugehörigen Blutentnahme-Termine über das Verfügbarkeitsportal ein oder aktualisieren Sie sie.\n' +
        'Admins: Bitte fügen Sie diese MRT-Termine bei Bedarf über „MRT-Termin \u2192 Zum Zeitplan hinzufügen" zum Terminplan hinzu.\n\n' +
        'Admin-Portal: {{AdminPortalLink}}',
      bodyEn: 'New MRI slot(s) were created:\n\n{{Details}}\n\n' +
        'Technical Assistants: please submit or update your availability for the associated Blood Drawing slots via the Availability Portal.\n' +
        'Admins: please add these MRI slots to the schedule as needed, via "MRI slot \u2192 Add to Schedule".\n\n' +
        'Admin Portal: {{AdminPortalLink}}'
    },
    mriSlotUpdated: {
      subjectDe: 'MRT-Termin aktualisiert', subjectEn: 'MRI Slot Updated',
      bodyDe: 'Der MRT-Termin {{MriSlot}} wurde aktualisiert.',
      bodyEn: 'MRI slot {{MriSlot}} has been updated.'
    },
    mriSlotDeleted: {
      subjectDe: 'MRT-Termin gelöscht', subjectEn: 'MRI Slot Deleted',
      // Round 14 fix (spec #9): was using {{MriSlot}}/{{AdminName}}
      // placeholders that deleteMriSlot's notifyAdminOfChange_ call never
      // populates — only {{Details}} — so the MRI ID/date/time and
      // "Deleted by" rendered blank. deleteMriSlot's detail lines now spell
      // out the MRI ID, Date/Time, and Deleted by explicitly.
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    staffAssignment: {
      subjectDe: 'Personalzuweisung', subjectEn: 'Staff Assignment',
      bodyDe: 'Sie wurden zugewiesen:\n\n{{Day1Slot}}{{Day2Slot}}\nDatum: {{Date}}\nZeit: {{Time}}',
      bodyEn: 'You have been assigned:\n\n{{Day1Slot}}{{Day2Slot}}\nDate: {{Date}}\nTime: {{Time}}'
    },
    staffReassignment: {
      subjectDe: 'Personal neu zugewiesen', subjectEn: 'Staff Reassignment',
      // Round 14 fix: notifyStaffReassignment_ (used by reassignStaff /
      // reassignDay2Staff) builds its own body directly and doesn't use
      // this template at all; but saveScheduleEdits' admin summary notice
      // DOES go through notifyAdminOfChange_ with only {{Details}}
      // populated, so the old {{AssignedStaff}}/{{AdminName}} placeholders
      // rendered blank there. {{Details}} carries the actual per-person diff.
      bodyDe: 'Eine Zuweisung hat sich geändert.\n\n{{Details}}',
      bodyEn: 'An assignment has changed.\n\n{{Details}}'
    },
    bloodDrawingAssignment: {
      subjectDe: 'Blutentnahme-Zuweisung', subjectEn: 'Blood Drawing Assignment',
      bodyDe: 'Blutentnahme-Termin: {{BloodDrawingSlot}}\nPersonal: {{AssignedStaff}}\nTechnische Assistenz: {{AssignedTAs}}',
      bodyEn: 'Blood Drawing slot: {{BloodDrawingSlot}}\nStaff: {{AssignedStaff}}\nTechnical Assistant(s): {{AssignedTAs}}'
    },
    bloodDrawingReassignment: {
      subjectDe: 'Blutentnahme neu zugewiesen', subjectEn: 'Blood Drawing Reassignment',
      bodyDe: 'Die Zuweisung für den Blutentnahme-Termin {{BloodDrawingSlot}} wurde geändert.\nPersonal: {{AssignedStaff}}\nTechnische Assistenz: {{AssignedTAs}}',
      bodyEn: 'The assignment for Blood Drawing slot {{BloodDrawingSlot}} has changed.\nStaff: {{AssignedStaff}}\nTechnical Assistant(s): {{AssignedTAs}}'
    },
    bloodDrawingSlotCreated: {
      subjectDe: 'Blutentnahme-Termin erstellt', subjectEn: 'Blood Drawing Slot Created',
      bodyDe: 'Ein neuer Blutentnahme-Termin wurde erstellt.\n\n{{Details}}',
      bodyEn: 'A new Blood Drawing slot has been created.\n\n{{Details}}'
    },
    bloodDrawingUpdates: {
      subjectDe: 'Blutentnahme aktualisiert', subjectEn: 'Blood Drawing Update',
      bodyDe: 'Blutentnahme-Termin {{BloodDrawingSlot}} wurde aktualisiert.\nPersonal: {{AssignedStaff}}\nTechnische Assistenz: {{AssignedTAs}}',
      bodyEn: 'Blood Drawing slot {{BloodDrawingSlot}} was updated.\nStaff: {{AssignedStaff}}\nTechnical Assistant(s): {{AssignedTAs}}'
    },
    bloodDrawingUnassigned: {
      subjectDe: 'Blutentnahme-Termin unbesetzt', subjectEn: 'Blood Drawing Slot Unassigned',
      bodyDe: 'Blutentnahme-Termin {{BloodDrawingSlot}} hat keine verfügbare technische Assistenz und bleibt unbesetzt. Bitte weisen Sie im Blutentnahme-Portal manuell eine TA zu.\n\nAdmin-Portal: {{AdminPortalLink}}',
      bodyEn: 'Blood Drawing slot {{BloodDrawingSlot}} has no available Technical Assistant and was left unassigned. Please assign a TA manually via the Blood Drawing portal.\n\nAdmin Portal: {{AdminPortalLink}}'
    },
    taAvailabilitySubmitted: {
      subjectDe: 'Verfügbarkeitsanfrage für technische Assistenz', subjectEn: 'Technical Assistant Availability Request',
      bodyDe: 'Bitte reichen Sie Ihre Verfügbarkeit für Blutentnahme-Termine ein oder aktualisieren Sie sie.',
      bodyEn: 'Please submit or update your availability for Blood Drawing slots.'
    },
    taAvailabilityConfirmation: {
      subjectDe: 'Verfügbarkeit bestätigt', subjectEn: 'Technical Assistant Availability Confirmation',
      bodyDe: '{{AdminName}} hat seine/ihre Verfügbarkeit aktualisiert.\nDatum: {{Date}}\nZeit: {{Time}}',
      bodyEn: '{{AdminName}} has updated their availability.\nDate: {{Date}}\nTime: {{Time}}'
    },
    weeklyReminder: {
      subjectDe: 'Wöchentliche Erinnerung', subjectEn: 'Weekly Reminder',
      bodyDe: 'Dies ist Ihre wöchentliche Erinnerung an ausstehende Termine.',
      bodyEn: 'This is your weekly reminder about pending slots.'
    },
    passwordReset: {
      subjectDe: 'Passwort zurücksetzen', subjectEn: 'Password Reset',
      bodyDe: 'Ihr Bestätigungscode: {{Passcode}}\nDieser Code läuft in {{Time}} ab.\n\nWenn Sie dies nicht angefordert haben, ignorieren Sie diese E-Mail.',
      bodyEn: 'Your verification code: {{Passcode}}\nThis code expires in {{Time}}.\n\nIf you did not request this, you can ignore this email.'
    },
    forgotPassword: {
      subjectDe: 'Passwort vergessen', subjectEn: 'Forgot Password',
      bodyDe: 'Ihr Bestätigungscode: {{Passcode}}',
      bodyEn: 'Your verification code: {{Passcode}}'
    },
    adminApproval: {
      subjectDe: 'Admin-Konto erstellt', subjectEn: 'Admin Approval',
      bodyDe: 'Für Sie wurde ein Admin-Konto erstellt.\nE-Mail: {{ParticipantName}}\nAnfangspasswort: {{Passcode}}',
      bodyEn: 'An admin account has been created for you.\nEmail: {{ParticipantName}}\nInitial password: {{Passcode}}'
    },
    participantMessages: {
      subjectDe: 'Teilnehmer-Kontaktnachricht', subjectEn: 'Participant Contact Message',
      bodyDe: 'Name: {{ParticipantName}}\nNachricht: {{Comments}}',
      bodyEn: 'Name: {{ParticipantName}}\nMessage: {{Comments}}'
    },
    postExperimentUpdates: {
      subjectDe: 'Post-Experiment-Update', subjectEn: 'Post-Experiment Notification',
      bodyDe: 'Aktualisierung zu {{ParticipantName}}: {{Comments}}',
      bodyEn: 'Update for {{ParticipantName}}: {{Comments}}'
    },
    // ---- round 10: closing the "routable but not wordable" gap. Each of
    // these was already controllable in the Notification Settings matrix
    // (who receives it) but had no matching entry here, so its wording was
    // hardcoded and not editable from the Admin Portal. All use a generic
    // {{Details}} placeholder — the specific event's detail lines, one per
    // line — since these events cover a variable set of facts rather than
    // a fixed small set of named fields.
    day1SlotDeleted: {
      subjectDe: 'Tag-1-Termin gelöscht', subjectEn: 'Day 1 Slot Deleted',
      bodyDe: 'Ein Tag-1-Termin wurde gelöscht.\n\n{{Details}}',
      bodyEn: 'A Day 1 slot has been deleted.\n\n{{Details}}'
    },
    day2SlotDeleted: {
      subjectDe: 'Tag-2-Termin gelöscht', subjectEn: 'Day 2 Slot Deleted',
      bodyDe: 'Ein Tag-2-Termin wurde gelöscht.\n\n{{Details}}',
      bodyEn: 'A Day 2 slot has been deleted.\n\n{{Details}}'
    },
    day1SlotEdited: {
      subjectDe: 'Tag-1-Termin bearbeitet', subjectEn: 'Day 1 Slot Edited',
      bodyDe: 'Ein Tag-1-Termin wurde bearbeitet.\n\n{{Details}}',
      bodyEn: 'A Day 1 slot has been edited.\n\n{{Details}}'
    },
    day2SlotEdited: {
      subjectDe: 'Tag-2-Termin bearbeitet', subjectEn: 'Day 2 Slot Edited',
      bodyDe: 'Ein Tag-2-Termin wurde bearbeitet.\n\n{{Details}}',
      bodyEn: 'A Day 2 slot has been edited.\n\n{{Details}}'
    },
    bloodDrawingSlotDeleted: {
      subjectDe: 'Blutentnahme-Termin gelöscht', subjectEn: 'Blood Drawing Slot Deleted',
      bodyDe: 'Ein Blutentnahme-Termin wurde gelöscht.\n\n{{Details}}',
      bodyEn: 'A Blood Drawing slot has been deleted.\n\n{{Details}}'
    },
    participantDetailsUpdated: {
      subjectDe: 'Teilnehmerdaten aktualisiert', subjectEn: 'Participant Details Updated',
      bodyDe: 'Die Kontaktdaten einer teilnehmenden Person wurden von einem Admin aktualisiert.\n\n{{Details}}',
      bodyEn: 'A participant\u2019s contact details were updated by an admin.\n\n{{Details}}'
    },
    adminAccountChanges: {
      subjectDe: 'Admin-Kontoänderung', subjectEn: 'Admin Account Change',
      bodyDe: 'Es gab eine Änderung an einem Admin-Konto.\n\n{{Details}}',
      bodyEn: 'There has been a change to an admin account.\n\n{{Details}}'
    },
    bulkSchedulingCompleted: {
      subjectDe: 'Sammel-Terminerstellung abgeschlossen', subjectEn: 'Bulk Scheduling Completed',
      bodyDe: 'Eine Sammel-Terminerstellung wurde abgeschlossen.\n\n{{Details}}',
      bodyEn: 'A bulk schedule creation has completed.\n\n{{Details}}'
    },
    reminderUnassigned: {
      subjectDe: 'Erinnerung: Nicht zugewiesene Termine', subjectEn: 'Reminder: Unassigned Slots',
      bodyDe: 'Die folgenden Termine haben in den nächsten zwei Wochen kein zugewiesenes Personal.\n\n{{Details}}',
      bodyEn: 'The following slots have no assigned staff in the next two weeks.\n\n{{Details}}'
    },
    reminderUnbooked: {
      subjectDe: 'Erinnerung: Nicht gebuchte Termine', subjectEn: 'Reminder: Unbooked Slots',
      bodyDe: 'Die folgenden Termine sind in den nächsten zwei Wochen noch nicht gebucht.\n\n{{Details}}',
      bodyEn: 'The following slots are still unbooked in the next two weeks.\n\n{{Details}}'
    },
    participantBooking: {
      subjectDe: 'Teilnehmer-Buchung', subjectEn: 'Participant Booking',
      bodyDe: '{{Details}}',
      bodyEn: '{{Details}}'
    },
    checklistUpdated: {
      subjectDe: 'Experiment-Checkliste aktualisiert', subjectEn: 'Experiment Checklist Updated',
      bodyDe: 'Die Experiment-Checkliste wurde aktualisiert.\n\n{{Details}}',
      bodyEn: 'The experiment checklist has been updated.\n\n{{Details}}'
    }
  },

  // ---- 2026-08 requirements pass (round 6): Calendar Invitation Settings ----
  CALENDAR_ACTIVITIES: [
    { key: 'mriSlotCreated', label: 'MRI Slot Created' },
    { key: 'mriSlotUpdated', label: 'MRI Slot Updated' },
    { key: 'mriSlotDeleted', label: 'MRI Slot Deleted' },
    { key: 'day1ScheduleCreated', label: 'Day 1 Schedule Created' },
    { key: 'day2ScheduleCreated', label: 'Day 2 Schedule Created' },
    { key: 'scheduleUpdated', label: 'Schedule Updated' },
    { key: 'scheduleDeleted', label: 'Schedule Deleted' },
    { key: 'bloodDrawingSlotCreated', label: 'Blood Drawing Slot Created' },
    { key: 'bloodDrawingSlotUpdated', label: 'Blood Drawing Slot Updated' },
    { key: 'bloodDrawingSlotBooked', label: 'Blood Drawing Slot Booked' },
    { key: 'bloodDrawingSlotUnbooked', label: 'Blood Drawing Slot Unbooked' },
    { key: 'bloodDrawingSlotDeleted', label: 'Blood Drawing Slot Deleted' },
    { key: 'participantBooking', label: 'Participant Booking' },
    { key: 'bookingRescheduled', label: 'Booking Rescheduled' },
    { key: 'bookingCancelled', label: 'Booking Cancelled' },
    { key: 'adminBookingUnbooked', label: 'Admin Unbooking' },
    { key: 'staffAssignment', label: 'Staff Assignment' },
    { key: 'staffReassignment', label: 'Staff Reassignment' }
  ],
  CALENDAR_RECIPIENT_GROUPS: [
    { key: 'MainAdmin', label: 'Main Admin' },
    { key: 'OtherAdmins', label: 'Other Admins (excl. Main Admin)' },
    { key: 'Admins', label: 'All Admins (incl. Main Admin)' },
    { key: 'SlotCreator', label: 'Slot Creator' },
    { key: 'AssignedStaff', label: 'Assigned Staff' },
    { key: 'BloodDrawingStaff', label: 'Assigned Blood Drawing Staff' },
    { key: 'TechnicalAssistants', label: 'Assigned Technical Assistant(s)' },
    { key: 'Participant', label: 'Participant (where applicable)' }
  ],
  // Default recipient groups invited to each activity's calendar event.
  CALENDAR_INVITE_DEFAULTS: {
    mriSlotCreated: [],
    mriSlotUpdated: [],
    mriSlotDeleted: [],
    day1ScheduleCreated: ['AssignedStaff'],
    day2ScheduleCreated: ['AssignedStaff'],
    scheduleUpdated: ['AssignedStaff'],
    scheduleDeleted: [],
    bloodDrawingSlotCreated: ['BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotUpdated: ['BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotBooked: ['BloodDrawingStaff', 'TechnicalAssistants', 'Participant'],
    bloodDrawingSlotUnbooked: ['BloodDrawingStaff', 'TechnicalAssistants'],
    bloodDrawingSlotDeleted: [],
    participantBooking: ['AssignedStaff', 'Participant'],
    bookingRescheduled: ['AssignedStaff', 'Participant'],
    bookingCancelled: [],
    adminBookingUnbooked: ['AssignedStaff'],
    staffAssignment: ['AssignedStaff'],
    staffReassignment: ['AssignedStaff']
  },


  // Prefix for human-readable confirmation numbers: EXP-<year>-<seq>.
  CONFIRMATION_PREFIX: 'EXP',

  // ---- Automatic Day1 -> Day2 compatibility window ----
  MAPPING_WINDOW_MIN_HOURS: 22,
  MAPPING_WINDOW_MAX_HOURS: 26,

  // Bilingual experiment name, used in confirmation emails.
  EXPERIMENT_NAME: {
    en: 'Two-Day Research Experiment',
    de: 'Zweitägiges Forschungsexperiment'
  },

  // Experiment location, shown on the confirmation screen and in the email.
  LOCATION: {
    address: 'Brenneckestraße 6, 39118 Magdeburg',
    mapsUrl: 'https://share.google/fGVtmqDfgzVR1vns8'
  },

  // Shown in confirmation emails and the participant help section.
  CONTACT: {
    email: 'altersstudie@lin-magdeburg.de',
    phone: '+49 391 6263 92072'
  },

  // Email sign-off.
  SIGNATURE: {
    name: 'Manoj Pandiri',
    roleEn: 'Doctoral Student, LIN',
    roleDe: 'Doktorand, LIN',
    email: 'neuropsychologie.lin@googlemail.com'
  },

  // This email address is exempt from the "one booking per email" rule.
  EMAIL_DUPLICATE_EXCEPTION: 'neuropsychologie.lin@googlemail.com',

  // Optional: BCC every confirmation email to the research team. Leave '' to disable.
  ADMIN_BCC_EMAIL: '', // deprecated, round 8 — no longer read anywhere; see sendConfirmationEmail_

  // Max time (ms) to wait for the booking lock before giving up.
  LOCK_TIMEOUT_MS: 30000,

  // Participant bookings are mirrored as calendar events onto THIS Google
  // Calendar (Day 1 and Day 2 each get their own event, carrying the
  // participant name, assigned staff, and booking status).
  //
  // IMPORTANT SETUP: for this to work, that calendar must be shared with
  // the account this script runs as, with "Make changes to events"
  // permission. If it is not shared, event creation fails silently (logged
  // only) and the booking itself still succeeds.
  PARTICIPANT_CALENDAR_EMAIL: 'neuropsychologie.lin@googlemail.com',

  // ---- Admin portal ----
  // Informational only — the real "only the owner can even reach this page"
  // guarantee comes from deploying the admin URL with Web App access set to
  // "Only myself" (see README). This value is just shown on the admin login
  // screen as a sanity-check banner, AND is used to seed the very first
  // MainAdmin account (see ensureMainAdminSeeded_) the first time the
  // Admins sheet is empty.
  ADMIN_OWNER_EMAIL: 'altersstudie@lin-magdeburg.de',

  // Initial password for that seeded first MainAdmin account. Change it
  // (via "Change Password") immediately after first login.
  ADMIN_DEFAULT_PASSWORD: '123456',

  // How long an admin login stays valid, in seconds (sliding expiration).
  ADMIN_SESSION_TTL_SECONDS: 1800, // 30 minutes

  // How long a password-change verification code stays valid, in seconds.
  ADMIN_OTP_TTL_SECONDS: 600, // 10 minutes

  // ---- Slot duration defaults (admin "Add slot" forms use duration
  // instead of an editable end time; the end time is always derived). ----
  DAY1_DEFAULT_DURATION_MINUTES: 180,
  DAY2_DEFAULT_DURATION_MINUTES: 60,

  // NOTE: schedule-change notifications are no longer sent to a single
  // fixed address — they go to EVERY active admin in the Admins sheet
  // (Main Admin included). See getAllAdminEmails_() / notifyAdminOfChange_().
};

/**
 * Bilingual user-facing messages for the PARTICIPANT booking flow.
 */
var MESSAGES = {
  en: {
    invalidData: 'No booking data received.',
    day1Required: 'Please select a Day 1 slot.',
    day2Required: 'Please select a Day 2 slot.',
    titleRequired: 'Please select a title.',
    genderRequired: 'Please select a gender.',
    firstNameRequired: 'Please enter your first name.',
    lastNameRequired: 'Please enter your last name.',
    nameRequired: 'Please enter your name.',
    emailRequired: 'Please enter your email address.',
    emailInvalid: 'Please enter a valid email address.',
    nameTooLong: 'Name is too long.',
    systemBusy: 'The system is busy processing another booking. Please try again in a moment.',
    emailUsed: 'This email address has already been used to complete a booking.',
    slotNotFound: 'The selected appointment slot could not be found.',
    day1Gone: 'The selected Day 1 slot no longer exists.',
    day1Taken: 'Sorry — that Day 1 slot was just booked by someone else. Please choose another.',
    day2Gone: 'The selected Day 2 slot no longer exists.',
    mappingInvalid: 'That Day 2 slot is no longer compatible with your selected Day 1 slot. Please reselect.',
    day2Taken: 'Sorry — that Day 2 slot was just booked by someone else. Please choose another.',
    bookingConfirmed: 'Booking confirmed!',
    invalidCredentials: 'Invalid Confirmation Number or Passcode.',
    bookingCancelled: 'This booking has already been cancelled.',
    rescheduled: 'Your appointment has been rescheduled.',
    cancelled: 'Your appointment has been cancelled.',
    detailsUpdated: 'Your details have been updated.',
    noChangeSelected: 'Please choose a different Day 1 or Day 2 appointment to reschedule to.'
  },
  de: {
    invalidData: 'Es wurden keine Buchungsdaten empfangen.',
    day1Required: 'Bitte wählen Sie einen Termin für Tag 1.',
    day2Required: 'Bitte wählen Sie einen Termin für Tag 2.',
    titleRequired: 'Bitte wählen Sie eine Anrede aus.',
    genderRequired: 'Bitte wählen Sie ein Geschlecht aus.',
    firstNameRequired: 'Bitte geben Sie Ihren Vornamen ein.',
    lastNameRequired: 'Bitte geben Sie Ihren Nachnamen ein.',
    nameRequired: 'Bitte geben Sie Ihren Namen ein.',
    emailRequired: 'Bitte geben Sie Ihre E-Mail-Adresse ein.',
    emailInvalid: 'Bitte geben Sie eine gültige E-Mail-Adresse ein.',
    nameTooLong: 'Der Name ist zu lang.',
    systemBusy: 'Das System verarbeitet gerade eine andere Buchung. Bitte versuchen Sie es gleich noch einmal.',
    emailUsed: 'Diese E-Mail-Adresse wurde bereits für eine Buchung verwendet.',
    slotNotFound: 'Der ausgewählte Termin konnte nicht gefunden werden.',
    day1Gone: 'Der ausgewählte Termin für Tag 1 existiert nicht mehr.',
    day1Taken: 'Dieser Termin für Tag 1 wurde soeben von einer anderen Person gebucht. Bitte wählen Sie einen anderen.',
    day2Gone: 'Der ausgewählte Termin für Tag 2 existiert nicht mehr.',
    mappingInvalid: 'Dieser Termin für Tag 2 passt nicht mehr zu Ihrem gewählten Termin für Tag 1. Bitte wählen Sie erneut.',
    day2Taken: 'Dieser Termin für Tag 2 wurde soeben von einer anderen Person gebucht. Bitte wählen Sie einen anderen.',
    bookingConfirmed: 'Buchung bestätigt!',
    invalidCredentials: 'Ungültige Bestätigungsnummer oder ungültiger Zugangscode.',
    bookingCancelled: 'Diese Buchung wurde bereits storniert.',
    rescheduled: 'Ihr Termin wurde verschoben.',
    cancelled: 'Ihr Termin wurde storniert.',
    detailsUpdated: 'Ihre Daten wurden aktualisiert.',
    noChangeSelected: 'Bitte wählen Sie einen anderen Termin für Tag 1 oder Tag 2 aus.'
  }
};

/** Weekday / month names for locale-correct date formatting. */
var WEEKDAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
};
var MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']
};

/**
 * ----------------------------------------------------------------------------
 * WEB APP ENTRY POINT / ROUTING
 * ----------------------------------------------------------------------------
 */

/**
 * Serves either the participant booking page or the admin portal.
 *
 * Deploy this script twice (see README): once with public "Anyone" access
 * for the booking page, and once with "Only myself" access for the admin
 * portal.
 *
 * ROUTING:
 *   1. An explicit "?page=admin" or "?admin=true" query parameter always
 *      wins, on either deployment — handy for bookmarking or testing.
 *   2. Otherwise, if this request is running under the "Only myself"
 *      restricted deployment, default straight to the Admin portal — no
 *      query parameter required.
 *   3. Otherwise, default to the participant booking page.
 *
 * NOTE ON DETECTION METHOD: this deliberately uses Session.getActiveUser()
 * rather than Session.getEffectiveUser(). Both admin and public deployments
 * here run with "Execute as: Me", which means getEffectiveUser() ALWAYS
 * returns the script owner's own email on every request, regardless of who
 * is actually visiting — it describes who the *code* runs as, not who is
 * *visiting*. Using it to gate the admin default would make the admin
 * portal the default view for literally every participant too, which is
 * the opposite of what we want.
 * getActiveUser(), by contrast, reflects the *visitor's* signed-in Google
 * identity when Apps Script is able to determine it — which it reliably
 * can here, precisely because the admin deployment's "Only myself" access
 * restriction forces Google to authenticate the visitor as the owner
 * before doGet() ever runs. On the public deployment, a participant's
 * active user will essentially never match the configured owner email, so
 * they keep seeing the booking page as before.
 *
 * @param {Object} e - Event object from the GET request.
 * @return {HtmlOutput}
 */
function doGet(e) {
  var param = (e && e.parameter) || {};
  var explicitPage = param.page || (param.admin === 'true' ? 'admin' : '');

  // The Manage Appointment portal is public (it authenticates with the
  // participant's own confirmation number + passcode) and takes precedence
  // over the owner auto-routing below.
  if (param.action === 'manage' || explicitPage === 'manage') {
    return HtmlService.createTemplateFromFile('Manage')
      .evaluate()
      .setTitle(CONFIG.EXPERIMENT_NAME.en + ' — Manage Appointment')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  var page = explicitPage;
  if (page !== 'admin' && page !== 'book') {
    page = isOwnerVisiting_() ? 'admin' : 'book';
  }

  if (page === 'admin') {
    return HtmlService.createTemplateFromFile('Admin')
      .evaluate()
      .setTitle('Admin — ' + CONFIG.EXPERIMENT_NAME.en)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(CONFIG.EXPERIMENT_NAME.en + ' — Booking')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Best-effort check for "the person loading this page is signed in as the
 * configured admin owner account". See the long comment on doGet() above
 * for why this uses getActiveUser() and not getEffectiveUser(). Never
 * throws — if Apps Script can't determine the active user for any reason,
 * this safely falls back to false (i.e. show the booking page, and require
 * the explicit ?page=admin / ?admin=true override instead).
 * @return {boolean}
 */
function isOwnerVisiting_() {
  try {
    var email = Session.getActiveUser().getEmail();
    return !!email && email.toLowerCase() === CONFIG.ADMIN_OWNER_EMAIL.toLowerCase();
  } catch (err) {
    return false;
  }
}

/**
 * Allows HTML files to include other HTML files (CSS/JS partials).
 * @param {string} filename
 * @return {string} raw file contents
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * ----------------------------------------------------------------------------
 * LANGUAGE HELPERS (participant-facing only)
 * ----------------------------------------------------------------------------
 */

function normalizeLang_(lang) {
  return (lang === 'de') ? 'de' : 'en';
}

/**
 * Normalizes a Day 1/Day 2 slot's stored Language value to one of
 * CONFIG.SLOT_LANGUAGES' keys, defaulting to CONFIG.SLOT_LANGUAGE_DEFAULT
 * ('any') for blank/unrecognized values — this is what makes every
 * pre-existing slot (created before this field existed) visible to
 * everyone rather than to nobody.
 * @param {*} value
 * @return {string} 'en' | 'de' | 'any'
 */
function normalizeSlotLanguage_(value) {
  var v = String(value || '').trim().toLowerCase();
  var valid = CONFIG.SLOT_LANGUAGES.some(function (l) { return l.key === v; });
  return valid ? v : CONFIG.SLOT_LANGUAGE_DEFAULT;
}

/**
 * Whether a slot tagged with slotLanguage should be shown to someone whose
 * preference is filterLanguage. 'any' on either side always matches — an
 * unset/blank filter means "no restriction requested" (e.g. an admin
 * browsing without a specific participant in mind), and an 'any' slot is
 * explicitly open to either language.
 * @param {*} slotLanguage
 * @param {*} filterLanguage
 * @return {boolean}
 */
function slotLanguageMatchesFilter_(slotLanguage, filterLanguage) {
  var filter = String(filterLanguage || '').trim().toLowerCase();
  if (!filter || filter === 'any') return true;
  var slot = normalizeSlotLanguage_(slotLanguage);
  return slot === 'any' || slot === filter;
}

/** Human-readable label for a normalized slot-language key, for change-diff emails. */
function slotLanguageLabel_(key) {
  var match = CONFIG.SLOT_LANGUAGES.filter(function (l) { return l.key === normalizeSlotLanguage_(key); })[0];
  return match ? match.label : String(key || '');
}

/**
 * ----------------------------------------------------------------------------
 * EXACT-CHANGE DIFF LINES (2026-08 requirements pass, #8)
 * ----------------------------------------------------------------------------
 * Every edit/update email must contain EXACTLY what changed — never a
 * generic "this was updated" notice. Given a list of {label, oldVal, newVal}
 * fields, returns one "Label: old → new" line per field that actually
 * changed, skipping anything unchanged. Matches the spec's own example:
 *   Time: 15:30–16:30 → 16:00–17:00
 *   Language: German → English
 *   Staff: Staff A → Staff B
 * @param {Array<{label: string, oldVal: *, newVal: *}>} fields
 * @return {Array<string>}
 */
function diffLines_(fields) {
  return (fields || [])
    .filter(function (f) { return String(f.oldVal == null ? '' : f.oldVal) !== String(f.newVal == null ? '' : f.newVal); })
    .map(function (f) { return f.label + ': ' + (f.oldVal || '(none)') + ' \u2192 ' + (f.newVal || '(none)'); });
}

function t_(lang, key) {
  var dict = MESSAGES[normalizeLang_(lang)] || MESSAGES.en;
  return dict[key] || MESSAGES.en[key] || key;
}

/**
 * ----------------------------------------------------------------------------
 * SPREADSHEET / SHEET HELPERS
 * ----------------------------------------------------------------------------
 */

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(sheetName) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Required sheet "' + sheetName + '" was not found. ' +
      'Please check the spreadsheet structure (see README.md).');
  }
  return sheet;
}

/**
 * Headers for the four round-4/5/6 admin-configuration sheets (Notification
 * Settings, Scheduling Rules, Email Templates, Calendar Invite Settings).
 * Used by getOrCreateConfigSheet_ to self-heal a missing sheet.
 */
var CONFIG_SHEET_HEADERS_ = {
  NotificationSettings: ['EventKey', 'RecipientGroups', 'UpdatedAt'],
  SchedulingRules: ['ExperimentTypeA', 'ExperimentTypeB', 'OverlapAllowed', 'UpdatedAt'],
  EmailTemplates: ['TemplateKey', 'SubjectDE', 'BodyDE', 'SubjectEN', 'BodyEN', 'UpdatedAt'],
  CalendarInviteSettings: ['ActivityKey', 'RecipientGroups', 'UpdatedAt'],
  Roles: ['RoleName', 'Permissions', 'UpdatedAt'],
  Tasks: ['TaskName', 'AllowedRoles', 'UpdatedAt']
};

/**
 * Like getSheet_, but for the four admin-configuration sheets: if the sheet
 * doesn't exist yet (e.g. this feature was added after the spreadsheet was
 * first initialized, and initializeSpreadsheet hasn't been re-run since),
 * it is created on the spot with the correct headers instead of throwing.
 * This is what makes editing these settings safe to try even before an
 * admin has re-run initializeSpreadsheet — both reading (already
 * try/catch-guarded with a CONFIG-default fallback) and writing now
 * self-heal the same way.
 */
function getOrCreateConfigSheet_(sheetName) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) return sheet;
  var headers = CONFIG_SHEET_HEADERS_[sheetName];
  sheet = ss.insertSheet(sheetName);
  if (headers) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Generic "find or create a column by header name" helper, used to safely
 * extend a sheet's schema without disturbing its existing fixed-index
 * columns (mirrors the pattern already established by
 * ensureSoftDeleteColumns_ for the Status/DeletedBy/... columns). The new
 * column is appended after whatever the sheet's current last column is, so
 * it never collides with existing data regardless of how many rows already
 * exist. Returns the 1-based column number.
 * @param {string} sheetName
 * @param {string} headerName
 * @return {number} 1-based column index
 */
var NAMED_COL_CACHE_ = {};
function ensureNamedColumn_(sheetName, headerName) {
  var cacheKey = sheetName + '::' + headerName;
  if (NAMED_COL_CACHE_[cacheKey]) return NAMED_COL_CACHE_[cacheKey];
  var sheet = getSheet_(sheetName);
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var idx = headers.indexOf(headerName);
  var col;
  if (idx === -1) {
    lastCol++;
    sheet.getRange(1, lastCol).setValue(headerName);
    col = lastCol;
  } else {
    col = idx + 1;
  }
  NAMED_COL_CACHE_[cacheKey] = col;
  return col;
}

/**
 * ----------------------------------------------------------------------------
 * SOFT DELETION (spec round 5, #5)
 * ----------------------------------------------------------------------------
 * No row is ever physically removed. Each data sheet carries four
 * soft-deletion columns, identified BY HEADER NAME (so they work regardless
 * of each sheet's differing width): Status, DeletedBy, DeletedOn,
 * DeletionReason. A row with Status === 'Deleted' is excluded from all normal
 * reads (getDataRows_ filters them out by default) but preserved for audit.
 */
var SOFT_DELETE_HEADERS_ = ['Status', 'DeletedBy', 'DeletedOn', 'DeletionReason'];
var SOFT_DELETE_COL_CACHE_ = {};

/** Ensures the four soft-deletion columns exist on a sheet; returns their 1-based column numbers. */
function ensureSoftDeleteColumns_(sheetName) {
  if (SOFT_DELETE_COL_CACHE_[sheetName]) return SOFT_DELETE_COL_CACHE_[sheetName];
  var sheet = getSheet_(sheetName);
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  var map = {};
  SOFT_DELETE_HEADERS_.forEach(function (name) {
    var idx = headers.indexOf(name);
    if (idx === -1) {
      // Append a new header column.
      lastCol++;
      sheet.getRange(1, lastCol).setValue(name);
      headers.push(name);
      map[name] = lastCol; // 1-based
    } else {
      map[name] = idx + 1; // 1-based
    }
  });
  SOFT_DELETE_COL_CACHE_[sheetName] = map;
  return map;
}

/** True if a raw row (array) from the given sheet is soft-deleted. */
function isRowDeleted_(sheetName, rowValues) {
  var map = ensureSoftDeleteColumns_(sheetName);
  var statusIdx = map.Status - 1; // 0-based into the row array
  if (statusIdx >= rowValues.length) return false;
  return String(rowValues[statusIdx] || '').trim().toLowerCase() === 'deleted';
}

/**
 * Marks a row Deleted (soft delete) by slot/record ID, using the given
 * ID-column index. Preserves the row. Returns true if a row was updated.
 * @param {string} sheetName
 * @param {number} idColIndex0 - 0-based column index holding the ID
 * @param {string} id
 * @param {string} deletedBy
 * @param {string} [reason]
 */
function softDeleteById_(sheetName, idColIndex0, id, deletedBy, reason) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var map = ensureSoftDeleteColumns_(sheetName);
  var ids = sheet.getRange(2, idColIndex0 + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(id).trim()) {
      var r = i + 2;
      sheet.getRange(r, map.Status).setValue('Deleted');
      sheet.getRange(r, map.DeletedBy).setValue(deletedBy || '');
      sheet.getRange(r, map.DeletedOn).setValue(new Date());
      sheet.getRange(r, map.DeletionReason).setValue(reason || '');
      return true;
    }
  }
  return false;
}

/** Soft-deletes a row by its absolute row index (used when the caller already has it). */
function softDeleteRowIndex_(sheetName, rowIndex, deletedBy, reason) {
  var sheet = getSheet_(sheetName);
  var map = ensureSoftDeleteColumns_(sheetName);
  sheet.getRange(rowIndex, map.Status).setValue('Deleted');
  sheet.getRange(rowIndex, map.DeletedBy).setValue(deletedBy || '');
  sheet.getRange(rowIndex, map.DeletedOn).setValue(new Date());
  sheet.getRange(rowIndex, map.DeletionReason).setValue(reason || '');
}

/**
 * Reads the data rows of a sheet. By default EXCLUDES soft-deleted rows so all
 * normal scheduling/booking/participant views ignore them. Pass
 * includeDeleted=true for audit/reporting reads.
 * @param {string} sheetName
 * @param {boolean} [includeDeleted]
 */
function getDataRows_(sheetName, includeDeleted) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var lastCol = sheet.getLastColumn();
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  if (includeDeleted) return rows;
  // Filter out soft-deleted rows (only if the sheet actually has a Status col).
  var map = ensureSoftDeleteColumns_(sheetName);
  var statusIdx = map.Status - 1;
  return rows.filter(function (row) {
    return String(row[statusIdx] || '').trim().toLowerCase() !== 'deleted';
  });
}

function isBooked_(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toUpperCase() === 'TRUE';
  return false;
}

/**
 * Extracts just the display name from a "Name <email>" provenance string
 * (as written by createdByLegacy_ / session.name + ' <' + session.email +
 * '>'), for showing "who created this slot" without leaking their email
 * outside Admin Management (spec round 2, #3). Falls back to the raw
 * string if it doesn't match that pattern (e.g. 'system').
 * @param {string} createdByRaw
 * @return {string}
 */
function creatorDisplayName_(createdByRaw) {
  var raw = String(createdByRaw || '').trim();
  if (!raw) return '';
  var match = /^(.*?)\s*<[^>]+>\s*$/.exec(raw);
  return match ? match[1].trim() : raw;
}

function findSlotRow_(sheet, slotId, includeDeleted) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var map = ensureSoftDeleteColumns_(sheet.getName());
  var lastCol = sheet.getLastColumn();
  var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var statusIdx = map.Status - 1;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][CONFIG.SLOT_COLS.SLOT_ID]).trim() === String(slotId).trim()) {
      if (!includeDeleted && String(rows[i][statusIdx] || '').trim().toLowerCase() === 'deleted') continue;
      return i + 2;
    }
  }
  return -1;
}

function getSlotByFullRow_(sheetName, slotId) {
  var sheet = getSheet_(sheetName);
  var rowIndex = findSlotRow_(sheet, slotId);
  if (rowIndex === -1) return null;
  var lastCol = Math.max(sheet.getLastColumn(), 5);
  var values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  return { sheet: sheet, rowIndex: rowIndex, values: values };
}

/**
 * ----------------------------------------------------------------------------
 * DATE / TIME HELPERS
 * ----------------------------------------------------------------------------
 */

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/**
 * Combines a "Date" cell value and a "Time" cell value (real Date objects
 * from Sheets, or plain strings) into a single JS Date representing the
 * actual date + time of day.
 * @param {*} dateValue
 * @param {*} timeValue
 * @return {Date}
 */
function combineDateAndTime_(dateValue, timeValue) {
  var baseDate;
  if (Object.prototype.toString.call(dateValue) === '[object Date]') {
    baseDate = dateValue;
  } else {
    baseDate = new Date(String(dateValue));
  }

  var hours = 0, minutes = 0, seconds = 0;
  if (Object.prototype.toString.call(timeValue) === '[object Date]') {
    hours = timeValue.getHours();
    minutes = timeValue.getMinutes();
    seconds = timeValue.getSeconds();
  } else if (typeof timeValue === 'string' && timeValue.indexOf(':') !== -1) {
    var parts = timeValue.split(':');
    hours = parseInt(parts[0], 10) || 0;
    minutes = parseInt(parts[1], 10) || 0;
    seconds = parseInt(parts[2], 10) || 0;
  }

  return new Date(
    baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(),
    hours, minutes, seconds
  );
}

/**
 * The automatic Day1 -> Day2 compatibility rule, shared by the participant
 * booking flow and the admin slot-creation guard.
 * @param {Date} day1DateTime
 * @param {Date} day2DateTime
 * @return {boolean}
 */
function isSlotPairCompatible_(day1DateTime, day2DateTime) {
  var diffHours = (day2DateTime.getTime() - day1DateTime.getTime()) / (1000 * 60 * 60);
  return diffHours >= CONFIG.MAPPING_WINDOW_MIN_HOURS && diffHours <= CONFIG.MAPPING_WINDOW_MAX_HOURS;
}

function formatDateForDisplay_(value, lang) {
  lang = normalizeLang_(lang);
  if (Object.prototype.toString.call(value) !== '[object Date]') {
    return value ? String(value) : '';
  }
  var weekday = WEEKDAYS[lang][value.getDay()];
  var month = MONTHS[lang][value.getMonth()];
  var day = value.getDate();
  var year = value.getFullYear();

  if (lang === 'de') {
    return weekday + ', ' + day + '. ' + month + ' ' + year;
  }
  return weekday + ', ' + month + ' ' + day + ', ' + year;
}

/** Numeric date for emails / audits: always dd.mm.yyyy */
function formatDateNumeric_(value) {
  var d = value;
  if (Object.prototype.toString.call(value) !== '[object Date]') {
    d = parseDateInput_(value);
  }
  if (!d || Object.prototype.toString.call(d) !== '[object Date]') return value ? String(value) : '';
  return pad2_(d.getDate()) + '.' + pad2_(d.getMonth() + 1) + '.' + d.getFullYear();
}

/** Slot date+time line for emails: "dd.mm.yyyy HH:MM–HH:MM" */
function formatSlotDateTimeForEmail_(dateVal, startVal, endVal) {
  var datePart = formatDateNumeric_(dateVal);
  var startPart = formatTimeForDisplay_(startVal, 'de');
  var endPart = endVal != null ? formatTimeForDisplay_(endVal, 'de') : '';
  return datePart + (startPart ? (' ' + startPart) : '') + (endPart ? ('\u2013' + endPart) : '');
}

function formatTimeForDisplay_(value, lang) {
  lang = normalizeLang_(lang);
  if (Object.prototype.toString.call(value) !== '[object Date]') {
    return value ? String(value) : '';
  }
  var hours = value.getHours();
  var minutes = value.getMinutes();

  if (lang === 'de') {
    return pad2_(hours) + ':' + pad2_(minutes);
  }
  var period = hours >= 12 ? 'PM' : 'AM';
  var hours12 = hours % 12;
  if (hours12 === 0) hours12 = 12;
  return hours12 + ':' + pad2_(minutes) + ' ' + period;
}

/**
 * True if the given "Date" cell value falls on or after today (script
 * timezone), ignoring time-of-day. Used by the admin overview to show only
 * upcoming slots.
 * @param {*} dateValue
 * @return {boolean}
 */
function isOnOrAfterToday_(dateValue) {
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var d;
  if (Object.prototype.toString.call(dateValue) === '[object Date]') {
    d = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate());
  } else {
    d = new Date(String(dateValue));
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime() >= today.getTime();
}

/**
 * ----------------------------------------------------------------------------
 * CLIENT-CALLABLE: PARTICIPANT READ OPERATIONS
 * ----------------------------------------------------------------------------
 */

function getDay1Slots(lang, filterLanguage) {
  lang = normalizeLang_(lang);
  var rows = getDataRows_(CONFIG.SHEETS.DAY1);
  var cols = CONFIG.SLOT_COLS;
  var slots = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var slotId = row[cols.SLOT_ID];
    if (!slotId) continue;
    if (isBooked_(row[cols.BOOKED])) continue;
    var slotLanguage = normalizeSlotLanguage_(row[CONFIG.DAY1_EXTRA_COLS.LANGUAGE]);
    if (!slotLanguageMatchesFilter_(slotLanguage, filterLanguage)) continue;

    slots.push({
      slotID: String(slotId),
      date: formatDateForDisplay_(row[cols.DATE], lang),
      startTime: formatTimeForDisplay_(row[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(row[cols.END_TIME], lang),
      language: slotLanguage
    });
  }
  return slots;
}

function getCompatibleDay2Slots(day1SlotId, lang, filterLanguage) {
  lang = normalizeLang_(lang);
  if (!day1SlotId) return [];

  var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotId);
  if (!day1Record) return [];

  var cols = CONFIG.SLOT_COLS;
  var day1DateTime = combineDateAndTime_(
    day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]
  );

  var day2Rows = getDataRows_(CONFIG.SHEETS.DAY2);
  var slots = [];

  for (var i = 0; i < day2Rows.length; i++) {
    var row = day2Rows[i];
    var slotId = row[cols.SLOT_ID];
    if (!slotId) continue;
    if (isBooked_(row[cols.BOOKED])) continue;
    var slotLanguage = normalizeSlotLanguage_(row[CONFIG.DAY2_EXTRA_COLS.LANGUAGE]);
    if (!slotLanguageMatchesFilter_(slotLanguage, filterLanguage)) continue;

    var day2DateTime = combineDateAndTime_(row[cols.DATE], row[cols.START_TIME]);
    if (!isSlotPairCompatible_(day1DateTime, day2DateTime)) continue;

    slots.push({
      slotID: String(slotId),
      date: formatDateForDisplay_(row[cols.DATE], lang),
      startTime: formatTimeForDisplay_(row[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(row[cols.END_TIME], lang),
      language: slotLanguage
    });
  }
  return slots;
}

/**
 * ----------------------------------------------------------------------------
 * CLIENT-CALLABLE: BOOKING (WRITE) OPERATION
 * ----------------------------------------------------------------------------
 */

function submitBooking(bookingData) {
  var lang = normalizeLang_(bookingData && bookingData.lang);

  var validationError = validateBookingInput_(bookingData, lang);
  if (validationError) {
    return { success: false, message: validationError };
  }

  var firstName = bookingData.firstName.trim();
  var lastName = bookingData.lastName.trim();
  var name = (firstName + ' ' + lastName).trim();
  var gender = String(bookingData.gender).trim();
  var title = String(bookingData.title).trim();
  var email = bookingData.email.trim().toLowerCase();
  var day1SlotID = String(bookingData.day1SlotID).trim();
  var day2SlotID = String(bookingData.day2SlotID).trim();
  var cols = CONFIG.SLOT_COLS;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: t_(lang, 'systemBusy') };
  }

  try {
    var isExemptEmail = (email === CONFIG.EMAIL_DUPLICATE_EXCEPTION.toLowerCase());
    if (!isExemptEmail && emailAlreadyBooked_(email)) {
      return { success: false, message: t_(lang, 'emailUsed') };
    }

    var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
    if (!day1Record) {
      return { success: false, message: t_(lang, 'day1Gone') };
    }
    if (isBooked_(day1Record.values[cols.BOOKED])) {
      return { success: false, message: t_(lang, 'day1Taken') };
    }

    var day2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
    if (!day2Record) {
      return { success: false, message: t_(lang, 'day2Gone') };
    }

    var day1DateTime = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]);
    var day2DateTime = combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]);
    if (!isSlotPairCompatible_(day1DateTime, day2DateTime)) {
      return { success: false, message: t_(lang, 'mappingInvalid') };
    }

    if (isBooked_(day2Record.values[cols.BOOKED])) {
      return { success: false, message: t_(lang, 'day2Taken') };
    }

    day1Record.sheet.getRange(day1Record.rowIndex, cols.BOOKED + 1).setValue(true);
    day2Record.sheet.getRange(day2Record.rowIndex, cols.BOOKED + 1).setValue(true);

    var confirmationNumber = generateConfirmationNumber_();
    var passcode = generatePasscode_();
    var comments = String((bookingData && bookingData.comments) || '').trim().slice(0, 2000);

    var bookingsSheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
    bookingsSheet.appendRow([
      new Date(),
      '', // ParticipantID left blank — assigned manually by the research team
      name,
      email,
      day1SlotID,
      day2SlotID,
      confirmationNumber,
      passcode,
      comments,
      'Booked',
      '',           // availability (only set on cancellation)
      new Date(),
      title,
      '',           // CreatedByAdmin — blank for self-service participant bookings
      gender,
      firstName,
      lastName,
      lang          // round 7: participant's language preference, preserved for future reschedules
    ]);

    var day1Details = {
      slotID: day1SlotID,
      date: formatDateForDisplay_(day1Record.values[cols.DATE], lang),
      startTime: formatTimeForDisplay_(day1Record.values[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(day1Record.values[cols.END_TIME], lang)
    };
    var day2Details = {
      slotID: day2SlotID,
      date: formatDateForDisplay_(day2Record.values[cols.DATE], lang),
      startTime: formatTimeForDisplay_(day2Record.values[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(day2Record.values[cols.END_TIME], lang)
    };

    // Mirror the booking onto the participant-bookings calendar.
    upsertParticipantCalendarEvents_(
      day1SlotID, day2SlotID, name, email,
      combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]),
      combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.END_TIME]),
      combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]),
      combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.END_TIME]),
      String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || ''),
      String(day2Record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || ''),
      'Booked',
      title
    );

    var day1Staff = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    var day2Staff = String(day2Record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');

    // Requirement #5: automatically update the linked Blood Drawing slot —
    // add the Booking ID and move it from Available to Booked.
    linkBloodDrawingToBooking_(day1SlotID, confirmationNumber, name);

    try {
      sendConfirmationEmail_(email, name, day1Details, day2Details, lang, {
        confirmationNumber: confirmationNumber,
        passcode: passcode,
        comments: comments,
        day1Staff: day1Staff,
        day2Staff: day2Staff
      });
    } catch (emailError) {
      Logger.log('Confirmation email failed: ' + emailError);
    }

    notifyBookingChange_('Participant booking', [
      'Participant: ' + name + ' <' + email + '>',
      'Confirmation Number: ' + confirmationNumber,
      'Day 1 slot: ' + day1SlotID + ' (' + day1Details.date + ' ' + day1Details.startTime + '–' + day1Details.endTime + ')',
      'Day 2 slot: ' + day2SlotID + ' (' + day2Details.date + ' ' + day2Details.startTime + '–' + day2Details.endTime + ')',
      comments ? 'Comments: ' + comments : ''
    ].filter(Boolean), [day1Staff, day2Staff], 'participantBooking');

    return {
      success: true,
      message: t_(lang, 'bookingConfirmed'),
      name: name,
      email: email,
      day1: day1Details,
      day2: day2Details,
      confirmationNumber: confirmationNumber,
      passcode: passcode,
      manageUrl: getManageUrl_(),
      location: CONFIG.LOCATION
    };

  } finally {
    lock.releaseLock();
  }
}

/**
 * ----------------------------------------------------------------------------
 * BOOKING CREDENTIALS (Confirmation Number + Passcode)
 * ----------------------------------------------------------------------------
 */

/**
 * Generates the next unique confirmation number, e.g. "EXP-2026-000123".
 *
 * The sequence counter lives in Script Properties so numbers are never
 * reused even if a Bookings row is deleted. It is also cross-checked
 * against the sheet, so a manually-edited counter can't produce a
 * duplicate. Must be called inside the booking lock.
 * @return {string}
 */
function generateConfirmationNumber_() {
  var props = PropertiesService.getScriptProperties();
  var year = new Date().getFullYear();
  var existing = getAllConfirmationNumbers_();

  var seq = parseInt(props.getProperty('CONFIRMATION_SEQ') || '0', 10);
  var candidate;
  do {
    seq++;
    candidate = CONFIG.CONFIRMATION_PREFIX + '-' + year + '-' + ('000000' + seq).slice(-6);
  } while (existing[candidate]);

  props.setProperty('CONFIRMATION_SEQ', String(seq));
  return candidate;
}

/** Map of every confirmation/Booking ID currently in use — Bookings AND Blood Drawing slots (round 15, #6: TA self-booked slots also get a generated Booking ID from this same sequence, so both catalogs must be checked to avoid a collision). */
function getAllConfirmationNumbers_() {
  var sheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
  var lastRow = sheet.getLastRow();
  var out = {};
  if (lastRow >= 2) {
    var col = CONFIG.BOOKING_COLS.CONFIRMATION_NUMBER;
    var values = sheet.getRange(2, 1, lastRow - 1, CONFIG.BOOKING_ROW_WIDTH).getValues();
    values.forEach(function (r) {
      var v = String(r[col] || '').trim();
      if (v) out[v] = true;
    });
  }
  try {
    var bdCols = CONFIG.BLOOD_DRAWING_COLS;
    getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING).forEach(function (row) {
      var v = String(row[bdCols.PARTICIPANT_CONFIRMATION] || '').trim();
      if (v) out[v] = true;
    });
  } catch (e) { /* Blood Drawing sheet not ready yet — ignore */ }
  return out;
}

/**
 * Generates a booking passcode.
 *
 * Apps Script exposes no cryptographic RNG (no crypto.getRandomValues), so
 * this draws entropy from Utilities.getUuid(), which is a random (version 4)
 * UUID — 122 bits of randomness from the platform's own generator. Two UUIDs
 * are concatenated and mapped onto an unambiguous alphabet (no 0/O/1/I/L) to
 * keep the code easy to read aloud and retype.
 * @return {string} 10-character code
 */
function generatePasscode_() {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  var out = '';
  for (var i = 0; i < 10; i++) {
    var chunk = parseInt(hex.substr(i * 3, 3), 16);
    out += alphabet.charAt(chunk % alphabet.length);
  }
  return out;
}

/**
 * ----------------------------------------------------------------------------
 * BOOKING LOOKUP & VERIFICATION
 * ----------------------------------------------------------------------------
 */

/** Reads a Bookings row into a structured record, or null. */
function findBookingByConfirmation_(confirmationNumber) {
  var sheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var cols = CONFIG.BOOKING_COLS;
  var values = sheet.getRange(2, 1, lastRow - 1, CONFIG.BOOKING_ROW_WIDTH).getValues();
  var target = String(confirmationNumber || '').trim().toUpperCase();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][cols.CONFIRMATION_NUMBER] || '').trim().toUpperCase() === target) {
      return { sheet: sheet, rowIndex: i + 2, values: values[i] };
    }
  }
  return null;
}

/**
 * Verifies a confirmation number + passcode pair.
 *
 * Deliberately returns the SAME failure message whether the confirmation
 * number was unknown or the passcode was wrong, so the response never
 * reveals which value was correct. Comparison is constant-ish time by
 * always comparing full strings.
 * @return {{ok: boolean, record?: Object, message?: string}}
 */
function verifyBookingCredentials_(confirmationNumber, passcode, lang) {
  var generic = t_(lang, 'invalidCredentials');
  var record = findBookingByConfirmation_(confirmationNumber);
  var supplied = String(passcode || '').trim().toUpperCase();

  if (!record) {
    // Still do comparable work so timing doesn't leak existence.
    generatePasscode_();
    return { ok: false, message: generic };
  }
  var stored = String(record.values[CONFIG.BOOKING_COLS.PASSCODE] || '').trim().toUpperCase();
  if (!stored || stored !== supplied) {
    return { ok: false, message: generic };
  }
  if (String(record.values[CONFIG.BOOKING_COLS.STATUS] || '').trim().toLowerCase() === 'cancelled') {
    return { ok: false, message: t_(lang, 'bookingCancelled') };
  }
  return { ok: true, record: record };
}

/** Builds the participant-facing view of a booking (never includes the passcode). */
function describeBookingForParticipant_(record, lang) {
  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var day1ID = String(record.values[cols.DAY1_SLOT_ID] || '');
  var day2ID = String(record.values[cols.DAY2_SLOT_ID] || '');
  var d1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1ID);
  var d2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2ID);

  function describe_(rec) {
    if (!rec) return null;
    return {
      date: formatDateForDisplay_(rec.values[scols.DATE], lang),
      startTime: formatTimeForDisplay_(rec.values[scols.START_TIME], lang),
      endTime: formatTimeForDisplay_(rec.values[scols.END_TIME], lang)
      // Deliberately no assignedStaff here — participants must never see who
      // is running their session (name or email).
    };
  }

  return {
    confirmationNumber: String(record.values[cols.CONFIRMATION_NUMBER] || ''),
    name: String(record.values[cols.NAME] || ''),
    email: String(record.values[cols.EMAIL] || ''),
    comments: String(record.values[cols.COMMENTS] || ''),
    day1: describe_(d1),
    day2: describe_(d2),
    location: CONFIG.LOCATION
  };
}

function validateBookingInput_(data, lang) {
  if (!data) return t_(lang, 'invalidData');
  if (!data.day1SlotID) return t_(lang, 'day1Required');
  if (!data.day2SlotID) return t_(lang, 'day2Required');
  if (!data.title || CONFIG.TITLES.indexOf(String(data.title).trim()) === -1) return t_(lang, 'titleRequired');
  if (!data.gender || getGenderOptions().indexOf(String(data.gender).trim()) === -1) return t_(lang, 'genderRequired');
  if (!data.firstName || !data.firstName.trim()) return t_(lang, 'firstNameRequired');
  if (!data.lastName || !data.lastName.trim()) return t_(lang, 'lastNameRequired');
  if (!data.email || !data.email.trim()) return t_(lang, 'emailRequired');

  if (!validateEmailFormat_(data.email.trim())) {
    return t_(lang, 'emailInvalid');
  }
  if ((data.firstName.trim() + ' ' + data.lastName.trim()).length > 200) return t_(lang, 'nameTooLong');
  return null;
}

/**
 * Shared email-format validator, used at every point the spec requires
 * email validation: participant registration, admin account creation, and
 * admin account edits (see requirements section 7).
 * @param {string} email
 * @return {boolean}
 */
function validateEmailFormat_(email) {
  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return !!email && emailPattern.test(String(email).trim());
}

/** Returns the last whitespace-separated token of a full name, for use in
 * "Title LastName" calendar-event labels (spec section 8). Falls back to
 * the whole name if it's a single token. */
function lastNameOf_(fullName) {
  var parts = String(fullName || '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : String(fullName || '');
}

function emailAlreadyBooked_(normalizedEmail) {
  var rows = getDataRows_(CONFIG.SHEETS.BOOKINGS);
  var emailCol = CONFIG.BOOKING_COLS.EMAIL;
  var statusCol = CONFIG.BOOKING_COLS.STATUS;
  for (var i = 0; i < rows.length; i++) {
    // Cancelled bookings don't count — a participant who cancelled is free
    // to book again with the same address.
    if (String(rows[i][statusCol] || '').trim().toLowerCase() === 'cancelled') continue;
    var existingEmail = String(rows[i][emailCol] || '').trim().toLowerCase();
    if (existingEmail && existingEmail === normalizedEmail) {
      return true;
    }
  }
  return false;
}

/**
 * ----------------------------------------------------------------------------
 * EMAIL (participant confirmation)
 * ----------------------------------------------------------------------------
 */

function buildEmailContent_(lang, name, day1Details, day2Details) {
  // Round 6: this now renders from the editable Email Templates system
  // (bookingConfirmation) instead of a hardcoded bilingual body, so the Main
  // Admin can edit subject/body in both languages without code changes. The
  // template is always rendered bilingual (German first) regardless of the
  // participant's chosen language, per round 4's decision.
  var day1Text = day1Details.date + ', ' + day1Details.startTime + '\u2013' + day1Details.endTime;
  var day2Text = day2Details.date + ', ' + day2Details.startTime + '\u2013' + day2Details.endTime;
  return renderEmailTemplate_('bookingConfirmation', {
    ParticipantName: name,
    Day1Slot: day1Text,
    Day2Slot: day2Text,
    Date: day1Details.date,
    Time: day1Details.startTime + '\u2013' + day1Details.endTime
  });
}

function sendConfirmationEmail_(email, name, day1Details, day2Details, lang, extras) {
  lang = normalizeLang_(lang);
  extras = extras || {};
  var content = buildEmailContent_(lang, name, day1Details, day2Details);

  var isDe = (lang === 'de');
  var extraLines = [];

  // NOTE (2026-08 requirements pass, section 2): participant-facing emails
  // must never include assigned staff names or email addresses. extras may
  // still carry day1Staff/day2Staff (used internally for notifyBookingChange_
  // recipient lists), but it is deliberately never rendered here.

  if (extras.comments) {
    extraLines.push('');
    extraLines.push((isDe ? 'Ihre Anmerkungen: ' : 'Your comments: ') + extras.comments);
  }

  if (extras.confirmationNumber) {
    extraLines.push('');
    extraLines.push('----------------------------------------');
    extraLines.push(isDe ? 'IHRE BUCHUNGSDATEN' : 'YOUR BOOKING CREDENTIALS');
    extraLines.push((isDe ? 'Bestätigungsnummer: ' : 'Confirmation Number: ') + extras.confirmationNumber);
    extraLines.push((isDe ? 'Zugangscode: ' : 'Booking Passcode: ') + extras.passcode);
    extraLines.push('');
    extraLines.push(isDe
      ? 'Sie benötigen BEIDE Angaben, um Ihren Termin zu verschieben oder zu stornieren. Bitte bewahren Sie diese E-Mail auf.'
      : 'You will need BOTH of these to reschedule or cancel your appointment. Please keep this email.');
    var manageUrl = getManageUrl_();
    if (manageUrl) {
      extraLines.push('');
      extraLines.push(isDe ? 'Termin verwalten:' : 'Manage your booking:');
      extraLines.push(manageUrl);
    }
    extraLines.push('----------------------------------------');
  }

  extraLines.push('');
  extraLines.push(isDe ? 'Ort:' : 'Location:');
  extraLines.push(CONFIG.LOCATION.address);
  extraLines.push('Google Maps: ' + CONFIG.LOCATION.mapsUrl);

  extraLines.push('');
  extraLines.push(isDe ? 'Kontakt:' : 'Contact:');
  extraLines.push(CONFIG.CONTACT.email);
  extraLines.push(CONFIG.CONTACT.phone);

  // Round 8 fix: this used to support CONFIG.ADMIN_BCC_EMAIL — a hardcoded,
  // code-level BCC on every participant confirmation email with NO admin UI
  // control and no way to disable it per event type. It defaulted to empty
  // so was inert out of the box, but it was still exactly the kind of
  // silent, out-of-band bypass the notification matrix exists to prevent.
  // Removed outright: admins are already notified of new bookings via the
  // matrix-driven 'participantBooking' event (see notifyBookingChange_),
  // which they can route/disable normally.
  MailApp.sendEmail(email, content.subject, content.body + '\n' + extraLines.join('\n'));
}

/**
 * The public web-app URL with ?page=admin appended, for admin-facing
 * emails (TA availability requests, "add this MRI slot to a schedule"
 * reminders, etc.) so the recipient can click straight through to the
 * Admin Portal instead of having to already know/bookmark the URL.
 * Returns '' if the URL can't be determined (e.g. running from the editor
 * before deployment) — callers must handle that gracefully.
 */
function getAdminPortalUrl_() {
  try {
    var base = ScriptApp.getService().getUrl();
    if (!base) return '';
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'page=admin';
  } catch (err) {
    Logger.log('getAdminPortalUrl_ failed: ' + err);
    return '';
  }
}

/**
 * The public web-app URL with ?action=manage appended, for the "Manage
 * Appointment" link. Returns '' if the URL can't be determined (e.g. when
 * running from the editor before deployment).
 */
function getManageUrl_() {
  try {
    var base = ScriptApp.getService().getUrl();
    if (!base) return '';
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'action=manage';
  } catch (err) {
    Logger.log('getManageUrl_ failed: ' + err);
    return '';
  }
}

/**
 * Notifies the UNIQUE set of {all active admins} ∪ {affected staff} about a
 * booking change. Each person receives exactly one email even if they belong
 * to several groups.
 * @param {string} action
 * @param {Array<string>} detailLines
 * @param {Array<string>} affectedStaffEmails
 */
function notifyBookingChange_(action, detailLines, affectedStaffEmails, subjectKey) {
  // Round 6 fix: recipients now come from the Notification Settings matrix
  // (resolveNotificationRecipients_) whenever subjectKey matches a
  // configured event, instead of always hardcoding "all admins + affected
  // staff" — this is what makes the Main Admin's routing choices for
  // Participant Booking / Booking Rescheduled / Booking Cancelled /
  // Booking Unbooked actually take effect.
  var isConfiguredEvent = subjectKey && CONFIG.NOTIFICATION_EVENTS.some(function (e) { return e.key === subjectKey; });
  var recipients;
  if (isConfiguredEvent) {
    recipients = resolveNotificationRecipients_(subjectKey, { assignedStaff: affectedStaffEmails || [] });
    // An empty list here means the Main Admin deliberately routed this
    // event to nobody — respect that instead of force-mailing Main Admin.
    if (!recipients.length) return;
  } else {
    recipients = buildDedupedGuestList_(getAllAdminEmails_().concat(affectedStaffEmails || []));
  }

  try {
    var details = detailLines.join('\n');
    // Round 10: render through the editable Email Templates catalog (see
    // notifyAdminOfChange_ for the same pattern) instead of a hardcoded
    // inline body, so these are now customizable from the Admin Portal too.
    if (subjectKey && getEmailTemplatesMap_()[subjectKey]) {
      var content = renderEmailTemplate_(subjectKey, { Details: action + '\n\n' + details });
      MailApp.sendEmail(recipients.join(','), content.subject, content.body);
      return;
    }
    var de = action + '\n\n' + details;
    var en = action + '\n\n' + details;
    MailApp.sendEmail(
      recipients.join(','),
      subjectKey ? emailSubject_(subjectKey) : ('[' + action + '] ' + CONFIG.EXPERIMENT_NAME.en),
      bilingualBody_(de, en)
    );
  } catch (err) {
    Logger.log('notifyBookingChange_ failed: ' + err);
  }
}

/**
 * Client-callable, UNAUTHENTICATED: the participant-facing "Confused? Write
 * us a message" contact form on the booking page. Emails every active admin
 * (deduplicated, same recipient-gathering pattern as booking notifications)
 * with the participant's question, with Reply-To set to their address so an
 * admin can just hit reply. No confirmation number/passcode needed — this
 * is for people who aren't sure what to do yet, possibly before booking.
 * @param {string} name - optional
 * @param {string} email
 * @param {string} message
 * @param {string} lang - 'en' | 'de', for the validation/success messages
 * @return {Object} {success, message}
 */
function sendHelpMessage(name, email, message, lang) {
  var isDe = (lang === 'de');
  name = String(name || '').trim();
  email = String(email || '').trim();
  message = String(message || '').trim().slice(0, 4000);

  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return {
      success: false,
      message: isDe ? 'Bitte geben Sie eine gültige E-Mail-Adresse ein.' : 'Please enter a valid email address.'
    };
  }
  if (!message) {
    return {
      success: false,
      message: isDe ? 'Bitte geben Sie Ihre Nachricht ein.' : 'Please enter your message.'
    };
  }

  var recipients = resolveNotificationRecipients_('participantMessages', {});
  // An empty list means the Main Admin deliberately routed this event to
  // nobody — respect that instead of silently falling back to all admins.
  // The participant still gets their normal success confirmation; the
  // message just isn't forwarded to anyone internally.
  if (!recipients.length) {
    return {
      success: true,
      message: isDe ? 'Danke — Ihre Nachricht wurde gesendet.' : 'Thanks — your message has been sent.'
    };
  }

  try {
    MailApp.sendEmail({
      to: recipients.join(','),
      replyTo: email,
      subject: emailSubject_('participantMessages'),
      body: bilingualBody_(
        'Ein/e Teilnehmer/in hat über das Kontaktformular der Buchungsseite eine Frage gesendet.\n\n' +
        'Name: ' + (name || '(nicht angegeben)') + '\nE-Mail: ' + email + '\n\nNachricht:\n' + message,
        'A participant sent a question via the booking page contact form.\n\n' +
        'Name: ' + (name || '(not provided)') + '\nEmail: ' + email + '\n\nMessage:\n' + message
      )
    });
  } catch (err) {
    Logger.log('sendHelpMessage failed: ' + err);
    return {
      success: false,
      message: isDe
        ? 'Ihre Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es später erneut.'
        : 'Could not send your message. Please try again later.'
    };
  }

  return {
    success: true,
    message: isDe ? 'Danke — Ihre Nachricht wurde gesendet.' : 'Thanks — your message has been sent.'
  };
}

/**
 * ============================================================================
 *  PARTICIPANT SELF-SERVICE: MANAGE APPOINTMENT
 * ============================================================================
 *  Every function here authenticates with Confirmation Number + Passcode.
 *  Failures return one generic message so nothing leaks about which value
 *  was wrong. The passcode is never returned to the client.
 * ============================================================================
 */

/**
 * Client-callable: verifies credentials and returns the booking for display.
 * @return {Object} {success, booking?, message?}
 */
function verifyBookingAccess(confirmationNumber, passcode, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };
  return { success: true, booking: describeBookingForParticipant_(v.record, lang) };
}

/**
 * Client-callable: updates the participant's own name/email only. Slot
 * assignments are untouched here.
 */
function updateParticipantDetails(confirmationNumber, passcode, name, email, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };

  var cleanName = String(name || '').trim();
  var cleanEmail = String(email || '').trim();
  if (!cleanName) return { success: false, message: t_(lang, 'nameRequired') };
  if (!isValidEmail_(cleanEmail)) return { success: false, message: t_(lang, 'emailInvalid') };

  var cols = CONFIG.BOOKING_COLS;
  v.record.sheet.getRange(v.record.rowIndex, cols.NAME + 1).setValue(cleanName);
  v.record.sheet.getRange(v.record.rowIndex, cols.EMAIL + 1).setValue(cleanEmail);
  v.record.sheet.getRange(v.record.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());

  // Re-read so the response reflects what was stored.
  var fresh = findBookingByConfirmation_(confirmationNumber);
  return {
    success: true,
    message: t_(lang, 'detailsUpdated'),
    booking: describeBookingForParticipant_(fresh, lang)
  };
}

/**
 * Client-callable: available Day 1 slots the participant could move to.
 * Excludes booked slots and any Day 1 slot with no available compatible
 * Day 2 partner. The participant's CURRENT slots are excluded too, since
 * "rescheduling to the same slot" is a no-op.
 */
function getRescheduleDay1Options(confirmationNumber, passcode, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };

  var currentDay1 = String(v.record.values[CONFIG.BOOKING_COLS.DAY1_SLOT_ID] || '');
  // Round 7: filter by the booking's ORIGINAL stored language preference,
  // not the (possibly different) UI language the participant happens to
  // be browsing the manage-booking page in right now.
  var filterLanguage = v.record.values[CONFIG.BOOKING_COLS.LANGUAGE];
  var options = getDay1Slots(lang, filterLanguage).filter(function (s) {
    return s.slotID !== currentDay1;
  });
  return { success: true, slots: options };
}

/** Client-callable: compatible, available Day 2 slots for a chosen Day 1. */
function getRescheduleDay2Options(confirmationNumber, passcode, day1SlotID, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };
  return { success: true, slots: getCompatibleDay2Slots(day1SlotID, lang, v.record.values[CONFIG.BOOKING_COLS.LANGUAGE]) };
}

/**
 * Client-callable: compatible, available Day 2 slots for the participant's
 * OWN current Day 1 slot — powers the "Change Day 2 Only" quick-reschedule
 * path, which never needs to know (or expose) its own Day 1 SlotID.
 */
function getRescheduleDay2OptionsForCurrentDay1(confirmationNumber, passcode, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };
  var day1ID = String(v.record.values[CONFIG.BOOKING_COLS.DAY1_SLOT_ID] || '');
  return { success: true, slots: getCompatibleDay2Slots(day1ID, lang, v.record.values[CONFIG.BOOKING_COLS.LANGUAGE]) };
}

/**
 * Client-callable: performs the reschedule.
 *
 * Releases the old Day 1/Day 2 slots, books the new pair, and PRESERVES the
 * existing confirmation number and passcode (per the security rules — they
 * only change if an administrator regenerates them). Runs under the booking
 * lock and re-validates availability inside it.
 */
function rescheduleBooking(confirmationNumber, passcode, newDay1SlotID, newDay2SlotID, lang) {
  lang = normalizeLang_(lang);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (e) {
    return { success: false, message: t_(lang, 'systemBusy') };
  }

  try {
    var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
    if (!v.ok) return { success: false, message: v.message };
    return rescheduleBookingCore_(v.record, newDay1SlotID, newDay2SlotID, lang, 'participant');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable, ADMIN: reschedules a booking on the participant's behalf,
 * identified by Booking ID (Confirmation Number) — no passcode needed since
 * the admin session itself is the authentication. Shares its logic 1:1 with
 * the participant-facing rescheduleBooking() via rescheduleBookingCore_, so
 * the same independent-Day-1/Day-2 rules, compatibility checks, and
 * calendar/email/notification behavior apply either way.
 */
function adminRescheduleBooking(token, confirmationNumber, newDay1SlotID, newDay2SlotID, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (e) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var record = findBookingByConfirmation_(confirmationNumber);
    if (!record) return { success: false, message: 'Booking not found.' };
    if (String(record.values[CONFIG.BOOKING_COLS.STATUS] || '').trim().toLowerCase() === 'cancelled') {
      return { success: false, message: 'This booking has already been cancelled.' };
    }
    return rescheduleBookingCore_(record, newDay1SlotID, newDay2SlotID, lang, session.name + ' <' + session.email + '> (admin)');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Shared reschedule logic (assumes the caller already holds the script lock
 * and has authenticated/authorized the request). See rescheduleBooking()
 * for the full behavior description.
 * @param {Object} record - a resolved Bookings row {sheet, rowIndex, values}
 * @param {string} newDay1SlotID - empty/falsy means "keep current Day 1"
 * @param {string} newDay2SlotID - empty/falsy means "keep current Day 2"
 * @param {string} lang
 * @param {string} actorLabel - who made the change, for notification text
 */
function rescheduleBookingCore_(record, newDay1SlotID, newDay2SlotID, lang, actorLabel) {
  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var confirmationNumber = String(record.values[cols.CONFIRMATION_NUMBER] || '');
  var passcode = String(record.values[cols.PASSCODE] || '');
  var oldDay1ID = String(record.values[cols.DAY1_SLOT_ID] || '');
  var oldDay2ID = String(record.values[cols.DAY2_SLOT_ID] || '');

  // Either side may be omitted, meaning "keep my current slot for that
  // day" — this is what makes Day 1 and Day 2 independently reschedulable.
  var targetDay1ID = newDay1SlotID ? String(newDay1SlotID).trim() : oldDay1ID;
  var targetDay2ID = newDay2SlotID ? String(newDay2SlotID).trim() : oldDay2ID;
  var day1Changing = (targetDay1ID !== oldDay1ID);
  var day2Changing = (targetDay2ID !== oldDay2ID);
  if (!day1Changing && !day2Changing) {
    return { success: false, message: t_(lang, 'noChangeSelected') };
  }

  var targetDay1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, targetDay1ID);
  var targetDay2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, targetDay2ID);
  if (!targetDay1 || !targetDay2) return { success: false, message: t_(lang, 'slotNotFound') };

  // Only a side that's actually CHANGING needs an availability check — the
  // unchanged side is already booked by this same booking.
  if (day1Changing && isBooked_(targetDay1.values[scols.BOOKED])) {
    return { success: false, message: t_(lang, 'day1Taken') };
  }
  if (day2Changing && isBooked_(targetDay2.values[scols.BOOKED])) {
    return { success: false, message: t_(lang, 'day2Taken') };
  }

  var d1DT = combineDateAndTime_(targetDay1.values[scols.DATE], targetDay1.values[scols.START_TIME]);
  var d2DT = combineDateAndTime_(targetDay2.values[scols.DATE], targetDay2.values[scols.START_TIME]);
  if (!isSlotPairCompatible_(d1DT, d2DT)) {
    return { success: false, message: t_(lang, 'mappingInvalid') };
  }

  // Capture the old appointment for the summary/notifications before
  // releasing anything. Staff emails are read directly off the slot
  // records purely for internal notification purposes — oldSummary itself
  // is participant-safe and already omits staff info.
  var oldSummary = describeBookingForParticipant_(record, lang);
  var oldDay1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, oldDay1ID);
  var oldDay2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, oldDay2ID);
  var oldDay1StaffEmail = oldDay1Record ? String(oldDay1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '') : '';
  var oldDay2StaffEmail = oldDay2Record ? String(oldDay2Record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '') : '';

  // Release/rebook only the side(s) that actually changed.
  if (day1Changing) {
    if (oldDay1Record) oldDay1Record.sheet.getRange(oldDay1Record.rowIndex, scols.BOOKED + 1).setValue(false);
    targetDay1.sheet.getRange(targetDay1.rowIndex, scols.BOOKED + 1).setValue(true);
    // Requirement #5/#12: the Blood Drawing tie-in follows the booking's
    // Day 1 slot — unlink the old one, link the new one.
    unlinkBloodDrawingFromBooking_(oldDay1ID);
    linkBloodDrawingToBooking_(targetDay1ID, confirmationNumber, String(record.values[cols.NAME] || ''));
  }
  if (day2Changing) {
    if (oldDay2Record) oldDay2Record.sheet.getRange(oldDay2Record.rowIndex, scols.BOOKED + 1).setValue(false);
    targetDay2.sheet.getRange(targetDay2.rowIndex, scols.BOOKED + 1).setValue(true);
  }

  // Clear the OLD calendar event only for a side that actually moved —
  // upsertParticipantCalendarEvents_ below already deletes-and-recreates
  // the event for the (possibly unchanged) target slot ID, so touching an
  // unchanged side here would be redundant.
  deleteParticipantCalendarEvents_(
    day1Changing ? oldDay1ID : '', day2Changing ? oldDay2ID : '',
    (day1Changing && oldDay1Record) ? combineDateAndTime_(oldDay1Record.values[scols.DATE], oldDay1Record.values[scols.START_TIME]) : null,
    (day2Changing && oldDay2Record) ? combineDateAndTime_(oldDay2Record.values[scols.DATE], oldDay2Record.values[scols.START_TIME]) : null
  );

  // Update the booking row — confirmation number and passcode are preserved.
  record.sheet.getRange(record.rowIndex, cols.DAY1_SLOT_ID + 1).setValue(targetDay1ID);
  record.sheet.getRange(record.rowIndex, cols.DAY2_SLOT_ID + 1).setValue(targetDay2ID);
  record.sheet.getRange(record.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());

  var name = String(record.values[cols.NAME] || '');
  var email = String(record.values[cols.EMAIL] || '');
  var comments = String(record.values[cols.COMMENTS] || '');
  var title = String(record.values[cols.TITLE] || '');
  var day1Staff = String(targetDay1.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
  var day2Staff = String(targetDay2.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');

  upsertParticipantCalendarEvents_(
    targetDay1ID, targetDay2ID, name, email,
    combineDateAndTime_(targetDay1.values[scols.DATE], targetDay1.values[scols.START_TIME]),
    combineDateAndTime_(targetDay1.values[scols.DATE], targetDay1.values[scols.END_TIME]),
    combineDateAndTime_(targetDay2.values[scols.DATE], targetDay2.values[scols.START_TIME]),
    combineDateAndTime_(targetDay2.values[scols.DATE], targetDay2.values[scols.END_TIME]),
    day1Staff, day2Staff, 'Rescheduled', title
  );

  var day1Details = {
    date: formatDateForDisplay_(targetDay1.values[scols.DATE], lang),
    startTime: formatTimeForDisplay_(targetDay1.values[scols.START_TIME], lang),
    endTime: formatTimeForDisplay_(targetDay1.values[scols.END_TIME], lang)
  };
  var day2Details = {
    date: formatDateForDisplay_(targetDay2.values[scols.DATE], lang),
    startTime: formatTimeForDisplay_(targetDay2.values[scols.START_TIME], lang),
    endTime: formatTimeForDisplay_(targetDay2.values[scols.END_TIME], lang)
  };

  try {
    sendConfirmationEmail_(email, name, day1Details, day2Details, lang, {
      confirmationNumber: confirmationNumber,
      passcode: passcode,
      comments: comments,
      day1Staff: day1Staff,
      day2Staff: day2Staff
    });
  } catch (err) {
    Logger.log('Reschedule email failed: ' + err);
  }

  notifyBookingChange_('Booking rescheduled', [
    'Participant: ' + name + ' <' + email + '>',
    'Confirmation Number: ' + confirmationNumber,
    day1Changing
      ? ('Day 1 changed: ' + oldDay1ID + (oldSummary.day1 ? ' (' + oldSummary.day1.date + ' ' + oldSummary.day1.startTime + '–' + oldSummary.day1.endTime + ')' : '') +
         ' -> ' + targetDay1ID + ' (' + day1Details.date + ' ' + day1Details.startTime + '–' + day1Details.endTime + ') staff: ' + (day1Staff || 'unassigned'))
      : 'Day 1 unchanged: ' + targetDay1ID,
    day2Changing
      ? ('Day 2 changed: ' + oldDay2ID + (oldSummary.day2 ? ' (' + oldSummary.day2.date + ' ' + oldSummary.day2.startTime + '–' + oldSummary.day2.endTime + ')' : '') +
         ' -> ' + targetDay2ID + ' (' + day2Details.date + ' ' + day2Details.startTime + '–' + day2Details.endTime + ') staff: ' + (day2Staff || 'unassigned'))
      : 'Day 2 unchanged: ' + targetDay2ID,
    'Changed by: ' + actorLabel
  ], [
    day1Staff, day2Staff,
    oldDay1StaffEmail,
    oldDay2StaffEmail
  ], 'bookingRescheduled');

  return {
    success: true,
    message: t_(lang, 'rescheduled'),
    oldBooking: oldSummary,
    newBooking: { day1: day1Details, day2: day2Details },
    confirmationNumber: confirmationNumber
  };
}

/**
 * Client-callable: checks whether the participant's CURRENT Day 2 slot is
 * still within the compatibility window of a CANDIDATE new Day 1 slot —
 * used by the "reschedule Day 1" flow to offer keeping the same Day 2
 * appointment instead of forcing a new pick. The current Day 2 slot is
 * naturally excluded from getRescheduleDay2Options (it's already booked BY
 * this booking), so this is a separate, purpose-built check.
 * @return {Object} {success, compatible, currentDay2?}
 */
function checkCurrentDay2StillCompatible(confirmationNumber, passcode, candidateDay1SlotID, lang) {
  lang = normalizeLang_(lang);
  var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
  if (!v.ok) return { success: false, message: v.message };

  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var currentDay2ID = String(v.record.values[cols.DAY2_SLOT_ID] || '');
  var candidateDay1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, candidateDay1SlotID);
  var currentDay2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, currentDay2ID);
  if (!candidateDay1 || !currentDay2) return { success: true, compatible: false };

  var d1DT = combineDateAndTime_(candidateDay1.values[scols.DATE], candidateDay1.values[scols.START_TIME]);
  var d2DT = combineDateAndTime_(currentDay2.values[scols.DATE], currentDay2.values[scols.START_TIME]);

  return {
    success: true,
    compatible: isSlotPairCompatible_(d1DT, d2DT),
    currentDay2: {
      slotID: currentDay2ID,
      date: formatDateForDisplay_(currentDay2.values[scols.DATE], lang),
      startTime: formatTimeForDisplay_(currentDay2.values[scols.START_TIME], lang),
      endTime: formatTimeForDisplay_(currentDay2.values[scols.END_TIME], lang)
    }
  };
}

/**
 * Client-callable: cancels a booking.
 *
 * The Bookings row is KEPT and marked 'Cancelled' rather than deleted, so
 * the confirmation number is never reused and the research team retains a
 * record (including any future availability the participant offered).
 * @param {Array<string>} availabilityDates - ISO dates, or [] with dontKnow
 * @param {boolean} dontKnow
 */
function cancelBooking(confirmationNumber, passcode, availabilityDates, dontKnow, lang) {
  lang = normalizeLang_(lang);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (e) {
    return { success: false, message: t_(lang, 'systemBusy') };
  }

  try {
    var v = verifyBookingCredentials_(confirmationNumber, passcode, lang);
    if (!v.ok) return { success: false, message: v.message };
    return cancelBookingCore_(v.record, availabilityDates, dontKnow, lang, 'participant');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable, ADMIN: cancels a booking on the participant's behalf,
 * identified by Booking ID (Confirmation Number) — no passcode needed.
 * Supports the same "record next possible availability" step as the
 * participant-facing flow, per the Admin Booking Management requirement.
 */
function adminCancelBooking(token, confirmationNumber, availabilityDates, dontKnow, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (e) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var record = findBookingByConfirmation_(confirmationNumber);
    if (!record) return { success: false, message: 'Booking not found.' };
    if (String(record.values[CONFIG.BOOKING_COLS.STATUS] || '').trim().toLowerCase() === 'cancelled') {
      return { success: false, message: 'This booking has already been cancelled.' };
    }
    return cancelBookingCore_(record, availabilityDates, dontKnow, lang, session.name + ' <' + session.email + '> (admin)');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Shared cancellation logic (assumes the caller already holds the script
 * lock and has authenticated/authorized the request).
 * @param {Object} record - a resolved Bookings row {sheet, rowIndex, values}
 * @param {Array<string>} availabilityDates - ISO dates, or [] with dontKnow
 * @param {boolean} dontKnow
 * @param {string} lang
 * @param {string} actorLabel - who cancelled it, for notification text
 */
function cancelBookingCore_(record, availabilityDates, dontKnow, lang, actorLabel) {
  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var confirmationNumber = String(record.values[cols.CONFIRMATION_NUMBER] || '');
  var summary = describeBookingForParticipant_(record, lang);
  var day1ID = String(record.values[cols.DAY1_SLOT_ID] || '');
  var day2ID = String(record.values[cols.DAY2_SLOT_ID] || '');

  var d1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1ID);
  var d2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2ID);
  var day1StaffEmail = d1 ? String(d1.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '') : '';
  var day2StaffEmail = d2 ? String(d2.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '') : '';
  var mriSlotIDForSummary = d1 ? String(d1.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '') : '';
  if (d1) d1.sheet.getRange(d1.rowIndex, scols.BOOKED + 1).setValue(false);
  if (d2) d2.sheet.getRange(d2.rowIndex, scols.BOOKED + 1).setValue(false);

  // Requirement #12: update the associated Blood Drawing slot — remove the
  // Booking ID and return it to the appropriate available state.
  unlinkBloodDrawingFromBooking_(day1ID);

  deleteParticipantCalendarEvents_(
    day1ID, day2ID,
    d1 ? combineDateAndTime_(d1.values[scols.DATE], d1.values[scols.START_TIME]) : null,
    d2 ? combineDateAndTime_(d2.values[scols.DATE], d2.values[scols.START_TIME]) : null
  );

  var availabilityText = dontKnow
    ? "I don't know yet"
    : (availabilityDates || []).join(', ');

  record.sheet.getRange(record.rowIndex, cols.STATUS + 1).setValue('Cancelled');
  record.sheet.getRange(record.rowIndex, cols.AVAILABILITY + 1).setValue(availabilityText);
  record.sheet.getRange(record.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());

  var name = summary.name;
  var email = summary.email;

  try {
    var isDe = (lang === 'de');
    MailApp.sendEmail(
      email,
      'Stornierung bestätigt / Cancellation confirmed — ' + CONFIG.EXPERIMENT_NAME.en,
      bilingualBody_(
        'Hallo ' + name + ',\n\n' +
        'Ihr Termin wurde storniert. Ihre Bestätigungsnummer war: ' + confirmationNumber + '\n\n' +
        (availabilityText ? 'Ihre angegebene Verfügbarkeit: ' + availabilityText + '\n\n' : '') +
        'Kontakt:\n' + CONFIG.CONTACT.email + '\n' + CONFIG.CONTACT.phone,
        'Hello ' + name + ',\n\n' +
        'Your appointment has been cancelled. Your confirmation number was: ' + confirmationNumber + '\n\n' +
        (availabilityText ? 'Availability you shared: ' + availabilityText + '\n\n' : '') +
        'Contact:\n' + CONFIG.CONTACT.email + '\n' + CONFIG.CONTACT.phone
      )
    );
  } catch (err) {
    Logger.log('Cancellation email failed: ' + err);
  }

  notifyBookingChange_('Booking cancelled', [
    'Participant: ' + name + ' <' + email + '>',
    'Confirmation Number: ' + confirmationNumber,
    'Cancelled Day 1: ' + day1ID + (summary.day1 ? ' (' + summary.day1.date + ' ' + summary.day1.startTime + '–' + summary.day1.endTime + ')' : ''),
    'Cancelled Day 2: ' + day2ID + (summary.day2 ? ' (' + summary.day2.date + ' ' + summary.day2.startTime + '–' + summary.day2.endTime + ')' : ''),
    'MRI slot: ' + (mriSlotIDForSummary || '(none)'),
    summary.comments ? 'Booking comments: ' + summary.comments : '',
    'Next possible availability: ' + (availabilityText || 'not provided'),
    'Cancelled by: ' + actorLabel
  ].filter(Boolean), [
    day1StaffEmail,
    day2StaffEmail
  ], 'bookingCancelled');

  return { success: true, message: t_(lang, 'cancelled'), booking: summary };
}

/**
 * ============================================================================
 *  ADMIN PORTAL
 * ============================================================================
 *  Every function below is only reachable in a meaningful way by whoever can
 *  load Admin.html — i.e. only the owner, if you deploy that page with
 *  "Only myself" access as described in README.md. As a second layer, every
 *  admin action additionally requires a valid session token obtained via
 *  adminLogin(), which itself requires the admin password.
 * ============================================================================
 */

/**
 * ----------------------------------------------------------------------------
 * PASSWORD STORAGE (hashed, in Script Properties — never stored in plaintext)
 * ----------------------------------------------------------------------------
 */

/**
 * Computes a salted SHA-256 hex digest of a password.
 * @param {string} salt
 * @param {string} password
 * @return {string} hex-encoded hash
 */
function hashPassword_(salt, password) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8
  );
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * ----------------------------------------------------------------------------
 * ADMIN ACCOUNTS (Admins sheet — multi-role, replaces the old single shared
 * password entirely)
 * ----------------------------------------------------------------------------
 */

/**
 * Seeds the very first MainAdmin account (CONFIG.ADMIN_OWNER_EMAIL /
 * CONFIG.ADMIN_DEFAULT_PASSWORD) the first time the Admins sheet is empty.
 * Safe to call on every login attempt — a no-op once any admin row exists.
 */
function ensureMainAdminSeeded_() {
  var sheet = getSheet_(CONFIG.SHEETS.ADMINS);
  if (sheet.getLastRow() >= 2) return; // at least one admin already exists

  var salt = Utilities.getUuid();
  sheet.appendRow([
    'Main Admin',
    CONFIG.ADMIN_OWNER_EMAIL,
    'MainAdmin',
    hashPassword_(salt, CONFIG.ADMIN_DEFAULT_PASSWORD),
    salt,
    true,
    new Date()
  ]);
}

/**
 * Finds an Admins-sheet row by email (case-insensitive).
 * @param {string} email
 * @return {?{sheet: Sheet, rowIndex: number, values: Array}}
 */
function findAdminByEmail_(email) {
  var sheet = getSheet_(CONFIG.SHEETS.ADMINS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var cols = CONFIG.ADMIN_COLS;
  var values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var target = String(email || '').trim().toLowerCase();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][cols.EMAIL] || '').trim().toLowerCase() === target) {
      return { sheet: sheet, rowIndex: i + 2, values: values[i] };
    }
  }
  return null;
}

/** Returns every row of the Admins sheet as plain objects (values array form). */
function getAllAdminRecords_() {
  var sheet = getSheet_(CONFIG.SHEETS.ADMINS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  return values.map(function (row, i) { return { rowIndex: i + 2, values: row }; });
}

/**
 * Finds the active MainAdmin's email, for "notify the Main Admin"
 * notifications. Falls back to CONFIG.ADMIN_OWNER_EMAIL if, for some
 * reason, no active MainAdmin row exists.
 * @return {string}
 */
function getMainAdminEmail_() {
  var cols = CONFIG.ADMIN_COLS;
  var records = getAllAdminRecords_();
  for (var i = 0; i < records.length; i++) {
    var v = records[i].values;
    if (String(v[cols.ROLE]) === 'MainAdmin' && isBooked_(v[cols.ACTIVE])) {
      return String(v[cols.EMAIL]);
    }
  }
  return CONFIG.ADMIN_OWNER_EMAIL;
}

/**
 * ----------------------------------------------------------------------------
 * SESSION HANDLING & PERMISSIONS
 * ----------------------------------------------------------------------------
 */

/**
 * Throws if the given token does not correspond to a currently-valid admin
 * session. Called at the top of every sensitive admin function. Also slides
 * the session's expiration forward on each successful call.
 * @param {string} token
 * @return {{email: string, name: string, role: string}} the session
 */
function requireAdminAuth_(token) {
  if (!token) {
    throw new Error('Not signed in. Please log in again.');
  }
  var cache = CacheService.getScriptCache();
  var raw = cache.get('ADMIN_SESSION_' + token);
  if (!raw) {
    throw new Error('Your admin session has expired. Please log in again.');
  }
  cache.put('ADMIN_SESSION_' + token, raw, CONFIG.ADMIN_SESSION_TTL_SECONDS);
  return JSON.parse(raw);
}

/**
 * ----------------------------------------------------------------------------
 * CONFIGURABLE ROLES & PERMISSIONS (2026-08 requirements pass, section 10)
 * ----------------------------------------------------------------------------
 * Permissions now live in the `Roles` sheet (RoleName | Permissions (comma-
 * separated) | UpdatedAt), seeded once from CONFIG.ROLE_PERMISSIONS. The
 * Main Admin can create, edit, and assign roles/permissions at any time via
 * getRolesConfig() / updateRolePermissions() / createRole() below, with no
 * code changes required. CONFIG.ROLE_PERMISSIONS remains only as the
 * fallback used to seed the sheet the first time it's created.
 * Cached briefly in the script cache to keep permission checks cheap.
 */
var ROLE_PERMISSIONS_CACHE_KEY_ = 'ROLE_PERMISSIONS_MAP_V1';
var ROLE_PERMISSIONS_CACHE_TTL_ = 300; // 5 minutes

/**
 * The full list of valid role names, read dynamically from the live Roles
 * sheet (the same source of truth as getRolePermissionsMap_) rather than
 * the static CONFIG.ADMIN_ROLES seed list. This is what makes a role
 * created via "Create New Role" immediately assignable/usable everywhere
 * else in the app: Apps Script rebuilds CONFIG fresh on every separate
 * execution, so a plain CONFIG.ADMIN_ROLES.push() from one request is
 * invisible to any other request — every consumer of "the list of valid
 * roles" needs to read the sheet (via this function), not the static array.
 * @return {Array<string>}
 */
function getAllRoleNames_() {
  var names = Object.keys(getRolePermissionsMap_());
  return names.length ? names : CONFIG.ADMIN_ROLES.slice();
}

function invalidateRolePermissionsCache_() {
  try { CacheService.getScriptCache().remove(ROLE_PERMISSIONS_CACHE_KEY_); } catch (e) { /* ignore */ }
}

/**
 * Returns the live role -> permissions map, reading from the Roles sheet
 * (with a short cache) and falling back to CONFIG.ROLE_PERMISSIONS if the
 * sheet is empty or unreadable.
 * @return {Object<string, Array<string>>}
 */
function getRolePermissionsMap_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(ROLE_PERMISSIONS_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and rebuild */ }
  }

  var map = {};
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.ROLES);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
      values.forEach(function (row) {
        var roleName = String(row[0] || '').trim();
        if (!roleName) return;
        var perms = String(row[1] || '').split(',').map(function (p) { return p.trim(); }).filter(Boolean);
        map[roleName] = perms;
      });
    }
  } catch (e) {
    Logger.log('getRolePermissionsMap_ failed to read Roles sheet, falling back to CONFIG: ' + e);
  }

  if (!Object.keys(map).length) {
    map = CONFIG.ROLE_PERMISSIONS;
  }

  try { cache.put(ROLE_PERMISSIONS_CACHE_KEY_, JSON.stringify(map), ROLE_PERMISSIONS_CACHE_TTL_); } catch (e) { /* ignore */ }
  return map;
}

/** Seeds the Roles sheet from CONFIG.ROLE_PERMISSIONS/CONFIG.ADMIN_ROLES the first time it's empty. Safe to call repeatedly. */
function ensureRolesSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.ROLES);
  if (sheet.getLastRow() >= 2) return;
  CONFIG.ADMIN_ROLES.forEach(function (roleName) {
    var perms = CONFIG.ROLE_PERMISSIONS[roleName] || [];
    sheet.appendRow([roleName, perms.join(','), new Date()]);
  });
  invalidateRolePermissionsCache_();
}

/**
 * Throws if the session's role does not grant the given permission string.
 * Reads from the live, Main-Admin-editable Roles store (getRolePermissionsMap_).
 * @param {{role: string}} session
 * @param {string} permission
 */
function requirePermission_(session, permission) {
  var granted = getRolePermissionsMap_()[session.role] || [];
  if (granted.indexOf(permission) === -1) {
    throw new Error('Your role (' + session.role + ') does not have permission to do that.');
  }
}

/**
 * Client-callable (MainAdmin only): every role with its permission list and
 * the full permission catalog (for rendering the "Manage Roles" checkbox
 * grid).
 * @return {Object} {roles: {RoleName: [perm,...]}, catalog: [{key,label},...], allRoleNames: [...]}
 */
function getRolesConfig(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureRolesSeeded_();
  return {
    roles: getRolePermissionsMap_(),
    catalog: CONFIG.PERMISSIONS_CATALOG,
    allRoleNames: getAllRoleNames_()
  };
}

/**
 * Client-callable (MainAdmin only): overwrites a role's permission list.
 * Refuses to strip 'manage_roles' from MainAdmin so the Main Admin can never
 * lock themselves out of role management (mirrors the existing "can't
 * remove the last MainAdmin" protection).
 * @param {string} token
 * @param {string} roleName
 * @param {Array<string>} permissions
 * @return {Object} {success, message?}
 */
function updateRolePermissions(token, roleName, permissions) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');

  roleName = String(roleName || '').trim();
  if (!roleName) return { success: false, message: 'Role name is required.' };
  if (roleName === 'MainAdmin' && CONFIG.PERMISSIONS_CATALOG.some(function (p) { return p.key === 'manage_roles'; }) &&
      (permissions || []).indexOf('manage_roles') === -1) {
    return { success: false, message: 'MainAdmin must always keep the "Manage roles & permissions" permission.' };
  }

  var validKeys = CONFIG.PERMISSIONS_CATALOG.map(function (p) { return p.key; });
  var cleanPerms = (permissions || []).map(function (p) { return String(p).trim(); }).filter(function (p) {
    return validKeys.indexOf(p) !== -1;
  });

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.ROLES);
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === roleName) {
        sheet.getRange(i + 2, 2).setValue(cleanPerms.join(','));
        sheet.getRange(i + 2, 3).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) {
    sheet.appendRow([roleName, cleanPerms.join(','), new Date()]);
  }
  invalidateRolePermissionsCache_();
  return { success: true, message: 'Permissions for ' + roleName + ' updated.' };
}

/**
 * Client-callable (MainAdmin only): creates a brand-new role with the given
 * permission set. The Roles sheet is the durable source of truth for both
 * role names and their permissions — every other function that needs "the
 * list of valid roles" reads it dynamically (getAllRoleNames_()), so a role
 * created here is immediately usable everywhere (assignable to an admin,
 * grantable on a task, etc.) without any further step.
 * @param {string} token
 * @param {string} roleName
 * @param {Array<string>} permissions
 */
function createRole(token, roleName, permissions) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');

  roleName = String(roleName || '').trim();
  if (!roleName) return { success: false, message: 'Role name is required.' };
  if (getAllRoleNames_().indexOf(roleName) !== -1) {
    return { success: false, message: 'A role with that name already exists.' };
  }

  var validKeys = CONFIG.PERMISSIONS_CATALOG.map(function (p) { return p.key; });
  var cleanPerms = (permissions || []).map(function (p) { return String(p).trim(); }).filter(function (p) {
    return validKeys.indexOf(p) !== -1;
  });

  getOrCreateConfigSheet_(CONFIG.SHEETS.ROLES).appendRow([roleName, cleanPerms.join(','), new Date()]);
  invalidateRolePermissionsCache_();
  return { success: true, message: 'Role "' + roleName + '" created.' };
}

/**
 * Returns info for the admin login screen: the currently signed-in Google
 * account (best-effort — may be blank depending on deployment access) and
 * the expected owner email, so the login page can show a friendly banner.
 * @return {Object} {signedInEmail, ownerEmail}
 */
function getAdminContext() {
  return {
    signedInEmail: getCurrentUserEmail_(),
    ownerEmail: CONFIG.ADMIN_OWNER_EMAIL
  };
}

function getCurrentUserEmail_() {
  try {
    var email = Session.getActiveUser().getEmail();
    return email || '';
  } catch (err) {
    return '';
  }
}

/**
 * Verifies an admin's email + password and, on success, issues a session
 * token carrying their email/name/role.
 * @param {string} email
 * @param {string} password
 * @return {Object} {success, token?, name?, role?, message?}
 */
function adminLogin(email, password) {
  ensureMainAdminSeeded_();
  if (!email || !password) {
    return { success: false, message: 'Please enter your email and password.' };
  }

  var record = findAdminByEmail_(email);
  if (!record) {
    return { success: false, message: 'No admin account found for that email.' };
  }
  var cols = CONFIG.ADMIN_COLS;
  if (!isBooked_(record.values[cols.ACTIVE])) {
    return { success: false, message: 'This admin account has been deactivated.' };
  }
  var candidate = hashPassword_(record.values[cols.PW_SALT], password);
  if (candidate !== record.values[cols.PW_HASH]) {
    return { success: false, message: 'Incorrect password.' };
  }

  var session = {
    email: String(record.values[cols.EMAIL]),
    name: String(record.values[cols.NAME]),
    role: String(record.values[cols.ROLE])
  };
  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('ADMIN_SESSION_' + token, JSON.stringify(session), CONFIG.ADMIN_SESSION_TTL_SECONDS);
  return {
    success: true,
    token: token,
    name: session.name,
    role: session.role,
    email: session.email,
    // The client uses this only to hide/show controls. It is NOT the
    // security boundary — every mutating server function independently
    // re-checks via requirePermission_(), so a tampered client gains
    // nothing by claiming extra permissions here.
    permissions: getRolePermissionsMap_()[session.role] || []
  };
}

/**
 * Client-callable: the list of assignable roles, for the "Manage Admins"
 * role dropdowns. Reads dynamically from the Roles sheet (getAllRoleNames_)
 * so a role created via "Create New Role" appears immediately.
 */
function getRoleOptions(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');
  return getAllRoleNames_();
}

/**
 * Invalidates an admin session token.
 * @param {string} token
 * @return {Object} {success}
 */
function adminLogout(token) {
  if (token) {
    CacheService.getScriptCache().remove('ADMIN_SESSION_' + token);
  }
  return { success: true };
}

/**
 * ----------------------------------------------------------------------------
 * SELF-SERVICE PASSWORD CHANGE (OTP emailed to the LOGGED-IN admin's own
 * address — every admin now has their own account/inbox, unlike the old
 * single shared password which had to use one fixed address)
 * ----------------------------------------------------------------------------
 */

/**
 * Step 1: verifies the current password, then emails a 6-digit verification
 * code to the CALLER'S OWN admin email (never anywhere client-supplied).
 * @param {string} token
 * @param {string} currentPassword
 * @param {string} newPassword
 * @return {Object} {success, message}
 */
function adminRequestPasswordChange(token, currentPassword, newPassword) {
  var session = requireAdminAuth_(token);
  var record = findAdminByEmail_(session.email);
  if (!record) return { success: false, message: 'Your admin account could not be found.' };

  var cols = CONFIG.ADMIN_COLS;
  var candidate = hashPassword_(record.values[cols.PW_SALT], currentPassword || '');
  if (candidate !== record.values[cols.PW_HASH]) {
    return { success: false, message: 'Current password is incorrect.' };
  }
  if (!newPassword || newPassword.length < 6) {
    return { success: false, message: 'New password must be at least 6 characters long.' };
  }
  if (newPassword === currentPassword) {
    return { success: false, message: 'New password must be different from the current password.' };
  }

  var otp = String(Math.floor(100000 + Math.random() * 900000));
  var pendingHash = hashPassword_(record.values[cols.PW_SALT], newPassword);
  CacheService.getScriptCache().put(
    'ADMIN_PW_RESET_' + session.email.toLowerCase(),
    JSON.stringify({ otp: otp, newHash: pendingHash }),
    CONFIG.ADMIN_OTP_TTL_SECONDS
  );

  MailApp.sendEmail(
    session.email,
    'Admin Password Change Verification Code',
    'A password change was requested for your ' + CONFIG.EXPERIMENT_NAME.en + ' admin account (' + session.email + ').\n\n' +
    'Verification code: ' + otp + '\n\n' +
    'This code expires in ' + Math.round(CONFIG.ADMIN_OTP_TTL_SECONDS / 60) + ' minutes. ' +
    'If you did not request this change, no action is needed — your password will not ' +
    'change without this code.'
  );

  return {
    success: true,
    message: 'A verification code has been sent to ' + session.email + '.'
  };
}

/**
 * Step 2: confirms the emailed code and, if it matches, commits the new
 * password hash onto the caller's own Admins row.
 * @param {string} token
 * @param {string} otpCode
 * @return {Object} {success, message}
 */
function adminConfirmPasswordChange(token, otpCode) {
  var session = requireAdminAuth_(token);
  var cacheKey = 'ADMIN_PW_RESET_' + session.email.toLowerCase();
  var raw = CacheService.getScriptCache().get(cacheKey);
  if (!raw) {
    return { success: false, message: 'Verification code expired or not found. Please request a new one.' };
  }
  var pending = JSON.parse(raw);
  if (String(otpCode || '').trim() !== pending.otp) {
    return { success: false, message: 'Incorrect verification code.' };
  }

  var record = findAdminByEmail_(session.email);
  if (!record) return { success: false, message: 'Your admin account could not be found.' };
  record.sheet.getRange(record.rowIndex, CONFIG.ADMIN_COLS.PW_HASH + 1).setValue(pending.newHash);
  CacheService.getScriptCache().remove(cacheKey);
  return { success: true, message: 'Password updated successfully.' };
}

/**
 * ----------------------------------------------------------------------------
 * FORGOT PASSWORD (unauthenticated — for an admin who cannot log in at all)
 * ----------------------------------------------------------------------------
 * Two-step, OTP-based, same pattern as adminRequestPasswordChange/
 * adminConfirmPasswordChange above, but reachable WITHOUT a valid session
 * (there can't be one yet — the admin is locked out). Both steps always
 * return a generic success shape for step 1 so a caller can't use this to
 * discover which email addresses have admin accounts.
 */

/**
 * Client-callable, UNAUTHENTICATED. Step 1: if the given email belongs to
 * an active admin, emails a 6-digit code to that SAME address (never to
 * anywhere client-supplied). Always returns the same generic message
 * regardless of whether the email matched, so this can't be used to probe
 * for valid admin accounts.
 * @param {string} email
 * @return {Object} {success: true, message}
 */
function adminForgotPasswordRequest(email) {
  var generic = {
    success: true,
    message: 'If that email belongs to an active admin account, a verification code has been sent to it.'
  };
  var normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return generic;

  var record = findAdminByEmail_(normalized);
  var cols = CONFIG.ADMIN_COLS;
  if (!record || !isBooked_(record.values[cols.ACTIVE])) return generic;

  var otp = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put(
    'ADMIN_FORGOT_PW_' + normalized,
    otp,
    CONFIG.ADMIN_OTP_TTL_SECONDS
  );

  try {
    var mins = Math.round(CONFIG.ADMIN_OTP_TTL_SECONDS / 60);
    var content = renderEmailTemplate_('passwordReset', {
      ParticipantName: normalized,
      Passcode: otp,
      Time: mins + ' minutes'
    });
    MailApp.sendEmail(normalized, content.subject, content.body);
  } catch (err) {
    Logger.log('adminForgotPasswordRequest email failed: ' + err);
  }

  return generic;
}

/**
 * Client-callable, UNAUTHENTICATED. Step 2: confirms the emailed code and
 * sets a brand-new password (and a fresh salt) — no knowledge of the old
 * password required.
 * @param {string} email
 * @param {string} otpCode
 * @param {string} newPassword
 * @return {Object} {success, message}
 */
function adminForgotPasswordConfirm(email, otpCode, newPassword) {
  var normalized = String(email || '').trim().toLowerCase();
  if (!newPassword || newPassword.length < 6) {
    return { success: false, message: 'New password must be at least 6 characters.' };
  }

  var cacheKey = 'ADMIN_FORGOT_PW_' + normalized;
  var stored = CacheService.getScriptCache().get(cacheKey);
  if (!stored || String(otpCode || '').trim() !== stored) {
    return { success: false, message: 'Incorrect or expired verification code. Please request a new one.' };
  }

  var record = findAdminByEmail_(normalized);
  if (!record) return { success: false, message: 'Admin account not found.' };

  var salt = Utilities.getUuid();
  record.sheet.getRange(record.rowIndex, CONFIG.ADMIN_COLS.PW_SALT + 1).setValue(salt);
  record.sheet.getRange(record.rowIndex, CONFIG.ADMIN_COLS.PW_HASH + 1).setValue(hashPassword_(salt, newPassword));
  CacheService.getScriptCache().remove(cacheKey);

  notifyAdminOfChange_('Admin password reset (Forgot Password)', ['Email: ' + normalized], 'adminAccountChanges');

  return { success: true, message: 'Password updated. You can now log in with your new password.' };
}

/**
 * ----------------------------------------------------------------------------
 * ADMIN MANAGEMENT (MainAdmin only — 'manage_admins' permission)
 * ----------------------------------------------------------------------------
 */

/** Client-callable: lists all admin accounts (never returns password hashes/salts). */
function getAdminsList(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var cols = CONFIG.ADMIN_COLS;
  return getAllAdminRecords_().map(function (r) {
    return {
      name: String(r.values[cols.NAME]),
      email: String(r.values[cols.EMAIL]),
      role: String(r.values[cols.ROLE]),
      active: isBooked_(r.values[cols.ACTIVE])
    };
  });
}

/** Client-callable: the list of valid admin role names, for the Manage Admins UI. */
function getAdminRoles(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');
  return getAllRoleNames_();
}

function countActiveMainAdmins_() {
  var cols = CONFIG.ADMIN_COLS;
  return getAllAdminRecords_().filter(function (r) {
    return String(r.values[cols.ROLE]) === 'MainAdmin' && isBooked_(r.values[cols.ACTIVE]);
  }).length;
}

/**
 * Client-callable: creates a new admin account. Emails the new admin their
 * login email + initial password directly (a simpler stand-in for a full
 * email-activation-link workflow — the new admin should change this
 * password via "Change Password" on first login).
 * @param {string} token
 * @param {Object} data - {name, email, role, initialPassword}
 * @return {Object}
 */
function createAdmin(token, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var name = String((data && data.name) || '').trim();
  var email = String((data && data.email) || '').trim();
  var role = String((data && data.role) || '').trim();
  var initialPassword = String((data && data.initialPassword) || '');

  if (!name) return { success: false, message: 'Please provide a name.' };
  if (!email || email.indexOf('@') === -1) return { success: false, message: 'Please provide a valid email.' };
  if (getAllRoleNames_().indexOf(role) === -1) return { success: false, message: 'Invalid role.' };
  if (!initialPassword || initialPassword.length < 6) return { success: false, message: 'Initial password must be at least 6 characters.' };
  if (findAdminByEmail_(email)) return { success: false, message: 'An admin with that email already exists.' };

  var salt = Utilities.getUuid();
  getSheet_(CONFIG.SHEETS.ADMINS).appendRow([
    name, email, role, hashPassword_(salt, initialPassword), salt, true, new Date()
  ]);

  try {
    var content = renderEmailTemplate_('adminApproval', {
      ParticipantName: email, // reused placeholder slot for "account email" in this context
      Passcode: initialPassword,
      AssignedStaff: role
    });
    MailApp.sendEmail(email, content.subject, content.body);
  } catch (err) {
    Logger.log('createAdmin welcome email failed: ' + err);
  }

  notifyAdminOfChange_('Admin account created', ['Name: ' + name, 'Email: ' + email, 'Role: ' + role, 'Created by: ' + session.email], 'adminAccountChanges');

  return { success: true, message: 'Admin account created for ' + email + '.' };
}

/**
 * Client-callable: changes an existing admin's role. Refuses to demote the
 * last active MainAdmin, so the system can never end up with zero admins
 * able to manage other admins.
 */
function updateAdminRole(token, email, newRole) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  if (getAllRoleNames_().indexOf(newRole) === -1) return { success: false, message: 'Invalid role.' };
  var record = findAdminByEmail_(email);
  if (!record) return { success: false, message: 'Admin not found.' };

  var cols = CONFIG.ADMIN_COLS;
  var wasMainAdmin = String(record.values[cols.ROLE]) === 'MainAdmin';
  if (wasMainAdmin && newRole !== 'MainAdmin' && countActiveMainAdmins_() <= 1) {
    return { success: false, message: 'Cannot change the last active MainAdmin\u2019s role — promote another admin to MainAdmin first.' };
  }

  record.sheet.getRange(record.rowIndex, cols.ROLE + 1).setValue(newRole);
  notifyAdminOfChange_('Admin role changed', ['Email: ' + email, 'New role: ' + newRole, 'Changed by: ' + session.email], 'adminAccountChanges');
  return { success: true, message: 'Updated role for ' + email + ' to ' + newRole + '.' };
}

/**
 * Client-callable: activates/deactivates an admin account (soft-disable
 * instead of deleting — preserves history). Same last-MainAdmin guard.
 */
function setAdminActive(token, email, active) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var record = findAdminByEmail_(email);
  if (!record) return { success: false, message: 'Admin not found.' };

  var cols = CONFIG.ADMIN_COLS;
  if (!active && String(record.values[cols.ROLE]) === 'MainAdmin' && countActiveMainAdmins_() <= 1) {
    return { success: false, message: 'Cannot deactivate the last active MainAdmin.' };
  }

  record.sheet.getRange(record.rowIndex, cols.ACTIVE + 1).setValue(!!active);
  notifyAdminOfChange_(active ? 'Admin reactivated' : 'Admin deactivated', ['Email: ' + email, 'Changed by: ' + session.email], 'adminAccountChanges');
  return { success: true, message: (active ? 'Reactivated ' : 'Deactivated ') + email + '.' };
}

/**
 * Client-callable: permanently removes an admin account. Same last-
 * MainAdmin guard as setAdminActive/updateAdminRole.
 */
function removeAdmin(token, email) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var record = findAdminByEmail_(email);
  if (!record) return { success: false, message: 'Admin not found.' };

  var cols = CONFIG.ADMIN_COLS;
  if (String(record.values[cols.ROLE]) === 'MainAdmin' && countActiveMainAdmins_() <= 1) {
    return { success: false, message: 'Cannot remove the last active MainAdmin.' };
  }

  // Round 5, #5: soft delete — also mark the account inactive so it can no
  // longer authenticate, while preserving the row for audit.
  softDeleteRowIndex_(CONFIG.SHEETS.ADMINS, record.rowIndex, session.email, 'Admin account removed');
  record.sheet.getRange(record.rowIndex, cols.ACTIVE + 1).setValue(false);
  notifyAdminOfChange_('Admin account removed', ['Email: ' + email, 'Removed by: ' + session.email], 'adminAccountChanges');
  return { success: true, message: 'Removed admin account for ' + email + '.' };
}

/**
 * Client-callable: MainAdmin-initiated password reset (no OTP needed, since
 * the MainAdmin is already authenticated+authorized). Emails the new
 * password directly to the affected admin — they should change it via
 * "Change Password" right after logging in.
 */
function resetAdminPassword(token, email, newPassword) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  if (!newPassword || newPassword.length < 6) return { success: false, message: 'New password must be at least 6 characters.' };
  var record = findAdminByEmail_(email);
  if (!record) return { success: false, message: 'Admin not found.' };

  var salt = Utilities.getUuid();
  record.sheet.getRange(record.rowIndex, CONFIG.ADMIN_COLS.PW_SALT + 1).setValue(salt);
  record.sheet.getRange(record.rowIndex, CONFIG.ADMIN_COLS.PW_HASH + 1).setValue(hashPassword_(salt, newPassword));

  try {
    MailApp.sendEmail(
      email,
      'Your Admin Password Was Reset — ' + CONFIG.EXPERIMENT_NAME.en,
      'Your admin password was reset by ' + session.email + '.\n\n' +
      'New password: ' + newPassword + '\n\n' +
      'Please log in and change it as soon as possible.'
    );
  } catch (err) {
    Logger.log('resetAdminPassword notification email failed: ' + err);
  }

  notifyAdminOfChange_('Admin password reset', ['Email: ' + email, 'Reset by: ' + session.email], 'adminAccountChanges');
  return { success: true, message: 'Password reset for ' + email + '.' };
}

/**
 * ----------------------------------------------------------------------------
 * SLOT OVERVIEW
 * ----------------------------------------------------------------------------
 */

/**
 * Returns every Day 1 and Day 2 slot dated today or later, with booking
 * status, sorted chronologically — for the admin dashboard. Includes both
 * display-formatted fields (for rendering) and raw ISO-ish fields (for
 * client-side collision/compatibility math without extra round-trips).
 * @param {string} token
 * @return {Object} {day1: [...], day2: [...]}
 */
function getAdminSlotsOverview(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');
  return {
    day1: getSlotsFromToday_(CONFIG.SHEETS.DAY1),
    day2: getSlotsFromToday_(CONFIG.SHEETS.DAY2),
    mri: getSlotsFromToday_(CONFIG.SHEETS.MRI)
  };
}

/**
 * ----------------------------------------------------------------------------
 * ADMIN BOOKING MANAGEMENT ('view' to list, 'manage_slots' to change anything)
 * ----------------------------------------------------------------------------
 *  Lets any approved admin view, reschedule, and cancel bookings — keyed by
 *  Booking ID (the same value participants call "Confirmation Number"), not
 *  by internal Slot IDs. Reschedule/cancel share their exact logic with the
 *  participant-facing flows via rescheduleBookingCore_/cancelBookingCore_,
 *  so there is only one implementation of those rules to keep correct.
 *  Deliberately never returns staff names or emails — this is a bookings
 *  view, not a staffing view.
 * ----------------------------------------------------------------------------
 */

/**
 * Client-callable, ADMIN: lists every booking (booked AND cancelled) for
 * the Booking Management screen — Booking ID, Passcode, Participant Name/
 * Email, Day 1/Day 2 slot summaries, and Status. No staff info included.
 */
function getAdminBookingsList(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');

  var sheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var values = sheet.getRange(2, 1, lastRow - 1, CONFIG.BOOKING_ROW_WIDTH).getValues();
  var out = [];

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var bookingID = String(row[cols.CONFIRMATION_NUMBER] || '');
    if (!bookingID) continue; // skip stray/blank rows

    var day1ID = String(row[cols.DAY1_SLOT_ID] || '');
    var day2ID = String(row[cols.DAY2_SLOT_ID] || '');
    var d1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1ID);
    var d2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2ID);
    var updatedAt = row[cols.UPDATED_AT];

    out.push({
      bookingID: bookingID,
      passcode: String(row[cols.PASSCODE] || ''),
      name: String(row[cols.NAME] || ''),
      email: String(row[cols.EMAIL] || ''),
      status: String(row[cols.STATUS] || ''),
      comments: String(row[cols.COMMENTS] || ''),
      day1: d1 ? {
        slotID: day1ID,
        date: formatDateForDisplay_(d1.values[scols.DATE], 'en'),
        startTime: formatTimeForDisplay_(d1.values[scols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(d1.values[scols.END_TIME], 'en')
      } : null,
      day2: d2 ? {
        slotID: day2ID,
        date: formatDateForDisplay_(d2.values[scols.DATE], 'en'),
        startTime: formatTimeForDisplay_(d2.values[scols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(d2.values[scols.END_TIME], 'en')
      } : null,
      updatedAtSortKey: (Object.prototype.toString.call(updatedAt) === '[object Date]') ? updatedAt.getTime() : 0
    });
  }

  // Most recently changed first.
  out.sort(function (a, b) { return b.updatedAtSortKey - a.updatedAtSortKey; });
  out.forEach(function (b) { delete b.updatedAtSortKey; });
  return out;
}

/** Client-callable, ADMIN: looks up one booking by Booking ID for detail display. */
function getAdminBookingDetail(token, bookingID, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');
  lang = normalizeLang_(lang);

  var record = findBookingByConfirmation_(bookingID);
  if (!record) return { success: false, message: 'Booking not found.' };
  return { success: true, booking: describeBookingForParticipant_(record, lang) };
}

/** Client-callable, ADMIN: available Day 1 slots to reschedule a booking to. */
function adminGetRescheduleDay1Options(token, bookingID, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);

  var record = findBookingByConfirmation_(bookingID);
  if (!record) return { success: false, message: 'Booking not found.' };
  var currentDay1 = String(record.values[CONFIG.BOOKING_COLS.DAY1_SLOT_ID] || '');
  // Round 7: filter by the booking's own stored language preference, not
  // the admin UI's display language (always 'en') — an admin rescheduling
  // a German-language booking should still only see German/Any slots.
  var options = getDay1Slots(lang, record.values[CONFIG.BOOKING_COLS.LANGUAGE]).filter(function (s) { return s.slotID !== currentDay1; });
  return { success: true, slots: options };
}

/** Client-callable, ADMIN: compatible, available Day 2 slots for a chosen Day 1. */
function adminGetRescheduleDay2Options(token, day1SlotID, lang, bookingID) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);
  var record = bookingID ? findBookingByConfirmation_(bookingID) : null;
  return { success: true, slots: getCompatibleDay2Slots(day1SlotID, lang, record ? record.values[CONFIG.BOOKING_COLS.LANGUAGE] : null) };
}

/**
 * Client-callable, ADMIN: compatible, available Day 2 slots for a booking's
 * OWN current Day 1 slot — powers the admin "Change Day 2 Only" quick path.
 */
function adminGetRescheduleDay2OptionsForCurrentDay1(token, bookingID, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);

  var record = findBookingByConfirmation_(bookingID);
  if (!record) return { success: false, message: 'Booking not found.' };
  var day1ID = String(record.values[CONFIG.BOOKING_COLS.DAY1_SLOT_ID] || '');
  return { success: true, slots: getCompatibleDay2Slots(day1ID, lang, record.values[CONFIG.BOOKING_COLS.LANGUAGE]) };
}

/**
 * Client-callable, ADMIN: checks whether a booking's CURRENT Day 2 slot is
 * still compatible with a candidate new Day 1 — powers the "keep current
 * Day 2" option in the admin reschedule flow.
 */
function adminCheckCurrentDay2StillCompatible(token, bookingID, candidateDay1SlotID, lang) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  lang = normalizeLang_(lang);

  var record = findBookingByConfirmation_(bookingID);
  if (!record) return { success: false, message: 'Booking not found.' };

  var cols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var currentDay2ID = String(record.values[cols.DAY2_SLOT_ID] || '');
  var candidateDay1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, candidateDay1SlotID);
  var currentDay2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, currentDay2ID);
  if (!candidateDay1 || !currentDay2) return { success: true, compatible: false };

  var d1DT = combineDateAndTime_(candidateDay1.values[scols.DATE], candidateDay1.values[scols.START_TIME]);
  var d2DT = combineDateAndTime_(currentDay2.values[scols.DATE], currentDay2.values[scols.START_TIME]);

  return {
    success: true,
    compatible: isSlotPairCompatible_(d1DT, d2DT),
    currentDay2: {
      slotID: currentDay2ID,
      date: formatDateForDisplay_(currentDay2.values[scols.DATE], lang),
      startTime: formatTimeForDisplay_(currentDay2.values[scols.START_TIME], lang),
      endTime: formatTimeForDisplay_(currentDay2.values[scols.END_TIME], lang)
    }
  };
}

function getSlotsFromToday_(sheetName) {
  var rows = getDataRows_(sheetName);
  var cols = CONFIG.SLOT_COLS;
  var out = [];
  var isDay1 = (sheetName === CONFIG.SHEETS.DAY1);
  var isDay2 = (sheetName === CONFIG.SHEETS.DAY2);
  var isMri = (sheetName === CONFIG.SHEETS.MRI);

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[cols.SLOT_ID]) continue;
    if (!isOnOrAfterToday_(row[cols.DATE])) continue;

    var startDT = combineDateAndTime_(row[cols.DATE], row[cols.START_TIME]);
    var endDT = combineDateAndTime_(row[cols.DATE], row[cols.END_TIME]);

    var entry = {
      slotID: String(row[cols.SLOT_ID]),
      date: formatDateForDisplay_(row[cols.DATE], 'en'),
      startTime: formatTimeForDisplay_(row[cols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(row[cols.END_TIME], 'en'),
      booked: isBooked_(row[cols.BOOKED]),
      // Raw fields for client-side math (overlap / compatibility checks).
      rawDate: toIsoDateStr_(row[cols.DATE]),
      rawStart: toHmStr_(row[cols.START_TIME]),
      rawEnd: toHmStr_(row[cols.END_TIME]),
      startMs: startDT.getTime(),
      endMs: endDT.getTime(),
      sortKey: startDT.getTime()
    };

    if (isDay1) {
      entry.mriSlotID = String(row[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
      entry.assignedStaff = String(row[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
      entry.assignedStaffName = entry.assignedStaff ? getStaffNameByEmail_(entry.assignedStaff) : '';
      entry.creatorName = creatorDisplayName_(row[CONFIG.DAY1_EXTRA_COLS.CREATED_BY]);
      entry.language = normalizeSlotLanguage_(row[CONFIG.DAY1_EXTRA_COLS.LANGUAGE]);
    }
    if (isDay2) {
      entry.assignedStaff = String(row[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
      entry.assignedStaffName = entry.assignedStaff ? getStaffNameByEmail_(entry.assignedStaff) : '';
      entry.creatorName = creatorDisplayName_(row[CONFIG.DAY2_EXTRA_COLS.CREATED_BY]);
      entry.language = normalizeSlotLanguage_(row[CONFIG.DAY2_EXTRA_COLS.LANGUAGE]);
    }
    if (isMri) {
      entry.day1Staff = String(row[CONFIG.MRI_EXTRA_COLS.DAY1_STAFF] || '');
      entry.day2Staff = String(row[CONFIG.MRI_EXTRA_COLS.DAY2_STAFF] || '');
      entry.day1StaffName = entry.day1Staff ? getStaffNameByEmail_(entry.day1Staff) : '';
      entry.day2StaffName = entry.day2Staff ? getStaffNameByEmail_(entry.day2Staff) : '';
      entry.createdBy = creatorDisplayName_(row[CONFIG.MRI_EXTRA_COLS.CREATED_BY]);
      // Duration is derived rather than stored, so it can never drift out of
      // sync with the start/end times actually on the row.
      entry.durationMinutes = Math.round((endDT.getTime() - startDT.getTime()) / 60000);
    }

    out.push(entry);
  }

  out.sort(function (a, b) { return a.sortKey - b.sortKey; });
  out.forEach(function (o) { delete o.sortKey; });
  return out;
}

/**
 * ----------------------------------------------------------------------------
 * SLOT CREATION (admin-only — this is the only way new SlotIDs are issued)
 * ----------------------------------------------------------------------------
 */

/**
 * Parses an HTML <input type="date"> value ("YYYY-MM-DD") into a Date.
 * @param {string} dateStr
 * @return {?Date} null if invalid
 */
function parseDateInput_(dateStr) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  var d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parses an HTML <input type="time"> value ("HH:MM") into a Date carrying
 * just that time-of-day (arbitrary date component).
 * @param {string} timeStr
 * @return {?Date} null if invalid
 */
function parseTimeInput_(timeStr) {
  if (!timeStr || !/^\d{2}:\d{2}$/.test(timeStr)) return null;
  var parts = timeStr.split(':');
  var hours = parseInt(parts[0], 10);
  var minutes = parseInt(parts[1], 10);
  if (hours > 23 || minutes > 59) return null;
  return new Date(1970, 0, 1, hours, minutes, 0);
}

/** Formats a sheet "Date" cell as "YYYY-MM-DD" for the client. */
function toIsoDateStr_(value) {
  var d = (Object.prototype.toString.call(value) === '[object Date]') ? value : new Date(String(value));
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** Formats a sheet "Time" cell as "HH:MM" for the client. */
function toHmStr_(value) {
  var d = (Object.prototype.toString.call(value) === '[object Date]') ? value : null;
  if (!d) return '';
  return pad2_(d.getHours()) + ':' + pad2_(d.getMinutes());
}

/**
 * Adds `minutes` to an HTML <input type="time"> "HH:MM" string and returns
 * the result as "HH:MM". Used to derive End Time from Start Time + Duration
 * on both the client (live preview) and server (authoritative). If the
 * duration pushes past midnight, the time wraps (callers should treat that
 * as a same-day slot only — cross-midnight experiments aren't supported by
 * this single-Date-column schema).
 * @param {string} startTimeStr - "HH:MM"
 * @param {number} durationMinutes
 * @return {?string} "HH:MM", or null if the input is invalid
 */
function addMinutesToTimeStr_(startTimeStr, durationMinutes) {
  var start = parseTimeInput_(startTimeStr);
  if (!start || !durationMinutes || durationMinutes <= 0) return null;
  var totalMinutes = (start.getHours() * 60 + start.getMinutes() + Math.round(durationMinutes)) % (24 * 60);
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  return pad2_(hours) + ':' + pad2_(minutes);
}

/**
 * Validates a raw {date, startTime, durationMinutes} object from the admin
 * form and, if valid, returns the derived {date, start, end} Date triplet.
 * @param {Object} data
 * @return {{error: ?string, date: ?Date, start: ?Date, end: ?Date, endTimeStr: ?string}}
 */
function validateSlotInputWithDuration_(data) {
  if (!data) return { error: 'Missing slot data.' };
  var date = parseDateInput_(data.date);
  if (!date) return { error: 'Please provide a valid date.' };
  var start = parseTimeInput_(data.startTime);
  if (!start) return { error: 'Please provide a valid start time.' };
  var duration = parseInt(data.durationMinutes, 10);
  if (!duration || duration <= 0) return { error: 'Please provide a duration greater than 0 minutes.' };
  if (duration > 20 * 60) return { error: 'Duration seems too long (over 20 hours) — please double-check.' };

  var endTimeStr = addMinutesToTimeStr_(data.startTime, duration);
  var end = parseTimeInput_(endTimeStr);
  if (!end || end.getTime() <= start.getTime()) {
    return { error: 'That duration crosses midnight, which this schedule does not support — please shorten it or split it into two slots.' };
  }
  return { error: null, date: date, start: start, end: end, endTimeStr: endTimeStr };
}

/**
 * Generates the next sequential SlotID for a sheet, e.g. "D1-004". Scans
 * existing IDs matching the prefix so it never collides, regardless of
 * manually-entered legacy IDs.
 * @param {string} sheetName
 * @param {string} prefix - e.g. 'D1' or 'D2'
 * @return {string}
 */
function generateNextSlotId_(sheetName, prefix) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var maxNum = 0;

  if (lastRow >= 2) {
    var ids = sheet.getRange(2, CONFIG.SLOT_COLS.SLOT_ID + 1, lastRow - 1, 1).getValues();
    var pattern = new RegExp('^' + prefix + '-(\\d+)$', 'i');
    for (var i = 0; i < ids.length; i++) {
      var idStr = String(ids[i][0] || '').trim();
      var m = idStr.match(pattern);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    }
  }

  var next = maxNum + 1;
  var padded = ('000' + next).slice(-3);
  return prefix + '-' + padded;
}

/**
 * ----------------------------------------------------------------------------
 * SLOT COLLISION DETECTION
 * ----------------------------------------------------------------------------
 * A slot "collides" with an existing slot in the SAME sheet (Day1Slots or
 * Day2Slots) if their [start, end) time ranges overlap on the same date.
 * This has nothing to do with Day1<->Day2 compatibility (which is the
 * separate 22-26h window rule) — it's purely "does this double-book the
 * room/participant's calendar against a slot that already exists".
 */

/**
 * ----------------------------------------------------------------------------
 * TIME-OVERLAP DETECTION
 * ----------------------------------------------------------------------------
 * Two ranges overlap iff [a,b) intersects [c,d) — i.e. a<d && c<b.
 *
 * IMPORTANT: overlap rules differ by slot type, deliberately:
 *
 *   MRI vs MRI          -> BLOCKING. The scanner can only run one session
 *                          at a time, so a new MRI slot may never overlap
 *                          an existing one.
 *   MRI vs Day1/Day2    -> WARNING ONLY. An MRI slot is allowed to sit on
 *                          top of existing experiment slots; the admin is
 *                          shown exactly which ones (with their assigned
 *                          staff) and can still create it. What IS blocked
 *                          later is assigning a staff member who is already
 *                          busy on one of those overlapping experiments —
 *                          see findStaffConflicts_().
 *   Day1/Day2 vs others -> BLOCKING when generating or creating experiment
 *                          slots, so participants are never offered a slot
 *                          that clashes with the scanner or another session.
 *
 * The one intentional asymmetry: creating an MRI slot tolerates experiment
 * overlaps, but generating Day 2 options excludes MRI overlaps. That is what
 * the specification calls for — MRI availability is the fixed constraint the
 * study works around, so it is entered first and experiments fit around it.
 */

/**
 * Generic overlap scan across the given sheets.
 * @param {Array<string>} sheetNames
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} startTimeStr - "HH:MM"
 * @param {number} durationMinutes
 * @param {?string} excludeSlotID
 * @param {boolean} returnAll - true to collect every match, false for first only
 * @return {Array<Object>} matches (possibly empty)
 */
function findOverlapsInSheets_(sheetNames, dateStr, startTimeStr, durationMinutes, excludeSlotID, returnAll) {
  var date = parseDateInput_(dateStr);
  var start = parseTimeInput_(startTimeStr);
  var duration = parseInt(durationMinutes, 10);
  if (!date || !start || !duration || duration <= 0) return [];

  var endTimeStr = addMinutesToTimeStr_(startTimeStr, duration);
  if (!endTimeStr) return [];

  var newStartMs = combineDateAndTime_(date, start).getTime();
  var newEndMs = combineDateAndTime_(date, parseTimeInput_(endTimeStr)).getTime();
  var cols = CONFIG.SLOT_COLS;
  var matches = [];

  for (var s = 0; s < sheetNames.length; s++) {
    var sheetName = sheetNames[s];
    var rows = getDataRows_(sheetName);
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var slotId = row[cols.SLOT_ID];
      if (!slotId) continue;
      if (excludeSlotID && String(slotId).trim() === String(excludeSlotID).trim()) continue;

      var existingStartMs = combineDateAndTime_(row[cols.DATE], row[cols.START_TIME]).getTime();
      var existingEndMs = combineDateAndTime_(row[cols.DATE], row[cols.END_TIME]).getTime();
      if (!(newStartMs < existingEndMs && existingStartMs < newEndMs)) continue;

      var staff = '';
      var taEmails = [];
      var dayLabel = '';
      if (sheetName === CONFIG.SHEETS.DAY1) {
        dayLabel = 'Day 1';
        staff = String(row[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
      } else if (sheetName === CONFIG.SHEETS.DAY2) {
        dayLabel = 'Day 2';
        staff = String(row[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
      } else if (sheetName === CONFIG.SHEETS.BLOOD_DRAWING) {
        dayLabel = 'Blood Drawing';
        staff = String(row[CONFIG.BLOOD_DRAWING_COLS.ASSIGNED_STAFF] || '');
        taEmails = parseTaEmails_(row[CONFIG.BLOOD_DRAWING_COLS.ASSIGNED_TA]);
      } else {
        dayLabel = 'MRI';
      }

      matches.push({
        slotID: String(slotId),
        sheet: sheetName,
        day: dayLabel,
        date: formatDateForDisplay_(row[cols.DATE], 'en'),
        startTime: formatTimeForDisplay_(row[cols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(row[cols.END_TIME], 'en'),
        assignedStaff: staff,
        // Round 11: names, not raw emails, are what should ever reach a
        // screen or an email — added here at the source (this is the one
        // shared function behind every overlap-warning list in the app) so
        // every caller gets it automatically instead of needing its own fix.
        assignedStaffName: staff ? (getStaffNameByEmail_(staff) || staff) : '',
        taEmails: taEmails,
        booked: isBooked_(row[cols.BOOKED])
      });

      if (!returnAll) return matches;
    }
  }
  return matches;
}

/**
 * BLOCKING check for MRI slot creation: does this candidate overlap another
 * MRI slot?
 * @return {?Object} the conflicting MRI slot, or null
 */
function findMriMriOverlap_(dateStr, startTimeStr, durationMinutes, excludeSlotID) {
  var m = findOverlapsInSheets_([CONFIG.SHEETS.MRI], dateStr, startTimeStr, durationMinutes, excludeSlotID, false);
  return m.length ? m[0] : null;
}

/**
 * WARNING-only check for MRI slot creation: which existing Day 1 / Day 2
 * experiment slots does this candidate sit on top of? Returns every match
 * (booked and unbooked) with its assigned staff, so the admin can be shown
 * the full picture.
 * @return {Array<Object>}
 */
function findExperimentOverlaps_(dateStr, startTimeStr, durationMinutes, excludeSlotID) {
  return findOverlapsInSheets_(
    [CONFIG.SHEETS.DAY1, CONFIG.SHEETS.DAY2], dateStr, startTimeStr, durationMinutes, excludeSlotID, true
  );
}

// NOTE (round 5): findExperimentBlockingOverlap_ removed as dead code — its
// only callers were checkSlotOverlap (already migrated to
// validateSchedulingSlot_) and the now-removed findOverlappingSlot_.

/**
 * ============================================================================
 * UNIFIED SCHEDULING VALIDATION (2026-08 requirements pass, round 3, #3)
 * ============================================================================
 * This REPLACES all previous overlap rules (the round-1 "behavioural overlap
 * is OK if different staff" rule and the round-2 "pre-MRI window must not hit
 * another MRI slot" rule are both gone). The complete rule set is now:
 *
 *   1. MRI vs MRI        -> ERROR, always. Never allowed to overlap.
 *   2. Behaviour vs
 *      Behaviour         -> ERROR, always. Applies to available, booked, and
 *                           unbooked slots alike, regardless of staff.
 *                           "Behavioural" = Day 1 (whose stored start/end
 *                           already includes the 90-min pre-MRI period) and
 *                           Day 2.
 *   3. Behaviour vs MRI  -> WARNING only, never blocks... EXCEPT when the
 *                           same staff member is on both sides, which is an
 *                           ERROR requiring different staff.
 *
 * Both the individual and the bulk scheduling workflows call this single
 * function, so they cannot drift apart (spec round 3, #4).
 *
 * @param {Object} c
 * @param {string} c.dateStr           - "YYYY-MM-DD" of the candidate behavioural slot
 * @param {string} c.startTimeStr      - "HH:MM"
 * @param {number} c.durationMinutes
 * @param {string} c.staffEmail        - staff being assigned to the candidate
 * @param {?string} c.excludeSlotID    - candidate's own slot ID, if it already exists
 * @param {?string} c.excludeMriSlotID - the MRI slot this candidate belongs to (its own
 *                                       MRI is expected to overlap and is not reported)
 * @param {string} c.label             - e.g. 'Day 1' / 'Day 2', for messages
 * @return {{errors: Array<string>, warnings: Array<string>,
 *           behaviouralConflicts: Array<Object>, mriOverlaps: Array<Object>,
 *           staffConflict: boolean}}
 */
/**
 * Maps an overlap match's sheet to its scheduling-rules experiment type.
 * (Day 1's pre-MRI portion is validated separately as 'Day1BeforeMri'; a full
 * Day 1 row is type 'Day1'.)
 */
function slotSheetToType_(sheetName) {
  if (sheetName === CONFIG.SHEETS.DAY1) return 'Day1';
  if (sheetName === CONFIG.SHEETS.DAY2) return 'Day2';
  if (sheetName === CONFIG.SHEETS.BLOOD_DRAWING) return 'BloodDrawing';
  return 'MRI';
}

/**
 * ============================================================================
 * CENTRALIZED, CONFIG-DRIVEN SCHEDULING VALIDATOR (spec round 5, #1/#2)
 * ============================================================================
 * The ONE validator every scheduling workflow calls (individual Day 1/Day 2,
 * Build Schedule, Bulk Scheduling, schedule editing, Blood Drawing creation
 * and editing). It contains NO hardcoded overlap rules — it scans for time
 * overlaps against every slot type and asks the configurable Scheduling Rules
 * (getSchedulingRulesConfig_ / isOverlapAllowed_) whether each overlap is
 * permitted:
 *
 *   - overlap NOT allowed        -> ERROR (blocks creation), with the
 *                                   conflicting slot / type / period / staff.
 *   - overlap allowed, but the
 *     SAME staff member is on
 *     both sides                 -> ERROR (blocks), requires different staff.
 *   - overlap allowed, and (for
 *     Blood Drawing) one of the
 *     candidate TAs is already on
 *     an overlapping BD slot      -> ERROR (blocks), requires a different TA.
 *   - overlap allowed, no staff/
 *     TA conflict                -> WARNING only (does not block).
 *
 * @param {Object} c
 * @param {string} c.candidateType   - one of the scheduling types, e.g. 'Day1','Day2','BloodDrawing','MRI'
 * @param {string} c.dateStr         - "YYYY-MM-DD"
 * @param {string} c.startTimeStr    - "HH:MM"
 * @param {number} c.durationMinutes
 * @param {string} [c.staffEmail]    - staff being assigned to the candidate
 * @param {Array<string>} [c.taEmails] - TAs being assigned (Blood Drawing only)
 * @param {Object} [c.excludeSlotIDs]- { Day1:id, Day2:id, MRI:id, BloodDrawing:id } to exclude self
 * @param {string} [c.label]         - label for messages
 * @return {{errors, warnings, conflicts, staffConflict, taConflict}}
 */
function validateSchedulingSlot_(c) {
  var label = c.label || (c.candidateType + ' slot');
  var candidateStaff = String(c.staffEmail || '').trim().toLowerCase();
  var candidateTAs = (c.taEmails || []).map(function (e) { return String(e || '').trim().toLowerCase(); }).filter(Boolean);
  var excl = c.excludeSlotIDs || {};
  var errors = [];
  var warnings = [];
  var conflicts = [];
  var staffConflict = false;
  var taConflict = false;

  var sheetsToScan = [CONFIG.SHEETS.MRI, CONFIG.SHEETS.DAY1, CONFIG.SHEETS.DAY2, CONFIG.SHEETS.BLOOD_DRAWING];

  sheetsToScan.forEach(function (sheetName) {
    var otherType = slotSheetToType_(sheetName);
    var excludeId = excl[otherType] || null;
    var overlaps = findOverlapsInSheets_([sheetName], c.dateStr, c.startTimeStr, c.durationMinutes, excludeId, true);

    overlaps.forEach(function (o) {
      conflicts.push(o);
      var allowed = isOverlapAllowed_(c.candidateType, otherType);
      var otherStaff = String(o.assignedStaff || '').trim().toLowerCase();
      var otherStaffName = o.assignedStaff ? getStaffNameByEmail_(o.assignedStaff) : '(unassigned)';
      // For MRI conflicts the "staff" is the MRI slot's Day1/Day2 staff pair.
      var otherStaffEmails = (otherType === 'MRI') ? getMriSlotStaffEmails_(o.slotID).map(function (e) { return e.toLowerCase(); })
                                                   : (otherStaff ? [otherStaff] : []);
      var where = o.day + ' slot ' + o.slotID + ' (' + o.date + ' ' + o.startTime + '\u2013' + o.endTime + ')';

      if (!allowed) {
        errors.push(
          label + ' overlaps ' + where + ' \u2014 assigned staff: ' + otherStaffName +
          '. Overlap between ' + c.candidateType + ' and ' + otherType +
          ' is not permitted by the Scheduling Rules; please choose a different time.'
        );
        return;
      }

      // Overlap permitted -> check for a same-staff hard conflict.
      var sameStaff = candidateStaff && otherStaffEmails.indexOf(candidateStaff) !== -1;
      // For Blood Drawing candidates, also check the candidate TAs against the
      // other slot's TAs (only meaningful when the other slot is BD).
      var sharedTA = '';
      if (candidateTAs.length && o.taEmails && o.taEmails.length) {
        var otherTAs = o.taEmails.map(function (e) { return e.toLowerCase(); });
        for (var t = 0; t < candidateTAs.length; t++) {
          if (otherTAs.indexOf(candidateTAs[t]) !== -1) { sharedTA = candidateTAs[t]; break; }
        }
      }

      if (sameStaff) {
        staffConflict = true;
        errors.push(
          label + '\u2019s assigned staff member (' + (getStaffNameByEmail_(candidateStaff) || candidateStaff) +
          ') is already assigned to overlapping ' + where + '. Please assign a different staff member.'
        );
      }
      if (sharedTA) {
        taConflict = true;
        errors.push(
          label + '\u2019s Technical Assistant (' + (getStaffNameByEmail_(sharedTA) || sharedTA) +
          ') is already assigned to overlapping ' + where + '. Please assign a different Technical Assistant.'
        );
      }
      if (!sameStaff && !sharedTA) {
        var taNote = (o.taEmails && o.taEmails.length)
          ? ' \u2014 TA(s): ' + o.taEmails.map(function (e) { return getStaffNameByEmail_(e); }).join(', ') : '';
        warnings.push(
          where + ' overlaps ' + label + ' \u2014 type: ' + otherType + ', staff: ' + otherStaffName + taNote +
          '. This overlap is permitted; scheduling is not blocked.'
        );
      }
    });
  });

  return {
    errors: errors,
    warnings: warnings,
    conflicts: conflicts,
    staffConflict: staffConflict,
    taConflict: taConflict
  };
}

/**
 * Back-compat shim: existing behavioural call-sites pass {dateStr, startTimeStr,
 * durationMinutes, staffEmail, excludeSlotID, excludeMriSlotID, label}. This
 * adapts them to the new validateSchedulingSlot_ with candidateType 'Day1'/'Day2'
 * (defaulting to a behavioural type), returning the legacy field names too.
 */
function validateBehaviouralSlot_(c) {
  var candidateType = c.candidateType || (String(c.label || '').indexOf('Day 2') !== -1 ? 'Day2' : 'Day1');
  var result = validateSchedulingSlot_({
    candidateType: candidateType,
    dateStr: c.dateStr,
    startTimeStr: c.startTimeStr,
    durationMinutes: c.durationMinutes,
    staffEmail: c.staffEmail,
    excludeSlotIDs: {
      Day1: candidateType === 'Day1' ? (c.excludeSlotID || null) : (c.excludeDay1SlotID || null),
      Day2: candidateType === 'Day2' ? (c.excludeSlotID || null) : (c.excludeDay2SlotID || null),
      MRI: c.excludeMriSlotID || null,
      BloodDrawing: c.excludeBloodDrawingSlotID || null
    },
    label: c.label
  });
  // Preserve the old return shape used by callers.
  result.behaviouralConflicts = result.conflicts.filter(function (o) {
    return o.day === 'Day 1' || o.day === 'Day 2';
  });
  result.mriOverlaps = result.conflicts.filter(function (o) { return o.day === 'MRI'; });
  return result;
}

/**
 * Same-schedule exclusions for a Day 1 slot: never treat its linked MRI or
 * Blood Drawing slot as a conflict against itself (they belong together).
 */
function sameScheduleExclusionsForDay1_(day1SlotID) {
  var excl = { Day1: day1SlotID || null, Day2: null, MRI: null, BloodDrawing: null };
  if (!day1SlotID) return excl;
  var d1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (d1) {
    var mriId = String(d1.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
    if (mriId) excl.MRI = mriId;
  }
  var bd = findBloodDrawingRowByDay1SlotID_(day1SlotID);
  if (bd) excl.BloodDrawing = String(bd.values[CONFIG.BLOOD_DRAWING_COLS.SLOT_ID]);
  return excl;
}

/** Returns the Day 1 + Day 2 staff emails recorded on an MRI slot (deduplicated, blanks dropped). */
function getMriSlotStaffEmails_(mriSlotID) {
  var rec = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
  if (!rec) return [];
  return buildDedupedGuestList_([
    String(rec.values[CONFIG.MRI_EXTRA_COLS.DAY1_STAFF] || ''),
    String(rec.values[CONFIG.MRI_EXTRA_COLS.DAY2_STAFF] || '')
  ]);
}

/** Formats a list of overlap-conflict objects into human-readable lines. */
function describeBehaviouralOverlaps_(conflicts) {
  return (conflicts || []).map(function (c) {
    return c.day + ' slot ' + c.slotID + ' — Assigned staff: ' +
      (c.assignedStaff ? getStaffNameByEmail_(c.assignedStaff) : '(unassigned)') +
      ' — Time overlap: ' + c.date + ' ' + c.startTime + '–' + c.endTime;
  });
}

// NOTE (round 5): findOverlappingSlot_, findMriOverlapsForExperiment_,
// findStaffBusyConflicts_, and describeStaffBusyConflict_ removed as dead
// code — their only caller was the orphaned legacy addDay1SlotWithDay2_
// (itself unreachable from any client, superseded long ago by the MRI-driven
// Build Schedule workflow / createScheduleFromMriInternal_), which has also
// been removed.


// NOTE (round 5): findStaffConflicts_ / describeStaffConflicts_ (used only by
// the now-removed checkStaffAvailability) have been removed as dead code.

/**
 * Client-callable real-time check used by the Bulk Scheduling modal's
 * per-row validation as the admin types (debounced). Round 5 fix: now
 * routes through the SAME validateSchedulingSlot_ engine as saving does
 * (bulkCreateMriSlots), instead of the old hardcoded
 * findMriMriOverlap_/findExperimentOverlaps_, so this live preview can
 * never disagree with what Save will actually do, and it now also
 * respects the Scheduling Rules for MRI×MRI (previously always hardcoded to
 * block) and scans Blood Drawing too (previously not scanned at all).
 * @param {string} token
 * @param {Object} data - {date, startTime, durationMinutes, excludeSlotID?}
 * @return {Object} {mriConflict: ?Object, experimentWarnings: Array, preWindowWarnings: Array}
 */
function previewMriSlot(token, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  data = data || {};
  var timeBeforeMriMinutes = parseInt(data.timeBeforeMriMinutes, 10) || CONFIG.DAY1_TIME_BEFORE_MRI_DEFAULT_MINUTES;

  var validation = validateSchedulingSlot_({
    candidateType: 'MRI',
    dateStr: data.date,
    startTimeStr: data.startTime,
    durationMinutes: data.durationMinutes,
    staffEmail: '',
    excludeSlotIDs: data.excludeSlotID ? { MRI: data.excludeSlotID } : {},
    label: 'This MRI slot'
  });

  // Preserve the old {mriConflict, experimentWarnings} shape: mriConflict is
  // the first not-permitted overlap (a real hard block); once there are no
  // errors, every remaining conflict is — by construction — a permitted
  // overlap, i.e. an informational warning.
  var mriConflict = null;
  if (validation.errors.length) {
    mriConflict = validation.conflicts.find(function (c) {
      return validation.errors.some(function (e) { return e.indexOf(c.slotID) !== -1; });
    }) || validation.conflicts[0] || null;
  }

  return {
    mriConflict: mriConflict,
    experimentWarnings: validation.errors.length ? [] : validation.conflicts,
    preWindowWarnings: findPreMriWindowOverlaps_(data.date, data.startTime, timeBeforeMriMinutes)
  };
}

/**
 * Client-callable real-time collision check for EXPERIMENT slots (Day 1 /
 * Day 2), used by the inline "new Day 2 slot" rows.
 * @param {string} token
 * @param {string} sheetKey - 'day1' | 'day2' | 'mri'
 * @param {Object} data - {date, startTime, durationMinutes, excludeSlotID?}
 * @return {Object} {overlaps: boolean, conflict?: Object}
 */
/**
 * Client-callable live-preview check used while an admin is filling in a new
 * MRI / Day 1 / Day 2 row (debounced, as they type). Round 5 fix: this used
 * to call separate hardcoded overlap helpers (findMriMriOverlap_,
 * findExperimentBlockingOverlap_, findMriOverlapsForExperiment_,
 * findStaffBusyConflicts_) that never consulted the Scheduling Rules config
 * — so a live preview could show "blocked" for an overlap the admin had
 * explicitly set to "Allowed", or vice versa. Now it delegates entirely to
 * validateSchedulingSlot_, the same validator Save uses, so the preview and
 * the actual save decision can never disagree.
 * @param {string} token
 * @param {string} sheetKey - 'mri' | 'day1' | 'day2'
 * @param {Object} data - {date, startTime, durationMinutes, staffEmail?, taEmails?, excludeSlotID?}
 */
function checkSlotOverlap(token, sheetKey, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  data = data || {};

  var candidateType = (sheetKey === 'mri') ? 'MRI' : (sheetKey === 'day1' ? 'Day1' : 'Day2');
  var excludeSlotIDs = {};
  if (data.excludeSlotID) excludeSlotIDs[candidateType] = data.excludeSlotID;

  var validation = validateSchedulingSlot_({
    candidateType: candidateType,
    dateStr: data.date,
    startTimeStr: data.startTime,
    durationMinutes: data.durationMinutes,
    staffEmail: data.staffEmail || '',
    taEmails: data.taEmails || [],
    excludeSlotIDs: excludeSlotIDs,
    label: 'This slot'
  });

  return {
    overlaps: validation.errors.length > 0,
    conflict: validation.conflicts[0] || null,
    errors: validation.errors,
    warnings: validation.warnings,
    staffConflict: validation.staffConflict,
    taConflict: validation.taConflict,
    // Legacy-shaped fields kept for any other callers.
    mriWarnings: validation.conflicts.filter(function (c) { return c.day === 'MRI'; }),
    staffConflicts: validation.staffConflict ? validation.errors : []
  };
}

// NOTE (round 5): addDay1SlotWithDay2_ removed as dead code — it had no
// callers anywhere (client or server); the live MRI-driven Build Schedule
// workflow (createScheduleFromMriInternal_) superseded it.


/**
 * ----------------------------------------------------------------------------
 * ADMIN CHANGE NOTIFICATION EMAILS
 * ----------------------------------------------------------------------------
 */

/**
 * Returns the email address of every ACTIVE admin (Main Admin included),
 * for broadcast notifications. Falls back to CONFIG.ADMIN_OWNER_EMAIL if
 * the Admins sheet is somehow empty, so notifications are never silently
 * lost.
 * @return {Array<string>}
 */
function getAllAdminEmails_() {
  var cols = CONFIG.ADMIN_COLS;
  var emails = [];
  getAllAdminRecords_().forEach(function (r) {
    if (!isBooked_(r.values[cols.ACTIVE])) return;
    var email = String(r.values[cols.EMAIL] || '').trim();
    if (email && emails.indexOf(email) === -1) emails.push(email);
  });
  if (emails.length === 0) emails.push(CONFIG.ADMIN_OWNER_EMAIL);
  return emails;
}

/**
 * Returns the email address of every ACTIVE admin EXCEPT whoever currently
 * holds the MainAdmin role — the complement of getMainAdminEmail_() within
 * getAllAdminEmails_(). Lets the 'MainAdmin' and 'OtherAdmins' recipient
 * groups be checked/unchecked independently in the Email Notification and
 * Calendar Invitation Settings matrices, instead of 'Admins' always
 * silently including the Main Admin too.
 * @return {Array<string>}
 */
function getOtherAdminEmails_() {
  var mainAdmin = getMainAdminEmail_().toLowerCase();
  return getAllAdminEmails_().filter(function (e) {
    return String(e || '').trim().toLowerCase() !== mainAdmin;
  });
}

/**
 * Emails a summary of a schedule/booking change to EVERY active admin
 * (Main Admin included). Sent as a single message with all admins on the
 * To: line. Never throws — a failed notification must never roll back or
 * block the underlying change, so failures are only logged.
 * @param {string} action - short heading, e.g. "Slots added", "Slot deleted"
 * @param {Array<string>} detailLines
 */
/**
 * Requirement #13: whenever a scheduled calendar event is actually deleted,
 * the Main Admin must be told — UNCONDITIONALLY, even if the Email Control
 * Matrix would otherwise route that action's own notification away from
 * them. Skips sending if the Main Admin is already among the recipients
 * about to receive (or that already received) the action's own matrix-
 * governed notification, so nobody gets a duplicate for the same event.
 * @param {string} summaryLine - one line describing what calendar event was removed
 * @param {Array<string>} actionRecipients - the recipients already resolved
 *   for this action's own notification (may be empty)
 */
function notifyMainAdminCalendarEventDeleted_(summaryLine, actionRecipients) {
  try {
    var mainAdminEmail = getMainAdminEmail_();
    if (!mainAdminEmail) return;
    var already = (actionRecipients || []).some(function (e) {
      return String(e || '').trim().toLowerCase() === mainAdminEmail.toLowerCase();
    });
    if (already) return;
    MailApp.sendEmail(
      mainAdminEmail,
      '[' + CONFIG.EXPERIMENT_NAME.en + '] Calendar Event Deleted',
      bilingualBody_(
        'Ein Kalendertermin wurde gelöscht.\n\n' + summaryLine,
        'A calendar event has been deleted.\n\n' + summaryLine
      )
    );
  } catch (err) {
    Logger.log('notifyMainAdminCalendarEventDeleted_ failed: ' + err);
  }
}

function notifyAdminOfChange_(action, detailLines, subjectKey, recipientContext) {
  try {
    var details = (detailLines || []).join('\n');

    // Round 6 fix: recipients now come from the Notification Settings
    // matrix whenever subjectKey matches a configured event (Schedule
    // Created/Updated/Deleted, MRI Slot Created, Booking Unbooked, etc.)
    // instead of always hardcoding "all admins" — this is what makes the
    // Main Admin's routing choices for those events actually take effect.
    // Calls with no subjectKey (pure admin-account audit notices — password
    // reset, account created/removed, role changed) keep going to all
    // admins, since those aren't part of the configurable event catalog.
    // recipientContext lets callers include AssignedStaff / BD staff / TAs
    // so matrix groups other than MainAdmin actually resolve.
    var isConfiguredEvent = subjectKey && CONFIG.NOTIFICATION_EVENTS.some(function (e) { return e.key === subjectKey; });
    var recipients = isConfiguredEvent
      ? resolveNotificationRecipients_(subjectKey, recipientContext || {})
      : getAllAdminEmails_();

    // Bug fix: an empty recipient list for a CONFIGURED event means the Main
    // Admin deliberately routed that event to nobody (e.g. unchecked every
    // group for "MRI Slot Created") — that must be honored, not overridden.
    // The Main-Admin fallback only applies to the unconfigured audit-notice
    // path, where an empty list would mean "Admins sheet is broken", not
    // "notifications disabled".
    if (!recipients.length) {
      if (isConfiguredEvent) return;
      recipients = [getMainAdminEmail_()];
    }

    // Round 10: render through the editable Email Templates catalog
    // whenever this event has a template (every configured event does, as
    // of round 10) — {{Details}} carries the event's detail lines, so the
    // Main Admin can customize the framing/wording without a code change.
    // Falls back to the old inline generic body only for the rare
    // uncatalogued case (subjectKey missing or has no template entry).
    if (subjectKey && getEmailTemplatesMap_()[subjectKey]) {
      var content = renderEmailTemplate_(subjectKey, { Details: details });
      MailApp.sendEmail(recipients.join(','), content.subject, content.body);
      return;
    }

    var de = action + ' im Zeitplan der Studie „' + CONFIG.EXPERIMENT_NAME.en + '".\n\n' + details;
    var en = action + ' in the ' + CONFIG.EXPERIMENT_NAME.en + ' schedule.\n\n' + details;
    MailApp.sendEmail(
      recipients.join(','),
      subjectKey ? emailSubject_(subjectKey) : ('[Schedule change] ' + action),
      bilingualBody_(de, en)
    );
  } catch (err) {
    Logger.log('notifyAdminOfChange_ failed: ' + err);
  }
}

/**
 * Notifies the UNIQUE set of {admins/staff routed by the matrix} that a
 * Day 1 or Day 2 slot (and anything cascade-deleted with it) was deleted.
 * Deduplicated case-insensitively, so a person who is both an admin and
 * assigned staff receives exactly one email.
 * @param {Array<string>} detailLines
 * @param {Array<string>} affectedStaffEmails
 * @param {string} [subjectKey] - 'day1SlotDeleted' | 'day2SlotDeleted' |
 *   'scheduleDeleted'. Defaults to 'scheduleDeleted' for callers that
 *   don't distinguish Day 1 from Day 2.
 */
function notifyScheduleDeleted_(detailLines, affectedStaffEmails, subjectKey) {
  subjectKey = subjectKey || 'scheduleDeleted';
  // Round 6 fix: this used to unconditionally email every admin + affected
  // staff for every deletion, completely bypassing the Notification
  // Settings matrix. The event now fully governs recipients, including
  // whether affected staff themselves are notified.
  var recipients = resolveNotificationRecipients_(subjectKey, { assignedStaff: affectedStaffEmails || [] });
  // Bug fix: an empty list here means the Main Admin deliberately routed
  // this event to nobody — respect that instead of force-mailing
  // the Main Admin anyway (see the matching fix in notifyAdminOfChange_).
  if (!recipients.length) return;

  try {
    var details = detailLines.join('\n');
    // Round 10: render through the editable Email Templates catalog.
    if (getEmailTemplatesMap_()[subjectKey]) {
      var content = renderEmailTemplate_(subjectKey, { Details: details });
      MailApp.sendEmail(recipients.join(','), content.subject, content.body);
      return;
    }
    var de = 'Ein Experiment-Zeitplan wurde gelöscht.\n\n' + details;
    var en = 'An experiment schedule has been deleted.\n\n' + details;
    MailApp.sendEmail(recipients.join(','), emailSubject_(subjectKey), bilingualBody_(de, en));
  } catch (err) {
    Logger.log('notifyScheduleDeleted_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * PARTICIPANT BOOKING CALENDAR
 * ----------------------------------------------------------------------------
 * Bookings are mirrored onto CONFIG.PARTICIPANT_CALENDAR_EMAIL as two events
 * (Day 1 and Day 2), each carrying the participant name, assigned staff and
 * booking status.
 *
 * SETUP REQUIRED: that calendar must be shared with the account this script
 * runs as, with "Make changes to events" permission. If it isn't, these
 * helpers log the failure and return quietly — a calendar problem must never
 * prevent a participant from booking.
 */

/** Resolves the participant-bookings calendar, or null if unavailable. */
function getParticipantCalendar_() {
  try {
    var cal = CalendarApp.getCalendarById(CONFIG.PARTICIPANT_CALENDAR_EMAIL);
    if (!cal) {
      Logger.log('Participant calendar not found/shared: ' + CONFIG.PARTICIPANT_CALENDAR_EMAIL);
    }
    return cal || null;
  } catch (err) {
    Logger.log('getParticipantCalendar_ failed: ' + err);
    return null;
  }
}

/**
 * Removes any existing participant events for these slots, then (unless
 * status is 'Cancelled') creates fresh ones. Events are located by a marker
 * containing the slot ID placed in the event description, so they can be
 * found again on reschedule/cancel/unbook without storing extra IDs.
 */
function upsertParticipantCalendarEvents_(day1SlotID, day2SlotID, participantName, participantEmail,
                                          day1Start, day1End, day2Start, day2End,
                                          day1Staff, day2Staff, status, participantTitle) {
  var cal = getParticipantCalendar_();
  if (!cal) return;

  deleteParticipantCalendarEvents_(day1SlotID, day2SlotID, day1Start, day2Start);
  if (status === 'Cancelled') return;

  var lastName = lastNameOf_(participantName);
  var titlePrefix = participantTitle ? String(participantTitle) + ' ' : '';

  var pairs = [
    { label: 'Day 1', slotID: day1SlotID, start: day1Start, end: day1End, staff: day1Staff },
    { label: 'Day 2', slotID: day2SlotID, start: day2Start, end: day2End, staff: day2Staff }
  ];

  pairs.forEach(function (p) {
    if (!p.slotID || !p.start || !p.end) return;
    try {
      var staffName = getStaffNameByEmail_(p.staff) || '(unassigned)';
      // Booked-slot calendar title, per spec section 8:
      //   Day 1
      //   Participant: <Title> <Last Name>
      //   Staff: <Assigned Staff Name>
      var title = p.label + '\n' +
        'Participant: ' + titlePrefix + lastName + '\n' +
        'Staff: ' + staffName;
      var event = cal.createEvent(
        title,
        p.start, p.end,
        {
          description:
            'Participant: ' + titlePrefix + participantName + '\n' +
            'Staff: ' + staffName + '\n' +
            'Booking status: ' + status + '\n' +
            'Location: ' + CONFIG.LOCATION.address + '\n' +
            PARTICIPANT_EVENT_MARKER_ + p.slotID
        }
      );
      applyStaffColor_(event, p.staff);
    } catch (err) {
      Logger.log('upsertParticipantCalendarEvents_ (' + p.label + ') failed: ' + err);
    }
  });
}

/** Marker written into event descriptions so events can be found again. */
var PARTICIPANT_EVENT_MARKER_ = 'ExperimentSlotRef:';

/**
 * Deletes participant events for the given slot IDs. Searches a narrow date
 * window around each slot's start time to keep the query cheap.
 */
function deleteParticipantCalendarEvents_(day1SlotID, day2SlotID, day1Start, day2Start) {
  var cal = getParticipantCalendar_();
  if (!cal) return;

  [{ id: day1SlotID, at: day1Start }, { id: day2SlotID, at: day2Start }].forEach(function (p) {
    if (!p.id || !p.at) return;
    try {
      var from = new Date(p.at.getTime() - 24 * 60 * 60 * 1000);
      var to = new Date(p.at.getTime() + 24 * 60 * 60 * 1000);
      cal.getEvents(from, to).forEach(function (ev) {
        var desc = '';
        try { desc = ev.getDescription() || ''; } catch (e) { desc = ''; }
        if (desc.indexOf(PARTICIPANT_EVENT_MARKER_ + p.id) !== -1) {
          ev.deleteEvent();
        }
      });
    } catch (err) {
      Logger.log('deleteParticipantCalendarEvents_ failed for ' + p.id + ': ' + err);
    }
  });
}

/**
 * ----------------------------------------------------------------------------
 * OWNER CALENDAR EVENTS
 * ----------------------------------------------------------------------------
 * Every scheduled session is mirrored onto the SCRIPT OWNER'S default Google
 * Calendar, as a single central view of the whole study schedule.
 *
 * 2026-08 requirements pass (section 8): whether the assigned staff member
 * (or anyone else) is invited to the calendar event is governed entirely by
 * the Calendar Invitation Settings matrix (resolveCalendarInvitees_), same
 * as Blood Drawing. There is no unconditional invite any more — an activity
 * with no configured recipient groups creates the event with no guests at
 * all. Each staff member is also assigned a stable, unique calendar
 * schedule creation, participant bookings, Blood Drawing, rescheduling,
 * cancellations, and reassignments. Recipient lists are de-duplicated so
 * nobody who is simultaneously Main Admin/Admin/Assigned Staff/TA for the
 * same event receives more than one invitation (see
 * buildDedupedGuestList_()).
 *
 * Titles follow the spec's "Scheduled Slots" format:
 *   Day 1
 *   Staff: <Staff Name>
 * (or "Day 2" for a Day 2 slot.) The caller's original descriptive title
 * (which may include cross-referenced Day1/Day2 staff info for the owner's
 * benefit) is preserved in the event description instead.
 *
 * There is no Outlook synchronisation.
 *
 * Every call is wrapped in try/catch and never blocks the underlying
 * slot/schedule operation on failure.
 */

/**
 * Deletes a previously-created owner-calendar event (if any), then creates a
 * replacement, invites the assigned staff member, and applies their colour.
 * Returns the new event's ID (to store back on the slot row), or '' if
 * creation failed.
 * @param {string} descriptiveTitle - caller's original title string; must
 *   start with "Day 1" or "Day 2" so the correct spec-format label can be
 *   extracted. The full string is kept in the event description.
 * @param {Date} startDateTime
 * @param {Date} endDateTime
 * @param {string} staffEmail
 * @param {string} oldEventId
 * @param {string} activityKey - one of CONFIG.CALENDAR_ACTIVITIES' keys
 *   (e.g. 'day1ScheduleCreated', 'day2ScheduleCreated', 'staffReassignment'),
 *   used to resolve who actually gets invited via the Calendar Invitation
 *   Settings matrix (resolveCalendarInvitees_). The assigned staff member is
 *   NOT invited unconditionally any more — whether they're invited at all is
 *   entirely up to that activity's configured recipient groups, same as
 *   Blood Drawing already does.
 * @return {string}
 */
function upsertStaffCalendarEvent_(descriptiveTitle, startDateTime, endDateTime, staffEmail, oldEventId, activityKey) {
  try {
    var calendar = CalendarApp.getDefaultCalendar();
    if (oldEventId) {
      try {
        var oldEvent = calendar.getEventById(oldEventId);
        if (oldEvent) oldEvent.deleteEvent();
      } catch (delErr) {
        Logger.log('Could not delete old calendar event ' + oldEventId + ': ' + delErr);
      }
    }
    var dayLabelMatch = /^(Day 1|Day 2)/.exec(String(descriptiveTitle || ''));
    var dayLabel = dayLabelMatch ? dayLabelMatch[1] : String(descriptiveTitle || '').split(' ')[0];
    var staffName = getStaffNameByEmail_(staffEmail) || '(unassigned)';
    var title = dayLabel + '\nStaff: ' + staffName;

    var guests = activityKey
      ? resolveCalendarInvitees_(activityKey, { assignedStaff: [staffEmail] })
      : buildDedupedGuestList_([staffEmail]);
    var event = calendar.createEvent(title, startDateTime, endDateTime, {
      description: descriptiveTitle + '\n' +
        'Location: ' + CONFIG.LOCATION.address + '\n' +
        'Automatically created by the ' + CONFIG.EXPERIMENT_NAME.en + ' scheduling system.',
      guests: guests.join(','),
      sendInvites: guests.length > 0
    });
    applyStaffColor_(event, staffEmail);
    return event.getId();
  } catch (err) {
    Logger.log('upsertStaffCalendarEvent_ failed: ' + err);
    return '';
  }
}

/** Deletes an owner-calendar event by ID, if it exists. Never throws. */
function deleteStaffCalendarEvent_(eventId) {
  if (!eventId) return;
  try {
    var event = CalendarApp.getDefaultCalendar().getEventById(eventId);
    if (event) event.deleteEvent();
  } catch (err) {
    Logger.log('deleteStaffCalendarEvent_ failed: ' + err);
  }
}

/**
 * Creates (or refreshes) the owner-calendar event for an MRI slot. Unlike
 * Day 1/Day 2 slots, an MRI slot has no assigned staff at creation time, so
 * its invitees come only from the non-staff recipient groups (MainAdmin,
 * OtherAdmins, Admins, SlotCreator) per the Calendar Invitation Settings
 * matrix — governed by 'mriSlotCreated' (and, in future, 'mriSlotUpdated').
 * Returns the new event's ID, or '' if creation failed or nobody is
 * configured to be invited (an event with zero guests is still created for
 * the owner's own visibility; only the invite behaviour is conditional).
 * @param {string} activityKey - 'mriSlotCreated' or 'mriSlotUpdated'
 * @param {string} slotId
 * @param {Date} startDateTime
 * @param {Date} endDateTime
 * @param {string} creatorEmail
 * @param {string} oldEventId
 * @return {string}
 */
function upsertMriCalendarEvent_(activityKey, slotId, startDateTime, endDateTime, creatorEmail, oldEventId) {
  try {
    var calendar = CalendarApp.getDefaultCalendar();
    if (oldEventId) {
      try {
        var oldEvent = calendar.getEventById(oldEventId);
        if (oldEvent) oldEvent.deleteEvent();
      } catch (delErr) {
        Logger.log('Could not delete old MRI calendar event ' + oldEventId + ': ' + delErr);
      }
    }
    var guests = resolveCalendarInvitees_(activityKey, { slotCreator: creatorEmail });
    var event = calendar.createEvent('MRI\n' + slotId, startDateTime, endDateTime, {
      description: 'MRI slot ' + slotId + '\n' +
        'Location: ' + CONFIG.LOCATION.address + '\n' +
        'Automatically created by the ' + CONFIG.EXPERIMENT_NAME.en + ' scheduling system.',
      guests: guests.join(','),
      sendInvites: guests.length > 0
    });
    return event.getId();
  } catch (err) {
    Logger.log('upsertMriCalendarEvent_ failed: ' + err);
    return '';
  }
}

/**
 * De-duplicates a list of email addresses (case-insensitive), dropping
 * blanks. Used to build calendar guest lists and notification recipient
 * lists so a person who holds several roles (Main Admin + Assigned Staff,
 * etc.) is only ever invited/notified once.
 * @param {Array<string>} emails
 * @return {Array<string>}
 */
function buildDedupedGuestList_(emails) {
  var seen = {};
  var out = [];
  (emails || []).forEach(function (e) {
    var addr = String(e || '').trim();
    if (!addr) return;
    var key = addr.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(addr);
  });
  return out;
}

/**
 * Looks up a staff member's display name from their email via the same
 * roster used for the Assigned Staff dropdown (Admins ∪ Staff sheets).
 * @param {string} email
 * @return {string} '' if not found
 */
function getStaffNameByEmail_(email) {
  var target = String(email || '').trim().toLowerCase();
  if (!target) return '';
  var list = getApprovedStaffList_();
  for (var i = 0; i < list.length; i++) {
    if (list[i].email.toLowerCase() === target) {
      // Strip the "(Role)" suffix added for admins in the dropdown label.
      return list[i].name.replace(/\s*\([^)]*\)\s*$/, '');
    }
  }
  return email;
}

/**
 * Returns a stable Google Calendar colour ID for a staff member, assigning
 * a new one (cycling through CONFIG.CALENDAR_COLOR_CYCLE) and persisting it
 * to the StaffColors sheet the first time that staff member is seen. The
 * SAME colour is then reused for every event type involving that person
 * (spec section 8: "Calendar Colours").
 * @param {string} email
 * @return {string} a CalendarApp colour ID, or '' if email is blank
 */
function getStaffColorId_(email) {
  var target = String(email || '').trim().toLowerCase();
  if (!target) return '';
  var sheet = getSheet_(CONFIG.SHEETS.STAFF_COLORS);
  var cols = CONFIG.STAFF_COLOR_COLS;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][cols.EMAIL] || '').trim().toLowerCase() === target) {
        return String(values[i][cols.COLOR_ID] || '');
      }
    }
    var nextColor = CONFIG.CALENDAR_COLOR_CYCLE[values.length % CONFIG.CALENDAR_COLOR_CYCLE.length];
    sheet.appendRow([target, nextColor]);
    return nextColor;
  }
  var firstColor = CONFIG.CALENDAR_COLOR_CYCLE[0];
  sheet.appendRow([target, firstColor]);
  return firstColor;
}

/** Applies a staff member's stable colour to a just-created calendar event. Never throws. */
function applyStaffColor_(event, staffEmail) {
  if (!event || !staffEmail) return;
  try {
    var colorId = getStaffColorId_(staffEmail);
    if (colorId) event.setColor(colorId);
  } catch (err) {
    Logger.log('applyStaffColor_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * STAFF ASSIGNMENT NOTIFICATION EMAILS
 * ----------------------------------------------------------------------------
 * Sends ONE combined email if Day 1 and Day 2 share the same assigned
 * staff member, or up to two separate emails (each containing only that
 * person's own assignment) if they differ. Either argument may be null
 * (e.g. the independent Day 2 creation flow only has a Day 2 assignment).
 * @param {?{staffEmail: string, details: string}} day1Assignment
 * @param {?{staffEmail: string, details: string}} day2Assignment
 */
function sendStaffAssignmentEmails_(day1Assignment, day2Assignment) {
  try {
    var day1Email = day1Assignment && day1Assignment.staffEmail;
    var day2Email = day2Assignment && day2Assignment.staffEmail;
    var subjectBase = emailSubject_('staffAssignment');
    var loc = 'Location: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl;
    var ort = 'Ort: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl;

    // Round 6 fix: the Notification Settings matrix now governs the ENTIRE
    // recipient decision for 'staffAssignment' — including whether the
    // assigned person themselves is emailed. "Assigned Staff" is one of the
    // toggleable recipient groups in the matrix by design (per spec), so if
    // the Main Admin unchecks it, the assigned staff member does NOT get a
    // notice from here, even though they're the one being assigned. There
    // is no unconditional carve-out.
    var resolved = resolveNotificationRecipients_('staffAssignment', {
      assignedStaff: buildDedupedGuestList_([day1Email, day2Email])
    });
    var resolvedLower = resolved.map(function (e) { return String(e).toLowerCase(); });
    var day1Included = day1Email && resolvedLower.indexOf(day1Email.toLowerCase()) !== -1;
    var day2Included = day2Email && resolvedLower.indexOf(day2Email.toLowerCase()) !== -1;

    if (day1Included && day2Included && day1Email.toLowerCase() === day2Email.toLowerCase()) {
      MailApp.sendEmail(
        day1Email,
        subjectBase + ' (Day 1 & Day 2)',
        bilingualBody_(
          'Sie wurden beiden Teilen eines neuen Termins zugewiesen:\n\n' +
          'Tag 1: ' + day1Assignment.details + '\nTag 2: ' + day2Assignment.details + '\n\n' + ort,
          'You have been assigned to both parts of a new schedule:\n\n' +
          'Day 1: ' + day1Assignment.details + '\nDay 2: ' + day2Assignment.details + '\n\n' + loc
        )
      );
    } else {
      if (day1Included) {
        MailApp.sendEmail(
          day1Email,
          subjectBase + ' (Day 1)',
          bilingualBody_(
            'Sie wurden einer Tag-1-Sitzung zugewiesen:\n\n' + day1Assignment.details + '\n\n' + ort,
            'You have been assigned to a Day 1 session:\n\n' + day1Assignment.details + '\n\n' + loc
          )
        );
      }
      if (day2Included) {
        MailApp.sendEmail(
          day2Email,
          subjectBase + ' (Day 2)',
          bilingualBody_(
            'Sie wurden einer Tag-2-Sitzung zugewiesen:\n\n' + day2Assignment.details + '\n\n' + ort,
            'You have been assigned to a Day 2 session:\n\n' + day2Assignment.details + '\n\n' + loc
          )
        );
      }
    }

    // Every OTHER resolved recipient (Main Admin, Admins, etc. — anyone
    // who isn't day1Email/day2Email, who already got the personalized
    // notice above if included) gets the same information as a broadcast.
    var alreadyNotified = {};
    if (day1Included) alreadyNotified[day1Email.toLowerCase()] = true;
    if (day2Included) alreadyNotified[day2Email.toLowerCase()] = true;
    var broadcastRecipients = resolved.filter(function (e) { return !alreadyNotified[String(e).toLowerCase()]; });

    if (broadcastRecipients.length) {
      var summaryLines = [];
      if (day1Assignment) summaryLines.push('Day 1: ' + day1Assignment.details + ' (staff: ' + day1Email + ')');
      if (day2Assignment) summaryLines.push('Day 2: ' + day2Assignment.details + ' (staff: ' + day2Email + ')');
      MailApp.sendEmail(
        broadcastRecipients.join(','),
        subjectBase,
        bilingualBody_(
          'Personalzuweisung:\n\n' + summaryLines.join('\n'),
          'Staff assignment:\n\n' + summaryLines.join('\n')
        )
      );
    }
  } catch (err) {
    Logger.log('sendStaffAssignmentEmails_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * SLOT DELETION
 * ----------------------------------------------------------------------------
 */

/** Formats a session as the "CreatedBy" provenance string. */
function createdByLegacy_(session) {
  return session ? (session.name + ' <' + session.email + '>') : '';
}

/** Deletes the sheet row for a given slotID. Returns true if a row was removed. */
function deleteSlotRow_(sheetName, slotId, deletedBy, reason) {
  // Round 5, #5: soft delete — the row is preserved and marked Deleted.
  return softDeleteById_(sheetName, CONFIG.SLOT_COLS.SLOT_ID, slotId, deletedBy || 'system', reason || '');
}

/**
 * For an AVAILABLE (unbooked) Day 1 slot, finds every AVAILABLE Day 2 slot
 * that is compatible ONLY with this Day 1 slot — i.e. it would become
 * unreachable by any participant if this Day 1 slot were deleted. These are
 * the Day 2 slots the admin must be warned will also be deleted.
 * @param {string} day1SlotID
 * @return {Object} {error?, day1?, orphanedDay2?: Array}
 */
function getDay1DeletionImpact_(day1SlotID) {
  var cols = CONFIG.SLOT_COLS;
  var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (!day1Record) return { error: 'That Day 1 slot no longer exists.' };
  if (isBooked_(day1Record.values[cols.BOOKED])) {
    return { error: 'That Day 1 slot is booked — use the Unbook / Delete Completely options instead.' };
  }

  var day1DateTime = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]);

  // Every OTHER available Day 1 slot, for the "still reachable via another slot" check.
  var otherAvailableDay1DateTimes = [];
  var day1Rows = getDataRows_(CONFIG.SHEETS.DAY1);
  for (var i = 0; i < day1Rows.length; i++) {
    var r = day1Rows[i];
    if (!r[cols.SLOT_ID]) continue;
    if (String(r[cols.SLOT_ID]).trim() === String(day1SlotID).trim()) continue;
    if (isBooked_(r[cols.BOOKED])) continue;
    otherAvailableDay1DateTimes.push(combineDateAndTime_(r[cols.DATE], r[cols.START_TIME]));
  }

  var orphaned = [];
  var day2Rows = getDataRows_(CONFIG.SHEETS.DAY2);
  for (var j = 0; j < day2Rows.length; j++) {
    var d2 = day2Rows[j];
    if (!d2[cols.SLOT_ID]) continue;
    if (isBooked_(d2[cols.BOOKED])) continue; // booked Day2 slots aren't affected here

    var d2DateTime = combineDateAndTime_(d2[cols.DATE], d2[cols.START_TIME]);
    if (!isSlotPairCompatible_(day1DateTime, d2DateTime)) continue; // not linked to this Day1 slot at all

    var reachableElsewhere = otherAvailableDay1DateTimes.some(function (otherDT) {
      return isSlotPairCompatible_(otherDT, d2DateTime);
    });
    if (!reachableElsewhere) {
      orphaned.push({
        slotID: String(d2[cols.SLOT_ID]),
        date: formatDateForDisplay_(d2[cols.DATE], 'en'),
        startTime: formatTimeForDisplay_(d2[cols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(d2[cols.END_TIME], 'en')
      });
    }
  }

  // Round 11: also surface every OTHER kind of slot that gets cascade-
  // deleted along with this Day 1 slot, not just orphaned Day 2 slots —
  // specifically, its linked Blood Drawing slot(s), which are ALWAYS
  // removed when their Day 1 slot is deleted (see cleanUpLinkedBloodDrawingSlots_),
  // booked or not. Shown to the admin before they confirm, not just
  // discovered after the fact.
  var linkedBloodDrawing = [];
  var bdRows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  for (var k = 0; k < bdRows.length; k++) {
    var bd = bdRows[k];
    if (!bd[bdCols.SLOT_ID]) continue;
    if (String(bd[bdCols.DAY1_SLOT_ID] || '') !== String(day1SlotID)) continue;
    linkedBloodDrawing.push({
      slotID: String(bd[bdCols.SLOT_ID]),
      date: formatDateForDisplay_(bd[bdCols.DATE], 'en'),
      startTime: formatTimeForDisplay_(bd[bdCols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(bd[bdCols.END_TIME], 'en'),
      booked: isBooked_(bd[bdCols.BOOKED])
    });
  }

  return {
    error: null,
    day1: {
      slotID: day1SlotID,
      date: formatDateForDisplay_(day1Record.values[cols.DATE], 'en'),
      startTime: formatTimeForDisplay_(day1Record.values[cols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(day1Record.values[cols.END_TIME], 'en'),
      mriSlotID: String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '')
    },
    orphanedDay2: orphaned,
    linkedBloodDrawing: linkedBloodDrawing,
    // Selectable related slots for the deletion confirmation picker
    related: (function () {
      var list = [];
      orphaned.forEach(function (d2) {
        list.push({ kind: 'day2', slotID: d2.slotID, label: 'Day 2 ' + d2.slotID + ' (' + d2.date + ' ' + d2.startTime + ')', defaultChecked: true });
      });
      linkedBloodDrawing.forEach(function (bd) {
        list.push({
          kind: 'bloodDrawing',
          slotID: bd.slotID,
          label: 'Blood Drawing ' + bd.slotID + ' (' + bd.date + ' ' + bd.startTime + ')' + (bd.booked ? ' — booked' : ''),
          defaultChecked: false
        });
      });
      var mriId = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
      if (mriId) {
        list.push({ kind: 'mri', slotID: mriId, label: 'MRI ' + mriId + ' (delete; unchecked = return to Available)', defaultChecked: false });
      }
      return list;
    })()
  };
}

/**
 * Client-callable: previews (or, with confirmDeleteOrphans=true, performs)
 * deletion of an available Day 1 slot. Call once with confirmDeleteOrphans
 * omitted/false to get the impact preview; if orphanedDay2.length > 0, show
 * the admin a warning and call again with confirmDeleteOrphans=true once
 * they confirm.
 * @param {string} token
 * @param {string} day1SlotID
 * @param {boolean} confirmDeleteOrphans
 * @return {Object}
 */
/**
 * ----------------------------------------------------------------------------
 * EDITING SCHEDULED SLOTS (round 9)
 * ----------------------------------------------------------------------------
 * Lets an admin correct a Day 1 or Day 2 slot's date, start time, duration,
 * or Session Language after it was created — without deleting and
 * recreating it (which would generate a new Slot ID and lose history).
 *
 * Scoped to UNBOOKED slots only: once a participant has booked a slot, its
 * date/time is a commitment made to them, and changing it needs their
 * confirmation — that's what Reschedule (participant self-service or admin
 * reschedule-on-their-behalf) is for. Editing a booked slot's time here
 * would silently invalidate a participant's confirmation email without
 * telling them, so it's deliberately not allowed. Assigned staff CAN be
 * changed on a booked slot via Reassign Staff, which is unaffected by this.
 */

/**
 * Client-callable (manage_slots): edit an unbooked Day 1 slot's date,
 * start time, duration, and/or Session Language. Re-validates against the
 * same conflict rules as creating a new slot, moves its calendar event to
 * the new time, and notifies via the matrix-controlled 'day1SlotEdited'
 * event.
 * @param {string} token
 * @param {string} day1SlotID
 * @param {Object} data - {date, startTime, durationMinutes, language}
 * @return {Object}
 */
/**
 * Requirement #3: Day 1's TIME is deliberately NOT editable here — it is
 * derived from its linked MRI slot (Day 1 Start = MRI Start − Time Before
 * MRI; Day 1 End = MRI End), so changing it independently would desync it
 * from the MRI slot it belongs to. Only Session Language (and any other
 * non-time field that may be added later) is editable through Edit
 * Schedule; overlap/scheduling validation still runs for whatever DOES
 * change. To move a Day 1 slot's time, delete and recreate its schedule
 * from the MRI slot, or resize the MRI slot itself while pushing to
 * schedule (see createScheduleFromMriInternal_).
 */
function editDay1Slot(token, day1SlotID, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var cols = CONFIG.SLOT_COLS;
  var extra = CONFIG.DAY1_EXTRA_COLS;
  var record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (!record) return { success: false, message: 'That Day 1 slot no longer exists.' };
  if (isBooked_(record.values[cols.BOOKED])) {
    return { success: false, message: 'This slot is already booked. Use Reschedule (from Booking Management) to change a booked slot\u2019s time — editing here is only for unbooked slots.' };
  }

  var summary = day1SlotID + ' (' + formatDateForDisplay_(record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(record.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(record.values[cols.END_TIME], 'en') + ')';

  var oldLanguage = normalizeSlotLanguage_(record.values[extra.LANGUAGE]);
  var newLanguage = data && data.language !== undefined ? normalizeSlotLanguage_(data.language) : oldLanguage;

  // Overlap/scheduling validation still runs (spec #3) even though time
  // can't change here — this re-checks the slot's CURRENT time against the
  // rules in case the Scheduling Rules matrix itself changed since it was
  // created, so a save can't silently leave a now-invalid slot in place.
  var staffEmail = String(record.values[extra.ASSIGNED_STAFF] || '');
  var validation = validateSchedulingSlot_({
    candidateType: 'Day1',
    dateStr: toIsoDateStr_(record.values[cols.DATE]),
    startTimeStr: toHmStr_(record.values[cols.START_TIME]),
    durationMinutes: Math.round((combineDateAndTime_(record.values[cols.DATE], record.values[cols.END_TIME]).getTime() -
                                 combineDateAndTime_(record.values[cols.DATE], record.values[cols.START_TIME]).getTime()) / 60000),
    staffEmail: staffEmail,
    excludeSlotIDs: { Day1: day1SlotID },
    label: 'Day 1 slot ' + day1SlotID
  });
  if (validation.errors.length) {
    return { success: false, message: validation.errors[0], errors: validation.errors };
  }

  var changeLines = diffLines_([
    { label: 'Language', oldVal: slotLanguageLabel_(oldLanguage), newVal: slotLanguageLabel_(newLanguage) }
  ]);
  if (!changeLines.length) {
    return { success: true, message: 'No changes to save.' };
  }

  record.sheet.getRange(record.rowIndex, extra.LANGUAGE + 1).setValue(newLanguage);

  // Requirement #8: the email must contain exactly what changed.
  notifyAdminOfChange_(
    'Day 1 slot edited',
    ['Day 1 slot ' + day1SlotID + ' updated', ''].concat(changeLines).concat(['', summary, 'Edited by: ' + session.name]),
    'day1SlotEdited'
  );

  return { success: true, message: 'Day 1 slot ' + day1SlotID + ' updated.' };
}

/**
 * Client-callable (manage_slots): edit an unbooked Day 2 slot's date, start
 * time, duration, and/or Session Language. Same scope and behaviour as
 * editDay1Slot — see that function's doc comment.
 * @param {string} token
 * @param {string} day2SlotID
 * @param {Object} data - {date, startTime, durationMinutes, language}
 * @return {Object}
 */
function editDay2Slot(token, day2SlotID, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var cols = CONFIG.SLOT_COLS;
  var extra = CONFIG.DAY2_EXTRA_COLS;
  var record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
  if (!record) return { success: false, message: 'That Day 2 slot no longer exists.' };
  if (isBooked_(record.values[cols.BOOKED])) {
    return { success: false, message: 'This slot is already booked. Use Reschedule (from Booking Management) to change a booked slot\u2019s time — editing here is only for unbooked slots.' };
  }

  var parsed = validateSlotInputWithDuration_(data);
  if (parsed.error) return { success: false, message: parsed.error };

  var oldTimeStr = formatDateForDisplay_(record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(record.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(record.values[cols.END_TIME], 'en');
  var oldLanguage = normalizeSlotLanguage_(record.values[extra.LANGUAGE]);
  var newLanguage = data && data.language !== undefined ? normalizeSlotLanguage_(data.language) : oldLanguage;

  var staffEmail = String(record.values[extra.ASSIGNED_STAFF] || '');
  var validation = validateSchedulingSlot_({
    candidateType: 'Day2',
    dateStr: toIsoDateStr_(parsed.date),
    startTimeStr: toHmStr_(parsed.start),
    durationMinutes: Math.round((parsed.end.getTime() - parsed.start.getTime()) / 60000) || parseInt(data.durationMinutes, 10),
    staffEmail: staffEmail,
    excludeSlotIDs: { Day2: day2SlotID },
    label: 'Day 2 slot ' + day2SlotID
  });
  if (validation.errors.length) {
    return { success: false, message: validation.errors[0], errors: validation.errors };
  }

  var newTimeStr = formatDateForDisplay_(parsed.date, 'en') + ' ' + formatTimeForDisplay_(parsed.start, 'en') + '\u2013' + formatTimeForDisplay_(parsed.end, 'en');
  var changeLines = diffLines_([
    { label: 'Time', oldVal: oldTimeStr, newVal: newTimeStr },
    { label: 'Language', oldVal: slotLanguageLabel_(oldLanguage), newVal: slotLanguageLabel_(newLanguage) }
  ]);
  if (!changeLines.length) {
    return { success: true, message: 'No changes to save.' };
  }

  record.sheet.getRange(record.rowIndex, cols.DATE + 1).setValue(parsed.date);
  record.sheet.getRange(record.rowIndex, cols.START_TIME + 1).setValue(parsed.start);
  record.sheet.getRange(record.rowIndex, cols.END_TIME + 1).setValue(parsed.end);
  record.sheet.getRange(record.rowIndex, extra.LANGUAGE + 1).setValue(newLanguage);

  var oldEventId = String(record.values[extra.CALENDAR_EVENT_ID] || '');
  var startDT = combineDateAndTime_(parsed.date, parsed.start);
  var endDT = combineDateAndTime_(parsed.date, parsed.end);
  if (staffEmail) {
    var newEventId = upsertStaffCalendarEvent_(
      'Day 2 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + day2SlotID + ')', startDT, endDT, staffEmail, oldEventId, 'day2ScheduleCreated'
    );
    record.sheet.getRange(record.rowIndex, extra.CALENDAR_EVENT_ID + 1).setValue(newEventId);
  }

  // Requirement #8: the email must contain exactly what changed.
  notifyAdminOfChange_(
    'Day 2 slot edited',
    ['Day 2 slot ' + day2SlotID + ' updated', ''].concat(changeLines).concat(['', 'Edited by: ' + session.name]),
    'day2SlotEdited'
  );

  return { success: true, message: 'Day 2 slot ' + day2SlotID + ' updated.' };
}

function deleteDay1Slot(token, day1SlotID, confirmDeleteOrphans, selectedRelated) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var impact = getDay1DeletionImpact_(day1SlotID);
  if (impact.error) {
    return { success: false, message: impact.error };
  }

  // Always show a related-slot picker when there is anything related
  // (orphaned Day 2, linked BD, or MRI) — BD is NOT auto-deleted.
  var hasRelated = (impact.related && impact.related.length > 0);
  if (hasRelated && !confirmDeleteOrphans) {
    return {
      success: false,
      requiresConfirmation: true,
      day1: impact.day1,
      orphanedDay2: impact.orphanedDay2,
      linkedBloodDrawing: impact.linkedBloodDrawing,
      related: impact.related,
      message: 'Select which related slots to also delete with Day 1 slot ' + day1SlotID +
        '. Unchecked Blood Drawing slots are kept (Day 1 link cleared). Unchecked MRI is returned to Available.'
    };
  }

  selectedRelated = selectedRelated || {};
  var selectedDay2 = {};
  var selectedBd = {};
  var deleteMri = !!selectedRelated.mri;
  (selectedRelated.day2Ids || []).forEach(function (id) { selectedDay2[String(id)] = true; });
  (selectedRelated.bloodDrawingIds || []).forEach(function (id) { selectedBd[String(id)] = true; });
  // If the admin confirmed without sending an explicit selection list (legacy
  // "Delete Anyway"), default: delete orphaned Day2, keep BD, release MRI.
  if (confirmDeleteOrphans && !selectedRelated.day2Ids && !selectedRelated.bloodDrawingIds && selectedRelated.mri == null) {
    impact.orphanedDay2.forEach(function (d2) { selectedDay2[d2.slotID] = true; });
    deleteMri = false;
  }

  var day1CalEventId = '';
  var affectedStaff = [];
  var day1FullRecord = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (day1FullRecord) {
    day1CalEventId = String(day1FullRecord.values[CONFIG.DAY1_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
    var d1Staff = String(day1FullRecord.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    if (d1Staff) affectedStaff.push(d1Staff);
  }
  impact.orphanedDay2.forEach(function (d2) {
    if (!selectedDay2[d2.slotID]) return;
    var rec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, d2.slotID);
    if (!rec) return;
    var s = String(rec.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
    if (s && affectedStaff.indexOf(s) === -1) affectedStaff.push(s);
  });

  var orphanCalEventIds = impact.orphanedDay2.map(function (d2) {
    var rec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, d2.slotID);
    return rec ? String(rec.values[CONFIG.DAY2_EXTRA_COLS.CALENDAR_EVENT_ID] || '') : '';
  });

  deleteSlotRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  deleteStaffCalendarEvent_(day1CalEventId);

  // Blood Drawing: delete only selected; otherwise detach Day 1 link.
  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  impact.linkedBloodDrawing.forEach(function (bd) {
    if (selectedBd[bd.slotID]) {
      cleanUpSpecificBloodDrawingSlot_(bd.slotID, day1SlotID);
    } else {
      var bdRec = findBloodDrawingRow_(bd.slotID);
      if (bdRec) {
        bdRec.sheet.getRange(bdRec.rowIndex, bdCols.DAY1_SLOT_ID + 1).setValue('');
      }
    }
  });

  var deletedDay2Ids = [];
  impact.orphanedDay2.forEach(function (d2, idx) {
    if (!selectedDay2[d2.slotID]) return;
    if (deleteSlotRow_(CONFIG.SHEETS.DAY2, d2.slotID)) {
      deletedDay2Ids.push(d2.slotID);
      deleteStaffCalendarEvent_(orphanCalEventIds[idx]);
    }
  });

  var mriNote = '(none)';
  if (impact.day1.mriSlotID) {
    if (deleteMri) {
      var mriRec = getSlotByFullRow_(CONFIG.SHEETS.MRI, impact.day1.mriSlotID);
      if (mriRec) {
        var mriCalId = String(mriRec.values[CONFIG.MRI_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
        deleteSlotRow_(CONFIG.SHEETS.MRI, impact.day1.mriSlotID);
        if (mriCalId) deleteStaffCalendarEvent_(mriCalId);
      }
      mriNote = impact.day1.mriSlotID + ' (deleted)';
    } else {
      var mriReleased = releaseLinkedMriSlot_(impact.day1.mriSlotID);
      mriNote = impact.day1.mriSlotID + (mriReleased ? ' (returned to Available)' : '');
    }
  }

  var day1DeletedNotifyRecipients = resolveNotificationRecipients_('day1SlotDeleted', { assignedStaff: affectedStaff });
  notifyScheduleDeleted_(
    [
      'Day 1 slot ' + day1SlotID + ' has been deleted.',
      '',
      'Day 2: ' + (deletedDay2Ids.length ? deletedDay2Ids.join(', ') : '(none affected)'),
      'MRI: ' + mriNote,
      'Deleted by: ' + session.name
    ],
    affectedStaff,
    'day1SlotDeleted'
  );
  if (day1CalEventId) notifyMainAdminCalendarEventDeleted_('Day 1 slot ' + day1SlotID, day1DeletedNotifyRecipients);

  return {
    success: true,
    message: 'Deleted Day 1 slot ' + day1SlotID +
      (deletedDay2Ids.length ? ' and ' + deletedDay2Ids.length + ' orphaned Day 2 slot(s).' : '.'),
    deletedDay1: day1SlotID,
    deletedDay2: deletedDay2Ids
  };
}

/**
 * Client-callable: deletes a single AVAILABLE (unbooked) Day 2 slot. Booked
 * Day 2 slots are managed only via their paired Day 1 slot's booking
 * (see handleBookedDay1Slot), since one booking always covers both.
 * @param {string} token
 * @param {string} day2SlotID
 * @return {Object}
 */
function deleteDay2Slot(token, day2SlotID, confirmCascade) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var cols = CONFIG.SLOT_COLS;
  var record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
  if (!record) return { success: false, message: 'That Day 2 slot no longer exists.' };
  if (isBooked_(record.values[cols.BOOKED])) {
    return { success: false, message: 'That Day 2 slot is booked — manage it via its paired Day 1 slot instead.' };
  }

  // Round 4, #4: check whether this is the ONLY compatible Day 2 slot for any
  // existing (available) Day 1 slot. If so, deleting it would leave that Day 1
  // slot with no bookable Day 2 option, so we cascade-delete the Day 1 slot
  // (and its linked Blood Drawing slot) — but only after the admin confirms.
  var impact = getDay2DeletionImpact_(day2SlotID);
  if (impact.affectedDay1.length > 0 && !confirmCascade) {
    return {
      success: false,
      requiresConfirmation: true,
      day2SlotID: day2SlotID,
      affectedDay1: impact.affectedDay1,
      message: 'Deleting Day 2 slot ' + day2SlotID + ' will also remove ' + impact.affectedDay1.length +
        ' Day 1 schedule(s) that would have no compatible Day 2 option left.'
    };
  }

  var summary = day2SlotID + ' (' + formatDateForDisplay_(record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(record.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(record.values[cols.END_TIME], 'en') + ')';
  var calEventId = String(record.values[CONFIG.DAY2_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
  var affectedStaff = [];
  var day2Staff = String(record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
  if (day2Staff) affectedStaff.push(day2Staff);

  // Cascade-delete the affected Day 1 slots (+ optional linked Blood Drawing
  // slots and calendar events) first. Always release linked MRI slots so they
  // return to Available when their Day 1 schedule is removed.
  var cascadedDay1 = [];
  impact.affectedDay1.forEach(function (d1) {
    var d1Rec = getSlotByFullRow_(CONFIG.SHEETS.DAY1, d1.slotID);
    if (!d1Rec) return;
    var d1CalEventId = String(d1Rec.values[CONFIG.DAY1_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
    var d1Staff = String(d1Rec.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    if (d1Staff && affectedStaff.indexOf(d1Staff) === -1) affectedStaff.push(d1Staff);
    var mriId = String(d1Rec.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
    deleteSlotRow_(CONFIG.SHEETS.DAY1, d1.slotID);
    deleteStaffCalendarEvent_(d1CalEventId);
    // Detach BD by default on Day2 cascade (do not auto-delete); clear Day1 link.
    var bd = findBloodDrawingRowByDay1SlotID_(d1.slotID);
    if (bd) {
      bd.sheet.getRange(bd.rowIndex, CONFIG.BLOOD_DRAWING_COLS.DAY1_SLOT_ID + 1).setValue('');
    }
    releaseLinkedMriSlot_(mriId);
    cascadedDay1.push(d1.slotID);
  });

  deleteSlotRow_(CONFIG.SHEETS.DAY2, day2SlotID);
  deleteStaffCalendarEvent_(calEventId);

  var detailLines = ['Day 2 slot ' + day2SlotID + ' has been deleted.', '', 'Day 1: ' + (cascadedDay1.length ? cascadedDay1.join(', ') : '(none affected)')];
  detailLines.push('Deleted by: ' + session.name);
  // Round 7 fix: this used to always route through 'scheduleDeleted' via
  // notifyAdminOfChange_, with no affected-staff context at all — so the
  // staff member(s) who lost their assignment were never told. Now uses
  // the dedicated 'day2SlotDeleted' event and includes them as context.
  var day2DeletedNotifyRecipients = resolveNotificationRecipients_('day2SlotDeleted', { assignedStaff: affectedStaff });
  notifyScheduleDeleted_(detailLines, affectedStaff, 'day2SlotDeleted');
  if (calEventId) notifyMainAdminCalendarEventDeleted_('Day 2 slot ' + day2SlotID, day2DeletedNotifyRecipients);

  return {
    success: true,
    message: 'Deleted Day 2 slot ' + day2SlotID +
      (cascadedDay1.length ? ' and ' + cascadedDay1.length + ' dependent Day 1 slot(s).' : '.'),
    deletedDay2: day2SlotID,
    cascadedDay1: cascadedDay1
  };
}

/**
 * For a Day 2 slot being considered for deletion, finds every available
 * Day 1 slot whose ONLY compatible available Day 2 slot is this one (i.e.
 * deleting it would strand that Day 1 slot). Returns the affected Day 1
 * slots along with their linked MRI slots (spec round 4, #4).
 * @param {string} day2SlotID
 * @return {{affectedDay1: Array<{slotID, date, startTime, mriSlotID}>}}
 */
function getDay2DeletionImpact_(day2SlotID) {
  var cols = CONFIG.SLOT_COLS;
  var targetRec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
  if (!targetRec) return { affectedDay1: [] };
  var targetDT = combineDateAndTime_(targetRec.values[cols.DATE], targetRec.values[cols.START_TIME]);

  // All OTHER available Day 2 slots' start times (the ones that would remain).
  var remainingDay2DateTimes = [];
  getDataRows_(CONFIG.SHEETS.DAY2).forEach(function (d2) {
    if (!d2[cols.SLOT_ID]) return;
    if (String(d2[cols.SLOT_ID]).trim() === String(day2SlotID).trim()) return;
    if (isBooked_(d2[cols.BOOKED])) return;
    remainingDay2DateTimes.push(combineDateAndTime_(d2[cols.DATE], d2[cols.START_TIME]));
  });

  var affectedDay1 = [];
  getDataRows_(CONFIG.SHEETS.DAY1).forEach(function (d1) {
    if (!d1[cols.SLOT_ID]) return;
    if (isBooked_(d1[cols.BOOKED])) return; // booked Day1 slots already have a paired Day2
    var d1DT = combineDateAndTime_(d1[cols.DATE], d1[cols.START_TIME]);
    // Is the target Day 2 compatible with this Day 1 at all?
    if (!isSlotPairCompatible_(d1DT, targetDT)) return;
    // Would any OTHER remaining Day 2 slot still be compatible?
    var stillReachable = remainingDay2DateTimes.some(function (otherDT) {
      return isSlotPairCompatible_(d1DT, otherDT);
    });
    if (!stillReachable) {
      affectedDay1.push({
        slotID: String(d1[cols.SLOT_ID]),
        date: formatDateForDisplay_(d1[cols.DATE], 'en'),
        startTime: formatTimeForDisplay_(d1[cols.START_TIME], 'en'),
        mriSlotID: String(d1[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '')
      });
    }
  });

  return { affectedDay1: affectedDay1 };
}

/**
 * Finds the Bookings sheet row(s) referencing a given Day 1 SlotID.
 * @param {string} day1SlotID
 * @return {Array<{rowIndex: number, values: Array}>}
 */
function findBookingsByDay1Slot_(day1SlotID) {
  var sheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  // Must read the FULL booking row width — confirmation number is column index 6
  // (previously capped at 6 columns → Booking ID always blank in unbook emails).
  var width = CONFIG.BOOKING_ROW_WIDTH;
  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var col = CONFIG.BOOKING_COLS.DAY1_SLOT_ID;
  var matches = [];
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][col]).trim() === String(day1SlotID).trim()) {
      matches.push({ rowIndex: i + 2, values: values[i] });
    }
  }
  return matches;
}

/**
 * Client-callable: handles a BOOKED Day 1 slot per the admin's choice.
 *   action = 'unbook'  -> clears the booking, returns both the Day 1 and
 *                         paired Day 2 slot to "Available", removes the
 *                         Bookings row. The slots remain in the schedule
 *                         for a future participant to book.
 *   action = 'delete'  -> permanently deletes the Day 1 slot, its paired
 *                         Day 2 slot, AND the Bookings row.
 * @param {string} token
 * @param {string} day1SlotID
 * @param {string} action - 'unbook' | 'delete'
 * @return {Object}
 */
/**
 * Preview related slots that would be affected by Unbook / Delete Completely
 * on a booked Day 1 slot — used by the admin confirmation picker.
 */
function getBookedDay1ActionPreview(token, day1SlotID) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var cols = CONFIG.SLOT_COLS;
  var bcols = CONFIG.BOOKING_COLS;
  var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (!day1Record) return { success: false, message: 'That Day 1 slot no longer exists.' };
  if (!isBooked_(day1Record.values[cols.BOOKED])) {
    return { success: false, message: 'That Day 1 slot is not booked.' };
  }

  var bookings = findBookingsByDay1Slot_(day1SlotID);
  var booking = bookings[0];
  var bookingID = booking ? String(booking.values[bcols.CONFIRMATION_NUMBER] || '') : '';
  var participantName = booking ? String(booking.values[bcols.NAME] || '') : '';
  var day2SlotID = booking ? String(booking.values[bcols.DAY2_SLOT_ID] || '').trim() : '';
  var mriSlotID = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
  var staffEmail = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');

  var related = [];
  related.push({
    kind: 'day1',
    slotID: day1SlotID,
    label: 'Day 1 ' + day1SlotID + ' (' + formatDateNumeric_(day1Record.values[cols.DATE]) + ' ' +
      formatTimeForDisplay_(day1Record.values[cols.START_TIME], 'en') + ')',
    required: true,
    defaultChecked: true
  });
  if (day2SlotID) {
    var d2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
    related.push({
      kind: 'day2',
      slotID: day2SlotID,
      label: 'Day 2 ' + day2SlotID + (d2 ? (' (' + formatDateNumeric_(d2.values[cols.DATE]) + ' ' +
        formatTimeForDisplay_(d2.values[cols.START_TIME], 'en') + ')') : ''),
      required: false,
      defaultChecked: true
    });
  }
  var bd = findBloodDrawingRowByDay1SlotID_(day1SlotID);
  if (bd) {
    var bdCols = CONFIG.BLOOD_DRAWING_COLS;
    related.push({
      kind: 'bloodDrawing',
      slotID: String(bd.values[bdCols.SLOT_ID]),
      label: 'Blood Drawing ' + bd.values[bdCols.SLOT_ID] + ' (' +
        formatDateNumeric_(bd.values[bdCols.DATE]) + ' ' +
        formatTimeForDisplay_(bd.values[bdCols.START_TIME], 'en') + ')',
      required: false,
      defaultChecked: true
    });
  }
  if (mriSlotID) {
    related.push({
      kind: 'mri',
      slotID: mriSlotID,
      label: 'MRI ' + mriSlotID + ' (delete completely only — unbook leaves MRI as-is)',
      required: false,
      defaultChecked: false,
      deleteOnly: true
    });
  }

  return {
    success: true,
    day1SlotID: day1SlotID,
    bookingID: bookingID,
    participantName: participantName,
    assignedStaff: staffEmail,
    related: related
  };
}

function handleBookedDay1Slot(token, day1SlotID, action, options) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  if (action !== 'unbook' && action !== 'delete') {
    return { success: false, message: 'Unknown action.' };
  }
  options = options || {};
  // selectedKinds: which related slot kinds to also clear/delete
  // e.g. { day2: true, bloodDrawing: true, mri: false }
  var selected = options.selectedKinds || { day2: true, bloodDrawing: true, mri: false };

  var cols = CONFIG.SLOT_COLS;
  var bcols = CONFIG.BOOKING_COLS;
  var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (!day1Record) return { success: false, message: 'That Day 1 slot no longer exists.' };
  if (!isBooked_(day1Record.values[cols.BOOKED])) {
    return { success: false, message: 'That Day 1 slot is not booked — use the standard delete option instead.' };
  }

  var bookings = findBookingsByDay1Slot_(day1SlotID);
  if (!bookings.length) {
    return { success: false, message: 'Slot is marked booked but no matching booking record was found. Please check the Bookings sheet manually.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var booking = bookings[0];
    var day2SlotID = String(booking.values[bcols.DAY2_SLOT_ID] || '').trim();
    var participantName = booking.values[bcols.NAME];
    var participantEmail = booking.values[bcols.EMAIL];
    var bookingID = String(booking.values[bcols.CONFIRMATION_NUMBER] || '');
    var mriSlotIDForSummary = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
    var day1Staff = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    var day2Staff = '';
    if (day2SlotID) {
      var d2StaffRec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
      if (d2StaffRec) day2Staff = String(d2StaffRec.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
    }
    var bdRec = findBloodDrawingRowByDay1SlotID_(day1SlotID);
    var bdStaff = '';
    var bdTAs = [];
    if (bdRec) {
      bdStaff = String(bdRec.values[CONFIG.BLOOD_DRAWING_COLS.ASSIGNED_STAFF] || '');
      bdTAs = parseTaEmails_(bdRec.values[CONFIG.BLOOD_DRAWING_COLS.ASSIGNED_TA]);
    }
    var assignedStaffEmails = [];
    if (day1Staff) assignedStaffEmails.push(day1Staff);
    if (day2Staff && assignedStaffEmails.indexOf(day2Staff) === -1) assignedStaffEmails.push(day2Staff);

    // Avoid Outlook auto-hyperlinking "Booking ID" — use "Confirmation number".
    var summaryLines = [
      'Confirmation number: ' + (bookingID || '(none)'),
      'Day 1 slot: ' + day1SlotID,
      'Day 2 slot: ' + (day2SlotID || '(not found)'),
      'MRI slot: ' + (mriSlotIDForSummary || '(none)'),
      'Participant: ' + participantName,
      'Actioned by: ' + session.name
    ];

    var d1StartForCal = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]);
    var d2StartForCal = null;
    if (day2SlotID) {
      var d2CalRec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
      if (d2CalRec) {
        d2StartForCal = combineDateAndTime_(d2CalRec.values[cols.DATE], d2CalRec.values[cols.START_TIME]);
      }
    }
    deleteParticipantCalendarEvents_(day1SlotID, day2SlotID, d1StartForCal, d2StartForCal);

    if (action === 'delete') {
      bookings.forEach(function (b) {
        softDeleteRowIndex_(CONFIG.SHEETS.BOOKINGS, b.rowIndex, session.email, 'Booking deleted');
      });
    } else {
      bookings.forEach(function (b) {
        getSheet_(CONFIG.SHEETS.BOOKINGS).getRange(b.rowIndex, CONFIG.BOOKING_COLS.STATUS + 1).setValue('Cancelled');
      });
    }

    if (action === 'unbook') {
      day1Record.sheet.getRange(day1Record.rowIndex, cols.BOOKED + 1).setValue(false);
      if (day2SlotID && selected.day2 !== false) {
        var day2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
        if (day2Record) {
          day2Record.sheet.getRange(day2Record.rowIndex, cols.BOOKED + 1).setValue(false);
        }
      }
      if (selected.bloodDrawing !== false) {
        unlinkBloodDrawingFromBooking_(day1SlotID);
      }

      var unbookOpeningLine = 'Confirmation number ' + (bookingID || '(none)') + ' has been removed from the schedule.';
      notifyAdminOfChange_(
        'Booking removed (slots returned to Available)',
        [unbookOpeningLine, ''].concat(summaryLines),
        'adminBookingUnbooked',
        {
          assignedStaff: assignedStaffEmails,
          bloodDrawingStaff: bdStaff ? [bdStaff] : [],
          technicalAssistants: bdTAs,
          participants: participantEmail ? [String(participantEmail)] : []
        }
      );
      return {
        success: true,
        message: 'Booking removed. Day 1 slot ' + day1SlotID +
          (day2SlotID && selected.day2 !== false ? ' and Day 2 slot ' + day2SlotID : '') +
          ' are available again.'
      };
    }

    // action === 'delete': remove the slots entirely (honour selected related kinds).
    if (selected.bloodDrawing !== false) {
      unlinkBloodDrawingFromBooking_(day1SlotID, { suppressNotification: true });
      cleanUpLinkedBloodDrawingSlots_(day1SlotID);
    } else if (bdRec) {
      // Detach without deleting: clear Day 1 link + booking fields.
      unlinkBloodDrawingFromBooking_(day1SlotID, { suppressNotification: true });
      bdRec.sheet.getRange(bdRec.rowIndex, CONFIG.BLOOD_DRAWING_COLS.DAY1_SLOT_ID + 1).setValue('');
    }
    var mriSlotID = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
    var day1CalEventId = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
    var day2CalEventId = '';
    if (day2SlotID) {
      var day2ForCal = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
      if (day2ForCal) day2CalEventId = String(day2ForCal.values[CONFIG.DAY2_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
    }
    deleteSlotRow_(CONFIG.SHEETS.DAY1, day1SlotID);
    deleteStaffCalendarEvent_(day1CalEventId);
    if (day2SlotID && selected.day2 !== false) {
      deleteSlotRow_(CONFIG.SHEETS.DAY2, day2SlotID);
      deleteStaffCalendarEvent_(day2CalEventId);
    }
    if (mriSlotID && selected.mri === true) {
      var mriRec = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
      if (mriRec) {
        var mriCalId = String(mriRec.values[CONFIG.MRI_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
        deleteSlotRow_(CONFIG.SHEETS.MRI, mriSlotID);
        if (mriCalId) deleteStaffCalendarEvent_(mriCalId);
      }
      summaryLines.push('Linked MRI slot ' + mriSlotID + ' deleted.');
    } else {
      var mriReleased = releaseLinkedMriSlot_(mriSlotID);
      if (mriReleased) summaryLines.push('Linked MRI slot ' + mriSlotID + ' returned to Available.');
    }
    var deleteOpeningLine = 'Confirmation number ' + (bookingID || '(none)') + ' and its slots have been permanently deleted.';
    var scheduleDeletedRecipients = resolveNotificationRecipients_('scheduleDeleted', {
      assignedStaff: assignedStaffEmails,
      bloodDrawingStaff: bdStaff ? [bdStaff] : [],
      technicalAssistants: bdTAs
    });
    notifyAdminOfChange_(
      'Booking and slots permanently deleted',
      [deleteOpeningLine, ''].concat(summaryLines),
      'scheduleDeleted',
      {
        assignedStaff: assignedStaffEmails,
        bloodDrawingStaff: bdStaff ? [bdStaff] : [],
        technicalAssistants: bdTAs
      }
    );
    if (day1CalEventId || day2CalEventId) {
      notifyMainAdminCalendarEventDeleted_('Day 1 slot ' + day1SlotID + (day2SlotID ? ' / Day 2 slot ' + day2SlotID : ''), scheduleDeletedRecipients);
    }
    return {
      success: true,
      message: 'Permanently deleted Day 1 slot ' + day1SlotID + (day2SlotID && selected.day2 !== false ? ', Day 2 slot ' + day2SlotID : '') + ', and the booking record.'
    };

  } finally {
    lock.releaseLock();
  }
}

/**
 * ============================================================================
 *  PHASE 2: MRI-BASED SCHEDULING
 * ============================================================================
 *  Replaces manual Day 1 date/time entry with a derivation from a chosen
 *  MRI slot (fixed 90 minutes) plus an admin-editable "Time Before MRI"
 *  offset. Day 2 slots are selected from the existing available bank
 *  (matched by the same 22-26h compatibility rule as always) rather than
 *  necessarily created fresh each time — though creating a fresh one inline
 *  is still supported for when the bank doesn't have enough coverage.
 *
 *  NOTE ON "STAFF" VS "ADMINS": the Staff sheet (who can be ASSIGNED to
 *  slots) is intentionally separate from the Admins sheet (who can LOG IN
 *  to the admin portal — see the multi-role admin accounts section below).
 *  A person can be in one, both, or neither — e.g. a researcher who runs
 *  sessions but never logs into the portal, or a coordinator who manages
 *  the schedule but is never personally assigned to a slot.
 * ============================================================================
 */

/**
 * Returns everyone who can be ASSIGNED to a slot: every active admin from
 * the Admins sheet (including the Main Admin), merged with any extra people
 * listed in the Staff sheet.
 *
 * Admins come first and win on duplicates, so a person who is both an admin
 * and a Staff row appears once, labelled with their admin role. The Staff
 * sheet remains useful for people who run sessions but never log into the
 * portal (e.g. student assistants).
 *
 * Matching is case-insensitive on email.
 * @return {Array<{name: string, email: string, isAdmin: boolean}>}
 */
function getApprovedStaffList_() {
  var out = [];
  var seen = {};

  // 1. Active admins (Admins sheet), EXCEPT Technical Assistants — round 4,
  //    #5: TAs may only be assigned to Blood Drawing slots, never to Day 1 or
  //    Day 2 behavioural experiments, so they never appear in this roster
  //    (which feeds every Day 1/Day 2 Assigned Staff dropdown).
  var acols = CONFIG.ADMIN_COLS;
  getAllAdminRecords_().forEach(function (r) {
    if (!isBooked_(r.values[acols.ACTIVE])) return; // inactive/unapproved admins aren't assignable
    if (String(r.values[acols.ROLE]) === 'TA') return; // TAs are Blood-Drawing-only
    var email = String(r.values[acols.EMAIL] || '').trim();
    if (!email) return;
    var key = email.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      name: String(r.values[acols.NAME] || email),
      email: email,
      role: String(r.values[acols.ROLE] || ''),
      isAdmin: true
    });
  });

  // 2. Extra non-admin staff (Staff sheet).
  var sheet = getSheet_(CONFIG.SHEETS.STAFF);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    var scols = CONFIG.STAFF_COLS;
    for (var i = 0; i < values.length; i++) {
      var name = String(values[i][scols.NAME] || '').trim();
      var semail = String(values[i][scols.EMAIL] || '').trim();
      if (!name && !semail) continue;
      if (!semail) continue;
      var skey = semail.toLowerCase();
      if (seen[skey]) continue;
      seen[skey] = true;
      out.push({ name: name || semail, email: semail, isAdmin: false });
    }
  }

  return out;
}

/** Client-callable: staff options for the Assigned Staff dropdown. */
function getStaffOptions(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');
  return getApprovedStaffList_();
}

/**
 * ----------------------------------------------------------------------------
 * MRI SLOTS
 * ----------------------------------------------------------------------------
 */

/** Client-callable: every AVAILABLE (unbooked) MRI slot from today onward. */
function getAvailableMriSlots(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');
  return getSlotsFromToday_(CONFIG.SHEETS.MRI).filter(function (s) { return !s.booked; });
}

/**
 * Client-callable: adds a new MRI slot.
 *
 * Duration defaults to CONFIG.MRI_DURATION_MINUTES but is editable per slot.
 *
 * Validation follows the two-tier rule (see the TIME-OVERLAP DETECTION
 * section): overlapping ANOTHER MRI SLOT is blocking, while overlapping
 * existing Day 1 / Day 2 experiment slots is permitted and only produces a
 * warning listing each conflicting experiment with its assigned staff.
 *
 * The client shows those warnings and re-submits with acknowledgeWarnings
 * = true to confirm.
 *
 * @param {string} token
 * @param {Object} data - {date, startTime, durationMinutes?, acknowledgeWarnings?}
 * @return {Object}
 */
/**
 * Computes NON-BLOCKING warnings for the "pre-MRI window" — the time
 * required before an MRI slot (MRI Start − Time Required Before MRI ->
 * MRI Start) overlapping existing Day 1/Day 2 experiments. Used by both
 * the live preview (previewMriSlot) and the actual save (bulkCreateMriSlots).
 * @param {string} mriDateStr - "YYYY-MM-DD"
 * @param {string} mriStartStr - "HH:MM"
 * @param {number} timeBeforeMriMinutes
 * @return {Array<Object>} conflicting experiment slots, empty if none
 */
function findPreMriWindowOverlaps_(mriDateStr, mriStartStr, timeBeforeMriMinutes) {
  var offset = parseInt(timeBeforeMriMinutes, 10);
  if (!offset || offset <= 0) return [];
  var mriStartDT = combineDateAndTime_(parseDateInput_(mriDateStr), parseTimeInput_(mriStartStr));
  if (!mriStartDT) return [];

  var preWindowStartDT = new Date(mriStartDT.getTime() - offset * 60000);
  var preDateStr = toIsoDateStr_(preWindowStartDT);
  var preStartStr = toHmStr_(preWindowStartDT);
  if (!preDateStr || !preStartStr) return [];

  return findExperimentOverlaps_(preDateStr, preStartStr, offset, null);
}

/**
 * Round 10: single-slot MRI creation (addMriSlot) has been removed per
 * explicit request — MRI slots are now created only via Bulk Scheduling
 * (bulkCreateMriSlots below), so every MRI slot goes through the exact
 * same validation path regardless of how many are being created at once,
 * and creating just one is simply "Bulk Scheduling with one row."
 */

/**
 * Client-callable: deletes an MRI slot that hasn't been used in a schedule
 * yet. Used MRI slots are released automatically when their linked Day 1
 * slot is deleted (see releaseLinkedMriSlot_) rather than deleted directly.
 * @param {string} token
 * @param {string} mriSlotID
 * @return {Object}
 */
function deleteMriSlot(token, mriSlotID) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  var cols = CONFIG.SLOT_COLS;
  var record = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
  if (!record) return { success: false, message: 'That MRI slot no longer exists.' };
  if (isBooked_(record.values[cols.BOOKED])) {
    return { success: false, message: 'That MRI slot is already used in a schedule. Delete the linked Day 1 slot instead — this will release it automatically.' };
  }

  var mriCalEventId = String(record.values[CONFIG.MRI_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
  var summary = mriSlotID + ' (' + formatDateForDisplay_(record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(record.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(record.values[cols.END_TIME], 'en') + ')';

  var mainAdminRecipients = resolveNotificationRecipients_('mriSlotDeleted', {});
  deleteStaffCalendarEvent_(mriCalEventId);
  notifyMainAdminCalendarEventDeleted_('MRI slot ' + summary, mainAdminRecipients);

  // Requirement #1: since a Blood Drawing slot is now auto-created at
  // MRI-creation time, deleting an unused MRI slot must also remove its
  // (still unbooked) linked Blood Drawing slot rather than leaving an
  // orphan behind.
  var linkedBd = findBloodDrawingRowByMriSlotID_(mriSlotID);
  if (linkedBd) {
    var bdCols = CONFIG.BLOOD_DRAWING_COLS;
    if (!isBooked_(linkedBd.values[bdCols.BOOKED])) {
      var bdEventId = String(linkedBd.values[bdCols.CALENDAR_EVENT_ID] || '');
      if (bdEventId) deleteBloodDrawingCalendarEvent_(bdEventId);
      deleteSlotRow_(CONFIG.SHEETS.BLOOD_DRAWING, String(linkedBd.values[bdCols.SLOT_ID]), session.email, 'Linked MRI slot deleted');
    }
  }

  deleteSlotRow_(CONFIG.SHEETS.MRI, mriSlotID);
  notifyAdminOfChange_(
    'MRI slot deleted',
    ['MRI slot ' + mriSlotID + ' has been deleted.', 'Date/Time: ' + formatDateForDisplay_(record.values[cols.DATE], 'en') + ' ' +
      formatTimeForDisplay_(record.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(record.values[cols.END_TIME], 'en'),
      'Deleted by: ' + session.name],
    'mriSlotDeleted'
  );
  return { success: true, message: 'Deleted MRI slot ' + mriSlotID + '.' };
}

/**
 * Returns an MRI slot back to "Available" and clears its assigned staff.
 * Called whenever the Day 1 slot derived from it is permanently deleted.
 * Safe to call with a blank/missing ID (does nothing, returns false) so
 * callers don't need to special-case legacy Day 1 slots with no MRI link.
 * @param {string} mriSlotID
 * @return {boolean} true if a slot was actually released
 */
function releaseLinkedMriSlot_(mriSlotID) {
  if (!mriSlotID) return false;
  var record = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
  if (!record) return false;
  record.sheet.getRange(record.rowIndex, CONFIG.SLOT_COLS.BOOKED + 1).setValue(false);
  record.sheet.getRange(record.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY1_STAFF + 1).setValue('');
  record.sheet.getRange(record.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY2_STAFF + 1).setValue('');
  return true;
}

/**
 * ----------------------------------------------------------------------------
 * DATE/TIME SHIFTING (handles day rollover, unlike addMinutesToTimeStr_)
 * ----------------------------------------------------------------------------
 */

/**
 * Shifts a "YYYY-MM-DD" + "HH:MM" pair by +/- minutesOffset, using real Date
 * arithmetic so it correctly rolls over to the previous/next calendar day
 * when needed (e.g. an MRI slot at 00:30 minus a 90-minute "Time Before
 * MRI" offset correctly lands at 23:00 the PREVIOUS day).
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {string} timeStr - "HH:MM"
 * @param {number} minutesOffset - may be negative
 * @return {?{dateStr: string, timeStr: string}}
 */
function shiftDateAndTime_(dateStr, timeStr, minutesOffset) {
  var date = parseDateInput_(dateStr);
  var time = parseTimeInput_(timeStr);
  if (!date || !time) return null;

  var d = new Date(date.getFullYear(), date.getMonth(), date.getDate(), time.getHours(), time.getMinutes(), 0);
  d.setMinutes(d.getMinutes() + Math.round(minutesOffset));

  return {
    dateStr: d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate()),
    timeStr: pad2_(d.getHours()) + ':' + pad2_(d.getMinutes())
  };
}

/**
 * Derives a Day 1 {date, startTime, endTime} from an MRI slot's own
 * date/start-time, a "Time Before MRI" offset, and an (editable) MRI
 * duration:
 *   Day1 Start = MRI Start - Time Before MRI
 *   MRI End    = MRI Start + MRI Duration   (the duration may differ from
 *                the MRI slot's currently-stored duration — the admin can
 *                adjust it here, and the MRISlots row is updated to match
 *                at save time)
 *   Day1 End   = MRI End
 * Always computed server-side from the MRI slot's actual stored
 * date/start-time — never trusts client-supplied Day 1 date/time directly.
 * Day 1 is required to stay within a single calendar date (consistent with
 * how duration-crossing-midnight is handled everywhere else in this app);
 * if the Time-Before-MRI offset would push Day 1 Start onto an earlier
 * calendar date than MRI End falls on, that's rejected as unsupported.
 * @param {string} mriSlotID
 * @param {number} timeBeforeMriMinutes
 * @param {number} mriDurationMinutes
 * @return {Object} {error?, mri?, mriEndChanged?, day1Date?, day1StartTime?, day1EndTime?}
 */
function computeDay1FromMri_(mriSlotID, timeBeforeMriMinutes, mriDurationMinutes) {
  var cols = CONFIG.SLOT_COLS;
  var mriRecord = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
  if (!mriRecord) return { error: 'That MRI slot no longer exists.' };
  if (isBooked_(mriRecord.values[cols.BOOKED])) {
    return { error: 'That MRI slot has already been used in another schedule.' };
  }

  var offset = parseInt(timeBeforeMriMinutes, 10);
  if (!offset || offset <= 0) return { error: 'Please provide a "Time Before MRI" offset greater than 0 minutes.' };
  var mriDuration = parseInt(mriDurationMinutes, 10);
  if (!mriDuration || mriDuration <= 0) return { error: 'Please provide an MRI duration greater than 0 minutes.' };

  var mriDate = mriRecord.values[cols.DATE];
  var mriStart = mriRecord.values[cols.START_TIME];
  var mriStartDateTime = combineDateAndTime_(mriDate, mriStart);

  var day1StartDateTime = new Date(mriStartDateTime.getTime() - offset * 60000);
  var mriEndDateTime = new Date(mriStartDateTime.getTime() + mriDuration * 60000);
  var day1EndDateTime = mriEndDateTime; // Day1 End = MRI End, by definition

  if (day1EndDateTime.getTime() <= day1StartDateTime.getTime()) {
    return { error: 'That combination of offset/duration produces an invalid (zero or negative length) Day 1 slot.' };
  }

  var sameCalendarDate =
    day1StartDateTime.getFullYear() === day1EndDateTime.getFullYear() &&
    day1StartDateTime.getMonth() === day1EndDateTime.getMonth() &&
    day1StartDateTime.getDate() === day1EndDateTime.getDate();
  if (!sameCalendarDate) {
    return {
      error: 'With this Time Before MRI offset, Day 1 would span past midnight (Day 1 Start falls on an ' +
        'earlier calendar date than MRI End) — this schedule does not support that. Reduce the offset or ' +
        'the MRI duration.'
    };
  }

  var origMriEndTime = mriRecord.values[cols.END_TIME];
  var origMriEndMs = combineDateAndTime_(mriDate, origMriEndTime).getTime();
  var mriEndChanged = (mriEndDateTime.getTime() !== origMriEndMs);

  return {
    error: null,
    mri: {
      slotID: mriSlotID,
      date: formatDateForDisplay_(mriDate, 'en'),
      startTime: formatTimeForDisplay_(mriStart, 'en'),
      endTime: formatTimeForDisplay_(origMriEndTime, 'en')
    },
    mriEndChanged: mriEndChanged,
    mriNewEndDateStr: day1EndDateTime.getFullYear() + '-' + pad2_(day1EndDateTime.getMonth() + 1) + '-' + pad2_(day1EndDateTime.getDate()),
    mriNewEndTimeStr: pad2_(day1EndDateTime.getHours()) + ':' + pad2_(day1EndDateTime.getMinutes()),
    day1Date: day1StartDateTime.getFullYear() + '-' + pad2_(day1StartDateTime.getMonth() + 1) + '-' + pad2_(day1StartDateTime.getDate()),
    day1StartTime: pad2_(day1StartDateTime.getHours()) + ':' + pad2_(day1StartDateTime.getMinutes()),
    day1EndTime: pad2_(day1EndDateTime.getHours()) + ':' + pad2_(day1EndDateTime.getMinutes())
  };
}

/**
 * Client-callable preview: given an MRI slot + offset + (possibly edited)
 * MRI duration, returns the computed Day 1 date/start/end AND whether
 * either the derived Day 1 slot OR the (possibly resized) MRI slot itself
 * now collides with something else in the shared conflict domain.
 * @param {string} token
 * @param {string} mriSlotID
 * @param {number} timeBeforeMriMinutes
 * @param {number} mriDurationMinutes
 * @return {Object}
 */
function previewDay1FromMri(token, mriSlotID, timeBeforeMriMinutes, mriDurationMinutes, day1StaffEmail) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  var computed = computeDay1FromMri_(mriSlotID, timeBeforeMriMinutes, mriDurationMinutes);
  if (computed.error) return { success: false, message: computed.error };

  // Day 1's own span, for collision purposes, is (offset + mriDuration)
  // minutes long — it runs from Day1 Start all the way to MRI End.
  var day1DurationMinutes = parseInt(timeBeforeMriMinutes, 10) + parseInt(mriDurationMinutes, 10);
  var staffEmail = String(day1StaffEmail || '').trim().toLowerCase();

  // Route through the SAME centralized, config-driven validator that Save
  // uses (validateSchedulingSlot_), so this live preview always reflects the
  // current Scheduling Rules AND the actually-selected staff member — e.g.
  // if Day1×Day1 overlap has been set to "Allowed", the preview shows a
  // warning instead of a hard "Conflicts with" block, and if the SAME staff
  // member is chosen for both slots it correctly escalates to a hard block
  // asking for a different staff member. The MRI slot itself is excluded so
  // the span leading up to it is never flagged against its own MRI.
  var validation = validateSchedulingSlot_({
    candidateType: 'Day1',
    dateStr: computed.day1Date,
    startTimeStr: computed.day1StartTime,
    durationMinutes: day1DurationMinutes,
    staffEmail: staffEmail,
    excludeSlotIDs: { MRI: mriSlotID },
    label: 'Day 1'
  });

  // If the admin resized the MRI slot's duration in this preview, also
  // re-check the MRI slot's OWN (possibly now-larger/smaller) time range
  // against every other MRI slot — through the SAME config-driven engine, so
  // MRI×MRI respects the Scheduling Rules rather than always hard-blocking.
  var mriResizeValidation = null;
  if (computed.mriEndChanged) {
    mriResizeValidation = validateSchedulingSlot_({
      candidateType: 'MRI',
      dateStr: computed.mri.date,
      startTimeStr: computed.mri.startTime,
      durationMinutes: parseInt(mriDurationMinutes, 10),
      staffEmail: '',
      excludeSlotIDs: { MRI: mriSlotID },
      label: 'The resized MRI slot'
    });
    if (mriResizeValidation.errors.length) validation.errors = validation.errors.concat(mriResizeValidation.errors);
    if (mriResizeValidation.warnings.length) validation.warnings = validation.warnings.concat(mriResizeValidation.warnings);
  }

  // Preserve the old {slotID, day, ...} single-collision shape for the
  // existing front-end, sourced from the validator's conflict list(s).
  var allConflicts = validation.conflicts.concat(mriResizeValidation ? mriResizeValidation.conflicts : []);
  var firstError = allConflicts.find(function (c) {
    return validation.errors.some(function (e) { return e.indexOf(c.slotID) !== -1; });
  });
  var firstWarningConflict = !firstError ? allConflicts[0] : null;

  return {
    success: true,
    day1Date: computed.day1Date,
    day1StartTime: computed.day1StartTime,
    day1EndTime: computed.day1EndTime,
    mriEndChanged: computed.mriEndChanged,
    collision: firstError || null,
    warningCollision: firstWarningConflict || null,
    staffConflict: validation.staffConflict,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

/**
 * ----------------------------------------------------------------------------
 * DAY 2 WINDOW (selecting from the existing bank, per the 22-26h rule)
 * ----------------------------------------------------------------------------
 */

/**
 * Client-callable: every AVAILABLE Day 2 slot (today onward) whose start
 * time falls within the compatibility window of the given Day 1
 * date/start-time. Used to populate the multi-select list in section 5.
 * @param {string} token
 * @param {string} day1DateStr
 * @param {string} day1StartStr
 * @return {Array<Object>}
 */
function getDay2SlotsInWindowForAdmin(token, day1DateStr, day1StartStr, day1DurationMinutes) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  var day1DateTime = combineDateAndTime_(parseDateInput_(day1DateStr), parseTimeInput_(day1StartStr));
  if (!day1DateTime) return [];

  var day1EndMs = day1DateTime.getTime() + (parseInt(day1DurationMinutes, 10) || 0) * 60000;

  return getSlotsFromToday_(CONFIG.SHEETS.DAY2)
    .filter(function (slot) {
      if (slot.booked) return false;
      if (!isSlotPairCompatible_(day1DateTime, new Date(slot.startMs))) return false;
      return true;
    })
    .map(function (slot) {
      var durationMinutes = Math.round((slot.endMs - slot.startMs) / 60000);
      // Round 5 fix: config-driven check against EVERYTHING (including the
      // Day 1 slot about to be created, and Blood Drawing), replacing the
      // old hardcoded "exclude if it clashes with the new Day 1 span" filter
      // and the hardcoded MRI-only warning. A not-permitted overlap now
      // excludes the slot from the list (it genuinely can't be used);
      // permitted overlaps are kept and surfaced as a warning.
      var validation = validateSchedulingSlot_({
        candidateType: 'Day2',
        dateStr: slot.rawDate,
        startTimeStr: slot.rawStart,
        durationMinutes: durationMinutes,
        staffEmail: '',
        excludeSlotIDs: { Day2: slot.slotID },
        label: slot.slotID
      });
      slot.blocked = validation.errors.length > 0;
      slot.blockReasons = validation.errors;
      slot.mriOverlaps = validation.conflicts.filter(function (c) { return c.day === 'MRI'; });
      slot.otherOverlaps = validation.conflicts.filter(function (c) { return c.day !== 'MRI'; });

      // The Day 1 slot about to be created has no sheet row yet, so the scan
      // above can't see it — check this Day 2 slot against that CANDIDATE
      // span separately, still via the config-driven permission (round 5 fix:
      // this used to be an unconditional exclusion regardless of the
      // Scheduling Rules).
      var overlapsDay1Candidate = slot.startMs < day1EndMs && day1DateTime.getTime() < slot.endMs;
      if (overlapsDay1Candidate) {
        if (!isOverlapAllowed_('Day1', 'Day2')) {
          slot.blocked = true;
          slot.blockReasons = slot.blockReasons.concat(['Overlaps the Day 1 slot being created, and Day1\u00d7Day2 overlap is not permitted by the Scheduling Rules.']);
        } else {
          slot.overlapsNewDay1 = true;
        }
      }
      return slot;
    })
    .filter(function (slot) { return !slot.blocked; });
}

/**
 * ----------------------------------------------------------------------------
 * INDEPENDENT DAY 2 SLOT CREATION
 * ----------------------------------------------------------------------------
 * A separate entry point for creating a Day 2 slot on its own — not tied to
 * building a new Day 1/MRI schedule. Still fully bound by the scheduling
 * rules: the candidate slot must be compatible (22-26h later) with at
 * least one existing AVAILABLE Day 1 slot, and must not conflict with
 * anything in the shared MRI/Day1/Day2 conflict domain.
 */

/**
 * Client-callable: given a candidate Day 2 {date, startTime,
 * durationMinutes}, finds every existing AVAILABLE Day 1 slot it would be
 * compatible with, and checks it for conflicts. Does NOT write anything —
 * call createIndependentDay2Slot() once the admin picks a staff member and
 * confirms.
 * @param {string} token
 * @param {Object} candidate - {date, startTime, durationMinutes}
 * @return {Object} {success, message?, compatibleDay1?: Array, conflict?: Object}
 */
function getIndependentDay2Options(token, candidate) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  return getIndependentDay2OptionsForSession_(session, candidate);
}

/**
 * Client-callable: creates the independent Day 2 slot after the admin has
 * reviewed the compatible Day 1 option(s) and picked a staff member.
 * Re-validates everything inside a lock (authoritative, never trusts the
 * client-side preview).
 * @param {string} token
 * @param {Object} data - {date, startTime, durationMinutes, staffEmail}
 * @return {Object}
 */
function createIndependentDay2Slot(token, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  return createIndependentDay2SlotInternal_(session, data || {});
}

/**
 * Shared create path for independent Day 2 (single + bulk). Pass
 * suppressNotification:true from bulk so the batch sender consolidates mail.
 * Does NOT send the "New Schedule Created" (scheduleCreated) event — that is
 * reserved for MRI→Day1→Day2 schedule pushes, not standalone Day 2 rows.
 */
function createIndependentDay2SlotInternal_(session, data) {
  var staffEmail = String((data && data.staffEmail) || '').trim().toLowerCase();
  if (!staffEmail) return { success: false, message: 'Please select an assigned staff member.' };
  var staffMatch = getApprovedStaffList_().some(function (s) { return s.email.toLowerCase() === staffEmail; });
  if (!staffMatch) return { success: false, message: 'That staff member was not found in the Staff sheet.' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var options = getIndependentDay2OptionsForSession_(session, data);
    if (!options.success) return options;

    var parsed = validateSlotInputWithDuration_(data);
    if (parsed.error) return { success: false, message: parsed.error };

    var indepValidation = validateBehaviouralSlot_({
      dateStr: data.date,
      startTimeStr: data.startTime,
      durationMinutes: data.durationMinutes,
      staffEmail: staffEmail,
      excludeSlotID: null,
      excludeMriSlotID: null,
      label: 'This Day 2 slot'
    });
    if (indepValidation.errors.length) {
      return {
        success: false,
        errors: indepValidation.errors,
        warnings: indepValidation.warnings,
        conflicts: describeBehaviouralOverlaps_(indepValidation.behaviouralConflicts),
        message: indepValidation.errors.join('\n')
      };
    }

    var slotId = generateNextSlotId_(CONFIG.SHEETS.DAY2, 'D2');
    var startDT = combineDateAndTime_(parsed.date, parsed.start);
    var endDT = combineDateAndTime_(parsed.date, parsed.end);
    var eventId = upsertStaffCalendarEvent_(
      'Day 2 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + slotId + ')', startDT, endDT, staffEmail, '', 'day2ScheduleCreated'
    );

    getSheet_(CONFIG.SHEETS.DAY2).appendRow([slotId, parsed.date, parsed.start, parsed.end, false, staffEmail, eventId, createdByLegacy_(session), new Date(), normalizeSlotLanguage_(data.language)]);

    var summary = slotId + ' (' + data.date + ' ' + data.startTime + '\u2013' + parsed.endTimeStr + ')';
    var compatibleSummary = options.compatibleDay1.map(function (d1) {
      return d1.slotID + ' (' + d1.date + ' ' + d1.startTime + ')';
    }).join(', ');

    if (!data.suppressNotification) {
      // Staff assignment only — intentionally NOT scheduleCreated / "New Schedule Created".
      sendStaffAssignmentEmails_(
        null,
        { staffEmail: staffEmail, details: 'Day 2 slot ' + summary + ' — ' + CONFIG.LOCATION.address }
      );
    }

    return {
      success: true,
      message: 'Day 2 slot created successfully.',
      slotID: slotId,
      summary: summary,
      staffEmail: staffEmail,
      compatibleDay1: options.compatibleDay1,
      compatibleSummary: compatibleSummary,
      addedSummary: { day2: summary, staff: staffEmail, compatibleDay1: options.compatibleDay1 }
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable (manage_slots): create several independent Day 2 slots
 * as one all-or-nothing batch. Validates every row against:
 *   (1) slots already saved,
 *   (2) other rows in this same batch,
 *   (3) the Scheduling Rules matrix (via validateSchedulingSlot_),
 * then creates only if every row is valid. Sends ONE consolidated staff
 * email — never the "New Schedule Created" notification.
 */
function bulkCreateIndependentDay2Slots(token, candidates) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  if (!candidates || !candidates.length) {
    return { success: false, message: 'Add at least one Day 2 slot first.' };
  }

  var results = [];
  var prepared = [];

  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i] || {};
    var staffEmail = String(c.staffEmail || '').trim().toLowerCase();
    var label = 'Day 2 row #' + (i + 1);

    if (!c.date || !c.startTime || !c.durationMinutes || !staffEmail) {
      results.push({ success: false, input: c, message: label + ': fill in date, start time, duration, and assigned staff.' });
      continue;
    }

    var options = getIndependentDay2OptionsForSession_(session, c);
    if (!options.success) {
      results.push({ success: false, input: c, message: options.message || (label + ' failed validation.') });
      continue;
    }

    var validation = validateBehaviouralSlot_({
      dateStr: c.date,
      startTimeStr: c.startTime,
      durationMinutes: c.durationMinutes,
      staffEmail: staffEmail,
      excludeSlotID: null,
      excludeMriSlotID: null,
      label: label
    });

    // In-batch peer conflicts (not yet saved).
    var peerMsg = null;
    var cStart = combineDateAndTime_(parseDateInput_(c.date), parseTimeInput_(c.startTime));
    var cEnd = cStart ? combineDateAndTime_(parseDateInput_(c.date), parseTimeInput_(
      addMinutesToTimeStr_(c.startTime, parseInt(c.durationMinutes, 10)))) : null;
    for (var j = 0; j < prepared.length; j++) {
      var other = prepared[j];
      if (other.date !== c.date) continue;
      if (cStart && other.startDT && other.endDT && cEnd &&
          cStart.getTime() < other.endDT.getTime() && other.startDT.getTime() < cEnd.getTime()) {
        peerMsg = label + ' overlaps another new Day 2 row (#' + (other.index + 1) + ') in this batch.';
        break;
      }
      if (staffEmail && staffEmail === other.staffEmail && c.date === other.date &&
          cStart && other.startDT && other.endDT && cEnd &&
          cStart.getTime() < other.endDT.getTime() && other.startDT.getTime() < cEnd.getTime()) {
        peerMsg = label + ' assigns the same staff as overlapping row #' + (other.index + 1) + '.';
        break;
      }
    }

    if (validation.errors.length || peerMsg) {
      var msgs = validation.errors.slice();
      if (peerMsg) msgs.push(peerMsg);
      results.push({ success: false, input: c, message: msgs.join('\n'), errors: msgs });
      continue;
    }

    prepared.push({
      index: i,
      input: c,
      staffEmail: staffEmail,
      date: c.date,
      startDT: cStart,
      endDT: cEnd,
      options: options
    });
    results.push({ success: true, input: c, pending: true });
  }

  var failed = results.filter(function (r) { return !r.success; });
  if (failed.length) {
    return {
      success: false,
      results: results,
      message: failed.length + ' of ' + candidates.length + ' Day 2 row(s) failed validation. Nothing was created.'
    };
  }

  var created = [];
  for (var k = 0; k < prepared.length; k++) {
    var p = prepared[k];
    var payload = {
      date: p.input.date,
      startTime: p.input.startTime,
      durationMinutes: p.input.durationMinutes,
      staffEmail: p.staffEmail,
      language: p.input.language,
      suppressNotification: true
    };
    var r = createIndependentDay2SlotInternal_(session, payload);
    r.input = p.input;
    results[p.index] = r;
    if (!r.success) {
      return {
        success: false,
        results: results,
        message: 'Stopped while creating row #' + (p.index + 1) + ': ' + (r.message || 'unknown error') +
          '. Earlier rows in this batch may already exist — check the Day 2 table.',
        partiallyCreated: created
      };
    }
    created.push(r);
  }

  // One consolidated staff notification for the whole batch (no scheduleCreated).
  var byStaff = {};
  created.forEach(function (r) {
    var email = String(r.staffEmail || '').toLowerCase();
    if (!email) return;
    if (!byStaff[email]) byStaff[email] = [];
    byStaff[email].push(r.summary || r.slotID);
  });
  Object.keys(byStaff).forEach(function (email) {
    sendStaffAssignmentEmails_(
      null,
      {
        staffEmail: email,
        details: 'Day 2 slot(s) created:\n\u2022 ' + byStaff[email].join('\n\u2022 ') +
          '\n\nLocation: ' + CONFIG.LOCATION.address
      }
    );
  });

  return {
    success: true,
    results: results,
    message: created.length + ' Day 2 slot(s) created.'
  };
}

/** Auth-aware helper used by independent Day 2 create/bulk (avoids re-auth loops). */
function getIndependentDay2OptionsForSession_(session, candidate) {
  var parsed = validateSlotInputWithDuration_(candidate);
  if (parsed.error) return { success: false, message: parsed.error };

  var candidateDateTime = combineDateAndTime_(parsed.date, parsed.start);
  var candidateValidation = validateSchedulingSlot_({
    candidateType: 'Day2',
    dateStr: candidate.date,
    startTimeStr: candidate.startTime,
    durationMinutes: candidate.durationMinutes,
    staffEmail: String(candidate.staffEmail || '').trim().toLowerCase(),
    label: 'This candidate Day 2 slot'
  });
  if (candidateValidation.errors.length) {
    return { success: false, message: candidateValidation.errors.join('\n') };
  }
  var mriOverlaps = candidateValidation.conflicts.filter(function (c) { return c.day === 'MRI'; });

  var cols = CONFIG.SLOT_COLS;
  var day1Rows = getDataRows_(CONFIG.SHEETS.DAY1);
  var compatible = [];
  for (var i = 0; i < day1Rows.length; i++) {
    var row = day1Rows[i];
    if (!row[cols.SLOT_ID]) continue;
    if (isBooked_(row[cols.BOOKED])) continue;
    if (!isOnOrAfterToday_(row[cols.DATE])) continue;
    var day1DateTime = combineDateAndTime_(row[cols.DATE], row[cols.START_TIME]);
    if (isSlotPairCompatible_(day1DateTime, candidateDateTime)) {
      compatible.push({
        slotID: String(row[cols.SLOT_ID]),
        date: formatDateForDisplay_(row[cols.DATE], 'en'),
        startTime: formatTimeForDisplay_(row[cols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(row[cols.END_TIME], 'en')
      });
    }
  }

  if (compatible.length === 0) {
    return {
      success: false,
      message: 'No existing available Day 1 slot is compatible with this candidate (needs to start ' +
        CONFIG.MAPPING_WINDOW_MIN_HOURS + '\u2013' + CONFIG.MAPPING_WINDOW_MAX_HOURS + ' hours before it). ' +
        'Add a Day 1 slot in that window first, or adjust the candidate time.'
    };
  }

  return {
    success: true,
    compatibleDay1: compatible,
    mriOverlaps: mriOverlaps,
    candidate: { date: candidate.date, startTime: candidate.startTime, endTime: parsed.endTimeStr, durationMinutes: candidate.durationMinutes }
  };
}

/**
 * ----------------------------------------------------------------------------
 * SCHEDULE CREATION (MRI + Day 1 + Day 2, all in one committed action)
 * ----------------------------------------------------------------------------
 */

// NOTE (round 5): checkStaffAvailability (the old "Step 3 — staff
// availability" preview) has been REMOVED — it duplicated, and could
// disagree with, the per-row config-driven checks that now cover Day 1
// (previewDay1FromMri) and every Day 2 row (checkSlotOverlap), all routed
// through the single validateSchedulingSlot_ engine. No client code calls it
// any longer.

/**
 * Client-callable: creates a complete schedule from an MRI slot.
 *
 * Validates, in order: MRI slot still available; Day 1 and Day 2 staff both
 * chosen and known; NO staff conflict against experiments overlapping the
 * MRI window (Step 3); Day 1 conflict-free (recomputed server-side from the
 * MRI slot's real time); and at least one Day 2 slot resolved, each with its
 * OWN assigned staff member. Nothing is written unless every check passes.
 * Wrapped in a lock so two admins can't double-book the same MRI slot.
 *
 * @param {string} token
 * @param {Object} input - {
 *     mriSlotID, day1StaffEmail, timeBeforeMriMinutes, mriDurationMinutes,
 *     existingDay2: [{slotID, staffEmail}, ...],
 *     newDay2List: [{date, startTime, durationMinutes, staffEmail}, ...]
 *   }
 * @return {Object}
 */
function createScheduleFromMri(token, input) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  return createScheduleFromMriInternal_(session, input);
}

/**
 * Reusable core of createScheduleFromMri, taking an already-authenticated
 * session so it can be called directly by bulkCreateSchedulesFromMri
 * (spec round 2, #13) without re-checking auth on every entry in a batch.
 */
function createScheduleFromMriInternal_(session, input) {
  input = input || {};

  var createdBy = session.name + ' <' + session.email + '>';
  var createdAt = new Date();

  var day1StaffEmail = String(input.day1StaffEmail || '').trim().toLowerCase();
  if (!day1StaffEmail) return { success: false, message: 'Please select a Day 1 assigned staff member.' };

  var staffEmails = getApprovedStaffList_().map(function (s) { return s.email.toLowerCase(); });
  if (staffEmails.indexOf(day1StaffEmail) === -1) {
    return { success: false, message: 'The Day 1 staff member is not an approved admin or listed staff member.' };
  }

  var existingDay2 = (input.existingDay2 || []).filter(function (e) { return e && e.slotID; });
  var newList = input.newDay2List || [];
  if (existingDay2.length === 0 && newList.length === 0) {
    return { success: false, message: 'Please select at least one existing Day 2 slot, or add a new one.' };
  }

  // Every Day 2 slot carries its OWN staff assignment.
  var allDay2Staff = [];
  for (var v = 0; v < existingDay2.length; v++) {
    var e2 = String(existingDay2[v].staffEmail || '').trim().toLowerCase();
    if (!e2) return { success: false, message: 'Please assign a staff member to Day 2 slot ' + existingDay2[v].slotID + '.' };
    if (staffEmails.indexOf(e2) === -1) return { success: false, message: 'Unknown staff member for Day 2 slot ' + existingDay2[v].slotID + '.' };
    existingDay2[v].staffEmail = e2;
    if (allDay2Staff.indexOf(e2) === -1) allDay2Staff.push(e2);
  }
  for (var w = 0; w < newList.length; w++) {
    var n2 = String(newList[w].staffEmail || '').trim().toLowerCase();
    if (!n2) return { success: false, message: 'Please assign a staff member to new Day 2 slot ' + (w + 1) + '.' };
    if (staffEmails.indexOf(n2) === -1) return { success: false, message: 'Unknown staff member for new Day 2 slot ' + (w + 1) + '.' };
    newList[w].staffEmail = n2;
    if (allDay2Staff.indexOf(n2) === -1) allDay2Staff.push(n2);
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    // Re-derive Day 1 from the MRI slot's ACTUAL stored data.
    var computed = computeDay1FromMri_(input.mriSlotID, input.timeBeforeMriMinutes, input.mriDurationMinutes);
    if (computed.error) return { success: false, message: computed.error };

    var mriCols = CONFIG.SLOT_COLS;
    var mriRec = getSlotByFullRow_(CONFIG.SHEETS.MRI, input.mriSlotID);
    var mriDateStr = toIsoDateStr_(mriRec.values[mriCols.DATE]);
    var mriStartStr = toHmStr_(mriRec.values[mriCols.START_TIME]);

    // NOTE (round 3, #3/#4): the previous per-staff MRI-window conflict
    // pre-check has been removed. All overlap rules now live in the single
    // validateBehaviouralSlot_() call below (and the Day 2 loop further down),
    // so the individual and bulk workflows apply exactly one, identical rule
    // set. behaviour-vs-behaviour is an unconditional block there; the
    // same-staff-on-overlapping-MRI case is handled as a staff error there too.

    // Day 1 validation under the round-3 unified rules: behaviour-vs-behaviour
    // always blocks; behaviour-vs-MRI only warns unless the same staff member
    // is on both sides. Day 1's OWN MRI and already-linked Blood Drawing slot
    // (created at MRI-creation time) are excluded — they are the same schedule.
    var existingBdForMri = findBloodDrawingRowByMriSlotID_(input.mriSlotID);
    var existingBdSlotId = existingBdForMri
      ? String(existingBdForMri.values[CONFIG.BLOOD_DRAWING_COLS.SLOT_ID])
      : null;
    var day1DurationMinutes = parseInt(input.timeBeforeMriMinutes, 10) + parseInt(input.mriDurationMinutes, 10);
    var day1Validation = validateBehaviouralSlot_({
      dateStr: computed.day1Date,
      startTimeStr: computed.day1StartTime,
      durationMinutes: day1DurationMinutes,
      staffEmail: day1StaffEmail,
      excludeSlotID: null,
      excludeMriSlotID: input.mriSlotID,
      excludeBloodDrawingSlotID: existingBdSlotId,
      label: 'Day 1'
    });
    var allValidationErrors = day1Validation.errors.slice();
    var allValidationWarnings = day1Validation.warnings.slice();
    var behaviouralOverlapWarnings = describeBehaviouralOverlaps_(day1Validation.behaviouralConflicts);

    if (day1Validation.errors.length) {
      return {
        success: false,
        staffConflictSameStaff: day1Validation.staffConflict,
        conflicts: behaviouralOverlapWarnings,
        errors: day1Validation.errors,
        warnings: day1Validation.warnings,
        message: day1Validation.errors.join('\n')
      };
    }

    if (computed.mriEndChanged) {
      // Round 5 fix: this was still hardcoded (findMriMriOverlap_) and never
      // consulted the Scheduling Rules — the live preview was already fixed
      // to use validateSchedulingSlot_, but the actual SAVE decision here
      // was not, so it could disagree with what the preview showed.
      var mriResizeValidation = validateSchedulingSlot_({
        candidateType: 'MRI',
        dateStr: mriDateStr,
        startTimeStr: mriStartStr,
        durationMinutes: parseInt(input.mriDurationMinutes, 10),
        staffEmail: '',
        excludeSlotIDs: { MRI: input.mriSlotID },
        label: 'The resized MRI slot'
      });
      if (mriResizeValidation.errors.length) {
        return {
          success: false,
          errors: mriResizeValidation.errors,
          warnings: mriResizeValidation.warnings,
          message: mriResizeValidation.errors.join('\n')
        };
      }
      allValidationWarnings = allValidationWarnings.concat(mriResizeValidation.warnings);
    }

    // Blood Drawing was already auto-created when the MRI slot was created.
    // Validate the BD *window* for conflicts against OTHER slots, but exclude
    // the existing linked BD (and this MRI) so we do not false-positive on
    // "the BD this Day 1 will generate" overlapping BD-001 that already exists.
    var bdValidation = previewGeneratedBloodDrawingValidation_(
      computed.day1Date, computed.day1StartTime, day1StaffEmail, {
        excludeBloodDrawingSlotID: existingBdSlotId,
        excludeMriSlotID: input.mriSlotID
      });
    if (bdValidation.errors.length) {
      return {
        success: false,
        staffConflictSameStaff: bdValidation.staffConflict,
        taConflictSameTA: bdValidation.taConflict,
        conflicts: bdValidation.errors,
        errors: bdValidation.errors,
        warnings: allValidationWarnings.concat(bdValidation.warnings),
        message: bdValidation.errors.join('\n')
      };
    }
    allValidationWarnings = allValidationWarnings.concat(bdValidation.warnings);

    var day1DateTime = combineDateAndTime_(parseDateInput_(computed.day1Date), parseTimeInput_(computed.day1StartTime));

    // Validate existing Day 2 selections.
    var resolvedDay2 = [];
    var mriOverlapWarnings = [];
    var day2Cols = CONFIG.SLOT_COLS;
    for (var i = 0; i < existingDay2.length; i++) {
      var sel = existingDay2[i];
      var d2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, sel.slotID);
      if (!d2Record) return { success: false, message: 'Day 2 slot ' + sel.slotID + ' no longer exists.' };
      if (isBooked_(d2Record.values[day2Cols.BOOKED])) {
        return { success: false, message: 'Day 2 slot ' + sel.slotID + ' was just booked. Please reselect.' };
      }
      var d2DateTime = combineDateAndTime_(d2Record.values[day2Cols.DATE], d2Record.values[day2Cols.START_TIME]);
      if (!isSlotPairCompatible_(day1DateTime, d2DateTime)) {
        return { success: false, message: 'Day 2 slot ' + sel.slotID + ' is no longer within the compatibility window.' };
      }

      // Round 5 fix: route through the SAME centralized, config-driven
      // validator as everything else — this used to call legacy
      // findStaffBusyConflicts_/findMriOverlapsForExperiment_ directly,
      // which don't consult the Scheduling Rules and could disagree with
      // the engine used elsewhere in this same save.
      var selDurationMinutes = Math.round((combineDateAndTime_(d2Record.values[day2Cols.DATE], d2Record.values[day2Cols.END_TIME]).getTime() -
                    d2DateTime.getTime()) / 60000);
      var selValidation = validateSchedulingSlot_({
        candidateType: 'Day2',
        dateStr: toIsoDateStr_(d2Record.values[day2Cols.DATE]),
        startTimeStr: toHmStr_(d2Record.values[day2Cols.START_TIME]),
        durationMinutes: selDurationMinutes,
        staffEmail: sel.staffEmail,
        excludeSlotIDs: { Day2: sel.slotID },
        label: 'Day 2 slot ' + sel.slotID
      });
      allValidationWarnings = allValidationWarnings.concat(selValidation.warnings);
      if (selValidation.errors.length) {
        return {
          success: false,
          staffConflictSameStaff: selValidation.staffConflict,
          errors: selValidation.errors,
          warnings: allValidationWarnings,
          message: selValidation.errors.join('\n')
        };
      }
      if (selValidation.warnings.length) {
        mriOverlapWarnings = mriOverlapWarnings.concat(selValidation.warnings);
      }

      resolvedDay2.push({
        slotID: sel.slotID,
        staffEmail: sel.staffEmail,
        isNew: false,
        record: d2Record,
        summary: sel.slotID + ' (' + formatDateForDisplay_(d2Record.values[day2Cols.DATE], 'en') + ' ' +
          formatTimeForDisplay_(d2Record.values[day2Cols.START_TIME], 'en') + '–' +
          formatTimeForDisplay_(d2Record.values[day2Cols.END_TIME], 'en') + ') — ' +
          (getStaffNameByEmail_(sel.staffEmail) || sel.staffEmail)
      });
    }

    // Validate + prepare new Day 2 rows.
    var parsedNewDay2 = [];
    for (var j = 0; j < newList.length; j++) {
      var entry = newList[j];
      var parsed = validateSlotInputWithDuration_(entry);
      if (parsed.error) return { success: false, message: 'New Day 2 slot ' + (j + 1) + ': ' + parsed.error };

      var newD2DateTime = combineDateAndTime_(parsed.date, parsed.start);
      if (!isSlotPairCompatible_(day1DateTime, newD2DateTime)) {
        return { success: false, message: 'New Day 2 slot ' + (j + 1) + ' is not within the 22–26 hour compatibility window.' };
      }
      // Same unified rules as Day 1 (spec round 3, #3): behaviour-vs-behaviour
      // always blocks; behaviour-vs-MRI warns unless the same staff member is
      // on both sides.
      var newDay2Validation = validateBehaviouralSlot_({
        dateStr: entry.date,
        startTimeStr: entry.startTime,
        durationMinutes: entry.durationMinutes,
        staffEmail: entry.staffEmail,
        excludeSlotID: null,
        excludeMriSlotID: null,
        label: 'New Day 2 slot ' + (j + 1)
      });
      behaviouralOverlapWarnings = behaviouralOverlapWarnings.concat(
        describeBehaviouralOverlaps_(newDay2Validation.behaviouralConflicts));
      allValidationWarnings = allValidationWarnings.concat(newDay2Validation.warnings);
      if (newDay2Validation.errors.length) {
        allValidationErrors = allValidationErrors.concat(newDay2Validation.errors);
        return {
          success: false,
          staffConflictSameStaff: newDay2Validation.staffConflict,
          conflicts: behaviouralOverlapWarnings,
          errors: newDay2Validation.errors,
          warnings: allValidationWarnings,
          message: newDay2Validation.errors.join('\n')
        };
      }

      // ALLOWED but warned: overlapping an MRI (or other permitted type) —
      // already fully covered by newDay2Validation.warnings above via the
      // centralized validator, including the same-staff hard block. The old
      // separate findMriOverlapsForExperiment_/findStaffBusyConflicts_ calls
      // here were a leftover pre-round-5 duplicate check that could disagree
      // with the engine's decision and have been removed.
      if (newDay2Validation.warnings.length) {
        mriOverlapWarnings = mriOverlapWarnings.concat(newDay2Validation.warnings);
      }

      parsedNewDay2.push({ parsed: parsed, raw: entry });
    }

    if (input.dryRun) {
      return {
        success: true,
        dryRun: true,
        warnings: allValidationWarnings.concat(mriOverlapWarnings),
        message: 'Validation passed (dry run).'
      };
    }

    // ---- All checks passed — commit ----
    var day1SlotId = generateNextSlotId_(CONFIG.SHEETS.DAY1, 'D1');
    var day1StartDT = day1DateTime;
    var day1EndDT = combineDateAndTime_(parseDateInput_(computed.day1Date), parseTimeInput_(computed.day1EndTime));

    // Event description carries BOTH staff members, per spec — as NAMES,
    // never raw emails (round 11). day2StaffLabel (raw emails) is still
    // needed separately below for sheet storage and the return payload.
    var day1StaffNameForTitle = getStaffNameByEmail_(day1StaffEmail) || day1StaffEmail;
    var day2StaffLabel = allDay2Staff.join(', ');
    var day2StaffNamesLabel = allDay2Staff.map(function (e) { return getStaffNameByEmail_(e) || e; }).join(', ');
    var day1CalEventId = upsertStaffCalendarEvent_(
      'Day 1 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + day1SlotId + ') — Day 1: ' + day1StaffNameForTitle + ' | Day 2: ' + day2StaffNamesLabel,
      day1StartDT, day1EndDT, day1StaffEmail, '', 'day1ScheduleCreated'
    );
    getSheet_(CONFIG.SHEETS.DAY1).appendRow([
      day1SlotId,
      parseDateInput_(computed.day1Date),
      parseTimeInput_(computed.day1StartTime),
      parseTimeInput_(computed.day1EndTime),
      false,
      input.mriSlotID,
      day1StaffEmail,
      day1CalEventId,
      createdBy,
      createdAt,
      normalizeSlotLanguage_(input.language)
    ]);
    // Requirement #1: the linked Blood Drawing slot was already created
    // when the MRI slot itself was created (autoCreateBloodDrawingSlotForMri_),
    // so we LINK it to the new Day 1 slot here instead of creating a new
    // one. Its date/time is refreshed to match the actual Day 1 start (the
    // admin may have used a non-default "Time Before MRI"), and its
    // assigned staff now defaults to the Day 1 staff member (unknown until
    // now). Falls back to creating one on the spot for legacy MRI slots
    // that predate this change and have no linked Blood Drawing slot yet.
    var bdCreateResult = linkOrCreateBloodDrawingForSchedule_(
      input.mriSlotID, day1SlotId, parseDateInput_(computed.day1Date), parseTimeInput_(computed.day1StartTime),
      createdBy, day1StaffEmail, input.suppressNotification
    );

    // Existing Day 2 rows: write their own staff + refresh their event.
    resolvedDay2.forEach(function (r) {
      var rec = r.record;
      var oldEventId = String(rec.values[CONFIG.DAY2_EXTRA_COLS.CALENDAR_EVENT_ID] || '');
      var startDT = combineDateAndTime_(rec.values[day2Cols.DATE], rec.values[day2Cols.START_TIME]);
      var endDT = combineDateAndTime_(rec.values[day2Cols.DATE], rec.values[day2Cols.END_TIME]);
      var evId = upsertStaffCalendarEvent_(
        'Day 2 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + r.slotID + ') — Day 1: ' + day1StaffNameForTitle + ' | Day 2: ' +
          (getStaffNameByEmail_(r.staffEmail) || r.staffEmail),
        startDT, endDT, r.staffEmail, oldEventId, 'day2ScheduleCreated'
      );
      rec.sheet.getRange(rec.rowIndex, CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF + 1).setValue(r.staffEmail);
      rec.sheet.getRange(rec.rowIndex, CONFIG.DAY2_EXTRA_COLS.CALENDAR_EVENT_ID + 1).setValue(evId);
      rec.sheet.getRange(rec.rowIndex, CONFIG.DAY2_EXTRA_COLS.CREATED_BY + 1).setValue(createdBy);
      rec.sheet.getRange(rec.rowIndex, CONFIG.DAY2_EXTRA_COLS.CREATED_AT + 1).setValue(createdAt);
    });

    parsedNewDay2.forEach(function (p, idx) {
      var newId = generateNextSlotId_(CONFIG.SHEETS.DAY2, 'D2');
      var sDT = combineDateAndTime_(p.parsed.date, p.parsed.start);
      var eDT = combineDateAndTime_(p.parsed.date, p.parsed.end);
      var evId = upsertStaffCalendarEvent_(
        'Day 2 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + newId + ') — Day 1: ' + day1StaffNameForTitle + ' | Day 2: ' +
          (getStaffNameByEmail_(p.raw.staffEmail) || p.raw.staffEmail),
        sDT, eDT, p.raw.staffEmail, '', 'day2ScheduleCreated'
      );
      getSheet_(CONFIG.SHEETS.DAY2).appendRow([
        newId, p.parsed.date, p.parsed.start, p.parsed.end, false,
        p.raw.staffEmail, evId, createdBy, createdAt, normalizeSlotLanguage_(p.raw.language)
      ]);
      resolvedDay2.push({
        slotID: newId,
        staffEmail: p.raw.staffEmail,
        isNew: true,
        summary: newId + ' (' + p.raw.date + ' ' + p.raw.startTime + '–' + p.parsed.endTimeStr + ') — ' +
          (getStaffNameByEmail_(p.raw.staffEmail) || p.raw.staffEmail) + ' [new]'
      });
    });

    // Mark the MRI slot used; record both staff members and provenance.
    mriRec.sheet.getRange(mriRec.rowIndex, CONFIG.SLOT_COLS.BOOKED + 1).setValue(true);
    mriRec.sheet.getRange(mriRec.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY1_STAFF + 1).setValue(day1StaffEmail);
    mriRec.sheet.getRange(mriRec.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY2_STAFF + 1).setValue(day2StaffLabel);
    if (computed.mriEndChanged) {
      mriRec.sheet.getRange(mriRec.rowIndex, CONFIG.SLOT_COLS.END_TIME + 1).setValue(parseTimeInput_(computed.mriNewEndTimeStr));
    }

    var day1Summary = day1SlotId + ' (' + computed.day1Date + ' ' + computed.day1StartTime + '–' + computed.day1EndTime + ')';
    var mriSummary = input.mriSlotID + ' (' + computed.mri.date + ' ' + computed.mri.startTime + '–' +
      (computed.mriEndChanged ? computed.mriNewEndTimeStr : computed.mri.endTime) + ')';
    var day2Summaries = resolvedDay2.map(function (r) { return r.summary; });

    var scheduleInfo = {
      mriSummary: mriSummary,
      day1Summary: day1Summary,
      day1Staff: day1StaffEmail,
      day2Summaries: day2Summaries,
      day2Assignments: resolvedDay2.map(function (r) {
        return { staffEmail: r.staffEmail, summary: r.summary };
      }),
      createdBy: createdBy,
      createdByName: session.name,
      createdAt: createdAt
    };

    // Round 12: bulk callers (bulkCreateSchedulesFromMri) pass
    // suppressNotification so they can collect every pushed schedule's
    // info and send ONE consolidated batch of emails at the end of the
    // whole operation, instead of one set of emails per individual push.
    if (!input.suppressNotification) {
      notifyScheduleCreated_([scheduleInfo]);
    }

    return {
      success: true,
      message: 'Experiment Schedule has been updated successfully.',
      day1SlotID: day1SlotId,
      day2SlotIDs: resolvedDay2.map(function (r) { return r.slotID; }),
      mriOverlapWarnings: mriOverlapWarnings,
      warnings: (typeof allValidationWarnings !== 'undefined' ? allValidationWarnings : []),
      scheduleInfo: scheduleInfo,
      bloodDrawingAssignment: bdCreateResult ? bdCreateResult.bloodDrawingAssignment : null,
      addedSummary: {
        mri: mriSummary,
        day1Staff: day1StaffEmail,
        day1StaffName: day1StaffNameForTitle,
        day2Staff: day2StaffLabel,
        day1: day1Summary,
        day2: day2Summaries,
        createdBy: createdBy,
        createdByName: session.name
      }
    };

  } finally {
    lock.releaseLock();
  }
}

/**
 * Notifies the UNIQUE set of {all active admins} ∪ {Day 1 staff} ∪ {Day 2
 * staff} that a schedule was created.
 *
 * Each person receives EXACTLY ONE email, deduplicated case-insensitively:
 *   - Someone assigned to both Day 1 and Day 2 gets a single combined
 *     message listing both assignments (never two separate ones).
 *   - Staff assigned to only one day get that day's assignment.
 *   - Admins who aren't assigned get the schedule overview only.
 *   - Someone who is both an admin and assigned gets one message containing
 *     both their assignment and the overview.
 * @param {Object} info
 */
/**
 * Round 12: now takes an ARRAY of schedule-creation infos (one per
 * MRI->schedule push) instead of a single one, so a bulk operation that
 * pushes several MRI slots in one action can consolidate per-person
 * assignments across the WHOLE batch — not just within one push. A single
 * "Build Schedule" push just calls this with a 1-element array. Each
 * affected person gets exactly ONE email listing every Day 1/Day 2
 * assignment they received across every schedule in this operation;
 * everyone else resolved for 'scheduleCreated' gets one broadcast copy
 * covering the whole batch.
 * @param {Array<Object>} infos
 */
function notifyScheduleCreated_(infos) {
  infos = Array.isArray(infos) ? infos : [infos];
  if (!infos.length) return;

  // Round 9: simplified per explicit request — no email addresses (names
  // only), no raw JS Date.toString() timestamp, one slot per line instead
  // of a comma-joined run-on sentence.
  var overviewLines = [];
  infos.forEach(function (info) {
    var day1StaffName = getStaffNameByEmail_(info.day1Staff) || info.day1Staff;
    overviewLines.push('MRI: ' + info.mriSummary);
    overviewLines.push('Day 1: ' + info.day1Summary + ' — Staff: ' + day1StaffName);
    info.day2Summaries.forEach(function (s) { overviewLines.push('Day 2: ' + s); });
  });
  overviewLines.push('Created by: ' + (infos[0].createdByName || infos[0].createdBy));
  var overview = overviewLines.join('\n');

  // Recipients come from scheduleCreated plus the dedicated Day 1 / Day 2
  // schedule-created matrix entries (union), so Main Admin can route each
  // independently while same-staff-on-both still gets one consolidated mail.
  var allAssignedEmails = buildDedupedGuestList_(
    infos.reduce(function (acc, info) {
      return acc.concat([info.day1Staff]).concat(info.day2Assignments.map(function (a) { return a.staffEmail; }));
    }, [])
  );
  var resolved = buildDedupedGuestList_(
    resolveNotificationRecipients_('scheduleCreated', { assignedStaff: allAssignedEmails })
      .concat(resolveNotificationRecipients_('day1ScheduleCreated', { assignedStaff: allAssignedEmails }))
      .concat(resolveNotificationRecipients_('day2ScheduleCreated', { assignedStaff: allAssignedEmails }))
  );
  var resolvedLower = resolved.map(function (e) { return String(e).toLowerCase(); });

  // Build recipient -> their own assignments (across EVERY info in this
  // batch), but only for resolved recipients.
  var recipients = {};   // lowercased email -> {email, assignments: []}
  function ensure_(email) {
    var addr = String(email || '').trim();
    if (!addr) return null;
    var key = addr.toLowerCase();
    if (resolvedLower.indexOf(key) === -1) return null; // not routed to this event — skip entirely
    if (!recipients[key]) recipients[key] = { email: addr, assignments: [] };
    return recipients[key];
  }

  infos.forEach(function (info) {
    var d1 = ensure_(info.day1Staff);
    if (d1) d1.assignments.push('Day 1: ' + info.day1Summary);

    info.day2Assignments.forEach(function (a) {
      var r = ensure_(a.staffEmail);
      if (r) r.assignments.push('Day 2: ' + a.summary);
    });
  });

  // Everyone else resolved (Main Admin, Admins, etc.) gets the broadcast copy.
  resolved.forEach(function (e) { ensure_(e); });

  Object.keys(recipients).forEach(function (key) {
    var r = recipients[key];
    var isAssigned = r.assignments.length > 0;
    var hasD1 = r.assignments.some(function (a) { return String(a).indexOf('Day 1:') === 0; });
    var hasD2 = r.assignments.some(function (a) { return String(a).indexOf('Day 2:') === 0; });
    var subjectKey = !isAssigned ? 'scheduleCreated'
      : (hasD1 && hasD2) ? 'staffAssignment'
      : hasD1 ? 'day1ScheduleCreated'
      : 'day2ScheduleCreated';
    var projectId = getProjectId();
    var projectLine = projectId ? ('Project: ' + projectId + '\n\n') : '';
    var body = isAssigned
      ? bilingualBody_(
          projectLine + 'Sie wurden folgenden neuen Terminen zugewiesen:\n\n' +
          r.assignments.join('\n') +
          '\n\nOrt: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl,
          projectLine + 'You have been assigned to the following new appointments:\n\n' +
          r.assignments.join('\n') +
          '\n\nLocation: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl
        )
      : bilingualBody_(
          projectLine + (infos.length > 1 ? infos.length + ' neue Termine wurden erstellt.\n\n' : 'Ein neuer Termin wurde erstellt.\n\n') + overview,
          projectLine + (infos.length > 1 ? infos.length + ' new appointments have been created.\n\n' : 'A new appointment has been created.\n\n') + overview
        );

    try {
      MailApp.sendEmail(
        r.email,
        emailSubject_(subjectKey),
        body
      );
    } catch (err) {
      Logger.log('notifyScheduleCreated_ to ' + r.email + ' failed: ' + err);
    }
  });
}

/**
 * ----------------------------------------------------------------------------
 * EDIT SCHEDULE (round 12)
 * ----------------------------------------------------------------------------
 * Replaces the standalone "Reassign Staff" actions on Day 1 and Day 2 rows.
 * A single panel edits every assignment tied to one schedule together —
 * Day 1 staff, Day 2 staff, Blood Drawing staff, and Blood Drawing TA(s) —
 * validates ALL of them before saving ANY of them (so a conflict on one
 * field can't leave the others half-applied), and sends ONE consolidated
 * email per affected person instead of a separate email per field changed.
 */

/**
 * Client-callable (manage_slots): gathers everything editable for "the
 * schedule" a Day 1 or Day 2 slot belongs to.
 *  - From a Day 1 slot: always includes Day 1 staff and its linked Blood
 *    Drawing slot (auto-created alongside every Day 1 slot). If booked,
 *    also includes the paired Day 2 slot (via the active booking).
 *  - From a Day 2 slot: always includes Day 2 staff. If booked, also
 *    includes the paired Day 1 slot and ITS linked Blood Drawing slot.
 *  - From an unbooked Day 2 slot with no booking yet, only Day 2 staff is
 *    editable here — there's no single Day 1 it's committed to yet.
 * @param {string} token
 * @param {string} slotID
 * @param {string} slotType - 'day1' | 'day2'
 * @return {Object} {success, context: {day1, day2, bloodDrawing, booking}}
 */
function getEditScheduleContext(token, slotID, slotType) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var cols = CONFIG.SLOT_COLS;
  var context = { day1: null, day2: null, bloodDrawing: null, booking: null };

  function buildBdContext(day1SlotID) {
    var bdRows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
    var bdCols = CONFIG.BLOOD_DRAWING_COLS;
    for (var i = 0; i < bdRows.length; i++) {
      var bd = bdRows[i];
      if (!bd[bdCols.SLOT_ID]) continue;
      if (String(bd[bdCols.DAY1_SLOT_ID] || '') !== String(day1SlotID)) continue;
      var staffEmail = String(bd[bdCols.ASSIGNED_STAFF] || '');
      var taEmails = parseTaEmails_(bd[bdCols.ASSIGNED_TA]);
      return {
        slotID: String(bd[bdCols.SLOT_ID]),
        date: formatDateForDisplay_(bd[bdCols.DATE], 'en'),
        startTime: formatTimeForDisplay_(bd[bdCols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(bd[bdCols.END_TIME], 'en'),
        staffEmail: staffEmail,
        staffName: staffEmail ? (getStaffNameByEmail_(staffEmail) || staffEmail) : '',
        taEmails: taEmails,
        taNames: taEmails.map(function (e) { return getStaffNameByEmail_(e) || e; }),
        booked: isBooked_(bd[bdCols.BOOKED])
      };
    }
    return null;
  }

  function buildDay1Context(record) {
    var staffEmail = String(record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    return {
      slotID: String(record.values[cols.SLOT_ID]),
      date: formatDateForDisplay_(record.values[cols.DATE], 'en'),
      startTime: formatTimeForDisplay_(record.values[cols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(record.values[cols.END_TIME], 'en'),
      staffEmail: staffEmail,
      staffName: staffEmail ? (getStaffNameByEmail_(staffEmail) || staffEmail) : '',
      booked: isBooked_(record.values[cols.BOOKED]),
      language: normalizeSlotLanguage_(record.values[CONFIG.DAY1_EXTRA_COLS.LANGUAGE])
    };
  }

  function buildDay2Context(record) {
    var staffEmail = String(record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
    var durationMinutes = Math.round((combineDateAndTime_(record.values[cols.DATE], record.values[cols.END_TIME]).getTime() -
      combineDateAndTime_(record.values[cols.DATE], record.values[cols.START_TIME]).getTime()) / 60000);
    return {
      slotID: String(record.values[cols.SLOT_ID]),
      date: formatDateForDisplay_(record.values[cols.DATE], 'en'),
      startTime: formatTimeForDisplay_(record.values[cols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(record.values[cols.END_TIME], 'en'),
      rawDate: toIsoDateStr_(record.values[cols.DATE]),
      rawStart: toHmStr_(record.values[cols.START_TIME]),
      durationMinutes: durationMinutes,
      staffEmail: staffEmail,
      staffName: staffEmail ? (getStaffNameByEmail_(staffEmail) || staffEmail) : '',
      booked: isBooked_(record.values[cols.BOOKED]),
      language: normalizeSlotLanguage_(record.values[CONFIG.DAY2_EXTRA_COLS.LANGUAGE])
    };
  }

  function findActiveBookingByDay1_(day1SlotID) {
    var matches = findBookingsByDay1Slot_(day1SlotID);
    var bookCols = CONFIG.BOOKING_COLS;
    for (var i = 0; i < matches.length; i++) {
      var full = getSheet_(CONFIG.SHEETS.BOOKINGS).getRange(matches[i].rowIndex, 1, 1, CONFIG.BOOKING_ROW_WIDTH).getValues()[0];
      if (String(full[bookCols.STATUS] || '') === 'Booked') {
        return { rowIndex: matches[i].rowIndex, values: full };
      }
    }
    return null;
  }

  if (slotType === 'day1') {
    var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, slotID);
    if (!day1Record) return { success: false, message: 'That Day 1 slot no longer exists.' };
    context.day1 = buildDay1Context(day1Record);
    context.bloodDrawing = buildBdContext(slotID);

    if (context.day1.booked) {
      var booking = findActiveBookingByDay1_(slotID);
      if (booking) {
        var bookCols = CONFIG.BOOKING_COLS;
        context.booking = {
          confirmationNumber: String(booking.values[bookCols.CONFIRMATION_NUMBER] || ''),
          participantName: String(booking.values[bookCols.NAME] || '')
        };
        var day2SlotID = String(booking.values[bookCols.DAY2_SLOT_ID] || '');
        if (day2SlotID) {
          var day2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
          if (day2Record) context.day2 = buildDay2Context(day2Record);
        }
      }
    }
  } else {
    var day2Rec = getSlotByFullRow_(CONFIG.SHEETS.DAY2, slotID);
    if (!day2Rec) return { success: false, message: 'That Day 2 slot no longer exists.' };
    context.day2 = buildDay2Context(day2Rec);

    if (context.day2.booked) {
      // Find the active booking referencing this Day 2 slot.
      var bSheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
      var lastRow = bSheet.getLastRow();
      var bookCols2 = CONFIG.BOOKING_COLS;
      if (lastRow >= 2) {
        var allRows = bSheet.getRange(2, 1, lastRow - 1, CONFIG.BOOKING_ROW_WIDTH).getValues();
        for (var r = 0; r < allRows.length; r++) {
          if (String(allRows[r][bookCols2.DAY2_SLOT_ID] || '') === String(slotID) &&
              String(allRows[r][bookCols2.STATUS] || '') === 'Booked') {
            context.booking = {
              confirmationNumber: String(allRows[r][bookCols2.CONFIRMATION_NUMBER] || ''),
              participantName: String(allRows[r][bookCols2.NAME] || '')
            };
            var day1SlotID2 = String(allRows[r][bookCols2.DAY1_SLOT_ID] || '');
            if (day1SlotID2) {
              var day1Rec = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID2);
              if (day1Rec) {
                context.day1 = buildDay1Context(day1Rec);
                context.bloodDrawing = buildBdContext(day1SlotID2);
              }
            }
            break;
          }
        }
      }
    }
  }

  return { success: true, context: context };
}

/**
 * Client-callable (manage_slots): applies Edit Schedule changes ATOMICALLY
 * — every changed field is validated via the centralized
 * validateSchedulingSlot_ engine BEFORE anything is written. If any field
 * fails validation, NOTHING is saved (the previous assignees remain in
 * place) and the specific conflicting slot/type/time is returned. On
 * success, every affected person gets exactly ONE consolidated email
 * listing everything that changed for them, instead of one email per field.
 * @param {string} token
 * @param {Object} edits - {
 *   day1: {slotID, staffEmail}?,
 *   day2: {slotID, staffEmail}?,
 *   bloodDrawing: {slotID, staffEmail, taEmails}?
 * } — include only the fields actually being changed.
 * @return {Object}
 */
function saveScheduleEdits(token, edits) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');
  edits = edits || {};

  var cols = CONFIG.SLOT_COLS;
  var plan = []; // { kind, record, newStaffEmail, newTaEmails, oldStaffEmail, oldTaEmails, summary }
  var errors = [];

  // ---- Day 1 staff ----
  if (edits.day1 && edits.day1.slotID) {
    var d1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, edits.day1.slotID);
    if (!d1Record) {
      errors.push('Day 1 slot ' + edits.day1.slotID + ' no longer exists.');
    } else if (!String(edits.day1.staffEmail || '').trim()) {
      errors.push('Day 1 must have an assigned staff member \u2014 it can\u2019t be left blank.');
    } else {
      var d1OldStaff = String(d1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
      var d1NewStaff = String(edits.day1.staffEmail || '').trim().toLowerCase();
      if (d1NewStaff !== d1OldStaff.toLowerCase()) {
        var d1Excl = sameScheduleExclusionsForDay1_(edits.day1.slotID);
        var d1Validation = validateSchedulingSlot_({
          candidateType: 'Day1',
          dateStr: toIsoDateStr_(d1Record.values[cols.DATE]),
          startTimeStr: toHmStr_(d1Record.values[cols.START_TIME]),
          durationMinutes: Math.round((combineDateAndTime_(d1Record.values[cols.DATE], d1Record.values[cols.END_TIME]).getTime() -
                                       combineDateAndTime_(d1Record.values[cols.DATE], d1Record.values[cols.START_TIME]).getTime()) / 60000),
          staffEmail: d1NewStaff,
          excludeSlotIDs: d1Excl,
          label: 'Day 1 slot ' + edits.day1.slotID
        });
        if (d1Validation.errors.length) {
          errors = errors.concat(d1Validation.errors);
        } else {
          plan.push({ kind: 'day1', record: d1Record, newStaffEmail: d1NewStaff, oldStaffEmail: d1OldStaff });
        }
      }
    }
  }

  // ---- Day 2 staff ----
  if (edits.day2 && edits.day2.slotID) {
    var d2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, edits.day2.slotID);
    if (!d2Record) {
      errors.push('Day 2 slot ' + edits.day2.slotID + ' no longer exists.');
    } else if (!String(edits.day2.staffEmail || '').trim()) {
      errors.push('Day 2 must have an assigned staff member \u2014 it can\u2019t be left blank.');
    } else {
      var d2OldStaff = String(d2Record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');
      var d2NewStaff = String(edits.day2.staffEmail || '').trim().toLowerCase();
      if (d2NewStaff !== d2OldStaff.toLowerCase()) {
        var d2Validation = validateSchedulingSlot_({
          candidateType: 'Day2',
          dateStr: toIsoDateStr_(d2Record.values[cols.DATE]),
          startTimeStr: toHmStr_(d2Record.values[cols.START_TIME]),
          durationMinutes: Math.round((combineDateAndTime_(d2Record.values[cols.DATE], d2Record.values[cols.END_TIME]).getTime() -
                                       combineDateAndTime_(d2Record.values[cols.DATE], d2Record.values[cols.START_TIME]).getTime()) / 60000),
          staffEmail: d2NewStaff,
          excludeSlotIDs: { Day2: edits.day2.slotID },
          label: 'Day 2 slot ' + edits.day2.slotID
        });
        if (d2Validation.errors.length) {
          errors = errors.concat(d2Validation.errors);
        } else {
          plan.push({ kind: 'day2', record: d2Record, newStaffEmail: d2NewStaff, oldStaffEmail: d2OldStaff });
        }
      }
    }
  }

  // ---- Blood Drawing staff + TA(s) ----
  if (edits.bloodDrawing && edits.bloodDrawing.slotID) {
    var bdRecord = findBloodDrawingRow_(edits.bloodDrawing.slotID);
    var bdCols = CONFIG.BLOOD_DRAWING_COLS;
    if (!bdRecord) {
      errors.push('Blood Drawing slot ' + edits.bloodDrawing.slotID + ' no longer exists.');
    } else {
      var bdOldStaff = String(bdRecord.values[bdCols.ASSIGNED_STAFF] || '');
      var bdNewStaff = String(edits.bloodDrawing.staffEmail || '').trim().toLowerCase();
      var bdOldTAs = parseTaEmails_(bdRecord.values[bdCols.ASSIGNED_TA]);
      var bdNewTAs;
      try { bdNewTAs = validateTaEmails_(edits.bloodDrawing.taEmails || bdOldTAs); }
      catch (e) { errors.push(e.message); bdNewTAs = bdOldTAs; }

      var staffChanged = bdNewStaff !== bdOldStaff.toLowerCase();
      var tasChanged = JSON.stringify(bdNewTAs.slice().sort()) !== JSON.stringify(bdOldTAs.slice().sort());
      if (staffChanged || tasChanged) {
        // Requirement #4: validate the new TA's availability and overlapping
        // commitments before saving. Overlapping commitments (double-booking
        // against another slot) is a hard block, via the same centralized
        // validator as everywhere else. Availability (whether the TA has
        // actually submitted themselves as free at this time, via the TA
        // Availability Portal) is surfaced as a non-blocking warning — an
        // admin reassigning a TA directly is a deliberate override, not
        // something that should be silently refused.
        var bdValidation = validateSchedulingSlot_({
          candidateType: 'BloodDrawing',
          dateStr: toIsoDateStr_(bdRecord.values[bdCols.DATE]),
          startTimeStr: toHmStr_(bdRecord.values[bdCols.START_TIME]),
          durationMinutes: Math.round((combineDateAndTime_(bdRecord.values[bdCols.DATE], bdRecord.values[bdCols.END_TIME]).getTime() -
                                       combineDateAndTime_(bdRecord.values[bdCols.DATE], bdRecord.values[bdCols.START_TIME]).getTime()) / 60000),
          staffEmail: bdNewStaff,
          taEmails: bdNewTAs,
          excludeSlotIDs: { BloodDrawing: edits.bloodDrawing.slotID },
          label: 'Blood Drawing slot ' + edits.bloodDrawing.slotID
        });
        if (bdValidation.errors.length) {
          errors = errors.concat(bdValidation.errors);
        } else {
          var addedTAsForAvailCheck = bdNewTAs.filter(function (e) { return bdOldTAs.indexOf(e) === -1; });
          var availWarnings = addedTAsForAvailCheck
            .filter(function (e) { return !taHasSubmittedAvailability_(e, bdRecord.values[bdCols.DATE], bdRecord.values[bdCols.START_TIME], bdRecord.values[bdCols.END_TIME]); })
            .map(function (e) { return (getStaffNameByEmail_(e) || e) + ' has not submitted availability covering this Blood Drawing slot\u2019s time \u2014 assigning them anyway.'; });
          plan.push({
            kind: 'bloodDrawing', record: bdRecord,
            newStaffEmail: bdNewStaff, oldStaffEmail: bdOldStaff,
            newTaEmails: bdNewTAs, oldTaEmails: bdOldTAs,
            warnings: bdValidation.warnings.concat(availWarnings)
          });
        }
      }
    }
  }

  // Atomic: if ANY field failed validation, save NOTHING — every previous
  // assignee stays exactly as they were.
  if (errors.length) {
    return { success: false, message: errors.join('\n'), errors: errors };
  }
  if (!plan.length) {
    return { success: true, message: 'No changes to save.' };
  }

  // Apply every planned change, tracking who's affected for the
  // consolidated email (round 12: one email per person per operation,
  // not one per field).
  var affected = {}; // lowercased email -> {email, items: [line, ...]}
  function track_(email, line) {
    var addr = String(email || '').trim();
    if (!addr) return;
    var key = addr.toLowerCase();
    if (!affected[key]) affected[key] = { email: addr, items: [] };
    affected[key].items.push(line);
  }
  var allWarnings = [];
  var bdReassignments = []; // {bdSummary, removedTAs, addedTAs} — requirement #4

  plan.forEach(function (p) {
    if (p.kind === 'day1') {
      var d1cols = CONFIG.DAY1_EXTRA_COLS;
      var d1summary = p.record.values[cols.SLOT_ID] + ' (' + formatDateForDisplay_(p.record.values[cols.DATE], 'en') + ' ' +
        formatTimeForDisplay_(p.record.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(p.record.values[cols.END_TIME], 'en') + ')';
      p.record.sheet.getRange(p.record.rowIndex, d1cols.ASSIGNED_STAFF + 1).setValue(p.newStaffEmail);
      var oldEventId = String(p.record.values[d1cols.CALENDAR_EVENT_ID] || '');
      var startDT = combineDateAndTime_(p.record.values[cols.DATE], p.record.values[cols.START_TIME]);
      var endDT = combineDateAndTime_(p.record.values[cols.DATE], p.record.values[cols.END_TIME]);
      var newEventId = upsertStaffCalendarEvent_(
        'Day 1 \u2014 ' + CONFIG.EXPERIMENT_NAME.en + ' (' + p.record.values[cols.SLOT_ID] + ')', startDT, endDT, p.newStaffEmail, oldEventId, 'staffReassignment'
      );
      p.record.sheet.getRange(p.record.rowIndex, d1cols.CALENDAR_EVENT_ID + 1).setValue(newEventId);
      var mriSlotID = String(p.record.values[d1cols.MRI_SLOT_ID] || '');
      if (mriSlotID) {
        var mriRecord = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
        if (mriRecord) mriRecord.sheet.getRange(mriRecord.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY1_STAFF + 1).setValue(p.newStaffEmail);
      }
      if (p.oldStaffEmail) track_(p.oldStaffEmail, 'Day 1: ' + d1summary + ' \u2014 removed from your schedule');
      track_(p.newStaffEmail, 'Day 1: ' + d1summary);
    } else if (p.kind === 'day2') {
      var d2cols = CONFIG.DAY2_EXTRA_COLS;
      var d2summary = p.record.values[cols.SLOT_ID] + ' (' + formatDateForDisplay_(p.record.values[cols.DATE], 'en') + ' ' +
        formatTimeForDisplay_(p.record.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(p.record.values[cols.END_TIME], 'en') + ')';
      p.record.sheet.getRange(p.record.rowIndex, d2cols.ASSIGNED_STAFF + 1).setValue(p.newStaffEmail);
      var oldEventId2 = String(p.record.values[d2cols.CALENDAR_EVENT_ID] || '');
      var startDT2 = combineDateAndTime_(p.record.values[cols.DATE], p.record.values[cols.START_TIME]);
      var endDT2 = combineDateAndTime_(p.record.values[cols.DATE], p.record.values[cols.END_TIME]);
      var newEventId2 = upsertStaffCalendarEvent_(
        'Day 2 \u2014 ' + CONFIG.EXPERIMENT_NAME.en + ' (' + p.record.values[cols.SLOT_ID] + ')', startDT2, endDT2, p.newStaffEmail, oldEventId2, 'staffReassignment'
      );
      p.record.sheet.getRange(p.record.rowIndex, d2cols.CALENDAR_EVENT_ID + 1).setValue(newEventId2);
      if (p.oldStaffEmail) track_(p.oldStaffEmail, 'Day 2: ' + d2summary + ' \u2014 removed from your schedule');
      track_(p.newStaffEmail, 'Day 2: ' + d2summary);
    } else if (p.kind === 'bloodDrawing') {
      var bdc = CONFIG.BLOOD_DRAWING_COLS;
      var bdSummary = p.record.values[bdc.SLOT_ID] + ' (' + formatDateForDisplay_(p.record.values[bdc.DATE], 'en') + ' ' +
        formatTimeForDisplay_(p.record.values[bdc.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(p.record.values[bdc.END_TIME], 'en') + ')';
      p.record.sheet.getRange(p.record.rowIndex, bdc.ASSIGNED_STAFF + 1).setValue(p.newStaffEmail);
      p.record.sheet.getRange(p.record.rowIndex, bdc.ASSIGNED_TA + 1).setValue(serializeTaEmails_(p.newTaEmails));
      var oldEventId3 = String(p.record.values[bdc.CALENDAR_EVENT_ID] || '');
      var startDT3 = combineDateAndTime_(p.record.values[bdc.DATE], p.record.values[bdc.START_TIME]);
      var endDT3 = combineDateAndTime_(p.record.values[bdc.DATE], p.record.values[bdc.END_TIME]);
      var participantName = String(p.record.values[bdc.PARTICIPANT_NAME] || '');
      var status = isBooked_(p.record.values[bdc.BOOKED]) ? 'Booked' : 'Scheduled';
      var newEventId3 = upsertBloodDrawingCalendarEvent_(p.record.values[bdc.SLOT_ID], startDT3, endDT3, p.newTaEmails, participantName, oldEventId3, status, p.newStaffEmail);
      p.record.sheet.getRange(p.record.rowIndex, bdc.CALENDAR_EVENT_ID + 1).setValue(newEventId3);

      if (p.oldStaffEmail && p.oldStaffEmail.toLowerCase() !== p.newStaffEmail.toLowerCase()) {
        track_(p.oldStaffEmail, 'Blood Drawing: ' + bdSummary + ' \u2014 removed from your schedule');
      }
      if (p.newStaffEmail) track_(p.newStaffEmail, 'Blood Drawing: ' + bdSummary);

      // Requirement #4: the TA change (as opposed to the staff change
      // above) gets its OWN dedicated notification — to both the previous
      // TA and the new TA — routed through the 'bloodDrawingReassignment'
      // Email Control Matrix entry, independent of 'staffReassignment'.
      var removedTAs = p.oldTaEmails.filter(function (e) { return p.newTaEmails.indexOf(e) === -1; });
      var addedTAs = p.newTaEmails.filter(function (e) { return p.oldTaEmails.indexOf(e) === -1; });
      if (removedTAs.length || addedTAs.length) {
        bdReassignments.push({ bdSummary: bdSummary, removedTAs: removedTAs, addedTAs: addedTAs });
      }
      if (p.warnings && p.warnings.length) allWarnings = allWarnings.concat(p.warnings);
    }
  });

  // Requirement #4: send the previous-TA and new-TA notifications for every
  // Blood Drawing TA change in this save, each carrying exactly what
  // changed (requirement #8).
  bdReassignments.forEach(function (r) {
    notifyBloodDrawingTAReassignment_(r.bdSummary, r.removedTAs, r.addedTAs, session.name);
  });

  // Round 12: ONE consolidated email per affected person, covering every
  // field they were touched by in this single save — not one email per
  // field. Main Admin (and whoever else is routed for 'staffReassignment')
  // gets a single summary of everything that changed.
  var allLines = [];
  Object.keys(affected).forEach(function (key) {
    var person = affected[key];
    var resolved = resolveNotificationRecipients_('staffReassignment', { assignedStaff: [person.email] });
    if (resolved.map(function (e) { return e.toLowerCase(); }).indexOf(key) === -1) return;
    try {
      MailApp.sendEmail(
        person.email,
        emailSubject_('staffReassignment'),
        bilingualBody_(
          'Ihre Terminplan-Zuweisungen wurden aktualisiert:\n\n' + person.items.join('\n'),
          'Your schedule assignments have been updated:\n\n' + person.items.join('\n')
        )
      );
    } catch (err) {
      Logger.log('saveScheduleEdits notification to ' + person.email + ' failed: ' + err);
    }
    allLines = allLines.concat(person.items.map(function (line) { return person.email + ' \u2014 ' + line; }));
  });

  notifyAdminOfChange_('Schedule edited', ['Edited by: ' + session.name].concat(allLines), 'staffReassignment');

  var msg = 'Schedule updated (' + plan.length + ' assignment' + (plan.length === 1 ? '' : 's') + ' changed).';
  if (allWarnings.length) msg += ' ' + allWarnings.length + ' warning(s) — see details.';
  return { success: true, message: msg, warnings: allWarnings };
}

/**
 * ----------------------------------------------------------------------------
 * STAFF REASSIGNMENT
 * ----------------------------------------------------------------------------
 */

/**
 * Client-callable: changes the assigned staff member on an existing Day 1
 * slot (and mirrors it onto the linked MRI slot, if any). Available to any
 * logged-in admin — full "any APPROVED admin" role enforcement arrives with
 * the admin-roles phase; today there's a single shared admin login.
 * @param {string} token
 * @param {string} day1SlotID
 * @param {string} newStaffEmail
 * @return {Object}
 */
/**
 * Client-callable: reassigns the staff member for a Day 1 slot (and mirrors
 * it onto the linked MRI slot). Notifies the previous staff member (removed),
 * the new staff member (with an updated calendar invite), and the Main
 * Admin — per the reassignment-notification requirements.
 */
function reassignStaff(token, day1SlotID, newStaffEmail) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var email = String(newStaffEmail || '').trim().toLowerCase();
  if (!email) return { success: false, message: 'Please select a staff member.' };
  var staffMatch = getApprovedStaffList_().some(function (s) { return s.email.toLowerCase() === email; });
  if (!staffMatch) return { success: false, message: 'That staff member was not found in the Staff sheet.' };

  var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
  if (!day1Record) return { success: false, message: 'That Day 1 slot no longer exists.' };

  var cols = CONFIG.SLOT_COLS;
  var extra = CONFIG.DAY1_EXTRA_COLS;
  var previousStaff = String(day1Record.values[extra.ASSIGNED_STAFF] || '');
  if (previousStaff.toLowerCase() === email) {
    return { success: false, message: email + ' is already assigned to this slot.' };
  }

  var day1Summary = day1SlotID + ' (' + formatDateForDisplay_(day1Record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(day1Record.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(day1Record.values[cols.END_TIME], 'en') + ')';

  // Round 12 fix: reassignment used to skip conflict validation entirely —
  // any approved staff member could be reassigned onto a slot even if they
  // already had an overlapping commitment elsewhere (MRI, Day 1, Day 2, or
  // Blood Drawing). Now runs through the SAME centralized validator as
  // slot creation/editing, excluding this slot itself so it isn't flagged
  // against its own current time. The previous assignee stays in place
  // until validation passes.
  var reassignValidation = validateSchedulingSlot_({
    candidateType: 'Day1',
    dateStr: toIsoDateStr_(day1Record.values[cols.DATE]),
    startTimeStr: toHmStr_(day1Record.values[cols.START_TIME]),
    durationMinutes: Math.round((combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.END_TIME]).getTime() -
                                 combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]).getTime()) / 60000),
    staffEmail: email,
    excludeSlotIDs: { Day1: day1SlotID },
    label: 'Day 1 slot ' + day1SlotID
  });
  if (reassignValidation.errors.length) {
    return { success: false, message: reassignValidation.errors.join('\n'), errors: reassignValidation.errors };
  }

  day1Record.sheet.getRange(day1Record.rowIndex, extra.ASSIGNED_STAFF + 1).setValue(email);

  // Refresh the calendar invite: cancel the old staff member's event, create
  // a new one for the new staff member.
  var oldEventId = String(day1Record.values[extra.CALENDAR_EVENT_ID] || '');
  var day1StartDT = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]);
  var day1EndDT = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.END_TIME]);
  var newEventId = upsertStaffCalendarEvent_(
    'Day 1 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + day1SlotID + ')', day1StartDT, day1EndDT, email, oldEventId, 'staffReassignment'
  );
  day1Record.sheet.getRange(day1Record.rowIndex, extra.CALENDAR_EVENT_ID + 1).setValue(newEventId);

  var mriSlotID = String(day1Record.values[extra.MRI_SLOT_ID] || '');
  if (mriSlotID) {
    var mriRecord = getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID);
    if (mriRecord) {
      mriRecord.sheet.getRange(mriRecord.rowIndex, CONFIG.MRI_EXTRA_COLS.DAY1_STAFF + 1).setValue(email);
    }
  }

  notifyStaffReassignment_('Day 1', day1Summary, previousStaff, email, session.email);

  return { success: true, message: 'Reassigned ' + day1SlotID + ' to ' + email + '.' };
}

/**
 * Client-callable: reassigns the staff member for a Day 2 slot,
 * independently of whatever Day 1 slot(s) it happens to be compatible
 * with. Same notification + calendar behavior as reassignStaff().
 */
function reassignDay2Staff(token, day2SlotID, newStaffEmail) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var email = String(newStaffEmail || '').trim().toLowerCase();
  if (!email) return { success: false, message: 'Please select a staff member.' };
  var staffMatch = getApprovedStaffList_().some(function (s) { return s.email.toLowerCase() === email; });
  if (!staffMatch) return { success: false, message: 'That staff member was not found in the Staff sheet.' };

  var day2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
  if (!day2Record) return { success: false, message: 'That Day 2 slot no longer exists.' };

  var cols = CONFIG.SLOT_COLS;
  var extra = CONFIG.DAY2_EXTRA_COLS;
  var previousStaff = String(day2Record.values[extra.ASSIGNED_STAFF] || '');
  if (previousStaff.toLowerCase() === email) {
    return { success: false, message: email + ' is already assigned to this slot.' };
  }

  var day2Summary = day2SlotID + ' (' + formatDateForDisplay_(day2Record.values[cols.DATE], 'en') + ' ' +
    formatTimeForDisplay_(day2Record.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(day2Record.values[cols.END_TIME], 'en') + ')';

  // Round 12 fix: same centralized validation as reassignStaff() above.
  var reassignValidation = validateSchedulingSlot_({
    candidateType: 'Day2',
    dateStr: toIsoDateStr_(day2Record.values[cols.DATE]),
    startTimeStr: toHmStr_(day2Record.values[cols.START_TIME]),
    durationMinutes: Math.round((combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.END_TIME]).getTime() -
                                 combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]).getTime()) / 60000),
    staffEmail: email,
    excludeSlotIDs: { Day2: day2SlotID },
    label: 'Day 2 slot ' + day2SlotID
  });
  if (reassignValidation.errors.length) {
    return { success: false, message: reassignValidation.errors.join('\n'), errors: reassignValidation.errors };
  }

  day2Record.sheet.getRange(day2Record.rowIndex, extra.ASSIGNED_STAFF + 1).setValue(email);

  var oldEventId = String(day2Record.values[extra.CALENDAR_EVENT_ID] || '');
  var day2StartDT = combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]);
  var day2EndDT = combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.END_TIME]);
  var newEventId = upsertStaffCalendarEvent_(
    'Day 2 — ' + CONFIG.EXPERIMENT_NAME.en + ' (' + day2SlotID + ')', day2StartDT, day2EndDT, email, oldEventId, 'staffReassignment'
  );
  day2Record.sheet.getRange(day2Record.rowIndex, extra.CALENDAR_EVENT_ID + 1).setValue(newEventId);

  notifyStaffReassignment_('Day 2', day2Summary, previousStaff, email, session.email);

  return { success: true, message: 'Reassigned ' + day2SlotID + ' to ' + email + '.' };
}

/**
 * Shared reassignment-notification logic: tells the previous staff member
 * their assignment was removed, tells the new staff member about their
 * updated assignment (a calendar invite follows separately from
 * upsertStaffCalendarEvent_), and notifies the Main Admin either way.
 */
function notifyStaffReassignment_(dayLabel, slotSummary, previousStaffEmail, newStaffEmail, changedByEmail) {
  // Round 6 fix: resolve the FULL recipient set for 'staffReassignment' up
  // front, and let it decide who gets what — including whether the
  // previous/new staff member themselves are notified. "Assigned Staff" is
  // a toggleable recipient group in the matrix by design (per spec); if the
  // Main Admin unchecks it, the affected staff do NOT get a personal notice
  // from here. There is no unconditional carve-out.
  var resolved = resolveNotificationRecipients_('staffReassignment', {
    assignedStaff: buildDedupedGuestList_([previousStaffEmail, newStaffEmail])
  });
  var resolvedLower = resolved.map(function (e) { return String(e).toLowerCase(); });

  if (previousStaffEmail && resolvedLower.indexOf(previousStaffEmail.toLowerCase()) !== -1) {
    try {
      MailApp.sendEmail(
        previousStaffEmail,
        emailSubject_('staffReassignment'),
        bilingualBody_(
          'Ihre ' + dayLabel + '-Zuweisung wurde entfernt/neu vergeben:\n\n' + slotSummary +
          '\n\nSie müssen diese Sitzung nicht mehr übernehmen.',
          'Your ' + dayLabel + ' assignment has been removed/reassigned:\n\n' + slotSummary +
          '\n\nYou no longer need to cover this session.'
        )
      );
    } catch (err) {
      Logger.log('notifyStaffReassignment_ (previous staff) failed: ' + err);
    }
  }

  var newStaffIncluded = newStaffEmail && resolvedLower.indexOf(newStaffEmail.toLowerCase()) !== -1;
  if (newStaffIncluded) {
    try {
      MailApp.sendEmail(
        newStaffEmail,
        emailSubject_('staffReassignment'),
        bilingualBody_(
          'Sie wurden einer ' + dayLabel + '-Sitzung zugewiesen:\n\n' + slotSummary +
          '\n\nOrt: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl,
          'You have been assigned to a ' + dayLabel + ' session:\n\n' + slotSummary +
          '\n\nLocation: ' + CONFIG.LOCATION.address + '\n' + CONFIG.LOCATION.mapsUrl
        )
      );
    } catch (err) {
      Logger.log('notifyStaffReassignment_ (new staff) failed: ' + err);
    }
  }

  // Every OTHER resolved recipient (Main Admin, Admins, etc. — anyone who
  // isn't the previous/new staff, who already got a personal notice above
  // if included) gets the same information as a broadcast.
  var alreadyNotified = {};
  if (previousStaffEmail) alreadyNotified[previousStaffEmail.toLowerCase()] = true;
  if (newStaffIncluded) alreadyNotified[newStaffEmail.toLowerCase()] = true;

  var adminRecipients = resolved.filter(function (e) {
    return !alreadyNotified[String(e).toLowerCase()];
  });

  if (adminRecipients.length) {
    try {
      var previousStaffName = previousStaffEmail ? (getStaffNameByEmail_(previousStaffEmail) || previousStaffEmail) : null;
      var newStaffName = getStaffNameByEmail_(newStaffEmail) || newStaffEmail;
      var changedByName = getStaffNameByEmail_(changedByEmail) || changedByEmail;
      // Round 9: names instead of raw emails, no raw timestamp — see notifyBookingChange_.
      var de = dayLabel + '-Termin: ' + slotSummary + '\nBisheriges Personal: ' + (previousStaffName || '(keines)') +
        '\nNeues Personal: ' + newStaffName + '\nGeändert von: ' + changedByName;
      var en = dayLabel + ' slot: ' + slotSummary + '\nPrevious staff: ' + (previousStaffName || '(none)') +
        '\nNew staff: ' + newStaffName + '\nChanged by: ' + changedByName;
      MailApp.sendEmail(adminRecipients.join(','), emailSubject_('staffReassignment'), bilingualBody_(de, en));
    } catch (err) {
      Logger.log('notifyStaffReassignment_ (admins) failed: ' + err);
    }
  }
}

/**
 * ----------------------------------------------------------------------------
 * ONE-TIME SETUP UTILITY (run manually from the Apps Script editor)
 * ----------------------------------------------------------------------------
 */
/**
 * ============================================================================
 *  2026-08 REQUIREMENTS PASS — NEW FEATURES
 *  (Admin Booking Portal, Blood Drawing / TA module, automatic reminders)
 * ============================================================================
 */

/**
 * When a Day 1 slot is deleted, its auto-created Blood Drawing slot no
 * longer has anything to cover. Unbooked linked slots are deleted outright;
 * a booked one is left in place (with its calendar event) since a TA/
 * participant relationship already exists — it shows up unlinked
 * (Day1SlotID still points at the now-gone slot) for manual follow-up.
 * @param {string} day1SlotID
 */
function cleanUpLinkedBloodDrawingSlots_(day1SlotID) {
  try {
    var sheet = getSheet_(CONFIG.SHEETS.BLOOD_DRAWING);
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    var width = Math.max(13, sheet.getLastColumn());
    var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();

    // Collect everyone affected across all removed slots so we can send a
    // single deduplicated notification (spec round 4, #6).
    var affectedStaff = [];
    var affectedTAs = [];
    var removedSlotIDs = [];
    var anyCalendarEventDeleted = false;

    for (var i = values.length - 1; i >= 0; i--) {
      if (String(values[i][cols.DAY1_SLOT_ID] || '') !== day1SlotID) continue;
      if (isRowDeleted_(CONFIG.SHEETS.BLOOD_DRAWING, values[i])) continue;

      affectedStaff.push(String(values[i][cols.ASSIGNED_STAFF] || ''));
      affectedTAs = affectedTAs.concat(parseTaEmails_(values[i][cols.ASSIGNED_TA]));
      removedSlotIDs.push(String(values[i][cols.SLOT_ID] || ''));

      // Round 4, #6: the linked Blood Drawing slot is ALWAYS removed and its
      // assignments cleared, booked or not (this differs from the earlier
      // "leave booked ones in place" behaviour).
      // Round 5, #5: soft-delete the linked Blood Drawing slot (preserved for
      // audit, excluded from normal views). Its calendar event is still removed.
      var eventId = String(values[i][cols.CALENDAR_EVENT_ID] || '');
      if (eventId) { deleteBloodDrawingCalendarEvent_(eventId); anyCalendarEventDeleted = true; }
      softDeleteById_(CONFIG.SHEETS.BLOOD_DRAWING, cols.SLOT_ID, String(values[i][cols.SLOT_ID] || ''),
        'system', 'Linked Day 1 slot ' + day1SlotID + ' deleted');
    }

    if (removedSlotIDs.length) {
      var recipients = notifyBloodDrawingSlotsRemoved_(removedSlotIDs, affectedStaff, affectedTAs, day1SlotID);
      // Requirement #13: Main Admin always learns a calendar event was deleted.
      if (anyCalendarEventDeleted) {
        notifyMainAdminCalendarEventDeleted_('Blood Drawing slot(s) linked to Day 1 slot ' + day1SlotID + ': ' + removedSlotIDs.join(', '), recipients || []);
      }
    }
  } catch (err) {
    Logger.log('cleanUpLinkedBloodDrawingSlots_ failed: ' + err);
  }
}

/** Soft-delete one specific Blood Drawing slot (used by the deletion picker). */
function cleanUpSpecificBloodDrawingSlot_(bdSlotID, day1SlotID) {
  try {
    var rec = findBloodDrawingRow_(bdSlotID);
    if (!rec) return;
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var eventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
    if (eventId) deleteBloodDrawingCalendarEvent_(eventId);
    softDeleteById_(CONFIG.SHEETS.BLOOD_DRAWING, cols.SLOT_ID, bdSlotID,
      'system', 'Linked Day 1 slot ' + (day1SlotID || '') + ' deleted');
    notifyBloodDrawingSlotsRemoved_(
      [bdSlotID],
      [String(rec.values[cols.ASSIGNED_STAFF] || '')],
      parseTaEmails_(rec.values[cols.ASSIGNED_TA]),
      day1SlotID || ''
    );
    if (eventId) {
      notifyMainAdminCalendarEventDeleted_('Blood Drawing slot ' + bdSlotID, []);
    }
  } catch (err) {
    Logger.log('cleanUpSpecificBloodDrawingSlot_ failed: ' + err);
  }
}

/**
 * Notifies the Blood Drawing staff, all TAs, and the Main Admin that Blood
 * Drawing slot(s) were removed because their linked Day 1 slot was deleted
 * (spec round 4, #6). Bilingual, deduplicated recipients.
 * @return {Array<string>} the resolved recipient list (for req #13 dedup).
 */
function notifyBloodDrawingSlotsRemoved_(slotIDs, staffEmails, taEmails, day1SlotID) {
  try {
    // Round 6 fix: recipients now come from the 'scheduleDeleted' matrix
    // entry (Blood Drawing staff/TAs only get notified if those groups are
    // checked), instead of unconditionally emailing Main Admin + staff + TAs.
    var recipients = resolveNotificationRecipients_('scheduleDeleted', {
      bloodDrawingStaff: staffEmails || [],
      technicalAssistants: taEmails || []
    });
    if (!recipients.length) return recipients;
    var idList = slotIDs.join(', ');
    var de = 'Der Tag-1-Termin ' + day1SlotID + ' wurde gelöscht. Die zugehörigen Blutentnahme-Termine (' +
             idList + ') wurden dadurch ebenfalls entfernt und alle Zuweisungen aufgehoben.';
    var en = 'Day 1 slot ' + day1SlotID + ' was deleted. Its linked Blood Drawing slot(s) (' + idList +
             ') were removed and all assignments cleared as a result.';
    MailApp.sendEmail(recipients.join(','), emailSubject_('scheduleDeleted'), bilingualBody_(de, en));
    return recipients;
  } catch (err) {
    Logger.log('notifyBloodDrawingSlotsRemoved_ failed: ' + err);
    return [];
  }
}

/**
 * ----------------------------------------------------------------------------
 * ADMIN BOOKING PORTAL (spec section 3)
 * ----------------------------------------------------------------------------
 * Lets any admin with 'manage_bookings' create a booking on a participant's
 * behalf. Identical workflow to the participant flow, except the email is
 * optional: if provided, the normal confirmation email is sent; if omitted,
 * the booking (ID, passcode, calendar entries, admin notification) is still
 * created, just without a participant email.
 */
function adminCreateBooking(token, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_bookings');

  var lang = normalizeLang_(data && data.lang);
  // Round 7: the participant's LANGUAGE PREFERENCE (which slots they're
  // eligible to be booked into / rescheduled to) is independent from
  // `lang` above (which is only the admin UI's display-formatting
  // language for the confirmation email). Defaults to 'any' — no
  // preference — if the admin doesn't pick one.
  var participantLanguage = normalizeSlotLanguage_(data && data.language);
  if (!data) return { success: false, message: 'No booking data received.' };
  if (!data.day1SlotID) return { success: false, message: 'Please select a Day 1 slot.' };
  if (!data.day2SlotID) return { success: false, message: 'Please select a Day 2 slot.' };
  if (!data.title || CONFIG.TITLES.indexOf(String(data.title).trim()) === -1) {
    return { success: false, message: 'Please select a title.' };
  }
  if (!data.gender || getGenderOptions().indexOf(String(data.gender).trim()) === -1) {
    return { success: false, message: 'Please select a gender.' };
  }
  if (!data.firstName || !data.firstName.trim()) return { success: false, message: 'Please enter the participant\'s first name.' };
  if (!data.lastName || !data.lastName.trim()) return { success: false, message: 'Please enter the participant\'s last name.' };

  var hasEmail = !!(data.email && data.email.trim());
  if (hasEmail && !validateEmailFormat_(data.email.trim())) {
    return { success: false, message: 'Please enter a valid email address, or leave it blank.' };
  }

  var firstName = data.firstName.trim();
  var lastName = data.lastName.trim();
  var name = (firstName + ' ' + lastName).trim();
  var gender = String(data.gender).trim();
  var title = String(data.title).trim();
  var email = hasEmail ? data.email.trim().toLowerCase() : '';
  var day1SlotID = String(data.day1SlotID).trim();
  var day2SlotID = String(data.day2SlotID).trim();
  var cols = CONFIG.SLOT_COLS;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy processing another booking. Please try again in a moment.' };
  }

  try {
    if (hasEmail && email !== CONFIG.EMAIL_DUPLICATE_EXCEPTION.toLowerCase() && emailAlreadyBooked_(email)) {
      return { success: false, message: 'This email address has already been used to complete a booking.' };
    }

    var day1Record = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1SlotID);
    if (!day1Record) return { success: false, message: 'The selected Day 1 slot no longer exists.' };
    if (isBooked_(day1Record.values[cols.BOOKED])) return { success: false, message: 'That Day 1 slot has already been booked.' };

    var day2Record = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2SlotID);
    if (!day2Record) return { success: false, message: 'The selected Day 2 slot no longer exists.' };

    var day1DateTime = combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]);
    var day2DateTime = combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]);
    if (!isSlotPairCompatible_(day1DateTime, day2DateTime)) {
      return { success: false, message: 'That Day 2 slot is not compatible with the selected Day 1 slot.' };
    }
    if (isBooked_(day2Record.values[cols.BOOKED])) return { success: false, message: 'That Day 2 slot has already been booked.' };

    day1Record.sheet.getRange(day1Record.rowIndex, cols.BOOKED + 1).setValue(true);
    day2Record.sheet.getRange(day2Record.rowIndex, cols.BOOKED + 1).setValue(true);

    var confirmationNumber = generateConfirmationNumber_();
    var passcode = generatePasscode_();
    var comments = String(data.comments || '').trim().slice(0, 2000);

    getSheet_(CONFIG.SHEETS.BOOKINGS).appendRow([
      new Date(), '', name, email, day1SlotID, day2SlotID,
      confirmationNumber, passcode, comments, 'Booked', '', new Date(),
      title, session.email, gender, firstName, lastName, participantLanguage
    ]);

    var day1Details = {
      date: formatDateForDisplay_(day1Record.values[cols.DATE], lang),
      startTime: formatTimeForDisplay_(day1Record.values[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(day1Record.values[cols.END_TIME], lang)
    };
    var day2Details = {
      date: formatDateForDisplay_(day2Record.values[cols.DATE], lang),
      startTime: formatTimeForDisplay_(day2Record.values[cols.START_TIME], lang),
      endTime: formatTimeForDisplay_(day2Record.values[cols.END_TIME], lang)
    };

    var day1Staff = String(day1Record.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    var day2Staff = String(day2Record.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');

    // Requirement #5: automatically update the linked Blood Drawing slot —
    // add the Booking ID and move it from Available to Booked.
    linkBloodDrawingToBooking_(day1SlotID, confirmationNumber, name);

    upsertParticipantCalendarEvents_(
      day1SlotID, day2SlotID, name, email,
      combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.START_TIME]),
      combineDateAndTime_(day1Record.values[cols.DATE], day1Record.values[cols.END_TIME]),
      combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.START_TIME]),
      combineDateAndTime_(day2Record.values[cols.DATE], day2Record.values[cols.END_TIME]),
      day1Staff, day2Staff, 'Booked', title
    );

    if (hasEmail) {
      try {
        sendConfirmationEmail_(email, name, day1Details, day2Details, lang, {
          confirmationNumber: confirmationNumber,
          passcode: passcode,
          comments: comments
        });
      } catch (emailErr) {
        Logger.log('adminCreateBooking confirmation email failed: ' + emailErr);
      }
    }

    notifyBookingChange_('Admin-created booking', [
      'Created by admin: ' + session.name,
      'Participant: ' + name + (hasEmail ? '' : ' (no email provided)'),
      'Confirmation Number: ' + confirmationNumber,
      'Day 1 slot: ' + day1SlotID + ' (' + day1Details.date + ' ' + day1Details.startTime + '–' + day1Details.endTime + ')',
      'Day 2 slot: ' + day2SlotID + ' (' + day2Details.date + ' ' + day2Details.startTime + '–' + day2Details.endTime + ')'
    ], [day1Staff, day2Staff], 'participantBooking');

    return {
      success: true,
      message: 'Booking created.',
      confirmationNumber: confirmationNumber,
      passcode: passcode,
      emailSent: hasEmail
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable (manage_bookings): lets an admin edit a participant's own
 * name/email/title (spec: "Edit participant details"). Mirrors the
 * participant self-service updateParticipantDetails(), but authenticated by
 * admin session instead of Confirmation Number + Passcode.
 */
function adminUpdateParticipantDetails(token, confirmationNumber, name, email, title) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_bookings');

  var record = findBookingByConfirmation_(confirmationNumber);
  if (!record) return { success: false, message: 'Booking not found.' };
  var cols = CONFIG.BOOKING_COLS;
  if (String(record.values[cols.STATUS]) === 'Cancelled') {
    return { success: false, message: 'This booking has already been cancelled.' };
  }

  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  title = String(title || '').trim();
  if (!name) return { success: false, message: 'Name is required.' };
  if (email && !validateEmailFormat_(email)) return { success: false, message: 'Please enter a valid email address.' };
  if (title && CONFIG.TITLES.indexOf(title) === -1) return { success: false, message: 'Invalid title.' };

  record.sheet.getRange(record.rowIndex, cols.NAME + 1).setValue(name);
  record.sheet.getRange(record.rowIndex, cols.EMAIL + 1).setValue(email);
  if (title) record.sheet.getRange(record.rowIndex, cols.TITLE + 1).setValue(title);
  record.sheet.getRange(record.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());

  notifyAdminOfChange_('Participant details updated (admin)', [
    'Confirmation Number: ' + confirmationNumber,
    'Updated by: ' + session.name,
    'Name: ' + name,
    'Email: ' + (email || '(none)')
  ], 'participantDetailsUpdated');

  return { success: true, message: 'Participant details updated.' };
}

/**
 * Client-callable (manage_bookings): records a participant's next available
 * date(s) directly from the Admin Portal (spec section 3), independent of
 * the cancellation flow that already captures this.
 */
function adminRecordNextAvailability(token, confirmationNumber, availabilityDates, dontKnow) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_bookings');

  var record = findBookingByConfirmation_(confirmationNumber);
  if (!record) return { success: false, message: 'Booking not found.' };
  var cols = CONFIG.BOOKING_COLS;

  var text = dontKnow ? "Don't know yet" : String(availabilityDates || '').trim();
  record.sheet.getRange(record.rowIndex, cols.AVAILABILITY + 1).setValue(text);
  record.sheet.getRange(record.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());
  return { success: true, message: 'Availability recorded.' };
}

/**
 * ----------------------------------------------------------------------------
 * BLOOD DRAWING MODULE (spec sections 4, 8, 11)
 * ----------------------------------------------------------------------------
 * A separate booking domain, scoped to Technical Assistants (TAs). Blood
 * Drawing slots may only ever be assigned to TAs. A 30-minute Blood Drawing
 * slot is auto-created whenever a Day 1 slot is created, covering the first
 * 30 minutes of that Day 1 experiment; authorized users can add more
 * manually.
 */

/** Reads every TA (role === 'TA') from the Admins sheet, active only. */
function getTAList_() {
  var cols = CONFIG.ADMIN_COLS;
  return getAllAdminRecords_()
    .filter(function (r) { return String(r.values[cols.ROLE]) === 'TA' && isBooked_(r.values[cols.ACTIVE]); })
    .map(function (r) { return { name: String(r.values[cols.NAME]), email: String(r.values[cols.EMAIL]) }; });
}

/**
 * Parses a Blood Drawing slot's ASSIGNED_TA cell (a comma-separated list) into
 * an array of clean, lower-cased, deduplicated TA emails (round 4, #1/#7).
 * @param {*} cellValue
 * @return {Array<string>}
 */
function parseTaEmails_(cellValue) {
  return buildDedupedGuestList_(String(cellValue || '').split(',').map(function (e) {
    return e.trim();
  }).filter(Boolean));
}

/** Serialises a list of TA emails back into the comma-separated cell format. */
function serializeTaEmails_(emails) {
  return buildDedupedGuestList_(emails || []).join(',');
}

/** Validates that every email in a list is a known active TA; returns the cleaned list or throws. */
function validateTaEmails_(emails) {
  var taByEmail = {};
  getTAList_().forEach(function (t) { taByEmail[t.email.toLowerCase()] = t; });
  var clean = [];
  (emails || []).forEach(function (e) {
    var key = String(e || '').trim().toLowerCase();
    if (!key) return;
    if (!taByEmail[key]) {
      throw new Error('Blood Drawing slots may only be assigned to Technical Assistants (TAs). "' + e + '" is not a TA.');
    }
    clean.push(taByEmail[key].email);
  });
  return buildDedupedGuestList_(clean);
}

/** Client-callable: TA roster, for Blood Drawing assignment dropdowns. Requires either Blood Drawing permission. */
function getTAOptions(token) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('manage_blood_drawing_schedules') === -1 && perms.indexOf('book_blood_drawing') === -1) {
    throw new Error('Your role does not have permission to view the TA roster.');
  }
  return getTAList_();
}

/**
 * Auto-creates a Blood Drawing slot covering the first
 * CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES minutes of a newly created Day 1
 * slot. Called right after a Day 1 row is written. Never throws — a
 * failure here must not roll back the Day 1 slot itself.
 * @param {string} day1SlotID
 * @param {Date} day1DateVal
 * @param {Date} day1StartVal
 * @param {string} createdBy
 */
function autoCreateBloodDrawingSlot_(day1SlotID, day1DateVal, day1StartVal, createdBy, day1StaffEmail, suppressNotification) {
  try {
    var dateStr = toIsoDateStr_(day1DateVal);
    var startStr = toHmStr_(day1StartVal);
    var endStr = addMinutesToTimeStr_(startStr, CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES);

    // Round 5, #4: validate the generated Blood Drawing slot through the same
    // centralized validator BEFORE creating it. The Blood Drawing Staff
    // defaults to the Day 1 staff member, so a same-staff conflict against an
    // overlapping Blood Drawing slot is possible and must be reported.
    var validation = validateSchedulingSlot_({
      candidateType: 'BloodDrawing',
      dateStr: dateStr,
      startTimeStr: startStr,
      durationMinutes: CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES,
      staffEmail: day1StaffEmail || '',
      taEmails: [],
      label: 'Auto-generated Blood Drawing slot'
    });

    var slotId = generateNextSlotId_(CONFIG.SHEETS.BLOOD_DRAWING, 'BD');
    getSheet_(CONFIG.SHEETS.BLOOD_DRAWING).appendRow([
      slotId, parseDateInput_(dateStr), parseTimeInput_(startStr), parseTimeInput_(endStr),
      false, '', '', day1SlotID, '', '', createdBy || 'system', new Date(), ''
    ]);
    // Round 12: auto-created Blood Drawing slots deliberately do NOT also
    // fire 'bloodDrawingSlotCreated' — they're a mechanical side-effect of
    // Day 1 creation (already covered by 'scheduleCreated'/'staffAssignment'
    // for the Day 1 slot itself), and autoAssignBloodDrawingStaffAndTA_
    // below already sends 'bloodDrawingAssignment' or 'bloodDrawingUnassigned'.
    // Firing a third email here for the same action would be exactly the
    // kind of redundant-email noise the consolidated-email work is meant to
    // eliminate. 'bloodDrawingSlotCreated' fires only for explicit manual/
    // bulk creation (see createBloodDrawingSlotInternal_), which is a
    // distinct admin action with nothing else notifying about it.
    //
    // Round 13 fix: bulk operations (pushing several MRI slots to schedule
    // in one action) used to fire this per-slot immediately, so a bulk push
    // of N slots sent up to N separate Blood-Drawing emails — a real
    // contributor to hitting Apps Script's daily email quota
    // ("Service invoked too many times for one day: email"). When
    // suppressNotification is set, the assignment/TA result is returned
    // instead of emailed, so the caller can batch it into ONE consolidated
    // notice for the whole operation (see notifyBloodDrawingAssignmentsBatch_).
    var bdResult = autoAssignBloodDrawingStaffAndTA_(slotId, String(day1StaffEmail || ''), suppressNotification);

    return { slotID: slotId, warnings: validation.warnings, errors: validation.errors, bloodDrawingAssignment: bdResult };
  } catch (err) {
    Logger.log('autoCreateBloodDrawingSlot_ failed for ' + day1SlotID + ': ' + err);
    return { slotID: '', warnings: [], errors: [] };
  }
}

/**
 * Requirement #1: links the Blood Drawing slot that was already auto-
 * created at MRI-creation time (see autoCreateBloodDrawingSlotForMri_) to
 * the Day 1 slot just written for it, refreshing its date/time if the
 * admin used a non-default "Time Before MRI" (so it no longer matches the
 * estimate used when the MRI slot was first created) and defaulting its
 * assigned staff to the Day 1 staff member (unknown until now). Falls back
 * to the old create-on-the-spot behaviour for legacy MRI slots with no
 * linked Blood Drawing slot (created before this feature existed).
 */
function linkOrCreateBloodDrawingForSchedule_(mriSlotID, day1SlotID, day1DateVal, day1StartVal, createdBy, day1StaffEmail, suppressNotification) {
  try {
    var rec = findBloodDrawingRowByMriSlotID_(mriSlotID);
    if (!rec) {
      return autoCreateBloodDrawingSlot_(day1SlotID, day1DateVal, day1StartVal, createdBy, day1StaffEmail, suppressNotification);
    }

    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var newDateStr = toIsoDateStr_(day1DateVal);
    var newStartStr = toHmStr_(day1StartVal);
    var newEndStr = addMinutesToTimeStr_(newStartStr, CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES);
    var oldDateStr = toIsoDateStr_(rec.values[cols.DATE]);
    var oldStartStr = toHmStr_(rec.values[cols.START_TIME]);
    var timeChanged = (oldDateStr !== newDateStr) || (oldStartStr !== newStartStr);

    rec.sheet.getRange(rec.rowIndex, cols.DAY1_SLOT_ID + 1).setValue(day1SlotID);

    if (!timeChanged) {
      // Time already matches what was assumed at MRI-creation time — just
      // record the Day 1 staff member as the default Blood Drawing staff;
      // leave any already-assigned TA and calendar event untouched.
      if (day1StaffEmail) rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_STAFF + 1).setValue(day1StaffEmail);
      var curTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
      var slotIdStr = String(rec.values[cols.SLOT_ID]);
      var summary = slotIdStr + ' (' + formatDateForDisplay_(rec.values[cols.DATE], 'en') + ' ' +
        formatTimeForDisplay_(rec.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(rec.values[cols.END_TIME], 'en') + ')';
      return {
        slotID: slotIdStr,
        bloodDrawingAssignment: {
          slotID: slotIdStr, summary: summary, assigned: curTAs.length > 0,
          staffEmail: day1StaffEmail || '', taEmail: curTAs[0] || ''
        }
      };
    }

    // Time actually shifted from the MRI-creation-time estimate (a custom
    // "Time Before MRI" was used) — move the slot and re-check TA
    // availability at the new time via the same existing rule.
    var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
    if (oldEventId) deleteBloodDrawingCalendarEvent_(oldEventId);
    rec.sheet.getRange(rec.rowIndex, cols.DATE + 1).setValue(parseDateInput_(newDateStr));
    rec.sheet.getRange(rec.rowIndex, cols.START_TIME + 1).setValue(parseTimeInput_(newStartStr));
    rec.sheet.getRange(rec.rowIndex, cols.END_TIME + 1).setValue(parseTimeInput_(newEndStr));
    rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue('');
    rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue('');

    var bdResult = autoAssignBloodDrawingStaffAndTA_(String(rec.values[cols.SLOT_ID]), day1StaffEmail || '', suppressNotification);
    return { slotID: String(rec.values[cols.SLOT_ID]), bloodDrawingAssignment: bdResult };
  } catch (err) {
    Logger.log('linkOrCreateBloodDrawingForSchedule_ failed for MRI ' + mriSlotID + ': ' + err);
    return { slotID: '', bloodDrawingAssignment: null };
  }
}

/**
 * Round 5, #4: PRE-CHECK the Blood Drawing slot that a Day 1 slot WOULD
 * generate, before the Day 1 slot is created, so the schedule-creation path
 * can block on a same-staff / same-TA Blood Drawing conflict (or a
 * not-permitted BD overlap) and surface warnings. Does not write anything.
 * @return {{errors, warnings, staffConflict, taConflict}}
 */
function previewGeneratedBloodDrawingValidation_(day1DateStr, day1StartStr, day1StaffEmail, excludeOpts) {
  excludeOpts = excludeOpts || {};
  var startStr = day1StartStr;
  return validateSchedulingSlot_({
    candidateType: 'BloodDrawing',
    dateStr: day1DateStr,
    startTimeStr: startStr,
    durationMinutes: CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES,
    staffEmail: day1StaffEmail || '',
    taEmails: [],
    excludeSlotIDs: {
      BloodDrawing: excludeOpts.excludeBloodDrawingSlotID || null,
      MRI: excludeOpts.excludeMriSlotID || null,
      Day1: excludeOpts.excludeDay1SlotID || null
    },
    label: 'The Blood Drawing slot this Day 1 slot will generate'
  });
}

/** Client-callable: every Blood Drawing slot from today onward (manage_blood_drawing_schedules, book_blood_drawing, or view). */
function getBloodDrawingSlots(token) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('manage_blood_drawing_schedules') === -1 && perms.indexOf('book_blood_drawing') === -1 &&
      perms.indexOf('view') === -1) {
    throw new Error('Your role does not have permission to view Blood Drawing slots.');
  }
  var cols = CONFIG.BLOOD_DRAWING_COLS;
  var mriCol = bdMriColumn_(); // 1-based sheet column
  var rows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var out = [];
  rows.forEach(function (row) {
    if (!row[cols.SLOT_ID]) return;
    if (!isOnOrAfterToday_(row[cols.DATE])) return;
    var taEmails = parseTaEmails_(row[cols.ASSIGNED_TA]);
    var hasParticipant = isBooked_(row[cols.BOOKED]) || !!String(row[cols.PARTICIPANT_CONFIRMATION] || '').trim();
    // Available = TA assigned + not booked; Unavailable = no TA; Booked = participant.
    var status = hasParticipant ? 'Booked' : (taEmails.length ? 'Available' : 'Unavailable');
    var mriSlotID = String(row[mriCol - 1] || '');
    var day1SlotID = String(row[cols.DAY1_SLOT_ID] || '');
    // Related Slot ID prefers MRI (auto-link); falls back to Day 1 for display.
    var relatedSlotID = mriSlotID || day1SlotID;
    // Read-only when this ID points at a real MRI slot (auto/manual MRI link).
    var relatedSlotLocked = !!(mriSlotID && getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID));
    out.push({
      slotID: String(row[cols.SLOT_ID]),
      date: formatDateForDisplay_(row[cols.DATE], 'en'),
      startTime: formatTimeForDisplay_(row[cols.START_TIME], 'en'),
      endTime: formatTimeForDisplay_(row[cols.END_TIME], 'en'),
      rawDate: toIsoDateStr_(row[cols.DATE]),
      rawStart: toHmStr_(row[cols.START_TIME]),
      rawEnd: toHmStr_(row[cols.END_TIME]),
      booked: hasParticipant,
      status: status,
      assignedTAs: taEmails,
      assignedTANames: taEmails.map(function (e) { return getStaffNameByEmail_(e); }),
      assignedStaff: String(row[cols.ASSIGNED_STAFF] || ''),
      day1SlotID: day1SlotID,
      mriSlotID: mriSlotID,
      relatedSlotID: relatedSlotID,
      relatedSlotLocked: relatedSlotLocked,
      participantName: String(row[cols.PARTICIPANT_NAME] || ''),
      participantConfirmation: String(row[cols.PARTICIPANT_CONFIRMATION] || '')
    });
  });
  return out;
}

/** Client-callable (manage_blood_drawing_schedules): create a manual Blood Drawing slot. */
function createBloodDrawingSlot(token, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_blood_drawing_schedules');
  return createBloodDrawingSlotInternal_(session, data);
}

/**
 * Shared implementation behind createBloodDrawingSlot and
 * bulkCreateBloodDrawingSlots (round 10). Assigned staff is entirely
 * OPTIONAL here — leave data.assignedStaff blank to create an unstaffed
 * slot (staff can be added any time afterwards via Edit).
 */
function createBloodDrawingSlotInternal_(session, data) {
  var parsed = validateSlotInputWithDuration_(data);
  if (parsed.error) return { success: false, message: parsed.error };

  // Round 5, #1: manual Blood Drawing creation goes through the centralized
  // validator too. An unconfirmed (confirmForce) create is blocked on any
  // not-permitted overlap or same-staff/same-TA conflict.
  data = data || {};
  var validation = validateSchedulingSlot_({
    candidateType: 'BloodDrawing',
    dateStr: toIsoDateStr_(parsed.date),
    startTimeStr: toHmStr_(parsed.start),
    durationMinutes: Math.round((combineDateAndTime_(parsed.date, parsed.end).getTime() -
                                 combineDateAndTime_(parsed.date, parsed.start).getTime()) / 60000),
    staffEmail: String(data.assignedStaff || '').trim().toLowerCase(),
    taEmails: (data.taEmails || []),
    label: 'This Blood Drawing slot'
  });
  if (validation.errors.length) {
    return { success: false, message: validation.errors.join('\n'), errors: validation.errors, warnings: validation.warnings };
  }

  var slotId = generateNextSlotId_(CONFIG.SHEETS.BLOOD_DRAWING, 'BD');
  var staffEmail = String(data.assignedStaff || '').trim().toLowerCase();
  var taSerialized = '';
  try { taSerialized = serializeTaEmails_(validateTaEmails_(data.taEmails || [])); }
  catch (e) { return { success: false, message: e.message }; }
  getSheet_(CONFIG.SHEETS.BLOOD_DRAWING).appendRow([
    slotId, parsed.date, parsed.start, parsed.end, false, taSerialized, '', '', '', '', session.email, new Date(), staffEmail
  ]);

  // Round 12: 'Blood Drawing Slot Created' is now its own controllable
  // event (previously creating a Blood Drawing slot sent no notification
  // of any kind).
  var summary = slotId + ' (' + formatDateForDisplay_(parsed.date, 'en') + ' ' +
    formatTimeForDisplay_(parsed.start, 'en') + '\u2013' + formatTimeForDisplay_(parsed.end, 'en') + ')';
  notifyAdminOfChange_(
    'Blood Drawing slot created',
    ['Blood Drawing slot: ' + summary, 'Created by: ' + session.name],
    'bloodDrawingSlotCreated'
  );

  return { success: true, slotID: slotId, warnings: validation.warnings };
}

/**
 * Client-callable (manage_blood_drawing_schedules): create several Blood
 * Drawing slots in one call (round 10). Each candidate is validated and
 * created independently — if one fails, the rest still proceed — and the
 * per-candidate results are returned so the front-end can report exactly
 * which ones succeeded. Staff is optional per row, same as the single-slot
 * path.
 * @param {string} token
 * @param {Array<Object>} candidates - [{date, startTime, durationMinutes, assignedStaff}]
 * @return {Object} {success, results: [{success, slotID?, message?, input}]}
 */
function bulkCreateBloodDrawingSlots(token, candidates) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_blood_drawing_schedules');

  if (!candidates || !candidates.length) {
    return { success: false, message: 'Add at least one Blood Drawing slot first.' };
  }

  var results = (candidates || []).map(function (c) {
    var r = createBloodDrawingSlotInternal_(session, c);
    r.input = c;
    return r;
  });
  var successCount = results.filter(function (r) { return r.success; }).length;

  return {
    success: successCount > 0,
    results: results,
    message: successCount + ' of ' + results.length + ' Blood Drawing slot(s) created.'
  };
}

/** Finds a Blood Drawing row by SlotID. */
function findBloodDrawingRow_(slotID) {
  return getSlotByFullRow_(CONFIG.SHEETS.BLOOD_DRAWING, slotID);
}

/**
 * ----------------------------------------------------------------------------
 * BLOOD DRAWING <-> MRI LINKAGE (2026-08 requirements pass, #1)
 * ----------------------------------------------------------------------------
 * A Blood Drawing slot is now auto-created the moment its MRI slot is
 * created (previously this happened later, when the MRI slot was pushed
 * into a full schedule and a Day 1 slot was written). Since no Day 1 slot
 * exists yet at MRI-creation time, the link is carried via a dedicated
 * "MRISlotID" column (added on demand via ensureNamedColumn_, so existing
 * spreadsheets self-heal without a manual migration) rather than the
 * existing DAY1_SLOT_ID column. DAY1_SLOT_ID is filled in later, once the
 * MRI slot is actually pushed into a schedule and its Day 1 slot exists
 * (see createScheduleFromMriInternal_).
 */
function bdMriColumn_() {
  return ensureNamedColumn_(CONFIG.SHEETS.BLOOD_DRAWING, 'MRISlotID');
}

/** Finds the Blood Drawing row linked to a given MRI slot (via the MRISlotID column), or null. */
function findBloodDrawingRowByMriSlotID_(mriSlotID) {
  if (!mriSlotID) return null;
  var col = bdMriColumn_();
  var rows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[bdCols.SLOT_ID]) continue;
    if (String(row[col - 1] || '') === String(mriSlotID)) {
      return getSlotByFullRow_(CONFIG.SHEETS.BLOOD_DRAWING, String(row[bdCols.SLOT_ID]));
    }
  }
  return null;
}

/** Finds the Blood Drawing row linked to a given Day 1 slot (via DAY1_SLOT_ID), or null. */
function findBloodDrawingRowByDay1SlotID_(day1SlotID) {
  if (!day1SlotID) return null;
  var rows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row[bdCols.SLOT_ID]) continue;
    if (String(row[bdCols.DAY1_SLOT_ID] || '') === String(day1SlotID)) {
      return getSlotByFullRow_(CONFIG.SHEETS.BLOOD_DRAWING, String(row[bdCols.SLOT_ID]));
    }
  }
  return null;
}

/**
 * Requirement #5: when a participant's booking is confirmed, automatically
 * update the Blood Drawing slot linked to their Day 1 slot — add the
 * Booking ID and move it from Available to Booked. Does not touch TA/staff
 * assignment (that stays governed by Edit Schedule / the TA Availability
 * Portal, an independent axis from "is a participant attached"). Never
 * throws — a failure here must not roll back the booking itself.
 * @param {string} day1SlotID
 * @param {string} confirmationNumber
 * @param {string} participantName
 */
function linkBloodDrawingToBooking_(day1SlotID, confirmationNumber, participantName) {
  try {
    var rec = findBloodDrawingRowByDay1SlotID_(day1SlotID);
    if (!rec) return;
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(true);
    rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_CONFIRMATION + 1).setValue(confirmationNumber || '');
    rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_NAME + 1).setValue(participantName || '');
    var taEmails = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
    var staffEmail = String(rec.values[cols.ASSIGNED_STAFF] || '');
    var slotID = String(rec.values[cols.SLOT_ID]);
    var startDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
    var endDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
    var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
    var newEventId = upsertBloodDrawingCalendarEvent_(
      slotID, startDT, endDT, taEmails, participantName || '', oldEventId, 'Booked', staffEmail
    );
    rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(newEventId);

    // Dedicated matrix event (not generic bloodDrawingUpdates).
    var when = formatSlotDateTimeForEmail_(rec.values[cols.DATE], rec.values[cols.START_TIME], rec.values[cols.END_TIME]);
    notifyAdminOfChange_(
      'Blood Drawing slot booked',
      [
        'Blood Drawing slot: ' + slotID + ' (' + when + ')',
        'Confirmation number: ' + (confirmationNumber || '(none)'),
        'Participant: ' + (participantName || '(none)'),
        'Day 1 slot: ' + day1SlotID
      ],
      'bloodDrawingSlotBooked',
      {
        assignedStaff: staffEmail ? [staffEmail] : [],
        bloodDrawingStaff: staffEmail ? [staffEmail] : [],
        technicalAssistants: taEmails
      }
    );
  } catch (err) {
    Logger.log('linkBloodDrawingToBooking_ failed for ' + day1SlotID + ': ' + err);
  }
}

/**
 * Requirement #12: when a booking is cancelled/unbooked, return its linked
 * Blood Drawing slot to the appropriate available state — clears the
 * Booking ID/participant tie-in and marks it Available again. The TA/staff
 * assignment is left as-is (an independent axis — see
 * linkBloodDrawingToBooking_), so the slot stays ready for the next
 * participant routed to that Day 1 slot without losing its staffing.
 * Never throws — a failure here must not roll back the cancellation.
 * @param {string} day1SlotID
 */
function unlinkBloodDrawingFromBooking_(day1SlotID, options) {
  try {
    options = options || {};
    var rec = findBloodDrawingRowByDay1SlotID_(day1SlotID);
    if (!rec) return;
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var prevConf = String(rec.values[cols.PARTICIPANT_CONFIRMATION] || '');
    if (!prevConf && !isBooked_(rec.values[cols.BOOKED])) return; // nothing to undo
    if (options.skipUnlink) return;
    rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(false);
    rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_CONFIRMATION + 1).setValue('');
    rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_NAME + 1).setValue('');
    var taEmails = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
    var staffEmail = String(rec.values[cols.ASSIGNED_STAFF] || '');
    var slotID = String(rec.values[cols.SLOT_ID]);
    var startDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
    var endDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
    var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
    var newEventId = upsertBloodDrawingCalendarEvent_(
      slotID, startDT, endDT, taEmails, '', oldEventId, 'Available', staffEmail
    );
    rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(newEventId);

    if (!options.suppressNotification) {
      var when = formatSlotDateTimeForEmail_(rec.values[cols.DATE], rec.values[cols.START_TIME], rec.values[cols.END_TIME]);
      notifyAdminOfChange_(
        'Blood Drawing slot unbooked',
        [
          'Blood Drawing slot: ' + slotID + ' (' + when + ')',
          'Previous confirmation number: ' + (prevConf || '(none)'),
          'Day 1 slot: ' + day1SlotID
        ],
        'bloodDrawingSlotUnbooked',
        {
          assignedStaff: staffEmail ? [staffEmail] : [],
          bloodDrawingStaff: staffEmail ? [staffEmail] : [],
          technicalAssistants: taEmails
        }
      );
    }
  } catch (err) {
    Logger.log('unlinkBloodDrawingFromBooking_ failed for ' + day1SlotID + ': ' + err);
  }
}

/**
 * Auto-creates a Blood Drawing slot the moment an MRI slot is created,
 * covering the first CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES minutes of where
 * Day 1 WOULD start by default (MRI start minus the default "time before
 * MRI" offset — the actual Day 1 slot doesn't exist yet). Checks the
 * existing TA availability rule (findAvailableNonConflictingTA_, the same
 * one used everywhere else) and auto-assigns a TA if one is free at that
 * time; otherwise the slot is left with no TA (still created, just
 * unassigned). Never throws — a failure here must not roll back the MRI
 * slot itself.
 * @param {string} mriSlotID
 * @param {Date} mriDateVal
 * @param {Date} mriStartVal
 * @param {number} timeBeforeMriMinutes
 * @param {string} createdBy
 * @param {boolean} suppressNotification - if true, returns the assignment
 *   result instead of emailing, so a bulk caller can send ONE consolidated
 *   notice for the whole batch (see notifyBloodDrawingAssignmentsBatch_).
 * @return {{slotID: string, bloodDrawingAssignment: ?Object}}
 */
function autoCreateBloodDrawingSlotForMri_(mriSlotID, mriDateVal, mriStartVal, timeBeforeMriMinutes, createdBy, suppressNotification) {
  try {
    var offset = parseInt(timeBeforeMriMinutes, 10) || CONFIG.DAY1_TIME_BEFORE_MRI_DEFAULT_MINUTES;
    var mriStartDT = combineDateAndTime_(mriDateVal, mriStartVal);
    var day1StartDT = new Date(mriStartDT.getTime() - offset * 60000);
    var dateStr = toIsoDateStr_(day1StartDT);
    var startStr = toHmStr_(day1StartDT);
    var endStr = addMinutesToTimeStr_(startStr, CONFIG.BLOOD_DRAWING_DEFAULT_MINUTES);

    var slotId = generateNextSlotId_(CONFIG.SHEETS.BLOOD_DRAWING, 'BD');
    getSheet_(CONFIG.SHEETS.BLOOD_DRAWING).appendRow([
      slotId, parseDateInput_(dateStr), parseTimeInput_(startStr), parseTimeInput_(endStr),
      false, '', '', '', '', '', createdBy || 'system', new Date(), ''
    ]);
    // Record the MRI link in the dedicated column (appended after the fixed
    // 13-column layout above, so this appendRow's shorter array is fine —
    // Sheets leaves the trailing cell blank until we set it explicitly).
    var mriCol = bdMriColumn_();
    var rec = findBloodDrawingRow_(slotId);
    if (rec) rec.sheet.getRange(rec.rowIndex, mriCol).setValue(mriSlotID);

    // Requirement #1: check TA availability using the existing rule and
    // auto-assign if someone is free; otherwise leave it Unassigned. No
    // staff assignment yet — the Day 1 staff member isn't chosen until the
    // MRI slot is later pushed into a schedule.
    var bdResult = autoAssignBloodDrawingStaffAndTA_(slotId, '', suppressNotification);

    return { slotID: slotId, bloodDrawingAssignment: bdResult };
  } catch (err) {
    Logger.log('autoCreateBloodDrawingSlotForMri_ failed for ' + mriSlotID + ': ' + err);
    return { slotID: '', bloodDrawingAssignment: null };
  }
}

/**
 * Client-callable (manage_admins or manage_roles — Main-Admin-level): returns
 * records from a chosen data sheet filtered by deletion status, for the audit
 * browser (spec round 5, #5). scope = 'active' | 'deleted' | 'all'.
 */
function getRecordsByStatus(token, sheetKey, scope) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var allowed = {
    MRI: CONFIG.SHEETS.MRI, DAY1: CONFIG.SHEETS.DAY1, DAY2: CONFIG.SHEETS.DAY2,
    BLOOD_DRAWING: CONFIG.SHEETS.BLOOD_DRAWING, BOOKINGS: CONFIG.SHEETS.BOOKINGS,
    TA_AVAILABILITY: CONFIG.SHEETS.TA_AVAILABILITY, ADMINS: CONFIG.SHEETS.ADMINS
  };
  var sheetName = allowed[sheetKey];
  if (!sheetName) return { success: false, message: 'Unknown record type.' };

  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { success: true, headers: [], rows: [] };

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || ''); });
  var all = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var map = ensureSoftDeleteColumns_(sheetName);
  var statusIdx = map.Status - 1;

  scope = String(scope || 'active').toLowerCase();
  var out = [];
  all.forEach(function (row) {
    var deleted = String(row[statusIdx] || '').trim().toLowerCase() === 'deleted';
    if (scope === 'active' && deleted) return;
    if (scope === 'deleted' && !deleted) return;
    // Format cells to display strings so dates/times are readable client-side.
    out.push(row.map(function (v) {
      if (Object.prototype.toString.call(v) === '[object Date]') {
        return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
      }
      return v === '' || v === null || v === undefined ? '' : String(v);
    }));
  });

  return { success: true, headers: headers, rows: out, count: out.length };
}

/**
 * Client-callable (manage_admins): restore a soft-deleted record (clears its
 * Deleted status). Keyed by the sheet's first column (ID) value.
 */
function restoreDeletedRecord(token, sheetKey, idValue) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');
  var allowed = {
    MRI: CONFIG.SHEETS.MRI, DAY1: CONFIG.SHEETS.DAY1, DAY2: CONFIG.SHEETS.DAY2,
    BLOOD_DRAWING: CONFIG.SHEETS.BLOOD_DRAWING, BOOKINGS: CONFIG.SHEETS.BOOKINGS,
    TA_AVAILABILITY: CONFIG.SHEETS.TA_AVAILABILITY, ADMINS: CONFIG.SHEETS.ADMINS
  };
  var sheetName = allowed[sheetKey];
  if (!sheetName) return { success: false, message: 'Unknown record type.' };

  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, message: 'No records.' };
  var map = ensureSoftDeleteColumns_(sheetName);
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).trim() === String(idValue).trim()) {
      var r = i + 2;
      sheet.getRange(r, map.Status).setValue('');
      sheet.getRange(r, map.DeletedBy).setValue('');
      sheet.getRange(r, map.DeletedOn).setValue('');
      sheet.getRange(r, map.DeletionReason).setValue('Restored by ' + session.email + ' on ' + new Date());
      return { success: true, message: 'Record restored.' };
    }
  }
  return { success: false, message: 'Record not found.' };
}

/** Client-callable (manage_blood_drawing_schedules): edit an unbooked Blood Drawing slot's time. */
/**
 * Client-callable (manage_blood_drawing_schedules): edit any of a Blood
 * Drawing slot's fields — date, start/end time, assigned Blood Drawing staff,
 * and the list of assigned TAs (round 4, #1). Updates the sheet and the
 * calendar event, and notifies affected staff + TAs (both removed and newly
 * added) with deduplicated recipients.
 * @param {string} token
 * @param {string} slotID
 * @param {Object} data - { date, startTime, endTime?, durationMinutes?,
 *                          assignedStaff?, taEmails? (array) }
 */
function editBloodDrawingSlot(token, slotID, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_blood_drawing_schedules');

  var rec = findBloodDrawingRow_(slotID);
  if (!rec) return { success: false, message: 'Blood Drawing slot not found.' };
  var cols = CONFIG.BLOOD_DRAWING_COLS;
  data = data || {};

  // Snapshot previous assignees so we can notify additions AND removals.
  var prevTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
  var prevStaff = String(rec.values[cols.ASSIGNED_STAFF] || '');

  // --- Date / time ---
  var newDate = rec.values[cols.DATE];
  var newStart = rec.values[cols.START_TIME];
  var newEnd = rec.values[cols.END_TIME];
  if (data.date || data.startTime) {
    // Accept either an explicit end time or a duration.
    if (data.endTime) {
      var pDate = parseDateInput_(data.date || toIsoDateStr_(rec.values[cols.DATE]));
      var pStart = parseTimeInput_(data.startTime || toHmStr_(rec.values[cols.START_TIME]));
      var pEnd = parseTimeInput_(data.endTime);
      if (!pDate || !pStart || !pEnd) return { success: false, message: 'Please provide a valid date and start/end time.' };
      if (combineDateAndTime_(pDate, pEnd).getTime() <= combineDateAndTime_(pDate, pStart).getTime()) {
        return { success: false, message: 'End time must be after start time.' };
      }
      newDate = pDate; newStart = pStart; newEnd = pEnd;
    } else {
      var parsed = validateSlotInputWithDuration_({
        date: data.date || toIsoDateStr_(rec.values[cols.DATE]),
        startTime: data.startTime || toHmStr_(rec.values[cols.START_TIME]),
        durationMinutes: data.durationMinutes ||
          Math.round((combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]).getTime() -
                      combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]).getTime()) / 60000)
      });
      if (parsed.error) return { success: false, message: parsed.error };
      newDate = parsed.date; newStart = parsed.start; newEnd = parsed.end;
    }
  }

  // --- Assigned Blood Drawing staff ---
  var newStaff = prevStaff;
  if (data.hasOwnProperty('assignedStaff')) {
    newStaff = String(data.assignedStaff || '').trim().toLowerCase();
  }

  // --- Assigned TAs (multiple) ---
  var newTAs = prevTAs;
  if (data.hasOwnProperty('taEmails')) {
    try {
      newTAs = validateTaEmails_(data.taEmails || []);
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  // Round 5, #1/#3: run the edited slot through the centralized validator
  // (excluding itself) before persisting. Blocks not-permitted overlaps and
  // same-staff / same-TA conflicts against other slots.
  var editValidation = validateSchedulingSlot_({
    candidateType: 'BloodDrawing',
    dateStr: toIsoDateStr_(newDate),
    startTimeStr: toHmStr_(newStart),
    durationMinutes: Math.round((combineDateAndTime_(newDate, newEnd).getTime() -
                                 combineDateAndTime_(newDate, newStart).getTime()) / 60000),
    staffEmail: newStaff,
    taEmails: newTAs,
    excludeSlotIDs: { BloodDrawing: slotID },
    label: 'This Blood Drawing slot'
  });
  if (editValidation.errors.length) {
    return { success: false, message: editValidation.errors.join('\n'), errors: editValidation.errors, warnings: editValidation.warnings };
  }

  // Persist to the sheet.
  rec.sheet.getRange(rec.rowIndex, cols.DATE + 1).setValue(newDate);
  rec.sheet.getRange(rec.rowIndex, cols.START_TIME + 1).setValue(newStart);
  rec.sheet.getRange(rec.rowIndex, cols.END_TIME + 1).setValue(newEnd);
  rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_STAFF + 1).setValue(newStaff);
  rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue(serializeTaEmails_(newTAs));

  // Related Slot ID (MRISlotID column): editable only when not auto-linked.
  var mriCol = bdMriColumn_();
  var existingMri = String(rec.values[mriCol - 1] || '');
  if (data.hasOwnProperty('relatedSlotID') && !existingMri) {
    var related = String(data.relatedSlotID || '').trim();
    rec.sheet.getRange(rec.rowIndex, mriCol).setValue(related);
  }

  // Update the calendar event.
  var startDT = combineDateAndTime_(newDate, newStart);
  var endDT = combineDateAndTime_(newDate, newEnd);
  var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
  var participantName = String(rec.values[cols.PARTICIPANT_NAME] || '');
  var status = isBooked_(rec.values[cols.BOOKED]) ? 'Booked' : 'Scheduled';
  var newEventId = upsertBloodDrawingCalendarEvent_(slotID, startDT, endDT, newTAs, participantName, oldEventId, status, newStaff);
  rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(newEventId);

  // Notify everyone affected — previous + new staff, and previous + new TAs
  // (so both removed and added people hear about it), deduplicated.
  // Prefer dedicated reassignment event when TAs actually changed.
  var taChanged = prevTAs.slice().sort().join(',') !== newTAs.slice().sort().join(',');
  notifyBloodDrawingChange_(slotID, [prevStaff, newStaff], prevTAs.concat(newTAs), taChanged ? 'reassignment' : 'update');

  return { success: true, message: 'Blood Drawing slot updated.' };
}

/** Client-callable (manage_blood_drawing_schedules): delete a Blood Drawing slot. Booked slots cannot be deleted. */
function deleteBloodDrawingSlot(token, slotID) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_blood_drawing_schedules');

  var rec = findBloodDrawingRow_(slotID);
  if (!rec) return { success: false, message: 'Blood Drawing slot not found.' };
  var cols = CONFIG.BLOOD_DRAWING_COLS;
  var hasParticipant = isBooked_(rec.values[cols.BOOKED]) || !!String(rec.values[cols.PARTICIPANT_CONFIRMATION] || '').trim();
  if (hasParticipant) {
    return { success: false, message: 'Booked Blood Drawing slots cannot be deleted. Cancel the booking first.' };
  }
  var eventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
  if (eventId) deleteStaffCalendarEvent_(eventId);

  var summary = slotID + ' (' + formatDateNumeric_(rec.values[cols.DATE]) + ' ' +
    formatTimeForDisplay_(rec.values[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(rec.values[cols.END_TIME], 'en') + ')';
  var affectedStaff = String(rec.values[cols.ASSIGNED_STAFF] || '') ? [String(rec.values[cols.ASSIGNED_STAFF])] : [];
  var affectedTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);

  deleteSlotRow_(CONFIG.SHEETS.BLOOD_DRAWING, slotID, session.email, 'Blood Drawing slot deleted');

  // Round 7 fix: this used to delete silently with no notification at all.
  // Now routed through the 'bloodDrawingSlotDeleted' matrix entry, so the
  // assigned TA(s)/staff and Main Admin are notified per the configured
  // routing, same as every other slot-deletion action.
  var recipients = resolveNotificationRecipients_('bloodDrawingSlotDeleted', {
    assignedStaff: affectedStaff,
    bloodDrawingStaff: affectedStaff,
    technicalAssistants: affectedTAs
  });
  if (recipients.length) {
    try {
      var details = 'Blood Drawing slot: ' + summary + '\nDeleted by: ' + session.name;
      var content = renderEmailTemplate_('bloodDrawingSlotDeleted', { Details: details });
      MailApp.sendEmail(recipients.join(','), content.subject, content.body);
    } catch (err) {
      Logger.log('deleteBloodDrawingSlot notification failed: ' + err);
    }
  }
  // Requirement #13: Main Admin always learns a calendar event was deleted.
  if (eventId) notifyMainAdminCalendarEventDeleted_('Blood Drawing slot ' + slotID, recipients);

  return { success: true, message: 'Blood Drawing slot deleted.' };
}

/**
 * Client-callable ('book_blood_drawing'): assign a TA to a Blood Drawing
 * slot, and optionally attach a participant (by Confirmation Number) if
 * this is being booked for a specific person. Creates/updates the
 * dedicated Blood Drawing calendar event and invites the TA.
 */
function bookBloodDrawingSlot(token, slotID, taEmails, participantConfirmationNumber) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'book_blood_drawing');

  var rec = findBloodDrawingRow_(slotID);
  if (!rec) return { success: false, message: 'Blood Drawing slot not found.' };
  var cols = CONFIG.BLOOD_DRAWING_COLS;

  // Accept either a single email (legacy) or an array of emails (round 4).
  var requested = Array.isArray(taEmails) ? taEmails : [taEmails];
  var cleanTAs;
  try {
    cleanTAs = validateTaEmails_(requested);
  } catch (e) {
    return { success: false, message: e.message };
  }
  if (!cleanTAs.length) {
    return { success: false, message: 'Please assign at least one Technical Assistant (TA).' };
  }

  var prevTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);

  var participantName = '';
  var confNum = String(participantConfirmationNumber || '').trim();
  if (confNum) {
    var booking = findBookingByConfirmation_(confNum);
    if (booking) participantName = String(booking.values[CONFIG.BOOKING_COLS.NAME] || '');
  }

  var startDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
  var endDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
  var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
  var existingStaffEmail = String(rec.values[cols.ASSIGNED_STAFF] || '');
  var eventId = upsertBloodDrawingCalendarEvent_(slotID, startDT, endDT, cleanTAs, participantName, oldEventId, 'Booked', existingStaffEmail);

  rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(true);
  rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue(serializeTaEmails_(cleanTAs));
  rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(eventId);
  rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_CONFIRMATION + 1).setValue(confNum);
  rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_NAME + 1).setValue(participantName);
  // Round 12: distinguish a first-time TA assignment from a reassignment
  // (changing who's already assigned) so they route through separate,
  // independently controllable matrix events.
  var taKind = prevTAs.length ? 'reassignment' : 'assignment';
  notifyBloodDrawingChange_(slotID, [existingStaffEmail], prevTAs.concat(cleanTAs), taKind);

  return { success: true, message: 'Blood Drawing slot booked.' };
}

/**
 * Client-callable ('book_blood_drawing'): assign the SAME Technical
 * Assistant(s) to several Blood Drawing slots in one action (round 11).
 * Each slot is booked independently via bookBloodDrawingSlot, so one
 * failing doesn't stop the rest. A participant confirmation number only
 * makes sense for a single slot (one participant, one slot) — pass it as
 * '' when booking more than one slot.
 * @param {string} token
 * @param {Array<string>} slotIDs
 * @param {Array<string>} taEmails
 * @param {string} participantConfirmationNumber - only applied if exactly one slotID is given
 * @return {Object} {success, results: [{success, slotID, message}]}
 */
function bulkBookBloodDrawingSlots(token, slotIDs, taEmails, participantConfirmationNumber) {
  if (!slotIDs || !slotIDs.length) {
    return { success: false, message: 'Select at least one Blood Drawing slot first.' };
  }
  var confNum = (slotIDs.length === 1) ? participantConfirmationNumber : '';
  var results = slotIDs.map(function (slotID) {
    var r = bookBloodDrawingSlot(token, slotID, taEmails, confNum);
    r.slotID = slotID;
    return r;
  });
  var successCount = results.filter(function (r) { return r.success; }).length;
  return {
    success: successCount > 0,
    results: results,
    message: successCount + ' of ' + results.length + ' Blood Drawing slot(s) booked.'
  };
}

/** Client-callable ('book_blood_drawing'): cancel/unbook a Blood Drawing booking, keeping the slot itself. */
function cancelBloodDrawingBooking(token, slotID) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'book_blood_drawing');

  var rec = findBloodDrawingRow_(slotID);
  if (!rec) return { success: false, message: 'Blood Drawing slot not found.' };
  var cols = CONFIG.BLOOD_DRAWING_COLS;
  var eventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
  if (eventId) deleteBloodDrawingCalendarEvent_(eventId);

  var prevTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
  var prevStaff = String(rec.values[cols.ASSIGNED_STAFF] || '');

  rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(false);
  rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue('');
  rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue('');
  rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_CONFIRMATION + 1).setValue('');
  rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_NAME + 1).setValue('');
  // Let the (now removed) TAs and staff know the booking was cancelled.
  notifyBloodDrawingChange_(slotID, [prevStaff], prevTAs, 'update');
  return { success: true, message: 'Blood Drawing booking cancelled.' };
}

/**
 * Creates/updates the dedicated Blood Drawing calendar event, invites the
 * assigned Blood Drawing Staff AND all assigned TAs (round 4, #1/#7:
 * multiple TAs), and applies a stable colour. Recipients are deduplicated so
 * nobody is invited twice.
 * @param {string} slotID
 * @param {Date} startDateTime
 * @param {Date} endDateTime
 * @param {Array<string>} taEmails - list of TA emails (may be empty)
 * @param {string} participantName
 * @param {string} oldEventId
 * @param {string} status
 * @param {string} staffEmail - Blood Drawing staff email
 * @return {string} new event ID, or ''
 */
function upsertBloodDrawingCalendarEvent_(slotID, startDateTime, endDateTime, taEmails, participantName, oldEventId, status, staffEmail) {
  try {
    var calendar = CalendarApp.getDefaultCalendar();
    if (oldEventId) {
      try {
        var oldEvent = calendar.getEventById(oldEventId);
        if (oldEvent) oldEvent.deleteEvent();
      } catch (delErr) {
        Logger.log('Could not delete old Blood Drawing calendar event ' + oldEventId + ': ' + delErr);
      }
    }
    var taList = buildDedupedGuestList_(taEmails || []);
    var taNames = taList.length
      ? taList.map(function (e) { return getStaffNameByEmail_(e) || e; }).join(', ')
      : '(unassigned)';
    var staffName = staffEmail ? (getStaffNameByEmail_(staffEmail) || '') : '';
    var title = 'Blood Drawing\nTA: ' + taNames + (staffName ? '\nStaff: ' + staffName : '');
    // Round 6: guest list is now config-driven (Calendar Invitation Settings)
    // instead of always hardcoding staff+TAs — the Main Admin can change who
    // gets invited to Blood Drawing calendar events without code changes.
    // The default routing reproduces the previous behaviour exactly.
    var guests = resolveCalendarInvitees_('bloodDrawingSlotCreated', {
      bloodDrawingStaff: staffEmail ? [staffEmail] : [],
      technicalAssistants: taList
    });
    var event = calendar.createEvent(title, startDateTime, endDateTime, {
      description: 'Blood Drawing slot ' + slotID + '\n' +
        'Assigned Staff: ' + (staffName || '(unassigned)') + '\n' +
        'Assigned TA(s): ' + taNames + '\n' +
        (participantName ? 'Participant: ' + participantName + '\n' : '') +
        'Status: ' + status + '\n' +
        'Location: ' + CONFIG.LOCATION.address,
      guests: guests.join(','),
      sendInvites: guests.length > 0
    });
    applyStaffColor_(event, taList[0] || staffEmail);
    return event.getId();
  } catch (err) {
    Logger.log('upsertBloodDrawingCalendarEvent_ failed: ' + err);
    return '';
  }
}

/** Deletes a Blood Drawing calendar event by ID, if it exists. Never throws. */
function deleteBloodDrawingCalendarEvent_(eventId) {
  if (!eventId) return;
  try {
    var event = CalendarApp.getDefaultCalendar().getEventById(eventId);
    if (event) event.deleteEvent();
  } catch (err) {
    Logger.log('deleteBloodDrawingCalendarEvent_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * TA AVAILABILITY PORTAL (spec section 11)
 * ----------------------------------------------------------------------------
 */

/** Client-callable ('book_blood_drawing' — i.e. any TA): submit/replace the caller's own availability for a date. */
function submitTAAvailability(token, date, startTime, endTime, notes) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'book_blood_drawing');
  if (session.role !== 'TA') {
    // Non-TA roles with book_blood_drawing (e.g. MainAdmin) can still use
    // this on a TA's behalf isn't supported here; availability is self-service.
    throw new Error('Only Technical Assistants can submit their own availability.');
  }

  var parsedDate = parseDateInput_(date);
  var parsedStart = parseTimeInput_(startTime);
  var parsedEnd = parseTimeInput_(endTime);
  if (!parsedDate || !parsedStart || !parsedEnd) {
    return { success: false, message: 'Please provide a valid date and time range.' };
  }

  var sheet = getSheet_(CONFIG.SHEETS.TA_AVAILABILITY);
  var cols = CONFIG.TA_AVAILABILITY_COLS;
  var lastRow = sheet.getLastRow();
  var targetDateStr = toIsoDateStr_(parsedDate);
  var updated = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
    for (var i = 0; i < values.length; i++) {
      var rowEmail = String(values[i][cols.TA_EMAIL] || '').trim().toLowerCase();
      var rowDate = toIsoDateStr_(values[i][cols.DATE]);
      if (rowEmail === session.email.toLowerCase() && rowDate === targetDateStr) {
        var r = i + 2;
        sheet.getRange(r, cols.START_TIME + 1).setValue(parsedStart);
        sheet.getRange(r, cols.END_TIME + 1).setValue(parsedEnd);
        sheet.getRange(r, cols.NOTES + 1).setValue(String(notes || ''));
        sheet.getRange(r, cols.UPDATED_AT + 1).setValue(new Date());
        updated = true;
        break;
      }
    }
  }
  if (!updated) {
    sheet.appendRow([session.email, session.name, parsedDate, parsedStart, parsedEnd, String(notes || ''), new Date()]);
  }

  notifyTAAvailabilitySaved_(session, targetDateStr, startTime, endTime);
  return { success: true, message: 'Your availability has been saved.' };
}

/** Client-callable ('view_ta_availability' or 'manage_ta_availability'): every TA's submitted availability, from today onward. */
function getTAAvailability(token) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('view_ta_availability') === -1 && perms.indexOf('manage_ta_availability') === -1) {
    throw new Error('Your role does not have permission to view TA availability.');
  }
  var sheet = getSheet_(CONFIG.SHEETS.TA_AVAILABILITY);
  var cols = CONFIG.TA_AVAILABILITY_COLS;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  var today = new Date(); today.setHours(0, 0, 0, 0);
  return values
    .filter(function (row) { return row[cols.DATE] instanceof Date && row[cols.DATE] >= today; })
    .map(function (row) {
      return {
        taEmail: String(row[cols.TA_EMAIL]),
        taName: String(row[cols.TA_NAME]),
        date: formatDateForDisplay_(row[cols.DATE], 'en'),
        startTime: formatTimeForDisplay_(row[cols.START_TIME], 'en'),
        endTime: formatTimeForDisplay_(row[cols.END_TIME], 'en'),
        notes: String(row[cols.NOTES] || '')
      };
    });
}

/** Sends a bilingual (German + English) notification to authorized admins whenever a TA saves/updates their availability. */
function notifyTAAvailabilitySaved_(session, dateStr, startTime, endTime) {
  // Round 6 fix: recipients now come purely from the 'taAvailabilitySubmitted'
  // matrix entry — no unconditional addition of TA-availability-permission
  // holders, since the Main Admin should be able to fully control who
  // receives this notice via the matrix, with no exceptions.
  var recipients = resolveNotificationRecipients_('taAvailabilitySubmitted', {
    technicalAssistants: [session.email]
  });
  if (!recipients.length) return;
  try {
    MailApp.sendEmail(
      recipients.join(','),
      emailSubject_('taAvailabilitySubmitted') + ' — ' + session.name + ' — ' + dateStr,
      bilingualBody_(
        session.name + ' hat seine/ihre Verfügbarkeit aktualisiert.\n' +
        'Datum: ' + dateStr + '\nZeit: ' + startTime + ' – ' + endTime,
        session.name + ' has updated their availability.\n' +
        'Date: ' + dateStr + '\nTime: ' + startTime + ' – ' + endTime
      )
    );
  } catch (err) {
    Logger.log('notifyTAAvailabilitySaved_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * TA AVAILABILITY PORTAL — PER-SLOT SELF-SERVICE (2026-08 requirements pass, #6)
 * ----------------------------------------------------------------------------
 * Replaces the admin-only "Book Slot(s) (assigns Technical Assistant(s))"
 * panel: instead of an admin picking slots and TAs, a Technical Assistant
 * browses the actual Blood Drawing slots and marks themselves available (or
 * withdraws) for however many they like, edits any of their own picks, and
 * saves everything together in ONE operation with ONE consolidated email —
 * never one slot/email at a time. TA assignment/reassignment BY AN ADMIN
 * (on someone else's behalf) remains in Edit Schedule (requirement #4).
 */

/**
 * Client-callable ('book_blood_drawing'): the full "poll grid" view of
 * upcoming Blood Drawing availability — every upcoming slot as a column
 * (grouped Month → Day → individual time slot, for the three-tier header),
 * every known Technical Assistant as a row, with a checkmark/cross per
 * cell showing whether that TA is currently assigned to that slot, and a
 * Totals row. Also returns the calling TA's own current picks, to pre-fill
 * the entry checkboxes above the grid.
 * @param {string} token
 * @return {Object} {months, slotIDs, slotBookingIDs, tas, totals, meName, meSlotIDs}
 */
function getTABloodDrawingAvailabilityGrid(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'book_blood_drawing');
  var cols = CONFIG.BLOOD_DRAWING_COLS;
  var tz = Session.getScriptTimeZone();
  var rows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING)
    .filter(function (row) { return row[cols.SLOT_ID] && isOnOrAfterToday_(row[cols.DATE]); });

  // Chronological order, same convention as every other slot listing.
  rows.sort(function (a, b) {
    return combineDateAndTime_(a[cols.DATE], a[cols.START_TIME]).getTime() -
           combineDateAndTime_(b[cols.DATE], b[cols.START_TIME]).getTime();
  });

  var meLower = session.email.toLowerCase();
  var slots = rows.map(function (row) {
    var hasParticipant = isBooked_(row[cols.BOOKED]) || !!String(row[cols.PARTICIPANT_CONFIRMATION] || '').trim();
    return {
      slotID: String(row[cols.SLOT_ID]),
      monthLabel: Utilities.formatDate(row[cols.DATE], tz, 'MMMM yyyy'),
      dayLabel: Utilities.formatDate(row[cols.DATE], tz, 'EEE. d'),
      timeLabel: formatTimeForDisplay_(row[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(row[cols.END_TIME], 'en'),
      bookingID: String(row[cols.PARTICIPANT_CONFIRMATION] || ''),
      booked: hasParticipant,
      taEmails: parseTaEmails_(row[cols.ASSIGNED_TA])
    };
  });

  // Group into Month -> Day -> leaf slot, for the three-tier header (matches
  // the reference "doodle poll" layout: month spans its days, each day
  // spans its own time-slot columns).
  var months = [];
  var monthMap = {};
  var dayMap = {};
  slots.forEach(function (s) {
    if (!monthMap[s.monthLabel]) {
      monthMap[s.monthLabel] = { label: s.monthLabel, days: [] };
      months.push(monthMap[s.monthLabel]);
    }
    var dayKey = s.monthLabel + '::' + s.dayLabel;
    if (!dayMap[dayKey]) {
      dayMap[dayKey] = { label: s.dayLabel, slots: [] };
      monthMap[s.monthLabel].days.push(dayMap[dayKey]);
    }
    dayMap[dayKey].slots.push({
      slotID: s.slotID,
      timeLabel: s.timeLabel,
      bookingID: s.bookingID,
      booked: s.booked
    });
  });

  // Roster: every known active TA, so someone with zero assignments still
  // shows a full row of crosses — the calling TA's own row sorts first.
  var roster = getTAList_().slice().sort(function (a, b) {
    var aMe = a.email.toLowerCase() === meLower;
    var bMe = b.email.toLowerCase() === meLower;
    if (aMe !== bMe) return aMe ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  var tas = roster.map(function (t) {
    var tLower = t.email.toLowerCase();
    return {
      name: t.name,
      isMe: tLower === meLower,
      cells: slots.map(function (s) { return s.taEmails.some(function (e) { return e.toLowerCase() === tLower; }); })
    };
  });

  var totals = slots.map(function (s, idx) {
    return tas.reduce(function (sum, t) { return sum + (t.cells[idx] ? 1 : 0); }, 0);
  });

  var meSlotIDs = slots.filter(function (s) {
    return s.taEmails.some(function (e) { return e.toLowerCase() === meLower; });
  }).map(function (s) { return s.slotID; });

  return {
    months: months,
    slotIDs: slots.map(function (s) { return s.slotID; }),
    slotBookingIDs: slots.map(function (s) { return s.bookingID; }),
    slotBookedFlags: slots.map(function (s) { return !!s.booked; }),
    tas: tas,
    totals: totals,
    meName: session.name,
    meSlotIDs: meSlotIDs
  };
}


/**
 * Client-callable ('book_blood_drawing'): applies a batch of availability
 * changes for the CALLING TA in one operation — {slotID, available} pairs,
 * where available=true means "assign me to this slot" and available=false
 * means "remove me from this slot". All changes are applied together under
 * a single lock, then ONE consolidated email is sent listing everything
 * that changed, routed through the Email Control Matrix
 * ('taAvailabilitySubmitted'). If a slot has no Booking ID yet when the
 * calling TA is added to it, one is generated automatically (spec #6).
 * @param {string} token
 * @param {Array<{slotID: string, available: boolean}>} changes
 * @return {Object}
 */
function saveTABloodDrawingAvailability(token, changes) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'book_blood_drawing');
  changes = (changes || []).filter(function (c) { return c && c.slotID; });
  if (!changes.length) return { success: true, message: 'No changes to save.' };

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var applied = []; // {slotID, summary, available, bookingID?}
    var errors = [];

    changes.forEach(function (c) {
      var rec = findBloodDrawingRow_(c.slotID);
      if (!rec) { errors.push('Blood Drawing slot ' + c.slotID + ' no longer exists.'); return; }
      var curTAs = parseTaEmails_(rec.values[cols.ASSIGNED_TA]);
      var meLower = session.email.toLowerCase();
      var alreadyIn = curTAs.some(function (e) { return e.toLowerCase() === meLower; });
      var summary = c.slotID + ' (' + formatDateForDisplay_(rec.values[cols.DATE], 'en') + ' ' +
        formatTimeForDisplay_(rec.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(rec.values[cols.END_TIME], 'en') + ')';

      if (c.available) {
        if (alreadyIn) return; // no-op — already available for this one
        // Don't let a TA double-book themselves onto an overlapping slot.
        var validation = validateSchedulingSlot_({
          candidateType: 'BloodDrawing',
          dateStr: toIsoDateStr_(rec.values[cols.DATE]),
          startTimeStr: toHmStr_(rec.values[cols.START_TIME]),
          durationMinutes: Math.round((combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]).getTime() -
                                       combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]).getTime()) / 60000),
          staffEmail: '',
          taEmails: [session.email],
          excludeSlotIDs: { BloodDrawing: c.slotID },
          label: 'Blood Drawing slot ' + c.slotID
        });
        if (validation.errors.length) { errors.push(validation.errors.join(' ')); return; }

        var newTAs = curTAs.concat([session.email]);
        rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue(serializeTaEmails_(newTAs));
        rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(true);

        // Requirement #6: auto-generate/assign the Booking ID if this slot
        // doesn't already have one (e.g. no participant has been routed to
        // it yet — a TA claiming it directly still needs a trackable ID).
        var bookingID = String(rec.values[cols.PARTICIPANT_CONFIRMATION] || '');
        if (!bookingID) {
          bookingID = generateConfirmationNumber_();
          rec.sheet.getRange(rec.rowIndex, cols.PARTICIPANT_CONFIRMATION + 1).setValue(bookingID);
        }

        var staffEmail = String(rec.values[cols.ASSIGNED_STAFF] || '');
        var participantName = String(rec.values[cols.PARTICIPANT_NAME] || '');
        var startDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
        var endDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
        var oldEventId = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
        var newEventId = upsertBloodDrawingCalendarEvent_(c.slotID, startDT, endDT, newTAs, participantName, oldEventId, 'Booked', staffEmail);
        rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(newEventId);

        applied.push({ slotID: c.slotID, summary: summary, available: true, bookingID: bookingID });
      } else {
        if (!alreadyIn) return; // no-op — wasn't on it anyway
        var remainingTAs = curTAs.filter(function (e) { return e.toLowerCase() !== meLower; });
        rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue(serializeTaEmails_(remainingTAs));
        var stillHasParticipant = !!String(rec.values[cols.PARTICIPANT_CONFIRMATION] || '');
        if (!remainingTAs.length && !stillHasParticipant) {
          rec.sheet.getRange(rec.rowIndex, cols.BOOKED + 1).setValue(false);
        }
        var staffEmail2 = String(rec.values[cols.ASSIGNED_STAFF] || '');
        var participantName2 = String(rec.values[cols.PARTICIPANT_NAME] || '');
        var startDT2 = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
        var endDT2 = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
        var oldEventId2 = String(rec.values[cols.CALENDAR_EVENT_ID] || '');
        var newEventId2 = upsertBloodDrawingCalendarEvent_(
          c.slotID, startDT2, endDT2, remainingTAs, participantName2, oldEventId2,
          (remainingTAs.length || stillHasParticipant) ? 'Booked' : 'Available', staffEmail2
        );
        rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(newEventId2);

        applied.push({ slotID: c.slotID, summary: summary, available: false });
      }
    });

    // Requirement #6: "when multiple changes are saved... send ONE
    // consolidated email containing all changes" — never one per slot.
    if (applied.length) notifyTABloodDrawingAvailabilityBatch_(session, applied);

    var msg = applied.length + ' change(s) saved.';
    if (errors.length) msg += ' ' + errors.length + ' could not be saved: ' + errors.join(' ');
    return { success: applied.length > 0 || !errors.length, message: msg, applied: applied, errors: errors };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Requirement #6: "when multiple changes are saved... send one consolidated
 * email containing all changes" — one email per operation, not one per slot.
 * Routed through the existing 'taAvailabilitySubmitted' Email Control
 * Matrix entry, same as the generic date-range availability submission.
 * @param {Object} session
 * @param {Array<{slotID, summary, available, bookingID}>} applied
 */
function notifyTABloodDrawingAvailabilityBatch_(session, applied) {
  try {
    var recipients = resolveNotificationRecipients_('taAvailabilitySubmitted', {
      technicalAssistants: [session.email]
    });
    if (!recipients.length) return;
    var lines = applied.map(function (a) {
      return (a.available ? 'Available for ' : 'No longer available for ') + a.summary +
        (a.bookingID ? ' \u2014 Booking ID: ' + a.bookingID : '');
    });
    MailApp.sendEmail(
      recipients.join(','),
      emailSubject_('taAvailabilitySubmitted') + ' \u2014 ' + session.name,
      bilingualBody_(
        session.name + ' hat seine/ihre Blutentnahme-Verfügbarkeit aktualisiert:\n\n' + lines.join('\n'),
        session.name + ' has updated their Blood Drawing availability:\n\n' + lines.join('\n')
      )
    );
  } catch (err) {
    Logger.log('notifyTABloodDrawingAvailabilityBatch_ failed: ' + err);
  }
}

/** Every active admin whose role grants at least one of the given permissions. */
function getAdminEmailsWithPermission_(permissionList) {
  var cols = CONFIG.ADMIN_COLS;
  var map = getRolePermissionsMap_();
  var out = [];
  getAllAdminRecords_().forEach(function (r) {
    if (!isBooked_(r.values[cols.ACTIVE])) return;
    var perms = map[String(r.values[cols.ROLE])] || [];
    if (permissionList.some(function (p) { return perms.indexOf(p) !== -1; })) {
      out.push(String(r.values[cols.EMAIL]));
    }
  });
  return buildDedupedGuestList_(out);
}

/**
 * ----------------------------------------------------------------------------
 * AUTOMATIC REMINDER EMAILS (spec sections 9, 11)
 * ----------------------------------------------------------------------------
 * Apps Script time-driven triggers can't be scoped to "every Monday and
 * Wednesday" directly, so a single daily trigger calls this dispatcher,
 * which no-ops on every day except Monday (day 1) and Wednesday (day 3).
 * Call installReminderTriggers() once from the Apps Script editor to set
 * the daily trigger up.
 */
function checkAndSendReminders_() {
  var day = new Date().getDay(); // 0=Sun..6=Sat
  if (day !== 1 && day !== 3) return; // Monday or Wednesday only
  sendUnbookedSlotReminder_();
  sendBloodDrawingAssignmentReminder_();
}

/** Installs the single daily trigger that drives checkAndSendReminders_(). Safe to re-run (removes any previous one first). */
function installReminderTriggers() {
  ScriptTriggers_removeByHandler_('checkAndSendReminders_');
  ScriptApp.newTrigger('checkAndSendReminders_').timeBased().everyDays(1).atHour(7).create();
}

function ScriptTriggers_removeByHandler_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}

/** Summary email to the Main Admin: every Day1/Day2 slot in the next N days that is unbooked AND unassigned. */
function sendUnbookedSlotReminder_() {
  try {
    var windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + CONFIG.REMINDER_WINDOW_DAYS);
    windowEnd.setHours(23, 59, 59, 999);

    var lines = [];
    [{ sheet: CONFIG.SHEETS.DAY1, label: 'Day 1', staffCol: CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF },
     { sheet: CONFIG.SHEETS.DAY2, label: 'Day 2', staffCol: CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF }]
      .forEach(function (cfg) {
        var cols = CONFIG.SLOT_COLS;
        getDataRows_(cfg.sheet).forEach(function (row) {
          if (!row[cols.SLOT_ID]) return;
          if (!isOnOrAfterToday_(row[cols.DATE])) return;
          var dateVal = row[cols.DATE];
          if (!(dateVal instanceof Date) || dateVal > windowEnd) return;
          var booked = isBooked_(row[cols.BOOKED]);
          var staff = String(row[cfg.staffCol] || '');
          if (booked && staff) return; // fully scheduled + booked — not a gap
          lines.push(
            cfg.label + ' slot ' + row[cols.SLOT_ID] + ' — Date: ' + formatDateForDisplay_(dateVal, 'en') +
            ' — Time: ' + formatTimeForDisplay_(row[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(row[cols.END_TIME], 'en') +
            ' — Staff: ' + (staff ? getStaffNameByEmail_(staff) : '(unassigned)') +
            ' — Booking status: ' + (booked ? 'Booked' : 'Unbooked')
          );
        });
      });

    if (!lines.length) return;
    var body = lines.join('\n');
    var recipients = resolveNotificationRecipients_('weeklyReminder', {});
    // An empty list means the Main Admin deliberately routed this reminder
    // to nobody — respect that instead of force-mailing Main Admin.
    if (!recipients.length) return;
    var content = renderEmailTemplate_('reminderUnbooked', { Details: body });
    MailApp.sendEmail(recipients.join(','), content.subject, content.body);
  } catch (err) {
    Logger.log('sendUnbookedSlotReminder_ failed: ' + err);
  }
}

/** Summary email to Main Admin + Blood Drawing managers: every Blood Drawing slot in the next N days without an assigned TA. */
function sendBloodDrawingAssignmentReminder_() {
  try {
    var windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + CONFIG.REMINDER_WINDOW_DAYS);
    windowEnd.setHours(23, 59, 59, 999);

    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var availableTAs = getTAList_().map(function (t) { return t.name; }).join(', ') || '(none registered)';
    var lines = [];
    getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING).forEach(function (row) {
      if (!row[cols.SLOT_ID]) return;
      if (!isOnOrAfterToday_(row[cols.DATE])) return;
      var dateVal = row[cols.DATE];
      if (!(dateVal instanceof Date) || dateVal > windowEnd) return;
      var assigned = String(row[cols.ASSIGNED_TA] || '');
      if (assigned) return;
      lines.push(
        'Blood Drawing slot ' + row[cols.SLOT_ID] + ' — Date: ' + formatDateForDisplay_(dateVal, 'en') +
        ' — Time: ' + formatTimeForDisplay_(row[cols.START_TIME], 'en') + '–' + formatTimeForDisplay_(row[cols.END_TIME], 'en') +
        ' — Related Day 1 experiment: ' + (String(row[cols.DAY1_SLOT_ID] || '') || '(manually added)') +
        ' — Assignment status: Unassigned' +
        ' — Available TAs: ' + availableTAs
      );
    });

    if (!lines.length) return;
    // Round 6 fix: recipients now come purely from the 'weeklyReminder'
    // matrix entry — no unconditional addition of Blood-Drawing-permission
    // holders, since the Main Admin should be able to fully control who
    // receives this reminder via the matrix, with no exceptions.
    var recipients = resolveNotificationRecipients_('weeklyReminder', {});
    // An empty list means the Main Admin deliberately routed this reminder
    // to nobody — respect that instead of force-mailing Main Admin.
    if (!recipients.length) return;
    var body = lines.join('\n');
    var content = renderEmailTemplate_('reminderUnassigned', { Details: body });
    MailApp.sendEmail(recipients.join(','), content.subject, content.body);
  } catch (err) {
    Logger.log('sendBloodDrawingAssignmentReminder_ failed: ' + err);
  }
}


/**
 * ============================================================================
 *  2026-08 REQUIREMENTS PASS — ROUND 2
 *  (Gender/name split, Task Management, dynamic email subjects, revised
 *  overlap rules, dual Blood Drawing assignment, bulk MRI scheduling,
 *  automatic TA assignment, Post-Experiment tracking)
 * ============================================================================
 */

/**
 * ----------------------------------------------------------------------------
 * GENDER OPTIONS (spec round 2, #1) — configurable dropdown
 * ----------------------------------------------------------------------------
 */
function ensureGenderOptionsSeeded_() {
  var sheet = getSheet_(CONFIG.SHEETS.GENDER_OPTIONS);
  if (sheet.getLastRow() >= 2) return;
  CONFIG.GENDERS_DEFAULT.forEach(function (g) { sheet.appendRow([g]); });
}

/** Client-callable (no auth — same trust level as language/title options on the public booking form). */
function getGenderOptions() {
  var sheet = getSheet_(CONFIG.SHEETS.GENDER_OPTIONS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return CONFIG.GENDERS_DEFAULT;
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    .map(function (r) { return String(r[0] || '').trim(); })
    .filter(Boolean);
}

/**
 * Client-callable (no auth): the Session Language options (round 7) — used
 * to populate the Language dropdown wherever a Day 1/Day 2 slot is created
 * (admin, 'manage_slots') and wherever an admin picks a participant's
 * language preference for filtering/booking purposes (Admin Booking
 * Portal, 'manage_bookings'). Same trust level as getGenderOptions/TITLES.
 */
function getSlotLanguageOptions() {
  return CONFIG.SLOT_LANGUAGES;
}

/** Client-callable (manage_participants): overwrite the Gender dropdown options. */
function updateGenderOptions(token, options) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_participants');
  var clean = (options || []).map(function (o) { return String(o).trim(); }).filter(Boolean);
  if (!clean.length) return { success: false, message: 'At least one gender option is required.' };
  var sheet = getSheet_(CONFIG.SHEETS.GENDER_OPTIONS);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) sheet.getRange(2, 1, lastRow - 1, 1).clearContent();
  clean.forEach(function (g) { sheet.appendRow([g]); });
  return { success: true, message: 'Gender options updated.' };
}

/**
 * ----------------------------------------------------------------------------
 * TASK MANAGEMENT (spec round 2, #2) — extends RBAC with a configurable
 * Task -> allowed-roles mapping, editable by the Main Admin at any time.
 * ----------------------------------------------------------------------------
 */
var TASKS_CACHE_KEY_ = 'TASKS_MAP_V1';
var TASKS_CACHE_TTL_ = 300;

function invalidateTasksCache_() {
  try { CacheService.getScriptCache().remove(TASKS_CACHE_KEY_); } catch (e) { /* ignore */ }
}

function ensureTasksSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.TASKS);
  if (sheet.getLastRow() >= 2) return;
  Object.keys(CONFIG.DEFAULT_TASKS).forEach(function (taskName) {
    sheet.appendRow([taskName, CONFIG.DEFAULT_TASKS[taskName].join(','), new Date()]);
  });
}

/** Live Task -> [allowed roles] map, sheet-backed with a short cache. */
function getTasksMap_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(TASKS_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
  }
  var map = {};
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.TASKS);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (row) {
        var taskName = String(row[0] || '').trim();
        if (!taskName) return;
        map[taskName] = String(row[1] || '').split(',').map(function (r) { return r.trim(); }).filter(Boolean);
      });
    }
  } catch (e) {
    Logger.log('getTasksMap_ failed, falling back to CONFIG.DEFAULT_TASKS: ' + e);
  }
  if (!Object.keys(map).length) map = CONFIG.DEFAULT_TASKS;
  try { cache.put(TASKS_CACHE_KEY_, JSON.stringify(map), TASKS_CACHE_TTL_); } catch (e) { /* ignore */ }
  return map;
}

/** True if the given role is allowed to perform the named task. Unknown tasks default to allowed (fail-open, since Task Management is an additive layer on top of the primary permission gates, not a replacement for them). */
function roleCanPerformTask_(role, taskName) {
  var map = getTasksMap_();
  if (!map.hasOwnProperty(taskName)) return true;
  return map[taskName].indexOf(role) !== -1;
}

/** Throws if the session's role is not allowed to perform the named task. Called alongside (never instead of) requirePermission_. */
function requireTask_(session, taskName) {
  if (!roleCanPerformTask_(session.role, taskName)) {
    throw new Error('Your role (' + session.role + ') is not permitted to perform the task "' + taskName + '".');
  }
}

/** Client-callable (manage_roles): full task catalog + allowed roles + all role names, for the "Manage Tasks" screen. */
function getTasksConfig(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureTasksSeeded_();
  return { tasks: getTasksMap_(), allRoleNames: getAllRoleNames_() };
}

/**
 * ----------------------------------------------------------------------------
 * EMAIL NOTIFICATION MATRIX (spec round 4, #8)
 * ----------------------------------------------------------------------------
 * A sheet-backed event -> [recipient groups] mapping, editable by the Main
 * Admin at any time, that controls which groups receive each notification.
 * resolveNotificationRecipients_() turns a routed group list into concrete,
 * deduplicated email addresses given the context of a specific event.
 */
var NOTIFICATION_CACHE_KEY_ = 'NOTIFICATION_MATRIX_V1';
var NOTIFICATION_CACHE_TTL_ = 300;

function invalidateNotificationCache_() {
  try { CacheService.getScriptCache().remove(NOTIFICATION_CACHE_KEY_); } catch (e) { /* ignore */ }
}

function ensureNotificationSettingsSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.NOTIFICATION_SETTINGS);
  if (sheet.getLastRow() >= 2) return;
  CONFIG.NOTIFICATION_EVENTS.forEach(function (evt) {
    var groups = CONFIG.NOTIFICATION_DEFAULTS[evt.key] || ['MainAdmin'];
    sheet.appendRow([evt.key, groups.join(','), new Date()]);
  });
}

/** Live event -> [groups] map, sheet-backed with a short cache; falls back to CONFIG.NOTIFICATION_DEFAULTS. */
function getNotificationMatrixMap_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(NOTIFICATION_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
  }
  var map = {};
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.NOTIFICATION_SETTINGS);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (row) {
        var key = String(row[0] || '').trim();
        if (!key) return;
        map[key] = String(row[1] || '').split(',').map(function (g) { return g.trim(); }).filter(Boolean);
      });
    }
  } catch (e) {
    Logger.log('getNotificationMatrixMap_ failed, falling back to defaults: ' + e);
  }
  // Fill any events missing from the sheet with their defaults.
  CONFIG.NOTIFICATION_EVENTS.forEach(function (evt) {
    if (!map.hasOwnProperty(evt.key)) map[evt.key] = CONFIG.NOTIFICATION_DEFAULTS[evt.key] || ['MainAdmin'];
  });
  try { cache.put(NOTIFICATION_CACHE_KEY_, JSON.stringify(map), NOTIFICATION_CACHE_TTL_); } catch (e) { /* ignore */ }
  return map;
}

/**
 * Resolves the recipient email list for an event, honouring the Main Admin's
 * routing matrix. `context` supplies the event-specific people:
 *   { assignedStaff: [emails], bloodDrawingStaff: [emails],
 *     technicalAssistants: [emails], participants: [emails] }
 * Returns a deduplicated list of addresses (spec #8 + the recurring
 * "each person receives only one email" requirement).
 * @param {string} eventKey
 * @param {Object} context
 * @return {Array<string>}
 */
function resolveNotificationRecipients_(eventKey, context) {
  context = context || {};
  var groups = getNotificationMatrixMap_()[eventKey] || ['MainAdmin'];
  var out = [];
  groups.forEach(function (g) {
    switch (g) {
      case 'MainAdmin':
        out.push(getMainAdminEmail_());
        break;
      case 'OtherAdmins':
        out = out.concat(getOtherAdminEmails_());
        break;
      case 'Admins':
        out = out.concat(getAllAdminEmails_());
        break;
      case 'AssignedStaff':
        out = out.concat(context.assignedStaff || []);
        break;
      case 'BloodDrawingStaff':
        out = out.concat(context.bloodDrawingStaff || []);
        break;
      case 'TechnicalAssistants':
        out = out.concat(context.technicalAssistants || []);
        break;
      case 'Participants':
        out = out.concat(context.participants || []);
        break;
      default:
        // Unknown group name -> also treat as a role name, gathering every
        // active admin holding that role.
        out = out.concat(getAdminEmailsWithRole_(g));
    }
  });
  return buildDedupedGuestList_(out);
}

/** Every active admin whose role exactly matches the given role name. */
function getAdminEmailsWithRole_(roleName) {
  var cols = CONFIG.ADMIN_COLS;
  return getAllAdminRecords_()
    .filter(function (r) { return String(r.values[cols.ROLE]) === roleName && isBooked_(r.values[cols.ACTIVE]); })
    .map(function (r) { return String(r.values[cols.EMAIL]); });
}

/** Client-callable (manage_roles): the notification matrix + event/group catalogs, for the Email Notification Settings UI. */
function getNotificationMatrix(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureNotificationSettingsSeeded_();
  return {
    matrix: getNotificationMatrixMap_(),
    events: CONFIG.NOTIFICATION_EVENTS,
    groups: CONFIG.NOTIFICATION_GROUPS
  };
}

/** Client-callable (manage_roles): set the recipient groups for one event. */
function updateNotificationRouting(token, eventKey, groups) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  eventKey = String(eventKey || '').trim();
  if (!CONFIG.NOTIFICATION_EVENTS.some(function (e) { return e.key === eventKey; })) {
    return { success: false, message: 'Unknown notification event.' };
  }
  var validGroups = CONFIG.NOTIFICATION_GROUPS.map(function (g) { return g.key; });
  var clean = (groups || []).map(function (g) { return String(g).trim(); }).filter(function (g) {
    return validGroups.indexOf(g) !== -1;
  });

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.NOTIFICATION_SETTINGS);
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === eventKey) {
        sheet.getRange(i + 2, 2).setValue(clean.join(','));
        sheet.getRange(i + 2, 3).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) sheet.appendRow([eventKey, clean.join(','), new Date()]);
  invalidateNotificationCache_();
  return { success: true, message: 'Notification routing updated.' };
}

/**
 * ----------------------------------------------------------------------------
 * CONFIGURABLE SCHEDULING RULES (spec round 5, #3)
 * ----------------------------------------------------------------------------
 * A sheet-backed, Main-Admin-editable registry of experiment types and an
 * overlap-permission matrix. The centralized scheduling validator
 * (validateSchedulingSlot_) reads ALL overlap permissions from here instead
 * of hardcoding them, so the rules can change without code edits.
 *
 * SchedulingRules sheet layout (one row per unordered type pair):
 *   TypeA | TypeB | Allowed('YES'/'NO') | UpdatedAt
 * The list of known types is derived from the union of every type that
 * appears in the matrix (plus the defaults), so "add a type" == "add a rule
 * referencing it".
 */
var SCHEDULING_RULES_CACHE_KEY_ = 'SCHEDULING_RULES_V1';
var SCHEDULING_RULES_CACHE_TTL_ = 300;

function invalidateSchedulingRulesCache_() {
  try { CacheService.getScriptCache().remove(SCHEDULING_RULES_CACHE_KEY_); } catch (e) { /* ignore */ }
}

/** Canonical key for an unordered type pair. */
function schedulingPairKey_(a, b) {
  var x = String(a || '').trim();
  var y = String(b || '').trim();
  return (x <= y) ? (x + '||' + y) : (y + '||' + x);
}

function ensureSchedulingRulesSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.SCHEDULING_RULES);
  if (sheet.getLastRow() >= 2) return;
  CONFIG.SCHEDULING_RULES_DEFAULT.forEach(function (r) {
    sheet.appendRow([r.a, r.b, r.allowed ? 'YES' : 'NO', new Date()]);
  });
}

/**
 * Live scheduling-rules config, cached. Returns:
 *   { types: [typeName...], allowed: { pairKey: true/false } }
 */
function getSchedulingRulesConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(SCHEDULING_RULES_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
  }
  var allowed = {};
  var typeSet = {};
  CONFIG.SCHEDULING_TYPES_DEFAULT.forEach(function (t) { typeSet[t] = true; });
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.SCHEDULING_RULES);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 3).getValues().forEach(function (row) {
        var a = String(row[0] || '').trim();
        var b = String(row[1] || '').trim();
        if (!a || !b) return;
        typeSet[a] = true; typeSet[b] = true;
        allowed[schedulingPairKey_(a, b)] = String(row[2] || '').trim().toUpperCase() === 'YES';
      });
    }
  } catch (e) {
    Logger.log('getSchedulingRulesConfig_ failed, using defaults: ' + e);
  }
  // Fill any missing default pairs so the engine always has an answer.
  CONFIG.SCHEDULING_RULES_DEFAULT.forEach(function (r) {
    var k = schedulingPairKey_(r.a, r.b);
    if (!allowed.hasOwnProperty(k)) allowed[k] = r.allowed;
  });
  var config = { types: Object.keys(typeSet), allowed: allowed };
  try { cache.put(SCHEDULING_RULES_CACHE_KEY_, JSON.stringify(config), SCHEDULING_RULES_CACHE_TTL_); } catch (e) { /* ignore */ }
  return config;
}

/**
 * Is an overlap between two experiment types PERMITTED per the configured
 * rules? Unknown pairs default to NOT permitted (safe/blocking).
 */
function isOverlapAllowed_(typeA, typeB) {
  var config = getSchedulingRulesConfig_();
  var k = schedulingPairKey_(typeA, typeB);
  return config.allowed.hasOwnProperty(k) ? config.allowed[k] : false;
}

/** Client-callable (manage_roles): the full scheduling-rules config for the Admin Portal UI. */
function getSchedulingRules(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureSchedulingRulesSeeded_();
  var config = getSchedulingRulesConfig_();
  // Return the matrix as an explicit list of {a,b,allowed} for every known
  // unordered pair (including self-pairs), so the UI can render a full grid.
  var types = config.types;
  var pairs = [];
  for (var i = 0; i < types.length; i++) {
    for (var j = i; j < types.length; j++) {
      var k = schedulingPairKey_(types[i], types[j]);
      pairs.push({ a: types[i], b: types[j], allowed: config.allowed.hasOwnProperty(k) ? config.allowed[k] : false });
    }
  }
  return { types: types, pairs: pairs };
}

/** Client-callable (manage_roles): set whether a given type pair may overlap. */
function updateSchedulingRule(token, typeA, typeB, allowed) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  typeA = String(typeA || '').trim();
  typeB = String(typeB || '').trim();
  if (!typeA || !typeB) return { success: false, message: 'Both experiment types are required.' };

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.SCHEDULING_RULES);
  var lastRow = sheet.getLastRow();
  var wantKey = schedulingPairKey_(typeA, typeB);
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < values.length; i++) {
      if (schedulingPairKey_(values[i][0], values[i][1]) === wantKey) {
        sheet.getRange(i + 2, 3).setValue(allowed ? 'YES' : 'NO');
        sheet.getRange(i + 2, 4).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) sheet.appendRow([typeA, typeB, allowed ? 'YES' : 'NO', new Date()]);
  invalidateSchedulingRulesCache_();
  return { success: true, message: 'Scheduling rule updated.' };
}

/** Client-callable (manage_roles): add a new experiment type (seeded as NOT-overlapping with everything, incl. itself, until edited). */
function addSchedulingType(token, typeName) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  typeName = String(typeName || '').trim();
  if (!typeName) return { success: false, message: 'Type name is required.' };
  if (/[|,]/.test(typeName)) return { success: false, message: 'Type name may not contain "|" or ",".' };
  var config = getSchedulingRulesConfig_();
  if (config.types.indexOf(typeName) !== -1) return { success: false, message: 'That type already exists.' };

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.SCHEDULING_RULES);
  // Seed a NOT-allowed rule against every existing type and itself, so the
  // type becomes "known" and has a defined (blocking) default everywhere.
  config.types.concat([typeName]).forEach(function (other) {
    sheet.appendRow([typeName, other, 'NO', new Date()]);
  });
  invalidateSchedulingRulesCache_();
  return { success: true, message: 'Experiment type "' + typeName + '" added.' };
}

/** Client-callable (manage_roles): delete an experiment type and all its rules. */
function deleteSchedulingType(token, typeName) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  typeName = String(typeName || '').trim();
  if (CONFIG.SCHEDULING_TYPES_DEFAULT.indexOf(typeName) !== -1) {
    return { success: false, message: 'Built-in experiment types cannot be deleted (only their overlap rules can be changed).' };
  }
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.SCHEDULING_RULES);
  var lastRow = sheet.getLastRow();
  var removed = 0;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = values.length - 1; i >= 0; i--) {
      if (String(values[i][0]).trim() === typeName || String(values[i][1]).trim() === typeName) {
        sheet.deleteRow(i + 2);
        removed++;
      }
    }
  }
  invalidateSchedulingRulesCache_();
  return { success: true, message: 'Experiment type "' + typeName + '" and ' + removed + ' rule(s) removed.' };
}

/**
 * ============================================================================
 * EDITABLE EMAIL TEMPLATES (spec round 6)
 * ============================================================================
 * A sheet-backed, Main-Admin-editable registry of every system email's
 * subject + body, in both German and English, with {{Placeholder}}
 * substitution. renderEmailTemplate_() is the single rendering entry point
 * every email-sending function should call instead of hand-building its own
 * bilingual body.
 *
 * EmailTemplates sheet layout (one row per template key):
 *   TemplateKey | SubjectDE | BodyDE | SubjectEN | BodyEN | UpdatedAt
 */
var EMAIL_TEMPLATES_CACHE_KEY_ = 'EMAIL_TEMPLATES_V1';
var EMAIL_TEMPLATES_CACHE_TTL_ = 300;

function invalidateEmailTemplatesCache_() {
  try { CacheService.getScriptCache().remove(EMAIL_TEMPLATES_CACHE_KEY_); } catch (e) { /* ignore */ }
}

function ensureEmailTemplatesSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.EMAIL_TEMPLATES);
  if (sheet.getLastRow() >= 2) return;
  Object.keys(CONFIG.EMAIL_TEMPLATES_DEFAULT).forEach(function (key) {
    var t = CONFIG.EMAIL_TEMPLATES_DEFAULT[key];
    sheet.appendRow([key, t.subjectDe, t.bodyDe, t.subjectEn, t.bodyEn, new Date()]);
  });
}

/** Live template map, cached: { key: {subjectDe, bodyDe, subjectEn, bodyEn} }. Falls back to defaults for anything missing. */
function getEmailTemplatesMap_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(EMAIL_TEMPLATES_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
  }
  var map = {};
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.EMAIL_TEMPLATES);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 5).getValues().forEach(function (row) {
        var key = String(row[0] || '').trim();
        if (!key) return;
        map[key] = { subjectDe: String(row[1] || ''), bodyDe: String(row[2] || ''), subjectEn: String(row[3] || ''), bodyEn: String(row[4] || '') };
      });
    }
  } catch (e) {
    Logger.log('getEmailTemplatesMap_ failed, using defaults: ' + e);
  }
  Object.keys(CONFIG.EMAIL_TEMPLATES_DEFAULT).forEach(function (key) {
    if (!map[key]) map[key] = CONFIG.EMAIL_TEMPLATES_DEFAULT[key];
  });
  try { cache.put(EMAIL_TEMPLATES_CACHE_KEY_, JSON.stringify(map), EMAIL_TEMPLATES_CACHE_TTL_); } catch (e) { /* ignore */ }
  return map;
}

/** Replaces every {{Placeholder}} in a string with values[placeholder] (or '' if absent). */
function substitutePlaceholders_(text, values) {
  if (!text) return '';
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (m, name) {
    return values && values.hasOwnProperty(name) ? String(values[name]) : '';
  });
}

/**
 * Renders a template by key into a subject + bilingual body, with every
 * placeholder in `values` substituted (missing ones resolve to ''). This is
 * the single rendering path every system email should use.
 * @param {string} key - a CONFIG.EMAIL_TEMPLATES_DEFAULT key
 * @param {Object} values - placeholder name -> value (see CONFIG.EMAIL_PLACEHOLDERS)
 * @return {{subject: string, body: string}}
 */
function renderEmailTemplate_(key, values) {
  var templates = getEmailTemplatesMap_();
  var t = templates[key] || { subjectDe: key, bodyDe: '', subjectEn: key, bodyEn: '' };
  var subject = substitutePlaceholders_(t.subjectEn || key, values || {});
  var bodyDe = substitutePlaceholders_(t.bodyDe || '', values || {});
  var bodyEn = substitutePlaceholders_(t.bodyEn || '', values || {});
  return { subject: '[' + CONFIG.EXPERIMENT_NAME.en + '] ' + subject, body: bilingualBody_(bodyDe, bodyEn) };
}

/**
 * ----------------------------------------------------------------------------
 * PROJECT ID (round 10)
 * ----------------------------------------------------------------------------
 * A single, admin-configurable label shown at the top of every portal
 * (participant booking page, manage-booking page, and the Admin Portal) so
 * everyone using the system can see at a glance which project/study
 * deployment they're on — useful once more than one instance of this
 * scheduler exists (e.g. a staging copy, or a different study). This is a
 * DISPLAY LABEL, not a multi-tenancy boundary: this deployment still has
 * exactly one spreadsheet and one set of admin accounts. Only the Main
 * Admin can change it (same 'manage_admins' tier as other account/identity
 * settings), but any authenticated admin can see it, and it's exposed with
 * no auth at all for the public-facing pages, same trust level as the
 * language/title options already public there.
 */

var PROJECT_ID_CACHE_KEY_ = 'PROJECT_ID_V1';
var PROJECT_ID_CACHE_TTL_ = 300;

function invalidateProjectIdCache_() {
  try { CacheService.getScriptCache().remove(PROJECT_ID_CACHE_KEY_); } catch (e) { /* ignore */ }
}

/**
 * Client-callable (no auth — same trust level as getGenderOptions /
 * getSlotLanguageOptions): the current Project ID, or '' if never set.
 * @return {string}
 */
function getProjectId() {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(PROJECT_ID_CACHE_KEY_);
    if (cached !== null) return cached;
  } catch (e) { /* CacheService unavailable; fall through to fresh read */ }

  var value = '';
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.PROJECT_SETTINGS);
    if (sheet.getLastRow() >= 2) {
      value = String(sheet.getRange(2, 1).getValue() || '');
    }
  } catch (e) {
    Logger.log('getProjectId failed: ' + e);
  }
  try { cache.put(PROJECT_ID_CACHE_KEY_, value, PROJECT_ID_CACHE_TTL_); } catch (e) { /* ignore */ }
  return value;
}

/**
 * Client-callable (manage_admins — Main-Admin tier): set the Project ID.
 * Overwrites the single existing row rather than appending, so there is
 * always exactly one current value.
 * @param {string} token
 * @param {string} projectId
 * @return {Object}
 */
function updateProjectId(token, projectId) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_admins');

  var clean = String(projectId || '').trim();
  if (clean.length > 120) {
    return { success: false, message: 'Project ID is too long (120 characters max).' };
  }

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.PROJECT_SETTINGS);
  if (sheet.getLastRow() < 2) {
    sheet.appendRow([clean, session.name, new Date()]);
  } else {
    sheet.getRange(2, 1, 1, 3).setValues([[clean, session.name, new Date()]]);
  }
  invalidateProjectIdCache_();

  return { success: true, message: 'Project ID updated.', projectId: clean };
}

/** Client-callable (manage_roles): every template + the placeholder catalog, for the Email Templates editor. */
function getEmailTemplates(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureEmailTemplatesSeeded_();
  return {
    templates: getEmailTemplatesMap_(),
    keys: Object.keys(CONFIG.EMAIL_TEMPLATES_DEFAULT),
    placeholders: CONFIG.EMAIL_PLACEHOLDERS
  };
}

/** Client-callable (manage_roles): update one template's subject/body in both languages. */
function updateEmailTemplate(token, key, data) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  key = String(key || '').trim();
  if (!CONFIG.EMAIL_TEMPLATES_DEFAULT.hasOwnProperty(key)) {
    return { success: false, message: 'Unknown template key.' };
  }
  data = data || {};
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.EMAIL_TEMPLATES);
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === key) {
        var r = i + 2;
        sheet.getRange(r, 2, 1, 4).setValues([[
          String(data.subjectDe || ''), String(data.bodyDe || ''), String(data.subjectEn || ''), String(data.bodyEn || '')
        ]]);
        sheet.getRange(r, 6).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) {
    sheet.appendRow([key, data.subjectDe || '', data.bodyDe || '', data.subjectEn || '', data.bodyEn || '', new Date()]);
  }
  invalidateEmailTemplatesCache_();
  return { success: true, message: 'Template updated.' };
}

/** Client-callable (manage_roles): reset one template back to its shipped default. */
function resetEmailTemplate(token, key) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  key = String(key || '').trim();
  var def = CONFIG.EMAIL_TEMPLATES_DEFAULT[key];
  if (!def) return { success: false, message: 'Unknown template key.' };
  return updateEmailTemplate(token, key, { subjectDe: def.subjectDe, bodyDe: def.bodyDe, subjectEn: def.subjectEn, bodyEn: def.bodyEn });
}

/**
 * ============================================================================
 * CALENDAR INVITATION SETTINGS (spec round 6)
 * ============================================================================
 * A sheet-backed, Main-Admin-editable registry of which recipient group(s)
 * are invited to the calendar event for each activity. resolveCalendarInvitees_()
 * turns a routed group list into concrete, deduplicated email addresses
 * given the event's context.
 *
 * CalendarInviteSettings sheet layout (one row per activity):
 *   ActivityKey | RecipientGroups | UpdatedAt
 */
var CALENDAR_INVITE_CACHE_KEY_ = 'CALENDAR_INVITE_SETTINGS_V1';
var CALENDAR_INVITE_CACHE_TTL_ = 300;

function invalidateCalendarInviteCache_() {
  try { CacheService.getScriptCache().remove(CALENDAR_INVITE_CACHE_KEY_); } catch (e) { /* ignore */ }
}

function ensureCalendarInviteSettingsSeeded_() {
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.CALENDAR_INVITE_SETTINGS);
  if (sheet.getLastRow() >= 2) return;
  CONFIG.CALENDAR_ACTIVITIES.forEach(function (a) {
    var groups = CONFIG.CALENDAR_INVITE_DEFAULTS[a.key] || [];
    sheet.appendRow([a.key, groups.join(','), new Date()]);
  });
}

/** Live activity -> [groups] map, cached; falls back to CONFIG.CALENDAR_INVITE_DEFAULTS. */
function getCalendarInviteMap_() {
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cache.get(CALENDAR_INVITE_CACHE_KEY_); } catch (e) { /* CacheService unavailable; fall through to fresh read */ }
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* rebuild */ }
  }
  var map = {};
  try {
    var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.CALENDAR_INVITE_SETTINGS);
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (row) {
        var key = String(row[0] || '').trim();
        if (!key) return;
        map[key] = String(row[1] || '').split(',').map(function (g) { return g.trim(); }).filter(Boolean);
      });
    }
  } catch (e) {
    Logger.log('getCalendarInviteMap_ failed, using defaults: ' + e);
  }
  CONFIG.CALENDAR_ACTIVITIES.forEach(function (a) {
    if (!map.hasOwnProperty(a.key)) map[a.key] = CONFIG.CALENDAR_INVITE_DEFAULTS[a.key] || [];
  });
  try { cache.put(CALENDAR_INVITE_CACHE_KEY_, JSON.stringify(map), CALENDAR_INVITE_CACHE_TTL_); } catch (e) { /* ignore */ }
  return map;
}

/**
 * Resolves which email addresses should be invited to an activity's
 * calendar event, per the configured recipient groups, given the event's
 * context. Deduplicated so nobody is invited twice (spec requirement).
 * @param {string} activityKey
 * @param {Object} context - { slotCreator, assignedStaff: [emails],
 *   bloodDrawingStaff: [emails], technicalAssistants: [emails], participant: [email] }
 * @return {Array<string>}
 */
function resolveCalendarInvitees_(activityKey, context) {
  context = context || {};
  var groups = getCalendarInviteMap_()[activityKey] || [];
  var out = [];
  groups.forEach(function (g) {
    switch (g) {
      case 'MainAdmin': out.push(getMainAdminEmail_()); break;
      case 'OtherAdmins': out = out.concat(getOtherAdminEmails_()); break;
      case 'Admins': out = out.concat(getAllAdminEmails_()); break;
      case 'SlotCreator': if (context.slotCreator) out.push(context.slotCreator); break;
      case 'AssignedStaff': out = out.concat(context.assignedStaff || []); break;
      case 'BloodDrawingStaff': out = out.concat(context.bloodDrawingStaff || []); break;
      case 'TechnicalAssistants': out = out.concat(context.technicalAssistants || []); break;
      case 'Participant': out = out.concat(context.participant || []); break;
      default: break;
    }
  });
  return buildDedupedGuestList_(out);
}

/** Client-callable (manage_roles): the calendar-invite matrix + activity/group catalogs, for the Calendar Invitations editor. */
function getCalendarInviteSettings(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  ensureCalendarInviteSettingsSeeded_();
  return {
    matrix: getCalendarInviteMap_(),
    activities: CONFIG.CALENDAR_ACTIVITIES,
    groups: CONFIG.CALENDAR_RECIPIENT_GROUPS
  };
}

/** Client-callable (manage_roles): set the recipient groups invited for one activity. */
function updateCalendarInviteRouting(token, activityKey, groups) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  activityKey = String(activityKey || '').trim();
  if (!CONFIG.CALENDAR_ACTIVITIES.some(function (a) { return a.key === activityKey; })) {
    return { success: false, message: 'Unknown activity.' };
  }
  var validGroups = CONFIG.CALENDAR_RECIPIENT_GROUPS.map(function (g) { return g.key; });
  var clean = (groups || []).map(function (g) { return String(g).trim(); }).filter(function (g) {
    return validGroups.indexOf(g) !== -1;
  });

  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.CALENDAR_INVITE_SETTINGS);
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === activityKey) {
        sheet.getRange(i + 2, 2).setValue(clean.join(','));
        sheet.getRange(i + 2, 3).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) sheet.appendRow([activityKey, clean.join(','), new Date()]);
  invalidateCalendarInviteCache_();
  return { success: true, message: 'Calendar invitation routing updated.' };
}

/** Client-callable (manage_roles): create a new task type with its allowed roles. */
function createTask(token, taskName, allowedRoles) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  taskName = String(taskName || '').trim();
  if (!taskName) return { success: false, message: 'Task name is required.' };
  if (getTasksMap_().hasOwnProperty(taskName)) return { success: false, message: 'A task with that name already exists.' };
  var validRoles = getAllRoleNames_();
  var clean = (allowedRoles || []).map(function (r) { return String(r).trim(); }).filter(function (r) {
    return validRoles.indexOf(r) !== -1;
  });
  getOrCreateConfigSheet_(CONFIG.SHEETS.TASKS).appendRow([taskName, clean.join(','), new Date()]);
  invalidateTasksCache_();
  return { success: true, message: 'Task "' + taskName + '" created.' };
}

/** Client-callable (manage_roles): update which roles may perform an existing task. */
function updateTaskRoles(token, taskName, allowedRoles) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  taskName = String(taskName || '').trim();
  var validRoles = getAllRoleNames_();
  var clean = (allowedRoles || []).map(function (r) { return String(r).trim(); }).filter(function (r) {
    return validRoles.indexOf(r) !== -1;
  });
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.TASKS);
  var lastRow = sheet.getLastRow();
  var found = false;
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === taskName) {
        sheet.getRange(i + 2, 2).setValue(clean.join(','));
        sheet.getRange(i + 2, 3).setValue(new Date());
        found = true;
        break;
      }
    }
  }
  if (!found) return { success: false, message: 'Task not found.' };
  invalidateTasksCache_();
  return { success: true, message: 'Task "' + taskName + '" updated.' };
}

/** Client-callable (manage_roles): delete a task type. */
function deleteTask(token, taskName) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_roles');
  taskName = String(taskName || '').trim();
  var sheet = getOrCreateConfigSheet_(CONFIG.SHEETS.TASKS);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim() === taskName) {
        sheet.deleteRow(i + 2);
        invalidateTasksCache_();
        return { success: true, message: 'Task "' + taskName + '" deleted.' };
      }
    }
  }
  return { success: false, message: 'Task not found.' };
}

/**
 * ----------------------------------------------------------------------------
 * DYNAMIC EMAIL SUBJECTS (spec round 2, #4)
 * ----------------------------------------------------------------------------
 * A single lookup so every notification email gets a clear, event-specific
 * subject line instead of a generic one. Pass one of these keys; unknown
 * keys fall back to the key itself so a call site is never left without a
 * subject even if EMAIL_SUBJECTS_ is not extended for it right away.
 */
var EMAIL_SUBJECTS_ = {
  scheduleCreated: 'New Schedule Created',
  scheduleUpdated: 'Schedule Updated',
  scheduleDeleted: 'Schedule Deleted',
  day1SlotDeleted: 'Day 1 Slot Deleted',
  day2SlotDeleted: 'Day 2 Slot Deleted',
  day1SlotEdited: 'Day 1 Slot Edited',
  day2SlotEdited: 'Day 2 Slot Edited',
  staffAssignment: 'Staff Assignment',
  staffReassignment: 'Staff Reassignment',
  bookingConfirmation: 'Participant Booking Confirmation',
  bookingRescheduled: 'Booking Rescheduled',
  bookingCancelled: 'Booking Cancelled',
  bookingUnbooked: 'Booking Unbooked',
  adminBookingUnbooked: 'Admin Unbooking',
  bloodDrawingAssignment: 'Blood Drawing Assignment',
  bloodDrawingReassignment: 'Blood Drawing Reassignment',
  bloodDrawingSlotCreated: 'Blood Drawing Slot Created',
  bloodDrawingAvailabilityUpdated: 'Blood Drawing Availability Updated',
  bloodDrawingUpdates: 'Blood Drawing Updates',
  bloodDrawingSlotBooked: 'Blood Drawing Slot Booked',
  bloodDrawingSlotUnbooked: 'Blood Drawing Slot Unbooked',
  bloodDrawingSlotDeleted: 'Blood Drawing Slot Deleted',
  bloodDrawingUnassigned: 'Blood Drawing Slot Unassigned',
  day1ScheduleCreated: 'Day 1 Schedule Created',
  day2ScheduleCreated: 'Day 2 Schedule Created',
  reminderUnassigned: 'Reminder: Unassigned Slots',
  reminderUnbooked: 'Reminder: Unbooked Slots',
  participantMessages: 'Participant Question',
  taAvailabilitySubmitted: 'TA Availability Update',
  mriSlotCreated: 'MRI Slot Created',
  mriSlotUpdated: 'MRI Slot Updated',
  mriSlotDeleted: 'MRI Slot Deleted',
  bulkSchedulingCompleted: 'Bulk Scheduling Completed',
  participantBooking: 'Participant Booking',
  checklistUpdated: 'Experiment Checklist Updated',
  postExperimentUpdates: 'Post-Experiment Updates',
  weeklyReminder: 'Weekly Reminder',
  participantDetailsUpdated: 'Participant Details Updated',
  adminAccountChanges: 'Admin Account Change'
};

/** Builds a "[Prefix] Subject" line from EMAIL_SUBJECTS_, with CONFIG.EXPERIMENT_NAME as the bracketed prefix so recipients can filter by study. */
function emailSubject_(key) {
  var subject = EMAIL_SUBJECTS_[key] || key;
  return '[' + CONFIG.EXPERIMENT_NAME.en + '] ' + subject;
}

/**
 * Composes a bilingual email body with the GERMAN section first, then the
 * English translation (spec round 4, #9). Every system email should pass its
 * two language versions through this so the format is uniform.
 * @param {string} germanBody
 * @param {string} englishBody
 * @return {string}
 */
function bilingualBody_(germanBody, englishBody) {
  var divider = '\n\n----------------------------------------\n\n';
  // Avoid bare "DEUTSCH"/"ENGLISH" tokens that some clients auto-hyperlink.
  return '--- Deutsch ---\n\n' + germanBody + divider + '--- English ---\n\n' + englishBody;
}

/**
 * ----------------------------------------------------------------------------
 * SCHEDULING RULES NOTE (superseded)
 * ----------------------------------------------------------------------------
 * The round-1 and round-2 overlap rules that used to live here have been
 * REPLACED by the round-3 simplified rule set. All overlap validation now
 * goes through validateBehaviouralSlot_() (see the UNIFIED SCHEDULING
 * VALIDATION section earlier in this file), which both the individual and
 * the bulk scheduling workflows call, plus the MRI-vs-MRI check in
 * findMriMriOverlap_().
 */

/**
 * ----------------------------------------------------------------------------
 * DUAL BLOOD DRAWING ASSIGNMENT (spec round 2, #7)
 * ----------------------------------------------------------------------------
 * Blood Drawing slots now carry TWO independent assignments: Assigned Staff
 * and Assigned TA. Both are editable independently via the functions below
 * (createBloodDrawingSlot/bookBloodDrawingSlot from round 1 continue to
 * handle the TA side; these add the Staff side).
 */

/**
 * Round 10: the standalone "Assign Staff" action (previously
 * assignBloodDrawingStaff) has been removed — staff is now set optionally
 * at slot-creation time (see createBloodDrawingSlotInternal_ /
 * bulkCreateBloodDrawingSlots) and can be changed any time afterwards via
 * Edit (editBloodDrawingSlot below), which already fully covers staff
 * changes with the same validation and calendar/notification handling.
 */

/**
 * ----------------------------------------------------------------------------
 * BLOOD DRAWING / TA NOTIFICATIONS (round 2 #9; round 4 #1/#7/#9)
 * ----------------------------------------------------------------------------
 */

/**
 * Notifies Main Admin + the assigned Blood Drawing staff + ALL assigned TAs of
 * a Blood Drawing assignment/update. staffEmails and taEmails may each contain
 * both previous and new assignees so that removed people are notified too;
 * recipients are deduplicated so each person gets exactly one bilingual email.
 * @param {string} slotID
 * @param {Array<string>} staffEmails
 * @param {Array<string>} taEmails
 * @param {string} kind - 'assignment' | 'reassignment' | 'update' | 'availability'
 */
function notifyBloodDrawingChange_(slotID, staffEmails, taEmails, kind) {
  try {
    var subjectKey = kind === 'update' ? 'bloodDrawingUpdates'
      : kind === 'reassignment' ? 'bloodDrawingReassignment'
      : 'bloodDrawingAssignment';
    // Round 4, #8: recipients are governed by the Email Notification matrix.
    // The staff/TA context passed in (previous + new assignees) lets the
    // resolver include exactly the people this change affects when the
    // matrix routes to the BloodDrawingStaff / TechnicalAssistants groups.
    var recipients = resolveNotificationRecipients_(subjectKey, {
      bloodDrawingStaff: staffEmails || [],
      technicalAssistants: taEmails || []
    });
    if (!recipients.length) return;

    // Re-read the slot's CURRENT assignees for the body (post-change state).
    var rec = findBloodDrawingRow_(slotID);
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    var curStaff = rec ? String(rec.values[cols.ASSIGNED_STAFF] || '') : '';
    var curTAs = rec ? parseTaEmails_(rec.values[cols.ASSIGNED_TA]) : [];
    var staffName = curStaff ? getStaffNameByEmail_(curStaff) : '(none)';
    var taNames = curTAs.length ? curTAs.map(function (e) { return getStaffNameByEmail_(e); }).join(', ') : '(none)';

    var content = renderEmailTemplate_(subjectKey, {
      BloodDrawingSlot: slotID,
      AssignedStaff: staffName,
      AssignedTAs: taNames
    });
    MailApp.sendEmail(recipients.join(','), content.subject, content.body);
  } catch (err) {
    Logger.log('notifyBloodDrawingChange_ failed: ' + err);
  }
}

/**
 * Requirement #4: dedicated previous-TA / new-TA notification for a Blood
 * Drawing TA reassignment made via Edit Schedule. Routed through the
 * 'bloodDrawingReassignment' Email Control Matrix entry (independent of
 * 'staffReassignment'), so the Main Admin can control this specific
 * notification without it being bundled with ordinary staff reassignment.
 * Each removed TA is told they were unassigned; each newly-added TA is
 * told they were assigned — exact changes only (requirement #8), never a
 * generic "something changed" notice. Everyone else resolved for the event
 * (Main Admin, etc.) gets one broadcast summarizing both lists.
 * @param {string} bdSummary - "BD-004 (2026-08-15 09:00–09:30)"
 * @param {Array<string>} removedTAs
 * @param {Array<string>} addedTAs
 * @param {string} changedByName
 */
function notifyBloodDrawingTAReassignment_(bdSummary, removedTAs, addedTAs, changedByName) {
  try {
    var resolved = resolveNotificationRecipients_('bloodDrawingReassignment', {
      bloodDrawingStaff: [],
      technicalAssistants: buildDedupedGuestList_((removedTAs || []).concat(addedTAs || []))
    });
    if (!resolved.length) return;
    var resolvedLower = resolved.map(function (e) { return String(e).toLowerCase(); });
    var alreadyNotified = {};

    (removedTAs || []).forEach(function (email) {
      if (resolvedLower.indexOf(email.toLowerCase()) === -1) return;
      alreadyNotified[email.toLowerCase()] = true;
      try {
        MailApp.sendEmail(
          email,
          emailSubject_('bloodDrawingReassignment'),
          bilingualBody_(
            'Sie wurden vom Blutentnahme-Termin ' + bdSummary + ' abgezogen.\nGeändert von: ' + changedByName,
            'You have been removed from Blood Drawing slot ' + bdSummary + '.\nChanged by: ' + changedByName
          )
        );
      } catch (err) {
        Logger.log('notifyBloodDrawingTAReassignment_ (removed TA) failed: ' + err);
      }
    });

    (addedTAs || []).forEach(function (email) {
      if (resolvedLower.indexOf(email.toLowerCase()) === -1) return;
      alreadyNotified[email.toLowerCase()] = true;
      try {
        MailApp.sendEmail(
          email,
          emailSubject_('bloodDrawingReassignment'),
          bilingualBody_(
            'Sie wurden dem Blutentnahme-Termin ' + bdSummary + ' zugewiesen.\nGeändert von: ' + changedByName,
            'You have been assigned to Blood Drawing slot ' + bdSummary + '.\nChanged by: ' + changedByName
          )
        );
      } catch (err) {
        Logger.log('notifyBloodDrawingTAReassignment_ (new TA) failed: ' + err);
      }
    });

    var broadcastRecipients = resolved.filter(function (e) { return !alreadyNotified[String(e).toLowerCase()]; });
    if (broadcastRecipients.length) {
      var removedNames = (removedTAs || []).map(function (e) { return getStaffNameByEmail_(e) || e; }).join(', ') || '(none)';
      var addedNames = (addedTAs || []).map(function (e) { return getStaffNameByEmail_(e) || e; }).join(', ') || '(none)';
      MailApp.sendEmail(
        broadcastRecipients.join(','),
        emailSubject_('bloodDrawingReassignment'),
        bilingualBody_(
          'Blutentnahme-Termin: ' + bdSummary + '\nEntfernte TA(s): ' + removedNames + '\nNeue TA(s): ' + addedNames + '\nGeändert von: ' + changedByName,
          'Blood Drawing slot: ' + bdSummary + '\nRemoved TA(s): ' + removedNames + '\nNew TA(s): ' + addedNames + '\nChanged by: ' + changedByName
        )
      );
    }
  } catch (err) {
    Logger.log('notifyBloodDrawingTAReassignment_ failed: ' + err);
  }
}

/**
 * Notifies whoever is routed for 'mriSlotCreated' (Main Admin and/or
 * Technical Assistants, by default) that new MRI slot(s) were created.
 * Round 11: consolidated from two separate emails (an admin-only hardcoded
 * notice, and a TA-only notice piggybacking on the unrelated
 * 'taAvailabilitySubmitted' event) into one call, one controllable event,
 * one editable template — see the 'mriSlotCreated' entry in
 * CONFIG.EMAIL_TEMPLATES_DEFAULT.
 * @param {Array<Object>} created - [{slotID, date, startTime, endTime}]
 */
function notifyMriSlotsCreated_(created) {
  try {
    if (!created || !created.length) return;
    var recipients = resolveNotificationRecipients_('mriSlotCreated', {
      technicalAssistants: getTAList_().map(function (t) { return t.email; })
    });
    if (!recipients.length) return;

    var details = created.map(function (s) {
      return s.slotID + ' \u2014 ' + s.date + ' ' + s.startTime + '\u2013' + s.endTime;
    }).join('\n');

    var content = renderEmailTemplate_('mriSlotCreated', {
      Details: details,
      AdminPortalLink: getAdminPortalUrl_()
    });
    MailApp.sendEmail(recipients.join(','), content.subject, content.body);
  } catch (err) {
    Logger.log('notifyMriSlotsCreated_ failed: ' + err);
  }
}

/**
 * ----------------------------------------------------------------------------
 * AUTOMATIC BLOOD DRAWING ASSIGNMENT (spec round 2, #12)
 * ----------------------------------------------------------------------------
 * Extends autoCreateBloodDrawingSlot_ (round 1) to also: default the Blood
 * Drawing Staff to the Day 1 staff member, and try to auto-assign an
 * available, non-double-booked TA. If none is available, the slot is left
 * unassigned, the Main Admin is notified, and it will appear in the
 * Monday/Wednesday reminder (sendBloodDrawingAssignmentReminder_ already
 * covers unassigned slots — no separate change needed there).
 */
function autoAssignBloodDrawingStaffAndTA_(slotID, day1StaffEmail, suppressNotification) {
  try {
    var rec = findBloodDrawingRow_(slotID);
    if (!rec) return null;
    var cols = CONFIG.BLOOD_DRAWING_COLS;
    if (day1StaffEmail) {
      rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_STAFF + 1).setValue(day1StaffEmail);
    }

    var startDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.START_TIME]);
    var endDT = combineDateAndTime_(rec.values[cols.DATE], rec.values[cols.END_TIME]);
    var availableTA = findAvailableNonConflictingTA_(rec.values[cols.DATE], startDT, endDT);
    var summary = slotID + ' (' + formatDateForDisplay_(rec.values[cols.DATE], 'en') + ' ' +
      formatTimeForDisplay_(rec.values[cols.START_TIME], 'en') + '\u2013' + formatTimeForDisplay_(rec.values[cols.END_TIME], 'en') + ')';

    if (availableTA) {
      var eventId = upsertBloodDrawingCalendarEvent_(slotID, startDT, endDT, [availableTA.email], '', '', 'Scheduled', day1StaffEmail || '');
      rec.sheet.getRange(rec.rowIndex, cols.ASSIGNED_TA + 1).setValue(serializeTaEmails_([availableTA.email]));
      rec.sheet.getRange(rec.rowIndex, cols.CALENDAR_EVENT_ID + 1).setValue(eventId);
      if (suppressNotification) {
        // Round 13: bulk callers collect this instead of emailing per slot —
        // see notifyBloodDrawingAssignmentsBatch_.
        return { slotID: slotID, summary: summary, assigned: true, staffEmail: day1StaffEmail || '', taEmail: availableTA.email };
      }
      notifyBloodDrawingChange_(slotID, [day1StaffEmail || ''], [availableTA.email], 'assignment');
      return { slotID: slotID, summary: summary, assigned: true, staffEmail: day1StaffEmail || '', taEmail: availableTA.email };
    } else {
      if (suppressNotification) {
        return { slotID: slotID, summary: summary, assigned: false, staffEmail: day1StaffEmail || '' };
      }
      // Round 10 fix: this used to share the 'bloodDrawingAssignment' toggle
      // with routine assignment-confirmation emails, which made it
      // impossible to control separately even though it's a materially
      // different kind of message (an action-needed alert, not a routine
      // confirmation). Now has its own dedicated 'bloodDrawingUnassigned'
      // entry in the Email Notification Settings matrix.
      var recipients = resolveNotificationRecipients_('bloodDrawingUnassigned', {
        assignedStaff: day1StaffEmail ? [day1StaffEmail] : [],
        bloodDrawingStaff: day1StaffEmail ? [day1StaffEmail] : []
      });
      if (recipients.length) {
        // Round 10 fix (part 2): now actually rendered through the editable
        // Email Templates catalog (renderEmailTemplate_) like every other
        // templated notification, instead of a hardcoded inline body the
        // Main Admin had no way to customize even though the routing was
        // controllable. See the 'bloodDrawingUnassigned' entry in
        // CONFIG.EMAIL_TEMPLATES_DEFAULT.
        var content = renderEmailTemplate_('bloodDrawingUnassigned', {
          BloodDrawingSlot: slotID,
          AdminPortalLink: getAdminPortalUrl_()
        });
        MailApp.sendEmail(recipients.join(','), content.subject, content.body);
      }
      return { slotID: slotID, summary: summary, assigned: false, staffEmail: day1StaffEmail || '' };
    }
  } catch (err) {
    Logger.log('autoAssignBloodDrawingStaffAndTA_ failed for ' + slotID + ': ' + err);
    return null;
  }
}

/**
 * Round 13: sends ONE consolidated email covering every Blood Drawing
 * auto-assignment result across a WHOLE bulk operation (e.g. pushing
 * several MRI slots to schedule in one action), instead of one email per
 * slot. Successfully-assigned slots go out under 'bloodDrawingAssignment'
 * (one line per slot, addressed to whoever is routed for that event, with
 * the assigned staff/TA context folded in); any left unassigned (no
 * available TA) go out separately under 'bloodDrawingUnassigned' so that
 * "needs attention" alert stays distinguishable from routine confirmations.
 * @param {Array<Object>} bdResults - autoAssignBloodDrawingStaffAndTA_ results
 */
function notifyBloodDrawingAssignmentsBatch_(bdResults) {
  try {
    var results = (bdResults || []).filter(Boolean);
    if (!results.length) return;

    var assigned = results.filter(function (r) { return r.assigned; });
    var unassigned = results.filter(function (r) { return !r.assigned; });

    if (assigned.length) {
      var assignedStaffEmails = buildDedupedGuestList_(assigned.map(function (r) { return r.staffEmail; }));
      var assignedTAEmails = buildDedupedGuestList_(assigned.map(function (r) { return r.taEmail; }));
      var recipients = resolveNotificationRecipients_('bloodDrawingAssignment', {
        assignedStaff: assignedStaffEmails,
        bloodDrawingStaff: assignedStaffEmails,
        technicalAssistants: assignedTAEmails
      });
      if (recipients.length) {
        var details = assigned.map(function (r) {
          return r.summary + ' \u2014 Staff: ' + (r.staffEmail ? (getStaffNameByEmail_(r.staffEmail) || r.staffEmail) : '(none)') +
            ', TA: ' + (getStaffNameByEmail_(r.taEmail) || r.taEmail);
        }).join('\n');
        var content = renderEmailTemplate_('bloodDrawingAssignment', {
          BloodDrawingSlot: assigned.length + ' slot(s)',
          AssignedStaff: details,
          AssignedTAs: ''
        });
        MailApp.sendEmail(recipients.join(','), content.subject, content.body);
      }
    }

    if (unassigned.length) {
      var unassignedStaffEmails = buildDedupedGuestList_(unassigned.map(function (r) { return r.staffEmail; }));
      var uRecipients = resolveNotificationRecipients_('bloodDrawingUnassigned', {
        assignedStaff: unassignedStaffEmails,
        bloodDrawingStaff: unassignedStaffEmails
      });
      if (uRecipients.length) {
        var uDetails = unassigned.map(function (r) { return r.summary; }).join('\n');
        var uContent = renderEmailTemplate_('bloodDrawingUnassigned', {
          BloodDrawingSlot: uDetails,
          AdminPortalLink: getAdminPortalUrl_()
        });
        MailApp.sendEmail(uRecipients.join(','), uContent.subject, uContent.body);
      }
    }
  } catch (err) {
    Logger.log('notifyBloodDrawingAssignmentsBatch_ failed: ' + err);
  }
}

/**
 * Requirement #4: whether a specific TA has submitted availability (via the
 * TA Availability Portal) covering the given date/time window. Used as a
 * non-blocking check when an admin manually assigns/reassigns a Blood
 * Drawing TA through Edit Schedule — a mismatch is surfaced as a warning,
 * not a hard block (the admin's direct assignment is a deliberate override).
 * @param {string} taEmail
 * @param {Date} dateVal
 * @param {Date} startVal
 * @param {Date} endVal
 * @return {boolean}
 */
function taHasSubmittedAvailability_(taEmail, dateVal, startVal, endVal) {
  var email = String(taEmail || '').trim().toLowerCase();
  if (!email) return true; // nothing to check
  var availCols = CONFIG.TA_AVAILABILITY_COLS;
  var dateStr = toIsoDateStr_(dateVal);
  var startDT = combineDateAndTime_(dateVal, startVal);
  var endDT = combineDateAndTime_(dateVal, endVal);
  return getDataRows_(CONFIG.SHEETS.TA_AVAILABILITY).some(function (row) {
    if (String(row[availCols.TA_EMAIL] || '').trim().toLowerCase() !== email) return false;
    if (toIsoDateStr_(row[availCols.DATE]) !== dateStr) return false;
    var availStart = combineDateAndTime_(row[availCols.DATE], row[availCols.START_TIME]);
    var availEnd = combineDateAndTime_(row[availCols.DATE], row[availCols.END_TIME]);
    if (!availStart || !availEnd) return false;
    return startDT.getTime() >= availStart.getTime() && endDT.getTime() <= availEnd.getTime();
  });
}

/**
 * Finds a TA who (a) has submitted availability covering [startDT, endDT]
 * on the given date, and (b) is not already assigned to another Blood
 * Drawing slot that overlaps this one. Returns the first match, or null.
 */
function findAvailableNonConflictingTA_(dateVal, startDT, endDT) {
  var availCols = CONFIG.TA_AVAILABILITY_COLS;
  var dateStr = toIsoDateStr_(dateVal);
  var availRows = getDataRows_(CONFIG.SHEETS.TA_AVAILABILITY);
  var candidateEmails = [];
  availRows.forEach(function (row) {
    if (toIsoDateStr_(row[availCols.DATE]) !== dateStr) return;
    var availStart = combineDateAndTime_(row[availCols.DATE], row[availCols.START_TIME]);
    var availEnd = combineDateAndTime_(row[availCols.DATE], row[availCols.END_TIME]);
    if (!availStart || !availEnd) return;
    if (startDT.getTime() >= availStart.getTime() && endDT.getTime() <= availEnd.getTime()) {
      candidateEmails.push(String(row[availCols.TA_EMAIL] || '').trim().toLowerCase());
    }
  });
  if (!candidateEmails.length) return null;

  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  var bdRows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var taList = getTAList_();

  for (var i = 0; i < candidateEmails.length; i++) {
    var email = candidateEmails[i];
    var ta = taList.filter(function (t) { return t.email.toLowerCase() === email; })[0];
    if (!ta) continue;
    var conflict = bdRows.some(function (row) {
      var rowTAs = parseTaEmails_(row[bdCols.ASSIGNED_TA]).map(function (e) { return e.toLowerCase(); });
      if (rowTAs.indexOf(email) === -1) return false;
      var rowStart = combineDateAndTime_(row[bdCols.DATE], row[bdCols.START_TIME]);
      var rowEnd = combineDateAndTime_(row[bdCols.DATE], row[bdCols.END_TIME]);
      if (!rowStart || !rowEnd) return false;
      return startDT.getTime() < rowEnd.getTime() && rowStart.getTime() < endDT.getTime();
    });
    if (!conflict) return ta;
  }
  return null;
}

/**
 * ----------------------------------------------------------------------------
 * POST-EXPERIMENT UPDATES & RECORDS (spec round 2, #10, #11)
 * ----------------------------------------------------------------------------
 * A dedicated, silent (no emails/notifications) completion-tracking screen
 * plus its own spreadsheet, independent of the operational Bookings/slot
 * sheets — one row per participant booking, kept in sync lazily (created
 * the first time it's touched for a given booking).
 */

/** Finds (or lazily creates) the PostExperimentRecords row for a booking, populated from the current Bookings/slot data. Returns {sheet, rowIndex, values}. */
function findOrCreatePostExperimentRecord_(bookingID) {
  var sheet = getSheet_(CONFIG.SHEETS.POST_EXPERIMENT);
  var cols = CONFIG.POST_EXPERIMENT_COLS;
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 20).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][cols.BOOKING_ID] || '') === bookingID) {
        return { sheet: sheet, rowIndex: i + 2, values: values[i] };
      }
    }
  }

  var booking = findBookingByConfirmation_(bookingID);
  if (!booking) return null;
  var bcols = CONFIG.BOOKING_COLS;
  var scols = CONFIG.SLOT_COLS;
  var day1ID = String(booking.values[bcols.DAY1_SLOT_ID] || '');
  var day2ID = String(booking.values[bcols.DAY2_SLOT_ID] || '');
  var d1 = getSlotByFullRow_(CONFIG.SHEETS.DAY1, day1ID);
  var d2 = getSlotByFullRow_(CONFIG.SHEETS.DAY2, day2ID);
  var mriID = d1 ? String(d1.values[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '') : '';
  var mri = mriID ? getSlotByFullRow_(CONFIG.SHEETS.MRI, mriID) : null;
  var mriDateTime = mri ? (formatDateForDisplay_(mri.values[scols.DATE], 'en') + ' ' + formatTimeForDisplay_(mri.values[scols.START_TIME], 'en')) : '';

  var bdRows = getDataRows_(CONFIG.SHEETS.BLOOD_DRAWING);
  var bdCols = CONFIG.BLOOD_DRAWING_COLS;
  var bdRow = bdRows.filter(function (r) { return String(r[bdCols.DAY1_SLOT_ID] || '') === day1ID; })[0];

  var newRow = [
    bookingID,
    String(booking.values[bcols.TITLE] || ''),
    String(booking.values[bcols.NAME] || ''),
    String(booking.values[bcols.EMAIL] || ''),
    mriID,
    mriDateTime,
    day1ID,
    day2ID,
    bdRow ? String(bdRow[bdCols.SLOT_ID] || '') : '',
    d1 ? String(d1.values[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '') : '',
    d2 ? String(d2.values[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '') : '',
    bdRow ? String(bdRow[bdCols.ASSIGNED_STAFF] || '') : '',
    bdRow ? String(bdRow[bdCols.ASSIGNED_TA] || '') : '',
    false, false, false, false,
    '', '', new Date()
  ];
  sheet.appendRow(newRow);
  return { sheet: sheet, rowIndex: sheet.getLastRow(), values: newRow };
}

/** Client-callable ('view' at minimum; writes require 'manage_bookings' or 'manage_participants'): every Post-Experiment record, refreshed from current booking data for any booking that doesn't have one yet. */
function getPostExperimentRecords(token) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'view');

  var bookingsSheet = getSheet_(CONFIG.SHEETS.BOOKINGS);
  var lastRow = bookingsSheet.getLastRow();
  var cols = CONFIG.BOOKING_COLS;
  if (lastRow >= 2) {
    var bookingValues = bookingsSheet.getRange(2, 1, lastRow - 1, CONFIG.BOOKING_ROW_WIDTH).getValues();
    bookingValues.forEach(function (row) {
      var bookingID = String(row[cols.CONFIRMATION_NUMBER] || '');
      if (bookingID && String(row[cols.STATUS]) === 'Booked') findOrCreatePostExperimentRecord_(bookingID);
    });
  }

  var sheet = getSheet_(CONFIG.SHEETS.POST_EXPERIMENT);
  var peLastRow = sheet.getLastRow();
  if (peLastRow < 2) return [];
  var pcols = CONFIG.POST_EXPERIMENT_COLS;
  return sheet.getRange(2, 1, peLastRow - 1, 20).getValues().map(function (row) {
    return {
      bookingID: String(row[pcols.BOOKING_ID] || ''),
      participantTitle: String(row[pcols.PARTICIPANT_TITLE] || ''),
      participantName: String(row[pcols.PARTICIPANT_NAME] || ''),
      mriSlotID: String(row[pcols.MRI_SLOT_ID] || ''),
      mriDateTime: String(row[pcols.MRI_DATE_TIME] || ''),
      day1SlotID: String(row[pcols.DAY1_SLOT_ID] || ''),
      day2SlotID: String(row[pcols.DAY2_SLOT_ID] || ''),
      bloodDrawingSlotID: String(row[pcols.BLOOD_DRAWING_SLOT_ID] || ''),
      day1Complete: isBooked_(row[pcols.DAY1_COMPLETE]),
      bloodDrawingComplete: isBooked_(row[pcols.BLOOD_DRAWING_COMPLETE]),
      mriComplete: isBooked_(row[pcols.MRI_COMPLETE]),
      day2Complete: isBooked_(row[pcols.DAY2_COMPLETE]),
      comments: String(row[pcols.COMMENTS] || ''),
      updatedBy: String(row[pcols.UPDATED_BY] || ''),
      updatedAt: row[pcols.UPDATED_AT] ? formatDateForDisplay_(row[pcols.UPDATED_AT], 'en') : ''
    };
  });
}

/**
 * Client-callable (manage_bookings or manage_participants): updates one or
 * more completion checkboxes + comments for a booking in a single
 * operation. Deliberately sends NO emails or notifications (spec #10).
 */
function updatePostExperimentRecord(token, bookingID, updates) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('manage_bookings') === -1 && perms.indexOf('manage_participants') === -1) {
    throw new Error('Your role does not have permission to update post-experiment records.');
  }

  var rec = findOrCreatePostExperimentRecord_(String(bookingID || '').trim());
  if (!rec) return { success: false, message: 'Booking not found.' };
  var cols = CONFIG.POST_EXPERIMENT_COLS;
  updates = updates || {};

  if (updates.hasOwnProperty('day1Complete')) rec.sheet.getRange(rec.rowIndex, cols.DAY1_COMPLETE + 1).setValue(!!updates.day1Complete);
  if (updates.hasOwnProperty('bloodDrawingComplete')) rec.sheet.getRange(rec.rowIndex, cols.BLOOD_DRAWING_COMPLETE + 1).setValue(!!updates.bloodDrawingComplete);
  if (updates.hasOwnProperty('mriComplete')) rec.sheet.getRange(rec.rowIndex, cols.MRI_COMPLETE + 1).setValue(!!updates.mriComplete);
  if (updates.hasOwnProperty('day2Complete')) rec.sheet.getRange(rec.rowIndex, cols.DAY2_COMPLETE + 1).setValue(!!updates.day2Complete);
  if (updates.hasOwnProperty('comments')) rec.sheet.getRange(rec.rowIndex, cols.COMMENTS + 1).setValue(String(updates.comments || ''));

  rec.sheet.getRange(rec.rowIndex, cols.UPDATED_BY + 1).setValue(session.email);
  rec.sheet.getRange(rec.rowIndex, cols.UPDATED_AT + 1).setValue(new Date());

  return { success: true, message: 'Post-experiment record updated.' };
}

/**
 * ----------------------------------------------------------------------------
 * BULK MRI SLOT CREATION / SCHEDULING (spec round 2, #8, #13)
 * ----------------------------------------------------------------------------
 * Validates a batch of candidate MRI slots together (each independently,
 * plus cross-checked against each other within the same batch), then
 * commits them all in one transaction with a single consolidated
 * notification. A second step (bulkCreateSchedulesFromMri) pushes some or
 * all of the newly created MRI slots into full Day1/Day2/Blood Drawing
 * schedules, also as one transaction with one consolidated notification.
 */

/**
 * Client-callable (manage_slots): validates a batch of candidate MRI slots
 * without writing anything. Each candidate: {date, startTime,
 * durationMinutes, timeBeforeMriMinutes}. Returns per-slot validation
 * results so the admin can fix invalid ones without affecting the rest.
 */
function validateBulkMriSlots(token, candidates) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var results = (candidates || []).map(function (c, idx) {
    var start = parseTimeInput_(c.startTime);
    var date = parseDateInput_(c.date);
    var duration = parseInt(c.durationMinutes, 10);
    var timeBefore = parseInt(c.timeBeforeMriMinutes, 10);
    if (!date || !start || !duration || duration <= 0 || !timeBefore || timeBefore <= 0) {
      return { index: idx, valid: false, message: 'Please provide a valid date, start time, duration, and time-required-before-MRI.' };
    }
    var end = addMinutesToTimeStr_(toHmStr_(start), duration);
    var mriStart = combineDateAndTime_(date, start);
    var mriEnd = combineDateAndTime_(date, parseTimeInput_(end));

    // Round 5 fix: route through the SAME centralized, config-driven
    // validator as everything else. This used to hardcode MRI×MRI as an
    // unconditional block and Day1/Day2 overlap as an unconditional warning
    // — neither respected the Scheduling Rules config, and Blood Drawing
    // wasn't scanned at all.
    var candidateValidation = validateSchedulingSlot_({
      candidateType: 'MRI',
      dateStr: c.date,
      startTimeStr: c.startTime,
      durationMinutes: duration,
      staffEmail: '',
      label: 'MRI slot #' + (idx + 1)
    });

    // BLOCKING: cross-check within this same batch (later slots vs earlier ones).
    var batchConflict = null;
    for (var j = 0; j < idx; j++) {
      var other = candidates[j];
      if (other.date !== c.date) continue;
      var otherStart = combineDateAndTime_(parseDateInput_(other.date), parseTimeInput_(other.startTime));
      var otherEnd = combineDateAndTime_(parseDateInput_(other.date), parseTimeInput_(
        addMinutesToTimeStr_(other.startTime, parseInt(other.durationMinutes, 10))));
      if (otherStart && otherEnd && mriStart.getTime() < otherEnd.getTime() && otherStart.getTime() < mriEnd.getTime()) {
        batchConflict = { index: j };
        break;
      }
    }

    var blocked = candidateValidation.errors.length > 0 || !!batchConflict;
    var messages = candidateValidation.errors.slice();
    if (batchConflict) messages.push('Overlaps another new MRI slot (#' + (batchConflict.index + 1) + ') in this batch \u2014 blocking.');

    return {
      index: idx,
      valid: !blocked,
      message: messages.join(' '),
      warnings: candidateValidation.warnings,
      computedEndTime: end
    };
  });

  return { results: results };
}

/**
 * Client-callable (manage_slots): commits a batch of already-validated MRI
 * slots in a single transaction, then sends ONE consolidated notification
 * to the Main Admin and notifies all TAs that new Blood Drawing
 * availability is needed.
 * @param {string} token
 * @param {Array<{date,startTime,durationMinutes,timeBeforeMriMinutes}>} candidates
 */
function bulkCreateMriSlots(token, candidates) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var validation = validateBulkMriSlots(token, candidates);
  if (validation.results.some(function (r) { return !r.valid; })) {
    return { success: false, message: 'One or more MRI slots still have blocking conflicts. Fix them before saving.', results: validation.results };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    var created = [];
    var allBdResults = [];
    (candidates || []).forEach(function (c) {
      var date = parseDateInput_(c.date);
      var start = parseTimeInput_(c.startTime);
      var duration = parseInt(c.durationMinutes, 10);
      var end = parseTimeInput_(addMinutesToTimeStr_(c.startTime, duration));
      var slotId = generateNextSlotId_(CONFIG.SHEETS.MRI, 'MRI');
      var mriCalEventId = upsertMriCalendarEvent_('mriSlotCreated', slotId,
        combineDateAndTime_(date, start), combineDateAndTime_(date, end), session.email, '');
      getSheet_(CONFIG.SHEETS.MRI).appendRow([slotId, date, start, end, false, '', '', session.email, new Date(), mriCalEventId]);
      created.push({ slotID: slotId, date: c.date, startTime: c.startTime, endTime: toHmStr_(end) });

      // Requirement #1: Blood Drawing slot creation moves from schedule
      // creation to MRI creation — every MRI slot gets its linked Blood
      // Drawing slot right away, with the existing TA-availability rule
      // auto-assigning a TA if one is free, else left Unassigned.
      // suppressNotification=true: batched into ONE consolidated email
      // below instead of one per MRI slot.
      var bdCreate = autoCreateBloodDrawingSlotForMri_(
        slotId, date, start, c.timeBeforeMriMinutes, session.email, true
      );
      if (bdCreate.bloodDrawingAssignment) allBdResults.push(bdCreate.bloodDrawingAssignment);
    });

    // Round 11 fix: this used to send TWO separate emails for the same
    // event — a hardcoded, non-templated admin-only notice routed through
    // 'mriSlotCreated', PLUS a separate TA-facing notice piggybacking on
    // the unrelated 'taAvailabilitySubmitted' event (which is really about
    // a TA submitting THEIR OWN availability, not about MRI slots being
    // created — routing it there made it impossible to find/control).
    // Consolidated into one call, one event ('mriSlotCreated'), one
    // editable template, covering whichever recipients are configured
    // (MainAdmin and/or TechnicalAssistants by default).
    notifyMriSlotsCreated_(created);
    // One consolidated Blood Drawing assignment/unassigned notice for the
    // whole batch, same pattern as the push-to-schedule bulk path.
    if (allBdResults.length) notifyBloodDrawingAssignmentsBatch_(allBdResults);

    return { success: true, message: created.length + ' MRI slot(s) created.', created: created };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Client-callable (manage_slots): pushes one or more newly-created MRI
 * slots into full schedules (Day1 + Day2 + auto Blood Drawing) in a single
 * transaction, with one consolidated notification at the end. Each entry:
 * {mriSlotID, day1StaffEmail, day2Assignments: [{day2SlotID, staffEmail}, ...]}.
 * Reuses createScheduleFromMri's per-slot logic and staff-aware overlap
 * rule; a failure on one entry stops the whole batch (nothing is partially
 * committed) so the "single transaction" requirement holds.
 */
function bulkCreateSchedulesFromMri(token, entries) {
  var session = requireAdminAuth_(token);
  requirePermission_(session, 'manage_slots');

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.LOCK_TIMEOUT_MS);
  } catch (lockError) {
    return { success: false, message: 'The system is busy. Please try again in a moment.' };
  }

  try {
    // Phase 1 — validate every entry with dryRun before writing anything.
    // Push must not partially apply schedules.
    for (var v = 0; v < (entries || []).length; v++) {
      var pre = entries[v];
      var preResult = createScheduleFromMriInternal_(session, {
        mriSlotID: pre.mriSlotID,
        day1StaffEmail: pre.day1StaffEmail,
        timeBeforeMriMinutes: pre.timeBeforeMriMinutes,
        mriDurationMinutes: pre.mriDurationMinutes,
        existingDay2: pre.existingDay2 || [],
        newDay2List: pre.newDay2List || [],
        language: pre.language,
        suppressNotification: true,
        dryRun: true
      });
      if (!preResult.success) {
        return {
          success: false,
          message: 'Validation failed for MRI slot ' + pre.mriSlotID + ': ' + preResult.message +
            '. No schedules were created.',
          errors: preResult.errors || [preResult.message],
          warnings: preResult.warnings || [],
          partiallyCreated: []
        };
      }
    }

    var allCreated = [];
    var allWarnings = [];
    var allScheduleInfos = [];
    var allBdResults = [];
    for (var i = 0; i < (entries || []).length; i++) {
      var entry = entries[i];
      var result = createScheduleFromMriInternal_(session, {
        mriSlotID: entry.mriSlotID,
        day1StaffEmail: entry.day1StaffEmail,
        timeBeforeMriMinutes: entry.timeBeforeMriMinutes,
        mriDurationMinutes: entry.mriDurationMinutes,
        existingDay2: entry.existingDay2 || [],
        newDay2List: entry.newDay2List || [],
        language: entry.language,
        suppressNotification: true
      });
      if (!result.success) {
        // Should be rare after dry-run; do not send success notifications for a failed batch.
        return {
          success: false,
          message: 'Stopped at MRI slot ' + entry.mriSlotID + ': ' + result.message +
            '. Some earlier schedules in this batch may already exist — check the overview tables.',
          errors: result.errors || [result.message],
          warnings: result.warnings || [],
          partiallyCreated: allCreated
        };
      }
      allCreated.push({ mriSlotID: entry.mriSlotID, day1SlotID: result.day1SlotID, day2SlotIDs: result.day2SlotIDs || [] });
      allWarnings = allWarnings.concat(result.warnings || []).concat(result.mriOverlapWarnings || []);
      if (result.scheduleInfo) allScheduleInfos.push(result.scheduleInfo);
      if (result.bloodDrawingAssignment) allBdResults.push(result.bloodDrawingAssignment);
    }

    // Round 12/13: ONE consolidated set of assignment emails for the WHOLE
    // bulk operation — a person assigned across several of these pushes
    // gets a single email listing everything, not one email per push, and
    // Blood Drawing auto-assignments (round 13) are batched the same way
    // instead of firing one email per slot (this was a real contributor to
    // hitting Apps Script's daily email quota on a large bulk push).
    if (allScheduleInfos.length) notifyScheduleCreated_(allScheduleInfos);
    if (allBdResults.length) notifyBloodDrawingAssignmentsBatch_(allBdResults);

    var summaryLines = allCreated.map(function (s) {
      return 'MRI ' + s.mriSlotID + ' \u2192 Day 1 ' + s.day1SlotID + ', Day 2: ' + s.day2SlotIDs.join(', ');
    }).join('\n');
    var recipients = resolveNotificationRecipients_('bulkSchedulingCompleted', {});
    // An empty list means the Main Admin deliberately routed this event to
    // nobody — respect that instead of force-mailing Main Admin.
    if (recipients.length) {
      var details = 'Created by: ' + session.name + '\nSchedules created: ' + allCreated.length + '\n\n' + summaryLines;
      var content = renderEmailTemplate_('bulkSchedulingCompleted', { Details: details });
      MailApp.sendEmail(recipients.join(','), content.subject, content.body);
    }

    var msg = allCreated.length + ' schedule(s) created.';
    if (allWarnings.length) msg += ' ' + allWarnings.length + ' permitted-overlap warning(s).';
    return { success: true, message: msg, created: allCreated, warnings: allWarnings };
  } catch (err) {
    // Round 13 safety net: this used to have no top-level catch, so ANY
    // unexpected exception here (a Google service quota error, a transient
    // Calendar/Sheets failure, anything) propagated straight to the client
    // as a raw, opaque "Exception: ..." — including Apps Script's daily
    // email-sending quota error, which is a real risk on a large bulk push
    // even after the consolidation fixes above reduced how many emails one
    // push sends. The slots/schedules already written to the sheet before
    // the failure are NOT lost (Sheets writes aren't transactional and
    // aren't rolled back here) — this just makes sure the admin is told
    // clearly what succeeded instead of being left with a cryptic crash.
    Logger.log('bulkCreateSchedulesFromMri failed partway through: ' + err);
    return {
      success: false,
      message: 'An unexpected error interrupted this operation: ' + err + '. ' +
        (typeof allCreated !== 'undefined' && allCreated.length
          ? (allCreated.length + ' schedule(s) were already created before the error and are NOT lost — check the Day 1/Day 2/MRI tables. ' +
             'Some assignment emails for this batch may not have been sent; try again in a few minutes, or in smaller batches, if this was a Google email-quota error.')
          : 'No schedules were created before the error occurred.'),
      partiallyCreated: (typeof allCreated !== 'undefined' ? allCreated : [])
    };
  } finally {
    lock.releaseLock();
  }
}


/**
 * ============================================================================
 * COMPATIBLE SCHEDULE COMBINATIONS + PDF EXPORT (spec round 4, #3)
 * ============================================================================
 * Generates every valid (Day 1 slot + compatible Day 2 slot) combination
 * from the available, unbooked slots, and can render them to a bilingual
 * (English + German) PDF. Each combination lists the Day 1 slot, its linked
 * MRI slot, the compatible Day 2 slot, and the assigned staff for each.
 */

/**
 * Builds every compatible (Day 1, Day 2) combination from AVAILABLE slots.
 * @param {boolean} availableOnly - if true (default), only unbooked slots
 * @return {Array<Object>} combination rows
 */
function buildCompatibleCombinations_(availableOnly) {
  if (availableOnly === undefined) availableOnly = true;
  var cols = CONFIG.SLOT_COLS;

  var day1Rows = getDataRows_(CONFIG.SHEETS.DAY1).filter(function (r) {
    return r[cols.SLOT_ID] && (!availableOnly || !isBooked_(r[cols.BOOKED]));
  });
  var day2Rows = getDataRows_(CONFIG.SHEETS.DAY2).filter(function (r) {
    return r[cols.SLOT_ID] && (!availableOnly || !isBooked_(r[cols.BOOKED]));
  });

  var combos = [];
  day1Rows.forEach(function (d1) {
    var d1DT = combineDateAndTime_(d1[cols.DATE], d1[cols.START_TIME]);
    var mriSlotID = String(d1[CONFIG.DAY1_EXTRA_COLS.MRI_SLOT_ID] || '');
    var day1Staff = String(d1[CONFIG.DAY1_EXTRA_COLS.ASSIGNED_STAFF] || '');
    var mriRec = mriSlotID ? getSlotByFullRow_(CONFIG.SHEETS.MRI, mriSlotID) : null;

    day2Rows.forEach(function (d2) {
      var d2DT = combineDateAndTime_(d2[cols.DATE], d2[cols.START_TIME]);
      if (!isSlotPairCompatible_(d1DT, d2DT)) return;
      var day2Staff = String(d2[CONFIG.DAY2_EXTRA_COLS.ASSIGNED_STAFF] || '');

      combos.push({
        day1SlotID: String(d1[cols.SLOT_ID]),
        day1Date: d1[cols.DATE],
        day1Start: d1[cols.START_TIME],
        day1End: d1[cols.END_TIME],
        day1Staff: day1Staff,
        day1StaffName: day1Staff ? getStaffNameByEmail_(day1Staff) : '',
        day1Language: normalizeSlotLanguage_(d1[CONFIG.DAY1_EXTRA_COLS.LANGUAGE]),
        mriSlotID: mriSlotID,
        mriDate: mriRec ? mriRec.values[cols.DATE] : null,
        mriStart: mriRec ? mriRec.values[cols.START_TIME] : null,
        mriEnd: mriRec ? mriRec.values[cols.END_TIME] : null,
        day2SlotID: String(d2[cols.SLOT_ID]),
        day2Date: d2[cols.DATE],
        day2Start: d2[cols.START_TIME],
        day2End: d2[cols.END_TIME],
        day2Staff: day2Staff,
        day2StaffName: day2Staff ? getStaffNameByEmail_(day2Staff) : '',
        day2Language: normalizeSlotLanguage_(d2[CONFIG.DAY2_EXTRA_COLS.LANGUAGE])
      });
    });
  });

  // Sort by Day 1 date/time, then Day 2 date/time, for a stable readable order.
  combos.sort(function (a, b) {
    var ad1 = combineDateAndTime_(a.day1Date, a.day1Start).getTime();
    var bd1 = combineDateAndTime_(b.day1Date, b.day1Start).getTime();
    if (ad1 !== bd1) return ad1 - bd1;
    return combineDateAndTime_(a.day2Date, a.day2Start).getTime() -
           combineDateAndTime_(b.day2Date, b.day2Start).getTime();
  });

  return combos;
}

/**
 * Client-callable ('view_reports' or 'view'): every compatible combination,
 * formatted for on-screen display (English labels).
 */
function getCompatibleCombinations(token, availableOnly) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('view_reports') === -1 && perms.indexOf('view') === -1) {
    throw new Error('Your role does not have permission to view reports.');
  }
  var combos = buildCompatibleCombinations_(availableOnly !== false);
  return combos.map(function (c) {
    return {
      day1SlotID: c.day1SlotID,
      day1: formatDateForDisplay_(c.day1Date, 'en') + ' ' + formatTimeForDisplay_(c.day1Start, 'en') +
            '\u2013' + formatTimeForDisplay_(c.day1End, 'en'),
      day1StaffName: c.day1StaffName || '(unassigned)',
      mriSlotID: c.mriSlotID || '(none)',
      mri: c.mriDate ? (formatDateForDisplay_(c.mriDate, 'en') + ' ' + formatTimeForDisplay_(c.mriStart, 'en') +
            '\u2013' + formatTimeForDisplay_(c.mriEnd, 'en')) : '(none)',
      day2SlotID: c.day2SlotID,
      day2: formatDateForDisplay_(c.day2Date, 'en') + ' ' + formatTimeForDisplay_(c.day2Start, 'en') +
            '\u2013' + formatTimeForDisplay_(c.day2End, 'en'),
      day2StaffName: c.day2StaffName || '(unassigned)'
    };
  });
}

/**
 * Client-callable ('view_reports' or 'view'): generates THREE participant-
 * facing PDFs of available compatible combinations — English-only, German-
 * only, and one with no language restriction — and returns all three so the
 * front-end can offer all as downloads in one action.
 *
 * Round 8 changes (per explicit request):
 *  - Always available slots only (booked slots are never eligible for a
 *    participant-facing export — the "availableOnly" toggle was removed
 *    from the caller; this function no longer accepts it).
 *  - Staff names are NEVER included — this is a participant-facing document
 *    and staff assignments are internal information (spec section 2's
 *    "participant-facing content never includes staff" rule, extended here
 *    to this artifact for the same reason).
 *  - A combination only appears in the English PDF if BOTH its Day 1 and
 *    Day 2 slot are language 'en' or 'any'; same logic for German. The
 *    "no preference" PDF has no language restriction — every available
 *    combination, regardless of the language either slot is tagged with.
 * @return {Object} {success, pdfs: [{language, label, fileName, url, base64, count}]}
 */
function generateCombinationsPdfSet(token) {
  var session = requireAdminAuth_(token);
  var perms = getRolePermissionsMap_()[session.role] || [];
  if (perms.indexOf('view_reports') === -1 && perms.indexOf('view') === -1) {
    throw new Error('Your role does not have permission to generate reports.');
  }

  var allCombos = buildCompatibleCombinations_(true); // available slots only — always
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm');

  var variants = [
    { language: 'en', label: 'English', fileSuffix: 'EN' },
    { language: 'de', label: 'German', fileSuffix: 'DE' },
    { language: 'any', label: 'No preference (all languages)', fileSuffix: 'AllLanguages' }
  ];

  var pdfs = variants.map(function (v) {
    var filtered = allCombos.filter(function (c) {
      return slotLanguageMatchesFilter_(c.day1Language, v.language) &&
             slotLanguageMatchesFilter_(c.day2Language, v.language);
    });
    var html = buildCombinationsHtml_(filtered, v.language);
    var blob = Utilities.newBlob(html, 'text/html', 'combinations.html').getAs('application/pdf');
    var fileName = 'AvailableSlots_' + v.fileSuffix + '_' + stamp + '.pdf';
    blob.setName(fileName);

    var url = '';
    try {
      var file = DriveApp.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      url = file.getUrl();
    } catch (e) {
      Logger.log('generateCombinationsPdfSet (' + v.language + '): Drive save failed (' + e + '); returning base64 only.');
    }

    return {
      language: v.language,
      label: v.label,
      fileName: fileName,
      url: url,
      base64: Utilities.base64Encode(blob.getBytes()),
      count: filtered.length
    };
  });

  return { success: true, pdfs: pdfs };
}

/**
 * Builds the participant-facing HTML rendered to PDF for ONE language
 * variant — no staff names anywhere (round 8: this is a document meant to
 * be shared with participants/external parties, so internal staffing is
 * never included, regardless of what the on-screen admin view shows).
 * @param {Array<Object>} combos - already filtered to the target language
 * @param {string} pdfLanguage - 'en' | 'de' | 'any' — controls which
 *   language the PDF's OWN text (headers, labels) is rendered in. 'any'
 *   renders bilingually (English then German), matching the rest of the
 *   app's convention for content with no single audience language.
 */
function buildCombinationsHtml_(combos, pdfLanguage) {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function rowsFor(lang) {
    if (!combos.length) {
      var none = lang === 'de' ? 'Keine verfügbaren Kombinationen.' : 'No available combinations.';
      return '<tr><td colspan="3" style="text-align:center;padding:16px;">' + esc(none) + '</td></tr>';
    }
    return combos.map(function (c, i) {
      var day1 = formatDateForDisplay_(c.day1Date, lang) + ' ' + formatTimeForDisplay_(c.day1Start, lang) +
                 '\u2013' + formatTimeForDisplay_(c.day1End, lang);
      var day2 = formatDateForDisplay_(c.day2Date, lang) + ' ' + formatTimeForDisplay_(c.day2Start, lang) +
                 '\u2013' + formatTimeForDisplay_(c.day2End, lang);
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(c.day1SlotID) + '<br><span class="muted">' + esc(day1) + '</span></td>' +
        '<td>' + esc(c.day2SlotID) + '<br><span class="muted">' + esc(day2) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function tableFor(lang) {
    var h = lang === 'de'
      ? { title: 'Verfügbare Terminkombinationen', sub: 'Alle verfügbaren Kombinationen aus Tag-1- und Tag-2-Terminen',
          n: 'Nr.', d1: 'Tag 1 (Termin / Zeit)',
          d2: 'Tag 2 (Termin / Zeit)', count: 'Anzahl der Kombinationen', generated: 'Erstellt am' }
      : { title: 'Available Schedule Combinations', sub: 'All available combinations of Day 1 and Day 2 slots',
          n: 'No.', d1: 'Day 1 (Slot / Time)',
          d2: 'Day 2 (Slot / Time)', count: 'Number of combinations', generated: 'Generated on' };
    var when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    return '<h1>' + esc(h.title) + '</h1>' +
      '<p class="sub">' + esc(h.sub) + '</p>' +
      '<p class="meta">' + esc(h.count) + ': ' + combos.length + ' &nbsp;|&nbsp; ' + esc(h.generated) + ': ' + esc(when) + '</p>' +
      '<table><thead><tr>' +
        '<th>' + esc(h.n) + '</th><th>' + esc(h.d1) + '</th><th>' + esc(h.d2) + '</th>' +
      '</tr></thead><tbody>' + rowsFor(lang) + '</tbody></table>';
  }

  var body = (pdfLanguage === 'de') ? tableFor('de')
    : (pdfLanguage === 'en') ? tableFor('en')
    : (tableFor('en') + '<div class="pagebreak"></div>' + tableFor('de')); // 'any' — bilingual

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;font-size:11px;margin:24px;}' +
    'h1{font-size:18px;margin:0 0 4px;}' +
    '.sub{margin:0 0 6px;color:#444;}' +
    '.meta{margin:0 0 12px;color:#666;font-size:10px;}' +
    'table{width:100%;border-collapse:collapse;margin-bottom:28px;}' +
    'th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top;}' +
    'th{background:#f0f0f0;}' +
    '.muted{color:#666;font-size:10px;}' +
    '.pagebreak{page-break-before:always;}' +
    '</style></head><body>' +
    body +
    '</body></html>';
}

function initializeSpreadsheet() {
  var ss = getSpreadsheet_();

  createSheetIfMissing_(ss, CONFIG.SHEETS.DAY1,
    ['SlotID', 'Date', 'StartTime', 'EndTime', 'Booked', 'MRISlotID', 'AssignedStaff',
     'CalendarEventID', 'CreatedBy', 'CreatedAt', 'Language']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.DAY2,
    ['SlotID', 'Date', 'StartTime', 'EndTime', 'Booked', 'AssignedStaff',
     'CalendarEventID', 'CreatedBy', 'CreatedAt', 'Language']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.BOOKINGS,
    ['Timestamp', 'ParticipantID', 'Name', 'Email', 'Day1SlotID', 'Day2SlotID',
     'ConfirmationNumber', 'Passcode', 'Comments', 'Status', 'NextAvailability', 'UpdatedAt',
     'Title', 'CreatedByAdmin', 'Gender', 'FirstName', 'LastName', 'Language']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.MRI,
    ['SlotID', 'Date', 'StartTime', 'EndTime', 'Booked', 'Day1Staff', 'Day2Staff',
     'CreatedBy', 'CreatedAt', 'CalendarEventID']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.STAFF,
    ['Name', 'Email']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.ADMINS,
    ['Name', 'Email', 'Role', 'PasswordHash', 'PasswordSalt', 'Active', 'CreatedAt']);

  // ---- 2026-08 requirements pass additions (round 1) ----
  createSheetIfMissing_(ss, CONFIG.SHEETS.ROLES,
    ['RoleName', 'Permissions', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.BLOOD_DRAWING,
    ['SlotID', 'Date', 'StartTime', 'EndTime', 'Booked', 'AssignedTA', 'CalendarEventID',
     'Day1SlotID', 'ParticipantConfirmationNumber', 'ParticipantName', 'CreatedBy', 'CreatedAt',
     'AssignedStaff']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.TA_AVAILABILITY,
    ['TAEmail', 'TAName', 'Date', 'StartTime', 'EndTime', 'Notes', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.STAFF_COLORS,
    ['Email', 'ColorId']);

  // ---- 2026-08 requirements pass additions (round 2) ----
  createSheetIfMissing_(ss, CONFIG.SHEETS.GENDER_OPTIONS, ['Value']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.TASKS, ['TaskName', 'AllowedRoles', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.POST_EXPERIMENT, [
    'BookingID', 'ParticipantTitle', 'ParticipantName', 'ParticipantEmail',
    'MRISlotID', 'MRIDateTime', 'Day1SlotID', 'Day2SlotID', 'BloodDrawingSlotID',
    'Day1Staff', 'Day2Staff', 'BloodDrawingStaff', 'AssignedTA',
    'Day1Complete', 'BloodDrawingComplete', 'MRIComplete', 'Day2Complete',
    'Comments', 'UpdatedBy', 'UpdatedAt'
  ]);
  createSheetIfMissing_(ss, CONFIG.SHEETS.NOTIFICATION_SETTINGS, ['EventKey', 'RecipientGroups', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.SCHEDULING_RULES, ['ExperimentTypeA', 'ExperimentTypeB', 'OverlapAllowed', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.EMAIL_TEMPLATES, ['TemplateKey', 'SubjectDE', 'BodyDE', 'SubjectEN', 'BodyEN', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.CALENDAR_INVITE_SETTINGS, ['ActivityKey', 'RecipientGroups', 'UpdatedAt']);
  createSheetIfMissing_(ss, CONFIG.SHEETS.PROJECT_SETTINGS, ['ProjectID', 'UpdatedBy', 'UpdatedAt']);

  ensureMainAdminSeeded_();
  ensureRolesSeeded_();
  ensureGenderOptionsSeeded_();
  ensureTasksSeeded_();
  ensureNotificationSettingsSeeded_();
  ensureSchedulingRulesSeeded_();
  ensureEmailTemplatesSeeded_();
  ensureCalendarInviteSettingsSeeded_();

  SpreadsheetApp.flush();
  Logger.log('Spreadsheet initialization complete. ' +
    'Remember to add rows to the Staff sheet (Name | Email) so the ' +
    'Assigned Staff dropdowns have options — see README. ' +
    'A MainAdmin account (' + CONFIG.ADMIN_OWNER_EMAIL + ' / ' + CONFIG.ADMIN_DEFAULT_PASSWORD + ') ' +
    'was seeded into the Admins sheet if it was empty. Role permissions were seeded into the ' +
    'Roles sheet from CONFIG.ROLE_PERMISSIONS if it was empty. Gender options and Task ' +
    'definitions were seeded from CONFIG defaults if their sheets were empty. ' +
    'Run installReminderTriggers() once (from the function dropdown) to schedule the Monday/' +
    'Wednesday reminder emails.');
}

function createSheetIfMissing_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return;

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  var bookedColIndex = headers.indexOf('Booked');
  if (bookedColIndex !== -1) {
    var range = sheet.getRange(2, bookedColIndex + 1, 500, 1);
    range.insertCheckboxes();
  }
}
