import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrdigovernanceApproval } from '../nodes/OrdigovernanceApproval/OrdigovernanceApproval.node';
import { OrdigovernanceRun } from '../nodes/OrdigovernanceRun/OrdigovernanceRun.node';
import { OrdigovernanceTask } from '../nodes/OrdigovernanceTask/OrdigovernanceTask.node';
import { OrdigovernanceTool } from '../nodes/OrdigovernanceTool/OrdigovernanceTool.node';
import { OrdigovernanceComposite } from '../nodes/OrdigovernanceComposite/OrdigovernanceComposite.node';
import { OrdigovernanceEvidence } from '../nodes/OrdigovernanceEvidence/OrdigovernanceEvidence.node';

const CREDENTIALS = {
	baseUrl: 'http://gateway.test/',
	token: 'test-token',
	viewerBaseUrl: 'http://viewer.test/',
};

const NODE: INode = {
	id: 'node-1',
	name: 'Test Node',
	type: 'ordigovernanceTest',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const fetchMock = vi.fn();

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal('fetch', fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function lastRequest(): { url: string; init: RequestInit; body: Record<string, unknown> } {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return {
		url,
		init,
		body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
	};
}

function createContext(
	parameters: Record<string, unknown>,
	items: INodeExecutionData[] = [{ json: {} }],
): IExecuteFunctions {
	const partial = {
		getInputData: () => items,
		getNode: () => NODE,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		getNodeParameter: (name: string, _itemIndex: number, fallback?: any) =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(parameters[name] !== undefined ? parameters[name] : fallback) as any,
		getCredentials: async (type: string) => {
			if (type !== 'ordigovernanceApi') {
				throw new Error(`unexpected credential type: ${type}`);
			}
			return CREDENTIALS as unknown as IDataObject;
		},
		continueOnFail: () => false,
	};
	return partial as unknown as IExecuteFunctions;
}

describe('OrdigovernanceRun', () => {
	it('starts a run with the gateway StartRunRequest schema fields only', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ run_id: 'run-1', status: 'running' }));
		const context = createContext({
			operation: 'start',
			runId: '',
			budgetMaxUnits: 50000,
			intent: 'demo narrative',
			metadata: { origin: 'test' },
			cancelExistingOnConflict: false,
		});

		const [output] = await new OrdigovernanceRun().execute.call(context);

		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/runs');
		expect(request.init.method).toBe('POST');
		expect((request.init.headers as Record<string, string>).Authorization).toBe(
			'Bearer test-token',
		);
		// Schema-alignment regression lock: pydantic silently drops unknown
		// fields, so the body must carry exactly the gateway's
		// StartRunRequest vocabulary (run_id / budget_max_units / intent /
		// metadata) and nothing else.
		expect(request.body).toEqual({
			budget_max_units: 50000,
			intent: 'demo narrative',
			metadata: { origin: 'test' },
		});
		expect(output[0].json).toMatchObject({ run_id: 'run-1' });
	});

	it('sends an explicit run_id when provided', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ run_id: 'run-explicit', status: 'running' }));
		const context = createContext({
			operation: 'start',
			runId: 'run-explicit',
			budgetMaxUnits: 0,
			intent: '',
			metadata: '{}',
			cancelExistingOnConflict: false,
		});

		await new OrdigovernanceRun().execute.call(context);

		expect(lastRequest().body).toEqual({ run_id: 'run-explicit' });
	});

	it('finishes a run with NO body (the gateway derives final_status)', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ run_id: 'run-1', final_status: 'succeeded' }),
		);
		const context = createContext({
			operation: 'finish',
			runId: 'run-1',
		});

		const [output] = await new OrdigovernanceRun().execute.call(context);

		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/runs/run-1/finish');
		// Regression lock: the finish endpoint takes no body; a
		// client-declared status would be silently dropped AND would imply
		// the client can declare run outcomes, which it cannot.
		expect(request.body).toEqual({});
		expect(output[0].json).toMatchObject({ final_status: 'succeeded' });
	});

	it('force-cancels a wedged run via the cancel endpoint with no body', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				run_id: 'run-1',
				status: 'cancelled',
				cancelled_tasks: ['slow-task'],
			}),
		);
		const context = createContext({
			operation: 'cancel',
			runId: 'run-1',
			pollTimeoutMs: 45000,
		});

		const [output] = await new OrdigovernanceRun().execute.call(context);

		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/runs/run-1/cancel');
		expect(request.init.method).toBe('POST');
		// Cancel takes NO body; the gateway waits for task settlement.
		expect(request.body).toEqual({});
		expect(output[0].json).toMatchObject({
			status: 'cancelled',
			cancelled_tasks: ['slow-task'],
		});
	});

	it('force-cancels the conflicting run and retries when cancelExistingOnConflict is set', async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({ detail: "a run is already in progress: 'run-stale'" }, 409),
			)
			.mockImplementation(() =>
				// Fresh Response per call: a Response body is a one-shot stream.
				Promise.resolve(jsonResponse({ run_id: 'run-stale', status: 'cancelled' })),
			)
			.mockImplementation(() =>
				Promise.resolve(jsonResponse({ run_id: 'run-new', status: 'running' })),
			);
		const context = createContext({
			operation: 'start',
			runId: '',
			budgetMaxUnits: 0,
			intent: '',
			metadata: '{}',
			cancelExistingOnConflict: true,
		});

		const [output] = await new OrdigovernanceRun().execute.call(context);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		// The structured 409 body.detail names the stale run; the recovery
		// path force-CANCELS it (the escape hatch that also settles its
		// running tasks), then retries the start.
		expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
			'http://gateway.test/runs/run-stale/cancel',
		);
		expect(output[0].json).toMatchObject({ run_id: 'run-new' });
	});

	it('propagates 409 without retry when cancelExistingOnConflict is off', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ detail: "a run is already in progress: 'run-stale'" }, 409),
		);
		const context = createContext({
			operation: 'start',
			runId: '',
			budgetMaxUnits: 0,
			intent: '',
			metadata: '{}',
			cancelExistingOnConflict: false,
		});

		await expect(new OrdigovernanceRun().execute.call(context)).rejects.toThrow(/\[409\]/);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('OrdigovernanceTool', () => {
	it('posts a governed tool call with the gateway ToolCallRequest schema fields only', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', result: { echoed: true } }));
		const context = createContext({
			toolName: 'search',
			toolInputs: { query: 'hello' },
			runId: 'run-1',
			taskId: 'task-1',
		});

		await new OrdigovernanceTool().execute.call(context);

		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/governed/tool-call');
		// Schema-alignment regression lock: the gateway schema carries
		// {tool, inputs, run_id?, task_id?}; client/purpose fields would be
		// silently dropped (the tool name doubles as the call purpose).
		expect(request.body).toEqual({
			tool: 'search',
			inputs: { query: 'hello' },
			run_id: 'run-1',
			task_id: 'task-1',
		});
	});

	it('omits run/task linkage when empty', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', result: {} }));
		const context = createContext({
			toolName: 'search',
			toolInputs: {},
			runId: '',
			taskId: '',
		});

		await new OrdigovernanceTool().execute.call(context);

		expect(lastRequest().body).toEqual({ tool: 'search', inputs: {} });
	});

	it('surfaces a readable error on gateway rejection', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ detail: 'denied by policy' }, 403));
		const context = createContext({
			toolName: 'search',
			toolInputs: {},
			runId: '',
			taskId: '',
		});

		await expect(new OrdigovernanceTool().execute.call(context)).rejects.toThrow(
			/\[403\].*denied by policy/,
		);
	});
});

