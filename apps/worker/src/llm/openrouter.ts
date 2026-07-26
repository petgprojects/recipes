import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';
import {
  DEEPSEEK_V4_FLASH_PRICING,
  normalizeOpenRouterUsage,
  type LlmPricing,
  type LlmUsageCallback,
} from './usage';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_REPAIR_CONTENT_CHARS = 12_000;
const MAX_VALIDATION_ERROR_CHARS = 4_000;

export interface OpenRouterProviderPreferences {
  readonly require_parameters: true;
}

export interface OpenRouterChatCompletionParams
  extends ChatCompletionCreateParamsNonStreaming {
  readonly provider: OpenRouterProviderPreferences;
}

export interface ChatCompletionTransport {
  create(
    params: OpenRouterChatCompletionParams,
    options?: TransportRequestOptions,
  ): Promise<ChatCompletion>;
}

export interface TransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly maxRetries?: number;
}

export interface OpenRouterClientConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly pricing?: LlmPricing;
}

export interface StructuredOutputTask<T> {
  /** Stable JSON Schema name: lowercase letters, digits and underscores. */
  readonly name: string;
  readonly schema: z.ZodType<T>;
  /** A byte-identical static prefix. Never interpolate recipe/page content. */
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxCompletionTokens?: number;
}

export interface LlmRequestContext {
  readonly taskName: string;
  readonly attempt: 'initial' | 'repair';
}

export type LlmBeforeRequest = (
  context: LlmRequestContext,
) => void | Promise<void>;

export type LlmAfterRequest = (
  context: LlmRequestContext,
) => void | Promise<void>;

export interface StructuredOutputCallOptions {
  readonly signal?: AbortSignal;
  /**
   * Called before each billable provider request. The repair attempt invokes
   * this independently, which is where a daily budget guard belongs.
   */
  readonly beforeRequest?: LlmBeforeRequest;
  /**
   * Called after a preflighted provider request finishes, including transport
   * and accounting failures. Budget coordination uses this to release its
   * cross-worker lease without leaking it on a failed request.
   */
  readonly afterRequest?: LlmAfterRequest;
  /**
   * Called immediately after every provider response and before inspecting its
   * content. Accounting therefore includes malformed responses and repairs.
   */
  readonly onUsage?: LlmUsageCallback;
}

export interface StructuredOutputClient {
  complete<T>(
    task: StructuredOutputTask<T>,
    options?: StructuredOutputCallOptions,
  ): Promise<T>;
}

export interface CreateStructuredOutputClientOptions {
  readonly transport: ChatCompletionTransport;
  readonly model?: string;
  readonly pricing?: LlmPricing;
}

export class StructuredOutputError extends Error {
  readonly taskName: string;
  readonly attempt: 'initial' | 'repair';

