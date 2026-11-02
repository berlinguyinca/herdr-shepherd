// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SplitLeftPane } from "../components/split-left-pane";
import { fullWindowRoute, leftPaneFor, tabFor } from "./split-pane";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/agents-list", () => ({
  AgentsList: ({
    selectedId,
    onSelect,
  }: {
    selectedId?: string;
    onSelect: (id: string) => void;
  }) => (
    <button
      type="button"
      data-testid="agents-list"
      data-selected={selectedId}
      onClick={() => onSelect("a2")}
    />
  ),
}));
vi.mock("../components/home-tab-bar", () => ({
  HomeTabBar: ({ active }: { active: string }) => <nav data-testid="tabs" data-active={active} />,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("wide window shows list and open agent side by side", async () => {
  expect(leftPaneFor("/agent", true, false)).toBe("agents");
  expect(leftPaneFor("/agents", true, false)).toBe("agents");
  // The open agent is no longer a full-window screen on a wide window.
  expect(fullWindowRoute("/agent", true)).toBe(false);
  expect(fullWindowRoute("/agents", true)).toBe(false);
  expect(tabFor("/agent", "agents")).toBe("agents");
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <SplitLeftPane
        pane="agents"
        tab="agents"
        inbox={<p data-testid="inbox" />}
        selectedAgentId="a1"
        onSelectAgent={onSelect}
      />,
    ),
  );
  const list = host.querySelector<HTMLElement>("[data-testid=agents-list]");
  expect(list?.dataset.selected).toBe("a1");
  expect(host.querySelector("[data-testid=inbox]")).toBeNull();
  expect(host.querySelector<HTMLElement>("[data-testid=tabs]")?.dataset.active).toBe("agents");
  act(() => list?.click());
  expect(onSelect).toHaveBeenCalledWith("a2");
});

it("narrow window pushes the agent over the list", () => {
  expect(leftPaneFor("/agent", false, false)).toBeNull();
  expect(leftPaneFor("/agents", false, false)).toBeNull();
  expect(leftPaneFor("/agents", false, true)).toBeNull();
  // Still a full-window screen where the split is not active.
  expect(fullWindowRoute("/agent", false)).toBe(true);
  expect(fullWindowRoute("/agents", false)).toBe(true);
});

it("Assistant tab on a wide window still shows the chat inbox", async () => {
  expect(leftPaneFor("/", true, true)).toBe("inbox");
  expect(leftPaneFor("/chat", true, true)).toBe("inbox");
  expect(leftPaneFor("/chat", true, false)).toBeNull();
  expect(leftPaneFor("/server", true, true)).toBeNull();
  expect(tabFor("/", "inbox")).toBe("assistant");
  // A chat open beside the inbox keeps the bar; on a narrow window there is no left pane.
  expect(tabFor("/thread", leftPaneFor("/thread", true, true))).toBe("assistant");
  expect(tabFor("/thread", leftPaneFor("/thread", false, true))).toBeNull();
  expect(tabFor("/server", leftPaneFor("/server", true, true))).toBeNull();
  await act(async () =>
    root.render(
      <SplitLeftPane
        pane="inbox"
        tab="assistant"
        inbox={<p data-testid="inbox" />}
        onSelectAgent={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector("[data-testid=inbox]")).not.toBeNull();
  expect(host.querySelector("[data-testid=agents-list]")).toBeNull();
  expect(host.querySelector<HTMLElement>("[data-testid=tabs]")?.dataset.active).toBe("assistant");
});
