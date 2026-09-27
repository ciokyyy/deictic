// @file: the half of the feedback plugin that runs in the page — hold the
// modifier to point at an element, type what should change around the chips it
// leaves behind, and send the whole thing to whoever is fixing it
// @contract: alt-click (or ctrl-click) an element to drop a chip into the blob's
// input; the words before the first chip are the request and the words after a
// chip are that element's note; Enter posts {prompt,items} to /__vite-feedback
// and answers 'sent'; Shift+Enter is a newline; Clear throws the document away
// and ✕ only puts it away, with the circle at the bottom left as the way back;
// nothing is sent without a word typed somewhere
// @invariants: no framework and no build step, so the plugin drops into any Vite
// app; the outline, the label and the blob are the only DOM it adds; while the
// modifier is held the page takes no press and no click, so nothing under the
// cursor can act before it is pointed at; every pick lands — as a file and a
// line when the app owns the place, as the element itself when nothing in the
// subtree is the app's, because a refusal would lose the reviewer's finding over
// a path; the blob is the document — nothing is kept in a side variable that a
// person's own editing could contradict, and it is mirrored into sessionStorage
// so a page change does not lose the walk
// @related: index.mjs (the server that reads the file and sends the message)

/**
 * Where the element came from, in the app's own source.
 *
 * The nearest location is not always the useful one: a portaled dialog renders
 * its frame in a library component, so the closest answer is a line in
 * `node_modules/bits-ui`. Walking up to the first location the app owns is what
 * makes a portal debuggable — the line you want is the one that composed it.
 *
 * All the way up, with no depth cap: a dialog is portaled to the body, so its
 * app-owned caller sits above the library frames in between — a cap that stops
 * short of it answers with a `node_modules` line, and a `node_modules` line is
 * a file the server will refuse to read.
 *
 * @param {Element} node
 * @returns {{file: string, line: number} | null}
 */
function locate(node) {
	let fallback = null;
	for (let el = /** @type {Element | null} */ (node); el; el = el.parentElement) {
		const meta = /** @type {any} */ (el).__svelte_meta;
		const loc = meta?.loc ?? meta?.parent;
		if (!loc?.file || typeof loc.line !== 'number') continue;
		const found = { file: String(loc.file), line: Number(loc.line) };
		if (!found.file.includes('node_modules')) return found;
		fallback ??= found;
	}
	return fallback;
}

/** @param {Element} node */
function describe(node) {
	const testid = node.closest?.('[data-testid]')?.getAttribute('data-testid');
	const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
	return `${testid ? `${node.tagName.toLowerCase()}[data-testid="${testid}"]` : node.tagName.toLowerCase()}${text ? ` "${text}"` : ''}`;
}

// One overlay at a time. Vite reloads this module on every edit, and a project
// can both have the plugin inject the client and import it itself: the mount
// that comes second takes the first one down, or the page keeps both — two
// blobs, two outlines, two labels, and a chip dropped in each of them by a
// single pick.
for (const stale of document.querySelectorAll('[data-vite-feedback]')) {
	stale.dispatchEvent(new CustomEvent('vite-feedback:unmount'));
	stale.remove();
}

const outline = document.createElement('div');
outline.setAttribute('data-vite-feedback', 'outline');
Object.assign(outline.style, {
	position: 'fixed',
	pointerEvents: 'none',
	border: '2px solid #38bdf8',
	background: 'rgba(56, 189, 248, 0.12)',
	borderRadius: '2px',
	zIndex: '2147483646',
	display: 'none'
});

const label = document.createElement('div');
label.setAttribute('data-vite-feedback', 'label');
Object.assign(label.style, {
	position: 'fixed',
	pointerEvents: 'none',
	padding: '2px 6px',
	borderRadius: '4px',
	background: '#0ea5e9',
	color: '#04121c',
	font: '11px/1.4 ui-monospace, monospace',
	zIndex: '2147483647',
	display: 'none',
	whiteSpace: 'nowrap'
});

// The blob. One input, at the bottom, over everything: the shape the 21st.dev
// toolbar has, because what a person is doing is writing a prompt about places
// in a page, and a prompt belongs in one field.
//
// Two placements, because a modal owns the keyboard: at the bottom of the
// viewport while the page is the page, and as the dialog's own footer while a
// dialog is open — inside it, the focus trap is satisfied and the field can
// hold the caret, which it cannot from outside.
const BLOB_LOOK = {
	// Stated rather than inherited: a modal dialog sets `pointer-events: none`
	// on the body, and this blob is a child of the body. Inheriting it made every
	// click in the field land on whatever was behind it, which reads as the blob
	// being transparent rather than as a page that has taken the keyboard.
	pointerEvents: 'auto',
	zIndex: '2147483647',
	boxSizing: 'border-box',
	padding: '10px',
	borderRadius: '16px',
	background: '#131316',
	border: '1px solid #2f2f36',
	boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
	display: 'none',
	flexDirection: 'column',
	gap: '6px',
	font: '13px/1.5 system-ui, sans-serif',
	color: '#fafafa'
};
const BLOB_ON_PAGE = {
	position: 'fixed',
	left: '50%',
	right: 'auto',
	top: 'auto',
	bottom: '20px',
	width: 'min(660px, calc(100vw - 24px))',
	transform: 'translateX(-50%)',
	// The popover UA sheet sets `inset: 0` and `margin: auto`; stating these
	// keeps the bar where the page puts it, in a dialog or not.
	margin: '0',
	overflow: 'visible'
};
const BLOB_IN_DIALOG = {
	position: 'absolute',
	left: '10px',
	right: '10px',
	bottom: '10px',
	width: 'auto',
	transform: 'none'
};

/**
 * Can this browser lift an element into the top layer? Chromium and Firefox can
 * (`popover`), and the panel needs that: it has to be *inside* the dialog in the
 * DOM for the focus trap to allow the field to hold the caret, and *drawn* at
 * the bottom of the window like everywhere else — drawn as the dialog's footer
 * instead, it covers the very rows the person is pointing at.
 */
const CAN_TOP_LAYER = typeof HTMLElement.prototype.showPopover === 'function';

const blob = document.createElement('div');
blob.setAttribute('data-vite-feedback', 'blob');
Object.assign(blob.style, BLOB_LOOK, BLOB_ON_PAGE);

