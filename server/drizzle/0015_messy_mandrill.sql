CREATE TABLE `viewer_presence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`device_id` text NOT NULL,
	`last_seen` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viewer_presence_device_unique` ON `viewer_presence` (`device_id`);--> statement-breakpoint
CREATE INDEX `viewer_presence_seen_idx` ON `viewer_presence` (`match_id`,`last_seen`);