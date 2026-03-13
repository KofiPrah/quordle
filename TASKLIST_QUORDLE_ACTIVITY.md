# TASKLIST_QUORDLE_ACTIVITY.md

## Project

Discord Quordle Activity - UX Improvements and Bug Fixes

## Repo Reality Check

Before touching any task, orient to the actual runtime:

- Primary client runtime: `client/main.js`
- Primary client styling: `client/style.css`
- Primary server runtime: `server/server.js`
- Shared game logic and tests: `engine/src/*`, `engine/test/*`

Important: `client/src/components/*` and `server/src/*` exist, but the current shipped app flow is largely driven by `client/main.js` and `server/server.js`. Do not start in the React component tree unless you first confirm the code path is active.

## Standard Validation After Each Task

Run the smallest relevant checks after each change:

```powershell
cd engine; npm test
cd client; npm run build
cd server; npm run typecheck
```

If you change `server/server.js`, also do a runtime syntax smoke check:

```powershell
cd server; node --check server.js
```

## Manual Viewport Matrix

Use this matrix for UI tasks:

- Desktop: `1440x900`
- Tablet portrait: `768x1024`
- Mobile portrait: `390x844`
- Narrow mobile: `360x740`
- Short landscape / Discord-like constrained view: `844x390`

## Global Constraints

- Keep English and Korean daily state isolated.
- Do not break practice mode while fixing daily mode.
- Do not regress WebSocket-first persistence.
- Prefer targeted edits in existing runtime files over broad refactors.
- If you add debug logs for a bug hunt, remove them before finalizing the PR unless the log is intentionally guarded by a debug flag.

## Suggested Execution Order

1. Task 4 - Fix incorrect Game Over state on Korean return
2. Task 5 - Fix mobile keyboard shift toggle
3. Task 6 - Increase mobile keyboard key size
4. Task 1 - Reduce board/leaderboard spacing
5. Task 3 - Allow background phone audio
6. Task 2 - Implement session timeout handling

---

# TASK 1 - Reduce Vertical Spacing Between Game Board and Leaderboard

**Priority:** Medium  
**Type:** UI/UX polish

## Why This Task Exists In This Repo

The board/leaderboard spacing is controlled almost entirely by CSS in `client/style.css`. The main layout is a CSS grid rendered from `client/main.js`:

- `client/main.js`: renders `.boards-grid` and `.leaderboard-panel`
- `client/style.css`: controls grid gap, panel spacing, mobile stack order, and leaderboard sizing

## Primary Files To Inspect

- `client/style.css`
- `client/main.js`

## Search Queries

```powershell
rg -n "boards-grid|leaderboard-panel|leaderboard\\+|grid-template-areas|board-gap|gap:" client/style.css
rg -n "leaderboard-panel|boards-grid|renderLeaderboardContent" client/main.js
```

## Likely CSS Entry Points

Focus here first:

- `.quordle-container`
- `.boards-grid`
- `.leaderboard-panel`
- `.leaderboard`
- `.leaderboard + .leaderboard`
- Mobile media blocks:
  - `@media (max-width: 700px)`
  - `@media (max-height: 500px)`
  - `@media (max-width: 480px) and (max-height: 700px)`

## Implementation Notes

- The vertical separation is likely coming more from container `gap` and stacked mobile panel sizing than from the board itself.
- Reduce spacing by tightening parent layout spacing before shrinking internal leaderboard content.
- Prefer adjusting existing CSS variables and shared spacing rules instead of adding one-off pixel overrides.
- On mobile, the board and leaderboard are on separate rows. Tune the handoff between `"main"` and `"sidebar"` rather than only changing leaderboard padding.

## Acceptance Tests

- Board and leaderboard feel visually grouped.
- Mobile no longer shows a large dead band between board and leaderboard.
- No overlap, clipping, or scroll-trap issues.
- Desktop and tablet layouts still preserve clear separation of sections.

## Manual Verification

- Compare before/after at `1440x900`, `768x1024`, `390x844`, and `844x390`.
- Confirm the leaderboard remains usable when it horizontally scrolls on mobile.