blob.innerHTML = `
	<div data-vite-feedback="field" style="position:relative">
		<div data-vite-feedback="input" contenteditable="true" role="textbox" aria-label="Describe the change"
			style="min-height:22px;max-height:140px;overflow-y:auto;outline:none;white-space:pre-wrap;word-break:break-word"></div>
		<div data-vite-feedback="placeholder"
			style="position:absolute;top:0;left:0;color:#52525b;pointer-events:none">Describe the change — hold alt and click an element to point at it</div>
	</div>
	<div style="display:flex;align-items:center;gap:8px">
		<span data-vite-feedback="status" style="flex:1;min-width:0;font-size:11px;color:#a1a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
		<select data-vite-feedback="target" aria-label="Send to which agent"
			title="Which agent this note goes to — the focused one when this is empty"
			style="flex:none;max-width:150px;background:#18181b;color:#a1a1aa;border:1px solid #2f2f36;border-radius:6px;font:inherit;font-size:11px;padding:2px 4px;cursor:pointer"></select>
		<button data-vite-feedback="clear" type="button" aria-label="Clear"
			style="background:transparent;border:0;color:#71717a;font:inherit;font-size:11px;cursor:pointer;padding:2px 4px">Clear</button>
		<button data-vite-feedback="close" type="button" aria-label="Close"
			style="width:22px;height:22px;flex:none;display:flex;align-items:center;justify-content:center;background:transparent;border:0;color:#71717a;font:400 14px/1 system-ui,sans-serif;cursor:pointer;padding:0">✕</button>
		<button data-vite-feedback="send" type="button" aria-label="Send"
			style="width:26px;height:26px;flex:none;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#09090b;border:0;border-radius:999px;font:600 14px/1 system-ui,sans-serif;cursor:pointer">↑</button>
	</div>`;

// The launcher: the way back to a walk that was closed and not thrown away.
// A circle at the bottom left, the shape the toolbar this borrows from wears,
// out of the way of the blob itself.
const launcher = document.createElement('button');
launcher.setAttribute('data-vite-feedback', 'launcher');
launcher.type = 'button';
launcher.setAttribute('aria-label', 'Open the feedback walk');
launcher.title = 'Feedback — hold alt and click an element to point at it';
Object.assign(launcher.style, {
	// Same reason as the blob: a modal sets `pointer-events: none` on the body.
	pointerEvents: 'auto',
	position: 'fixed',
	// The bottom right, which is where a launcher belongs and where it does not
	// cover what the page is about. Naming the corner means saying which two sides
	// are `auto`: the popover UA sheet declares `inset: 0`, so with only `bottom`
	// set the box is over-constrained, `top` wins, and the circle sits at the top
	// left of the viewport — which is exactly where it used to be.
	left: 'auto',
	top: 'auto',
	right: '20px',
	bottom: '20px',
	// The UA sheet's `margin: auto` would re-centre the circle over the corner
	// it was just pinned to.
	margin: '0',
	zIndex: '2147483647',
	width: '38px',
	height: '38px',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	background: '#131316',
	border: '1px solid #2f2f36',
	borderRadius: '999px',
	color: '#fafafa',
	boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
	cursor: 'pointer',
	padding: '0',
	font: '600 13px/1 system-ui, sans-serif'
});
launcher.innerHTML = `
	<span data-vite-feedback="count" style="display:none"></span>
	<svg data-vite-feedback="mark" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
		<circle cx="8" cy="8" r="4.25" stroke="currentColor" stroke-width="1.35"/>
		<path d="M8 0.6v3M8 12.4v3M0.6 8h3M12.4 8h3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
	</svg>`;

/** @type {HTMLElement} */
const input = /** @type {any} */ (blob.querySelector('[data-vite-feedback="input"]'));
/** @type {HTMLElement} */
const placeholder = /** @type {any} */ (blob.querySelector('[data-vite-feedback="placeholder"]'));
/** @type {HTMLElement} */
const status = /** @type {any} */ (blob.querySelector('[data-vite-feedback="status"]'));
/** @type {HTMLButtonElement} */
const sendButton = /** @type {any} */ (blob.querySelector('[data-vite-feedback="send"]'));
/** @type {HTMLButtonElement} */
const clearButton = /** @type {any} */ (blob.querySelector('[data-vite-feedback="clear"]'));
/** @type {HTMLButtonElement} */
const closeButton = /** @type {any} */ (blob.querySelector('[data-vite-feedback="close"]'));
/** @type {HTMLElement} */
const launcherCount = /** @type {any} */ (launcher.querySelector('[data-vite-feedback="count"]'));
/** @type {HTMLElement} */
const launcherMark = /** @type {any} */ (launcher.querySelector('[data-vite-feedback="mark"]'));

/** @type {HTMLSelectElement} */
const targetSelect = /** @type {any} */ (blob.querySelector('[data-vite-feedback="target"]'));

// Which agent a note goes to. Empty is the focused pane, which is what this
// panel did before the picker existed and stays the default, so a person who
// never touches it behaves exactly as they did. A pane id is remembered
// because a feedback session sends several notes to the same agent, and
// re-picking the same one every time is the friction a target picker is meant
// to remove.
const LAST_TARGET = 'vite-feedback-target';
const START = '+';

/** @returns {string} */
function rememberedTarget() {
	try {
		return localStorage.getItem(LAST_TARGET) ?? '';
	} catch {
		// A private window has no localStorage. The picker still works for this
		// note; it just forgets, which is better than a panel that will not open.
		return '';
	}
}

/** @param {string} pane */
function rememberTarget(pane) {
	try {
		if (pane) localStorage.setItem(LAST_TARGET, pane);
		else localStorage.removeItem(LAST_TARGET);
	} catch {
		/* nothing to do: see rememberedTarget */
	}
}

/** What a note should carry: a pane id, or nothing to mean the focused one. */
function chosenTarget() {
	const value = targetSelect.value;
	// A start request is a verb, not a destination — by the time send runs the
	// value is a real pane, so anything still prefixed is not a target.
	return value.startsWith(START) ? '' : value;
}

/** Fills the picker with what is running, plus a way to start something new.
 *  The list is only fetched when the panel is opened, because it costs a
 *  process spawn on the other end and a person sending a note is not asking
 *  for a census of their panes. */
/** An option, built through the document rather than the `Option` global: a
 *  page sandbox is not guaranteed to expose that constructor, and a picker that
 *  cannot render its own options is a picker that does not exist. */
function option(label, value) {
	const made = document.createElement('option');
	made.textContent = label;
	made.value = value;
	return made;
}

async function loadTargets(ensure = null) {
	let found;
	try {
		const response = await fetch('/__vite-feedback/agents');
		if (!response.ok) throw new Error(String(response.status));
		found = await response.json();
	} catch {
		// The picker is an addition, not a gate: a bridge that is not running
		// leaves the one option that always works.
		targetSelect.replaceChildren(option('focused agent', ''));
		return;
	}
	const agents = Array.isArray(found?.agents) ? found.agents : [];
	const free = Array.isArray(found?.free) ? found.free : [];
	const kinds = Array.isArray(found?.kinds) ? found.kinds : [];
	const options = [option('focused agent', '')];
	for (const one of agents) {
		// The kind is what "any kind of agent" means, and it is shown even when a
		// name exists, because the name says which session and the kind says
		// which program.
		const who = one.name ? `${one.name} · ${one.kind}` : `${one.kind} · ${one.pane}`;
		options.push(option(one.focused ? `${who} (focused)` : who, one.pane));
	}
	// A pane this panel just started an agent in is added even when the census
	// does not list it yet. The census is read a moment after the start, so a
	// newly started agent is exactly the one that may be missing — and
	// assigning a value a select does not offer silently yields '', which would
	// throw away the choice the person just made.
	if (ensure?.pane && !options.some((one) => one.value === ensure.pane)) {
		options.push(option(ensure.name ? `${ensure.name} · ${ensure.kind}` : `${ensure.kind} · ${ensure.pane}`, ensure.pane));
	}
	// Only offered when there is somewhere to start one: herdr needs an idle
	// pane, and a start that cannot happen is not a choice worth showing.
	if (free.length > 0) {
		const group = document.createElement('optgroup');
		group.label = 'start new';
		for (const kind of kinds) group.append(option(kind, `${START}${kind}`));
		targetSelect.replaceChildren(...options, group);
	} else {
		targetSelect.replaceChildren(...options);
	}
	const remembered = rememberedTarget();
	// A remembered pane that has since gone is not re-selected: a select whose
	// value is not among its options would silently mean something else.
	if (remembered && options.some((one) => one.value === remembered)) targetSelect.value = remembered;
}

