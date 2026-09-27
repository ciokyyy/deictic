// @file: a Vite plugin that turns a click in the running app into a message for
// whoever is fixing it — the file and line that produced the element, the source
// around it, and whatever the person typed about it
// @contract: feedbackPlugin(options) returns a Vite plugin that, in dev only,
// injects its client and answers the overlay's POST; nothing is added to a
// production build
// @invariants: the batch leaves as one POST, `{prompt, items}` in text/plain
// TOON, and never through a shell, so what a person types cannot execute
// anything; a path is resolved inside the Vite root and refused if it climbs
// out, because a path arrives from the browser and the browser is not a caller
// to trust; the excerpt is a fixed number of lines the server chooses, never a
// range the client can widen
// @related: client.mjs (the overlay it serves), README.md (using it elsewhere)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { feedbackToon } from './toon.mjs';

export const CLIENT_PATH = '/__vite-feedback/client.js';
const CLIENT_FILE = new URL('./client.mjs', import.meta.url);
const CONTEXT_LINES = 2;

/**
 * The wire format this build speaks, stamped on every answer. A client that gets
 * a refusal without the stamp knows the dev server is running a different build
 * of this plugin — and a Vite plugin is read when the server starts, so no
 * reload fixes that, only a restart does.
 */
const PROTOCOL = 'vite-plugin-feedback/2';

/**
 * The lines around `line`, numbered, or null when the line is not in the file.
 * @param {string} source
 * @param {number} line
 * @returns {string | null}
 */
function excerpt(source, line) {
	const lines = source.split('\n');
	if (line < 1 || line > lines.length) return null;
	const from = Math.max(0, line - 1 - CONTEXT_LINES);
	const to = Math.min(lines.length, line + CONTEXT_LINES);
	return lines
		.slice(from, to)
		.map((/** @type {string} */ text, /** @type {number} */ offset) => `${String(from + offset + 1).padStart(4)} | ${text}`)
		.join('\n');
}

/**
 * A whole review session in one message. The order is the order the person
 * clicked in — element 1 with its note, then the next, across every page they
 * walked — because a review reads as a walk, and re-sorting it would scramble
 * the thing they are describing.
 *
 * TOON rather than prose: the locations are a table, and a table is what TOON
 * is for. The code is quoted as it is written, because quoting code as data
 * makes it harder to read, not smaller.
 *
 * @param {{file?: string, line?: number, context?: string, url: string, note?: string}[]} items
 * @param {string} request what the person typed before the first element
 * @param {(item: {file: string, line: number}) => string | null} sourceOf
 * @param {{file: string, line: number, reason: string}[]} [unreadable]
 * @returns {string}
 */
function compose(items, request, sourceOf, unreadable = []) {
	const head = `[ui feedback] ${items.length} from ${new Set(items.map((item) => item.url)).size} page(s)`;
	// The words that belong to no single element — the shape of the change —
	// come first, above the places it touches.
	const said = request ? `\nrequest: ${request}` : '';
	const body = `${head}${said}\n${feedbackToon(items, sourceOf)}`;
	if (unreadable.length === 0) return body;
	// Said plainly, because the alternative is a note that quietly arrives with
	// no code attached and no reason why.
	const skipped = unreadable.map((one) => `  ${one.file}:${one.line} — ${one.reason}`).join('\n');
	return `${body}\nnot_read:\n${skipped}\n`;
}

/**
 * @typedef {object} FeedbackOptions
 * @property {string} [endpoint] Where a note goes: a POST whose body is text/plain.
 * @property {string} [root] Paths arrive relative to here — the Vite root.
 * @property {string} [prefix] Words placed before the message.
 */

/**
 * @param {FeedbackOptions} [options]
 * @returns {import('vite').Plugin}
 */
