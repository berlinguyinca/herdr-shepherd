import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useContext, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { AgentEvent, isRenderableEvent } from "../components/agent-event";
import { useAgentStatus } from "../components/agent-row";
import { glassHeaderOptions } from "../components/glass-title";
import { NativeSegmentedControl } from "../components/native-segmented-control";
import { TerminalView } from "../components/terminal-view";
import { conversationColumn } from "../lib/agent-column";
import { agentIdFromRoute } from "../lib/agent-route";
import {
  modeSwitchWidth,
  terminalKeyboardOffset,
  useViewMode,
  type ViewMode,
  viewModeLocked,
} from "../lib/agent-view-mode";
import type { AgentEvent as Event } from "../lib/agents";
import { agentEvent, isAgentGone } from "../lib/agents";
import { useFloatingHeaderInset } from "../lib/floating-header";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { InboxBesideContext, useSideInsets } from "../lib/side-insets";
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
  const [mode, setMode, modeLoading] = useViewMode(agentId, agent?.status);
  // The terminal mounts on first use and then stays, under Chat, so toggling does not rebuild its
  // client; the chat list stays mounted under Terminal to keep its scroll position. Neither is
  // hidden with display none: both stay laid out at full size (a collapsed terminal would fit
  // itself to nothing and report a size of 0), just transparent and out of reach. Both belong to
  // one agent: another agent on this screen starts again.
  const [terminalFor, setTerminalFor] = useState<string>();
  if (!modeLoading && mode === "terminal" && terminalFor !== agentId) setTerminalFor(agentId);
  const terminalUsed = terminalFor === agentId;
  const sides = useSideInsets();
  const { fontScale, width: windowWidth } = useWindowDimensions();
  const [headerWidth, setHeaderWidth] = useState<number>();
  // Where the terminal begins in the window: the keyboard has to clear that much too.
  const [terminalTop, setTerminalTop] = useState<number>();
  const terminalBox = useRef<View>(null);
  // Nothing to attach to for a closed agent; one that closes while shown still offers Chat.
  const terminalLocked = viewModeLocked(agent?.status) && mode !== "terminal";

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

  if (gone) {
    return (
      <View style={[styles.center, { backgroundColor: tokens.background }]}>
        <Text style={[styles.message, { color: tokens.mutedForeground }]}>
          {t("This agent is no longer available")}
        </Text>
        <Pressable accessibilityRole="button" onPress={backToList}>
          <Text style={[styles.message, { color: tokens.foreground }]}>{t("Back to agents")}</Text>
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
      {agent || failed ? (
        <View
          testID="agent-subheader"
          onLayout={(event) => setHeaderWidth(event.nativeEvent.layout.width)}
          style={[
            styles.header,
            { borderBottomColor: tokens.border, paddingTop: headerInset + 10 },
          ]}
        >
          <View testID="agent-column" style={[conversationColumn, styles.headerColumn]}>
            {agent ? (
              <>
                <Text
                  testID="agent-machine"
                  style={[styles.title, { color: tokens.mutedForeground }]}
                  numberOfLines={1}
                >
                  {agent.machine}
                </Text>
                <StatusChip status={agent.status} />
              </>
            ) : (
              <View style={styles.title} />
            )}
            <View style={{ width: modeSwitchWidth(fontScale, (headerWidth ?? windowWidth) - 32) }}>
              <NativeSegmentedControl<ViewMode>
                accessibilityLabel={
                  terminalLocked
                    ? t("Terminal unavailable: this agent has no live session")
                    : t("Agent view")
                }
                disabled={terminalLocked}
                value={mode}
                onChange={setMode}
                options={[
                  { value: "chat", label: t("Chat") },
                  { value: "terminal", label: t("Terminal") },
                ]}
              />
            </View>
          </View>
        </View>
      ) : (
        <View style={{ height: headerInset }} />
      )}
      <View style={styles.body}>
        <View
          testID="agent-chat"
          style={[styles.pane, mode === "terminal" && styles.hidden]}
          {...hiddenProps(mode === "terminal")}
        >
          {failed ? (
            <View style={styles.center}>
              <Text style={[styles.message, { color: tokens.mutedForeground }]}>
                {t("Could not load this conversation")}
              </Text>
              <Pressable accessibilityRole="button" onPress={conversation.retry}>
                <Text style={[styles.message, { color: tokens.foreground }]}>{t("Try Again")}</Text>
              </Pressable>
            </View>
          ) : null}
          {conversation.reconnecting ? (
            <Text style={[styles.small, { color: tokens.mutedForeground }]}>
              {t("Reconnecting")}
            </Text>
          ) : null}
          {failed ? null : loading ? (
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
                  n.contentOffset.y + n.layoutMeasurement.height >=
                  n.contentSize.height - BOTTOM_SLACK;
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
                    <Text style={{ color: tokens.mutedForeground }}>
                      {t("Load earlier messages")}
                    </Text>
                  </Pressable>
                ) : null
              }
              initialNumToRender={20}
              windowSize={9}
            />
          )}
        </View>
        {terminalUsed ? (
          <View
            ref={terminalBox}
            testID="agent-terminal"
            style={[styles.pane, sides, mode !== "terminal" && styles.hidden]}
            {...hiddenProps(mode !== "terminal")}
            onLayout={() =>
              // A rotation or a split-pane resize lays this out again, and the page refits to it.
              terminalBox.current?.measureInWindow?.((_x, y) => setTerminalTop(y))
            }
          >
            <TerminalView
              agentId={agentId}
              focused={mode === "terminal"}
              keyboardOffset={terminalKeyboardOffset(terminalTop, headerInset)}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** What keeps a pane that is laid out but not shown from being touched or read out. */
function hiddenProps(hidden: boolean) {
  return hidden
    ? ({
        pointerEvents: "none",
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      } as const)
    : {};
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { flex: 1 },
  pane: { flex: 1 },
  body: { flex: 1 },
  hidden: { ...StyleSheet.absoluteFill, opacity: 0 },
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
  headerColumn: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
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
