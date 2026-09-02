CREATE TABLE `chat_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`match_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`consumed_at` text,
	`generation_id` integer,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_match_idx` ON `chat_messages` (`match_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_unconsumed_idx` ON `chat_messages` (`match_id`,`consumed_at`);