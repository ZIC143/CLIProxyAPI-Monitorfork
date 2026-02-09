CREATE INDEX IF NOT EXISTS "usage_records_occurred_at_idx"
  ON "usage_records" ("occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "usage_records_route_occurred_at_idx"
  ON "usage_records" ("route", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "usage_records_model_occurred_at_idx"
  ON "usage_records" ("model", "occurred_at" DESC);

CREATE INDEX IF NOT EXISTS "usage_records_source_occurred_at_idx"
  ON "usage_records" ("source", "occurred_at" DESC);
