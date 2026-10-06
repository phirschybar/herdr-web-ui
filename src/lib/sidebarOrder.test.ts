import { describe, expect, it } from "bun:test";

import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { activityOrder, isUnseenDone, markSeen, pruneSeen, seedSeen, stateSeqs } from "./sidebarOrder.ts";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.ts";

const workspace = (id: string) => ({ workspace_id: id, label: id }) as WorkspaceInfo;
const pane = (id: string, workspaceId: string, agent_status: string) => ({ pane_id: id, workspace_id: workspaceId, agent_status }) as PaneInfo;
const ids = (list: WorkspaceInfo[]) => list.map((entry) => entry.workspace_id);

describe("state_change_seq", () => {
  it("is read from the snapshot's agents, the only place session.snapshot carries it", () => {
    const seqs = stateSeqs({ agents: [{ pane_id: "a", state_change_seq: 7 }, { pane_id: "b" }, { pane_id: "c", state_change_seq: "9" }] } as never);
    expect([...seqs]).toEqual([["a", 7]]);
    expect(stateSeqs(null).size).toBe(0);
  });
});

describe("activity order", () => {
  const workspaces = ["idle", "working", "blocked", "done-old", "done-new", "shell"].map(workspace);
  const panes = [pane("p-idle", "idle", "idle"), pane("p-working", "working", "working"), pane("p-blocked", "blocked", "blocked"),
    pane("p-done-old", "done-old", "done"), pane("p-done-new", "done-new", "done"), pane("p-shell", "shell", "unknown")];
  const seqs = new Map([["p-idle", 50], ["p-working", 10], ["p-blocked", 1], ["p-done-old", 20], ["p-done-new", 30]]);

  it("ranks blocked, then unseen done, then working, then the rest, the latest change first within each", () => {
    expect(ids(activityOrder(workspaces, panes, seqs, new Set(["p-done-old", "p-done-new"]))))
      .toEqual(["blocked", "done-new", "done-old", "working", "idle", "shell"]);
  });

  it("drops a done pane already viewed to the rest, ordered by its change", () => {
    expect(ids(activityOrder(workspaces, panes, seqs, new Set(["p-done-old"]))))
      .toEqual(["blocked", "done-old", "working", "idle", "done-new", "shell"]);
  });

  it("puts a new workspace first among its rank, and keeps herdr's order between equals", () => {
    const fresh = [...panes, pane("p-new", "new", "idle"), pane("p-tie", "tie", "idle")];
    const order = activityOrder([...workspaces, workspace("new"), workspace("tie")], fresh, new Map([...seqs, ["p-new", 99]]), new Set());
    expect(ids(order).slice(0, 3)).toEqual(["blocked", "working", "new"]);
    // no counter at all: the shell and "tie" keep herdr's order at the end
    expect(ids(order).slice(-2)).toEqual(["shell", "tie"]);
  });

  it("ranks a workspace by its roll-up and its most recent pane", () => {
    const multi = [pane("x1", "multi", "idle"), pane("x2", "multi", "blocked"), pane("y1", "other", "working")];
    expect(ids(activityOrder([workspace("other"), workspace("multi")], multi, new Map([["x1", 5], ["x2", 1], ["y1", 9]]), new Set())))
      .toEqual(["multi", "other"]);
  });
});

describe("unseen marks", () => {
  const seqs = new Map([["a", 10], ["b", 12]]);

  it("marks a done pane whose state changed after it was last viewed", () => {
    expect(isUnseenDone(pane("a", "w", "done"), seqs, { a: 9 })).toBe(true);
    expect(isUnseenDone(pane("a", "w", "done"), seqs, { a: 10 })).toBe(false);
    expect(isUnseenDone(pane("a", "w", "idle"), seqs, {})).toBe(false);
    // a pane opened after the record was seeded has no entry: its finish is unseen
    expect(isUnseenDone(pane("b", "w", "done"), seqs, {})).toBe(true);
    // no counter (a shell): never marked
    expect(isUnseenDone(pane("c", "w", "done"), seqs, {})).toBe(false);
  });

  it("seeds a first record as all seen, so turning marks on lights nothing", () => {
    const seeded = seedSeen([pane("a", "w", "done"), pane("b", "w", "done"), pane("c", "w", "idle")], seqs);
    expect(seeded).toEqual({ a: 10, b: 12 });
    expect(isUnseenDone(pane("a", "w", "done"), seqs, seeded)).toBe(false);
  });

  it("keeps the same record object when nothing changes, and forgets closed panes but not on an empty roster", () => {
    const record = { a: 10, gone: 3 };
    expect(markSeen(record, "a", 10)).toBe(record);
    expect(markSeen(record, "a", 11)).toEqual({ a: 11, gone: 3 });
    expect(pruneSeen(record, [pane("a", "w", "done")])).toEqual({ a: 10 });
    expect(pruneSeen({ a: 10 }, [pane("a", "w", "done")])).toEqual({ a: 10 });
    expect(pruneSeen(record, [])).toBe(record);
  });
});

it("defaults to herdr's order with no marks, and accepts only known values", () => {
  expect([DEFAULT_SETTINGS.sidebarOrder, DEFAULT_SETTINGS.unseenMarks]).toEqual(["workspace", false]);
  expect(sanitizeSettings({ sidebarOrder: "activity", unseenMarks: true })).toMatchObject({ sidebarOrder: "activity", unseenMarks: true });
  expect(sanitizeSettings({ sidebarOrder: "recent", unseenMarks: "yes" })).toMatchObject({ sidebarOrder: "workspace", unseenMarks: false });
});
