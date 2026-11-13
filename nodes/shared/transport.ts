import { randomBytes } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleepWithAbort } from 'n8n-workflow';

import { bi } from './i18n';
import type { Problem } from './types';

export const CREDENTIAL_NAME = 'typizerApi';
export const DEFAULT_BASE_URL = 'https://api.typizer.ru';
export const CABINET_URL = 'https://my.typizer.ru';

export type TypizerContext =
	| IExecuteFunctions
	| ILoadOptionsFunctions
	| IHookFunctions
	| IWebhookFunctions;

export interface TypizerRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	/** A JSON body, or a ready multipart body from {@link buildMultipart}. */
	body?: IDataObject | Multipart;
	/** Sent as `Idempotency-Key`: a retried request then never creates a second run or file. */
	idempotencyKey?: string;
	/** Milliseconds; requests with `?wait=` are held by the API for up to 60 s. */
	timeout?: number;
	/** Statuses the caller handles itself: returned (with the problem as body), not thrown. */
	allowStatus?: number[];
	/** `false`: a 429/503 fails at once instead of waiting out `Retry-After`. */
	retry?: boolean;
}

export interface TypizerResponse<T> {
	statusCode: number;
	body: T;
	headers: IDataObject;
}

/** How many times a 429/503 is retried before it surfaces as an error. */
const MAX_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 30_000;

