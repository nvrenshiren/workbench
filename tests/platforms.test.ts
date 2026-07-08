import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { parse as parseToml } from "smol-toml"
import { type AgentSpec, getAdapter, initProject, resolveModel, resolvePlatforms } from "../core/index"
import { extractFilePath } from "../scripts/hook-input"

const SPEC: AgentSpec = {
  name: "architect",
  description: "设计 DB 与 API 契约",
  tools: ["Read", "Write", "Edit", "Bash"],
  model: "test-model",
  body: "# 架构师\n\n你是 @architect。"
}

describe("platform adapter:agent 序列化", () => {
  it("claude → md + frontmatter(name/model/tools/memory)", () => {
    const out = getAdapter("claude").renderAgent(SPEC)
    assert.match(out, /^---\nname: architect\n/)
    assert.match(out, /\nmodel: test-model\n/)
    assert.match(out, /\nmemory: project\n/)
    assert.match(out, /\ntools: Read, Write, Edit, Bash\n/)
    assert.ok(out.includes("# 架构师"))
  })

  it("codex → 合法 TOML(name/model/developer_instructions)", () => {
    const out = getAdapter("codex").renderAgent(SPEC)
    const parsed = parseToml(out) as any
    assert.equal(parsed.name, "architect")
    assert.equal(parsed.model, "test-model")
    assert.ok(parsed.developer_instructions.includes("# 架构师"))
  })

  it("opencode → frontmatter 含 mode:subagent + permission(由 tools 派生)", () => {
    const out = getAdapter("opencode").renderAgent(SPEC)
    assert.match(out, /\nmode: subagent\n/)
    assert.match(out, /\nmodel: test-model\n/)
    assert.match(out, /\n  edit: allow\n/)
    assert.match(out, /\n  bash: allow\n/)
  })

  it("opencode → 无 Edit/Bash 工具时 permission 收敛为 deny", () => {
    const readonly: AgentSpec = { ...SPEC, tools: ["Read", "Glob"] }
    const out = getAdapter("opencode").renderAgent(readonly)
    assert.match(out, /\n  edit: deny\n/)
    assert.match(out, /\n  bash: deny\n/)
  })

  it("cursor → subagent frontmatter(name/description/model)", () => {
    const out = getAdapter("cursor").renderAgent(SPEC)
    assert.match(out, /^---\nname: architect\n/)
    assert.match(out, /\nmodel: test-model\n/)
    assert.ok(!out.includes("memory:"), "cursor 不应有 memory 字段")
  })
})

describe("platform adapter:MCP 写入(合并,不覆盖既有)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-mcp-"))
  after(() => rmSync(root, { recursive: true, force: true }))
  const server = { name: "workbench", command: "npx", args: ["tsx", "../server/mcp.ts"] }

  it("claude:合并进已有 .mcp.json 不丢用户的 server", () => {
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }))
    getAdapter("claude").writeMcp(root, server)
    const json = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"))
    assert.equal(json.mcpServers.other.command, "x")
    assert.deepEqual(json.mcpServers.workbench, { command: "npx", args: ["tsx", "../server/mcp.ts"] })
  })

  it("codex:写进 .codex/config.toml 的 [mcp_servers.workbench]", () => {
    getAdapter("codex").writeMcp(root, server)
    const cfg = parseToml(readFileSync(join(root, ".codex/config.toml"), "utf-8")) as any
    assert.equal(cfg.mcp_servers.workbench.command, "npx")
    assert.deepEqual(cfg.mcp_servers.workbench.args, ["tsx", "../server/mcp.ts"])
  })

  it("opencode:command 是整个数组 + type=local", () => {
    getAdapter("opencode").writeMcp(root, server)
    const json = JSON.parse(readFileSync(join(root, "opencode.json"), "utf-8"))
    assert.equal(json.mcp.workbench.type, "local")
    assert.deepEqual(json.mcp.workbench.command, ["npx", "tsx", "../server/mcp.ts"])
  })
})

