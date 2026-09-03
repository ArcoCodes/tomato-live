ALTER TABLE `matches` ADD `story_chapter` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_phase` text DEFAULT 'Landfall' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_setting` text DEFAULT 'a rain-soaked remote coast as a storm closes in' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_goal` text DEFAULT 'get off the exposed shore before the storm makes landfall' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_clock` text DEFAULT 'dusk on day one' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_directive` text DEFAULT 'Take the next concrete step toward shelter, and run into a new complication doing it.' NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_tension` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_beat` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_reframe_after` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `matches` ADD `story_advanced_at` text;