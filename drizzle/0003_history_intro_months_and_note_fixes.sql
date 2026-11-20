ALTER TABLE `price_history` ADD COLUMN `intro_months` integer;
--> statement-breakpoint
UPDATE `price_history` SET `intro_months` = (SELECT `intro_months` FROM `plans` WHERE `plans`.`id` = `price_history`.`plan_id`) WHERE `intro_price` IS NOT NULL;
--> statement-breakpoint
UPDATE `plans` SET `note` = '合约期未注明，查 CIS。' WHERE `provider` = 'Flip' AND `plan_name` = 'Unlimited Premium nbn25';
--> statement-breakpoint
UPDATE `plans` SET `note` = '优惠结束后的月费 $80.90，是 50 档里最低的。' WHERE `provider` = 'Kogan Internet' AND `plan_name` = 'Silver Unlimited';
--> statement-breakpoint
UPDATE `plans` SET `note` = '固定价、不打折：$80/月就是长期价，优惠结束后的月费是 500 档最低。仅限 FTTP/HFC。另可 +$1/天临时升到 1000 Mbps（Warp Speed）。' WHERE `provider` = 'Exetel' AND `plan_name` = 'The One Plan 500/50';
--> statement-breakpoint
UPDATE `plans` SET `note` = '固定价 $99/月，不分优惠期，优惠结束后的月费是 1000 档最低；促销活动 2026-12-15 结束。' WHERE `provider` = 'Superloop' AND `plan_name` = 'Lightspeed 1000/100';