async function startAgent(kind) {
	targetSelect.disabled = true;
	hint(`starting ${kind}…`);
	try {
		const response = await fetch('/__vite-feedback/agent', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind })
		});
		const answer = await response.json().catch(() => ({}));
		if (!response.ok || !answer?.started) {
			hint(String(answer?.reason ?? `could not start ${kind}`).slice(0, 90));
			await loadTargets();
			return;
		}
		await loadTargets(answer);
		targetSelect.value = answer.pane;
		rememberTarget(answer.pane);
		hint(`${answer.name} is ready`);
	} catch (cause) {
		hint(`could not start ${kind}: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 90));
	} finally {
		targetSelect.disabled = false;
	}
}

document.body.append(outline, label, blob, launcher);

let armed = false;
/** Whether the panel is showing. Kept here rather than read back from the
 * style, because a placement change must not be mistaken for a close. */
let panelOpen = false;
/** @type {HTMLElement | null} */
let host = null;
/** @type {HTMLElement | null} */
let hostStyled = null;
/** @type {MutationObserver | null} */
let hostWatch = null;

/** The dialog that owns the keyboard, if one is open: the topmost, and one that
 * is actually drawn — a hidden leftover from an earlier open is not an owner.
 * @returns {HTMLElement | null} */
function visibleDialog() {
	const candidates = /** @type {HTMLElement[]} */ ([
		...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]'),
	]);
	return candidates.filter((node) => node.getClientRects().length > 0).at(-1) ?? null;
}

/**
 * Put nodes in the top layer, or take them out of it.
 *
 * The attribute is added and removed rather than toggled: a closed popover is
 * `display: none` from the UA sheet, and an inline `display` would beat that and
 * leave the node drawn while it is shut.
 *
 * @param {HTMLElement[]} nodes
 * @param {boolean} lifted
 */
function topLayer(nodes, lifted) {
	for (const node of nodes) {
		if (!CAN_TOP_LAYER) continue;
		if (lifted) {
			if (!node.hasAttribute('popover')) node.setAttribute('popover', 'manual');
			if (!node.matches(':popover-open')) node.showPopover();
		} else if (node.hasAttribute('popover')) {
			if (node.matches(':popover-open')) node.hidePopover();
			node.removeAttribute('popover');
		}
	}
}

/**
 * Where the overlay lives: inside the dialog that owns the keyboard, or at the
 * bottom of the viewport when no dialog does.
 *
 * This is the whole reason the panel moves. A modal focus trap cannot be beaten
 * from outside — re-asserting focus on every frame loses, because the trap
 * re-asserts on every focusin — so a field outside the dialog can never take the
 * caret, and a person pointing at a palette row is left typing into the palette's
 * own search box.
 *
 * Being in the dialog's DOM is what buys the caret; the top layer is what stops
 * it from being drawn as the dialog's footer, over the rows being pointed at.
 * Where the top layer is unavailable it falls back to being that footer, which
 * is still better than a field nobody can type in.
 */
function resync() {
	const next = visibleDialog() ?? document.body;
	if (host === next) return;
	if (hostStyled) {
		hostStyled.style.position = '';
		hostStyled = null;
	}
	hostWatch?.disconnect();
	hostWatch = null;
	host = next;
	next.append(outline, label, blob, launcher);

	// Lifted whenever the browser can, and for the launcher as well as the blob:
	// a circle a modal covers is a tool that cannot be brought back. It used to
	// be lifted only inside a dialog, on the reasoning that a dialog is the one
	// thing that beats a maximum z-index — but an ancestor with a transform or a
	// filter caps it just as effectively, and the top layer is painted above
	// every z-index that will ever be written.
	topLayer([outline, label, blob, launcher], true);
	if (next === document.body) {
		Object.assign(blob.style, BLOB_ON_PAGE);
		reapply(blob);
		reapply(launcher);
		launcher.style.display = panelOpen ? 'none' : 'flex';
		return;
	}
	// A static ancestor would not be the containing block for an absolutely
	// placed child, and the fallback panel would land somewhere arbitrary.
	if (!CAN_TOP_LAYER && getComputedStyle(next).position === 'static') {
		hostStyled = next;
		next.style.position = 'relative';
	}
	Object.assign(blob.style, CAN_TOP_LAYER ? BLOB_ON_PAGE : BLOB_IN_DIALOG);
	// The default layout above is absolute; without this, a blob that was dragged
	// somewhere snaps back to the bottom edge the first time the panel opens.
	reapply(blob);
	reapply(launcher);
	launcher.style.display = 'none';
	// The dialog is removed from its parent when it closes, and the overlay goes
	// with it — so the removal is what sends the panel home.
	hostWatch = new MutationObserver(() => {
		if (!next.isConnected) resync();
	});
	hostWatch.observe(next.parentElement ?? document.body, { childList: true });
}

/**
 * Every listener this overlay adds, so a second mount can take the first one
 * down. Vite reloads this module on every edit, and a project can both have the
 * plugin inject the client and import it itself: without this, each mount
 * leaves its own outline, label and blob on the page, and one pick drops a chip
 * in every blob at once.
 *
 * The event is generic rather than `EventListener` so a handler reads the
 * event it was given — a `keydown` callback is handed a `KeyboardEvent` and can
 * ask for `key` without a cast at every call site.
 *
 * @template {Event} E
 * @param {EventTarget} target
 * @param {string} type
 * @param {(event: E) => void} handler
 * @param {boolean} [capture]
 */
function on(target, type, handler, capture = false) {
	const listener = /** @type {EventListener} */ (handler);
	target.addEventListener(type, listener, capture);
	attached.push(() => target.removeEventListener(type, listener, capture));
}
/** @type {(() => void)[]} */
const attached = [];

function dispose() {
	clearTimeout(timer);
	hostWatch?.disconnect();
	if (hostStyled) hostStyled.style.position = '';
	for (const detach of attached) detach();
	// Out of the top layer before out of the document: a popover that is still
	// open is still drawn, wherever its element happens to be.
	topLayer([outline, label, blob, launcher], false);
	for (const node of [outline, label, blob, launcher]) node.remove();
}

// The previous mount, if there is one, goes first: its listeners are on the
// document and the window, where replacing the DOM would not have silenced them.
blob.addEventListener('vite-feedback:unmount', dispose);
keepEventsLocal(blob);
keepEventsLocal(launcher);
// One key per surface. A shared one meant the last surface dragged silently
// moved the other on the next load, and the launcher is the only one on screen
// while the panel is shut, so it always won.
const WHERE_KEY = 'vite-feedback-where';
/** The last place a surface was explicitly put, so the default layout that
 *  resync() re-applies cannot throw it away on the next open or close. */
const placed = new WeakMap();

/** @param {HTMLElement} surface */
const whereKey = (surface) => `${WHERE_KEY}-${surface.getAttribute('data-vite-feedback')}`;

makeDraggable(blob);
makeDraggable(launcher);
restorePlace(blob);
restorePlace(launcher);

// The blob, at the bottom of everything, and its field — the document a person
// is writing. It is built before the document is read, so the reading can be
// the only description of the state.
on(input, 'input', () => {
	renumber();
	saveDocument();
	showPlaceholder();
});

/** @param {HTMLElement} node */
function hide(node) {
	node.style.display = 'none';
}

/**
 * The blob is opened by a pick or by the launcher, never by the modifier alone:
 * holding alt is pointing, and chrome that appeared the moment alt went down
 * would cover the thing being pointed at. Closed is a state with a way back, so
 * it is remembered — a walk closed on one page must not reopen itself on the
 * next, and a walk left open must not hide because the page changed.
 */
function open() {
	resync();
	blob.style.display = 'flex';
	panelOpen = true;
	hide(launcher);
	showPlaceholder();
	savePanel(true);
	// Refused, not awaited: the panel is already open and a slow census must
	// not hold up typing a note into it.
	void loadTargets();
}

on(targetSelect, 'change', () => {
	const value = targetSelect.value;
	if (value.startsWith(START)) void startAgent(value.slice(START.length));
	else rememberTarget(value);
});

function close() {
	// The caret leaves with the blob: a hidden field that still has focus
	// swallows every keystroke meant for the page.
	const focused = document.activeElement;
	if (focused instanceof HTMLElement && blob.contains(focused)) focused.blur();
	hide(blob);
	panelOpen = false;
	resync();
	// The circle belongs to the page, not to a dialog: inside one there is no
	// room for chrome the dialog did not ask for, and the way back arrives with
	// the dialog's own close.
	if (host === document.body) launcher.style.display = 'flex';
	savePanel(false);
}

/** @param {string} text */
function hint(text) {
	status.textContent = text;
	clearTimeout(timer);
	timer = /** @type {any} */ (setTimeout(() => (status.textContent = ''), 6000));
}
/** @type {any} */
let timer = null;

function arm() {
	if (armed) return;
	armed = true;
	document.body.style.cursor = 'crosshair';
}

function disarm() {
	armed = false;
	document.body.style.cursor = '';
	hide(outline);
	hide(label);
}

/**
 * @param {Element} node
 * @param {DOMRect} rect
 */
function show(node, rect) {
	Object.assign(outline.style, {
		display: 'block',
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`
	});
	const at = locate(node);
	label.textContent = at ? `${at.file}:${at.line}` : describe(node);
	Object.assign(label.style, {
		display: 'block',
		left: `${Math.max(4, rect.left)}px`,
		top: `${Math.max(4, rect.top - 20)}px`
	});
}

