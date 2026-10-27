import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Relay storage: LilOS domain objects only (D-#25). The relay owns
 * employees, their internal channels, projects, conversations, and visible
 * messages — it does NOT store engine transcripts (tools, reasoning); the
 * engine owns those.
 * Not: a transcript copy in LilOS — it would drift from the engine's, and
 * sensitive reasoning data would sit at rest here. `schema.test.ts` fails
 * on any transcript-shaped column.
 */
export const employees = sqliteTable("employees", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default(""),
  status: text("status", { enum: ["online", "busy", "offline"] })
    .notNull()
    .default("offline"),
  profile: text("profile").notNull().default(""),
  model: text("model").notNull().default(""),
  /** #872: the agent's default effort pick — NULL means the model's own
      default. */
  effort: text("effort"),
  now: text("now").notNull().default(""),
  instructions: text("instructions").notNull().default(""),
  respondTo: text("respond_to", { enum: ["me", "selected", "anyone"] })
    .notNull()
    .default("me"),
  /** #561 AC-3: per-employee notification mute — relay-owned, read by the
      push fan-out and broadcast to the apps. */
  muted: integer("muted", { mode: "boolean" }).notNull().default(false),
  /** Who this person reports to (D-#775). NULL means the owner — there is
      no owner row to point at, and the name shown is the profile's, never
      a hardcoded one. A self-reference would be a cycle; the directory
      rejects those before a write. */
  reportsTo: text("reports_to").references((): AnySQLiteColumn => employees.id),
  /** D-#761: the engine runtime this agent's threads bind to — NULL means
      the default engine (every pre-#761 row). */
  runtime: text("runtime"),
  createdAt: integer("created_at").notNull(),
});

export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["dm"] }).notNull(),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    /** Per-channel message watermark; assigning seq increments it atomically. */
    lastSeq: integer("last_seq").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("channels_dm_employee").on(t.kind, t.employeeId)],
);

