import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useTerminal } from "../lib/terminal";
import {
  base64ToBytes,
  createLoadGate,
  createOutputBatcher,
  decodeFromWeb,
  encodeToWeb,
  type NativeMsg,
  type PageState,
  pageReducer,
  pasteMessage,
  terminalFontSize,
} from "../lib/terminal-bridge";
import { terminalHtml } from "../lib/terminal-html.generated";
import { compactKeyRow, type KeyName, pressRowKey } from "../lib/terminal-keys";
import { TerminalKeyRow } from "./terminal-key-row";

const SOURCE = { html: terminalHtml };
// Nothing but the inline page may load.
const ORIGINS = ["about:*"];

/**
 * One agent's terminal: an xterm page in a WebView, wired to the agent's terminal session. A
 * reloaded or crashed page has lost its screen, so it remounts (new key, new client, full
 * replay); so does another agent.
 */
export function TerminalView({ agentId, focused }: { agentId: string; focused: boolean }) {
  const [mount, setMount] = useState({ generation: 0, uncapped: false });
  return (
    <TerminalPage
      key={`${agentId}:${mount.generation}`}
      agentId={agentId}
      focused={focused}
      uncapped={mount.uncapped}
      onReload={(next) =>
        setMount((m) => ({ generation: m.generation + 1, uncapped: next.uncapped }))
      }
    />
  );
}

function TerminalPage({
  agentId,
  focused,
  uncapped,
  onReload,
}: {
  agentId: string;
  focused: boolean;
  uncapped: boolean;
  onReload: (next: PageState) => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const dark = useResolvedAppearance() === "dark";
  const { fontScale } = useWindowDimensions();
  const { state, write, resize, reopen, onOutput } = useTerminal(agentId);
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const page = useRef<PageState>({ generation: 0, ready: false, dropped: false, uncapped });
  const advance = (event: "ready" | "gone" | "overflow") => {
    const next = pageReducer(page.current, event);
    const reload = next.generation !== page.current.generation;
    page.current = next;
    if (reload) onReload(next);
    else setReady(next.ready);
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const allowLoad = useMemo(createLoadGate, []);
  const send = (msg: NativeMsg) => web.current?.postMessage(encodeToWeb(msg));
  const sendRef = useRef(send);
  sendRef.current = send;

  // The key row's state. Ctrl is held here and in the page, which spends it on a soft key.
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  const [hasSelection, setHasSelection] = useState(false);
  const applicationCursor = useRef(false);
  const softKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const setCtrlOn = (on: boolean) => {
    ctrlRef.current = on;
    setCtrl(on);
    send({ t: "ctrl", on });
  };
  const pressKey = (key: KeyName) => {
    const pressed = pressRowKey(ctrlRef.current, key, {
      applicationCursor: applicationCursor.current,
    });
    if (pressed.bytes.length > 0) write(pressed.bytes);
    if (ctrlRef.current) setCtrlOn(pressed.ctrl);
  };
  const pasteClipboard = async () => {
    // Never logged: the clipboard can hold anything.
    const message = pasteMessage(await Clipboard.getStringAsync());
    if (message) sendRef.current(message);
  };

  const batcher = useMemo(
    () =>
      createOutputBatcher(
        (msg) => sendRef.current(msg),
        (run) => {
          const id = requestAnimationFrame(run);
          return () => cancelAnimationFrame(id);
        },
        {
          maxPendingBytes: uncapped ? Number.POSITIVE_INFINITY : undefined,
          onOverflow: () => advanceRef.current("overflow"),
        },
      ),
    [],
  );
  useEffect(() => {
    const stop = onOutput((chunk) => batcher.push(chunk));
    return () => {
      stop();
      batcher.dispose();
    };
  }, [batcher, onOutput]);
  useEffect(() => batcher.setReady(ready), [batcher, ready]);
  useEffect(() => {
    if (ready) send({ t: "theme", dark });
  }, [ready, dark]);
  const fontSize = terminalFontSize(fontScale);
  useEffect(() => {
    // The page starts at the size injected on load; this follows a change while it is open.
    if (ready) send({ t: "font", size: fontSize });
  }, [ready, fontSize]);
  useEffect(() => {
    if (ready && focused) send({ t: "focus" });
  }, [ready, focused]);

  const onMessage = (event: WebViewMessageEvent) => {
    const msg = decodeFromWeb(event.nativeEvent.data);
    if (!msg) return;
    if (msg.t === "ready") advance("ready");
    else if (msg.t === "in") write(base64ToBytes(msg.b64));
    else if (msg.t === "size") resize(msg.rows, msg.cols);
    else if (msg.t === "copy") void Clipboard.setStringAsync(msg.text);
    else if (msg.t === "ctrlUsed") {
      ctrlRef.current = false;
      setCtrl(false);
    } else if (msg.t === "selection") setHasSelection(msg.has);
    else if (msg.t === "appCursor") applicationCursor.current = msg.on;
    else if (msg.t === "pasteRequest") void pasteClipboard();
  };

  const overlay =
    state === "connecting"
      ? t("Connecting…")
      : state === "ended"
        ? t("Session ended")
        : state === "taken_over"
          ? t("Opened elsewhere")
          : state === "error"
            ? t("Connection lost. Retrying…")
            : null;

  return (
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
      <View style={styles.fill}>
        <WebView
          ref={web}
          source={SOURCE}
          originWhitelist={ORIGINS}
          javaScriptEnabled
          injectedJavaScriptBeforeContentLoaded={`window.__fontSize=${fontSize};window.__dark=${dark};true;`}
          onContentProcessDidTerminate={() => advance("gone")}
          onRenderProcessGone={() => advance("gone")}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={allowLoad}
          setSupportMultipleWindows={false}
          bounces={false}
          scrollEnabled={false}
          overScrollMode="never"
          textZoom={100}
          automaticallyAdjustContentInsets={false}
          hideKeyboardAccessoryView
          keyboardDisplayRequiresUserAction={false}
          style={styles.web}
          containerStyle={styles.web}
        />
        {overlay ? (
          <View
            pointerEvents="box-none"
            style={[
              styles.overlay,
              { backgroundColor: tokens.background, borderColor: tokens.border },
            ]}
          >
            <Text testID="terminal-status" style={[styles.status, { color: tokens.foreground }]}>
              {overlay}
            </Text>
            {state === "taken_over" ? (
              <Pressable
                accessibilityRole="button"
                onPress={reopen}
                style={[styles.button, { borderColor: tokens.border }]}
              >
                <Text style={[styles.buttonLabel, { color: tokens.foreground }]}>
                  {t("Reopen")}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
      <TerminalKeyRow
        ctrl={ctrl}
        keyboardOn={softKeyboardVisible}
        hasSelection={hasSelection}
        compact={compactKeyRow({
          isPad: Platform.OS === "ios" && Platform.isPad,
          softKeyboardVisible,
        })}
        onKey={pressKey}
        onToggleCtrl={() => setCtrlOn(!ctrlRef.current)}
        onToggleKeyboard={() => send({ t: "keyboard", on: !softKeyboardVisible })}
        onPaste={() => void pasteClipboard()}
        onCopy={() => send({ t: "copy" })}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  web: { flex: 1, backgroundColor: "transparent" },
  overlay: {
    position: "absolute",
    top: 8,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  status: { fontSize: 13, lineHeight: 18 },
  button: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonLabel: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
});