---

# TASK 2 - Implement Session Timeout Handling

**Priority:** Medium  
**Type:** Reliability

## Why This Task Exists In This Repo

There is no dedicated `sessionManager` module yet. Session persistence currently lives inside `client/main.js` through `saveGameState()` / `loadGameState()` and localStorage keys like:

- `quordle_daily_${currentLanguage}`
- `quordle_practice_${currentLanguage}`
- `quordle_language`

This task should be implemented in the current client runtime, not in a nonexistent `/state/sessionManager.*`.

## Primary Files To Inspect

- `client/main.js`
- `client/style.css` if a timeout UI/banner/modal is needed
- `server/server.js` only if you intentionally make timeout behavior server-aware

## Search Queries

```powershell
rg -n "saveGameState|loadGameState|clearGameStorage|beforeunload|visibilitychange|sendBeacon" client/main.js
rg -n "localStorage|quordle_daily_|quordle_practice_|quordle_language" client/main.js
rg -n "JOIN|STATE|serverJoinGame|serverSubmitGuess" client/main.js
```

## Implementation Shape

Start with a client-side inactivity model:

- Add a configurable timeout constant, default `45 * 60 * 1000`
- Track `lastActiveAt`
- Update activity timestamp on:
  - pointer/touch interaction
  - on-screen keyboard presses
  - physical keyboard input
  - visibility return to foreground
- Persist timeout metadata with the saved game snapshot

## State To Save

- `gameState`
- `gameMode`
- `language`
- `dateKey`
- `lastActiveAt`

## Recommended Behavior

- On inactivity expiry, save the latest state snapshot first
- Route the user out of the active session state
- Allow resume if a saved state still exists and is valid

Important constraint: this app does not currently have a dedicated "home screen". Do not overbuild routing if a lightweight expired-session state or resume prompt will solve it with lower risk.

## Edge Cases

- If WebSocket state arrives after a local timeout check, decide which source wins and keep that rule explicit.
- Daily mode must not accidentally resume yesterday's board.
- Practice mode timeout must not wipe daily state.
- If the tab is backgrounded, do not create a timer loop that hammers re-renders.

## Acceptance Tests

- A session expires after the configured inactivity threshold.
- State is saved before the timeout transition.
- The user can resume from a valid saved state.
- No corruption between practice/daily or English/Korean storage.

## Recommended Verification Strategy

Temporarily lower the timeout to `15-30` seconds during development, then restore `45 minutes` before merge.

---

# TASK 3 - Allow Background Phone Audio

**Priority:** Medium  
**Type:** Mobile UX

## Why This Task Is Tricky Here

The current app code does not appear to create an `AudioContext`, audio element, or video element. That means the interruption may be caused by Discord Activity embedding behavior rather than explicit app code.

Do not guess. First prove whether this repo is requesting audio focus at all.

## Primary Files To Inspect

- `client/main.js`
- `client/index.html`
- `client/package.json`

## Search Queries

```powershell
rg -n "DiscordSDK|ready|authorize|authenticate|AudioContext|audio|video|autoplay" client/main.js client/index.html
rg -n "audio|video|focus|autoplay" client
```

## Current Relevant Code

Discord Activity bootstrapping is in `client/main.js`:

- `DiscordSDK` construction
- `discordSdk.ready()`
- `discordSdk.commands.authorize(...)`
- `discordSdk.commands.authenticate(...)`

There is no obvious in-app media initialization path today.

## Implementation Notes

- First confirm the app is not instantiating or resuming Web Audio anywhere.
- Do not add silent audio hacks, autoplay unlock shims, or hidden media elements.
- If the issue is tied to an SDK option or Activity capability, isolate the exact platform call before editing.
- If no app-side audio focus request exists, this task may be a platform limitation rather than a code bug.

## What A Good PR Looks Like

One of these outcomes is acceptable:

1. A real app-side focus request is found and removed.
2. A reproducible platform limitation is documented with evidence, and the task is marked blocked by Discord/iOS behavior.