/**
 * Projects (D-#771): a folder the company works in. `folder` is the
 * `~`-collapsed path recents use (`projectFolderOf`) and unique — one project per folder — and `key` is the unique short
 * uppercase tag. Rows are only ever created by the relay itself (first use
 * of a folder, `projects.create`); nothing renames or deletes them yet, so
 * a thread's `project_id` never dangles.
 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    folder: text("folder").notNull(),
    about: text("about").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_key").on(t.key),
    uniqueIndex("projects_folder").on(t.folder),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    /** The message the thread was opened with. */
    rootMessageId: text("root_message_id")
      .notNull()
      .references((): AnySQLiteColumn => messages.id),
    /** Opaque engine session reference owned by the harness. */
    engineRef: text("engine_ref"),
    state: text("state", { enum: ["idle", "active", "closed"] })
      .notNull()
      .default("idle"),
    /** Model pinned on the engine session (issue #30); null = engine default. */
    model: text("model"),
    /** The rest of the session's pick (issue #92): provider slug, effort, fast. */
    provider: text("provider"),
    effort: text("effort"),
    fast: integer("fast", { mode: "boolean" }),
    /** Folder the session runs in (issue #113); null = harness default dir.
        For a workstream open (#156) this is the worktree path. */
    cwd: text("cwd"),
    /** The project the thread lives in (D-#771); null = a plain chat.
        Relay-set from the folder at open/move (and the boot backfill). */
    projectId: text("project_id").references(() => projects.id),
    /** The ticket this thread is a hand of (D-#776); null = not on a ticket.
        One column, so a thread links to at most one ticket. */
    ticketId: text("ticket_id").references(() => tickets.id),
    /** The standing CEO thread (D-#777). Set when a ceo-wake message is
        stored on this row. */
    ceoThread: integer("ceo_thread", { mode: "boolean" })
      .notNull()
      .default(false),
    /** The thread that handed this one a task (D-#844) — relay-set once
        at `tasks.create`, never client-written. NULL everywhere else. */
    parentId: text("parent_id"),
    /** Workstream mode stamped at open (#156): JSON WorkspaceIntent; null =
        direct folder / just chat. */
    workspace: text("workspace"),
    /** The composer pill's access level (#106): `ask` stops at approval
        cards, `full` has the harness auto-answer them. Stamped at open from
        Settings' `defaultAccess`; the conversation never remembers a
        last-used level. */
    access: text("access", { enum: ["ask", "full"] })
      .notNull()
      .default("ask"),
    title: text("title").notNull().default(""),
    /** Who named the conversation (#137): `user` wins over every later
        engine/auto title write; `auto` is free to be upgraded. */
    titleSource: text("title_source", { enum: ["auto", "user"] })
      .notNull()
      .default("auto"),
    /* D-#862: `settled_*` is the thread-parking model — `archived` stays as
       its synced mirror (updateConversation keeps archived ⇔ settled_at
       non-NULL) so pre-#862 wire clients and every archived-filtered query
       keep working unchanged. */
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /** Pinned to the top of the thread list, epoch ms; NULL = not pinned.
        Settling clears it. */
    pinnedAt: integer("pinned_at"),
    /** Settled onto the shelf, epoch ms; NULL = live. */
    settledAt: integer("settled_at"),
    /** Why it settled: 'manual' (the user / a legacy archived write), 'idle'
        (3-day sweep), 'pr' (its PR merged or closed). */
    settledReason: text("settled_reason", {
      enum: ["manual", "idle", "pr"],
    }),
    /** The PR that settled it — JSON {num, state} — when reason='pr'. */
    settledPr: text("settled_pr"),
    /** Hidden until this epoch-ms time; wakes early on ask/failure/user msg. */
    snoozedUntil: integer("snoozed_until"),
    /** Auto-settle switch for this thread; 1 = the sweep may settle it. */
    autoSettle: integer("auto_settle", { mode: "boolean" })
      .notNull()
      .default(true),
    /** D-#862 review: newest owner park action — the sweep's idle clock
        counts it so a freshly un-parked thread doesn't bounce back. */
    lastParkActionAt: integer("last_park_action_at"),
    /** Host watermark: highest user-message seq handed to the engine (#28). */
    deliveredSeq: integer("delivered_seq").notNull().default(0),
    /** The newest turn.completed's usage (#300): JSON engine `Usage`
        (input/output/reasoning/cache + optional contextWindow) — the context
        meter's numbers, kept on the row so a dead engine session can't take
        the meter with it. */
    usage: text("usage"),
    /** Freshness fence for `usage` writes (#300): the session + seq of the
        turn.completed that stored it. A replayed older turn from the same
        session can't regress the row; a rebound session writes freely. */
    usageSessionId: text("usage_session_id"),
    usageSeq: integer("usage_seq").notNull().default(0),
    /** The engine session's life (#346): host-only `open`/`closed` write —
        `closed` while suspended, `open` again once it reopens. `running`
        never crosses the wire; it's derived client-side. */
    life: text("life", { enum: ["open", "closed"] }),
    /** The last turn's failure (#419): JSON TurnFailure {kind, text} —
        the thread row's alert card; host-written, cleared on the
        next `turn.started`. */
    turnFailure: text("turn_failure"),
    /** The last turn ended stopped (#583): the thread row's "stopped"
        word; same host-written lifecycle as `turn_failure`. */
    turnStopped: integer("turn_stopped", { mode: "boolean" }),
    /** Running background-job count (#583): the thread row's
        "N in background" badge; same host-written lifecycle. */
    bgJobs: integer("bg_jobs"),
    /** The running turn is stuck (D-#772): JSON `{reason}` — the plain
        sentence the card and the push say. Host-written; null once the
        next step differs, a new message lands, or the turn stops. */
    stuck: text("stuck"),
    /** Epoch ms when `stuck` last went from unset to set (issue #775).
        Relay-written on that transition; a clear leaves it; a later
        episode overwrites it. The week's stuck count reads this, not
        the live mark. */
    stuckAt: integer("stuck_at"),
    /** The user's read watermark (#563): the channel seq up to which they have
        opened this thread. `conversations.markRead` stamps
        max(channel lastSeq, finishedSeq); compared against `finishedSeq`
        for the dot. */
    readSeq: integer("read_seq").notNull().default(0),
    /** The "finished, not seen" watermark (#563): channel seq when the
        relay last observed a turn end (turn.completed, or session.state
        error) for this conversation. */
    finishedSeq: integer("finished_seq").notNull().default(0),
    /** Freshness fence for `finishedSeq` writes (#563), same rule as
        `usage_session_id`/`usage_seq`: a replayed older finish from the
        same session can't regress the stamp; a rebound session writes
        freely. Store-internal — never on the wire. */
    finishedSessionId: text("finished_session_id"),
    finishedEventSeq: integer("finished_event_seq").notNull().default(0),
    /** Set on a session a scheduled task opened (#136): JSON
        `{taskId, name}` — host-stamped at `conversations.open`. */
    scheduled: text("scheduled"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("conversations_channel").on(t.channelId),
    index("conversations_project").on(t.projectId),
    index("conversations_ticket").on(t.ticketId),
  ],
);

/**
 * Goals (D-#776): what the company wants. `owner_id` null means the human.
 * Progress is not stored — it is the goal's tickets, done over all.
 */
export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    due: text("due").notNull().default(""),
    why: text("why").notNull().default(""),
    ownerId: text("owner_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("goals_project").on(t.projectId)],
);

