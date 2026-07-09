import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { logEvent } from "../events"
import { hashPath } from "../hash"
import { expandPattern, getKindRegistry, inferKind, normalizeModule, type KindLevel } from "../kind"
import type { ArtifactKind, ArtifactRow, Ctx } from "../types"
import { refreshArtifact } from "./artifact.commands"

export interface ScanSummary {
  registered: number
  refreshed: number
  /** 坐标随 config 收敛(moduleMapping / kind 覆盖等)而重挂的行数 */
  remapped: number
  edges: number
  /** 对账清理的残留 derived 边数(manual 永不计入) */
  edgesPruned: number
  /** 重命名/移动检测:同 hash 唯一候选自动跟随的行数 */
  moved: number
  skipped: string[]
  /** 命中 kind 但路径不符 coords 文法(非规范 / 废弃端等),未登记 —— 让被丢弃的可见,不静默 mis-file */
  unresolved: string[]
}

interface Coords {
  module: string | null
  endpoint: string | null
  page: string | null
}

const stripExt = (s: string): string => s.replace(/\.(md|html)$/i, "")

/**
 * 按 kind 的 coords 文法解析坐标(相对 pathPatterns[0] 前缀)。
 * - 无 coords 文法 → 全 null 坐标(baseline/project/code 等,照常登记);
 * - 单占位符 `{X}` → 绑定叶子文件名(忽略中间目录):复现 flow/module-prd/db/api「模块=文件名」、
 *   design-system「端=文件名」;endpoint 缺省用 defaultEndpoint;
 * - 多段 `{endpoint}/{module}/{page}` → 从前缀起按位,`{page}` 贪婪吃尾,`page` 存 `{module}/{页尾}`;
 *   捕获的 `{endpoint}` 必须 ∈ config.endpoints,否则返回 null(交调用方 warn/skip,丢弃 pc/old 这类非规范/废弃端)。
 * 返回 null = 命中 kind 但不符文法,不登记。
 */
function parseCoords(ctx: Ctx, kind: ArtifactKind, relPath: string): Coords | null {
  const none: Coords = { module: null, endpoint: null, page: null }
  const spec = getKindRegistry(ctx.config)[kind]
  const grammar = spec?.coords
  if (!grammar) return none

  const prefix = spec.pathPatterns?.[0] ? expandPattern(spec.pathPatterns[0], ctx.config) : ""
  const tail = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath
  const tailSegs = tail.split("/").filter(Boolean)
  const gSegs = grammar.split("/")
  const defEnd = spec.defaultEndpoint ?? null
  const mod = (raw: string) => normalizeModule(raw, ctx.config)

  // 单占位符:绑定叶子文件名,忽略中间目录
  if (gSegs.length === 1) {
    if (tailSegs.length === 0) return null
    const leaf = stripExt(tailSegs[tailSegs.length - 1])
    if (gSegs[0] === "{module}") return { module: mod(leaf), endpoint: defEnd, page: null }
    if (gSegs[0] === "{endpoint}") return { module: null, endpoint: leaf, page: null }
    return none
  }

  // 多段:从前缀起按位;{page} 贪婪吃尾
  const hasPage = gSegs[gSegs.length - 1] === "{page}"
  const fixed = hasPage ? gSegs.length - 1 : gSegs.length
  if (hasPage ? tailSegs.length < gSegs.length : tailSegs.length !== gSegs.length) return null

  const cap: Record<string, string> = {}
  for (let i = 0; i < fixed; i++) cap[gSegs[i]] = stripExt(tailSegs[i])

  // endpoint 锚定护栏:多段捕获的端必须是已声明端,否则丢弃(非规范 / 已删端)
  if (cap["{endpoint}"] !== undefined && !ctx.config.endpoints.includes(cap["{endpoint}"])) return null

  const endpoint = cap["{endpoint}"] ?? defEnd
  const module = cap["{module}"] !== undefined ? mod(cap["{module}"]) : null

  let page: string | null = null
  if (hasPage) {
    const pageSegs = tailSegs.slice(fixed)
    const pageTail = pageSegs.map((s, i) => (i === pageSegs.length - 1 ? stripExt(s) : s)).join("/")
    page = module ? `${module}/${pageTail}` : pageTail
  }
  return { module, endpoint, page }
}

function isMetaPath(ctx: Ctx, relPath: string): boolean {
  const registry = getKindRegistry(ctx.config)
  for (const spec of Object.values(registry)) {
    if (!spec.meta) continue
    for (const pattern of spec.pathPatterns ?? []) {
      if (pattern.endsWith("/") ? relPath.startsWith(pattern) : relPath === pattern) return true
    }
  }
  return false
}

function walkFiles(absDir: string, rel: string, out: string[]) {
  for (const name of readdirSync(absDir).sort()) {
    if (name.startsWith(".") || name === "node_modules") continue
    const full = join(absDir, name)
    const relPath = `${rel}/${name}`
    if (statSync(full).isDirectory()) {
      walkFiles(full, relPath, out)
    } else if (/\.(md|html)$/i.test(name)) {
      out.push(relPath)
    }
  }
}