export function feedbackPlugin(options = {}) {
	const {
		/** Where a note goes: a POST whose body is text/plain. */
		endpoint = '',
		/** Paths arrive relative to here — the Vite root. */
		root = process.cwd(),
		/** Words placed before the message, e.g. the workspace's name. */
		prefix = ''
	} = options;

	const resolvedRoot = path.resolve(root);

	return {
		name: 'vite-plugin-feedback',
		// Dev only. A review tool that can read the project's source has no
		// business in a bundle a person runs in production.
		apply: 'serve',

		transformIndexHtml() {
			return [
				{ tag: 'script', attrs: { type: 'module', src: CLIENT_PATH }, injectTo: 'head' }
			];
		},

		configureServer(server) {
			server.middlewares.use(async (/** @type {any} */ request, /** @type {any} */ response, /** @type {any} */ next) => {
				// Every answer is stamped with the wire format it speaks. A client
				// that gets a refusal without the stamp knows it is talking to a
				// dev server that is running a different build of this plugin — and
				// a Vite plugin is read when the server starts, so no reload fixes
				// that, only a restart does.
				response.setHeader('x-vite-feedback', PROTOCOL);
				const url = new URL(request.url ?? '/', 'http://localhost');

				if (url.pathname === CLIENT_PATH) {
					response.setHeader('content-type', 'text/javascript');
					response.end(await readFile(CLIENT_FILE));
					return;
				}

				// The bridge's other routes sit beside the prompt one, so the base
				// is derived from the single configured endpoint rather than
				// configured twice and left to drift.
				const base = endpoint.replace(/\/[^/]*$/, '');

				if (url.pathname === '/__vite-feedback/agents' && request.method === 'GET') {
					if (!base) {
						response.statusCode = 501;
						response.end('no endpoint configured');
						return;
					}
					try {
						const answer = await fetch(`${base}/agents`);
						response.statusCode = answer.status;
						response.setHeader('content-type', 'application/json');
						response.end(await answer.text());
					} catch (cause) {
						response.statusCode = 502;
						response.end(`could not reach the endpoint: ${cause instanceof Error ? cause.message : String(cause)}`);
					}
					return;
				}

				// Starting an agent is a POST through the same hop, so the client
				// never speaks to 127.0.0.1:9977 directly and no second origin has
				// to be allowed.
				if (url.pathname === '/__vite-feedback/agent' && request.method === 'POST') {
					if (!base) {
						response.statusCode = 501;
						response.end('no endpoint configured');
						return;
					}
					const asked = [];
					for await (const chunk of request) asked.push(chunk);
					try {
						const started = await fetch(`${base}/agent`, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: Buffer.concat(asked).toString() || '{}'
						});
						response.statusCode = started.status;
						response.setHeader('content-type', 'application/json');
						response.end(await started.text());
					} catch (cause) {
						response.statusCode = 502;
						response.end(`could not reach the endpoint: ${cause instanceof Error ? cause.message : String(cause)}`);
					}
					return;
				}

				if (url.pathname !== '/__vite-feedback' || request.method !== 'POST') {
					next();
					return;
				}

				const chunks = [];
				for await (const chunk of request) chunks.push(chunk);
				let payload;
				try {
					payload = JSON.parse(Buffer.concat(chunks).toString());
				} catch {
					response.statusCode = 400;
					response.end('bad request');
					return;
				}

				const items = /** @type {any[]} */ (Array.isArray(payload?.items) ? payload.items : []);
				const prompt = typeof payload?.prompt === 'string' ? payload.prompt.trim() : '';
				// A chip is a place to look, not a sentence: an element the person
				// pointed at and said nothing about still names what to look at. And a
				// place the code search could not name arrives as the element itself,
				// which is still a place — a row a dependency draws, a framework that
				// records nothing, a node the compiler never saw.
				const usable = items.filter(
					(/** @type {any} */ item) =>
						(item?.file && Number.isInteger(item.line)) ||
						(typeof item?.context === 'string' && item.context.trim() !== '')
				);
				if (usable.length === 0) {
					response.statusCode = 400;
					response.end('items are required, each with a file and a line or a context');
					return;
				}
				// Pointing at code and saying nothing is a note nobody can act on, so
				// it is refused — but one word anywhere is enough to send.
				const silent = usable.every((/** @type {any} */ item) => !String(item?.note ?? '').trim());
				if (!prompt && silent) {
					response.statusCode = 400;
					response.end('say what should change: a request, or a word against an element');
					return;
				}

				// Every path came from the browser, and one of them can be a library
				// file the project does not own. That is a fact about the item, not
				// a reason to throw away the other four: the file is simply not read
				// and the note says so. What is never allowed is reading it.
				const absolute = new Map();
				/** @type {{file: string, line: number, reason: string}[]} */
				const unreadable = [];
				for (const item of usable) {
					// A context item has no path to resolve and nothing to read.
					if (!item.file) continue;
					const resolved = path.resolve(resolvedRoot, item.file);
					if (!resolved.startsWith(resolvedRoot + path.sep)) {
						unreadable.push({
							file: String(item.file),
							line: Number(item.line),
							reason: 'outside the project'
						});
						continue;
					}
					absolute.set(item, resolved);
				}

				// Every file is read once, before composing: the writer is
				// synchronous, so the document comes out in the order it was
				// clicked, and a repeated element pays for its code once.
				const sources = new Map();
				for (const [item, resolved] of absolute) {
					const key = `${item.file}:${item.line}`;
					if (sources.has(key)) continue;
					try {
						sources.set(key, excerpt(await readFile(resolved, 'utf8'), item.line));
					} catch {
						sources.set(key, null);
					}
				}

				const body = compose(
					usable,
					prompt,
					(item) => sources.get(`${item.file}:${item.line}`) ?? null,
					unreadable
				);
				if (!endpoint) {
					response.statusCode = 501;
					response.end('no endpoint configured');
					return;
				}
				try {
					// The pane the person picked rides as a query parameter, because
					// the body is the note itself and text/plain carries nothing
					// structured. Absent means "the focused one", which is what this
					// route did before the picker existed.
					const target = typeof payload?.target === 'string' ? payload.target.trim() : '';
					const where = target ? `${endpoint}?target=${encodeURIComponent(target)}` : endpoint;
					const delivered = await fetch(where, {
						method: 'POST',
						headers: { 'content-type': 'text/plain' },
						body: prefix ? `${prefix} ${body}` : body
					});
					response.statusCode = delivered.ok ? 200 : 502;
					response.end(delivered.ok ? 'sent' : `the far end said ${delivered.status}`);
				} catch (cause) {
					response.statusCode = 502;
					response.end(
						`could not reach the endpoint: ${cause instanceof Error ? cause.message : String(cause)}`
					);
				}
			});
		}
	};
}
