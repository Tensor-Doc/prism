// Cloudflare R2 upload helper.
//
// R2 is S3-compatible — we use @aws-sdk/client-s3 with a custom endpoint
// pointing at `https://<account-id>.r2.cloudflarestorage.com`. Keys are
// generated specifically in R2's "Manage R2 API Tokens" section; the
// Cloudflare global API key WILL NOT work here.
//
// Environment variables:
//   R2_ACCOUNT_ID          hex account id from the R2 dashboard URL
//   R2_ACCESS_KEY_ID       R2-specific Access Key ID
//   R2_SECRET_ACCESS_KEY   matching Secret
//   R2_BUCKET              bucket name (e.g. "prism")
//   R2_PUBLIC_BASE         (optional) public URL prefix (custom domain or
//                          pub-XXXXXX.r2.dev). If absent, uploads still
//                          happen so the bytes land in R2, but the
//                          catalog entry's assets.video / .thumb stay as
//                          local /videos/ paths until the public URL is
//                          known. Flip on later with `pnpm prism refresh-urls`.
//   R2_KEY_PREFIX          (optional) prefix to namespace files in the bucket
//
// isR2Enabled() returns true if the 4 required vars are present
// (account/access/secret/bucket). The public URL is a separate decision.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";

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
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }
  const publicBase = process.env.R2_PUBLIC_BASE;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBase: publicBase ? publicBase.replace(/\/+$/, "") : null,
    keyPrefix: (process.env.R2_KEY_PREFIX ?? "").replace(/^\/+|\/+$/g, ""),
  };
}

export function isR2Enabled(): boolean {
  return readConfig() !== null;
}

let cachedClient: { client: S3Client; cfg: R2Config } | null = null;
function getClient(): { client: S3Client; cfg: R2Config } {
  if (cachedClient) return cachedClient;
  const cfg = readConfig();
  if (!cfg) throw new Error("R2 not configured — see scripts/prism/r2.ts header for required env vars");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  cachedClient = { client, cfg };
  return cachedClient;
}

function objectKey(cfg: R2Config, key: string): string {
  return cfg.keyPrefix ? `${cfg.keyPrefix}/${key}` : key;
}

/** Upload a local file to R2 under the given key. Returns the public URL
 *  if R2_PUBLIC_BASE is set, or null if upload succeeded but no public
 *  URL is configured yet. Idempotent: re-upload overwrites. */
export async function uploadFile(
  localPath: string,
  key: string,
  contentType: string,
): Promise<string | null> {
  const { client, cfg } = getClient();
  const body = readFileSync(localPath);
  const fullKey = objectKey(cfg, key);
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: fullKey,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return cfg.publicBase ? `${cfg.publicBase}/${fullKey}` : null;
}
