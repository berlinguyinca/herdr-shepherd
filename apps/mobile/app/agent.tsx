import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useContext, useRef } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { AgentEvent, isRenderableEvent } from "../components/agent-event";
import { useAgentStatus } from "../components/agent-row";
import { glassHeaderOptions } from "../components/glass-title";
import { conversationColumn } from "../lib/agent-column";
import { agentIdFromRoute } from "../lib/agent-route";
import type { AgentEvent as Event } from "../lib/agents";
import { agentEvent, isAgentGone } from "../lib/agents";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { InboxBesideContext } from "../lib/side-insets";
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
  // With the list beside it there is nothing to go back to: picking another agent replaces this one.
  const beside = useContext(InboxBesideContext);
  // The glass header floats over the screen on iOS 26, so fixed content starts below it.
  const headerInset = useFloatingHeaderInset();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const agentId = agentIdFromRoute(id) ?? "";
  const conversation = useAgentConversation(agentId);
  const { agent, events, loading, gone, failed, empty, markGone } = conversation;
  // Usage and other quiet events draw nothing; a conversation of only those gets a calm message.
  const nothingToShow =
    !loading && !empty && !conversation.hasMore && !events.some(isRenderableEvent);
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
      <Stack.Screen
        options={{
          ...glassHeaderOptions(name || t("Agent")),
          headerBackVisible: !beside,
          ...(beside && iosAtLeast(26) ? { unstable_headerLeftItems: () => [] } : {}),
        }}
      />
      {agent ? (
        <View
          testID="agent-subheader"
          style={[
            styles.header,
            { borderBottomColor: tokens.border, paddingTop: headerInset + 10 },
          ]}
        >
          <View testID="agent-column" style={[conversationColumn, styles.headerColumn]}>
            <Text
              testID="agent-machine"
              style={[styles.title, { color: tokens.mutedForeground }]}
              numberOfLines={1}
            >
              {agent.machine}
            </Text>
            <StatusChip status={agent.status} />
          </View>
        </View>
      ) : (
        <View style={{ height: headerInset }} />
      )}
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
      ) : nothingToShow ? (
        <View style={styles.center}>
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>
            {t("Nothing to show yet.")}
          </Text>
        </View>
      ) : (
        <FlatList<Event>
          ref={list}
          style={styles.list}
          contentContainerStyle={conversationColumn}
          data={events}
          keyExtractor={(event) => `${agentId}:${event.seq}`}
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerColumn: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 17, lineHeight: 22 },
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
