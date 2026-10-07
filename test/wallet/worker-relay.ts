import { createRequire } from "node:module";
import { createHash } from "node:crypto";

interface Socket { send(value: string): void; terminate(): void; on(event: "message", listener: (value: Buffer) => void): void }
interface Server { clients: Set<Socket>; address(): { port: number }; on(event: "connection", listener: (socket: Socket) => void): void; once(event: string, listener: (...args: unknown[]) => void): void; close(callback: (error?: Error) => void): void }

export const createWorkerRelay = async (manifest: URL = new URL("../../package.json", import.meta.url)) => {
  const require = createRequire(manifest);
  const signClient = createRequire(require.resolve("@walletconnect/sign-client"));
  const core = createRequire(signClient.resolve("@walletconnect/core"));
  const connection = createRequire(core.resolve("@walletconnect/jsonrpc-ws-connection"));
  const { Server } = connection("ws") as { Server: new (options: { host: string; port: number }) => Server };
  const server = new Server({ host: "127.0.0.1", port: 0 });
  const methods: string[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id: number; method: string; params: { topic?: string; topics?: string[] } };
      methods.push(message.method);
      const subscription = (topic: string) => createHash("sha256").update(topic).digest("hex");
      const result = message.method === "irn_subscribe" ? subscription(message.params.topic!) :
        message.method === "irn_batchSubscribe" ? message.params.topics!.map(subscription) : true;
      if (!["irn_subscribe", "irn_batchSubscribe", "irn_publish", "irn_unsubscribe", "wc_proposeSession"].includes(message.method)) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported relay method." } }));
      } else socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("listening", () => resolve()); server.once("error", reject); });
  const port = server.address().port;
  return { port, url: `ws://127.0.0.1:${port}/`, methods,
    close: async (): Promise<void> => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))); } };
};
