# firehose

This project currently has two runnable surfaces:

- a Bun-served browser app for live filtered Bluesky and X streaming
- the older terminal CLI, preserved as `cli.js`

The browser app is now the primary entrypoint.

## Current behavior

### Browser app

The browser app serves a single page with two panels:

- left panel: a live scrolling post stream
- right panel: summary text, 10 LLM-suggested filter keywords, and top bigrams
- fixed bottom status bar: posts/sec, total posts, subscriber count, summary age, and system message
- incoming posts render in small batches at most 10 times per second with a six-millisecond work budget; scrolling happens once per batch, stats and usernames update at most four times per second, and the graph redraws once per second to keep mobile controls responsive; the feed and pending queue each retain at most the newest 500 posts
- posts/sec uses a rolling 5-second average and includes a 60-second sparkline, sampled once per second; summary age includes a ring that fills over 10 seconds and resets on a new summary

How it works today:

- select Bluesky, X, or both using the toolbar checkboxes (Bluesky is the default)
- both sources use the same filter chips, with OR matching; posts arrive in a combined feed with source labels, shared summaries, and bigrams
- source selection is included in shared URLs using repeated `source=bluesky&source=x` parameters
- X requires at least one filter and shows its own connection/error status; Bluesky can still stream without filters
- the browser connects to the backend over SSE at `/events` using repeated `filter=` query params when filters are active
- the toolbar supports multiple filters; pressing Enter in the input adds the new filter and reconnects
- active filters appear as removable chips, and removing a chip updates the live stream when connected
- backend channels are keyed by the normalized filter set and source selection, so matching combinations reuse their subscriptions
- if two browser clients use the same filter set, they share one upstream Bluesky firehose connection
- dropped Bluesky connections reconnect automatically with randomized exponential backoff capped at 30 seconds; pausing the last subscriber cancels pending retries
- Bluesky posts with cached usernames arrive immediately; on a cache miss, delivery waits one second and checks again, sending without a username if it is still unavailable; visible posts update when a later lookup succeeds
- Bluesky profile and post links use stable author DIDs; reconnects resume live traffic without replaying posts missed during the outage
- summaries are shared per filter channel and generated roughly every 10 seconds
- each summary update also includes 10 short filter-style keywords generated from the same 10-second post window, each with 5 related search-term expansions
- clicking a summary keyword adds that keyword and its related search terms to the active filter chip list
- when both Bluesky and X are selected, a box below the summary compares shared topics and differences in emphasis, tone, and viewpoints using up to 50 recent posts per source from the same 10-second window; it waits if either source has no recent posts, and uses the same OpenRouter request as the main summary
- the backend also tracks the top 10 bigrams per active filter channel
- the bigram panel has a `clear` control that resets the shared bigram counts for the current filter set
- changing filters does not wipe the current summary, keywords, or bigrams while the new stream catches up
- if no new posts arrive in a summary window, the previous summary stays visible and only its age grows
- the browser has a persistent `Pin to bottom` toggle stored in localStorage
- the browser has a single `play` / `pause` stream toggle plus a `clear` button that resets local app state without changing whether streaming is active
- the browser has a persistent Light/Dark/Streamserver theme dropdown stored in localStorage; Streamserver uses the inline posts, Avenir typography, and teal/amber/rust palette from `not/static/client.css`
- the browser has a persistent Mode dropdown (Off, Sound mode, Crazy mode); Crazy mode includes sound and spotlights a random visible post every 15 seconds while streaming with a padded theme-colored card, a gunshot sound, and a three-second fade; the rest of the screen stays visible; Escape dismisses the spotlight; each new post plays a short Web Audio tone matched to the theme: the original bright click in Light, a low-pass-filtered muffled click in Dark, and a soft pentatonic note in Streamserver; pitch follows the post rate; Streamserver steps up and down its pentatonic scale, transposing the whole scale upward by up to an octave as traffic rises from 0 to 8 posts/sec while preserving its musical intervals; playback caps at 12 tones per second during bursts, with shared reverb and output compression to keep busy streams clean
- shared URLs preserve playback (`play=true` or `play=false`), theme (`theme=light|dark|streamserver`), and mode (`mode=off|sound|crazy`); URL settings override saved preferences
- `play=true` starts even without a filter; `play=false` stays paused even with filters; older links without `play` still start automatically when they include filters
- connecting with filters updates the URL with `pushState`, so filtered views can be shared
- browser Back/Forward restores filters, sources, playback, theme, and mode; appearance-only changes preserve the active connection
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
- `--summarize` send the last 10 seconds of post bodies to the OpenRouter Chat Completions API using `OPENROUTER_KEY` and `openai/gpt-6-luna`
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

## Vercel

The repository is linked locally to `josh-delmans-projects/firehose`. The committed
`vercel.json` selects the Bun runtime and includes the browser files in the server
bundle. `bun.lock` is the shared text lockfile for Vercel and Docker.

To link a fresh checkout, run:

```bash
vercel link --yes --project firehose --scope josh-delmans-projects
vercel build
```

