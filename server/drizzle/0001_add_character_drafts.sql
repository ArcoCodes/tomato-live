CREATE TABLE `character_drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`control_token_hash` text NOT NULL,
	`requester_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`archetype` text NOT NULL,
	`accent` text NOT NULL,
	`source_s3_uri` text,
	`generated_s3_uri` text,
	`renoise_source_material_id` integer,
	`renoise_generated_material_id` integer,
	`renoise_task_id` text,
	`model` text DEFAULT 'gpt-image-2' NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`estimated_credit` text,
	`error_message` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`claimed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `character_drafts_public_id_unique` ON `character_drafts` (`public_id`);--> statement-breakpoint
CREATE INDEX `character_drafts_status_idx` ON `character_drafts` (`status`);--> statement-breakpoint
CREATE INDEX `character_drafts_requester_idx` ON `character_drafts` (`requester_hash`);--> statement-breakpoint
ALTER TABLE `participants` ADD `character_draft_id` integer REFERENCES character_drafts(id);--> statement-breakpoint
CREATE UNIQUE INDEX `participants_character_draft_unique` ON `participants` (`character_draft_id`);