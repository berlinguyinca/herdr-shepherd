import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { fetchSpaceActivity } from "../../lib/activity";
import { agentListQuery } from "../../lib/agents";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { queryClient } from "../../lib/query";
import { statusStripRows } from "../../lib/status-strip";

const POLL_MS = 15_000;

/** Read-only band listing assistants that are working or blocked; hidden when none are. */
export function StatusStrip() {
  const tokens = useMobileTokens();
  const agents = useQuery({ ...agentListQuery(false), refetchInterval: POLL_MS }, queryClient);
  const activity = useQuery(
    {
      queryKey: ["single-chat-activity"],
      queryFn: fetchSpaceActivity,
      refetchInterval: POLL_MS,
    },
    queryClient,
  );
  const rows = statusStripRows(agents.data?.agents, activity.data?.active ?? [], agents.error);
  if (rows.length === 0) return null;
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={t("Assistant status")}
      style={{
        position: "absolute",
        top: 48,
        left: 12,
        right: 12,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 10,
        backgroundColor: tokens.background,
        borderWidth: 1,
        borderColor: tokens.foreground,
        opacity: 0.92,
      }}
    >
      {rows.map((row, i) => (
        <Text
          key={`${row.name}-${i}`}
          numberOfLines={1}
          style={{ color: tokens.foreground, fontSize: 12 }}
        >
          {row.name
            ? `${row.state === "blocked" ? t("Blocked") : t("Working")} · ${row.name}${row.line ? `: ${row.line}` : ""}`
            : row.line}
        </Text>
      ))}
    </View>
  );
}
