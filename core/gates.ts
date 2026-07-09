import { execSync } from "node:child_process"
import { moduleCleared, prototypeEndorsed, reviewStatus, taskStaleness } from "./derive"
import { PM_KINDS, getKindRegistry, kindSpec, type KindLevel } from "./kind"
import { runProtocolLints } from "./lints"
import type { ArtifactKind, ArtifactRow, Ctx, TaskRow } from "./types"

export interface GateResult {
  warnings: string[]
  /** claim 校验时匹配到的上游产物,用于 task_inputs 快照(已按 drivesStale 过滤) */
  inputs: ArtifactRow[]
}

interface ArtifactFilter {
  module?: string | null
  endpoint?: string | null
  page?: string | null
}

function findByKinds(ctx: Ctx, kinds: ArtifactKind[], f: ArtifactFilter): ArtifactRow[] {
  if (kinds.length === 0) return []
  let query = `SELECT * FROM artifacts WHERE kind IN (${kinds.map(() => "?").join(",")})`
  const params: (string | number)[] = [...kinds]
  if (f.module) {
    query += " AND module = ?"
    params.push(f.module)
  }
  if (f.endpoint) {
    query += " AND endpoint = ?"
    params.push(f.endpoint)
  }
  if (f.page) {
    query += " AND page = ?"
    params.push(f.page)
  }
  return ctx.db.prepare(query).all(...params) as ArtifactRow[]
}

/** 按上游 kind 的坐标层级生成过滤器(project 级无过滤,module/endpoint/page 逐层收紧) */
function levelFilter(level: KindLevel, task: TaskRow): ArtifactFilter {
  switch (level) {
    case "project":
      return {}
    case "module":
      return { module: task.module }
    case "endpoint":
      return { endpoint: task.endpoint }
    case "page":
      return { module: task.module, endpoint: task.endpoint, page: task.page }
  }
}

interface Requirement {
  desc: string
  /** exist:缺失即阻断(与旧 CLI 行为等价);approved:未达信任状态按 approvalMode 处理 */
  level: "exist" | "approved"
  kinds: ArtifactKind[]
  filter: ArtifactFilter
}

/** 该任务产出哪些 kind(gate 上游选择器的起点;designer 按任务形态分流) */
function producedKinds(ctx: Ctx, task: TaskRow): ArtifactKind[] {
  const declared = (ctx.config.roleProduces[task.role] ?? []) as ArtifactKind[]
  if (task.role === "designer") {
    return task.page ? declared.filter(k => k !== "design-system") : ["design-system"]
  }
  return declared
}

/** exist 级要求:旧 CLI 行为等价的保守下限,保证存量流程不被 approved 级噪音阻断 */
function existRequirements(task: TaskRow): Requirement[] {
  const m = task.module
  switch (task.role) {
    case "architect":
    case "designer":
      return [{ desc: "PM 产出(模块/页面 PRD)", level: "exist", kinds: PM_KINDS, filter: { module: m } }]
    case "developer": {
      if (task.endpoint === "service") {
        return [{ desc: "数据库文档", level: "exist", kinds: ["db-doc"], filter: { module: m } }]
      }
      return [
        { desc: "数据库文档", level: "exist", kinds: ["db-doc"], filter: { module: m } },
        { desc: "API 文档", level: "exist", kinds: ["api-doc"], filter: { module: m } },
        { desc: `designer ${task.endpoint} 设计稿`, level: "exist", kinds: ["design-prompt", "prototype"], filter: { module: m, endpoint: task.endpoint } }
      ]
    }
    default:
      return []
  }
}

/**
 * approved 级要求:由注册表派生——该角色产出 kind 的 parents 即其上游契约。
 * 规则:排除自产 kind;approval=none/machine 的上游不设审批要求;
 * page 级上游在无 page 坐标的任务上跳过(如 service 端 developer 不要求原型)。
 */
