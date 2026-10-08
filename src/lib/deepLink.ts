/**
 * The address says where the app is, so any moment can be linked to and returned to:
 *
 *   ?machine=<pc>&ws=<workspace>&pane=<pane>&view=chat|terminal&settings=<page>
 *
 * `machine` is left out for the local PC; `pane` and `machine` are the names a tapped
 * notification already opens the app with (public/sw.js). A link to a workspace (`ws` alone, or
 * a `pane` that has closed) opens the pane its sidebar row opens. Opening another pane is an
 * entry of the history, so Back returns to the last one; a lens switch, a Settings page and a
 * pane the app picked itself only replace the entry. Settings keeps its own entries
 * (lib/settingsHistory.ts); the address of the one shown carries its page.
 */
import type { SessionSnapshot } from "../../shared/protocol.ts";

export type LinkView = "chat" | "terminal";

export interface AppLink {
  machine: string;
  workspace: string | null;
  pane: string | null;
  view: LinkView | null;
  settings: string | null;
}

const LOCAL = "local";
/** the query names this module owns; anything else in the address is left as it is */
const OWN = ["machine", "ws", "pane", "view", "settings"] as const;

const named = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** The place an address names. Every field is optional in an address; a missing PC is the local one. */
export function readLink(search: string): AppLink {
  const query = new URLSearchParams(search);
  const view = query.get("view");
  return {
    machine: named(query.get("machine")) ?? LOCAL,
    workspace: named(query.get("ws")),
    pane: named(query.get("pane")),
    view: view === "chat" || view === "terminal" ? view : null,
    settings: named(query.get("settings")),
  };
}

/** Whether an address names a place at all, as opposed to the app's own start. */
export function linksSomewhere(search: string): boolean {
  const query = new URLSearchParams(search);
  return OWN.some((name) => query.has(name));
}

/** The query for a place, keeping whatever else `current` holds that is not this module's. */
export function linkSearch(link: AppLink, current = ""): string {
  const query = new URLSearchParams(current);
  for (const name of OWN) query.delete(name);
  if (link.machine !== LOCAL) query.set("machine", link.machine);
  if (link.workspace) query.set("ws", link.workspace);
  if (link.pane) query.set("pane", link.pane);
  if (link.pane && link.view) query.set("view", link.view);
  if (link.settings) query.set("settings", link.settings);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * The pane a link to a workspace opens, as its sidebar row does: the one in front in its active
 * tab, else its focused pane, else its first. Null when the workspace is not open.
 */
export function workspacePane(snapshot: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">, workspaceId: string): string | null {
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!workspace) return null;
  const panes = snapshot.panes.filter((pane) => pane.workspace_id === workspaceId);
  const front = snapshot.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id;
  return (panes.find((pane) => pane.pane_id === front) ?? panes.find((pane) => pane.focused) ?? panes[0])?.pane_id ?? null;
}

/** Whether going from one place to another is a move the history keeps (another pane or PC). */
export function isNavigation(from: Pick<AppLink, "machine" | "pane">, to: Pick<AppLink, "machine" | "pane">): boolean {
  return to.pane !== null && (from.machine !== to.machine || from.pane !== to.pane);
}

/** Marks an entry the app pushed for a move between panes. */
export const NAV_KEY = "herdr-web-ui:nav";
