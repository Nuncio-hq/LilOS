/**
 * Minimal socket contract for the relay transport — browsers, Bun, and the
 * `ws` package all satisfy it structurally, so the runtime stays DOM-free
 * and testable with a scripted fake.
 */
export interface RelaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

export type SocketFactory = (url: string) => RelaySocket;

/** Browser/Bun WebSocket; tests and Node clients inject their own. */
export const defaultSocketFactory: SocketFactory = (url) => {
  const ctor = (globalThis as { WebSocket?: new (u: string) => RelaySocket })
    .WebSocket;
  if (!ctor) {
    throw new Error(
      "no global WebSocket — pass a socketFactory (e.g. the ws package under Node)",
    );
  }
  return new ctor(url);
};

export const SOCKET_OPEN = 1;
