# Pinyin Quordle Redesign

**Status:** Approved design
**Date:** 2026-08-17
**Scope:** Replace Simplified-Chinese-character gameplay in language `zh` with variable-length, Latin-letter Pinyin gameplay while retaining Chinese learning metadata and the existing Quordle presentation quality.

## Problem

The shipped Chinese mode evaluates two Han characters. Pinyin is only an input method that resolves to a Hanzi candidate, so players who know a word's pronunciation but not its characters receive almost no useful partial feedback. Full-Pinyin clues are unsuitable in that model because they reveal an enterable answer, while the remaining hints do not make the underlying character puzzle sufficiently approachable.

The redesigned mode makes plain Pinyin the puzzle surface. Standard letter feedback then supplies partial information naturally, while Hanzi, tones, and meaning remain learning content.

## Goals

- Make Chinese Quordle playable with individual Latin-letter Pinyin tiles.
- Preserve the defining Quordle rule that one submitted guess applies to four boards.
- Support natural Pinyin word lengths without forcing every answer into five letters.
- Treat tones as optional learning information, not answer characters.
- Handle homophones without requiring Hanzi candidate selection.
- Provide selectable, partial, board-targeted hints that never reveal the complete answer.
- Preserve existing English and Korean behavior.
- Preserve the current visual language, responsive polish, accessibility, and Discord embedded-mobile behavior.
- Keep daily REST and WebSocket gameplay authoritative and version-compatible.

## Non-goals

- Scoring tone marks or tone numbers as answer units.
- Accepting Hanzi as the Chinese-mode puzzle answer.
- Retaining the Hanzi candidate picker.
- Supporting one-syllable or three-plus-syllable answer entries.
- Enabling 4-, 8-, or 9-letter daily answer buckets in this phase.
- Redesigning English or Korean gameplay.
- Introducing a new color palette, typography system, or general visual redesign.
- Deploying the redesign to Railway as part of local implementation. Production rollout is a separate, explicitly verified operation.

## Approved Product Decisions

1. Each tile represents one Latin letter, not a Han character or full syllable.
2. The daily word length varies. All four answers on a given day have the same normalized length.
3. The initial enabled daily lengths are 5, 6, and 7 letters.
4. The engine supports normalized lengths 4 through 9, but lengths 4, 8, and 9 remain disabled until their reviewed answer pools are expanded in a later scope.
5. Tone marks and tone numbers are optional input conveniences and learning output. They never occupy tiles or affect tile scoring.
6. A normalized Pinyin spelling is the guess identity. Homophonous Hanzi entries collapse into one playable guess.
7. Daily answers must have unique normalized Pinyin spellings.
8. The syllable boundary is hidden by default and consumes a hint.
9. Chinese mode uses three selectable hints: syllable boundary, reveal one letter, and broad meaning.
10. The adaptive-hybrid board layout is approved. It must reuse the existing style guide and level of polish.

## Canonical Pinyin Representation

The playable key is lowercase, tone-insensitive Pinyin with both syllables concatenated. The canonical tile alphabet is `a-z`, with `v` representing `ü`.

Examples:

| Learning word | Marked Pinyin | Playable key | Length | Boundary index |
|---|---|---:|---:|---:|
| 学生 | xué shēng | `xuesheng` | 8 | 3 |
| 女儿 | nǚ ér | `nver` | 4 | 2 |
| 绿色 | lǜ sè | `lvse` | 4 | 2 |

The boundary index is the number of normalized letters in the first syllable. It is target-specific and is not included in the submitted guess.

### Accepted input forms

The input parser accepts:

- Plain Pinyin: `xuesheng`
- Marked Pinyin: `xué shēng`
- Well-formed tone-number Pinyin: `xue2 sheng1`
- `ü`, `u:`, or `v` for the umlaut vowel
- Harmless syllable separators: spaces, apostrophes, hyphens, and middle dots

The parser validates the input grammar before normalization. Unsupported digits, Hanzi, mixed scripts, and arbitrary punctuation are rejected rather than silently discarded. The on-screen keyboard emits plain Latin letters and includes `V`.

