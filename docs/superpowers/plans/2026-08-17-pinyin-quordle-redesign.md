# Pinyin Quordle Redesign Implementation Plan

> **Execution:** Implement directly on the current `main` checkout with the user's explicit approval. Preserve all pre-existing `.superpowers/` artifacts. Commit each independently passing task locally. Do not push, deploy, or claim hosted Discord verification.

**Goal:** Replace the shipped Chinese Hanzi puzzle with authoritative, variable-length Latin-letter Pinyin gameplay while retaining canonical Hanzi learning identity and preserving English/Korean behavior.

**Architecture:** Generate a compact answer catalog and length-sharded guess keys from checked-in Chinese data, then make the engine the single source of truth for parsing, selection, validation, evaluation, and hints. Version every Chinese gameplay boundary with `pinyin-latin-v2`, and update the shipped vanilla client to render normalized Pinyin through an adaptive Overview/Focus layout while resolving learning data by canonical Hanzi `targetId`.

**Tech stack:** TypeScript engine, Node/Express/WebSocket server, vanilla JavaScript/Vite client, Redis-compatible persistence, Node test runner.

## Global Constraints

- The shipped runtime is `client/main.js`, `client/style.css`, and `server/server.js`; inactive React sources are not an implementation target.
- Preserve the checked-in Chinese dictionary snapshot/pruning pipeline and deterministic generated artifacts. Do not require a network fetch or an unavailable external dictionary source to regenerate the Pinyin catalog from the current checkout.
- Add `PINYIN_PUZZLE_VARIANT = "pinyin-latin-v2"` and `ENABLED_ZH_PINYIN_LENGTHS = [5, 6, 7]`. The engine validates lengths 4 through 9, but selectors enable only 5, 6, and 7.
- For Pinyin boards, `targetWord` is the playable normalized Pinyin key and `targetId` is the canonical Hanzi learning identifier. The Hanzi word is the stable answer `id` and Saved Words identifier.
- New Chinese gameplay requests require exactly `puzzleVariant: "pinyin-latin-v2"`. Unsupported, missing, legacy, or unknown variants fail closed with `UNSUPPORTED_PUZZLE_VERSION`.
- REST and WebSocket share one authoritative guess transition and identical `INVALID_FORMAT`, `INVALID_LENGTH`, `NOT_IN_LIST`, and `UNSUPPORTED_PUZZLE_VERSION` codes.
- New Chinese hints are only `syllable-boundary` (cost 2), `reveal-letter` (cost 5), and `broad-meaning` (cost 7). New Pinyin games use assistance scoring version 2; version 1 remains readable for Korean and legacy Hanzi history.
- Version Chinese room, player, Redis, leaderboard, completion-dedupe, local-storage, and round identifiers with `pinyin-latin-v2`. Leave legacy unsuffixed Hanzi state untouched and never restore it into the new game.
- Preserve source drafts after local rejection, server rejection, and network failure. Clear only after confirmed submission, and block duplicate Enter presses while pending.
- Reuse the existing dark palette, typography, tile colors, spacing, radii, shadows, icons, motion, focus, reduced-motion, `visualViewport`, safe-area, and Discord embedded-mobile handling. Do not introduce a new theme or new raster art.
- Treat `.superpowers/brainstorm/1417-1786946097/content/pinyin-board-layout.html` as the approved layout companion, not as a palette/theme reference. The existing production style tokens govern visual treatment.
- Follow red-green-refactor. Every new behavior needs a focused test that is observed failing for the intended reason before production code is written, followed by focused green and stage-wide verification.

## Task 1: Generate the Pinyin catalog and implement strict input grammar

**Files:**

