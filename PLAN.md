# Browser App Migration Plan

## Goal

Replace the current terminal-first Bluesky CLI with a browser app, while keeping the CLI available as-is under `cli.js`.

The browser app should:

- serve a single page from Bun
- use TypeScript throughout new code
- stream posts to the browser over SSE
- show posts in a left panel (2/3 width) with new posts appearing at the bottom
- show stats and summary in a right panel (1/3 width)
- keep the upstream source, pub-sub engine, and summary pipeline modular and swappable

## Progress Tracking

- [x] Write the migration plan
- [x] Confirm major architecture decisions
- [x] Ensure the project is already a git repo
- [x] Replace `.gitignore` with a standard Node.js-oriented ignore file
- [x] Start implementation

## Working Assumptions

These are the assumptions I plan to use unless you want to change them before implementation:

1. Frontend stack: plain browser TypeScript + HTML + CSS, no React/Vite/build step.
2. Runtime: Bun serves static assets and API/SSE endpoints directly.
3. Summary scope: summaries are shared per filter channel, not per individual browser client.
4. Channel key: the filter text is normalized and used as the pub-sub channel key.
5. Initial backend implementation: Bluesky only, with interfaces that allow a Mastodon adapter later.
6. Summary model/API: continue using `gpt-5-mini-2025-08-07` through the OpenAI Responses API with `OPENAI_API_KEY`.

## Confirmed Decisions

1. Frontend rendering starts without React.
2. Summaries are shared per filter channel.
3. On empty 10-second windows, keep the previous summary visible.
4. Show summary staleness in human-readable form such as `45s`, `1m`, `2m`.

Frontend recommendation:

- React is not necessary for the first version.
- This is mostly an append-only stream plus a lightweight sidebar, so plain TypeScript keeps the render path simpler and more predictable.
- `react-window` is not needed if we cap the visible post list in the DOM.
- If later you want a much deeper retained in-browser history, then virtualization becomes worthwhile.

## Proposed Architecture

### 1. Preserve the Existing CLI

- rename `index.js` to `cli.js`
- keep behavior unchanged except for any import/path fixes needed after the rename
- do not fold CLI logic directly into the web server; instead extract shared pieces where useful

### 2. Shared Domain Layer

Create TypeScript domain models and interfaces so the source and transport layers are replaceable.

Core model:

```ts
type GenericPost = {
  id: string;
  source: 'bluesky' | string;
  channelKey: string;
  authorId: string;
  username: string;
  text: string;
  createdAt: string;
  language?: string;
  raw?: unknown;
};
```

Core interfaces:

- `PostSourceAdapter`
  - starts/stops upstream subscriptions for a channel
  - emits normalized `GenericPost` objects
- `PubSubAdapter`
  - subscribe/unsubscribe by channel
  - publish post events, stats updates, and summary updates
- `SummaryService`
  - buffers recent posts per channel
  - generates summaries on a 10-second cadence
- `ChannelRegistry`
  - reference-counted channel lifecycle
  - ensures one upstream connection per unique normalized filter

### 3. Backend Channel Lifecycle

For each normalized filter:

1. browser opens SSE to `/events?filter=oscars`
2. server normalizes filter and looks up a channel in `ChannelRegistry`
3. if channel exists, attach subscriber only
4. if channel does not exist:
   - create channel state
   - start upstream Bluesky stream for that filter
   - start summary timer for that channel
5. when the last subscriber disconnects:
   - stop SSE subscription
   - stop upstream adapter
   - stop summary timer
   - remove channel state

This gives reusable channels for repeated filters while keeping the system stateless across different filter keys.

### 4. Event Model Over SSE

Use one SSE stream per browser request. Emit typed events.

Proposed event types:

- `post`
  - payload: `GenericPost`
- `stats`
  - payload: `{ postsPerSecond: number; totalPosts: number; subscriberCount: number }`
- `summary`
  - payload: `{ text: string; updatedAt: string; status: 'idle' | 'updating' | 'error' }`
- `system`
  - payload: `{ message: string }`

The browser should tear down and recreate the SSE connection whenever the filter changes.

### 5. Pub-Sub Abstraction

Add an internal pub-sub contract that is transport-agnostic.

Initial adapter:

- `InMemoryPubSubAdapter`
  - `Map<channelKey, Set<subscriber>>`
  - appropriate cleanup on disconnect

Future adapter:

- `RedisPubSubAdapter`
  - not implemented now
  - the interface should not assume in-process callbacks only

This means channel orchestration code should depend on the interface, not on direct `EventEmitter` usage.

### 6. Bluesky Source Adapter

Move Bluesky-specific logic behind a `BlueskyFirehoseAdapter`.

Responsibilities:

