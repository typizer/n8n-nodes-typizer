import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	outputOptionProperties,
	readOutputOptions,
	splitLineItemsProperty,
	TYPIZER_ID_REGEX,
} from '../shared/descriptions';
import { bi } from '../shared/i18n';
import { searchTypizers } from '../shared/listSearch';
import { META_KEY, runToItems } from '../shared/output';
import {
	headersFresh,
	rememberDelivery,
	type SeenDeliveries,
	verifySignature,
} from '../shared/signature';
import { CABINET_URL, CREDENTIAL_NAME, typizerRequest } from '../shared/transport';
import type { Page, Problem, Run, WebhookEndpoint, WebhookEvent } from '../shared/types';

const RUN_EVENTS = ['run.succeeded', 'run.failed'];

function sameEvents(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((event) => b.includes(event));
}

function endpointUrl(ctx: IHookFunctions | IWebhookFunctions): string {
	const url = ctx.getNodeWebhookUrl('default');
	if (!url) throw new NodeOperationError(ctx.getNode(), 'n8n did not provide a webhook URL');
	return url;
}

async function findEndpointByUrl(
	ctx: IHookFunctions,
	url: string,
): Promise<WebhookEndpoint | undefined> {
	let cursor: string | undefined;
	do {
		const { body } = await typizerRequest<Page<WebhookEndpoint>>(ctx, {
			method: 'GET',
			path: '/v1/webhook_endpoints',
			qs: { limit: 100, ...(cursor ? { starting_after: cursor } : {}) },
		});
		const found = body.data.find((endpoint) => endpoint.url === url);
		if (found) return found;
		cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
	} while (cursor);
	return undefined;
}

/** Typizer delivers only to public https URLs; say so in n8n's terms, not the API's. */
function notPublicUrl(ctx: IHookFunctions, url: string, problem: Problem): NodeOperationError {
	return new NodeOperationError(
		ctx.getNode(),
		bi(
			`Typizer only delivers events to a public https URL, and this n8n's webhook URL is ${url}. Set a public address in your n8n's N8N_WEBHOOK_URL variable (WEBHOOK_URL in older versions) or use a tunnel, and try again`,
			`Typizer отправляет события только на публичный https-адрес, а адрес вебхука у этого n8n — ${url}. Задайте публичный адрес в переменной N8N_WEBHOOK_URL вашего n8n (в прежних версиях — WEBHOOK_URL) или используйте туннель и запустите снова`,
		),
		{ description: problem.detail },
	);
}

/**
 * Endpoint signing secrets, in this process's memory only. Never in the workflow's static data:
 * n8n stores that unencrypted and exports it with the workflow, and a stored copy would go stale
 * when the secret changes.
 */
interface CachedSecret {
	secret: string | null;
	fetchedAt: number;
}
const secretCache = new Map<string, CachedSecret>();
const SECRET_TTL_MS = 5 * 60_000;
/** A failed check refetches the secret at most this often, so forged requests cannot drive calls. */
const MIN_REFETCH_MS = 30_000;

/** Tests only. */
export function clearSecretCache(): void {
	secretCache.clear();
}

/**
 * The endpoint's secret: from memory while fresh, else read from Typizer — once, without
 * waiting out a 429, so a flood of requests cannot hold deliveries open.
 */
async function endpointSecret(
	ctx: IWebhookFunctions,
	endpointId: string,
	refresh = false,
): Promise<CachedSecret> {
	const cached = secretCache.get(endpointId);
	if (!refresh && cached && Date.now() - cached.fetchedAt < SECRET_TTL_MS) return cached;
	const { body } = await typizerRequest<WebhookEndpoint>(ctx, {
		method: 'GET',
		path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
		retry: false,
	});
	const entry = { secret: body.secret, fetchedAt: Date.now() };
	secretCache.set(endpointId, entry);
	return entry;
}

