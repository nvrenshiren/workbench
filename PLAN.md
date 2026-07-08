# Workbench 开发计划（v3 终稿）

> 状态：M0–M8 全部完成;M9(向量发现层)可选,待校准点数据裁决
> 本文档是整套 AI 工作流升级（数据层 / 信任体系 / 双车道 / QA / 进化 / 可视化工作台）的唯一计划真相。
> 此前对话中的所有设计讨论以本文档的裁决为准。
> **定位**：drift-enforced、spec-anchored 的执行层。核心赌注只有一条——生成无限快之后,
> 验证是唯一瓶颈;把人的验证铸成机器可读、可失效、可传播的资产(approved_hash),
> 让千次消费零边际成本。所有设计决策服从这个赌注。

---

## 〇、系统宪法（七条不变式,与任何后续设计冲突时以此为准）

1. **派生优先**：状态永远派生不落库(五态/stale/health/everApproved)。
2. **智能夹在两道确定性之间**：AI 出草稿 → 人审锚定 → 机器展开与把关。任何 AI 判断必须先固化为 approved 产物才有资格驱动下游。
3. **翻转默认**：一切"agent 自觉"必须翻转为"系统默认 + 机器兜底"(task_inputs 自动注入、trailer hook 注入、孤儿提交拦截)。发现新的自觉制依赖 = 发现新 bug。
4. **契约走注入,发现走检索**：gate 注入 100% 确定性送达;语义检索只提案、申报才算数。
5. **登记独立于 git 状态**：自研 hash(CRLF 归一 + ignore 集),git 只是监听层之一。
6. **闸门 fail-closed(新闸门经观察期数据达标后转正),观测 fail-open**：gate/PreToolUse 拦截失败即阻断;PostToolUse/sync 失败只留痕不挡路。新闸门先以"只记日志"模式跑观察期,误拦率达标再翻 fail-closed——闸门本身也要过校准。
7. **元产物入体系**：agent 定义、skill、hook 脚本、PLAN 自身皆注册为 artifact(kind: agent-def/skill/hook-script/plan)。**注册与审批解耦**：现在即全部注册为 draft(零摩擦,白嫖变更留痕),审批时点分层——agent-def/skill/hook 于 **M4 出口**锚定(M4 全程在重写它们,起点锚定=每次迭代都失效),PLAN 于校准点过后锚定(施工图→竣工图)。

## 〇.1 反清单（明确不做,防未来自己推翻自己）

- **plan 不引入 AI 分析**——毁审批前置/幂等/可解释
- **契约上下文不走 RAG**——一次 miss = 静默违约
- **不用 fs watch**——Windows 不可靠,hook 栈替代
- **登记指纹不用 git hash**——未 commit 文件拿不到
- **不做 spec-as-source**——不确定性代价过高
- **不追 autonomy 最大化**——用户意图不可被 orchestrator 推翻
- **多人协作/远程部署维持非目标**
- **代码 embedding 缓行**——grep + hash 锚定摘要先行,M4 实测不够再上(M9 可选)
- 竞品扫描结论一律作**定位假设**而非事实;开源启动前重扫,话术以新扫描为准

---

## 一、目标与非目标

### 目标

1. **真实关系链**：文档 → 任务 → 产出在数据库中以外键与 DAG 边存在，非命名约定
2. **信任锚点**：契约文档经人工审批（approved_hash），修改自动失效；AI 对 approved 产物视为真相
3. **双车道**：标准道（全流程）与快车道（hotfix，豁免文档义务、不豁免登记义务）
4. **变更传播**：任何登记产物修改 → 自动失效 → 下游 stale → 自动派 review 任务
5. **QA 闭环**：PM 写业务验收口径，QA 翻译执行；developer 完成 ≠ 任务完成
6. **反馈进化**：代码/原型走 👍👎 反馈，加权后提炼 skill（人审后生效）
7. **可视化工作台**：树（项目→模块→端→页面）+ 内容渲染 + 审批/反馈/派发操作 + 实时事件流
8. **通用可移植**：通用层（引擎）与项目层（配置）物理切割，最终打包为 plugin

### 非目标（本期不做）

- 多人协作 / 远程部署（纯本地单用户工具）
- 任务系统的细粒度权限（operator 字符串校验足够）
- 旧 legacy 任务的历史关系补建（历史就是历史）

---

## 二、统一数据模型（schema v2）

替换 `tasks/db.ts` 现有三表。旧库整体迁移（见 M1）。

> ⚠️ **本节为 v2 原始设计,非 as-built。** M0.5 后实现有差异:`tasks.endpoint` 改 nullable、
> `type` 增 `rework`、artifact kind 增 `doc/agent-def/skill/hook-script/plan`;表实现已迁至
> `core/db.ts`(非 `tasks/db.ts`)。当前 schema 以 §六里程碑注记 +
> `core/db.ts` / `core/kind.ts` / `core/types.ts` 为准。

