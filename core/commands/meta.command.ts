import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { logEvent } from "../events"
import { hashPath } from "../hash"
import { inferKind } from "../kind"
import { resolvePlatforms } from "../platforms"
import type { ArtifactKind, Ctx, WorkbenchConfig } from "../types"
import { normalizeRelPath } from "./artifact.commands"

/**
 * 元产物 draft 注册(宪法第七条:驱动系统的文件不能游离于系统之外)。
 * draft 是零摩擦状态:无 approved_hash 即无失效级联,施工期白嫖变更留痕;
 * 审批时点分层——agent-def/skill/hook 于 M4 出口锚定,plan 于校准点过后锚定。
 * migrate scan 排除这些路径,元产物只走本命令显式注册。
 */
export interface RegisterMetaResult {
  registered: { path: string; kind: ArtifactKind }[]
  skipped: string[]
}

interface MetaSource {
  dir: string
  filter?: (name: string) => boolean
  recursive?: boolean
}

/** 元产物扫描源:按目标平台展开(agent/skill/hook 目录各平台不同),末尾追加 plan */
function metaSources(config: WorkbenchConfig): MetaSource[] {
  const seen = new Set<string>()
  const sources: MetaSource[] = []
  const add = (s: MetaSource) => {
    if (!seen.has(s.dir)) {
      seen.add(s.dir)
      sources.push(s)
    }
  }
  for (const a of resolvePlatforms(config.platforms)) {
    add({ dir: a.agentsDir, filter: n => n.endsWith(".md") || n.endsWith(".toml") })
    add({ dir: a.skillsDir, filter: n => n === "SKILL.md", recursive: true })
    if (a.hooksScanDir) add({ dir: a.hooksScanDir, recursive: true })
  }
  add({ dir: "docs/workbench", filter: n => n === "PLAN.md" })
  return sources
}

function collectFiles(root: string, dir: string, filter?: (n: string) => boolean, recursive?: boolean): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  const results: string[] = []
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const relPath = `${rel}/${name}`
      if (statSync(full).isDirectory()) {
        if (recursive) walk(full, relPath)
      } else if (!filter || filter(name)) {
        results.push(relPath)
      }
    }
  }
  walk(abs, dir)
  return results
}

export function registerMetaArtifacts(ctx: Ctx, actor = "system"): RegisterMetaResult {
  const result: RegisterMetaResult = { registered: [], skipped: [] }

  const files: string[] = []
  for (const src of metaSources(ctx.config)) {
    files.push(...collectFiles(ctx.root, src.dir, src.filter, src.recursive))
  }

  const insert = ctx.db.prepare(
    `INSERT INTO artifacts (kind, module, endpoint, page, path, content_hash) VALUES (?, NULL, NULL, NULL, ?, ?)`
  )
  const exists = ctx.db.prepare("SELECT id FROM artifacts WHERE path = ?")

  const tx = ctx.db.transaction(() => {
    for (const file of files) {
      const relPath = normalizeRelPath(ctx, file)
      if (exists.get(relPath)) {
        result.skipped.push(relPath)
        continue
      }
      const kind = inferKind(relPath, ctx.config)
      const hash = hashPath(join(ctx.root, relPath))
      if (hash === null) continue
      const inserted = insert.run(kind, relPath, hash)
      logEvent(ctx.db, {
        entityType: "artifact",
        entityId: inserted.lastInsertRowid as number,
        event: "meta_registered",
        actor,
        payload: { path: relPath, kind }
      })
      result.registered.push({ path: relPath, kind })
    }
  })
  tx()
  return result
}
