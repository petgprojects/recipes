/**
 * robots.txt parsing and matching, per RFC 9309.
 *
 * PLAN.md §7 makes honouring robots.txt a requirement, not a nicety, so this
 * is a real implementation rather than a `includes('Disallow: /')` check:
 * group selection by user-agent specificity, `*` and `$` wildcards in paths,
 * longest-match-wins with allow winning ties, and `Crawl-delay`.
 *
 * Everything here is pure. Fetching and caching live in `fetcher.ts`.
 */

export interface RobotsRule {
  readonly type: 'allow' | 'disallow';
  /** The raw path pattern, e.g. `/wp-admin/` or `/*?s=`. */
  readonly pattern: string;
  /** Precompiled matcher. */
  readonly regex: RegExp;
  /** Pattern length, used for longest-match-wins. */
  readonly length: number;
}

export interface RobotsGroup {
  /** Lower-cased user-agent tokens this group applies to. */
  readonly agents: string[];
  readonly rules: RobotsRule[];
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsTxt {
  readonly groups: RobotsGroup[];
  /** Absolute sitemap URLs advertised by the file — free discovery input. */
  readonly sitemaps: string[];
  /** True when the file had no parseable directives at all. */
  readonly empty: boolean;
}

export const EMPTY_ROBOTS: RobotsTxt = { groups: [], sitemaps: [], empty: true };

/**
 * Parse a robots.txt body. Never throws: an unparseable file is an
 * unrestricted one, which is what every major crawler does.
 */
export function parseRobotsTxt(body: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let current: { agents: string[]; rules: RobotsRule[]; crawlDelaySeconds: number | null } | null =
    null;
  // Consecutive `User-agent:` lines share one group; a rule line closes the
  // agent block so the next `User-agent:` starts a new group.
  let acceptingAgents = false;
  let sawDirective = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line.length === 0) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (value.length === 0) break;
        sawDirective = true;
        if (!acceptingAgents || current === null) {
          current = { agents: [], rules: [], crawlDelaySeconds: null };
          groups.push(current);
          acceptingAgents = true;
        }
        current.agents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        if (current === null) break; // A rule before any User-agent is orphaned.
        acceptingAgents = false;
        sawDirective = true;
        // "Disallow:" with an empty value means *allow everything* and must
        // not become a rule matching the empty prefix (i.e. every path).
        if (value.length === 0) break;
        current.rules.push(compileRule(field, value));
        break;
      }
      case 'crawl-delay': {
        if (current === null) break;
        acceptingAgents = false;
        sawDirective = true;
        const seconds = Number.parseFloat(value);
        if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelaySeconds = seconds;
        break;
      }
      case 'sitemap': {
        sawDirective = true;
        try {
          sitemaps.push(new URL(value).toString());
        } catch {
          // A relative or malformed Sitemap: line is simply ignored.
        }
        break;
      }
      default:
        break;
    }
  }

  return { groups, sitemaps, empty: !sawDirective };
}

function compileRule(type: 'allow' | 'disallow', pattern: string): RobotsRule {
  return { type, pattern, regex: patternToRegExp(pattern), length: pattern.length };
}

/**
 * `*` matches any run of characters, a trailing `$` anchors the end, and
 * everything else is a literal prefix match.
 */
function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Select the group that applies to `userAgent`.
 *
 * RFC 9309: match on the crawler's *product token*, case-insensitively, and
 * the most specific (longest) matching token wins. `*` is the fallback and
 * only applies when no named group matched.
 */
export function selectGroup(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const token = productToken(userAgent);
  let best: RobotsGroup | null = null;
  let bestLength = -1;
  let wildcard: RobotsGroup | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') {
        // Merge nothing; first `*` group wins, as with named groups.
        wildcard ??= group;
        continue;
      }
      if (token.startsWith(agent) && agent.length > bestLength) {
        best = group;
        bestLength = agent.length;
      }
    }
  }

  return best ?? wildcard;
}

/** `RecipePlannerBot/0.1 (+https://…)` → `recipeplannerbot`. */
export function productToken(userAgent: string): string {
  return (userAgent.split('/')[0] ?? userAgent).trim().toLowerCase();
}

/**
 * Is `pathAndQuery` crawlable by `userAgent`?
 *
 * Longest matching pattern wins; on an exact tie `Allow` wins, per RFC 9309
 * §2.2.2. No matching rule at all means allowed.
 */
export function isPathAllowed(robots: RobotsTxt, userAgent: string, url: string): boolean {
  const group = selectGroup(robots, userAgent);
  if (group === null || group.rules.length === 0) return true;

  const target = pathAndQueryOf(url);

  let bestLength = -1;
  let bestType: 'allow' | 'disallow' = 'allow';
  for (const rule of group.rules) {
    if (!rule.regex.test(target)) continue;
    if (rule.length > bestLength || (rule.length === bestLength && rule.type === 'allow')) {
      bestLength = rule.length;
      bestType = rule.type;
    }
  }

  return bestLength === -1 || bestType === 'allow';
}

/** The `Crawl-delay` in milliseconds for this agent, or `null` if unset. */
export function crawlDelayMsFor(robots: RobotsTxt, userAgent: string): number | null {
  const group = selectGroup(robots, userAgent);
  if (group?.crawlDelaySeconds == null) return null;
  return Math.round(group.crawlDelaySeconds * 1000);
}

function pathAndQueryOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    // Already a path.
    return url.startsWith('/') ? url : `/${url}`;
  }
}
