import Database from "better-sqlite3"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_KIND_REGISTRY,
  META_KINDS,
  SCHEMA_V1,
  createTask,
  ensureSchema,
  openWorkbenchAt,
  registerMetaArtifacts,
  reviewStatus
} from "../core/index"

function normalizedSchema(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`
    )
    .all() as { type: string; name: string; sql: string }[]
  return rows.map(r => `${r.type}:${r.name}:${r.sql.replace(/\s+/g, " ").trim()}`).join("\n")
}

describe("schema 等价测试:基线路径与全新路径必须收敛", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-mig-"))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("基线戳库(版本1→N) 与 空库(0→N) 最终 schema 一致", () => {
    // 路径 A:模拟 pre-versioning 真实库(手工建 V1 形态,无 schema_version)
    const dbA = new Database(join(dir, "baseline.db"))
    dbA.exec(SCHEMA_V1)
    ensureSchema(dbA) // 应打基线戳=1,然后跑迁移 2

    // 路径 B:全新空库跑完整迁移链
    const dbB = new Database(join(dir, "fresh.db"))
    ensureSchema(dbB)

    assert.equal(normalizedSchema(dbA), normalizedSchema(dbB))

    const vA = dbA.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }
    const vB = dbB.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }
    assert.equal(vA.v, CURRENT_SCHEMA_VERSION)
    assert.equal(vB.v, CURRENT_SCHEMA_VERSION)
    dbA.close()
    dbB.close()
  })

  it("迁移 2 保留数据:V1 库中的任务原样带入重建后的表", () => {
    const db = new Database(join(dir, "data.db"))
    db.exec(SCHEMA_V1)
    db.prepare(
      "INSERT INTO tasks (module, role, endpoint, status, assignee, creator) VALUES ('land','architect','common','completed','architect','pm')"
    ).run()
    ensureSchema(db)
    const row = db.prepare("SELECT * FROM tasks").get() as Record<string, unknown>
    assert.equal(row.module, "land")
    assert.equal(row.external_ref, null)
    db.close()
  })

  it("迁移 4:artifact_edges 有 source 列,默认 derived,拒绝非法值", () => {
    const db = new Database(join(dir, "edges.db"))
    ensureSchema(db)
    const cols = db.prepare("PRAGMA table_info(artifact_edges)").all() as { name: string; dflt_value: string | null }[]
    const source = cols.find(c => c.name === "source")
    assert.ok(source, "缺 source 列")
    assert.match(String(source!.dflt_value), /derived/)

    db.prepare("INSERT INTO artifacts (kind, path, content_hash) VALUES ('doc','a.md','h')").run()
    db.prepare("INSERT INTO artifacts (kind, path, content_hash) VALUES ('doc','b.md','h')").run()
    db.prepare("INSERT INTO artifact_edges (from_id, to_id) VALUES (1, 2)").run()
    const row = db.prepare("SELECT source FROM artifact_edges WHERE from_id = 1").get() as { source: string }
    assert.equal(row.source, "derived") // 未指定即 derived
    db.prepare("INSERT INTO artifact_edges (from_id, to_id, source) VALUES (2, 1, 'manual')").run()
    assert.throws(() => db.prepare("INSERT INTO artifact_edges (from_id, to_id, source) VALUES (1, 1, 'weird')").run())
    db.close()
  })
})

describe("CHECK 手术后的项目语义校验(commands 层)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-check-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("rework 类型合法;非法角色被 commands 层拦截;status 仍由 DB CHECK 兜底", () => {
    const id = createTask(ctx, { module: "land", role: "developer", endpoint: "admin", type: "rework", creator: "qa" })
    assert.ok(id > 0)
    assert.throws(
      () => createTask(ctx, { module: "land", role: "hacker" as never, endpoint: "admin", creator: "x" }),
      /无效的角色/
    )
    // 引擎不变式:status CHECK 留在 DB 层做最后防线
    assert.throws(() => ctx.db.prepare("UPDATE tasks SET status = 'weird' WHERE id = ?").run(id))
  })

  it("endpoint 可为空(纯后端/项目级任务的坐标退化)", () => {
    const id = createTask(ctx, { role: "product-manager", creator: "user" })
    assert.ok(id > 0)
  })
})

describe("元产物 draft 注册(零摩擦入体系)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-meta-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, ".claude/agents"), { recursive: true })
  mkdirSync(join(root, ".claude/skills/demo-skill"), { recursive: true })
  mkdirSync(join(root, "docs/workbench"), { recursive: true })
  writeFileSync(join(root, ".claude/agents/developer.md"), "# developer agent")
  writeFileSync(join(root, ".claude/skills/demo-skill/SKILL.md"), "# demo skill")
  writeFileSync(join(root, "docs/workbench/PLAN.md"), "# plan")
  const ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("agent-def/skill/plan 正确推断,注册即 draft,重跑幂等", () => {
    const first = registerMetaArtifacts(ctx)
    const kinds = Object.fromEntries(first.registered.map(r => [r.kind, r.path]))
    assert.ok(kinds["agent-def"]?.endsWith("developer.md"))
    assert.ok(kinds["skill"]?.endsWith("SKILL.md"))
    assert.ok(kinds["plan"]?.endsWith("PLAN.md"))

    const rows = ctx.db.prepare("SELECT * FROM artifacts").all() as Parameters<typeof reviewStatus>[0][]
    for (const row of rows) assert.equal(reviewStatus(row), "draft")

    const second = registerMetaArtifacts(ctx)
    assert.equal(second.registered.length, 0)
    assert.equal(second.skipped.length, first.registered.length)
  })

  it("注册表:meta kinds 与 drivesStale/approval 定稿自洽", () => {
    assert.deepEqual([...META_KINDS].sort(), ["agent-def", "hook-script", "plan", "skill"])
    assert.equal(DEFAULT_KIND_REGISTRY["prototype"].approval, "thumbs")
    assert.equal(DEFAULT_KIND_REGISTRY["prototype"].drivesStale, true)
    assert.equal(DEFAULT_KIND_REGISTRY["code"].drivesStale, false)
    assert.equal(DEFAULT_KIND_REGISTRY["design-prompt"].approval, "none")
  })
})
