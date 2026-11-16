import { ClassicHome } from "../components/home/classic-home";
import { BackToChat } from "../components/single-chat/back-to-chat";

/** Single-chat builds reach the classic home (chats, agents, settings) from the chat's menu button. */
export default function MenuRoute() {
  return <ClassicHome aboveTabs={<BackToChat />} />;
}
