import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
	AIMessage,
	AIMessageChunk,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
} from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	TrackedChatModel,
	toAiMessage,
	toOpenAiMessages,
} from '../nodes/OrdigovernanceChatModel/TrackedChatModel';

const CONFIG = {
	baseUrl: 'http://gw:8180',
	token: 'test-token',
	client: 'research',
	purpose: 'n8n-chat',
};

const OPENAI_TOOL_SPEC = {
	type: 'function',
	function: {
		name: 'search',
		description: 'web search',
		parameters: { type: 'object', properties: { query: { type: 'string' } } },
	},
};

function okResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

/** Build an SSE Response carrying the given frames (one data: line each). */
function sseResponse(frames: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	});
}

/**
 * Streaming extension-point surface of the model.
 *
 * The PUBLIC streaming method (astream/stream) varies across
 * @langchain/core version lines and is not on the type surface in 1.x,
 * while _stream (the ChatOpenAI convention) and _astream are the
 * points every version routes its public streaming through. The tests
 * therefore exercise the extension points directly through this
 * structural type.
 */
type StreamingModel = {
	_astream: (
		messages: BaseMessage[],
		options: Record<string, unknown>,
	) => AsyncGenerator<{ message: AIMessageChunk }>;
	_stream: (
		messages: BaseMessage[],
		options: Record<string, unknown>,
	) => AsyncGenerator<{ message: AIMessageChunk }>;
};

async function collectChunks(
	model: TrackedChatModel,
	messages: BaseMessage[],
	callOptions: Record<string, unknown> = {},
): Promise<AIMessageChunk[]> {
	const streaming = model as unknown as StreamingModel;
	const generations = streaming._astream(messages, callOptions);
	const chunks: AIMessageChunk[] = [];
	for await (const generation of generations) {
		chunks.push(generation.message);
	}
	return chunks;
}

describe('message translation', () => {
	it('maps langchain message types to openai roles', () => {
		const dicts = toOpenAiMessages([
			new SystemMessage('sys'),
			new HumanMessage('hi'),
			new AIMessage('hello'),
		]);
		expect(dicts).toEqual([
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello' },
		]);
	});

	it('translates normalized tool calls back to the wire shape', () => {
		const dicts = toOpenAiMessages([
			new AIMessage({
				content: '',
				tool_calls: [{ name: 'search', args: { query: 'ev' }, id: 'call_1', type: 'tool_call' }],
			}),
			new ToolMessage({ content: '{"hits": 3}', tool_call_id: 'call_1' }),
		]);
		expect(dicts[0].tool_calls).toEqual([
			{
				id: 'call_1',
				type: 'function',
				function: { name: 'search', arguments: '{"query":"ev"}' },
			},
		]);
		expect(dicts[1]).toEqual({ role: 'tool', content: '{"hits": 3}', tool_call_id: 'call_1' });
	});

	it('passes raw additional_kwargs tool_calls through untouched', () => {
		const raw = [
			{ id: 'call_9', type: 'function', function: { name: 'search', arguments: '{}' } },
		];
		// langchain-core 1.x message-field generics reject additional_kwargs
		// inside the constructor literal (variance), so assign after
		// construction -- the wire-shaped entries must pass through
		// untouched either way.
		const message = new AIMessage({ content: '' });
		(message as unknown as { additional_kwargs: Record<string, unknown> })
			.additional_kwargs.tool_calls = raw;
		const dicts = toOpenAiMessages([message]);
		expect(dicts[0].tool_calls).toBe(raw);
	});
});

describe('response translation', () => {
	it('maps openai tool_calls to langchain toolcall dicts and usage', () => {
		const message = toAiMessage({
			choices: [
				{
					message: {
						content: '',
						tool_calls: [
							{
								id: 'call_1',
								type: 'function',
								function: { name: 'search', arguments: '{"query": "ev"}' },
							},
						],
					},
				},
			],
			usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
		});
		expect(message.tool_calls).toEqual([
			{ name: 'search', args: { query: 'ev' }, id: 'call_1', type: 'tool_call' },
		]);
		expect(message.usage_metadata).toEqual({
			input_tokens: 3,
			output_tokens: 2,
			total_tokens: 5,
		});
	});
});

