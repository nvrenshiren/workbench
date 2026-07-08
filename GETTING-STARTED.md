# Workbench 使用教程

一套 **drift-enforced、spec-anchored 的 AI 开发执行层**。它的赌注只有一条:
生成无限快之后,**验证是唯一瓶颈**——所以把你的每一次验证(审批、反馈)铸成机器可读、
可失效、可传播的资产,让 AI 千次消费零边际成本。

你在这套系统里只做三件事:**在待审队列点头/摇头、给产物点 👍👎、回答几个裁决**。
写规则、定路径、派任务、跑测试、对齐变更——全部是 AI 的活 + 数据库的事。

---

## 一、前置要求

| 必需 | 说明 |
| --- | --- |
| Node.js ≥ 22 | 引擎运行时 |
| pnpm(或 npm) | 装依赖;better-sqlite3 需原生构建 |
| git | 变更传播 / 归因(可选但强烈建议) |
| Claude Code | AI 端(agent 定义 + MCP + hooks 自动生效) |
| 可选 | `gh` CLI(issue intake)、`flutter`(app 端验收) |

---

## 二、五分钟上手

### 1. 把 workbench 放进你的新项目

```
my-project/
└── workbench/          ← 把这个文件夹整个拷进来
```

workbench 是"租客":它作为子文件夹住进任何项目,引擎零业务耦合。项目专属的东西
(配置 / 数据库 / 生成的 agent)全在项目根,不在 workbench 里。

### 2. 装依赖

```bash
cd my-project/workbench
pnpm install          # better-sqlite3 若被拦,pnpm approve-builds 后 pnpm rebuild
cd ..
```

> pnpm 11 默认拦截原生构建脚本。若 `better-sqlite3` 没编译,运行
> `cd workbench && pnpm approve-builds`(勾选 better-sqlite3)再 `pnpm rebuild`,或改用 `npm install`。

### 3. 一键引导

在**项目根**运行(声明你有哪些端):

```bash
npx tsx workbench/cli.ts init --endpoints=service,admin,weapp,app
# 纯后端项目:   --endpoints=service         (自动裁掉 designer;qa 保留)
# 前后端:       --endpoints=service,web
```

它会生成:`workbench.config.json`、`docs/` 骨架、`.claude/agents/*`(按你的端裁剪)、
`.mcp.json`、git hooks、以及数据库 `.workbench/`。

> **预置文件部署**:`workbench/preset/` 下的所有文件(含 dotfiles / 子目录,保留相对结构)会一并
> 部署到项目根——放你项目通用的脚手架(如 `.editorconfig`、`.prettierrc`、`.gitignore` 模板,以及
> 一个最小 `package.json`——含 `tsx`,让裸项目开箱即可 `npx tsx` 跑 workbench)。
> 与其余步骤一致的**幂等防覆盖**:项目根已存在同名文件则跳过,不动你已有的(已有 `package.json`
> 但缺 `tsx` 时,init 会单独补上 `tsx` devDep,不覆盖你的文件)。`--preset=false` 可关。

### 4. 填代码目录约定,启动工作台

编辑 `workbench.config.json` 的 `codeRoots`(见 §八),然后:

```bash
cd workbench && pnpm start          # 首次/前端更新后:先 web:build 再 serve → http://127.0.0.1:5620
# 前端已 build 过、只想重启后端:pnpm run serve
```

> ⚠️ `pnpm run serve` 只起 API,不 build 前端。若前端 `web/dist` 还没生成就直接 `serve`,
> 访问根路由 `/` 会得到 `Route GET:/ not found`(404)——因为静态托管在 server 启动时才按
> `existsSync(web/dist)` 注册。**首次或前端改动后用 `pnpm start`**;build 完必须重启 server 才生效。

浏览器打开就是你的工作台。此刻它是空的——因为还没有需求。

---

## 三、日常工作流:一个需求的完整旅程

假设你要做"用户可以收藏房源"。你只需对 AI(Claude Code)说这一句。之后:

```
① 你提需求(一句话)
        ↓
② 判车道:小 bug/微调 → 快车道 hotfix;新功能 → 标准道(如下)
        ↓
③ PM 逐层产契约:flow → 模块 PRD → 页面 PRD
   每层送审 → 停在你的【待审队列】→ 你看 diff 点【通过】→ 才进下一层
        ↓
④ 契约批准后:plan 一键派发整组任务(architect / designer / developer / qa)
        ↓
⑤ AI 干活(你只看工作台的树实时变色):
   architect 设计 DB+API → 送审 → 你批
   designer 出设计系统+原型 → 你在工作台预览点 👍 放行
   developer 按批准的契约实现(approved = 真相,不发散)
        ↓
⑥ QA 验收:不通过自动派 rework → developer 修 → 自动复验,循环到通过(不消耗你)
        ↓
⑦ 你顺手给代码/原型点 👍👎(👎 附一句原因,喂进化管道)
        ↓
⑧ 模块 accepted
```

**你的总介入 = 前端几次"看 diff 点头" + 沿途几次 👍。** 需求质量的博弈全部前置到
文档阶段,之后是确定性的机械执行。

