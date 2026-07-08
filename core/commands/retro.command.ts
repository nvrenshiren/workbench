import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Ctx } from "../types"

// ─── 进化机制:反馈加权提炼 + 审批吞吐报表 + 事件导出 ───────────────────
//
// 本命令层是**确定性聚合**:只把 artifact_feedback / events 铸成证据包。把证据沉淀成什么
// 形态由 AI 判断——skill(可复用做法)/ 规则(硬约束→protocolLints)/ 记忆(角色专属教训
// →agent-memory);其中 skill 走 register-meta → submit → 用户人审,approved 才生效。
// 智能永远夹在两道确定性之间。

/** 加权正例分 ≥ 此值 → 经验候选(形态由 AI 三选一);config.candidateThreshold 未配时的默认 */
export const CANDIDATE_THRESHOLD = 3
/** 加权负例分 ≥ 此值 → Red Flags;config.redFlagThreshold 未配时的默认 */
export const RED_FLAG_THRESHOLD = 2
/**
 * 自动 verdict 权重(actor 以 -auto 结尾,如 qa-auto):
 * 反馈管道防饿死的基础粮——单用户手动 👍 频率极低,QA pass 自动喂;
 * 人工反馈是更强的加权信号(1.0),自动打半折。
 */
export const AUTO_ACTOR_WEIGHT = 0.5

/** SQLite CURRENT_TIMESTAMP 为 UTC "YYYY-MM-DD HH:MM:SS" */
function parseDbTime(s: string): number {
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z")
}

export interface FeedbackEvidence {
  artifactId: number
  path: string
  module: string | null
  verdict: 1 | -1
  /** 半衰期 × actor 加权后的分值(2 位小数) */
  weight: number
  comment: string | null
  actor: string
  createdAt: string
}

export type DistillBucket = "candidate" | "red-flag" | "observation"

export interface DistillGroup {
  /** 分组键:endpoint(NULL 归 common)+ kind */
  endpoint: string
  kind: string
  posScore: number
  negScore: number
  bucket: DistillBucket
  /** observation 细分:mixed=正负两侧都达阈值;insufficient=样本不足 */
  reason?: "mixed" | "insufficient"
  evidence: FeedbackEvidence[]
}

export interface DistillOptions {
  module?: string
  /** 时间基准(测试注入固定值保证确定性;缺省取当前时刻) */
  now?: Date
}

interface FeedbackJoinRow {
  artifact_id: number
  verdict: 1 | -1
  comment: string | null
  actor: string
  created_at: string
  kind: string
  module: string | null
  endpoint: string | null
  path: string
}

/**
 * 反馈加权提炼(纯读、确定性):
 * weight = actor 权重 × 0.5^(距今天数 / feedbackHalfLifeDays)。
 * 按 (endpoint, kind) 聚合正负分后分桶(阈值可配,缺省 3 / 2):
 *   正分 ≥ candidateThreshold 且负分 < redFlagThreshold → candidate
 *   负分 ≥ redFlagThreshold 且正分 < candidateThreshold → red-flag
 *   两侧都达阈值        → observation(mixed,信号矛盾,人看)
 *   其余                → observation(insufficient,继续积累)
 */
