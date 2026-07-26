import { describe, expect, it } from 'vitest';
import {
  BLURB_SYSTEM_PROMPT,
  DERIVE_FIELDS_SYSTEM_PROMPT,
  EXTRACT_POST_SYSTEM_PROMPT,
  EXTRACT_RECIPE_SYSTEM_PROMPT,
  SUITABILITY_SYSTEM_PROMPT,
  classifySuitability,
  deriveFields,
  extractRecipe,
  extractRecipeFromPost,
  recipeFacts,
  serializeRecipeFacts,
  writeBlurb,
  type RecipeContextInput,
  type StructuredOutputCallOptions,
  type StructuredOutputClient,
  type StructuredOutputTask,
} from '../src/llm';

const RECIPE: RecipeContextInput = {
  title: 'Sheet Pan Chicken',
  totalMinutes: 45,
  activeMinutes: 15,
  servings: 5,
  ingredients: [{ rawText: '2 lb chicken breast' }, '1 head broccoli'],
  instructions: [
    { name: 'Prep', text: 'Cut everything into bite-size pieces.' },
    { name: null, text: 'Roast until cooked through.' },
  ],
};

describe('recipe task context', () => {
  it('keeps only compact recipe facts and accepts raw strings or stored ingredients', () => {
    expect(recipeFacts(RECIPE)).toEqual({
      title: 'Sheet Pan Chicken',
      total_minutes: 45,
      active_minutes: 15,
      servings: 5,
      ingredients: ['2 lb chicken breast', '1 head broccoli'],
      instructions: [
        { name: 'Prep', text: 'Cut everything into bite-size pieces.' },
        { name: null, text: 'Roast until cooked through.' },
      ],
    });
    expect(JSON.parse(serializeRecipeFacts(RECIPE))).not.toHaveProperty('sourceUrl');
  });
});

