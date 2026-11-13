import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	outputOptionProperties,
	readOutputOptions,
	RUN_ID_REGEX,
	splitLineItemsProperty,
	TYPIZER_ID_REGEX,
} from '../shared/descriptions';
import { searchRuns, searchTypizers } from '../shared/listSearch';
import { runMeta, runToItems, type OutputOptions } from '../shared/output';
import { presetOptions } from '../shared/presets';
import {
	getRun,
	isFinished,
	runFailedError,
	startRun,
	type DocumentSource,
	waitForRuns,
} from '../shared/runs';
import { CABINET_URL, CREDENTIAL_NAME, typizerRequest } from '../shared/transport';
import type { Page, Run, Typizer as TypizerObject } from '../shared/types';

const EXTRACT = { show: { resource: ['document'], operation: ['extract'] } };
const RUN_GET = { show: { resource: ['run'], operation: ['get'] } };
const TYPIZER_GET_ALL = { show: { resource: ['typizer'], operation: ['getAll'] } };

const DEFAULT_MAX_WAIT_MINUTES = 10;

function extractProperties(): INodeProperties[] {
	return [
		{
			displayName: 'Input Binary Field',
			name: 'binaryPropertyName',
			type: 'string',
			default: 'data',
			required: true,
			displayOptions: EXTRACT,
			hint: 'Name of the incoming binary field holding the document, usually data',
			description:
				'A PDF, scan or photo of the document from the previous node: email, Telegram, Google Drive, HTTP Request',
		},
		{
			displayName: 'Document Type',
			name: 'documentSource',
			type: 'options',
			noDataExpression: true,
			default: 'preset',
			displayOptions: EXTRACT,
			options: [
				{
					name: 'Ready-Made Document Type',
					value: 'preset',
					description: 'Invoice, UPD, act, TORG-12, contract and more, with fields chosen for you',
				},
				{
					name: 'My Typizer',
					value: 'typizer',
					description: 'A typizer set up at my.typizer.ru: your fields and checks',
				},
				{
					name: 'Describe in Words',
					value: 'describe',
					description: 'Write what data you need and Typizer builds the fields',
				},
			],
		},
		{
			displayName: 'Document',
			name: 'preset',
			type: 'options',
			default: 'schet-na-oplatu',
			displayOptions: { show: { ...EXTRACT.show, documentSource: ['preset'] } },
			options: presetOptions(),
		},
		{
			displayName: 'Typizer',
			name: 'typizer',
			type: 'resourceLocator',
			default: { mode: 'list', value: '' },
			required: true,
			displayOptions: { show: { ...EXTRACT.show, documentSource: ['typizer'] } },
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
					validation: [
						{
							type: 'regex',
							properties: {
								regex: `.*/typizers/${TYPIZER_ID_REGEX}.*`,
								errorMessage: 'Paste a typizer link from the cabinet: my.typizer.ru/typizers/tz_…',
							},
						},
					],
				},
				{
					displayName: 'ID',
					name: 'id',
					type: 'string',
					placeholder: 'tz_…',
					validation: [
						{
							type: 'regex',
							properties: {
								regex: `^${TYPIZER_ID_REGEX}$`,
								errorMessage: 'A typizer ID starts with tz_',
							},
						},
					],
				},
			],
		},
		{
			displayName: 'What to Extract',
			name: 'prompt',
			type: 'string',
			typeOptions: { rows: 3 },
			default: '',
			required: true,
			displayOptions: { show: { ...EXTRACT.show, documentSource: ['describe'] } },
			placeholder:
				'Invoice number and date, supplier with INN, line items with quantity and price, total',
			hint: 'The fields are built once and remembered by the active workflow. To control them yourself, save a typizer in the cabinet',
		},
		{
			displayName: 'Wait for Result',
			name: 'waitForResult',
			type: 'boolean',
			default: true,
			displayOptions: EXTRACT,
			description:
				'Whether the node returns the extracted data once the document is processed (usually within a minute). Turn off to get just the run ID now and catch the result with the Typizer Trigger node.',
		},
		splitLineItemsProperty({ show: { ...EXTRACT.show, waitForResult: [true] } }),
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			displayOptions: EXTRACT,
			options: [
				{
					displayName: 'Extra Instructions',
					name: 'instructions',
					type: 'string',
					typeOptions: { rows: 2 },
					default: '',
					displayOptions: { show: { '/documentSource': ['preset', 'describe'] } },
					placeholder: 'If the file holds several documents, take only the invoice',
					description:
						'Hints for extraction: which of several documents to take, how to write values',
				},
				{
					displayName: 'File Name',
					name: 'fileName',
					type: 'string',
					default: '',
					description:
						'The name the document shows under in the cabinet. Empty: the binary field name.',
				},
				{
					displayName: 'Max Wait (Minutes)',
					name: 'maxWaitMinutes',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 120 },
					default: DEFAULT_MAX_WAIT_MINUTES,
					displayOptions: { show: { '/waitForResult': [true] } },
					description:
						'How long to wait for processing before the node reports an error. Large scans in precise mode take longer.',
				},
				{
					displayName: 'Mode',
					name: 'mode',
					type: 'options',
					default: 'standard',
					options: [
						{
							name: 'Standard',
							value: 'standard',
						},
						{
							name: 'Precise',
							value: 'precise',
							description:
								'Double-checks the extraction, for poor scans and important amounts; bills more pages',
						},
					],
				},
				{
					displayName: 'Run Metadata',
					name: 'metadata',
					type: 'fixedCollection',
					placeholder: 'Add Metadata',
					typeOptions: { multipleValues: true },
					default: {},
					description:
						'Your key–value pairs (for example a deal ID), up to 20. They come back with the result and in the Typizer Trigger.',
					options: [
						{
							displayName: 'Metadata',
							name: 'values',
							values: [
								{
									displayName: 'Key',
									name: 'key',
									type: 'string',
									default: '',
									placeholder: 'deal_id',
								},
								{
									displayName: 'Value',
									name: 'value',
									type: 'string',
									default: '',
								},
							],
						},
					],
				},
				...outputOptionProperties().map((property) => ({
					...property,
					displayOptions: { show: { '/waitForResult': [true] } },
				})),
			],
		},
	];
}

