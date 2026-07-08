import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { CONFIG_FILENAME, workbenchRelPath } from "../config"
import { openWorkbenchAt } from "../db"
import type { Ctx, Role } from "../types"
import { genAgents } from "./gen-agents.command"
import { installGitHooks } from "./install-hooks.command"
import { registerMetaArtifacts } from "./meta.command"

export interface InitOptions {
  /** 项目有哪些端(有无前端端决定 designer 是否进流水线;qa 恒在) */
  endpoints: string[]
  /** 覆盖角色流水线;缺省按 endpoints 推断(纯后端 → 无 designer) */
  pipeline?: Role[]
  /** 每个端的代码目录约定(scan 目录级登记 code 产物用);{module} 是模块名占位 */
  codeRoots?: Record<string, string[]>
  /** 是否安装 git hooks(非 git 仓库自动跳过) */
  gitHooks?: boolean
  /** 是否脚手架 docs 目录骨架(默认 true) */
  scaffold?: boolean
  /** 是否写 .mcp.json 让 Claude Code 自动挂载 MCP(默认 true) */
  mcp?: boolean
  /** 是否把 workbench/preset 下的预置文件部署到项目根(默认 true) */
  preset?: boolean
}

export interface InitResult {
  ctx: Ctx
  configPath: string
  agents: string[]
  metaRegistered: number
  hooks: string[]
  scaffolded: string[]
  mcpPath: string | null
  preset: string[]
  /** 是否往根 package.json 补了 tsx devDep(补了则需 pnpm install 生效) */
  rootTsxAdded: boolean
}

const DOC_DIRS = [
  "docs/prd/flows",
  "docs/prd/modules",
  "docs/prd/pages",
  "docs/architecture/database",
  "docs/architecture/api",
  "docs/design/systems",
  "docs/design/prompts",
  "docs/design/prototypes",
  "docs/acceptance"
]

/** 引擎内预置文件目录:init 时整目录部署到项目根(见 deployPreset) */
const PRESET_DIR = join(import.meta.dirname, "..", "..", "preset")

/**
 * 递归把 preset/ 下所有文件(含 dotfiles / 子目录,保留相对结构)部署到项目根。
 * 目标已存在则跳过——与 init 其余步骤一致的幂等防覆盖策略。返回已部署的相对路径。
 */
function deployPreset(root: string): string[] {
  const deployed: string[] = []
  if (!existsSync(PRESET_DIR)) return deployed
  const walk = (rel: string): void => {
    for (const ent of readdirSync(join(PRESET_DIR, rel), {
      withFileTypes: true
    })) {
      const childRel = rel ? join(rel, ent.name) : ent.name
      if (ent.isDirectory()) {
        walk(childRel)
      } else if (ent.isFile()) {
        const dest = join(root, childRel)
        if (existsSync(dest)) continue
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(join(PRESET_DIR, childRel), dest)
        deployed.push(childRel)
      }
    }
  }
  walk("")
  return deployed
}

/** 根 package.json 缺 tsx 时补的版本区间(与 workbench 自身 devDep 对齐) */
const TSX_VERSION = "^4"

/**
 * 确保项目根 package.json 的 devDependencies 里有 tsx。
 * workbench 的两处约定都靠 `npx tsx`(config.cli 的 `npx tsx cli.ts`、.mcp.json 的
 * `npx tsx server/mcp.ts`),根缺 tsx 时 npx 解析会间歇失败——CLI 命令抽风、MCP 服务拉不起,
 * agents 反复踩。幂等:已有 tsx、或根本没有 package.json,都不动。返回是否写入(写了需 pnpm install 生效)。
 */
function ensureRootTsx(root: string): boolean {
  const pkgPath = join(root, "package.json")
  if (!existsSync(pkgPath)) return false
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    devDependencies?: Record<string, string>
  }
  if (pkg.devDependencies?.tsx) return false
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), tsx: TSX_VERSION }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  return true
}

/**
 * 新项目一键引导:生成项目层 config → 建库 → 脚手架 docs 骨架 →
 * 从模板生成 agent 定义 → 元产物 draft 注册 → 写 .mcp.json → git hooks。
 * 幂等防覆盖:已有 config 的目录拒绝执行。
 */
export function initProject(root: string, opts: InitOptions): InitResult {
  const configPath = join(root, CONFIG_FILENAME)
  if (existsSync(configPath)) {
    throw new Error(
      `${CONFIG_FILENAME} 已存在,init 只用于空项目引导(改配置请直接编辑该文件)`
    )
  }
  if (opts.endpoints.length === 0)
    throw new Error("至少声明一个端(--endpoints=service,...)")

  const hasFrontend = opts.endpoints.some(e => e !== "service")
  const pipeline: Role[] =
    opts.pipeline ??
    (hasFrontend
      ? ["product-manager", "architect", "designer", "developer", "qa"]
      : ["product-manager", "architect", "developer", "qa"])

  const config = {
    endpoints: opts.endpoints,
    pipeline,
    docs: {
      prd: "docs/prd",
      architecture: "docs/architecture",
      design: "docs/design",
      acceptance: "docs/acceptance"
    },
    codeRoots: opts.codeRoots ?? {},
    cli: `npx tsx ${workbenchRelPath(root, "cli.ts")}`,
    machineChecks: { enabled: false },
    protocolLints: [],
    moduleMapping: {},
    feedbackHalfLifeDays: 15,
    gates: { approvalMode: "warn", writeGate: "observe" },
    git: { taskTrailer: "off", trailerKey: "Task" }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")

  const scaffolded: string[] = []
  if (opts.scaffold !== false) {
    for (const dir of DOC_DIRS) {
      const abs = join(root, dir)
      if (!existsSync(abs)) {
        mkdirSync(abs, { recursive: true })
        writeFileSync(join(abs, ".gitkeep"), "")
        scaffolded.push(dir)
      }
    }
  }

  const preset = opts.preset !== false ? deployPreset(root) : []
  const rootTsxAdded = ensureRootTsx(root)

  const ctx = openWorkbenchAt(root)
  const { written } = genAgents(ctx)
  const meta = registerMetaArtifacts(ctx)

  let mcpPath: string | null = null
  if (opts.mcp !== false) {
    const p = join(root, ".mcp.json")
    if (!existsSync(p)) {
      writeFileSync(
        p,
        JSON.stringify(
          {
            mcpServers: {
              workbench: {
                command: "npx",
                args: ["tsx", workbenchRelPath(root, "server/mcp.ts")]
              }
            }
          },
          null,
          2
        ) + "\n"
      )
      mcpPath = ".mcp.json"
    }
  }

  let hooks: string[] = []
  if (opts.gitHooks !== false && existsSync(join(root, ".git"))) {
    try {
      hooks = installGitHooks(ctx)
    } catch {
      /* 非 git 仓库/hook 目录异常:引导不因此失败 */
    }
  }

  return {
    ctx,
    configPath,
    agents: written,
    metaRegistered: meta.registered.length,
    hooks,
    scaffolded,
    mcpPath,
    preset,
    rootTsxAdded
  }
}
