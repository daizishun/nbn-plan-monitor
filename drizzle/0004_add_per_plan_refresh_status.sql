ALTER TABLE `plans` ADD COLUMN `last_refresh_status` text;
--> statement-breakpoint
ALTER TABLE `plans` ADD COLUMN `last_refresh_at` text;
--> statement-breakpoint
UPDATE `plans` SET `last_refresh_status` = 'unchanged' WHERE `last_refresh_status` IS NULL;
