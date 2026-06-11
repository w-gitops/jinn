import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { WorkTree, type WorkTreeProps } from "../work-tree"
import { MAX_DOCK_NODES, type DockSideMap } from "../work-dock-layout"
import type { GraphNode } from "../graph-store"
import type { ActivityMap } from "../thread-activity"

/** depth-1 node helper (defaults to an idle, owned COO node). */
const d1 = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  parentId: "root",
  depth: 1,
  label: id,
  employee: null,
  status: "idle",
  lastActivity: "2026-06-10T00:00:00Z",
  ...over,
})

/** depth-2+ descendant helper. */
const sub = (id: string, parentId: string, depth: number, over: Partial<GraphNode> = {}): GraphNode => ({
  id,
  parentId,
  depth,
  label: id,
  employee: null,
  status: "idle",
  lastActivity: "2026-06-10T00:00:00Z",
  ...over,
})

const at = (n: number) => new Date(2026, 5, 10, 0, 0, n).toISOString()

/** A 3-deep delegation tree: lead → analyst → runner. */
const tree = (): GraphNode[] => [
  d1("t1", { label: "Movekit Lead", status: "running", lastActivity: at(9) }),
  sub("g1", "t1", 2, { label: "Funnel Analyst", status: "running" }),
  sub("gg1", "g1", 3, { label: "Query Runner", status: "idle" }),
]

function renderTree(over: Partial<WorkTreeProps> = {}) {
  const props: WorkTreeProps = {
    graph: tree(),
    sideState: new Map() as DockSideMap,
    activity: new Map() as ActivityMap,
    targetThreadId: null,
    onOpenThread: vi.fn(),
    onSelectTarget: vi.fn(),
    onRename: vi.fn(),
    onDismiss: vi.fn(),
    idle: false,
    ...over,
  }
  return { ...render(<WorkTree {...props} />), props }
}

describe("WorkTree — hierarchy rendering", () => {
  it("renders depth-2 AND depth-3 descendants as labeled rows (no anonymous dots)", () => {
    renderTree()
    expect(screen.getByText("Funnel Analyst")).toBeTruthy()
    expect(screen.getByText("Query Runner")).toBeTruthy()
  })

  it("indents sub-rows by depth relative to their root (clamped 1..3)", () => {
    const { container } = renderTree()
    const rows = container.querySelectorAll(".wt__item--sub")
    expect(rows).toHaveLength(2)
    expect((rows[0] as HTMLElement).style.getPropertyValue("--wt-indent")).toBe("1")
    expect((rows[1] as HTMLElement).style.getPropertyValue("--wt-indent")).toBe("2")
  })

  it("a working sub-row shows its live activity line", () => {
    renderTree({ activity: new Map([["g1", { activity: "reading…" }]]) })
    expect(screen.getByText("reading…")).toBeTruthy()
  })

  it("an idle sub-row shows NO live line even when activity lingers in the map", () => {
    renderTree({ activity: new Map([["gg1", { activity: "editing…" }]]) })
    expect(screen.queryByText("editing…")).toBeNull()
  })

  it("the root row shows its live line when the root node is working", () => {
    renderTree({ activity: new Map([["t1", { activity: "delegating…" }]]) })
    expect(screen.getByText("delegating…")).toBeTruthy()
  })

  it("clicking a grandchild (depth-3) row opens that thread", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("listitem", { name: /query runner/i }))
    expect(props.onOpenThread).toHaveBeenCalledWith("gg1")
  })

  it("sub-rows have no ⋯ menu button (only roots do)", () => {
    renderTree()
    expect(screen.getAllByRole("button", { name: /actions for/i })).toHaveLength(1)
  })

  it("sub-row aria-labels carry the label and status", () => {
    renderTree()
    expect(screen.getByRole("listitem", { name: "Open thread: Funnel Analyst — working" })).toBeTruthy()
  })

  it("rail is a list; every row is a listitem", () => {
    renderTree()
    const list = screen.getByRole("list")
    expect(list).toBeTruthy()
    // 1 root + 2 sub-rows
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
  })

  it("staggers row entrances via a per-row --wt-i index", () => {
    const { container } = renderTree()
    const items = container.querySelectorAll(".wt__item")
    expect((items[0] as HTMLElement).style.getPropertyValue("--wt-i")).toBe("0")
    expect((items[1] as HTMLElement).style.getPropertyValue("--wt-i")).toBe("1")
    expect((items[2] as HTMLElement).style.getPropertyValue("--wt-i")).toBe("2")
  })

  it("renders nothing when there are no depth-1 nodes", () => {
    const { container } = renderTree({ graph: [] })
    expect(container.firstChild).toBeNull()
  })
})