export function distillFeedback(ctx: Ctx, opts: DistillOptions = {}): DistillGroup[] {
  const now = (opts.now ?? new Date()).getTime()
  const halfLifeMs = ctx.config.feedbackHalfLifeDays * 24 * 60 * 60 * 1000
  const candidateThreshold = ctx.config.candidateThreshold ?? CANDIDATE_THRESHOLD
  const redFlagThreshold = ctx.config.redFlagThreshold ?? RED_FLAG_THRESHOLD

  let query = `
    SELECT f.artifact_id, f.verdict, f.comment, f.actor, f.created_at,
           a.kind, a.module, a.endpoint, a.path
    FROM artifact_feedback f JOIN artifacts a ON a.id = f.artifact_id`
  const params: string[] = []
  if (opts.module) {
    query += " WHERE a.module = ?"
    params.push(opts.module)
  }
  query += " ORDER BY f.id"
  const rows = ctx.db.prepare(query).all(...params) as FeedbackJoinRow[]

  const groups = new Map<string, DistillGroup>()
  for (const row of rows) {
    const endpoint = row.endpoint ?? "common"
    const key = `${endpoint}/${row.kind}`
    let group = groups.get(key)
    if (!group) {
      group = { endpoint, kind: row.kind, posScore: 0, negScore: 0, bucket: "observation", evidence: [] }
      groups.set(key, group)
    }
    const ageMs = Math.max(0, now - parseDbTime(row.created_at))
    const actorWeight = row.actor.endsWith("-auto") ? AUTO_ACTOR_WEIGHT : 1
    const weight = actorWeight * Math.pow(0.5, ageMs / halfLifeMs)
    if (row.verdict === 1) group.posScore += weight
    else group.negScore += weight
    group.evidence.push({
      artifactId: row.artifact_id,
      path: row.path,
      module: row.module,
      verdict: row.verdict,
      weight: Math.round(weight * 100) / 100,
      comment: row.comment,
      actor: row.actor,
      createdAt: row.created_at
    })
  }

  const result = [...groups.values()]
  for (const g of result) {
    g.posScore = Math.round(g.posScore * 100) / 100
    g.negScore = Math.round(g.negScore * 100) / 100
    const pos = g.posScore >= candidateThreshold
    const neg = g.negScore >= redFlagThreshold
    if (pos && neg) {
      g.bucket = "observation"
      g.reason = "mixed"
    } else if (pos) {
      g.bucket = "candidate"
    } else if (neg) {
      g.bucket = "red-flag"
    } else {
      g.bucket = "observation"
      g.reason = "insufficient"
    }
  }
  // 输出顺序确定:候选在前、红旗次之,组内按键名
  const order: Record<DistillBucket, number> = { candidate: 0, "red-flag": 1, observation: 2 }
  return result.sort((a, b) => order[a.bucket] - order[b.bucket] || `${a.endpoint}/${a.kind}`.localeCompare(`${b.endpoint}/${b.kind}`))
}

export interface ApprovalKindStats {
  kind: string
  approved: number
  rejected: number
  /** submitted→approved 平均小时数(无可配对样本为 null) */
  avgApprovalHours: number | null
}

export interface ApprovalStats {
  approved: number
  rejected: number
  /** rejected / (approved + rejected);无审批动作为 null */
  rejectionRate: number | null
  avgApprovalHours: number | null
  byKind: ApprovalKindStats[]
}

/**
 * 审批吞吐报表(events 白嫖):让审批纪律本身被度量。
 * 耗时口径:每个 approved 事件配对同产物之前最近一次 submitted;
 * 未经送审的 approved(原型 👍 合一等)不进耗时样本。
 */
export function approvalStats(ctx: Ctx): ApprovalStats {
  const rows = ctx.db
    .prepare(
      `SELECT e.entity_id, e.event, e.created_at, a.kind
       FROM events e JOIN artifacts a ON a.id = e.entity_id
       WHERE e.entity_type = 'artifact' AND e.event IN ('submitted', 'approved', 'rejected')
       ORDER BY e.entity_id, e.id`
    )
    .all() as { entity_id: number; event: string; created_at: string; kind: string }[]

  const perKind = new Map<string, { approved: number; rejected: number; durations: number[] }>()
  const kindOf = (kind: string) => {
    let k = perKind.get(kind)
    if (!k) {
      k = { approved: 0, rejected: 0, durations: [] }
      perKind.set(kind, k)
    }
    return k
  }

  let currentEntity = -1
  let lastSubmittedAt: number | null = null
  for (const row of rows) {
    if (row.entity_id !== currentEntity) {
      currentEntity = row.entity_id
      lastSubmittedAt = null
    }
    const k = kindOf(row.kind)
    if (row.event === "submitted") {
      lastSubmittedAt = parseDbTime(row.created_at)
    } else if (row.event === "approved") {
      k.approved++
      if (lastSubmittedAt !== null) {
        k.durations.push(parseDbTime(row.created_at) - lastSubmittedAt)
        lastSubmittedAt = null
      }
    } else {
      k.rejected++
      lastSubmittedAt = null
    }
  }

  const hours = (ds: number[]) =>
    ds.length === 0 ? null : Math.round((ds.reduce((s, d) => s + d, 0) / ds.length / 36e5) * 100) / 100
  const byKind: ApprovalKindStats[] = [...perKind.entries()]
    .map(([kind, k]) => ({ kind, approved: k.approved, rejected: k.rejected, avgApprovalHours: hours(k.durations) }))
    .sort((a, b) => a.kind.localeCompare(b.kind))
  const approved = byKind.reduce((s, k) => s + k.approved, 0)
  const rejected = byKind.reduce((s, k) => s + k.rejected, 0)
  const allDurations = [...perKind.values()].flatMap(k => k.durations)
  return {
    approved,
    rejected,
    rejectionRate: approved + rejected === 0 ? null : Math.round((rejected / (approved + rejected)) * 100) / 100,
    avgApprovalHours: hours(allDurations),
    byKind
  }
}