export class TypizerTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Typizer Trigger',
		name: 'typizerTrigger',
		icon: { light: 'file:typizer.svg', dark: 'file:typizer.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			'Starts the workflow when Typizer has processed a document: from n8n, the cabinet, the API or a batch',
		defaults: { name: 'Typizer Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL_NAME, required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['run.succeeded'],
				options: [
					{
						name: 'Document Processed',
						value: 'run.succeeded',
						description: 'Data extracted; the item holds the document fields',
					},
					{
						name: 'Document Failed',
						value: 'run.failed',
						description: 'The reason is in _typizer.error',
					},
					{
						name: 'Batch Completed',
						value: 'batch.completed',
						description: 'All documents of a batch are done',
					},
					{
						name: 'Balance Low',
						value: 'balance.low',
						description: 'Time to top up pages',
					},
				],
			},
			{
				displayName:
					'Typizer sends events to this node by itself while the workflow is active; nothing to set up in the cabinet. The address must be public https',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			splitLineItemsProperty({ show: { events: ['run.succeeded'] } }),
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Only Typizer',
						name: 'typizer',
						type: 'resourceLocator',
						default: { mode: 'list', value: '' },
						description: 'React only to documents of this typizer',
						modes: [
							{
								displayName: 'From List',
								name: 'list',
								type: 'list',
								placeholder: 'Select a typizer…',
								typeOptions: { searchListMethod: 'searchTypizers', searchable: true },
							},
							{
								displayName: 'By URL',
								name: 'url',
								type: 'string',
								placeholder: `${CABINET_URL}/typizers/tz_…`,
								extractValue: { type: 'regex', regex: `/typizers/(${TYPIZER_ID_REGEX})` },
							},
							{
								displayName: 'ID',
								name: 'id',
								type: 'string',
								placeholder: 'tz_…',
							},
						],
					},
					{
						displayName: 'Only With Metadata',
						name: 'metadataFilter',
						type: 'string',
						default: '',
						placeholder: 'source=n8n',
						description:
							'React only to runs with this metadata (key=value), set by the Typizer node under "Run Metadata"',
					},
					...outputOptionProperties(),
				],
			},
		],
	};

	methods = {
		listSearch: { searchTypizers },
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const endpointId = staticData.endpointId as string | undefined;
				if (!endpointId) return false;
				const { statusCode, body } = await typizerRequest<WebhookEndpoint>(this, {
					method: 'GET',
					path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
					allowStatus: [404],
				});
				if (statusCode === 404) {
					delete staticData.endpointId;
					return false;
				}
				const events = this.getNodeParameter('events') as string[];
				const exists =
					body.url === endpointUrl(this) &&
					body.status === 'active' &&
					sameEvents(body.events, events);
				return exists;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const url = endpointUrl(this);
				const events = this.getNodeParameter('events') as string[];
				const created = await typizerRequest<WebhookEndpoint | Problem>(this, {
					method: 'POST',
					path: '/v1/webhook_endpoints',
					body: { url, events },
					allowStatus: [400, 409],
				});
				if (created.statusCode === 400) throw notPublicUrl(this, url, created.body as Problem);
				if (created.statusCode !== 409) {
					staticData.endpointId = (created.body as WebhookEndpoint).id;
					return true;
				}
				// One endpoint per URL: this node's URL is already registered (an earlier activation,
				// or a run's webhook_url) — take it over with this node's events.
				const existing = await findEndpointByUrl(this, url);
				if (!existing) {
					throw new NodeOperationError(
						this.getNode(),
						bi(
							'Typizer refused the webhook: the organization already has 50 active endpoints. Delete unused ones at https://my.typizer.ru/developers/webhooks',
							'Typizer не дал создать вебхук: у организации уже 50 активных адресов. Удалите лишние в кабинете: https://my.typizer.ru/developers/webhooks',
						),
						{ description: (created.body as Problem).detail },
					);
				}
				await typizerRequest<WebhookEndpoint>(this, {
					method: 'PATCH',
					path: `/v1/webhook_endpoints/${encodeURIComponent(existing.id)}`,
					body: { events, status: 'active' },
				});
				staticData.endpointId = existing.id;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				const endpointId = staticData.endpointId as string | undefined;
				if (!endpointId) return true;
				// 404: already deleted (in the cabinet, say) — the goal is reached all the same.
				await typizerRequest(this, {
					method: 'DELETE',
					path: `/v1/webhook_endpoints/${encodeURIComponent(endpointId)}`,
					allowStatus: [404],
				});
				secretCache.delete(endpointId);
				delete staticData.endpointId;
				delete staticData.seenDeliveries;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const request = this.getRequestObject();
		const headerData = this.getHeaderData();
		const rawBody = (request as unknown as { rawBody?: Buffer | string }).rawBody;
		const staticData = this.getWorkflowStaticData('node');
		const endpointId = staticData.endpointId as string | undefined;
		const header = (name: string) => {
			const value = headerData[name];
			return Array.isArray(value) ? value[0] : value;
		};
		const headers = {
			id: header('webhook-id'),
			timestamp: header('webhook-timestamp'),
			signature: header('webhook-signature'),
		};

		const reject = (status: number, message: string): IWebhookResponseData => {
			this.getResponseObject().status(status).send(message).end();
			return { noWebhookResponse: true };
		};
		// Nothing unsigned or stale reaches the API: anyone can post to this URL, and each call
		// would spend the user's key's rate limit.
		if (!endpointId || rawBody === undefined || !headersFresh(headers)) {
			return reject(401, 'Unauthorized');
		}

		const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
		let cached = await endpointSecret(this, endpointId);
		let valid = cached.secret !== null && verifySignature(cached.secret, headers, raw);
		if (!valid && Date.now() - cached.fetchedAt >= MIN_REFETCH_MS) {
			// The secret may have changed (a new endpoint, a rotation): read it once more.
			cached = await endpointSecret(this, endpointId, true);
			valid = cached.secret !== null && verifySignature(cached.secret, headers, raw);
		}
		if (!valid) return reject(401, 'Invalid signature');

		// A verified delivery is handled once: a repeat of its webhook-id (a replayed capture or a
		// duplicate delivery) is acknowledged and dropped.
		const seen = (staticData.seenDeliveries ?? {}) as SeenDeliveries;
		staticData.seenDeliveries = seen;
		if (!rememberDelivery(seen, headers.id as string, Number(headers.timestamp))) {
			return { webhookResponse: 'OK' };
		}

		const event = JSON.parse(raw.toString('utf8')) as WebhookEvent;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const eventMeta = {
			event_id: event.id,
			event_type: event.type,
			event_created_at: event.created_at,
		};

		if (!RUN_EVENTS.includes(event.type)) {
			return {
				workflowData: [[{ json: { ...event.data.object, [META_KEY]: eventMeta } }]],
			};
		}

		const run = event.data.object as unknown as Run;
		const typizerId = this.getNodeParameter('options.typizer', '', {
			extractValue: true,
		}) as string;
		if (typizerId && run.typizer_id !== typizerId) return { webhookResponse: 'OK' };
		const metadataFilter =
			typeof options.metadataFilter === 'string' ? options.metadataFilter.trim() : '';
		if (metadataFilter) {
			const [key, ...rest] = metadataFilter.split('=');
			const value = rest.join('=');
			if (run.metadata?.[key.trim()] !== value.trim()) return { webhookResponse: 'OK' };
		}

		const splitLineItems =
			event.type === 'run.succeeded' && (this.getNodeParameter('splitLineItems', false) as boolean);
		const items = runToItems(run, readOutputOptions(splitLineItems, options)).map((json) => ({
			json: { ...json, [META_KEY]: { ...(json[META_KEY] as IDataObject), ...eventMeta } },
		}));
		return { workflowData: [items] };
	}
}
