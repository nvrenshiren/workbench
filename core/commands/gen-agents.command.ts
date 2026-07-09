import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { WORKBENCH_DIR } from "../config"
import { getKindRegistry, kindPathTemplate } from "../kind"
import { type AgentSpec, resolveModel, resolvePlatforms } from "../platforms"
import type { ArtifactKind, Ctx } from "../types"

/**
 * 从中性模板生成各平台的 agent 定义:
 * - 路径不再手写在 prompt 里,由 kind 注册表展开注入 → agent 规则与路径约定单一真相源
 * - 共享块(信任协议/CLI 用法)集中一处,五个角色统一
 * - 模板解析成平台无关 AgentSpec,再由各平台 adapter 序列化(md+frontmatter / toml)
 * - 生成物是元产物(agent-def),draft 注册,经用户审批锚定
 */

function expandPath(ctx: Ctx, kind: ArtifactKind): string {
  const spec = getKindRegistry(ctx.config)[kind]
  const raw = spec?.pathPatterns?.[0] ?? ""
  return raw
    .replace("{prd}", ctx.config.docs.prd)
    .replace("{architecture}", ctx.config.docs.architecture)
    .replace("{design}", ctx.config.docs.design)
    .replace("{acceptance}", ctx.config.docs.acceptance)
}

const TRUST_PROTOCOL_ZH = `## 信任协议(最高优先级)

| 上游产物状态 | 你的行为 |
| --- | --- |
| approved | 视为真相直接使用;**禁止**重新推导、禁止向用户重复确认已拍板内容 |
| draft / pending(从未获批) | 可用,但产出中标注"基于未审文档";遇疑点停下来问 |
| pending 且曾获批(复审中) | **禁用**,等复审通过 |
| invalidated | **禁用**,停止并要求上游复审 |

状态查询:\`{{CLI}} artifacts --module=<模块>\`
对 approved 内容有实质异议时**禁止擅自偏离**,留痕后停止等用户裁决:
\`{{CLI}} dispute --actor=<角色> --reason="..." -- <文件路径>\``

const CLI_GUIDE_ZH = `## 任务操作

MCP 已注册时优先用 \`wb_*\` typed tools(与 CLI 同源同事务);CLI 等价:

\`\`\`bash
{{CLI}} list --role=<角色> --status=pending   # 查看待办
{{CLI}} claim <id> --assignee=<角色>          # 领取(gate 自动校验,依赖自动快照)
{{CLI}} input <id> --operator=<角色> -- <路径> # 补充申报 gate 之外读过的产物
{{CLI}} output --module=<模块> --role=<角色> --endpoint=<端> [--page=<模块>/<页面>] -- <路径>
{{CLI}} submit --actor=<角色> -- <路径>        # 契约类文档写完即送审
{{CLI}} update <id> --status=completed --operator=<角色>
{{CLI}} record <id> --operator=<角色> "备注"
\`\`\`

- 领取时 gate 报错都是**可行动的**:按提示等上游产出/审批,禁止绕过
- 任务 stale(上游变更)时 complete 会被拦截:先对齐变更;确认无影响才 \`--force=true\`(留痕)
- 产出必须**先写文件再登记**;登记会自动关联你领取的任务
- **git 归因**:领取任务后设置环境变量 \`WORKBENCH_TASK_ID=<任务id>\`,
  提交时 hook 自动注入 \`Task: #id\` trailer(多 agent 同分支的归因依据,不设即为孤儿提交)`

const TRUST_PROTOCOL_EN = `## Trust Protocol (highest priority)

| Upstream state | Your behavior |
| --- | --- |
| approved | Treat as truth, use directly; **do not** re-derive or re-confirm settled content |
| draft / pending (never approved) | Usable, but flag outputs as "based on unreviewed docs"; stop and ask on doubt |
| pending & previously approved (under re-review) | **Forbidden**, wait for re-review |
| invalidated | **Forbidden**, stop and require upstream re-review |

Query state: \`{{CLI}} artifacts --module=<module>\`
On a substantive objection to approved content, **do not silently deviate** — leave a trace and stop for a ruling:
\`{{CLI}} dispute --actor=<role> --reason="..." -- <file path>\``

const CLI_GUIDE_EN = `## Task operations

When MCP is registered, prefer the \`wb_*\` typed tools (same source & transaction as the CLI); CLI equivalents:

\`\`\`bash
{{CLI}} list --role=<role> --status=pending   # your queue
{{CLI}} claim <id> --assignee=<role>          # claim (gate auto-checks, deps auto-snapshotted)
{{CLI}} input <id> --operator=<role> -- <path> # declare a dep read outside the gate
{{CLI}} output --module=<module> --role=<role> --endpoint=<endpoint> [--page=<module>/<page>] -- <path>
{{CLI}} submit --actor=<role> -- <path>        # submit a contract doc once written
{{CLI}} update <id> --status=completed --operator=<role>
{{CLI}} record <id> --operator=<role> "note"
\`\`\`

- Gate errors on claim are **actionable**: follow them to wait for upstream output/approval, never bypass
- A stale task (upstream changed) blocks complete: align with the change first; only \`--force=true\` (traced) once you confirm no impact
- Outputs must be **written to a file, then registered**; registration auto-links your claimed task
- **git attribution**: after claiming, set env var \`WORKBENCH_TASK_ID=<task id>\`; the commit hook injects a \`Task: #id\` trailer (attribution for multi-agent shared branches; unset = orphan commit)`