```sql
-- ① 产物表：一切登记物（文档/原型/代码目录/基线）
CREATE TABLE artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,        -- baseline|project|roles|glossary|flow|module-prd|page-prd|
                                      -- db-doc|api-doc|design-system|design-prompt|prototype|
                                      -- acceptance|code
  module        TEXT,                 -- 项目级产物(baseline/project/roles/glossary)为 NULL
  endpoint      TEXT,                 -- common|service|admin|weapp|app,项目级为 NULL
  page          TEXT,
  path          TEXT NOT NULL UNIQUE, -- 文件路径;code 类为目录路径
  content_hash  TEXT NOT NULL,        -- 文件 sha1;目录=按相对路径排序逐文件 sha1 后整体 sha1
  approved_hash TEXT,                 -- 审批通过时刻的 content_hash
  reviewed_by   TEXT,
  reviewed_at   DATETIME,
  submitted_at  DATETIME,             -- 送审时间
  submitted_hash TEXT,                -- 送审时刻的 content_hash(五态模型的关键)
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 审批状态永远派生,不存储(五态模型,按优先级):
--   approved_hash = content_hash                     → approved
--   submitted_hash = content_hash (≠ approved_hash)  → pending(含"失效后重新送审")
--   approved_hash 非空                                → invalidated(曾批准,已修改,未重新送审)
--   其余                                              → draft(含"送审后又编辑"的撤审,留 submission_stale 事件)
-- reject 清空 submitted_at + submitted_hash。
-- everApproved(approved_hash 非空)标记 re-pending:曾获批的 pending 在信任协议中沿用禁用待遇。

-- ② DAG 边:上游 → 下游(derives 关系)
CREATE TABLE artifact_edges (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES artifacts(id),  -- 上游
  to_id   INTEGER NOT NULL REFERENCES artifacts(id),  -- 下游
  UNIQUE(from_id, to_id)
);

-- ③ 任务表
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  module     TEXT,
  role       TEXT NOT NULL,   -- product-manager|architect|designer|developer|qa
  endpoint   TEXT NOT NULL,
  page       TEXT,
  type       TEXT NOT NULL DEFAULT 'build',  -- build|review|qa|hotfix|baseline|legacy
  status     TEXT NOT NULL DEFAULT 'pending',-- pending|in_progress|completed|cancelled
  assignee   TEXT,
  creator    TEXT NOT NULL,
  content    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 任务 stale 永远派生:存在 task_inputs 行,其 input_hash ≠ 对应 artifact 当前 content_hash

-- ④ 任务输入:claim 时快照上游产物指纹(stale 判定的事实来源)
CREATE TABLE task_inputs (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  input_hash  TEXT NOT NULL,
  UNIQUE(task_id, artifact_id)
);

-- ⑤ 任务产出:真实外键
CREATE TABLE task_outputs (
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
  UNIQUE(task_id, artifact_id)
);

-- ⑥ 事件流:append-only,一切写操作同事务留痕
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,   -- task|artifact
  entity_id   INTEGER NOT NULL,
  event       TEXT NOT NULL,   -- created|claimed|completed|cancelled|output_added|
                               -- submitted|approved|rejected|approval_invalidated|
                               -- feedback|review_spawned|qa_passed|qa_failed|migrated
  actor       TEXT NOT NULL,
  payload     TEXT,            -- JSON
  module      TEXT, endpoint TEXT, page TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ⑦ 反馈表:代码/原型的 👍👎
CREATE TABLE artifact_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id  INTEGER NOT NULL REFERENCES artifacts(id),
  task_id      INTEGER REFERENCES tasks(id),
  verdict      INTEGER NOT NULL,   -- +1 | -1
  comment      TEXT,               -- verdict=-1 时必填(commands 层强制)
  content_hash TEXT NOT NULL,      -- 反馈时刻指纹
  actor        TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 派生状态规则（实现于 core，禁止落库）

| 派生量            | 规则                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| artifact 审批状态 | 见 schema 注释五态                                                                                                                    |
| task stale        | 任一 task_inputs.input_hash ≠ artifact 当前 hash                                                                                      |
| 原型放行          | prototype 类 artifact 存在 verdict=+1 且 content_hash=当前 hash 的反馈；👍 动作同时写 approved_hash（反馈与审批合一，仅限 prototype） |
| 节点 phase        | 该坐标下角色流水线推进位置（pm→architect→designer→developer→qa）                                                                      |
| 节点 health       | failed > blocked > stale > ok，向上聚合取最差                                                                                         |
| 节点 failed       | 该坐标最近一次 qa / 机器检查事件为失败                                                                                                |
| 节点 blocked      | 存在 pending 任务其 exist 级 gate 当前不可满足（M2 树渲染时懒计算，不缓存）                                                           |
| 模块清算状态      | 该模块存在任一 legacy 前 artifact 未 approved → uncleared（懒清算 gate 用）                                                           |

### task_inputs 与 stale 驱动规则

- **系统默认申报**：claim 时 gate 矩阵匹配到的上游产物 + baseline **自动注入** task_inputs,agent 只负责用 `input` 命令追加额外依赖(M1)——把"agent 记得申报"翻转为"系统默认申报、agent 补充"
- **什么驱动 stale 由 kind 注册表的 `drivesStale` 字段声明**(M1),而非散落的 prose 规则。现状等价规则:gate 注入的都驱动(含已 👍 原型),code 从不被 gate 注入、不驱动 stale——同模块并行 developer 任务不会经共享 code 目录互相 stale
- **stale 任务 complete 默认拦截**,`--force=true` 放行并写事件留痕(与快车道哲学一致)

### hash 规范

- 自研 hash,**不用 git blob/tree hash**——agent 写完立即登记,此时文件常未 commit 甚至未 add,登记流程不被 git 状态绑架
- 文本文件换行归一(CRLF/CR→LF)后再 hash,防 git autocrlf 幻影失效;二进制原样(前 8KB null 字节嗅探)
- 目录聚合忽略集:node_modules/.git/dist/build/.workbench + lockfile/.DS_Store/Thumbs.db
- 路径归一:统一正斜杠 + 取磁盘真实大小写(防 Windows 下大小写变体骗过 UNIQUE)
- kind 注册表的 `hashMode` 字段(text-normalize / binary / directory)统一管辖归一策略(M1)

### 并发与灾备

- WAL + busy_timeout=5000;claim 原子化(`UPDATE ... WHERE status='pending' AND (assignee IS NULL OR assignee=本人)`,查影响行数),并发 agent 撞车即失败
- 每次审批后 dump `.workbench/approvals.json`(path/approved_hash/reviewed_by/reviewed_at 排序快照)进 git——灾备 + 信任状态进入版本历史可审计

---

## 三、信任体系与车道规则

### 信任协议（注入所有 agent 定义）

| 上游产物状态                   | agent 行为                                                           |
| ------------------------------ | -------------------------------------------------------------------- |
| approved                       | 视为真相直接使用；禁止重新推导、禁止向用户重复确认                   |
| pending / draft（从未获批）    | 可用但产出标注"基于未审文档"，疑点即停                               |
| pending 且曾获批（re-pending） | **禁用**——未经复核的契约修订版，作者的 submit 动作无权恢复下游使用权 |
| invalidated                    | 禁用，停止并要求上游复审                                             |

对 approved 内容有实质异议时不得擅自偏离：写 `dispute` 事件并停止,等用户裁决（M3 落地）。

### 审批 vs 反馈的分工

| 产物                                                                    | 通道                                                      |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 契约文档（baseline/roles/glossary/flow/PRD/API 文档/设计系统/验收标准） | 人工审批（approved_hash）                                 |
| 设计提示词                                                              | 仅登记，不设人审闸门（工作底稿）                          |
| HTML 原型                                                               | 👍 = 反馈 + 审批合一（放行 developer）；👎 必附原因，打回 |
| 代码目录                                                                | 机器检查 + QA 验收 = 等效审批；👍👎 为品味信号            |

### 双车道

|           | 标准道                 | 快车道（hotfix）                                                            |
| --------- | ---------------------- | --------------------------------------------------------------------------- |
| 适用      | 新模块/新页面/契约变更 | bugfix、微调                                                                |
| 文档 gate | 全部上游 approved      | 豁免                                                                        |
| 登记义务  | 有                     | **有（不豁免）**：complete 时必须登记触碰的 artifact                        |
| 机器检查  | 有                     | 有                                                                          |
| 升级检测  | —                      | complete 时：触碰路径 ∩ 契约 artifact 路径 ≠ ∅ → 自动生成补文档 review 任务 |

### approvalMode 过渡策略

`gates.approvalMode` 配置项:`warn`(默认,M0–M5 孵化期) / `enforce`(M6 清算启动后切换)。
warn 模式下 exist 级缺失照常阻断(与旧 CLI 等价),approved 级不满足仅记信任警告——
避免存量 306 份 draft 产物在清算完成前卡死全部任务。

### claim gate 矩阵（v2）

| role/type          | 要求 approved 的上游                                              |
| ------------------ | ----------------------------------------------------------------- |
| architect(build)   | 模块 flow + module PRD                                            |
| designer(设计系统) | baseline                                                          |
| designer(页面)     | page PRD + API 文档 + 该端设计系统                                |
| developer(service) | DB 文档 + base/API 文档                                           |
| developer(前端)    | 对应端 API 文档 + 原型已 👍                                       |
| qa                 | 验收标准 approved + developer 任务 completed                      |
| hotfix             | 无文档 gate；模块 uncleared 时提示先清算（可 --force 跳过并留痕） |
| review             | 无（复审本身就是去修真相）                                        |

### review 任务去重

sync 发现失效时，若目标 artifact 已存在 open（pending/in_progress）的 review 任务则不重复生成，仅追加 event。

---

## 四、代码组织（通用层切割）

> ⚠️ **本节为孵化期(与宿主共生)设计,仓库现已抽离为纯工具:** CLI 已统一为
> `cli.ts` + `cli-runner.ts`(不存在 `tasks/task-cli.ts`),目录树里的顶层 `tasks/` 已不适用;
> 下方 config 已中性化为通用示例(不再含宿主端划分/包名/模块映射)。字段默认值与实际行为
> 以 `core/config.ts` + 项目根 `workbench.config.json` 为准。

### 孵化与抽离策略

- **孵化期（M0–M6）**：代码住本仓库顶层 `workbench/`（不放 `packages/*`——那是业务库，依赖边界不同），与第一个客户共生迭代
- **抽离（M7）**：`git subtree split` → 独立仓库 → changesets 发 `@whzhuke/workbench` → house 转 devDependency → plugin 打包
- **可移植性纪律（M0 起 lint 强制）**：
  1. 零业务 import（禁止引用 service/admin/packages 等任何业务代码，CI 检查）
  2. 项目知识只经 `workbench.config.json` 与 CLI 参数进入，代码内禁业务字面量
  3. 无绝对路径，一切相对"目标项目根"（默认 cwd，`--project` 可指）
  4. 数据归项目（`.workbench/workbench.db`，旧 tasks/task.db 迁入），引擎归包，包内无状态

```
workbench/                      # 新 pnpm workspace 包(通用层,零业务耦合)
├── core/                       # 唯一写入口
│   ├── db.ts                   # schema v2 + migration
│   ├── hash.ts                 # 文件/目录聚合 hash
│   ├── commands/               # create/claim/update/output/approve/reject/
│   │                           # feedback/plan/sync/migrate/graph/... 纯函数
│   ├── gates.ts                # claim/complete 校验矩阵
│   ├── derive.ts               # 全部派生状态计算
│   └── config.ts               # 读 workbench.config.json
├── server/                     # Fastify:HTTP API + SSE + (M7)MCP
└── web/                        # Vite + React 18 + antd 6
tasks/task-cli.ts               # 保留,薄壳,调 workbench/core/commands
workbench.config.json           # 项目层配置(见下)
```

### workbench.config.json（项目层，通用示例）

```jsonc
{
  "endpoints": ["service", "web"],
  "docs": {
    "prd": "docs/prd",
    "architecture": "docs/architecture",
    "design": "docs/design",
    "acceptance": "docs/acceptance"
  },
  "codeRoots": {
    "service": ["service/src/modules/{module}"],
    "web": ["web/src/pages/{module}"]
  },
  "machineChecks": {
    // 各端 complete 时跑;命令以各自 package.json scripts 为准
    "service": ["pnpm --filter service exec tsc --noEmit"],
    "web": ["pnpm --filter web exec tsc --noEmit"]
  },
  "protocolLints": [
    // 能机器查的约定 → 降级为 lint(违例阻断 complete)
    {
      "name": "no-page-size",
      "grep": "pageSize",
      "paths": ["service/src"]
    }
  ],
  "moduleMapping": {
    // fine→coarse 模块归并示例
    "userProfile": "user"
  },
  "feedbackHalfLifeDays": 15
}
```

---

## 五、PM / designer / QA 产出体系（v2 定版）

### PM 八问八产出

| 产物                                 | 路径                                 | 级别       |
| ------------------------------------ | ------------------------------------ | ---------- |
| 项目全景                             | docs/prd/project.md                  | 项目级契约 |
| 角色权限矩阵                         | docs/prd/roles.md                    | 项目级契约 |
| 领域术语表                           | docs/prd/glossary.md                 | 项目级契约 |
| 业务流程+实体状态机                  | docs/prd/flows/{模块}.md             | 模块级契约 |
| 模块 PRD（含数据来源、决策记录章节） | docs/prd/modules/{模块}.md           | 模块级契约 |
| 页面 PRD（含验收要点章节）           | docs/prd/pages/{端}/{模块}/{页面}.md | 页面级契约 |

边界判据：**每个陈述必须用业务语言可判真伪**。单一出现原则：状态机只在 flow，页面清单只在 module PRD。

### 技术基线（architect，0 号任务）

`ARCHITECTURE.md` + `TECH.md` 登记为 kind=baseline，是全项目代码产物的 DAG 上游。
双契约 gate：project.md 与 baseline 均 approved，plan 才对模块开闸。

### designer 三产出

1. 设计系统 `docs/design/systems/{端}.md`（每端一份，人工审批，DAG 边 → 该端全部原型）
2. 页面提示词 `docs/design/prompts/{端}/{模块}/{页面}.md`（登记不审）
3. HTML 原型 `docs/design/prototypes/{端}/{模块}/{页面}.html`（👍 合一放行）

### QA 两段式

- PM：页面 PRD"验收要点"章节 = 业务口径（什么算对）
- QA：`docs/acceptance/{端}/{模块}/{页面}.md` = 执行用例（怎么验），contract 类走审批
- 执行手段：service=API 断言脚本；admin=preview 走查；weapp=清单+编译；app=app-flow-testing skill

---

## 六、里程碑（M0–M8）

> 每个里程碑有独立验收标准，验收不过不进下一个。
> 工期经双 AI 评审校准:合计 19–25 天(原 13 天偏乐观)。

### M0 核心数据层（✅ 已完成并验收,含评审修订）

实际交付在计划之上追加:五态模型(submitted_hash)、claim 原子化 + busy_timeout、
stale complete 拦截 + --force、CRLF/二进制/大小写 hash 规范、approvals.json 快照、
submission_stale 事件、`refreshArtifact` 最小 rehash(submit/approve/feedback 前置重算,
M0 验收即依赖它,不等 M3 sync)。单测 19/19,隔离检查通过,306 产物迁移零缺失。

### M0.5 配置化地基（✅ 已完成,1 天窗口内的最后一批零成本字段改动）

- **版本化迁移框架**：schema_version 表;基线规则=真实库打基线戳(版本1=M0形态),新库跑 0→N;
  **schema 等价测试**(基线路径 vs 全新路径的 sqlite_master 归一对比)进单测,永久防双路径分叉
- **CHECK 手术**(SQLite 改 CHECK 只能重建表,必须在此窗口)：role/type CHECK 删除——项目语义下沉
  commands 层(M1 起可 config 覆盖);**status CHECK 保留**——引擎不变式留在 DB 层做最后防线,
  "core 唯一写入口"不独扛全部完整性
- 便宜 DDL：tasks.endpoint nullable(纯后端项目坐标退化)、external_ref(M6.5 issue 关联)、
  rework 任务类型(M4 QA 闭环)、events module/event 索引
- **kind 注册表结构定稿**(接线在 M1)：KindSpec { level / approval(human|thumbs|machine|none) /
  parents / drivesStale / hashMode(text-normalize|binary|directory) / retrieval(full|summary|semantic) /
  pathPattern / meta },core 内置默认表,config 可覆盖
- **元产物 draft 注册**：register-meta 命令;本项目 17 份已入库(4 agent-def + 12 skill + 1 plan)
- **验收**：等价测试绿;真实库基线戳+迁移2成功;25/25 单测;register-meta 幂等

### M0 原始计划（约 2 天,实际 ~2.5 天含修订）

- schema v2 + 旧 task.db 迁移（旧任务 type=legacy，旧 outputs 转 artifacts+关联，同事务写 migrated 事件）
- commands 层全量实现（含 approve/reject/feedback/graph 新命令），事件同事务写入
- gate 矩阵 + 派生状态函数 + hash 工具
- task-cli 改为薄壳，命令面保持兼容（现有 agent 定义暂不用改）
- **验收**：迁移后旧数据可查；gate 矩阵单测全绿；`graph --module=land` 输出正确 Mermaid；篡改一份已审批文件后派生状态变 invalidated

### M1 存量登记 + 注册表接线（约 2 天）

- **注册表五处重接线**（结构已在 M0.5 定稿）：inferKind(pathPattern) / 边推导(parents) /
  审批分流(approval) / gate 上游选择器 / stale 驱动(drivesStale) 全部改由注册表驱动；
  角色流水线降为 config 数组
- `migrate scan`：按注册表 pathPattern 扫描 docs/** 入库；代码按 codeRoots 目录级登记；
  DAG 边按 parents 自动推导；**排除元产物路径\*\*（走显式 register-meta）
- `move` 命令（保 id 改 path，审批历史/边/反馈不断裂）；`input` 命令（agent 追加申报额外依赖，
  advisory 语义写进帮助文本）
- 全部存量初始 draft；moduleMapping 归并生效；**历史文档不守命名约定的例外处理预留半天**
- **验收**：本项目 21 个模块全部登记；任一模块的树查询（module→endpoint→page→artifacts）返回正确；graph 显示推导出的边

### M2 Workbench 只读版（约 3–4 天;Tree+SSE+四种渲染器,2 天出的是毛坯）

- server：Fastify + 只读 API（树/节点详情/artifact 内容/events 游标）+ SSE（500ms 轮询 events 游标推送）
- web：antd Tree（phase+health 徽标）、react-markdown+mermaid、Monaco 只读、原型 iframe 渲染（含 375/1280 视口切换）、节点事件时间线
- **PostToolUse 秒级 hash 刷新**（Claude Code hook,fail-open）：agent 编辑已登记文件 → 即刻 refresh → SSE → 编辑即变黄
- 树给 meta 类 kind 过滤开关，元产物不混业务树
- **验收**：树实时反映 CLI 操作（另开终端 claim 一个任务，3 秒内树上变色）；PRD 的 mermaid 正常渲染；原型可预览

### M3 信任与变更闭环（✅ 已完成并验收）

实际交付:sync 全量对账(invalidated→沿边派 review 去重/tombstone+review/幂等)、
approve --trivial(re-bless 下游快照+自动关闭派生 review)、审批内容存档+diff、
dispute 事件、claim_commit 记录、hotfix 契约触碰检测(自动派补文档 review)、
install-hooks(post-commit sync 已装)、Workbench 写 API + 待审队列(diff 双栏)+
通过/trivial/打回/送审/👍👎 按钮。**trailer 交叉验证已实现但 config 默认 off,
等用户裁决后开启(prepare-commit-msg hook 仅 on 时安装)**。
浏览器实测:改 approved PRD→sync→树变黄+review 任务+队列 diff→页面点通过→队列清空树复绿。
单测 35/35。

### M3 原始计划（约 2–3 天）

- 待审队列（diff 对比上一 approved 版本）+ 通过/打回按钮；原型 👍👎（👎 强制原因）
- `sync` 命令 + git post-commit hook：hash 对账 → invalidated → 沿 DAG 派 review 任务（去重）；
  文件删除 = tombstone 事件 + 下游派 review（不静默悬空）
- 双车道：`create --type=hotfix` + 完成时契约触碰检测。**多 agent 归因**：tasks 表加 `claim_commit`,
  commit message 加 `Task: #id` trailer（任务元数据,非 AI 署名;trailer 约定进 git-commit skill 前先经用户确认）,
  `git diff claim_commit..HEAD` 按 trailer 过滤归属提交后与登记清单交叉验证,差集非空即拦截
- `dispute` 事件（agent 对 approved 内容有异议的出口）；审批加 `--trivial` 非破坏性变更标记（自动关闭派生 review,不打扰下游）
- Workbench 操作按钮：plan/sync/claim/complete（全部走 commands 层，gate 错误原样弹出）
- **验收**：改一份 approved 的 PRD → 提交 → 树上下游全部变黄 + review 任务出现 + 待审队列出现 diff；hotfix 触碰 sql.enum.ts → 自动生成补文档任务

### M4 agent 体系升级（✅ 机制层完成;校准点待真实需求实测）

实际交付:QA fail→rework→自动复验闭环(qa 命令,pass 自动喂 +1 verdict 进进化管道)、
plan 派发(以已登记 page-prd 为真相源,幂等+设计系统前置+删页 cancel)、
PreToolUse 写闸门(observe 默认,would_block 事件带坐标/kind/taskEnv=误拦判据数据源,
enforce 文案含可行动指引)、**agent 定义模板化**(workbench/templates/agents + gen-agents,
路径由注册表注入,信任协议/CLI 共享块统一,五角色 v2 精简版——纪律交给机器 gate,
prompt 只管专业行为)、新增 qa agent。单测 40/40。
**待办:校准点(2–3 个真实小需求实测三数字)需用户参与驱动;元产物锚定(用户审批 5 份 agent-def)。**

### M4 原始计划（约 4–6 天）

- 重写 4 个 agent 定义：PM 八产出+逐层送审、architect 基线职责+协议符合性、designer 三产出新工作流、developer 信任协议+task_inputs 快照
- 新增 `.claude/agents/qa.md` + 两段式验收流程；**QA fail→rework 闭环**（qa_failed → rework 任务 → 重触发 QA，状态机全图 M4 前定死）
- `plan` 命令：解析 PRD frontmatter 一键生成整组任务（纯函数 + 删页面 cancel 语义，含设计系统前置、QA 任务）
- context assembly 分层（按注册表 retrieval 字段：full 注入 / summary 注入 / semantic 提案）
- **PreToolUse 写闸门**（仅 approved 契约类）：**默认只记日志不拦截**,观察期误拦率达标后翻 fail-closed（宪法第 6 条）;
  误拦判据前置定义——would-block 事件带任务坐标+kind,人工每周标注合法/非法;报错文案必须含"该领什么任务"的可行动指引
- **元产物锚定**：M4 出口将 agent-def/skill/hook 送审锚定（出口而非起点——全程在重写它们）
- **尾部挂校准点（全计划唯一 go/no-go 闸）**：端到端跑 2–3 个真实小需求,实测三个数——
  单需求人工介入时长、token 消耗、gate 误拦率。三个数决定 M8/M9 是否上、context assembly 是否加码。
  **工具的存在理由必须在这里用数字自证,否则砍尾部保主干。**
- **验收**：选一个小需求（建议 about 或 systemConfig 级别）端到端跑通：需求→八产出→审批→派发→设计→👍→开发→QA→accepted，全程 Workbench 可视

### M5 机器卡点（✅ 已完成并验收）

实际交付:协议 lint 引擎(config 规则集,按角色/端过滤,allowlist 承接既有债)挂入
developer/architect complete gate,违例即阻断(测试证明:硬编码大写 SQL enum 被拦,修复后放行;
architect 的 api 文档 pageSize 被拦)。machineChecks 接线:service tsc 已开
(实测通过);admin/weapp 存在既有类型债(pdfme-ui 模块解析/antdIcon TS2525),命令置空待清。
**判据校准收获**:lint 初版会误伤小写查询参数字面量(z.enum(["day"]))——收窄为大写 SQL enum
模式;既有债账目:weapp 4 处 + admin 12 处 Record map、api 文档 1 处 pageSize,全部 allowlist
留痕待清(已派后台清理任务)。单测 44/44。

### M5 原始计划（约 1.5 天）

- machineChecks 四端命令核实接线（以各 package.json 实际 scripts 为准）
- protocolLints 实现并挂入 developer complete gate；enum-bidirectional skill 的 grep 自检清单固化进 lint
- architect complete 挂协议符合性检查（api 文档禁 page/pageSize 等）
- **验收**：故意写一个硬编码 enum 字面量 → developer complete 被拦

### M6 真相清算启动（🔶 机制完成;审批动作在用户队列)

机制交付:moduleCleared 派生(module-prd approved = 该模块最小真相锚点)、
未清算模块 claim 出对账提示(不硬阻断,成本按需支付)、audit 对账命令
(契约状态+磁盘存在性+批量送审建议,一致性判断留给人/architect)。
已入用户待审队列:ARCHITECTURE.md / TECH.md(baseline)+ 三端设计系统
(designer agents 反向提炼)。**approvalMode 切 enforce 待清算铺开后由用户决定。**

### M6.5 issue intake（✅ 已完成)

intake 命令:gh issue 三分诊(判据即帮助文本:label=bug → hotfix 快车道;
其余含无 label/模糊一律 PM 分析——保守默认,分诊错成本最低);
external_ref=gh#N 去重;任务完成自动 gh issue close 回写(fail-open)。

### M6 原始计划（1 天启动 + 长期懒清算）

- baseline（ARCHITECTURE/TECH）登记送审；三端设计系统反向提炼（收编 designer memory 中的状态色约定）送审
- 懒清算 gate 生效：触碰 uncleared 模块 → 先对账（architect 审计文档 vs 代码 → 一致推荐批 / 漂移派 review）；
  AI 提 frontmatter 草稿 → 写回送审 → plan 才认
- **approvalMode 切换 enforce** 在本里程碑完成后执行
- **验收**：baseline approved；至少 1 个活跃模块完成清算并 approved

### M6.5 issue intake（约 1 天）

- gh CLI 版三分诊（判据文本写进 intake 命令帮助,**默认保守走 PM**）：
  明确 bugfix → hotfix 任务；明确新需求 → PM 流水线；模糊 → PM 分析
- hotfix 完成 → 自动回写关闭对应 issue（external_ref 关联,M0.5 已备字段）

### M7 MCP + init 引导（✅ 已完成;plugin 外壳留待 M7 抽离时一并做）

实际交付:MCP stdio 端点(commands 层包装为 typed tools,与 CLI 同源同事务同事件流;
**审批 approve/reject 刻意不暴露**——人的动作只在 Workbench/CLI 由用户执行),
.mcp.json 已注册;init 一键引导(config+agents+meta 注册+hooks,幂等防覆盖,
纯后端项目自动裁剪 designer);**异构 dry-run 通过**——纯后端假想项目
init→scan→plan→claim→complete 全链跑通,plan/gen-agents 均尊重 pipeline 配置。
单测 50/50(含 InMemoryTransport MCP 全握手)。
plugin 打包外壳(marketplace 格式)与 subtree 抽离/npm 发布留待自用 2-3 个月后一并执行。

### M7 原始计划（约 1.5–2 天）

- server 加 MCP 端点（包装 commands 层为 typed tools），agent 定义提供 MCP 版调用方式
- plugin 打包（agents 模板 + 通用 skills + MCP 配置 + init 问答）+ 政策边界核实（原生用法确认）
- **通用性唯一可信测试**：用一个异构假想项目（纯后端、无 designer）对 config 做 dry-run,
  验证坐标系与流水线 config 化是否真的够用
- **验收**：新建一个空目录 `plugin install` + init 问答后，task-cli/Workbench 可用

### M8 进化机制（✅ 已完成并验收）

实际交付:`retro` 命令 + `wb_retro` MCP tool(反馈加权提炼:半衰期 0.5^(天数/feedbackHalfLifeDays)
× actor 权重,自动 verdict(actor 以 -auto 结尾)半权防饿死、人工全权;按 endpoint×kind 聚合分桶——
加权正分 ≥3 → skill 候选 / 负分 ≥2 → Red Flags(负例 comment 即素材)/ 两侧都达 → 混杂观察 /
其余 → 样本不足)。**命令层是确定性聚合(对齐反清单"plan 不引入 AI 分析"),AI 只消费证据包
写 skill 草稿**,草稿走既有人审流:register-meta(kind=skill)→ submit → 用户 approve,零旁路。
审批吞吐报表(送审→通过平均耗时 + 打回率,按 kind 细分;👍 合一等未经送审的 approved 不进耗时样本)
随 retro 一并输出。`export` 命令导出 events/feedback 全量 jsonl 到 .workbench/(幂等),
post-commit hook 顺手跑(fail-open)——数据单点缓解落地。qa agent 模板补"人工测试反哺验收用例"
条款(发现验收标准未覆盖的缺陷先补用例再记 fail)。单测 60/60(新增 8)。

### M8 原始计划（约 3–4 天，独立成章——原塞在 M7 的 1.5 天里被严重低估）

- retrospective 流程 + 反馈加权提炼规则（半衰期加权、3 正例成 skill 草稿 / 2 负例进 Red Flags / 混杂观察）+ skill 草稿人审流
- **反馈管道防饿死**：单用户对代码目录点 👍 频率极低 → QA pass/fail 自动写 verdict 事件喂进化管道，人工反馈作加权信号而非唯一来源；人工测试反哺验收用例
- **审批吞吐报表**（平均耗时/打回率,events 白嫖可算）——让审批纪律本身被度量；events/feedback 定期导出 jsonl 入 git（数据单点缓解）
- **验收**：跑 3 个模块后能产出至少一份有效 skill 草稿供人审

### M9 向量发现层（可选,约 3–4 天;校准点数据说了算）

- sqlite-vec;embedding 键 = artifact_id + content_hash;**只检 approved**（宪法第 4 条:发现走检索,提案不算数,申报才算数）
- 用途：issue 分诊辅助 / 跨模块发现 / legacy 对账 / 相似案例;模块摘要记忆（QA pass 时生成,hash 锚定）

**总量：核心 M0.5–M7 ≈ 19–23 工作日;全量含 M8/M9 ≈ 25–30 日。M0→M0.5→M1→M2 严格串行；M3 与 M4 部分可并行；M6 启动后与日常开发并行；M8/M9 标记为可砍,由 M4 校准点数字裁决。**

---

## 六.1 裁决账本（各里程碑动工前必须定死,防散落）

| 闸口    | 待裁决                                                                           | 状态                                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0.5 前 | kind 注册表字段集终稿（retrieval 三值）;坐标系 NULL 语义;schema_version 基线规则 | ✅ 已裁决并落地                                                                                                                                                              |
| M3 前   | trailer 环境变量命名与 hook 安装方式;孤儿提交拦截的路径范围                      | ✅ 已裁决:`WORKBENCH_TASK_ID` env + prepare-commit-msg 注入 `Task: #id`,taskTrailer=on;孤儿检测范围=契约路径∪业务 code 目录(meta 排除),**observe 模式**留 orphan_commit 事件 |
| M4 前   | rework 状态机全图;PreToolUse 报错文案模板;误拦判据                               | ✅ 已裁决并落地(M4)                                                                                                                                                          |
| M6.5 前 | 三分诊判据文本                                                                   | ✅ 已裁决(bug→hotfix,余者保守走 PM)                                                                                                                                          |
| M7 前   | 异构假想项目 config dry-run                                                      | ✅ 已执行(纯后端全链测试通过)                                                                                                                                                |

**信任基线里程碑(2026-07-03)**:首批 10 份契约经用户锚定——baseline×2、设计系统×3、
agent-def×5。期间实证了失效机制:agent-def 获批后被 gen-agents 重写,系统即刻标记
invalidated,按用户授权重新锚定。approvalMode 仍为 warn,切 enforce 待清算铺开后决定。

---

## 七、风险登记

| 风险                                                | 缓解                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **审批纪律**（全系统最大单点,橡皮图章反向放大错误） | diff 化 + --trivial + 批量 re-bless 降摩擦;M8 审批吞吐报表让纪律本身被度量                |
| **工具吞噬项目**（25–30 天是真实投资）              | M4 校准点 go/no-go;M8/M9 明确标记为可砍                                                   |
| gate 规则倒逼产出造假（历史已发生）                 | 每条 gate 上线前过一问："能否用空文档骗过？"；无表模块给 kind 豁免而非要求占位文档        |
| 流程对小需求过重                                    | 快车道 + 懒清算，小事永远有小门                                                           |
| 告警疲劳                                            | re-bless / --trivial / reject 事件级不强制 stale,三件套已备                               |
| M4 行为收敛                                         | 校准点 + gate 报错可行动性列入 M4 验收                                                    |
| 数据单点                                            | approvals.json 入 git ✅;events/feedback 导出 jsonl ✅(M8:export 命令 + post-commit 自动) |
| Windows 文件监听不可靠                              | 实时性只依赖 events 游标轮询 + hook 栈，不依赖 fs watch                                   |
| machineChecks 命令假设与实际 scripts 不符           | M5 接线时逐端核实，配置化不硬编码                                                         |

**开源战略（M7 后的选项,非义务）**：最佳时机 = M7 后自用 2–3 个月,用校准点真实数字做 README 实证;
届时重扫竞品、话术以新扫描为准;kind 注册表留 `lib-spec` 口子（成本零）。
