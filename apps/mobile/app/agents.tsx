import { useRouter } from "expo-router";
import { useContext } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AgentsList } from "../components/agents-list";
import { HomeTabBar } from "../components/home-tab-bar";
import { agentRouteId } from "../lib/agent-route";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { InboxBesideContext } from "../lib/side-insets";

/** The Agents tab; on a wide window the list sits in the left pane and this is the empty right. */
export default function Agents() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const beside = useContext(InboxBesideContext);
  if (beside) {
    return (
      <View style={[styles.empty, { backgroundColor: tokens.background }]}>
        <Text style={[styles.message, { color: tokens.mutedForeground }]}>
          {t("Select an agent")}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <AgentsList
        onSelect={(id) => router.push({ pathname: "/agent", params: { id: agentRouteId(id) } })}
      />
      <HomeTabBar active="agents" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  message: { fontSize: 17, textAlign: "center" },
});
