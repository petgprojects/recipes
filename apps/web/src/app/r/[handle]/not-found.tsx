/**
 * A share link that does not resolve.
 *
 * Three real ways to arrive here, and the copy has to cover all of them without
 * guessing which: a mistyped or truncated handle, a link to a recipe that has
 * since been rejected (`getRecipeByShareCode` returns `active` rows only), and
 * a link from a database this one was not restored from — the corpus lives in
 * `pgdata`, so codes are not portable between installations.
 */

import '@/styles/artifact.css';

export default function ShareNotFound() {
  return (
    <div className="mp">
      <div className="mp-wrap">
        <header className="mp-head">
          <div className="mp-eyebrow">Recipe planner</div>
          <h1 className="mp-title">
            That link
            <br />
            <em>went cold.</em>
          </h1>
          <p className="mp-sub">
            No recipe here has that code. It may have been mistyped or cut short in the message it
            arrived in, or the recipe may have left the collection since it was shared.{' '}
            <a className="mp-link" href="/">
              Browse everything instead →
            </a>
          </p>
        </header>
      </div>
    </div>
  );
}
