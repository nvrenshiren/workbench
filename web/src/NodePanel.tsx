import { Badge, Button, Card, Drawer, Empty, Flex, List, Space, Table, Tabs, Tag, Typography } from "antd"
import { useEffect, useState } from "react"
import { api, type Artifact, type Task, type TreeNode, type WbEvent } from "./api"
import { ArtifactViewer } from "./viewers/ArtifactViewer"
import { eventColor, kindColor, MONO, SURFACE } from "./ui"

const REVIEW_TAG: Record<string, { color: string; text: string }> = {
  draft: { color: "default", text: "草稿" },
  pending: { color: "gold", text: "待审" },
  approved: { color: "green", text: "已审批" },
  invalidated: { color: "red", text: "已失效" }
}

const STATUS_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: "default", text: "待领取" },
  in_progress: { color: "blue", text: "进行中" },
  completed: { color: "green", text: "已完成" },
  cancelled: { color: "red", text: "已取消" }
}

/** 路径拆分:目录弱化,文件名强调 */
function PathText({ path, size = 13 }: { path: string; size?: number }) {
  const idx = path.lastIndexOf("/")
  const dir = idx >= 0 ? path.slice(0, idx + 1) : ""
  const file = idx >= 0 ? path.slice(idx + 1) : path
  return (
    <span style={{ fontSize: size, fontFamily: MONO }}>
      <span style={{ color: "rgba(255,255,255,0.35)" }}>{dir}</span>
      <span style={{ color: "rgba(255,255,255,0.85)", fontWeight: 500 }}>{file}</span>
    </span>
  )
}

