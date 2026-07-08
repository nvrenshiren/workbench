/**
 * 多平台 PreToolUse hook:approved 契约写闸门。
 * 宪法第六条:新闸门先跑观察期——writeGate 三档:
 *   off     不检查
 *   observe 只记 would_block 事件(误拦判据的数据源,人工每周标注),永不拦截 ← 默认
 *   enforce 拦截(平台各自的拒绝出口),观察期误拦率达标后由用户翻开
 * 平台由 --platform=<id> 指定;stdin/项目根按平台归一(见 hook-input）。
 */
import { extractFilePath, hookPlatform, hookProjectDir, readStdinJson } from "./hook-input"

async function main() {
  const platform = hookPlatform()
  const input = await readStdinJson()
  const filePath = extractFilePath(input)
  if (!filePath) return

  const { openWorkbench } = await import("../core/db")
  const { normalizeRelPath } = await import("../core/commands/artifact.commands")
  const { reviewStatus } = await import("../core/derive")
  const { contractKinds } = await import("../core/kind")
  const { logEvent } = await import("../core/events")

  const ctx = openWorkbench(hookProjectDir())
  const mode = ctx.config.gates.writeGate
  if (mode === "off") return

  const rel = normalizeRelPath(ctx, filePath)
  const artifact = ctx.db.prepare("SELECT * FROM artifacts WHERE path = ?").get(rel) as
    | import("../core/types").ArtifactRow
    | undefined
  if (!artifact) return
  if (!contractKinds(ctx.config).includes(artifact.kind)) return
  if (reviewStatus(artifact) !== "approved") return

  // 合法通行证:环境变量声明了一个已领取的未完成任务(非数字不算通行证,也不能借抛错触发 fail-open 绕过)
  const taskEnv = Number(process.env.WORKBENCH_TASK_ID)
  if (Number.isInteger(taskEnv) && taskEnv > 0) {
    const task = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM tasks WHERE id = ? AND assignee IS NOT NULL AND status IN ('pending','in_progress')")
      .get(taskEnv) as { c: number }
    if (task.c > 0) return
  }

  logEvent(ctx.db, {
    entityType: "artifact",
    entityId: artifact.id,
    event: "would_block",
    actor: "write-gate",
    payload: { path: rel, kind: artifact.kind, platform, taskEnv: process.env.WORKBENCH_TASK_ID ?? null, mode },
    module: artifact.module,
    endpoint: artifact.endpoint,
    page: artifact.page
  })

  if (mode === "enforce") {
    // 可行动文案(裁决账本:必须告诉 agent 该领什么任务)
    const msg =
      `该文件是已审批契约(${artifact.kind}): ${rel}。\n` +
      `修改前请先领取对应任务:${ctx.config.cli} list --module=${artifact.module ?? ""} --status=pending\n` +
      `领取后设置环境变量 WORKBENCH_TASK_ID=<任务id> 再修改;若对内容本身有异议,用 dispute 命令留痕并停止。`
    if (platform === "cursor") {
      // Cursor:stdout 返回 JSON 决策
      process.stdout.write(JSON.stringify({ permission: "deny", userMessage: msg, agentMessage: msg }))
      process.exit(0)
    }
    // Claude / Codex / 其余:stderr + exit 2 阻断
    console.error(msg)
    process.exit(2)
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))

export {}
