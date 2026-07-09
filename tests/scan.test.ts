import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  addTaskInput,
  approveArtifact,
  claimTask,
  createTask,
  listArtifacts,
  listEvents,
  moveArtifact,
  openWorkbenchAt,
  refreshArtifact,
  reviewStatus,
  scanArtifacts,
  taskStaleness,
  type Ctx
} from "../core/index"

function makeProject(): Ctx {
  const root = mkdtempSync(join(tmpdir(), "wb-scan-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      moduleMapping: { landType: "land" },
      codeRoots: {
        service: ["service/src/modules/{client}/{module}"],
        admin: ["admin/src/pages/home/{module}"]
      }
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("ARCHITECTURE.md", "# 架构基线")
  write("docs/prd/project.md", "# 项目")
  write("docs/prd/flows/land.md", "# land flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/pages/admin/land/list.md", "# land 列表页 PRD")
  write("docs/architecture/database/land.md", "# land DB")
  write("docs/architecture/api/admin/land.md", "# land API")
  write("docs/design/systems/admin.md", "# admin 设计系统")
  write("docs/design/prompts/admin/land/list.md", "# 提示词")
  write("docs/design/prototypes/admin/land/list.html", "<div>proto</div>")
  // 元产物路径(应被 scan 排除)
  write(".claude/agents/developer.md", "# agent")
  write("docs/workbench/PLAN.md", "# plan")
  // 代码目录
  write("service/src/modules/admin/land/admin.land.controller.ts", "export {}")
  write("admin/src/pages/home/landType/index.tsx", "export {}")
  return openWorkbenchAt(root)
}

describe("scan:全量登记 + 坐标解析 + 边推导", () => {
  const ctx = makeProject()
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("登记全部业务产物,排除元产物,代码目录级登记且模块归并", () => {
    const s = scanArtifacts(ctx)
    assert.equal(s.registered, 12) // 10 docs + 2 code dirs

    const all = listArtifacts(ctx, {})
    const byPath = Object.fromEntries(all.map(a => [a.path, a]))

    // 元产物不入 scan(不在扫描根 + isMetaPath 双保险)
    assert.equal(byPath["docs/workbench/PLAN.md"], undefined)

    const pagePrd = byPath["docs/prd/pages/admin/land/list.md"]
    assert.equal(pagePrd.kind, "page-prd")
    assert.deepEqual([pagePrd.module, pagePrd.endpoint, pagePrd.page], ["land", "admin", "land/list"])

    const proto = byPath["docs/design/prototypes/admin/land/list.html"]
    assert.equal(proto.kind, "prototype")
    assert.equal(proto.page, "land/list")

    const codeService = byPath["service/src/modules/admin/land"]
    assert.equal(codeService.kind, "code")
    assert.deepEqual([codeService.module, codeService.endpoint], ["land", "service"])

    // {module} 目录名 landType → 归并为 land
    const codeAdmin = byPath["admin/src/pages/home/landType"]
    assert.equal(codeAdmin.module, "land")

    assert.equal(byPath[".claude/agents/developer.md"], undefined)
  })

  it("DAG 边按 parents 推导:module-prd→page-prd→design-prompt→prototype→code 链成立", () => {
    const edge = (fromPath: string, toPath: string) => {
      const row = ctx.db
        .prepare(
          `SELECT COUNT(*) c FROM artifact_edges e
           JOIN artifacts f ON f.id = e.from_id JOIN artifacts t ON t.id = e.to_id
           WHERE f.path = ? AND t.path = ?`
        )
        .get(fromPath, toPath) as { c: number }
      return row.c
    }
    assert.equal(edge("docs/prd/modules/land.md", "docs/prd/pages/admin/land/list.md"), 1)
    assert.equal(edge("docs/prd/flows/land.md", "docs/prd/modules/land.md"), 1)
    assert.equal(edge("docs/prd/pages/admin/land/list.md", "docs/design/prompts/admin/land/list.md"), 1)
    assert.equal(edge("docs/design/prompts/admin/land/list.md", "docs/design/prototypes/admin/land/list.html"), 1)
    assert.equal(edge("docs/design/prototypes/admin/land/list.html", "admin/src/pages/home/landType"), 1)
    assert.equal(edge("ARCHITECTURE.md", "service/src/modules/admin/land"), 1)
    // 设计系统 → 该端原型
    assert.equal(edge("docs/design/systems/admin.md", "docs/design/prototypes/admin/land/list.html"), 1)
  })

  it("幂等:重跑不重复登记不重复建边;内容变更计入 refreshed", () => {
    const again = scanArtifacts(ctx)
    assert.equal(again.registered, 0)
    assert.equal(again.edges, 0)
    writeFileSync(join(ctx.root, "docs/prd/modules/land.md"), "# land PRD v2")
    const third = scanArtifacts(ctx)
    assert.equal(third.refreshed, 1)
  })
})

describe("move / input 命令", () => {
  const ctx = makeProject()
  scanArtifacts(ctx)
  after(() => {
    ctx.db.close()
    rmSync(ctx.root, { recursive: true, force: true })
  })

  it("move 保 id 改 path,审批不断裂(内容未变 → 仍 approved)", () => {
    const before = approveArtifact(ctx, { path: "docs/prd/modules/land.md" }, "user")
    mkdirSync(join(ctx.root, "docs/prd/modules2"), { recursive: true })
    renameSync(join(ctx.root, "docs/prd/modules/land.md"), join(ctx.root, "docs/prd/modules2/land.md"))
    const moved = moveArtifact(ctx, { from: "docs/prd/modules/land.md", to: "docs/prd/modules2/land.md", actor: "user" })
    assert.equal(moved.id, before.id)
    assert.equal(moved.path, "docs/prd/modules2/land.md")
    assert.equal(reviewStatus(moved), "approved")
  })

  it("input 补充申报 → 进入 stale 监控", () => {
    const id = createTask(ctx, { module: "land", role: "architect", endpoint: "common", creator: "pm" })
    claimTask(ctx, { id, assignee: "architect" })
    // gate 之外的产物:设计系统不在 architect 依赖集,补充申报
    addTaskInput(ctx, { id, path: "docs/design/systems/admin.md", operator: "architect" })
    assert.equal(taskStaleness(ctx.db, id).stale, false)
    writeFileSync(join(ctx.root, "docs/design/systems/admin.md"), "# 设计系统 v2")
    refreshArtifact(ctx, { path: "docs/design/systems/admin.md" })
    const st = taskStaleness(ctx.db, id)
    assert.equal(st.stale, true)
    assert.ok(st.changed.some(c => c.path.includes("systems/admin.md")))
  })
})

describe("scan:坐标随 config 收敛(remap)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-remap-"))
  writeFileSync(join(root, "workbench.config.json"), "{}") // 初始无 moduleMapping
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/landType.md"), "# landType 模块 PRD")
  const ctx = openWorkbenchAt(root)
  const REL = "docs/prd/modules/landType.md"
  const getRow = () => ctx.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(REL) as any
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("事后加入 moduleMapping → 旧行重挂粗模块,审批不失效,幂等", () => {
    scanArtifacts(ctx)
    assert.equal(getRow().module, "landType") // 未映射,原样登记

    // 先审批,验证重挂不打回已批契约
    approveArtifact(ctx, { path: REL }, "user")
    assert.equal(reviewStatus(getRow()), "approved")

    // 事后加入归并规则,重扫
    ctx.config.moduleMapping = { landType: "land" }
    const s = scanArtifacts(ctx)
    assert.equal(s.remapped, 1)

    const row = getRow()
    assert.equal(row.module, "land") // 坐标已收敛到粗模块
    assert.equal(reviewStatus(row), "approved") // 内容 hash 未变 → 审批存活

    const ev = listEvents(ctx.db, { entityType: "artifact", entityId: row.id, event: "coords_remapped" })
    assert.equal(ev.length, 1)
    const payload = JSON.parse(ev[0].payload!)
    assert.equal(payload.from.module, "landType")
    assert.equal(payload.to.module, "land")

    // 幂等:坐标已相等 → 不再重挂
    assert.equal(scanArtifacts(ctx).remapped, 0)
  })
})

