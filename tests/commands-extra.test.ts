import Database from "better-sqlite3"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approveArtifact,
  disputeArtifact,
  graphModule,
  intakeIssues,
  listEvents,
  migrateLegacy,
  openWorkbenchAt,
  registerOutput,
  rejectArtifact,
  resolveArtifact,
  reviewStatus,
  scanArtifacts,
  submitArtifact,
  type Ctx
} from "../core/index"

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("dispute:对 approved 内容留痕异议且不改状态", () => {
  const root = tmpRoot("wb-dispute-")
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  const ctx: Ctx = openWorkbenchAt(root)
  const { artifactId } = registerOutput(ctx, {
    module: "land",
    role: "product-manager",
    endpoint: "common",
    filePath: "docs/prd/modules/land.md"
  })
  approveArtifact(ctx, { id: artifactId }, "user")
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("空理由被拒;有理由 → dispute 事件留痕,审批状态保持 approved", () => {
    assert.throws(() => disputeArtifact(ctx, { id: artifactId }, "developer", "  "), /异议必须说明理由/)

    disputeArtifact(ctx, { id: artifactId }, "developer", "枚举定义与 DB 契约冲突")
    const events = listEvents(ctx.db, { entityType: "artifact", entityId: artifactId, event: "dispute" })
    assert.equal(events.length, 1)
    assert.equal(JSON.parse(events[0].payload!).reason, "枚举定义与 DB 契约冲突")

    // dispute 只留痕停下,不动审批状态
    assert.equal(reviewStatus(resolveArtifact(ctx, { id: artifactId })), "approved")
  })
})

describe("reject:打回清空送审态并留痕", () => {
  const root = tmpRoot("wb-reject-")
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  const ctx: Ctx = openWorkbenchAt(root)
  const { artifactId } = registerOutput(ctx, {
    module: "land",
    role: "product-manager",
    endpoint: "common",
    filePath: "docs/prd/modules/land.md"
  })
  submitArtifact(ctx, { id: artifactId }, "product-manager")
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("空原因被拒;有原因 → pending 回落 draft + rejected 事件", () => {
    assert.equal(reviewStatus(resolveArtifact(ctx, { id: artifactId })), "pending")
    assert.throws(() => rejectArtifact(ctx, { id: artifactId }, "user", ""), /打回必须附原因/)

    rejectArtifact(ctx, { id: artifactId }, "user", "缺少字段级验收要点")
    // submitted_hash 被清空,又未 approved → draft
    assert.equal(reviewStatus(resolveArtifact(ctx, { id: artifactId })), "draft")
    const events = listEvents(ctx.db, { entityType: "artifact", entityId: artifactId, event: "rejected" })
    assert.equal(events.length, 1)
    assert.equal(JSON.parse(events[0].payload!).reason, "缺少字段级验收要点")
  })
})

describe("graph:模块关系链 Mermaid 输出", () => {
  const root = tmpRoot("wb-graph-")
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/pages/admin/land/list.md", "# 列表页 PRD")
  const ctx: Ctx = openWorkbenchAt(root)
  scanArtifacts(ctx)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("空模块 → 注释;有产物 → flowchart + 分层节点 + 边 + 审批样式", () => {
    assert.match(graphModule(ctx, "nope"), /没有登记任何产物/)

    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    const g = graphModule(ctx, "land")
    assert.ok(g.startsWith("flowchart TD"), "应是 Mermaid flowchart")
    assert.match(g, /classDef approved/)
    assert.match(g, /:::approved/) // 已批节点带 approved 样式类
    assert.match(g, /a\d+ --> a\d+/) // 至少一条推导边(flow→module-prd→page-prd)
    assert.ok(g.includes("land.md"))
  })
})

describe("migrate:旧 tasks/task.db 迁移(幂等防重)", () => {
  const root = tmpRoot("wb-migrate-")
  writeFileSync(join(root, "workbench.config.json"), "{}")
  // 旧库:仿 pre-workbench 的 tasks/task.db 形态
  mkdirSync(join(root, "tasks"), { recursive: true })
  const legacyPath = join(root, "tasks/task.db")
  const ldb = new Database(legacyPath)
  ldb.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, module TEXT, role TEXT, endpoint TEXT, page TEXT,
      status TEXT, assignee TEXT, creator TEXT, content TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE task_outputs (id INTEGER PRIMARY KEY, module TEXT, role TEXT, endpoint TEXT, page TEXT,
      file_path TEXT, created_at TEXT);
    CREATE TABLE task_records (id INTEGER PRIMARY KEY, task_id INTEGER, content TEXT, operator TEXT, created_at TEXT);
  `)
  ldb.prepare(
    "INSERT INTO tasks (id, module, role, endpoint, page, status, assignee, creator, content, created_at, updated_at) VALUES (1,'land','architect','common',NULL,'completed','architect','pm','旧任务', '2025-01-01 00:00:00','2025-01-02 00:00:00')"
  ).run()
  // 一个产出文件存在(可链接) + 一个缺失(计入 missingFiles)
  mkdirSync(join(root, "docs/architecture/database"), { recursive: true })
  writeFileSync(join(root, "docs/architecture/database/land.md"), "# land DB")
  ldb.prepare(
    "INSERT INTO task_outputs (module, role, endpoint, page, file_path, created_at) VALUES ('land','architect','common',NULL,'docs/architecture/database/land.md','2025-01-01 00:00:00')"
  ).run()
  ldb.prepare(
    "INSERT INTO task_outputs (module, role, endpoint, page, file_path, created_at) VALUES ('land','architect','common',NULL,'docs/architecture/api/gone.md','2025-01-01 00:00:00')"
  ).run()
  ldb.prepare(
    "INSERT INTO task_records (task_id, content, operator, created_at) VALUES (1,'历史备注','architect','2025-01-01 00:00:00')"
  ).run()
  ldb.close()

  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("旧任务标 legacy 带入,产出转 artifacts,记录转 note;缺失文件计入;重跑被拒", () => {
    const s = migrateLegacy(ctx, "tasks/task.db")
    assert.equal(s.tasks, 1)
    assert.equal(s.artifacts, 2)
    assert.equal(s.linkedOutputs, 2) // 两个产出都按 role/endpoint/module/page 匹配到 legacy 任务
    assert.deepEqual(s.missingFiles, ["docs/architecture/api/gone.md"])
    assert.equal(s.notes, 1)

    const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = 1").get() as { type: string; module: string }
    assert.equal(task.type, "legacy")
    assert.equal(task.module, "land")
    const notes = listEvents(ctx.db, { entityType: "task", entityId: 1, event: "note" })
    assert.equal(notes.length, 1)

    // 幂等防重:已存在 legacy 任务 → 拒绝再迁移
    assert.throws(() => migrateLegacy(ctx, "tasks/task.db"), /已迁移过/)
  })
})

describe("intake:非 GitHub 环境快速失败", () => {
  const root = tmpRoot("wb-intake-")
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("gh 不可用 / 非 GitHub 仓库 → 明确报错,不静默建任务", () => {
    // 临时目录不是 git/GitHub 仓库;gh 未装时同样落这条错误分支
    assert.throws(() => intakeIssues(ctx), /gh CLI 不可用|intake 依赖 gh/)
    assert.equal((ctx.db.prepare("SELECT COUNT(*) c FROM tasks").get() as { c: number }).c, 0)
  })
})
