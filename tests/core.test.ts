import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approveArtifact,
  claimTask,
  createTask,
  everApproved,
  feedbackArtifact,
  listEvents,
  openWorkbenchAt,
  refreshArtifact,
  registerOutput,
  reviewStatus,
  scanArtifacts,
  submitArtifact,
  taskStaleness,
  updateTask,
  type Ctx
} from "../core/index"

function makeProject(approvalMode: "warn" | "enforce"): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-test-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({ gates: { approvalMode }, moduleMapping: { landType: "land" } })
  )
  for (const dir of [
    "docs/prd/modules",
    "docs/prd/pages/admin/land",
    "docs/prd/flows",
    "docs/architecture/database",
    "docs/architecture/api/admin",
    "docs/design/prompts/admin/land",
    "docs/design/prototypes/admin/land"
  ]) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return openWorkbenchAt(root)
}

function writeDoc(ctx: Ctx, rel: string, content: string) {
  writeFileSync(join(ctx.root, rel), content)
}

describe("审批状态派生(五态模型)", () => {
  it("draft / pending / approved / invalidated / re-pending", () => {
    assert.equal(reviewStatus({ approved_hash: null, content_hash: "a", submitted_hash: null }), "draft")
    assert.equal(reviewStatus({ approved_hash: null, content_hash: "a", submitted_hash: "a" }), "pending")
    assert.equal(reviewStatus({ approved_hash: "a", content_hash: "a", submitted_hash: null }), "approved")
    assert.equal(reviewStatus({ approved_hash: "a", content_hash: "b", submitted_hash: null }), "invalidated")
    // 硬伤修复:失效后重新送审 → pending(而非永久 invalidated)
    assert.equal(reviewStatus({ approved_hash: "a", content_hash: "b", submitted_hash: "b" }), "pending")
    // 送审后又编辑 = 静默撤审 → draft
    assert.equal(reviewStatus({ approved_hash: null, content_hash: "c", submitted_hash: "b" }), "draft")
    // re-pending 的曾获批标记(信任协议:沿用禁用待遇)
    assert.equal(everApproved({ approved_hash: "a" }), true)
    assert.equal(everApproved({ approved_hash: null }), false)
  })
})

