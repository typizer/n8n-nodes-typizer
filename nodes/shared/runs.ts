import { createHash } from 'crypto';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError, sleepWithAbort } from 'n8n-workflow';

import { bi } from './i18n';
import { getPreset } from './presets';
import { Multipart, typizerRequest } from './transport';
import type { Run, TypizerDraft, UploadedFile } from './types';
import { TERMINAL_STATUSES } from './types';

export type DocumentSource = 'preset' | 'typizer' | 'describe';

export interface StartRunInput {
	source: DocumentSource;
	presetSlug?: string;
	typizerId?: string;
	/** "Describe in Words": what to extract, in the user's words. */
	prompt?: string;
	/** Added to the preset's or the description's own instructions. */
	instructions?: string;
	mode?: 'standard' | 'precise';
	metadata: Record<string, string>;
	file: { data: Buffer; fileName: string; mimeType: string };
	/** Hold the create request until the run finishes (up to 60 s, the API's own limit). */
	wait: boolean;
}

/** The API holds `?wait=` requests up to 60 s; the HTTP timeout leaves room for the upload. */
const WAIT_SECONDS = 60;
const WAIT_TIMEOUT_MS = 120_000;

/**
 * `Idempotency-Key` of one create request: the execution, the node and what is sent. A retried
 * item («Retry On Fail», a network error) replays the run it already created instead of paying
 * for the document twice; a different file or setting is a different key, so a loop that runs
 * this node many times in one execution still creates a run per document.
 */
export function idempotencyKey(
	ctx: IExecuteFunctions,
	step: string,
	input: Pick<StartRunInput, 'file'> & IDataObject,
): string {
	const { file, ...rest } = input;
	const hash = createHash('sha256')
		.update(file.data)
		.update(JSON.stringify(rest))
		.update(file.fileName)
		.digest('hex')
		.slice(0, 32);
	return `n8n-${ctx.getExecutionId()}-${ctx.getNode().id}-${step}-${hash}`.slice(0, 200);
}

function joinInstructions(...parts: Array<string | undefined>): string | undefined {
	const text = parts
		.map((part) => part?.trim())
		.filter(Boolean)
		.join('\n\n');
	return text || undefined;
}

function filePart(input: StartRunInput) {
	return {
		field: 'file',
		filename: input.file.fileName,
		contentType: input.file.mimeType || 'application/octet-stream',
		data: input.file.data,
	};
}

function metadataPart(input: StartRunInput) {
	return Object.keys(input.metadata).length > 0
		? [{ field: 'metadata', value: JSON.stringify(input.metadata) }]
		: [];
}

/** Workflow-level cache of the fields a description produced, so they stay the same next run. */
interface DraftCache {
	[promptHash: string]: { schema: IDataObject; instructions: string; name: string };
}

function promptHash(prompt: string): string {
	return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 24);
}

/**
 * The fields for "Describe in Words": drafted once from the description (and the first document
 * as a sample), then kept in the workflow's static data — the next executions of an active
 * workflow reuse them, so the output columns do not change from one document to the next.
 */
async function draftFor(
	ctx: IExecuteFunctions,
	prompt: string,
	fileId: string,
): Promise<{ schema: IDataObject; instructions: string }> {
	const staticData = ctx.getWorkflowStaticData('node');
	const cache = ((staticData.typizerDrafts as DraftCache | undefined) ?? {}) as DraftCache;
	const key = promptHash(prompt);
	const cached = cache[key];
	if (cached) return cached;
	const { body } = await typizerRequest<TypizerDraft>(ctx, {
		method: 'POST',
		path: '/v1/typizers/generate',
		body: { description: prompt.trim(), file_id: fileId },
		timeout: WAIT_TIMEOUT_MS,
	});
	// Only the latest description is kept: the cache never grows past one entry per node.
	staticData.typizerDrafts = {
		[key]: { schema: body.schema, instructions: body.instructions, name: body.name },
	};
	return { schema: body.schema, instructions: body.instructions };
}