### 变更来了怎么办(体系最值钱的部分)

任何时候——哪怕模块早已完成——只要某份 approved 文档被改:

- `git commit` 后 hook 自动 `sync` 对账 → 该文档 approved **自动失效**
- 沿依赖图找到所有下游 → **自动派 review 任务**给对应角色
- 工作台上对应节点**变黄**,待审队列多出"复审后重新送审"的条目

变更响应不依赖任何人"想起来"——这是它和普通 AI 协作最本质的区别。

---

## 四、你的三个动作(其余都是 AI 的)

| 动作 | 在哪做 | 什么时候 |
| --- | --- | --- |
| **审批契约** | 工作台【待审队列】看 diff → 通过 / trivial 通过 / 打回 | 队列出现新条目时 |
| **放行/反馈** | 产物查看器点 👍(原型=放行)/ 👎(附原因) | 看到原型或代码时 |
| **回答裁决** | 直接对 AI 说 | AI 停下来问、或 dispute 留痕时 |

- **通过**:从此 AI 把它当真相直接用,不再向你确认。别橡皮图章,但也不必逐字精读。
- **trivial 通过**:非破坏性小改——自动解除下游 stale + 关闭已派 review,降摩擦。
- **打回**:必附原因(进事件流),对应 agent 照改重来。

---

## 五、命令速查

所有命令:`npx tsx workbench/cli.ts <command>`(独立项目)。日常你几乎只用工作台,
命令主要给 AI 和调试用。

```bash
# 引导 / 维护
init --endpoints=...          # 新项目一键引导
gen-agents                    # 从模板重新生成 agent 定义(改了 config 后)
register-meta                 # 注册 agent/skill/PLAN 等元产物
install-hooks                 # 安装 git hooks
scan                          # 全量扫描登记 docs+代码,推导依赖图
sync                          # 全量对账(改了文档没 commit 时手动跑)

# 查看
list [--role= --status= --module=]   # 任务列表
artifacts [--module= --kind=]        # 产物 + 审批状态
queue                                # 待审队列
graph --module=<模块>                # 输出该模块依赖图(Mermaid)
audit --module=<模块>                # 模块对账报告(清算用)

# 人的动作(通常在工作台点,不敲命令)
approve --actor=user -- <路径>       # 审批通过(--trivial=true 非破坏性)
reject  --actor=user --reason= -- <路径>
feedback --actor=user --verdict=+1 -- <路径>

# 流程(通常 AI 敲)
plan --module=<模块>                 # 派发整组任务
qa <id> --result=pass|fail --operator=qa [--reason=]
intake                               # 从 gh issues 分诊建任务

# 进化(M8)
retro [--module= --json=true]        # 反馈加权提炼(skill 候选/Red Flags)+ 审批吞吐报表
export                               # events/feedback 导出 jsonl(post-commit 自动跑)
```

---

## 六、工作台界面

- **左侧树**:项目 → 模块 → 端 → 页面。每个节点一个健康色点:
  🟢 ok / 🟡 stale(上游变了)/ 🟣 blocked(缺前置)/ 🔴 failed(QA/检查挂)。
  顶部"元产物"开关控制 agent/skill/PLAN 是否显示。
- **待审队列**(左上按钮,带数字徽标):逐份 diff 对比上一批准版,通过/打回按钮。
- **节点面板**:产物(点开看渲染的 markdown/mermaid、原型 iframe、代码 Monaco)、
  任务表、实时事件时间线。
- **原型**:沙箱 iframe 渲染,375/768/1280 三档视口切换,右上 👍👎。
- **Sync 按钮**:手动对账(改了文件没 commit 时用)。

实时性:CLI/AI 的任何操作,2 秒内反映到树和事件流(SSE 推送,不靠文件监听)。

---

## 七、接入 AI(Claude Code)

`init` 已把三样东西就位,下个 Claude Code 会话自动生效:

1. **agent 定义**(`.claude/agents/*.md`):五个角色(PM/architect/designer/developer/qa),
   路径由 kind 注册表注入、信任协议内置。**改目录约定 → 改 config → `gen-agents` 重生成**,
   规则和路径永远单一真相源。
2. **MCP**(`.mcp.json`):AI 通过 `wb_*` typed tools 操作(claim/output/submit/plan/qa…),
   比敲 CLI 更稳。**审批 approve/reject 刻意不暴露给 AI——那是你的动作**。
3. **hooks**(`.claude/settings.json` + git hooks):
   - PostToolUse:AI 改文件后秒级刷新 hash(工作台即时变黄)
   - PreToolUse:写闸门(observe 观察期,只记 `would_block` 事件不拦)
   - post-commit:自动 sync + 孤儿提交检测

> settings.json 的 hook 项 init 不会自动写(避免覆盖你的配置)。参考 workbench/README.md
> 的 hooks 片段手动加进 `.claude/settings.json`。

---

## 八、配置详解(workbench.config.json)

