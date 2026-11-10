import type { ModelApiProtocol } from "@rakazo/contracts";
import type { OpenAiCompatibleUrlPolicy } from "./openai-compatible-url.js";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  isPrivateOpenAiCompatibleHostname,
} from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

const TEST_PROMPT = "Reply with OK.";
const TEST_MAX_TOKENS = 32;
const TEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REPLY_CHARS = 200;
const ANTHROPIC_MESSAGES_VERSION = "2023-06-01";

export type ModelCompletionTestInput = {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  headers?: Record<string, string>;
  apiProtocol?: ModelApiProtocol;
};

export type ModelCompletionTestResult = { reply: string; latencyMs: number };

type WireRequest = { path: string; headers: Record<string, string>; body: unknown };

function wireRequest(input: ModelCompletionTestInput): WireRequest {
  const key = input.apiKey?.trim();
  const base = { Accept: "application/json", "Content-Type": "application/json" };
  const messages = [{ role: "user", content: TEST_PROMPT }];
  switch (input.apiProtocol) {
    case "responses":
      return {
        path: "responses",
        headers: { ...base, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: { model: input.modelId, input: TEST_PROMPT, max_output_tokens: TEST_MAX_TOKENS },
      };
    case "anthropic-messages":
      return {
        path: "messages",
        headers: {
          ...base,
          "anthropic-version": ANTHROPIC_MESSAGES_VERSION,
          ...(key ? { "x-api-key": key } : {}),
        },
        body: { model: input.modelId, max_tokens: TEST_MAX_TOKENS, messages },
      };
    default:
      return {
        path: "chat/completions",
        headers: { ...base, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: { model: input.modelId, max_tokens: TEST_MAX_TOKENS, stream: false, messages },
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function textParts(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => {
      const text = asRecord(part).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** The model's short reply across the three wire shapes; empty when it produced no text. */
function replyText(protocol: ModelApiProtocol | undefined, body: unknown): string {
  const root = asRecord(body);
  if (protocol === "anthropic-messages") return textParts(root.content);
  if (protocol === "responses") {
    if (typeof root.output_text === "string") return root.output_text;
    return Array.isArray(root.output)
      ? root.output.map((item) => textParts(asRecord(item).content)).join("")
      : "";
  }
  const choice = asRecord(Array.isArray(root.choices) ? root.choices[0] : undefined);
  return textParts(asRecord(choice.message).content);
}

function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (value) out = out.split(value).join("•••");
  }
  return out;
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Model server response is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The provider's own error message, only when the body is JSON shaped like a provider error
 * (`error.message` or `message`). Anything else is never echoed, so a probed server cannot
 * use this route to read arbitrary response text.
 */
export function providerErrorDetail(raw: string): string {
  try {
    const root = asRecord(JSON.parse(raw));
    const nested = asRecord(root.error).message;
    if (typeof nested === "string") return nested;
    if (typeof root.message === "string") return root.message;
  } catch {
    // Not JSON: nothing to echo.
  }
  return "";
}

/**
 * Sends one tiny completion request to a model and returns its short reply and the round-trip
 * time. Follows the same address policy as `probeOpenAiCompatibleModels`; the key and custom
 * headers are never echoed in a returned error.
 */
export async function testModelCompletion(
  input: ModelCompletionTestInput,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
  opts?: OpenAiCompatibleUrlPolicy,
): Promise<ModelCompletionTestResult> {
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error("Choose a model to test.");
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl, opts);
  assertHttpsForKeyedOpenAiCompatibleUrl(
    baseUrl,
    input.apiKey,
    Object.keys(input.headers ?? {}).length > 0,
  );
  const wire = wireRequest({ ...input, modelId });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const secrets = [input.apiKey, ...Object.values(input.headers ?? {})];
  const safeFetch = createOpenAiCompatibleFetch(fetchImpl, undefined, {
    ...opts,
    headers: input.headers,
  });
  const started = performance.now();
  try {
    const response = await safeFetch(new URL(wire.path, `${baseUrl.href}/`).href, {
      method: "POST",
      headers: wire.headers,
      body: JSON.stringify(wire.body),
      redirect: "error",
      signal: merged,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Model server redirects are not allowed.");
    }
    const text = await readBounded(response);
    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    if (!response.ok) {
      // A private host's body is never echoed; only its status code is.
      const detail = isPrivateOpenAiCompatibleHostname(baseUrl.hostname)
        ? ""
        : redact(providerErrorDetail(text), secrets).trim().slice(0, MAX_REPLY_CHARS);
      throw new Error(`Model server returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Model server returned invalid JSON.");
    }
    const reply = redact(replyText(input.apiProtocol, parsed), secrets)
      .trim()
      .slice(0, MAX_REPLY_CHARS);
    return { reply, latencyMs };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The model did not answer within 15 seconds.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
