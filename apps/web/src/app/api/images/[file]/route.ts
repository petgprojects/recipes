/**
 * GET /api/images/:file — the cached recipe photo.
 *
 * PLAN.md §7: "cache one downscaled copy for performance rather than
 * hotlinking (hotlinking hammers their bandwidth and breaks when they
 * reorganize), keep the attribution and link visible on every card." The worker
 * already did the caching — one ≤800px WebP per source image URL, written into
 * the shared `recipe-images` volume — so this route only has to hand the bytes
 * out.
 *
 * Two things it must not do:
 *
 * 1. **Serve anything outside the volume.** The filename is content-addressed
 *    (`sha256(imageUrl).webp`, see `storage/images.ts`), so the guard is an
 *    exact-shape match rather than path normalisation. `..%2F` and friends
 *    cannot survive a `/^[0-9a-f]{64}\.webp$/` test.
 * 2. **Leak whether an arbitrary path exists.** Anything that fails the shape
 *    test and anything missing get the same 404.
 *
 * The name is a hash of the immutable upstream URL, so the bytes behind a given
 * URL never change: `immutable` with a one-year max-age is honest here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { env } from '@recipes/shared/env';

export const runtime = 'nodejs';

const CACHED_IMAGE_NAME = /^[0-9a-f]{64}\.webp$/;

function notFound() {
  return NextResponse.json(
    { error: 'Image not found' },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  if (!CACHED_IMAGE_NAME.test(file)) return notFound();

  try {
    const bytes = await readFile(join(env.RECIPE_IMAGES_DIR, file));
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/webp',
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // A recipe row can outlive its cached file (volume reset, failed fetch);
    // the card falls back to its text-only layout, which is a designed state.
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return notFound();
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
