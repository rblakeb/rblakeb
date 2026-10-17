import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  // Runs several statements with no parameters (migrations).
  exec(sql: string): Promise<void>;
  // Inside `fn`, use only the `tx` handle; the outer one would wait on the transaction.
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

// With a DATABASE_URL (Supabase or any Postgres) uses a connection pool.
// Without one, runs an embedded Postgres: in memory, or persisted to `dataDir`.
export async function openDb(options: { url?: string; dataDir?: string } = {}): Promise<Db> {
  const db = options.url ? postgresDb(options.url) : await pgliteDb(options.dataDir);
  await migrate(db);
  return db;
}

function postgresDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (client: pg.Pool | pg.PoolClient): Omit<Db, "transaction" | "close"> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await client.query(sql, params)).rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  });
  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const tx: Db = { ...wrap(client), transaction: (inner) => inner(tx), close: async () => {} };
        const result = await fn(tx);
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function pgliteDb(dataDir?: string): Promise<Db> {
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const pglite = await PGlite.create(dataDir);
  type Queryable = Pick<PGlite, "query" | "exec">;
  const wrap = (q: Queryable): Omit<Db, "transaction" | "close"> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      return (await q.query<T>(sql, params)).rows;
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
  });
  return {
    ...wrap(pglite),
    transaction(fn) {
      return pglite.transaction((t) => {
        const tx: Db = { ...wrap(t), transaction: (inner) => inner(tx), close: async () => {} };
        return fn(tx);
      });
    },
    close: () => pglite.close(),
  };
}

// Applies server/migrations/*.sql in name order, each once.
async function migrate(db: Db): Promise<void> {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
    });
  }
}

// The process-wide database, set once at startup (or per test file).
let current: Db | null = null;

export function setDb(db: Db): void {
  current = db;
}

export function getDb(): Db {
  if (!current) throw new Error("Database not initialized");
  return current;
}
