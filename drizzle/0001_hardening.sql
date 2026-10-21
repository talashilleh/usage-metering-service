-- Preserve the exact result of an idempotent request.
-- Nullable so existing decisions from earlier versions remain readable.
ALTER TABLE "requests" ADD COLUMN "decision_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_monthly_nonnegative" CHECK ("monthly_allowance" >= 0);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_max_request_positive" CHECK ("max_per_request" > 0);
--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_type_valid" CHECK ("type" IN ('account', 'user'));
--> statement-breakpoint
ALTER TABLE "account_usage" ADD CONSTRAINT "account_usage_nonnegative" CHECK ("consumed" >= 0);
--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_nonnegative" CHECK ("consumed" >= 0);
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_units_positive" CHECK ("units" > 0);
