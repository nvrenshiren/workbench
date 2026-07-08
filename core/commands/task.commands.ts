import { taskStaleness, type StaleInfo } from "../derive"
import { logEvent, listEvents } from "../events"
import { validateClaim, validateComplete } from "../gates"
import { gitHead, touchedByTaskTrailer, touchedSince } from "../git"
import { closeLinkedIssue } from "../gh"
import { contractKinds, normalizeModule } from "../kind"
import { normalizeRelPath } from "./artifact.commands"
import { ownerRole } from "./sync.command"
import type { ArtifactRow, Ctx, EventRow, Role, TaskRow, TaskStatus, TaskType } from "../types"

const VALID_STATUS: TaskStatus[] = ["pending", "in_progress", "completed", "cancelled"]
// role/type 是项目语义:DB CHECK 已删(迁移 2),校验下沉到此(M1 起可由 config 覆盖)
const VALID_TYPES: TaskType[] = ["build", "review", "qa", "hotfix", "baseline", "legacy", "rework"]
const VALID_ROLES: Role[] = ["product-manager", "architect", "designer", "developer", "qa"]

export interface CreateTaskParams {
  module?: string | null
  role: TaskRow["role"]
  endpoint?: string | null
  page?: string | null
  type?: TaskType
  assignee?: string | null
  creator: string
  content?: string | null
  externalRef?: string | null
}

export function createTask(ctx: Ctx, p: CreateTaskParams): number {
  const type = p.type ?? "build"
  if (!VALID_TYPES.includes(type)) throw new Error(`无效的任务类型: ${type},可选值: ${VALID_TYPES.join(", ")}`)
  if (!VALID_ROLES.includes(p.role)) throw new Error(`无效的角色: ${p.role},可选值: ${VALID_ROLES.join(", ")}`)
  const module = normalizeModule(p.module, ctx.config)

  const tx = ctx.db.transaction(() => {
    const result = ctx.db
      .prepare(
        `INSERT INTO tasks (module, role, endpoint, page, type, assignee, creator, content, external_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(module, p.role, p.endpoint ?? null, p.page ?? null, type, p.assignee ?? null, p.creator, p.content ?? null, p.externalRef ?? null)
    const id = result.lastInsertRowid as number
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: "created",
      actor: p.creator,
      payload: { role: p.role, type },
      module,
      endpoint: p.endpoint ?? null,
      page: p.page ?? null
    })
    return id
  })
  return tx()
}

export function getTaskRow(ctx: Ctx, id: number): TaskRow {
  const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined
  if (!task) throw new Error(`任务 #${id} 不存在`)
  return task
}

export interface ClaimResult {
  id: number
  warnings: string[]
}

export function claimTask(ctx: Ctx, { id, assignee }: { id: number; assignee: string }): ClaimResult {
  const task = getTaskRow(ctx, id)
  const { warnings, inputs } = validateClaim(ctx, task)
  const claimCommit = gitHead(ctx.root)

  const tx = ctx.db.transaction(() => {
    // 原子领取:仅 pending 且(无人认领或本人预分配)可领,防止并发 agent 撞车
    const result = ctx.db
      .prepare(
        `UPDATE tasks SET assignee = ?, status = 'in_progress', claim_commit = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending' AND (assignee IS NULL OR assignee = ?)`
      )
      .run(assignee, claimCommit, id, assignee)
    if (result.changes === 0) {
      throw new Error(`任务 #${id} 无法领取:已被他人领取或状态不是 pending(当前 ${task.status}${task.assignee ? `,执行人 ${task.assignee}` : ""})`)
    }
    const snapshot = ctx.db.prepare(
      "INSERT OR REPLACE INTO task_inputs (task_id, artifact_id, input_hash) VALUES (?, ?, ?)"
    )
    for (const a of inputs) snapshot.run(id, a.id, a.content_hash)
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: "claimed",
      actor: assignee,
      payload: { warnings, inputCount: inputs.length },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
  })
  tx()
  return { id, warnings }
}

export interface UpdateResult {
  id: number
  warnings: string[]
}

export function updateTask(
  ctx: Ctx,
  { id, status, operator, force = false }: { id: number; status: string; operator: string; force?: boolean }
): UpdateResult {
  const task = getTaskRow(ctx, id)

  if (!VALID_STATUS.includes(status as TaskStatus)) {
    throw new Error(`无效的状态: ${status},可选值: ${VALID_STATUS.join(", ")}`)
  }
  if (task.assignee !== null && task.assignee !== operator) {
    throw new Error(`只有执行人才能更新任务状态`)
  }

  const { warnings } = validateComplete(ctx, task, status, { force })

  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, id)
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: status === "completed" ? "completed" : "status_changed",
      actor: operator,
      payload: { status, warnings, ...(force ? { force: true } : {}) },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
  })
  tx()

  // 快车道机器锁:hotfix 完成时检测契约触碰 → 自动升级标准道(补文档 review)
  if (task.type === "hotfix" && status === "completed") {
    warnings.push(...checkContractTouch(ctx, task, operator))
  }

  // QA 闭环收口:rework 完成 → 自动再派新一轮 qa 复验
  if (task.type === "rework" && status === "completed") {
    const qaId = spawnFollowupQa(ctx, task)
    warnings.push(`[复验] 已自动派新一轮 qa 任务 #${qaId}`)
  }

  // issue 回写:关联 gh issue 的任务完成 → 自动关闭(fail-open)
  if (status === "completed" && task.external_ref?.startsWith("gh#")) {
    const closed = closeLinkedIssue(ctx, task.external_ref, task.id)
    warnings.push(closed ? `[issue] 已关闭 ${task.external_ref}` : `[issue] ${task.external_ref} 关闭失败(gh 不可用),请手动处理`)
  }

  return { id, warnings }
}

