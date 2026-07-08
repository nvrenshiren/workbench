import { Badge, Button, Flex, Layout, Space, Switch, Tooltip, Tree, Typography, message } from "antd"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, type TreeNode, type WbEvent } from "./api"
import { NodePanel } from "./NodePanel"
import { ReviewQueue } from "./ReviewQueue"
import { SkillCandidates } from "./SkillCandidates"
import { ACCENT, MONO, SURFACE } from "./ui"

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
      <Flex align="center" gap={7} style={{ paddingRight: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            flexShrink: 0,
            background: HEALTH_COLOR[n.health],
            boxShadow: n.health !== "ok" ? `0 0 6px ${HEALTH_COLOR[n.health]}` : "none"
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
        <Flex align="center" gap={6} style={{ marginLeft: "auto", flexShrink: 0 }}>
          {n.health !== "ok" && (
            <span style={{ fontSize: 10, color: HEALTH_COLOR[n.health] }}>{n.health}</span>
          )}
          {done && (
            <span
              style={{
                fontSize: 11,
                fontFamily: MONO,
                color: "rgba(255,255,255,0.38)",
                background: "rgba(255,255,255,0.06)",
                borderRadius: 8,
                padding: "0 6px",
                lineHeight: "16px"
              }}
            >
              {done}
            </span>
          )}
        </Flex>
      </Flex>
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
  const [skillCount, setSkillCount] = useState(0)
  const [skillOpen, setSkillOpen] = useState(false)
  const refreshTimer = useRef<number | null>(null)
  const prevSkill = useRef(-1) // -1 = 首次加载,不弹提醒;之后仅在计数增长时提醒

  const loadTree = useCallback(async (meta: boolean) => {
    setTree(await api.tree(meta))
    api.reviewQueue().then(q => setQueueCount(q.length))
    api.skillCandidates().then(r => {
      const n = r.candidates + r.redFlags
      if (prevSkill.current >= 0 && n > prevSkill.current) {
        message.info(`反馈提炼出 ${r.candidates} 个 skill 候选 / ${r.redFlags} 个 red-flag,见「经验提炼」`)
      }
      prevSkill.current = n
      setSkillCount(n)
    })
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
      <Layout.Header
        style={{
          height: 52,
          lineHeight: "52px",
          padding: "0 20px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: `linear-gradient(180deg, ${SURFACE.raised} 0%, ${SURFACE.panel} 100%)`,
          borderBottom: `1px solid ${SURFACE.line}`
        }}
      >
        <svg width="22" height="22" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
          <rect width="32" height="32" rx="7" fill={SURFACE.canvas} />
          <path
            d="M8 10l3.2 12L16 12l4.8 10L24 10"
            stroke={ACCENT}
            strokeWidth="2.6"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <Typography.Text strong style={{ fontSize: 15, letterSpacing: -0.2 }}>
          Workbench
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          spec-anchored 执行层
        </Typography.Text>
        <span style={{ flex: 1 }} />
        <Space size={16}>
          <Tooltip title="在树中显示 agent 定义 / skill / PLAN 等元产物">
            <Space size={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                元产物
              </Typography.Text>
              <Switch size="small" checked={includeMeta} onChange={setIncludeMeta} />
            </Space>
          </Tooltip>
          <Button size="small" onClick={runSync}>
            Sync 对账
          </Button>
          <Badge count={skillCount} size="small" offset={[-2, 2]} color="#722ed1">
            <Button size="small" onClick={() => setSkillOpen(true)}>
              经验提炼
            </Button>
          </Badge>
          <Badge count={queueCount} size="small" offset={[-2, 2]}>
            <Button size="small" type="primary" onClick={() => setQueueOpen(true)}>
              待审队列
            </Button>
          </Badge>
        </Space>
      </Layout.Header>
      <Layout style={{ flex: 1, minHeight: 0 }}>
        <Layout.Sider
          width={312}
          theme="light"
          style={{ borderRight: `1px solid ${SURFACE.line}`, overflow: "auto", background: SURFACE.panel }}
        >
          <div style={{ padding: "10px 12px 4px", fontSize: 11, letterSpacing: 1, color: "rgba(255,255,255,0.35)" }}>
            项目结构
          </div>
          <Tree
            treeData={antTree}
            defaultExpandedKeys={["__root__"]}
            onSelect={(_, info) => setSelected((info.node as unknown as AntNode).node)}
            style={{ padding: "0 8px 12px", background: "transparent" }}
            blockNode
          />
        </Layout.Sider>
        <Layout.Content style={{ overflow: "auto", background: SURFACE.canvas }}>
          <NodePanel node={selected} liveEvents={liveEvents} onOpenQueue={() => setQueueOpen(true)} queueCount={queueCount} />
        </Layout.Content>
      </Layout>
      <ReviewQueue open={queueOpen} onClose={() => setQueueOpen(false)} onActed={() => loadTree(includeMeta)} />
      <SkillCandidates open={skillOpen} onClose={() => setSkillOpen(false)} />
    </Layout>
  )
}
