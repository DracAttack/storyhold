import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createPrivateFileScanner, PRIVATE_FILE_MAX_BYTES, scanWithClamd } from "./privateFileScanner";
import { antivirusTestBytes, runPrivateFileScannerCheck, verifyPrivateFileScanner } from "./privateFileScannerCheck";

test("readiness requires BOTH clean approval and standard test detection", async () => {
  assert.equal(antivirusTestBytes().length, 68);
  assert.equal(createHash("md5").update(antivirusTestBytes()).digest("hex"), "44d88612fea8a8f36de82e1278abb02f");
  await verifyPrivateFileScanner(async (bytes) => bytes.equals(antivirusTestBytes()) ? "suspicious" : "clean");
  await assert.rejects(verifyPrivateFileScanner(async () => "clean"), /scanner_missed_test_pattern/);
  await assert.rejects(verifyPrivateFileScanner(async () => "suspicious"), /scanner_rejected_clean_probe/);
  await assert.rejects(verifyPrivateFileScanner(async () => { throw new Error("scanner unavailable"); }));
});

test("readiness failure is actionable and does not leak private connection paths", async () => {
  const output: string[] = [];
  assert.equal(await runPrivateFileScannerCheck({}, (line) => output.push(line)), 1);
  assert.match(output[0]!, /Antivirus check FAILED/);
  assert.match(output[0]!, /STORYHOLD_CLAMD_SOCKET/);
  assert.match(output[0]!, /current signatures/);
});

test("operator check exercises the same INSTREAM client used for uploads", async () => {
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let pending = Buffer.alloc(0);
    let offset = 0;
    const chunks: Buffer[] = [];
    socket.on("data", (data: Buffer) => {
      pending = Buffer.concat([pending, data]);
      if (!offset) {
        if (pending.length < 10) return;
        assert.equal(pending.subarray(0, 10).toString(), "zINSTREAM\0");
        offset = 10;
      }
      while (pending.length >= offset + 4) {
        const size = pending.readUInt32BE(offset);
        if (pending.length < offset + 4 + size) return;
        offset += 4;
        if (size === 0) {
          const bytes = Buffer.concat(chunks);
          received.push(bytes);
          socket.end(bytes.equals(antivirusTestBytes()) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        chunks.push(pending.subarray(offset, offset + size));
        offset += size;
      }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const output: string[] = [];
    const port = (server.address() as { port: number }).port;
    assert.equal(await runPrivateFileScannerCheck({ STORYHOLD_CLAMD_PORT: String(port) }, (line) => output.push(line)), 0);
    assert.equal(received.length, 2);
    assert.ok(received[1]!.equals(antivirusTestBytes()));
    assert.match(output[0]!, /No uploads, database changes, AI calls, or credits used/);
  } finally { server.close(); await once(server, "close"); }
});

test("scanner refuses invalid ports and out-of-range content before connecting", async () => {
  for (const port of ["", "0", "-1", "65536", "3.5", "invalid"]) {
    await assert.rejects(createPrivateFileScanner({ STORYHOLD_CLAMD_PORT: port })(Buffer.from("text")), /scanner_unavailable/);
  }
  const scanner = createPrivateFileScanner({ STORYHOLD_CLAMD_PORT: "3310" });
  await assert.rejects(scanner(Buffer.alloc(0)), /scan_size_invalid/);
  await assert.rejects(scanner(Buffer.alloc(PRIVATE_FILE_MAX_BYTES + 1)), /scan_size_invalid/);
});

test("scanner handles fragmented verdicts and rejects incomplete or oversized replies", async () => {
  for (const reply of ["split", "incomplete", "oversized"]) {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        if (reply === "split") { socket.write("stream: "); setImmediate(() => socket.end("OK\0")); }
        else if (reply === "incomplete") socket.end("stream: OK");
        else socket.end("x".repeat(8193));
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const result = scanWithClamd(Buffer.from("text"), { host: "127.0.0.1", port: (server.address() as { port: number }).port }, 1000);
      if (reply === "split") assert.equal(await result, "clean");
      else await assert.rejects(result, /scanner_invalid_response/);
    } finally { server.close(); await once(server, "close"); }
  }
});
