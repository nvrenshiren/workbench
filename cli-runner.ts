/**
 * CLI 分发核心(单一真相源):cli.ts 及各宿主入口都是薄壳,
 * 调用这里的 parseArgs / runInit / runCommand。
 */
import chalk from "chalk"
import {
  addTaskInput,
  approveArtifact,
  auditModule,
  claimTask,
  createTask,
  disputeArtifact,
  exportEventLog,
  feedbackArtifact,
  genAgents,
  getTaskDetail,
  graphModule,
  initProject,
  installGitHooks,
  intakeIssues,
  listArtifacts,
  listEvents,
  listTasks,
  migrateLegacy,
  moveArtifact,
  planModule,
  recordNote,
  recordQaResult,
  registerMetaArtifacts,
  registerOutput,
  rejectArtifact,
  removeTask,
  runProtocolLints,
  runRetrospective,
  scanArtifacts,
  submitArtifact,
  syncArtifacts,
  updateTask,
  type Ctx
} from "./core/index"

const STATUS_TEXT: Record<string, string> = { pending: "⏳ 待领取", in_progress: "🔄 进行中", completed: "✅ 已完成", cancelled: "❌ 已取消" }
const STATUS_COLOR: Record<string, (s: string) => string> = { pending: chalk.gray, in_progress: chalk.blue, completed: chalk.green, cancelled: chalk.red }
const REVIEW_TEXT: Record<string, string> = { draft: "📝 草稿", pending: "⏳ 待审", approved: "✅ 已审批", invalidated: "⚠️ 已失效" }

export interface ParsedArgs {
  command?: string
  a: Record<string, any>
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { a: {} }
  const [command, ...rest] = argv
  const a: Record<string, any> = {}
  for (const arg of rest) {
    if (arg === "--") continue // end-of-options 分隔符(submit --actor=x -- <路径>)
    const match = arg.match(/^--(\w+)=([\s\S]+)$/)
    if (match) a[match[1]] = match[2]
    else if (arg.match(/^\d+$/)) a.id = parseInt(arg)
    else if (a._ === undefined) a._ = arg
    else fail(`多余的位置参数: ${arg}(已有 ${a._});含空格的内容请加引号`)
  }
  return { command, a }
}

function printWarnings(warnings: string[]) {
  for (const w of warnings) console.log(chalk.yellow(`  ⚠ ${w}`))
}

export function printTasks(rows: ReturnType<typeof listTasks>) {
  if (rows.length === 0) return console.log(chalk.yellow("没有找到任务"))
  console.log(chalk.bold("\n ID   | 模块     | 角色        | 端      | 页面                  | 类型    | 状态       | 执行人        | 创建时间"))
  console.log(chalk.gray("------|---------|-------------|---------|----------------------|--------|-----------|--------------|-------------------"))
  for (const row of rows) {
    const colorFn = STATUS_COLOR[row.status] || chalk.white
    const pageDisplay = row.page && row.page.length > 20 ? row.page.substring(0, 17) + "..." : row.page || ""
    const staleMark = row.stale ? chalk.yellow(" ⚠stale") : ""
    console.log(
      colorFn(` ${String(row.id).padEnd(5)} | ${(row.module || "-").padEnd(8)} | ${row.role.padEnd(12)} | ${(row.endpoint || "-").padEnd(8)} | ${pageDisplay.padEnd(22)} | ${row.type.padEnd(7)} | ${(STATUS_TEXT[row.status] || row.status).padEnd(10)} | ${(row.assignee || "-").padEnd(13)} | ${row.created_at}`) + staleMark
    )
  }
  console.log()
}

function printArtifacts(rows: ReturnType<typeof listArtifacts>) {
  if (rows.length === 0) return console.log(chalk.yellow("没有找到产物"))
  console.log(chalk.bold("\n ID   | kind          | 模块     | 端      | 审批状态   | 路径"))
  console.log(chalk.gray("------|---------------|---------|---------|-----------|-------------------"))
  for (const row of rows) {
    const p = row.path.length > 60 ? "..." + row.path.substring(row.path.length - 57) : row.path
    console.log(` ${String(row.id).padEnd(5)} | ${row.kind.padEnd(14)} | ${(row.module || "-").padEnd(8)} | ${(row.endpoint || "-").padEnd(8)} | ${(REVIEW_TEXT[row.review_status] || row.review_status).padEnd(10)} | ${p}`)
  }
  console.log()
}

