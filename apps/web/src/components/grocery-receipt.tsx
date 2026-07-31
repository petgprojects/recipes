'use client';

/**
 * The receipt.
 *
 * The merge happens in SQL (Phase 5, `lib/grocery.ts`) and the printable text
 * lives in `@recipes/shared/grocery`; what this file owns is the paper
 * aesthetic — which PLAN.md §5 asks to keep, and which is the best part of the
 * original design — plus two honesty affordances the artifact's hand-authored
 * data never needed: an amount can be unknown, and a total can be an
 * underestimate when a source wrote "salt, to taste".
 *
 * Print and copy are Phase 5 deliverables. Both go through the same list this
 * component is rendering, so what comes out of the printer or the clipboard is
 * what is on screen, including which boxes are ticked.
 */

import { useCallback, useEffect, useState } from 'react';
import { groceryListToText, type GroceryAisleGroup } from '@recipes/shared/grocery';

interface GroceryReceiptProps {
  groups: readonly GroceryAisleGroup[];
  checked: Record<string, true>;
  recipeCount: number;
  totalServings: number;
  itemCount: number;
  loading: boolean;
  /** A failed list is not an empty list; the reader has to be told which. */
  error: Error | null;
  onToggle: (itemKey: string) => void;
  onClearChecks: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function GroceryReceipt({
  groups,
  checked,
  recipeCount,
  totalServings,
  itemCount,
  loading,
  error,
  onToggle,
  onClearChecks,
}: GroceryReceiptProps) {
  const [copied, setCopied] = useState<CopyState>('idle');

  useEffect(() => {
    if (copied === 'idle') return;
    const timer = setTimeout(() => setCopied('idle'), 2_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    const text = groceryListToText(groups, { checked, recipeCount, totalServings });
    try {
      // `navigator.clipboard` is undefined over plain HTTP on anything but
      // localhost, and `writeText` rejects when the document is not focused.
      // Neither deserves an exception in the console — the button says so.
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
  }, [groups, checked, recipeCount, totalServings]);

  if (recipeCount === 0) {
    return (
      <div className="mp-empty">
        <h3>The list builds itself</h3>
        <p>
          Save some recipes and everything they need shows up here, combined and sorted in the order
          you&apos;ll walk the store.
        </p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="mp-empty">
        <h3>Couldn&apos;t build the list</h3>
        <p>
          {error.message}. Your picks are safe — this is the shopping list that could not be read.
          It will retry on its own.
        </p>
      </div>
    );
  }

  const doneCount = groups.reduce(
    (sum, group) => sum + group.items.filter((item) => checked[item.key] === true).length,
    0,
  );

  return (
    <>
      <div className="mp-bar mp-no-print">
        <div className="mp-mini">
          {loading ? 'Building the list…' : `${doneCount} of ${itemCount} in the cart`}
        </div>
        <div className="mp-bar-actions">
          <button className="mp-mini" onClick={() => void copy()}>
            {copied === 'copied' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy as text'}
          </button>
          <button className="mp-mini" onClick={() => window.print()}>
            Print
          </button>
          <button className="mp-mini" onClick={onClearChecks}>
            Uncheck all
          </button>
        </div>
      </div>

      <div className="mp-receipt">
        <div className="mp-r-head">
          <h2>Shopping list</h2>
          <p>
            {recipeCount} {recipeCount === 1 ? 'RECIPE' : 'RECIPES'}
            {totalServings > 0 && ` · ${totalServings} SERVINGS`} · {itemCount} ITEMS
          </p>
        </div>

        {groups.map((group) => (
          <section key={group.aisle}>
            <div className="mp-aisle">{group.aisle}</div>
            {group.items.map((item) => {
              const on = checked[item.key] === true;
              return (
                <button
                  key={item.key}
                  className="mp-r-item"
                  data-on={on}
                  aria-pressed={on}
                  onClick={() => onToggle(item.key)}
                >
                  <span className="mp-box">✓</span>
                  <span className="mp-name">
                    {item.name}
                    {item.optional && <span className="mp-from"> optional</span>}
                    {item.recipes.length > 1 && (
                      <span className="mp-from">
                        <br />
                        for {item.recipes.length} recipes
                      </span>
                    )}
                  </span>
                  <span className="mp-dots" />
                  <span className="mp-amt">
                    {item.amount === '' ? '—' : item.amount}
                    {item.approximate && item.amount !== '' ? '+' : ''}
                  </span>
                </button>
              );
            })}
          </section>
        ))}

        <div className="mp-total">
          <span>Total</span>
          <span>
            {itemCount} items{totalServings > 0 && ` · ${totalServings} meals`}
          </span>
        </div>
      </div>
      <div className="mp-tear" />

      <p className="mp-note mp-no-print">
        Aisles run in the order most stores are laid out, with frozen last so nothing melts on the
        walk to the register. The same ingredient from several recipes is added together whenever
        the units allow it — cans and ounces stay separate lines rather than being guessed at. A
        dash means the source never gave an amount; a <b>+</b> means one recipe asked for &ldquo;to
        taste&rdquo; on top of the total. Check-offs stay put if you close this and come back
        mid-shop.
      </p>
    </>
  );
}