describe('governed call contract (non-streaming)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is a BaseChatModel of its own langchain copy', () => {
		// The real acceptance is instanceof against n8n's built-in copy
		// (peer dependency discipline, see README); this pins the class shape.
		expect(new TrackedChatModel(CONFIG)).toBeInstanceOf(BaseChatModel);
	});

	it('forwards bind options, identity and translated messages', async () => {
		fetchMock.mockResolvedValue(
			okResponse({
				status: 'ok',
				call_id: 'n8n-chat-n8n-call-abc-e-abc-1001',
				response: { choices: [{ message: { content: 'ok' } }] },
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		);
		const model = new TrackedChatModel({ ...CONFIG, runId: 'run-1', taskId: 'task-a' });
		const result = await model._generate([new HumanMessage('hi')], {
			tools: [OPENAI_TOOL_SPEC],
			tool_choice: 'auto',
			stop: ['###'],
			parallel_tool_calls: false,
		} as never);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('http://gw:8180/governed/llm-chat');
		expect(init.method).toBe('POST');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
		const payload = JSON.parse(String(init.body));
		expect(payload.client).toBe('research');
		expect(payload.purpose).toBe('n8n-chat');
		expect(payload.run_id).toBe('run-1');
		expect(payload.task_id).toBe('task-a');
		expect(payload.messages).toEqual([{ role: 'user', content: 'hi' }]);
		expect(payload.kwargs.tools).toEqual([OPENAI_TOOL_SPEC]);
		expect(payload.kwargs.tool_choice).toBe('auto');
		expect(payload.kwargs.stop).toEqual(['###']);
		expect(payload.kwargs.parallel_tool_calls).toBe(false);

		expect(result.generations[0].message.content).toBe('ok');
		expect(result.llmOutput).toEqual({
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			call_id: 'n8n-chat-n8n-call-abc-e-abc-1001',
		});
	});

	it('omits run/task identity and tools when unbound', async () => {
		fetchMock.mockResolvedValue(
			okResponse({
				status: 'ok',
				call_id: 'cid',
				response: { choices: [{ message: { content: 'ok' } }] },
			}),
		);
		const model = new TrackedChatModel(CONFIG);
		await model._generate([new HumanMessage('hi')], {} as never);
		const payload = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
		expect('run_id' in payload).toBe(false);
		expect('task_id' in payload).toBe(false);
		expect('tools' in payload.kwargs).toBe(false);
	});

	it('surfaces gateway errors readably', async () => {
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({ detail: "unknown llm client 'nope'; registered: ['research']" }),
				{ status: 422 },
			),
		);
		const model = new TrackedChatModel(CONFIG);
		await expect(model._generate([new HumanMessage('hi')], {} as never)).rejects.toThrow(
			/\[422\].*unknown llm client/,
		);
	});

	it('surfaces an unreachable gateway readably', async () => {
		fetchMock.mockRejectedValue(new Error('fetch failed'));
		const model = new TrackedChatModel(CONFIG);
		await expect(model._generate([new HumanMessage('hi')], {} as never)).rejects.toThrow(
			/gateway unreachable at http:\/\/gw:8180/,
		);
	});

	describe('tools agent compatibility', () => {
		it('exposes bindTools for the tools agent probe', () => {
			const model = new TrackedChatModel(CONFIG);
			expect(typeof model.bindTools).toBe('function');
		});

		it('forwards bound tools to the gateway on invocation', async () => {
			fetchMock.mockResolvedValue(
				okResponse({
					status: 'ok',
					call_id: 'cid-bound',
					response: { choices: [{ message: { content: 'ok' } }] },
				}),
			);
			const bound = new TrackedChatModel(CONFIG).bindTools([OPENAI_TOOL_SPEC]);
			await bound.invoke([new HumanMessage('hi')]);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const payload = JSON.parse(
				String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
			);
			expect(payload.kwargs.tools).toEqual([OPENAI_TOOL_SPEC]);
		});

		it('passes already wire-shaped tool specs through unchanged', async () => {
			fetchMock.mockResolvedValue(
				okResponse({
					status: 'ok',
					call_id: 'cid-wire',
					response: { choices: [{ message: { content: 'ok' } }] },
				}),
			);
			const model = new TrackedChatModel(CONFIG);
			await model._generate([new HumanMessage('hi')], {
				tools: [OPENAI_TOOL_SPEC],
			} as never);

			const payload = JSON.parse(
				String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
			);
			expect(payload.kwargs.tools).toEqual([OPENAI_TOOL_SPEC]);
		});
	});
});

