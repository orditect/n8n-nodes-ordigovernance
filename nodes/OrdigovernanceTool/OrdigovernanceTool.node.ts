import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { gatewayRequest, type GatewayCredentials } from '../shared/gatewayHttp';
import { asTrimmedString, parseJsonObject } from '../shared/nodeParams';

const CREDENTIAL_TYPE = 'ordigovernanceApi';
const PATH_TOOL_CALL = '/governed/tool-call';

export class OrdigovernanceTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ordigovernance Tool',
		name: 'ordigovernanceTool',
		icon: 'fa:wrench',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["toolName"] }}',
		description: 'Invoke a tool through the Ordigovernance gateway governance path',
		defaults: { name: 'Ordigovernance Tool' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [{ name: CREDENTIAL_TYPE, required: true }],
		properties: [
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: '',
				required: true,
				description:
					'Name of the registered tool to invoke (see GET /runs/{id}/vocabulary; unknown names fail with a 422 listing the valid names)',
			},
			{
				displayName: 'Inputs',
				name: 'toolInputs',
				type: 'json',
				default: '{}',
				description:
					'JSON object of keyword arguments expanded into the tool handler',
			},
			{
				displayName: 'Run ID',
				name: 'runId',
				type: 'string',
				default: '',
				description: 'Optional run identifier to link this tool call to',
			},
			{
				displayName: 'Task ID',
				name: 'taskId',
				type: 'string',
				default: '',
				description:
					'Optional task identifier to attribute the call to (must belong to the addressed run; 404 otherwise)',
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
				const toolName = asTrimmedString(this.getNodeParameter('toolName', itemIndex));
				const toolInputs = parseJsonObject(
					this.getNodeParameter('toolInputs', itemIndex),
					'toolInputs',
				);
				const runId = asTrimmedString(this.getNodeParameter('runId', itemIndex));
				const taskId = asTrimmedString(this.getNodeParameter('taskId', itemIndex));

				// Gateway ToolCallRequest schema: {tool, inputs, run_id?, task_id?}.
				// The tool name doubles as the call_id purpose (naming
				// discipline); unknown body fields are silently dropped.
				const body: Record<string, unknown> = {
					tool: toolName,
					inputs: toolInputs,
				};
				if (runId) body.run_id = runId;
				if (taskId) body.task_id = taskId;

				const response = await gatewayRequest(credentials, {
					method: 'POST',
					path: PATH_TOOL_CALL,
					body,
				});
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