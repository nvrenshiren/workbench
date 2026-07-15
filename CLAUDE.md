# opcflow 开发约定(Claude Code 项目指引)

spec 锚定、漂移强制的 AI 开发执行层:artifact DAG + 信任门禁 + 多角色流水线,为 Claude Code / Codex / OpenCode / Cursor 生成 agent/MCP/hooks。npm 包 `@dawipong/opcflow`。

## 架构地图

| 目录 | 职责 |
| --- | --- |
| `core/` | 引擎:SQLite 数据层(db/迁移)、kind 注册表(coords 文法)、gates、信任派生(derive)、DAG(scan/sync)、commands、平台 adapter(platforms.ts 是平台差异唯一接缝,含生成期+hook 运行期契约) |
| `server/` | Fastify HTTP + SSE + MCP server(审批 approve/reject 刻意不暴露给 AI) |
| `web/` | React 18 + antd 6 工作台(Vite;关系图用 @xyflow/react + dagre) |
| `scripts/` | 平台 hooks(pre=写门禁/post=刷新)、esbuild 打包、隔离检查 |
| `templates/agents/{zh,en}/` | 角色 agent 模板,**双语必须同步改** |
| `preset/` | init 落到裸项目的最小脚手架 |

## 命令

```bash
pnpm run typecheck && pnpm test && pnpm run check:isolation   # 每次改动后的三件套,必须全绿
pnpm run web:build            # 前端(涉及 web/ 改动时必跑)
pnpm exec tsx cli.ts serve    # 从源码起工作台(先 web:build,否则 404)
pnpm run build                # 发布构建(web + dist/cli.mjs)
```

## 提交与发布

- **推 main 即发布**:semantic-release 自动跑(`feat`→minor、`fix`→patch、`docs/refactor/chore`→不发版)。所以**未经用户同意不要 push**;含 feat 的批次要提醒会发 minor。
- Conventional Commits,描述用中文;**绝不加 AI 署名尾注**(见 CONTRIBUTING.md,全仓强制)。
- 发布后 bot 会回写 `chore(release): x.y.z [skip ci]`,下次提交前先 `git pull --rebase`。

## 测试约定

- `node --test` + `node:assert/strict`;fixture 用 `mkdtempSync(tmpdir())` 建临时项目 + `after` 清理;describe/it 用中文描述行为。
- TDD:先写失败测试(或确认"锚点"测试改前是绿的),再实现。
- 测试必须走**真实链路**,不许抄近道绕过引擎机制(教训:m4 曾手工 `DELETE FROM artifacts` 掩盖了 plan 的 tombstone bug)。
- `tests/templates.test.ts` 有宿主残留金丝雀清单——模板改动不得引入项目专属词。

## 关键不变式(改动前想清楚)

- **信任状态是派生的**:draft/pending/approved/invalidated 由 `approved_hash`/`content_hash`/`submitted_hash` 现场推导,绝不落库存状态列。坐标(kind/module/endpoint/page)重挂不碰 hash → 审批存活。
- **artifacts 行不硬删**:文件消失只打 `tombstoned` 事件;消费方(如 plan)要按磁盘存在性收敛,不能只看行存在。唯一例外:关系图的"取消登记"仅限无审批/无引用/无反馈的产物。
- **边是 id 基的**:`artifact_edges.source` 区分 derived(scan 对账维护,只增删于对账)/ manual(用户所有,scan 永不动);重命名靠 scan 的同 hash 唯一候选检测保 id 跟随。
- **core/ 禁止 import server/web/业务代码**(check:isolation 强制)。
- **人审不外包**:approve/reject 只在 CLI/工作台,MCP 永不暴露;引擎 `assertHumanApprover` 再拒以流水线角色(`isPipelineRole`)作 actor 审批——CLI approve/reject 与「原型👍 放行」同源封死,agent 不能自写自审。
- 项目可配性走注册表深合并:kind(`config.kinds`,含 coords 文法)、**角色(`config.roles`,core/roles.ts 的 `DEFAULT_ROLE_REGISTRY` 是角色语义唯一真相源——改角色行为改注册表,不加 role 字面量分支)**、`taskPreconditions`——加能力优先考虑"默认值=现行为的注册表字段",不加顶层开关。gates 仅存两处有据例外:产出义务跳过 developer/qa、designer 原型👍(PM 免领取已注册表化为 `completeWithoutClaim`)。

## 常见坑

- Windows:文本 hash 已做 CRLF 归一(hashMode text-normalize),别绕过 `hashPath` 自己算。
- WAL:`.workbench/workbench.db` 的近期状态在 `-wal` 里,export 前必须 checkpoint(exportEventLog 已处理)。
- agent 指示的产出路径由 `kindPathTemplate`(TPL_* token)从 kind 注册表推导——改了 `coords`/`docs` 后**重跑 `gen-agents`** 即同步;唯一例外 api-doc(叶子文法表达不了 `{端}/` 目录惯例,模板手写)。
- 内部开发计划放仓库根 `*-PLAN.md`,已 gitignore(不随包分发);仓库根跑 serve 产生的 `.workbench/` 同样已忽略。

## 文档

README / COMMANDS / CONFIG 均中英双份,**改一份必须同步另一份**;命令行为变化同步 COMMANDS,config 字段变化同步 CONFIG。平台注意事项见 PLATFORMS.md。