describe('OrdigovernanceTask', () => {
	it('returns the submit response when not waiting', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_id: 'task-1', accepted: true }));
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: { text: 'hi' },
			toolsWhitelist: '',
			upstream: '',
			waitForCompletion: false,
		});

		const [output] = await new OrdigovernanceTask().execute.call(context);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/runs/run-1/tasks');
		expect(request.body).toEqual({ task_id: 'task-1', impl: 'classify', params: { text: 'hi' } });
		expect(output[0].json).toMatchObject({ task_id: 'task-1', accepted: true });
	});

	it('sends the tools whitelist when provided (governance restriction)', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_id: 'task-1', accepted: true }));
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'researcher',
			taskInput: {},
			toolsWhitelist: 'search, vector',
			upstream: '',
			waitForCompletion: false,
		});

		await new OrdigovernanceTask().execute.call(context);

		expect(lastRequest().body).toMatchObject({
			tools: ['search', 'vector'],
		});
	});

	it('polls until the task reaches a terminal state', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', accepted: true }))
			.mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'running' }))
			.mockResolvedValueOnce(
				jsonResponse({ task_id: 'task-1', status: 'succeeded', result: { ok: 1 } }),
			);
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: {},
			toolsWhitelist: '',
			upstream: '',
			waitForCompletion: true,
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		const [output] = await new OrdigovernanceTask().execute.call(context);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
			'http://gateway.test/runs/run-1/tasks/task-1',
		);
		expect(output[0].json).toMatchObject({ task_id: 'task-1', status: 'succeeded' });
	});

	it('sends upstream evidence edges when provided (D1)', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_id: 'task-1', accepted: true }));
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: {},
			toolsWhitelist: '',
			upstream: 'task-a, task-b',
			waitForCompletion: false,
		});

		await new OrdigovernanceTask().execute.call(context);

		expect(lastRequest().body).toMatchObject({ upstream: ['task-a', 'task-b'] });
	});

	it('auto-suffixes colliding task ids across items (D11)', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ task_id: 'task-1', accepted: true })),
		);
		const context = createContext(
			{
				runId: 'run-1',
				taskId: 'task-1',
				impl: 'classify',
				taskInput: {},
				toolsWhitelist: '',
				upstream: '',
				waitForCompletion: false,
			},
			[{ json: {} }, { json: {} }],
		);

		await new OrdigovernanceTask().execute.call(context);

		const bodies = fetchMock.mock.calls.map(
			([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
		);
		expect(bodies[0].task_id).toBe('task-1');
		expect(bodies[1].task_id).toBe('task-1-1');
	});

	it('trims whitespace from expression-field ids (n8n literal-text pitfall)', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_id: 'task-1', accepted: true }));
		const context = createContext({
			runId: '   run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: {},
			toolsWhitelist: '',
			upstream: '',
			waitForCompletion: false,
		});

		await new OrdigovernanceTask().execute.call(context);

		expect(lastRequest().url).toBe('http://gateway.test/runs/run-1/tasks');
	});

	it('names the impl payload field "params" (silent-drop regression lock)', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_id: 'task-1', accepted: true }));
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: { topic: 'EV batteries' },
			toolsWhitelist: '',
			upstream: '',
			waitForCompletion: false,
		});

		await new OrdigovernanceTask().execute.call(context);

		expect(lastRequest().body).toMatchObject({ params: { topic: 'EV batteries' } });
		expect(lastRequest().body).not.toHaveProperty('input');
	});

	it('fails the node when the task settles on a non-succeeded terminal state', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', accepted: true }))
			.mockResolvedValueOnce(jsonResponse({ task_id: 'task-1', status: 'failed', result: null }));
		const context = createContext({
			runId: 'run-1',
			taskId: 'task-1',
			impl: 'classify',
			taskInput: {},
			toolsWhitelist: '',
			upstream: '',
			waitForCompletion: true,
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		await expect(new OrdigovernanceTask().execute.call(context)).rejects.toThrow(
			/terminal status "failed"/,
		);
	});
});

