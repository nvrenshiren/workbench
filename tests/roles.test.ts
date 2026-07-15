import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { claimTask, createTask, getRoleRegistry, openWorkbenchAt, planModule, registerOutput, scanArtifacts, updateTask, type Ctx } from "../core/index"

describe("角色注册表:合并语义与 requires 规则化", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  const ctx: Ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("默认注册表编码现行为:developer 非 service 要求 api-doc;设计稿 service+common 均免(无 UI);service 只要 db-doc", () => {
    const reg = getRoleRegistry(ctx.config)
    const dev = reg.developer
    assert.deepEqual(dev.produces, ["code"])
    assert.equal(dev.requires!.filter(r => !r.when).length, 1) // db-doc 无条件
    assert.ok(dev.requires!.some(r => r.when?.endpointNot === "service" && r.kinds.includes("api-doc")))
    const designReq = dev.requires!.find(r => r.kinds.includes("design-prompt"))
    assert.deepEqual(designReq?.when?.endpointNotIn, ["service", "common"]) // common 纯计算包与 service 一同豁免
  })

  it("config.roleProduces 旧字段兼容:只覆盖 produces 维度", () => {
    ctx.config.roleProduces = { ...ctx.config.roleProduces, architect: ["code"] }
    const reg = getRoleRegistry(ctx.config)
    assert.deepEqual(reg.architect.produces, ["code"])
    assert.ok(reg.architect.requires!.length >= 1) // requires 等其他维度保留默认
    ctx.config.roleProduces = { ...ctx.config.roleProduces, architect: ["db-doc", "api-doc"] } // 还原
  })

  it("config.roles 可为自定义角色声明 requires:security-reviewer 要求 api-doc 存在", () => {
    ctx.config.roles = {
      "security-reviewer": {
        produces: ["doc"],
        requires: [{ desc: "API 契约", kinds: ["api-doc"] }]
      }
    }
    const id = createTask(ctx, { module: "land", role: "security-reviewer" as never, endpoint: "service", creator: "pm" })
    // api-doc 不存在 → exist 级阻断
    assert.throws(() => claimTask(ctx, { id, assignee: "security-reviewer" }), /API 契约.*不存在/)
  })

  it("未注册的角色 createTask 被拒(校验来自注册表键,而非静态清单)", () => {
    assert.throws(
      () => createTask(ctx, { module: "land", role: "nonexistent-role" as never, endpoint: "common", creator: "pm" }),
      /无效的角色/
    )
  })
})

describe("developer common 端豁免设计稿前置(纯计算共享包无 UI,回归 #99 死锁)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-common-dev-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("docs/prd/modules/engine.md", "# engine PRD")
  write("docs/architecture/database/engine.md", "# db")
  write("docs/architecture/api/common/engine.md", "# api")
  const ctx: Ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "engine", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/engine.md" })
  registerOutput(ctx, { module: "engine", role: "architect", endpoint: "common", filePath: "docs/architecture/database/engine.md" })
  registerOutput(ctx, { module: "engine", role: "architect", endpoint: "common", filePath: "docs/architecture/api/common/engine.md" })
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("common 端 developer:db-doc+api-doc 齐备即可领取,不因缺 designer 设计稿被拦", () => {
    const id = createTask(ctx, { module: "engine", role: "developer", endpoint: "common", creator: "pm" })
    // 修复前:common ∉ endpointNot:"service" 豁免 → 要求 designer common 设计稿(结构性不存在)→ 死锁
    assert.doesNotThrow(() => claimTask(ctx, { id, assignee: "developer" }))
  })

  it("豁免不外溢:同样缺设计稿,web 端 developer 仍被设计稿前置阻断", () => {
    write("docs/architecture/api/web/engine.md", "# api web")
    registerOutput(ctx, { module: "engine", role: "architect", endpoint: "web", filePath: "docs/architecture/api/web/engine.md" })
    const id = createTask(ctx, { module: "engine", role: "developer", endpoint: "web", page: "engine/list", creator: "pm" })
    assert.throws(() => claimTask(ctx, { id, assignee: "developer" }), /设计稿.*不存在/)
  })
})