describe("scan:自定义 coords 文法(house 式嵌套 flow + endpoint 锚定护栏)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-coords-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      endpoints: ["admin", "app"], // 注意:pc 不在声明端里
      kinds: { flow: { coords: "{module}/{endpoint}" } } // house 有意:flow 按端拆分
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/flows/ad/admin.md", "# ad admin flow")
  write("docs/prd/flows/ad/app.md", "# ad app flow")
  write("docs/design/prototypes/admin/user/list.html", "<div>list</div>")
  write("docs/design/prototypes/admin/user/sub/detail.html", "<div>detail</div>") // 深层 page
  write("docs/design/prototypes/pc/contact.html", "<div>pc</div>") // pc 已删端,应被护栏丢弃
  const ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("嵌套 flow 按端落位;深层 page 支持;非声明端 pc 进 unresolved 不登记", () => {
    const s = scanArtifacts(ctx)
    const byPath = Object.fromEntries(listArtifacts(ctx, {}).map(a => [a.path, a]))

    // flow 覆盖为 {module}/{endpoint}:目录=模块、文件=端
    const fAdmin = byPath["docs/prd/flows/ad/admin.md"]
    assert.deepEqual([fAdmin.kind, fAdmin.module, fAdmin.endpoint], ["flow", "ad", "admin"])
    assert.deepEqual(
      [byPath["docs/prd/flows/ad/app.md"].module, byPath["docs/prd/flows/ad/app.md"].endpoint],
      ["ad", "app"]
    )

    // prototype 默认 {endpoint}/{module}/{page}
    const proto = byPath["docs/design/prototypes/admin/user/list.html"]
    assert.deepEqual([proto.endpoint, proto.module, proto.page], ["admin", "user", "user/list"])
    // {page} 贪婪吃尾 → 深层页面也能落位
    assert.equal(byPath["docs/design/prototypes/admin/user/sub/detail.html"].page, "user/sub/detail")

    // 首段 pc ∉ endpoints → 护栏丢弃,不 mis-file
    assert.equal(byPath["docs/design/prototypes/pc/contact.html"], undefined)
    assert.ok(s.unresolved.includes("docs/design/prototypes/pc/contact.html"))
  })
})

