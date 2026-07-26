ALTER TABLE "recipes" ADD COLUMN "page_etag" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "page_last_modified" text;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "no_recipe" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "feed_etag" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "feed_last_modified" text;
