CREATE TABLE `director_rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`source_generation_id` integer,
	`option_a_label` text NOT NULL,
	`option_b_label` text NOT NULL,
	`option_a_cue` text NOT NULL,
	`option_b_cue` text NOT NULL,
	`votes_a` integer DEFAULT 0 NOT NULL,
	`votes_b` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'voting' NOT NULL,
	`winner` text,
	`closes_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `director_rounds_match_idx` ON `director_rounds` (`match_id`,`status`);--> statement-breakpoint
CREATE TABLE `director_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`voter_hash` text NOT NULL,
	`option` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `director_rounds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `director_votes_unique` ON `director_votes` (`round_id`,`voter_hash`);--> statement-breakpoint
ALTER TABLE `generations` ADD `vote_state` text;--> statement-breakpoint
ALTER TABLE `generations` ADD `vote_round_id` integer;--> statement-breakpoint
ALTER TABLE `generations` ADD `vote_option` text;