# 多平台接入

workbench 是 vibecode 平台无关的执行引擎:核心(SQLite 数据层 / gates / 信任协议 / DAG /
CLI / MCP server)对所有平台一致,只有「AI 怎么读到 agent 定义、怎么挂 MCP、怎么触发 hook」
这层接线因平台而异,由 [`core/platforms.ts`](core/platforms.ts) 的 adapter 负责。

一次可为多个平台生成(它们的文件互不冲突),同一仓库里 Claude / Codex / OpenCode / Cursor
用户各用各的工具都能跑同一套流程。

## 一键引导

```bash
bash setup.sh          # 交互:选平台(多选)+ 选端 + 选模型(models.dev)→ 生成
```

或直接用 CLI:

```bash
npx tsx workbench/cli.ts init \
  --platforms=claude,codex,opencode,cursor \
  --endpoints=service,web \
  --model='{"codex":"gpt-5.1-codex","opencode":"anthropic/claude-opus-4-8"}'
```

- `--platforms` 缺省 `claude`(旧行为完全不变)。
- `--model` 可给单个字符串(全平台同款)或 `{平台: 模型}` JSON;缺省用各平台内置默认。
- `--writehooks=false` 关闭 hooks 自动接线(默认接线,observe 模式)。

## 各平台落点

| 维度 | claude | codex | opencode | cursor |
| --- | --- | --- | --- | --- |
| **agent** | `.claude/agents/<role>.md` | `.codex/agents/<role>.toml` | `.opencode/agents/<role>.md` | `.cursor/agents/<role>.md` |
| **格式** | md + YAML frontmatter | TOML(`developer_instructions`) | md + frontmatter(`mode: subagent`) | md + frontmatter(subagent) |
| **skill** | `.claude/skills/` | `.agents/skills/` | `.opencode/skills/` | `.cursor/skills/` |
| **MCP** | `.mcp.json` | `.codex/config.toml` `[mcp_servers]` | `opencode.json` `mcp` | `.cursor/mcp.json` |
| **hooks** | `.claude/settings.json` | `.codex/config.toml` `[hooks]` | `.opencode/plugins/workbench.ts` | `.cursor/hooks.json` |
| **模型钉在哪** | agent frontmatter | agent toml / config | agent frontmatter | subagent frontmatter |

MCP / hooks 写入均为**合并语义**:不会覆盖你已有的 server / 其它 hook,只补 `workbench` 这一项。

## Hooks(写门禁 + 刷新)

init 默认把两个 hook 接到各平台原生 hook 机制,`writeGate` 三档控制行为(默认 **observe**):

- **PreToolUse**(写门禁):agent 改到已 approved 的契约文件时——`observe` 只记 `would_block`
  事件(误拦判据),`enforce` 拦截(Claude/Codex 非零退出、Cursor 返回 `{permission:"deny"}`),
  `off` 不查。持有已领取任务(`WORKBENCH_TASK_ID`)时放行。
- **PostToolUse**(刷新):改文件后秒级重算对应 artifact 的 hash,驱动失效传播。

各平台传给 hook 的 stdin JSON 形态不同,由 [`scripts/hook-input.ts`](scripts/hook-input.ts) 归一。

## 平台注意点

- **Codex**:项目级 `.codex/*`(agents / config.toml / hooks)**仅当项目被标记 `trusted`
  才加载** —— 首次进入目标项目须在 `~/.codex/config.toml` 里设
  `[projects."<项目路径>"] trust_level = "trusted"`,否则静默失效。skill 走 `.agents/skills/`。
- **Cursor**:**主 agent 模型由 UI 选,项目文件改不了**;`--model` 只作用于生成的
  subagent(`.cursor/agents/*.md`)。需 Cursor 2.4+(subagents)、1.7+(hooks)。
- **OpenCode**:模型串是 `provider/model` 格式(见 [models.dev](https://models.dev));API key
  建议走环境变量或 `{env:...}`,不依赖只在全局的 `auth.json`。hook 是进程内 JS 插件,
  workbench 生成一个薄壳插件转发到 hook 脚本。
- **各平台文档更新快**:字段/路径以核实当日为准,接入前对照目标平台当前版本再校一次。

## 模型来源

`setup.sh` 从 [models.dev](https://models.dev) 的 `api.json` 拉取「支持 tool_call」的模型清单
(用 node 解析,无需 jq),按 provider 分组供选;也可直接粘贴模型串或用各平台默认。
