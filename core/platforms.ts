import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"

/**
 * 平台适配层:把「中性 AgentSpec + MCP + hooks」序列化成各 vibecode 平台的原生文件。
 * 引擎其余部分(DB/gates/信任/DAG/CLI/MCP server)平台无关;这里是唯一的接线层。
 * 事实来源(核实日):Claude Code(本仓)、Codex developers.openai.com/codex、
 * OpenCode opencode.ai/docs、Cursor cursor.com/docs(1.7+/2.4+)。
 */

export type PlatformId = "claude" | "codex" | "opencode" | "cursor"
export const PLATFORM_IDS: PlatformId[] = ["claude", "codex", "opencode", "cursor"]

/** 平台无关的角色 agent 描述(body 已注入 token) */
export interface AgentSpec {
  name: string
  description: string
  tools: string[]
  model: string
  body: string
}

/** 要注册的 MCP server(workbench 自身) */
export interface McpServer {
  name: string
  command: string
  args: string[]
}

/** hooks 接线入参(命令由 init 用 workbenchRelPath 算好后传入,平台层不碰路径) */
export interface HookWire {
  /** PreToolUse(写门禁)完整命令 */
  preCommand: string
  /** PostToolUse(刷新 hash)完整命令 */
  postCommand: string
}

export interface PlatformAdapter {
  id: PlatformId
  /** 该平台的点目录(.claude / .codex / …),用于 agent-memory 等 */
  dotDir: string
  /** agent 文件目录(相对项目根) */
  agentsDir: string
  /** skill 目录(相对项目根) */
  skillsDir: string
  /** hook-script 扫描目录(仅 Claude 有独立 hooks/;其余为 null) */
  hooksScanDir: string | null
  /** 用户未指定模型时的兜底 */
  defaultModel: string
  /** 提醒(trust、UI 选模型等) */
  notes: string[]
  /** agent 文件名 */
  agentFile(role: string): string
  /** 序列化一个 agent 为该平台文件内容 */
  renderAgent(spec: AgentSpec): string
  /** 写/合并 MCP 配置,返回写入的相对路径 */
  writeMcp(root: string, server: McpServer): string
  /** 写/合并 hooks(observe 由 hook 脚本内部按 config.writeGate 决定),返回写入的相对路径 */
  writeHooks(root: string, wire: HookWire): string[]
}

// ─── 通用小工具 ─────────────────────────────────────────────

function ensureDir(abs: string) {
  mkdirSync(dirname(abs), { recursive: true })
}
function writeFile(root: string, rel: string, content: string): string {
  const abs = join(root, rel)
  ensureDir(abs)
  writeFileSync(abs, content)
  return rel
}
function readJson(root: string, rel: string): Record<string, any> {
  const abs = join(root, rel)
  if (!existsSync(abs)) return {}
  try {
    return JSON.parse(readFileSync(abs, "utf-8")) as Record<string, any>
  } catch {
    return {}
  }
}
function readToml(root: string, rel: string): Record<string, any> {
  const abs = join(root, rel)
  if (!existsSync(abs)) return {}
  try {
    return parseToml(readFileSync(abs, "utf-8")) as Record<string, any>
  } catch {
    return {}
  }
}
/** hook 命令去重合并进「命令数组」结构(避免重跑重复注入) */
function hasCommand(list: any[] | undefined, cmd: string): boolean {
  if (!Array.isArray(list)) return false
  return JSON.stringify(list).includes(cmd)
}

// ─── frontmatter / 正文序列化 ───────────────────────────────

function yamlFrontmatter(fields: [string, string][], body: string): string {
  const fm = fields.map(([k, v]) => `${k}: ${v}`).join("\n")
  return `---\n${fm}\n---\n\n${body.replace(/^\n+/, "")}\n`
}

// ─── 各平台适配器 ───────────────────────────────────────────

