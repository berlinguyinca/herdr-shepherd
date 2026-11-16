import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { fetchSpaceActivity } from "../../lib/activity";
import { agentListQuery } from "../../lib/agents";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { queryClient } from "../../lib/query";
import {
  type StatusChip,
  type StatusRow,
  statusChip,
  statusStripRows,
} from "../../lib/status-strip";

const POLL_MS = 15_000;

/** Polled assistant status: the chip summary and the detail rows. Polling pauses when hidden or backgrounded. */
export function useAssistantStatus(): { chip: StatusChip; rows: StatusRow[] } {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => setAppActive(next === "active"));
    return () => sub.remove();
  }, []);
  const refetchInterval = focused && appActive ? POLL_MS : false;
  const agents = useQuery({ ...agentListQuery(false), refetchInterval }, queryClient);
  const activity = useQuery(
    { queryKey: ["single-chat-activity"], queryFn: fetchSpaceActivity, refetchInterval },
    queryClient,
  );
  return {
    chip: statusChip(agents.data?.agents),
    rows: statusStripRows(agents.data?.agents, activity.data?.active ?? [], agents.error),
  };
}

/** Header chip summarising assistant status; toggles the detail panel. */
export function StatusChipButton({
  chip,
  expanded,
  onPress,
}: {
  chip: StatusChip;
  expanded: boolean;
  onPress: () => void;
}) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("Assistant status")}: ${chip.label}`}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={{
        minHeight: 44,
        minWidth: 44,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: 22,
        borderWidth: 1,
        borderColor: chip.tone === "blocked" ? tokens.destructive : tokens.border,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color: chip.tone === "idle" ? tokens.mutedForeground : tokens.foreground,
          fontSize: 13,
        }}
      >
        {chip.label}
        {expanded ? " ▴" : " ▾"}
      </Text>
    </Pressable>
  );
}

/** In-flow list of the active assistants; it pushes the chat down instead of covering it. */
export function StatusPanel({ rows }: { rows: StatusRow[] }) {
  const tokens = useMobileTokens();
  if (rows.length === 0)
    return (
      <Text style={{ color: tokens.mutedForeground, fontSize: 13 }}>{t("No one is working")}</Text>
    );
  return (
    <View accessibilityLabel={t("Assistant status")} style={{ gap: 4 }}>
      {rows.map((row, i) => (
        <Text
          key={`${row.name}-${i}`}
          numberOfLines={2}
          style={{ color: tokens.foreground, fontSize: 13 }}
        >
          {row.name
            ? `${row.state === "blocked" ? t("Blocked") : t("Working")} · ${row.name}${row.line ? `: ${row.line}` : ""}`
            : row.line}
        </Text>
      ))}
    </View>
  );
}
