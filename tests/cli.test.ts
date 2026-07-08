import { spawnSync } from "node:child_process"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { after, describe, it } from "node:test"
import { parseArgs } from "../cli-runner"

const REPO = join(import.meta.dirname, "..")
const CLI = join(REPO, "cli.ts")
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href

/** 在干净临时目录里跑一次 CLI(经 tsx 从源码执行),返回退出码与 stdout。 */
function runCli(args: string[], cwd: string) {
  const env = { ...process.env }
  delete env.WORKBENCH_PROJECT
  delete env.WORKBENCH_TASK_ID
  const r = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI, ...args], {
    cwd,
    env,
    encoding: "utf-8"
  })
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

describe("parseArgs:命令 / 长选项 / 位置参 / 分隔符", () => {
  it("空 argv → 无命令、空参数袋", () => {
    const { command, a } = parseArgs([])
    assert.equal(command, undefined)
    assert.deepEqual(a, {})
  })

  it("命令 + 多个 --key=value", () => {
    const { command, a } = parseArgs(["list", "--status=pending", "--module=land"])
    assert.equal(command, "list")
    assert.equal(a.status, "pending")
    assert.equal(a.module, "land")
  })

  it("纯数字位置参 → a.id", () => {
    const { command, a } = parseArgs(["show", "5"])
    assert.equal(command, "show")
    assert.equal(a.id, 5)
  })

  it("`--` 分隔符被跳过,其后作为文件路径位置参落到 a._", () => {
    const { command, a } = parseArgs(["submit", "--actor=pm", "--", "docs/prd/modules/land.md"])
    assert.equal(command, "submit")
    assert.equal(a.actor, "pm")
    assert.equal(a._, "docs/prd/modules/land.md")
  })

  it("含等号的值原样保留(如 JSON model 串)", () => {
    const { a } = parseArgs(["init", '--model={"codex":"gpt-5.1"}'])
    assert.equal(a.model, '{"codex":"gpt-5.1"}')
  })
})

describe("CLI 入口:帮助与未知命令", () => {
  const dirs: string[] = []
  const fresh = () => {
    const d = mkdtempSync(join(tmpdir(), "wb-cli-"))
    dirs.push(d)
    return d
  }
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  for (const flag of ["-h", "--help", "help"]) {
    it(`\`${flag}\` → 打印帮助,退出 0,且不创建 .workbench`, () => {
      const d = fresh()
      const r = runCli([flag], d)
      assert.equal(r.status, 0)
      assert.match(r.stdout, /opcflow CLI/)
      assert.equal(existsSync(join(d, ".workbench")), false)
    })
  }

  it("无参 → 打印帮助,退出 0,且不创建 .workbench(不再误列任务/误建库)", () => {
    const d = fresh()
    const r = runCli([], d)
    assert.equal(r.status, 0)
    assert.match(r.stdout, /opcflow CLI/)
    assert.equal(existsSync(join(d, ".workbench")), false)
  })

  it("未知命令 → 报错 + 帮助,退出 1", () => {
    const d = fresh()
    const r = runCli(["definitely-not-a-command"], d)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /未知命令: definitely-not-a-command/)
    assert.match(r.stdout, /opcflow CLI/)
  })
})