describe('OrdigovernanceApproval', () => {
	it.each([
		['pause', 'http://gateway.test/runs/run-1/hitl/pause'],
		['resume', 'http://gateway.test/runs/run-1/hitl/resume'],
		['retry', 'http://gateway.test/runs/run-1/hitl/retry'],
	])('posts %s to the hitl route', async (operation, expectedUrl) => {
		fetchMock.mockResolvedValue(jsonResponse({ action_id: 'act-1', accepted: true }));
		const context = createContext({
			operation,
			runId: 'run-1',
			taskId: 'task-1',
			waitForReceipt: false,
			pollIntervalMs: 1,
			pollTimeoutMs: 100,
		});

		await new OrdigovernanceApproval().execute.call(context);

		expect(lastRequest().url).toBe(expectedUrl);
	});

	it('sends task_id for pause/retry and root_id defaulting to the run id for resume', async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ action_id: 'act-1', accepted: true })),
		);
		const pauseCtx = createContext({
			operation: 'pause',
			runId: 'run-1',
			taskId: 'task-1',
			waitForReceipt: false,
			pollIntervalMs: 1,
			pollTimeoutMs: 100,
		});
		await new OrdigovernanceApproval().execute.call(pauseCtx);
		expect(lastRequest().body).toEqual({ task_id: 'task-1' });

		const resumeCtx = createContext({
			operation: 'resume',
			runId: 'run-1',
			taskId: '',
			rootId: '',
			waitForReceipt: false,
			pollIntervalMs: 1,
			pollTimeoutMs: 100,
		});
		await new OrdigovernanceApproval().execute.call(resumeCtx);
		expect(lastRequest().body).toEqual({ root_id: 'run-1' });
	});

	it('polls the execution receipt while it 404s (dual-receipt discipline)', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ action_id: 'act-1', accepted: true }))
			.mockResolvedValueOnce(jsonResponse({ detail: 'pending' }, 404))
			.mockResolvedValueOnce(jsonResponse({ action_id: 'act-1', status: 'executed', rerun: 1 }));
		const context = createContext({
			operation: 'pause',
			runId: 'run-1',
			taskId: 'task-1',
			waitForReceipt: true,
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		const [output] = await new OrdigovernanceApproval().execute.call(context);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
			'http://gateway.test/runs/run-1/hitl/receipt/act-1',
		);
		expect(output[0].json).toMatchObject({
			acceptance: { action_id: 'act-1' },
			receipt: { status: 'executed', rerun: 1 },
		});
	});

	it('awaitDecision resolves approved when a new generation appears', async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					task_id: 'task-1',
					status: 'cancelled',
					execution_id: 'e-1',
					previous_execution_ids: [],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					task_id: 'task-1',
					status: 'running',
					execution_id: 'e-2',
					previous_execution_ids: ['e-1'],
				}),
			);
		const context = createContext({
			operation: 'awaitDecision',
			runId: 'run-1',
			taskId: 'task-1',
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		const [output] = await new OrdigovernanceApproval().execute.call(context);

		expect(output[0].json).toMatchObject({ status: 'approved', execution_id: 'e-2' });
	});

	it('awaitDecision resolves rejected when the run finishes (hot read 404, D14)', async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					task_id: 'task-1',
					status: 'cancelled',
					execution_id: 'e-1',
					previous_execution_ids: [],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({ detail: 'historical evidence belongs to the viewer' }, 404),
			);
		const context = createContext({
			operation: 'awaitDecision',
			runId: 'run-1',
			taskId: 'task-1',
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		const [output] = await new OrdigovernanceApproval().execute.call(context);

		expect(output[0].json).toMatchObject({ status: 'rejected' });
	});
});

