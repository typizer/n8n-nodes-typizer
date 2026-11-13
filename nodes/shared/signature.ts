import { createHmac, timingSafeEqual } from 'crypto';

/** Standard Webhooks' replay window, the same 5 minutes Typizer signs for. */
export const TOLERANCE_SEC = 300;

export interface SignatureHeaders {
	id?: string;
	timestamp?: string;
	signature?: string;
}

/**
 * The cheap part of the check, before any secret is needed: all three headers present and the
 * timestamp within the window. A request failing it is rejected without a call to the API.
 */
export function headersFresh(
	headers: SignatureHeaders,
	nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature) return false;
	if (!/^\d{1,15}$/.test(timestamp)) return false;
	return Math.abs(nowSec - Number(timestamp)) <= TOLERANCE_SEC;
}

/** Recently delivered `webhook-id`s with their timestamps (the node's workflow static data). */
export type SeenDeliveries = Record<string, number>;

/**
 * Remembers a verified delivery's id; `false` when the id was already seen — a replay of a
 * captured request, or a duplicate delivery. Ids older than the timestamp window are dropped:
 * a replay of those fails {@link headersFresh} anyway.
 */
export function rememberDelivery(
	seen: SeenDeliveries,
	id: string,
	timestampSec: number,
	nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
	for (const [key, at] of Object.entries(seen)) {
		if (nowSec - at > TOLERANCE_SEC) delete seen[key];
	}
	if (id in seen) return false;
	seen[id] = timestampSec;
	return true;
}

/**
 * Checks a Typizer webhook signature (Standard Webhooks): HMAC-SHA256 over
 * `{webhook-id}.{webhook-timestamp}.{raw body}` keyed with the base64 part of the endpoint's
 * `whsec_…` secret; any `v1,` signature of the header may match; the timestamp must be within
 * 5 minutes. Never throws: anything missing or malformed is `false`.
 */
export function verifySignature(
	secret: string,
	headers: SignatureHeaders,
	rawBody: Buffer,
	nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
	const { id, timestamp, signature } = headers;
	if (!id || !timestamp || !signature || !headersFresh(headers, nowSec)) return false;
	const timestampSec = Number(timestamp);

	const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
	const key = Buffer.from(encoded, 'base64');
	if (key.length === 0) return false;

	const expected = createHmac('sha256', key)
		.update(`${id}.${timestampSec}.`, 'utf8')
		.update(rawBody)
		.digest();
	let ok = false;
	for (const entry of signature.split(' ')) {
		const comma = entry.indexOf(',');
		if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
		const given = Buffer.from(entry.slice(comma + 1), 'base64');
		if (given.length === expected.length && timingSafeEqual(given, expected)) ok = true;
	}
	return ok;
}
