import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative } from "node:path"
import { reviewStatus } from "../derive"
import { logEvent } from "../events"
import { hashPath } from "../hash"
import { inferKind, kindSpec, normalizeModule } from "../kind"
import { isPipelineRole } from "../roles"
import type { ArtifactRow, Ctx, ReviewStatus } from "../types"

export interface ArtifactRef {
  id?: number
  path?: string
}

/**
 * 路径归一:统一正斜杠 + 取磁盘真实大小写(Windows 上同一文件的
 * 两种大小写写法否则会骗过 UNIQUE 约束)。
 */
export function normalizeRelPath(ctx: Ctx, p: string): string {
  let abs = isAbsolute(p) ? p : join(ctx.root, p)
  if (existsSync(abs)) {
    try {
      abs = realpathSync.native(abs)
    } catch {
      /* 保持原样 */
    }
  }
  return relative(realpathSync.native(ctx.root), abs).replace(/\\/g, "/")
}

/** 审批状态快照落 git:灾备 + 让信任状态进入版本历史可审计 */
function dumpApprovals(ctx: Ctx) {
  const rows = ctx.db
    .prepare(
      `SELECT path, approved_hash, reviewed_by, reviewed_at FROM artifacts
       WHERE approved_hash IS NOT NULL ORDER BY path`
    )
    .all()
  writeFileSync(join(ctx.root, ctx.config.dataDir, "approvals.json"), JSON.stringify(rows, null, 2) + "\n")
}

export function resolveArtifact(ctx: Ctx, ref: ArtifactRef): ArtifactRow {
  let row: ArtifactRow | undefined
  if (ref.id !== undefined) {
    row = ctx.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(ref.id) as ArtifactRow | undefined
  } else if (ref.path) {
    row = ctx.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(normalizeRelPath(ctx, ref.path)) as
      | ArtifactRow
      | undefined
  }
  if (!row) throw new Error(`产物不存在: ${ref.id ?? ref.path}`)
  return row
}

/** 重算磁盘指纹;变化则更新并留痕。返回最新行。 */
export function refreshArtifact(ctx: Ctx, ref: ArtifactRef, actor = "system"): ArtifactRow {
  const row = resolveArtifact(ctx, ref)
  const current = hashPath(join(ctx.root, row.path))
  if (current === null || current === row.content_hash) return row

  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare("UPDATE artifacts SET content_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(current, row.id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "content_changed",
      actor,
      payload: { from: row.content_hash, to: current },
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })
    if (row.approved_hash !== null && row.approved_hash !== current) {
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: row.id,
        event: "approval_invalidated",
        actor,
        payload: { approvedHash: row.approved_hash, currentHash: current },
        module: row.module,
        endpoint: row.endpoint,
        page: row.page
      })
    }
    // 送审后又编辑 = 撤审,但撤得有痕
    if (row.submitted_hash !== null && row.submitted_hash !== current) {
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: row.id,
        event: "submission_stale",
        actor,
        payload: { submittedHash: row.submitted_hash, currentHash: current },
        module: row.module,
        endpoint: row.endpoint,
        page: row.page
      })
    }
  })
  tx()
  return resolveArtifact(ctx, { id: row.id })
}

export interface RegisterOutputParams {
  module?: string | null
  role: string
  endpoint: string
  page?: string | null
  filePath: string
  taskId?: number
  actor?: string
}

export interface RegisterOutputResult {
  artifactId: number
  linkedTaskId: number | null
  kind: string
}