describe("producedKinds 形态匹配:产出分裂由注册表 dispatch.produces 承载(不再锁死 designer)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-shape-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      roles: {
        author: {
          produces: ["module-prd"],
          dispatch: [{ at: "page", produces: ["acceptance"], content: "写 {endpoint}/{page} 验收" }]
        }
      }
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("page 任务产出义务=acceptance;无 page 任务=module-prd——同一角色两形态分裂", () => {
    // 预先登记 acceptance(page 坐标),不登记 module-prd
    write("docs/acceptance/admin/land/list.md", "# 验收用例")
    registerOutput(ctx, { module: "land", role: "author" as never, endpoint: "admin", page: "land/list", filePath: "docs/acceptance/admin/land/list.md" })

    const pageTask = createTask(ctx, { module: "land", role: "author" as never, endpoint: "admin", page: "land/list", creator: "pm" })
    claimTask(ctx, { id: pageTask, assignee: "author" })
    const { warnings } = updateTask(ctx, { id: pageTask, status: "completed", operator: "author", force: true })
    assert.ok(Array.isArray(warnings)) // acceptance 已在 → page 形态放行

    const moduleTask = createTask(ctx, { module: "land", role: "author" as never, endpoint: "admin", creator: "pm" })
    claimTask(ctx, { id: moduleTask, assignee: "author" })
    // module-prd 不存在 → 无 page 形态的产出义务阻断(修复前 producedKinds 读不到自定义角色,义务为空不拦)
    assert.throws(() => updateTask(ctx, { id: moduleTask, status: "completed", operator: "author", force: true }), /必须添加产出文件/)

    write("docs/prd/modules/land.md", "# land PRD")
    registerOutput(ctx, { module: "land", role: "author" as never, endpoint: "common", filePath: "docs/prd/modules/land.md" })
    const r2 = updateTask(ctx, { id: moduleTask, status: "completed", operator: "author", force: true })
    assert.ok(Array.isArray(r2.warnings))
  })
})

describe("plan 派发由注册表 dispatch 物化:自定义角色纯 config 进流水线", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-plan-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      pipeline: ["product-manager", "architect", "designer", "developer", "security-reviewer", "qa"],
      roles: {
        "security-reviewer": {
          produces: ["doc"],
          dispatch: [{ at: "page", content: "安审 {endpoint}/{page}" }]
        }
      }
    })
  )
  const write = (rel: string, content: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  write("ARCHITECTURE.md", "# baseline")
  write("docs/prd/project.md", "# 项目")
  write("docs/prd/flows/land.md", "# flow")
  write("docs/prd/modules/land.md", "# land PRD")
  write("docs/prd/pages/admin/land/list.md", "# 列表页 PRD")
  write("docs/architecture/database/land.md", "# db")
  write("docs/architecture/api/admin/land.md", "# api")
  const ctx: Ctx = openWorkbenchAt(root)
  scanArtifacts(ctx)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("默认拓扑保持(7)+ 自定义角色逐页任务(+1),content 模板插值", () => {
    const s = planModule(ctx, "land")
    // 默认:architect×2 + dev service + 设计系统(admin) + 页×(designer+developer+qa)=3 → 7;+security-reviewer 1 → 8
    assert.equal(s.created.length, 8)
    const sec = s.created.find(t => t.role === ("security-reviewer" as never))
    assert.ok(sec, "自定义角色未被派发")
    assert.equal(sec!.page, "land/list")
    const row = ctx.db.prepare("SELECT content FROM tasks WHERE id = ?").get(sec!.id) as { content: string }
    assert.equal(row.content, "安审 admin/land/list")
    // 幂等
    assert.equal(planModule(ctx, "land").created.length, 0)
  })
})

describe("QA 闭环角色注册表化:rework 接锅方与复验角色由 produces 反查", () => {
  it("ownerRoleOf:code→developer(兜底)、acceptance→qa、自定义 produces 反查", async () => {
    const { ownerRoleOf } = await import("../core/roles")
    const cfg = JSON.parse(JSON.stringify({}))
    const base = { ...((await import("../core/config")).loadConfig("/nonexistent-x")) }
    assert.equal(ownerRoleOf(base, "code"), "developer")
    assert.equal(ownerRoleOf(base, "acceptance"), "qa")
    assert.equal(ownerRoleOf({ ...base, roles: { verifier: { produces: ["acceptance"] } } } as never, "acceptance"), "qa") // 默认 qa 先命中(遍历序)
    void cfg
  })
})