/** rework 完成 → 自动再派新一轮 qa(闭环收口;放本文件避免与 qa.command 环依赖) */
export function spawnFollowupQa(
  ctx: Ctx,
  reworkTask: { id: number; module: string | null; endpoint: string | null; page: string | null }
): number {
  const tx = ctx.db.transaction(() => {
    const result = ctx.db
      .prepare(
        `INSERT INTO tasks (module, role, endpoint, page, type, status, assignee, creator, content)
         VALUES (?, 'qa', ?, ?, 'qa', 'pending', 'qa', 'system', ?)`
      )
      .run(reworkTask.module, reworkTask.endpoint, reworkTask.page, `[复验] rework #${reworkTask.id} 已完成,请重新验收`)
    const qaId = result.lastInsertRowid as number
    logEvent(ctx.db, {
      entityType: "task",
      entityId: qaId,
      event: "qa_respawned",
      actor: "system",
      payload: { rework: reworkTask.id },
      module: reworkTask.module,
      endpoint: reworkTask.endpoint,
      page: reworkTask.page
    })
    return qaId
  })
  return tx()
}

/** 触碰路径 ∩ 契约产物路径 ≠ ∅ → 为每份被触碰契约派"补文档"review 任务(去重) */
function checkContractTouch(ctx: Ctx, task: TaskRow, operator: string): string[] {
  const warnings: string[] = []
  const touched =
    ctx.config.git.taskTrailer === "on" && task.claim_commit
      ? touchedByTaskTrailer(ctx.root, task.claim_commit, ctx.config.git.trailerKey, task.id)
      : touchedSince(ctx.root, task.claim_commit)
  if (touched.length === 0) return warnings

  const kinds = contractKinds(ctx.config)
  const contracts = ctx.db
    .prepare(`SELECT * FROM artifacts WHERE kind IN (${kinds.map(() => "?").join(",")})`)
    .all(...kinds) as ArtifactRow[]

  for (const contract of contracts) {
    const hit = touched.some(t => t === contract.path || t.startsWith(contract.path + "/"))
    if (!hit) continue
    const open = ctx.db
      .prepare(
        `SELECT COUNT(*) AS c FROM tasks t JOIN task_inputs ti ON ti.task_id = t.id
         WHERE t.type = 'review' AND t.status IN ('pending','in_progress') AND ti.artifact_id = ?`
      )
      .get(contract.id) as { c: number }
    if (open.c > 0) continue

    const role = ownerRole(ctx, contract.kind) ?? "architect"
    const tx = ctx.db.transaction(() => {
      const result = ctx.db
        .prepare(
          `INSERT INTO tasks (module, role, endpoint, type, status, assignee, creator, content)
           VALUES (?, ?, ?, 'review', 'pending', ?, 'system', ?)`
        )
        .run(
          contract.module,
          role,
          contract.endpoint,
          role,
          `[契约触碰] hotfix #${task.id} 触碰了契约 ${contract.path},请补文档并重新送审`
        )
      const reviewId = result.lastInsertRowid as number
      ctx.db
        .prepare("INSERT OR REPLACE INTO task_inputs (task_id, artifact_id, input_hash) VALUES (?, ?, ?)")
        .run(reviewId, contract.id, contract.content_hash)
      logEvent(ctx.db, {
        entityType: "task",
        entityId: reviewId,
        event: "contract_touched",
        actor: operator,
        payload: { hotfix: task.id, contract: contract.path },
        module: contract.module,
        endpoint: contract.endpoint
      })
    })
    tx()
    warnings.push(`[契约触碰] ${contract.path} 被本 hotfix 修改,已自动派补文档 review 任务`)
  }
  return warnings
}

