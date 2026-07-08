import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  claimTask,
  initProject,
  listTasks,
  planModule,
  registerOutput,
  scanArtifacts,
  updateTask,
  type Ctx
} from "../core/index"
import { buildMcpServer } from "../server/mcp"

describe("M7 异构 dry-run:纯后端项目(通用性唯一可信测试)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-m7-"))
  let ctx: Ctx
  after(() => {
    ctx?.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("init:空目录引导出无 designer 的流水线与 agent 集", () => {
    const r = initProject(root, { endpoints: ["service"], gitHooks: false })
    ctx = r.ctx
    assert.deepEqual(ctx.config.pipeline, ["product-manager", "architect", "developer", "qa"])
    // designer 不生成;PLAN 不存在也不注册
    assert.equal(existsSync(join(root, ".claude/agents/developer.md")), true)
    assert.equal(existsSync(join(root, ".claude/agents/designer.md")), false)
    assert.throws(() => initProject(root, { endpoints: ["service"] }), /已存在/) // 幂等防覆盖
  })

  it("scan→plan→claim→complete 全链在纯后端坐标系下工作", () => {
    const write = (rel: string, content: string) => {
      mkdirSync(join(root, rel, ".."), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    write("docs/prd/flows/billing.md", "# flow")
    write("docs/prd/modules/billing.md", "# billing PRD")
    write("docs/architecture/database/billing.md", "# db")
    write("docs/architecture/api/base/billing.md", "# api take/skip")
    scanArtifacts(ctx)

    const s = planModule(ctx, "billing")
    // 无 designer/qa 页面任务(无 page-prd);architect×2 + developer service = 3
    assert.equal(s.created.length, 3)
    assert.ok(s.created.every(t => t.role !== "designer"))

    const dev = listTasks(ctx, { role: "developer", status: "pending" })[0]
    claimTask(ctx, { id: dev.id, assignee: "developer" })
    const { warnings } = updateTask(ctx, { id: dev.id, status: "completed", operator: "developer", force: true })
    assert.ok(Array.isArray(warnings))
  })
})

describe("init:根 package.json 补 tsx devDep", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-tsx-"))
  let ctx: Ctx
  after(() => {
    ctx?.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("有 package.json 但缺 tsx → 补 ^4,不丢原有 devDep", () => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { typescript: "^5" } }, null, 2) + "\n"
    )
    const r = initProject(root, {
      endpoints: ["service"],
      gitHooks: false,
      mcp: false,
      preset: false
    })
    ctx = r.ctx
    assert.equal(r.rootTsxAdded, true)
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
    assert.equal(pkg.devDependencies.tsx, "^4")
    assert.equal(pkg.devDependencies.typescript, "^5")
  })
})

describe("init:裸项目从 preset 落地最小 package.json(含 tsx)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-pkg-"))
  let ctx: Ctx
  after(() => {
    ctx?.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("无 package.json → preset 部署含 tsx 的最小 package.json,ensureRootTsx 不再重复补", () => {
    assert.equal(existsSync(join(root, "package.json")), false)
    const r = initProject(root, { endpoints: ["service"], gitHooks: false, mcp: false })
    ctx = r.ctx
    assert.equal(existsSync(join(root, "package.json")), true)
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
    assert.equal(pkg.devDependencies.tsx, "^4")
    assert.equal(pkg.private, true)
    assert.equal(r.rootTsxAdded, false) // preset 已带 tsx,无需再补
    assert.ok(r.preset.includes("package.json"))
  })
})

describe("M7 MCP 端点(InMemoryTransport 全握手)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-mcp-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, "docs/prd/modules/land.md"), "# land PRD")
  let ctx: Ctx
  after(() => {
    ctx?.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("tools/list 暴露 wb_* 工具集且不含审批(人的动作不给 AI)", async () => {
    const { openWorkbenchAt } = await import("../core/db")
    ctx = openWorkbenchAt(root)
    registerOutput(ctx, { module: "land", role: "product-manager", endpoint: "common", filePath: "docs/prd/modules/land.md" })

    const server = buildMcpServer(ctx)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0.0.0" })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const expected of ["wb_list_tasks", "wb_claim", "wb_update_status", "wb_output", "wb_submit", "wb_feedback", "wb_dispute", "wb_plan", "wb_sync", "wb_audit", "wb_qa"]) {
      assert.ok(names.includes(expected), `缺工具: ${expected}`)
    }
    assert.ok(!names.some(n => n.includes("approve") || n.includes("reject")), "审批不得暴露给 AI")

    // 实调一个工具:与 CLI 同源同事务
    const result = await client.callTool({ name: "wb_audit", arguments: { module: "land" } })
    const text = (result.content as { type: string; text: string }[])[0].text
    const report = JSON.parse(text)
    assert.equal(report.module, "land")
    assert.equal(report.cleared, false)
    await client.close()
    await server.close()
  })
})