Do not ship speculative changes that cannot be tied to the interruption.

## Acceptance Tests

- Launching the activity does not start or resume any app-owned audio context.
- External audio keeps playing if the platform permits it.
- If the issue is platform-owned, the PR clearly documents the limit and the code audit performed.

---

# TASK 4 - Fix Incorrect Game Over State When Returning To Korean Board

**Priority:** High  
**Type:** Gameplay bug

## Why This Task Exists In This Repo

There is a strong repo-specific root-cause signal already:

- Client local storage keys are language-specific:
  - `getStorageKeyDaily() -> quordle_daily_${currentLanguage}`
- WebSocket/Redis persistence is language-aware:
  - `makePlayerRedisKey(roomId, dateKey, visibleUserId, language)`
  - `makeRoomKey(roomId, dateKey, language)`
- But the legacy REST fallback store in `server/server.js` is language-blind:
  - `_makeKey(roomId, dateKey, userId) -> ${roomId}:${dateKey}:${userId}`
- Client restore also trusts stored payloads without validating the embedded language field.

This means English/Korean contamination is plausible even before looking at `gameOver`.

## Primary Files To Inspect

- `client/main.js`
- `server/server.js`
- `engine/src/game.ts`
- `engine/src/languageConfig.ts`
- `engine/test/korean.test.ts`
- `engine/test/game.test.ts`

## Search Queries

```powershell
rg -n "getStorageKeyDaily|loadGameState|switchLanguage|gameOver|saveGameState" client/main.js
rg -n "gameStateStore|_makeKey|api/game/join|api/game/guess|getPlayer\\(|makeRoomKey|makePlayerRedisKey" server/server.js
rg -n "createGame|submitGuess|maxGuesses|guessCount|gameOver|language" engine/src/game.ts engine/src/languageConfig.ts engine/test/korean.test.ts
```

## Reproduction Checklist

Reproduce exactly:

1. Finish an English daily game.
2. Switch to Korean.
3. Make fewer than 9 guesses.
4. Leave the activity.
5. Reopen later.
6. Check whether `gameOver` is true even though `guessCount < maxGuesses`.

Test both:

- WebSocket/Redis path available
- REST/local fallback path only

## Temporary Debug Logs To Add During Investigation

Log these values at restore/join time:

- `currentLanguage`
- `parsed.language`
- `parsed.gameState?.language`
- `guessCount`
- `maxGuesses`
- `gameOver`
- `roomId`
- `dateKey`

Suggested insertion points:

- `loadGameState()` in `client/main.js`
- `switchLanguage()` in `client/main.js`
- `gameStateStore.get/set()` in `server/server.js`
- `/api/game/join` and `/api/game/guess` in `server/server.js`

Remove or guard logs before finalizing.

## Likely Fixes

Apply the smallest set that fully closes contamination:

- Make the legacy REST store key language-aware, or eliminate the language-blind fallback entirely.
- Validate saved local payloads before restore:
  - reject if `parsed.language !== currentLanguage`
  - reject if `parsed.gameState?.language` mismatches
- Ensure `uiScreen = "results"` is only set after validating restored state.
- Keep `gameOver` derived from real state:
  - `allSolved || guessCount >= maxGuesses`

## Additional Regression Risk

`server/server.js` has two persistence paths:

- WebSocket/Redis path
- REST compatibility path

Fix both or you will leave a flaky reproduction path in place.

## Acceptance Tests

- Leaving and returning resumes the Korean game correctly.
- English and Korean daily states remain isolated.
- `gameOver` is false whenever `guessCount < maxGuesses` and not all boards are solved.
- `gameOver` only appears after the 9th guess or full solve.

## Preferred Regression Coverage

If practical, extract language-aware key generation into a pure helper and add test coverage around it. Engine tests alone will not catch a storage-key contamination bug.

---

# TASK 5 - Fix Mobile Keyboard Shift Toggle

**Priority:** Medium  
**Type:** UX bug

## Why This Task Exists In This Repo

The current Korean on-screen keyboard already renders a visible shift key, but it is effectively a no-op:

- `renderKoreanKeyboard()` includes a `SHIFT` key
- The shift-handling branch in `handleKeyPress(...)` immediately returns with comment "handled by the double consonant keys directly"
- CSS already contains `.key-shift.active`
- Physical keyboard uppercase mappings exist in `QWERTY_TO_JAMO`

This is a strong sign that the UI affordance exists, but the state model was never finished.

## Primary Files To Inspect

- `client/main.js`
- `client/style.css`

## Search Queries

```powershell
rg -n "renderKoreanKeyboard|QWERTY_TO_JAMO|handleKeyPress|keyboard-ko" client/main.js
rg -n "key-shift|ko-shift-row|active" client/style.css
```

## Implementation Notes

Add an explicit Korean shift state in the client runtime, for example:

```text
let koreanShiftActive = false;
```

Expected behavior:

- Tapping the shift key toggles the state
- Key labels update visually
- The next consonant press can emit doubled consonants where appropriate
- The shift key visually reflects active/inactive state

Consistency requirement:

- The on-screen mobile behavior should match the existing physical keyboard uppercase mapping as closely as possible

## Low-Risk Approach

- Keep the existing Korean keyboard layout shape
- Swap the affected key labels when shift is active instead of redesigning the keyboard
- Reuse existing CSS hooks like `.key-shift.active`

## State Reset Guidance

Decide and document whether shift should:

- auto-reset after one shifted consonant, or
- remain sticky until toggled off

Auto-reset is likely the least surprising mobile behavior.

## Acceptance Tests

- The shift key toggles reliably on mobile.
- The keyboard visibly shows active shift state.
- Shifted key output is correct on iOS and Android.
- Physical keyboard Korean input behavior remains unchanged.

---

# TASK 6 - Increase Mobile Keyboard Key Size

**Priority:** Medium  
**Type:** UX improvement

## Why This Task Exists In This Repo

The current keyboard sizing is driven by CSS custom properties in `client/style.css`, with multiple mobile-specific overrides already in place. This task should be solved by tuning those variables rather than rewriting layout markup.

## Primary Files To Inspect

- `client/style.css`

## Search Queries

```powershell
rg -n -- "--key-height|--key-min-width|--key-font-size|--key-padding|key-wide|keyboard-row" client/style.css
```

## Main CSS Knobs

Desktop/base variables:

- `--key-height`
- `--key-min-width`
- `--key-font-size`
- `--key-padding`

Mobile override blocks to adjust first:

- `@media (max-width: 700px)`
- `@media (max-width: 480px)`
- `@media (max-height: 600px)`
- `@media (max-height: 500px)`
- `@media (max-width: 480px) and (max-height: 700px)`

Also review:

- `.keyboard`
- `.keyboard-row`
- `.key-wide`

## Implementation Notes

- Increase tap target size using the existing CSS variables.
- Keep QWERTY rows intact.
- Make `ENTER`, `BACKSPACE`, and Korean shift keys scale proportionally with the rest of the row.
- Validate short-height layouts carefully so larger keys do not push the keyboard off-screen or create horizontal overflow.

## Suggested Tuning Order

1. Raise mobile `--key-height`
2. Slightly raise mobile `--key-min-width`
3. Rebalance `--key-padding`
4. Adjust `.key-wide` only if special keys stop fitting

## Acceptance Tests

- Keys are noticeably easier to tap on mobile.
- No horizontal overflow or row wrapping occurs.
- Keyboard remains fully visible on common iPhone-size viewports.
- Short landscape layouts stay usable.

---

## Notes For The Agent Implementing These Tasks

- Treat `client/main.js`, `client/style.css`, and `server/server.js` as the source of truth for current behavior.
- For Task 4, start with the language-blind REST fallback key in `server/server.js` before chasing engine logic.
- For Task 5 and Task 6, prefer incremental changes to the existing keyboard rendering/CSS instead of introducing a new component system.
- For Task 3, prove causality before editing anything. A clean "platform limitation" PR is better than a speculative code change.