/**
 * Tickets (D-#776): one piece of work, one owner, one status. `id` is
 * `${project.key}-${number}`. Waiting-on, checklist, result and updates are
 * JSON. No foreign key on the owner: a removed employee must not block the
 * row; the app shows them as gone.
 */
export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    goalId: text("goal_id").references(() => goals.id),
    ownerId: text("owner_id"),
    status: text("status").notNull(),
    waitingOn: text("waiting_on"),
    progress: text("progress").notNull().default("[]"),
    result: text("result"),
    updates: text("updates").notNull().default("[]"),
    stuckWhy: text("stuck_why"),
    startsAt: text("starts_at"),
    statusAt: integer("status_at").notNull(),
    doneAt: integer("done_at"),
    /* D-#844: the hand-off blob — JSON `TicketTask` (lineage, requestId,
       wake fence, lastResult); NULL on a non-task ticket. The two real
       columns beside it exist only for the requestId index below and are
       written in sync with the blob. */
    task: text("task"),
    taskParentId: text("task_parent_id"),
    taskRequestId: text("task_request_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    /* (project_id, number) is unique, so a second index on project_id
       alone would only repeat its leftmost column. */
    uniqueIndex("tickets_project_number").on(t.projectId, t.number),
    index("tickets_goal").on(t.goalId),
    /* D-#844: `requestId` repeats land on one task — NULLs stay distinct,
       so non-task rows and keyless tasks never collide. */
    uniqueIndex("tickets_task_request").on(t.taskParentId, t.taskRequestId),
  ],
);

/**
 * What the company told the owner (D-#777). No foreign key: a removed
 * ticket or goal must not block the note. `author_id` is empty for a
 * system note (LilOS); an employee note names that employee.
 */
export const companyUpdates = sqliteTable(
  "company_updates",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    ticketId: text("ticket_id"),
    goalId: text("goal_id"),
    authorKind: text("author_kind").notNull(),
    authorId: text("author_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("company_updates_created").on(t.createdAt)],
);

/**
 * Scheduled tasks (#136): one row per employee task — a prompt that opens a
 * new thread on a schedule. The relay owns the record (D-#25); the
 * engine host owns the clock: `last_fired_at` is its "runs after this"
 * anchor and `requested_at` carries Run-now clicks, so a slept-through slot
 * lands once on the next tick and a click while the host was down still
 * fires. `schedule`/`last_run` are JSON (`TaskSchedule`/`ScheduledRunRecord`).
 */
export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    employeeId: text("employee_id")
      .notNull()
      .references(() => employees.id),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** Folder the run's session opens in; null = harness default dir. */
    folder: text("folder"),
    /** JSON `TaskSchedule`. */
    schedule: text("schedule").notNull(),
    access: text("access", { enum: ["ask", "full"] })
      .notNull()
      .default("ask"),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    lastFiredAt: integer("last_fired_at"),
    requestedAt: integer("requested_at"),
    /** JSON `ScheduledRunRecord` — the latest run's thread + outcome. */
    lastRun: text("last_run"),
    /** Epoch ms a run was skipped: the previous run was still going (AC-4). */
    skippedAt: integer("skipped_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("scheduled_tasks_employee").on(t.employeeId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id").references(
      (): AnySQLiteColumn => conversations.id,
    ),
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", {
      enum: ["user", "employee", "system"],
    }).notNull(),
    /** A CEO wake (D-#777). The text is what the model reads; this flag
        is what the product keys off. */
    ceoWake: integer("ceo_wake", { mode: "boolean" }).notNull().default(false),
    /** A task wake (D-#844): a child task's finished turn prompting the
        parent thread — same flag rule as ceo_wake. */
    taskWake: integer("task_wake", { mode: "boolean" })
      .notNull()
      .default(false),
    text: text("text").notNull(),
    /** Display refs JSON (`MessageAttachment[]`); bytes live outside the row. */
    attachments: text("attachments"),
    /** Engine `turn.started.model` on employee answers (issue #30). */
    model: text("model"),
    /** Engine `turn.started` provider / effort / fast on employee answers (#92). */
    provider: text("provider"),
    effort: text("effort"),
    fast: integer("fast", { mode: "boolean" }),
    /** Monotonic per channel; replay cursor (`afterSeq`) points here. */
    seq: integer("seq").notNull(),
    /** Exactly-once write key (#28): retries return the original row. */
    dedupeKey: text("dedupe_key"),
    /** Rewound by `conversations.rewind` (#134): hidden, kept for audit. */
    rewound: integer("rewound", { mode: "boolean" }).notNull().default(false),
    /** ■ Stop parked it in the not-sent tray (#315): hidden, never delivered. */
    dropped: integer("dropped", { mode: "boolean" }).notNull().default(false),
    /** User removed it while still waiting (#315): hidden, never delivered. */
    removed: integer("removed", { mode: "boolean" }).notNull().default(false),
    /** Harness committed its prompt to dispatch (#377): not "waiting". */
    claimed: integer("claimed", { mode: "boolean" }).notNull().default(false),
    /** Pre-turn folder checkpoint id stamped by the harness (#134). */
    checkpoint: text("checkpoint"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("messages_channel_seq").on(t.channelId, t.seq),
    uniqueIndex("messages_dedupe_key").on(t.channelId, t.dedupeKey),
    /* #571: conv-scoped reads order by seq — the composite serves both the
       equality seek and the range/order (the old conversation_id-only index
       is a strict prefix of this one). */
    index("messages_conversation_seq").on(t.conversationId, t.seq),
  ],
);

