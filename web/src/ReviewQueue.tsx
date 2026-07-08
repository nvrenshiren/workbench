import { Alert, Button, Card, Drawer, Empty, Flex, Input, Modal, Segmented, Space, Tag, Typography, message } from "antd"
import { useCallback, useEffect, useState } from "react"
import { api, type Artifact } from "./api"
import { MarkdownView } from "./viewers/ArtifactViewer"
import { kindColor, MONO, SURFACE } from "./ui"

function DiffView({ id, path }: { id: number; path: string }) {
  const [diff, setDiff] = useState<{ approved: string | null; current: string | null } | null>(null)
  const isMd = path.endsWith(".md")
  const [mode, setMode] = useState<"preview" | "diff">("diff")
  useEffect(() => {
    setDiff(null)
    api.diff(id).then(d => {
      setDiff(d)
      // md 首次送审默认渲染预览(重点是看内容);复审默认文本对比(重点是看变更)
      setMode(isMd && d.approved === null ? "preview" : "diff")
    })
  }, [id, isMd])
  if (!diff) return null

  const toggle = isMd ? (
    <Segmented
      size="small"
      style={{ marginBottom: 8 }}
      options={[
        { label: "渲染预览", value: "preview" },
        { label: "文本对比", value: "diff" }
      ]}
      value={mode}
      onChange={v => setMode(v as "preview" | "diff")}
    />
  ) : null

  // 统一为纵向 flex 填满可用高度:工具条固定,内容区 flex:1 内部滚动
  if (isMd && mode === "preview") {
    return (
      <Flex vertical style={{ height: "100%" }}>
        {toggle}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            border: `1px solid ${SURFACE.line}`,
            borderRadius: 10,
            padding: "12px 20px",
            background: SURFACE.panel
          }}
        >
          <MarkdownView content={diff.current ?? "(空)"} />
        </div>
      </Flex>
    )
  }

  if (diff.approved === null) {
    return (
      <Flex vertical style={{ height: "100%" }}>
        {toggle}
        <Alert type="info" message="首次送审,无已批版本可比对——展示当前全文" style={{ marginBottom: 8 }} showIcon />
        <pre style={{ ...paneStyle, flex: 1, minHeight: 0 }}>{diff.current ?? "(空)"}</pre>
      </Flex>
    )
  }
  const approvedLines = new Set(diff.approved.split("\n"))
  const currentLines = new Set((diff.current ?? "").split("\n"))
  const render = (text: string, other: Set<string>, color: string) => (
    <pre style={{ ...paneStyle, flex: 1, minHeight: 0 }}>
      {text.split("\n").map((line, i) => (
        <div key={i} style={{ background: other.has(line) ? undefined : color, minHeight: 18 }}>
          {line || " "}
        </div>
      ))}
    </pre>
  )
  return (
    <Flex vertical style={{ height: "100%" }}>
      {toggle}
      <Flex gap={8} style={{ flex: 1, minHeight: 0 }}>
        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text type="secondary">已批版本</Typography.Text>
          {render(diff.approved, currentLines, "rgba(255,77,79,0.22)")}
        </Flex>
        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text type="secondary">当前版本</Typography.Text>
          {render(diff.current ?? "", approvedLines, "rgba(82,196,26,0.22)")}
        </Flex>
      </Flex>
    </Flex>
  )
}

const paneStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: MONO,
  lineHeight: "18px",
  background: SURFACE.raised,
  padding: 10,
  margin: 0,
  borderRadius: 8,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all"
}

export function ReviewQueue({ open, onClose, onActed }: { open: boolean; onClose: () => void; onActed: () => void }) {
  const [queue, setQueue] = useState<Artifact[]>([])
  const [active, setActive] = useState<Artifact | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const [rejecting, setRejecting] = useState(false)

  const load = useCallback(() => {
    api.reviewQueue().then(rows => {
      setQueue(rows)
      setActive(prev => (prev ? rows.find(r => r.id === prev.id) ?? rows[0] ?? null : rows[0] ?? null))
    })
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn()
      message.success(label)
      load()
      onActed()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="82%"
      title={
        <Space size={8}>
          <span>待审队列</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {queue.length} 份等待裁决
          </Typography.Text>
        </Space>
      }
      destroyOnHidden
    >
      {queue.length === 0 ? (
        <Empty description="队列已清空,没有待审产物" />
      ) : (
        <Flex gap={16} style={{ height: "100%" }}>
          <div style={{ width: 330, overflow: "auto", paddingRight: 4, flexShrink: 0 }}>
            {queue.map(a => {
              const isActive = active?.id === a.id
              const idx = a.path.lastIndexOf("/")
              const dir = idx >= 0 ? a.path.slice(0, idx + 1) : ""
              const file = idx >= 0 ? a.path.slice(idx + 1) : a.path
              return (
                <Card
                  key={a.id}
                  onClick={() => setActive(a)}
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
                  <Space size={4} style={{ marginBottom: 4 }}>
                    <Tag bordered={false} color={kindColor(a.kind)} style={{ margin: 0 }}>
                      {a.kind}
                    </Tag>
                    <Tag
                      bordered={false}
                      color={a.review_status === "invalidated" ? "red" : "gold"}
                      style={{ margin: 0 }}
                    >
                      {a.review_status === "invalidated" ? "已失效" : a.ever_approved ? "复审中" : "待审"}
                    </Tag>
                  </Space>
                  <div style={{ fontFamily: MONO, fontSize: 12, lineHeight: 1.5, wordBreak: "break-all" }}>
                    <span style={{ color: "rgba(255,255,255,0.35)" }}>{dir}</span>
                    <span style={{ color: "rgba(255,255,255,0.88)", fontWeight: 500 }}>{file}</span>
                  </div>
                </Card>
              )
            })}
          </div>
          <Flex vertical style={{ flex: 1, minWidth: 0 }}>
            {active && (
              <>
                <Space style={{ marginBottom: 12, flexShrink: 0 }}>
                  <Button type="primary" onClick={() => act(() => api.approve(active.id), "已审批通过")}>
                    通过
                  </Button>
                  <Button onClick={() => act(() => api.approve(active.id, true), "trivial 通过(已 re-bless 下游)")}>
                    trivial 通过
                  </Button>
                  <Button danger onClick={() => setRejecting(true)}>
                    打回
                  </Button>
                  {active.review_status === "invalidated" && (
                    <Button onClick={() => act(() => api.submit(active.id), "已重新送审")}>重新送审</Button>
                  )}
                </Space>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <DiffView id={active.id} path={active.path} />
                </div>
              </>
            )}
          </Flex>
        </Flex>
      )}
      <Modal
        open={rejecting}
        title="打回原因(必填,会进事件流)"
        onCancel={() => setRejecting(false)}
        onOk={async () => {
          if (!active) return
          await act(() => api.reject(active.id, rejectReason), "已打回")
          setRejecting(false)
          setRejectReason("")
        }}
      >
        <Input.TextArea rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)} />
      </Modal>
    </Drawer>
  )
}
