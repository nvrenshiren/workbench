import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { getKindRegistry } from "../kind"
import { type AgentSpec, resolveModel, resolvePlatforms } from "../platforms"
import type { ArtifactKind, Ctx } from "../types"

/**
 * 从中性模板生成各平台的 agent 定义(宪法第七条的落地):
 * - 路径不再手写在 prompt 里,由 kind 注册表展开注入 → agent 规则与路径约定单一真相源
 * - 共享块(信任协议/CLI 用法)集中一处,五个角色统一
 * - 模板解析成平台无关 AgentSpec,再由各平台 adapter 序列化(md+frontmatter / toml)
 * - 生成物是元产物(agent-def),draft 注册,M4 出口经用户审批锚定
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

const TRUST_PROTOCOL = `## 信任协议(最高优先级)

| 上游产物状态 | 你的行为 |
| --- | --- |
| approved | 视为真相直接使用;**禁止**重新推导、禁止向用户重复确认已拍板内容 |
| draft / pending(从未获批) | 可用,但产出中标注"基于未审文档";遇疑点停下来问 |
| pending 且曾获批(复审中) | **禁用**,等复审通过 |
| invalidated | **禁用**,停止并要求上游复审 |

状态查询:\`{{CLI}} artifacts --module=<模块>\`
对 approved 内容有实质异议时**禁止擅自偏离**,留痕后停止等用户裁决:
\`{{CLI}} dispute --actor=<角色> --reason="..." -- <文件路径>\``

const CLI_GUIDE = `## 任务操作

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
  const dir = templatesDir ?? join(import.meta.dirname, "../../templates/agents")
  if (!existsSync(dir)) throw new Error(`模板目录不存在: ${dir}`)

  const cli = ctx.config.cli
  // 平台无关的正文 token(CLI 已烘进信任协议/CLI 指南)
  const baseTokens: Record<string, string> = {
    CLI: cli,
    TRUST_PROTOCOL: TRUST_PROTOCOL.replaceAll("{{CLI}}", cli),
    CLI_GUIDE: CLI_GUIDE.replaceAll("{{CLI}}", cli),
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
    ENDPOINTS: ctx.config.endpoints.join(" / "),
    PIPELINE: ctx.config.pipeline.join(" → "),
    CODE_ROOTS: ctx.config.endpoints
      .map(e => `| ${e} | ${(ctx.config.codeRoots[e] ?? []).join("、") || "(待配置:workbench.config.json 的 codeRoots)"} |`)
      .join("\n")
  }

  const renderTokens = (text: string, memoryDir: string): string => {
    let content = text
    const tokens = { ...baseTokens, AGENT_MEMORY_DIR: memoryDir }
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
      const memoryDir = `${adapter.dotDir}/agent-memory/${role}/`
      const spec: AgentSpec = {
        name: tpl.name,
        description: renderTokens(tpl.description, memoryDir),
        tools: tpl.tools,
        model: resolveModel(ctx.config.model, adapter),
        body: renderTokens(tpl.body, memoryDir)
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