// The overlay's own DOM is not the page: a click in the blob's input is a click
// in the input, and treating it as a pick would drop a chip on the textarea and
// put the caret somewhere else. Everything the overlay draws is off limits to
// the picker.
/** @param {EventTarget | null} node */
const isOwnDom = (node) => node instanceof Node && (blob.contains(node) || launcher.contains(node));

// Holding the modifier is pick mode: while it is down the page is inert, so
// every element is a target. A control is not exempt — the thing a person
// wants to point at is usually a button or a link, and a picker that refuses
// exactly those is a picker that does nothing on a screen made of them.
//
// A modal dialog is not a refusal either: the panel moves inside it, which is
// what lets the field be typed into while the dialog owns the keyboard. See
// `resync`.

/**
 * A refusal is said out loud, on the label — the surface the person is already
 * watching while they hold the modifier. A modified click that comes to nothing
 * is indistinguishable from a tool that is broken, and the two causes (a
 * modifier the window manager never let through, a page that has taken the
 * keyboard) need opposite responses from the person.
 *
 * @param {Element} node
 * @param {string} text
 */
function say(node, text) {
	const rect = node.getBoundingClientRect();
	label.textContent = text;
	Object.assign(label.style, {
		display: 'block',
		left: `${Math.max(4, Math.min(rect.left, window.innerWidth - 260))}px`,
		top: `${Math.max(4, rect.top - 20)}px`
	});
	hide(outline);
}

// ————— the document ————————————————————————————————————————————————
//
// A chip is a place in the code; the words around it are what to do there. The
// JSON type is what the server reads; the page below is what the person writes,
// and the second is derived from the first every time a chip is dropped.

/**
 * A place in the walk. Either the code that made it — `file` and `line`, which
 * the server resolves and quotes — or, when nothing in the subtree is the app's
 * own, `context`: the element itself, described. Never both, never neither.
 *
 * @typedef {{file?: string, line?: number, url: string, note: string, render?: string, context: string}} Picked
 * @typedef {{request: string, items: Picked[]}} Document
 */

/**
 * The element itself, for a place the code search could not name: a row drawn
 * entirely by a dependency, or a framework that records no source locations at
 * all. This is what a screen-scraping toolbar would have sent all along — tag,
 * id, classes, the attributes that identify it, its text, where it sits in the
 * tree, how big it is — except here it rides with the chips, in the walk, beside
 * the words the person wrote about it.
 *
 * @param {Element} node
 * @param {{file: string, line: number} | null} at
 * @returns {string}
 */
