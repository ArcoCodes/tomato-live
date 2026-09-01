ALTER TABLE `generations` ADD `channel` text DEFAULT 'director' NOT NULL;--> statement-breakpoint
ALTER TABLE `generations` ADD `channel_participant_id` integer REFERENCES participants(id);--> statement-breakpoint
ALTER TABLE `generations` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `viewer_prompt` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `source_generation_id` integer;--> statement-breakpoint
CREATE INDEX `generations_channel_idx` ON `generations` (`match_id`,`channel`,`channel_participant_id`,`id`);