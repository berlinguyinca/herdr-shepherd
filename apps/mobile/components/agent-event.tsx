import { ChatMarkdown } from "@rakazo/chat-ui/native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentEvent as Event } from "../lib/agents";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

type Data = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function duration(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/**
 * One event of an agent's conversation: a message as a bubble, a tool call as a single line that
 * opens to its output, other kinds as a very small neutral line or nothing. `onExpand` fetches the
 * full event when the server cut its text or output.
 */
export function AgentEvent({
  event,
  onExpand,
}: {
  event: Event;
  onExpand?: (event: Event) => Promise<Event | undefined>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Event | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A newer revision of the same event (a tool call that finished) replaces what was fetched.
  const shown = full && full.rev === event.rev ? full : event;
  useEffect(() => {
    setFull((current) => (current && current.rev !== event.rev ? null : current));
  }, [event.rev]);

  const data: Data = shown.data;
  const withheld = data.withheld === true;
  const more = data.output_more === true || data.text_more === true || data.diff_more === true;
  const fetchFull = async () => {
    if (!more || full?.rev === event.rev || !onExpand || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      const next = await onExpand(event);
      if (next) setFull(next);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  const chip = withheld ? (
    <Text
      testID="withheld"
      style={[styles.chip, { color: tokens.warning, borderColor: tokens.warning }]}
    >
      {str(data.withheld_reason)
        ? t("Withheld: {reason}", { reason: str(data.withheld_reason) })
        : t("Withheld")}
    </Text>
  ) : null;

  if (event.kind === "message") {
    const user = data.role === "user";
    const text = str(data.text);
    return (
      <View style={[styles.messageRow, user ? styles.end : styles.start]}>
        <View
          testID={user ? "bubble-user" : "bubble-assistant"}
          style={[styles.bubble, { backgroundColor: user ? tokens.chatUser : tokens.secondary }]}
        >
          {chip}
          {!withheld && text ? (
            <ChatMarkdown
              palette={user ? { ...tokens, foreground: tokens.chatUserForeground } : tokens}
              colorScheme={colorScheme}
            >
              {text}
            </ChatMarkdown>
          ) : null}
          {!withheld && !text ? (
            <Text style={{ color: tokens.mutedForeground }}>{t("Empty message")}</Text>
          ) : null}
          {!withheld && data.text_more === true && onExpand && full?.rev !== event.rev ? (
            <Pressable accessibilityRole="button" onPress={() => void fetchFull()}>
              <Text style={[styles.small, { color: tokens.mutedForeground }]}>
                {loading
                  ? t("Loading")
                  : failed
                    ? t("Couldn't load the full text. Tap to retry.")
                    : t("Show full message")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  if (event.kind === "tool") {
    const status = str(data.status) || "running";
    const icon =
      status === "ok" ? "✓" : status === "error" ? "✕" : status === "running" ? "…" : "!";
    const color =
      status === "ok" ? tokens.success : status === "error" ? tokens.destructive : tokens.warning;
    const statusLabel =
      status === "ok"
        ? t("Succeeded")
        : status === "error"
          ? t("Failed")
          : status === "running"
            ? t("Running")
            : t("Interrupted");
    const output = str(data.output);
    const time = duration(data.duration_ms);
    return (
      <View style={styles.toolWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            // After a failed fetch a tap retries instead of collapsing.
            if (open && failed) return void fetchFull();
            setOpen(!open);
            if (!open) void fetchFull();
          }}
          style={[styles.tool, { borderColor: tokens.border }]}
        >
          <Text testID="tool-status" accessibilityLabel={statusLabel} style={{ color }}>
            {icon}
          </Text>
          <Text style={[styles.toolName, { color: tokens.foreground }]} numberOfLines={1}>
            {str(data.tool) || t("Tool")}
            {str(data.args_preview) ? (
              <Text style={{ color: tokens.mutedForeground }}>{` ${str(data.args_preview)}`}</Text>
            ) : null}
          </Text>
          {time ? (
            <Text style={[styles.small, { color: tokens.mutedForeground }]}>{time}</Text>
          ) : null}
        </Pressable>
        {chip}
        {open && failed ? (
          <Pressable accessibilityRole="button" onPress={() => void fetchFull()}>
            <Text style={[styles.small, { color: tokens.warning }]}>
              {t("Couldn't load the full output. Tap to retry.")}
            </Text>
          </Pressable>
        ) : null}
        {open && !withheld ? (
          <Text
            selectable
            testID="tool-output"
            style={[
              styles.output,
              { color: tokens.mutedForeground, backgroundColor: tokens.secondary },
            ]}
          >
            {loading ? t("Loading") : output || t("No output")}
          </Text>
        ) : null}
      </View>
    );
  }

  if (withheld) return <View style={styles.note}>{chip}</View>;
  const phase = str(data.phase);
  const line =
    event.kind === "lifecycle" && phase
      ? t("Session {phase}", { phase })
      : event.kind === "file" && str(data.path)
        ? str(data.path)
        : "";
  if (!line) return null;
  return (
    <View style={styles.note}>
      <Text style={[styles.small, { color: tokens.faintForeground }]} numberOfLines={1}>
        {line}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  messageRow: { paddingHorizontal: 12, paddingVertical: 4, flexDirection: "row" },
  start: { justifyContent: "flex-start" },
  end: { justifyContent: "flex-end" },
  bubble: { maxWidth: "88%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, gap: 6 },
  chip: {
    alignSelf: "flex-start",
    fontSize: 12,
    lineHeight: 16,
    paddingHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: "hidden",
  },
  toolWrap: { paddingHorizontal: 12, paddingVertical: 3, gap: 4 },
  tool: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  toolName: { flex: 1, fontSize: 14, lineHeight: 18, fontWeight: "600" },
  output: { fontFamily: "Menlo", fontSize: 12, lineHeight: 16, padding: 8, borderRadius: 8 },
  small: { fontSize: 12, lineHeight: 16 },
  note: { paddingHorizontal: 16, paddingVertical: 2, alignItems: "center" },
});
