import { describe, expect, it } from "bun:test";

import { isNavigation, linkSearch, linksSomewhere, readLink, workspacePane } from "./deepLink.ts";

describe("deep links", () => {
  it("reads every place an address can name, with the local PC by default", () => {
    expect(readLink("?ws=w2&pane=w2%3Ap1&view=chat&settings=appearance")).toEqual({ machine: "local", workspace: "w2", pane: "w2:p1", view: "chat", settings: "appearance" });
    expect(readLink("?machine=box&pane=w1:p3")).toMatchObject({ machine: "box", pane: "w1:p3", workspace: null, view: null });
    expect(readLink("?view=sideways&pane=%20%20")).toMatchObject({ view: null, pane: null });
    expect(readLink("")).toEqual({ machine: "local", workspace: null, pane: null, view: null, settings: null });
  });

  it("writes the shortest address, keeps what is not its own, and reads back what it wrote", () => {
    const link = { machine: "local", workspace: "w2", pane: "w2:p1", view: "terminal" as const, settings: null };
    expect(linkSearch(link)).toBe("?ws=w2&pane=w2%3Ap1&view=terminal");
    expect(readLink(linkSearch(link))).toEqual(link);
    expect(linkSearch({ ...link, machine: "box" }, "?debug=1&pane=old")).toBe("?debug=1&machine=box&ws=w2&pane=w2%3Ap1&view=terminal");
    // a lens means nothing without a pane; nothing to say is no query at all
    expect(linkSearch({ machine: "local", workspace: null, pane: null, view: "chat", settings: null })).toBe("");
    expect(linkSearch({ machine: "local", workspace: null, pane: null, view: null, settings: "about" })).toBe("?settings=about");
  });

  it("tells an address that names a place from the app's plain start", () => {
    expect(linksSomewhere("?pane=w1:p1")).toBe(true);
    expect(linksSomewhere("?settings=chat")).toBe(true);
    expect(linksSomewhere("?pair=ABC")).toBe(false);
    expect(linksSomewhere("")).toBe(false);
  });

  it("opens the pane a workspace's row opens: in front in its active tab, then focused, then first", () => {
    const panes = [
      { pane_id: "w2:p1", workspace_id: "w2", focused: false },
      { pane_id: "w2:p2", workspace_id: "w2", focused: true },
      { pane_id: "w2:p3", workspace_id: "w2", focused: false },
      { pane_id: "w3:p1", workspace_id: "w3", focused: false },
    ];
    const workspaces = [{ workspace_id: "w2", active_tab_id: "w2:t2" }, { workspace_id: "w3", active_tab_id: "w3:t1" }];
    const snapshot = (layouts: unknown[]) => ({ workspaces, panes, layouts }) as never;
    expect(workspacePane(snapshot([{ tab_id: "w2:t2", focused_pane_id: "w2:p3" }]), "w2")).toBe("w2:p3");
    expect(workspacePane(snapshot([]), "w2")).toBe("w2:p2");
    expect(workspacePane(snapshot([]), "w3")).toBe("w3:p1");
    expect(workspacePane(snapshot([]), "gone")).toBeNull();
  });

  it("keeps a history entry for a move to another pane or PC, not for staying put", () => {
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: "b" })).toBe(true);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "box", pane: "a" })).toBe(true);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: "a" })).toBe(false);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: null })).toBe(false);
  });
});
