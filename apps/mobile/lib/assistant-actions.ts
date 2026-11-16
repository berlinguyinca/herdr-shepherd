import type { Bot } from "@rakazo/contracts";

/** Request for a new assistant; rejects a blank name and trims name and role. */
export function createAssistantInput(name: string, role?: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Assistant name is required");
  return {
    name: trimmed,
    instructions: role?.trim() ?? "",
    notifyOnFinish: true,
    computerMode: "team" as const,
  };
}

/** Request marking one assistant as the default the app opens into. */
export function setDefaultInput(botId: string) {
  if (!botId) throw new Error("Assistant id is required");
  return { botId, isDefault: true as const };
}

// api pulls in react-native, so it is loaded on first call to keep the builders above unit-testable.
export async function createAssistant(name: string, role?: string): Promise<Bot> {
  const input = createAssistantInput(name, role);
  const { rpc } = await import("./api");
  return rpc("bots/create", input);
}

export async function setDefaultAssistant(botId: string): Promise<void> {
  const input = setDefaultInput(botId);
  const { rpc } = await import("./api");
  await rpc("bots/update", input);
}
