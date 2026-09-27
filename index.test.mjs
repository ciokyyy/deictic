// @file: the three things that can go wrong here — reading a file the page
// should not have been able to name, sending half a batch, and losing the order
// the person clicked in
// @contract: every case drives the real middleware against a real endpoint, so
// what is asserted is what a note does, not what a mock was told to do
// @invariants: the escape case must never reach the endpoint, which is the only
// way to prove the refusal happens before the read
import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { feedbackPlugin } from './index.mjs';

/** The plugin's middleware, wired to a fake Vite server. */
function middlewareFor(options) {
	let handler;
	feedbackPlugin(options).configureServer({
		middlewares: {
			use: (fn) => {
				handler = fn;
			}
		}
	});
	return handler;
}

/** A stand-in for the request/response pair connect hands a middleware. */
function exchange(handler, body, opts = {}) {
	const { url = '/__vite-feedback', method = 'POST' } = opts;
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
	return new Promise((resolve) => {
		handler(
			{
				url,
				method,
				[Symbol.asyncIterator]: async function* () {
					yield* chunks;
				}
			},
			{
				statusCode: 200,
				setHeader() {},
				end(text) {
					resolve({ status: this.statusCode, body: String(text ?? '') });
				}
			},
			() => resolve({ status: 0, body: 'passed through' })
		);
	});
}

async function project() {
	const root = await mkdtemp(path.join(tmpdir(), 'feedback-'));
	await writeFile(path.join(root, 'Panel.svelte'), 'one\ntwo\nthree\nfour\nfive\nsix\n');
	await writeFile(path.join(root, 'Other.svelte'), 'alpha\nbeta\ngamma\n');
	return root;
}

/** A sink that records what it was given, standing in for an agent pane. */
async function sink() {
	const received = [];
	const requests = [];
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			received.push(await request.text());
			requests.push(request.url);
			return new Response('ok');
		}
	});
	return { received, requests, url: `http://127.0.0.1:${server.port}/prompt`, stop: () => server.stop(true) };
}

test('a note carries the line and the source around it', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			items: [{ note: 'this heading is too big', file: 'Panel.svelte', line: 3, url: '/settings' }]
		});
		expect(result.status).toBe(200);
		expect(far.received).toHaveLength(1);
		const body = far.received[0];
		expect(body).toContain('feedback[1]{index,file,line,url}:');
		expect(body).toContain('this heading is too big');
		expect(body).toContain('  2 | two');
		expect(body).toContain('  3 | three');
		expect(body).toContain('  4 | four');
		// A fixed window: the client cannot ask for the whole file.
		expect(body).not.toContain('six');
	} finally {
		far.stop();
	}
});

test('a batch arrives in the order it was clicked, across pages', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			items: [
				{ note: 'first: too big', file: 'Panel.svelte', line: 1, url: '/one' },
				{ note: 'second: wrong colour', file: 'Other.svelte', line: 2, url: '/two' },
				{ note: 'third: 4px off', file: 'Panel.svelte', line: 3, url: '/one' },
				{ note: 'fourth: same element again', file: 'Panel.svelte', line: 1, url: '/one' }
			]
		});
		expect(result.status).toBe(200);
		const body = far.received[0];
		expect(body).toContain('feedback[4]{index,file,line,url}:');
		// The order is the walk, not an alphabetical accident.
		expect(body.indexOf('first: too big')).toBeLessThan(body.indexOf('second: wrong colour'));
		expect(body.indexOf('second: wrong colour')).toBeLessThan(body.indexOf('third: 4px off'));
		expect(body.indexOf('third: 4px off')).toBeLessThan(body.indexOf('fourth: same element again'));
		// Both files are named, and an element clicked twice is printed once.
		expect(body).toContain('Panel.svelte:1:');
		expect(body).toContain('Other.svelte:2:');
		expect(body.match(/Panel\.svelte:1:/g)).toHaveLength(1);
	} finally {
		far.stop();
	}
});

test('one unreadable path costs its own code, not the whole batch', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			items: [
				{ note: 'mine, and readable', file: 'Panel.svelte', line: 1, url: '/one' },
				// What a portaled library component reports: a path the project
				// does not own.
				{ note: 'from a library', file: '/usr/lib/node_modules/bits-ui/item.svelte', line: 45, url: '/one' }
			]
		});
		expect(result.status).toBe(200);
		expect(far.received).toHaveLength(1);
		const body = far.received[0];
		// The readable item still arrives, with its code.
		expect(body).toContain('mine, and readable');
		expect(body).toContain('Panel.svelte:1:');
		// The other is named as unread, and nothing from it is quoted.
		expect(body).toContain('not_read:');
		expect(body).toContain('bits-ui/item.svelte:45 — outside the project');
		expect(body).not.toContain('node_modules/bits-ui/item.svelte:45:');
	} finally {
		far.stop();
	}
});

test('nothing said and nothing pointed at is not sent', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		// A chip with no words against it: a place, but nothing to do there.
		expect(
			(await exchange(handler, { items: [{ note: '   ', file: 'Panel.svelte', line: 1, url: '/' }] })).status
		).toBe(400);
		// A word, but no place to put it.
		expect(
			(await exchange(handler, { items: [{ note: 'hi', file: 'Panel.svelte', url: '/' }] })).status
		).toBe(400);
		expect((await exchange(handler, { note: 'hi', file: 'Panel.svelte', line: 1, url: '/' })).status).toBe(400);
		expect((await exchange(handler, { prompt: 'make it lighter', items: [] })).status).toBe(400);
		expect(far.received).toHaveLength(0);
	} finally {
		far.stop();
	}
});

