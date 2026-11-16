import { useRouter } from "expo-router";
import { Pressable, Text } from "react-native";
import { t } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";

/** Bar on the single-chat menu that returns to the chat. */
export function BackToChat() {
  const router = useRouter();
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("Back to chat")}
      onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
      style={{
        minHeight: 44,
        justifyContent: "center",
        alignItems: "center",
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        backgroundColor: tokens.background,
      }}
    >
      <Text style={{ color: tokens.foreground, fontSize: 16, fontWeight: "600" }}>
        {t("Back to chat")}
      </Text>
    </Pressable>
  );
}
