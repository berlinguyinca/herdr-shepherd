import { Redirect } from "expo-router";

/** Personal-server fork: there is no server to choose. */
export default function ServerRoute() {
  return <Redirect href="/sign-in" />;
}