describe('OrdigovernanceComposite', () => {
	it('starts a composite with name and params', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ composite_id: 'cmp-1', accepted: true }));
		const context = createContext({
			runId: 'run-1',
			compositeName: 'quality_gate_pair',
			compositeParams: { producer_id: 'writer-9', threshold: 80 },
			waitForCompletion: false,
		});

		const [output] = await new OrdigovernanceComposite().execute.call(context);

		const request = lastRequest();
		expect(request.url).toBe('http://gateway.test/runs/run-1/composites');
		expect(request.body).toEqual({
			name: 'quality_gate_pair',
			params: { producer_id: 'writer-9', threshold: 80 },
		});
		expect(output[0].json).toMatchObject({ composite_id: 'cmp-1' });
	});

	it('polls until the composite settles and returns children as object rows (gateway shape)', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ composite_id: 'cmp-1', accepted: true }))
			.mockResolvedValueOnce(jsonResponse({ composite_id: 'cmp-1', status: 'running' }))
			.mockResolvedValueOnce(
				jsonResponse({
					composite_id: 'cmp-1',
					status: 'succeeded',
					// Gateway CompositeStatusResponse.children is a list of
					// {task_id, status, execution_id} OBJECTS; the earlier mock
					// locked a string-array shape that never existed on the wire.
					children: [
						{ task_id: 'writer-9', status: 'succeeded', execution_id: 'e-w1' },
						{ task_id: 'reviewer-9', status: 'succeeded', execution_id: 'e-r1' },
					],
					outcome: { passed: true, iterations: 2, scores: [62, 88] },
				}),
			);
		const context = createContext({
			runId: 'run-1',
			compositeName: 'quality_gate_pair',
			compositeParams: {},
			waitForCompletion: true,
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		const [output] = await new OrdigovernanceComposite().execute.call(context);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
			'http://gateway.test/runs/run-1/composites/cmp-1',
		);
		expect(output[0].json).toMatchObject({
			status: 'succeeded',
			children: [
				{ task_id: 'writer-9', status: 'succeeded' },
				{ task_id: 'reviewer-9', status: 'succeeded' },
			],
			outcome: { passed: true, iterations: 2 },
		});
	});

	it('fails the node when the composite settles on a non-succeeded terminal state', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ composite_id: 'cmp-1', accepted: true }))
			.mockResolvedValueOnce(jsonResponse({ composite_id: 'cmp-1', status: 'failed' }));
		const context = createContext({
			runId: 'run-1',
			compositeName: 'quality_gate_pair',
			compositeParams: {},
			waitForCompletion: true,
			pollIntervalMs: 1,
			pollTimeoutMs: 2000,
		});

		await expect(new OrdigovernanceComposite().execute.call(context)).rejects.toThrow(
			/terminal status "failed"/,
		);
	});
});

