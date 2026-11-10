import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { applyAgentRow } from "../lib/agent-order";
import type { AgentRow as Row } from "../lib/agents";
import { agentListQuery, isAgentsUnsupported, subscribeAgentList } from "../lib/agents";
import { useForegroundPoll } from "../lib/foreground-poll";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { queryClient } from "../lib/query";
import { AgentRow } from "./agent-row";

const POLL_MS = 5_000;
/** After the stream fell back, a poll that works this long afterwards tries the stream again. */
const STREAM_RETRY_MS = 60_000;

/** The agents list, for the full-screen Agents tab and the left pane of a wide window. */
export function AgentsList({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const [showOlder, setShowOlder] = useState(false);
  const [polling, setPolling] = useState(false);
  const fellBackAt = useRef(0);
  const [pulling, setPulling] = useState(false);
  // Rows changed by the stream, kept only for the list they were applied to.
  const [live, setLive] = useState<{ source: unknown; rows: Row[] } | null>(null);
  const query = useQuery(agentListQuery(showOlder), queryClient);
  const { data, refetch } = query;

  const dataRef = useRef(data);
  dataRef.current = data;
  const rows = live && live.source === data ? live.rows : (data?.agents ?? []);

  // The stream starts from the cursor of the first list for this view, so a refetch (a poll, or
  // Show older) does not restart it; a new view of the list (showOlder) opens its own stream.
  const cursor = useRef<{ showOlder: boolean; value: number } | null>(null);
  if (data && cursor.current?.showOlder !== showOlder)
    cursor.current = { showOlder, value: data.cursor };
  const startCursor = data ? (cursor.current?.value ?? data.cursor) : null;
  useEffect(() => {
    if (startCursor === null || polling) return;
    return subscribeAgentList(
      startCursor,
      (row) =>
        setLive((current) => {
          const source = dataRef.current;
          const base = current && current.source === source ? current.rows : (source?.agents ?? []);
          return { source, rows: applyAgentRow(base, row, showOlder) };
        }),
      () => {
        fellBackAt.current = Date.now();
        setPolling(true);
      },
    );
  }, [startCursor, showOlder, polling]);

  // A poll that worked means the server is reachable: try the stream again.
  const poll = useCallback(async () => {
    const result = await refetch();
    if (result.isError || !result.data || Date.now() - fellBackAt.current < STREAM_RETRY_MS) return;
    cursor.current = { showOlder, value: result.data.cursor };
    setPolling(false);
  }, [refetch, showOlder]);
  useForegroundPoll(poll, POLL_MS, polling);

  const unsupported = query.isError && isAgentsUnsupported(query.error);
  const failed = query.isError && !unsupported && !data;
  const message = unsupported
    ? t("This server does not offer the Agents view yet")
    : failed
      ? t("Could not load agents")
      : null;
  const hidden = !showOlder && (data?.hiddenCount ?? 0) > 0;

  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      {/* Same top inset as the Assistant list's header, so the first row clears the status bar. */}
      <View
        testID="agents-header"
        style={[styles.header, { paddingTop: Math.max(insets.top, 20) + 8 }]}
      >
        <Text accessibilityRole="header" style={[styles.heading, { color: tokens.foreground }]}>
          {t("Agents")}
        </Text>
      </View>
      {message ? (
        <View style={styles.center}>
          <Text style={[styles.message, { color: tokens.mutedForeground }]}>{message}</Text>
          {failed ? (
            <Pressable accessibilityRole="button" onPress={() => void refetch()}>
              <Text style={[styles.message, { color: tokens.foreground }]}>{t("Try again")}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.mutedForeground} />
        </View>
      ) : (
        <FlatList<Row>
          style={styles.list}
          data={rows}
          keyExtractor={(row) => row.id}
          renderItem={({ item }) => (
            <AgentRow
              row={item}
              selected={item.id === selectedId}
              onPress={() => onSelect(item.id)}
            />
          )}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews
          refreshing={pulling}
          onRefresh={() => {
            setPulling(true);
            void refetch().finally(() => setPulling(false));
          }}
          ListEmptyComponent={
            <Text style={[styles.message, styles.empty, { color: tokens.mutedForeground }]}>
              {t("No agents yet")}
            </Text>
          }
          ListFooterComponent={
            hidden ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setShowOlder(true)}
                style={styles.older}
              >
                <Text style={[styles.message, { color: tokens.foreground }]}>
                  {t("Show older")}
                </Text>
              </Pressable>
            ) : undefined
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 10 },
  heading: { fontSize: 28, lineHeight: 34, fontWeight: "700" },
  list: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  message: { fontSize: 17, textAlign: "center" },
  empty: { marginTop: 48 },
  older: { alignItems: "center", paddingVertical: 16 },
});
