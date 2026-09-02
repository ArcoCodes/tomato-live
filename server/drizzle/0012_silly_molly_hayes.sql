CREATE TABLE `viewer_perks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`tier` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viewer_perks_user_unique` ON `viewer_perks` (`user_id`);