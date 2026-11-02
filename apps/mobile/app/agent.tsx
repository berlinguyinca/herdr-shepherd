import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { AgentEvent } from "../components/agent-event";
import { useAgentStatus } from "../components/agent-row";
import type { AgentEvent as Event } from "../lib/agents";
import { agentEvent, isAgentGone } from "../lib/agents";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useAgentConversation } from "../lib/use-agent-conversation";

/** Within this many points of the end counts as "at the bottom". */
const BOTTOM_SLACK = 80;

function StatusChip({ status }: { status: string }) {
  const { label, color } = useAgentStatus(status as never);
  return <Text style={[styles.chip, { color, borderColor: color }]}>{label}</Text>;
}

export default function AgentScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const agentId = typeof id === "string" ? id : "";
  const conversation = useAgentConversation(agentId);
  const { agent, events, loading, gone, failed, empty, markGone } = conversation;
  const list = useRef<FlatList<Event>>(null);
  const atBottom = useRef(true);

  const expand = useCallback(
    async (event: Event) => {
      try {
        return await agentEvent(agentId, event.seq);
      } catch (error) {
        if (!isAgentGone(error)) throw error;
        markGone();
        return undefined;
      }
    },
    [agentId, markGone],
  );

  const backToList = () => (router.canGoBack() ? router.back() : router.replace("/agents"));
  const name = agent?.name.trim() ?? "";

  if (gone || failed) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.background }]}>
        <Text style={[styles.message, { color: tokens.mutedForeground }]}>
          {gone ? t("This agent is no longer available") : t("Could not load this conversation")}
        </Text>
        <Pressable accessibilityRole="button" onPress={gone ? backToList : conversation.retry}>
          <Text style={[styles.message, { color: tokens.foreground }]}>
            {gone ? t("Back to agents") : t("Try Again")}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <Stack.Screen options={{ title: name || t("Agent") }} />
      {agent ? (
        <View style={[styles.header, { borderBottomColor: tokens.border }]}>
          <Text style={[styles.title, { color: tokens.foreground }]} numberOfLines={1}>
            <Text testID="agent-name" style={styles.name}>
              {name || t("Unknown")}
            </Text>
            {agent.machine ? (
              <Text testID="agent-machine" style={{ color: tokens.mutedForeground }}>
                {` ${agent.machine}`}
              </Text>
            ) : null}
          </Text>
          <StatusChip status={agent.status} />
        </View>
      ) : null}
      {conversation.reconnecting ? (
        <Text style={[styles.small, { color: tokens.mutedForeground }]}>{t("Reconnecting")}</Text>
      ) : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : empty ? (
        <View style={styles.center}>
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>
            {t("No conversation was captured for this agent.")}
          </Text>
        </View>
      ) : (
        <FlatList<Event>
          ref={list}
          style={styles.list}
          data={events}
          keyExtractor={(event) => String(event.seq)}
          renderItem={({ item }) => <AgentEvent event={item} onExpand={expand} />}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onStartReached={conversation.loadOlder}
          onStartReachedThreshold={0.5}
          onScroll={({ nativeEvent: n }) => {
            atBottom.current =
              n.contentOffset.y + n.layoutMeasurement.height >= n.contentSize.height - BOTTOM_SLACK;
          }}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (atBottom.current) list.current?.scrollToEnd({ animated: false });
          }}
          ListHeaderComponent={
            conversation.loadingOlder ? (
              <ActivityIndicator color={tokens.mutedForeground} style={styles.older} />
            ) : conversation.hasMore ? (
              <Pressable
                accessibilityRole="button"
                onPress={conversation.loadOlder}
                style={styles.older}
              >
                <Text style={{ color: tokens.mutedForeground }}>{t("Load earlier messages")}</Text>
              </Pressable>
            ) : null
          }
          initialNumToRender={20}
          windowSize={9}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  message: { fontSize: 17, textAlign: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, fontSize: 17, lineHeight: 22 },
  name: { fontWeight: "600" },
  chip: {
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: "hidden",
  },
  small: { fontSize: 12, textAlign: "center", paddingVertical: 4 },
  older: { alignItems: "center", paddingVertical: 12 },
});
