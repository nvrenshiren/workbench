import { resolvePlatforms } from "./platforms"
import type { ArtifactKind, Language, WorkbenchConfig } from "./types"

// ─── kind 注册表 ───────────────────────

export type KindHashMode = "text-normalize" | "binary" | "directory"
export type KindApproval = "human" | "thumbs" | "machine" | "none"
export type KindRetrieval = "full" | "summary" | "semantic"
export type KindLevel = "project" | "module" | "endpoint" | "page"

export interface KindSpec {
  /** 坐标层级:该 kind 产物挂在树的哪一层 */
  level: KindLevel
  /** 审批通道:human=人审 / thumbs=👍合一 / machine=机器检查+QA / none=仅登记 */
  approval: KindApproval
  /** DAG 上游 kind(边推导与 gate 上游选择器的共同依据) */
  parents: ArtifactKind[]
  /** 是否驱动下游 stale(进 task_inputs 即生效) */
  drivesStale: boolean
  /** hash 归一策略 */
  hashMode: KindHashMode
  /** 上下文装配层级:full=全文注入 / summary=摘要注入 / semantic=语义检索提案 */
  retrieval: KindRetrieval
  /**
   * 路径约定:{prd}/{architecture}/{design}/{acceptance} 占位符由 config.docs 展开;
   * 以 / 结尾 = 前缀匹配,否则精确匹配。按注册表插入顺序首匹配生效。
   */
  pathPatterns?: string[]
  /**
   * 坐标文法(相对 pathPatterns[0] 前缀,占位符 {module}/{endpoint}/{page}):
   * - 单占位符 `{X}` → 绑定叶子文件名(忽略中间目录),复现「模块=文件名」类约定;
   * - 多段如 `{endpoint}/{module}/{page}` → 从前缀起按位匹配,`{page}` 贪婪吃尾,
   *   捕获的 `{endpoint}` 必须 ∈ config.endpoints,否则该文件不解析(warn/skip)。
   * 缺省时该 kind 不解析坐标(module/endpoint/page 全 null,仍照常登记)。
   * 项目层经 config.kinds 覆盖即可自定义内层目录约定。
   */
  coords?: string
  /** coords 未捕获 {endpoint} 时的固定端(如 db-doc=common、api-doc=service) */
  defaultEndpoint?: string
  /** 该 kind 产物的文件扩展名(缺省 md;prototype=html)——路径投影 kindPathTemplate 用 */
  ext?: string
  /** 元产物:业务树默认过滤,scan 排除(走显式 register-meta) */
  meta?: boolean
}