export async function startRun(
	ctx: IExecuteFunctions,
	input: StartRunInput,
	itemIndex: number,
): Promise<Run> {
	const qs = { wait: input.wait ? WAIT_SECONDS : 0 };
	const timeout = input.wait ? WAIT_TIMEOUT_MS : 60_000;
	const settings: IDataObject = {
		source: input.source,
		preset: input.presetSlug ?? null,
		typizer: input.typizerId ?? null,
		prompt: input.prompt ?? null,
		instructions: input.instructions ?? null,
		mode: input.mode ?? null,
		metadata: input.metadata,
	};

	if (input.source === 'typizer') {
		if (!input.typizerId) {
			throw new NodeOperationError(ctx.getNode(), bi('Choose a typizer', 'Выберите типизатор'), {
				itemIndex,
			});
		}
		const parts = [
			filePart(input),
			{ field: 'format', value: 'json' },
			...(input.mode ? [{ field: 'mode', value: input.mode }] : []),
			...metadataPart(input),
		];
		const { body } = await typizerRequest<Run>(ctx, {
			method: 'POST',
			path: `/v1/typizers/${encodeURIComponent(input.typizerId)}/runs`,
			qs,
			body: new Multipart(parts),
			idempotencyKey: idempotencyKey(ctx, 'run', { file: input.file, ...settings }),
			timeout,
		});
		return body;
	}

	if (input.source === 'preset') {
		const preset = getPreset(input.presetSlug ?? '');
		if (!preset) {
			throw new NodeOperationError(
				ctx.getNode(),
				bi('Choose a document type', 'Выберите тип документа'),
				{ itemIndex },
			);
		}
		const instructions = joinInstructions(preset.prompt, input.instructions);
		const parts = [
			filePart(input),
			{ field: 'schema', value: JSON.stringify(preset.schema) },
			...(instructions ? [{ field: 'instructions', value: instructions }] : []),
			{ field: 'format', value: 'json' },
			...(input.mode ? [{ field: 'mode', value: input.mode }] : []),
			...metadataPart(input),
		];
		const { body } = await typizerRequest<Run>(ctx, {
			method: 'POST',
			path: '/v1/extract',
			qs,
			body: new Multipart(parts),
			idempotencyKey: idempotencyKey(ctx, 'extract', { file: input.file, ...settings }),
			timeout,
		});
		return body;
	}

	const prompt = input.prompt?.trim();
	if (!prompt) {
		throw new NodeOperationError(
			ctx.getNode(),
			bi('Describe what data to extract', 'Опишите, какие данные достать из документа'),
			{ itemIndex },
		);
	}
	const { body: file } = await typizerRequest<UploadedFile>(ctx, {
		method: 'POST',
		path: '/v1/files',
		body: new Multipart([filePart(input)]),
		idempotencyKey: idempotencyKey(ctx, 'file', { file: input.file }),
		timeout: WAIT_TIMEOUT_MS,
	});
	const draft = await draftFor(ctx, prompt, file.id);
	const extract: IDataObject = {
		schema: draft.schema,
		file_id: file.id,
		format: 'json',
		metadata: input.metadata,
	};
	const instructions = joinInstructions(draft.instructions, input.instructions);
	if (instructions) extract.instructions = instructions.slice(0, 4000);
	if (input.mode) extract.mode = input.mode;
	const { body } = await typizerRequest<Run>(ctx, {
		method: 'POST',
		path: '/v1/extract',
		qs,
		body: extract,
		idempotencyKey: idempotencyKey(ctx, 'extract', {
			file: input.file,
			...settings,
			schema: draft.schema,
		}),
		timeout,
	});
	return body;
}

export async function getRun(ctx: IExecuteFunctions, runId: string): Promise<Run> {
	const { body } = await typizerRequest<Run>(ctx, {
		method: 'GET',
		path: `/v1/runs/${encodeURIComponent(runId)}`,
	});
	return body;
}

export function isFinished(run: Run): boolean {
	return TERMINAL_STATUSES.includes(run.status);
}

export interface Waiting {
	itemIndex: number;
	run: Run;
	maxWaitMs: number;
}

export interface Settled<T extends Waiting> {
	pending: T;
	/** Set when the run did not finish within its `maxWaitMs`. */
	error?: NodeOperationError;
}

function stillProcessing(ctx: IExecuteFunctions, run: Run, itemIndex: number): NodeOperationError {
	return new NodeOperationError(
		ctx.getNode(),
		bi(
			`The document is still processing (run ${run.id}). Increase "Max Wait (Minutes)", fetch the result later with Run → "Get Result", or catch it with the Typizer Trigger node`,
			`Документ ещё обрабатывается (прогон ${run.id}). Увеличьте «Max Wait (Minutes)» или заберите результат позже действием Run → «Get Result» — либо ловите его узлом Typizer Trigger`,
		),
		{ itemIndex, description: `run_id: ${run.id}` },
	);
}

/**
 * Polls the runs until each finishes or runs out of its own wait: every 3 s at first, then up to
 * every 15 s. `pending[].run` is updated in place with the latest state.
 */
export async function waitForRuns<T extends Waiting>(
	ctx: IExecuteFunctions,
	pending: T[],
	now: () => number = Date.now,
): Promise<Array<Settled<T>>> {
	const started = now();
	const settled: Array<Settled<T>> = [];
	let open = pending.filter((entry) => {
		if (!isFinished(entry.run)) return true;
		settled.push({ pending: entry });
		return false;
	});
	let delay = 3000;
	while (open.length > 0) {
		const nextDeadline = Math.min(...open.map((entry) => started + entry.maxWaitMs));
		await sleepWithAbort(
			Math.max(0, Math.min(delay, nextDeadline - now())),
			ctx.getExecutionCancelSignal(),
		);
		delay = Math.min(delay * 1.5, 15_000);
		const stillOpen: T[] = [];
		for (const entry of open) {
			entry.run = await getRun(ctx, entry.run.id);
			if (isFinished(entry.run)) settled.push({ pending: entry });
			else if (now() - started >= entry.maxWaitMs) {
				settled.push({ pending: entry, error: stillProcessing(ctx, entry.run, entry.itemIndex) });
			} else stillOpen.push(entry);
		}
		open = stillOpen;
	}
	return settled;
}

/** A failed run as an error the user can act on. */
export function runFailedError(
	ctx: IExecuteFunctions,
	run: Run,
	itemIndex: number,
): NodeOperationError {
	const reason = run.error?.message ?? bi('no reason given', 'причина не указана');
	return new NodeOperationError(
		ctx.getNode(),
		bi(
			`Typizer could not process the document: ${reason}`,
			`Typizer не смог обработать документ: ${reason}`,
		),
		{
			itemIndex,
			description: [run.error?.code, `run_id: ${run.id}`].filter(Boolean).join(' · '),
		},
	);
}