function runGetProperties(): INodeProperties[] {
	return [
		{
			displayName: 'Run',
			name: 'run',
			type: 'resourceLocator',
			default: { mode: 'id', value: '' },
			required: true,
			displayOptions: RUN_GET,
			description: 'The run ID from a Typizer node (_typizer.run_id field) or from the cabinet',
			modes: [
				{
					displayName: 'ID',
					name: 'id',
					type: 'string',
					placeholder: 'run_…',
					validation: [
						{
							type: 'regex',
							properties: {
								regex: `^${RUN_ID_REGEX}$`,
								errorMessage: 'A run ID starts with run_',
							},
						},
					],
				},
				{
					displayName: 'From List',
					name: 'list',
					type: 'list',
					placeholder: 'Select a run…',
					typeOptions: { searchListMethod: 'searchRuns', searchable: true },
				},
				{
					displayName: 'By URL',
					name: 'url',
					type: 'string',
					placeholder: `${CABINET_URL}/runs/run_…`,
					extractValue: { type: 'regex', regex: `/runs/(${RUN_ID_REGEX})` },
					validation: [
						{
							type: 'regex',
							properties: {
								regex: `.*/runs/${RUN_ID_REGEX}.*`,
								errorMessage: 'Paste a run link from the cabinet: my.typizer.ru/runs/run_…',
							},
						},
					],
				},
			],
		},
		{
			displayName: 'Wait for Result',
			name: 'waitForResult',
			type: 'boolean',
			default: true,
			displayOptions: RUN_GET,
			description:
				'Whether to wait for the result if the document is still processing. Turn off to get the current status right away.',
		},
		splitLineItemsProperty(RUN_GET),
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			displayOptions: RUN_GET,
			options: [
				{
					displayName: 'Max Wait (Minutes)',
					name: 'maxWaitMinutes',
					type: 'number',
					typeOptions: { minValue: 1, maxValue: 120 },
					default: DEFAULT_MAX_WAIT_MINUTES,
					displayOptions: { show: { '/waitForResult': [true] } },
				},
				...outputOptionProperties(),
			],
		},
	];
}

function typizerGetAllProperties(): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			displayOptions: TYPIZER_GET_ALL,
			description: 'Whether to return all results or only up to a given limit',
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 50,
			displayOptions: { show: { ...TYPIZER_GET_ALL.show, returnAll: [false] } },
			description: 'Max number of results to return',
		},
	];
}

