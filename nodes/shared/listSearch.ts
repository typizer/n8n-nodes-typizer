import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

import { CABINET_URL, typizerRequest } from './transport';
import type { Page, Run, Typizer } from './types';

const PAGE_SIZE = 100;

function matches(filter: string | undefined, ...values: Array<string | null | undefined>): boolean {
	const needle = filter?.trim().toLowerCase();
	if (!needle) return true;
	return values.some((value) => value?.toLowerCase().includes(needle));
}

/** "My Typizer" dropdown: the organization's typizers, newest first, filtered by name. */
export async function searchTypizers(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const { body } = await typizerRequest<Page<Typizer>>(this, {
		method: 'GET',
		path: '/v1/typizers',
		qs: { limit: PAGE_SIZE, ...(paginationToken ? { starting_after: paginationToken } : {}) },
	});
	return {
		results: body.data
			.filter((typizer) => matches(filter, typizer.name, typizer.description, typizer.id))
			.map((typizer) => ({
				name: typizer.name,
				value: typizer.id,
				url: `${CABINET_URL}/typizers/${typizer.id}`,
				description: typizer.description ?? undefined,
			})),
		paginationToken: body.has_more ? (body.next_cursor ?? undefined) : undefined,
	};
}

const STATUS_LABEL: Record<Run['status'], () => string> = {
	queued: () => 'queued',
	processing: () => 'processing',
	succeeded: () => 'done',
	failed: () => 'failed',
};

/** "Run" dropdown: recent runs with their file name, status and time. */
export async function searchRuns(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const { body } = await typizerRequest<Page<Run>>(this, {
		method: 'GET',
		path: '/v1/runs',
		qs: { limit: PAGE_SIZE, ...(paginationToken ? { starting_after: paginationToken } : {}) },
	});
	return {
		results: body.data
			.filter((run) => matches(filter, run.file?.filename, run.id))
			.map((run) => {
				const when = run.created_at.slice(0, 16).replace('T', ' ');
				const file = run.file?.filename ?? run.id;
				return {
					name: `${file} — ${STATUS_LABEL[run.status]()} — ${when}`,
					value: run.id,
					url: `${CABINET_URL}/runs/${run.id}`,
				};
			}),
		paginationToken: body.has_more ? (body.next_cursor ?? undefined) : undefined,
	};
}
