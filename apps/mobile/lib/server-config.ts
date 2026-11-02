/** Shared by connection settings and reporting before the full API module can load. */
export const API_BASE_STORAGE_KEY = "rakazo.api_base";
export const LOCAL_API = "http://127.0.0.1:3100";
/** This fork talks to one server only: the owner's own dashboard (EXPO_PUBLIC_PERSONAL_SERVER_URL). EXPO_PUBLIC_PERSONAL_SERVER_ONLY=false restores upstream's server choice. */
export const personalServerOnly = () => process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY !== "false";
export const DEFAULT_API =
  process.env.EXPO_PUBLIC_PERSONAL_SERVER_URL ?? process.env.EXPO_PUBLIC_API_URL ?? LOCAL_API;