function metadataFrom(options: IDataObject): Record<string, string> {
	const entries = ((options.metadata as IDataObject | undefined)?.values ?? []) as Array<{
		key?: string;
		value?: string;
	}>;
	const metadata: Record<string, string> = {};
	for (const entry of entries) {
		const key = entry.key?.trim();
		if (key) metadata[key] = String(entry.value ?? '');
	}
	return metadata;
}

function typizerSummary(typizer: TypizerObject): IDataObject {
	const properties = (typizer.schema?.properties ?? {}) as Record<string, IDataObject>;
	return {
		id: typizer.id,
		name: typizer.name,
		description: typizer.description,
		version: typizer.version,
		mode: typizer.mode,
		fields: Object.entries(properties).map(([name, schema]) => ({
			name,
			type: schema.type ?? null,
			description: schema.description ?? null,
		})),
		created_at: typizer.created_at,
		updated_at: typizer.updated_at,
		cabinet_url: `${CABINET_URL}/typizers/${typizer.id}`,
	};
}

interface PendingRun {
	itemIndex: number;
	run: Run;
	output: OutputOptions;
	maxWaitMs: number;
}

export class Typizer implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Typizer',
		name: 'typizer',
		icon: { light: 'file:typizer.svg', dark: 'file:typizer.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description:
			'Extracts data from invoices, UPD, acts, contracts and any other document: PDFs, scans and photos',
		defaults: { name: 'Typizer' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL_NAME, required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'document',
				options: [
					{ name: 'Document', value: 'document' },
					{ name: 'Run', value: 'run' },
					{ name: 'Typizer', value: 'typizer' },
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'extract',
				displayOptions: { show: { resource: ['document'] } },
				options: [
					{
						name: 'Extract Data',
						value: 'extract',
						action: 'Extract data from a document',
						description: 'Read a document and return its fields',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'get',
				displayOptions: { show: { resource: ['run'] } },
				options: [
					{
						name: 'Get Result',
						value: 'get',
						action: 'Get a run result',
						description: 'The data of a document processed earlier',
					},
				],
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getAll',
				displayOptions: { show: { resource: ['typizer'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						action: 'Get many typizers',
						description: "The organization's typizers with their fields",
					},
				],
			},
			...extractProperties(),
			...runGetProperties(),
			...typizerGetAllProperties(),
		],
	};

	methods = {
		listSearch: { searchTypizers, searchRuns },
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		if (resource === 'document' && operation === 'extract') return [await extract(this)];
		if (resource === 'run' && operation === 'get') return [await getRunResult(this)];
		if (resource === 'typizer' && operation === 'getAll') return [await listTypizers(this)];
		throw new NodeOperationError(this.getNode(), `Unsupported operation ${resource}.${operation}`);
	}
}

/** The item's error as output (with «Continue On Fail») or as the node's error. */
function failItem(
	ctx: IExecuteFunctions,
	error: Error,
	itemIndex: number,
	run?: Run,
): INodeExecutionData[] {
	if (!ctx.continueOnFail()) {
		if (error instanceof NodeOperationError || error.name === 'NodeApiError') throw error;
		throw new NodeOperationError(ctx.getNode(), error, { itemIndex });
	}
	const json: IDataObject = { error: error.message };
	if (run) json._typizer = runMeta(run, { includeFieldDetails: false });
	return [{ json, pairedItem: { item: itemIndex } }];
}

function itemsFor(ctx: IExecuteFunctions, pending: PendingRun): INodeExecutionData[] {
	if (pending.run.status === 'failed') {
		return failItem(
			ctx,
			runFailedError(ctx, pending.run, pending.itemIndex),
			pending.itemIndex,
			pending.run,
		);
	}
	return runToItems(pending.run, pending.output).map((json) => ({
		json,
		pairedItem: { item: pending.itemIndex },
	}));
}

async function extract(ctx: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = ctx.getInputData();
	const results: INodeExecutionData[][] = items.map(() => []);
	const pending: PendingRun[] = [];
	// One document: the create request itself waits for the result (no polling delay). Many:
	// all are sent first, then polled together, so they process in parallel on Typizer's side.
	const holdRequest = items.length === 1;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const binaryPropertyName = ctx.getNodeParameter('binaryPropertyName', itemIndex) as string;
			const source = ctx.getNodeParameter('documentSource', itemIndex) as DocumentSource;
			const waitForResult = ctx.getNodeParameter('waitForResult', itemIndex) as boolean;
			const options = ctx.getNodeParameter('options', itemIndex, {}) as IDataObject;
			const binary = ctx.helpers.assertBinaryData(itemIndex, binaryPropertyName);
			const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
			const fileName =
				(typeof options.fileName === 'string' && options.fileName.trim()) ||
				binary.fileName ||
				`document${binary.fileExtension ? `.${binary.fileExtension}` : ''}`;

			const run = await startRun(
				ctx,
				{
					source,
					presetSlug:
						source === 'preset' ? (ctx.getNodeParameter('preset', itemIndex) as string) : undefined,
					typizerId:
						source === 'typizer'
							? (ctx.getNodeParameter('typizer', itemIndex, '', { extractValue: true }) as string)
							: undefined,
					prompt:
						source === 'describe'
							? (ctx.getNodeParameter('prompt', itemIndex) as string)
							: undefined,
					instructions: typeof options.instructions === 'string' ? options.instructions : undefined,
					mode:
						options.mode === 'precise'
							? 'precise'
							: options.mode === 'standard'
								? 'standard'
								: undefined,
					metadata: metadataFrom(options),
					file: { data, fileName, mimeType: binary.mimeType },
					wait: waitForResult && holdRequest,
				},
				itemIndex,
			);
			const splitLineItems = waitForResult
				? (ctx.getNodeParameter('splitLineItems', itemIndex, false) as boolean)
				: false;
			const entry: PendingRun = {
				itemIndex,
				run,
				output: readOutputOptions(splitLineItems, options),
				maxWaitMs: Number(options.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES) * 60_000,
			};
			if (waitForResult && !isFinished(run)) pending.push(entry);
			else if (waitForResult) results[itemIndex] = itemsFor(ctx, entry);
			else {
				results[itemIndex] = runToItems(run, entry.output).map((json) => ({
					json,
					pairedItem: { item: itemIndex },
				}));
			}
		} catch (error) {
			results[itemIndex] = failItem(ctx, error as Error, itemIndex);
		}
	}

	const settled = await waitForRuns(ctx, pending);
	for (const entry of settled) {
		results[entry.pending.itemIndex] = entry.error
			? failItem(ctx, entry.error, entry.pending.itemIndex, entry.pending.run)
			: itemsFor(ctx, entry.pending);
	}
	return results.flat();
}