const claude: PlatformAdapter = {
  id: "claude",
  dotDir: ".claude",
  agentsDir: ".claude/agents",
  skillsDir: ".claude/skills",
  hooksScanDir: ".claude/hooks",
  defaultModel: "opus",
  notes: [],
  agentFile: role => `${role}.md`,
  renderAgent: spec =>
    yamlFrontmatter(
      [
        ["name", spec.name],
        ["description", spec.description],
        ["model", spec.model],
        ["memory", "project"],
        ["tools", spec.tools.join(", ")]
      ],
      spec.body
    ),
  writeMcp(root, server) {
    const rel = ".mcp.json"
    const json = readJson(root, rel)
    json.mcpServers = json.mcpServers ?? {}
    json.mcpServers[server.name] = { command: server.command, args: server.args }
    return writeFile(root, rel, JSON.stringify(json, null, 2) + "\n")
  },
  writeHooks(root, wire) {
    const rel = ".claude/settings.json"
    const json = readJson(root, rel)
    json.hooks = json.hooks ?? {}
    const matcher = "Edit|Write|MultiEdit"
    for (const [event, cmd] of [
      ["PreToolUse", wire.preCommand],
      ["PostToolUse", wire.postCommand]
    ] as const) {
      json.hooks[event] = json.hooks[event] ?? []
      if (!hasCommand(json.hooks[event], cmd))
        json.hooks[event].push({ matcher, hooks: [{ type: "command", command: cmd }] })
    }
    return [writeFile(root, rel, JSON.stringify(json, null, 2) + "\n")]
  }
}

const codex: PlatformAdapter = {
  id: "codex",
  dotDir: ".codex",
  agentsDir: ".codex/agents",
  skillsDir: ".agents/skills",
  hooksScanDir: null,
  defaultModel: "gpt-5.1-codex",
  notes: [
    "Codex:项目级 .codex/* 仅当项目被标记 trusted 才加载 —— 在 ~/.codex/config.toml 里为本项目设 trust_level=\"trusted\"",
    "Codex:skill 走 .agents/skills/(非 .codex/skills)"
  ],
  agentFile: role => `${role}.toml`,
  renderAgent: spec =>
    stringifyToml({
      name: spec.name,
      description: spec.description,
      model: spec.model,
      developer_instructions: spec.body.replace(/^\n+/, "")
    }) + "\n",
  writeMcp(root, server) {
    const rel = ".codex/config.toml"
    const cfg = readToml(root, rel)
    cfg.mcp_servers = cfg.mcp_servers ?? {}
    cfg.mcp_servers[server.name] = { command: server.command, args: server.args }
    return writeFile(root, rel, stringifyToml(cfg) + "\n")
  },
  writeHooks(root, wire) {
    const rel = ".codex/config.toml"
    const cfg = readToml(root, rel)
    cfg.hooks = cfg.hooks ?? {}
    for (const [event, cmd] of [
      ["PreToolUse", wire.preCommand],
      ["PostToolUse", wire.postCommand]
    ] as const) {
      cfg.hooks[event] = Array.isArray(cfg.hooks[event]) ? cfg.hooks[event] : []
      if (!hasCommand(cfg.hooks[event], cmd)) cfg.hooks[event].push({ hooks: [{ command: cmd }] })
    }
    return [writeFile(root, rel, stringifyToml(cfg) + "\n")]
  }
}

