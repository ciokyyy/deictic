// @file: the shape a batch of feedback is written in — one table of locations,
// then the person's words, then the code
// @contract: feedbackToon(items, sourceOf) returns a TOON document: a
// `feedback[N]{index,file,line,url}` table, a `notes` block holding a line for
// every element that has one, and a `sources` block keyed by file:line
// @invariants: the order is the order the person clicked in, and nothing is
// re-sorted — a review reads as a walk through the app
// @related: index.mjs (the only caller)

/**
 * A TOON scalar is bare when it cannot be mistaken for structure, and quoted
 * when it can: a comma reads as a column break, a bracket as nesting.
 * @param {unknown} value
 * @returns {string}
 */
export function scalar(value) {
	const text = String(value ?? '').replace(/\r?\n/g, '\\n').trim();
	if (text === '') return '""';
	if (/[",[\]{}]/.test(text)) return `"${text.replace(/"/g, '\\"')}"`;
	return text;
}

/**
 * @param {string} key
 * @param {string[]} lines
 * @returns {string[]}
 */
function block(key, lines) {
	return lines.length === 0 ? [] : ['', `${key}:`, ...lines.map((/** @type {string} */ line) => `  ${line}`)];
}

/**
 * A multi-line value under its index: the first line after `N: `, the rest lined
 * up under it, so a described element reads as one entry and not as loose lines
 * pretending to be others.
 *
 * @param {number} index
 * @param {string} text
 * @returns {string[]}
 */
function underIndex(index, text) {
	const [first = '', ...rest] = text.split('\n');
	const indent = ' '.repeat(String(index).length + 2);
	return [`${index}: ${first}`, ...rest.map((line) => `${indent}${line}`)];
}

/**
 * @param {{file?: string, line?: number, context?: string, render?: string, url: string, note?: string}[]} items
 * @param {(item: {file: string, line: number}) => string | null} sourceOf
 * @returns {string}
 */
export function feedbackToon(items, sourceOf) {
	const lines = [];
	// The walk's own numbering, kept across both kinds of place: a note or a
	// description has to be able to point at a row of the table, or at another
	// entry, by the same number the person saw on the chip.
	const numbered = items.map((item, index) => ({ index: index + 1, item }));
	const located = numbered.filter(({ item }) => item.file && Number.isInteger(item.line));

	if (located.length > 0) {
		lines.push(
			`feedback[${located.length}]{index,file,line,url}:`,
			...located.map(
				({ index, item }) => `  ${index},${scalar(item.file)},${item.line},${scalar(item.url)}`
			)
		);
	}

	lines.push(
		...block(
			'notes',
			// Every element the person had something to say about, described or not:
			// a note about a palette row is as much the review as a note about a
			// line of the app. A chip with no words after it is still a place to
			// look, and the table or the context block names it either way.
			numbered
				.map(({ index, item }) =>
					item.note?.trim() ? `${index}: ${item.note.replace(/\s+/g, ' ').trim()}` : null
				)
				.filter((/** @type {string | null} */ line) => line !== null)
		)
	);

	// The places no line in the app accounts for, described as the element: this
	// is the fallback a screen-scraping toolbar would have sent for everything.
	lines.push(
		...block(
			'context',
			numbered
				.filter(({ item }) => item.context?.trim())
				.flatMap(({ index, item }) => underIndex(index, /** @type {string} */ (item.context)))
		)
	);

	// One line per element the code is quoted for: what the browser actually made
	// of it. A class is a claim and this is the measurement, and the review that
	// says "4px off" is arguing about the measurement.
	lines.push(
		...block(
			'render',
			numbered
				.filter(({ item }) => item.render?.trim())
				.map(({ index, item }) => `${index}: ${item.render}`)
		)
	);

	// One block per distinct file:line, so a person who clicked the same element
	// twice pays for the code once.
	const seen = new Set();
	for (const { item } of located) {
		const key = `${item.file}:${item.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const source = sourceOf(/** @type {{file: string, line: number}} */ (item));
		if (source) lines.push(...block(key, source.split('\n')));
	}

	return `${lines.join('\n')}\n`;
}
