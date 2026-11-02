import { Pressable, StyleSheet, Text, View } from "react-native";
import { agentStatus } from "../lib/agent-order";
import type { AgentRow as Row } from "../lib/agents";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** One agent: name and machine, a status chip, and a one-line summary. Never shows the id. */
export function AgentRow({ row, onPress }: { row: Row; onPress?: () => void }) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const status = agentStatus(row.status);
  const labels = {
    blocked: t("Blocked"),
    done: t("Done"),
    working: t("Working"),
    idle: t("Idle"),
    unknown: t("Unknown"),
    closed: t("Closed"),
  };
  const color = {
    blocked: tokens.warning,
    done: tokens.success,
    working: tokens.foreground,
    idle: tokens.mutedForeground,
    unknown: tokens.mutedForeground,
    closed: tokens.faintForeground,
  }[status];
  const needsYou = status === "blocked" || status === "done";
  const name = row.name.trim();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={[
        styles.row,
        { borderBottomColor: tokens.border },
        needsYou ? { borderLeftColor: color, borderLeftWidth: 3 } : null,
      ]}
    >
      <View style={styles.top}>
        <Text style={[styles.title, { color: tokens.foreground }]} numberOfLines={1}>
          <Text testID="agent-name" style={styles.name}>
            {name || t("Unknown")}
          </Text>
          {row.machine ? (
            <Text style={{ color: tokens.mutedForeground }}>{` ${row.machine}`}</Text>
          ) : null}
        </Text>
        <Text style={[styles.chip, { color, borderColor: color }]}>{labels[status]}</Text>
      </View>
      {needsYou ? (
        <Text testID="needs-you" style={[styles.needs, { color }]}>
          {t("Needs you")}
        </Text>
      ) : null}
      {row.summary ? (
        <Text style={[styles.summary, { color: tokens.mutedForeground }]} numberOfLines={1}>
          {row.summary}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 3,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
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
  needs: { fontSize: 13, lineHeight: 17, fontWeight: "600" },
  summary: { fontSize: 15, lineHeight: 19 },
});
