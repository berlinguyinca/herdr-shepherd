import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { LeftPane } from "../lib/split-pane";
import { AgentsList } from "./agents-list";
import type { HomeTab } from "./home-tab-bar";
import { HomeTabBar } from "./home-tab-bar";

/** The left column of the wide-window frame: the chat list or the agents list, and the tab bar. */
export function SplitLeftPane({
  pane,
  tab,
  inbox,
  selectedAgentId,
  onSelectAgent,
}: {
  pane: LeftPane;
  tab: HomeTab | null;
  inbox: ReactNode;
  selectedAgentId?: string;
  onSelectAgent: (id: string) => void;
}) {
  return (
    <View style={styles.pane}>
      <View style={styles.pane}>
        {pane === "agents" ? (
          <AgentsList selectedId={selectedAgentId} onSelect={onSelectAgent} />
        ) : (
          inbox
        )}
      </View>
      {tab ? <HomeTabBar active={tab} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ pane: { flex: 1 } });
