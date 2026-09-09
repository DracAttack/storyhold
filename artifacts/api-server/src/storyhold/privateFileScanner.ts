import { createConnection, type NetConnectOpts } from "node:net";

export const PRIVATE_FILE_MAX_BYTES = 25 * 1024 * 1024;
export type PrivateFileVerdict = "clean" | "suspicious";
export type PrivateFileScanner = (bytes: Buffer) => Promise<PrivateFileVerdict>;

// clamd INSTREAM uses length-prefixed bytes, never private filenames or paths.
// Only local sockets/loopback are supported: clamd TCP has no authentication
// or encryption. A remote scanner needs a separately secured transport.
export function createPrivateFileScanner(env: NodeJS.ProcessEnv = process.env): PrivateFileScanner {
  const socketPath = env.STORYHOLD_CLAMD_SOCKET?.trim();
  const port = Number(env.STORYHOLD_CLAMD_PORT);
  const host = env.STORYHOLD_CLAMD_HOST?.trim() || "127.0.0.1";
  const connection: NetConnectOpts | null = socketPath ? { path: socketPath }
    : Number.isInteger(port) && port > 0 && port <= 65535 && ["127.0.0.1", "::1"].includes(host)
      ? { host, port } : null;
  return async (bytes) => {
    if (!connection) throw new Error("scanner_unavailable");
    if (!bytes.length || bytes.length > PRIVATE_FILE_MAX_BYTES) throw new Error("scan_size_invalid");
    return scanWithClamd(bytes, connection);
  };
}

export function scanWithClamd(bytes: Buffer, connection: NetConnectOpts, timeoutMs = 30_000): Promise<PrivateFileVerdict> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(connection);
    let response = Buffer.alloc(0);
    let sentAll = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("scanner_timeout")), timeoutMs);
    const finish = (error?: Error, verdict?: PrivateFileVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(verdict!);
    };
    socket.on("error", () => finish(new Error("scanner_unavailable")));
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 8192) finish(new Error("scanner_invalid_response"));
    });
    socket.on("end", () => {
      const reply = response.toString("utf8");
      if (sentAll && reply === "stream: OK\0") finish(undefined, "clean");
      else if (/^stream: [^\r\n\0]+ FOUND\0$/u.test(reply)) finish(undefined, "suspicious");
      else finish(new Error("scanner_invalid_response"));
    });
    socket.on("close", () => { if (!settled) finish(new Error("scanner_incomplete_response")); });
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      let offset = 0;
      const send = () => {
        if (settled) return;
        while (offset < bytes.length) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          const frame = Buffer.allocUnsafe(chunk.length + 4);
          frame.writeUInt32BE(chunk.length, 0);
          chunk.copy(frame, 4);
          offset += chunk.length;
          if (!socket.write(frame)) { socket.once("drain", send); return; }
        }
        socket.write(Buffer.alloc(4));
        sentAll = true;
      };
      send();
    });
  });
}
