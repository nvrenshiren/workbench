import { existsSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type { WorkbenchConfig } from "./types"

export const CONFIG_FILENAME = "workbench.config.json"

/** workbench 包自身所在目录(不假设它叫 workbench/ 或位于项目哪一层) */
export const WORKBENCH_DIR = resolve(join(import.meta.dirname, ".."))

/**
 * 从项目根指向 workbench 包内某文件的相对调用路径(正斜杠)。
 * init / install-hooks / 默认 cli 都由此生成,workbench 无论作为子目录
 * 还是仓库根都能得到正确路径(根即包目录时返回 "cli.ts" 这类裸路径)。
 */
export function workbenchRelPath(root: string, ...segments: string[]): string {
  return relative(resolve(root), join(WORKBENCH_DIR, ...segments)).replace(
    /\\/g,
    "/"
  )
}

const DEFAULTS: WorkbenchConfig = {
  endpoints: ["service", "web"],
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
  git: { taskTrailer: "off", trailerKey: "Task" },
  legacyDb: ".workbench/legacy.db",
  dataDir: ".workbench",
  cli: "npx tsx workbench/cli.ts",
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
  }
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
  // cli 缺省按实际布局推导,不写死 workbench/ 子目录前缀
  const dynamicCli = `npx tsx ${workbenchRelPath(root, "cli.ts")}`
  const file = join(root, CONFIG_FILENAME)
  if (!existsSync(file)) return { ...DEFAULTS, cli: dynamicCli }
  const raw = JSON.parse(
    readFileSync(file, "utf-8")
  ) as Partial<WorkbenchConfig>
  return {
    ...DEFAULTS,
    cli: dynamicCli,
    ...raw,
    docs: { ...DEFAULTS.docs, ...raw.docs },
    gates: { ...DEFAULTS.gates, ...raw.gates },
    machineChecks: { ...DEFAULTS.machineChecks, ...raw.machineChecks },
    roleProduces: { ...DEFAULTS.roleProduces, ...raw.roleProduces },
    pipeline: raw.pipeline ?? DEFAULTS.pipeline,
    git: { ...DEFAULTS.git, ...raw.git }
  }
}