```jsonc
{
  "endpoints": ["service", "admin"],          // 你的端
  "pipeline": ["product-manager", "architect", "developer", "qa"],  // 角色流水线;不含的角色不派任务
  "cli": "npx tsx workbench/cli.ts",          // 注入 agent 定义的 CLI 前缀
  "codeRoots": {                              // 【必填】每端代码目录,{module} 是模块名占位
    "service": ["service/src/modules/{module}"],
    "admin":   ["admin/src/pages/{module}"]
  },
  "moduleMapping": { "userProfile": "user" },  // 细模块归并到粗模块
  "machineChecks": {                          // developer complete 时跑(enabled=true 才生效)
    "enabled": false,
    "service": ["cd service && npx tsc --noEmit"]
  },
  "protocolLints": [                          // 能机器查的约定 → 降级为 lint(违例阻断 complete)
    { "name": "no-page-size", "grep": "pageSize", "paths": ["service/src"], "endpoint": "service",
      "message": "分页统一 take/skip", "allow": ["既有债文件路径"] }
  ],
  "gates": {
    "approvalMode": "warn",                   // warn=未审批只警告 / enforce=阻断(清算铺开后再切)
    "writeGate": "observe"                     // off / observe(只记录)/ enforce(拦改 approved 契约)
  },
  "git": { "taskTrailer": "off", "trailerKey": "Task" }  // on=提交注入 Task:#id 归因 trailer
}
```

### kind 注册表(高级,一般不用改)

产物类型的全部规则(路径约定 / 审批通道 / 依赖父级 / 是否驱动 stale / hash 策略)集中在
`workbench/core/kind.ts` 的 `DEFAULT_KIND_REGISTRY`。想改目录结构或加产物类型,在 config 里
加 `"kinds": { "<kind>": { "pathPatterns": [...], "parents": [...] } }` 覆盖即可——
这一张表同时驱动扫描、依赖图、gate、审批分流。

---

## 九、核心概念(读一遍,受用一直)

- **五态审批**:draft(草稿,零摩擦)→ pending(送审)→ approved(真相)→ invalidated(改过失效)
  → re-pending(失效后重送,仍禁用直到复审)。**状态永远派生,不落库**——文件一改,状态在数学上就变。
- **信任协议**:AI 对 approved 产物直接当真相用,不发散不复述;对 draft 标注"未审";
  对 invalidated 禁用并要求复审。
- **双车道**:标准道(新功能,全流程)vs 快车道 hotfix(跳过文档 gate,但登记义务不豁免;
  触碰契约会自动补文档 review)。小事永远有小门。
- **懒清算**:存量项目所有旧文档初始 draft、零信任。**用到哪个模块才清算哪个**——
  `audit --module=X` 出对账报告,架构师核实文档 vs 代码,你批准,该模块从此有真相锚点。
  没人碰的模块永远 draft,不花你一分钟。
- **元产物入体系**:agent 定义、skill、PLAN 自身也注册为产物、走审批——驱动系统的文件
  不能游离于系统之外。
- **反馈进化**:你的 👍👎 和 QA 结果按半衰期加权累积;`retro` 出确定性证据包
  (3 正例 → skill 候选 / 2 负例 → Red Flags / 混杂观察),AI 据此起草 skill 草稿,
  **人审通过才作为经验生效**——经验也是契约,不会悄悄改变 AI 行为。

---

## 十、目录结构

```
my-project/
├── workbench/              # 引擎(租客,零业务耦合)
│   ├── core/               #   逻辑:schema/gates/tree/kind 注册表/commands
│   ├── server/             #   Fastify 只读+写 API / SSE / MCP 端点
│   ├── web/                #   React 工作台前端
│   ├── templates/agents/   #   agent 定义模板({{CLI}} {{PATH_*}} 占位)
│   ├── scripts/            #   hooks(PostToolUse/PreToolUse/post-commit)
│   ├── cli.ts              #   CLI 入口
│   └── GETTING-STARTED.md  #   本文
├── workbench.config.json   # 项目层配置(init 生成)
├── .workbench/             # 数据:workbench.db + approved/ 存档 + approvals.json(入 git)
├── .claude/agents/         # 生成的 agent 定义(元产物)
├── .mcp.json               # MCP 注册
└── docs/                   # 契约的家:prd/ architecture/ design/ acceptance/
```

---

## 十一、故障排查

| 现象 | 处理 |
| --- | --- |
| `better-sqlite3` 报错 | `cd workbench && pnpm approve-builds` 勾选后 `pnpm rebuild`,或 `npm install` |
| 工作台空/树不动 | 先 `scan` 登记产物;改了文件没 commit 时点 Sync 或 `sync` |
| gate 拦住任务 | 报错都是可行动的——按提示等上游产出/审批;stale 拦截先对齐或 `--force=true` |
| 很多 draft 文档 | 正常。draft=零摩擦,不用全审;用到某模块时才 `audit` 清算 |
| agent 用了错的 CLI 路径 | 检查 config 的 `cli` 字段,改后 `gen-agents` 重生成 |
| 数据库想重建 | 删 `.workbench/workbench.db` → `scan` + `register-meta` 重造产物图(审批需从 approvals.json 恢复) |

---

有了这些,你已经能独立跑起整套流程。**第一步永远是:提一个真实需求给 AI,然后去待审队列等它。**
