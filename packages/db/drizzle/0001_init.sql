CREATE TYPE "public"."aisle" AS ENUM('Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Grains & Pasta', 'Canned & Jarred', 'Pantry', 'Spices', 'Frozen', 'Other');--> statement-breakpoint
CREATE TYPE "public"."recipe_category" AS ENUM('Chicken', 'Beef & Turkey', 'Vegetarian', 'Soup', 'Breakfast', 'No-reheat');--> statement-breakpoint
CREATE TYPE "public"."recipe_status" AS ENUM('pending', 'active', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."scan_run_status" AS ENUM('running', 'success', 'partial', 'error');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('blog', 'reddit', 'social');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_pkey" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "cook_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"aspects" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"cooked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cook_logs_rating_range" CHECK ("cook_logs"."rating" between 1 and 5),
	CONSTRAINT "cook_logs_aspects_vocab" CHECK ("aspects" <@ ARRAY['quick', 'slow', 'cheap', 'expensive', 'tasty', 'bland', 'reheats_well', 'soggy_leftovers', 'too_much_cleanup', 'would_repeat']::text[])
);
--> statement-breakpoint
CREATE TABLE "grocery_checks" (
	"user_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_checks_pkey" PRIMARY KEY("user_id","item_key")
);
--> statement-breakpoint
CREATE TABLE "ingredient_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"aisle" "aisle" DEFAULT 'Other' NOT NULL,
	"default_unit" text,
	"density_g_per_ml" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipe_ingredients" (
	"recipe_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"raw_text" text NOT NULL,
	"ingredient_id" uuid,
	"qty" numeric(12, 4),
	"unit" text,
	"note" text,
	"optional" boolean DEFAULT false NOT NULL,
	CONSTRAINT "recipe_ingredients_pkey" PRIMARY KEY("recipe_id","position")
);
--> statement-breakpoint
CREATE TABLE "recipe_scores" (
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"score" real NOT NULL,
	"reason" text,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_scores_pkey" PRIMARY KEY("user_id","recipe_id")
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_url" text NOT NULL,
	"content_hash" text,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"blurb" text,
	"total_minutes" integer,
	"active_minutes" integer,
	"servings" integer,
	"keeps_days" integer,
	"freezer_months" integer,
	"category" "recipe_category",
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"image_url" text,
	"image_local_path" text,
	"image_w" integer,
	"image_h" integer,
	"image_blurhash" text,
	"author" text,
	"source_rating" real,
	"source_rating_count" integer,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_jsonld" jsonb,
	"status" "recipe_status" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"published_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipes_tags_vocab" CHECK ("tags" <@ ARRAY['10 minutes', '30 minutes', 'Better on day two', 'Big batch', 'Cheap', 'Comfort', 'Component prep', 'Crunchy', 'Freezes', 'Gluten-free', 'Grab and go', 'Hands-off', 'High fiber', 'High protein', 'Marinate ahead', 'No cook', 'No microwave', 'One cleanup', 'One pot', 'Pantry staples', 'Reader favorite', 'Sheet pan', 'Slow cooker', 'Under 20 min', 'Vegan', 'Vegan option', 'Vegetarian']::text[]),
	CONSTRAINT "recipes_source_rating_range" CHECK ("recipes"."source_rating" is null or ("recipes"."source_rating" >= 0 and "recipes"."source_rating" <= 5))
);
--> statement-breakpoint
CREATE TABLE "saved_recipes" (
	"user_id" uuid NOT NULL,
	"recipe_id" uuid NOT NULL,
	"batches" integer DEFAULT 1 NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_recipes_pkey" PRIMARY KEY("user_id","recipe_id"),
	CONSTRAINT "saved_recipes_batches_positive" CHECK ("saved_recipes"."batches" > 0)
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "scan_run_status" DEFAULT 'running' NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"new" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "source_kind" NOT NULL,
	"base_url" text NOT NULL,
	"feed_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"crawl_delay_s" integer DEFAULT 2 NOT NULL,
	"robots_checked_at" timestamp with time zone,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"profile" jsonb,
	"hard_rules" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"avatar_url" text,
	"email_verified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cook_logs" ADD CONSTRAINT "cook_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "cook_logs" ADD CONSTRAINT "cook_logs_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "grocery_checks" ADD CONSTRAINT "grocery_checks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ingredient_aliases" ADD CONSTRAINT "ingredient_aliases_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_ingredient_id_ingredients_id_fk" FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipe_scores" ADD CONSTRAINT "recipe_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipe_scores" ADD CONSTRAINT "recipe_scores_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "saved_recipes" ADD CONSTRAINT "saved_recipes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "saved_recipes" ADD CONSTRAINT "saved_recipes_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cook_logs_user_id_cooked_at_idx" ON "cook_logs" USING btree ("user_id","cooked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cook_logs_recipe_id_idx" ON "cook_logs" USING btree ("recipe_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingredient_aliases_alias_key" ON "ingredient_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "ingredient_aliases_ingredient_id_idx" ON "ingredient_aliases" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "ingredient_aliases_alias_trgm_idx" ON "ingredient_aliases" USING gin ("alias" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ingredients_name_key" ON "ingredients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ingredients_aisle_idx" ON "ingredients" USING btree ("aisle");--> statement-breakpoint
CREATE INDEX "ingredients_name_trgm_idx" ON "ingredients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "recipe_ingredients_ingredient_id_idx" ON "recipe_ingredients" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "recipe_scores_user_id_score_idx" ON "recipe_scores" USING btree ("user_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_source_url_key" ON "recipes" USING btree ("source_url");--> statement-breakpoint
CREATE INDEX "recipes_status_published_at_idx" ON "recipes" USING btree ("status","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recipes_source_id_idx" ON "recipes" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "recipes_slug_idx" ON "recipes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "recipes_last_seen_at_idx" ON "recipes" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "saved_recipes_recipe_id_idx" ON "saved_recipes" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "scan_runs_started_at_idx" ON "scan_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scan_runs_source_id_idx" ON "scan_runs" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_base_url_key" ON "sources" USING btree ("base_url");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");