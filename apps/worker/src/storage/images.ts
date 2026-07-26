/**
 * Bounded, attribution-preserving recipe image cache.
 *
 * Image bytes come through `PoliteFetcher.fetchBytes()`, so they receive the
 * same robots, User-Agent, crawl-delay, retry and timeout handling as pages.
 * Sharp rejects oversized/deceptive inputs, auto-orients EXIF data, fits inside
 * 800×800 without enlargement, strips metadata and emits one WebP frame.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { PoliteFetcher } from '../scanner/fetcher';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_IMAGE_EDGE = 800;

const ACCEPTED_CONTENT_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const ACCEPTED_INPUT_FORMATS = new Set(['avif', 'gif', 'jpeg', 'png', 'webp']);

export interface CachedRecipeImage {
  /** Deterministic path relative to the configured image volume. */
  readonly localPath: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly reused: boolean;
}

export type CacheRecipeImageResult =
  | { readonly outcome: 'cached'; readonly image: CachedRecipeImage }
  | { readonly outcome: 'skipped'; readonly reason: 'no-url' }
  | { readonly outcome: 'failed'; readonly error: string };

export interface ImageFileOperations {
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<Buffer>;
  writeExclusive(path: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface CacheRecipeImageOptions {
  readonly outputDir: string;
  readonly crawlDelayMs?: number | null;
  readonly maxBytes?: number;
  readonly maxPixels?: number;
  readonly maxEdge?: number;
  readonly fileOperations?: ImageFileOperations;
  readonly tempId?: () => string;
}

export async function cacheRecipeImage(
  fetcher: Pick<PoliteFetcher, 'fetchBytes'>,
  imageUrl: string | null,
  options: CacheRecipeImageOptions,
): Promise<CacheRecipeImageResult> {
  if (imageUrl === null) return { outcome: 'skipped', reason: 'no-url' };

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return { outcome: 'failed', error: `invalid image URL: ${imageUrl}` };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { outcome: 'failed', error: `unsupported image URL protocol: ${parsed.protocol}` };
  }

  const files = options.fileOperations ?? DEFAULT_FILE_OPERATIONS;
  const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;
  const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE;
  const filename = deterministicImageFilename(parsed.toString());
  const finalPath = join(options.outputDir, filename);

  try {
    const cached = await readCached(files, finalPath, filename, maxPixels, maxEdge);
    if (cached !== null) return { outcome: 'cached', image: cached };

    const response = await fetcher.fetchBytes(parsed.toString(), {
      accept: 'image/avif,image/webp,image/jpeg,image/png,image/gif;q=0.8',
      crawlDelayMs: options.crawlDelayMs ?? null,
      maxBytes: options.maxBytes ?? MAX_IMAGE_BYTES,
    });
    if (response.outcome !== 'ok') {
      return {
        outcome: 'failed',
        error:
          response.outcome === 'error'
            ? `${response.reason}: ${response.message}`
            : 'image server returned 304 without a cached file',
      };
    }

    const contentType = response.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
      return {
        outcome: 'failed',
        error: `unsupported image content-type: ${contentType || '(missing)'}`,
      };
    }

    const transformed = await transformImage(response.body, maxPixels, maxEdge);
    await files.mkdir(options.outputDir);
    const tempPath = join(
      options.outputDir,
      `.${filename}.${process.pid}.${options.tempId?.() ?? randomUUID()}.tmp`,
    );
    try {
      await files.writeExclusive(tempPath, transformed.data);
      await files.rename(tempPath, finalPath);
    } finally {
      // `rename` removes the source on success; ENOENT is therefore expected.
      await files.remove(tempPath).catch(() => undefined);
    }

    return {
      outcome: 'cached',
      image: {
        localPath: filename,
        width: transformed.width,
        height: transformed.height,
        bytes: transformed.data.byteLength,
        reused: false,
      },
    };
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function deterministicImageFilename(imageUrl: string): string {
  return `${createHash('sha256').update(imageUrl).digest('hex')}.webp`;
}

async function transformImage(
  input: Buffer,
  maxPixels: number,
  maxEdge: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  const constructorOptions = {
    failOn: 'warning' as const,
    limitInputPixels: maxPixels,
    limitInputChannels: 5,
    pages: 1,
  };
  const metadata = await sharp(input, constructorOptions).metadata();
  if (metadata.format === undefined || !ACCEPTED_INPUT_FORMATS.has(metadata.format)) {
    throw new Error(`unsupported or deceptive image format: ${metadata.format ?? 'unknown'}`);
  }

  const { data, info } = await sharp(input, {
    ...constructorOptions,
    // Current Sharp supports constructor-level EXIF orientation.
    autoOrient: true,
  })
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  if (info.width > maxEdge || info.height > maxEdge) {
    throw new Error(`resized image exceeded ${maxEdge}px bound`);
  }
  return { data, width: info.width, height: info.height };
}

async function readCached(
  files: ImageFileOperations,
  path: string,
  localPath: string,
  maxPixels: number,
  maxEdge: number,
): Promise<CachedRecipeImage | null> {
  let data: Buffer;
  try {
    data = await files.read(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }

  try {
    const metadata = await sharp(data, {
      failOn: 'warning',
      limitInputPixels: maxPixels,
      limitInputChannels: 5,
      pages: 1,
    }).metadata();
    if (
      metadata.format !== 'webp' ||
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width > maxEdge ||
      metadata.height > maxEdge
    ) {
      return null;
    }
    return {
      localPath,
      width: metadata.width,
      height: metadata.height,
      bytes: data.byteLength,
      reused: true,
    };
  } catch {
    // A partial/corrupt cache file is not authoritative; fetch and atomically
    // replace it below.
    return null;
  }
}

const DEFAULT_FILE_OPERATIONS: ImageFileOperations = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  read: readFile,
  async writeExclusive(path, data) {
    await writeFile(path, data, { flag: 'wx' });
  },
  rename,
  remove: unlink,
};

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
