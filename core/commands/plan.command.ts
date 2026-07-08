import { reviewStatus } from "../derive"
import { logEvent } from "../events"
import { normalizeModule } from "../kind"
import type { ArtifactRow, Ctx, Role, TaskType } from "../types"
import { createTask } from "./task.commands"

export interface PlanSummary {
  created: { id: number; role: Role; endpoint: string | null; page: string | null; type: TaskType }[]
  skipped: number
  cancelled: number
  warnings: string[]
}

interface DesiredTask {
  role: Role
  endpoint: string | null
  page: string | null
  type: TaskType
  assignee: string
  content: string
}

/**
 * plan 派发(纯函数,幂等):
 * - 真相源 = 已登记的 page-prd 产物(不解析 frontmatter,产物即事实)
 * - 每个已存在的等价任务(坐标+角色+类型,状态非 cancelled)跳过
 * - cancel 语义:PRD 中已删除的页面,其 pending 的 build/qa 任务自动取消
 * - 双契约与 flow/module-prd 审批按 approvalMode 出警告(warn)或阻断(enforce)
 */
export function planModule(ctx: Ctx, moduleRaw: string, creator = "product-manager"): PlanSummary {
  const module = normalizeModule(moduleRaw, ctx.config)!
  const summary: PlanSummary = { created: [], skipped: 0, cancelled: 0, warnings: [] }

  const artifacts = ctx.db.prepare("SELECT * FROM artifacts WHERE module IS ? OR module IS NULL").all(module) as ArtifactRow[]
  const byKind = (kind: string) => artifacts.filter(a => a.kind === kind && a.module === module)
  const projectLevel = (kind: string) => artifacts.filter(a => a.kind === kind && a.module === null)

  const modulePrd = byKind("module-prd")
  if (modulePrd.length === 0) {
    throw new Error(`[前置条件] 模块 ${module} 没有登记 module-prd,PM 先产出并登记后才能派发`)
  }

  // 双契约 + 逐层审批检查
  const trustChecks: { desc: string; rows: ArtifactRow[] }[] = [
    { desc: "技术基线(baseline)", rows: projectLevel("baseline") },
    { desc: "项目全景(project)", rows: projectLevel("project") },
    { desc: `flow(${module})`, rows: byKind("flow") },
    { desc: `模块 PRD(${module})`, rows: modulePrd }
  ]
  for (const check of trustChecks) {
    const ok = check.rows.some(r => reviewStatus(r) === "approved")
    if (ok) continue
    const msg = `[信任警告] ${check.desc} 未达 approved`
    if (ctx.config.gates.approvalMode === "enforce") throw new Error(`[前置条件] ${msg}`)
    summary.warnings.push(msg)
  }

  // 期望任务集
  const pagePrds = byKind("page-prd").filter(a => a.endpoint && a.page)
  const endpoints = [...new Set(pagePrds.map(a => a.endpoint!))]
  const desired: DesiredTask[] = [
    { role: "architect", endpoint: "common", page: null, type: "build", assignee: "architect", content: `设计 ${module} 模块数据库` },
    { role: "architect", endpoint: "service", page: null, type: "build", assignee: "architect", content: `设计 ${module} 模块 API 文档` },
    { role: "developer", endpoint: "service", page: null, type: "build", assignee: "developer", content: `实现 ${module} 模块 service 端` }
  ]
  for (const endpoint of endpoints) {
    const hasDesignSystem = artifacts.some(a => a.kind === "design-system" && a.endpoint === endpoint)
    if (!hasDesignSystem) {
      desired.push({
        role: "designer",
        endpoint,
        page: null,
        type: "build",
        assignee: "designer",
        content: `建立 ${endpoint} 端设计系统(该端首个页面设计前置)`
      })
    }
  }
  for (const prd of pagePrds) {
    desired.push(
      { role: "designer", endpoint: prd.endpoint, page: prd.page, type: "build", assignee: "designer", content: `设计 ${prd.endpoint}/${prd.page} 页面(提示词+原型)` },
      { role: "developer", endpoint: prd.endpoint, page: prd.page, type: "build", assignee: "developer", content: `实现 ${prd.endpoint}/${prd.page} 页面` },
      { role: "qa", endpoint: prd.endpoint, page: prd.page, type: "qa", assignee: "qa", content: `验收 ${prd.endpoint}/${prd.page} 页面` }
    )
  }

  // 异构项目支持:不在 pipeline 里的角色不生成任务(纯后端项目无 designer;qa 在 pipeline,但无 page-prd 时不产生页面 qa 任务)
  const activeRoles = new Set(ctx.config.pipeline)
  const filtered = desired.filter(d => activeRoles.has(d.role))
  desired.length = 0
  desired.push(...filtered)

  // 幂等:等价任务已存在(非 cancelled)则跳过
  const exists = ctx.db.prepare(
    `SELECT COUNT(*) AS c FROM tasks
     WHERE module IS ? AND role = ? AND endpoint IS ? AND page IS ? AND type = ? AND status != 'cancelled'`
  )
  for (const d of desired) {
    const row = exists.get(module, d.role, d.endpoint, d.page, d.type) as { c: number }
    if (row.c > 0) {
      summary.skipped++
      continue
    }
    const id = createTask(ctx, { module, role: d.role, endpoint: d.endpoint, page: d.page, type: d.type, assignee: d.assignee, creator, content: d.content })
    summary.created.push({ id, role: d.role, endpoint: d.endpoint, page: d.page, type: d.type })
  }

  // cancel 语义:page 级 pending 任务,其 page-prd 已不存在 → 取消
  const validPages = new Set(pagePrds.map(p => `${p.endpoint}|${p.page}`))
  const pending = ctx.db
    .prepare(
      `SELECT id, role, endpoint, page FROM tasks
       WHERE module IS ? AND status = 'pending' AND page IS NOT NULL AND type IN ('build', 'qa')`
    )
    .all(module) as { id: number; role: Role; endpoint: string | null; page: string }[]
  for (const t of pending) {
    if (validPages.has(`${t.endpoint}|${t.page}`)) continue
    const tx = ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(t.id)
      logEvent(ctx.db, {
        entityType: "task",
        entityId: t.id,
        event: "plan_cancelled",
        actor: creator,
        payload: { reason: "页面 PRD 已删除" },
        module,
        endpoint: t.endpoint,
        page: t.page
      })
    })
    tx()
    summary.cancelled++
  }

  return summary
}
