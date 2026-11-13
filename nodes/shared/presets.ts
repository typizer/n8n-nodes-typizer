import type { INodePropertyOptions } from 'n8n-workflow';

import { PRESET_DATA, type PresetData } from './presets.generated';

export interface Preset extends PresetData {
	en: string;
}

/** The dropdown's order: the documents people send most often first. */
const ORDER: Array<[slug: string, en: string]> = [
	['schet-na-oplatu', 'Invoice'],
	['upd', 'Universal Transfer Document'],
	['schet-faktura', 'VAT Invoice'],
	['akt', 'Certificate of Completion'],
	['torg-12', 'Goods Waybill'],
	['ttn', 'Transport Waybill'],
	['dogovor', 'Contract'],
	['platezhnoe-poruchenie', 'Payment Order'],
	['bankovskaya-vypiska', 'Bank Statement'],
	['kassovyj-chek', 'Cash Receipt'],
	['doverennost', 'Power of Attorney'],
	['smeta', 'Cost Estimate'],
];

export const PRESETS: Preset[] = ORDER.flatMap(([slug, en]) => {
	const data = PRESET_DATA.find((doc) => doc.slug === slug);
	return data ? [{ ...data, en }] : [];
});

export function getPreset(slug: string): Preset | undefined {
	return PRESETS.find((preset) => preset.slug === slug);
}

/**
 * Dropdown entries named in English with the document's Russian name in brackets — «Invoice
 * (Счёт на оплату)» — so the users who send these documents recognise them at a glance.
 */
export function presetOptions(): INodePropertyOptions[] {
	return PRESETS.map((preset) => ({
		name: `${preset.en} (${preset.name})`,
		value: preset.slug,
		description: `Extracts: ${preset.prompt}`,
	}));
}
