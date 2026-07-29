'use client';

/**
 * The visible half of Phase 7's hard rules.
 *
 * PLAN.md §5 is blunt about why this component exists at all: "Show the active
 * rules in the UI with a switch to disable each one — **a filter you can't see
 * is indistinguishable from a bug**." Everything here follows from that. Each
 * rule states what it hides in a full sentence, says how many of the reader's
 * own cooks it is based on, and has a switch that turns it off immediately.
 *
 * A disabled rule stays listed rather than disappearing. It is still a fact
 * about the reader's history — and a rule that vanished when switched off
 * would give them no way to switch it back on.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  describeHardRule,
  explainHardRule,
  type HardRule,
} from '@recipes/shared/personalization';
import { hardRuleKeys, setHardRuleEnabled, useHardRulesQuery } from '@/lib/api';

interface HardRulesProps {
  /** Null signed out, where there are no rules and the feed is unfiltered. */
  signedIn: boolean;
  /** The rules as of the server render, so the first paint is not a spinner. */
  initialRules: HardRule[];
  /**
   * Told before the refetch, so the planner adopts the next feed directly
   * instead of announcing it as "N new recipes" — see the note on
   * `adoptNextFeed`. Recipes a switch un-hides are not new arrivals.
   */
  onChanged?: () => void;
}

export function HardRules({ signedIn, initialRules, onChanged }: HardRulesProps) {
  const queryClient = useQueryClient();
  const { data: rules = [] } = useHardRulesQuery(signedIn, initialRules);

  const toggle = useMutation({
    // One scope, so two fast clicks on two switches serialise. Without it the
    // slower response — carrying the whole rule list — would overwrite the
    // faster one and visibly flip a switch back. Same reasoning as the planner
    // mutations sharing `planner-state`.
    scope: { id: 'hard-rules' },
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      setHardRuleEnabled(ruleId, enabled),
    async onMutate({ ruleId, enabled }) {
      await queryClient.cancelQueries({ queryKey: hardRuleKeys.list });
      const previous = queryClient.getQueryData<HardRule[]>(hardRuleKeys.list);
      queryClient.setQueryData<HardRule[]>(hardRuleKeys.list, (current) =>
        (current ?? []).map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)),
      );
      return { previous };
    },
    onError(_error, _args, context) {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(hardRuleKeys.list, context.previous);
      }
    },
    onSuccess(next) {
      queryClient.setQueryData<HardRule[]>(hardRuleKeys.list, next);
    },
    onSettled() {
      // Flagged before the invalidate, not after: the refetch can resolve in
      // the same tick, and a planner that learned about the change afterwards
      // would already have shown the pill.
      onChanged?.();
      // The feed itself is now filtered differently, so it has to be refetched
      // — the whole point of the switch is that browse changes. The list keys
      // only: an open recipe's steps did not change because a filter did.
      void queryClient.invalidateQueries({ queryKey: ['recipes', 'list'] });
    },
  });

  if (!signedIn || rules.length === 0) return null;

  const active = rules.filter((rule) => rule.enabled).length;

  return (
    <section className="mp-rules">
      <div className="mp-rules-top">
        <h3 className="mp-rules-title">Filters from your ratings</h3>
        <span className="mp-rules-count">
          {active === 0 ? 'none active' : `${active} active`}
        </span>
      </div>

      <ul className="mp-rules-list">
        {rules.map((rule) => (
          <li className="mp-rule" key={rule.id} data-on={rule.enabled}>
            <div className="mp-rule-text">
              <span className="mp-rule-what">{describeHardRule(rule)}</span>
              <span className="mp-rule-why">{explainHardRule(rule)}</span>
            </div>
            <button
              className="mp-switch"
              role="switch"
              aria-checked={rule.enabled}
              aria-label={describeHardRule(rule)}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ ruleId: rule.id, enabled: !rule.enabled })}
            >
              <span className="mp-switch-knob" />
            </button>
          </li>
        ))}
      </ul>

      {toggle.isError && (
        <p className="mp-note">
          That switch didn&apos;t save. Your filters are unchanged — try again.
        </p>
      )}
    </section>
  );
}