- Create or extend the generator under `engine/scripts/` so it reads checked-in Chinese dictionary shards plus `engine/src/zhHintClues.seed.json` and emits deterministic Pinyin puzzle artifacts without requiring a new source download.
- Create a compact generated answer catalog in `engine/src/` containing all 64 curated answers.
- Create deterministic generated guess-key shards for normalized lengths 4 through 9 in a dedicated `engine/src/` subdirectory.
- Add a server-side aggregate module that imports all guess-key shards.
- Modify `engine/src/pinyin.ts`, `engine/src/chineseLexicon.ts`, engine exports, generator/verification scripts, and focused engine tests.
- Retire the compact initials/tone/first-character hint metadata from generated puzzle artifacts while retaining the dictionary Pinyin index for learning surfaces.

**Required behavior:**

- Export `PINYIN_PUZZLE_VARIANT`, `ENABLED_ZH_PINYIN_LENGTHS`, `ChinesePinyinPuzzleAnswer`, `ChinesePinyinRound`, and `parseChinesePinyinInput`.
- Each answer record uses Hanzi as both stable `id` and learning identifier and includes Hanzi, playable key, marked and numeric Pinyin, two tones, boundary index, curated broad meaning, length, and `answerEligible: true`.
- Fail generation for incomplete/two-syllable-invalid metadata, unsupported lengths, bad boundaries, duplicate answer keys, or answers missing from the accepted Pinyin guess set.
- Deduplicate homophonous dictionary entries into one playable guess key. Produce complete unique key sets for lengths 4 through 9.
- `parseChinesePinyinInput` accepts plain, marked, numbered, decomposed-Unicode, spaces/apostrophes/hyphens/middle dots, and `ü`/`u:`/`v`; returns the lowercase tone-insensitive `a-z` key with `v` for `ü` plus the parsed two-syllable structure needed by callers.
- Numeric input must contain exactly two independently well-formed tone-number syllables. Reject unsupported digits, missing/extra tone numbers, mixed tone digits and marked vowels, Hanzi/mixed scripts, and arbitrary punctuation rather than silently discarding them.
- Add deterministic generator and verifier coverage for the current distribution `4:6, 5:15, 6:14, 7:20, 8:7, 9:2`, 64 unique answer keys, boundaries, `v/ü`, and homophone guess deduplication.

**Verification and commit:**

- Run the focused parser/catalog tests red then green.
- Run the Chinese dictionary generator in checked-in-data mode twice and verify no second-run diff.
- Run the engine suite and both dictionary verifiers.
- Run `git diff --check` and commit the passing stage locally.

## Task 2: Make engine state, selection, validation, evaluation, and hints authoritative

**Files:**

- Modify `engine/src/types.ts`, `engine/src/languageConfig.ts`, `engine/src/daily.ts`, `engine/src/game.ts`, `engine/src/assistance.ts`, `engine/src/chineseHints.ts`, exports, and focused engine tests.
- Remove runtime dependence on the retired compact Chinese hint metadata.

**Required behavior:**

- Make `GameState.wordLength` required and add optional `GameState.puzzleVariant`; add optional `BoardState.targetId`.
- Export `getDailyChinesePinyinRound`, `getPracticeChinesePinyinRound`, `validateGuessForGame`, and `applyValidatedGuess`.
- Daily Chinese selection uses seed `${dateKey}:zh:pinyin-latin-v2`: select length uniformly from `[5, 6, 7]`, deterministically shuffle that bucket, and take four unique answer keys and IDs. Practice follows the same length-first rule. English and Korean seeds/fixtures stay unchanged.
- Pinyin games use nine guesses for every enabled length and the existing duplicate-aware two-pass letter evaluator for 4 through 9 letters.
- Validation applies the strict parser, current game length, and generated guess set, returning stable `INVALID_FORMAT`, `INVALID_LENGTH`, or `NOT_IN_LIST` failures without consuming a guess.
- `applyValidatedGuess` is the only state transition that appends an already validated normalized key and evaluates all boards.
- Implement persisted idempotent hints for unsolved boards: boundary index cost 2; lowest target position never green with typed `{ index, letter }` cost 5 and unavailable when fewer than two unresolved positions remain; broad meaning cost 7.
- New Pinyin assistance state uses scoring version 2 and typed variant-specific payloads. Preserve normalization/readability of version-1 Korean and legacy Hanzi assistance history. Retired Chinese hints cannot be requested in new games.

