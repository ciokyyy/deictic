# deictic

A deictic is a word like *here* or *that* — one whose meaning is fixed by the situation rather than by itself. This is a dev tool for the same gesture in a browser: you point at the thing you mean instead of describing it.

Hold <kbd>alt</kbd>, click any element in a running Vite app, write what is wrong with it, and the note arrives in a coding agent as the source of the exact line that produced that element. No screenshot, no "the card in the top right", no guessing which `Card.tsx` you meant.

![architecture](docs/architecture.svg)

## What it actually sends

The agent does not get a description. It gets a table of every element you clicked, the file and line each one came from, and the real source around that line:

```toon
[ui feedback] 2 from 1 page(s)
request: the empty state should use the accent colour
feedback[2]{index,file,line,url}
  1,apps/frontend/src/lib/Thread.svelte,142,/threads/9f2
  2,apps/frontend/src/lib/Thread.svelte,158,/threads/9f2
notes:
  1: this should be the accent, not the muted foreground
sources:
  apps/frontend/src/lib/Thread.svelte:142
    140 |   <div class="flex flex-col gap-2">
    141 |     {#each empty as suggestion}
    142 |       <button class="text-muted-foreground text-sm">
    143 |         {suggestion.title}
    144 |       </button>
```

[TOON](https://github.com/toon-format/toon) rather than prose, because the locations are a table and a table is what TOON is for. The order is the order you clicked in — a review reads as a walk through the app, and re-sorting it would scramble the thing you are describing. The code is quoted as it is written, because quoting code as data makes it harder to read, not smaller.

## Install

```bash
npm install --save-dev deictic
```

```js
// vite.config.js
import { defineConfig } from 'vite';
import { feedbackPlugin } from 'deictic';

export default defineConfig({
  plugins: [feedbackPlugin({ endpoint: 'http://127.0.0.1:9977/prompt' })]
});
```

That is the whole setup. The plugin serves its own overlay, so there is nothing to import into your app and nothing added to your bundle.

## How a note gets to an agent

The plugin is deliberately dumb about the far end. It POSTs `text/plain` to the one `endpoint` you configured and reports whatever comes back. Anything that accepts a POST is a valid destination.

**`bridge.mjs` is the herdr implementation, and it is the only file that knows herdr exists.** It binds `127.0.0.1` only and speaks four routes:

| route | what it does |
| --- | --- |
| `GET /agents` | the running agents, the free panes, and the 22 kinds that can be started |
| `POST /agent` | starts an agent of a chosen kind in a free pane, answers its pane id |
| `POST /prompt?target=<pane>` | runs `herdr agent prompt <pane> <text>`; with no target, the focused pane |
| `GET /health` | `{ok: true, target}` |

The overlay offers the running agents by name, with a "start new" group, and remembers your last choice. A bridge that is not running leaves the one option that always works — the focused agent.

## Decisions worth arguing about

**The bridge never validates a target pane.** herdr is the authority on whether a pane id still exists. Quietly re-routing a stale pane to the focused one would send your note to an agent nobody picked, which is worse than an error. Refusals pass through as refusals.

**The 22 agent kinds are a stated constant, not a capability check.** herdr has no `agent kinds` command, so the list is written out. If you ask for one it does not have, herdr refuses it — the right way round, since herdr is what would run it.

**The note travels as one argv element and never through a shell.** A note containing `$(...)` or a quote cannot execute anything.

**A closed popover is `display: none` from the UA sheet**, so the overlay adds and removes the `popover` attribute rather than toggling it — an inline `display` would beat the UA sheet and leave the node drawn while it is shut. It is lifted into the top layer unconditionally, launcher included, because a circle a modal covers is a tool you cannot bring back.

**A drag is not a click.** The browser sends a `click` after every `pointerup`. Left alone, dragging the launcher to the corner also opened the panel. Presses that move more than 4px are drags, and the click they drag out with is swallowed.

**Event isolation excludes `mousedown` and `click`.** While <kbd>alt</kbd> is held the overlay swallows `pointerup`, `wheel`, `contextmenu`, `dblclick` and `touchstart` at the window in the capture phase, so the app sees nothing. It deliberately does not swallow press and click: the picker needs to see those to make a pick, and a window-level capture that took them first would break picking entirely.

## Stack

No dependencies. The plugin is three files of ESM and a Vite peer dependency; the bridge is `node:child_process` and an HTTP server. The test runner is [Bun](https://bun.sh) with jsdom.

| file | what it is |
| --- | --- |
| `index.mjs` | the Vite plugin: routes, file:line resolution, message composition |
| `client.mjs` | the overlay: picking, the note field, the agent picker |
| `toon.mjs` | the batch format |
| `bridge.mjs` | the herdr side, and the only herdr-aware file |

```bash
bun test
```

## License

MIT
