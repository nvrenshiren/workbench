# opcflow 配置参考(workbench.config.json)

← 返回 [README](README.md) · **简体中文** · [English](CONFIG.en.md)

`workbench.config.json` 由 `init` 生成、之后手工编辑,是每个项目的坐标系与纪律开关。命令说明见 [COMMANDS.md](COMMANDS.md)。

字段分两组:**常调的**、和**基本不动的(进阶)**。

```jsonc
{
  "platforms": ["claude", "cursor"],
  "endpoints": ["service", "web"],
  "pipeline": ["product-manager", "architect", "designer", "developer", "qa"],
  "codeRoots": {
    "service": ["service/src/modules/{module}"],
    "web": ["web/src/pages/{module}"]
  },
  "moduleMapping": { "userProfile": "user" },
  "machineChecks": { "enabled": false, "service": ["cd service && npx tsc --noEmit"] },
  "protocolLints": [{ "name": "no-page-size", "grep": "pageSize", "paths": ["service/src"] }],
  "gates": { "approvalMode": "warn", "writeGate": "observe" },
  "git": { "taskTrailer": "off", "trailerKey": "Task" },
  "feedbackHalfLifeDays": 15,
  "language": "zh"
}
```

---

## 常调字段

- **`codeRoots`** `Record<端, 目录模板[]>`(**必填**)—— 每个端的代码目录约定,`{module}` 占位(也支持 `{client}` 等自定义段)。`scan` 据此把代码目录级登记为 `code` 产物并解析模块归属。**不填 developer 任务无法定位代码。**
- **`endpoints`** `string[]` —— 你的端(如 `service`/`web`/`admin`/`weapp`)。坐标系的一维,贯穿任务 / 产物 / lint。
- **`pipeline`** `Role[]`(默认全 5 角色)—— 启用的角色流水线;不在列表里的角色不派任务。*纯后端去掉 `designer`;不要 QA 去掉 `qa`。*
- **`platforms`** `string[]`(默认 `["claude"]`)—— 目标 vibecode 平台,决定生成哪些平台的 agent/MCP/hooks。可选 `claude`/`codex`/`opencode`/`cursor`。
- **`gates.approvalMode`** `"warn"|"enforce"`(默认 `warn`)—— 上游未审批时:`warn` 只警告放行,`enforce` 直接阻断 claim。*磨合期 warn,纪律严了切 enforce。*
- **`gates.writeGate`** `"off"|"observe"|"enforce"`(默认 `observe`)—— agent 改动已批契约时:`off` 不管;`observe` 只记 `would_block` 事件(用于观察误拦率),永不拦;`enforce` 真拦(需先领任务并设环境变量 `WORKBENCH_TASK_ID`,否则 exit 2)。*观察期数据达标后再翻 enforce。*
- **`machineChecks`** `{ enabled, [端]: string[] }` —— developer `complete` 时按端跑的命令(如 `tsc --noEmit`);`enabled:false` 全局关。*接入你项目的类型检查 / 构建作为硬闸门。*
- **`protocolLints`** `{name,grep,paths,endpoint?,role?,message?,allow?}[]` —— 把「能机器查的约定」降级为 lint:命中 `grep` 正则即违例,阻断对应 role/endpoint 的 `complete`;`allow` 列历史豁免文件。*例:禁硬编码分页 `pageSize`、禁 SQL enum 字面量。*
- **`moduleMapping`** `Record<细, 粗>` —— 把细粒度模块名归并到粗模块(如 `userProfile` → `user`),统一坐标。*改动后重跑 `scan` 即把已登记行的坐标收敛到新映射(不影响审批)。*
- **`git.taskTrailer`** `"off"|"on"`(默认 `off`)—— `on` 时提交注入 `Task:#<id>` 归因 trailer,并做多 agent 同分支的触碰交叉验证。
- **`git.trailerKey`** `string`(默认 `Task`)—— trailer 的键名。
- **`language`** `"zh"|"en"`(默认 `zh`)—— 生成 agent 的语言 + 工作台 UI 语言。
- **`model`** `string | Record<平台, model>` —— 各平台模型:字符串=全平台同款,对象=按平台指定,缺省用各 adapter 默认。
- **`feedbackHalfLifeDays`** `number`(默认 `15`)—— 反馈权重半衰期天数;`retro`/distill 用,越旧的 👍👎 权重越低。
- **`taskPreconditions`** `{role, type?, requiresSiblingRoleCompleted}[]`(默认 `[{role:"qa", type:"qa", requiresSiblingRoleCompleted:"developer"}]`)—— 任务级跨角色前置:该角色的任务领取前,要求**同坐标**的某角色任务已 completed。kind 的 parents 只能表达"产物审批状态"依赖,这类"任务完成状态"依赖在此声明。*例:让 designer 等 product-manager 任务完成:`{"role":"designer","requiresSiblingRoleCompleted":"product-manager"}`。*
- **`candidateThreshold`** `number`(默认 `3`)—— 加权正分 ≥ 此值 → 经验候选(提示 AI 判断沉淀为 skill / 规则 / 记忆)。调低更爱提候选,调高更保守。
- **`redFlagThreshold`** `number`(默认 `2`)—— 加权负分 ≥ 此值 → Red Flag。同理调节灵敏度。

## 基本不动(进阶)

- **`docs`** `{prd,architecture,design,acceptance}` —— 各类文档根目录(默认 `docs/prd`、`docs/architecture`、`docs/design`、`docs/acceptance`),坐标解析与 kind 推断依据。
- **`dataDir`** `string`(默认 `.workbench`)—— SQLite 库与导出文件所在目录。
- **`legacyDb`** `string`(默认 `tasks/task.db`)—— `migrate` 默认读取的旧库路径。
- **`cli`** `string`(默认 `npx -y @dawipong/opcflow`)—— 注入到 agent 定义、MCP、hooks、gate 报错里的命令前缀;换机器 / 团队协作免重装即靠它。
- **`roleProduces`** `Record<角色, kind[]>` —— 各角色产出的 kind,gate 的上游选择器据此派生。
- **`kinds`** `Record<kind, {...}>` —— 覆盖 / 扩展 kind 注册表(与 core 默认表深合并),调 kind 的审批方式 / 层级 / 是否驱动 stale,以及**坐标文法 `coords`**。
  - **`coords`**:该 kind 的文件路径如何映射到坐标 `(module, endpoint, page)`,相对其 `pathPatterns[0]` 前缀,占位符 `{module}/{endpoint}/{page}`:
    - 单占位符 `{X}` → 绑定**叶子文件名**(忽略中间目录)。默认:`flow`/`module-prd`/`db-doc`/`api-doc` = `{module}`、`design-system` = `{endpoint}`。
    - 多段如 `{endpoint}/{module}/{page}`(page/prototype/prompt/acceptance 默认)→ 从前缀起**按位**匹配,`{page}` 贪婪吃尾;捕获的 `{endpoint}` **必须 ∈ `endpoints`**,否则该文件不解析(scan 记入 unresolved 并跳过,不 mis-file)。
    - `defaultEndpoint`:`coords` 未捕获 `{endpoint}` 时的固定端(默认 db-doc=common、api-doc=service)。
  - **示例**:某项目的 flow 按端拆分(`flows/<模块>/<端>.md`),只需覆盖一行:
    ```jsonc
    "kinds": { "flow": { "coords": "{module}/{endpoint}" } }
    ```
    此后 `flows/ad/admin.md` → 模块 `ad`、端 `admin`;`flows/ad/app.md` → 模块 `ad`、端 `app`。默认值一律等于内置约定,不配即现状。
