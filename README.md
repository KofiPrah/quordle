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

The key is build-time only and must never use a `VITE_` prefix. See
`THIRD_PARTY_NOTICES.md` for dictionary attribution and licensing.