describe('Phase 2 recipe tasks', () => {
  it('uses byte-stable static prompts while recipe data stays in the user message', async () => {
    const fake = fakeClient([
      { is_meal_prep: true, reason: 'Five make-ahead portions.' },
      {
        keeps_days: 4,
        freezer_months: 2,
        category: 'Chicken',
        tags: ['Sheet pan', 'Big batch'],
      },
      { blurb: 'One sheet pan turns into five ready lunches.' },
    ]);
    const callOptions: StructuredOutputCallOptions = {
      beforeRequest() {},
    };

    await expect(classifySuitability(fake.client, RECIPE, callOptions)).resolves.toEqual({
      is_meal_prep: true,
      reason: 'Five make-ahead portions.',
    });
    await expect(deriveFields(fake.client, RECIPE, callOptions)).resolves.toMatchObject({
      category: 'Chicken',
      tags: ['Sheet pan', 'Big batch'],
    });
    await expect(writeBlurb(fake.client, RECIPE, callOptions)).resolves.toBe(
      'One sheet pan turns into five ready lunches.',
    );

    expect(fake.calls.map((call) => call.task.systemPrompt)).toEqual([
      SUITABILITY_SYSTEM_PROMPT,
      DERIVE_FIELDS_SYSTEM_PROMPT,
      BLURB_SYSTEM_PROMPT,
    ]);
    expect(fake.calls.every((call) => call.options === callOptions)).toBe(true);
    for (const call of fake.calls) {
      expect(call.task.systemPrompt).not.toContain(RECIPE.title);
      expect(call.task.userPrompt).toContain(RECIPE.title);
    }
  });

  it('maps extracted facts into a locally attributed, nullable-JSON-LD draft', async () => {
    const extracted = {
      found: true,
      reason: 'One complete recipe is present.',
      recipe: {
        title: 'Five Bean Chili',
        total_minutes: 60,
        active_minutes: 20,
        servings: 8,
        ingredients: ['2 cans beans', '1 onion'],
        instructions: [{ name: null, text: 'Simmer until thick.' }],
        image_url: 'https://images.example/chili.jpg',
        author: 'Test Cook',
        published_at: '2026-07-20T12:00:00Z',
      },
    };
    const fake = fakeClient([extracted, extracted]);
    const sourceUrl = 'https://example.com/posts/chili';

    const first = await extractRecipe(fake.client, {
      pageText: 'Visible recipe page text',
      sourceUrl,
    });
    const second = await extractRecipe(fake.client, {
      pageText: 'Different prompt text does not enter the hash',
      sourceUrl,
    });

    expect(first).toMatchObject({
      sourceUrl,
      title: 'Five Bean Chili',
      slug: 'five-bean-chili',
      rawJsonld: null,
      sourceRating: null,
      sourceRatingCount: null,
      imageUrl: 'https://images.example/chili.jpg',
      ingredients: [
        { position: 0, rawText: '2 cans beans' },
        { position: 1, rawText: '1 onion' },
      ],
    });
    expect(first?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.contentHash).toBe(first?.contentHash);
    expect(first?.missing).toEqual(['rating']);
    expect(fake.calls[0]?.task.systemPrompt).toBe(EXTRACT_RECIPE_SYSTEM_PROMPT);

    const responseSchema = fake.calls[0]?.task.schema;
    expect(responseSchema).toBeDefined();
    expect(responseSchema?.safeParse(extracted).success).toBe(true);
    expect(JSON.stringify(extracted)).not.toContain(sourceUrl);
  });

  it('returns null for a validated no-recipe extraction result', async () => {
    const fake = fakeClient([
      {
        found: false,
        reason: 'Editorial round-up, not one complete recipe.',
        recipe: null,
      },
    ]);

    await expect(
      extractRecipe(fake.client, {
        pageText: 'Twenty weeknight dinner ideas',
        sourceUrl: 'https://example.com/roundup',
      }),
    ).resolves.toBeNull();
  });

  it('orders post-author comments first, then by score, and keeps trusted provenance local', async () => {
    const fake = fakeClient([
      {
        found: true,
        reason: 'The post contains quantities and steps.',
        recipe: {
          title: 'Breakfast Burritos',
          total_minutes: 40,
          active_minutes: 30,
          servings: 6,
          ingredients: ['6 tortillas', '8 eggs'],
          instructions: [{ name: null, text: 'Fill and wrap.' }],
          image_url: null,
          author: null,
          published_at: null,
        },
      },
    ]);
    const sourceUrl = 'https://reddit.com/r/MealPrepSunday/comments/example';
    const publishedAt = new Date('2026-07-26T10:00:00Z');

    const draft = await extractRecipeFromPost(fake.client, {
      post: {
        sourceUrl,
        title: 'Breakfast burritos for the week',
        body: 'Recipe is below.',
        author: 'meal_prepper',
        publishedAt,
        imageUrl: 'https://images.example/burritos.jpg',
      },
      comments: [
        { body: 'High score', author: 'reader', score: 100 },
        { body: 'Author clarification', author: 'meal_prepper', score: 1, isSubmitter: true },
        { body: 'Medium score', author: 'reader2', score: 50 },
      ],
    });

    expect(draft).toMatchObject({
      sourceUrl,
      author: 'meal_prepper',
      publishedAt,
      imageUrl: 'https://images.example/burritos.jpg',
      rawJsonld: null,
    });
    const task = fake.calls[0]!.task;
    expect(task.systemPrompt).toBe(EXTRACT_POST_SYSTEM_PROMPT);
    expect(task.systemPrompt).not.toContain(sourceUrl);
    const postJson = between(task.userPrompt, '<post_data>', '</post_data>');
    const postData = JSON.parse(postJson) as {
      comments: { body: string }[];
    };
    expect(postData.comments.map((comment) => comment.body)).toEqual([
      'Author clarification',
      'High score',
      'Medium score',
    ]);
  });
});

interface FakeCall {
  readonly task: StructuredOutputTask<unknown>;
  readonly options: StructuredOutputCallOptions | undefined;
}

function fakeClient(outputs: unknown[]): {
  readonly client: StructuredOutputClient;
  readonly calls: FakeCall[];
} {
  const remaining = [...outputs];
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      async complete<T>(
        task: StructuredOutputTask<T>,
        options?: StructuredOutputCallOptions,
      ): Promise<T> {
        calls.push({
          task: task as StructuredOutputTask<unknown>,
          options,
        });
        if (remaining.length === 0) throw new Error('fake LLM output queue exhausted');
        return remaining.shift() as T;
      },
    },
  };
}

function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not find ${start}...${end}`);
  return value.slice(from + start.length, to);
}
