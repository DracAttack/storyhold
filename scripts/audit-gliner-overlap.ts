import { readFile } from "node:fs/promises";
import { extractLocalStoryEntities } from "../artifacts/api-server/src/storyhold/localEntityExtraction";
import { activateLorekeeperStage, releaseLorekeeperStage } from "../artifacts/api-server/src/storyhold/localLorekeeperModels";

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass one or more inspectLocalWorld JSON files.");

process.env.STORYHOLD_LOCAL_GLINER1_ENABLED = "true";
process.env.STORYHOLD_LOCAL_GLINER1_URL = "http://127.0.0.1:8765/gliner1";
process.env.STORYHOLD_LOCAL_GLINER2_ENABLED = "true";
process.env.STORYHOLD_LOCAL_GLINER2_URL = "http://127.0.0.1:8765/gliner2";

type Chunk = { id: string; source_id: string; content: string };
const sourceChunks: Chunk[] = [];
for (const inputPath of paths) {
  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as { chunks?: Chunk[] };
  const chunks = parsed.chunks ?? [];
  const sampleCount = Math.min(12, chunks.length);
  for (let index = 0; index < sampleCount; index += 1) {
    sourceChunks.push(chunks[Math.round(index * (chunks.length - 1) / Math.max(1, sampleCount - 1))]!);
  }
}
const chunks = sourceChunks.map((chunk) => ({
  id: chunk.id,
  sourceId: chunk.source_id,
  content: chunk.content,
}));

const run = async (stage: "gliner1" | "gliner2") => {
  await activateLorekeeperStage(stage);
  return extractLocalStoryEntities({ chunks, stage, stopOnFailure: true, timeoutMilliseconds: 120_000 });
};

try {
  const first = await run("gliner1");
  const second = await run("gliner2");
  const key = (mention: { text: string; category: string }) =>
    `${mention.text.normalize("NFKC").toLocaleLowerCase()}|${mention.category}`;
  const firstKeys = new Set(first.mentions.map(key));
  const secondKeys = new Set(second.mentions.map(key));
  const firstOnly = first.mentions.filter((mention) => !secondKeys.has(key(mention)));
  const secondOnly = second.mentions.filter((mention) => !firstKeys.has(key(mention)));
  process.stdout.write(`${JSON.stringify({
    sampledChunks: chunks.length,
    gliner1: first.receipt,
    gliner2: second.receipt,
    gliner1UniqueKeys: firstKeys.size,
    gliner2UniqueKeys: secondKeys.size,
    overlapKeys: [...firstKeys].filter((value) => secondKeys.has(value)).length,
    gliner1OnlySamples: firstOnly.slice(0, 80).map((mention) => ({
      text: mention.text,
      category: mention.category,
      score: mention.score,
    })),
    gliner2OnlySamples: secondOnly.slice(0, 80).map((mention) => ({
      text: mention.text,
      category: mention.category,
      score: mention.score,
    })),
  }, null, 2)}\n`);
} finally {
  await releaseLorekeeperStage().catch(() => undefined);
}
