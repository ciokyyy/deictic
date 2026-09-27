// @file: the bridge that hands a feedback note to an agent pane — the last hop
// between packages/vite-plugin-feedback and the session that fixes the code
// @contract: GET /agents answers {agents,free,kinds} so the sender can offer a
// choice; POST /agent starts a new agent of a chosen kind in a free pane and
// answers its pane id; POST /prompt?target=<pane> runs `herdr agent prompt
// <pane> <text>` for that pane, and with no target keeps the focused pane;
// GET /health answers {ok:true,target}
// @invariants: the text travels as one argv element and never through a shell,
// so a note containing quotes or $(...) cannot execute anything; only
// 127.0.0.1 is bound; the target is never validated here — herdr is the
// authority on whether a pane id still exists, and a stale one is answered with
// its own refusal rather than a second opinion
// @related: scripts/dev-toolbar.sh, packages/vite-plugin-feedback (the sender)
import { spawn } from 'node:child_process';

const port = Number(process.env.BRIDGE_PORT ?? 9977);
// Nothing pinned by default: a pane id is per session, so a hardcoded target
// fails with agent_not_found as soon as that session is gone. Set BRIDGE_AGENT
// to pin one anyway.
const pinnedAgent = process.env.BRIDGE_AGENT;
const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'content-type',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/** The kinds `herdr agent start --kind` accepts, in the order it lists them.
 *  Herdr has no `agent kinds` command to read this from, so it is stated here
 *  rather than guessed; regenerate with `herdr agent start --help`. A kind this
 *  list has and herdr does not is refused by herdr, which is the authority. */
const KINDS = [
	'pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
	'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok',
	'hermes', 'kilo', 'qodercli', 'qwen', 'maki'
];

/** Runs the real herdr. Injected everywhere it is used, because every route
 *  below spawns a process and a test must not spawn an agent to find out that
 *  it handed over the right argv. */
function realHerdr(args) {
	const child = spawn('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => (stdout += chunk));
	child.stderr.on('data', (chunk) => (stderr += chunk));
	return new Promise((resolve) => {
		child.on('close', (status) => resolve({ status, stdout, stderr }));
	});
}

/** herdr answers JSON with a banner above it, so the first brace starts it. An
 *  unparseable answer is no agents rather than a crash: a sender asking what
 *  exists should still get a page, and the reason comes back as a reason. */
function parseJson(text) {
	const at = text.indexOf('{');
	if (at < 0) return null;
	try {
		return JSON.parse(text.slice(at));
	} catch {
		return null;
	}
}

export function createBridge({ herdr = realHerdr, pinned = pinnedAgent } = {}) {
	/** Every agent herdr can see, in the shape the sender picks from. `name` is
	 *  optional — the director's own agent reports none — so a label falls back
	 *  to the kind and the pane rather than rendering as blank. */
	async function agents() {
		const { stdout } = await herdr(['agent', 'list']);
		const found = parseJson(stdout)?.result?.agents ?? [];
		return found.map((one) => ({
			pane: one.pane_id,
			kind: one.agent,
			name: one.agent_session?.name ?? one.name ?? null,
			focused: Boolean(one.focused),
			status: one.agent_status,
			cwd: one.foreground_cwd ?? one.cwd ?? null
		}));
	}

	/** A pane with no agent in it. `herdr agent start` needs an existing pane at
	 *  an interactive shell prompt, so this is what a new agent is started in. */
	async function freePanes() {
		const { stdout } = await herdr(['pane', 'list']);
		const panes = parseJson(stdout)?.result?.result ?? [];
		return panes.filter((one) => !one.agent).map((one) => one.pane_id);
	}

	/** Who to hand the prompt to with nothing chosen: a pinned target, else the
	 *  focused agent pane's id, else the first agent there is. A pane id, not the
	 *  `agent` field — that is the binary's name and the prompt target has never
	 *  accepted it. */
	async function defaultTarget() {
		if (pinned) return pinned;
		const all = await agents();
		return all.find((one) => one.focused)?.pane ?? all[0]?.pane ?? null;
	}

	return {
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
			if (request.method === 'GET' && url.pathname === '/health') {
				return Response.json({ ok: true, target: await defaultTarget() }, { headers: cors });
			}
			if (request.method === 'GET' && url.pathname === '/agents') {
				return Response.json(
					{ agents: await agents(), free: await freePanes(), kinds: KINDS },
					{ headers: cors }
				);
			}
			if (request.method === 'POST' && url.pathname === '/agent') {
				return startAgent(request);
			}
			if (request.method !== 'POST' || url.pathname !== '/prompt') {
				return new Response('not found', { status: 404, headers: cors });
			}
			const text = (await request.text()).trim();
			if (!text) return Response.json({ delivered: false, reason: 'empty prompt' }, { status: 400, headers: cors });
			// An explicit target is this route's whole reason for existing: the
			// sender chose a pane, and the focused pane is no longer relevant.
			const target = url.searchParams.get('target') || (await defaultTarget());
			if (!target) return Response.json({ delivered: false, reason: 'no herdr agent to prompt' }, { status: 503, headers: cors });
			const { status: exit, stderr } = await herdr(['agent', 'prompt', target, text]);
			console.log(`[bridge] ${new Date().toISOString()} ${text.length} chars → herdr agent prompt ${target} (exit ${exit})`);
			if (exit !== 0) console.log(`[bridge] herdr said: ${stderr.trim()}`);
			return Response.json({ delivered: exit === 0, exit, target, stderr: stderr.trim() || undefined }, { status: exit === 0 ? 200 : 502, headers: cors });
		}
	};

	/** Starting one is `herdr agent start <name> --kind <kind> --pane <id>`, and
	 *  the name is a required argument, so it is minted here. Two panes can be
	 *  free at the same moment, so the name carries a base36 clock rather than
	 *  counting from one. */
	async function startAgent(request) {
		let asked;
		try {
			asked = await request.json();
		} catch {
			return Response.json({ started: false, reason: 'body is not json' }, { status: 400, headers: cors });
		}
		const kind = asked?.kind;
		if (!KINDS.includes(kind)) {
			return Response.json(
				{ started: false, reason: `${JSON.stringify(kind ?? null)} is not a kind herdr starts` },
				{ status: 400, headers: cors }
			);
		}
		const name = asked?.name || `feedback-${kind}-${Date.now().toString(36)}`;
		// An explicit pane is honoured so a caller can place it, but a pane that
		// is not asked for is taken from the free ones, because a new agent with
		// nowhere to live is not started.
		const free = await freePanes();
		const pane = asked?.pane || free[0];
		if (!pane) {
			return Response.json(
				{ started: false, reason: 'no free pane to start one in — open a pane and try again' },
				{ status: 409, headers: cors }
			);
		}
		const { status: exit, stderr } = await herdr(['agent', 'start', name, '--kind', kind, '--pane', pane]);
		if (exit !== 0) {
			return Response.json({ started: false, reason: stderr.trim() || `herdr exited ${exit}` }, { status: 502, headers: cors });
		}
		console.log(`[bridge] started ${kind} "${name}" in ${pane}`);
		return Response.json({ started: true, name, kind, pane }, { headers: cors });
	}
}

/** Only serve when run, so a test can import the routes and hand them a herdr
 *  that answers from a table instead of one that starts agents. */
if (import.meta.main) {
	const bridge = createBridge();
	Bun.serve({ hostname: '127.0.0.1', port, fetch: bridge.fetch });
	console.log(`[bridge] listening on http://127.0.0.1:${port} → herdr pane ${pinnedAgent ?? '(the focused one)'}`);
}
