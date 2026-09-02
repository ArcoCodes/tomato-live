ALTER TABLE `chat_messages` ADD `device_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `chat_device_idx` ON `chat_messages` (`match_id`,`device_id`);--> statement-breakpoint
ALTER TABLE `viewer_perks` ADD `device_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `viewer_perks_device_unique` ON `viewer_perks` (`device_id`);