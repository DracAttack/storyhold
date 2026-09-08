import path from "node:path";
import { pathToFileURL } from "node:url";

const configuredSourceDir = process.env.STORYHOLD_SOURCE_DIR;
const storyholdSourceDir = configuredSourceDir
  ? pathToFileURL(`${path.resolve(configuredSourceDir, "storyhold")}${path.sep}`)
  : new URL("./", import.meta.url);

export function storyholdSourceUrl(relativePath: string): URL {
  return new URL(relativePath, storyholdSourceDir);
}