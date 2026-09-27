// @file: the bridge's routes, against a herdr that answers from a table
// @contract: the sender can list what is running, start a new agent of a chosen
// kind, and deliver to a pane it chose rather than to the focused one
// @invariants: every test asserts the exact argv handed to herdr, because a
// wrong flag is invisible in a passing status code
// @related: scripts/toolbar-bridge.mjs

import { expect, test } from 'bun:test';
import { createBridge } from './bridge.mjs';

const AGENTS = {
	result: {
		agents: [
			{ pane_id: 'w1:p1', agent: 'omp', agent_status: 'working', focused: true, foreground_cwd: '/repo' },
			{ pane_id: 'w2:p1', agent: 'pi', agent_status: 'idle', focused: false, agent_session: { name: 'critic' } }
		]
	}
};
const PANES = {
	result: {
		result: [
			{ pane_id: 'w1:p1', agent: 'omp' },
			{ pane_id: 'w1:p2', agent: null },
			{ pane_id: 'w2:p1', agent: 'pi' },
			{ pane_id: 'w2:p2', agent: null }
		]
	}
};

/** A herdr that answers the two list commands from the tables above and records
 *  every argv, so a test can say which command was meant to run. Anything else
 *  succeeds silently, which is what `herdr agent prompt` does on a live pane. */
function fakeHerdr({ startExit = 0, startStderr = '', promptExit = 0 } = {}) {
	const calls = [];
	return {
		calls,
		async herdr(args) {
			calls.push(args);
			if (args[0] === 'agent' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(AGENTS), stderr: '' };
			if (args[0] === 'pane' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(PANES), stderr: '' };
			if (args[1] === 'start') return { status: startExit, stdout: '', stderr: startStderr };
			if (args[1] === 'prompt') return { status: promptExit, stdout: '', stderr: 'agent_not_found' };
			return { status: 1, stdout: '', stderr: 'unexpected' };
		}
	};
}

const get = (bridge, path) => bridge.fetch(new Request(`http://127.0.0.1:9977${path}`));
const post = (bridge, path, body, type = 'text/plain') =>
	bridge.fetch(new Request(`http://127.0.0.1:9977${path}`, { method: 'POST', body, headers: { 'content-type': type } }));

test('GET /agents answers what is running, what is free, and what can be started', async () => {
	const { herdr } = fakeHerdr();
	const answer = await (await get(createBridge({ herdr }), '/agents')).json();

	expect(answer.kinds).toContain('omp');
	expect(answer.kinds).toContain('pi');
	expect(answer.free).toEqual(['w1:p2', 'w2:p2']);
	// The kind, not the pane, is what "any kind of agent" means, and a label
	// falls back to kind+scope because the director's own agent reports no name.
	expect(answer.agents[0]).toMatchObject({ pane: 'w1:p1', kind: 'omp', focused: true, status: 'working' });
	expect(answer.agents[1]).toMatchObject({ pane: 'w2:p1', kind: 'pi', name: 'critic' });
	expect(answer.agents[0].name).toBeNull();
});

test('a note goes to the pane the sender chose, not the focused one', async () => {
	const { herdr, calls } = fakeHerdr();
	const bridge = createBridge({ herdr });
	const answer = await (
		await post(bridge, '/prompt?target=w2:p1', 'fix the thing')
	).json();

	expect(answer).toMatchObject({ delivered: true, exit: 0, target: 'w2:p1' });
	// The whole feature in one assertion: w1:p1 is focused and must not be it.
	expect(calls).toContainEqual(['agent', 'prompt', 'w2:p1', 'fix the thing']);
	expect(calls.some((c) => c.includes('w1:p1'))).toBe(false);
});

test('with no pane chosen the focused one still gets it, so today is unchanged', async () => {
	const { herdr, calls } = fakeHerdr();
	await post(createBridge({ herdr }), '/prompt', 'no target');
	expect(calls).toContainEqual(['agent', 'prompt', 'w1:p1', 'no target']);
});