  constructor(
    taskName: string,
    attempt: 'initial' | 'repair',
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${taskName} ${attempt} response: ${message}`, options);
    this.name = 'StructuredOutputError';
    this.taskName = taskName;
    this.attempt = attempt;
  }
}

/**
 * Construct the real OpenAI-compatible OpenRouter transport.
 *
 * Automatic SDK retries are disabled: a hidden retry can incur a second charge
 * without giving the budget/accounting hooks an independent preflight.
 */
export function createOpenRouterClient(
  config: OpenRouterClientConfig,
): StructuredOutputClient {
  const openai = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
    defaultHeaders: config.defaultHeaders,
  });

  const transport: ChatCompletionTransport = {
    create(params, options) {
      return openai.chat.completions.create(params, {
        ...options,
        maxRetries: 0,
      });
    },
  };

  return createStructuredOutputClient({
    transport,
    model: config.model,
    pricing: config.pricing,
  });
}

/** Create the same client around an injected transport for deterministic tests. */
export function createStructuredOutputClient(
  options: CreateStructuredOutputClientOptions,
): StructuredOutputClient {
  const model = options.model ?? DEFAULT_MODEL;
  const pricing = options.pricing ?? DEEPSEEK_V4_FLASH_PRICING;

  return {
    async complete<T>(
      task: StructuredOutputTask<T>,
      callOptions: StructuredOutputCallOptions = {},
    ): Promise<T> {
      assertTaskName(task.name);
      const responseFormat = strictResponseFormat(task);
      const initialMessages: ChatCompletionMessageParam[] = [
        { role: 'system', content: task.systemPrompt },
        { role: 'user', content: task.userPrompt },
      ];

      const initialContext: LlmRequestContext = {
        taskName: task.name,
        attempt: 'initial',
      };
      const initial = await accountedRequest(
        initialContext,
        callOptions,
        () =>
          request(
            options.transport,
            model,
            task,
            responseFormat,
            initialMessages,
            callOptions.signal,
          ),
        (response) =>
          reportUsage(
            response,
            task.name,
            'initial',
            pricing,
            callOptions.onUsage,
          ),
      );

      const first = parseStructuredResponse(task, initial, 'initial');
      if (first.success) return first.data;
      if (!first.repairable) throw first.error;

      const repairContext: LlmRequestContext = {
        taskName: task.name,
        attempt: 'repair',
      };
      const repairMessages: ChatCompletionMessageParam[] = [
        // Keep the cached static prefix byte-identical to the first request.
        { role: 'system', content: task.systemPrompt },
        { role: 'user', content: task.userPrompt },
        {
          role: 'assistant',
          content: truncate(first.rawContent ?? '(no content)', MAX_REPAIR_CONTENT_CHARS),
        },
        {
          role: 'user',
          content:
            'Repair the preceding response so it conforms exactly to the required JSON schema. ' +
            'Return only the corrected JSON object. Validation errors:\n' +
            truncate(first.validationError, MAX_VALIDATION_ERROR_CHARS),
        },
      ];
      const repaired = await accountedRequest(
        repairContext,
        callOptions,
        () =>
          request(
            options.transport,
            model,
            task,
            responseFormat,
            repairMessages,
            callOptions.signal,
          ),
        (response) =>
          reportUsage(
            response,
            task.name,
            'repair',
            pricing,
            callOptions.onUsage,
          ),
      );

      const second = parseStructuredResponse(task, repaired, 'repair');
      if (second.success) return second.data;
      throw second.error;
    },
  };
}

async function accountedRequest(
  context: LlmRequestContext,
  options: StructuredOutputCallOptions,
  send: () => Promise<ChatCompletion>,
  account: (response: ChatCompletion) => Promise<void>,
): Promise<ChatCompletion> {
  await options.beforeRequest?.(context);
  try {
    const response = await send();
    await account(response);
    return response;
  } finally {
    await options.afterRequest?.(context);
  }
}

type ResponseFormat = NonNullable<
  ChatCompletionCreateParamsNonStreaming['response_format']
>;

function strictResponseFormat<T>(task: StructuredOutputTask<T>): ResponseFormat {
  const schema = z.toJSONSchema(task.schema);
  // `$schema` is metadata, not part of the strict output contract.
  delete schema.$schema;
  return {
    type: 'json_schema',
    json_schema: {
      name: task.name,
      strict: true,
      schema,
    },
  };
}

async function request<T>(
  transport: ChatCompletionTransport,
  model: string,
  task: StructuredOutputTask<T>,
  responseFormat: ResponseFormat,
  messages: ChatCompletionMessageParam[],
  signal: AbortSignal | undefined,
): Promise<ChatCompletion> {
  return transport.create(
    {
      model,
      messages,
      response_format: responseFormat,
      temperature: 0,
      provider: { require_parameters: true },
      ...(task.maxCompletionTokens === undefined
        ? {}
        // OpenRouter's model capability list exposes `max_tokens` for this
        // endpoint. Sending `max_completion_tokens` together with
        // require_parameters=true makes an otherwise compatible strict-output
        // request unroutable.
        : { max_tokens: task.maxCompletionTokens }),
    },
    { signal, maxRetries: 0 },
  );
}

async function reportUsage(
  response: ChatCompletion,
  taskName: string,
  attempt: 'initial' | 'repair',
  pricing: LlmPricing,
  callback: LlmUsageCallback | undefined,
): Promise<void> {
  if (callback === undefined) return;
  await callback(normalizeOpenRouterUsage(response, pricing), {
    taskName,
    attempt,
    responseId: response.id,
    model: response.model,
  });
}

type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly repairable: boolean;
      readonly rawContent: string | null;
      readonly validationError: string;
      readonly error: StructuredOutputError;
    };

function parseStructuredResponse<T>(
  task: StructuredOutputTask<T>,
  response: ChatCompletion,
  attempt: 'initial' | 'repair',
): ParseResult<T> {
  const choice = response.choices[0];
  if (choice === undefined) {
    return failed(task.name, attempt, null, 'response contained no choices', true);
  }
  if (choice.message.refusal !== null && choice.message.refusal !== undefined) {
    return failed(
      task.name,
      attempt,
      choice.message.content,
      `model refused the request: ${choice.message.refusal}`,
      false,
    );
  }
  if (choice.finish_reason === 'content_filter') {
    return failed(task.name, attempt, choice.message.content, 'content was filtered', false);
  }

  const content = choice.message.content;
  if (content === null || content.trim() === '') {
    return failed(task.name, attempt, content, 'response content was empty', true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    return failed(
      task.name,
      attempt,
      content,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      true,
      error,
    );
  }

  const validated = task.schema.safeParse(parsed);
  if (!validated.success) {
    return failed(
      task.name,
      attempt,
      content,
      z.prettifyError(validated.error),
      true,
      validated.error,
    );
  }
  if (choice.finish_reason !== 'stop') {
    return failed(
      task.name,
      attempt,
      content,
      `completion ended with finish_reason=${choice.finish_reason}`,
      true,
    );
  }
  return { success: true, data: validated.data };
}

function failed<T>(
  taskName: string,
  attempt: 'initial' | 'repair',
  rawContent: string | null,
  validationError: string,
  repairable: boolean,
  cause?: unknown,
): ParseResult<T> {
  return {
    success: false,
    repairable,
    rawContent,
    validationError,
    error: new StructuredOutputError(taskName, attempt, validationError, {
      cause,
    }),
  };
}

function assertTaskName(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new TypeError(
      `Structured-output task name must match /^[a-z][a-z0-9_]{0,63}$/: ${value}`,
    );
  }
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