export function NodePanel({
  node,
  liveEvents,
  onOpenQueue,
  queueCount
}: {
  node: TreeNode | null
  liveEvents: WbEvent[]
  onOpenQueue: () => void
  queueCount: number
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [viewing, setViewing] = useState<Artifact | null>(null)

  // liveEvents 上限 50 条,length 会饱和;用最新事件 id(单调递增)驱动实时刷新
  const latestEventId = liveEvents[0]?.id ?? 0

  useEffect(() => {
    if (!node) return
    const q =
      node.key === "__project__" || node.key === "__meta__"
        ? { module: node.key }
        : { module: node.module ?? undefined, endpoint: node.endpoint ?? undefined, page: node.page ?? undefined }
    if (node.key === "__root__") {
      setArtifacts([])
      setTasks([])
      return
    }
    api.node(q).then(d => {
      setArtifacts(d.artifacts)
      setTasks(d.tasks)
    })
  }, [node, latestEventId])

  if (!node || node.key === "__root__") {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "56px 24px" }}>
        <Card
          style={{
            background: SURFACE.panel,
            borderColor: SURFACE.line,
            borderRadius: 12,
            marginBottom: 20
          }}
          styles={{ body: { padding: "28px 32px" } }}
        >
          <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.3 }}>
            验证是唯一瓶颈
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "8px 0 20px", fontSize: 13 }}>
            左侧树按 模块 → 端 → 页面 组织全部产物与任务;你的动作只有三件——审批契约、给产物点
            👍👎、回答裁决。其余都是 AI 与数据库的事。
          </Typography.Paragraph>
          <Space>
            <Badge count={queueCount} size="small" offset={[-2, 2]}>
              <Button type="primary" onClick={onOpenQueue}>
                处理待审队列
              </Button>
            </Badge>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {queueCount > 0 ? `${queueCount} 份契约等待你的裁决` : "队列已清空"}
            </Typography.Text>
          </Space>
        </Card>
        <Card
          style={{
            background: SURFACE.panel,
            borderColor: SURFACE.line,
            borderRadius: 12
          }}
          styles={{ body: { padding: "16px 20px" } }}
        >
          <div style={{ fontSize: 11, letterSpacing: 1, color: "rgba(255,255,255,0.35)", marginBottom: 10 }}>
            实时事件
          </div>
          <EventFeed events={liveEvents} />
        </Card>
      </div>
    )
  }

  const coord = [node.module, node.endpoint, node.page].filter(Boolean).join(" / ")

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 28px 40px" }}>
      {coord && (
        <div style={{ fontSize: 11, fontFamily: MONO, color: "rgba(255,255,255,0.35)", marginBottom: 2 }}>{coord}</div>
      )}
      <Space align="baseline" style={{ marginBottom: 8 }}>
        <Typography.Title level={4} style={{ margin: 0, letterSpacing: -0.3 }}>
          {node.title}
        </Typography.Title>
        {node.phase !== "-" && (
          <Tag bordered={false} color="cyan" style={{ fontSize: 11 }}>
            {node.phase}
          </Tag>
        )}
      </Space>

      <Tabs
        items={[
          {
            key: "artifacts",
            label: `产物 ${artifacts.length > 0 ? artifacts.length : ""}`,
            children:
              artifacts.length === 0 ? (
                <Empty description="该坐标暂无登记产物" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <List
                  size="small"
                  split={false}
                  dataSource={artifacts}
                  renderItem={a => {
                    const tag = REVIEW_TAG[a.review_status]
                    return (
                      <List.Item
                        className="wb-hover-row"
                        style={{ cursor: "pointer", padding: "8px 10px" }}
                        onClick={() => setViewing(a)}
                        actions={[
                          a.kind === "prototype" && a.endorsed ? (
                            <Tag bordered={false} color="green">
                              👍 已放行
                            </Tag>
                          ) : null,
                          <Tag bordered={false} color={tag.color}>
                            {a.review_status === "pending" && a.ever_approved ? "复审中(禁用)" : tag.text}
                          </Tag>
                        ].filter(Boolean)}
                      >
                        <Space size={10}>
                          <Tag bordered={false} color={kindColor(a.kind)} style={{ minWidth: 76, textAlign: "center" }}>
                            {a.kind}
                          </Tag>
                          <PathText path={a.path} />
                        </Space>
                      </List.Item>
                    )
                  }}
                />
              )
          },
          {
            key: "tasks",
            label: `任务 ${tasks.length > 0 ? tasks.length : ""}`,
            children: (
              <Table
                size="small"
                rowKey="id"
                pagination={{ pageSize: 15, hideOnSinglePage: true }}
                dataSource={tasks}
                columns={[
                  {
                    title: "ID",
                    dataIndex: "id",
                    width: 64,
                    render: id => <span style={{ fontFamily: MONO, fontSize: 12 }}>#{id}</span>
                  },
                  { title: "角色", dataIndex: "role", width: 130 },
                  {
                    title: "类型",
                    dataIndex: "type",
                    width: 90,
                    render: t => <Tag bordered={false}>{t}</Tag>
                  },
                  {
                    title: "状态",
                    dataIndex: "status",
                    width: 130,
                    render: (s: string, row: Task) => (
                      <Space size={4}>
                        <Tag bordered={false} color={STATUS_TAG[s]?.color}>
                          {STATUS_TAG[s]?.text ?? s}
                        </Tag>
                        {row.stale && (
                          <Tag bordered={false} color="orange">
                            stale
                          </Tag>
                        )}
                      </Space>
                    )
                  },
                  { title: "执行人", dataIndex: "assignee", width: 130 },
                  { title: "内容", dataIndex: "content", ellipsis: true },
                  {
                    title: "更新时间",
                    dataIndex: "updated_at",
                    width: 170,
                    render: t => <span style={{ fontFamily: MONO, fontSize: 12, color: "rgba(255,255,255,0.45)" }}>{t}</span>
                  }
                ]}
              />
            )
          },
          {
            key: "timeline",
            label: "实时事件",
            children: <EventFeed events={liveEvents} />
          }
        ]}
      />

      <Drawer
        open={viewing !== null}
        onClose={() => setViewing(null)}
        width="72%"
        title={
          viewing && (
            <Space>
              <Tag bordered={false} color={kindColor(viewing.kind)}>
                {viewing.kind}
              </Tag>
              <PathText path={viewing.path} size={13} />
            </Space>
          )
        }
        destroyOnHidden
      >
        {viewing && <ArtifactViewer artifact={viewing} />}
      </Drawer>
    </div>
  )
}

function EventFeed({ events }: { events: WbEvent[] }) {
  if (events.length === 0) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        等待事件……(CLI / MCP 的任何操作会实时出现在这里)
      </Typography.Text>
    )
  }
  return (
    <div>
      {events.map(e => {
        const payload = e.payload ? (JSON.parse(e.payload) as Record<string, unknown>) : {}
        const coord = [e.module, e.endpoint, e.page].filter(Boolean).join("/")
        return (
          <Flex
            key={e.id}
            align="center"
            gap={10}
            className="wb-hover-row"
            style={{ padding: "5px 8px", minWidth: 0 }}
          >
            <span style={{ fontFamily: MONO, fontSize: 11, color: "rgba(255,255,255,0.32)", flexShrink: 0 }}>
              {e.created_at.slice(5, 19)}
            </span>
            <Tag bordered={false} color={eventColor(e.event)} style={{ margin: 0, fontSize: 11, flexShrink: 0 }}>
              {e.event}
            </Tag>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", flexShrink: 0 }}>{e.actor}</span>
            {e.event === "note" && (
              <span
                style={{
                  fontSize: 12,
                  color: "rgba(255,255,255,0.45)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {String(payload.content ?? "")}
              </span>
            )}
            {coord && (
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: MONO,
                  fontSize: 11,
                  color: "rgba(255,255,255,0.3)",
                  flexShrink: 0
                }}
              >
                {coord}
              </span>
            )}
          </Flex>
        )
      })}
    </div>
  )
}
