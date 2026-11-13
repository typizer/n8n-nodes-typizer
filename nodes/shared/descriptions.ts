import type { IDataObject, INodeProperties } from 'n8n-workflow';

import type { OutputOptions } from './output';

export const TYPIZER_ID_REGEX = 'tz_[0-9a-z]{26}';
export const RUN_ID_REGEX = 'run_[0-9a-z]{26}';

/** "Split Line Items": the toggle people look for when they want a row per line item. */
export function splitLineItemsProperty(
	displayOptions?: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName: 'Split Line Items',
		name: 'splitLineItems',
		type: 'boolean',
		default: false,
		displayOptions,
		description:
			'Whether each row of the document table (goods, services, transactions) becomes a separate n8n item, for example one Google Sheets row each. Document number, date and parties repeat in each item.',
	};
}

/** The options of how the result looks: shared by the Typizer node and the Typizer Trigger. */
export function outputOptionProperties(): INodeProperties[] {
	return [
		{
			displayName: 'Line Items Field',
			name: 'lineItemsField',
			type: 'string',
			default: '',
			placeholder: 'items',
			description: 'Which list to split into items. Empty: find it automatically (usually items).',
		},
		{
			displayName: 'Flatten Fields',
			name: 'flatten',
			type: 'boolean',
			default: false,
			description:
				'Whether nested fields become underscore columns: supplier.inn → supplier_inn. Handy for Google Sheets and Excel column auto-mapping.',
		},
		{
			displayName: 'Include Field Check Details',
			name: 'includeFieldDetails',
			type: 'boolean',
			default: false,
			description:
				'Whether to add each field status (ok, warn, missing), the warning reason and where on the page the value came from to _typizer.fields',
		},
	];
}

export function readOutputOptions(splitLineItems: boolean, options: IDataObject): OutputOptions {
	return {
		splitLineItems,
		lineItemsField: typeof options.lineItemsField === 'string' ? options.lineItemsField : undefined,
		flatten: options.flatten === true,
		includeFieldDetails: options.includeFieldDetails === true,
	};
}
