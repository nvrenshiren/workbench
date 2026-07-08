# opcflow CLI 命令参考

← 返回 [README](README.md) · **简体中文** · [English](COMMANDS.en.md)

统一形态 `opcflow <命令> [参数]`(全局装后即用;或 `npx -y @dawipong/opcflow <命令>` 免装)。配置说明见 [CONFIG.md](CONFIG.md)。

**通用约定**

- 全局 `--project=<路径>` 指定项目根,缺省从当前目录向上找 `workbench.config.json`。
- 文件路径参数放在 `--` 之后(如 `submit --actor=pm -- docs/prd/modules/user.md`),避免被当选项解析。
- `<id>` 直接作位置参(如 `show 12`)。
- **审批类动作(approve/reject)刻意只给人**;AI 侧走 MCP 的 `wb_*` typed tools(与 CLI 同源同事务),看不到审批入口。

---

## 任务

- **`list`** `[--status --assignee --module --role --endpoint --type --stale=true]` —— 按条件列任务。*场景:* 开工先 `list --assignee=<你的角色> --status=pending` 看该做什么;`--stale=true` 只看上游已变、需复查的。
- **`show <id>`** `[--json=true]` —— 单任务详情:事件时间线、产出、stale 的上游清单。*场景:* 领取前确认上下文,或排查它为什么 stale。
- **`create`** `--role --creator [--module --endpoint --page --type --content --assignee]` —— 手工建任务。*场景:* 流水线之外的临时任务;正常业务任务由 `plan` 自动派,不用手建。
- **`claim <id>`** `--assignee=<角色>` —— 领取任务:过 gate(上游契约齐备/已批检查),并快照当前依赖内容 hash 作为 stale 判据。*场景:* 每个 agent 开工第一步;领取即锁定,第二人再领撞车失败。
- **`update <id>`** `--status --operator [--force=true]` —— 改状态(pending/in_progress/completed/cancelled);complete 时跑 machineChecks + protocolLints 闸门。`--force=true` 越过 stale 拦截并留痕。*场景:* 完工 `update <id> --status=completed`;上游刚变但确认无影响时用 `--force`。
- **`remove <id>`** `--operator [--force=true]` —— 删任务。*场景:* 误建/废弃清理。
- **`record <id> "备注"`** `--operator` —— 加一条备注事件。*场景:* 留决策/踩坑记录,进事件流可回溯。
- **`input <id> -- <路径>`** `--operator` —— 申报「gate 之外你实际读过的依赖」,纳入 stale 监控。*场景:* 参考了标准依赖集之外的文件(如别端设计系统),申报后它一变你也被标 stale。

## 产出

- **`output -- <路径>`** `--role --endpoint [--module --page --task]` —— 登记一个产物文件,自动关联你当前领取的任务。*场景:* 非代码类产物(PRD/契约/原型)写完后登记入 DAG。
- **`artifacts`** `[--module --endpoint --page --kind]` —— 列产物及审批状态。*场景:* 查某模块有哪些契约、各自 draft/pending/approved。
- **`scan`** `[--actor]` —— 全量扫描 docs + codeRoots 登记所有产物,按 kind 层级推导 DAG 边;代码目录级登记(不逐文件)。改了 `moduleMapping` / `kinds` 覆盖等 config 后,**已登记行的坐标也随之收敛(重挂 `coords_remapped`,内容 hash 不变故审批不失效)**。*场景:* 批量落地文件后一次入库;代码写完不用手动 `output`,scan 自动维护;调整归并/kind 规则后重跑即收敛旧行;git post-commit 也自动跑。
- **`move --from=<> --to=<>`** `--actor` —— 移动产物路径,保留 id 与审批状态(内容没变就不失效)。*场景:* 重构目录时避免审批断裂、下游误 stale。

## 信任(审批闭环)

- **`submit -- <路径>`** `--actor` —— 送审:当前内容标为待审。*场景:* agent 产出契约后送人审。
- **`approve -- <路径>`** `--actor [--trivial=true]` —— 批准:把当前内容 hash 铸成 approved 锚点。`--trivial=true` 微调:re-bless 下游快照 + 关闭派生 review(不惊动下游)。*场景:* **你的动作**;待审队列过目 diff 后点头。错别字级改动用 `--trivial` 免全下游返工。
- **`reject -- <路径>`** `--actor --reason` —— 打回:清掉送审态、退回 draft、留原因。*场景:* **你的动作**;契约有问题,附一句为什么。
- **`feedback -- <路径>`** `--actor --verdict=+1|-1 [--comment --task]` —— 给产物 👍/👎;对原型 👍 = 反馈+审批合一(放行),👎 必附 comment。*场景:* 原型评审;日常给代码/产物打分,喂给进化机制(retro)。
- **`dispute -- <路径>`** `--actor --reason` —— 对已 approved 的内容留痕异议并停下,等你裁决。*场景:* agent 消费上游契约时发现它本身有问题——不擅自偏离,而是留证据、停工等人。
- **`queue`** —— 待审队列(pending + invalidated)。*场景:* 你的日常入口:看什么等着审、什么因上游变动需复审。
- **`sync`** `[--actor]` —— 对账:重扫内容 → 失效传播 → 沿 DAG 给下游派 review(去重)→ 处理删除(墓碑)。*场景:* 手工批量改文件后对齐状态;post-commit 自动跑。

