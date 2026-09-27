// @file: the picker's rule, in a page — while the modifier is held every
// element is a target, the chip it leaves lands in the one field, and neither
// the press nor the click that picks one ever reaches the app
// @contract: the overlay is imported once, against a page built before it, and
// then driven with real events; the module keeps its state for the whole file,
// so the tests are ordered
// @related: client.mjs (the half under test)
import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
	'<!doctype html><html><body><a href="/projects">g shots</a><button data-testid="new-chat">New chat</button></body></html>',
	{ url: 'http://localhost:5174/' }
);

// A module with side effects wants the page's globals before it is imported,
// and the `instanceof` checks inside it compare against the page's own classes.
const { window } = dom;
Object.assign(globalThis, {
	window,
	document: window.document,
	location: window.location,
	Node: window.Node,
	Element: window.Element,
	HTMLElement: window.HTMLElement,
	MouseEvent: window.MouseEvent,
	KeyboardEvent: window.KeyboardEvent,
	MutationObserver: window.MutationObserver,
	getComputedStyle: window.getComputedStyle.bind(window),
	sessionStorage: window.sessionStorage,
	// The panel remembers the pane that was picked, and a browser has this
	// global. It was not exposed here, which is why the picker could not be
	// tested for remembering anything at all.
	localStorage: window.localStorage,
	requestAnimationFrame: (run) => run()
});

/** @type {{url: string, body: any}[]} */
const sent = [];
globalThis.fetch = /** @type {any} */ (
	async (url, init) => {
		sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return { ok: true, status: 200, text: async () => 'sent' };
	}
);

await import('./client.mjs');

const hud = (/** @type {string} */ name) =>
	/** @type {HTMLElement} */ (document.querySelector(`[data-vite-feedback="${name}"]`));
const chips = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[data-vite-feedback="chip"]')]);
const field = () => hud('input');
const link = () => /** @type {HTMLElement} */ (document.querySelector('a'));
const button = () => /** @type {HTMLElement} */ (document.querySelector('[data-testid="new-chat"]'));

function arm() {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
}
function release() {
	window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
}

/** @param {string} type @param {EventTarget} node */
function modified(type, node) {
	const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, altKey: true });
	node.dispatchEvent(event);
	return event;
}

/** Tell a picked element where it came from, the way Svelte's dev build does. */
function from(node, file, line) {
	/** @type {any} */ (node).__svelte_meta = { loc: { file, line } };
	return node;
}

/** Rewrite the field as a person's editing leaves it, and let the plugin read it. */
function fill(nodes) {
	field().textContent = '';
	field().append(...nodes);
	field().dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function enter() {
	field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	await Bun.sleep(0);
}

test('the blob starts closed with the launcher showing, and the modifier alone does not open it', () => {
	expect(hud('blob').style.display).toBe('none');
	expect(hud('launcher').style.display).toBe('flex');

	arm();

	// Holding the modifier is pointing, not opening: chrome that appeared under
	// the cursor would cover the thing being pointed at.
	expect(hud('blob').style.display).toBe('none');
	expect(document.body.style.cursor).toBe('crosshair');
});

test('hover names every element under the cursor — a link and a button alike', () => {
	arm();
	from(link(), 'src/lib/AppSidebar.svelte', 73);
	from(button(), 'src/lib/NewChat.svelte', 12);

	for (const node of [link(), button()]) {
		node.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, altKey: true }));
		expect(hud('outline').style.display).toBe('block');
		expect(hud('label').textContent).toContain('.svelte:');
	}
});

