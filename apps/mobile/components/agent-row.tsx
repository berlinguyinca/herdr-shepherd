import { Pressable, StyleSheet, Text, View } from "react-native";
import { agentStatus } from "../lib/agent-order";
import type { AgentRow as Row } from "../lib/agents";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";

/** The label and color an agent status reads with. */
export function useAgentStatus(raw: Row["status"]) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const status = agentStatus(raw);
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
  return { status, label: labels[status], color };
}

/** One agent: name and machine, a status chip, and a one-line summary. Never shows the id. */
export function AgentRow({
  row,
  onPress,
  selected = false,
}: {
  row: Row;
  onPress?: () => void;
  selected?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { status, label, color } = useAgentStatus(row.status);
  const needsYou = status === "blocked" || status === "done";
  const name = row.name.trim();
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityState={{ selected }}
      disabled={!onPress}
      onPress={onPress}
      style={[
        styles.row,
        { borderBottomColor: tokens.border },
        needsYou ? { borderLeftColor: color, borderLeftWidth: 3 } : null,
        selected ? styles.selected : null,
      ]}
    >
      <View style={styles.top}>
        <View style={styles.title}>
          <Text
            testID="agent-name"
            style={[styles.name, { color: tokens.foreground }]}
            numberOfLines={1}
          >
            {name || t("Unknown")}
          </Text>
          {row.machine ? (
            <Text
              testID="agent-row-machine"
              style={[styles.machine, { color: tokens.mutedForeground }]}
              numberOfLines={1}
            >
              {row.machine}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.chip, { color, borderColor: color }]}>{label}</Text>
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
  // The Assistant list's selected row: inset and rounded, in the same fill.
  selected: {
    marginHorizontal: 12,
    paddingHorizontal: 4,
    borderRadius: 12,
    backgroundColor: native.fillPressed,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  // The name gives way first: the machine and the chip keep their room.
  title: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 6 },
  name: { flexShrink: 1, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  machine: { flexShrink: 0, maxWidth: "45%", fontSize: 17, lineHeight: 22 },
  chip: {
    flexShrink: 0,
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