**Verification and commit:**

- Observe focused selector, dynamic-state, validation/evaluation, duplicate-letter, hint, idempotency, and legacy-normalization tests fail before implementation and pass afterward.
- Cover 5/6/7-letter creation/submission/completion, engine-supported 4/8/9 validation, deterministic fixtures, homophones, every hint rule, and unchanged English/Korean fixtures.
- Run the full engine suite, `git diff --check`, and commit the passing stage locally.

## Task 3: Version and unify server protocol, persistence, analytics, learning, and bot behavior

**Files:**

- Modify `server/server.js`, server persistence helpers/tests, `server/learningData.js`, analytics tests, `server/bot.js`, and any focused shared server helper modules needed to avoid duplicated protocol logic.

**Required behavior:**

- Remove duplicated Chinese selection, validation, evaluation, and state-creation assumptions in favor of the Task 2 engine APIs.
- Route REST and WebSocket submissions through the same authoritative validation and `applyValidatedGuess` transition.
- Require `puzzleVariant: "pinyin-latin-v2"` on Chinese JOIN, GUESS, INVALID_GUESS_ATTEMPT, and HINT requests. Return identical stable error codes over REST and WebSocket.
- Namespace Chinese rooms, players, Redis state, leaderboard entries, completion dedupe, and round identifiers with `pinyin-latin-v2`; never read legacy unsuffixed Hanzi state for a Pinyin join.
- Add `puzzleVariant` to gameplay analytics. Record valid Pinyin guesses using `guessKey`; record solved/failed and Saved Words events using canonical Hanzi `targetId`.
- Store Pinyin aggregates separately. Chinese summaries default to `pinyin-latin-v2`; explicit `puzzleVariant=hanzi-v1` reads legacy aggregates without combining them.
- Mark Saved Words recall only when the corresponding canonical target becomes newly solved, so a submitted homophone never creates false recall.
- Update bot room/player leaderboard reads and completion events to use the versioned Chinese namespace.
- Preserve Korean/English protocols and readable version-1 historical records.

**Verification and commit:**

- Add REST/WebSocket parity tests for join, restore, submit, invalid format/length/list/version, hint idempotency/unavailability, completion, analytics, and leaderboards.
- Verify rejected guesses consume no attempts, failed hints consume no points, legacy state is not restored, aggregates remain isolated, homophones do not produce false recall, and English/Korean tests stay green.
- Run the engine build required by the server, the full server suite, relevant engine tests, `git diff --check`, and commit the passing stage locally.

## Task 4: Replace the vanilla client's Hanzi candidate workflow with resilient Pinyin gameplay

**Files:**

- Replace or refactor `client/src/chineseInput.js` and its tests.
- Modify `client/src/chineseDictionary.js`, `client/main.js`, local-storage/round helpers, hint client contracts as needed, and focused client tests.
- Remove active Hanzi candidate-selection and per-guess pronunciation UI from the shipped vanilla runtime.

**Required behavior:**

- Maintain a Chinese draft state with original source text, normalized tile text, validation status, and pending-submission state.
- Lazy-load only the active Pinyin guess-key length in the client. Reject locally with the engine parser/key set when possible and never submit a known invalid draft.
- Preserve the exact source draft after local rejection, server rejection, and network failure. Clear only after confirmed authoritative submission. Ignore duplicate Enter presses while pending.
- Send `puzzleVariant: "pinyin-latin-v2"` on every Chinese JOIN, GUESS, INVALID_GUESS_ATTEMPT, and HINT request over both REST and WebSocket paths.
- Render normalized Latin letters in every board and use the existing QWERTY keyboard including `V`; remove the Hanzi candidate picker, per-guess Hanzi candidate label, and per-tile pronunciation UI.
- Resolve solved cards, dictionary access, post-game review, and Saved Words through `targetId`. During active play reveal only solved targets; after completion reveal all targets.
- Version Chinese local-storage, round, completion, and draft identifiers with `pinyin-latin-v2`, without deleting or interpreting old unsuffixed Hanzi data.
- Preserve English/Korean input, rendering, and storage behavior.

