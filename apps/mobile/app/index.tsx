import { ClassicHome } from "../components/home/classic-home";
import { SingleChatHome } from "../components/single-chat/single-chat-home";
import { singleChatOnly } from "../lib/server-config";

export { HomeSession, InboxPane } from "../components/home/home-session";

export default function HomeRoute() {
  // Fixed per build, so this never changes which hooks run.
  return singleChatOnly() ? <SingleChatHome /> : <ClassicHome />;
}
