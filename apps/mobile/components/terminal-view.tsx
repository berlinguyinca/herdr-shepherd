import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import WebView, { type WebViewMessageEvent } from "react-native-webview";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useTerminal } from "../lib/terminal";
import {
  createLoadGate,
  createOutputBatcher,
  encodeToWeb,
  type NativeMsg,
  type PageState,
  pageReducer,
  terminalFontSize,
} from "../lib/terminal-bridge";
import { terminalHtml } from "../lib/terminal-html.generated";
import { compactKeyRow } from "../lib/terminal-keys";
import { createTerminalHandler } from "../lib/terminal-view-handler";
import { TerminalKeyRow } from "./terminal-key-row";

const SOURCE = { html: terminalHtml };
// Nothing but the inline page may load.
const ORIGINS = ["about:*"];
const NOTICE_MS = 3000;

/**
 * One agent's terminal: an xterm page in a WebView, wired to the agent's terminal session. A
 * reloaded or crashed page has lost its screen, so it remounts (new key, new client, full
 * replay); so does another agent.
 */
export function TerminalView({
  agentId,
  focused,
  keyboardOffset = 0,
}: {
  agentId: string;
  focused: boolean;
  /** The height above this view that the keyboard must also clear; the parent knows it. */
  keyboardOffset?: number;
}) {
  const [mount, setMount] = useState({ generation: 0, uncapped: false });
  return (
    <TerminalPage
      key={`${agentId}:${mount.generation}`}
      agentId={agentId}
      focused={focused}
      keyboardOffset={keyboardOffset}
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
  keyboardOffset,
  uncapped,
  onReload,
}: {
  agentId: string;
  focused: boolean;
  keyboardOffset: number;
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

  // The key row's display state; the handler owns the sticky Ctrl and the cursor mode.
  const [ctrl, setCtrl] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [notice, setNotice] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const softKeyboardVisible = useKeyboardState((state) => state.isVisible);
  // The handler is made once; what it calls is always the latest render's.
  const deps = {
    ready: () => advance("ready"),
    write,
    resize,
    // Clipboard text is never logged: it can hold anything.
    readClipboard: () => Clipboard.getStringAsync(),
    writeClipboard: (text: string) => Clipboard.setStringAsync(text),
    send,
    onCtrl: setCtrl,
    onSelection: setHasSelection,
    onNotice: () => {
      setNotice(true);
      clearTimeout(noticeTimer.current);
      noticeTimer.current = setTimeout(() => setNotice(false), NOTICE_MS);
    },
  };
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const handler = useMemo(
    () =>
      createTerminalHandler({
        ready: () => depsRef.current.ready(),
        write: (bytes) => depsRef.current.write(bytes),
        resize: (rows, cols) => depsRef.current.resize(rows, cols),
        readClipboard: () => depsRef.current.readClipboard(),
        writeClipboard: (text) => depsRef.current.writeClipboard(text),
        send: (msg) => depsRef.current.send(msg),
        onCtrl: (on) => depsRef.current.onCtrl(on),
        onSelection: (has) => depsRef.current.onSelection(has),
        onNotice: () => depsRef.current.onNotice(),
      }),
    [],
  );

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

  const onMessage = (event: WebViewMessageEvent) => handler.onMessage(event.nativeEvent.data);

  const overlay =
    state === "connecting"
      ? t("Connecting…")
      : state === "ended"
        ? t("Session ended")
        : state === "taken_over"
          ? t("Opened elsewhere")
          : state === "error"
            ? t("Connection lost. Retrying…")
            : notice
              ? t("Too large to copy or paste")
              : null;

  return (
    <KeyboardAvoidingView
      behavior="padding"
      keyboardVerticalOffset={keyboardOffset}
      style={styles.fill}
    >
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
        // An iPad with no soft keyboard showing is taken to have a hardware keyboard, so the row
        // shrinks. An iPad whose keyboard is only hidden gets the compact row too, and the
        // toggle then reads "Show keyboard".
        compact={compactKeyRow({
          isPad: Platform.OS === "ios" && Platform.isPad,
          softKeyboardVisible,
        })}
        onKey={handler.pressKey}
        onToggleCtrl={handler.toggleCtrl}
        onToggleKeyboard={() => send({ t: "keyboard", on: !softKeyboardVisible })}
        onPaste={() => void handler.paste()}
        onCopy={handler.copy}
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
