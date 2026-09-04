import { ChatView } from "../../components/chat/ChatView";

/** Admin chat: same surface as the consoles, plus channel and member management. */
export function ChatPanel() {
  return <ChatView canManage />;
}