test('the request is the words that belong to no element, and a chip may carry none', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			prompt: 'make the sidebar feel lighter',
			items: [
				// Pointed at and said nothing about: still a place, still code.
				{ note: '', file: 'Panel.svelte', line: 3, url: '/settings' },
				{ note: 'this one is 4px too tall', file: 'Other.svelte', line: 2, url: '/settings' }
			]
		});

		expect(result.status).toBe(200);
		expect(far.received).toHaveLength(1);
		const body = far.received[0];
		// The request sits above the table, and the table holds both places.
		expect(body).toContain('request: make the sidebar feel lighter');
		expect(body.indexOf('request:')).toBeLessThan(body.indexOf('feedback[2]'));
		expect(body).toContain('feedback[2]{index,file,line,url}:');
		// Only the element that has words gets a note line, and the numbering
		// still points at its row in the table.
		expect(body).not.toContain('\n  1: ');
		expect(body).toContain('  2: this one is 4px too tall');
		// The silent one's code is quoted all the same.
		expect(body).toContain('Panel.svelte:3:');
		expect(body).toContain('  3 | three');
	} finally {
		far.stop();
	}
});

test('a place the code search could not name arrives described, beside the places it could', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			prompt: 'the palette should lead with actions',
			items: [
				// A row a dependency draws: no line of the app accounts for it.
				{
					note: 'this row should lead',
					context:
						'div.flex.items-center.gap-2 "shots — main"\ndata-testid: workspace-row\npath: div.flex\nat: 25,448 516×46\nfrom: bits-ui/command-item.svelte:40',
					url: '/'
				},
				{ note: '', file: 'Panel.svelte', line: 2, url: '/' }
			]
		});

		expect(result.status).toBe(200);
		const body = far.received[0];
		expect(body).toContain('request: the palette should lead with actions');
		// The described place keeps the walk's numbering, so a note can point at
		// it, and it is described rather than counted as a location.
		expect(body).toContain('feedback[1]{index,file,line,url}:');
		expect(body).toContain('  2,Panel.svelte,2,/');
		expect(body).toContain('context:');
		expect(body).toContain('  1: div.flex.items-center.gap-2 "shots — main"');
		expect(body).toContain('     data-testid: workspace-row');
		expect(body).toContain('     from: bits-ui/command-item.svelte:40');
		// A note about a described place is a note like any other.
		expect(body).toContain('  1: this row should lead');
		// The located one still gets its code; the described one has none to get.
		expect(body).toContain('Panel.svelte:2:');
		expect(body).not.toContain('not_read');
	} finally {
		far.stop();
	}
});

test('a context with nothing in it is not a place', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		expect(
			(await exchange(handler, { prompt: 'hi', items: [{ context: '   ', url: '/' }] })).status
		).toBe(400);
		expect(far.received).toHaveLength(0);
	} finally {
		far.stop();
	}
});

test('no endpoint configured sends nothing rather than failing silently', async () => {
	const root = await project();
	const handler = middlewareFor({ root });
	const result = await exchange(handler, {
		items: [{ note: 'hi', file: 'Panel.svelte', line: 1, url: '/' }]
	});
	expect(result.status).toBe(501);
});

// The pane a person picked has to survive the hop, and it travels as a query
// parameter because the body is the note itself. Asserted on the URL the far end
// actually saw, not on a mock that was told what to expect.
test('a note goes to the pane that was picked, not just to the endpoint', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, {
			target: 'w2:p1',
			items: [{ note: 'this heading is too big', file: 'Panel.svelte', line: 1, url: '/' }]
		});
		expect(result.status).toBe(200);
		expect(far.requests[0]).toBe(`${far.url}?target=w2%3Ap1`);
	} finally {
		far.stop();
	}
});

test('a pane id with characters a URL cares about is encoded, not pasted', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		await exchange(handler, {
			target: 'w2:p1?x=1&y=2',
			items: [{ note: 'hi', file: 'Panel.svelte', line: 1, url: '/' }]
		});
		// An unencoded & would make the far end read target as "w2:p1?x=1" and
		// then stop parsing, which is a note delivered to the wrong place.
		expect(far.requests[0]).toBe(`${far.url}?target=w2%3Ap1%3Fx%3D1%26y%3D2`);
	} finally {
		far.stop();
	}
});

test('no pane picked still posts to the bare endpoint, exactly as before', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		await exchange(handler, { items: [{ note: 'hi', file: 'Panel.svelte', line: 1, url: '/' }] });
		expect(far.requests[0]).toBe(far.url);
	} finally {
		far.stop();
	}
});

test('the agent list reaches the client, derived from the one configured endpoint', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, undefined, { url: '/__vite-feedback/agents', method: 'GET' });
		expect(result.status).toBe(200);
		// The base is derived by dropping /prompt, so the two cannot drift apart
		// as separate configuration.
		expect(far.requests[0]).toBe(far.url.replace(/\/prompt$/, '/agents'));
	} finally {
		far.stop();
	}
});

test('starting an agent is forwarded as json to the same base', async () => {
	const root = await project();
	const far = await sink();
	try {
		const handler = middlewareFor({ endpoint: far.url, root });
		const result = await exchange(handler, { kind: 'pi' }, { url: '/__vite-feedback/agent' });
		expect(result.status).toBe(200);
		expect(far.requests[0]).toBe(far.url.replace(/\/prompt$/, '/agent'));
		expect(JSON.parse(far.received[0])).toEqual({ kind: 'pi' });
	} finally {
		far.stop();
	}
});

test('the agent routes are a 501 without an endpoint, not a hang', async () => {
	const handler = middlewareFor({ root: await project() });
	expect((await exchange(handler, undefined, { url: '/__vite-feedback/agents', method: 'GET' })).status).toBe(501);
	expect((await exchange(handler, { kind: 'pi' }, { url: '/__vite-feedback/agent' })).status).toBe(501);
});