test('a pinned target outranks the focused pane', async () => {
	const { herdr, calls } = fakeHerdr();
	await post(createBridge({ herdr, pinned: 'w9:p9' }), '/prompt', 'pinned');
	expect(calls).toContainEqual(['agent', 'prompt', 'w9:p9', 'pinned']);
});

// A note is a note is a note: a quote or $(id) in it must not run, which is why
// the whole thing is one argv element. Proved by putting a real expansion in.
test('a note cannot execute anything, whatever it contains', async () => {
	const { herdr, calls } = fakeHerdr();
	const evil = 'rename $(touch /tmp/pwned) and "rm -rf /" too';
	await post(createBridge({ herdr }), '/prompt?target=w2:p1', evil);
	const argv = calls.find((c) => c[1] === 'prompt');
	expect(argv).toHaveLength(4);
	expect(argv[3]).toBe(evil);
});

test('a new agent is started in a free pane, named because herdr demands a name', async () => {
	const { herdr, calls } = fakeHerdr();
	const answer = await (
		await post(createBridge({ herdr }), '/agent', JSON.stringify({ kind: 'pi' }), 'application/json')
	).json();

	expect(answer).toMatchObject({ started: true, kind: 'pi', pane: 'w1:p2' });
	expect(answer.name).toMatch(/^feedback-pi-/);
	const start = calls.find((c) => c[1] === 'start');
	expect(start.slice(2)).toEqual([answer.name, '--kind', 'pi', '--pane', 'w1:p2']);
});

test('a kind herdr does not start is refused before anything is spawned', async () => {
	const { herdr, calls } = fakeHerdr();
	const answer = await (
		await post(createBridge({ herdr }), '/agent', JSON.stringify({ kind: 'gpt' }), 'application/json')
	).json();

	expect(answer).toMatchObject({ started: false });
	expect(answer.reason).toContain('gpt');
	expect(calls.some((c) => c[1] === 'start')).toBe(false);
});
test('no free pane is a 409 that says so, not a crash', async () => {
	const noFree = {
		async herdr(args) {
			if (args[0] === 'pane') return { status: 0, stdout: JSON.stringify({ result: { result: [{ pane_id: 'w1:p1', agent: 'omp' }] } }), stderr: '' };
			return { status: 0, stdout: '', stderr: '' };
		}
	};
	const response = await post(createBridge({ herdr: noFree.herdr }), '/agent', JSON.stringify({ kind: 'omp' }), 'application/json');
	expect(response.status).toBe(409);
	expect((await response.json()).reason).toContain('no free pane');
});

test('a pane herdr refuses is reported as refused, not retried elsewhere', async () => {
	const { herdr } = fakeHerdr({ promptExit: 1 });
	const response = await post(createBridge({ herdr }), '/prompt?target=w9:p9', 'gone');
	const answer = await response.json();

	expect(response.status).toBe(502);
	// The bridge does not second-guess herdr: a stale pane id is a fact the
	// sender needs to see, and quietly re-routing to the focused pane would
	// send the note to an agent nobody chose.
	expect(answer).toMatchObject({ delivered: false, target: 'w9:p9', stderr: 'agent_not_found' });
});

test('an unparseable herdr answer is no agents, not a crash', async () => {
	const noisy = { async herdr() { return { status: 0, stdout: 'not json at all', stderr: '' }; } };
	const answer = await (await get(createBridge({ herdr: noisy.herdr }), '/agents')).json();
	expect(answer.agents).toEqual([]);
	expect(answer.free).toEqual([]);
});

test('health still answers the target it would use by default', async () => {
	const { herdr } = fakeHerdr();
	const answer = await (await get(createBridge({ herdr }), '/health')).json();
	expect(answer).toEqual({ ok: true, target: 'w1:p1' });
});
