import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { findProjectRoot, loadConfig } from "./config"
import type { Ctx } from "./types"

/**
 * 迁移 1:初始 schema(含 submitted_hash)。
 * 历史说明:role/type 的 CHECK 在迁移 2 中删除(项目语义下沉 commands 层),
 * status 的 CHECK 保留(引擎不变式,DB 层最后防线)。
 */
export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  module        TEXT,
  endpoint      TEXT,
  page          TEXT,
  path          TEXT NOT NULL UNIQUE,
  content_hash  TEXT NOT NULL,
  approved_hash TEXT,
  reviewed_by   TEXT,
  reviewed_at   DATETIME,
  submitted_at  DATETIME,
  submitted_hash TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifact_edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  to_id   INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  UNIQUE(from_id, to_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  module     TEXT,
  role       TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  page       TEXT,
  type       TEXT NOT NULL DEFAULT 'build',
  status     TEXT NOT NULL DEFAULT 'pending',
  assignee   TEXT,
  creator    TEXT NOT NULL,
  content    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (role IN ('product-manager', 'architect', 'designer', 'developer', 'qa')),
  CHECK (type IN ('build', 'review', 'qa', 'hotfix', 'baseline', 'legacy')),
  CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS task_inputs (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  input_hash  TEXT NOT NULL,
  UNIQUE(task_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS task_outputs (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  UNIQUE(task_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  event       TEXT NOT NULL,
  actor       TEXT NOT NULL,
  payload     TEXT,
  module      TEXT,
  endpoint    TEXT,
  page        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS artifact_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id  INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  verdict      INTEGER NOT NULL CHECK (verdict IN (1, -1)),
  comment      TEXT,
  content_hash TEXT NOT NULL,
  actor        TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_artifacts_coord ON artifacts(module, endpoint, page);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_coord ON tasks(module, role, endpoint, status);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_feedback_artifact ON artifact_feedback(artifact_id);
`

/**
 * 迁移 2(CHECK 手术 + 便宜 DDL):
 * - tasks 重建:删 role/type CHECK(项目语义下沉 commands 层),保 status CHECK(引擎不变式);
 *   endpoint 改 nullable;新增 external_ref(issue 关联)
 * - events 补 module / event 索引
 */
const MIGRATION_2 = `
CREATE TABLE tasks_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module       TEXT,
  role         TEXT NOT NULL,
  endpoint     TEXT,
  page         TEXT,
  type         TEXT NOT NULL DEFAULT 'build',
  status       TEXT NOT NULL DEFAULT 'pending',
  assignee     TEXT,
  creator      TEXT NOT NULL,
  content      TEXT,
  external_ref TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'))
);
INSERT INTO tasks_new (id, module, role, endpoint, page, type, status, assignee, creator, content, external_ref, created_at, updated_at)
  SELECT id, module, role, endpoint, page, type, status, assignee, creator, content, NULL, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_coord ON tasks(module, role, endpoint, status);
CREATE INDEX IF NOT EXISTS idx_events_module ON events(module);
CREATE INDEX IF NOT EXISTS idx_events_event ON events(event);
`

interface Migration {
  version: number
  up: (db: Database.Database) => void
}

export const MIGRATIONS: Migration[] = [
  { version: 1, up: db => db.exec(SCHEMA_V1) },
  {
    version: 2,
    up: db => {
      db.pragma("foreign_keys = OFF")
      db.exec(MIGRATION_2)
      db.pragma("foreign_keys = ON")
      const violations = db.pragma("foreign_key_check") as unknown[]
      if (violations.length > 0) {
        throw new Error(`迁移 2 后外键校验失败: ${JSON.stringify(violations)}`)
      }
    }
  },
  // 迁移 3:claim 时记录 git HEAD,供 hotfix 契约触碰检测与 trailer 交叉验证
  { version: 3, up: db => db.exec("ALTER TABLE tasks ADD COLUMN claim_commit TEXT") },
  // 迁移 4:边来源(derived=scan 按 parents×坐标推导,对账维护;manual=用户手动声明,可解绑、scan 永不动)
  {
    version: 4,
    up: db =>
      db.exec(
        "ALTER TABLE artifact_edges ADD COLUMN source TEXT NOT NULL DEFAULT 'derived' CHECK (source IN ('derived','manual'))"
      )
  }
]

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * 版本化迁移:
 * - 基线规则:库已有 artifacts 表但无 schema_version → 打基线戳(=版本 1)
 * - 新库从空跑迁移链 0→N;两条路径的最终 schema 由等价测试保证一致
 */
export function ensureSchema(db: Database.Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
  )
  let current =
    (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0

  if (current === 0) {
    const hasArtifacts = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'")
      .get() as { c: number }
    if (hasArtifacts.c > 0) {
      // 基线戳:pre-versioning 真实库 = 版本 1(含 ad-hoc submitted_hash 补丁的兜底)
      const cols = (db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]).map(c => c.name)
      if (!cols.includes("submitted_hash")) {
        db.exec("ALTER TABLE artifacts ADD COLUMN submitted_hash TEXT")
      }
      db.prepare("INSERT INTO schema_version (version) VALUES (1)").run()
      current = 1
    }
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    const tx = db.transaction(() => {
      m.up(db)
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version)
    })
    tx()
  }
}

function openDb(root: string, config: Ctx["config"]): Database.Database {
  const dataDir = join(root, config.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, "workbench.db"))
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  db.pragma("busy_timeout = 5000")
  ensureSchema(db)
  return db
}

export function openWorkbench(rootArg?: string): Ctx {
  const root = findProjectRoot(rootArg)
  const config = loadConfig(root)
  return { root, config, db: openDb(root, config) }
}

/** 测试/多项目场景:在指定目录直接开库(不向上找 config) */
export function openWorkbenchAt(root: string): Ctx {
  const config = loadConfig(root)
  return { root, config, db: openDb(root, config) }
}
