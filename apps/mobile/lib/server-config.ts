/** Shared by connection settings and reporting before the full API module can load. */
export const API_BASE_STORAGE_KEY = "rakazo.api_base";
export const LOCAL_API = "http://127.0.0.1:3100";
/** Shepherd connects to any Herdr server the user enters. A build for one person's own dashboard can pin it:
 * EXPO_PUBLIC_PERSONAL_SERVER_ONLY=true plus EXPO_PUBLIC_PERSONAL_SERVER_URL locks the app to that server. */
export const personalServerOnly = () => process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY === "true";
export const DEFAULT_API =
  process.env.EXPO_PUBLIC_PERSONAL_SERVER_URL ?? process.env.EXPO_PUBLIC_API_URL ?? LOCAL_API;
/** The server this build was made for, if any. A public build has none and asks the user for one on first launch. */
export const pinnedServerUrl = () =>
  process.env.EXPO_PUBLIC_PERSONAL_SERVER_URL ?? process.env.EXPO_PUBLIC_API_URL;
