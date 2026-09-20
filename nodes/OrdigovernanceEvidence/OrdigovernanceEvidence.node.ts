import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { gatewayRequest, type GatewayCredentials } from '../shared/gatewayHttp';
import { asTrimmedString } from '../shared/nodeParams';

const CREDENTIAL_TYPE = 'ordigovernanceApi';

/**
 * Evidence node: read-only access to the cold-path evidence chain.
 *
 * The gateway is the WRITE path (D14: hot reads close at finish); the
 * viewer host is the READ path. This node queries the viewer's trace
 * routers so n8n workflows can consume the governance evidence -- the
 * archived result and input_pins of one generation, the audit stream
 * of one task, the bundle self-certification, the dependency graph,
 * the lineage tree -- without leaving the canvas.
 *
 * All endpoints are parameterized by run_id and hit the viewer host
 * configured on the credential (viewerBaseUrl).
 */
export class OrdigovernanceEvidence implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ordigovernance Evidence',
		name: 'ordigovernanceEvidence',
		icon: 'fa:search',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] }}',
		description: 'Read governance evidence from the cold-path viewer (read-only)',
		defaults: { name: 'Ordigovernance Evidence' },
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
					{
						name: 'Get Generation Content',
						value: 'getGeneration',
						action: 'Read one archived generation result and its lineage pins',
					},
					{
						name: 'List Generations',
						value: 'listGenerations',
						action: 'List every execution generation of a run',
					},
					{
						name: 'Get Audit',
						value: 'getAudit',
						action: 'Read the governed-call audit stream',
					},
					{
						name: 'Validate Bundle',
						value: 'validate',
						action: 'Self-certify the run trace bundle (run_rules + pin reconciliation)',
					},
					{
						name: 'Get Dependency Graph',
						value: 'getGraph',
						action: 'Read the dependency graph edges of a run',
					},
					{
						name: 'Get Lineage Tree',
						value: 'getTree',
						action: 'Read the latest-generation lineage tree of a run',
					},
				],
				default: 'getGeneration',
			},
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				required: true,
				description: 'Identifier of the run whose evidence is read',
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				displayOptions: {
					show: { operation: ['getGeneration', 'getAudit'] },
				},
				description:
					'Task to read the generation content / audit slice of (optional for getAudit: empty = the whole run audit stream)',
			},
			{
				displayName: 'Execution ID',
				name: 'executionId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['getGeneration'] } },
				description:
					'Execution id (eid) of the archived generation to read; find it via List Generations',
			},
			{
				displayName: 'Root ID',
				name: 'rootId',
				type: 'string',
				default: '',
				description:
					'Root id for the graph / tree read; empty defaults to the run id',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const credentials = (await this.getCredentials(
			CREDENTIAL_TYPE,
		)) as unknown as GatewayCredentials & { viewerBaseUrl?: string };
		const returnData: INodeExecutionData[] = [];

		const viewerBaseUrl = String(credentials.viewerBaseUrl ?? '').trim();
		if (!viewerBaseUrl) {
			throw new NodeOperationError(
				this.getNode(),
				'Viewer Base URL is not set on the Ordigovernance Gateway API credential; the evidence endpoints are served by the cold-path viewer host',
			);
		}
		const viewer: GatewayCredentials = {
			baseUrl: viewerBaseUrl,
			token: credentials.token,
		};

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const runId = asTrimmedString(this.getNodeParameter('runId', itemIndex));
				const rootId = asTrimmedString(this.getNodeParameter('rootId', itemIndex)) || runId;
				let response: Record<string, unknown>;

				if (operation === 'getGeneration') {
					const taskId = asTrimmedString(this.getNodeParameter('taskId', itemIndex));
					const executionId = asTrimmedString(
						this.getNodeParameter('executionId', itemIndex),
					);
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(runId)}/generations/${encodeURIComponent(
							taskId,
						)}/${encodeURIComponent(executionId)}/content`,
					});
				} else if (operation === 'listGenerations') {
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(
							runId,
						)}/generations?root_id=${encodeURIComponent(rootId)}`,
					});
					// Normalize to one item per generation row for
					// downstream item-based nodes.
					for (const row of Array.isArray(response) ? response : [response]) {
						returnData.push({
							json: row as IDataObject,
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				} else if (operation === 'getAudit') {
					const taskId = asTrimmedString(this.getNodeParameter('taskId', itemIndex));
					const query = taskId
						? `?task_id=${encodeURIComponent(taskId)}`
						: '';
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(runId)}/audit${query}`,
					});
					for (const row of Array.isArray(response) ? response : [response]) {
						returnData.push({
							json: row as IDataObject,
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				} else if (operation === 'validate') {
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(
							runId,
						)}/validate?root_id=${encodeURIComponent(rootId)}`,
					});
				} else if (operation === 'getGraph') {
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(
							runId,
						)}/graph?root_id=${encodeURIComponent(rootId)}`,
					});
				} else {
					// getTree
					response = await gatewayRequest(viewer, {
						method: 'GET',
						path: `/api/runs/${encodeURIComponent(
							runId,
						)}/tree?root_id=${encodeURIComponent(rootId)}`,
					});
					for (const row of Array.isArray(response) ? response : [response]) {
						returnData.push({
							json: row as IDataObject,
							pairedItem: { item: itemIndex },
						});
					}
					continue;
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