describe("五态全流程 + CRLF 归一", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("approved → 修改 → invalidated → 重新送审 → pending → 复审 → approved", () => {
    writeDoc(ctx, "docs/prd/modules/cycle.md", "v1")
    const { artifactId } = registerOutput(ctx, { module: "cycle", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/cycle.md" })
    approveArtifact(ctx, { id: artifactId }, "user")
    writeDoc(ctx, "docs/prd/modules/cycle.md", "v2")
    assert.equal(reviewStatus(refreshArtifact(ctx, { id: artifactId })), "invalidated")
    const resubmitted = submitArtifact(ctx, { id: artifactId }, "product-manager")
    assert.equal(reviewStatus(resubmitted), "pending")
    assert.equal(everApproved(resubmitted), true)
    assert.equal(reviewStatus(approveArtifact(ctx, { id: artifactId }, "user")), "approved")
  })

  it("送审后编辑 → submission_stale 事件留痕", () => {
    writeDoc(ctx, "docs/prd/modules/edit.md", "v1")
    const { artifactId } = registerOutput(ctx, { module: "edit", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/edit.md" })
    submitArtifact(ctx, { id: artifactId }, "product-manager")
    writeDoc(ctx, "docs/prd/modules/edit.md", "v2 送审后又改")
    assert.equal(reviewStatus(refreshArtifact(ctx, { id: artifactId })), "draft")
    assert.equal(listEvents(ctx.db, { entityType: "artifact", entityId: artifactId, event: "submission_stale" }).length, 1)
  })

  it("CRLF 与 LF 内容 hash 一致(幻影失效防护)", () => {
    writeDoc(ctx, "docs/prd/modules/crlf.md", "line1\nline2\n")
    const { artifactId } = registerOutput(ctx, { module: "crlf", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/crlf.md" })
    const before = refreshArtifact(ctx, { id: artifactId }).content_hash
    writeDoc(ctx, "docs/prd/modules/crlf.md", "line1\r\nline2\r\n")
    const afterHash = refreshArtifact(ctx, { id: artifactId }).content_hash
    assert.equal(before, afterHash)
  })
})

describe("并发与 stale 拦截", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("claim 原子化:第二个 agent 撞车即失败;cancelled 不可领", () => {
    writeDoc(ctx, "docs/prd/modules/race.md", "# race PRD")
    registerOutput(ctx, { module: "race", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/race.md" })
    const id = createTask(ctx, { module: "race", role: "architect", endpoint: "common", creator: "product-manager" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.throws(() => claimTask(ctx, { id, assignee: "architect-2" }), /无法领取/)

    const id2 = createTask(ctx, { module: "race", role: "architect", endpoint: "common", creator: "product-manager" })
    ctx.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id2)
    assert.throws(() => claimTask(ctx, { id: id2, assignee: "architect" }), /无法领取/)
  })

  it("stale 任务 complete 默认拦截,--force 放行留痕", () => {
    const id = createTask(ctx, { module: "race", role: "architect", endpoint: "common", creator: "product-manager" })
    claimTask(ctx, { id, assignee: "architect" })
    writeDoc(ctx, "docs/architecture/database/race.md", "# race DB")
    registerOutput(ctx, { module: "race", role: "architect", endpoint: "common", filePath: "docs/architecture/database/race.md" })

    writeDoc(ctx, "docs/prd/modules/race.md", "# race PRD v2 上游变了")
    refreshArtifact(ctx, { path: "docs/prd/modules/race.md" })

    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "architect" }), /任务已 stale/)
    const { warnings } = updateTask(ctx, { id, status: "completed", operator: "architect", force: true })
    assert.ok(warnings.some(w => w.includes("强制放行")))
  })
})

describe("claim gate 矩阵(warn 模式)", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("architect:PM 产出缺失 → 阻断", () => {
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "product-manager" })
    assert.throws(() => claimTask(ctx, { id, assignee: "architect" }), /PM 产出.*不存在/)
  })

  it("architect:PM 产出存在但未审批 → 放行 + 信任警告", () => {
    writeDoc(ctx, "docs/prd/modules/land.md", "# land 模块 PRD")
    registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "product-manager" })
    const { warnings } = claimTask(ctx, { id, assignee: "architect" })
    assert.ok(warnings.some(w => w.includes("信任警告")))
  })

  it("模块归并:landType 归并为 land", () => {
    const id = createTask(ctx, { module: "landType", role: "architect", endpoint: "common", creator: "product-manager" })
    const { id: claimed } = claimTask(ctx, { id, assignee: "architect" })
    assert.equal(claimed, id)
  })

  it("complete:无产出 → 阻断;登记产出后放行", () => {
    const id = createTask(ctx, { module: "goods", role: "architect", endpoint: "common", creator: "product-manager" })
    writeDoc(ctx, "docs/prd/modules/goods.md", "# goods PRD")
    registerOutput(ctx, { module: "goods", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/goods.md" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "architect" }), /必须添加产出文件/)

    writeDoc(ctx, "docs/architecture/database/goods.md", "# goods DB")
    registerOutput(ctx, { module: "goods", role: "architect", endpoint: "common", filePath: "docs/architecture/database/goods.md" })
    const { warnings } = updateTask(ctx, { id, status: "completed", operator: "architect" })
    assert.ok(Array.isArray(warnings))
  })

  it("只有执行人才能更新任务状态", () => {
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "product-manager" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "designer" }), /只有执行人/)
  })

  it("hotfix 任务不设文档 gate(仅懒清算提示,不阻断)", () => {
    const id = createTask(ctx, { module: "nonexist", role: "developer", endpoint: "admin", type: "hotfix", creator: "user" })
    const { warnings } = claimTask(ctx, { id, assignee: "developer" })
    assert.ok(warnings.every(w => w.includes("[清算]"))) // 未清算模块只提示对账,无信任警告
  })
})

describe("claim gate(enforce 模式)", () => {
  const ctx = makeProject("enforce")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("上游未审批 → 阻断;审批后放行", () => {
    writeDoc(ctx, "docs/prd/flows/land.md", "# land flow")
    writeDoc(ctx, "docs/prd/modules/land.md", "# land PRD")
    registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/flows/land.md" })
    registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })

    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "product-manager" })
    assert.throws(() => claimTask(ctx, { id, assignee: "architect" }), /信任警告/)

    approveArtifact(ctx, { path: "docs/prd/flows/land.md" }, "user")
    approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    const { warnings } = claimTask(ctx, { id, assignee: "architect" })
    assert.equal(warnings.length, 0)
  })
})

