#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createPool } from "@vercel/postgres";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) continue;

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnv() {
  const env = process.env.NODE_ENV || "development";
  const envFiles = [
    `.env.${env}.local`,
    env !== "test" ? ".env.local" : null,
    `.env.${env}`,
    ".env"
  ].filter(Boolean);

  for (const file of envFiles) {
    loadEnvFile(file);
  }
}

async function main() {
  loadLocalEnv();

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL 或 POSTGRES_URL 未配置");
  }

  const pool = createPool({ connectionString });

  try {
    await pool.query("BEGIN");

    // 0) 对 auth_index 为空且将被置空 email 的数据先去重，避免触发唯一索引冲突
    const dedupeNoAuthRes = await pool.query(
      `
      WITH ranked AS (
        SELECT
          id,
          row_number() OVER (
            PARTITION BY occurred_at, project, route, model
            ORDER BY id
          ) AS rn
        FROM usage_records
        WHERE auth_index IS NULL OR auth_index = ''
      )
      DELETE FROM usage_records u
      USING ranked r
      WHERE u.id = r.id
        AND r.rn > 1
      `
    );

    // 1) auth_index 为空：直接清空 provider/email
    const clearResult = await pool.query(
      `
      UPDATE usage_records
      SET provider = '', email = ''
      WHERE auth_index IS NULL OR auth_index = ''
      `
    );

    // 2) auth_index 有值：按现有匹配规则回填 provider/email
    const candidateCountRes = await pool.query(
      `
      SELECT count(*)::int AS count
      FROM usage_records
      WHERE auth_index IS NOT NULL AND auth_index <> ''
      `
    );
    const candidateWithAuthIndex = Number(candidateCountRes.rows?.[0]?.count ?? 0);

    // 1.5) 对映射后将命中同一唯一键的数据先去重（保留 id 最小一条）
    const dedupeMappedRes = await pool.query(
      `
      WITH mapped AS (
        SELECT
          u.id,
          u.occurred_at,
          u.project,
          u.route,
          u.model,
          COALESCE(
            NULLIF((SELECT af.email FROM auth_file_mappings af WHERE af.auth_id = u.auth_index LIMIT 1), ''),
            NULLIF((SELECT af.name FROM auth_file_mappings af WHERE af.auth_id = u.auth_index LIMIT 1), ''),
            NULLIF((SELECT af2.email FROM auth_file_mappings af2 WHERE af2.auth_id = u.email LIMIT 1), ''),
            NULLIF((SELECT af2.name FROM auth_file_mappings af2 WHERE af2.auth_id = u.email LIMIT 1), ''),
            ''
          ) AS target_email
        FROM usage_records u
        WHERE u.auth_index IS NOT NULL
          AND u.auth_index <> ''
          AND (
            EXISTS (SELECT 1 FROM auth_file_mappings af WHERE af.auth_id = u.auth_index)
            OR EXISTS (SELECT 1 FROM auth_file_mappings af2 WHERE af2.auth_id = u.email)
          )
      ),
      ranked AS (
        SELECT
          m.id,
          EXISTS (
            SELECT 1
            FROM usage_records u2
            WHERE u2.occurred_at = m.occurred_at
              AND u2.project = m.project
              AND u2.route = m.route
              AND u2.model = m.model
              AND u2.email = m.target_email
              AND u2.id <> m.id
          ) AS has_existing_conflict,
          row_number() OVER (
            PARTITION BY occurred_at, project, route, model, target_email
            ORDER BY id
          ) AS rn
        FROM mapped m
      ),
      to_delete AS (
        SELECT id
        FROM ranked
        WHERE has_existing_conflict = true OR rn > 1
      )
      DELETE FROM usage_records u
      USING to_delete d
      WHERE u.id = d.id
      `
    );

    const updatedRes = await pool.query(
      `
      UPDATE usage_records u
      SET
        provider = COALESCE(
          NULLIF((SELECT af.provider FROM auth_file_mappings af WHERE af.auth_id = u.auth_index LIMIT 1), ''),
          NULLIF((SELECT af2.provider FROM auth_file_mappings af2 WHERE af2.auth_id = u.email LIMIT 1), ''),
          ''
        ),
        email = COALESCE(
          NULLIF((SELECT af.email FROM auth_file_mappings af WHERE af.auth_id = u.auth_index LIMIT 1), ''),
          NULLIF((SELECT af.name FROM auth_file_mappings af WHERE af.auth_id = u.auth_index LIMIT 1), ''),
          NULLIF((SELECT af2.email FROM auth_file_mappings af2 WHERE af2.auth_id = u.email LIMIT 1), ''),
          NULLIF((SELECT af2.name FROM auth_file_mappings af2 WHERE af2.auth_id = u.email LIMIT 1), ''),
          ''
        )
      WHERE u.auth_index IS NOT NULL
        AND u.auth_index <> ''
        AND (
          EXISTS (SELECT 1 FROM auth_file_mappings af WHERE af.auth_id = u.auth_index)
          OR EXISTS (SELECT 1 FROM auth_file_mappings af2 WHERE af2.auth_id = u.email)
        )
      `
    );
    const mappedAndUpdated = Number(updatedRes.rowCount ?? 0);

    await pool.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          status: "ok",
          removedDuplicatesWithoutAuthIndex: Number(dedupeNoAuthRes.rowCount ?? 0),
          clearedWithoutAuthIndex: Number(clearResult.rowCount ?? 0),
          candidateWithAuthIndex,
          removedDuplicatesAfterMapping: Number(dedupeMappedRes.rowCount ?? 0),
          mappedAndUpdated,
          unmatchedWithAuthIndex: Math.max(candidateWithAuthIndex - mappedAndUpdated, 0)
        },
        null,
        2
      )
    );
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error("[backfill-usage-provider-email] failed:", error);
  process.exit(1);
});