function contextOf(node, at) {
	const tag = node.tagName.toLowerCase();
	const id = node.id ? `#${node.id}` : '';
	const classes = chosenClasses(node, 3);
	const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
	const attributes = [...node.attributes]
		.filter((one) => /^(data-|role$|aria-|name$|type$|href$|value$|placeholder$|alt$)/.test(one.name))
		.slice(0, 6)
		.map((one) => `${one.name}=${one.value.slice(0, 32)}`)
		.join(' ');
	const trail = [];
	for (
		let el = /** @type {Element | null} */ (node),
			depth = 0;
		el && el !== document.body && depth < 5;
		el = el.parentElement, depth += 1
	) {
		trail.unshift(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + chosenClasses(el, 1));
	}
	return [
		`${tag}${id}${classes}${text ? ` "${text}"` : ''}`,
		attributes,
		`path: ${trail.join(' > ')}`,
		// What the browser made of it. A place with no source of its own has nothing
		// but this to be measured against.
		factsOf(node).all,
		// What the search did find, even when it was a dependency: the drawer this
		// element was rendered into is worth knowing.
		at ? `from: ${shorten(at.file)}:${at.line}` : null
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Computed properties worth arguing about, and only the ones that are actually
 * set: a `div` with nothing on it says nothing, and a wall of defaults is noise
 * where the finding should be.
 *
 * This is the half of the truth the source cannot give. A class says `max-w-
 * [85%]`, a media query or a parent decides the rest, and the review that argues
 * "this is 4px off" needs the number the browser actually used.
 *
 * @param {Element} node
 * @returns {{box: string, layout: string, paint: string, text: string, all: string, brief: string}}
 */
function factsOf(node) {
	const style = getComputedStyle(node);
	// `shortenCss` can decide a value says nothing — `0px none …` is a border
	// nobody drew — so an entry is only reported when something is left of it.
	const of = (/** @type {string[]} */ names) =>
		names
			.map((name) => [name, style.getPropertyValue(name).trim()])
			.filter(([, value]) => value && !DEFAULT_LIKE.has(value))
			.map(([name, value]) => `${name} ${shortenCss(value)}`.trimEnd())
			.filter((line) => !line.endsWith(' '));
	const rect = node.getBoundingClientRect();
	const box = [`${Math.round(rect.width)}×${Math.round(rect.height)} at ${Math.round(rect.left)},${Math.round(rect.top)}`]
		.concat(of(['display', 'position', 'z-index', 'overflow', 'transform', 'opacity']))
		.join(' · ');
	const layout = of([
		'flex-direction',
		'flex-wrap',
		'align-items',
		'justify-content',
		'grid-template-columns',
		'gap',
		'padding',
		'margin',
		'border-radius'
	]).join(' · ');
	// A border is only worth a line when there is one: the computed shorthand for
	// an element without is `0px none <colour>`, which is noise wearing a value.
	const border = style.getPropertyValue('border-top-width').trim() === '0px' ? '' : of(['border']);
	const paint = of(['color', 'background-color', 'box-shadow', 'backdrop-filter', 'fill'])
		.concat(border)
		.filter(Boolean)
		.join(' · ');
	const hasWords = (node.textContent ?? '').trim() !== '';
	const text = hasWords
		? of(['font-size', 'line-height', 'font-weight', 'font-family', 'letter-spacing', 'text-transform', 'text-overflow', 'white-space']).join(' · ')
		: '';
	const sizes = of(['width', 'height', 'min-height', 'max-height', 'min-width', 'max-width']).join(' · ');
	return {
		box,
		layout,
		paint,
		text,
		// The whole thing for a place with no source of its own, one line for a place
		// whose code is already in the message.
		all: [box, sizes, layout, paint, text].filter(Boolean).join('\n'),
		brief: [box, paint, text].filter(Boolean).join(' · ')
	};
}

/**
 * Computed values are verbose by nature — `rgb(250, 250, 250)` where `#fafafa`
 * says it — and a message is read by a person and by a budget.
 *
 * @param {string} value
 * @returns {string}
 */
function shortenCss(value) {
	if (value.startsWith('rgb')) {
		// `rgb(250, 250, 250)` is four words a person reads slower than `#fafafa`,
		// and an alpha is a fourth byte, not a fourth word.
		const [r = '0', g = '0', b = '0', a] = value
			.replace(/rgba?\(|\)/g, '')
			.split(',')
			.map((part) => part.trim());
		const hex = `#${[r, g, b].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
		return a === undefined || Number(a) === 1 ? hex : `${hex}/${a}`;
	}
	// A compound that starts at zero is a property nobody set: `0px none …`,
	// `0px 0px 0px 0px`.
	if (/^0(px|%)?\b/.test(value)) return '';
	return value.length > 40 ? `${value.slice(0, 39)}…` : value;
}

const DEFAULT_LIKE = new Set([
	'none',
	'normal',
	'auto',
	'0px',
	'0s',
	'1',
	'static',
	'visible',
	'clip',
	'baseline',
	'start',
	'wrap',
	'transparent',
	'rgba(0, 0, 0, 0)'
]);

/**
 * The classes a person chose, not the ones a tool generated: Svelte's scope
 * hashes and cmdk's structural markers are noise in a description somebody has
 * to read, and there were twenty of them where there should be three.
 *
 * @param {Element} node
 * @param {number} limit
 * @returns {string}
 */
function chosenClasses(node, limit) {
	const kept = [...node.classList].filter(
		(one) => !one.startsWith('svelte-') && !one.includes('**:[[')
	);
	return kept.length > 0 ? `.${kept.slice(0, limit).join('.')}` : '';
}
/**
 * What a chip says. A place in the code says where; a place the code search
 * could not name says what it is. Read from the description, because a chip has
 * to survive a reload, and the first line of that description is written for it:
 * tag, id, classes, then the text in quotes.
 *
 * The words win over the classes. A palette row is `div.data-selected:text-
 * foreground.…` to a parser and `project-one — main` to a person, and the chip is
 * read by a person.
 *
 * @param {Picked} item
 * @returns {string}
 */
function chipLabel(item) {
	if ('file' in item && item.file) return `${shorten(item.file)}:${item.line}`;
	const [first = ''] = ('context' in item ? item.context : '').split('\n');
	const parts = first.match(/^([a-z0-9-]+)(#[^\s.]*)?((?:\.[^\s"]+)*)(?:\s+"([^"]*)")?$/i);
	if (!parts) return first.length > 44 ? `${first.slice(0, 43)}…` : first;
	const [, tag, id = '', classes = '', text = ''] = parts;
	// No words to go by, so the classes are what identifies it.
	const label = text ? `${tag} "${text}"` : `${tag}${id}${classes}`;
	return label.length > 44 ? `${label.slice(0, 43)}…` : label;
}

const DOCUMENT_KEY = 'vite-plugin-feedback:document';
const PANEL_KEY = 'vite-plugin-feedback:panel';

/** @param {boolean} isOpen */
function savePanel(isOpen) {
	try {
		sessionStorage.setItem(PANEL_KEY, isOpen ? 'open' : 'closed');
	} catch {
		// A full or blocked store is a lost preference, not a broken page.
	}
}

/** @returns {boolean} */
function loadPanel() {
	try {
		return sessionStorage.getItem(PANEL_KEY) === 'open';
	} catch {
		return false;
	}
}

/**
 * What the person is looking at, as the server wants it: the words before the
 * first chip, then each chip with the words that follow it. One walk, so the
 * request and the notes can never disagree about where a chip sits.
 *
 * @returns {Document}
 */
function readDocument() {
	/** @type {Picked[]} */
	const items = [];
	// The words between two chips belong to the chip before them; only what
	// comes before the first chip is the request itself.
	let request = '';
	/** @type {Picked | null} */
	let current = null;
	/** @param {Node} node */
	const walk = (node) => {
		for (const child of node.childNodes) {
			if (child.nodeType === 3) {
				const text = child.textContent ?? '';
				if (current) current.note += text;
				else request += text;
				continue;
			}
			if (child.nodeName === 'BR') {
				if (current) current.note += '\n';
				else request += '\n';
				continue;
			}
			const element = /** @type {HTMLElement} */ (child);
			if (element.dataset?.viteFeedback === 'chip') {
				// A chip says where it is in one of two ways, and the document has
				// to be told which: a file and a line the server can read, plus the
				// one line of computed truth that says what the browser made of it —
				// or the element itself, for a place no line in the app accounts for.
				// Rebuilt from what the chip carries, which is the location when the
				// search found one and the element either way.
				current = {
					url: String(element.dataset.url),
					note: '',
					context: String(element.dataset.context ?? ''),
					...(element.dataset.file
						? {
								file: String(element.dataset.file),
								line: Number(element.dataset.line),
								render: element.dataset.render ? String(element.dataset.render) : undefined
							}
						: {})
				};
				items.push(current);
				continue;
			}
			walk(child);
		}
	};
	walk(input);
	return {
		request: request.trim(),
		items: items.map((item) => ({ ...item, note: item.note.trim() }))
	};
}

/** @param {Document} doc */
function render(doc) {
	input.textContent = '';
	if (doc.request) input.append(doc.request);
	for (const item of doc.items) {
		const chip = chipFor(item);
		input.append(chip);
		if (item.note) input.append(item.note);
		input.append(' ');
	}
	renumber();
	showPlaceholder();
}

/**
 * @param {Picked} item
 * @returns {HTMLElement}
 */
function chipFor(item) {
	const chip = document.createElement('span');
	chip.setAttribute('data-vite-feedback', 'chip');
	chip.setAttribute('contenteditable', 'false');
	chip.dataset.url = item.url;
	chip.dataset.label = chipLabel(item);
	// Both halves ride with the chip, because a chip has to survive a reload and
	// the walk is only as good as what it can rebuild.
	// `?? ''` rather than a bare assignment: the dataset map stringifies what it
	// is given, so one missing description would reach the agent as the literal
	// word "undefined" inside a context block.
	chip.dataset.context = item.context ?? '';
	if (item.file && item.line) {
		chip.dataset.file = item.file;
		chip.dataset.line = String(item.line);
		chip.title = `${item.file}:${item.line} · ${item.url}\n${item.render ?? item.context}`;
	} else {
		chip.title = `${item.context}\n${item.url}`;
	}
	if (item.render) chip.dataset.render = item.render;
	Object.assign(chip.style, {
		display: 'inline-flex',
		alignItems: 'center',
		margin: '0 2px',
		padding: '1px 6px',
		borderRadius: '6px',
		background: '#27272a',
		border: '1px solid #3f3f46',
		color: '#d4d4d8',
		font: '11px/1.6 ui-monospace, monospace',
		whiteSpace: 'nowrap',
		verticalAlign: 'baseline'
	});
	return chip;
}

/**
 * A path inside `node_modules` is a maze — `.bun/bits-ui@2.19.3+2a168…/…`. The
 * name a reader needs is the package and the file: that a subtree is drawn by a
 * dependency is the reason there is no app line to point at, and a chip that
 * said `command-item.svelte` alone would read as the app's own.
 *
 * @param {string} file
 * @returns {string}
 */
function shorten(file) {
	const base = file.split('/').pop() ?? file;
	// `node_modules/.bun/<name>@<version>+<hash>/…` is bun's layout; the name is
	// everything before the version, and a scoped name keeps its scope.
	const pkg = file
		.match(/node_modules\/(?:\.bun\/)?((?:@[^/]+\/)?[^/]+)/)?.[1]
		?.replace(/@[^/]*$/, '');
	return pkg ? `${pkg}/${base}` : file.split('/').slice(-2).join('/');
}

/** The chip's label is only ever its place in the walk: renumbering after a
 * deletion is what keeps `1 · 2 · 3` a fact rather than a memory. The launcher
 * wears the same count, so a closed blob still says how much of the walk is
 * waiting. */
function renumber() {
	const chips = /** @type {HTMLElement[]} */ ([...input.querySelectorAll('[data-vite-feedback="chip"]')]);
	chips.forEach((chip, index) => {
		chip.dataset.index = String(index + 1);
		chip.textContent = `${index + 1} · ${chip.dataset.label}`;
	});
	launcherCount.textContent = chips.length > 0 ? String(chips.length) : '';
	launcherCount.style.display = chips.length > 0 ? 'block' : 'none';
	launcherMark.style.display = chips.length > 0 ? 'none' : 'block';
	launcher.title = chips.length
		? `Feedback — ${chips.length} element${chips.length === 1 ? '' : 's'} picked`
		: 'Feedback — hold alt and click an element to point at it';
}

function showPlaceholder() {
	const empty = input.textContent.trim() === '' && input.querySelector('[data-vite-feedback="chip"]') === null;
	placeholder.style.display = empty ? 'block' : 'none';
}

function saveDocument() {
	try {
		sessionStorage.setItem(DOCUMENT_KEY, JSON.stringify(readDocument()));
	} catch {
		// A full or blocked store is a lost walk, not a broken page.
	}
}

/** @returns {Document} */
function loadDocument() {
	try {
		const raw = sessionStorage.getItem(DOCUMENT_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed || !Array.isArray(parsed.items)) return { request: '', items: [] };
		return {
			request: typeof parsed.request === 'string' ? parsed.request : '',
			items: parsed.items.filter(
				(/** @type {any} */ item) =>
					(item?.file && Number.isInteger(item?.line)) ||
					(typeof item?.context === 'string' && item.context.trim() !== '')
			)
		};
	} catch {
		return { request: '', items: [] };
	}
}

/**
 * Put the picked place at the end of the walk, and the caret after it so the
 * next thing typed is that element's note.
 *
 * At the end rather than at the caret, because the walk is an ordered list of
 * places and a pick is its next entry: inserting wherever the caret happened to
 * be left makes the numbering depend on an invisible cursor, which is how a chip
 * ends up numbered 3 while reading second.
 *
 * @param {{file?: string, line?: number, context?: string}} place
 * @param {Element} node the element itself, for what the browser made of it
 */
function addPick(place, node) {
	const url = `${location.pathname}${location.search}`;
	const chip = chipFor({
		url,
		note: '',
		// What the browser made of it, always: a class is a claim and this is the
		// measurement, and a review that says "4px off" is arguing about the
		// measurement rather than about the class.
		context: /** @type {string} */ (place.context),
		...(place.file ? { file: place.file, line: /** @type {number} */ (place.line), render: factsOf(node).brief } : {})
	});
	// A space before the chip when the words before it ran up against it: a note
	// and the next chip must not read as one sentence, which is what makes
	// `note for 12 · AppSidebar.svelte` out of two separate things.
	if (input.textContent && !/\s$/.test(input.textContent)) input.append(document.createTextNode(' '));
	input.append(chip, document.createTextNode(' '));
	focusEnd();
	renumber();
	showPlaceholder();
	saveDocument();
}

function focusEnd() {
	input.focus();
	const selection = window.getSelection?.();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(input);
	range.collapse(false);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** Insert plain text at the caret, so a paste cannot bring the page's markup
 * into the field the plugin reads. @param {string} text */
function insertText(text) {
	const selection = window.getSelection?.();
	const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
	if (!range || !input.contains(range.startContainer) || !selection) {
		input.append(document.createTextNode(text));
		focusEnd();
		return;
	}
	const node = document.createTextNode(text);
	range.deleteContents();
	range.insertNode(node);
	const caret = document.createRange();
	caret.setStartAfter(node);
	caret.collapse(true);
	selection.removeAllRanges();
	selection.addRange(caret);
}

// The wire format, named. The server stamps every answer with it, and a refusal
// without a stamp means the answer came from a different build of this plugin —
// which, for a Vite plugin, means the dev server has to be restarted.
const PROTOCOL = 'vite-plugin-feedback/2';

async function send() {
	const doc = readDocument();
	if (doc.items.length === 0) {
		hint('point at an element first — hold alt and click one');
		return;
	}
	if (!doc.request && doc.items.every((item) => item.note === '')) {
		hint('say what should change');
		return;
	}
	sendButton.disabled = true;
	hint('sending…');
	try {
		const response = await fetch('/__vite-feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// Absent rather than empty when nothing is chosen: the far end reads an
			// absent target as "the focused one", which is the old behaviour, while
			// an empty string would be a pane id that does not exist.
			body: JSON.stringify({ ...doc, plugin: PROTOCOL, target: chosenTarget() || undefined })
		});
		const answer = await response.text();
		if (!response.ok) {
			// A refusal from a server that does not stamp its answer is a server
			// running a different version of this plugin — and a Vite plugin is read
			// when the dev server starts, so no reload will ever fix it. Said here,
			// because the alternative is a rule the page follows that the server has
			// never heard of, reported as if it were the walk's fault.
			if (!response.headers.get('x-vite-feedback')) {
				hint('this dev server is running an older build of the plugin — restart it');
				return;
			}
			hint(answer.slice(0, 120) || `the dev server said ${response.status}`);
			return;
		}
		const sent = doc.items.length;
		clear();
		hint(`sent — ${sent} element${sent === 1 ? '' : 's'}`);
	} catch (cause) {
		hint(`could not reach the dev server: ${cause instanceof Error ? cause.message : String(cause)}`);
	} finally {
		sendButton.disabled = false;
	}
}

function clear() {
	input.textContent = '';
	renumber();
	saveDocument();
	showPlaceholder();
}

on(clearButton, 'click', clear);
on(closeButton, 'click', close);
// The way back in: the circle opens the walk that was closed, and puts the
// caret in the field so the next thing typed is a note, not a hunt.
on(launcher, 'click', () => {
	open();
	focusEnd();
});
on(sendButton, 'click', () => void send());

// Enter sends and Shift+Enter is a newline: one prompt, one send, the shape the
// toolbar this borrows from has.
on(input, 'keydown', (/** @type {KeyboardEvent} */ event) => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		void send();
	}
});

on(input, 'paste', (/** @type {ClipboardEvent} */ event) => {
	event.preventDefault();
	const text = event.clipboardData?.getData('text/plain') ?? '';
	if (text) insertText(text);
});

// The blob is a guest in someone else's page. Every open surface underneath it
// watches for a press or a key that lands outside itself, and our DOM is
// outside — so a popover would close the moment a person clicked the field. The
// listener is on the way *up* from the field: late enough that the field still
// receives the event, early enough that the page never does.
//
// The modifier keys and Escape are the exceptions. Arming the picker is a
// listener on the window, and a pick leaves the caret in the field — so a field
// that swallowed `alt` would leave the picker unable to arm itself for the very
// next pick, and the person holding alt would be told the page never saw it
// press. Escape is the platform's "close the thing on top": trapping it in the
// panel left a dialog that the panel lives in with no way out but the mouse.
/** @param {HTMLElement} surface */
function keepEventsLocal(surface) {
	for (const type of ['mousedown', 'pointerdown', 'click']) {
		on(surface, type, (event) => event.stopPropagation());
	}
	for (const type of ['keydown', 'keyup']) {
		on(surface, type, (/** @type {KeyboardEvent} */ event) => {
			if (isModifier(event) || event.key === 'Escape') return;
			event.stopPropagation();
		});
	}
}

// While the modifier is held the page is not to act on the gesture. One list,
// one handler, one loop: the guarantee is then exactly as total as that list,
// rather than as total as somebody remembered to add the next event type
// somewhere else. `mousedown` and `click` are deliberately NOT here — the
// picker's own capture handlers own those two, because it has to SEE them to
// turn them into a pick, and a window-level capture that swallowed them first
// would break picking outright. Everything a page can act on besides the pick
// is listed, including the ones only a framework or a touch screen sends.
const ISOLATE_WHILE_ARMED = [
	'pointerdown', 'pointerup', 'mouseup', 'dblclick', 'contextmenu', 'wheel',
	'touchstart', 'touchend', 'touchmove', 'keypress', 'keydown', 'keyup'
];

function isolateWhileArmed() {
	for (const type of ISOLATE_WHILE_ARMED) {
		on(
			window,
			type,
			(event) => {
				// Not armed is not picking, so every event is the app's own — which
				// is what still makes a plain click the app's.
				if (!armed) return;
				// The modifier's own press and release must keep working or the
				// overlay could never be put away, and Escape is how a person backs
				// out of a walk.
				if (type.startsWith('key') && (isModifier(event) || event.key === 'Escape')) return;
				// Our own chrome is exempt, or the picker could not be driven.
				if (event.target instanceof Node && isOwnDom(event.target)) return;
				event.preventDefault();
				event.stopPropagation();
			},
			true
		);
	}
}

// Dragging. The blob moves by its own chrome and never by a press that belongs
// to something inside it: the field needs its caret, the buttons need their
// clicks, and a chip has to stay deletable. Pointer events rather than mouse
// events so a finger drags it too, and one set of handlers rather than a
// mouse/touch pair that could disagree.
const NOT_A_HANDLE = 'input, button, select, textarea, a, [contenteditable="true"], [data-vite-feedback="chip"]';
/** How far a press may wander and still be a click. Below this it is a press
 *  on a control, above it the click the browser sends is part of a drag. */
const DRAG_SLOP = 4;
/** @param {HTMLElement} surface */
function makeDraggable(surface) {
	/** @type {{x: number, y: number, left: number, top: number, width: number, height: number} | null} */
	let from = null;
	/** Whether the current press moved far enough to be a drag and not a click. */
	let dragged = false;
	on(surface, 'pointerdown', (event) => {
		if (event.button !== 0) return;
		// Controls *inside* the panel are not handles. The surface itself always is:
		// the launcher is a <button>, so a bare `closest` match on the target
		// excluded the very surface the test was meant to protect, and the circle
		// could not be dragged anywhere at all.
		const handle = event.target instanceof Element ? event.target.closest(NOT_A_HANDLE) : null;
		if (handle && handle !== surface) return;
		// Reset per press, so a drag whose click never arrived cannot swallow the
		// next real one.
		dragged = false;
		const box = surface.getBoundingClientRect();
		from = { x: event.clientX, y: event.clientY, left: box.left, top: box.top, width: box.width, height: box.height };
		// Not every environment has it (JSDOM among them), and losing pointer
		// capture costs a drag that ends at the window edge, not a drag.
		surface.setPointerCapture?.(event.pointerId);
		surface.style.cursor = 'grabbing';
	});
	on(surface, 'pointermove', (event) => {
		if (!from) return;
		// A press that does not move is a click and the browser will send one. A
		// press that does move is a drag, and the click it drags out with must
		// not count: otherwise the circle cannot be moved without also opening the
		// panel it was being moved away from.
		if (Math.abs(event.clientX - from.x) > DRAG_SLOP || Math.abs(event.clientY - from.y) > DRAG_SLOP) dragged = true;
		// Clamped to the viewport, because a blob dragged off the edge is a blob
		// that cannot be dragged back. Sized from the box already read at the grab,
		// which is what is on screen rather than the untransformed layout width.
		const left = Math.min(Math.max(0, from.left + event.clientX - from.x), Math.max(0, window.innerWidth - from.width));
		const top = Math.min(Math.max(0, from.top + event.clientY - from.y), Math.max(0, window.innerHeight - from.height));
		place(surface, left, top);
	});
	const drop = () => {
		if (!from) return;
		from = null;
		surface.style.cursor = '';
		rememberPlace(surface);
	};
	on(surface, 'pointerup', drop);
	on(surface, 'pointercancel', drop);
	// Registered here so it runs before the click handlers below it: only
	// stopImmediatePropagation reaches the listeners added after this one, which
	// is what stops the circle's own "open the walk" from answering a drag.
	on(surface, 'click', (event) => {
		if (!dragged) return;
		dragged = false;
		event.preventDefault();
		event.stopImmediatePropagation();
	});
}

/** Pins a surface to a point, replacing the centred default. The blob sits at
 *  `left: 50%` with a translate until it is moved, and one that were both
 *  dragged and centred would jump by half its own width. */
function place(surface, left, top) {
	placed.set(surface, { left, top });
	Object.assign(surface.style, {
		left: `${left}px`,
		top: `${top}px`,
		right: 'auto',
		bottom: 'auto',
		transform: 'none'
	});
}

/** @param {HTMLElement} surface */
function reapply(surface) {
	const at = placed.get(surface);
	if (at) place(surface, at.left, at.top);
}

/** Remembers where it was left, so a surface dragged into a corner is still
 *  there after the reload. Measured with getBoundingClientRect, not offsetLeft:
 *  the centred default is `left: 50%` with `translateX(-50%)`, and offsetLeft is
 *  the untransformed layout offset — the middle of the viewport, not where the
 *  blob actually is. A private window has nowhere to put it, which is a lost
 *  convenience and not a broken panel.
 *  @param {HTMLElement} surface */
function rememberPlace(surface) {
	try {
		const box = surface.getBoundingClientRect();
		localStorage.setItem(whereKey(surface), JSON.stringify({ left: box.left, top: box.top }));
	} catch {
		/* nowhere to remember it; it stays where it was put */
	}
}

/** @param {HTMLElement} surface */
function restorePlace(surface) {
	try {
		const saved = JSON.parse(localStorage.getItem(whereKey(surface)) ?? 'null');
		if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) place(surface, saved.left, saved.top);
	} catch {
		/* nothing saved, or nothing readable saved */
	}
}

// Registered here rather than beside the mounts above, because it reads a const
// declared below them and a module body runs strictly top to bottom.
isolateWhileArmed();

on(
	document,
	'mousemove',
	(event) => {
		if (!armed) return;
		if (!(event.target instanceof Element) || isOwnDom(event.target)) return;
		show(event.target, event.target.getBoundingClientRect());
	},
	true
);

on(
	document,
	'click',
	(/** @type {MouseEvent} */ event) => {
		if (isOwnDom(event.target)) return;
		// A modified click is the one that means "this element"; a plain click
		// stays the app's own, exactly like the editor inspectors.
		if (!event.altKey && !event.ctrlKey && !event.metaKey) return;
		if (!(event.target instanceof Element)) return;
		// The modifier must have been seen *before* the click. A window manager
		// that keeps a key for itself (KWin's alt-drag, any WM grab) swallows the
		// keydown, and then the page's first and only sign of the modifier is a
		// click carrying one it never watched being pressed. Nothing else tells
		// those two situations apart, and they need opposite fixes.
		if (!armed) {
			say(event.target, 'hold the modifier down first — the page never saw it press');
			return;
		}
		// From here the person is picking, so the click is not the app's, whatever
		// comes of it: a refused pick that fell through would be a selection
		// attempt that quietly became a navigation.
		event.preventDefault();
		event.stopPropagation();
		// Nothing under the cursor is exempt: a pick that skips buttons is a pick
		// that skips the thing being reviewed, and the press that picks one never
		// reaches the page (see the mousedown listener) — so a control cannot act
		// and then be chipped on the way out.
		// The code search is the best answer and not the only one. A place the app
		// owns is a file and a line the server can read; anywhere else — a row a
		// dependency draws, a framework that records nothing, a node the compiler
		// never saw — the pick still lands, carrying the element itself. A refusal
		// here would lose the reviewer's actual finding over a file path.
		const at = locate(event.target);
		const appCode = at && !at.file.includes('node_modules');
		hide(outline);
		hide(label);
		open();
		// Described either way. The search naming a file says which line of the app
		// draws this; it says nothing about what the element is, which is the half
		// the file cannot answer. Dropping the description for a located pick meant
		// the common case sent the file and lost the element.
		addPick({ ...(appCode ? { file: at.file, line: at.line } : {}), context: contextOf(event.target, at) }, event.target);
		// No hint on a pick: the chip that just appeared in the field is the
		// feedback, and the field is where the person is looking — and when a
		// dialog owns the keyboard, `open()` has already moved the panel inside it
		// so that field can be typed into.
	},
	true
);

// Holding the modifier makes the page inert, which is what makes every element
// a target: the press that precedes a pick must not focus the control, place a
// caret, start a drag, select text or open a native dropdown, or the control
// under the cursor takes the very interaction the pick was meant to take. The
// press is stopped before it can do any of it.
//
// Ours is exempt — the blob's field is the one press that must still land.
on(
	document,
	'mousedown',
	(/** @type {MouseEvent} */ event) => {
		if (!armed || isOwnDom(event.target)) return;
		if (!event.altKey && !event.ctrlKey && !event.metaKey) return;
		event.preventDefault();
		event.stopPropagation();
	},
	true
);

// Losing window focus puts the hover chrome away, but it must not throw away a
// walk somebody is halfway through writing. A window manager grabbing alt, a
// devtools panel, another application: all of them blur this window, and none
// of them mean "discard".
on(window, 'blur', () => {
	hide(outline);
	hide(label);
});

// Holding the modifier is the gesture: the outline follows the cursor while it
// is down and puts itself away when it is released, so nothing is left armed
// and a plain click stays the app's own. The blob stays — that is the walk.
/** @param {KeyboardEvent} event */
const isModifier = (event) => event.key === 'Alt' || event.key === 'Control' || event.key === 'Meta';
on(window, 'keydown', (/** @type {KeyboardEvent} */ event) => {
	if (isModifier(event)) arm();
});
on(window, 'keyup', (/** @type {KeyboardEvent} */ event) => {
	if (isModifier(event)) disarm();
});

// A walk that survived a page change, or a reload: the document comes back, and
// with it the panel — open if it was left open, closed if a person closed it,
// because a close is a decision and a page change is not an argument with it.
const saved = loadDocument();
if (saved.items.length > 0 || saved.request) render(saved);
else showPlaceholder();
renumber();
resync();
if (loadPanel()) open();
else close();
