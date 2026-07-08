/**
 * 多平台 hook 入参归一。各平台传给 hook 的 stdin JSON / 项目根环境变量各不相同,
 * 这里做防御式提取(字段名尽量全覆盖;版本可能微调,以目标平台实测为准)。
 */
export function hookPlatform(): string {
  const arg = process.argv.find(a => a.startsWith("--platform="))
  return arg ? arg.slice("--platform=".length) : "claude"
}

/** 从 hook stdin JSON 里提取被操作文件路径(跨平台字段兜底) */
export function extractFilePath(input: any): string | undefined {
  return (
    input?.tool_input?.file_path ?? // claude PreToolUse/PostToolUse
    input?.tool_input?.filePath ??
    input?.file_path ?? // cursor afterFileEdit / 通用
    input?.filePath ??
    input?.args?.file_path ?? // opencode tool 参数
    input?.args?.filePath ??
    input?.arguments?.file_path ?? // codex 兜底
    input?.arguments?.filePath ??
    input?.input?.file_path ??
    undefined
  )
}

/** 项目根:各平台可能注入不同环境变量;都没有则交给 findProjectRoot(cwd) */
export function hookProjectDir(): string | undefined {
  return (
    process.env.CLAUDE_PROJECT_DIR ??
    process.env.CODEX_PROJECT_DIR ??
    process.env.CURSOR_PROJECT_DIR ??
    process.env.OPENCODE_PROJECT_DIR ??
    process.env.WORKBENCH_PROJECT ??
    undefined
  )
}

/** 读取 stdin 全部内容并 JSON 解析(失败返回 {}) */
export async function readStdinJson(): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
  } catch {
    return {}
  }
}
