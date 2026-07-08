import { Alert, Button, Card, Drawer, Empty, Flex, Space, Tag, Typography, message } from "antd"
import { useCallback, useEffect, useState } from "react"
import { api, type DistillGroup, type SkillCandidatesReport } from "./api"
import { MONO, SURFACE } from "./ui"
import { t } from "./i18n"

/** 把一组证据 + guidance 组装成给 AI 的沉淀指令(复制到剪贴板,人带进 Claude 会话) */
function buildDraftPrompt(g: DistillGroup, guidance: string[]): string {
  const lines: string[] = [
    t(
      "依据以下 opcflow 反馈证据,先判断这条经验最适合沉淀为 skill / 规则 / 记忆中的哪一种,再按对应路径产出:",
      "Based on the following opcflow feedback evidence, first decide whether this experience is best captured as a skill / rule / memory, then produce it via the matching route:"
    ),
    "",
    t(
      `分组:${g.endpoint}/${g.kind}    桶:${g.bucket}    正分 ${g.posScore} / 负分 ${g.negScore}`,
      `Group: ${g.endpoint}/${g.kind}    Bucket: ${g.bucket}    +score ${g.posScore} / -score ${g.negScore}`
    ),
    "",
    t("证据(evidence):", "Evidence:")
  ]
  for (const e of g.evidence) {
    lines.push(
      t(
        `  [${e.verdict > 0 ? "+1" : "-1"}] ${e.path}${e.comment ? `  — ${e.comment}` : ""}  (${e.actor}, 权重 ${e.weight})`,
        `  [${e.verdict > 0 ? "+1" : "-1"}] ${e.path}${e.comment ? `  — ${e.comment}` : ""}  (${e.actor}, weight ${e.weight})`
      )
    )
  }
  lines.push(
    "",
    t("三选一(按判据挑,再产出):", "Pick one (by these criteria), then produce:"),
    t(
      "- skill —— 跨会话可复用的做法/流程:写 .claude/skills/<名称>/SKILL.md,再 `register-meta` 注册 + `submit --actor=<角色>` 送人审,approved 才生效;",
      "- skill — a reusable practice/procedure across sessions: write .claude/skills/<name>/SKILL.md, then `register-meta` + `submit --actor=<role>` for human review; effective once approved;"
    ),
    t(
      "- 规则(rule)—— 必须始终成立、能机器查的硬约束:降级为 workbench.config.json 的 protocolLints 卡点(或写入 TECH.md / 基线约定);",
      "- rule — a hard, machine-checkable constraint that must always hold: downgrade it to a protocolLints gate in workbench.config.json (or write it into TECH.md / the baseline);"
    ),
    t(
      "- 记忆(memory)—— 只对该角色/项目有用、不值得单独成篇的教训或偏好:写 .claude/agent-memory/<角色>/,更新 MEMORY.md 索引;",
      "- memory — a role/project-specific lesson or preference not worth a whole skill: write .claude/agent-memory/<role>/ and update the MEMORY.md index;"
    ),
    t(
      "- 负例(-1)的 comment 是「别再犯」的素材:能机器查→规则,跨会话通用坑→写进 skill 的 Red Flags,角色专属坑→记忆。",
      "- negative (-1) comments are “don't repeat this” material: machine-checkable → rule, general cross-session pitfall → the skill's Red Flags section, role-specific pitfall → memory."
    )
  )
  if (guidance.length) {
    lines.push("", t("引擎 guidance:", "Engine guidance:"))
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
      message.success(t("沉淀指令已复制,粘贴到 Claude Code 会话即可判断并沉淀为 skill/规则/记忆", "Distill instruction copied — paste it into a Claude Code session to classify and capture as skill/rule/memory"))
    } catch {
      message.error(t("复制失败(剪贴板权限?),可手动选中证据文本", "Copy failed (clipboard permission?) — you can select the evidence text manually"))
    }
  }

  const groups = report?.groups ?? []

  const BUCKET = {
    candidate: { color: "green", label: t("经验候选", "Candidate") },
    "red-flag": { color: "red", label: "red-flag" },
    observation: { color: "default", label: t("观察", "Observation") }
  } as const

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="72%"
      title={
        <Space size={8}>
          <span>{t("经验提炼", "Distill")}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {report
              ? t(
                  `${report.candidates} 个经验候选 · ${report.redFlags} 个 red-flag · 半衰期 ${report.halfLifeDays} 天`,
                  `${report.candidates} candidate(s) · ${report.redFlags} red-flag(s) · half-life ${report.halfLifeDays} day(s)`
                )
              : ""}
          </Typography.Text>
        </Space>
      }
      destroyOnHidden
    >
      {groups.length === 0 ? (
        <Empty description={t("暂无达阈值的经验候选 / red-flag(继续积累 👍👎 与 QA 反馈)", "No candidates / red-flags above threshold yet (keep gathering 👍👎 and QA feedback)")} />
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
                      color: "rgba(var(--wb-fg),0.88)",
                      fontWeight: 500
                    }}
                  >
                    {k}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(var(--wb-fg),0.45)", marginTop: 2 }}>
                    {t(
                      `正 ${g.posScore} / 负 ${g.negScore} · ${g.evidence.length} 条证据`,
                      `+${g.posScore} / -${g.negScore} · ${g.evidence.length} evidence`
                    )}
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
                    {t("复制沉淀指令", "Copy distill instruction")}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {BUCKET[active.bucket].label} · {t(`正 ${active.posScore} / 负 ${active.negScore}`, `+${active.posScore} / -${active.negScore}`)}
                  </Typography.Text>
                </Space>
                <Alert
                  type={active.bucket === "red-flag" ? "warning" : "info"}
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={
                    active.bucket === "red-flag"
                      ? t("负例达阈值:按判据沉淀——能机器查→规则(protocolLints),通用坑→skill 的 Red Flags,角色专属坑→记忆", "Negative cases above threshold: capture by criteria — machine-checkable → rule (protocolLints), general pitfall → the skill's Red Flags, role-specific pitfall → memory")
                      : t("正例达阈值:判断沉淀为 skill / 规则 / 记忆之一,再按对应路径产出(skill 需人审 approved 才生效)", "Positive cases above threshold: decide skill / rule / memory, then produce via the matching route (skills take effect once approved)")
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
                          {e.actor} · {t(`权重 ${e.weight}`, `weight ${e.weight}`)} · {e.createdAt}
                        </Typography.Text>
                      </Space>
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 12,
                          wordBreak: "break-all",
                          color: "rgba(var(--wb-fg),0.82)"
                        }}
                      >
                        {e.path}
                      </div>
                      {e.comment && (
                        <div style={{ fontSize: 12, color: "rgba(var(--wb-fg),0.7)", marginTop: 4 }}>{e.comment}</div>
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