function approvedRequirements(ctx: Ctx, task: TaskRow): Requirement[] {
  const registry = getKindRegistry(ctx.config)
  const produced = producedKinds(ctx, task)
  const parentSet = new Set<ArtifactKind>()
  for (const kind of produced) {
    for (const parent of registry[kind]?.parents ?? []) {
      if (!produced.includes(parent)) parentSet.add(parent)
    }
  }

  const reqs: Requirement[] = []
  for (const parent of parentSet) {
    const spec = registry[parent]
    if (!spec || spec.approval === "none" || spec.approval === "machine") continue
    if (spec.level === "page" && !task.page) continue
    if (spec.level === "endpoint" && !task.endpoint) continue
    if (spec.level === "module" && !task.module) continue
    reqs.push({
      desc: `上游 ${parent} 已达信任状态(${spec.approval === "thumbs" ? "👍 放行" : "approved"})`,
      level: "approved",
      kinds: [parent],
      filter: levelFilter(spec.level, task)
    })
  }
  return reqs
}

function claimRequirements(ctx: Ctx, task: TaskRow): Requirement[] {
  if (task.type !== "build" && task.type !== "qa") return []
  if (task.role === "product-manager") return []
  return [...existRequirements(task), ...approvedRequirements(ctx, task)]
}

/** approved 级满足判定:按注册表 approval 通道分发(thumbs → 👍,human → 审批四态) */
function requirementSatisfied(ctx: Ctx, req: Requirement, matched: ArtifactRow[]): boolean {
  if (req.level === "exist") return matched.length > 0
  if (matched.length === 0) return false
  return matched.some(a =>
    kindSpec(ctx.config, a.kind).approval === "thumbs" ? prototypeEndorsed(ctx.db, a) : reviewStatus(a) === "approved"
  )
}

/**
 * claim 校验。exist 级缺失抛错阻断;approved 级不满足时,
 * approvalMode=warn 记 warning,enforce 抛错。
 * task_inputs 快照 = 匹配产物 ∪ baseline,按注册表 drivesStale 过滤。
 */
