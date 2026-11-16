import { BackToChat } from "../components/single-chat/back-to-chat";
import { ClassicHomeRoute } from "./index";

/** Single-chat builds reach the classic home (chats, agents, settings) from the chat's menu button. */
export default function MenuRoute() {
  return <ClassicHomeRoute aboveTabs={<BackToChat />} />;
}
