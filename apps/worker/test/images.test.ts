import { mkdtemp, readFile, readdir, rm, unlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { FetchBytesResult, PoliteFetcher } from '../src/scanner/fetcher';
import {
  cacheRecipeImage,
  deterministicImageFilename,
  type ImageFileOperations,
} from '../src/storage/images';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'recipes-images-'));
  temporaryDirectories.push(directory);
  return directory;
}

function imageFetcher(
  body: Buffer,
  contentType = 'image/png',
  onFetch?: () => void,
): Pick<PoliteFetcher, 'fetchBytes'> {
  return {
    async fetchBytes(url): Promise<FetchBytesResult> {
      onFetch?.();
      return {
        outcome: 'ok',
        url,
        finalUrl: url,
        statusCode: 200,
        body,
        etag: null,
        lastModified: null,
        contentType,
        bytes: body.byteLength,
        attempts: 1,
        fetchedAt: new Date(0),
      };
    },
  };
}

describe('cacheRecipeImage', () => {
  it('fits inside 800×800, emits WebP and reuses the deterministic file', async () => {
    const directory = await temporaryDirectory();
    const input = await sharp({
      create: {
        width: 1_600,
        height: 400,
        channels: 3,
        background: '#c8553d',
      },
    })
      .png()
      .toBuffer();
    let fetches = 0;
    const fetcher = imageFetcher(input, 'image/png', () => {
      fetches += 1;
    });
    const url = 'https://images.example/meal.png';

    const first = await cacheRecipeImage(fetcher, url, { outputDir: directory });
    expect(first.outcome).toBe('cached');
    if (first.outcome !== 'cached') return;
    expect(first.image).toMatchObject({
      localPath: deterministicImageFilename(url),
      width: 800,
      height: 200,
      reused: false,
    });

    const metadata = await sharp(
      await readFile(join(directory, first.image.localPath)),
    ).metadata();
    expect(metadata.format).toBe('webp');

    const second = await cacheRecipeImage(fetcher, url, { outputDir: directory });
    expect(second.outcome).toBe('cached');
    if (second.outcome === 'cached') expect(second.image.reused).toBe(true);
    expect(fetches).toBe(1);
  });

  it('auto-orients EXIF data and never enlarges a small image', async () => {
    const directory = await temporaryDirectory();
    const oriented = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: '#457b9d',
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await cacheRecipeImage(
      imageFetcher(oriented, 'image/jpeg'),
      'https://images.example/oriented.jpg',
      { outputDir: directory },
    );
    expect(result.outcome).toBe('cached');
    if (result.outcome === 'cached') {
      expect([result.image.width, result.image.height]).toEqual([20, 40]);
    }
  });

  it('rejects a deceptive content type without writing a file', async () => {
    const directory = await temporaryDirectory();
    const result = await cacheRecipeImage(
      imageFetcher(Buffer.from('<svg/>'), 'image/svg+xml'),
      'https://images.example/vector.svg',
      { outputDir: directory },
    );
    expect(result.outcome).toBe('failed');
    expect(await readdir(directory)).toEqual([]);
  });

  it('cleans its temp file when the atomic rename fails', async () => {
    const directory = await temporaryDirectory();
    const input = await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 3,
        background: '#111111',
      },
    })
      .png()
      .toBuffer();
    const operations: ImageFileOperations = {
      async mkdir(path) {
        await mkdir(path, { recursive: true });
      },
      read: readFile,
      async writeExclusive(path, data) {
        await writeFile(path, data, { flag: 'wx' });
      },
      async rename() {
        throw new Error('disk rename failed');
      },
      remove: unlink,
    };

    const result = await cacheRecipeImage(
      imageFetcher(input),
      'https://images.example/fail.png',
      { outputDir: directory, fileOperations: operations, tempId: () => 'test' },
    );
    expect(result).toEqual({ outcome: 'failed', error: 'disk rename failed' });
    expect(await readdir(directory)).toEqual([]);
  });
});
