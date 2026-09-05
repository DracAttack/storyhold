import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";
// The pino-pretty transport spins up a worker thread, which can't be bundled
// into the ESM test runner (esbuild concatenation breaks its `__dirname`
// lookup). Skip it under `test` so any module importing the logger stays
// test-bundleable; this is also redundant in production where pretty is off.
const usePrettyTransport = !isProduction && process.env.NODE_ENV !== "test";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(usePrettyTransport
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }
    : {}),
});
