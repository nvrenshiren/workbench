# Workbench

**Drift-enforced、spec-anchored 的 AI 开发执行层。**

生成无限快之后,验证是唯一瓶颈。Workbench 把你的每一次验证(审批、反馈)铸成机器可读、
可失效、可传播的资产——文档 → 任务 → 产出形成真实关系链,任何一处变更都自动沿链传播、
自动派复审。你只做三件事:**审批契约、给产物点 👍👎、回答裁决**。

## 能力一览

- **真实关系链**:artifact DAG + 任务外键,不是命名约定
- **五态信任锚点**:approved 内容被改自动失效,下游自动 stale
- **双车道**:标准道(全流程)+ 快车道 hotfix(登记义务不豁免)
- **变更传播**:sync 对账 → 失效 → 沿图派 review(去重)
- **QA 闭环**:fail → 自动 rework → 自动复验,不消耗人
- **反馈进化**:👍👎 与 QA verdict 半衰期加权提炼 → skill 候选 / Red Flags,草稿走人审;审批吞吐被度量
- **协议 lint**:能机器查的约定降级为 gate 卡点
- **可视化工作台**:树 + markdown/mermaid/原型/代码渲染 + 待审队列 diff + SSE 实时
- **AI 接入**:5 个 agent 定义(模板生成)+ MCP typed tools + Claude Code hooks
- **异构可移植**:纯后端项目自动裁掉 designer(qa 保留);零业务耦合(lint 强制)

## 快速开始

```bash
# 1. 把 workbench/ 拷进你的项目,装依赖
cd my-project/workbench && pnpm install && cd ..

# 2. 一键引导(声明你的端)
npx tsx workbench/cli.ts init --endpoints=service,admin,weapp,app

# 3. 填 workbench.config.json 的 codeRoots,启动工作台(首次需先 build 前端)
cd workbench && pnpm start          # 首次/前端改动后:build 前端 + 起 server → http://127.0.0.1:5620
# 前端已 build 过、只重启后端:pnpm run serve
```

**完整教程见 [GETTING-STARTED.md](./GETTING-STARTED.md)。**

## Claude Code hooks 片段

`init` 不自动改你的 `.claude/settings.json`(避免覆盖)。手动加入:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit", "hooks": [
        { "type": "command", "command": "npx tsx workbench/scripts/hook-pretooluse.ts", "timeout": 15 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [
        { "type": "command", "command": "npx tsx workbench/scripts/hook-refresh.ts", "timeout": 15 } ] }
    ]
  }
}
```

## 脚本

```bash
pnpm start                # 启动工作台(build 前端 + 起 server;首次用它)
pnpm run serve            # 只起 server,不 build 前端(web/dist 未生成会 404)
pnpm run web:build        # 构建前端
pnpm test                 # core 单元测试
pnpm run typecheck        # 类型检查
pnpm run check:isolation  # 零业务耦合校验
```

## 技术栈

TypeScript · better-sqlite3 · Fastify · React 18 + antd 6 · Monaco · mermaid ·
@modelcontextprotocol/sdk · tsx。运行时 Node ≥ 22。

## 许可

MIT
