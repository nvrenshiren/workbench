import fastifyCors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import Fastify, { type FastifyInstance } from "fastify"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, normalize, relative } from "node:path"
import {
  approveArtifact,
  approvedContent,
  feedbackArtifact,
  listArtifacts,
  rejectArtifact,
  submitArtifact
} from "../core/commands/artifact.commands"
import { runRetrospective } from "../core/commands/retro.command"
import { registerAdHocArtifact } from "../core/commands/scan.command"
import { syncArtifacts } from "../core/commands/sync.command"
import { WORKBENCH_DIR } from "../core/config"
import { claimTask, updateTask } from "../core/commands/task.commands"
import { everApproved, prototypeEndorsed, reviewStatus } from "../core/derive"
import { listEvents, logEvent } from "../core/events"
import { expandPattern, getKindRegistry } from "../core/kind"
import { buildTree, nodeDetail } from "../core/tree"
import type { ArtifactRow, Ctx } from "../core/types"

const MAX_INLINE_SIZE = 1024 * 1024

function getArtifact(ctx: Ctx, id: number): ArtifactRow {
  const row = ctx.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined
  if (!row) throw Object.assign(new Error(`artifact #${id} 不存在`), { statusCode: 404 })
  return row
}

/** 路径守卫:只允许读登记产物自身或其目录内文件 */
function guardedAbsPath(ctx: Ctx, artifact: ArtifactRow, rel?: string): string {
  const base = normalize(join(ctx.root, artifact.path))
  if (!rel) return base
  const target = normalize(join(base, rel))
  // startsWith 会放过共享前缀的兄弟目录(docs/prd → docs/prd-x),用 relative 严判
  const r = relative(base, target)
  if (r === "" || r === "." || r.startsWith("..") || isAbsolute(r)) {
    throw Object.assign(new Error("路径越界"), { statusCode: 403 })
  }
  return target
}

