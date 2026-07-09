import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { WorkbenchConfig } from "./types"

export const CONFIG_FILENAME = "workbench.config.json"

/** npm 包名 */
export const PKG_NAME = "@dawipong/opcflow"

/**
 * 生成到项目里的命令前缀:统一走 npx 零安装调用已发布的包。
 * 项目侧不再需要 opcflow 源码——config.cli / .mcp.json / hooks 全指向这个 bin。
 */
export const WORKBENCH_BIN = `npx -y ${PKG_NAME}`

/**
 * opcflow 包根目录。源码运行时 import.meta.dirname = <pkg>/core;
 * 编译发布后 = <pkg>/dist —— 两者都在包根下一层,统一 ".." 定位包根,
 * templates / preset / web/dist 均由此解析,兼容 tsx 源码与编译产物两种形态。
 */
export const WORKBENCH_DIR = resolve(join(import.meta.dirname, ".."))

const DEFAULTS: WorkbenchConfig = {
  endpoints: ["service", "admin", "weapp", "app"],
  docs: {
    prd: "docs/prd",
    architecture: "docs/architecture",
    design: "docs/design",
    acceptance: "docs/acceptance"
  },
  codeRoots: {},
  machineChecks: { enabled: false },
  protocolLints: [],
  moduleMapping: {},
  feedbackHalfLifeDays: 15,
  gates: { approvalMode: "warn", writeGate: "observe" },
  taskPreconditions: [{ role: "qa", type: "qa", requiresSiblingRoleCompleted: "developer" }],
  git: { taskTrailer: "off", trailerKey: "Task" },
  legacyDb: "tasks/task.db",
  dataDir: ".workbench",
  cli: WORKBENCH_BIN,
  pipeline: ["product-manager", "architect", "designer", "developer", "qa"],
  roleProduces: {
    "product-manager": [
      "project",
      "roles",
      "glossary",
      "flow",
      "module-prd",
      "page-prd"
    ],
    architect: ["db-doc", "api-doc"],
    designer: ["design-system", "design-prompt", "prototype"],
    developer: ["code"],
    qa: ["acceptance"]
  },
  platforms: ["claude"],
  language: "zh"
}

/** 自 from 向上寻找 workbench.config.json 所在目录;找不到则返回 from 本身 */
export function findProjectRoot(from: string = process.cwd()): string {
  let dir = resolve(from)
  while (true) {
    if (existsSync(join(dir, CONFIG_FILENAME))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(from)
    dir = parent
  }
}

export function loadConfig(root: string): WorkbenchConfig {
  const file = join(root, CONFIG_FILENAME)
  if (!existsSync(file)) return { ...DEFAULTS }
  const raw = JSON.parse(
    readFileSync(file, "utf-8")
  ) as Partial<WorkbenchConfig>
  return {
    ...DEFAULTS,
    ...raw,
    docs: { ...DEFAULTS.docs, ...raw.docs },
    gates: { ...DEFAULTS.gates, ...raw.gates },
    machineChecks: { ...DEFAULTS.machineChecks, ...raw.machineChecks },
    roleProduces: { ...DEFAULTS.roleProduces, ...raw.roleProduces },
    pipeline: raw.pipeline ?? DEFAULTS.pipeline,
    git: { ...DEFAULTS.git, ...raw.git },
    platforms: raw.platforms ?? DEFAULTS.platforms
  }
}