export interface RetroReport {
  halfLifeDays: number
  module: string | null
  groups: DistillGroup[]
  candidates: number
  redFlags: number
  approval: ApprovalStats
  /** 给 AI 的下一步指引(判断沉淀为 skill / 规则 / 记忆,并按各自路径产出) */
  guidance: string[]
}

/** retrospective 流程:提炼 + 吞吐报表 + 人审流指引,一次出全 */
export function runRetrospective(ctx: Ctx, opts: DistillOptions = {}): RetroReport {
  const groups = distillFeedback(ctx, opts)
  const candidates = groups.filter(g => g.bucket === "candidate").length
  const redFlags = groups.filter(g => g.bucket === "red-flag").length
  const cli = ctx.config.cli

  const guidance: string[] = []
  if (candidates > 0) {
    guidance.push(
      `发现 ${candidates} 个经验候选组:对每组依据 evidence(路径+comment)判断该沉淀为哪一种,再按对应路径产出——` +
        `跨会话可复用的做法/流程 → skill(.claude/skills/<名称>/SKILL.md;\`${cli} register-meta\` 注册 + \`${cli} submit --actor=<角色> -- <路径>\` 送人审,approved 才生效);` +
        `必须始终成立、可 grep 的硬约束 → 规则(workbench.config.json 的 protocolLints 卡点,或写入 TECH.md / 基线约定);` +
        `只对特定角色/项目有用、不值得单独成篇的教训或偏好 → 记忆(.claude/agent-memory/<角色>/,更新 MEMORY.md 索引)`
    )
  }
  if (redFlags > 0) {
    guidance.push(
      `发现 ${redFlags} 个 Red Flags 组:负例 comment 即「别再犯」的素材,同样三选一——` +
        `能机器查 → protocolLints 卡点;跨会话通用坑 → 写进对应 skill 的 Red Flags 章节;角色专属坑 → 记忆`
    )
  }
  if (guidance.length === 0) {
    guidance.push("反馈样本不足,继续积累(QA pass 自动喂 +1,人工 👍👎 是更强信号)")
  }

  return {
    halfLifeDays: ctx.config.feedbackHalfLifeDays,
    module: opts.module ?? null,
    groups,
    candidates,
    redFlags,
    approval: approvalStats(ctx),
    guidance
  }
}

export interface ExportResult {
  events: number
  feedbacks: number
  files: string[]
}

/**
 * events / artifact_feedback 全量导出 jsonl(数据单点缓解,入 git 随版本历史灾备)。
 * 两表均 append-only,全量覆盖写即幂等;post-commit hook 顺手跑。
 */
export function exportEventLog(ctx: Ctx): ExportResult {
  // 先把 WAL 合并进主 db 文件再导出:workbench.db 是 WAL 模式,不 checkpoint 的话近期状态只留在
  // .db-wal(被 gitignore),主 db 会停在旧版、无法随 git 同步(历次 DB 丢失的根因)。export 由 post-commit
  // hook 每次提交后调用,在此 checkpoint(TRUNCATE) 确保 WAL 合并落盘、不无限积压。
  ctx.db.pragma("wal_checkpoint(TRUNCATE)")
  const dir = join(ctx.root, ctx.config.dataDir)
  mkdirSync(dir, { recursive: true })
  const dump = (table: "events" | "artifact_feedback", file: string): number => {
    const rows = ctx.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
    writeFileSync(join(dir, file), rows.map(r => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : ""))
    return rows.length
  }
  return {
    events: dump("events", "events.jsonl"),
    feedbacks: dump("artifact_feedback", "feedback.jsonl"),
    files: [`${ctx.config.dataDir}/events.jsonl`, `${ctx.config.dataDir}/feedback.jsonl`]
  }
}
