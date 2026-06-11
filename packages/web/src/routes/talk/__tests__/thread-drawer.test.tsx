import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { GraphNode } from "../graph-store"

// ---------------------------------------------------------------------------
// Module mocks — the drawer's data feeds are hook-shaped, so we mock the
// modules and mutate the hoisted holders per test.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  graph: [] as unknown[],
  chat: {
    messages: [] as unknown[],
    streamingText: "",
    loading: false,
    session: undefined as Record<string, unknown> | undefined,
    isInitialLoading: false,
    error: null as Error | null,
  },
}))

vi.mock("../use-session-chat", () => ({
  useSessionChat: () => mocks.chat,
}))

vi.mock("../talk-provider", () => ({
  useTalkContext: () => ({ orchestratorId: "orch", graph: mocks.graph }),
}))

// ChatMessages pulls the whole chat renderer (markdown, media, audio) — stub it.
vi.mock("@/components/chat/chat-messages", () => ({
  ChatMessages: () => <div data-testid="chat-messages" />,
}))

vi.mock("@/lib/api", () => ({
  api: { talkDelegate: vi.fn(), sendMessage: vi.fn() },
}))

import { ThreadDrawer } from "../thread-drawer"

const node = (over: Partial<GraphNode>): GraphNode => ({
  id: "t1",
  parentId: "root",
  depth: 1,
  label: "Lead",
  employee: null,
  status: "running",
  lastActivity: "2026-06-11T00:00:00Z",
  ...over,
})

/** root ← t1 (Lead) ← g1 (Analyst) — the talk root itself is NOT a graph node. */
const chainGraph = () => [
  node({ id: "t1", parentId: "root", depth: 1, label: "Lead" }),
  node({ id: "g1", parentId: "t1", depth: 2, label: "Analyst", status: "running" }),
]

beforeEach(() => {
  mocks.graph = []
  mocks.chat.messages = []
  mocks.chat.streamingText = ""
  mocks.chat.loading = false
  mocks.chat.session = undefined
  mocks.chat.isInitialLoading = false
  mocks.chat.error = null
  vi.clearAllMocks()
})

describe("ThreadDrawer", () => {
  it("renders the breadcrumb path from graph parent links", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByText("AURA")).toBeTruthy()
    // Ancestor crumb is a clickable button.
    expect(screen.getByRole("button", { name: "Lead" })).toBeTruthy()
    // Current crumb is emphasized, NOT a button.
    const current = screen.getByText("Analyst")
    expect(current.closest("button")).toBeNull()
  })

  it("ancestor crumb click navigates the drawer to that session", () => {
    mocks.graph = chainGraph()
    const onNavigate = vi.fn()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={onNavigate} />)
    fireEvent.click(screen.getByRole("button", { name: "Lead" }))
    expect(onNavigate).toHaveBeenCalledWith("t1")
  })

  it("lists sub-threads from childrenOf and descends on click", () => {
    mocks.graph = chainGraph()
    const onNavigate = vi.fn()
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={onNavigate} />)
    expect(screen.getByText("Sub-threads")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /open sub-thread: analyst/i }))
    expect(onNavigate).toHaveBeenCalledWith("g1")
  })

  it("renders no Sub-threads strip when the node has no children", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="g1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.queryByText("Sub-threads")).toBeNull()
  })

  it("Escape calls onClose", () => {
    mocks.graph = chainGraph()
    const onClose = vi.fn()
    render(<ThreadDrawer sessionId="t1" onClose={onClose} onNavigate={vi.fn()} />)
    fireEvent.keyDown(document, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("scrim click calls onClose", () => {
    mocks.graph = chainGraph()
    const onClose = vi.fn()
    const { container } = render(
      <ThreadDrawer sessionId="t1" onClose={onClose} onNavigate={vi.fn()} />,
    )
    const scrim = container.querySelector(".tdrawer-scrim")
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim!)
    expect(onClose).toHaveBeenCalled()
  })

  it("shows plain Attach buttons when the session is not attached", () => {
    mocks.graph = chainGraph()
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Attach" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Attach + engage" })).toBeTruthy()
    expect(screen.queryByLabelText("Message this session")).toBeNull()
  })

  it("shows the engage composer only when attached in engage mode", () => {
    mocks.graph = [node({ id: "t1", attached: true, mode: "engage" })]
    render(<ThreadDrawer sessionId="t1" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByLabelText("Message this session")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Detach" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Attach + engage" })).toBeNull()
  })

  it("falls back to AURA ▸ header label when the node left the graph", () => {
    mocks.graph = []
    mocks.chat.session = { title: "Old Thread" }
    render(<ThreadDrawer sessionId="zz" onClose={vi.fn()} onNavigate={vi.fn()} />)
    expect(screen.getByText("AURA")).toBeTruthy()
    const current = screen.getByText("Old Thread")
    expect(current.closest("button")).toBeNull()
  })

  it("renders nothing while closed (sessionId null)", () => {
    const { container } = render(
      <ThreadDrawer sessionId={null} onClose={vi.fn()} onNavigate={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
