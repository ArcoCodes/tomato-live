/**
 * Database Relations
 *
 * Define app-level Drizzle ORM relations here.
 *
 * Notes:
 * - Relations help Drizzle with typed joins and nested query shapes at runtime.
 * - Relation-only edits usually do not change generated migration SQL.
 * - You can split relations across multiple files, but re-export them here.
 */

import { relations } from "drizzle-orm";
import { characterDrafts, generations, matchEvents, matches, participants } from "./db_schema";

export const matchesRelations = relations(matches, ({ many }) => ({
  participants: many(participants),
  events: many(matchEvents),
  generations: many(generations),
}));

export const participantsRelations = relations(participants, ({ one, many }) => ({
  match: one(matches, {
    fields: [participants.match_id],
    references: [matches.id],
  }),
  characterDraft: one(characterDrafts, {
    fields: [participants.character_draft_id],
    references: [characterDrafts.id],
  }),
  events: many(matchEvents),
}));

export const characterDraftsRelations = relations(characterDrafts, ({ one }) => ({
  participant: one(participants),
}));

export const matchEventsRelations = relations(matchEvents, ({ one }) => ({
  match: one(matches, {
    fields: [matchEvents.match_id],
    references: [matches.id],
  }),
  participant: one(participants, {
    fields: [matchEvents.participant_id],
    references: [participants.id],
  }),
}));

export const generationsRelations = relations(generations, ({ one }) => ({
  match: one(matches, {
    fields: [generations.match_id],
    references: [matches.id],
  }),
}));
