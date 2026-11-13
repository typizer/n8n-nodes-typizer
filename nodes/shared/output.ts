import type { IDataObject } from 'n8n-workflow';

import { CABINET_URL } from './transport';
import type { Run } from './types';

/** Where the run's meta goes in every item, next to the extracted fields. */
export const META_KEY = '_typizer';

export interface OutputOptions {
	/** One n8n item per element of the line-items array. */
	splitLineItems: boolean;
	/** Which top-level array to split by; empty — the first array of objects (`items` first). */
	lineItemsField?: string;
	/** `supplier.inn` becomes `supplier_inn`: columns Google Sheets and Excel map by name. */
	flatten: boolean;
	/** Adds the per-field check results (status, reason, source on the page) to the meta. */
	includeFieldDetails: boolean;
}

export const DEFAULT_OUTPUT: OutputOptions = {
	splitLineItems: false,
	flatten: false,
	includeFieldDetails: false,
};

function isPlainObject(value: unknown): value is IDataObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Field checks in brief: what to look at before the data goes on. */
export function checkSummary(run: Run): IDataObject {
	const warnings: IDataObject[] = [];
	const missing: string[] = [];
	for (const [field, check] of Object.entries(run.fields ?? {})) {
		if (check.status === 'warn') warnings.push({ field, reason: check.reason ?? null });
		else if (check.status === 'missing') missing.push(field);
	}
	return { all_ok: warnings.length === 0 && missing.length === 0, warnings, missing };
}

export function runMeta(
	run: Run,
	options: Pick<OutputOptions, 'includeFieldDetails'>,
): IDataObject {
	const meta: IDataObject = {
		run_id: run.id,
		status: run.status,
		typizer_id: run.typizer_id,
		typizer_version: run.typizer_version,
		mode: run.mode,
		pages_billed: run.pages?.billed ?? null,
		file_name: run.file?.filename ?? null,
		metadata: run.metadata ?? {},
		created_at: run.created_at,
		completed_at: run.completed_at,
		cabinet_url: `${CABINET_URL}/runs/${run.id}`,
	};
	if (run.status === 'succeeded') {
		meta.checks = checkSummary(run);
		if (run.output_expired) meta.output_expired = true;
		if (options.includeFieldDetails) meta.fields = (run.fields ?? {}) as IDataObject;
	}
	if (run.error) meta.error = run.error;
	return meta;
}

export function flatten(value: IDataObject, prefix = '', out: IDataObject = {}): IDataObject {
	for (const [key, child] of Object.entries(value)) {
		const name = prefix ? `${prefix}_${key}` : key;
		if (isPlainObject(child) && Object.keys(child).length > 0) flatten(child, name, out);
		else out[name] = child;
	}
	return out;
}

/** The array the line items are in: the named one, else `items`, else the first array of objects. */
export function findLineItemsField(output: IDataObject, preferred?: string): string | undefined {
	const name = preferred?.trim();
	if (name) return Array.isArray(output[name]) ? name : undefined;
	if (Array.isArray(output.items)) return 'items';
	return Object.keys(output).find(
		(key) => Array.isArray(output[key]) && (output[key] as unknown[]).some(isPlainObject),
	);
}

/**
 * The run as n8n items: the extracted fields at the top level (as the document's schema names
 * them) and the run's meta under `_typizer`. Split by line items, each item is the same document
 * with the array replaced by one of its elements — `items.name`, `items.amount` — plus
 * `_typizer.line_number`/`line_count`, so a row per position keeps its document's number, date
 * and parties.
 */
export function runToItems(run: Run, options: OutputOptions): IDataObject[] {
	const meta = runMeta(run, options);
	const output = isPlainObject(run.output) ? run.output : {};
	const finish = (data: IDataObject, extraMeta: IDataObject = {}): IDataObject => {
		const fields = options.flatten ? flatten(data) : data;
		return { ...fields, [META_KEY]: { ...meta, ...extraMeta } };
	};

	if (!options.splitLineItems || run.status !== 'succeeded') return [finish({ ...output })];

	const field = findLineItemsField(output, options.lineItemsField);
	const lines = field ? (output[field] as unknown[]) : [];
	if (!field || lines.length === 0) {
		return [finish({ ...output }, { line_number: null, line_count: 0 })];
	}
	return lines.map((line, index) =>
		finish(
			{ ...output, [field]: line as IDataObject },
			{ line_number: index + 1, line_count: lines.length },
		),
	);
}
