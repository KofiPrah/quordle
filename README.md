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

## Korean hints and scoring

Korean games provide four one-time hints per unsolved board: part of speech
(2 points), semantic category (3), batchim count (5), and first-syllable reveal
(10). Practice games apply hints locally; daily games use the server-authoritative
WebSocket or REST hint endpoint. Repeated requests return the original persisted
hint without another charge.

Leaderboard and result scores use:

```text
max(0, 25 × solved boards − 2 × max(0, guesses − solved boards) − hint penalty)
```

English games use the same formula with zero hints. Daily leaderboard entries,
completion events, and Discord summaries include score, hint count, hint
penalty, and Assisted/Unassisted status. Deploy the engine, server, bot, and
client together when changing these contracts. Existing Redis JSON is
normalized at restore time, so no database migration is required.

