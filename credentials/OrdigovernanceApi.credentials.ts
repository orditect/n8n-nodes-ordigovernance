import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class OrdigovernanceApi implements ICredentialType {
	name = 'ordigovernanceApi';

	displayName = 'Ordigovernance Gateway API';

	documentationUrl = 'https://github.com/orditect/n8n-nodes-ordigovernance#readme';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://localhost:8180',
			description:
				'The ordigovernance gateway base URL (http://gateway:8180 inside the compose network)',
		},
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'The GATEWAY_AUTH_TOKEN of the gateway deployment',
		},
		{
			displayName: 'Viewer Base URL',
			name: 'viewerBaseUrl',
			type: 'string',
			default: 'http://localhost:8181',
			description:
				'Base URL of the cold-path viewer host serving the evidence endpoints (tree / generations / graph / audit / validate). Used by the Evidence node; empty falls back to this default.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.token}}',
			},
		},
	};

	// The credential test must exercise an AUTHENTICATED route: /healthz
	// is auth-exempt on the gateway, so a wrong token passed the test
	// and the first real call failed with 401 (false positive).
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/runs',
			method: 'GET',
		},
	};
}