test('a modified click on a link drops a chip instead of following it', () => {
	let followed = false;
	link().addEventListener('click', () => {
		followed = true;
	});

	const click = modified('click', link());

	expect(click.defaultPrevented).toBe(true);
	expect(followed).toBe(false);
	// A pick is the other way in: the first chip opens the panel it landed in.
	expect(hud('blob').style.display).toBe('flex');
	expect(hud('launcher').style.display).toBe('none');
	expect(chips()).toHaveLength(1);
	// The chip is numbered, named and carries the place the server resolves.
	expect(chips()[0].textContent).toBe('1 · lib/AppSidebar.svelte:73');
	expect(chips()[0].dataset.file).toBe('src/lib/AppSidebar.svelte');
	expect(chips()[0].dataset.line).toBe('73');
	expect(chips()[0].dataset.url).toBe('/');
});

test('a button is a target too, and the press and the click that take it stop at the picker', () => {
	let pressed = false;
	let acted = false;
	button().addEventListener('mousedown', () => {
		pressed = true;
	});
	button().addEventListener('click', () => {
		acted = true;
	});

	expect(modified('mousedown', button()).defaultPrevented).toBe(true);
	const click = modified('click', button());

	expect(click.defaultPrevented).toBe(true);
	expect(pressed).toBe(false);
	expect(acted).toBe(false);
	expect(chips().map((chip) => chip.textContent)).toEqual(['1 · lib/AppSidebar.svelte:73', '2 · lib/NewChat.svelte:12']);
});

test('the words before the first chip are the request, and the words after a chip are its note', () => {
	const [first, second] = chips();
	fill([
		'tighten the sidebar ',
		first,
		' this row is 4px too tall ',
		second,
		' and this button should be secondary'
	]);

	const stored = JSON.parse(sessionStorage.getItem('vite-plugin-feedback:document') ?? '{}');
	expect(stored.request).toBe('tighten the sidebar');
	// The fields that carry the review, exactly; the measured line rides along
	// beside them, and its values are the browser's, so only its presence is
	// asserted here — jsdom has no layout to measure.
	expect(stored.items).toHaveLength(2);
	expect(stored.items[0]).toMatchObject({
		file: 'src/lib/AppSidebar.svelte',
		line: 73,
		url: '/',
		note: 'this row is 4px too tall'
	});
	expect(stored.items[1]).toMatchObject({
		file: 'src/lib/NewChat.svelte',
		line: 12,
		url: '/',
		note: 'and this button should be secondary'
	});
	expect(stored.items.every((/** @type {any} */ item) => typeof item.render === 'string')).toBe(true);
	expect(stored.items[0].render).toContain('display');
	// The measured line is where "the code lies" is settled, so it has to be
	// readable: a colour as hex, and nothing that says nothing.
	expect(stored.items[0].render).toContain('#0000ee');
	expect(stored.items[0].render).not.toContain('NaN');
	expect(stored.items[0].render).not.toMatch(/·\s*·/);
});

