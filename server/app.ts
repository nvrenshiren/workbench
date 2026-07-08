import fastifyCors from "@fastify/cors"
import fastifyStatic from "@fastify/static"
import Fastify, { type FastifyInstance } from "fastify"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
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
import { syncArtifacts } from "../core/commands/sync.command"
import { WORKBENCH_DIR } from "../core/config"
import { claimTask, updateTask } from "../core/commands/task.commands"
import { everApproved, prototypeEndorsed } from "../core/derive"
import { listEvents } from "../core/events"
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

  const webDist = join(WORKBENCH_DIR, "web/dist")
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
  }

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
    return { artifact, content, isDirectory, missing, feedback, events }
  })

  app.get<{ Params: { id: string } }>("/api/artifact/:id/raw", async (req, reply) => {
    const artifact = getArtifact(ctx, parseInt(req.params.id))
    const abs = guardedAbsPath(ctx, artifact)
    if (!existsSync(abs) || statSync(abs).isDirectory()) {
      return reply.code(404).send("not found")
    }
    reply.header("content-type", artifact.path.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8")
    return reply.send(readFileSync(abs))
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