export async function createServer(ctx: Ctx): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(fastifyCors, { origin: true })

  // 写保护(config.server.authToken 配置后生效):写端点要求共享口令;读端点保持开放(观测不设卡)。
  // 「人审不外包」不变式的 HTTP 侧兜底——serve 默认对局域网开放,没有它任何人都能以任意 actor 审批。
  const authToken = ctx.config.server?.authToken
  if (authToken) {
    app.addHook("preHandler", async (req, reply) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return
      if (req.headers["x-workbench-token"] !== authToken) {
        return reply.code(401).send({ error: "缺少或错误的 x-workbench-token(该工作台已启用写保护)" })
      }
    })
  }

  const webDist = join(WORKBENCH_DIR, "web/dist")
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
  }

  // 原型静态服务:iframe 直接指向原型文件的真实相对路径,HTML 里的相对资源(css/js/img)
  // 才能正确解析。静态根由 kind 注册表的 prototype.pathPatterns[0] 推导(单一真相源——
  // 项目覆盖 pathPatterns 后,/proto 与 previewUrl 自动跟随,前端不再自行解析路径)。
  // 作用域仅限原型子树,不暴露整个项目(默认 0.0.0.0 下尤为重要)。
  const protoPattern = getKindRegistry(ctx.config).prototype.pathPatterns?.[0]
  const protoRel = (protoPattern ? expandPattern(protoPattern, ctx.config) : `${ctx.config.docs.design}/prototypes/`).replace(/\/+$/, "")
  const protoRoot = join(ctx.root, protoRel)
  mkdirSync(protoRoot, { recursive: true })
  await app.register(fastifyStatic, { root: protoRoot, prefix: "/proto/", decorateReply: false })
  /** 产物 → 预览地址(在原型根内才有;单一真相源,前端直接用) */
  const previewUrlOf = (a: ArtifactRow): string | null =>
    a.path.startsWith(protoRel + "/") ? encodeURI(`/proto/${a.path.slice(protoRel.length + 1)}`) : null

  app.get("/api/meta", async () => ({
    root: ctx.root,
    language: ctx.config.language,
    pipeline: ctx.config.pipeline,
    endpoints: ctx.config.endpoints,
    approvalMode: ctx.config.gates.approvalMode
  }))

  app.get<{ Querystring: { includeMeta?: string } }>("/api/tree", async req => {
    return buildTree(ctx, { includeMeta: req.query.includeMeta === "1" })
  })

  app.get<{ Querystring: { module?: string; endpoint?: string; page?: string; includeMeta?: string } }>(
    "/api/node",
    async req => {
      const { module, endpoint, page, includeMeta } = req.query
      const isBucket = module === "__project__" || module === "__meta__"
      return nodeDetail(ctx, {
        module: isBucket ? null : module,
        endpoint: endpoint || null,
        page: page || null,
        includeMeta: includeMeta === "1",
        metaOnly: module === "__meta__"
      })
    }
  )

  app.get<{ Params: { id: string } }>("/api/artifact/:id", async req => {
    const artifact = getArtifact(ctx, parseInt(req.params.id))
    const abs = guardedAbsPath(ctx, artifact)
    const feedback = ctx.db
      .prepare("SELECT * FROM artifact_feedback WHERE artifact_id = ? ORDER BY id DESC")
      .all(artifact.id)
    const events = listEvents(ctx.db, { entityType: "artifact", entityId: artifact.id, limit: 50 })

    let content: string | null = null
    let isDirectory = false
    let missing = false
    if (!existsSync(abs)) {
      missing = true
    } else if (statSync(abs).isDirectory()) {
      isDirectory = true
    } else if (statSync(abs).size <= MAX_INLINE_SIZE) {
      content = readFileSync(abs, "utf-8")
    }
    return { artifact, content, isDirectory, missing, feedback, events, previewUrl: previewUrlOf(artifact) }
  })

  app.get<{ Params: { id: string } }>("/api/artifact/:id/files", async req => {
    const artifact = getArtifact(ctx, parseInt(req.params.id))
    const base = guardedAbsPath(ctx, artifact)
    const files: { rel: string; size: number }[] = []
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(dir).sort()) {
        if (name === "node_modules" || name.startsWith(".")) continue
        const full = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        const st = statSync(full)
        if (st.isDirectory()) walk(full, relPath)
        else files.push({ rel: relPath, size: st.size })
      }
    }
    if (existsSync(base) && statSync(base).isDirectory()) walk(base, "")
    return { files }
  })

  app.get<{ Params: { id: string }; Querystring: { rel: string } }>("/api/artifact/:id/file", async req => {
    const artifact = getArtifact(ctx, parseInt(req.params.id))
    const abs = guardedAbsPath(ctx, artifact, req.query.rel)
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      throw Object.assign(new Error("文件不存在"), { statusCode: 404 })
    }
    if (statSync(abs).size > MAX_INLINE_SIZE) {
      throw Object.assign(new Error("文件过大"), { statusCode: 413 })
    }
    return { rel: req.query.rel, content: readFileSync(abs, "utf-8") }
  })

  app.get<{ Querystring: { afterId?: string; module?: string; limit?: string } }>("/api/events", async req => {
    return listEvents(ctx.db, {
      afterId: req.query.afterId ? parseInt(req.query.afterId) : undefined,
      module: req.query.module,
      limit: req.query.limit ? parseInt(req.query.limit) : 100
    })
  })

  // SSE:500ms 轮询 events 游标,新事件即推(实时性不依赖 fs watch)
  app.get("/api/sse", (req, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*"
    })
    let cursor =
      (ctx.db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number | null }).id ?? 0
    reply.raw.write(`event: hello\ndata: {"cursor":${cursor}}\n\n`)

    const timer = setInterval(() => {
      try {
        const rows = listEvents(ctx.db, { afterId: cursor, limit: 200 })
        if (rows.length > 0) {
          cursor = rows[rows.length - 1].id
          reply.raw.write(`data: ${JSON.stringify(rows)}\n\n`)
        }
      } catch {
        /* fail-open:观测通道失败不挡路 */
      }
    }, 500)

    req.raw.on("close", () => clearInterval(timer))
  })

  // ─── 写 API:全部走 commands 层,gate 错误原样回传 ───────────

  // ─── 关系图:节点 + 边(含来源),供画布渲染 ───────────
  app.get("/api/graph", async () => {
    const registry = getKindRegistry(ctx.config)
    const rows = (ctx.db.prepare("SELECT * FROM artifacts ORDER BY id").all() as ArtifactRow[]).filter(
      a => !registry[a.kind]?.meta
    )
    const ids = new Set(rows.map(a => a.id))
    const nodes = rows.map(a => ({
      id: a.id,
      kind: a.kind,
      path: a.path,
      module: a.module,
      endpoint: a.endpoint,
      page: a.page,
      review_status: reviewStatus(a),
      missing: !existsSync(join(ctx.root, a.path))
    }))
    const edges = (
      ctx.db.prepare("SELECT id, from_id, to_id, source FROM artifact_edges").all() as {
        id: number
        from_id: number
        to_id: number
        source: string
      }[]
    ).filter(e => ids.has(e.from_id) && ids.has(e.to_id))
    return { nodes, edges }
  })

  // 名字索引:已登记产物(SQL LIKE)+ 未登记文件(全项目 walk,排噪声目录,各限 30)
  app.get<{ Querystring: { q?: string } }>("/api/search", async req => {
    const q = (req.query.q ?? "").trim().toLowerCase()
    if (!q) return { artifacts: [], files: [] }
    const like = `%${q.replace(/[%_\\]/g, c => "\\" + c)}%`
    const artifacts = (
      ctx.db
        .prepare("SELECT * FROM artifacts WHERE path LIKE ? ESCAPE '\\' ORDER BY path LIMIT 30")
        .all(like) as ArtifactRow[]
    ).map(a => ({ id: a.id, kind: a.kind, path: a.path, module: a.module, endpoint: a.endpoint, review_status: reviewStatus(a) }))
    const registered = new Set((ctx.db.prepare("SELECT path FROM artifacts").all() as { path: string }[]).map(r => r.path))
    const files: string[] = []
    const walk = (dir: string, rel: string) => {
      if (files.length >= 30) return
      for (const name of readdirSync(dir).sort()) {
        if (files.length >= 30) return
        if (name.startsWith(".") || name === "node_modules" || name === "dist" || name === "build") continue
        const full = join(dir, name)
        const relPath = rel ? `${rel}/${name}` : name
        if (statSync(full).isDirectory()) walk(full, relPath)
        else if (relPath.toLowerCase().includes(q) && !registered.has(relPath)) files.push(relPath)
      }
    }
    walk(ctx.root, "")
    return { artifacts, files }
  })

  // 拖入未登记文件 → 按需登记为产物(幂等)
  app.post<{ Body: { path: string; actor?: string } }>("/api/artifact/register", async req => {
    return registerAdHocArtifact(ctx, req.body.path, req.body.actor || "user")
  })

  // 手动声明关系(source=manual):参与失效传播(spawnReviews 沿边表,不区分来源)
  app.post<{ Body: { fromId: number; toId: number; actor?: string } }>("/api/edge", async (req, reply) => {
    const { fromId, toId } = req.body
    const actor = req.body.actor || "user"
    if (!fromId || !toId || fromId === toId) {
      return reply.code(400).send({ error: "无效的边:需要两个不同的产物" })
    }
    const has = (id: number) => (ctx.db.prepare("SELECT COUNT(*) c FROM artifacts WHERE id = ?").get(id) as { c: number }).c > 0
    if (!has(fromId) || !has(toId)) return reply.code(404).send({ error: "产物不存在" })

    // 环检测:从 toId 沿边下行可达 fromId → 拒绝
    const seen = new Set<number>([toId])
    const queue = [toId]
    const next = ctx.db.prepare("SELECT to_id FROM artifact_edges WHERE from_id = ?")
    while (queue.length) {
      const cur = queue.pop()!
      for (const row of next.all(cur) as { to_id: number }[]) {
        if (row.to_id === fromId) return reply.code(400).send({ error: "会形成环,已拒绝" })
        if (!seen.has(row.to_id)) {
          seen.add(row.to_id)
          queue.push(row.to_id)
        }
      }
    }

    const r = ctx.db.prepare("INSERT OR IGNORE INTO artifact_edges (from_id, to_id, source) VALUES (?, ?, 'manual')").run(fromId, toId)
    if (r.changes === 0) return reply.code(409).send({ error: "该关系已存在" })
    logEvent(ctx.db, { entityType: "artifact", entityId: toId, event: "edge_added", actor, payload: { fromId, toId, source: "manual" } })
    return { id: r.lastInsertRowid as number, fromId, toId, source: "manual" }
  })

  // 取消登记:仅限"无信任痕迹"的产物(未审批过、未被任务引用、无反馈)——手动误登记的撤销出口。
  // 已进入信任机器的产物绝不硬删(审批/归因历史是资产);docs 树内的文件删除登记后下次 scan 会重新登记。
  app.delete<{ Params: { id: string }; Body: { actor?: string } | null }>("/api/artifact/:id", async (req, reply) => {
    const id = parseInt(req.params.id)
    const row = ctx.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined
    if (!row) return reply.code(404).send({ error: "产物不存在" })
    if (row.approved_hash !== null) return reply.code(403).send({ error: "该产物有审批历史,不可取消登记" })
    const refs = ctx.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM task_inputs WHERE artifact_id = ?) +
                (SELECT COUNT(*) FROM task_outputs WHERE artifact_id = ?) +
                (SELECT COUNT(*) FROM artifact_feedback WHERE artifact_id = ?) AS c`
      )
      .get(id, id, id) as { c: number }
    if (refs.c > 0) return reply.code(403).send({ error: "该产物已被任务/反馈引用,不可取消登记" })
    const tx = ctx.db.transaction(() => {
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: id,
        event: "unregistered",
        actor: req.body?.actor || "user",
        payload: { path: row.path, kind: row.kind },
        module: row.module,
        endpoint: row.endpoint,
        page: row.page
      })
      ctx.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id) // 边随 FK 级联删除
    })
    tx()
    return { ok: true }
  })

  // 解绑:仅 manual;derived 由 scan 对账维护,解了也会被推导回来,故直接禁止
  app.delete<{ Params: { id: string }; Body: { actor?: string } | null }>("/api/edge/:id", async (req, reply) => {
    const id = parseInt(req.params.id)
    const edge = ctx.db.prepare("SELECT * FROM artifact_edges WHERE id = ?").get(id) as
      | { id: number; from_id: number; to_id: number; source: string }
      | undefined
    if (!edge) return reply.code(404).send({ error: "边不存在" })
    if (edge.source !== "manual") return reply.code(403).send({ error: "自动推导的关系不可解绑(由 scan 按坐标事实维护)" })
    ctx.db.prepare("DELETE FROM artifact_edges WHERE id = ?").run(id)
    logEvent(ctx.db, {
      entityType: "artifact",
      entityId: edge.to_id,
      event: "edge_removed",
      actor: req.body?.actor || "user",
      payload: { fromId: edge.from_id, toId: edge.to_id }
    })
    return { ok: true }
  })

  app.get("/api/review-queue", async () => {
    // 前端依赖 ever_approved(区分"复审中"与首次待审),与 nodeDetail 同口径补齐
    return listArtifacts(ctx, {})
      .filter(r => r.review_status === "pending" || r.review_status === "invalidated")
      .map(r => ({
        ...r,
        ever_approved: everApproved(r),
        endorsed: r.kind === "prototype" ? prototypeEndorsed(ctx.db, r) : false
      }))
  })

  // 反馈进化:加权提炼出的经验候选 / red-flag 组(确定性,复用 retro.command)
  app.get("/api/skill-candidates", async () => {
    const report = runRetrospective(ctx)
    return {
      groups: report.groups.filter(g => g.bucket === "candidate" || g.bucket === "red-flag"),
      candidates: report.candidates,
      redFlags: report.redFlags,
      halfLifeDays: report.halfLifeDays,
      guidance: report.guidance
    }
  })

  app.get<{ Params: { id: string } }>("/api/artifact/:id/diff", async req => {
    const artifact = getArtifact(ctx, parseInt(req.params.id))
    const abs = guardedAbsPath(ctx, artifact)
    const current = existsSync(abs) && !statSync(abs).isDirectory() ? readFileSync(abs, "utf-8") : null
    return { approved: approvedContent(ctx, artifact.id), current }
  })

  app.post<{ Params: { id: string }; Body: { actor: string; trivial?: boolean } }>(
    "/api/artifact/:id/approve",
    async req => approveArtifact(ctx, { id: parseInt(req.params.id) }, req.body.actor, { trivial: req.body.trivial })
  )

  app.post<{ Params: { id: string }; Body: { actor: string; reason: string } }>(
    "/api/artifact/:id/reject",
    async req => rejectArtifact(ctx, { id: parseInt(req.params.id) }, req.body.actor, req.body.reason)
  )

  app.post<{ Params: { id: string }; Body: { actor: string } }>("/api/artifact/:id/submit", async req =>
    submitArtifact(ctx, { id: parseInt(req.params.id) }, req.body.actor)
  )

  app.post<{ Params: { id: string }; Body: { actor: string; verdict: 1 | -1; comment?: string } }>(
    "/api/artifact/:id/feedback",
    async req =>
      feedbackArtifact(ctx, { id: parseInt(req.params.id) }, {
        verdict: req.body.verdict,
        comment: req.body.comment,
        actor: req.body.actor
      })
  )

  app.post("/api/sync", async () => syncArtifacts(ctx, "opcflow"))

  app.post<{ Params: { id: string }; Body: { assignee: string } }>("/api/task/:id/claim", async req =>
    claimTask(ctx, { id: parseInt(req.params.id), assignee: req.body.assignee })
  )

  app.post<{ Params: { id: string }; Body: { status: string; operator: string; force?: boolean } }>(
    "/api/task/:id/status",
    async req =>
      updateTask(ctx, {
        id: parseInt(req.params.id),
        status: req.body.status,
        operator: req.body.operator,
        force: req.body.force
      })
  )

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; message?: string }
    reply.code(e.statusCode ?? 500).send({ error: e.message ?? String(err) })
  })

  return app
}