test('closing keeps the walk, the launcher wears its count, and the circle comes back to it', () => {
	field().focus();
	hud('close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

	expect(hud('blob').style.display).toBe('none');
	expect(hud('launcher').style.display).toBe('flex');
	expect(hud('count').textContent).toBe('2');
	// The caret leaves with the panel: a hidden field that kept focus would eat
	// the page's keystrokes.
	expect(field().contains(document.activeElement)).toBe(false);
	// Closing is not clearing.
	expect(JSON.parse(sessionStorage.getItem('vite-plugin-feedback:document') ?? '{}').items).toHaveLength(2);

	hud('launcher').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

	expect(hud('blob').style.display).toBe('flex');
	expect(hud('launcher').style.display).toBe('none');
	expect(chips().map((chip) => chip.textContent)).toEqual([
		'1 · lib/AppSidebar.svelte:73',
		'2 · lib/NewChat.svelte:12'
	]);
});

test('Enter sends the whole walk as one document, stamped with the protocol, and the field is emptied', async () => {
	await enter();

	expect(sent).toHaveLength(1);
	expect(sent[0].url).toBe('/__vite-feedback');
	// The stamp is how a server running a different build of this plugin is told
	// so: it stamps its answers, and its absence is the tell.
	expect(sent[0].body.plugin).toBe('vite-plugin-feedback/2');
	expect(sent[0].body.request).toBe('tighten the sidebar');
	expect(sent[0].body.items).toHaveLength(2);
	expect(sent[0].body.items[0]).toMatchObject({
		file: 'src/lib/AppSidebar.svelte',
		line: 73,
		url: '/',
		note: 'this row is 4px too tall'
	});
	expect(sent[0].body.items[1]).toMatchObject({
		file: 'src/lib/NewChat.svelte',
		line: 12,
		url: '/',
		note: 'and this button should be secondary'
	});
	expect(chips()).toHaveLength(0);
	expect(field().textContent).toBe('');
});

test('a request with no element behind it says so rather than sending nothing', async () => {
	fill(['make the whole thing feel lighter']);
	await enter();

	expect(sent).toHaveLength(1);
	expect(hud('status').textContent).toContain('point at an element first');
});

test('a chip nothing was said about is refused, so a silent walk never leaves', async () => {
	fill(['']);
	arm();
	modified('click', link());
	expect(chips()).toHaveLength(1);

	await enter();

	expect(sent).toHaveLength(1);
	expect(hud('status').textContent).toContain('say what should change');
});

test('a pick inside a dialog moves the panel into it, and the dialog closing brings it home', async () => {
	// A modal focus trap cannot be beaten from outside, so the panel has to be
	// inside: that is what lets the field take the caret while a dialog owns the
	// keyboard.
	const dialog = document.createElement('div');
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	// jsdom has no layout and no top layer, so "is it drawn" has to be said out
	// loud, and this harness covers the fallback: the panel lives in the dialog
	// and draws as its footer. The top-layer placement — inside the dialog's DOM,
	// drawn at the bottom of the window — is the browser's path, verified there.
	dialog.getClientRects = /** @type {any} */ (() => [{ width: 1 }]);
	document.body.append(dialog);

	arm();
	const before = chips().length;
	modified('click', link());

	expect(hud('blob').style.display).toBe('flex');
	expect(hud('blob').parentElement).toBe(dialog);
	expect(hud('launcher').parentElement).toBe(dialog);
	expect(chips()).toHaveLength(before + 1);
	// Inside a dialog the panel is its footer, not a viewport-anchored bar.
	expect(hud('blob').style.position).toBe('absolute');
	expect(hud('blob').style.left).toBe('10px');

	dialog.remove();
	await Bun.sleep(0);

	expect(hud('blob').parentElement).toBe(document.body);
	expect(hud('blob').style.position).toBe('fixed');
	expect(hud('blob').style.display).toBe('flex');
});

test('closing the panel inside a dialog keeps the circle off the dialog', async () => {
	const dialog = document.createElement('div');
	dialog.setAttribute('role', 'dialog');
	dialog.setAttribute('aria-modal', 'true');
	dialog.getClientRects = /** @type {any} */ (() => [{ width: 1 }]);
	document.body.append(dialog);

	arm();
	modified('click', link());
	expect(hud('blob').parentElement).toBe(dialog);

	hud('close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

	// No circle in the dialog's footer: the way back arrives when it closes.
	expect(hud('blob').style.display).toBe('none');
	expect(hud('launcher').style.display).toBe('none');

	dialog.remove();
	await Bun.sleep(0);

	expect(hud('launcher').style.display).toBe('flex');
	expect(hud('launcher').parentElement).toBe(document.body);
});

test('a modified click with the modifier never seen says so rather than doing nothing', () => {
	release();
	modified('click', link());

	expect(hud('label').style.display).toBe('block');
	expect(hud('label').textContent).toContain('hold the modifier down first');
});

test('a portaled element answers with the app’s own line, not the library’s', () => {
	// A dialog is portaled to the body: the library frames between the element
	// and the app that composed it are many, and stopping short of the app
	// answers with a node_modules line the server then refuses to read.
	const inner = from(document.createElement('div'), 'node_modules/bits-ui/dist/item.svelte', 40);
	document.body.append(inner);
	let deepest = inner;
	for (let depth = 0; depth < 20; depth += 1) {
		const wrapper = from(document.createElement('div'), `node_modules/bits-ui/dist/frame-${depth}.svelte`, depth);
		wrapper.append(deepest);
		document.body.append(wrapper);
		deepest = wrapper;
	}
	const owner = document.createElement('section');
	owner.append(deepest);
	document.body.append(owner);
	from(owner, 'src/lib/components/CommandPalette.svelte', 12);

	arm();
	modified('click', inner);

	const chip = chips().at(-1);
	expect(chip?.dataset.file).toBe('src/lib/components/CommandPalette.svelte');
	expect(chip?.dataset.line).toBe('12');

	owner.remove();
});

test('an element a dependency draws arrives described, and says where the search landed', () => {
	// The palette's rows are drawn entirely by bits-ui: no app element exists in
	// that subtree to name. A line inside the library is not an answer about the
	// app, so the pick lands as the element — with the library line kept, because
	// which drawer it was rendered into is worth knowing.
	const row = from(
		document.createElement('div'),
		'/repo/node_modules/.bun/bits-ui@2.19.3+2a1681a79325820b/node_modules/bits-ui/dist/bits/command/components/command-item.svelte',
		40
	);
	row.className = 'flex items-center gap-2';
	row.setAttribute('data-testid', 'workspace-row');
	row.textContent = 'shots — ~/worktrees/go-agent · main';
	document.body.append(row);

	arm();
	modified('click', row);

	const chip = chips().at(-1);
	// Not a file chip any more: there is no file of the app's to name.
	expect(chip?.dataset.file).toBeUndefined();
	// The chip says what a person recognises it by, not what a parser sees.
	expect(chip?.textContent).toBe('5 · div "shots — ~/worktrees/go-agent · main"');

	const stored = JSON.parse(sessionStorage.getItem('vite-plugin-feedback:document') ?? '{}').items.at(-1);
	expect(stored.file).toBeUndefined();
	expect(stored.context).toContain('div.flex.items-center.gap-2 "shots — ~/worktrees/go-agent · main"');
	expect(stored.context).toContain('data-testid=workspace-row');
	// The trail stops at the body: the body is not a step anyone needs.
	expect(stored.context).toContain('path: div.flex');
	expect(stored.context).toContain('from: bits-ui/command-item.svelte:40');

	row.remove();
});

test('an element with no source location at all still lands, described', () => {
	// A framework that records nothing, or a node the compiler never saw: the
	// finding is the finding, and it does not need a file to travel in.
	const node = document.createElement('button');
	node.className = 'rounded-full px-3';
	node.setAttribute('aria-label', 'Open workspace menu');
	node.textContent = 'Open…';
	document.body.append(node);

	arm();
	modified('click', node);

	const stored = JSON.parse(sessionStorage.getItem('vite-plugin-feedback:document') ?? '{}').items.at(-1);
	expect(stored.context).toContain('button.rounded-full.px-3 "Open…"');
	expect(stored.context).toContain('aria-label=Open workspace menu');
	expect(stored.context).not.toContain('from:');

	node.remove();
});

test('the blob is the one press that still lands while the page is inert', () => {
	arm();
	expect(modified('mousedown', field()).defaultPrevented).toBe(false);
	expect(modified('mousedown', button()).defaultPrevented).toBe(true);
});

test('a pick leaves the caret in the field, and alt held there still arms the picker', () => {
	// The key a person's keyboard sends goes to whatever has focus, and a pick
	// leaves focus in the field. A field that stopped the modifier on its way up
	// would leave the picker unable to arm itself for the next pick.
	release();
	field().focus();
	field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));

	expect(document.body.style.cursor).toBe('crosshair');
});

