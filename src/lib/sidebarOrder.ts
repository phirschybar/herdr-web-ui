/**
 * The sidebar's Activity order and its unseen marks, as herdr's own sidebar does them: the
 * agents panel under `agent_panel_sort = "priority"` puts what needs you and what just changed
 * on top, and a done agent stays marked until it is viewed.
 *
 * Recency is herdr's `state_change_seq`, one counter for the session bumped on every agent state
 * change. `session.snapshot` leaves it off `panes` and carries it on `agents`, so it is read there.
 *
 * "Seen" is kept per browser and per PC: the `state_change_seq` each pane had when it was last on
 * screen. A done pane whose counter moved past that is unseen. Opening a pane in the web UI does
 * not tell herdr, so herdr's own done/idle flip is not used.
 */
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { knownStatus, rollupStatus } from "./status.ts";

/** pane id → the `state_change_seq` it had when last viewed */
export type SeenRecord = Readonly<Record<string, number>>;

/** Each agent pane's `state_change_seq`. Panes without an agent have none. */
export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = (agent as { state_change_seq?: unknown }).state_change_seq;
    if (typeof seq === "number" && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

/** A pane that finished after it was last viewed. A pane with no counter is never unseen. */
export function isUnseenDone(pane: Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>, seen: SeenRecord): boolean {
  if (knownStatus(pane.agent_status) !== "done") return false;
  const seq = seqs.get(pane.pane_id);
  return seq !== undefined && seq > (seen[pane.pane_id] ?? -1);
}

/** The first record on a browser: everything open now counts as seen, so turning marks on does not light every done row. */
export function seedSeen(panes: readonly Pick<PaneInfo, "pane_id">[], seqs: ReadonlyMap<string, number>): SeenRecord {
  const record: Record<string, number> = {};
  for (const pane of panes) {
    const seq = seqs.get(pane.pane_id);
    if (seq !== undefined) record[pane.pane_id] = seq;
  }
  return record;
}

/** The record with `paneId` seen at `seq`; the same object when nothing changes, so state does not churn. */
export function markSeen(record: SeenRecord, paneId: string, seq: number): SeenRecord {
  return record[paneId] === seq ? record : { ...record, [paneId]: seq };
}

/** The record without panes that closed; the same object when none did. An empty roster keeps it (herdr restarting). */
export function pruneSeen(record: SeenRecord, panes: readonly Pick<PaneInfo, "pane_id">[]): SeenRecord {
  if (panes.length === 0) return record;
  const open = new Set(panes.map((pane) => pane.pane_id));
  const gone = Object.keys(record).filter((id) => !open.has(id));
  if (gone.length === 0) return record;
  const next: Record<string, number> = { ...record };
  for (const id of gone) delete next[id];
  return next;
}

/** 0 blocked, 1 finished and not yet viewed, 2 working, 3 the rest */
function activityRank(panes: readonly PaneInfo[], unseen: ReadonlySet<string>): number {
  const state = rollupStatus(panes.map((pane) => pane.agent_status));
  if (state === "blocked") return 0;
  if (panes.some((pane) => unseen.has(pane.pane_id))) return 1;
  if (state === "working") return 2;
  return 3;
}

/**
 * Workspaces in Activity order: by rank, then the most recent state change among their panes,
 * then herdr's own order. `unseen` holds the panes that rank as "finished, not yet viewed": with
 * marks off the caller passes every done pane, as herdr ranks done above idle.
 */
export function activityOrder(workspaces: readonly WorkspaceInfo[], panes: readonly PaneInfo[], seqs: ReadonlyMap<string, number>, unseen: ReadonlySet<string>): WorkspaceInfo[] {
  const keyed = workspaces.map((workspace, index) => {
    const own = panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const recent = Math.max(-1, ...own.map((pane) => seqs.get(pane.pane_id) ?? -1));
    return { workspace, index, rank: activityRank(own, unseen), recent };
  });
  keyed.sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index);
  return keyed.map((entry) => entry.workspace);
}

const seenKey = (machineId: string) => `herdr-web-ui:seen:${machineId}`;

/** This browser's record for a PC, or null when it has none yet. */
export function loadSeen(machineId: string): SeenRecord | null {
  try {
    const raw = localStorage.getItem(seenKey(machineId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
  } catch {
    return null;
  }
}

export function saveSeen(machineId: string, record: SeenRecord): void {
  try { localStorage.setItem(seenKey(machineId), JSON.stringify(record)); } catch { /* storage blocked: marks last for this page only */ }
}