export function registerOutput(ctx: Ctx, p: RegisterOutputParams): RegisterOutputResult {
  if (p.role === "developer") {
    throw new Error(`developer 角色的产出不需要记录到 task_outputs,代码直接实现到项目路径即可。`)
  }

  const relPath = normalizeRelPath(ctx, p.filePath)
  const abs = join(ctx.root, relPath)
  if (!existsSync(abs)) {
    throw new Error(`产出文件不存在: ${relPath},请先写文件再登记`)
  }

  const existing = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(relPath) as { id: number } | undefined
  if (existing) {
    throw new Error(`产出文件已存在: ${relPath}`)
  }

  const kind = inferKind(relPath, ctx.config)
  // 项目级/端级契约(project/roles/glossary/baseline、元产物、design-system)不挂业务模块坐标:
  // 它们跨模块通用,无论登记传入什么 module 一律归零,否则会被树误当成业务模块节点(如历史上的 common、account)。
  const level = kindSpec(ctx.config, kind).level
  const module = level === "project" || level === "endpoint" ? null : normalizeModule(p.module, ctx.config)
  const hash = hashPath(abs)!
  const actor = p.actor ?? p.role

  // 关联任务:显式 taskId 优先,否则匹配同坐标已领取的未完成任务
  let linkedTaskId: number | null = p.taskId ?? null
  if (linkedTaskId === null) {
    const match = ctx.db
      .prepare(
        `SELECT id FROM tasks
         WHERE role = ? AND endpoint = ? AND module IS ? AND assignee IS NOT NULL
           AND status IN ('pending', 'in_progress')
           AND (? IS NULL OR page IS NULL OR page = ?)
         ORDER BY id DESC LIMIT 1`
      )
      .get(p.role, p.endpoint, module, p.page ?? null, p.page ?? null) as { id: number } | undefined
    linkedTaskId = match?.id ?? null
  }

  const tx = ctx.db.transaction(() => {
    const result = ctx.db
      .prepare(
        `INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(kind, module, p.endpoint, p.page ?? null, relPath, hash)
    const artifactId = result.lastInsertRowid as number

    if (linkedTaskId !== null) {
      ctx.db
        .prepare("INSERT OR IGNORE INTO task_outputs (task_id, artifact_id) VALUES (?, ?)")
        .run(linkedTaskId, artifactId)
    }

    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: artifactId,
      event: "output_added",
      actor,
      payload: { path: relPath, kind, taskId: linkedTaskId },
      module,
      endpoint: p.endpoint,
      page: p.page ?? null
    })
    return artifactId
  })

  return { artifactId: tx(), linkedTaskId, kind }
}

export function submitArtifact(ctx: Ctx, ref: ArtifactRef, actor: string): ArtifactRow {
  const row = refreshArtifact(ctx, ref, actor)
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "UPDATE artifacts SET submitted_at = CURRENT_TIMESTAMP, submitted_hash = content_hash, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(row.id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "submitted",
      actor,
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })
  })
  tx()
  return resolveArtifact(ctx, { id: row.id })
}

export interface ApproveOptions {
  via?: "review" | "feedback"
  /**
   * 非破坏性变更标记:re-bless——把所有下游任务对该产物的 input_hash 快照
   * 刷到当前版本(解除 stale),并自动取消由本次变更派生的 open review 任务。
   */
  trivial?: boolean
}

/**
 * 「人审不外包」硬门:审批是人的动作,流水线角色(AI)不得自审自批。
 * 挡 agent 以自身角色跑 CLI approve/reject、或经 feedback 给原型自我 👍 放行;
 * 约束下沉引擎最内层——CLI / HTTP / feedback 三条同源入口一处生效。
 */
function assertHumanApprover(ctx: Ctx, actor: string, action: string): void {
  if (isPipelineRole(ctx.config, actor)) {
    throw new Error(
      `「人审不外包」:actor "${actor}" 是流水线角色,不能自行${action}。审批是人的动作——请由人在 CLI/工作台以真实身份操作。`
    )
  }
}

/** 审批通过:approved_hash 绑定"审批人刚看过的这一版"(先重算磁盘指纹);内容存档供 diff */
export function approveArtifact(ctx: Ctx, ref: ArtifactRef, actor: string, opts: ApproveOptions = {}): ArtifactRow {
  assertHumanApprover(ctx, actor, "审批(approve)")
  const row = refreshArtifact(ctx, ref, actor)
  const via = opts.via ?? "review"
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE artifacts SET approved_hash = content_hash, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .run(actor, row.id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "approved",
      actor,
      payload: { via, hash: row.content_hash, trivial: opts.trivial ?? false },
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })

    if (opts.trivial) {
      // re-bless:下游快照对齐到新版本,stale 派生即刻消失
      ctx.db
        .prepare(
          `UPDATE task_inputs SET input_hash = (SELECT content_hash FROM artifacts WHERE id = ?)
           WHERE artifact_id = ?`
        )
        .run(row.id, row.id)
      // 取消本次变更派生的 open review 任务
      const reviews = ctx.db
        .prepare(
          `SELECT t.id FROM tasks t JOIN task_inputs ti ON ti.task_id = t.id
           WHERE t.type = 'review' AND t.status = 'pending' AND ti.artifact_id = ?`
        )
        .all(row.id) as { id: number }[]
      for (const r of reviews) {
        ctx.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id)
        logEvent(ctx.db, {
          entityType: "task",
          entityId: r.id,
          event: "review_auto_closed",
          actor,
          payload: { source: row.path, reason: "trivial 审批" }
        })
      }
    }
  })
  tx()
  dumpApprovals(ctx)
  archiveApprovedContent(ctx, row.id)
  return resolveArtifact(ctx, { id: row.id })
}

/** 审批内容存档:.workbench/approved/{id} 存最新获批版本,待审队列 diff 用 */
function archiveApprovedContent(ctx: Ctx, artifactId: number) {
  try {
    const row = resolveArtifact(ctx, { id: artifactId })
    const abs = join(ctx.root, row.path)
    if (!existsSync(abs) || statSync(abs).isDirectory()) return
    const dir = join(ctx.root, ctx.config.dataDir, "approved")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, String(artifactId)), readFileSync(abs))
  } catch {
    /* 存档失败不阻塞审批(fail-open 观测侧) */
  }
}

/** 读取某产物的已批版本内容(无存档返回 null) */
export function approvedContent(ctx: Ctx, artifactId: number): string | null {
  const file = join(ctx.root, ctx.config.dataDir, "approved", String(artifactId))
  if (!existsSync(file)) return null
  return readFileSync(file, "utf-8")
}

export function rejectArtifact(ctx: Ctx, ref: ArtifactRef, actor: string, reason: string): ArtifactRow {
  assertHumanApprover(ctx, actor, "打回(reject)")
  if (!reason || !reason.trim()) throw new Error("打回必须附原因")
  const row = resolveArtifact(ctx, ref)
  const tx = ctx.db.transaction(() => {
    ctx.db
      .prepare(
        "UPDATE artifacts SET submitted_at = NULL, submitted_hash = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      )
      .run(row.id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "rejected",
      actor,
      payload: { reason },
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })
  })
  tx()
  return resolveArtifact(ctx, { id: row.id })
}

export interface FeedbackParams {
  verdict: 1 | -1
  comment?: string
  actor: string
  taskId?: number
}

export function feedbackArtifact(ctx: Ctx, ref: ArtifactRef, p: FeedbackParams): { feedbackId: number; endorsed: boolean } {
  if (p.verdict === -1 && (!p.comment || !p.comment.trim())) {
    throw new Error("负反馈必须附一句原因,否则无法沉淀为经验")
  }
  const row = refreshArtifact(ctx, ref, p.actor)
  // 原型👍=放行=审批:与下方 endorse 分支同条件前置拦截,agent(角色)不得自我背书,且不落半条 feedback
  if (row.kind === "prototype" && p.verdict === 1) assertHumanApprover(ctx, p.actor, "对原型 👍 放行")

  const tx = ctx.db.transaction(() => {
    const result = ctx.db
      .prepare(
        `INSERT INTO artifact_feedback (artifact_id, task_id, verdict, comment, content_hash, actor)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, p.taskId ?? null, p.verdict, p.comment ?? null, row.content_hash, p.actor)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "feedback",
      actor: p.actor,
      payload: { verdict: p.verdict, comment: p.comment ?? null },
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })
    return result.lastInsertRowid as number
  })
  const feedbackId = tx()

  // 原型 👍 = 反馈 + 审批合一
  let endorsed = false
  if (row.kind === "prototype" && p.verdict === 1) {
    approveArtifact(ctx, { id: row.id }, p.actor, { via: "feedback" })
    endorsed = true
  }
  return { feedbackId, endorsed }
}

