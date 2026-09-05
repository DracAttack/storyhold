import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "3000";
const adminEmail = process.env.STORYHOLD_LOCAL_ADMIN_EMAIL || "admin@storyhold.local";
const adminPassword = process.env.STORYHOLD_LOCAL_ADMIN_PASSWORD || "storyhold-dev";
const env = {
  ...process.env,
  BASE_PATH: process.env.BASE_PATH || "/",
  NODE_ENV: "development",
  PORT: port,
  STORYHOLD_LOCAL_ACCELERATION: process.env.STORYHOLD_LOCAL_ACCELERATION || "auto",
  STORYHOLD_LOCAL_CUDA_STAGES: process.env.STORYHOLD_LOCAL_CUDA_STAGES || "gliner2,coreference,nli,minilm,bge",
  STORYHOLD_LOCAL_QWEN_GPU_LAYERS: process.env.STORYHOLD_LOCAL_QWEN_GPU_LAYERS || "32",
  STORYHOLD_LOCAL_QWEN_BATCH_SIZE: process.env.STORYHOLD_LOCAL_QWEN_BATCH_SIZE || "512",
  STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE: process.env.STORYHOLD_LOCAL_QWEN_MICRO_BATCH_SIZE || "128",
  STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV: process.env.STORYHOLD_LOCAL_QWEN_OFFLOAD_KQV || "true",
  STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE: process.env.STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE || "1",
  GGML_VK_VISIBLE_DEVICES: process.env.GGML_VK_VISIBLE_DEVICES || process.env.STORYHOLD_LOCAL_QWEN_VULKAN_DEVICE || "1",
};

async function prepareGliner() {
  if (process.platform !== "win32") {
    throw new Error("The complete sequential local intake launcher is currently packaged for Windows.");
  }
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = path.join(repoDir, "scripts", "start-storyhold-gliner.ps1");
  await new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      cwd: repoDir,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`GLiNER2 startup failed with exit code ${code}.`)));
  });
  env.STORYHOLD_REQUIRE_FULL_LOCAL_INTAKE = "true";
  env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
  env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";
  env.STORYHOLD_LOCAL_GLINER2_MODEL = env.STORYHOLD_LOCAL_GLINER2_MODEL || "fastino/gliner2-base-v1";
  env.STORYHOLD_LOCAL_NER_ENABLED = "true";
  env.STORYHOLD_LOCAL_NER_URL = env.STORYHOLD_LOCAL_GLINER2_URL;
  env.STORYHOLD_LOCAL_NER_MODEL = env.STORYHOLD_LOCAL_GLINER2_MODEL;
  env.STORYHOLD_LOCAL_MINILM_ENABLED = "true";
  env.STORYHOLD_LOCAL_MINILM_URL = "http://127.0.0.1:8765/rerank/fast";
  env.STORYHOLD_LOCAL_MINILM_MODEL = env.STORYHOLD_LOCAL_MINILM_MODEL || "cross-encoder/ms-marco-MiniLM-L6-v2";
  env.STORYHOLD_LOCAL_RERANKER_ENABLED = "true";
  env.STORYHOLD_LOCAL_RERANKER_URL = "http://127.0.0.1:8765/rerank/final";
  env.STORYHOLD_LOCAL_BGE_MODEL = env.STORYHOLD_LOCAL_BGE_MODEL || "BAAI/bge-reranker-v2-m3";
  env.STORYHOLD_LOCAL_RERANKER_MODEL = env.STORYHOLD_LOCAL_BGE_MODEL;
  env.STORYHOLD_LOCAL_NLI_ENABLED = "true";
  env.STORYHOLD_LOCAL_NLI_URL = "http://127.0.0.1:8765/nli";
  env.STORYHOLD_LOCAL_NLI_MODEL = env.STORYHOLD_LOCAL_NLI_MODEL || "cross-encoder/nli-deberta-v3-xsmall";
  env.STORYHOLD_LOCAL_COREFERENCE_ENABLED = "true";
  env.STORYHOLD_LOCAL_COREFERENCE_URL = "http://127.0.0.1:8765/coreference";
  env.STORYHOLD_LOCAL_COREFERENCE_MODEL = env.STORYHOLD_LOCAL_COREFERENCE_MODEL || "biu-nlp/f-coref";
  env.STORYHOLD_LOCAL_QWEN_ENABLED = "true";
  env.STORYHOLD_LOCAL_QWEN_URL = "http://127.0.0.1:8765/qwen/audit";
  env.STORYHOLD_LOCAL_QWEN_MODEL = env.STORYHOLD_LOCAL_QWEN_MODEL || "Qwen/Qwen3.5-4B-Instruct";
  return true;
}

async function stopGliner() {
  if (process.platform !== "win32") return;
  const powershell = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  const script = path.join(repoDir, "scripts", "stop-storyhold-gliner.ps1");
  await new Promise((resolve) => {
    const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      cwd: repoDir,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function runNode(entry, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd || repoDir,
      env,
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`));
    });
  });
}

console.log("Preparing the Storyhold local test site...");
await prepareGliner();
await runNode(
  path.join(repoDir, "artifacts", "site", "node_modules", "vite", "bin", "vite.js"),
  [
  "build",
  "--config",
  "vite.config.ts",
  "--configLoader",
  "runner",
  ],
  { cwd: path.join(repoDir, "artifacts", "site") },
);
console.log(`\nStoryhold is starting at http://127.0.0.1:${port}`);
console.log(`Local sign-in: ${adminEmail} / ${adminPassword}`);
console.log("Press Ctrl+C to stop it.\n");
try {
  await runNode(
    path.join(repoDir, "artifacts", "api-server", "node_modules", "tsx", "dist", "cli.mjs"),
    ["./src/local.ts"],
    { cwd: path.join(repoDir, "artifacts", "api-server") },
  );
} finally {
  await stopGliner();
}
