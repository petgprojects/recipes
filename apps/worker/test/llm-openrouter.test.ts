import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { z } from 'zod';
import {
  StructuredOutputError,
  createStructuredOutputClient,
  type ChatCompletionTransport,
  type StructuredOutputTask,
} from '../src/llm/openrouter';
import {
  DEEPSEEK_V4_FLASH_PRICING,
  normalizeOpenRouterUsage,
} from '../src/llm/usage';

const TEST_SCHEMA = z.object({
  ok: z.boolean(),
  note: z.string().min(1),
});

const TASK: StructuredOutputTask<z.infer<typeof TEST_SCHEMA>> = {
  name: 'test_output',
  schema: TEST_SCHEMA,
  systemPrompt: 'STATIC SYSTEM PREFIX',
  userPrompt: 'variable input',
  maxCompletionTokens: 123,
};

describe('OpenRouter strict structured output', () => {
  it('sends strict json_schema, requires parameter support and forwards AbortSignal', async () => {
    const signal = new AbortController().signal;
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValue(
        completion('{"ok":true,"note":"done"}', { cost: 0.000019 }),
      );
    const usage = vi.fn();
    const beforeRequest = vi.fn();

    const result = await createStructuredOutputClient({
      transport: { create },
    }).complete(TASK, { signal, onUsage: usage, beforeRequest });

    expect(result).toEqual({ ok: true, note: 'done' });
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith({
      taskName: 'test_output',
      attempt: 'initial',
    });
    expect(create).toHaveBeenCalledOnce();
    const [body, requestOptions] = create.mock.calls[0]!;
    expect(body).toMatchObject({
      model: 'deepseek/deepseek-v4-flash',
      provider: { require_parameters: true },
      temperature: 0,
      max_tokens: 123,
      messages: [
        { role: 'system', content: 'STATIC SYSTEM PREFIX' },
        { role: 'user', content: 'variable input' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'test_output',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'note'],
          },
        },
      },
    });
    expect(
      (body.response_format as { json_schema?: { schema?: Record<string, unknown> } })
        .json_schema?.schema,
    ).not.toHaveProperty('$schema');
    expect(requestOptions).toEqual({ signal, maxRetries: 0 });
    expect(usage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tokensIn: 100,
        tokensOut: 20,
        costUsd: 0.000019,
        costSource: 'provider',
      }),
      {
        taskName: 'test_output',
        attempt: 'initial',
        responseId: 'completion-1',
        model: 'deepseek/deepseek-v4-flash',
      },
    );
  });

  it('accounts for malformed output before one independently guarded repair', async () => {
    const events: string[] = [];
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockImplementation(async () => {
        events.push('provider');
        return create.mock.calls.length === 1
          ? completion('{"ok":"wrong","note":""}', { id: 'bad-response', cost: 0.001 })
          : completion('{"ok":true,"note":"repaired"}', {
              id: 'repair-response',
              cost: 0.002,
            });
      });

    const result = await createStructuredOutputClient({
      transport: { create },
    }).complete(TASK, {
      async beforeRequest(context) {
        events.push(`before:${context.attempt}`);
      },
      async onUsage(_usage, context) {
        events.push(`usage:${context.attempt}`);
      },
      async afterRequest(context) {
        events.push(`after:${context.attempt}`);
      },
    });

    expect(result).toEqual({ ok: true, note: 'repaired' });
    expect(events).toEqual([
      'before:initial',
      'provider',
      'usage:initial',
      'after:initial',
      'before:repair',
      'provider',
      'usage:repair',
      'after:repair',
    ]);
    expect(create).toHaveBeenCalledTimes(2);

    const firstBody = create.mock.calls[0]![0];
    const repairBody = create.mock.calls[1]![0];
    expect(repairBody.messages[0]).toEqual(firstBody.messages[0]);
    expect(repairBody.messages).toHaveLength(4);
    expect(repairBody.messages[2]).toEqual({
      role: 'assistant',
      content: '{"ok":"wrong","note":""}',
    });
    expect(repairBody.messages[3]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Validation errors:'),
    });
  });

  it('lets the budget guard stop a repair before a second provider call', async () => {
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValue(completion('not json'));
    const attempts: string[] = [];

    await expect(
      createStructuredOutputClient({ transport: { create } }).complete(TASK, {
        beforeRequest(context) {
          attempts.push(context.attempt);
          if (context.attempt === 'repair') {
            throw new Error('daily LLM budget exhausted');
          }
        },
      }),
    ).rejects.toThrow('daily LLM budget exhausted');

    expect(attempts).toEqual(['initial', 'repair']);
    expect(create).toHaveBeenCalledOnce();
  });

  it('runs request finalization after transport failure but not failed preflight', async () => {
    const afterRequest = vi.fn();
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockRejectedValue(new Error('provider unavailable'));

    await expect(
      createStructuredOutputClient({ transport: { create } }).complete(TASK, {
        afterRequest,
      }),
    ).rejects.toThrow('provider unavailable');
    expect(afterRequest).toHaveBeenCalledExactlyOnceWith({
      taskName: 'test_output',
      attempt: 'initial',
    });

    afterRequest.mockClear();
    await expect(
      createStructuredOutputClient({ transport: { create } }).complete(TASK, {
        beforeRequest() {
          throw new Error('budget blocked');
        },
        afterRequest,
      }),
    ).rejects.toThrow('budget blocked');
    expect(afterRequest).not.toHaveBeenCalled();
  });

  it('fails after exactly one repair when both responses are invalid', async () => {
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValueOnce(completion('not json'))
      .mockResolvedValueOnce(completion('{"ok":false}'));

    await expect(
      createStructuredOutputClient({ transport: { create } }).complete(TASK),
    ).rejects.toMatchObject({
      name: 'StructuredOutputError',
      taskName: 'test_output',
      attempt: 'repair',
    } satisfies Partial<StructuredOutputError>);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('accounts for a refusal but does not retry it', async () => {
    const onUsage = vi.fn();
    const create = vi
      .fn<ChatCompletionTransport['create']>()
      .mockResolvedValue(
        completion(null, {
          refusal: 'I cannot process this.',
          cost: 0.0004,
        }),
      );

    await expect(
      createStructuredOutputClient({ transport: { create } }).complete(TASK, {
        onUsage,
      }),
    ).rejects.toThrow('model refused');
    expect(onUsage).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects unsafe schema names before making a request', async () => {
    const create = vi.fn<ChatCompletionTransport['create']>();
    await expect(
      createStructuredOutputClient({ transport: { create } }).complete({
        ...TASK,
        name: 'Bad name!',
      }),
    ).rejects.toThrow('task name');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('OpenRouter usage normalization', () => {
  it('prefers provider-reported cost and reads cached-token extensions', () => {
    const response = completion('{}', {
      cost: 0.25,
      cachedTokens: 40,
      promptTokens: 100,
      completionTokens: 20,
    });
    expect(normalizeOpenRouterUsage(response)).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      totalTokens: 120,
      cachedTokensIn: 40,
      costUsd: 0.25,
      costSource: 'provider',
    });
  });

  it('estimates from verified rates only when OpenRouter omits cost', () => {
    const response = completion('{}', {
      cost: undefined,
      cachedTokens: 40,
      promptTokens: 100,
      completionTokens: 20,
    });
    const expected =
      (60 * DEEPSEEK_V4_FLASH_PRICING.inputPerMillionUsd +
        40 * DEEPSEEK_V4_FLASH_PRICING.cachedInputPerMillionUsd +
        20 * DEEPSEEK_V4_FLASH_PRICING.outputPerMillionUsd) /
      1_000_000;
    expect(normalizeOpenRouterUsage(response)).toMatchObject({
      costUsd: expected,
      costSource: 'estimated',
    });
  });
});

interface CompletionOptions {
  readonly id?: string;
  readonly refusal?: string | null;
  readonly finishReason?: ChatCompletion.Choice['finish_reason'];
  readonly cost?: number;
  readonly cachedTokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

function completion(
  content: string | null,
  options: CompletionOptions = {},
): ChatCompletion {
  const promptTokens = options.promptTokens ?? 100;
  const completionTokens = options.completionTokens ?? 20;
  return {
    id: options.id ?? 'completion-1',
    created: 1,
    model: 'deepseek/deepseek-v4-flash',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content,
          refusal: options.refusal ?? null,
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: {
        cached_tokens: options.cachedTokens ?? 0,
      },
      ...(options.cost === undefined ? {} : { cost: options.cost }),
    },
  } as ChatCompletion;
}