/**
 * 移动/重命名产物:保 id 改 path——审批历史、DAG 边、反馈全部随 id 保留。
 * 目标文件必须已在磁盘新位置(先 mv 再登记)。
 */
export function moveArtifact(ctx: Ctx, { from, to, actor }: { from: string; to: string; actor: string }): ArtifactRow {
  const row = resolveArtifact(ctx, { path: from })
  const toRel = normalizeRelPath(ctx, to)
  if (!existsSync(join(ctx.root, toRel))) {
    throw new Error(`目标文件不存在: ${toRel},请先移动磁盘文件再执行 move`)
  }
  const dup = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?").get(toRel) as { id: number } | undefined
  if (dup && dup.id !== row.id) throw new Error(`目标路径已被 artifact #${dup.id} 占用: ${toRel}`)

  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE artifacts SET path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(toRel, row.id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: row.id,
      event: "moved",
      actor,
      payload: { from: row.path, to: toRel },
      module: row.module,
      endpoint: row.endpoint,
      page: row.page
    })
  })
  tx()
  // 移动后按新内容对账(内容未变则 hash 不变,审批不受影响)
  return refreshArtifact(ctx, { id: row.id }, actor)
}

export interface ListArtifactsFilter {
  module?: string
  endpoint?: string
  page?: string
  kind?: string
  role?: string
}

export type ArtifactWithStatus = ArtifactRow & { review_status: ReviewStatus }

export function listArtifacts(ctx: Ctx, f: ListArtifactsFilter = {}): ArtifactWithStatus[] {
  let query = "SELECT * FROM artifacts WHERE 1=1"
  const params: string[] = []
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
  if (f.kind) {
    query += " AND kind = ?"
    params.push(f.kind)
  }
  query += " ORDER BY id DESC"
  const rows = ctx.db.prepare(query).all(...params) as ArtifactWithStatus[]
  for (const row of rows) row.review_status = reviewStatus(row)
  return rows
}
