import type { AgentRow } from "@rakazo/contracts";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useRef, useState } from "react";
import type { TuiClient } from "../rpc.js";
import { explainRpcError } from "../rpc.js";
import type { Line } from "./feeds.js";
import { sendToBot, typeIntoAgent, useAgents, useBots, useTimeline } from "./feeds.js";
import type { Effect, Press, SidebarItem, UiState } from "./state.js";
import {
  buildSidebar,
  hintsFor,
  initialState,
  itemKey,
  reduce,
  selectedItem,
  truncate,
} from "./state.js";

export type AppProps = {
  client: TuiClient;
  /** Hands the terminal to the existing attach flow and returns when the person detaches. */
  onAttach: (agentId: string) => Promise<void>;
};

const STATUS_COLOR: Record<AgentRow["status"], string | undefined> = {
  blocked: "yellow",
  working: "green",
  done: "cyan",
  idle: undefined,
  unknown: undefined,
  closed: undefined,
};

const HELP: [string, string][] = [
  ["↑ ↓  j k", "move, or scroll when the main pane has focus"],
  ["Tab", "switch between the list and the main pane"],
  ["Enter  n", "write to the selected agent or bot"],
  ["a", "attach to the selected agent's terminal (Ctrl-] then q detaches)"],
  ["c", "chat with a bot"],
  ["r", "reload"],
  ["q  Ctrl-C", "quit"],
];

export function App({ client, onAttach }: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const [ui, setUi] = useState<UiState>(initialState);
  // Keys can arrive faster than a render (a paste), so each one reduces the latest state.
  const latest = useRef(ui);
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState("");
  const report = useCallback((message: string) => setNotice(message), []);
  const agents = useAgents(client, tick, report);
  const bots = useBots(client, tick, report);
  const items = buildSidebar(agents, bots);
  const item = selectedItem(items, ui);
  const lines = useTimeline(client, item, tick, report);
  const width = columns || 80;
  const height = Math.max(6, (rows || 24) - 1);
  const sideWidth = Math.min(32, Math.floor(width / 3));

  const perform = async (effect: Effect): Promise<void> => {
    try {
      if (effect.kind === "quit") exit();
      else if (effect.kind === "refresh") setTick((n) => n + 1);
      else if (effect.kind === "attach") await suspendTerminal(() => onAttach(effect.id));
      else if (effect.to.kind === "bot") await sendToBot(client, effect.to.id, effect.text);
      else {
        await typeIntoAgent(client, effect.to.id, effect.text, { rows: 24, cols: 80 });
        setNotice(`Sent to ${truncate(effect.to.label, 40)}.`);
      }
    } catch (error) {
      setNotice(explainRpcError(error, effect.kind).message);
    }
  };

  useInput((input, key) => {
    const press: Press = {
      input,
      up: key.upArrow,
      down: key.downArrow,
      tab: key.tab,
      enter: key.return,
      escape: key.escape,
      backspace: key.backspace || key.delete,
      ctrl: key.ctrl,
    };
    const step = reduce(latest.current, press, items);
    latest.current = step.state;
    setUi(step.state);
    setNotice("");
    if (step.effect) void perform(step.effect);
  });

  return (
    <Box flexDirection="column" height={height + 1} width={width}>
      <Box height={height}>
        <Sidebar items={items} selected={item} width={sideWidth} height={height} />
        <Main
          item={item}
          agent={agents.find((row) => item?.kind === "agent" && row.id === item.id)}
          lines={lines}
          ui={ui}
          width={width - sideWidth - 2}
          height={height}
        />
      </Box>
      <Text dimColor={!notice} color={notice ? "red" : undefined} wrap="truncate">
        {truncate(notice || hintsFor(ui, item), width)}
      </Text>
    </Box>
  );
}

function Sidebar(props: {
  items: SidebarItem[];
  selected: SidebarItem | undefined;
  width: number;
  height: number;
}) {
  const { items, selected, width, height } = props;
  const entries: (SidebarItem | string)[] = [];
  for (const [kind, title] of [
    ["agent", "AGENTS"],
    ["bot", "BOTS"],
  ] as const) {
    const group = items.filter((candidate) => candidate.kind === kind);
    if (group.length > 0) entries.push(title, ...group);
  }
  const at = selected ? entries.indexOf(selected) : 0;
  const start = Math.min(
    Math.max(0, at - Math.floor(height / 2)),
    Math.max(0, entries.length - height),
  );
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor="gray"
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      {entries.length === 0 && <Text dimColor>Nothing yet</Text>}
      {entries.slice(start, start + height).map((entry) =>
        typeof entry === "string" ? (
          <Text key={entry} dimColor bold>
            {entry}
          </Text>
        ) : (
          <SidebarRow
            key={itemKey(entry)}
            item={entry}
            active={entry === selected}
            width={width - 3}
          />
        ),
      )}
    </Box>
  );
}

function SidebarRow(props: { item: SidebarItem; active: boolean; width: number }) {
  const { item, active, width } = props;
  const color = item.kind === "agent" ? STATUS_COLOR[item.status] : undefined;
  return (
    <Text wrap="truncate" inverse={active}>
      {item.kind === "agent" ? (
        <Text color={color} dimColor={!color}>
          ●{" "}
        </Text>
      ) : (
        <Text dimColor>○ </Text>
      )}
      {truncate(item.label, width - 2)}
    </Text>
  );
}

function Main(props: {
  item: SidebarItem | undefined;
  agent: AgentRow | undefined;
  lines: Line[];
  ui: UiState;
  width: number;
  height: number;
}) {
  const { item, agent, lines, ui, width, height } = props;
  if (!item) return <Box paddingLeft={1} />;
  const room = Math.max(1, height - 2);
  const scroll = Math.min(ui.scroll, Math.max(0, lines.length - room));
  const shown = lines.slice(Math.max(0, lines.length - room - scroll), lines.length - scroll);
  const title = agent
    ? `${item.label}  ${agent.status}${agent.machine ? `  @${agent.machine}` : ""}${agent.summary ? `  ${agent.summary}` : ""}`
    : item.label;
  return (
    <Box flexDirection="column" paddingLeft={1} width={width + 1}>
      <Text bold wrap="truncate">
        {truncate(title, width)}
      </Text>
      <Box flexDirection="column" height={room}>
        {ui.mode === "help"
          ? HELP.map(([keys, what]) => (
              <Text key={keys} wrap="truncate">
                <Text bold>{keys.padEnd(11)}</Text>
                {truncate(what, width - 11)}
              </Text>
            ))
          : shown.map((line) => (
              <Text
                key={line.key}
                wrap="truncate"
                dimColor={line.tone === "event"}
                color={line.tone === "you" ? "cyan" : undefined}
              >
                {truncate(`${line.tone === "you" ? "› " : ""}${line.text}`, width)}
              </Text>
            ))}
      </Box>
      <Prompt ui={ui} item={item} width={width} />
    </Box>
  );
}

function Prompt({ ui, item, width }: { ui: UiState; item: SidebarItem; width: number }) {
  if (ui.mode === "confirm") {
    return (
      <Text color="yellow" wrap="truncate">
        {truncate(`Send to ${item.label}: ${ui.draft}`, width)}
      </Text>
    );
  }
  if (ui.mode !== "compose") return <Text> </Text>;
  return (
    <Text wrap="truncate-start">
      {"› "}
      {ui.draft}
      <Text inverse> </Text>
    </Text>
  );
}
