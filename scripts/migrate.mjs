#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const PG_SSL_QUERY_KEYS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslpassword",
  "sslaccept",
  "uselibpqcompat"
];

function normalizeEnvMultiline(value) {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/\\n/g, "\n");
}

function stripPgSslParams(urlString) {
  try {
    const url = new URL(urlString);
    for (const key of PG_SSL_QUERY_KEYS) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return urlString;
  }
}

// SSL 配置：DATABASE_CA 支持原始 PEM 或 Base64 编码
function getSSLOptions() {
  const ca = process.env.DATABASE_CA;
  if (!ca) return undefined;

  const normalized = normalizeEnvMultiline(ca);
  if (normalized.includes("-----BEGIN CERTIFICATE-----")) {
    return { ca: normalized, rejectUnauthorized: true };
  }

  const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
  const pem = normalizeEnvMultiline(decoded);
  return { ca: pem, rejectUnauthorized: true };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const separatorIndex = normalized.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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

function getConnectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || "";
}

function shouldUseNeon(connectionString) {
  return process.env.DATABASE_DRIVER === "neon" ||
    (process.env.DATABASE_DRIVER !== "pg" && /\.neon\.tech/.test(connectionString));
}

async function createMigrateContext(connectionString) {
  const useNeon = shouldUseNeon(connectionString);
  if (useNeon) {
    const { Pool, neonConfig } = await import("@neondatabase/serverless");
    const { WebSocket } = await import("ws");
    neonConfig.webSocketConstructor = WebSocket;
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
    const pool = new Pool({ connectionString });
    const db = drizzle(pool);
    return { pool, db, migrate, useNeon };
  } else {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const sslOptions = getSSLOptions();
    const pgConnectionString = sslOptions
      ? stripPgSslParams(connectionString)
      : connectionString;
    const pool = new pg.default.Pool({
      connectionString: pgConnectionString,
      ssl: sslOptions
    });
    const db = drizzle(pool);
    return { pool, db, migrate, useNeon };
  }
}

function getMigrationMeta(migrationsFolder) {
  const journalPath = `${migrationsFolder}/meta/_journal.json`;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));

  return journal.entries.map((entry) => {
    const sql = readFileSync(`${migrationsFolder}/${entry.tag}.sql`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");

    return {
      tag: entry.tag,
      hash,
      createdAt: entry.when
    };
  });
}

async function runMigrations() {
  loadLocalEnv();

  const connectionString = getConnectionString();
  if (!connectionString) {
    console.warn("未检测到 DATABASE_URL 或 POSTGRES_URL，跳过数据库迁移。");
    process.exit(0);
  }

  const { pool, db, migrate, useNeon } = await createMigrateContext(connectionString);
  try {
    console.log(`检查迁移表... (驱动: ${useNeon ? "neon-serverless" : "pg"})`);
    
    await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
    await pool.query(
      "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT)"
    );

    // 获取本地所有迁移元数据
    const allMigrations = getMigrationMeta("./drizzle");
    
    // 检查数据库中已有的迁移记录
    const existingMigrations = await pool.query(
      "SELECT hash, created_at FROM drizzle.__drizzle_migrations"
    );
    const existingHashes = new Set(existingMigrations.rows.map((r) => r.hash));

    // 检查 model_prices 表是否存在
    const tableExists = await pool.query(
      "SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'model_prices' AND c.relkind IN ('r','p') LIMIT 1"
    );

    // 如果表已存在，需要确保对应的迁移已标记
    if (tableExists.rows.length > 0) {
      // 找出 0000 迁移
      const initialMigration = allMigrations.find((m) => m.tag.startsWith("0000_"));
      
      if (initialMigration && !existingHashes.has(initialMigration.hash)) {
        console.log("检测到表已存在但迁移未标记，正在标记...");
        await pool.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [initialMigration.hash, initialMigration.createdAt]
        );
        console.log("✓ 已标记 0000 迁移");
      }
    }

    console.log("执行数据库迁移...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("✓ 迁移完成");
  } catch (error) {
    console.error("迁移失败:", error);
    try { await pool.end(); } catch {}
    // 不阻止构建继续
  } finally {
    await pool.end().catch(() => undefined);
    process.exit(0);
  }
}

runMigrations();