describe('governed streaming contract (_stream / _astream)', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('yields token-level chunks from the SSE delta frames', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				{ type: 'delta', text: 'hel', reasoning: '' },
				{ type: 'delta', text: 'lo', reasoning: '' },
				{ type: 'delta', text: ' world', reasoning: '' },
				{ type: 'done', call_id: 'cid-s', usage: null },
			]),
		);
		const model = new TrackedChatModel(CONFIG);

		const chunks = await collectChunks(model, [new HumanMessage('hi')]);

		// The request hit the streaming endpoint with include_usage.
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('http://gw:8180/governed/llm-chat-stream');
		expect((init.headers as Record<string, string>).Accept).toBe('text/event-stream');
		const payload = JSON.parse(String(init.body));
		expect(payload.kwargs.include_usage).toBe(true);

		// Token-level chunks: one chunk per delta frame, content
		// accumulating to the full text (the monolithic-fallback
		// regression these overrides exist to prevent).
		expect(chunks.length).toBeGreaterThanOrEqual(3);
		expect(chunks.map((c) => c.content).join('')).toBe('hello world');
	});

	it('routes _stream (the ChatOpenAI-style extension point) through the same governed path', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				{ type: 'delta', text: 'hel', reasoning: '' },
				{ type: 'delta', text: 'lo', reasoning: '' },
				{ type: 'done', call_id: 'cid-s2', usage: null },
			]),
		);
		const model = new TrackedChatModel(CONFIG);

		const streaming = model as unknown as StreamingModel;
		const texts: string[] = [];
		for await (const generation of streaming._stream([new HumanMessage('hi')], {})) {
			texts.push(String(generation.message.content));
		}

		expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
			'http://gw:8180/governed/llm-chat-stream',
		);
		expect(texts.join('')).toBe('hello');
	});

	it('carries reasoning deltas as additional_kwargs (thinking stream)', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				{ type: 'delta', text: '', reasoning: 'thinking hard...' },
				{ type: 'delta', text: 'answer', reasoning: '' },
				{ type: 'done', call_id: 'cid-r', usage: null },
			]),
		);
		const model = new TrackedChatModel(CONFIG);

		const chunks = await collectChunks(model, [new HumanMessage('hi')]);

		const reasoningChunk = chunks.find(
			(c) =>
				(c.additional_kwargs as Record<string, unknown> | undefined)?.reasoning_content ===
				'thinking hard...',
		);
		expect(reasoningChunk).toBeDefined();
		expect(chunks.map((c) => c.content).join('')).toBe('answer');
	});

	it('carries usage_metadata from the done frame onto the final chunk', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				{ type: 'delta', text: 'ok', reasoning: '' },
				{
					type: 'done',
					call_id: 'cid-u',
					usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
				},
			]),
		);
		const model = new TrackedChatModel(CONFIG);

		const chunks = await collectChunks(model, [new HumanMessage('hi')]);

		const withUsage = chunks.find((c) => c.usage_metadata !== undefined);
		expect(withUsage?.usage_metadata).toEqual({
			input_tokens: 3,
			output_tokens: 2,
			total_tokens: 5,
		});
	});

	it('forwards bound tool specs on the streaming path too', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([
				{ type: 'delta', text: 'ok', reasoning: '' },
				{ type: 'done', call_id: 'cid-t', usage: null },
			]),
		);
		const model = new TrackedChatModel(CONFIG);

		// bindTools merges the specs into the call options; the streaming
		// path must forward them to the gateway verbatim.
		await collectChunks(model, [new HumanMessage('hi')], {
			tools: [OPENAI_TOOL_SPEC],
		});

		const payload = JSON.parse(
			String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body),
		);
		expect(payload.kwargs.tools).toEqual([OPENAI_TOOL_SPEC]);
	});

	it('throws readably on an error frame', async () => {
		fetchMock.mockResolvedValue(
			sseResponse([{ type: 'error', detail: 'boom: upstream interrupted' }]),
		);
		const model = new TrackedChatModel(CONFIG);

		await expect(collectChunks(model, [new HumanMessage('hi')])).rejects.toThrow(
			/governed chat stream failed.*boom/,
		);
	});

	it('skips malformed and keepalive SSE lines without failing', async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(': keepalive\n\n'));
				controller.enqueue(
					encoder.encode('data: {"type":"delta","text":"a","reasoning":""}\n\n'),
				);
				controller.enqueue(encoder.encode('data: not-json\n\n'));
				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				controller.enqueue(
					encoder.encode('data: {"type":"done","call_id":"c","usage":null}\n\n'),
				);
				controller.close();
			},
		});
		fetchMock.mockResolvedValue(
			new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			}),
		);
		const model = new TrackedChatModel(CONFIG);

		const chunks = await collectChunks(model, [new HumanMessage('hi')]);
		expect(chunks.map((c) => c.content).join('')).toBe('a');
	});
});