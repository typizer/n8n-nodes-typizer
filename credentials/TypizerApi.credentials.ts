import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TypizerApi implements ICredentialType {
	name = 'typizerApi';

	displayName = 'Typizer API';

	icon: Icon = { light: 'file:../icons/typizer.svg', dark: 'file:../icons/typizer.dark.svg' };

	documentationUrl = 'https://docs.typizer.ru/how-to/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'tz_live_…',
			description:
				'Create a key at https://my.typizer.ru/developers/keys. Access «Только запуск прогонов» (runs only) is enough; "Describe in Words" needs «Полный доступ» (full access).',
		},
		{
			displayName: 'API URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.typizer.ru',
			description: 'Leave as is unless you use a dedicated Typizer installation.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/me',
			method: 'GET',
		},
	};
}