/** codeRoots 模式展开:占位符段(如 {client}/{module})逐层枚举目录,{module} 段捕获模块名 */
function expandCodeRoots(ctx: Ctx): { dir: string; endpoint: string; module: string }[] {
  const results: { dir: string; endpoint: string; module: string }[] = []
  for (const [endpoint, patterns] of Object.entries(ctx.config.codeRoots)) {
    for (const pattern of patterns) {
      const segments = pattern.replace(/\\/g, "/").split("/")
      let candidates: { dir: string; module: string | null }[] = [{ dir: "", module: null }]
      for (const segment of segments) {
        const next: { dir: string; module: string | null }[] = []
        // 占位符段:`{module}` = 目录段(枚举子目录);`{module}.<ext>` = 文件段
        // (枚举匹配后缀的文件,模块名 = 去后缀的文件名,如 account.prisma → account)。
        const ph = /^\{(\w+)\}(.*)$/.exec(segment)
        for (const c of candidates) {
          if (ph) {
            const [, placeholder, suffix] = ph
            const abs = join(ctx.root, c.dir)
            if (!existsSync(abs)) continue
            for (const name of readdirSync(abs).sort()) {
              const isDir = statSync(join(abs, name)).isDirectory()
              if (suffix === "" ? !isDir : isDir || !name.endsWith(suffix)) continue
              const captured = suffix === "" ? name : name.slice(0, -suffix.length)
              next.push({ dir: c.dir ? `${c.dir}/${name}` : name, module: placeholder === "module" ? captured : c.module })
            }
          } else {
            next.push({ dir: c.dir ? `${c.dir}/${segment}` : segment, module: c.module })
          }
        }
        candidates = next
      }
      for (const c of candidates) {
        if (c.module && existsSync(join(ctx.root, c.dir))) {
          results.push({ dir: c.dir, endpoint, module: normalizeModule(c.module, ctx.config)! })
        }
      }
    }
  }
  return results
}

/** 按 parents 推导 DAG 边(对账式):重算期望 derived 边集,补缺失、删残留;manual 边永不动 */
export function deriveEdges(ctx: Ctx): { created: number; pruned: number } {
  const registry = getKindRegistry(ctx.config)
  const artifacts = ctx.db.prepare("SELECT * FROM artifacts").all() as ArtifactRow[]
  const nonMeta = artifacts.filter(a => !registry[a.kind]?.meta)

  const byKind = new Map<ArtifactKind, ArtifactRow[]>()
  for (const a of nonMeta) {
    const list = byKind.get(a.kind) ?? []
    list.push(a)
    byKind.set(a.kind, list)
  }

  // 期望集:上游坐标按其 level 与下游坐标对齐(下游更粗时放宽到共有坐标)
  const expected = new Set<string>()
  for (const child of nonMeta) {
    const parents = registry[child.kind]?.parents ?? []
    for (const parentKind of parents) {
      const level: KindLevel = registry[parentKind]?.level ?? "module"
      const candidates = (byKind.get(parentKind) ?? []).filter(p => {
        if ((level === "module" || level === "page") && child.module && p.module !== child.module) return false
        if ((level === "endpoint" || level === "page") && child.endpoint && p.endpoint !== child.endpoint) return false
        if (level === "page" && child.page && p.page !== child.page) return false
        return true
      })
      for (const parent of candidates) expected.add(`${parent.id}|${child.id}`)
    }
  }

  const existing = ctx.db.prepare("SELECT id, from_id, to_id, source FROM artifact_edges").all() as {
    id: number
    from_id: number
    to_id: number
    source: string
  }[]
  const have = new Set(existing.map(e => `${e.from_id}|${e.to_id}`))
  const insert = ctx.db.prepare("INSERT OR IGNORE INTO artifact_edges (from_id, to_id, source) VALUES (?, ?, 'derived')")
  const del = ctx.db.prepare("DELETE FROM artifact_edges WHERE id = ?")

  let created = 0
  let pruned = 0
  const tx = ctx.db.transaction(() => {
    for (const key of expected) {
      if (have.has(key)) continue // 已存在(含 manual 占位:用户所有权优先,不升格)
      const [from, to] = key.split("|")
      created += insert.run(Number(from), Number(to)).changes
    }
    for (const e of existing) {
      if (e.source !== "derived") continue
      if (!expected.has(`${e.from_id}|${e.to_id}`)) pruned += del.run(e.id).changes
    }
  })
  tx()
  return { created, pruned }
}

/**
 * 全量扫描登记:docs 树 + baseline + codeRoots 目录级;
 * 已登记文件走 refresh(hash 对账),元产物路径排除(走 register-meta);
 * 收尾统一推导 DAG 边。幂等。
 */
