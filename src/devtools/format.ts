// Small value formatters shared by the devtools UI (and handy for consumers' own panels).

/** Compact single-value formatter: integers stay whole, floats get one decimal. */
export function formatValue(v: unknown): string {
	if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
	if (typeof v === 'string') return v;
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	return JSON.stringify(v);
}

/** Formats a component's data object as `key=value` pairs on one line. */
export function formatComponentData(data: unknown): string {
	if (!data || typeof data !== 'object') return formatValue(data);
	return Object.entries(data as Record<string, unknown>)
		.map(([k, v]) => `${k}=${formatValue(v)}`)
		.join('  ');
}