All accepted forms normalize to the same playable key. Guess length is measured after normalization.

## Dictionary and Generated Catalog

The checked-in CC-CEDICT-derived data remains the source for Hanzi, pronunciation, and definitions. The Chinese dictionary generator will additionally produce a compact Pinyin puzzle catalog and a unique Pinyin guess-key set grouped by normalized length.

Each answer record has this logical contract:

```ts
interface ChinesePinyinPuzzleAnswer {
  id: string;                 // stable Chinese dictionary identifier
  hanzi: string;              // intended Simplified Chinese learning word
  pinyinKey: string;          // normalized playable answer, e.g. "xuesheng"
  pinyinMarked: string;       // e.g. "xué shēng"
  pinyinNumeric: string;      // e.g. "xue2 sheng1"
  syllableBoundary: number;   // index in pinyinKey after the first syllable
  tones: [number, number];
  broadMeaning: string;
  length: number;
  answerEligible: true;
}
```

Generation fails if an answer:

- does not contain exactly two valid Pinyin syllables;
- normalizes outside the supported 4-9 letter range;
- lacks Hanzi, marked Pinyin, tones, or a curated broad meaning;
- has an invalid boundary index;
- shares its playable key with another answer-eligible entry; or
- is absent from the accepted Pinyin guess set.

Homophonous dictionary entries may share a guess key. They form one valid playable guess. Only answer eligibility requires a single curated target entry per key.

The current reviewed answer distribution is 4: 6 words, 5: 15, 6: 14, 7: 20, 8: 7, and 9: 2. This phase enables the explicit allowlist `[5, 6, 7]`; future enablement of other lengths requires a separately reviewed corpus change rather than an implicit threshold.

## Daily and Practice Selection

Chinese Pinyin daily selection uses a versioned seed namespace such as `${dateKey}:zh:pinyin-latin-v2`.

1. Use the shared deterministic RNG to select one length uniformly from `[5, 6, 7]`.
2. Deterministically shuffle the answer bucket for that length.
3. Take the first four entries, asserting four unique playable keys and four unique dictionary identifiers.

All four target keys therefore accept the same shared guess length. Existing English and Korean seed inputs and historical targets remain unchanged.

Practice mode uses the same enabled-length allowlist and catalog validation. It selects one enabled length first, then four unique entries from that bucket.

Games retain nine guesses for every enabled Pinyin length. Changing guess count by length is outside this phase.

## Game Engine Contract

Chinese game state adds:

- `puzzleVariant: "pinyin-latin-v2"`;
- the selected `wordLength`; and
- for each board, a playable target key plus the associated Chinese dictionary identifier.

Submitted and persisted Chinese guesses are normalized Pinyin keys. Each result array has exactly `wordLength` entries and uses the existing two-pass Wordle algorithm, including duplicate-letter accounting. A board is solved only when every normalized letter is correct.

Tone, syllable segmentation, Hanzi, and meaning do not affect letter evaluation. They are read through the target's learning metadata for hints and solved-state presentation.

The engine's language configuration must accept a per-game word length for `zh`; it must not replace the fixed English and Korean contracts. Shared functions should expose the authoritative Chinese format, normalization, validation, daily selection, and evaluation rules so the server does not maintain duplicate assumptions.

## Guess Validation and Homophones

A Chinese guess is valid when:

1. its source text passes the Pinyin input grammar;
2. its normalized key matches the current game's `wordLength`; and
3. the key exists in the generated Pinyin guess set for that length.

No candidate choice follows validation. A key such as `shiwu` is one guess even when several Hanzi dictionary entries share it. During an active game, the UI does not expose the matching Hanzi alternatives because they may leak learning targets. Post-game dictionary surfaces may show the target entry and clearly labeled homophones.

Invalid guesses preserve the draft, consume no attempt, make no server submission when the client can reject them locally, and display the existing inline error treatment. Server rejection remains authoritative and follows the same no-consumption rule.

