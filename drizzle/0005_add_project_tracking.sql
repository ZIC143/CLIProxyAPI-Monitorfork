ALTER TABLE "usage_records"
  ADD COLUMN IF NOT EXISTS "project" text NOT NULL DEFAULT '';

-- 为历史数据回填主项目（以当前环境首项目为准）
-- 若未配置 CLIPROXY_API_BASE_URL(S)，该值保持为空字符串。

DROP INDEX IF EXISTS "usage_records_occurred_route_model_source_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_occurred_project_route_model_source_idx"
  ON "usage_records" USING btree ("occurred_at", "project", "route", "model", "source");

CREATE INDEX IF NOT EXISTS "usage_records_project_occurred_at_idx"
  ON "usage_records" ("project", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "usage_records_project_occurred_model_idx"
  ON "usage_records" ("project", "occurred_at" DESC, "model");

CREATE INDEX IF NOT EXISTS "usage_records_project_occurred_route_idx"
  ON "usage_records" ("project", "occurred_at" DESC, "route");

CREATE INDEX IF NOT EXISTS "usage_records_project_occurred_source_idx"
  ON "usage_records" ("project", "occurred_at" DESC, "source");