const SHARED = {
  zh: { trust: TRUST_PROTOCOL_ZH, guide: CLI_GUIDE_ZH, todo: "(待配置:workbench.config.json 的 codeRoots)", sep: "、" },
  en: { trust: TRUST_PROTOCOL_EN, guide: CLI_GUIDE_EN, todo: "(configure codeRoots in workbench.config.json)", sep: ", " }
} as const

export interface GenAgentsResult {
  /** 生成的文件相对路径(跨所有目标平台) */
  written: string[]
}

interface ParsedTemplate {
  name: string
  description: string
  tools: string[]
  body: string
}

/** 解析模板 frontmatter(name/description/tools)+ 正文;model/memory 交由各平台 adapter */
function parseTemplate(rawInput: string): ParsedTemplate {
  const raw = rawInput.replace(/\r\n/g, "\n") // Windows 检出可能是 CRLF,归一后再解析
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) throw new Error("模板缺少 frontmatter")
  const meta: Record<string, string> = {}
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    name: meta.name ?? "",
    description: meta.description ?? "",
    tools: (meta.tools ?? "").split(",").map(t => t.trim()).filter(Boolean),
    body: m[2].replace(/^\n+/, "")
  }
}

export function genAgents(ctx: Ctx, templatesDir?: string): GenAgentsResult {
  const lang = ctx.config.language
  const blocks = SHARED[lang] ?? SHARED.zh
  const dir = templatesDir ?? join(WORKBENCH_DIR, "templates/agents", lang)
  if (!existsSync(dir)) throw new Error(`模板目录不存在: ${dir}`)

  const cli = ctx.config.cli
  // 平台无关的正文 token(CLI 已烘进信任协议/CLI 指南)
  const baseTokens: Record<string, string> = {
    CLI: cli,
    TRUST_PROTOCOL: blocks.trust.replaceAll("{{CLI}}", cli),
    CLI_GUIDE: blocks.guide.replaceAll("{{CLI}}", cli),
    PATH_PROJECT: expandPath(ctx, "project"),
    PATH_ROLES: expandPath(ctx, "roles"),
    PATH_GLOSSARY: expandPath(ctx, "glossary"),
    PATH_FLOWS: expandPath(ctx, "flow"),
    PATH_MODULES: expandPath(ctx, "module-prd"),
    PATH_PAGES: expandPath(ctx, "page-prd"),
    PATH_DB_DOCS: expandPath(ctx, "db-doc"),
    PATH_API_DOCS: expandPath(ctx, "api-doc"),
    PATH_DESIGN_SYSTEMS: expandPath(ctx, "design-system"),
    PATH_DESIGN_PROMPTS: expandPath(ctx, "design-prompt"),
    PATH_PROTOTYPES: expandPath(ctx, "prototype"),
    PATH_ACCEPTANCE: expandPath(ctx, "acceptance"),
    // 路径投影:完整路径模板由 kind 注册表(前缀+coords 文法+ext)推导——
    // 项目覆盖 coords 后重跑 gen-agents,agent 指示与 scan 解析自动同步(单一真相源)
    TPL_FLOW: kindPathTemplate(ctx.config, "flow", lang) ?? "",
    TPL_MODULE_PRD: kindPathTemplate(ctx.config, "module-prd", lang) ?? "",
    TPL_PAGE_PRD: kindPathTemplate(ctx.config, "page-prd", lang) ?? "",
    TPL_DB_DOC: kindPathTemplate(ctx.config, "db-doc", lang) ?? "",
    TPL_DESIGN_SYSTEM: kindPathTemplate(ctx.config, "design-system", lang) ?? "",
    TPL_DESIGN_PROMPT: kindPathTemplate(ctx.config, "design-prompt", lang) ?? "",
    TPL_PROTOTYPE: kindPathTemplate(ctx.config, "prototype", lang) ?? "",
    TPL_ACCEPTANCE: kindPathTemplate(ctx.config, "acceptance", lang) ?? "",
    ENDPOINTS: ctx.config.endpoints.join(" / "),
    PIPELINE: ctx.config.pipeline.join(" → "),
    CODE_ROOTS: ctx.config.endpoints
      .map(e => `| ${e} | ${(ctx.config.codeRoots[e] ?? []).join(blocks.sep) || blocks.todo} |`)
      .join("\n")
  }

  const renderTokens = (text: string, memory: string): string => {
    let content = text
    const tokens = { ...baseTokens, MEMORY: memory }
    for (const [token, value] of Object.entries(tokens)) content = content.replaceAll(`{{${token}}}`, value)
    const leftover = content.match(/\{\{[A-Z_]+\}\}/)
    if (leftover) throw new Error(`模板存在未解析 token: ${leftover[0]}`)
    return content
  }

  const adapters = resolvePlatforms(ctx.config.platforms)
  const pipeline = new Set<string>(ctx.config.pipeline)
  const written: string[] = []

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue
    const role = file.replace(/\.md$/, "")
    // 异构项目:不在流水线里的角色不生成(纯后端无 designer)
    if (!pipeline.has(role)) continue
    const tpl = parseTemplate(readFileSync(join(dir, file), "utf-8"))

    for (const adapter of adapters) {
      const memory = adapter.memoryBlock(role, lang)
      const spec: AgentSpec = {
        name: tpl.name,
        description: renderTokens(tpl.description, memory),
        tools: tpl.tools,
        model: resolveModel(ctx.config.model, adapter),
        body: renderTokens(tpl.body, memory)
      }
      const rel = `${adapter.agentsDir}/${adapter.agentFile(role)}`
      const abs = join(ctx.root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, adapter.renderAgent(spec))
      written.push(rel)
    }
  }
  return { written }
}
