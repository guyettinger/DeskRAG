<p align="center">
  <img src="assets/deskrag-ghost.svg" alt="DeskRAG" width="150" height="150">
</p>

<h1 align="center">DeskRAG</h1>

<p align="center"><strong>Local-first, multimodal desktop session memory.</strong></p>

DeskRAG captures what happens on your desktop — screen video, desktop + mic audio,
mouse/keyboard input, active window, and the OS accessibility tree — into a searchable
"experience memory," then lets you recall past moments by:

- **semantic query** — *"that time I was debugging auth"*
- **visual example** — *"find this screen / this dialog"*
- **behavioral similarity** — *"sessions like what I'm doing now"*

It's inspired by VideoRAG and PixelRAG, with a key advantage over pure-pixel systems:
on the desktop we read real UI structure from the **accessibility tree**, giving free,
labeled region proposals — grounded bounding boxes and roles that video systems must
infer.

Recordings don't stay a pile of video. Each one is lifted into a **trace graph** — states
verified against the accessibility tree, edges of the actions you actually performed —
and the **Flows** screen is where you read it: the routes you take repeatedly, weighted by
how often you took them, with one click from any state back to the recording and the exact
moment it happened. Recording a task twice is what reveals it as a flow at all, so what
shows up is what you did rather than what a model inferred.

The graph is also an executable IR — `src/replay/` turns it into a plan and posts real
CGEvents — but **that executor is not wired to the app**: nothing in DeskRAGApp observes or
acts on the live desktop, and it never starts a process capable of clicking.

**Every model runs on your machine.** There is no cloud provider, no API key, and no
network call to anything but a daemon on localhost — the privacy claim is structural,
not a matter of how you configured it. TypeScript throughout, strict types, pluggable
local providers (Ollama, in-process ONNX, whisper.cpp).

## DeskRAGApp

The desktop client drives the whole pipeline from a UI — record, auto-index, then play
back or search your sessions. See **[app/README.md](./app/README.md)** for setup,
permissions, and how it's wired.

![The Library screen: session list beside a player whose scrubber is divided at the indexed keyframes](docs/images/library.png)

<table>
<tr>
<td width="50%"><img src="docs/images/record.png" alt="Record screen"><br><strong>Record</strong> — a per-signal switchboard with live permission status.</td>
<td width="50%"><img src="docs/images/search.png" alt="Search screen"><br><strong>Search</strong> — hits come back as a contact sheet of keyframes.</td>
</tr>
<tr>
<td width="50%"><img src="docs/images/detail.png" alt="Detail view"><br><strong>Detail</strong> — pick an accessibility node to locate it on the frame.</td>
<td width="50%"><img src="docs/images/flows.png" alt="Flows screen"><br><strong>Flows</strong> — the paths you take, and one click back to the recording.</td>
</tr>
</table>

## Quick start

```bash
npm install         # the library (root) — Node-ABI native modules for the test suite
npm run app:install # the app (own node_modules) — postinstall builds better-sqlite3 for Electron
npm run app:dev     # build the library, then launch the app
```

To use the library directly instead:

```bash
npm install && npm run typecheck && npm test
```

## Documentation

| Document | What's in it |
|---|---|
| [Architecture](./docs/architecture.md) | the pipeline, the dual-store seam, vector namespacing, repo layout |
| [Setup](./docs/setup.md) | requirements, install, optional tools, macOS permissions, maintainer scripts |
| [Providers](./docs/providers.md) | what runs where, weight pinning, why every provider is local |
| [Library usage](./docs/library-usage.md) | the API shape, end to end |
| [DeskRAGApp](./app/README.md) | the Electron desktop client |
| [CLAUDE.md](./CLAUDE.md) | the load-bearing invariants, verified the hard way |

## License

MIT — see [LICENSE](./LICENSE).
