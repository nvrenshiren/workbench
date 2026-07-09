export interface TreeNode {
  key: string
  title: string
  level: "project" | "module" | "endpoint" | "page"
  module: string | null
  endpoint: string | null
  page: string | null
  health: "ok" | "stale" | "blocked" | "failed"
  phase: string
  counts: { artifacts: number; tasksDone: number; tasksTotal: number }
  children: TreeNode[]
}

export interface Artifact {
  id: number
  kind: string
  module: string | null
  endpoint: string | null
  page: string | null
  path: string
  content_hash: string
  approved_hash: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_status: "draft" | "pending" | "approved" | "invalidated"
  ever_approved: boolean
  endorsed: boolean
}

export interface Task {
  id: number
  module: string | null
  role: string
  endpoint: string | null
  page: string | null
  type: string
  status: string
  assignee: string | null
  creator: string
  content: string | null
  stale: boolean
  created_at: string
  updated_at: string
}

export interface WbEvent {
  id: number
  entity_type: string
  entity_id: number
  event: string
  actor: string
  payload: string | null
  module: string | null
  endpoint: string | null
  page: string | null
  created_at: string
}

export interface ArtifactDetail {
  artifact: Artifact
  content: string | null
  isDirectory: boolean
  missing: boolean
  feedback: { id: number; verdict: number; comment: string | null; actor: string; created_at: string }[]
  events: WbEvent[]
  /** 原型预览地址(服务端由 kind 注册表推导;在原型根内才有)——单一真相源,前端勿自行拼路径 */
  previewUrl: string | null
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json() as Promise<T>
}

/** 写口令(服务端 config.server.authToken 启用写保护时需要);与 actor 身份分离 */
const TOKEN_KEY = "wb-token"
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}
export function setToken(v: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, v)
  } catch {
    /* 隐私模式静默降级 */
  }
}
function writeHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" }
  const t = getToken()
  if (t) h["x-workbench-token"] = t
  return h
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(body)
  })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `${url}: ${res.status}`)
  return data
}

export interface FeedbackEvidence {
  artifactId: number
  path: string
  module: string | null
  verdict: 1 | -1
  weight: number
  comment: string | null
  actor: string
  createdAt: string
}

export interface DistillGroup {
  endpoint: string
  kind: string
  posScore: number
  negScore: number
  bucket: "candidate" | "red-flag" | "observation"
  reason?: "mixed" | "insufficient"
  evidence: FeedbackEvidence[]
}

export interface SkillCandidatesReport {
  groups: DistillGroup[]
  candidates: number
  redFlags: number
  halfLifeDays: number
  guidance: string[]
}

export interface GraphNode {
  id: number
  kind: string
  path: string
  module: string | null
  endpoint: string | null
  page: string | null
  review_status: "draft" | "pending" | "approved" | "invalidated"
  missing: boolean
}

export interface GraphEdge {
  id: number
  from_id: number
  to_id: number
  source: "derived" | "manual"
}

/** 操作人身份:工作台头部可设置(localStorage 持久),多人共用一个工作台时区分是谁批的/谁反馈的 */
const ACTOR_KEY = "wb-actor"
export function getActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY)?.trim() || "user"
  } catch {
    return "user"
  }
}
export function setActor(name: string): void {
  try {
    localStorage.setItem(ACTOR_KEY, name.trim())
  } catch {
    /* 隐私模式等场景静默降级 */
  }
}

export const api = {
  tree: (includeMeta: boolean) => get<TreeNode>(`/api/tree?includeMeta=${includeMeta ? 1 : 0}`),
  reviewQueue: () => get<Artifact[]>(`/api/review-queue`),
  skillCandidates: () => get<SkillCandidatesReport>(`/api/skill-candidates`),
  diff: (id: number) => get<{ approved: string | null; current: string | null }>(`/api/artifact/${id}/diff`),
  approve: (id: number, trivial = false) => post(`/api/artifact/${id}/approve`, { actor: getActor(), trivial }),
  reject: (id: number, reason: string) => post(`/api/artifact/${id}/reject`, { actor: getActor(), reason }),
  submit: (id: number) => post(`/api/artifact/${id}/submit`, { actor: getActor() }),
  feedback: (id: number, verdict: 1 | -1, comment?: string) =>
    post(`/api/artifact/${id}/feedback`, { actor: getActor(), verdict, comment }),
  sync: () => post<{ checked: number; changed: number; invalidated: number; tombstoned: number; reviewsSpawned: number }>(`/api/sync`, {}),
  node: (q: { module?: string; endpoint?: string; page?: string }) => {
    const params = new URLSearchParams()
    if (q.module) params.set("module", q.module)
    if (q.endpoint) params.set("endpoint", q.endpoint)
    if (q.page) params.set("page", q.page)
    return get<{ artifacts: Artifact[]; tasks: Task[] }>(`/api/node?${params}`)
  },
  artifact: (id: number) => get<ArtifactDetail>(`/api/artifact/${id}`),
  files: (id: number) => get<{ files: { rel: string; size: number }[] }>(`/api/artifact/${id}/files`),
  file: (id: number, rel: string) => get<{ content: string }>(`/api/artifact/${id}/file?rel=${encodeURIComponent(rel)}`),
  events: (limit = 60) => get<WbEvent[]>(`/api/events?limit=${limit}`),
  // ─── 关系图 ───
  graph: () => get<{ nodes: GraphNode[]; edges: GraphEdge[] }>(`/api/graph`),
  searchFiles: (q: string) =>
    get<{ artifacts: { id: number; kind: string; path: string; review_status: string }[]; files: string[] }>(
      `/api/search?q=${encodeURIComponent(q)}`
    ),
  addEdge: (fromId: number, toId: number) => post<GraphEdge>(`/api/edge`, { fromId, toId, actor: getActor() }),
  removeEdge: async (id: number) => {
    const res = await fetch(`/api/edge/${id}`, {
      method: "DELETE",
      headers: writeHeaders(),
      body: JSON.stringify({ actor: getActor() })
    })
    if (!res.ok) {
      const data = (await res.json()) as { error?: string }
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
  },
  registerFile: (path: string) => post<{ id: number; path: string }>(`/api/artifact/register`, { path, actor: getActor() }),
  unregisterArtifact: async (id: number) => {
    const res = await fetch(`/api/artifact/${id}`, {
      method: "DELETE",
      headers: writeHeaders(),
      body: JSON.stringify({ actor: getActor() })
    })
    if (!res.ok) {
      const data = (await res.json()) as { error?: string }
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
  }
}