export function validateClaim(ctx: Ctx, task: TaskRow): GateResult {
  const warnings: string[] = []
  const inputs = new Map<number, ArtifactRow>()
  const mode = ctx.config.gates.approvalMode

  // qa 任务:要求对应 developer 任务已完成
  if (task.role === "qa" && task.type === "qa") {
    const dev = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE role = 'developer' AND status = 'completed' AND module IS ? AND endpoint IS ?
           AND (? IS NULL OR page IS ?)`
      )
      .get(task.module, task.endpoint, task.page, task.page) as { c: number }
    if (dev.c === 0) {
      throw new Error(`[前置条件] 对应的 developer ${task.endpoint} 任务尚未完成,无法领取 qa 任务。`)
    }
  }

  // 懒清算提示:触碰未清算模块 → 建议先对账(不硬阻断,清算成本按需支付)
  if (task.module && (task.type === "build" || task.type === "hotfix") && !moduleCleared(ctx.db, task.module)) {
    warnings.push(
      `[清算] 模块 ${task.module} 未清算(module-prd 未审批)。建议先对账:${ctx.config.cli} audit --module=${task.module}`
    )
  }

  for (const req of claimRequirements(ctx, task)) {
    const matched = findByKinds(ctx, req.kinds, req.filter)
    for (const a of matched) {
      if (kindSpec(ctx.config, a.kind).drivesStale) inputs.set(a.id, a)
    }
    if (requirementSatisfied(ctx, req, matched)) continue

    if (req.level === "exist") {
      throw new Error(`[前置条件] ${req.desc} 不存在,无法领取任务。`)
    }
    const msg = `[信任警告] ${req.desc}:未满足`
    if (mode === "enforce") throw new Error(`[前置条件] ${msg}`)
    warnings.push(msg)
  }

  // 基线永远进入输入快照(它是所有产物的上游)
  for (const b of findByKinds(ctx, ["baseline"], {})) inputs.set(b.id, b)

  return { warnings, inputs: [...inputs.values()] }
}

/** 各角色完成任务时,旧式产出匹配(兼容未经 task 外键关联的 legacy 产出) */
function completeOutputRequirement(ctx: Ctx, task: TaskRow): Requirement | null {
  if (task.role === "developer" || task.role === "qa") return null
  const kinds = producedKinds(ctx, task)
  if (kinds.length === 0) return null
  const spec = kindSpec(ctx.config, kinds[0])
  return { desc: `${task.role} 产出`, level: "exist", kinds, filter: levelFilter(spec.level === "page" && !task.page ? "module" : spec.level, task) }
}

/** complete 校验:stale 拦截 + 产出义务 + (可选)机器检查 */
export function validateComplete(
  ctx: Ctx,
  task: TaskRow,
  status: string,
  opts: { force?: boolean } = {}
): GateResult {
  const warnings: string[] = []
  if (status !== "completed") return { warnings, inputs: [] }

  if (task.role !== "product-manager" && task.assignee === null) {
    throw new Error(`任务尚未被领取,无法更新状态`)
  }

  if (task.type === "legacy") return { warnings, inputs: [] }

  // stale 拦截:执行中途上游变更 → 默认拦截,--force 放行并留痕
  const staleness = taskStaleness(ctx.db, task.id)
  if (staleness.stale) {
    const detail = staleness.changed.map(c => c.path).join(", ")
    if (!opts.force) {
      throw new Error(`[前置条件] 任务已 stale(上游变更: ${detail})。请先对齐变更,或 --force=true 放行(留痕)。`)
    }
    warnings.push(`[强制放行] 忽略 stale 上游: ${detail}`)
  }

  // 产出义务:优先看 task_outputs 外键,兼容旧式坐标匹配
  const req = completeOutputRequirement(ctx, task)
  if (req) {
    const linked = ctx.db.prepare("SELECT COUNT(*) AS c FROM task_outputs WHERE task_id = ?").get(task.id) as { c: number }
    if (linked.c === 0) {
      const matched = findByKinds(ctx, req.kinds, req.filter)
      if (matched.length === 0) {
        throw new Error(`[前置条件] ${task.role} 任务必须添加产出文件后才能标记为完成。`)
      }
    }
  }

  // designer:原型 👍 放行(approved 级,通道由注册表声明)
  if (task.role === "designer" && task.type === "build" && task.page) {
    const prototypes = findByKinds(ctx, ["prototype"], { module: task.module, endpoint: task.endpoint, page: task.page })
    const endorsed = prototypes.some(p => prototypeEndorsed(ctx.db, p))
    if (!endorsed) {
      const msg = "[信任警告] 原型尚未获得 👍 放行"
      if (ctx.config.gates.approvalMode === "enforce") throw new Error(`[前置条件] ${msg}`)
      warnings.push(msg)
    }
  }

  // 协议 lint:角色/端过滤交给 runProtocolLints 自己(rule.role 缺省即 developer),
  // 不再在外层限定角色白名单——此前 role:qa/designer 等配置项会被这里静默吞掉,永不生效
  const violations = runProtocolLints(ctx, { role: task.role, endpoint: task.endpoint })
  if (violations.length > 0) {
    const detail = violations
      .slice(0, 10)
      .map(v => `  ${v.file}:${v.line} [${v.lint}] ${v.message}\n    ${v.text}`)
      .join("\n")
    throw new Error(
      `[协议 lint 失败] ${violations.length} 处违例,修复后再完成:\n${detail}${violations.length > 10 ? `\n  ...等 ${violations.length} 处` : ""}`
    )
  }

  // 机器检查(config 开启时):按产出 kind 的审批通道推导,不再硬编码角色——
  // 默认只有 developer 产出 code(approval:"machine"),行为不变;
  // 若项目把某个 kind 的 approval 配成 machine 并分给别的角色产出,同样会过这关
  const producesMachineKind = producedKinds(ctx, task).some(k => kindSpec(ctx.config, k).approval === "machine")
  if (producesMachineKind && task.endpoint && ctx.config.machineChecks.enabled) {
    const cmds = ctx.config.machineChecks[task.endpoint]
    if (Array.isArray(cmds)) {
      for (const cmd of cmds) {
        try {
          execSync(cmd, { cwd: ctx.root, stdio: "pipe" })
        } catch (err) {
          const e = err as { stdout?: Buffer; stderr?: Buffer }
          const detail = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-2000) || String(err)
          throw new Error(`[机器检查失败] ${cmd}\n${detail}`)
        }
      }
    }
  }

  return { warnings, inputs: [] }
}
