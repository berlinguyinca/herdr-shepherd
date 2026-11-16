import type { Bot } from "@rakazo/contracts";
import { newClientId } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput } from "react-native";
import { rpc } from "../../lib/api";
import { assignSendInput } from "../../lib/assign-message";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { errorText } from "../../lib/user-error";
import { Sheet } from "./assistant-picker";

/**
 * Hands work to an agent or role by messaging the default assistant ("Assign <who>: <task>") through
 * the ordinary send path. Existing assistants are offered as quick picks; any role can be typed.
 */
export function AssignSheet({
  defaultBotId,
  onClose,
  onSent,
}: {
  defaultBotId: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const tokens = useMobileTokens();
  const [target, setTarget] = useState("");
  const [task, setTask] = useState("");
  const [bots, setBots] = useState<Bot[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void rpc("bots/list")
      .then((list) => setBots(list.filter((b) => !b.archivedAt && b.id !== defaultBotId)))
      .catch(() => setBots([]));
  }, [defaultBotId]);
  const input = assignSendInput(defaultBotId, { target, task }, newClientId());
  const submit = async () => {
    if (busy || !input) return;
    setBusy(true);
    try {
      await rpc("threads/send", input);
      onSent();
    } catch (error) {
      Alert.alert(t("Could not assign"), errorText(error));
      setBusy(false);
    }
  };
  const field = {
    color: tokens.foreground,
    fontSize: 16,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: 10,
    padding: 12,
    minHeight: 44,
  };
  return (
    <Sheet title={t("Assign work")} onClose={onClose}>
      <TextInput
        accessibilityLabel={t("Agent or role")}
        placeholder={t("Agent or role")}
        placeholderTextColor={tokens.mutedForeground}
        value={target}
        onChangeText={setTarget}
        autoCapitalize="words"
        style={field}
      />
      {bots.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {bots.map((bot) => (
            <Pressable
              key={bot.id}
              accessibilityRole="button"
              accessibilityLabel={bot.name}
              onPress={() => setTarget(bot.name)}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: 14,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: tokens.border,
              }}
            >
              <Text style={{ color: tokens.foreground, fontSize: 14 }}>{bot.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <TextInput
        accessibilityLabel={t("Task")}
        placeholder={t("Task")}
        placeholderTextColor={tokens.mutedForeground}
        value={task}
        onChangeText={setTask}
        multiline
        style={{ ...field, minHeight: 120, textAlignVertical: "top" }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !input }}
        onPress={() => void submit()}
        style={{
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          opacity: input ? 1 : 0.4,
        }}
      >
        <Text style={{ color: tokens.foreground, fontSize: 17, fontWeight: "600" }}>
          {busy ? t("Sending…") : t("Send")}
        </Text>
      </Pressable>
    </Sheet>
  );
}
