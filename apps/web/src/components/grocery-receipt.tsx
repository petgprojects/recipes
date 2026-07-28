'use client';

/**
 * The receipt. The aggregation itself lives in `@recipes/shared/grocery` — it
 * is tested there, and Phase 5 replaces its internals with SQL while this
 * component keeps rendering the same `GroceryAisleGroup[]`.
 *
 * What this file owns is the paper aesthetic (which is the best part of the
 * original design, per PLAN.md §5) and two honesty affordances the artifact's
 * hand-authored data never needed: an amount can be unknown, and a total can
 * be an underestimate when a source wrote "salt, to taste".
 */

import type { GroceryAisleGroup } from '@recipes/shared/grocery';

interface GroceryReceiptProps {
  groups: readonly GroceryAisleGroup[];
  checked: Record<string, true>;
  recipeCount: number;
  totalServings: number;
  itemCount: number;
  loading: boolean;
  onToggle: (itemKey: string) => void;
  onClearChecks: () => void;
}

export function GroceryReceipt({
  groups,
  checked,
  recipeCount,
  totalServings,
  itemCount,
  loading,
  onToggle,
  onClearChecks,
}: GroceryReceiptProps) {
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

  const doneCount = groups.reduce(
    (sum, group) => sum + group.items.filter((item) => checked[item.key] === true).length,
    0,
  );

  return (
    <>
      <div className="mp-bar">
        <div className="mp-mini">
          {loading ? 'Building the list…' : `${doneCount} of ${itemCount} in the cart`}
        </div>
        <button className="mp-mini" onClick={onClearChecks}>
          Uncheck all
        </button>
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

      <p className="mp-note">
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
