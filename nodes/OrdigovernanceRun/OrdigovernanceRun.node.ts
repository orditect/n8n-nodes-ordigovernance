import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	gatewayRequest,
	GatewayHttpError,
	type GatewayCredentials,
} from '../shared/gatewayHttp';
import { asTrimmedString, parseJsonObject } from '../shared/nodeParams';

const CREDENTIAL_TYPE = 'ordigovernanceApi';
const PATH_RUNS = '/runs';
const pathRunFinish = (runId: string): string =>
	`/runs/${encodeURIComponent(runId)}/finish`;
const pathRunCancel = (runId: string): string =>
	`/runs/${encodeURIComponent(runId)}/cancel`;

/**
 * Extract the conflicting run id from a structured 409 body.
 *
 * The gateway's 409 detail string IS the contract ("a run is already
 * in progress: '<run-id>'"); reading it from the structured body field
 * (never the rendered error message) survives message-format changes.
 */
function conflictRunIdOf(error: unknown): string | null {
	if (!(error instanceof GatewayHttpError) || error.status !== 409) return null;
	const detail = error.body.detail;
	if (typeof detail !== 'string') return null;
	const match = detail.match(/'([^']+)'/);
	return match ? match[1] : null;
}

export class OrdigovernanceRun implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ordigovernance Run',
		name: 'ordigovernanceRun',
		icon: 'fa:play',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Start, finish or force-cancel a governed run on the Ordigovernance gateway',
		defaults: { name: 'Ordigovernance Run' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: CREDENTIAL_TYPE, required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Start', value: 'start', action: 'Start a governed run' },
					{ name: 'Finish', value: 'finish', action: 'Finish a governed run' },
					{ name: 'Cancel', value: 'cancel', action: 'Force-cancel a wedged run' },
				],
				default: 'start',
			},
			// ---- start -----------------------------------------------------
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['start'] } },
				description:
					'Optional explicit run id (idempotent retries); empty lets the gateway mint one',
			},
			{
				displayName: 'Budget Max Units',
				name: 'budgetMaxUnits',
				type: 'number',
				default: 0,
				displayOptions: { show: { operation: ['start'] } },
				description:
					'Budget cap in token units for the run (0 = the gateway default). Unknown body fields are silently dropped by the gateway schema, so this must ride the budget_max_units field.',
			},
			{
				displayName: 'Intent',
				name: 'intent',
				type: 'string',
				default: '',
				displayOptions: { show: { operation: ['start'] } },
				description:
					'Business intent recorded on the run registry entry (provenance only; the gateway never interprets it)',
			},
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				displayOptions: { show: { operation: ['start'] } },
				description: 'Optional JSON metadata recorded on the registry entry',
			},
			{
				displayName: 'Cancel Existing on Conflict',
				name: 'cancelExistingOnConflict',
				type: 'boolean',
				default: false,
				displayOptions: { show: { operation: ['start'] } },
				description:
					'On 409, force-cancel the stale run (the gateway cancels its running tasks and closes it) and retry once. Dev convenience; keep off in production so conflicts surface loudly.',
			},
			// ---- finish ----------------------------------------------------
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['finish'] } },
				description: 'Identifier of the run to finish',
			},
			// ---- cancel ----------------------------------------------------
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['cancel'] } },
				description:
					'Identifier of the wedged run to force-cancel (cooperative-cancel its running tasks, then close as cancelled)',
			},
			{
				displayName: 'Poll Timeout (Ms)',
				name: 'pollTimeoutMs',
				type: 'number',
				default: 300000,
				displayOptions: { show: { operation: ['cancel'] } },
				description:
					'Cancel waits for every running task to settle; this value doubles as the transport timeout floor (minimum 60s)',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials(
			CREDENTIAL_TYPE,
		)) as unknown as GatewayCredentials;
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				let response: Record<string, unknown>;

				if (operation === 'start') {
					// Gateway StartRunRequest schema: {run_id?, budget_max_units?,
					// intent?, metadata?}. Pydantic drops unknown fields silently
					// (pitfall: contract drift), so the body carries exactly these.
					const body: Record<string, unknown> = {};
					const runId = asTrimmedString(this.getNodeParameter('runId', itemIndex));
					if (runId) body.run_id = runId;
					const budgetMaxUnits = this.getNodeParameter(
						'budgetMaxUnits',
						itemIndex,
						0,
					) as number;
					if (budgetMaxUnits > 0) body.budget_max_units = budgetMaxUnits;
					const intent = asTrimmedString(this.getNodeParameter('intent', itemIndex));
					if (intent) body.intent = intent;
					const metadata = parseJsonObject(
						this.getNodeParameter('metadata', itemIndex),
						'metadata',
					);
					if (Object.keys(metadata).length > 0) body.metadata = metadata;

					const cancelExisting = this.getNodeParameter(
						'cancelExistingOnConflict',
						itemIndex,
						false,
					) as boolean;

					try {
						response = await gatewayRequest(credentials, {
							method: 'POST',
							path: PATH_RUNS,
							body,
						});
					} catch (error) {
						// Single-active-run gateway: on 409, optionally force-cancel
						// the stale run (the escape hatch that also settles its
						// running tasks) and retry once.
						const conflictRunId = conflictRunIdOf(error);
						if (!cancelExisting || !conflictRunId) throw error;

						await gatewayRequest(credentials, {
							method: 'POST',
							path: pathRunCancel(conflictRunId),
						});
						response = await gatewayRequest(credentials, {
							method: 'POST',
							path: PATH_RUNS,
							body,
						});
					}
				} else if (operation === 'finish') {
					// Finish takes NO body: the gateway derives final_status from
					// the registered tasks' terminal statuses; a client-declared
					// status would never be trusted as evidence.
					const runId = asTrimmedString(this.getNodeParameter('runId', itemIndex));
					response = await gatewayRequest(credentials, {
						method: 'POST',
						path: pathRunFinish(runId),
					});
				} else {
					// cancel: force-cancel the run's running tasks and close it.
					// The gateway WAITS for every task to settle terminally
					// (cooperative cancel windows abort at their next slice
					// boundary), so the response can legitimately take as
					// long as the longest running task -- far beyond the
					// shared 30s default. Poll-timeout doubles as the cancel
					// transport budget with a generous floor.
					const runId = asTrimmedString(this.getNodeParameter('runId', itemIndex));
					const cancelTimeoutMs = Math.max(
						60000,
						(this.getNodeParameter('pollTimeoutMs', itemIndex, 0) as number) * 2,
					);
					response = await gatewayRequest(credentials, {
						method: 'POST',
						path: pathRunCancel(runId),
						timeoutMs: cancelTimeoutMs,
					});
				}

				returnData.push({ json: response as IDataObject, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error.message : String(error),
					{ itemIndex },

				);
			}
		}

		return [returnData];
	}
}