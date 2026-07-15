import { execSync } from "node:child_process"
import { moduleCleared, prototypeEndorsed, reviewStatus, taskStaleness } from "./derive"
import { getKindRegistry, kindSpec, type KindLevel } from "./kind"
import { runProtocolLints } from "./lints"
import { getRoleRegistry } from "./roles"
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

/**
 * 该任务产出哪些 kind(gate 上游选择器的起点):
 * 按注册表 dispatch 形态匹配——page 任务对 at:"page" 规则、无 page 任务对 at:"module"/"endpoint" 规则,
 * 命中带 produces 覆盖的规则则用之,否则回落 role.produces。
 * designer 的 page/端级产出分裂由默认注册表的 dispatch.produces 承载,不再是引擎特例。
 */
function producedKinds(ctx: Ctx, task: TaskRow): ArtifactKind[] {
  const spec = getRoleRegistry(ctx.config)[task.role]
  if (!spec) return []
  const wantPage = !!task.page
  const rule = (spec.dispatch ?? []).find(d => (wantPage ? d.at === "page" : d.at !== "page") && d.produces)
  return rule?.produces ?? spec.produces
}

/**
 * exist 级要求:由角色注册表 requires 派生(封闭 when 谓词:endpoint / endpointNot)。
 * 保守下限语义不变——保证存量流程不被 approved 级噪音阻断;默认注册表逐字节编码旧 switch。
 */
function existRequirements(ctx: Ctx, task: TaskRow): Requirement[] {
  const spec = getRoleRegistry(ctx.config)[task.role]
  const reqs: Requirement[] = []
  for (const r of spec?.requires ?? []) {
    if (r.when?.endpoint && task.endpoint !== r.when.endpoint) continue
    if (r.when?.endpointNot && task.endpoint === r.when.endpointNot) continue
    if (r.when?.endpointNotIn && task.endpoint && r.when.endpointNotIn.includes(task.endpoint)) continue
    // 设计稿类要求按端过滤(旧行为:developer 前端任务查本端设计稿),其余按模块
    const filter: ArtifactFilter =
      r.kinds.includes("design-prompt") || r.kinds.includes("prototype")
        ? { module: task.module, endpoint: task.endpoint }
        : { module: task.module }
    reqs.push({ desc: r.desc.replaceAll("{endpoint}", task.endpoint ?? ""), level: "exist", kinds: r.kinds, filter })
  }
  return reqs
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
  // 流水线头部角色(如 PM)无需特判:注册表 requires 为空,且其产出 kind 的 parents
  // 全部被 self-produced 排除 → approvedRequirements 恒为空,推导天然等价于早退
  return [...existRequirements(ctx, task), ...approvedRequirements(ctx, task)]
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
 * 任务级跨角色前置(config.taskPreconditions):kind 的 parents 只能表达"产物级"依赖,
 * 这类"同坐标的某角色任务必须先完成"的依赖要单独声明,不走 claimRequirements。
 */
function siblingRoleBlocking(ctx: Ctx, task: TaskRow): string | null {
  for (const rule of ctx.config.taskPreconditions ?? []) {
    if (rule.role !== task.role) continue
    if (rule.type && rule.type !== task.type) continue
    const done = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks
         WHERE role = ? AND status = 'completed' AND module IS ? AND endpoint IS ?
           AND (? IS NULL OR page IS ?)`
      )
      .get(rule.requiresSiblingRoleCompleted, task.module, task.endpoint, task.page, task.page) as { c: number }
    if (done.c === 0) {
      return `对应的 ${rule.requiresSiblingRoleCompleted} ${task.endpoint ?? ""} 任务尚未完成,无法领取 ${task.role} 任务。`
    }
  }
  return null
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

  // 任务级跨角色前置(config.taskPreconditions,缺省 = qa 要求同坐标 developer 已完成)
  const blockMsg = siblingRoleBlocking(ctx, task)
  if (blockMsg) throw new Error(`[前置条件] ${blockMsg}`)

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

  // 免领取完成是注册表能力(completeWithoutClaim,默认仅 PM),不再是角色字面量特判
  if (task.assignee === null && !getRoleRegistry(ctx.config)[task.role]?.completeWithoutClaim) {
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
