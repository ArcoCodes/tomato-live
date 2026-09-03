/**
 * Database Schema
 *
 * Define your app tables here using Drizzle ORM.
 * If you want app-level `relations(...)`, define them in `src/defs/db_relations.ts`.
 *
 * After making changes, run:
 *   edgespark db generate   (create migration files)
 *   edgespark db migrate    (apply to the project database)
 *   edgespark deploy        (deploy with latest schema)
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const matches = sqliteTable("matches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull(),
  status: text("status", { enum: ["waiting", "live", "finished"] }).notNull().default("waiting"),
  current_round: integer("current_round").notNull().default(1),
  zone: text("zone").notNull().default("北岸雨林"),
  viewers: integer("viewers").notNull().default(0),
  // How hard the show films: how many clips may render at once and how long to wait between them.
  // The host switches this from /admin-change when nobody is watching.
  generation_tier: text("generation_tier", { enum: ["live", "idle", "hourly"] }).notNull().default("live"),
  // How talkative the seeded audience is. Separate from the render tier: chat is what fills the
  // queue, rendering is what drains it.
  chat_seed_tier: text("chat_seed_tier", { enum: ["busy", "normal", "quiet", "off"] }).notNull().default("normal"),
  // The showrunner state. Prompts read these instead of the constants that used to be baked into
  // them, which is the only reason the show can ever leave the beach it started on.
  story_chapter: integer("story_chapter").notNull().default(1),
  story_phase: text("story_phase").notNull().default("Landfall"),
  story_setting: text("story_setting").notNull().default("a rain-soaked remote coast as a storm closes in"),
  story_goal: text("story_goal").notNull().default("get off the exposed shore before the storm makes landfall"),
  story_clock: text("story_clock").notNull().default("dusk on day one"),
  // What the house cast acts on when the chat queue is empty. Rewritten every time the story turns.
  story_directive: text("story_directive").notNull().default("Take the next concrete step toward shelter, and run into a new complication doing it."),
  story_tension: integer("story_tension").notNull().default(20),
  // Completed clips since the last turn. Viewer messages count double, so a busy room moves faster.
  story_beat: integer("story_beat").notNull().default(0),
  // Generation id at the moment the location last changed. A channel whose last clip predates this
  // must reopen on its character sheet — the old tail frame would drag the old place forward.
  story_reframe_after: integer("story_reframe_after").notNull().default(0),
  story_advanced_at: text("story_advanced_at"),
  started_at: text("started_at").notNull().default(sql`(current_timestamp)`),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex("matches_slug_unique").on(table.slug),
  index("matches_status_idx").on(table.status),
]);

export const characterDrafts = sqliteTable("character_drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  public_id: text("public_id").notNull(),
  control_token_hash: text("control_token_hash").notNull(),
  requester_hash: text("requester_hash").notNull(),
  display_name: text("display_name").notNull(),
  archetype: text("archetype").notNull(),
  accent: text("accent").notNull(),
  source_s3_uri: text("source_s3_uri"),
  generated_s3_uri: text("generated_s3_uri"),
  renoise_source_material_id: integer("renoise_source_material_id"),
  renoise_generated_material_id: integer("renoise_generated_material_id"),
  renoise_task_id: text("renoise_task_id"),
  model: text("model").notNull().default("gpt-image-2"),
  prompt: text("prompt").notNull(),
  // What the viewer actually typed, before the agent enriched it.
  concept: text("concept"),
  // The text half of the character: written alongside the sheet from the same enriched brief, so the
  // wording that reproduces this person in later clips is bound to the image from the start.
  appearance: text("appearance"),
  status: text("status", { enum: ["generating", "ready", "failed", "claimed"] }).notNull().default("generating"),
  estimated_credit: text("estimated_credit"),
  error_message: text("error_message"),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
  completed_at: text("completed_at"),
  claimed_at: text("claimed_at"),
}, (table) => [
  uniqueIndex("character_drafts_public_id_unique").on(table.public_id),
  index("character_drafts_status_idx").on(table.status),
  index("character_drafts_requester_idx").on(table.requester_hash),
]);

export const participants = sqliteTable("participants", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  character_draft_id: integer("character_draft_id").references(() => characterDrafts.id),
  user_id: text("user_id"),
  control_token_hash: text("control_token_hash"),
  display_name: text("display_name").notNull(),
  archetype: text("archetype").notNull(),
  accent: text("accent").notNull(),
  avatar_s3_uri: text("avatar_s3_uri"),
  // What the roster and the cast cards show. Kept apart from avatar_s3_uri because that one is the
  // 16:9 opening frame for video generation, and its aspect ratio is not negotiable.
  portrait_s3_uri: text("portrait_s3_uri"),
  renoise_material_id: integer("renoise_material_id"),
  status: text("status", { enum: ["ready", "alive", "danger", "eliminated"] }).notNull().default("ready"),
  health: integer("health").notNull().default(100),
  stamina: integer("stamina").notNull().default(100),
  hunger: integer("hunger").notNull().default(0),
  score: integer("score").notNull().default(0),
  last_action: text("last_action").notNull().default("等待入场"),
  // Written once by a vision model from the character sheet. H3-Max sees only the opening frame, so
  // this text is what stops the contestant drifting over a long tail-frame chain.
  appearance: text("appearance"),
  // House cast: seeded, not claimable, and preferred when the director picks whose footage to cut to.
  is_system: integer("is_system", { mode: "boolean" }).notNull().default(false),
  joined_at: text("joined_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  index("participants_match_idx").on(table.match_id),
  index("participants_status_idx").on(table.status),
  index("participants_user_idx").on(table.user_id),
  uniqueIndex("participants_character_draft_unique").on(table.character_draft_id),
]);

export const matchEvents = sqliteTable("match_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  participant_id: integer("participant_id").references(() => participants.id),
  round: integer("round").notNull(),
  kind: text("kind", { enum: ["world", "player", "system", "danger"] }).notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  index("events_match_idx").on(table.match_id),
  index("events_participant_idx").on(table.participant_id),
]);

export const directorRounds = sqliteTable("director_rounds", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  // The clip this fork branches from; its tail frame opens both candidates.
  source_generation_id: integer("source_generation_id"),
  option_a_label: text("option_a_label").notNull(),
  option_b_label: text("option_b_label").notNull(),
  option_a_cue: text("option_a_cue").notNull(),
  option_b_cue: text("option_b_cue").notNull(),
  votes_a: integer("votes_a").notNull().default(0),
  votes_b: integer("votes_b").notNull().default(0),
  status: text("status", { enum: ["voting", "settled"] }).notNull().default("voting"),
  winner: text("winner", { enum: ["a", "b"] }),
  closes_at: text("closes_at").notNull(),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  index("director_rounds_match_idx").on(table.match_id, table.status),
  // The guard in openDirectorRound is read-then-write and concurrent pollers slipped through it.
  // A partial unique index is what actually keeps one open fork per match.
  uniqueIndex("director_rounds_one_open").on(table.match_id).where(sql`status = 'voting'`),
]);

export const directorVotes = sqliteTable("director_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  round_id: integer("round_id").notNull().references(() => directorRounds.id),
  // Hash of the caller fingerprint: one vote per viewer per round, without storing who they are.
  voter_hash: text("voter_hash").notNull(),
  option: text("option", { enum: ["a", "b"] }).notNull(),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex("director_votes_unique").on(table.round_id, table.voter_hash),
]);

// How far a viewer has unlocked their speaking allowance. Nothing here can be verified from the
// server — following an account off-site leaves no trace we can read — so the row records what the
// viewer said they did, and the allowance follows from it.
export const viewerPerks = sqliteTable("viewer_perks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // The allowance follows the browser, not the account: chatting needs no sign-in. Kept as its own
  // column so the account column stays what it always was.
  device_id: text("device_id"),
  user_id: text("user_id").notNull(),
  tier: integer("tier").notNull().default(0),
  updated_at: text("updated_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex("viewer_perks_user_unique").on(table.user_id),
  uniqueIndex("viewer_perks_device_unique").on(table.device_id),
]);

// Who is watching right now. One row per browser, refreshed by its own heartbeat, counted over a
// short window — the alternative was a made-up number on screen.
export const viewerPresence = sqliteTable("viewer_presence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  device_id: text("device_id").notNull(),
  // last_seen is overwritten on every heartbeat, so it cannot answer "how many arrived today".
  first_seen: text("first_seen"),
  last_seen: text("last_seen").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  uniqueIndex("viewer_presence_device_unique").on(table.device_id),
  index("viewer_presence_seen_idx").on(table.match_id, table.last_seen),
]);

// Viewer chat. Messages are both the room's conversation and the queue the show pulls its next
// beat from, which is why consumption is tracked on the row itself.
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  // Empty for a signed-out viewer; the device is what identifies them and what the quota counts.
  user_id: text("user_id").notNull(),
  device_id: text("device_id").notNull().default(""),
  display_name: text("display_name").notNull(),
  body: text("body").notNull(),
  // Participant ids the message mentioned, as JSON. They are pulled into the shot together.
  mentions: text("mentions").notNull().default("[]"),
  // Who gets filmed first when more lines are waiting than the show can shoot. The seeded room is 0,
  // a real viewer is 1, the host is 2 — so the people actually watching always outrank our own
  // filler, and the host's line is never left in the queue.
  priority: integer("priority").notNull().default(0),
  // Claimed atomically when the show picks this message, so two concurrent pickers cannot film the
  // same message twice.
  consumed_at: text("consumed_at"),
  generation_id: integer("generation_id"),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
}, (table) => [
  index("chat_match_idx").on(table.match_id, table.id),
  // The picker asks for unconsumed messages constantly; this is the index it rides.
  index("chat_unconsumed_idx").on(table.match_id, table.consumed_at),
  index("chat_device_idx").on(table.match_id, table.device_id),
]);

export const generations = sqliteTable("generations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  match_id: integer("match_id").notNull().references(() => matches.id),
  round: integer("round").notNull(),
  stage: text("stage", { enum: ["queued", "keyframe", "video", "completed", "failed"] }).notNull().default("queued"),
  model: text("model").notNull().default("hailuo-h3-max"),
  prompt: text("prompt").notNull(),
  participant_ids: text("participant_ids").notNull().default("[]"),
  keyframe_task_id: text("keyframe_task_id"),
  keyframe_material_id: integer("keyframe_material_id"),
  video_task_id: text("video_task_id"),
  result_url: text("result_url"),
  thumbnail_url: text("thumbnail_url"),
  error_message: text("error_message"),
  duration_seconds: integer("duration_seconds").notNull().default(10),
  // Each contestant owns one perspective channel; the director channel is the default broadcast line.
  channel: text("channel", { enum: ["director", "participant"] }).notNull().default("director"),
  channel_participant_id: integer("channel_participant_id").references(() => participants.id),
  // Timeline summary written after the clip completes; feeds the next prompt and the world feed.
  summary: text("summary"),
  // Raw viewer-authored text, kept for auditing what actually went into the prompt.
  viewer_prompt: text("viewer_prompt"),
  // Which contestant clip a director clip took its opening frame from.
  source_generation_id: integer("source_generation_id"),
  // Voting candidates are generated up front and only one of them ever airs, so the archive and the
  // player have to be able to tell a candidate from a clip that is actually part of the broadcast.
  vote_state: text("vote_state", { enum: ["candidate", "winner", "discarded"] }),
  vote_round_id: integer("vote_round_id"),
  vote_option: text("vote_option", { enum: ["a", "b"] }),
  created_by: text("created_by").notNull(),
  created_at: text("created_at").notNull().default(sql`(current_timestamp)`),
  completed_at: text("completed_at"),
}, (table) => [
  index("generations_match_idx").on(table.match_id),
  index("generations_stage_idx").on(table.stage),
  index("generations_channel_idx").on(table.match_id, table.channel, table.channel_participant_id, table.id),
  // Director cuts run concurrently now, and two of them racing on the same contestant clip would
  // air the same beat twice. The read-then-write guard in pickDirectorSource already lost that race
  // once, so the constraint lives here.
  uniqueIndex("generations_director_source").on(table.source_generation_id).where(sql`channel = 'director' and source_generation_id is not null`),
]);
