import { connect } from "node:net";
import path from "node:path";
import { STUCK_CLEAR_SOCKET } from "../../packages/engine-fake/src/script";

/** Folder-less chats run in the stack's `LILOS_WORKDIR` (`<home>/work`).
    Connect once the stuck card is visible so the different step can run.
    The engine is already listening; it does not emit that step before this. */
export function releaseStuckClear(home: string): Promise<void> {
  const sockPath = path.join(home, "work", STUCK_CLEAR_SOCKET);
  return new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}
