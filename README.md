# firehose

This project currently has two runnable surfaces:

- a Bun-served browser app for live filtered Bluesky streaming
- the older terminal CLI, preserved as `cli.js`

The browser app is now the primary entrypoint.

## Current behavior

### Browser app

The browser app serves a single page with two panels:

- left panel: a live scrolling post stream
- right panel: summary text, 10 LLM-suggested filter keywords, and top bigrams
- fixed bottom status bar: posts/sec, total posts, subscriber count, summary age, and system message

How it works today:

- the browser connects to the backend over SSE at `/events` using repeated `filter=` query params when filters are active
- the toolbar supports multiple filters; pressing Enter in the input adds the new filter and reconnects
- active filters appear as removable chips, and removing a chip updates the live stream when connected
- backend channels are keyed by the normalized filter set, so matching filter combinations reuse the same upstream subscription
- if two browser clients use the same filter set, they share one upstream Bluesky firehose connection
- summaries are shared per filter channel and generated roughly every 10 seconds
- each summary update also includes 10 short filter-style keywords generated from the same 10-second post window, each with 5 related search-term expansions
- clicking a summary keyword adds that keyword and its related search terms to the active filter chip list
- the backend also tracks the top 10 bigrams per active filter channel
- the bigram panel has a `clear` control that resets the shared bigram counts for the current filter set
- changing filters does not wipe the current summary, keywords, or bigrams while the new stream catches up
- if no new posts arrive in a summary window, the previous summary stays visible and only its age grows
- the browser has a persistent `Pin to bottom` toggle stored in localStorage
- the browser has a single `play` / `pause` stream toggle plus a `clear` button that resets local app state without changing whether streaming is active
- the browser has a persistent light/dark theme toggle stored in localStorage
- the browser has a persistent `Sound mode` toggle; when enabled, each new post triggers a small synthesized click via the Web Audio API
- the browser does not auto-connect on load unless the URL includes at least one `?filter=...` parameter
- connecting with filters updates the URL with `pushState`, so filtered views can be shared
- browser Back/Forward restores the filter chips and reconnects from the URL state
- when a non-default filter is active, matching text in posts is highlighted in pale yellow
- Bluesky rich-text links and plain URLs in post text are clickable
- usernames link to Bluesky profiles and timestamps link to the original Bluesky posts when available
- embedded Bluesky images are rendered inline when available
- the browser UI intentionally looks plain and old-web: Times New Roman, white background, simple borders

### CLI

The CLI still streams Bluesky posts directly in the terminal.

Examples:

```bash
node cli.js
node cli.js --filter bun
node cli.js --lang es
node cli.js --summarize
```

Optional CLI flags:

- `--endpoint` override the Bluesky firehose URL
- `--filter` case-insensitive substring matched against the post body
- `--lang` BCP-47 language tag matched against the post's `langs` list; defaults to `en`
- `--summarize` send the last 10 seconds of post bodies to the OpenAI Responses API using `OPENAI_API_KEY`
- `--help` show usage

## Running

Install dependencies:

```bash
bun install
```

Start the browser app:

```bash
bun run dev
```

Open:

```text
http://localhost:3000
```

Run tests:

```bash
bun test
```

Typecheck:

```bash
bun x tsc --noEmit
```

## Architecture

The server is modular so the upstream source and pub-sub implementation can be swapped later.

Current pieces:

- `index.ts`
  - Bun server entrypoint
- `src/server/channel-registry.ts`
  - filter channel lifecycle and shared upstream reuse
- `src/server/pubsub/`
  - swappable pub-sub contract and in-memory adapter
- `src/server/sources/bluesky-firehose.ts`
  - Bluesky-specific firehose adapter
- `src/server/summary-service.ts`
  - per-channel summary buffering and OpenAI summary generation
- `src/server/routes.ts`
  - HTML, browser module, CSS, and SSE routing
- `src/web/`
  - browser app HTML/CSS/TypeScript
- `cli.js`
  - preserved terminal app

## Logging

The server now emits Apache-style access logs for HTTP requests.

It also logs Bluesky upstream lifecycle events in a structured server-side format:

- when a new Bluesky connection is opened
- when a Bluesky connection is closed
- each log line includes the active filter

## Environment

Optional environment variables:

- `PORT`
  - Bun server port, defaults to `3000`
- `OPENAI_API_KEY`
  - required for summary generation
- `BLUESKY_FIREHOSE_URL`
  - override the default Bluesky firehose websocket endpoint

## Testing status

The repository currently includes automated tests for:

- in-memory pub-sub behavior
- channel reuse and teardown
- summary service behavior
- bigram tracking behavior
- SSE event serialization
- browser-side filter reconnection behavior

This README should continue to be updated as the project changes.
