import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import {
  approvalStats,
  approveArtifact,
  distillFeedback,
  exportEventLog,
  listArtifacts,
  registerMetaArtifacts,
  runRetrospective,
  submitArtifact,
  type Ctx
} from "../core/index"
import { openWorkbenchAt } from "../core/db"

/** 固定时间基准:提炼计算全部注入 now,结果确定 */
const NOW = new Date("2026-07-06T00:00:00Z")
const FRESH = "2026-07-06 00:00:00"
const DAYS_15_AGO = "2026-06-21 00:00:00" // 恰好 15 天前 = 一个半衰期(feedbackHalfLifeDays 默认 15)

describe("M8 反馈加权提炼(半衰期 × actor 权重 × 分桶)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-m8-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const insertArtifact = (kind: string, endpoint: string | null, module: string | null, path: string): number => {
    const r = ctx.db
      .prepare("INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash) VALUES (?, ?, ?, NULL, ?, 'h0')")
      .run(kind, module, endpoint, path)
    return r.lastInsertRowid as number
  }
  const insertFeedback = (artifactId: number, verdict: 1 | -1, actor: string, createdAt: string, comment: string | null = null) => {
    ctx.db
      .prepare(
        "INSERT INTO artifact_feedback (artifact_id, task_id, verdict, comment, content_hash, actor, created_at) VALUES (?, NULL, ?, ?, 'h0', ?, ?)"
      )
      .run(artifactId, verdict, comment, actor, createdAt)
  }
  const groupOf = (groups: ReturnType<typeof distillFeedback>, endpoint: string) =>
    groups.find(g => g.endpoint === endpoint && g.kind === "code")!

  it("3 个人工正例 → skill-candidate;2 个人工负例 → red-flag;混杂 → observation(mixed)", () => {
    // service/code:3 个人工 +1(不同产物)
    for (let i = 1; i <= 3; i++) {
      insertFeedback(insertArtifact("code", "service", `m${i}`, `service/src/m${i}`), 1, "user", FRESH)
    }
    // admin/code:2 个人工 -1(负反馈必有 comment,它是 Red Flags 的素材)
    insertFeedback(insertArtifact("code", "admin", "m1", "admin/src/m1"), -1, "user", FRESH, "表单校验遗漏空串")
    insertFeedback(insertArtifact("code", "admin", "m2", "admin/src/m2"), -1, "user", FRESH, "分页用了 pageSize")
    // weapp/code:两侧都达阈值 → 信号矛盾
    const weapp = insertArtifact("code", "weapp", "m1", "weapp/src/m1")
    for (let i = 0; i < 3; i++) insertFeedback(weapp, 1, "user", FRESH)
    insertFeedback(weapp, -1, "user", FRESH, "svg 又混进来了")
    insertFeedback(weapp, -1, "user", FRESH, "三态图标缺 disabled")

    const groups = distillFeedback(ctx, { now: NOW })
    const service = groupOf(groups, "service")
    assert.equal(service.bucket, "skill-candidate")
    assert.equal(service.posScore, 3)

    const admin = groupOf(groups, "admin")
    assert.equal(admin.bucket, "red-flag")
    assert.equal(admin.negScore, 2)
    assert.deepEqual(
      admin.evidence.map(e => e.comment),
      ["表单校验遗漏空串", "分页用了 pageSize"]
    )

    const weappGroup = groupOf(groups, "weapp")
    assert.equal(weappGroup.bucket, "observation")
    assert.equal(weappGroup.reason, "mixed")

    // 排序:候选在前,红旗次之
    assert.equal(groups[0].bucket, "skill-candidate")
    assert.equal(groups[1].bucket, "red-flag")
  })

  it("自动 verdict(-auto)半权:2 个 qa-auto +1 只积 1 分 → 样本不足(防饿死但人工是更强信号)", () => {
    const app = insertArtifact("code", "app", "m1", "app/lib/m1")
    insertFeedback(app, 1, "qa-auto", FRESH)
    insertFeedback(app, 1, "qa-auto", FRESH)
    const g = groupOf(distillFeedback(ctx, { now: NOW }), "app")
    assert.equal(g.posScore, 1)
    assert.equal(g.bucket, "observation")
    assert.equal(g.reason, "insufficient")
  })

  it("半衰期加权:15 天前的人工 +1 衰减为 0.5", () => {
    const c = insertArtifact("code", "common", "m1", "packages/m1")
    insertFeedback(c, 1, "user", FRESH)
    insertFeedback(c, 1, "user", DAYS_15_AGO)
    const g = groupOf(distillFeedback(ctx, { now: NOW }), "common")
    assert.equal(g.posScore, 1.5)
    assert.deepEqual(g.evidence.map(e => e.weight), [1, 0.5])
  })

  it("module 过滤只聚合该模块的反馈", () => {
    const groups = distillFeedback(ctx, { now: NOW, module: "m2" })
    // m2 的反馈:service/code +1(m2)与 admin/code -1(m2)各一条
    assert.equal(groups.length, 2)
    assert.ok(groups.every(g => g.evidence.every(e => e.module === "m2")))
  })
})

