import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  addTaskInput,
  auditModule,
  claimTask,
  disputeArtifact,
  feedbackArtifact,
  listArtifacts,
  listTasks,
  planModule,
  recordQaResult,
  recordNote,
  registerOutput,
  runRetrospective,
  submitArtifact,
  syncArtifacts,
  updateTask
} from "../core/index"
import type { Ctx } from "../core/types"

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] })

/**
 * MCP 端点:commands 层包装为 typed tools。
 * 与 CLI 完全同源——同一 commands 层、同一事务、同一事件流;
 * 审批(approve/reject)刻意不暴露:那是人的动作,只在 opcflow/CLI 由用户执行。
 */
export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "opcflow", version: "0.1.0" })

  server.registerTool(
    "wb_list_tasks",
    {
      description: "查看任务列表(gate 报错可行动;领取用 wb_claim)",
      inputSchema: { role: z.string().optional(), status: z.string().optional(), module: z.string().optional(), type: z.string().optional() }
    },
    async args => json(listTasks(ctx, { ...args, withStale: true }))
  )

  server.registerTool(
    "wb_claim",
    { description: "领取任务(gate 自动校验,上游依赖自动快照)", inputSchema: { id: z.number(), assignee: z.string() } },
    async args => json(claimTask(ctx, args))
  )

  server.registerTool(
    "wb_update_status",
    {
      description: "更新任务状态;completed 会跑 stale 拦截/产出义务/协议 lint/机器检查",
      inputSchema: { id: z.number(), status: z.string(), operator: z.string(), force: z.boolean().optional() }
    },
    async args => json(updateTask(ctx, args))
  )

  server.registerTool(
    "wb_output",
    {
      description: "登记产出文件(必须先写文件;自动推断 kind 并关联已领取任务)",
      inputSchema: {
        role: z.string(),
        endpoint: z.string().optional(),
        module: z.string().optional(),
        page: z.string().optional(),
        filePath: z.string()
      }
    },
    async args => json(registerOutput(ctx, { ...args, endpoint: args.endpoint ?? "common" }))
  )

  server.registerTool(
    "wb_submit",
    { description: "契约文档送审(进入用户待审队列)", inputSchema: { path: z.string(), actor: z.string() } },
    async args => json(submitArtifact(ctx, { path: args.path }, args.actor))
  )

  server.registerTool(
    "wb_feedback",
    {
      description: "对原型/代码产物记录 👍(+1)/👎(-1);👎 必附 comment;原型 👍=放行",
      inputSchema: { path: z.string(), verdict: z.union([z.literal(1), z.literal(-1)]), comment: z.string().optional(), actor: z.string() }
    },
    async args => json(feedbackArtifact(ctx, { path: args.path }, args))
  )

  server.registerTool(
    "wb_dispute",
    {
      description: "对 approved 内容有实质异议时留痕并停止(等用户裁决,禁止擅自偏离)",
      inputSchema: { path: z.string(), actor: z.string(), reason: z.string() }
    },
    async args => {
      disputeArtifact(ctx, { path: args.path }, args.actor, args.reason)
      return json({ ok: true })
    }
  )

  server.registerTool(
    "wb_input",
    {
      description: "补充申报任务依赖(gate 之外读过的登记产物,进入 stale 监控)",
      inputSchema: { id: z.number(), path: z.string(), operator: z.string() }
    },
    async args => {
      addTaskInput(ctx, args)
      return json({ ok: true })
    }
  )

  server.registerTool(
    "wb_record",
    { description: "任务备注留痕", inputSchema: { id: z.number(), content: z.string(), operator: z.string() } },
    async args => {
      recordNote(ctx, args)
      return json({ ok: true })
    }
  )

  server.registerTool(
    "wb_plan",
    { description: "按已登记 page-prd 派发模块整组任务(幂等,删页自动 cancel)", inputSchema: { module: z.string(), creator: z.string().optional() } },
    async args => json(planModule(ctx, args.module, args.creator))
  )

  server.registerTool("wb_sync", { description: "全量对账:失效检测+review 派发+tombstone", inputSchema: {} }, async () =>
    json(syncArtifacts(ctx, "mcp"))
  )

  server.registerTool(
    "wb_audit",
    { description: "模块对账报告(清算状态/契约信任状态/送审建议)", inputSchema: { module: z.string() } },
    async args => json(auditModule(ctx, args.module))
  )

  server.registerTool(
    "wb_qa",
    {
      description: "记录 QA 验收结果;fail 必附 reason(自动派 rework,完成后自动复验)",
      inputSchema: { id: z.number(), result: z.enum(["pass", "fail"]), reason: z.string().optional(), operator: z.string() }
    },
    async args => json(recordQaResult(ctx, args))
  )

  server.registerTool(
    "wb_retro",
    {
      description:
        "retrospective 证据包:反馈半衰期加权提炼(经验候选/Red Flags/观察)+ 审批吞吐报表。" +
        "依据 evidence 判断每组该沉淀为哪一种再产出:可复用做法→skill(.claude/skills/<名称>/SKILL.md,register-meta+submit 送人审,approved 才生效);" +
        "能机器查的硬约束→规则(workbench.config.json 的 protocolLints);角色专属教训→记忆(.claude/agent-memory/<角色>/)。见 report.guidance",
      inputSchema: { module: z.string().optional() }
    },
    async args => json(runRetrospective(ctx, args))
  )

  server.registerTool(
    "wb_artifacts",
    {
      description: "查看产物信任状态(approved=真相直接用;invalidated/复审中=禁用)",
      inputSchema: { module: z.string().optional(), kind: z.string().optional(), endpoint: z.string().optional() }
    },
    async args => json(listArtifacts(ctx, args))
  )

  return server
}

// stdio 入口(独立运行;打包后由 opcflow mcp 子命令调用)
if (process.argv[1]?.replace(/\\/g, "/").endsWith("server/mcp.ts")) {
  import("../core/db").then(async ({ openWorkbench }) => {
    const ctx = openWorkbench(process.env.WORKBENCH_PROJECT)
    const server = buildMcpServer(ctx)
    await server.connect(new StdioServerTransport())
  })
}