test('Escape leaves the panel — the dialog it lives in has to hear it — while typing stays local', () => {
	let reachedWindow = 0;
	const count = () => {
		reachedWindow += 1;
	};
	window.addEventListener('keydown', count);

	field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	expect(reachedWindow).toBe(1);

	// Everything else stays in the panel: the page must not see the sentence
	// being typed into the field, or its own shortcuts would fire mid-note.
	field().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
	field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	expect(reachedWindow).toBe(1);

	window.removeEventListener('keydown', count);
});

// ─── the target picker ──────────────────────────────────────────────────────
// The picker is the one place a note decides WHO reads it, so these drive the
// real panel and assert on the option list and the body that goes out.

const AGENTS = {
	agents: [
		{ pane: 'w1:p1', kind: 'omp', name: null, focused: true, status: 'working' },
		{ pane: 'w2:p1', kind: 'pi', name: 'critic', focused: false, status: 'idle' }
	],
	free: ['w9:p2'],
	kinds: ['omp', 'pi', 'claude']
};

/** Swaps the global fetch for one that answers the census, so a test never
 *  races the picker against the panel's own load. */
async function withAgents(answer, run) {
	const was = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (url, init) => {
		seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (String(url).endsWith('/agents')) {
			return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
		}
		if (String(url).endsWith('/agent')) {
			return { ok: true, status: 200, json: async () => ({ started: true, name: 'feedback-pi-1', pane: 'w9:p2' }), text: async () => '{}' };
		}
		return { ok: true, status: 200, text: async () => 'sent' };
	};
	try {
		await run(seen);
	} finally {
		globalThis.fetch = was;
	}
}

