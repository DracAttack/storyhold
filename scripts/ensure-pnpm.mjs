import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userAgent = process.env.npm_config_user_agent || "";

if (!userAgent.startsWith("pnpm/")) {
  process.stderr.write("Use pnpm instead.\n");
  process.exit(1);
}

for (const filename of ["package-lock.json", "yarn.lock"]) {
  rmSync(path.join(repoDir, filename), { force: true });
}