## 流程

- **`plan`** `--module [--creator]` —— 契约全批后一键派发该模块下游任务(architect/designer/developer/qa),幂等;页面 PRD 删除会自动 cancel 对应任务。*场景:* 模块 PRD 审完,一条命令铺开施工任务。
- **`qa <id>`** `--result=pass|fail --operator [--reason]` —— 记验收结果;fail(必附 reason)自动派 rework,rework 完成自动派复验,直到 pass。*场景:* QA 执行验收后回填,fail→rework→复验全自动。
- **`audit`** `--module` —— 模块契约对账报告:清算状态、各契约审批态、建议送审清单。*场景:* 开工前确认某模块契约是否齐备/清算。
- **`graph`** `--module` —— 输出该模块 Mermaid 关系链(节点按 kind 分层,审批态着色)。*场景:* 可视化某模块 文档→任务→代码 的依赖与状态。
- **`lint`** `[--role --endpoint]` —— 单独跑 protocolLints(不进 complete 闸门)。*场景:* 提交前自查是否踩了项目约定。
- **`events`** `[<id> | --taskId --module --event --limit --json]` —— 事件流。*场景:* 审计谁在何时做了什么;排查状态怎么变成现在这样。
- **`intake`** —— 拉 GitHub open issue 入队:label 含 bug → hotfix(developer 快车道),其余 → PM 分析任务(标准道),按 `gh#<n>` 去重。*场景:* 把 issue 接入流水线;需要 `gh` CLI。

## 进化 / 维护

- **`retro`** `[--module --json]` —— 复盘:半衰期加权的经验候选 / Red Flags / 审批吞吐(阈值 `candidateThreshold` / `redFlagThreshold` 可配,缺省 3 / 2)。*场景:* 阶段性回顾;把候选证据交给 AI 判断该沉淀为 **skill / 规则 / 记忆** 中的哪一种,负例同样三分流(能机器查→规则、通用坑→skill 的 Red Flags、角色专属坑→记忆)。
- **`export`** —— 把 events / feedback 全量导出为 jsonl(落 `.workbench/`)。*场景:* 离线分析、备份;post-commit 自动跑。
- **`init`** `--endpoints [--platforms --model --language --hooks=false --preset=false --writehooks=false]` —— 空项目引导(在终端裸跑进交互问答)。*场景:* 新项目一次性落地 agent/MCP/hooks/config/docs 骨架。
- **`gen-agents`** —— 从模板重新生成各平台 agent 定义。*场景:* 改了 config(端/平台/codeRoots)或升级模板后刷新 agent。
- **`register-meta`** `[--actor]` —— 把元产物(agent-def/skill/plan/hook-script)登记为 draft 入体系。*场景:* AI 写了 skill 草稿后登记,再走 submit→人审。
- **`install-hooks`** —— 安装 git hooks(post-commit 对账)。*场景:* init 时非 git 仓库、后来才 `git init`,补装。
- **`migrate`** `--from=<路径>` —— 迁移旧 `tasks/task.db` 到新库(旧任务标 legacy,幂等防重)。*场景:* 从 pre-workbench 老库升级。

## 服务与集成(多由平台 / git 自动调用)

- **`serve`** `[--project --port=5620 --host=0.0.0.0]` —— 起可视化工作台(HTTP + SSE)。*场景:* 你审批的主界面;默认对局域网开放,团队自托管即靠它。
- **`mcp`** `[--project]` —— 起 MCP server(stdio),把 `wb_*` typed tools 暴露给 AI 平台。*场景:* 由各平台 MCP 配置自动拉起,一般不手调。
- **`hook pre|post --platform=<id>`** —— agent 工具调用前/后 hook(写门禁 / 刷新)。*场景:* 由平台 hooks 配置自动调用。
- **`postcommit`** —— git 提交后:scan + sync + 孤儿检测 + 导出。*场景:* 由 git post-commit hook 自动调用。
