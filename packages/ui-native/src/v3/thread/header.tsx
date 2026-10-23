import { View } from "react-native";
import { Avatar, Hairline, PersonName, StatusLabel, T, Tag } from "../kit";
import type { ThreadVM } from "./types";

/* The one compact block under the native header (which carries the back
   chevron and the title): who is on it, where it is filed, how it stands. */
export function ThreadHeader({ thread }: { thread: ThreadVM }) {
  return (
    <View>
      <View className="flex-row items-center gap-3 px-5 pt-2 pb-3.5">
        <Avatar person={thread.agent} size={38} />
        <View className="flex-1 gap-1">
          <PersonName person={thread.agent} />
          <View className="flex-row items-center gap-2">
            <Tag>{thread.tag}</Tag>
            {thread.agent.role ? (
              <T
                variant="caption"
                tone="ink3"
                numberOfLines={1}
                className="shrink"
              >
                {thread.agent.role}
              </T>
            ) : null}
          </View>
        </View>
        <StatusLabel status={thread.status} label={thread.statusWord} />
      </View>
      <Hairline />
    </View>
  );
}