describe("M8 审批吞吐报表(events 白嫖)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-m8-stats-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("送审→通过平均耗时与打回率", () => {
    const prd = ctx.db
      .prepare("INSERT INTO artifacts (kind, module, path, content_hash) VALUES ('module-prd', 'm1', 'docs/prd/modules/m1.md', 'h0')")
      .run().lastInsertRowid as number
    const api = ctx.db
      .prepare("INSERT INTO artifacts (kind, module, path, content_hash) VALUES ('api-doc', 'm1', 'docs/architecture/api/m1.md', 'h0')")
      .run().lastInsertRowid as number
    const ev = (id: number, event: string, at: string) =>
      ctx.db
        .prepare("INSERT INTO events (entity_type, entity_id, event, actor, created_at) VALUES ('artifact', ?, ?, 'user', ?)")
        .run(id, event, at)
    ev(prd, "submitted", "2026-07-05 00:00:00")
    ev(prd, "approved", "2026-07-05 02:00:00") // 2 小时
    ev(api, "submitted", "2026-07-05 00:00:00")
    ev(api, "rejected", "2026-07-05 01:00:00")

    const s = approvalStats(ctx)
    assert.equal(s.approved, 1)
    assert.equal(s.rejected, 1)
    assert.equal(s.rejectionRate, 0.5)
    assert.equal(s.avgApprovalHours, 2)
    const prdKind = s.byKind.find(k => k.kind === "module-prd")!
    assert.equal(prdKind.avgApprovalHours, 2)
    const apiKind = s.byKind.find(k => k.kind === "api-doc")!
    assert.equal(apiKind.rejected, 1)
    assert.equal(apiKind.avgApprovalHours, null) // 未经通过,无耗时样本
  })

  it("未经送审的 approved(👍 合一/trivial)不进耗时样本", () => {
    const proto = ctx.db
      .prepare("INSERT INTO artifacts (kind, path, content_hash) VALUES ('prototype', 'docs/design/prototypes/p.html', 'h0')")
      .run().lastInsertRowid as number
    ctx.db
      .prepare("INSERT INTO events (entity_type, entity_id, event, actor, created_at) VALUES ('artifact', ?, 'approved', 'user', '2026-07-05 00:00:00')")
      .run(proto)
    const s = approvalStats(ctx)
    assert.equal(s.approved, 2)
    assert.equal(s.avgApprovalHours, 2) // 平均值不被无配对样本稀释
  })
})

describe("M8 skill 草稿人审流 + retrospective 报告 + 事件导出", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-m8-e2e-"))
  writeFileSync(join(root, "workbench.config.json"), "{}")
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("验收路径:候选证据 → AI 写草稿 → register-meta(kind=skill)→ submit → 人审 approved", () => {
    // 积累到候选阈值的反馈
    const code = ctx.db
      .prepare("INSERT INTO artifacts (kind, module, endpoint, path, content_hash) VALUES ('code', 'billing', 'service', 'service/src/billing', 'h0')")
      .run().lastInsertRowid as number
    for (let i = 0; i < 3; i++) {
      ctx.db
        .prepare("INSERT INTO artifact_feedback (artifact_id, verdict, content_hash, actor, created_at) VALUES (?, 1, 'h0', 'user', ?)")
        .run(code, FRESH)
    }
    const report = runRetrospective(ctx, { now: NOW })
    assert.equal(report.candidates, 1)
    assert.ok(report.guidance[0].includes("SKILL.md"), "指引必须给出人审流的具体路径")

    // AI 依据证据写草稿(此处模拟)→ 显式注册为元产物
    const skillDir = join(root, ".claude/skills/service-billing-patterns")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "# 从 3 个正例提炼的计费模式\n")
    const { registered } = registerMetaArtifacts(ctx, "developer")
    assert.deepEqual(registered.map(r => r.kind), ["skill"])
    const path = registered[0].path

    // 人审流:submit → pending;approve → approved(经existing闸门,无旁路)
    submitArtifact(ctx, { path }, "developer")
    let row = listArtifacts(ctx, { kind: "skill" })[0]
    assert.equal(row.review_status, "pending")
    approveArtifact(ctx, { path }, "user")
    row = listArtifacts(ctx, { kind: "skill" })[0]
    assert.equal(row.review_status, "approved")
  })

  it("export:events/feedback 全量落 jsonl,行数与表一致且幂等", () => {
    const first = exportEventLog(ctx)
    const eventCount = (ctx.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c
    const fbCount = (ctx.db.prepare("SELECT COUNT(*) AS c FROM artifact_feedback").get() as { c: number }).c
    assert.equal(first.events, eventCount)
    assert.equal(first.feedbacks, fbCount)

    const lines = (f: string) => readFileSync(join(root, ".workbench", f), "utf-8").split("\n").filter(Boolean)
    assert.equal(lines("events.jsonl").length, eventCount)
    assert.equal(lines("feedback.jsonl").length, fbCount)
    // 每行合法 JSON 且按 id 升序
    const ids = lines("events.jsonl").map(l => (JSON.parse(l) as { id: number }).id)
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b))

    const second = exportEventLog(ctx)
    assert.deepEqual(second, first)
    assert.ok(existsSync(join(root, ".workbench/feedback.jsonl")))
  })
})
