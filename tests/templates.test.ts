import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"
import { genAgents, type Ctx } from "../core/index"
import { openWorkbenchAt } from "../core/db"

/**
 * 模板通用性防回归:agent 模板属于引擎资产,禁止携带任何宿主项目残留。
 * 栈/端专属约定的真相源是项目层(TECH.md 基线/设计系统/protocolLints/config),
 * 模板只允许指向它们。金丝雀列表 = 曾经泄漏进模板的宿主专属词。
 */
const HOST_RESIDUE_CANARIES = [
  "weapp",
  "Taro",
  "NutUI",
  "antd",
  "dart-mcp",
  "app.less",
  "sql.enum",
  "ServiceCode",
  "app-flow-testing",
  "enum-bidirectional",
  "html-to-production",
  "admin-crud-page",
  "prisma",
  "四端",
  "task-management"
]

describe("agent 模板零宿主残留(通用性)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-tpl-"))
  writeFileSync(
    join(root, "workbench.config.json"),
    JSON.stringify({
      endpoints: ["service", "web"],
      codeRoots: { service: ["service/src/modules/{module}"] } // web 故意不配,验证占位提示
    })
  )
  const ctx: Ctx = openWorkbenchAt(root)
  after(() => {
    ctx.db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it("生成物不含任何宿主项目金丝雀词", () => {
    const { written } = genAgents(ctx)
    assert.equal(written.length, 5)
    for (const rel of written) {
      const content = readFileSync(join(ctx.root, rel), "utf-8").toLowerCase()
      for (const canary of HOST_RESIDUE_CANARIES) {
        assert.ok(!content.includes(canary.toLowerCase()), `${rel} 含宿主残留 "${canary}"`)
      }
    }
  })

  it("codeRoots 由 config 注入:已配的端出目录,未配的端出待配置提示", () => {
    const dev = readFileSync(join(ctx.root, ".claude/agents/developer.md"), "utf-8")
    assert.ok(dev.includes("| service | service/src/modules/{module} |"))
    assert.ok(dev.includes("| web | (待配置:workbench.config.json 的 codeRoots) |"))
    assert.ok(dev.includes("service / web"), "ENDPOINTS 注入缺失")
  })

  it("路径投影锚点:默认约定下 developer 的原型/页面 PRD 路径与内置文法一致", () => {
    const dev = readFileSync(join(ctx.root, ".claude/agents/developer.md"), "utf-8")
    assert.ok(dev.includes("docs/design/prototypes/{端}/{模块}/{页面}.html"))
    assert.ok(dev.includes("docs/prd/pages/{端}/{模块}/{页面}.md"))
  })

  it("coords 覆盖穿透:flow 配成 {module}/{endpoint} → 生成的 PM 指示同步变化(单一真相源闭环)", () => {
    const root2 = mkdtempSync(join(tmpdir(), "wb-tpl-ovr-"))
    writeFileSync(
      join(root2, "workbench.config.json"),
      JSON.stringify({ endpoints: ["admin", "app"], kinds: { flow: { coords: "{module}/{endpoint}" } } })
    )
    const ctx2: Ctx = openWorkbenchAt(root2)
    genAgents(ctx2)
    const pm = readFileSync(join(root2, ".claude/agents/product-manager.md"), "utf-8")
    assert.ok(pm.includes("docs/prd/flows/{模块}/{端}.md"), "覆盖后的文法未穿透到 agent 指示")
    assert.ok(!pm.includes("docs/prd/flows/{模块}.md"), "旧的扁平约定仍残留")
    ctx2.db.close()
    rmSync(root2, { recursive: true, force: true })
  })

  it("en 模板:路径投影保持英文占位符", () => {
    const root3 = mkdtempSync(join(tmpdir(), "wb-tpl-en-"))
    writeFileSync(join(root3, "workbench.config.json"), JSON.stringify({ language: "en" }))
    const ctx3: Ctx = openWorkbenchAt(root3)
    genAgents(ctx3)
    const dev = readFileSync(join(root3, ".claude/agents/developer.md"), "utf-8")
    assert.ok(dev.includes("docs/design/prototypes/{endpoint}/{module}/{page}.html"))
    ctx3.db.close()
    rmSync(root3, { recursive: true, force: true })
  })

  it("模板源文件本身也不含金丝雀(防 token 之外的硬编码;含 zh/en 各语言)", () => {
    const base = join(import.meta.dirname, "../templates/agents")
    const langs = readdirSync(base).filter(d => statSync(join(base, d)).isDirectory())
    assert.ok(langs.includes("zh") && langs.includes("en"), "应有 zh/en 两套模板")
    for (const lang of langs) {
      const dir = join(base, lang)
      for (const name of readdirSync(dir).filter(n => n.endsWith(".md"))) {
        const content = readFileSync(join(dir, name), "utf-8").toLowerCase()
        for (const canary of HOST_RESIDUE_CANARIES) {
          assert.ok(!content.includes(canary.toLowerCase()), `模板 ${lang}/${name} 含宿主残留 "${canary}"`)
        }
      }
    }
  })
})