export async function getBaseUrl(ctx: TypizerContext): Promise<string> {
	const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
	const raw = typeof credentials.baseUrl === 'string' ? credentials.baseUrl.trim() : '';
	return (raw || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function cancelSignal(ctx: TypizerContext): AbortSignal | undefined {
	return 'getExecutionCancelSignal' in ctx ? ctx.getExecutionCancelSignal() : undefined;
}

function parseBody(body: unknown): unknown {
	if (Buffer.isBuffer(body)) body = body.toString('utf8');
	if (typeof body !== 'string') return body;
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

function retryAfterMs(headers: IDataObject, attempt: number): number {
	const header = Number(headers['retry-after']);
	const seconds = Number.isFinite(header) && header >= 0 ? header : 2 ** attempt;
	return Math.min(Math.max(seconds, 1) * 1000, MAX_RETRY_DELAY_MS);
}

/**
 * One call to the Typizer API with the node's «Typizer API» credentials. A 429 or 503 is retried
 * after its `Retry-After` (the API sends it with both) — for GETs and for requests carrying an
 * `Idempotency-Key`, which the API replays instead of repeating. Any other non-2xx becomes a
 * {@link NodeApiError} with a message in the interface's language.
 */
export async function typizerRequest<T>(
	ctx: TypizerContext,
	request: TypizerRequest,
): Promise<TypizerResponse<T>> {
	const baseURL = await getBaseUrl(ctx);
	const headers: IDataObject = { Accept: 'application/json' };
	let body: IHttpRequestOptions['body'];
	if (request.body instanceof Multipart) {
		headers['Content-Type'] = request.body.contentType;
		body = request.body.body;
	} else if (request.body !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = request.body;
	}
	if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;

	const retryable =
		request.retry !== false && (request.method === 'GET' || request.idempotencyKey !== undefined);
	for (let attempt = 0; ; attempt++) {
		const options: IHttpRequestOptions = {
			method: request.method,
			baseURL,
			url: request.path,
			qs: request.qs,
			headers,
			body,
			json: !(request.body instanceof Multipart),
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: request.timeout ?? 60_000,
			abortSignal: cancelSignal(ctx),
		};
		const response = (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			CREDENTIAL_NAME,
			options,
		)) as { statusCode: number; body: unknown; headers: IDataObject };
		const parsed = parseBody(response.body);
		if (response.statusCode < 400 || request.allowStatus?.includes(response.statusCode)) {
			return { statusCode: response.statusCode, body: parsed as T, headers: response.headers };
		}
		const transient = response.statusCode === 429 || response.statusCode === 503;
		if (transient && retryable && attempt < MAX_RETRIES) {
			await sleepWithAbort(retryAfterMs(response.headers ?? {}, attempt), cancelSignal(ctx));
			continue;
		}
		throw apiError(ctx, response.statusCode, parsed);
	}
}

/** The problem's message for people who work in n8n, not with HTTP. */
export function problemMessage(problem: Problem, statusCode: number): string {
	switch (problem.code) {
		case 'unauthorized':
			return bi(
				'Typizer did not accept the API key. Check the key in the "Typizer API" credentials or create a new one: https://my.typizer.ru/developers/keys',
				'Typizer не принял ключ API. Проверьте ключ в учётных данных «Typizer API» или создайте новый: https://my.typizer.ru/developers/keys',
			);
		case 'insufficient_scope':
			return bi(
				'The API key lacks a permission for this action. Create a key with «Только запуск прогонов» (runs only) access, «Полный доступ» (full access) for "Describe in Words": https://my.typizer.ru/developers/keys',
				'У ключа API не хватает прав для этого действия. Создайте ключ с доступом «Только запуск прогонов» (а для «Describe in Words» — «Полный доступ»): https://my.typizer.ru/developers/keys',
			);
		case 'forbidden':
			return bi(
				'Typizer forbids this action for your key',
				'Typizer запретил это действие для вашего ключа',
			);
		case 'insufficient_balance':
			return bi(
				'Your Typizer balance does not have enough pages for this document. Top up: https://my.typizer.ru/billing',
				'На балансе Typizer не хватает страниц для этого документа. Пополните баланс: https://my.typizer.ru/billing',
			);
		case 'file_too_large':
			return bi(
				'The file is too large: Typizer accepts documents up to 50 MB',
				'Файл слишком большой: Typizer принимает документы до 50 МБ',
			);
		case 'unsupported_file_type':
			return bi(
				'Typizer cannot read this file type. Pass a PDF, a scan or a photo of the document',
				'Typizer не умеет читать файлы этого типа. Передайте PDF, скан или фото документа',
			);
		case 'document_unreadable':
			return bi(
				'The document cannot be read: the file is damaged, password-protected or empty',
				'Документ не читается: файл повреждён, защищён паролем или пуст',
			);
		case 'too_many_pages':
			return bi(
				'The document has more pages than Typizer processes at once. Split the file',
				'В документе больше страниц, чем Typizer обрабатывает за один раз. Разделите файл на части',
			);
		case 'not_found':
			return bi(
				"Not found: check that the typizer or run exists and belongs to this API key's organization",
				'Не найдено: проверьте, что типизатор или прогон существует и относится к организации этого ключа API',
			);
		case 'rate_limited':
			return bi(
				'Too many requests to Typizer. Process fewer documents at once (for example with a Loop Over Items node) or retry later',
				'Слишком много запросов к Typizer подряд. Уменьшите число одновременных документов (например, узлом Loop Over Items) или повторите позже',
			);
		case 'upstream_unavailable':
		case 'internal_error':
			return bi(
				'Typizer is temporarily unavailable. Retry later, or turn on "Retry On Fail" in the node settings',
				'Typizer временно недоступен. Повторите позже — или включите «Retry On Fail» в настройках узла',
			);
		case 'invalid_schema':
		case 'unsupported_schema_feature':
			return bi('Typizer rejected the document schema', 'Схема документа не подходит Typizer');
		case 'extraction_failed':
			return bi(
				'Typizer could not build fields from the description. Rephrase it, or save a typizer in the cabinet',
				'Typizer не смог составить поля по описанию. Переформулируйте описание или сохраните типизатор в кабинете',
			);
		default:
			return (
				problem.detail ??
				problem.title ??
				bi(`Typizer returned error ${statusCode}`, `Typizer ответил ошибкой ${statusCode}`)
			);
	}
}

export function apiError(ctx: TypizerContext, statusCode: number, body: unknown): NodeApiError {
	const problem: Problem =
		body !== null && typeof body === 'object' ? (body as Problem) : { detail: String(body ?? '') };
	const details = [
		problem.detail,
		problem.param ? `param: ${problem.param}` : undefined,
		problem.request_id ? `request_id: ${problem.request_id}` : undefined,
		problem.doc_url,
	].filter((part): part is string => Boolean(part));
	return new NodeApiError(ctx.getNode(), problem as JsonObject, {
		message: problemMessage(problem, statusCode),
		description: details.join(' · ') || undefined,
		httpCode: String(statusCode),
	});
}

type Part =
	| { field: string; value: string }
	| { field: string; filename: string; contentType: string; data: Buffer };

/** `filename="…"` keeps printable ASCII; the real name goes in `filename*` (RFC 5987). */
function dispositionFilename(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	const encoded = encodeURIComponent(filename).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * A `multipart/form-data` body built by hand: the package ships without runtime dependencies,
 * and a plain Buffer goes through n8n's HTTP helper unchanged.
 */
export class Multipart {
	readonly body: Buffer;
	readonly contentType: string;

	constructor(parts: Part[]) {
		const boundary = `----typizer-n8n-${randomBytes(12).toString('hex')}`;
		const chunks: Buffer[] = [];
		for (const part of parts) {
			const name = part.field.replace(/["\r\n]/g, '_');
			if ('data' in part) {
				chunks.push(
					Buffer.from(
						`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; ${dispositionFilename(part.filename)}\r\nContent-Type: ${part.contentType}\r\n\r\n`,
					),
					part.data,
					Buffer.from('\r\n'),
				);
			} else {
				chunks.push(
					Buffer.from(
						`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${part.value}\r\n`,
					),
				);
			}
		}
		chunks.push(Buffer.from(`--${boundary}--\r\n`));
		this.body = Buffer.concat(chunks);
		this.contentType = `multipart/form-data; boundary=${boundary}`;
	}
}
