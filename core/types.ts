import type Database from "better-sqlite3"

export type Role = "product-manager" | "architect" | "designer" | "developer" | "qa"

export type TaskType = "build" | "review" | "qa" | "hotfix" | "baseline" | "legacy" | "rework"

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type ArtifactKind =
  | "baseline"
  | "project"
  | "roles"
  | "glossary"
  | "flow"
  | "module-prd"
  | "page-prd"
  | "db-doc"
  | "api-doc"
  | "design-system"
  | "design-prompt"
  | "prototype"
  | "acceptance"
  | "code"
  | "doc"
  | "agent-def"
  | "skill"
  | "hook-script"
  | "plan"

export type ReviewStatus = "draft" | "pending" | "approved" | "invalidated"

export interface TaskRow {
  id: number
  module: string | null
  role: Role
  endpoint: string | null
  page: string | null
  type: TaskType
  status: TaskStatus
  assignee: string | null
  creator: string
  content: string | null
  external_ref: string | null
  claim_commit: string | null
  created_at: string
  updated_at: string
}

export interface ArtifactRow {
  id: number
  kind: ArtifactKind
  module: string | null
  endpoint: string | null
  page: string | null
  path: string
  content_hash: string
  approved_hash: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  submitted_at: string | null
  submitted_hash: string | null
  created_at: string
  updated_at: string
}

export interface EventRow {
  id: number
  entity_type: "task" | "artifact"
  entity_id: number
  event: string
  actor: string
  payload: string | null
  module: string | null
  endpoint: string | null
  page: string | null
  created_at: string
}

export interface FeedbackRow {
  id: number
  artifact_id: number
  task_id: number | null
  verdict: 1 | -1
  comment: string | null
  content_hash: string
  actor: string
  created_at: string
}

export interface WorkbenchConfig {
  endpoints: string[]
  docs: { prd: string; architecture: string; design: string; acceptance: string }
  codeRoots: Record<string, string[]>
  machineChecks: { enabled: boolean } & Record<string, boolean | string[]>
  protocolLints: {
    name: string
    grep: string
    paths: string[]
    endpoint?: string
    role?: Role
    message?: string
    allow?: string[]
  }[]
  moduleMapping: Record<string, string>
  feedbackHalfLifeDays: number
  gates: { approvalMode: "warn" | "enforce"; writeGate: "off" | "observe" | "enforce" }
  /** git 集成:trailer 交叉验证默认 off(裁决账本:用户过目后生效) */
  git: { taskTrailer: "off" | "on"; trailerKey: string }
  legacyDb: string
  dataDir: string
  /** CLI 命令前缀(注入 agent 定义与 gate 报错;独立项目默认 workbench/cli.ts) */
  cli: string
  /** kind 注册表覆盖(与 core 默认表深合并) */
  kinds?: Record<string, Record<string, unknown>>
  /** 角色流水线(phase 派生顺序) */
  pipeline: Role[]
  /** 角色产出 kind(gate 上游选择器派生依据);designer 按任务形态在 core 内分流 */
  roleProduces: Record<string, ArtifactKind[]>
  /** 目标 vibecode 平台(生成 agent/MCP/hooks 落地);默认 ["claude"] */
  platforms: string[]
  /** 各平台模型:字符串(全平台同款)或 {platform: model};缺省用各 adapter 默认 */
  model?: string | Record<string, string>
}

/** 一切 core 操作的执行上下文:项目根 + 配置 + 打开的库 */
export interface Ctx {
  root: string
  config: WorkbenchConfig
  db: Database.Database
}