const picker = () => /** @type {HTMLSelectElement} */ (hud('target'));
const optionTexts = () => [...picker().options].map((one) => one.textContent);
const optionValues = () => [...picker().options].map((one) => one.value);
/** Two turns of the microtask queue, which is what the panel's own await chain
 *  costs: one for the fetch, one for the json. */
const settled = () => Promise.resolve().then(() => Promise.resolve());

/** Opens the panel the way a person does. Closed first, because this file's
 *  module keeps its state for the whole run: a picker test that assumed the
 *  panel happened to be closed would pass or fail on whatever ran before it. */
async function openPanel() {
	hud('close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	hud('launcher').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await settled();
}

/** Closed, modifier held, picked. A pick lands only while the panel is closed,
 *  and the pick is itself what opens it — so this is also what reads the census,
 *  and reopening afterwards would throw the chip away. */
async function pickThenOpen() {
	hud('close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	// Its own element, not the page's link: earlier tests in this file navigate
	// that one away, so reusing it would make a picker test depend on them.
	const made = document.createElement('button');
	made.textContent = 'a fresh thing';
	document.body.append(made);
	// The modifier has to be HELD, not merely present on the click: the overlay
	// arms on the keydown and a window manager that grabs alt would otherwise
	// make a pick look like a plain click. Dispatched on window, which is where
	// it listens.
	window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
	modified('click', made);
	// Released again: a modifier left held here is still held for every test that
	// runs after this one, which is how a picker test ends up owning the armed
	// state of an unrelated one.
	window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Alt', altKey: true, bubbles: true }));
	await settled();
}

test('the picker offers every agent that is running, by kind and by name', async () => {
	await withAgents(AGENTS, async () => {
		await openPanel();
		// Empty first, because empty means "the focused one" and must stay the
		// default for anyone who never touches this.
		expect(optionValues()[0]).toBe('');
		expect(optionTexts().join(' ')).toContain('omp');
		expect(optionTexts().join(' ')).toContain('critic · pi');
		expect(optionValues()).toContain('w2:p1');
	});
});

test('a new agent can be started by kind, because herdr has free panes to start one in', async () => {
	await withAgents(AGENTS, async (seen) => {
		await openPanel();
		expect(optionValues()).toContain('+pi');
		picker().value = '+pi';
		picker().dispatchEvent(new window.Event('change', { bubbles: true }));
		await settled();
		await settled();
		const started = seen.find((one) => one.url.endsWith('/__vite-feedback/agent'));
		expect(started.body).toEqual({ kind: 'pi' });
		// And the pane it landed in becomes the one a note would go to.
		expect(picker().value).toBe('w9:p2');
	});
});

test('no free pane means no start-new group, rather than a start that cannot happen', async () => {
	await withAgents({ ...AGENTS, free: [] }, async () => {
		await openPanel();
		expect(optionValues().some((one) => one.startsWith('+'))).toBe(false);
		expect(optionValues()).toContain('w2:p1');
	});
});

test('a bridge that cannot be reached leaves the one choice that always works', async () => {
	const was = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error('fetch failed');
	};
	try {
		await openPanel();
		// A picker is an addition, not a gate: this is the state the panel was in
		// before the picker existed and it must still be able to send.
		expect(optionValues()).toEqual(['']);
	} finally {
		globalThis.fetch = was;
	}
});

test('the pane that was picked last is picked again, and rides the note', async () => {
	await withAgents(AGENTS, async (seen) => {
		await pickThenOpen();
		// At least one, not exactly one: this file's walk persists in
		// sessionStorage, so earlier tests' chips are still in the field.
		expect(chips().length).toBeGreaterThan(0);
		picker().value = 'w2:p1';
		picker().dispatchEvent(new window.Event('change', { bubbles: true }));
		expect(localStorage.getItem('vite-feedback-target')).toBe('w2:p1');

		// Picking again is what a person does between notes, and the panel is
		// closed and reopened by that, so the choice has to survive it.
		await pickThenOpen();
		expect(picker().value).toBe('w2:p1');

		// Appended, not assigned: textContent replaces every child, and the
		// children are the chips. A note belongs to the chip it follows.
		field().append(document.createTextNode('this heading is too big'));
		hud('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		await settled();
		await settled();
		const note = seen.filter((one) => one.url.endsWith('/__vite-feedback')).pop();
		// The whole point of the hop: the pane reached the wire.
		expect(note.body.target).toBe('w2:p1');
		localStorage.removeItem('vite-feedback-target');
	});
});

test('a remembered pane that has since closed is not carried into a note', async () => {
	await withAgents(AGENTS, async (seen) => {
		localStorage.setItem('vite-feedback-target', 'wGone:p9');
		await pickThenOpen();
		// The pane is not among the options, so selecting it would silently mean
		// the first option instead.
		expect(picker().value).toBe('');

		field().append(document.createTextNode('hello there'));
		hud('send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		await settled();
		await settled();
		const note = seen.filter((one) => one.url.endsWith('/__vite-feedback')).pop();
		// Absent, not empty: an empty target is a pane id that does not exist,
		// and the far end would answer 502 for a note nobody meant to misroute.
		expect('target' in note.body).toBe(false);
		localStorage.removeItem('vite-feedback-target');
	});
});

// ─── draggable, on top, and deaf to the app ─────────────────────────────────

const blob = () => hud('blob');
const launcher = () => hud('launcher');
const pointer = (type, target, x, y) =>
	target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }));