Configure `OPENROUTER_KEY` in Vercel for summaries and `SITE_PASSWORD` to enable
the site's password screen. X additionally needs `ENABLE_X=true` and
`X_BEARER_TOKEN`. Vercel instances have separate in-memory channels, and streams
are subject to function duration limits. The shared X connection assumes one
server process, so its current implementation needs a dedicated persistent
backend before enabling it across multiple instances.

## Docker

Build the image:

```bash
./build.sh
```

Build and run it at `http://localhost:3000`:

```bash
./build.sh --run
```

The script loads `.env` into the running container if present, including `SITE_PASSWORD` and API tokens. Environment files are excluded from the image. The app listens on port 3000 inside the container. Use `HOST_PORT=8080 ./build.sh --run` to change the published host port, or `IMAGE_NAME=my-firehose ./build.sh` to change the image tag. Running stays in the foreground; Ctrl-C stops and removes the container.

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
- `src/server/sources/x-stream.ts`
  - shared X API v2 filtered stream, rule reconciliation, reconnects, and post normalization
- `src/server/summary-service.ts`
  - per-channel summary buffering and OpenRouter summary generation
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
- `SITE_PASSWORD`
  - optional shared site password; when set to a non-empty value, protects the page and streaming endpoints with a centered password screen
  - successful sign-in sets a signed, HttpOnly cookie lasting 24 hours; the password is never stored in the cookie, and changing it invalidates existing sessions
- `OPENROUTER_KEY`
  - required for summary generation through OpenRouter using `openai/gpt-6-luna`
  - if the summary reports exhausted credits or a quota/spending limit, add OpenRouter credits or adjust the key budget in OpenRouter settings, then restart the app server; affected channels stop summary requests until restarted
- `OPENROUTER_MANAGEMENT_KEY`
  - optional server-only OpenRouter management key for historical daily usage on `/admin`; the regular key still provides today's spend and, when permitted, account balance
- `BLUESKY_FIREHOSE_URL`
  - override the default Bluesky firehose websocket endpoint
- `X_BEARER_TOKEN`
  - server-only X API app bearer token; put it in `.env` and restart Bun
- `ENABLE_X`
  - set to `true` to show the X source checkbox and allow X streaming; unset or `false` hides the checkbox and disables X streaming, including requests from saved URLs; restart the server after changing it
- `X_RULE_PREFIX`
  - optional rule ownership prefix, defaults to `firehose:`; use a dedicated X app for this server

## Admin usage

Visit `/admin` to view X and OpenRouter credit balances in USD and daily usage in UTC. The page uses the existing `SITE_PASSWORD` sign-in. Like the main app, it is open when no site password is configured. Provider credentials stay on the server.

X reports project-wide post-read counts for the last 30 days, including today. OpenRouter reports account-wide spend, requests, and tokens for the last 30 completed days when `OPENROUTER_MANAGEMENT_KEY` is set; today's spend for `OPENROUTER_KEY` is shown separately. The key's remaining budget is distinct from the account credit balance. Missing data and provider permission errors are shown explicitly. Reports are cached for one minute; use Refresh to check again.

Sources: [X usage](https://docs.x.com/x-api/usage/get-usage), [X credits](https://docs.x.com/x-api/usage/get-usage-credits), [OpenRouter activity](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint), and [OpenRouter credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits).

## X streaming

Set `ENABLE_X=true` in `.env` and restart the server to show X in the toolbar. Select X, add a word or phrase, and press play. Enable Bluesky too for a combined feed. Bun loads `.env` automatically. The token is never sent to the browser.

The integration uses [X API v2 Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction). Your X app needs streaming access and API credits. X bills delivered posts; narrow filters help control consumption.

One server process owns one X connection shared by all browser channels. Active filter chips become literal quoted X rules with `lang:en -is:retweet`, excluding retweets before download. Incoming posts also pass the same case-insensitive substring matching used for Bluesky. X’s upstream word/phrase matching can omit substring-only matches (for example `cat` inside `concatenate`). Chips are literal text, not X query syntax; quotes, backslashes, and newlines are rejected for X.

Only rules tagged with `X_RULE_PREFIX` are managed. Stale owned rules are removed on the next reconciliation; rules belonging to other apps are preserved. Those other rules can still cause X to deliver billable posts on the shared app stream, so a dedicated X app is recommended. Run only one server process per X app under the standard single-connection limit.

Pausing the last X subscriber closes the stream and removes unused rules. Normal SIGINT/SIGTERM shutdown also cleans up owned rules. Abrupt termination can leave rules behind; the next X subscription reconciles them. Authentication, access, credit, and invalid-rule errors stop retries until a subscription changes (pause/play retries; restart after editing `.env`). Temporary failures reconnect with backoff and respect rate-limit headers.

## Testing status

The repository currently includes automated tests for:

- in-memory pub-sub behavior
- channel reuse and teardown
- summary service behavior
- bigram tracking behavior
- SSE event serialization
- browser-side filter reconnection behavior
- X stream framing, shared connections, rule ownership, post routing, and authentication failures
- Bluesky reconnects after dropped sockets, cancellation on pause, and uninterrupted delivery during slow or failed profile lookups

This README should continue to be updated as the project changes.

The Crazy mode spotlight sound is `sounds/gunshot.m4a`, sourced from https://www.youtube.com/watch?v=Fn0IBlb8GQg with approximately 0.39 seconds of leading silence removed.
