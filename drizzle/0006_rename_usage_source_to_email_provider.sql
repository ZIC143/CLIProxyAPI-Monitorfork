DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usage_records'
      AND column_name = 'source'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usage_records'
      AND column_name = 'email'
  ) THEN
    ALTER TABLE "usage_records" RENAME COLUMN "source" TO "email";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usage_records'
      AND column_name = 'channel'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'usage_records'
      AND column_name = 'provider'
  ) THEN
    ALTER TABLE "usage_records" RENAME COLUMN "channel" TO "provider";
  END IF;
END $$;

DROP INDEX IF EXISTS "usage_records_occurred_project_route_model_source_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_occurred_project_route_model_email_idx"
  ON "usage_records" USING btree ("occurred_at", "project", "route", "model", "email");

DROP INDEX IF EXISTS "usage_records_source_occurred_at_idx";
CREATE INDEX IF NOT EXISTS "usage_records_email_occurred_at_idx"
  ON "usage_records" ("email", "occurred_at" DESC);

DROP INDEX IF EXISTS "usage_records_project_occurred_source_idx";
CREATE INDEX IF NOT EXISTS "usage_records_project_occurred_email_idx"
  ON "usage_records" ("project", "occurred_at" DESC, "email");