test('the blob is dragged by its own chrome, and lands where it was put', () => {
	blob().style.display = 'flex';
	pointer('pointerdown', blob(), 100, 100);
	pointer('pointermove', blob(), 160, 140);
	expect(blob().style.left).toBe('60px');
	expect(blob().style.top).toBe('40px');
	// The centred default is a translate; leaving it in place would drag the blob
	// by half its own width as well.
	expect(blob().style.transform).toBe('none');
	pointer('pointerup', blob(), 160, 140);
});

test('a press inside the field or a button drags nothing, because it belongs to them', () => {
	const before = blob().style.left;
	pointer('pointerdown', hud('input'), 10, 10);
	pointer('pointermove', blob(), 200, 200);
	expect(blob().style.left).toBe(before);
	pointer('pointerdown', hud('send'), 10, 10);
	pointer('pointermove', blob(), 200, 200);
	expect(blob().style.left).toBe(before);
});

test('a blob dragged off the edge is clamped, so it can be dragged back', () => {
	blob().style.display = 'flex';
	pointer('pointerdown', blob(), 100, 100);
	pointer('pointermove', blob(), 99999, 99999);
	// JSDOM has no layout, so the width is 0 and the clamp is the viewport edge —
	// which is exactly the assertion that matters: never past it.
	expect(parseInt(blob().style.left, 10)).toBeLessThanOrEqual(window.innerWidth);
	expect(parseInt(blob().style.top, 10)).toBeLessThanOrEqual(window.innerHeight);
	pointer('pointerup', blob(), 0, 0);
});



