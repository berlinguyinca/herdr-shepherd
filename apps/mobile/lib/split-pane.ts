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

/** The home tab bar sits under the left pane on the two home screens and the open agent. */
export function tabFor(pathname: string): HomeTab | null {
  if (pathname === "/") return "assistant";
  return isAgentsRoute(pathname) ? "agents" : null;
}
