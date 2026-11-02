import type { HomeTab } from "../components/home-tab-bar";

/** What the left pane of the wide-window frame holds. */
export type LeftPane = "inbox" | "agents";

// Screens that take the whole window even when it is wide enough for a list beside them.
const FULL_WINDOW_ROUTES = new Set(["/sign-in", "/server", "/image", "/computer", "/share"]);

export function isAgentsRoute(pathname: string) {
  return pathname === "/agents" || pathname === "/agent";
}

/** The Agents screens take the whole window only where the split is not active. */
export function fullWindowRoute(pathname: string, split: boolean) {
  return FULL_WINDOW_ROUTES.has(pathname) || (isAgentsRoute(pathname) && !split);
}

/**
 * The left pane for a route: the agents list stays beside the Agents screens, the chat list beside
 * everything else that is not full window (when `inboxVisible`), nothing on a narrow window.
 */
export function leftPaneFor(
  pathname: string,
  split: boolean,
  inboxVisible: boolean,
): LeftPane | null {
  if (!split || fullWindowRoute(pathname, split)) return null;
  if (isAgentsRoute(pathname)) return "agents";
  return inboxVisible ? "inbox" : null;
}

/**
 * The home tab bar stays under the left pane whatever it holds: Agents on the Agents screens,
 * Assistant beside any chat. Nothing on a narrow window.
 */
export function tabFor(pathname: string, leftPane: LeftPane | null): HomeTab | null {
  if (leftPane === null) return null;
  return isAgentsRoute(pathname) ? "agents" : "assistant";
}