test('the launcher is draggable, even though it is a button', () => {
	// The launcher is the only surface on screen with the panel closed, so it is
	// the one a person drags in practice. It is a <button>, and the handle test
	// excludes buttons, so it used to exclude itself: the circle could not be
	// moved at all, and its default is the top-left corner.
	expect(launcher().tagName).toBe('BUTTON');
	pointer('pointerdown', launcher(), 100, 100);
	pointer('pointermove', launcher(), 300, 260);
	expect(launcher().style.left).toBe('200px');
	expect(launcher().style.top).toBe('160px');
	pointer('pointerup', launcher(), 300, 260);
});

test('each surface remembers its own place, not a shared one', () => {
	// One key for both surfaces meant the last one dragged silently moved the
	// other on the next load, and the launcher is the only one on screen while the panel
	// is shut, so it always won.
	pointer('pointerdown', blob(), 10, 10);
	pointer('pointermove', blob(), 40, 50);
	pointer('pointerup', blob(), 40, 50);
	pointer('pointerdown', launcher(), 10, 10);
	pointer('pointermove', launcher(), 700, 600);
	pointer('pointerup', launcher(), 700, 600);
	const keys = Object.keys(localStorage).filter((k) => k.startsWith('vite-feedback-where'));
	expect(keys.length).toBe(2);
	// The keys are the contract; the values are not assertable here because JSDOM
	// does no layout and every box is 0x0. What is worth pinning is that each
	// surface has its own slot to be restored into.
	expect(keys.sort()).toEqual(['vite-feedback-where-blob', 'vite-feedback-where-launcher']);
	for (const k of keys) localStorage.removeItem(k);
});

test('the circle starts in the bottom right, where a launcher belongs', async () => {
	// The default is only what a person sees on a first visit. Everything
	// remembered is cleared and the overlay is mounted again, because on the mount
	// that is already up a remembered place is correctly winning and the default is
	// not what is on screen. dispose() takes the old one down with it, so there is
	// still exactly one overlay afterwards.
	for (const k of Object.keys(localStorage).filter((k) => k.startsWith('vite-feedback'))) localStorage.removeItem(k);
	blob().dispatchEvent(new window.CustomEvent('vite-feedback:unmount'));
	await import('./client.mjs?fresh-mount=1');
	const fresh = /** @type {HTMLElement} */ (document.querySelector('[data-vite-feedback="launcher"]'));
	expect(document.querySelectorAll('[data-vite-feedback="launcher"]').length, 'one overlay, not two').toBe(1);
	// `bottom: 20px` alone does not put it there: the popover UA sheet declares
	// `inset: 0`, so top and bottom are both set and the box is over-constrained,
	// where top wins and the circle lands at the top left of the viewport. Naming
	// the corner means naming the two sides that are `auto`.
	expect(fresh.style.right).toBe('20px');
	expect(fresh.style.bottom).toBe('20px');
	expect(fresh.style.left).toBe('auto');
	expect(fresh.style.top).toBe('auto');
});