describe("WorkTree — ported dock behaviors", () => {
  it("orders roots working-first", () => {
    const { container } = renderTree({
      graph: [
        d1("idle-1", { label: "Idle One", status: "idle", lastActivity: at(9) }),
        d1("busy-1", { label: "Busy One", status: "running", lastActivity: at(1) }),
      ],
    })
    const labels = Array.from(container.querySelectorAll(".wt__label")).map((b) => b.textContent)
    expect(labels).toEqual(["Busy One", "Idle One"])
  })

  it("opens the root thread from its label button", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("button", { name: "Open thread: Movekit Lead — working" }))
    expect(props.onOpenThread).toHaveBeenCalledWith("t1")
  })

  it("excludes dismissed (tombstoned) roots and their sub-rows", () => {
    renderTree({ sideState: new Map([["t1", { dismissed: true }]]) })
    expect(screen.queryByText("Movekit Lead")).toBeNull()
    expect(screen.queryByText("Funnel Analyst")).toBeNull()
  })

  it("caps roots at MAX_DOCK_NODES and shows the overflow count", () => {
    const graph = Array.from({ length: MAX_DOCK_NODES + 2 }, (_, i) =>
      d1(`x${i}`, { lastActivity: at(i) }),
    )
    renderTree({ graph })
    expect(screen.getByText("+2")).toBeTruthy()
  })

  it("renders the attached (soft-link) dashed-ring dot variant", () => {
    const { container } = renderTree({
      graph: [d1("a1", { label: "Watched", attached: true, status: "running" })],
    })
    expect(container.querySelector(".wt__dot--attached")).toBeTruthy()
  })

  it("shows the pin icon on the route-target row", () => {
    const { container } = renderTree({ targetThreadId: "t1" })
    expect(screen.getByLabelText("Route target")).toBeTruthy()
    expect(container.querySelector('.wt__item[data-pinned="true"]')).toBeTruthy()
  })

  it("pins as route target via the ⋯ menu", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("button", { name: /actions for movekit lead/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /pin as route target/i }))
    expect(props.onSelectTarget).toHaveBeenCalledWith("t1")
  })

  it("unpins via the ⋯ menu when already pinned", () => {
    const { props } = renderTree({ targetThreadId: "t1" })
    fireEvent.click(screen.getByRole("button", { name: /actions for movekit lead/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /unpin route target/i }))
    expect(props.onSelectTarget).toHaveBeenCalledWith(null)
  })

  it("renames inline: menu → Rename → edit → Enter commits", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("button", { name: /actions for movekit lead/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }))
    const input = screen.getByLabelText("Rename thread") as HTMLInputElement
    expect(input.value).toBe("Movekit Lead")
    fireEvent.change(input, { target: { value: "Funnel audit" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.onRename).toHaveBeenCalledWith("t1", "Funnel audit")
  })

  it("Escape cancels a rename without committing", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("button", { name: /actions for movekit lead/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }))
    const input = screen.getByLabelText("Rename thread")
    fireEvent.change(input, { target: { value: "Nope" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(props.onRename).not.toHaveBeenCalled()
    expect(screen.queryByLabelText("Rename thread")).toBeNull()
  })

  it("a user rename override wins over the server label", () => {
    renderTree({ sideState: new Map([["t1", { labelOverride: "My audit" }]]) })
    expect(screen.getByText("My audit")).toBeTruthy()
    expect(screen.queryByText("Movekit Lead")).toBeNull()
  })

  it("dismisses via the ⋯ menu", () => {
    const { props } = renderTree()
    fireEvent.click(screen.getByRole("button", { name: /actions for movekit lead/i }))
    fireEvent.click(screen.getByRole("menuitem", { name: /dismiss/i }))
    expect(props.onDismiss).toHaveBeenCalledWith("t1")
  })
})

describe("WorkTree — collapse", () => {
  it("collapses to dots when idle and nothing is working anywhere", () => {
    const { container } = renderTree({
      graph: [d1("t1", { label: "Lead", status: "idle" }), sub("g1", "t1", 2, { status: "idle" })],
      idle: true,
    })
    expect(container.querySelector(".wt")?.getAttribute("data-collapsed")).toBe("true")
  })

  it("stays expanded while a root is working, even when the conversation is idle", () => {
    const { container } = renderTree({ idle: true }) // tree() root is running
    expect(container.querySelector(".wt")?.getAttribute("data-collapsed")).toBe("false")
  })

  it("stays expanded while only a DEEP descendant is working", () => {
    const { container } = renderTree({
      graph: [
        d1("t1", { label: "Lead", status: "idle" }),
        sub("g1", "t1", 2, { status: "idle" }),
        sub("gg1", "g1", 3, { status: "running" }),
      ],
      idle: true,
    })
    expect(container.querySelector(".wt")?.getAttribute("data-collapsed")).toBe("false")
  })

  it("does not collapse while the conversation is active", () => {
    const { container } = renderTree({
      graph: [d1("t1", { label: "Lead", status: "idle" })],
      idle: false,
    })
    expect(container.querySelector(".wt")?.getAttribute("data-collapsed")).toBe("false")
  })
})