describe("deriveEdges 对账:残留 derived 边清理,manual 边永不动", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-edges-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/modules/goods.md", "# goods PRD")
  const ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("坐标漂移后残留的 derived 边被清理;手动边跨 scan 存活", () => {
    scanArtifacts(ctx)
    const id = (p: string) => (ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(p) as { id: number }).id
    const flow = id("docs/prd/flows/land.md")
    const land = id("docs/prd/modules/land.md")
    const goods = id("docs/prd/modules/goods.md")
    const count = (from: number, to: number) =>
      (ctx.db.prepare("SELECT COUNT(*) c FROM artifact_edges WHERE from_id = ? AND to_id = ?").get(from, to) as { c: number }).c

    assert.equal(count(flow, land), 1) // flow(land) → module-prd(land) 推导成立

    // 手动声明一条推导此刻不会给的边:goods PRD ← land flow
    ctx.db.prepare("INSERT INTO artifact_edges (from_id, to_id, source) VALUES (?, ?, 'manual')").run(flow, goods)

    // 制造坐标漂移:land 归并进 goods → flow 与 land 的 module-prd 重挂
    ctx.config.moduleMapping = { land: "goods" }
    const s = scanArtifacts(ctx)
    assert.ok(s.remapped >= 2)
    assert.equal(typeof s.edgesPruned, "number") // 字段存在

    // 对账后:新坐标下 flow(goods) 与两个 module-prd(都 goods)边成立
    assert.equal(count(flow, land), 1)
    // 手动边原样存活(即使推导现在也想要它,保持 manual)
    const manual = ctx.db.prepare("SELECT source FROM artifact_edges WHERE from_id = ? AND to_id = ?").get(flow, goods) as { source: string }
    assert.equal(manual.source, "manual")
    scanArtifacts(ctx)
    assert.equal(count(flow, goods), 1)
  })

  it("残留清理的直接验证:手工塞一条不可能推导的 derived 边,scan 后被删", () => {
    const flow = (ctx.db.prepare("SELECT id FROM artifacts WHERE path = 'docs/prd/flows/land.md'").get() as { id: number }).id
    // 自指边不可能被推导出来 → 必然是残留
    ctx.db.prepare("INSERT OR IGNORE INTO artifact_edges (from_id, to_id, source) VALUES (?, ?, 'derived')").run(flow, flow)
    const s = scanArtifacts(ctx)
    assert.ok(s.edgesPruned >= 1)
    const c = (ctx.db.prepare("SELECT COUNT(*) c FROM artifact_edges WHERE from_id = ? AND to_id = ?").get(flow, flow) as { c: number }).c
    assert.equal(c, 0)
  })
})

describe("scan 重命名检测:同 hash 唯一候选自动跟随(保 id 保审批)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-rename-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD v1")
  const ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("重命名文件 → 同 id、新路径、审批存活、auto_moved 留痕", () => {
    scanArtifacts(ctx)
    const before = ctx.db.prepare("SELECT * FROM artifacts WHERE path = 'docs/prd/modules/land.md'").get() as any
    approveArtifact(ctx, { id: before.id }, "user")

    renameSync(join(ctx.root, "docs/prd/modules/land.md"), join(ctx.root, "docs/prd/modules/estate.md"))
    const s = scanArtifacts(ctx)
    assert.equal(s.moved, 1)
    assert.equal(s.registered, 0) // 是跟随,不是新登记

    const moved = ctx.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(before.id) as any
    assert.equal(moved.path, "docs/prd/modules/estate.md")
    assert.equal(moved.module, "estate") // 坐标随新路径重解析
    assert.equal(reviewStatus(moved), "approved") // hash 未变 → 审批存活
    assert.equal(listEvents(ctx.db, { entityType: "artifact", entityId: before.id, event: "auto_moved" }).length, 1)
  })

  it("歧义(两个消失的同 hash 候选)→ 保守回退为新登记,不乱认", () => {
    mkdirSync(join(ctx.root, "docs/prd/flows"), { recursive: true })
    writeFileSync(join(ctx.root, "docs/prd/flows/a.md"), "same content")
    writeFileSync(join(ctx.root, "docs/prd/flows/b.md"), "same content")
    scanArtifacts(ctx)
    rmSync(join(ctx.root, "docs/prd/flows/a.md"))
    rmSync(join(ctx.root, "docs/prd/flows/b.md"))
    writeFileSync(join(ctx.root, "docs/prd/flows/c.md"), "same content")
    const s = scanArtifacts(ctx)
    assert.equal(s.moved, 0) // 两个候选,不认
    assert.equal(s.registered, 1) // c.md 走正常新登记
  })
})
