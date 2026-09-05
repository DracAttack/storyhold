import { Storage } from "@google-cloud/storage";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type StorageFile = {
  save(data: Buffer, options: {
    resumable: boolean;
    preconditionOpts: { ifGenerationMatch: number };
    metadata: { contentType: string; metadata: Record<string, string> };
  }): Promise<unknown>;
  delete(): Promise<unknown>;
};

type StorageBucket = {
  file(name: string): StorageFile;
  getFiles(options: { prefix: string }): Promise<[StorageFile[]]>;
};

export type StoryholdSourceVaultStorage = {
  uploadSource(input: {
    worldId: string;
    sourceId: string;
    extension: string;
    bytes: Buffer;
    contentType: string;
    documentType: string;
  }): Promise<string>;
  deleteSource(key: string): Promise<void>;
  deleteWorldSources(worldId: string): Promise<void>;
};

export function storyholdSourceObjectKey(
  worldId: string,
  sourceId: string,
  extension: string,
): string {
  if (!UUID_PATTERN.test(worldId) || !UUID_PATTERN.test(sourceId)) {
    throw new Error("Invalid Storyhold source identifier.");
  }
  if (!/^\.[a-z0-9]{1,10}$/iu.test(extension)) {
    throw new Error("Invalid Storyhold source extension.");
  }
  return `storyhold/worlds/${worldId.toLowerCase()}/sources/${sourceId.toLowerCase()}${extension.toLowerCase()}`;
}

export function storyholdWorldObjectPrefix(worldId: string): string {
  if (!UUID_PATTERN.test(worldId)) throw new Error("Invalid Storyhold world identifier.");
  return `storyhold/worlds/${worldId.toLowerCase()}/`;
}

function sourceKeyParts(key: string): {
  worldId: string;
  sourceId: string;
  extension: string;
} {
  const parts =
    /^storyhold\/worlds\/([^/]+)\/sources\/([^/.]+)(\.[a-z0-9]{1,10})$/iu.exec(
      key,
    );
  if (
    !parts ||
    storyholdSourceObjectKey(parts[1]!, parts[2]!, parts[3]!) !==
      key.toLowerCase()
  ) {
    throw new Error("Invalid Storyhold source object key.");
  }
  return {
    worldId: parts[1]!,
    sourceId: parts[2]!,
    extension: parts[3]!,
  };
}

function privateObjectLocation(value = process.env.PRIVATE_OBJECT_DIR): {
  bucketName: string;
  prefix: string;
} {
  const parts = (value ?? "").replace(/^\/+|\/+$/gu, "").split("/").filter(Boolean);
  if (parts.length < 1) throw new Error("Private object storage is not configured.");
  return { bucketName: parts[0]!, prefix: parts.slice(1).join("/") };
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: number }).code === 404);
}

export class GcsStoryholdSourceVaultStorage implements StoryholdSourceVaultStorage {
  private readonly bucket: StorageBucket;
  private readonly privatePrefix: string;

  constructor(bucket?: StorageBucket, privateObjectDir?: string) {
    const location = privateObjectLocation(privateObjectDir);
    this.privatePrefix = location.prefix ? `${location.prefix}/` : "";
    this.bucket = bucket ?? new Storage({
      credentials: {
        audience: "replit",
        subject_token_type: "access_token",
        token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
        type: "external_account",
        credential_source: {
          url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
          format: { type: "json", subject_token_field_name: "access_token" },
        },
        universe_domain: "googleapis.com",
      },
      projectId: "",
    }).bucket(location.bucketName) as unknown as StorageBucket;
  }

  async uploadSource(input: Parameters<StoryholdSourceVaultStorage["uploadSource"]>[0]): Promise<string> {
    const key = storyholdSourceObjectKey(input.worldId, input.sourceId, input.extension);
    await this.bucket.file(`${this.privatePrefix}${key}`).save(input.bytes, {
      resumable: false,
      // A UUID collision must fail rather than replace another source.
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: {
        contentType: input.contentType,
        metadata: { documentType: input.documentType },
      },
    });
    return key;
  }

  async deleteSource(key: string): Promise<void> {
    sourceKeyParts(key);
    try {
      await this.bucket.file(`${this.privatePrefix}${key}`).delete();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async deleteWorldSources(worldId: string): Promise<void> {
    const prefix = `${this.privatePrefix}${storyholdWorldObjectPrefix(worldId)}`;
    const [files] = await this.bucket.getFiles({ prefix });
    await Promise.all(files.map(async (file) => {
      try {
        await file.delete();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }));
  }
}

class LocalStoryholdSourceVaultStorage
  implements StoryholdSourceVaultStorage
{
  constructor(private readonly storageRoot: string) {}

  private sourcePath(key: string): string {
    const { worldId, sourceId, extension } = sourceKeyParts(key);
    return path.join(
      this.storageRoot,
      "uploads",
      worldId,
      `${sourceId}${extension}`,
    );
  }

  async uploadSource(
    input: Parameters<StoryholdSourceVaultStorage["uploadSource"]>[0],
  ): Promise<string> {
    const key = storyholdSourceObjectKey(
      input.worldId,
      input.sourceId,
      input.extension,
    );
    const filePath = this.sourcePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.bytes, { flag: "wx" });
    return key;
  }

  async deleteSource(key: string): Promise<void> {
    try {
      await unlink(this.sourcePath(key));
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        (error as { code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  async deleteWorldSources(worldId: string): Promise<void> {
    const prefix = storyholdWorldObjectPrefix(worldId);
    const directory = path.join(
      this.storageRoot,
      "uploads",
      prefix.split("/")[2]!,
    );
    await rm(directory, { recursive: true, force: true });
  }
}

export function createStoryholdSourceVaultStorage(
  storageRoot: string,
): StoryholdSourceVaultStorage {
  return process.env.PRIVATE_OBJECT_DIR?.trim()
    ? new GcsStoryholdSourceVaultStorage()
    : new LocalStoryholdSourceVaultStorage(storageRoot);
}