/**
 * Engine asks surfaced to the user (#26). `request` is the EngineRequest JSON
 * verbatim; `state` flips to `resolved` when `asks.respond` lands. The
 * (conversation_id, request_id) pair is unique — re-opening the same engine
 * request after a replay returns the same row.
 */
export const asks = sqliteTable(
  "asks",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    turnId: text("turn_id").notNull(),
    requestId: text("request_id").notNull(),
    request: text("request").notNull(),
    hire: text("hire"),
    /* D-#773: gateway ask lines. Null on an engine approval. */
    why: text("why"),
    ifYes: text("if_yes"),
    ifNo: text("if_no"),
    state: text("state", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    outcome: text("outcome"),
    answer: text("answer"),
    createdAt: integer("created_at").notNull(),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    uniqueIndex("asks_conversation_request").on(t.conversationId, t.requestId),
    index("asks_channel").on(t.channelId),
  ],
);

/**
 * LilOS-owned recent folders for the session picker (#113): one shared list,
 * newest-first by `last_used_at`. `folders.add` upserts; `conversations.open`
 * with `cwd` bumps the same row.
 */
export const recentFolders = sqliteTable("recent_folders", {
  path: text("path").primaryKey(),
  lastUsedAt: integer("last_used_at").notNull(),
});

/**
 * LilOS-owned key/value settings (#92): the one home for app-level state the
 * engine doesn't own — e.g. `modelVisibility` (the Edit-models hide list).
 * `value` is JSON text; `settings.get`/`settings.set` expose it on the wire.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * The signed-in human's profile (D-#118): one row (`id` = 1) of relay-owned
 * identity — name, company name, avatar colour — behind `profile.get`/
 * `profile.update` (`settings.*` is #92's KV namespace). Columns stay NULL
 * until the user sets them; the app prefills from `host.user` (the OS full
 * name) on an untouched install. Not: a hardcoded `ME` constant in the web
 * app, or identity fields on the employee record.
 */
export const profile = sqliteTable("profile", {
  id: integer("id").primaryKey(),
  userName: text("user_name"),
  companyName: text("company_name"),
  avatarColor: text("avatar_color"),
});

/**
 * One-time pairing grants (#153): the code shown in the Pair phone QR is
 * stored only as `code_hash` (SHA-256) — the raw value lives in the QR and
 * the exchange request, never on disk. A set `consumed_at` means spent;
 * `expires_at` is the 5-minute TTL.
 */
export const pairingGrants = sqliteTable("pairing_grants", {
  codeHash: text("code_hash").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

/**
 * Devices paired to this install (#153): phones that exchanged a grant for
 * their own credential. The credential is stored only as `credential_hash`;
 * a set `revoked_at` closes live sockets and blocks future hellos.
 */
export const pairedDevices = sqliteTable("paired_devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  credentialHash: text("credential_hash").notNull().unique(),
  pairedAt: integer("paired_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  revokedAt: integer("revoked_at"),
});

/**
 * Expo push registrations (#161): one row per paired phone — its Expo push
 * token and the four per-kind toggles it last registered. Tied to
 * `paired_devices.id`; a revoke deletes the row so a dead phone stops
 * receiving pushes.
 */
export const devicePush = sqliteTable("device_push", {
  deviceId: text("device_id")
    .primaryKey()
    .references(() => pairedDevices.id),
  expoToken: text("expo_token").notNull(),
  /** Per-kind toggles as JSON (`PushPrefs`). */
  prefs: text("prefs").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Engine-event freshness watermark (#161): the highest `engine.event` seq
 * the relay has seen per engine session. A host replay after a restart
 * re-sends old events at/under this mark → no re-push. Persisted — an
 * in-memory mark would let a relay restart re-notify.
 */
export const engineEventMarks = sqliteTable("engine_event_marks", {
  sessionId: text("session_id").primaryKey(),
  lastSeq: integer("last_seq").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