const closePanel = () => hud('close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

test('a drag that ends on the circle is not a click, and does not open the panel', () => {
	// The circle opens the walk; it does not toggle it, so the close button is how
	// a panel is shut. The baseline is stated rather than inherited.
	launcher().click();
	expect(blob().style.display, 'the panel opened, so the baseline holds').toBe('flex');
	closePanel();
	expect(blob().style.display, 'and the close button shuts it').toBe('none');

	// The browser sends a click after every pointerup, drag or not. A drag that
	// opened the panel meant the circle could not be moved without also opening
	// the thing it was being moved away from.
	pointer('pointerdown', launcher(), 100, 100);
	pointer('pointermove', launcher(), 260, 240);
	pointer('pointerup', launcher(), 260, 240);
	launcher().dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
	expect(blob().style.display, 'a drag opened the panel').toBe('none');

	// And a plain click still works, or the fix is just "the circle is dead".
	launcher().click();
	expect(blob().style.display, 'a real click no longer opens the panel').toBe('flex');
});
test('what is remembered is the box on screen, not an untransformed offset', () => {
	// offsetLeft is the untransformed layout offset, so for the centred default
	// — left: 50% with translateX(-50%) — it reports the centre of the viewport
	// and not where the blob actually is. Storing that puts a dragged blob back
	// somewhere nobody put it.
	blob().getBoundingClientRect = () => ({ left: 300, top: 200, right: 338, bottom: 238, width: 38, height: 38 });
	pointer('pointerdown', blob(), 310, 210);
	pointer('pointermove', blob(), 310, 210);
	pointer('pointerup', blob(), 310, 210);
	const saved = Object.keys(localStorage)
	.filter((k) => k.startsWith('vite-feedback-where'))
	.map((k) => JSON.parse(localStorage.getItem(k)))
	.find((p) => p.left === 300);
	expect(saved).toEqual({ left: 300, top: 200 });
	for (const k of Object.keys(localStorage).filter((k) => k.startsWith('vite-feedback-where'))) localStorage.removeItem(k);
});

// The app must not act on a gesture that is a pick. Asserted on the app's own
// listener, because "the overlay stopped it" is only true if the app really
// received nothing.
test('while the modifier is held the app sees no press, wheel or context menu', () => {
	const appSaw = [];
	const app = document.createElement('div');
	for (const type of ['pointerdown', 'mouseup', 'contextmenu', 'wheel', 'dblclick', 'touchstart']) {
		app.addEventListener(type, () => appSaw.push(type));
	}
document.body.append(app);

	// The baseline is stated, not inherited: a modifier left held by an earlier
	// test would make "not armed" false without anything here being wrong.
	window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
	// Not armed: everything is the app's, which is what keeps a plain click normal.
	app.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
	expect(appSaw).toEqual(['pointerdown']);
	appSaw.length = 0;

	window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
	for (const type of ['pointerdown', 'mouseup', 'contextmenu', 'wheel', 'dblclick', 'touchstart']) {
		const Ctor = type.startsWith('touch') ? window.Event : type === 'wheel' ? window.Event : window.MouseEvent;
		app.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true }));
	}
	expect(appSaw).toEqual([]);

	window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Alt', altKey: true, bubbles: true }));
	app.remove();
});

test('the overlay still works while the modifier is held, or it could not be driven', () => {
	window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Alt', altKey: true, bubbles: true }));
	// A press on the blob is ours, and swallowing it would make the picker
	// impossible to use — which is the failure mode of being too thorough.
	const seen = [];
	blob().addEventListener('pointerdown', () => seen.push('blob'));
	pointer('pointerdown', blob(), 5, 5);
	expect(seen).toEqual(['blob']);
	blob().removeEventListener('pointerdown', () => seen.push('blob'));
	window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Alt', altKey: true, bubbles: true }));
});

test('the top layer is used when the browser has one, and its absence is survivable', () => {
	// JSDOM has no showPopover, so this asserts the fallback: the maximum z-index
	// this always used is still there, and nothing threw on the way.
	const has = typeof blob().showPopover === 'function';
	expect(blob().style.zIndex).toBe('2147483647');
	if (has) expect(blob().getAttribute('popover')).toBe('manual');
});