describe("信任锚点:修改自动失效 + 任务 stale", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("approved 文件被修改 → refresh 后 invalidated,且留 approval_invalidated 事件", () => {
    writeDoc(ctx, "docs/prd/modules/land.md", "v1")
    const { artifactId } = registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
    const approved = approveArtifact(ctx, { id: artifactId }, "user")
    assert.equal(reviewStatus(approved), "approved")

    writeDoc(ctx, "docs/prd/modules/land.md", "v2 已被篡改")
    const refreshed = refreshArtifact(ctx, { id: artifactId })
    assert.equal(reviewStatus(refreshed), "invalidated")

    const invalidatedEvents = listEvents(ctx.db, { entityType: "artifact", entityId: artifactId, event: "approval_invalidated" })
    assert.equal(invalidatedEvents.length, 1)
  })

  it("claim 快照后上游变化 → 任务派生为 stale", () => {
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "product-manager" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.equal(taskStaleness(ctx.db, id).stale, false)

    writeDoc(ctx, "docs/prd/modules/land.md", "v3 又改了")
    refreshArtifact(ctx, { path: "docs/prd/modules/land.md" })
    const info = taskStaleness(ctx.db, id)
    assert.equal(info.stale, true)
    assert.equal(info.changed.length, 1)
    assert.ok(info.changed[0].path.includes("land.md"))
  })
})

describe("反馈机制", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("负反馈必须附原因", () => {
    writeDoc(ctx, "docs/design/prototypes/admin/land/list.html", "<div>proto v1</div>")
    const { artifactId, kind } = registerOutput(ctx, {
      module: "land", role: "designer", endpoint: "admin", page: "land/list",
      filePath: "docs/design/prototypes/admin/land/list.html"
    })
    assert.equal(kind, "prototype")
    assert.throws(() => feedbackArtifact(ctx, { id: artifactId }, { verdict: -1, actor: "user" }), /负反馈必须附一句原因/)
  })

  it("原型 👍 = 反馈 + 审批合一", () => {
    const { endorsed } = feedbackArtifact(ctx, { path: "docs/design/prototypes/admin/land/list.html" }, { verdict: 1, actor: "user" })
    assert.equal(endorsed, true)
    const events = listEvents(ctx.db, { event: "approved" })
    assert.ok(events.length >= 1)
  })
})

