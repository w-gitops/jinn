# Chat redesign — focused sidebar + frosted-pill header

Branch: `chat-focus-pills` (off `main`). NOTHING merged/deployed until approved.
Mockups: `/tmp/jinn-mockups/` (sidebar = Variant A, flat Today/Yesterday).

## Workstreams
1. **Focused sidebar** (priority — report first) — flat Today/Yesterday recency list.
2. **Transparent header → frosted pills** — after sidebar approval.

---

## Data-layer finding (verified in source)

`GET /api/sessions` (default, no params) → `listRecentPerGroup(50, portalSlug)` in
`packages/jinn/src/sessions/registry.ts:780`:
- The **50 most-recent sessions per group** (each employee + `__direct__` + `__cron__`),
  globally ordered by `last_activity DESC`.
- Plus a `counts` map = **true total per group** (used today for "+N more").
- The web hook comment (`use-sessions.ts`) saying "top-N = 8" is **stale** — server
  const is `SESSION_LIST_PER_GROUP = 50` (`gateway/api.ts:83`).

**Conclusion: no backend change needed for Today/Yesterday.**
50 recent/group reliably captures every today+yesterday chat (an employee would need
>50 chats in a *single day* to drop one — not realistic). Today/Yesterday buckets are
built from the loaded payload; the "Older" summary count uses the authoritative
`counts` totals, so it's exact even though the deep tail isn't all loaded.
- Edge limit (documented, accepted): if one employee had >50 chats in a day, the
  oldest of that day wouldn't appear until "Older" is expanded. Vanishingly rare.
- Search already spans ALL sessions server-side (`searchSessions`, `?q=`), unchanged.

## Sidebar design decisions
- **Variant A**: flat, recency-sectioned. One row per *session* (not per employee).
  Row = avatar (+status dot) + employee name + time (line 1), chat title (line 2),
  pin icon if pinned.
- Sections: **Today**, **Yesterday** (local-midnight boundaries).
- **Older** collapses to one line: "Older · N chats across M employees", expands
  **in place** to the EXISTING per-employee grouped list (EmployeeRow + per-group
  "load more") — reuses tested code, preserves full access to old sessions (no data
  loss), and the task explicitly allows "keep the old grouping" for Older.
- **Scheduled** (cron) section: unchanged.
- **Team** (contactable, session-less) footer: unchanged.
- Search mode: flat results, no sections (search spans everything).
- Virtualization preserved via a unified `VirtualItem[]` (section headers + flat
  rows + employee rows + cron + older-line).
- **Pinned**: kept in context menu; pinned sessions show a pin marker in their day
  bucket; Older-expanded keeps pinned-employee float. No separate "Pinned" section
  (avoid scope creep) — open question to confirm.

## Files touched
- `packages/web/src/components/chat/chat-route-helpers.ts` — add `bucketByDay` date helper.
- `packages/web/src/components/chat/__tests__/chat-sidebar-helpers.test.ts` — bucketing tests.
- `packages/web/src/components/chat/chat-sidebar.tsx` — focused layout.
- (header phase, later) `page-layout.tsx`, `chat-tabs.tsx`, `routes/chat/page.tsx`.

## Resolved questions
- Pinned: CONFIRMED — pin-marker-in-bucket, NO separate Pinned section (per reviewer).
- Helpers: `bucketByDay` / `startOfLocalDay` / `summarizeOlder` live in
  chat-route-helpers.ts (shared with a parallel session, now reconciled — single
  definition, no duplication). use-sessions.ts comment fixed (top-N 8 → 50).

## What changed (sidebar phase)
- `chat-route-helpers.ts`: `bucketByDay`, `startOfLocalDay`, `summarizeOlder` (pure).
- `chat-route-helpers.test.ts`: 26 tests (bucketing + older summary, DST/month edges).
- `chat-sidebar.tsx`:
  - New `FlatSessionRow` (two-line: avatar+dot, name+time / chat title) — one row
    per chat for Today/Yesterday/search.
  - Grouping useMemo rewritten: buckets non-cron sessions into Today/Yesterday flat
    rows; tallies `recentByGroup`; computes the Older summary from authoritative
    `counts`; derives the Older drawer's per-employee groups (only groups with
    older chats).
  - `olderExpanded` state (localStorage-persisted). Collapsed → one summary line;
    expanded → existing EmployeeRow drawer (load-more preserved).
  - Unified `VirtualItem[]` (section | flat | older-line | older-header | employee
    | cron-*), single `renderItem()` shared by virtualized + plain paths.
  - Keyboard nav order + delete-next-selection updated to the new visible order
    (de-duped). Cron "Scheduled" + Team footer + search (spans all) unchanged.
- `use-sessions.ts`: stale PER_GROUP comment corrected (8 → 50).

## Verification
- `pnpm --filter @jinn/web typecheck` — clean.
- web tests — 457 passed (41 files), incl. 26 helper tests.
- Screenshots in /tmp/chat-redesign/: desktop.png, desktop-tall.png,
  sidebar-crop.png (Today/Yesterday/Older line/Scheduled), desktop-older-expanded.png
  + older-expanded-crop.png (Older drawer), mobile-sidebar.png (390, edge-to-edge).
- Live data via `pnpm --filter @jinn/web dev --port 5199` (proxies API→7777).

## Status
- [x] data-layer investigation (no backend change needed)
- [x] date-bucketing helper + tests
- [x] focused sidebar layout
- [x] preview screenshots (desktop 1440 + mobile 390)
- [ ] report → STOP for review  ← HERE
- [ ] header pills (after approval)
