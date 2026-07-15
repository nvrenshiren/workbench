import { PM_KINDS } from "./kind"
import type { ArtifactKind, TaskType, WorkbenchConfig } from "./types"

// ─── 角色注册表:role = 函数(produces=返回值 / requires=参数 / dispatch=调用点 / onQaFail=异常策略) ───
//
// approved 级上游要求不在此声明——它由 kind 注册表的 parents 自动派生(类型推断);
// 这里只承载 kind 表达不了的角色语义。模板(方法论散文)是函数体,永远手写,不进注册表。

/** exist 级输入要求(缺失即阻断领取) */
export interface RoleRequire {
  desc: string
  kinds: ArtifactKind[]
  /** 封闭谓词:endpoint 精确匹配 / 单端排除 / 多端排除(endpointNotIn)。不扩表达式——config 一旦图灵完备,声明式承诺即死 */
  when?: { endpoint?: string; endpointNot?: string; endpointNotIn?: string[] }
}

/** plan 派发规则:该角色在哪些坐标形态被物化为任务 */
export interface RoleDispatch {
  at: "module" | "endpoint" | "page"
  /** at:"module" 时的固定端(如 developer 的 service 后端任务) */
  endpoint?: string
  type?: TaskType
  /** at:"endpoint" 且该端缺此 kind 才派(设计系统前置) */
  ifMissingKind?: ArtifactKind
  /** 该形态任务的产出(缺省 role.produces)——承载 designer 的 page/端级产出分裂 */
  produces?: ArtifactKind[]
  /** 任务 content 模板:{module} {endpoint} {page} 插值 */
  content: string
}

export interface RoleSpec {
  produces: ArtifactKind[]
  requires?: RoleRequire[]
  dispatch?: RoleDispatch[]
  /** 产出被 QA fail 时的接锅方式(目前仅 rework 一种语义) */
  onQaFail?: "rework"
  /** 允许不领取直接完成(流水线头部角色特权,如 PM 由用户直启);未领取完成仍需 operator ∈ {角色本人, 创建者} */
  completeWithoutClaim?: boolean
}

/** 内置 5 角色 = 现行为的逐字节编码(dispatch content 与 plan 派发的现字符串一致) */
export const DEFAULT_ROLE_REGISTRY: Record<string, RoleSpec> = {
  "product-manager": {
    produces: ["project", "roles", "glossary", "flow", "module-prd", "page-prd"],
    completeWithoutClaim: true
  },
  architect: {
    produces: ["db-doc", "api-doc"],
    requires: [{ desc: "PM 产出(模块/页面 PRD)", kinds: PM_KINDS }],
    dispatch: [
      { at: "module", endpoint: "common", content: "设计 {module} 模块数据库" },
      { at: "module", endpoint: "service", content: "设计 {module} 模块 API 文档" }
    ]
  },
  designer: {
    produces: ["design-system", "design-prompt", "prototype"],
    requires: [{ desc: "PM 产出(模块/页面 PRD)", kinds: PM_KINDS }],
    dispatch: [
      { at: "endpoint", ifMissingKind: "design-system", produces: ["design-system"], content: "建立 {endpoint} 端设计系统(该端首个页面设计前置)" },
      { at: "page", produces: ["design-prompt", "prototype"], content: "设计 {endpoint}/{page} 页面(提示词+原型)" }
    ]
  },
  developer: {
    produces: ["code"],
    requires: [
      { desc: "数据库文档", kinds: ["db-doc"] },
      { desc: "API 文档", kinds: ["api-doc"], when: { endpointNot: "service" } },
      // service 后端与 common 纯计算共享包均无 UI,designer 不产其设计稿 → 一并豁免设计稿前置
      { desc: "designer {endpoint} 设计稿", kinds: ["design-prompt", "prototype"], when: { endpointNotIn: ["service", "common"] } }
    ],
    dispatch: [
      { at: "module", endpoint: "service", content: "实现 {module} 模块 service 端" },
      { at: "page", content: "实现 {endpoint}/{page} 页面" }
    ],
    onQaFail: "rework"
  },
  qa: {
    produces: ["acceptance"],
    dispatch: [{ at: "page", type: "qa", content: "验收 {endpoint}/{page} 页面" }]
  }
}

/** 合并:内置默认 ← config.roleProduces(旧字段,仅 produces 维度)← config.roles(逐角色浅合并) */
export function getRoleRegistry(config: WorkbenchConfig): Record<string, RoleSpec> {
  const merged: Record<string, RoleSpec> = {}
  for (const [role, spec] of Object.entries(DEFAULT_ROLE_REGISTRY)) merged[role] = { ...spec }
  for (const [role, kinds] of Object.entries(config.roleProduces ?? {})) {
    merged[role] = { ...(merged[role] ?? { produces: [] }), produces: kinds as ArtifactKind[] }
  }
  for (const [role, override] of Object.entries(config.roles ?? {})) {
    merged[role] = { ...(merged[role] ?? { produces: [] }), ...override } as RoleSpec
  }
  return merged
}

/**
 * actor 是否流水线角色(AI 执行者)。「人审不外包」判定:审批(approve/reject、原型👍 放行)
 * 是人的动作,角色不得以自身身份自审自批;判据走注册表,项目自定义角色(config.roles)一并覆盖。
 */
export function isPipelineRole(config: WorkbenchConfig, actor: string): boolean {
  return Object.prototype.hasOwnProperty.call(getRoleRegistry(config), actor)
}

/** kind → 产出它的角色(produces 反查;code 兜底 developer,兼容旧 ownerRole 语义) */
export function ownerRoleOf(config: WorkbenchConfig, kind: ArtifactKind): string | null {
  for (const [role, spec] of Object.entries(getRoleRegistry(config))) {
    if (spec.produces.includes(kind)) return role
  }
  if (kind === "code") return "developer"
  return null
}
