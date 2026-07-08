import { Alert, Button, Card, Drawer, Empty, Flex, Space, Tag, Typography, message } from "antd"
import { useCallback, useEffect, useState } from "react"
import { api, type DistillGroup, type SkillCandidatesReport } from "./api"
import { MONO, SURFACE } from "./ui"

const BUCKET = {
  "skill-candidate": { color: "green", label: "skill 候选" },
  "red-flag": { color: "red", label: "red-flag" },
  observation: { color: "default", label: "观察" }
} as const

/** 把一组证据 + guidance 组装成给 AI 的起草指令(复制到剪贴板,人带进 Claude 会话起草) */
function buildDraftPrompt(g: DistillGroup, guidance: string[]): string {
  const lines: string[] = [
    "依据以下 workbench 反馈证据,起草一份 skill(.claude/skills/<名称>/SKILL.md):",
    "",
    `分组:${g.endpoint}/${g.kind}    桶:${g.bucket}    正分 ${g.posScore} / 负分 ${g.negScore}`,
    "",
    "证据(evidence):"
  ]
  for (const e of g.evidence) {
    lines.push(
      `  [${e.verdict > 0 ? "+1" : "-1"}] ${e.path}${e.comment ? `  — ${e.comment}` : ""}  (${e.actor}, 权重 ${e.weight})`
    )
  }
  lines.push(
    "",
    "起草要求:",
    "- skill-candidate:把正例共性提炼成「正确做法」;",
    "- red-flag:把负例 comment 写进「Red Flags」章节;",
    "- 能机器查的约定,建议降级为 workbench.config.json 的 protocolLints 卡点;",
    "- 起草后 `register-meta` 注册 + `submit --actor=<角色>` 送人审,approved 才生效。"
  )
  if (guidance.length) {
    lines.push("", "引擎 guidance:")
    guidance.forEach(x => lines.push(`  · ${x}`))
  }
  return lines.join("\n")
}

export function SkillCandidates({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [report, setReport] = useState<SkillCandidatesReport | null>(null)
  const [active, setActive] = useState<DistillGroup | null>(null)

  const load = useCallback(() => {
    api.skillCandidates().then(r => {
      setReport(r)
      const key = (g: DistillGroup) => `${g.endpoint}/${g.kind}`
      setActive(prev =>
        prev ? r.groups.find(g => key(g) === key(prev)) ?? r.groups[0] ?? null : r.groups[0] ?? null
      )
    })
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const copyDraft = async (g: DistillGroup) => {
    try {
      await navigator.clipboard.writeText(buildDraftPrompt(g, report?.guidance ?? []))
      message.success("起草指令已复制,粘贴到 Claude Code 会话即可起草 skill")
    } catch {
      message.error("复制失败(剪贴板权限?),可手动选中证据文本")
    }
  }

  const groups = report?.groups ?? []

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="72%"
      title={
        <Space size={8}>
          <span>经验提炼</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {report
              ? `${report.candidates} 个 skill 候选 · ${report.redFlags} 个 red-flag · 半衰期 ${report.halfLifeDays} 天`
              : ""}
          </Typography.Text>
        </Space>
      }
      destroyOnHidden
    >
      {groups.length === 0 ? (
        <Empty description="暂无达阈值的 skill 候选 / red-flag(继续积累 👍👎 与 QA 反馈)" />
      ) : (
        <Flex gap={16} style={{ height: "100%" }}>
          <div style={{ width: 300, overflow: "auto", paddingRight: 4, flexShrink: 0 }}>
            {groups.map(g => {
              const k = `${g.endpoint}/${g.kind}`
              const isActive = active ? `${active.endpoint}/${active.kind}` === k : false
              const b = BUCKET[g.bucket]
              return (
                <Card
                  key={k}
                  onClick={() => setActive(g)}
                  styles={{ body: { padding: "10px 12px" } }}
                  style={{
                    cursor: "pointer",
                    marginBottom: 8,
                    borderRadius: 10,
                    borderColor: isActive ? "rgba(47,189,175,0.55)" : SURFACE.line,
                    background: isActive ? "rgba(47,189,175,0.08)" : SURFACE.panel,
                    transition: "border-color .18s ease, background .18s ease"
                  }}
                >
                  <Tag bordered={false} color={b.color} style={{ margin: "0 0 4px" }}>
                    {b.label}
                  </Tag>
                  <div
                    style={{
                      fontFamily: MONO,
                      fontSize: 12,
                      lineHeight: 1.5,
                      wordBreak: "break-all",
                      color: "rgba(255,255,255,0.88)",
                      fontWeight: 500
                    }}
                  >
                    {k}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 2 }}>
                    正 {g.posScore} / 负 {g.negScore} · {g.evidence.length} 条证据
                  </div>
                </Card>
              )
            })}
          </div>
          <Flex vertical style={{ flex: 1, minWidth: 0 }}>
            {active && (
              <>
                <Space style={{ marginBottom: 12, flexShrink: 0 }}>
                  <Button type="primary" onClick={() => copyDraft(active)}>
                    复制起草指令
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {BUCKET[active.bucket].label} · 正 {active.posScore} / 负 {active.negScore}
                  </Typography.Text>
                </Space>
                <Alert
                  type={active.bucket === "red-flag" ? "warning" : "info"}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    active.bucket === "red-flag"
                      ? "负例达阈值:把这些 comment 提炼进 skill 的 Red Flags 章节"
                      : "正例达阈值:把共性提炼成 skill 的正确做法。起草 → 人审 approved 才生效"
                  }
                />
                <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                  {active.evidence.map((e, i) => (
                    <Card
                      key={i}
                      styles={{ body: { padding: "8px 10px" } }}
                      style={{
                        marginBottom: 8,
                        borderRadius: 8,
                        background: SURFACE.raised,
                        borderColor: SURFACE.line
                      }}
                    >
                      <Space size={6} style={{ marginBottom: 4 }}>
                        <Tag bordered={false} color={e.verdict > 0 ? "green" : "red"} style={{ margin: 0 }}>
                          {e.verdict > 0 ? "+1" : "-1"}
                        </Tag>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {e.actor} · 权重 {e.weight} · {e.createdAt}
                        </Typography.Text>
                      </Space>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 12,
                          wordBreak: "break-all",
                          color: "rgba(255,255,255,0.82)"
                        }}
                      >
                        {e.path}
                      </div>
                      {e.comment && (
                        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.7)", marginTop: 4 }}>{e.comment}</div>
                      )}
                    </Card>
                  ))}
                </div>
              </>
            )}
          </Flex>
        </Flex>
      )}
    </Drawer>
  )
}