describe('OrdigovernanceEvidence', () => {
	it('reads one generation content (archived result + pins) from the viewer host', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				task_id: 'task-1',
				execution_id: 'e-1',
				result: { marker: 'hello' },
				input_pins: { upstream: 'e-0' },
			}),
		);
		const context = createContext({
			operation: 'getGeneration',
			runId: 'run-1',
			taskId: 'task-1',
			executionId: 'e-1',
			rootId: '',
		});

		const [output] = await new OrdigovernanceEvidence().execute.call(context);

		const request = lastRequest();
		// Evidence reads hit the VIEWER host (cold path), not the gateway.
		expect(request.url).toBe(
			'http://viewer.test/api/runs/run-1/generations/task-1/e-1/content',
		);
		expect((request.init.headers as Record<string, string>).Authorization).toBe(
			'Bearer test-token',
		);
		expect(output[0].json).toMatchObject({
			task_id: 'task-1',
			input_pins: { upstream: 'e-0' },
		});
	});

	it('lists generations as one item per row', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse([
				{ task_id: 'a', execution_id: 'e-1', status: 'succeeded' },
				{ task_id: 'a', execution_id: 'e-2', status: 'succeeded' },
			]),
		);
		const context = createContext({
			operation: 'listGenerations',
			runId: 'run-1',
			rootId: '',
		});

		const output = await new OrdigovernanceEvidence().execute.call(context);

		expect(lastRequest().url).toBe(
			'http://viewer.test/api/runs/run-1/generations?root_id=run-1',
		);
		expect(output[0]).toHaveLength(2);
		expect(output[0][1].json).toMatchObject({ execution_id: 'e-2' });
	});

	it('reads the audit stream, optionally scoped to one task', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse([{ event_type: 'llm_call', event_id: 'x-1' }]),
		);
		const context = createContext({
			operation: 'getAudit',
			runId: 'run-1',
			taskId: 'task-1',
			rootId: '',
		});

		const output = await new OrdigovernanceEvidence().execute.call(context);

		expect(lastRequest().url).toBe(
			'http://viewer.test/api/runs/run-1/audit?task_id=task-1',
		);
		expect(output[0][0].json).toMatchObject({ event_type: 'llm_call' });
	});

	it('reads the whole audit stream when task id is empty', async () => {
		fetchMock.mockResolvedValue(jsonResponse([]));
		const context = createContext({
			operation: 'getAudit',
			runId: 'run-1',
			taskId: '',
			rootId: '',
		});

		await new OrdigovernanceEvidence().execute.call(context);

		expect(lastRequest().url).toBe('http://viewer.test/api/runs/run-1/audit');
	});

	it('validates the run bundle (self-certification)', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ available: true, ok: true, summary: '3 checks passed' }),
		);
		const context = createContext({
			operation: 'validate',
			runId: 'run-1',
			rootId: 'run-1',
		});

		const [output] = await new OrdigovernanceEvidence().execute.call(context);

		expect(lastRequest().url).toBe(
			'http://viewer.test/api/runs/run-1/validate?root_id=run-1',
		);
		expect(output[0].json).toMatchObject({ available: true, ok: true });
	});

	it('reads the dependency graph and lineage tree', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ task_ids: ['a'], edges: [] }));
		const graphContext = createContext({
			operation: 'getGraph',
			runId: 'run-1',
			rootId: 'run-1',
		});
		await new OrdigovernanceEvidence().execute.call(graphContext);
		expect(lastRequest().url).toBe(
			'http://viewer.test/api/runs/run-1/graph?root_id=run-1',
		);

		fetchMock.mockResolvedValue(
			jsonResponse([{ task_id: 'a', status: 'succeeded' }]),
		);
		const treeContext = createContext({
			operation: 'getTree',
			runId: 'run-1',
			rootId: 'run-1',
		});
		const treeOutput = await new OrdigovernanceEvidence().execute.call(treeContext);
		expect(lastRequest().url).toBe(
			'http://viewer.test/api/runs/run-1/tree?root_id=run-1',
		);
		expect(treeOutput[0][0].json).toMatchObject({ task_id: 'a' });
	});

	it('fails loudly when the credential carries no viewer base url', async () => {
		const context = createContext({
			operation: 'validate',
			runId: 'run-1',
			rootId: '',
		});
		const partial = context as unknown as {
			getCredentials: (type: string) => Promise<Record<string, unknown>>;
		};
		const original = partial.getCredentials;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(partial as any).getCredentials = async () => ({
			baseUrl: 'http://gateway.test/',
			token: 'test-token',
		});
		try {
			await expect(
				new OrdigovernanceEvidence().execute.call(context),
			).rejects.toThrow(/Viewer Base URL/);
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(partial as any).getCredentials = original;
		}
	});
});