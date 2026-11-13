import type { IDataObject } from 'n8n-workflow';

export type RunStatus = 'queued' | 'processing' | 'succeeded' | 'failed';

export interface FieldCheck {
	status: 'ok' | 'warn' | 'missing';
	reason?: string;
	sources?: Array<{ page: number; bbox: number[] | null; text: string }>;
}

/** `Run` of the public API (`GET /v1/runs/{id}`; `data.object` of `run.*` webhooks). */
export interface Run {
	id: string;
	object: 'run';
	status: RunStatus;
	typizer_id: string | null;
	typizer_version: number | null;
	mode: 'standard' | 'precise';
	format: string;
	source: string;
	pages: { physical: number | null; billed: number | null };
	output?: unknown;
	fields: Record<string, FieldCheck> | null;
	output_expired: boolean;
	error: { code: string; message: string } | null;
	file_id: string;
	file: { filename: string; mime: string } | null;
	batch_id: string | null;
	metadata: Record<string, string>;
	created_at: string;
	completed_at: string | null;
}

export interface Typizer {
	id: string;
	object: 'typizer';
	name: string;
	description: string | null;
	version: number;
	schema: IDataObject;
	instructions: string;
	default_format: string;
	mode: 'standard' | 'precise';
	created_at: string;
	updated_at: string;
}

export interface Page<T> {
	object: 'list';
	data: T[];
	has_more: boolean;
	next_cursor: string | null;
}

export interface WebhookEndpoint {
	id: string;
	object: 'webhook_endpoint';
	url: string;
	events: string[];
	status: 'active' | 'disabled';
	secret: string | null;
	failing_since: string | null;
	created_at: string;
}

/** RFC 9457 problem of the public API. */
export interface Problem {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	code?: string;
	param?: string;
	request_id?: string;
	doc_url?: string;
}

export interface TypizerDraft {
	object: 'typizer_draft';
	name: string;
	schema: IDataObject;
	instructions: string;
}

export interface UploadedFile {
	id: string;
	filename: string;
	mime: string;
	size_bytes: number;
}

export interface WebhookEvent {
	id: string;
	type: string;
	created_at: string;
	data: { object: IDataObject };
}

export const TERMINAL_STATUSES: readonly RunStatus[] = ['succeeded', 'failed'];