- connect to Bluesky firehose websocket
- decode commit frames / CAR blocks
- extract `app.bsky.feed.post` records
- apply text and language filtering
- resolve usernames with caching
- publish normalized `GenericPost` objects

Important detail:

- the adapter should not know about SSE or browser clients
- it only emits `GenericPost` objects to the pub-sub / channel layer

### 7. Summary Service

For each active channel:

- keep a rolling buffer of about 10 seconds of matching post bodies
- every 10 seconds:
  - send the buffered post texts to OpenAI
  - request a terse summary and note outliers
  - publish a `summary` event for the channel
- if there are no posts in the interval:
  - keep the last good summary visible
- publish a freshness timestamp so the UI can show how stale the summary is
- also publish status so the UI can indicate whether a refresh is in progress

### 8. Browser UI

Single page with two columns:

- left panel: post stream
  - scrollable
  - new posts appended at the bottom
  - preserve readable timestamps and usernames
- right panel: stats + summary
  - sticky/full-height sidebar feel
  - posts/sec
  - total posts
  - summary text
  - summary staleness
  - current filter / connection state

Suggested behavior:

- top input bar or sidebar control for filter text
- on filter submit:
  - close current SSE
  - clear current view state
  - open new SSE with the new filter
- keep the visible post list bounded to avoid DOM growth under heavy stream volume

### 9. Server Surface

Proposed Bun endpoints:

- `GET /`
  - serve the app shell HTML
- `GET /app.ts`
  - serve browser TypeScript source if Bun can transpile directly for the browser
  - if that turns out to be awkward, fall back to serving plain JS authored in `.ts` source but emitted by Bun at request time
- `GET /events?filter=...`
  - SSE endpoint for posts/stats/summary/system events

If Bun’s direct TS-to-browser serving is clumsy, I will keep the source in TypeScript and use the simplest Bun-native path that avoids introducing a bundler.

## Proposed File Layout

```text
cli.js
PLAN.md
src/
  server/
    index.ts
    routes.ts
    sse.ts
    channel-registry.ts
    summary-service.ts
    pubsub/
      pubsub.ts
      in-memory-pubsub.ts
    sources/
      source.ts
      bluesky-firehose.ts
    models/
      post.ts
      events.ts
  web/
    index.html
    app.ts
    styles.css
```

I may compress or slightly rename files during implementation if Bun routing ergonomics suggest a simpler structure, but the layering should remain the same.

## Execution Phases

### Phase 1. Restructure

- [x] rename `index.js` -> `cli.js`
- [x] update `package.json` entrypoints and docs
- [x] add TypeScript source tree

### Phase 2. Shared Models and Interfaces

- [x] implement `GenericPost`
- [x] implement event contracts
- [x] implement pub-sub interface and in-memory adapter
- [x] implement channel registry lifecycle

### Phase 3. Bluesky Adapter Extraction

- [x] port current Bluesky websocket/firehose logic into TypeScript
- [x] keep filtering, language matching, handle caching, and summary input extraction
- [x] publish normalized posts into channels

### Phase 4. Summary Pipeline

- [x] implement per-channel 10-second buffers
- [x] integrate OpenAI summary generation
- [x] publish summary/status updates into the channel

### Phase 5. Bun Server and SSE

- [x] build the single-page server
- [x] build SSE endpoint with subscription cleanup
- [x] emit `post`, `stats`, and `summary` events

### Phase 6. Browser UI

- [x] build the two-panel layout
- [x] implement filter input and SSE reconnect behavior
- [x] render streaming posts
- [x] render stats and summaries
- [x] show human-readable summary staleness
- [x] cap retained rendered posts for performance

### Phase 7. Verification and Testing

- [x] add robust automated tests for the shared models and interfaces
- [x] add robust automated tests for channel lifecycle and pub-sub behavior
- [x] add robust automated tests for summary buffering and summary state transitions
- [x] add robust automated tests for SSE event formatting and connection cleanup
- [x] add robust automated tests for the browser filter reset flow
- [x] verify duplicate browser clients with same filter reuse one upstream source
- [x] verify different filters create separate channels
- [x] verify disconnect cleanup
- [x] verify summary timing and UI updates
- [x] verify a filter change tears down and recreates SSE cleanly

## Risks / Things To Watch

- Bun TS-in-browser serving may need a small adjustment if raw `.ts` is not ideal for the browser path.
- SSE cleanup must be explicit to avoid leaking channel subscribers.
- Shared channel reuse must be reference-counted correctly or filters will leak websocket connections.
- Summary generation should be throttled strictly per channel to avoid overlapping OpenAI calls.
- Bluesky username lookups should remain cached to avoid unnecessary profile requests.

## Ready To Execute

The planning questions are resolved. Implementation can proceed from this plan.
