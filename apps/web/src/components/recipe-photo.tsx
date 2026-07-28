'use client';

/**
 * The recipe photo, and its absence.
 *
 * PLAN.md §5, Phase 3: "Cards without a photo fall back to the current
 * text-only layout rather than a broken frame — this *will* happen with real
 * data, so build it deliberately." Two ways it happens: the row never got an
 * `image_local_path` (a failed or skipped fetch), or the file behind one is
 * gone (a reset `recipe-images` volume). The first is a null check; the second
 * only shows up at load time, hence `failed`.
 *
 * `unoptimized` is deliberate. The worker already fetched each image once,
 * auto-oriented it, fitted it inside 800×800 and wrote one WebP frame
 * (`storage/images.ts`), so Next's optimizer would be re-encoding an already
 * optimal file — and it would need `sharp` in the web image, which is a
 * dependency this app otherwise does not have. What `next/image` is still
 * doing for us is the lazy loading, the intrinsic sizing and the reserved
 * aspect box that stops the card from reflowing when the photo lands.
 */

import Image from 'next/image';
import { useState } from 'react';
import type { RecipeSummary } from '@/lib/recipe-types';
import { recipeImageSrc } from '@/lib/recipe-types';

interface RecipePhotoProps {
  recipe: RecipeSummary;
  /** `card` is the 16:9 crop; `hero` is the taller detail-sheet image. */
  variant: 'card' | 'hero';
  priority?: boolean;
}

export function RecipePhoto({ recipe, variant, priority = false }: RecipePhotoProps) {
  const [failed, setFailed] = useState(false);
  const src = recipeImageSrc(recipe);
  if (src === null || failed) return null;

  return (
    <div className={variant === 'hero' ? 'mp-hero' : 'mp-photo'}>
      <Image
        src={src}
        alt={`${recipe.title}, photographed by ${recipe.sourceName}`}
        width={recipe.imageW ?? 800}
        height={recipe.imageH ?? 450}
        sizes={variant === 'hero' ? '(min-width: 700px) 700px, 100vw' : '(min-width: 640px) 360px, 100vw'}
        unoptimized
        priority={priority}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
