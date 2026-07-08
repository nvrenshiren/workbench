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
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  bucket: "skill-candidate" | "red-flag" | "observation"
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

export const ACTOR = "user"

export const api = {
  tree: (includeMeta: boolean) => get<TreeNode>(`/api/tree?includeMeta=${includeMeta ? 1 : 0}`),
  reviewQueue: () => get<Artifact[]>(`/api/review-queue`),
  skillCandidates: () => get<SkillCandidatesReport>(`/api/skill-candidates`),
  diff: (id: number) => get<{ approved: string | null; current: string | null }>(`/api/artifact/${id}/diff`),
  approve: (id: number, trivial = false) => post(`/api/artifact/${id}/approve`, { actor: ACTOR, trivial }),
  reject: (id: number, reason: string) => post(`/api/artifact/${id}/reject`, { actor: ACTOR, reason }),
  submit: (id: number) => post(`/api/artifact/${id}/submit`, { actor: ACTOR }),
  feedback: (id: number, verdict: 1 | -1, comment?: string) =>
    post(`/api/artifact/${id}/feedback`, { actor: ACTOR, verdict, comment }),
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
  rawUrl: (id: number) => `/api/artifact/${id}/raw`
}