export function removeTask(ctx: Ctx, { id, operator, force = false }: { id: number; operator: string; force?: boolean }): void {
  const task = getTaskRow(ctx, id)
  if (!force && task.creator !== operator) {
    throw new Error(`只有创建人(${task.creator})才能删除任务`)
  }
  const tx = ctx.db.transaction(() => {
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: "removed",
      actor: operator,
      payload: { force },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
    ctx.db.prepare("DELETE FROM tasks WHERE id = ?").run(id)
  })
  tx()
}

/**
 * 追加申报任务依赖(advisory:gate 依赖已由系统自动注入,
 * 本命令只用于 agent 读了 gate 之外的产物时补充申报,让它进入 stale 监控)。
 */
export function addTaskInput(ctx: Ctx, { id, path, operator }: { id: number; path: string; operator: string }): void {
  const task = getTaskRow(ctx, id)
  const artifact = ctx.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(normalizeRelPath(ctx, path)) as
    | ArtifactRow
    | undefined
  if (!artifact) throw new Error(`产物未登记: ${path},无法申报依赖`)
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare("INSERT OR REPLACE INTO task_inputs (task_id, artifact_id, input_hash) VALUES (?, ?, ?)")
      .run(id, artifact.id, artifact.content_hash)
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: "input_added",
      actor: operator,
      payload: { path: artifact.path, artifactId: artifact.id },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
  })
  tx()
}

export function recordNote(ctx: Ctx, { id, content, operator }: { id: number; content: string; operator: string }): void {
  const task = getTaskRow(ctx, id)
  const tx = ctx.db.transaction(() => {
    logEvent(ctx.db, {
      entityType: "task",
      entityId: id,
      event: "note",
      actor: operator,
      payload: { content },
      module: task.module,
      endpoint: task.endpoint,
      page: task.page
    })
  })
  tx()
}

export interface ListTasksFilter {
  status?: string
  assignee?: string
  module?: string
  role?: string
  endpoint?: string
  type?: string
  withStale?: boolean
}

export type TaskWithStale = TaskRow & { stale?: boolean }

export function listTasks(ctx: Ctx, f: ListTasksFilter = {}): TaskWithStale[] {
  let query = "SELECT * FROM tasks WHERE 1=1"
  const params: string[] = []
  if (f.status) {
    query += " AND status = ?"
    params.push(f.status)
  }
  if (f.assignee) {
    query += " AND assignee = ?"
    params.push(f.assignee)
  }
  if (f.module) {
    query += " AND module LIKE ?"
    params.push(`%${f.module}%`)
  }
  if (f.role) {
    query += " AND role = ?"
    params.push(f.role)
  }
  if (f.endpoint) {
    query += " AND endpoint = ?"
    params.push(f.endpoint)
  }
  if (f.type) {
    query += " AND type = ?"
    params.push(f.type)
  }
  query += " ORDER BY id DESC"
  const rows = ctx.db.prepare(query).all(...params) as TaskWithStale[]
  if (f.withStale) {
    for (const row of rows) row.stale = taskStaleness(ctx.db, row.id).stale
  }
  return rows
}

export interface TaskDetail {
  task: TaskRow
  events: EventRow[]
  outputs: ArtifactRow[]
  staleness: StaleInfo
}

export function getTaskDetail(ctx: Ctx, id: number): TaskDetail {
  const task = getTaskRow(ctx, id)
  const events = listEvents(ctx.db, { entityType: "task", entityId: id })
  const outputs = ctx.db
    .prepare(
      `SELECT a.* FROM artifacts a JOIN task_outputs t ON t.artifact_id = a.id WHERE t.task_id = ? ORDER BY a.id ASC`
    )
    .all(id) as ArtifactRow[]
  // legacy 兼容:无外键关联时按坐标匹配
  if (outputs.length === 0 && task.module) {
    const fallback = ctx.db
      .prepare(`SELECT * FROM artifacts WHERE module = ? AND endpoint = ? ORDER BY id ASC`)
      .all(task.module, task.endpoint) as ArtifactRow[]
    outputs.push(...fallback)
  }
  return { task, events, outputs, staleness: taskStaleness(ctx.db, id) }
}