function printTaskDetail(ctx: Ctx, id: number) {
  const { task, events, outputs, staleness } = getTaskDetail(ctx, id)
  console.log(chalk.bold(`\n═══ 任务 #${task.id} ═══`))
  console.log(`  模块: ${task.module || "-"}   角色: ${task.role}   端: ${task.endpoint || "-"}   页面: ${task.page || "-"}`)
  console.log(`  类型: ${task.type}   状态: ${STATUS_COLOR[task.status]?.(STATUS_TEXT[task.status]) || task.status}${staleness.stale ? chalk.yellow("  ⚠ STALE(上游已变更)") : ""}`)
  console.log(`  执行人: ${task.assignee || "-"}   创建人: ${task.creator}`)
  if (task.content) console.log(chalk.bold("\n  📄 内容: ") + task.content)
  if (staleness.stale) {
    console.log(chalk.yellow("\n  ⚠ 变更的上游产物:"))
    for (const c of staleness.changed) console.log(chalk.yellow(`    - ${c.path}`))
  }
  console.log(chalk.bold(`\n  📦 产出 (${outputs.length})`))
  for (const o of outputs) console.log(chalk.cyan(`    ├─ [${o.kind}] ${o.path}`))
  console.log(chalk.bold(`\n  📝 事件 (${events.length})`))
  for (const e of events.slice(0, 20)) {
    const payload = e.payload ? JSON.parse(e.payload) : {}
    const extra = e.event === "note" ? ` ${payload.content}` : ""
    console.log(chalk.gray(`    ├─ ${e.created_at} [${e.event}] ${e.actor}${extra}`))
  }
  console.log()
}

const ALL_PLATFORMS = ["claude", "codex", "opencode", "cursor"]

/** 一线 provider 优先(下拉默认视图先展示这些,避免被聚合商 302ai/requesty/openrouter 等刷屏) */
const PRIORITY_PROVIDERS = [
  "anthropic", "openai", "google", "xai", "deepseek",
  "mistral", "meta", "groq", "qwen", "moonshotai", "zhipuai", "z-ai", "cohere"
]

/** models.dev:拉取支持 tool_call 的模型清单(provider/model 串),一线 provider 优先;失败返回空 */
async function fetchToolCallModels(): Promise<string[]> {
  try {
    const res = await fetch("https://models.dev/api.json")
    const j = (await res.json()) as Record<string, { models?: Record<string, { tool_call?: boolean }> }>
    const out: string[] = []
    for (const [p, v] of Object.entries(j))
      for (const [m, mv] of Object.entries(v.models ?? {})) if (mv.tool_call) out.push(`${p}/${m}`)
    const rank = (m: string) => {
      const i = PRIORITY_PROVIDERS.indexOf(m.split("/")[0])
      return i === -1 ? PRIORITY_PROVIDERS.length : i
    }
    return [...new Set(out)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  } catch {
    return []
  }
}

interface InitAnswers {
  platforms: string[]
  endpoints: string[]
  model?: string | Record<string, string>
  language: "zh" | "en"
}

/** 交互式引导:inquirer 提示选语言 / 平台(多选)/ 端 / 模型(models.dev 搜索补全) */
async function promptInit(): Promise<InitAnswers> {
  const { checkbox, input, search, select } = await import("@inquirer/prompts")

  const language = await select<"zh" | "en">({
    message: "语言 / Language",
    choices: [
      { name: "中文", value: "zh" },
      { name: "English", value: "en" }
    ]
  })
  const zh = language === "zh"

  const platforms = await checkbox({
    message: zh ? "平台(空格勾选,回车确认)" : "Platforms (space to select, enter to confirm)",
    choices: ALL_PLATFORMS.map(p => ({ name: p, value: p, checked: p === "claude" })),
    required: true
  })

  const endpoints = (
    await input({
      message: zh ? "端(逗号分隔)" : "Endpoints (comma-separated)",
      default: "service,web"
    })
  )
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)

  const models = await fetchToolCallModels()
  const modelObj: Record<string, string> = {}
  for (const p of platforms) {
    const picked = await search<string>({
      message: zh ? `${p} 模型(输入过滤;选"默认"用平台缺省)` : `${p} model (type to filter)`,
      pageSize: 12,
      source: async term => {
        const def = { name: zh ? "(默认 / default)" : "(default)", value: "" }
        const list = models
          .filter(m => !term || m.toLowerCase().includes(term.toLowerCase()))
          .slice(0, 40)
          .map(m => ({ name: m, value: m }))
        return [def, ...list]
      }
    })
    if (picked) modelObj[p] = picked
  }

  return { platforms, endpoints, model: Object.keys(modelObj).length ? modelObj : undefined, language }
}