**Verification and commit:**

- Add focused tests for direct Pinyin input, source/normalized drafts, marked/numbered/`v` handling, active-length lazy loading, local/server/network rejection, pending duplicate Enter, canonical learning lookup, variant payloads, and versioned storage.
- Run the full client suite, engine suite as needed, production client build, `git diff --check`, and commit the passing stage locally.

## Task 5: Implement adaptive Overview/Focus layout and accessible hint rendering

**Files:**

- Modify `client/src/boardLayout.js`, `client/src/hintUi.js`, `client/main.js`, `client/style.css`, and focused client tests.
- Reuse the approved layout companion at `.superpowers/brainstorm/1417-1786946097/content/pinyin-board-layout.html` for layout anatomy while retaining the existing production tokens and theme.

**Design inventory and required behavior:**

- Primary surfaces remain the existing game shell, header controls, 2x2 board overview, QWERTY keyboard, hint sheet, solved compact history, result sheet, and learning cards. New components are only an Overview/Focus control and four-board focus status strip.
- Default to Overview when the measured estimated 2x2 tile width is at least 24 CSS pixels; otherwise default to Focus. The measurement must account for available width/safe areas and the current word length, not `100vh` or a hard-coded Discord offset.
- A manual Overview/Focus choice remains available during an active game and persists only for the current versioned round.
- Focus renders one full-size unsolved board plus a four-board status/navigation strip. Selecting an unsolved item also sets the hint target; selecting a solved item opens its compact history.
- Switching layouts changes presentation only: all four boards retain the same confirmed guesses and normalized shared draft.
- Render target-specific syllable-boundary dividers across the selected board grid when used.
- Render persistent reveal-letter ghost markers at the supplied column, visually distinct from draft and evaluated tiles, without changing stored guesses. Include an accessible label such as `Hint: letter E in position 3.`
- Show the three hint options and costs in the existing sheet; expose used/unavailable states visually and to assistive technology. Broad meaning uses the existing result treatment.
- Preserve existing palette, type, feedback colors, keyboard four-board indicators, motion, `prefers-reduced-motion`, focus styles, safe-area and `visualViewport` behavior.

**Verification and commit:**

- Add focused tests for the 24px threshold, 5/6/7-letter defaults, manual round-local override, focus navigation/hint targeting, solved history, shared draft/guesses, boundary dividers, ghost labels, and unavailable hint states.
- Run the full client suite and production build, then the engine and server suites, both dictionary verifiers, and `git diff --check`.
- Commit the passing stage locally.

## Final Verification (Controller Gate)

- Run fresh engine, client, and server suites; both dictionary verifiers; production client build; generated-artifact determinism check; and `git diff --check`.
- Run a broad whole-branch review against the approved design and this plan. Fix and re-review all load-bearing findings.
- Use the in-app Browser first for desktop, tablet, 320px and 360px mobile, short-height, reduced-motion, keyboard-only, simulated Discord safe-area, and virtual-keyboard states across 5/6/7-letter games and Overview/Focus.
- If Browser cannot connect, record the exact failure and use the user-approved Playwright fallback with all temporary tooling/screenshots outside the repository.
- Capture the approved layout companion and rendered implementation, inspect both with `view_image`, and keep a mismatch ledger covering layout, typography, existing palette/tokens, tile sizing, hint treatments, controls, responsiveness, copy, and interaction state. Fix all material mismatches before completion.
- Remove temporary QA artifacts, preserve pre-existing `.superpowers/` design files, and leave commits local on `main` without pushing or deploying.