export function scanArtifacts(ctx: Ctx, actor = "system"): ScanSummary {
  const summary: ScanSummary = { registered: 0, refreshed: 0, remapped: 0, edges: 0, edgesPruned: 0, moved: 0, skipped: [], unresolved: [] }

  const files: string[] = []
  for (const dir of Object.values(ctx.config.docs)) {
    const abs = join(ctx.root, dir)
    if (existsSync(abs)) walkFiles(abs, dir, files)
  }
  for (const p of ["ARCHITECTURE.md", "TECH.md"]) {
    if (existsSync(join(ctx.root, p))) files.push(p)
  }

  const exists = ctx.db.prepare(
    "SELECT id, kind, module, endpoint, page, content_hash FROM artifacts WHERE path = ?"
  )
  const remap = ctx.db.prepare(
    "UPDATE artifacts SET kind = ?, module = ?, endpoint = ?, page = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  )
  const insert = ctx.db.prepare(
    "INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash) VALUES (?, ?, ?, ?, ?, ?)"
  )

  type ExistingRow = {
    id: number
    kind: ArtifactKind
    module: string | null
    endpoint: string | null
    page: string | null
    content_hash: string
  }

  const registerOne = (relPath: string, kind: ArtifactKind, coords: Coords | null) => {
    const row = exists.get(relPath) as ExistingRow | undefined
    if (row) {
      const before = row.content_hash
      const after = refreshArtifact(ctx, { id: row.id }, actor)
      if (after.content_hash !== before) summary.refreshed++

      // 坐标随 config 收敛:path 不变但 moduleMapping / kind 覆盖等使 kind/坐标漂移时重挂。
      // 内容 hash 不参与 → 审批锚点(approved_hash vs content_hash)不受影响。
      // coords 为 null(现约定下不再可解析)→ 不动坐标,保持已登记状态。
      if (coords && (row.kind !== kind || row.module !== coords.module || row.endpoint !== coords.endpoint || row.page !== coords.page)) {
        const tx = ctx.db.transaction(() => {
          remap.run(kind, coords.module, coords.endpoint, coords.page, row.id)
          logEvent(ctx.db, {
            entityType: "artifact",
            entityId: row.id,
            event: "coords_remapped",
            actor,
            payload: {
              path: relPath,
              from: { kind: row.kind, module: row.module, endpoint: row.endpoint, page: row.page },
              to: { kind, module: coords.module, endpoint: coords.endpoint, page: coords.page }
            },
            module: coords.module,
            endpoint: coords.endpoint,
            page: coords.page
          })
        })
        tx()
        summary.remapped++
      }
      return
    }
    // 新文件但坐标无法解析(命中 kind、路径不符 coords 文法)→ 不登记,记入 unresolved 让其可见
    if (!coords) {
      summary.unresolved.push(relPath)
      return
    }
    const hash = hashPath(join(ctx.root, relPath))
    if (hash === null) return

    // 重命名/移动检测:同 hash、同 kind、原路径已消失的唯一候选 → 按 move 跟随(保 id,
    // 审批锚点 approved_hash vs content_hash 不受影响;边是 id 基的,关系自动存活)。
    // 候选不唯一(空文件/模板复制)或 kind 不同(跨文档根移动)→ 保守回退为新登记。
    const movedFrom = (ctx.db.prepare("SELECT * FROM artifacts WHERE content_hash = ? AND kind = ?").all(hash, kind) as ArtifactRow[])
      .filter(a => !existsSync(join(ctx.root, a.path)))
    if (movedFrom.length === 1) {
      const old = movedFrom[0]
      const tx = ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE artifacts SET path = ?, module = ?, endpoint = ?, page = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(relPath, coords.module, coords.endpoint, coords.page, old.id)
        logEvent(ctx.db, {
          entityType: "artifact",
          entityId: old.id,
          event: "auto_moved",
          actor,
          payload: { from: old.path, to: relPath },
          module: coords.module,
          endpoint: coords.endpoint,
          page: coords.page
        })
      })
      tx()
      summary.moved++
      return
    }
    const tx = ctx.db.transaction(() => {
      const result = insert.run(kind, coords.module, coords.endpoint, coords.page, relPath, hash)
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: result.lastInsertRowid as number,
        event: "scan_registered",
        actor,
        payload: { path: relPath, kind },
        module: coords.module,
        endpoint: coords.endpoint,
        page: coords.page
      })
    })
    tx()
    summary.registered++
  }

  for (const relPath of files) {
    if (isMetaPath(ctx, relPath)) {
      summary.skipped.push(relPath)
      continue
    }
    const kind = inferKind(relPath, ctx.config)
    registerOne(relPath, kind, parseCoords(ctx, kind, relPath))
  }

  for (const code of expandCodeRoots(ctx)) {
    registerOne(code.dir, "code", { module: code.module, endpoint: code.endpoint, page: null })
  }

  const edgeResult = deriveEdges(ctx)
  summary.edges = edgeResult.created
  summary.edgesPruned = edgeResult.pruned
  return summary
}