describe("platform adapter:hooks 写入", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-hk-"))
  after(() => rmSync(root, { recursive: true, force: true }))
  const wire = { preCommand: "PRE --platform=x", postCommand: "POST --platform=x" }

  it("claude settings.json:PreToolUse/PostToolUse 带 matcher", () => {
    getAdapter("claude").writeHooks(root, wire)
    const json = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf-8"))
    assert.equal(json.hooks.PreToolUse[0].hooks[0].command, "PRE --platform=x")
    assert.equal(json.hooks.PostToolUse[0].hooks[0].command, "POST --platform=x")
  })

  it("cursor hooks.json:preToolUse + afterFileEdit", () => {
    getAdapter("cursor").writeHooks(root, wire)
    const json = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf-8"))
    assert.equal(json.version, 1)
    assert.equal(json.hooks.preToolUse[0].command, "PRE --platform=x")
    assert.equal(json.hooks.afterFileEdit[0].command, "POST --platform=x")
  })

  it("hooks 去重:重复写不追加第二份", () => {
    getAdapter("cursor").writeHooks(root, wire)
    const json = JSON.parse(readFileSync(join(root, ".cursor/hooks.json"), "utf-8"))
    assert.equal(json.hooks.preToolUse.length, 1)
  })

  it("opencode:生成 .opencode/plugins/workbench.ts 插件薄壳", () => {
    getAdapter("opencode").writeHooks(root, wire)
    const plugin = readFileSync(join(root, ".opencode/plugins/workbench.ts"), "utf-8")
    assert.ok(plugin.includes("tool.execute.before"))
    assert.ok(plugin.includes("PRE --platform=x"))
  })
})

describe("model 解析", () => {
  it("字符串 → 全平台同款", () => {
    assert.equal(resolveModel("m", getAdapter("codex")), "m")
  })
  it("对象 → 按平台取,缺则用 adapter 默认", () => {
    assert.equal(resolveModel({ codex: "c" }, getAdapter("codex")), "c")
    assert.equal(resolveModel({ codex: "c" }, getAdapter("claude")), getAdapter("claude").defaultModel)
  })
  it("undefined → adapter 默认", () => {
    assert.equal(resolveModel(undefined, getAdapter("opencode")), getAdapter("opencode").defaultModel)
  })
})

describe("hook 入参跨平台提取 file path", () => {
  it("claude tool_input.file_path", () => {
    assert.equal(extractFilePath({ tool_input: { file_path: "a.ts" } }), "a.ts")
  })
  it("cursor file_path", () => {
    assert.equal(extractFilePath({ file_path: "b.ts", edits: [] }), "b.ts")
  })
  it("opencode args.filePath", () => {
    assert.equal(extractFilePath({ args: { filePath: "c.ts" } }), "c.ts")
  })
  it("codex arguments.file_path", () => {
    assert.equal(extractFilePath({ arguments: { file_path: "d.ts" } }), "d.ts")
  })
  it("无匹配 → undefined", () => {
    assert.equal(extractFilePath({ foo: 1 }), undefined)
  })
})

describe("多平台 init 端到端", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-mp-"))
  let ctx: any
  after(() => {
    ctx?.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("一次为 4 平台生成 agent/MCP/hooks + 元产物全登记", () => {
    const r = initProject(root, {
      endpoints: ["service", "web"],
      platforms: ["claude", "codex", "opencode", "cursor"],
      gitHooks: false
    })
    ctx = r.ctx
    // 5 角色 × 4 平台 = 20 agent 文件
    assert.equal(r.agents.length, 20)
    assert.equal(r.mcpPaths.length, 4)
    assert.ok(r.hookPaths.length >= 4)
    assert.equal(r.metaRegistered, 20)
    // 各平台落地格式正确
    assert.ok(existsSync(join(root, ".claude/agents/architect.md")))
    assert.ok(existsSync(join(root, ".codex/agents/architect.toml")))
    assert.ok(existsSync(join(root, ".opencode/agents/architect.md")))
    assert.ok(existsSync(join(root, ".cursor/agents/architect.md")))
    // config 记录 platforms
    assert.deepEqual(ctx.config.platforms, ["claude", "codex", "opencode", "cursor"])
  })

  it("默认(不传 platforms)= 仅 claude,行为不变", () => {
    const root2 = mkdtempSync(join(tmpdir(), "wb-def-"))
    const r = initProject(root2, { endpoints: ["service"], gitHooks: false })
    assert.deepEqual(r.platforms, ["claude"])
    assert.equal(r.mcpPaths[0], ".mcp.json")
    assert.ok(existsSync(join(root2, ".claude/agents/architect.md")))
    assert.ok(!existsSync(join(root2, ".codex")))
    r.ctx.db.close()
    rmSync(root2, { recursive: true, force: true })
  })
})

describe("resolvePlatforms 归一", () => {
  it("空/undefined → claude 兜底", () => {
    assert.deepEqual(resolvePlatforms(undefined).map(a => a.id), ["claude"])
    assert.deepEqual(resolvePlatforms([]).map(a => a.id), ["claude"])
  })
  it("未知平台报错", () => {
    assert.throws(() => resolvePlatforms(["nope"]), /未知平台/)
  })
})