describe("B4 端到端:自定义角色 = config + 项目模板,零引擎代码", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-roles-e2e-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      pipeline: ["product-manager", "architect", "designer", "developer", "security-reviewer", "qa"],
      roles: { "security-reviewer": { produces: ["doc"], dispatch: [{ at: "page", content: "安审 {endpoint}/{page}" }] } }
    })
  )
  // 项目级模板目录:自定义角色的"函数体"
  mkdirSync(join(root, "docs/workbench/templates/agents/zh"), { recursive: true })
  writeFileSync(
    join(root, "docs/workbench/templates/agents/zh/security-reviewer.md"),
    "---\nname: security-reviewer\ndescription: 安全审查页面实现\ntools: Read, Grep\n---\n\n# 安全审查员\n\n检查注入与越权。\n"
  )
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("genAgents:内置角色走内置模板,自定义角色走项目模板,共 6 份", async () => {
    const { genAgents } = await import("../core/index")
    const { written } = genAgents(ctx)
    assert.equal(written.length, 6)
    const sec = readFileSync(join(root, ".claude/agents/security-reviewer.md"), "utf-8")
    assert.ok(sec.includes("安全审查员"))
    assert.ok(sec.includes("name: security-reviewer"))
    const dev = readFileSync(join(root, ".claude/agents/developer.md"), "utf-8")
    assert.ok(dev.includes("信任协议")) // 内置模板照常
  })

  it("pipeline 里缺模板的自定义角色 → 可行动报错", async () => {
    const { genAgents } = await import("../core/index")
    ctx.config.pipeline = [...ctx.config.pipeline, "ghost-role"]
    ctx.config.roles = { ...ctx.config.roles, "ghost-role": { produces: ["doc"] } }
    assert.throws(() => genAgents(ctx), /ghost-role.*模板/)
    ctx.config.pipeline = ctx.config.pipeline.filter(r => r !== "ghost-role")
  })
})

describe("onQaFail 接线:rework 是否派发由 code 归属角色的注册表声明决定", () => {
  const mk = (rolesJson: object) => {
    const root = mkdtempSync(join(tmpdir(), "wb-onqafail-"))
    writeFileSync(join(root, "workbench.config.json"), JSON.stringify(rolesJson))
    const ctx = openWorkbenchAt(root)
    // 直插一条已领取的 qa 任务(绕开 claim 前置,聚焦 fail 分支)
    const id = ctx.db
      .prepare("INSERT INTO tasks (module, role, endpoint, type, status, assignee, creator) VALUES ('m','qa','admin','qa','in_progress','qa','pm')")
      .run().lastInsertRowid as number
    return { root, ctx, id }
  }

  it("默认注册表:developer.onQaFail=rework → fail 照常派返工(行为锚点)", async () => {
    const { recordQaResult } = await import("../core/index")
    const { root, ctx, id } = mk({})
    const r = recordQaResult(ctx, { id, result: "fail", reason: "分页坏了", operator: "qa" })
    assert.ok(r.reworkTaskId)
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("code 归属角色未声明 onQaFail → fail 只留痕,不派返工", async () => {
    const { recordQaResult } = await import("../core/index")
    // fixer 接管 code 且未声明 onQaFail;developer 让出 code
    const { root, ctx, id } = mk({ roleProduces: { developer: [] }, roles: { fixer: { produces: ["code"] } } })
    const r = recordQaResult(ctx, { id, result: "fail", reason: "分页坏了", operator: "qa" })
    assert.equal(r.reworkTaskId, null) // 修复前:硬派 rework,无视注册表声明
    const c = (ctx.db.prepare("SELECT COUNT(*) c FROM tasks WHERE type = 'rework'").get() as { c: number }).c
    assert.equal(c, 0)
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })
})

describe("B4 免领取完成注册表化 + 未领取任务的 operator 授权收紧", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-nwc-"))
  writeFileSync(join(root, "workbench.config.json"), JSON.stringify({ roles: { ghost: { produces: ["doc"] }, opener: { produces: ["doc"], completeWithoutClaim: true } } }))
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  mkdirSync(join(root, "notes"), { recursive: true })
  writeFileSync(join(root, "notes/memo.md"), "# memo")
  const ctx: Ctx = openWorkbenchAt(root)
  registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })
  registerOutput(ctx, { module: "land", role: "opener" as never, endpoint: "common", filePath: "notes/memo.md" })
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("授权漏洞收口:未领取的 PM 任务,任意 operator 不再能完成;角色本人/创建者可以", () => {
    const id = createTask(ctx, { module: "land", role: "product-manager", endpoint: "common", creator: "pm-creator" })
    assert.throws(() => updateTask(ctx, { id, status: "completed", operator: "stranger" }), /仅创建者或角色本人/)
    const { warnings } = updateTask(ctx, { id, status: "completed", operator: "product-manager" })
    assert.ok(Array.isArray(warnings))
  })

  it("免领取完成是注册表能力:未声明的自定义角色仍被拦,声明后创建者可直接完成", () => {
    const g = createTask(ctx, { module: "land", role: "ghost" as never, endpoint: "common", creator: "pm-creator" })
    assert.throws(() => updateTask(ctx, { id: g, status: "completed", operator: "pm-creator" }), /尚未被领取/)

    const o = createTask(ctx, { module: "land", role: "opener" as never, endpoint: "common", creator: "pm-creator" })
    const { warnings } = updateTask(ctx, { id: o, status: "completed", operator: "pm-creator" })
    assert.ok(Array.isArray(warnings))
  })
})
