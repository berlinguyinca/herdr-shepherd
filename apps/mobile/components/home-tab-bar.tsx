import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

export type HomeTab = "assistant" | "agents";

/** The bottom bar of the two home screens: the chat list (Assistant) and the Agents list. */
export function HomeTabBar({ active }: { active: HomeTab }) {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const insets = useSafeAreaInsets();
  const tabs: { key: HomeTab; label: string; open: () => void }[] = [
    { key: "assistant", label: t("Assistant"), open: () => router.dismissTo("/") },
    { key: "agents", label: t("Agents"), open: () => router.push("/agents") },
  ];
  return (
    <View
      style={[
        styles.bar,
        {
          paddingBottom: insets.bottom,
          backgroundColor: tokens.background,
          borderTopColor: tokens.border,
        },
      ]}
    >
      {tabs.map(({ key, label, open }) => {
        const selected = key === active;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            onPress={selected ? undefined : open}
            style={styles.tab}
          >
            <Text
              style={[
                styles.label,
                { color: selected ? tokens.foreground : tokens.mutedForeground },
                selected ? styles.selected : null,
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 48 },
  label: { fontSize: 15, lineHeight: 19 },
  selected: { fontWeight: "600" },
});
