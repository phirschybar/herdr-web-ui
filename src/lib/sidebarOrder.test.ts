import { describe, expect, it } from "bun:test";

import type { PaneInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { activityOrder, isUnseenDone, liveSeqs, markSeen, newSeqMemory, pruneSeen, seedSeen, stateSeqs } from "./sidebarOrder.ts";
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

describe("live counters", () => {
  const snap = (statuses: Record<string, string>, seqs: Record<string, number>) => ({
    panes: Object.entries(statuses).map(([id, status]) => pane(id, `w-${id}`, status)),
    agents: Object.entries(seqs).map(([pane_id, state_change_seq]) => ({ pane_id, state_change_seq })),
  }) as never;

  it("dates a pushed status change above every known counter until herdr's own counter comes", () => {
    const memory = newSeqMemory();
    expect([...liveSeqs(snap({ a: "idle", b: "done" }, { a: 5, b: 9 }), memory)]).toEqual([["a", 5], ["b", 9]]);
    // a is sent a message: the push changes its status, the counter is still 5
    const pushed = liveSeqs(snap({ a: "working", b: "done" }, { a: 5, b: 9 }), memory);
    expect(pushed.get("a")!).toBeGreaterThan(9);
    // it finishes before the roster is read again: dated later still, so it is a new change
    const finished = liveSeqs(snap({ a: "done", b: "done" }, { a: 5, b: 9 }), memory);
    expect(finished.get("a")!).toBeGreaterThan(pushed.get("a")!);
    // herdr's counter arrives and replaces the stand-in
    expect(liveSeqs(snap({ a: "done", b: "done" }, { a: 11, b: 9 }), memory).get("a")).toBe(11);
    expect(memory.bumped.size).toBe(0);
  });

  it("does not date a pane's first sighting, or a pane with no counter", () => {
    const memory = newSeqMemory();
    liveSeqs(snap({ a: "idle", shell: "unknown" }, { a: 5 }), memory);
    const next = liveSeqs(snap({ a: "idle", shell: "working", c: "done" }, { a: 5, c: 7 }), memory);
    expect([...next]).toEqual([["a", 5], ["c", 7]]);
  });
});

describe("activity order", () => {
  const workspaces = ["idle", "working", "blocked", "done-old", "done-new", "shell"].map(workspace);
  const panes = [pane("p-idle", "idle", "idle"), pane("p-working", "working", "working"), pane("p-blocked", "blocked", "blocked"),
    pane("p-done-old", "done-old", "done"), pane("p-done-new", "done-new", "done"), pane("p-shell", "shell", "unknown")];
  const seqs = new Map([["p-idle", 50], ["p-working", 10], ["p-blocked", 1], ["p-done-old", 20], ["p-done-new", 30]]);

  it("puts blocked first, then the latest change first whatever the state", () => {
    expect(ids(activityOrder(workspaces, panes, seqs)))
      .toEqual(["blocked", "idle", "done-new", "done-old", "working", "shell"]);
  });

  it("keeps the row just worked in on top while it runs and after it finishes", () => {
    // a message sent from "done-old": it starts working, so its counter is the newest
    const sent = panes.map((entry) => entry.pane_id === "p-done-old" ? pane("p-done-old", "done-old", "working") : entry);
    const running = new Map([...seqs, ["p-done-old", 60]]);
    expect(ids(activityOrder(workspaces, sent, running)).slice(0, 2)).toEqual(["blocked", "done-old"]);
    const finished = panes.map((entry) => entry.pane_id === "p-done-old" ? pane("p-done-old", "done-old", "done") : entry);
    expect(ids(activityOrder(workspaces, finished, new Map([...running, ["p-done-old", 61]]))).slice(0, 2)).toEqual(["blocked", "done-old"]);
  });

  it("puts a new workspace on top, and keeps herdr's order between equals", () => {
    const fresh = [...panes, pane("p-new", "new", "idle"), pane("p-tie", "tie", "idle")];
    const order = activityOrder([...workspaces, workspace("new"), workspace("tie")], fresh, new Map([...seqs, ["p-new", 99]]));
    expect(ids(order).slice(0, 2)).toEqual(["blocked", "new"]);
    // no counter at all: the shell and "tie" keep herdr's order at the end
    expect(ids(order).slice(-2)).toEqual(["shell", "tie"]);
  });

  it("pins a workspace with any blocked pane, and dates it by its most recent pane", () => {
    const multi = [pane("x1", "multi", "idle"), pane("x2", "multi", "blocked"), pane("y1", "other", "working"), pane("z1", "late", "done")];
    expect(ids(activityOrder([workspace("other"), workspace("late"), workspace("multi")], multi, new Map([["x1", 5], ["x2", 1], ["y1", 9], ["z1", 3]]))))
      .toEqual(["multi", "other", "late"]);
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
