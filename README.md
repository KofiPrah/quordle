# Quordle - Discord Activity

A multiplayer Quordle word game built as a Discord Activity using the Embedded App SDK.

## Getting Started

Read more about building Discord Activities with the Embedded App SDK at [https://discord.com/developers/docs/activities/overview](https://discord.com/developers/docs/activities/overview).

## Korean dictionary snapshot

Korean definitions and translations are loaded from a checked-in, generated
snapshot so gameplay never depends on a live dictionary service. To refresh it:

```powershell
cd engine
npm run dictionary:refresh
npm run dictionary:verify
```

`dictionary:refresh` uses `KRDICT_API_KEY`. To rebuild from an official KRDICT
bulk JSON archive instead, pass the downloaded archive path after `--`:

```powershell
npm run dictionary:refresh -- C:\path\to\krdict-json.zip
```

Bulk refreshes also regenerate the compact Korean recognition snapshot used for
nearby-word suggestions and valid-but-not-accepted feedback. They import and
deduplicate KRDICT semantic categories for Korean hint metadata as well. If an
answer has no category in the official archive, its semantic-category hint is
unavailable; the answer and accepted-guess pools are not changed.

API-only refreshes preserve the broader recognition and category data, and
verification will fail if the recognition snapshot no longer contains every
accepted guess. Use a bulk refresh whenever accepted-word membership or
semantic-category data changes. The recognition snapshot contains only
normalized two-syllable headwords and learning levels; full definitions remain
limited to the accepted game lexicon.

The key is build-time only and must never use a `VITE_` prefix. See
`THIRD_PARTY_NOTICES.md` for dictionary attribution and licensing.

## Chinese dictionary snapshot

Chinese mode uses a checked-in CC-CEDICT v1 snapshot split into a compact
accepted/answer lexicon, pinyin candidate shards, and lazy dictionary shards.
The 64 daily-answer words are maintained explicitly in
`engine/src/zhAnswerWords.seed.txt`; verification fails if the source does not
contain every reviewed answer.

To rebuild from an official UTF-8 CC-CEDICT `.txt`, `.gz`, or `.zip` export:

```powershell
cd engine
npm run dictionary:refresh:zh -- C:\path\to\cedict_ts.u8.gz
npm run dictionary:verify:zh
```

Chinese broad-meaning hints are curated separately in
`engine/src/zhHintClues.seed.json`. Run `npm run hints:refresh:zh` after editing
that file; the full dictionary refresh also regenerates the compact hint
metadata.

The generated metadata records the source release timestamp and archive
SHA-256. See `THIRD_PARTY_NOTICES.md` for attribution and CC BY-SA 4.0 terms.

## Korean and Chinese hints and scoring

Korean games provide four one-time hints per unsolved board: part of speech
(2 points), semantic category (3), batchim count (5), and first-syllable reveal
(10). Practice games apply hints locally; daily games use the server-authoritative
WebSocket or REST hint endpoint. Repeated requests return the original persisted
hint without another charge.

Chinese games use the same selected-board and persistence flow with tone pattern
(2 points), tone-marked pinyin (5), curated broad meaning (7), and first-character
reveal (10). A first-character reveal is unavailable when prior feedback already
confirmed that character. Chinese pinyin candidates remain normal, unscored
input, and nearby-word suggestions remain Korean-only.

Leaderboard and result scores use:

```text
max(0, 25 × solved boards − 2 × max(0, guesses − solved boards) − hint penalty)
```

English games use the same formula with zero hints. Daily leaderboard entries,
completion events, and Discord summaries include score, hint count, hint
penalty, and Assisted/Unassisted status. Deploy the engine, server, bot, and
client together when changing these contracts. Existing Redis JSON is
normalized at restore time, so no database migration is required.

## Learning analytics and Saved Words

Phase 6 records versioned learning aggregates without retaining a raw event log.
Daily valid and invalid guesses, solves, failures, hints, completion scores, and
assistance status are derived by the server. The client submits practice gameplay
events and UI interactions such as dictionary views, nearby-word selections, and
post-game review engagement. Unrecognized input text is discarded; only
KRDICT-confirmed real-but-unaccepted Korean words may appear in word-frequency
aggregates.

Cross-device Korean and Chinese Saved Words use the authenticated Discord identity. The
analytics store uses an HMAC pseudonym instead of the Discord ID, display name,
guild, or room. Aggregate and cohort keys expire after 180 days, event
idempotency keys after 30 days, and Saved Words remain until the player removes
them. Local development outside Discord falls back to device-only localStorage.
An authenticated local server can be exercised with `ALLOW_DEV_SESSION=true`;
never enable that helper in a deployed environment.

Production requires Redis and these server-only settings:

```text
LEARNING_ANALYTICS_ENABLED=true
APP_SESSION_SECRET=<random secret>
ANALYTICS_HMAC_SECRET=<independent random secret>
ANALYTICS_ADMIN_TOKEN=<independent admin token>
```

If any requirement is unavailable, gameplay continues but server learning data
fails closed. `/health` reports capability booleans without exposing secret
values. Retrieve a protected JSON summary with:

```powershell
$headers = @{ Authorization = "Bearer $env:ANALYTICS_ADMIN_TOKEN" }
Invoke-RestMethod -Headers $headers -Uri "https://your-server/api/admin/analytics/summary?from=2026-08-01&to=2026-08-31&language=ko&mode=daily"
```

The summary supports at most 90 days per request. Dictionary, nearby-word,
Saved Words, and review usage do not affect scores; only persisted hints mark a
round Assisted or apply the existing hint penalty.

