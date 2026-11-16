import type { ReactNode } from "react";
import { View } from "react-native";
import { useSplitView } from "../../lib/split-view";
import { HomeTabBar } from "../home-tab-bar";
import { PickChatPane } from "../pick-chat-pane";
import { HomeSession } from "./home-session";

/** The chat list and tabs. In single-chat mode the /menu route hosts it, with `aboveTabs` linking back to the chat. */
export function ClassicHome({ aboveTabs }: { aboveTabs?: ReactNode } = {}) {
  const { split } = useSplitView();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>{split ? <PickChatPane /> : <HomeSession />}</View>
      {aboveTabs}
      {/* On a wide window the tab bar sits under the list instead, not under the open chat. */}
      {split ? null : <HomeTabBar active="assistant" />}
    </View>
  );
}