/** init 特例:在 config 存在之前运行,不开常规 ctx。无 flags 且在终端时进交互 */
export async function runInit(root: string, a: Record<string, any>): Promise<void> {
  let opts: {
    endpoints: string[]
    platforms?: string[]
    model?: string | Record<string, string>
    language?: "zh" | "en"
  }
  if (!a.platforms && !a.endpoints && process.stdin.isTTY) {
    const p = await promptInit()
    opts = { endpoints: p.endpoints, platforms: p.platforms, model: p.model, language: p.language }
  } else {
    if (!a.endpoints) {
      console.log(chalk.red("错误: 需要 --endpoints=service,admin,...(或在终端直接运行 init 进入交互)"))
      process.exit(1)
    }
    const platforms = a.platforms
      ? String(a.platforms).split(",").map((s: string) => s.trim()).filter(Boolean)
      : undefined
    let model: string | Record<string, string> | undefined
    if (a.model) {
      const raw = String(a.model).trim()
      model = raw.startsWith("{") ? JSON.parse(raw) : raw
    }
    const language = a.language === "en" ? "en" : a.language === "zh" ? "zh" : undefined
    opts = { endpoints: String(a.endpoints).split(","), platforms, model, language }
  }
  const r = initProject(root, {
    ...opts,
    gitHooks: a.hooks !== "false",
    preset: a.preset !== "false",
    writeHooks: a.writehooks !== "false"
  })
  const cli = r.ctx.config.cli
  console.log(chalk.green(`\n✅ 项目引导完成\n`))
  console.log(`  配置文件   ${r.configPath}`)
  console.log(`  语言       ${r.ctx.config.language}`)
  console.log(`  目标平台   ${r.platforms.join(", ")}`)
  console.log(`  文档骨架   ${r.scaffolded.length} 个目录`)
  console.log(`  预置文件   ${r.preset.length ? r.preset.join(", ") : "无(preset/ 为空或均已存在)"}`)
  console.log(`  agent 定义 ${r.agents.length} 份`)
  console.log(`  元产物注册 ${r.metaRegistered} 份(draft)`)
  console.log(`  MCP        ${r.mcpPaths.join(", ") || "未写"}`)
  console.log(`  hooks 接线 ${r.hookPaths.join(", ") || "未写(--writehooks=false)"}`)
  console.log(`  git hooks  ${r.hooks.join(", ") || "未安装(非 git 仓库)"}`)
  if (r.notes.length) {
    console.log(chalk.yellow(`\n平台提醒:`))
    for (const n of r.notes) console.log(chalk.yellow(`  • ${n}`))
  }
  console.log(chalk.bold(`\n下一步:`))
  console.log(`  1. 编辑 workbench.config.json 的 codeRoots(填每个端的代码目录约定)`)
  console.log(`  2. 启动工作台:  ${cli} serve   → http://127.0.0.1:5620`)
  console.log(`  3. 对 AI 提第一个需求,它走流水线产出契约,你在待审队列点头`)
  console.log(`  4. 契约审批后:  ${cli} plan --module=<模块>  一键派发\n`)
  r.ctx.db.close()
}

const HELP = `Workbench CLI

任务   list / show <id> / create / claim / update / remove / record
产出   output / artifacts / scan / move / input
信任   submit / approve / reject / feedback / queue / dispute / sync
流程   plan / qa / audit / intake / lint / graph / events
进化   retro [--module= --json=] / export
维护   init / gen-agents / register-meta / install-hooks / migrate`