describe("事件流:写必留痕", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("create/claim/complete/output 全部留事件", () => {
    writeDoc(ctx, "docs/prd/modules/order.md", "# order PRD")
    registerOutput(ctx, { module: "order", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/order.md" })
    const id = createTask(ctx, { module: "order", role: "architect", endpoint: "common", creator: "product-manager" })
    claimTask(ctx, { id, assignee: "architect" })
    writeDoc(ctx, "docs/architecture/database/order.md", "# order DB")
    registerOutput(ctx, { module: "order", role: "architect", endpoint: "common", filePath: "docs/architecture/database/order.md" })
    updateTask(ctx, { id, status: "completed", operator: "architect" })

    const taskEvents = listEvents(ctx.db, { entityType: "task", entityId: id })
    const names = taskEvents.map(e => e.event)
    assert.ok(names.includes("created"))
    assert.ok(names.includes("claimed"))
    assert.ok(names.includes("completed"))
    const outputEvents = listEvents(ctx.db, { entityType: "artifact", event: "output_added" })
    assert.ok(outputEvents.length >= 2)
  })

  it("产出登记自动关联已领取任务(task_outputs 外键)", () => {
    const id = createTask(ctx, { module: "news", role: "architect", endpoint: "common", creator: "product-manager" })
    writeDoc(ctx, "docs/prd/modules/news.md", "# news PRD")
    registerOutput(ctx, { module: "news", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/news.md" })
    claimTask(ctx, { id, assignee: "architect" })
    writeDoc(ctx, "docs/architecture/database/news.md", "# news DB")
    const { linkedTaskId } = registerOutput(ctx, { module: "news", role: "architect", endpoint: "common", filePath: "docs/architecture/database/news.md" })
    assert.equal(linkedTaskId, id)
  })
})

describe("机器检查门禁:按产出 kind 的 approval==='machine' 推导,不再硬编码角色", () => {
  it("默认配置:developer 产出 code(machine 审批)→ 触发机器检查", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mc-"))
    writeFileSync(
      join(root, "workbench.config.json"),
      JSON.stringify({ machineChecks: { enabled: true, service: ['node -e "process.exit(1)"'] } })
    )
    // developer service 任务的 claim gate 要求 db-doc 存在,setup 须补齐
    mkdirSync(join(root, "docs/architecture/database"), { recursive: true })
    writeFileSync(join(root, "docs/architecture/database/land.md"), "# land DB")
    mkdirSync(join(root, "service/src/modules/land"), { recursive: true })
    writeFileSync(join(root, "service/src/modules/land/x.ts"), "export {}")
    const ctx = openWorkbenchAt(root)
    ctx.config.codeRoots = { service: ["service/src/modules/{module}"] }
    scanArtifacts(ctx)
    const id = createTask(ctx, { module: "land", role: "developer", endpoint: "service", creator: "pm" })
    claimTask(ctx, { id, assignee: "developer" })
    assert.throws(
      () => updateTask(ctx, { id, status: "completed", operator: "developer", force: true }),
      /机器检查失败/
    )
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("泛化:非 developer 角色若在 roleProduces 里改产出 code,同样触发机器检查", () => {
    const root = mkdtempSync(join(tmpdir(), "wb-mc-gen-"))
    writeFileSync(
      join(root, "workbench.config.json"),
      JSON.stringify({
        machineChecks: { enabled: true, service: ['node -e "process.exit(1)"'] },
        codeRoots: { service: ["service/src/modules/{module}"] },
        roleProduces: { architect: ["code"] }
      })
    )
    mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
    writeFileSync(join(root, "docs/prd/modules/land.md"), "# PRD")
    mkdirSync(join(root, "service/src/modules/land"), { recursive: true })
    writeFileSync(join(root, "service/src/modules/land/x.ts"), "export {}")
    const ctx = openWorkbenchAt(root)
    scanArtifacts(ctx) // 登记 module-prd(docs 树)与 code(codeRoots 目录级)
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "service", creator: "pm" })
    claimTask(ctx, { id, assignee: "architect" })
    assert.throws(
      () => updateTask(ctx, { id, status: "completed", operator: "architect", force: true }),
      /机器检查失败/
    )
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })
})

describe("任务级跨角色前置(config.taskPreconditions)", () => {
  const ctx = makeProject("warn")
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("默认规则:qa 领取前置——developer 未完成则阻断,完成后放行", () => {
    writeDoc(ctx, "docs/prd/modules/land.md", "# land PRD")
    registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
    // 任务级前置是本组主角:developer 用 hotfix(不设文档 gate),绕开无关的 exist 要求
    const devId = createTask(ctx, { module: "land", role: "developer", endpoint: "admin", type: "hotfix", creator: "pm" })
    const qaId = createTask(ctx, { module: "land", role: "qa", endpoint: "admin", type: "qa", creator: "pm" })

    assert.throws(() => claimTask(ctx, { id: qaId, assignee: "qa" }), /developer admin 任务尚未完成/)

    claimTask(ctx, { id: devId, assignee: "developer" })
    updateTask(ctx, { id: devId, status: "completed", operator: "developer", force: true })

    const { id } = claimTask(ctx, { id: qaId, assignee: "qa" })
    assert.equal(id, qaId)
  })

  it("自定义规则:可声明任意角色对的任务级前置,证明泛化(不锁死 qa/developer)", () => {
    ctx.config.taskPreconditions = [{ role: "designer", requiresSiblingRoleCompleted: "product-manager" }]
    const designId = createTask(ctx, { module: "land", role: "designer", endpoint: "admin", creator: "pm" })
    assert.throws(() => claimTask(ctx, { id: designId, assignee: "designer" }), /product-manager admin 任务尚未完成/)

    const pmId = createTask(ctx, { module: "land", role: "product-manager", endpoint: "admin", creator: "pm" })
    claimTask(ctx, { id: pmId, assignee: "product-manager" })
    updateTask(ctx, { id: pmId, status: "completed", operator: "product-manager", force: true })

    const { id } = claimTask(ctx, { id: designId, assignee: "designer" })
    assert.equal(id, designId)
  })
})
