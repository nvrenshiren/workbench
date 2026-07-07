import { Badge, Button, Layout, Space, Switch, Tag, Tree, Typography, message } from "antd"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, type TreeNode, type WbEvent } from "./api"
import { NodePanel } from "./NodePanel"
import { ReviewQueue } from "./ReviewQueue"

const HEALTH_COLOR: Record<string, string> = {
  ok: "#52c41a",
  stale: "#faad14",
  blocked: "#722ed1",
  failed: "#f5222d"
}

interface AntNode {
  key: string
  title: React.ReactNode
  children?: AntNode[]
  node: TreeNode
}

function toAntNode(n: TreeNode): AntNode {
  const done = n.counts.tasksTotal > 0 ? `${n.counts.tasksDone}/${n.counts.tasksTotal}` : null
  return {
    key: n.key,
    node: n,
    title: (
      <Space size={6}>
        <Badge color={HEALTH_COLOR[n.health]} />
        <span>{n.title}</span>
        {done && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {done}
          </Typography.Text>
        )}
        {n.health !== "ok" && (
          <Tag color={HEALTH_COLOR[n.health]} style={{ fontSize: 10, lineHeight: "16px", padding: "0 4px" }}>
            {n.health}
          </Tag>
        )}
      </Space>
    ),
    children: n.children.length > 0 ? n.children.map(toAntNode) : undefined
  }
}

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [includeMeta, setIncludeMeta] = useState(false)
  const [selected, setSelected] = useState<TreeNode | null>(null)
  const [liveEvents, setLiveEvents] = useState<WbEvent[]>([])
  const [queueCount, setQueueCount] = useState(0)
  const [queueOpen, setQueueOpen] = useState(false)
  const refreshTimer = useRef<number | null>(null)

  const loadTree = useCallback(async (meta: boolean) => {
    setTree(await api.tree(meta))
    api.reviewQueue().then(q => setQueueCount(q.length))
  }, [])

  useEffect(() => {
    loadTree(includeMeta)
  }, [includeMeta, loadTree])

  const runSync = async () => {
    const s = await api.sync()
    message.info(`对账完成:变更 ${s.changed},失效 ${s.invalidated},派 review ${s.reviewsSpawned}`)
    loadTree(includeMeta)
  }

  // SSE:事件到达 → 300ms 去抖后刷新树(500ms 服务端轮询 + 去抖 ≈ 秒级可见)
  useEffect(() => {
    const source = new EventSource("/api/sse")
    source.onmessage = evt => {
      const rows = JSON.parse(evt.data) as WbEvent[]
      setLiveEvents(prev => [...rows.reverse(), ...prev].slice(0, 50))
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(() => loadTree(includeMeta), 300)
    }
    return () => {
      // 残留的去抖定时器持有旧 includeMeta 闭包,不清会用旧视图覆盖新树
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current)
      source.close()
    }
  }, [includeMeta, loadTree])

  const antTree = useMemo(() => (tree ? [toAntNode(tree)] : []), [tree])

  return (
    <Layout style={{ height: "100%" }}>
      <Layout.Sider width={340} theme="light" style={{ borderRight: "1px solid #303030", overflow: "auto" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #303030", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography.Text strong>Workbench</Typography.Text>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              元产物
            </Typography.Text>
            <Switch size="small" checked={includeMeta} onChange={setIncludeMeta} />
          </Space>
        </div>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #303030" }}>
          <Space>
            <Badge count={queueCount} size="small">
              <Button size="small" onClick={() => setQueueOpen(true)}>
                待审队列
              </Button>
            </Badge>
            <Button size="small" onClick={runSync}>
              Sync 对账
            </Button>
          </Space>
        </div>
        <Tree
          treeData={antTree}
          defaultExpandedKeys={["__root__"]}
          onSelect={(_, info) => setSelected((info.node as unknown as AntNode).node)}
          style={{ padding: 8 }}
          blockNode
        />
      </Layout.Sider>
      <Layout.Content style={{ overflow: "auto", background: "#141414" }}>
        <NodePanel node={selected} liveEvents={liveEvents} />
      </Layout.Content>
      <ReviewQueue open={queueOpen} onClose={() => setQueueOpen(false)} onActed={() => loadTree(includeMeta)} />
    </Layout>
  )
}
