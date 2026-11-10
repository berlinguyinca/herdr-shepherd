// @vitest-environment jsdom

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
  };
});

import type { ModelCompletionResult } from "./ModelCompletionTest";
import { ModelCompletionTest } from "./ModelCompletionTest";

let root: Root;
let server: ReturnType<typeof createServer>;
let url: string;
let status = 200;
let payload: unknown = {};

/** A real local server answering like an OpenAI-compatible /chat/completions endpoint. */
async function ask(): Promise<ModelCompletionResult> {
  const started = performance.now();
  const response = await fetch(url, { method: "POST", body: "{}" });
  const body = (await response.json()) as {
    error?: { message: string };
    choices?: Array<{ message: { content: string } }>;
  };
  if (!response.ok)
    throw new Error(`Model server returned ${response.status}: ${body.error?.message}`);
  return {
    reply: body.choices?.[0]?.message.content ?? "",
    latencyMs: Math.max(1, Math.round(performance.now() - started)),
  };
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  status = 200;
  payload = { choices: [{ message: { content: "OK" } }] };
  server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  await new Promise((resolve) => server.close(resolve));
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const button = () => document.querySelector("button") as HTMLButtonElement;
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 50))));

function render(props: { disabled?: boolean; resetKey?: string } = {}) {
  return act(async () =>
    root.render(<ModelCompletionTest run={ask} resetKey={props.resetKey ?? "a"} {...props} />),
  );
}

it("shows the reply and latency of a working model", async () => {
  await render();
  await act(async () => button().click());
  await settle();
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent).toMatch(/Works\. The model replied “OK” in \d+ ms\./);
});

it("shows a model that answered without text as working", async () => {
  payload = { choices: [{ message: { content: "" } }] };
  await render();
  await act(async () => button().click());
  await settle();
  expect(document.querySelector('[role="status"]')?.textContent).toMatch(
    /Works\. The model answered in \d+ ms\./,
  );
});

it("shows the provider's error when the request fails", async () => {
  status = 401;
  payload = { error: { message: "Incorrect API key" } };
  await render();
  await act(async () => button().click());
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Model server returned 401: Incorrect API key",
  );
});

it("masks anything key-shaped in an error", async () => {
  status = 401;
  payload = { error: { message: "bad key sk-abcdefghijklmnop" } };
  await render();
  await act(async () => button().click());
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("sk-abcdefghij");
});

it("clears the result when what is being tested changes", async () => {
  await render({ resetKey: "a" });
  await act(async () => button().click());
  await settle();
  expect(document.querySelector('[role="status"]')).not.toBeNull();
  await render({ resetKey: "b" });
  expect(document.querySelector('[role="status"]')).toBeNull();
});

it("is disabled until there is something to test", async () => {
  await render({ disabled: true });
  expect(button().disabled).toBe(true);
});
