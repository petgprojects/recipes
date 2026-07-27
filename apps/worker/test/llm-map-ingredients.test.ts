import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import {
  MAP_INGREDIENTS_SYSTEM_PROMPT,
  createStructuredOutputClient,
  mapIngredients,
  type ChatCompletionTransport,
  type StructuredOutputClient,
  type StructuredOutputTask,
} from '../src/llm';

const CANONICAL = [
  { name: 'scallions', aisle: 'Produce' },
  { name: 'garlic cloves', aisle: 'Produce' },
  { name: 'olive oil', aisle: 'Pantry' },
] as const;

const VALID_OUTPUT = {
  decisions: [
    {
      input_name: 'green onions',
      action: 'existing',
      canonical_name: 'scallions',
      aisle: null,
    },
    {
      input_name: 'black garlic',
      action: 'new',
      canonical_name: 'black garlic',
      aisle: 'Produce',
    },
  ],
} as const;

describe('semantic ingredient mapping task', () => {
  it('keeps a static prompt and sends only bounded variable JSON in the user message', async () => {
    const captured: StructuredOutputTask<unknown>[] = [];
    const client = validatingFakeClient([VALID_OUTPUT], captured);

    await expect(
      mapIngredients(client, {
        unknownNames: ['green onions', 'black garlic'],
        canonicalIngredients: CANONICAL,
      }),
    ).resolves.toEqual(VALID_OUTPUT);

    const task = captured[0]!;
    expect(task.name).toBe('ingredient_semantic_mapping');
    expect(task.systemPrompt).toBe(MAP_INGREDIENTS_SYSTEM_PROMPT);
    expect(task.systemPrompt).not.toContain('green onions');
    expect(task.maxCompletionTokens).toBe(8_192);
    const payload = JSON.parse(
      between(task.userPrompt, '<ingredient_data>', '</ingredient_data>'),
    ) as {
      unknown_names: string[];
      canonical_ingredients: { name: string; aisle: string }[];
    };
    expect(payload).toEqual({
      unknown_names: ['green onions', 'black garlic'],
      canonical_ingredients: CANONICAL,
    });
  });

  it('uses an input-aware schema that rejects missing, extra and duplicate decisions', async () => {
    const task = await capturedTask();

    expect(
      task.schema.safeParse({
        decisions: [VALID_OUTPUT.decisions[0]],
      }).success,
    ).toBe(false);
    expect(
      task.schema.safeParse({
        decisions: [
          VALID_OUTPUT.decisions[0],
          {
            input_name: 'mystery herb',
            action: 'new',
            canonical_name: 'mystery herb',
            aisle: 'Produce',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      task.schema.safeParse({
        decisions: [
          VALID_OUTPUT.decisions[0],
          {
            ...VALID_OUTPUT.decisions[0],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects invalid existing targets and normalizes an existing name mislabeled as new', async () => {
    const task = await capturedTask();

    const invalidExisting = task.schema.safeParse({
      decisions: [
        {
          ...VALID_OUTPUT.decisions[0],
          canonical_name: 'green onion',
        },
        VALID_OUTPUT.decisions[1],
      ],
    });
    expect(invalidExisting.success).toBe(false);
    if (!invalidExisting.success) {
      expect(invalidExisting.error.message).toContain('Invalid option');
      expect(invalidExisting.error.message).toContain('scallions');
    }

    const mislabeled = {
      decisions: [
        VALID_OUTPUT.decisions[0],
        {
          ...VALID_OUTPUT.decisions[1],
          canonical_name: 'olive oil',
          aisle: 'Produce' as const,
        },
      ],
    };
    expect(task.schema.safeParse(mislabeled).success).toBe(true);
    await expect(
      mapIngredients(validatingFakeClient([mislabeled], []), {
        unknownNames: ['green onions', 'black garlic'],
        canonicalIngredients: CANONICAL,
      }),
    ).resolves.toEqual({
      decisions: [
        VALID_OUTPUT.decisions[0],
        {
          input_name: 'black garlic',
          action: 'existing',
          canonical_name: 'olive oil',
          aisle: null,
        },
      ],
    });
  });

  it('rejects unsafe names and undeclared quantity/note fields', async () => {
    const task = await capturedTask();

    expect(
      task.schema.safeParse({
        decisions: [
          VALID_OUTPUT.decisions[0],
          {
            ...VALID_OUTPUT.decisions[1],
            canonical_name: '2 bulbs black garlic, chopped',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      task.schema.safeParse({
        decisions: [
          {
            ...VALID_OUTPUT.decisions[0],
            quantity: 2,
          },
          VALID_OUTPUT.decisions[1],
        ],
      }).success,
    ).toBe(false);

  });

  it('allows several aliases to teach one new canonical when their aisle agrees', async () => {
    const threeInputTask = await capturedTask([
      'green onions',
      'black garlic',
      'fermented garlic',
    ]);
    expect(
      threeInputTask.schema.safeParse({
        decisions: [
          VALID_OUTPUT.decisions[0],
          VALID_OUTPUT.decisions[1],
          {
            input_name: 'fermented garlic',
            action: 'new',
            canonical_name: 'black garlic',
            aisle: 'Produce',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      threeInputTask.schema.safeParse({
        decisions: [
          VALID_OUTPUT.decisions[0],
          VALID_OUTPUT.decisions[1],
          {
            input_name: 'fermented garlic',
            action: 'new',
            canonical_name: 'black garlic',
            aisle: 'Canned & Jarred',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts a learned canonical vocabulary larger than 1,000 entries', async () => {
    const canonicalIngredients = Array.from({ length: 1_001 }, (_, index) => ({
      name: `test ingredient ${alphabeticSuffix(index)}`,
      aisle: 'Pantry' as const,
    }));
    const lastCanonical = canonicalIngredients.at(-1)!.name;
    const output = {
      decisions: [
        {
          input_name: 'test ingredient alias',
          action: 'existing' as const,
          canonical_name: lastCanonical,
          aisle: null,
        },
      ],
    };

    await expect(
      mapIngredients(validatingFakeClient([output], []), {
        unknownNames: ['test ingredient alias'],
        canonicalIngredients,
      }),
    ).resolves.toEqual(output);
  });

  it('rejects invalid or duplicate input before invoking the LLM client', async () => {
    const complete = vi.fn();
    const client = { complete } as unknown as StructuredOutputClient;

    await expect(
      mapIngredients(client, {
        unknownNames: ['2 cups scallions'],
        canonicalIngredients: CANONICAL,
      }),
    ).rejects.toThrow();
    await expect(
      mapIngredients(client, {
        unknownNames: ['green onions', 'green onions'],
        canonicalIngredients: CANONICAL,
      }),
    ).rejects.toThrow(/duplicate/);
    await expect(
      mapIngredients(client, {
        unknownNames: ['green onions'],
        canonicalIngredients: [
          CANONICAL[0],
          CANONICAL[0],
        ],
      }),
    ).rejects.toThrow(/duplicate/);
    await expect(
      mapIngredients(client, {
        unknownNames: [],
        canonicalIngredients: CANONICAL,
      }),
    ).rejects.toThrow();

    expect(complete).not.toHaveBeenCalled();
  });

  it('feeds input-aware validation errors through the one repair retry', async () => {
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValueOnce(
        completion({
          decisions: [
            {
              input_name: 'green onions',
              action: 'existing',
              canonical_name: 'green onion',
              aisle: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        completion({
          decisions: [
            {
              input_name: 'green onions',
              action: 'existing',
              canonical_name: 'scallions',
              aisle: null,
            },
          ],
        }),
      );

    await expect(
      mapIngredients(
        createStructuredOutputClient({ transport: { create } }),
        {
          unknownNames: ['green onions'],
          canonicalIngredients: CANONICAL,
        },
      ),
    ).resolves.toEqual({
      decisions: [
        {
          input_name: 'green onions',
          action: 'existing',
          canonical_name: 'scallions',
          aisle: null,
        },
      ],
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0].messages[0]).toEqual(
      create.mock.calls[0]?.[0].messages[0],
    );
    expect(create.mock.calls[1]?.[0].messages[3]).toMatchObject({
      role: 'user',
      content: expect.stringContaining(
        'expected one of "scallions"|"garlic cloves"|"olive oil"',
      ),
    });
  });

  it('omits JavaScript-only Unicode regex patterns from the provider schema', async () => {
    const output = {
      decisions: [
        {
          input_name: 'jalapeño',
          action: 'new' as const,
          canonical_name: 'jalapeño',
          aisle: 'Produce' as const,
        },
      ],
    };
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValue(completion(output));

    await expect(
      mapIngredients(
        createStructuredOutputClient({ transport: { create } }),
        {
          unknownNames: ['jalapeño'],
          canonicalIngredients: CANONICAL,
        },
      ),
    ).resolves.toEqual(output);

    const responseFormat = create.mock.calls[0]![0].response_format;
    expect(JSON.stringify(responseFormat)).not.toContain(String.raw`\p{`);
  });

  it('puts exact input and existing canonical names into the provider schema', async () => {
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValue(completion(VALID_OUTPUT));

    await mapIngredients(
      createStructuredOutputClient({ transport: { create } }),
      {
        unknownNames: ['green onions', 'black garlic'],
        canonicalIngredients: CANONICAL,
      },
    );

    const wireSchema = JSON.stringify(
      create.mock.calls[0]![0].response_format,
    );
    expect(wireSchema).toContain(
      '"enum":["green onions","black garlic"]',
    );
    expect(wireSchema).toContain(
      '"enum":["scallions","garlic cloves","olive oil"]',
    );
  });
});

async function capturedTask(
  unknownNames: readonly string[] = ['green onions', 'black garlic'],
): Promise<StructuredOutputTask<unknown>> {
  const captured: StructuredOutputTask<unknown>[] = [];
  const decisions = unknownNames.map((inputName, index) =>
    index === 0
      ? {
          input_name: inputName,
          action: 'existing' as const,
          canonical_name: 'scallions',
          aisle: null,
        }
      : {
          input_name: inputName,
          action: 'new' as const,
          canonical_name: inputName,
          aisle: 'Produce' as const,
        },
  );
  await mapIngredients(
    validatingFakeClient([{ decisions }], captured),
    {
      unknownNames,
      canonicalIngredients: CANONICAL,
    },
  );
  return captured[0]!;
}

function validatingFakeClient(
  outputs: readonly unknown[],
  captured: StructuredOutputTask<unknown>[],
): StructuredOutputClient {
  const remaining = [...outputs];
  return {
    async complete<T>(task: StructuredOutputTask<T>): Promise<T> {
      captured.push(task as StructuredOutputTask<unknown>);
      if (remaining.length === 0) throw new Error('fake LLM output queue exhausted');
      return task.schema.parse(remaining.shift());
    },
  };
}

function completion(output: unknown): ChatCompletion {
  return {
    id: 'ingredient-map-completion',
    created: 1,
    model: 'deepseek/deepseek-v4-flash',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: JSON.stringify(output),
          refusal: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0001,
    },
  } as ChatCompletion;
}

function between(value: string, start: string, end: string): string {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not find ${start}...${end}`);
  return value.slice(from + start.length, to);
}

function alphabeticSuffix(index: number): string {
  let remaining = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(97 + (remaining % 26)) + suffix;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return suffix;
}
