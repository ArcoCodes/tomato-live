CREATE TABLE `generations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`round` integer NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`model` text DEFAULT 'hailuo-h3-max' NOT NULL,
	`prompt` text NOT NULL,
	`participant_ids` text DEFAULT '[]' NOT NULL,
	`keyframe_task_id` text,
	`keyframe_material_id` integer,
	`video_task_id` text,
	`result_url` text,
	`thumbnail_url` text,
	`error_message` text,
	`duration_seconds` integer DEFAULT 10 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `generations_match_idx` ON `generations` (`match_id`);--> statement-breakpoint
CREATE INDEX `generations_stage_idx` ON `generations` (`stage`);--> statement-breakpoint
CREATE TABLE `match_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`participant_id` integer,
	`round` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`participant_id`) REFERENCES `participants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_match_idx` ON `match_events` (`match_id`);--> statement-breakpoint
CREATE INDEX `events_participant_idx` ON `match_events` (`participant_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`current_round` integer DEFAULT 1 NOT NULL,
	`zone` text DEFAULT '北岸雨林' NOT NULL,
	`viewers` integer DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `matches_slug_unique` ON `matches` (`slug`);--> statement-breakpoint
CREATE INDEX `matches_status_idx` ON `matches` (`status`);--> statement-breakpoint
CREATE TABLE `participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`user_id` text,
	`control_token_hash` text,
	`display_name` text NOT NULL,
	`archetype` text NOT NULL,
	`accent` text NOT NULL,
	`avatar_s3_uri` text,
	`renoise_material_id` integer,
	`status` text DEFAULT 'ready' NOT NULL,
	`health` integer DEFAULT 100 NOT NULL,
	`stamina` integer DEFAULT 100 NOT NULL,
	`hunger` integer DEFAULT 0 NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`last_action` text DEFAULT '等待入场' NOT NULL,
	`joined_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `participants_match_idx` ON `participants` (`match_id`);--> statement-breakpoint
CREATE INDEX `participants_status_idx` ON `participants` (`status`);--> statement-breakpoint
CREATE INDEX `participants_user_idx` ON `participants` (`user_id`);