## Hint Contract

Chinese mode retires `tone-pattern`, `pinyin-initials`, and `reveal-first-character`. Tone information remains available only after a board is solved and in dictionary or Saved Words views.

The new selectable hint types are:

| Hint type | Cost | Payload | Availability |
|---|---:|---|---|
| `syllable-boundary` | 2 | Boundary index | Once per unsolved board |
| `reveal-letter` | 5 | Position and letter | Once per unsolved board; at least two unresolved positions must remain |
| `broad-meaning` | 7 | Curated broad clue | Once per unsolved board |

All hints are board-targeted, persisted, included in assistance scoring, and idempotent. Retrying a used hint returns the original payload and timestamp without another charge.

### Reveal-letter selection

`reveal-letter` selects the lowest target position that has never received a green result on that board. It is unavailable if fewer than two such positions remain. Consequently, it cannot directly solve a board. The payload is persisted as a typed `{ index, letter }` value so restoration and server retries reproduce the same clue.

The clue does not modify or prefill the shared draft because the other three boards may require different letters at that position.

### Assistance versioning

New Pinyin Chinese games use assistance scoring version 2 with typed, variant-specific hint payloads. Version 1 remains the active Korean contract and stays readable for historical Hanzi records. Analytics and leaderboards continue to label any hinted result as Assisted.

## Server, Protocol, and Persistence

Daily REST and WebSocket flows remain server-authoritative. Both paths import the same generated Pinyin catalog and engine functions and must produce identical validation, results, hints, metrics, and error codes.

Chinese room and player-state keys include `pinyin-latin-v2`. Legacy Hanzi Chinese states remain stored under their old namespace and cannot be restored into the new protocol. Joining the redesigned mode creates or resumes only a version-2 state; it does not attempt a lossy in-progress-game conversion.

Language remains `zh` for dictionary records, Saved Words, and language selection. Gameplay analytics additionally record `puzzleVariant` so Hanzi-era and Pinyin-era results are not combined. Existing Saved Words stay accessible because their canonical identifiers remain Hanzi dictionary identifiers.

Engine, server, client, and bot protocol changes must ship together. A version mismatch fails closed with an unsupported-puzzle-version error rather than interpreting a Hanzi state as Pinyin or vice versa.

## Interface and Responsive Behavior

Implementation stays in the shipped vanilla runtime: `client/main.js`, `client/style.css`, and `server/server.js`. Inactive React sources are not the target.

The redesign reuses the existing:

- typography and color tokens;
- correct, present, and absent tile treatments;
- tile flip and solved-board motion;
- keyboard styling and four-board key indicators;
- hint sheet, result sheet, and learning-card components;
- spacing scale, radii, shadows, and iconography;
- focus treatment, reduced-motion behavior, and accessibility patterns; and
- `visualViewport`, safe-area, and Discord embedded-mobile handling.

No new visual theme is introduced.

### Adaptive-hybrid layout

- Desktop and sufficiently wide layouts retain the polished 2x2 overview.
- On narrow screens, 5-letter games default to Overview.
- On narrow screens, 6- and 7-letter games default to Focus.
- Overview/Focus is always available while the game is active.
- A manual choice persists for the current round and overrides the default.
- Focus shows one full-size board and a four-board status/navigation strip.
- Selecting a focus board also selects it for hints.
- Switching views changes presentation only; the same shared draft and submitted guesses render on all boards.
- Layout choice is based on measured available tile space, viewport, and safe areas, not `100vh` or a hard-coded Discord offset.

### Hint presentation

- The existing hint sheet contains the three selectable options with visible point costs.
- A used syllable-boundary hint adds a polished divider at the target-specific boundary across that board's grid without changing stored guesses.
- A revealed letter appears as a persistent ghost marker aligned to the correct column, visually distinct from evaluated green/yellow/gray tiles and from typed draft letters.
- The ghost marker has an accessible label such as “Hint: letter E in position 3.”
- Broad meaning uses the existing hint-result treatment.
- Used and unavailable hints expose their state visually and through accessible text.

