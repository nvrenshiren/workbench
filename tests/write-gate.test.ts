import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { after, describe, it } from "node:test"
import { approveArtifact, claimTask, createTask, openWorkbenchAt, registerOutput, type Ctx } from "../core/index"

/**
 * 写门禁 hook(scripts/hook-pretooluse.ts)。它靠 stdin 读入平台 hook JSON、
 * 靠退出码/输出与平台交互(enforce claude→exit 2、cursor→stdout deny JSON),
 * 故用真实子进程驱动 —— 这才验证到它与各平台的实际契约,而非内部函数。
 */
const REPO = join(import.meta.dirname, "..")
const HOOK = join(REPO, "scripts/hook-pretooluse.ts")
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href

const REL = "docs/prd/modules/land.md"

interface GateProject {
  root: string
  abs: string
  artifactId: number
  ctx: Ctx
}

const projects: Ctx[] = []
const roots: string[] = []

/** 建一个含 module-prd 契约的项目;approved=true 时批准它。 */
function makeGateProject(writeGate: "off" | "observe" | "enforce", approved = true): GateProject {
  const root = mkdtempSync(join(tmpdir(), "wb-gate-"))
  roots.push(root)
  writeFileSync(join(root, "workbench.config.json"), JSON.stringify({ gates: { writeGate } }))
  mkdirSync(join(root, "docs/prd/modules"), { recursive: true })
  writeFileSync(join(root, REL), "# land PRD")
  const ctx = openWorkbenchAt(root)
  projects.push(ctx)
  const { artifactId } = registerOutput(ctx, {
    module: "land",
    role: "product-manager",
    endpoint: "common",
    filePath: REL
  })
  if (approved) approveArtifact(ctx, { id: artifactId }, "user")
  return { root, abs: join(root, REL), artifactId, ctx }
}

/** 触发 hook:模拟平台把「即将编辑 abs 文件」的 JSON 从 stdin 送进来。 */
function runHook(root: string, opts: { platform?: string; taskId?: number; filePath: string }) {
  const env = { ...process.env, WORKBENCH_PROJECT: root } as Record<string, string>
  delete env.WORKBENCH_TASK_ID
  if (opts.taskId !== undefined) env.WORKBENCH_TASK_ID = String(opts.taskId)
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, HOOK, `--platform=${opts.platform ?? "claude"}`], {
    cwd: REPO, // 让 tsx/依赖可解析;项目根由 WORKBENCH_PROJECT 指定
    env,
    input: JSON.stringify({ tool_input: { file_path: opts.filePath } }),
    encoding: "utf-8"
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const wouldBlockCount = (ctx: Ctx) =>
  (ctx.db.prepare("SELECT COUNT(*) c FROM events WHERE event = 'would_block'").get() as { c: number }).c

describe("写门禁 hook:三档 writeGate × 通行证 × 契约判定", () => {
  after(() => {
    for (const ctx of projects) ctx.db.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it("off:不检查,放行,不留 would_block", () => {
    const p = makeGateProject("off")
    const r = runHook(p.root, { filePath: p.abs })
    assert.equal(r.status, 0)
    assert.equal(wouldBlockCount(p.ctx), 0)
  })

  it("observe:approved 契约被改 → 只记 would_block,永不拦(exit 0)", () => {
    const p = makeGateProject("observe")
    const r = runHook(p.root, { filePath: p.abs })
    assert.equal(r.status, 0)
    assert.equal(wouldBlockCount(p.ctx), 1)
  })

  it("enforce:approved 契约无通行证 → exit 2 + 可行动文案,并留 would_block", () => {
    const p = makeGateProject("enforce")
    const r = runHook(p.root, { filePath: p.abs })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /已审批契约/)
    assert.match(r.stderr, /WORKBENCH_TASK_ID/)
    assert.equal(wouldBlockCount(p.ctx), 1)
  })

  it("enforce + 合法通行证(已领取的未完成任务)→ 放行,不留 would_block", () => {
    const p = makeGateProject("enforce")
    const id = createTask(p.ctx, { module: "land", role: "architect", endpoint: "common", creator: "pm" })
    claimTask(p.ctx, { id, assignee: "architect" })
    const r = runHook(p.root, { filePath: p.abs, taskId: id })
    assert.equal(r.status, 0)
    assert.equal(wouldBlockCount(p.ctx), 0)
  })

  it("enforce:未 approved 的契约(draft)不拦 —— 门禁只守已批真相", () => {
    const p = makeGateProject("enforce", false) // 注册但不批准
    const r = runHook(p.root, { filePath: p.abs })
    assert.equal(r.status, 0)
    assert.equal(wouldBlockCount(p.ctx), 0)
  })

  it("cursor enforce:走 stdout 返回 deny 决策(exit 0),并留 would_block", () => {
    const p = makeGateProject("enforce")
    const r = runHook(p.root, { platform: "cursor", filePath: p.abs })
    assert.equal(r.status, 0)
    const decision = JSON.parse(r.stdout)
    assert.equal(decision.permission, "deny")
    assert.match(decision.agentMessage, /已审批契约/)
    assert.equal(wouldBlockCount(p.ctx), 1)
  })
})