/** 主分发(抛错由入口捕获) */
export async function runCommand(ctx: Ctx, command: string, a: Record<string, any>): Promise<void> {
  switch (command) {
    case "create": {
      if (!a.role || !a.creator) return fail("--role, --creator 必填")
      const id = createTask(ctx, { module: a.module, role: a.role, endpoint: a.endpoint, page: a.page, type: a.type, assignee: a.assignee, creator: a.creator, content: a.content })
      console.log(chalk.green(`✅ 任务 #${id} 创建成功`))
      break
    }
    case "claim": {
      if (!a.id || !a.assignee) return fail("需要任务 ID 和 --assignee")
      const { warnings } = claimTask(ctx, { id: a.id, assignee: a.assignee })
      console.log(chalk.green(`✅ 任务 #${a.id} 已由 ${a.assignee} 领取`))
      printWarnings(warnings)
      break
    }
    case "update": {
      if (!a.id || !a.status || !a.operator) return fail("需要任务 ID, --status 和 --operator")
      const { warnings } = updateTask(ctx, { id: a.id, status: a.status, operator: a.operator, force: a.force === "true" })
      console.log(chalk.green(`✅ 任务 #${a.id} 状态已更新为 ${a.status}`))
      printWarnings(warnings)
      break
    }
    case "remove":
    case "delete": {
      if (!a.id || !a.operator) return fail("需要任务 ID 和 --operator")
      removeTask(ctx, { id: a.id, operator: a.operator, force: a.force === "true" })
      console.log(chalk.green(`✅ 任务 #${a.id} 已删除`))
      break
    }
    case "record": {
      if (!a.id || !a._ || !a.operator) return fail("需要任务 ID, --operator 和内容文本")
      recordNote(ctx, { id: a.id, content: a._, operator: a.operator })
      console.log(chalk.green(`✅ 任务 #${a.id} 记录已添加`))
      break
    }
    case "output": {
      if (!a.role || !a.endpoint || !a._) return fail("需要 --role, --endpoint 和文件路径")
      const { artifactId, linkedTaskId, kind } = registerOutput(ctx, { module: a.module, role: a.role, endpoint: a.endpoint, page: a.page, filePath: a._, taskId: a.task ? parseInt(a.task) : undefined })
      console.log(chalk.green(`✅ 输出文件已添加 (artifact #${artifactId}, kind=${kind}${linkedTaskId ? `, 关联任务 #${linkedTaskId}` : ""})`))
      break
    }
    case "outputs":
    case "artifacts":
      printArtifacts(listArtifacts(ctx, { module: a.module, endpoint: a.endpoint, page: a.page, kind: a.kind }))
      break
    case "list":
      printTasks(listTasks(ctx, { status: a.status, assignee: a.assignee, module: a.module, role: a.role, endpoint: a.endpoint, type: a.type, withStale: a.stale === "true" }))
      break
    case "show": {
      if (!a.id) return fail("需要任务 ID")
      if (a.json === "true") console.log(JSON.stringify(getTaskDetail(ctx, a.id), null, 2))
      else printTaskDetail(ctx, a.id)
      break
    }
    case "records":
    case "events": {
      const rows = listEvents(ctx.db, { entityId: a.taskId ? parseInt(a.taskId) : a.id, entityType: a.taskId || a.id ? "task" : undefined, module: a.module, event: a.event, limit: a.limit ? parseInt(a.limit) : 50 })
      if (a.json === "true") return void console.log(JSON.stringify(rows, null, 2))
      for (const e of rows) {
        const payload = e.payload ? JSON.parse(e.payload) : {}
        const extra = e.event === "note" ? ` ${payload.content}` : ""
        console.log(chalk.gray(` ${e.created_at} [${e.entity_type}#${e.entity_id}] ${e.event} by ${e.actor}${extra}`))
      }
      break
    }
    case "submit": {
      if (!a._ || !a.actor) return fail("需要文件路径和 --actor")
      submitArtifact(ctx, { path: a._ }, a.actor)
      console.log(chalk.green(`✅ 已送审: ${a._}`))
      break
    }
    case "approve": {
      if (!a._ || !a.actor) return fail("需要文件路径和 --actor")
      const trivial = a.trivial === "true"
      const row = approveArtifact(ctx, { path: a._ }, a.actor, { trivial })
      console.log(chalk.green(`✅ 已审批通过${trivial ? "(trivial:已 re-bless 下游并关闭派生 review)" : ""}: ${row.path} (hash=${row.approved_hash?.slice(0, 8)})`))
      break
    }
    case "reject": {
      if (!a._ || !a.actor || !a.reason) return fail("需要文件路径, --actor 和 --reason")
      rejectArtifact(ctx, { path: a._ }, a.actor, a.reason)
      console.log(chalk.yellow(`↩ 已打回: ${a._}`))
      break
    }
    case "feedback": {
      if (!a._ || !a.actor || !a.verdict) return fail("需要文件路径, --actor 和 --verdict=+1|-1")
      const verdict = a.verdict === "+1" || a.verdict === "1" ? 1 : -1
      const { endorsed } = feedbackArtifact(ctx, { path: a._ }, { verdict, comment: a.comment, actor: a.actor, taskId: a.task ? parseInt(a.task) : undefined })
      console.log(chalk.green(`✅ 反馈已记录 (${verdict > 0 ? "👍" : "👎"})${endorsed ? " — 原型已放行" : ""}`))
      break
    }
    case "queue":
      printArtifacts(listArtifacts(ctx, {}).filter(r => r.review_status === "pending" || r.review_status === "invalidated"))
      break
    case "dispute": {
      if (!a._ || !a.actor || !a.reason) return fail("需要文件路径, --actor 和 --reason")
      disputeArtifact(ctx, { path: a._ }, a.actor, a.reason)
      console.log(chalk.yellow(`⚖ 异议已留痕,等待用户裁决: ${a._}`))
      break
    }
    case "sync": {
      const s = syncArtifacts(ctx, a.actor || "sync")
      console.log(chalk.green(`✅ 对账完成:检查 ${s.checked},变更 ${s.changed},失效 ${s.invalidated},墓碑 ${s.tombstoned},派 review ${s.reviewsSpawned}`))
      break
    }
    case "plan": {
      if (!a.module) return fail("需要 --module")
      const s = planModule(ctx, a.module, a.creator || "product-manager")
      console.log(chalk.green(`✅ 派发完成:新建 ${s.created.length},跳过 ${s.skipped},取消 ${s.cancelled}`))
      for (const t of s.created) console.log(chalk.cyan(`  + #${t.id} ${t.role} ${t.endpoint ?? "-"} ${t.page ?? ""} (${t.type})`))
      printWarnings(s.warnings)
      break
    }
    case "qa": {
      if (!a.id || !a.result || !a.operator) return fail("需要任务 ID, --result=pass|fail 和 --operator;fail 需 --reason")
      const { reworkTaskId } = recordQaResult(ctx, { id: a.id, result: a.result, reason: a.reason, operator: a.operator })
      console.log(chalk.green(`✅ 验收结果已记录: ${a.result}${reworkTaskId ? `,已派 rework #${reworkTaskId}` : ""}`))
      break
    }
    case "audit": {
      if (!a.module) return fail("需要 --module")
      const r = auditModule(ctx, a.module)
      console.log(chalk.bold(`\n═══ 模块 ${r.module} 对账报告 ═══  清算状态: ${r.cleared ? chalk.green("✅ 已清算") : chalk.yellow("⚠ 未清算")}\n`))
      for (const c of r.contracts) {
        const st = { draft: chalk.gray("📝 草稿"), pending: chalk.yellow("⏳ 待审"), approved: chalk.green("✅ 已审批"), invalidated: chalk.red("⚠ 已失效") }[c.status]
        console.log(`  ${st} [${c.kind}] ${c.path}${c.onDisk ? "" : chalk.red(" (磁盘缺失!)")}`)
      }
      console.log(chalk.bold(`\n  code 目录 ${r.codeDirs.length} 个`))
      if (r.suggestedSubmits.length > 0) {
        console.log(chalk.cyan(`\n  对账后可批量送审(与代码核实一致后执行):`))
        for (const p of r.suggestedSubmits) console.log(chalk.gray(`    ${ctx.config.cli} submit --actor=architect -- ${p}`))
      }
      console.log()
      break
    }
    case "intake": {
      const s = intakeIssues(ctx)
      console.log(chalk.green(`✅ intake:拉取 ${s.fetched},新建 ${s.created.length},已关联跳过 ${s.skipped}`))
      for (const c of s.created) console.log(chalk.cyan(`  gh#${c.issue} → 任务 #${c.taskId} (${c.lane === "hotfix" ? "快车道 hotfix" : "PM 分析"})`))
      break
    }
    case "retro":
    case "retrospective": {
      const report = runRetrospective(ctx, { module: a.module })
      if (a.json === "true") return void console.log(JSON.stringify(report, null, 2))
      const BUCKET_TEXT: Record<string, string> = {
        "skill-candidate": chalk.green("🌱 skill 候选"),
        "red-flag": chalk.red("🚩 Red Flag"),
        observation: chalk.gray("👀 观察")
      }
      console.log(chalk.bold(`\n═══ Retrospective${report.module ? `(模块 ${report.module})` : ""} ═══  半衰期 ${report.halfLifeDays} 天\n`))
      if (report.groups.length === 0) console.log(chalk.yellow("  尚无反馈数据"))
      for (const g of report.groups) {
        const reason = g.reason === "mixed" ? "(信号矛盾)" : g.reason === "insufficient" ? "(样本不足)" : ""
        console.log(`  ${BUCKET_TEXT[g.bucket]}${reason} [${g.endpoint}/${g.kind}]  +${g.posScore} / -${g.negScore}(${g.evidence.length} 条反馈)`)
        for (const e of g.evidence.filter(e => e.verdict === -1 && e.comment)) {
          console.log(chalk.red(`      👎 ${e.comment}  (${e.path})`))
        }
      }
      const ap = report.approval
      console.log(chalk.bold(`\n  审批吞吐:`) + ` 通过 ${ap.approved},打回 ${ap.rejected}` +
        `${ap.rejectionRate !== null ? `,打回率 ${Math.round(ap.rejectionRate * 100)}%` : ""}` +
        `${ap.avgApprovalHours !== null ? `,送审→通过平均 ${ap.avgApprovalHours} 小时` : ""}`)
      console.log(chalk.bold(`\n  下一步:`))
      for (const gd of report.guidance) console.log(chalk.cyan(`    → ${gd}`))
      console.log()
      break
    }
    case "export": {
      const r = exportEventLog(ctx)
      console.log(chalk.green(`✅ 已导出 events ${r.events} 条,feedback ${r.feedbacks} 条 → ${r.files.join(", ")}`))
      break
    }
    case "lint": {
      const role = (a.role || "developer") as "developer" | "architect"
      const violations = runProtocolLints(ctx, { role, endpoint: a.endpoint })
      if (violations.length === 0) console.log(chalk.green("✅ 协议 lint 通过,无违例"))
      else {
        console.log(chalk.red(`✗ ${violations.length} 处违例:`))
        for (const v of violations) console.log(chalk.red(`  ${v.file}:${v.line} [${v.lint}] ${v.message}`))
        process.exit(1)
      }
      break
    }
    case "graph": {
      if (!a.module) return fail("需要 --module")
      console.log(graphModule(ctx, a.module))
      break
    }
    case "scan": {
      const s = scanArtifacts(ctx, a.actor || "system")
      console.log(chalk.green(`✅ 扫描完成:新登记 ${s.registered},内容刷新 ${s.refreshed},新增边 ${s.edges},排除元产物 ${s.skipped.length}`))
      break
    }
    case "move": {
      if (!a.from || !a.to || !a.actor) return fail("需要 --from, --to 和 --actor")
      const moved = moveArtifact(ctx, { from: a.from, to: a.to, actor: a.actor })
      console.log(chalk.green(`✅ 已移动(保 id #${moved.id}): ${a.from} → ${moved.path}`))
      break
    }
    case "input": {
      if (!a.id || !a._ || !a.operator) return fail("需要任务 ID, --operator 和产物路径")
      addTaskInput(ctx, { id: a.id, path: a._, operator: a.operator })
      console.log(chalk.green(`✅ 任务 #${a.id} 已补充申报依赖: ${a._}`))
      break
    }
    case "gen-agents": {
      const { written } = genAgents(ctx)
      console.log(chalk.green(`✅ agent 定义已从模板生成(路径由注册表注入):`))
      for (const w of written) console.log(chalk.cyan(`  → ${w}`))
      break
    }
    case "register-meta": {
      const { registered, skipped } = registerMetaArtifacts(ctx, a.actor || "system")
      console.log(chalk.green(`✅ 元产物注册:新增 ${registered.length},已存在跳过 ${skipped.length}`))
      for (const r of registered) console.log(chalk.cyan(`  + [${r.kind}] ${r.path}`))
      break
    }
    case "install-hooks": {
      const installed = installGitHooks(ctx)
      console.log(chalk.green(`✅ git hooks 已安装: ${installed.join(", ")}`))
      break
    }
    case "migrate": {
      const summary = migrateLegacy(ctx, a.from)
      console.log(chalk.green(`✅ 迁移完成:任务 ${summary.tasks},产物 ${summary.artifacts}(关联 ${summary.linkedOutputs}),记录 ${summary.notes}`))
      if (summary.missingFiles.length > 0) {
        console.log(chalk.yellow(`⚠ ${summary.missingFiles.length} 个产出文件已不在磁盘上(hash 置空)`))
      }
      break
    }
    case "help":
      console.log(HELP)
      break
    default:
      console.log(chalk.red(`未知命令: ${command}`))
      console.log(HELP)
      process.exit(1)
  }
}

function fail(msg: string): void {
  console.log(chalk.red(`错误: ${msg}`))
  process.exit(1)
}