### Input and learning presentation

- The Hanzi/Pinyin mixed input and candidate-list interface is removed.
- The on-screen keyboard is QWERTY and includes `V` for `ü`.
- The current normalized draft fills letter tiles in both Overview and Focus.
- Invalid input preserves the draft and uses existing inline status/error styling.
- Solving a board reveals the intended Hanzi, marked Pinyin, tones, and broad meaning using the current solved-board and learning-card polish.
- Post-game review, dictionary, and Saved Words continue to use the canonical Hanzi dictionary entry.

## Error Handling

- Missing or contradictory answer metadata is a generator/verification failure, not a runtime fallback.
- A length bucket with fewer than four unique eligible answers cannot be enabled.
- Invalid Pinyin returns a stable invalid-format or not-in-list error without changing guess count.
- Hint requests against invalid board indices, solved boards, completed games, wrong variants, or unavailable reveal-letter states fail without charging points.
- Duplicate hint requests return their original persisted result.
- Network failure leaves the local draft intact and does not render an unconfirmed result.
- Legacy or unknown puzzle versions are rejected explicitly.

## Verification Plan

### Dictionary and corpus

- Verify every answer has exactly two syllables and complete learning metadata.
- Verify playable-key uniqueness for answers and intentional deduplication for guesses.
- Verify boundary indices, lengths, `v/ü` handling, and enabled buckets.
- Verify the generated catalog is deterministic from the checked-in source and curated seeds.
- Verify no retired full-Pinyin hint metadata remains in the compact hint contract.

### Engine

- Test 5-, 6-, and 7-letter game creation, validation, submission, solving, and nine-guess completion.
- Test duplicate-letter evaluation across representative Pinyin keys.
- Test plain, marked, numbered, spaced, decomposed-Unicode, `ü`, `u:`, and `v` input.
- Test rejection of malformed tone numbers, mixed Hanzi/Latin input, and unsupported punctuation.
- Test deterministic same-length daily targets and unchanged English/Korean historical fixtures.
- Test homophone guess collapsing and answer-key uniqueness.
- Test all hint costs, payloads, availability rules, idempotency, and assistance metrics.
- Test that `reveal-letter` never reveals the last unresolved position.

### Server and protocol

- Run matching REST and WebSocket tests for join, restore, submit, invalid guess, hints, completion, and leaderboard updates.
- Verify invalid guesses and failed hints do not consume attempts or points.
- Verify versioned Redis/memory state keys and rejection of mismatched state.
- Verify repeated hint requests retain one charge and one original payload.
- Verify analytics distinguish `pinyin-latin-v2` from legacy Chinese games.

### Client

- Test removal of candidate-selection behavior and direct Pinyin submission.
- Test keyboard and physical-input normalization, including `V/ü`.
- Test draft preservation after local and server rejection.
- Test Overview/Focus defaults, manual overrides, board selection, and shared guesses.
- Test boundary dividers, ghost-letter clues, costs, unavailable states, and accessible announcements.
- Test solved-board and post-game learning content.

### Visual and accessibility matrix

Manually verify 5-, 6-, and 7-letter rounds in Overview and Focus across:

- desktop 2x2 layouts;
- tablet widths;
- 320px and 360px mobile widths;
- short-height mobile frames;
- Discord embedded mobile;
- safe-area insets and visible/hidden virtual keyboard states;
- reduced motion; and
- keyboard-only and screen-reader navigation.

The visual review must confirm tile legibility, no clipped keyboard or controls, preserved styling, clear selected-board state, and no confusion between a ghost hint and evaluated feedback.

### Completion gate

Before implementation is called complete:

- engine, client, and server test suites pass;
- Chinese and Korean dictionary verifiers pass;
- the production client build passes;
- `git diff --check` passes;
- the responsive visual matrix is exercised; and
- leakage checks confirm that no single hint yields the complete enterable answer.

Production deployment and hosted verification remain a separate authorized step.