const opencode: PlatformAdapter = {
  id: "opencode",
  dotDir: ".opencode",
  agentsDir: ".opencode/agents",
  skillsDir: ".opencode/skills",
  hooksScanDir: null,
  defaultModel: "anthropic/claude-opus-4-8",
  notes: [
    "OpenCode:模型串是 provider/model 格式(见 models.dev);API key 建议走环境变量或 {env:...}"
  ],
  agentFile: role => `${role}.md`,
  renderAgent: spec => {
    const canEdit = spec.tools.some(t => t === "Edit" || t === "Write")
    const canBash = spec.tools.includes("Bash")
    const body = spec.body.replace(/^\n+/, "")
    return (
      `---\n` +
      `description: ${spec.description}\n` +
      `mode: subagent\n` +
      `model: ${spec.model}\n` +
      `permission:\n` +
      `  edit: ${canEdit ? "allow" : "deny"}\n` +
      `  bash: ${canBash ? "allow" : "deny"}\n` +
      `---\n\n${body}\n`
    )
  },
  writeMcp(root, server) {
    const rel = "opencode.json"
    const json = readJson(root, rel)
    json["$schema"] = json["$schema"] ?? "https://opencode.ai/config.json"
    json.mcp = json.mcp ?? {}
    json.mcp[server.name] = {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true
    }
    return writeFile(root, rel, JSON.stringify(json, null, 2) + "\n")
  },
  writeHooks(root, wire) {
    // OpenCode 的 hook 是进程内 JS 插件:写一个薄壳,把工具事件转发给 workbench hook 脚本
    const rel = ".opencode/plugins/workbench.ts"
    const plugin = `// workbench:把工具调用前后事件转发给 hook 脚本(观测写门禁 + 刷新 hash)
import { spawn } from "node:child_process"

function runHook(cmd: string, payload: unknown): Promise<void> {
  return new Promise(resolve => {
    const parts = cmd.split(" ")
    const p = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "ignore", "ignore"] })
    p.on("error", () => resolve())
    p.on("close", () => resolve())
    p.stdin.write(JSON.stringify(payload))
    p.stdin.end()
  })
}

export const workbench = async () => ({
  "tool.execute.before": async (_input: unknown, output: unknown) => {
    await runHook(${JSON.stringify(wire.preCommand)}, output)
  },
  "tool.execute.after": async (_input: unknown, output: unknown) => {
    await runHook(${JSON.stringify(wire.postCommand)}, output)
  }
})
`
    return [writeFile(root, rel, plugin)]
  }
}

const cursor: PlatformAdapter = {
  id: "cursor",
  dotDir: ".cursor",
  agentsDir: ".cursor/agents",
  skillsDir: ".cursor/skills",
  hooksScanDir: null,
  defaultModel: "claude-opus-4-8",
  notes: [
    "Cursor:主 agent 模型由 UI 选,--model 只作用于生成的 subagent(.cursor/agents/*.md)"
  ],
  agentFile: role => `${role}.md`,
  renderAgent: spec =>
    yamlFrontmatter(
      [
        ["name", spec.name],
        ["description", spec.description],
        ["model", spec.model]
      ],
      spec.body
    ),
  writeMcp(root, server) {
    const rel = ".cursor/mcp.json"
    const json = readJson(root, rel)
    json.mcpServers = json.mcpServers ?? {}
    json.mcpServers[server.name] = { command: server.command, args: server.args }
    return writeFile(root, rel, JSON.stringify(json, null, 2) + "\n")
  },
  writeHooks(root, wire) {
    const rel = ".cursor/hooks.json"
    const json = readJson(root, rel)
    json.version = json.version ?? 1
    json.hooks = json.hooks ?? {}
    for (const [event, cmd] of [
      ["preToolUse", wire.preCommand],
      ["afterFileEdit", wire.postCommand]
    ] as const) {
      json.hooks[event] = Array.isArray(json.hooks[event]) ? json.hooks[event] : []
      if (!hasCommand(json.hooks[event], cmd)) json.hooks[event].push({ command: cmd })
    }
    return [writeFile(root, rel, JSON.stringify(json, null, 2) + "\n")]
  }
}

const ADAPTERS: Record<PlatformId, PlatformAdapter> = { claude, codex, opencode, cursor }

export function getAdapter(id: PlatformId): PlatformAdapter {
  const a = ADAPTERS[id]
  if (!a) throw new Error(`未知平台: ${id}(支持 ${PLATFORM_IDS.join(", ")})`)
  return a
}

/** config.platforms 归一为 adapter 列表(默认 claude) */
export function resolvePlatforms(platforms: string[] | undefined): PlatformAdapter[] {
  const ids = platforms && platforms.length ? platforms : ["claude"]
  return ids.map(id => getAdapter(id as PlatformId))
}

/** 解析单平台模型:config.model 支持字符串(全平台同款)或 {platform: model} */
export function resolveModel(model: string | Record<string, string> | undefined, adapter: PlatformAdapter): string {
  if (!model) return adapter.defaultModel
  if (typeof model === "string") return model
  return model[adapter.id] ?? adapter.defaultModel
}
