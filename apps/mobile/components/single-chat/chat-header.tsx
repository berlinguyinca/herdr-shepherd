import type { Bot, RunActivityRow } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { rpc } from "../../lib/api";
import { pickDefaultBot } from "../../lib/default-assistant";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { AssignSheet } from "./assign-sheet";
import { AssistantPickerModal } from "./assistant-picker";
import { StatusChipButton, StatusPanel, useAssistantStatus } from "./status-strip";

/**
 * Single-chat layout: a header row below the safe area (menu, assistant name, status chip), an
 * expandable status panel that pushes the chat down, and the chat in all the remaining space.
 */
export function SingleChatHeader({
  botId,
  name,
  onSwitch,
  children,
}: {
  botId: string | null;
  name: string | null;
  onSwitch: (bot: Bot) => void;
  children: ReactNode;
}) {
  const tokens = useMobileTokens();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { chip, rows } = useAssistantStatus();
  const [picking, setPicking] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [runs, setRuns] = useState<RunActivityRow[]>([]);
  // Only the latest request may apply, and none after unmount; a failure keeps the last good data.
  const requestId = useRef(0);
  useEffect(
    () => () => {
      requestId.current = -1;
    },
    [],
  );
  const loadBots = useCallback(() => {
    const id = ++requestId.current;
    void Promise.all([
      rpc("bots/list"),
      rpc("runs/list", { filter: "recent" })
        .then((r) => r.runs)
        .catch(() => []),
    ])
      .then(([list, runs]) => {
        if (requestId.current !== id) return;
        setBots(list);
        setRuns(runs);
      })
      .catch(() => undefined); // keep the last good bots and runs
  }, []);
  // Reloaded when the picker closes, since it can change the default.
  useEffect(() => {
    if (!picking) loadBots();
  }, [picking, loadBots]);
  const current = bots.find((b) => b.id === botId);
  const defaultBot = pickDefaultBot(bots, runs);
  const label = { color: tokens.foreground, fontSize: 16 };
  return (
    <View style={{ flex: 1, backgroundColor: tokens.background }}>
      <View
        style={{
          paddingTop: insets.top,
          paddingLeft: Math.max(insets.left, 8),
          paddingRight: Math.max(insets.right, 8),
          paddingBottom: 6,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Menu")}
            hitSlop={4}
            onPress={() => router.push("/menu")}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...label, fontSize: 22 }}>☰</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t("Switch assistant")}: ${name || t("Assistants")}`}
            onPress={() => setPicking(true)}
            style={{ flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Text numberOfLines={1} style={{ ...label, fontWeight: "600", flexShrink: 1 }}>
              {name || t("Assistants")}
            </Text>
            {current?.isDefault ? (
              <Text style={{ color: tokens.mutedForeground, fontSize: 12 }}>{t("Default")}</Text>
            ) : null}
          </Pressable>
          <StatusChipButton
            chip={chip}
            expanded={expanded}
            onPress={() => setExpanded((v) => !v)}
          />
        </View>
        {expanded ? (
          <View style={{ gap: 8, paddingHorizontal: 8 }}>
            <StatusPanel rows={rows} />
            {defaultBot ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Assign work")}
                onPress={() => setAssigning(true)}
                style={{ minHeight: 44, justifyContent: "center" }}
              >
                <Text style={{ ...label, fontWeight: "600" }}>{t("Assign work")}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}>{children}</View>
      {picking ? (
        <AssistantPickerModal
          currentBotId={botId}
          onClose={() => setPicking(false)}
          onSwitch={(bot) => {
            setPicking(false);
            onSwitch(bot);
          }}
        />
      ) : null}
      {assigning && defaultBot ? (
        <AssignSheet
          defaultBotId={defaultBot.id}
          onClose={() => setAssigning(false)}
          onSent={() => {
            setAssigning(false);
            setExpanded(false);
          }}
        />
      ) : null}
    </View>
  );
}
