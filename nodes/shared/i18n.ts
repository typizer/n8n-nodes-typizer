/**
 * The node interface is English, as n8n's community-node verification requires. Error messages
 * are read by people who work in Russian too, so they carry both: English first, then Russian.
 */
export function bi(en: string, ru: string): string {
	return `${en} / ${ru}`;
}