export const DEFAULT_KIND_REGISTRY: Record<ArtifactKind, KindSpec> = {
  // 元产物在前:与业务路径无重叠,但显式优先更稳
  "agent-def": { level: "project", approval: "human", parents: [], drivesStale: false, hashMode: "text-normalize", retrieval: "full", meta: true, pathPatterns: [".claude/agents/"] },
  skill: { level: "project", approval: "human", parents: [], drivesStale: false, hashMode: "text-normalize", retrieval: "full", meta: true, pathPatterns: [".claude/skills/"] },
  "hook-script": { level: "project", approval: "human", parents: [], drivesStale: false, hashMode: "text-normalize", retrieval: "full", meta: true, pathPatterns: [".claude/hooks/"] },
  plan: { level: "project", approval: "human", parents: [], drivesStale: false, hashMode: "text-normalize", retrieval: "summary", meta: true, pathPatterns: ["docs/workbench/PLAN.md"] },

  baseline: { level: "project", approval: "human", parents: [], drivesStale: true, hashMode: "text-normalize", retrieval: "summary", pathPatterns: ["ARCHITECTURE.md", "TECH.md"] },
  project: { level: "project", approval: "human", parents: [], drivesStale: true, hashMode: "text-normalize", retrieval: "summary", pathPatterns: ["{prd}/project.md"] },
  roles: { level: "project", approval: "human", parents: ["project"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{prd}/roles.md"] },
  glossary: { level: "project", approval: "human", parents: ["project"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{prd}/glossary.md"] },
  flow: { level: "module", approval: "human", parents: ["project", "roles", "glossary"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{prd}/flows/"], coords: "{module}", defaultEndpoint: "common" },
  "module-prd": { level: "module", approval: "human", parents: ["flow"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{prd}/modules/"], coords: "{module}", defaultEndpoint: "common" },
  "page-prd": { level: "page", approval: "human", parents: ["module-prd"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{prd}/pages/"], coords: "{endpoint}/{module}/{page}" },
  "db-doc": { level: "module", approval: "human", parents: ["module-prd"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{architecture}/database/"], coords: "{module}", defaultEndpoint: "common" },
  "api-doc": { level: "module", approval: "human", parents: ["module-prd", "db-doc"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{architecture}/api/"], coords: "{module}", defaultEndpoint: "service" },
  "design-system": { level: "endpoint", approval: "human", parents: ["baseline"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{design}/systems/"], coords: "{endpoint}" },
  "design-prompt": { level: "page", approval: "none", parents: ["page-prd", "api-doc", "design-system"], drivesStale: false, hashMode: "text-normalize", retrieval: "summary", pathPatterns: ["{design}/prompts/"], coords: "{endpoint}/{module}/{page}" },
  prototype: { level: "page", approval: "thumbs", parents: ["design-prompt", "design-system"], drivesStale: true, hashMode: "text-normalize", retrieval: "summary", pathPatterns: ["{design}/prototypes/"], coords: "{endpoint}/{module}/{page}", ext: "html" },
  acceptance: { level: "page", approval: "human", parents: ["page-prd", "prototype"], drivesStale: true, hashMode: "text-normalize", retrieval: "full", pathPatterns: ["{acceptance}/"], coords: "{endpoint}/{module}/{page}" },
  code: { level: "module", approval: "machine", parents: ["baseline", "api-doc", "prototype"], drivesStale: false, hashMode: "directory", retrieval: "semantic" },
  doc: { level: "module", approval: "none", parents: [], drivesStale: false, hashMode: "text-normalize", retrieval: "summary" }
}

/** 合并 config 覆盖 + 平台元产物路径展开后的注册表(项目层可改任意字段) */
export function getKindRegistry(config: WorkbenchConfig): Record<ArtifactKind, KindSpec> {
  const merged = { ...DEFAULT_KIND_REGISTRY }
  if (config.kinds) {
    for (const [kind, override] of Object.entries(config.kinds)) {
      const base = merged[kind as ArtifactKind]
      if (base) merged[kind as ArtifactKind] = { ...base, ...(override as Partial<KindSpec>) }
    }
  }
  // 元产物路径按目标平台动态展开:多平台同时生成时,各平台 agents/skills/hooks 目录都要能被识别
  const adapters = resolvePlatforms(config.platforms)
  const uniq = (xs: string[]) => [...new Set(xs)]
  merged["agent-def"] = { ...merged["agent-def"], pathPatterns: uniq(adapters.map(a => `${a.agentsDir}/`)) }
  merged.skill = { ...merged.skill, pathPatterns: uniq(adapters.map(a => `${a.skillsDir}/`)) }
  merged["hook-script"] = {
    ...merged["hook-script"],
    pathPatterns: uniq(adapters.map(a => a.hooksScanDir).filter((d): d is string => !!d).map(d => `${d}/`))
  }
  return merged
}

export function kindSpec(config: WorkbenchConfig, kind: ArtifactKind): KindSpec {
  return getKindRegistry(config)[kind] ?? DEFAULT_KIND_REGISTRY.doc
}

/** 元产物 kind 集(树过滤 / scan 排除用) */
export const META_KINDS: ArtifactKind[] = (Object.keys(DEFAULT_KIND_REGISTRY) as ArtifactKind[]).filter(
  k => DEFAULT_KIND_REGISTRY[k].meta
)

/** 契约类产物 = approval:human 且非元产物(派生,不再维护清单) */
export function contractKinds(config: WorkbenchConfig): ArtifactKind[] {
  const reg = getKindRegistry(config)
  return (Object.keys(reg) as ArtifactKind[]).filter(k => reg[k].approval === "human" && !reg[k].meta)
}

/** PM 角色的产出 kind 集(gate exist 级判定用,来自 roleProduces) */
export const PM_KINDS: ArtifactKind[] = ["project", "roles", "glossary", "flow", "module-prd", "page-prd"]

/** kind 层级:graph 分层展示用(展示顺序,非推导依据——推导走 parents) */
export const KIND_TIERS: ArtifactKind[][] = [
  ["baseline", "project", "roles", "glossary"],
  ["flow"],
  ["module-prd"],
  ["page-prd"],
  ["db-doc", "api-doc", "design-system"],
  ["design-prompt"],
  ["prototype", "acceptance"],
  ["code"]
]

export function expandPattern(pattern: string, config: WorkbenchConfig): string {
  return pattern
    .replace("{prd}", config.docs.prd)
    .replace("{architecture}", config.docs.architecture)
    .replace("{design}", config.docs.design)
    .replace("{acceptance}", config.docs.acceptance)
}

/** 坐标占位符的本地化(zh 模板用中文占位;en 保持原样) */
const COORD_LABELS_ZH: Record<string, string> = { "{module}": "{模块}", "{endpoint}": "{端}", "{page}": "{页面}" }

/**
 * 路径投影:由 kind 的 pathPatterns[0] 前缀 + coords 文法 + ext 渲染完整路径模板,
 * 注入 agent 指示(gen-agents 的 TPL_* token)——与 scan 的坐标解析共享同一真相源,
 * 项目覆盖 coords 后 agent 指示自动同步,不再出现"agent 按旧约定写、scan 按新文法拒收"。
 * 无 coords 文法(baseline/code 等)返回 null。
 * 已知例外:api-doc 的文法是叶子文件名(容忍任意中间目录),表达不了「{端}/ 子目录」惯例,
 * 其模板路径仍由模板散文手写。
 */
export function kindPathTemplate(config: WorkbenchConfig, kind: ArtifactKind, lang: Language): string | null {
  const spec = getKindRegistry(config)[kind]
  if (!spec?.coords || !spec.pathPatterns?.[0]) return null
  const prefix = expandPattern(spec.pathPatterns[0], config)
  const ext = spec.ext ?? "md"
  const segs = spec.coords.split("/").map(s => (lang === "zh" ? COORD_LABELS_ZH[s] ?? s : s))
  return `${prefix}${segs.join("/")}.${ext}`
}

/**
 * 按注册表 pathPatterns 推断产物 kind(首匹配生效);
 * 无匹配时的兜底:.html → prototype,.md → doc,其余 → code。
 */
export function inferKind(relPath: string, config: WorkbenchConfig): ArtifactKind {
  const p = relPath.replace(/\\/g, "/")
  const registry = getKindRegistry(config)
  for (const [kind, spec] of Object.entries(registry) as [ArtifactKind, KindSpec][]) {
    for (const raw of spec.pathPatterns ?? []) {
      const pattern = expandPattern(raw, config)
      if (pattern.endsWith("/") ? p.startsWith(pattern) : p === pattern) return kind
    }
  }
  if (p.endsWith(".html")) return "prototype"
  if (p.endsWith(".md")) return "doc"
  return "code"
}

/** fine → coarse 模块归并 */
export function normalizeModule(module: string | null | undefined, config: WorkbenchConfig): string | null {
  if (!module) return null
  return config.moduleMapping[module] ?? module
}
