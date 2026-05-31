// r2.ts — Cloudflare R2 helpers for Vercel functions.
//
// R2 is S3-compatible. We use @aws-sdk/client-s3 with a custom endpoint
// (https://<account-id>.r2.cloudflarestorage.com). This module assumes
// the Node.js runtime — Edge runtime can run the SDK but bundle size
// matters less when these endpoints aren't on the hot path.
//
// Required env vars (server-side, never bundled into the client):
//   R2_ACCOUNT_ID
//   R2_ACCESS_KEY_ID
//   R2_SECRET_ACCESS_KEY
//   R2_BUCKET
// Optional:
//   R2_PUBLIC_BASE         (e.g. https://images.prism.scott.ai) — public read URL prefix
//   R2_KEY_PREFIX          (e.g. prism) — namespace inside the bucket
//
// The functions below short-circuit cleanly when R2 isn't configured so
// localhost dev without R2 keys still boots; isR2Enabled() lets callers
// branch on availability.

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBase: string | null;
  keyPrefix: string;
}

function readConfig(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBase: (process.env.R2_PUBLIC_BASE ?? "").replace(/\/+$/, "") || null,
    keyPrefix: (process.env.R2_KEY_PREFIX ?? "").replace(/^\/+|\/+$/g, ""),
  };
}

export function isR2Enabled(): boolean {
  return readConfig() !== null;
}

let cached: { client: S3Client; cfg: R2Config } | null = null;
function getClient(): { client: S3Client; cfg: R2Config } {
  if (cached) return cached;
  const cfg = readConfig();
  if (!cfg) throw new Error("R2 not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)");
  cached = {
    cfg,
    client: new S3Client({
      region: "auto",
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    }),
  };
  return cached;
}

function fullKey(key: string): string {
  const { cfg } = getClient();
  return cfg.keyPrefix ? `${cfg.keyPrefix}/${key}` : key;
}

/** Public URL for a key, or null if R2_PUBLIC_BASE isn't set.
 *  When null, the bucket isn't externally accessible and the caller
 *  must stream bytes through its own endpoint. */
export function publicUrl(key: string): string | null {
  const { cfg } = getClient();
  if (!cfg.publicBase) return null;
  return `${cfg.publicBase}/${fullKey(key)}`;
}

export async function putBytes(
  key: string,
  bytes: Uint8Array,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<void> {
  const { client, cfg } = getClient();
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: fullKey(key),
    Body: bytes,
    ContentType: contentType,
    CacheControl: "public, max-age=2592000, immutable",  // 30 days
    Metadata: metadata,
  }));
}

export async function putJson(key: string, value: unknown): Promise<void> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  await putBytes(key, json, "application/json; charset=utf-8");
}

export async function getJson<T>(key: string): Promise<T | null> {
  const { client, cfg } = getClient();
  try {
    const res = await client.send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: fullKey(key),
    }));
    const text = await res.Body?.transformToString("utf-8");
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** True if a key exists. Cheap HEAD request — no body transfer. */
export async function exists(key: string): Promise<boolean> {
  const { client, cfg } = getClient();
  try {
    await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: fullKey(key) }));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** List keys under a prefix. Returns up to `limit` keys (default 1000,
 *  R2's per-page max). Caller handles pagination if more are needed. */
export async function listKeys(prefix: string, limit = 1000): Promise<string[]> {
  const { client, cfg } = getClient();
  const res = await client.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: fullKey(prefix),
    MaxKeys: Math.min(limit, 1000),
  }));
  const stripPrefix = cfg.keyPrefix ? `${cfg.keyPrefix}/` : "";
  return (res.Contents ?? [])
    .map((o) => o.Key ?? "")
    .filter(Boolean)
    .map((k) => (stripPrefix && k.startsWith(stripPrefix) ? k.slice(stripPrefix.length) : k));
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.$metadata?.httpStatusCode === 404
  );
}
