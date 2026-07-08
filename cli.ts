/**
 * opcflow CLI —— 单一 bin 承载全部子命令(发布后经 `npx -y @dawipong/opcflow <cmd>` 调用)。
 * 项目侧不落 opcflow 源码:init 生成的 config.cli / .mcp.json / hooks 全指向本 bin。
 *   init                      新项目引导
 *   mcp                       起 MCP server(stdio),读 --project / cwd 的 .workbench
 *   serve [--project --port]  起 web 工作台,连接项目的 .workbench
 *   hook pre|post --platform= agent 工具调用前后 hook(写门禁 / 刷新)
 *   postcommit                git 提交后:scan + sync + 孤儿检测 + 导出
 *   其余(list/plan/qa/...)   见 `help`
 */
import { openWorkbench } from "./core/db"
import { parseArgs, runInit, runCommand, HELP } from "./cli-runner"

async function main() {
  const { command, a } = parseArgs(process.argv.slice(2))

  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(HELP)
    return
  }

  if (command === "init") {
    await runInit(a.project || process.cwd(), a)
    return
  }

  if (command === "mcp") {
    const { buildMcpServer } = await import("./server/mcp")
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")
    const ctx = openWorkbench(a.project ?? process.env.WORKBENCH_PROJECT)
    await buildMcpServer(ctx).connect(new StdioServerTransport())
    return
  }

  if (command === "serve") {
    const { createServer } = await import("./server/app")
    const net = await import("node:net")
    const ctx = openWorkbench(a.project ?? process.env.WORKBENCH_PROJECT)
    const start = parseInt(a.port ?? process.env.WORKBENCH_PORT ?? "5620")
    const host = a.host ?? process.env.WORKBENCH_HOST ?? "0.0.0.0" // 默认对局域网开放;--host=127.0.0.1 只本机
    // 端口占用检测:连 127.0.0.1:port,能连上=已有监听(覆盖 0.0.0.0 与 127.0.0.1 两种绑定,
    // 绕开 Windows 上 0.0.0.0 与 127.0.0.1 可共存导致 bind 探测漏判的坑)
    const inUse = (p: number) =>
      new Promise<boolean>(resolve => {
        const sock = net.connect({ port: p, host: "127.0.0.1" })
        sock.setTimeout(400)
        sock.once("connect", () => {
          sock.destroy()
          resolve(true)
        })
        sock.once("timeout", () => {
          sock.destroy()
          resolve(false)
        })
        sock.once("error", () => resolve(false))
      })
    let port = start
    for (let i = 0; i < 30 && (await inUse(port)); i++) port++
    if (port !== start) console.error(`端口 ${start} 被占用,改用 ${port}`)
    const app = await createServer(ctx)
    await app.listen({ port, host })
    console.log(`opcflow: http://127.0.0.1:${port}  (host: ${host}, project: ${ctx.root})`)
    return
  }

  if (command === "hook") {
    const platform = a.platform ?? "claude"
    if (a._ === "pre") {
      const { writeGateHook } = await import("./scripts/hook-pretooluse")
      await writeGateHook(platform).catch(() => {})
    } else if (a._ === "post") {
      const { refreshHook } = await import("./scripts/hook-refresh")
      await refreshHook(platform).catch(() => {})
    }
    process.exit(0)
  }

  if (command === "postcommit") {
    try {
      const { scanArtifacts, syncArtifacts, detectOrphanCommit } = await import("./core/index")
      const { exportEventLog } = await import("./core/commands/retro.command")
      const ctx = openWorkbench(process.cwd())
      scanArtifacts(ctx, "post-commit")
      syncArtifacts(ctx, "post-commit")
      detectOrphanCommit(ctx)
      exportEventLog(ctx)
    } catch {
      /* observe fail-open:提交后对账绝不阻塞 */
    }
    return
  }

  const ctx = openWorkbench(a.project)

  try {
    await runCommand(ctx, command, a)
  } catch (err: any) {
    console.error(`\n✗ ${err.message}\n`)
    process.exit(1)
  }
}

main()
