import Editor from "@monaco-editor/react"
import { Alert, Button, Input, List, Modal, Radio, Space, Spin, Tag, Typography, message } from "antd"
import mermaid from "mermaid"
import { useEffect, useId, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { api, type Artifact, type ArtifactDetail } from "../api"

mermaid.initialize({ startOnLoad: false, theme: "dark" })

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  dart: "dart",
  less: "less",
  css: "css",
  html: "html",
  prisma: "graphql",
  yaml: "yaml",
  yml: "yaml"
}

function langOf(path: string): string {
  return LANG_BY_EXT[path.split(".").pop() ?? ""] ?? "plaintext"
}

function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "")
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    mermaid
      .render(`m${id}`, code)
      .then(({ svg }) => {
        if (ref.current) ref.current.innerHTML = svg
      })
      .catch(err => {
        if (ref.current) ref.current.innerText = `mermaid 渲染失败: ${err.message}`
      })
  }, [code, id])
  return <div ref={ref} />
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <div style={{ maxWidth: 900, lineHeight: 1.7 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1]
            if (lang === "mermaid") return <Mermaid code={String(children)} />
            return (
              <code className={className} {...props}>
                {children}
              </code>
            )
          },
          table: ({ children }) => (
            <table style={{ borderCollapse: "collapse", width: "100%" }} className="wb-md-table">
              {children}
            </table>
          ),
          th: ({ children }) => <th style={{ border: "1px solid #424242", padding: "6px 10px", background: "#1f1f1f" }}>{children}</th>,
          td: ({ children }) => <td style={{ border: "1px solid #424242", padding: "6px 10px" }}>{children}</td>
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

const VIEWPORTS = [
  { label: "375 (weapp/app)", value: 375 },
  { label: "768", value: 768 },
  { label: "1280 (admin/pc)", value: 1280 }
]

function PrototypeView({ artifact }: { artifact: Artifact }) {
  const [width, setWidth] = useState(artifact.endpoint === "admin" ? 1280 : 375)
  return (
    <div>
      <Radio.Group
        size="small"
        options={VIEWPORTS.map(v => ({ label: v.label, value: v.value }))}
        optionType="button"
        value={width}
        onChange={e => setWidth(e.target.value)}
        style={{ marginBottom: 12 }}
      />
      <div style={{ background: "#262626", padding: 16, display: "flex", justifyContent: "center" }}>
        <iframe
          src={api.rawUrl(artifact.id)}
          sandbox="allow-scripts"
          style={{ width, height: "70vh", border: "1px solid #424242", background: "#fff" }}
          title={artifact.path}
        />
      </div>
    </div>
  )
}

function CodeDirView({ artifact }: { artifact: Artifact }) {
  const [files, setFiles] = useState<{ rel: string; size: number }[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>("")

  useEffect(() => {
    api.files(artifact.id).then(d => {
      setFiles(d.files)
      if (d.files.length > 0) setSelected(d.files[0].rel)
    })
  }, [artifact.id])

  useEffect(() => {
    if (!selected) return
    api.file(artifact.id, selected).then(d => setContent(d.content))
  }, [artifact.id, selected])

  return (
    <div style={{ display: "flex", gap: 12, height: "72vh" }}>
      <List
        size="small"
        style={{ width: 300, overflow: "auto", borderRight: "1px solid #303030" }}
        dataSource={files}
        renderItem={f => (
          <List.Item
            style={{ cursor: "pointer", background: f.rel === selected ? "rgba(22,119,255,0.25)" : undefined, paddingLeft: 8 }}
            onClick={() => setSelected(f.rel)}
          >
            <Typography.Text style={{ fontSize: 12 }}>{f.rel}</Typography.Text>
          </List.Item>
        )}
      />
      <div style={{ flex: 1 }}>
        {selected && (
          <Editor
            height="100%"
            theme="vs-dark"
            language={langOf(selected)}
            value={content}
            options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }}
          />
        )}
      </div>
    </div>
  )
}

function Actions({ artifact, onDone }: { artifact: Artifact; onDone: () => void }) {
  const [negOpen, setNegOpen] = useState(false)
  const [negComment, setNegComment] = useState("")
  const act = async (fn: () => Promise<unknown>, label: string) => {
    try {
      await fn()
      message.success(label)
      onDone()
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }
  const isFeedbackKind = artifact.kind === "prototype" || artifact.kind === "code"
  return (
    <Space>
      {isFeedbackKind && (
        <>
          <Button size="small" onClick={() => act(() => api.feedback(artifact.id, 1), artifact.kind === "prototype" ? "👍 已放行" : "👍 已记录")}>
            👍
          </Button>
          <Button size="small" onClick={() => setNegOpen(true)}>
            👎
          </Button>
        </>
      )}
      {!isFeedbackKind && artifact.review_status === "draft" && (
        <Button size="small" onClick={() => act(() => api.submit(artifact.id), "已送审")}>
          送审
        </Button>
      )}
      {!isFeedbackKind && (artifact.review_status === "pending" || artifact.review_status === "invalidated") && (
        <Button size="small" type="primary" onClick={() => act(() => api.approve(artifact.id), "已审批通过")}>
          通过
        </Button>
      )}
      <Modal
        open={negOpen}
        title="👎 原因(必填,进反馈与进化管道)"
        onCancel={() => setNegOpen(false)}
        onOk={async () => {
          await act(() => api.feedback(artifact.id, -1, negComment), "👎 已记录")
          setNegOpen(false)
          setNegComment("")
        }}
      >
        <Input.TextArea rows={3} value={negComment} onChange={e => setNegComment(e.target.value)} />
      </Modal>
    </Space>
  )
}

export function ArtifactViewer({ artifact }: { artifact: Artifact }) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    setDetail(null)
    api.artifact(artifact.id).then(setDetail)
  }, [artifact.id, reloadKey])

  if (!detail) return <Spin style={{ display: "block", margin: "80px auto" }} />
  if (detail.missing) return <Alert type="warning" message={`文件已不在磁盘上: ${artifact.path}`} />

  let body: React.ReactNode
  if (detail.isDirectory) {
    body = <CodeDirView artifact={artifact} />
  } else if (artifact.kind === "prototype" || artifact.path.endsWith(".html")) {
    body = <PrototypeView artifact={artifact} />
  } else if (artifact.path.endsWith(".md")) {
    body = <MarkdownView content={detail.content ?? ""} />
  } else {
    body = (
      <Editor
        height="72vh"
        theme="vs-dark"
        language={langOf(artifact.path)}
        value={detail.content ?? ""}
        options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13 }}
      />
    )
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Tag>hash {artifact.content_hash.slice(0, 8)}</Tag>
        {artifact.approved_hash && <Tag color="green">approved {artifact.approved_hash.slice(0, 8)}</Tag>}
        {artifact.reviewed_by && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            审批人 {artifact.reviewed_by} @ {artifact.reviewed_at}
          </Typography.Text>
        )}
        {detail.feedback.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            反馈 {detail.feedback.filter(f => f.verdict > 0).length}👍 / {detail.feedback.filter(f => f.verdict < 0).length}👎
          </Typography.Text>
        )}
        <Actions artifact={artifact} onDone={() => setReloadKey(k => k + 1)} />
      </Space>
      {body}
    </div>
  )
}