async function getRunResult(ctx: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = ctx.getInputData();
	const results: INodeExecutionData[] = [];
	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			const runId = ctx.getNodeParameter('run', itemIndex, '', { extractValue: true }) as string;
			const waitForResult = ctx.getNodeParameter('waitForResult', itemIndex) as boolean;
			const splitLineItems = ctx.getNodeParameter('splitLineItems', itemIndex, false) as boolean;
			const options = ctx.getNodeParameter('options', itemIndex, {}) as IDataObject;
			const entry: PendingRun = {
				itemIndex,
				run: await getRun(ctx, runId.trim()),
				output: readOutputOptions(splitLineItems, options),
				maxWaitMs: Number(options.maxWaitMinutes ?? DEFAULT_MAX_WAIT_MINUTES) * 60_000,
			};
			if (waitForResult && !isFinished(entry.run)) {
				const [settled] = await waitForRuns(ctx, [entry]);
				if (settled.error) {
					results.push(...failItem(ctx, settled.error, itemIndex, entry.run));
					continue;
				}
			}
			if (!isFinished(entry.run)) {
				results.push(
					...runToItems(entry.run, entry.output).map((json) => ({
						json,
						pairedItem: { item: itemIndex },
					})),
				);
			} else {
				results.push(...itemsFor(ctx, entry));
			}
		} catch (error) {
			results.push(...failItem(ctx, error as Error, itemIndex));
		}
	}
	return results;
}

async function listTypizers(ctx: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const returnAll = ctx.getNodeParameter('returnAll', 0) as boolean;
	const limit = returnAll ? Infinity : (ctx.getNodeParameter('limit', 0) as number);
	const typizers: TypizerObject[] = [];
	let cursor: string | undefined;
	do {
		const { body } = await typizerRequest<Page<TypizerObject>>(ctx, {
			method: 'GET',
			path: '/v1/typizers',
			qs: {
				limit: Math.min(100, Math.max(1, limit - typizers.length)),
				...(cursor ? { starting_after: cursor } : {}),
			},
		});
		typizers.push(...body.data);
		cursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
	} while (cursor && typizers.length < limit);
	return typizers.slice(0, limit).map((typizer) => ({
		json: typizerSummary(typizer),
		pairedItem: { item: 0 },
	}));
}
