# Project Context — College Cricket Tournament PWA

Generated from a full read of every tracked file (no tests exist, nothing was executed).
Line numbers in §5 refer to the `main` branch at commit `08189c0` (the audit baseline).

> **Status update:** all seven P0 items (1-7) and the related items 20, 23 and parts of 25-26 have been fixed in the working tree (not yet committed/deployed). They are marked **FIXED** below. **Before deploying, set `STAFF_PASSWORD` in Vercel** (see README) or nobody will be able to sign in. The old password `sitare@2029` is in git history and must be treated as compromised. `npm test` runs 13 tests covering the new sync/auth behaviour.

---

## 1. What this is

A mobile-first, zero-build **Progressive Web App** for running a college cricket tournament (Sitare college).
Four official squads (55 preloaded players), ball-by-ball live scoring for umpires, a public live scoreboard,
points table with ICC-style Net Run Rate, match history/scorecards, and player leaderboard.

- Live site: https://sitarekcirc.vercel.app
- Repo: https://github.com/Golden8922/cricket-tournament
- Stack: plain HTML/CSS/vanilla JS (global objects, no modules, no bundler), one Vercel serverless function, Vercel Blob for shared state. Optional Firebase/Firestore path (largely dead, see §6).
- Only runtime dependency: `@vercel/blob` (used by `api/sync.js`). No test, lint or build tooling.

## 2. File map

| File | Size | Role |
|---|---|---|
| `index.html` | 53 KB | Single page: 6 view panels (live, table, teams, players, history, scoring), bottom nav, ~12 modals. Loads Firebase compat SDK from gstatic, then `seed → engine → teams → db → app`. |
| `js/app.js` | 117 KB | `App` object: all UI rendering, event wiring, scoring console, modals, toasts. Renders by building HTML strings into `innerHTML`. |
| `js/db.js` | 25 KB | `AppDB`: localStorage persistence, cloud sync (poll + push), fake auth, Firebase hooks, CRUD for players/teams/matches. |
| `js/engine.js` | 21 KB | `CricketEngine`: pure functions — `replayInnings` (derives everything from the ball list), result text, points table + NRR, aggregate player stats, rating formula. |
| `js/teams.js` | 5 KB | `TeamEngine`: auto-balance / re-shuffle (snake draft), team stats, `movePlayer`. Only `calculateTeamStats` and `movePlayer` are used by the UI. |
| `js/seed.js` | 11 KB | Official 4 teams + 55 players (`getInitialTournamentData()`), starts with zero matches. |
| `api/sync.js` | 2 KB | `GET` = read latest `tournament_state.json` blob; `POST` = overwrite it. No auth. |
| `sw.js` | 2 KB | Service worker, cache `college-cricket-v1`, stale-while-revalidate for same-origin. |
| `css/styles.css` | 33 KB | Theming (dark / outdoor / light via `data-theme`), all components. |
| `firestore.rules` | 2 KB | Rules for the optional Firebase backend (not in use). |
| `vercel.json` | | Clean URLs, basic security headers, no-cache for `sw.js`. |
| `manifest.json`, `icons/` | | PWA manifest, SVG + JPG icons. |
| `start.bat` | | Local static server (python → node → file://). |
| `README.md` | | User-facing docs (partly stale, see §5). |

## 3. Architecture & data flow

```
 Browser (every device)                         Vercel
 ┌──────────────────────────┐   POST /api/sync   ┌────────────────┐
 │ localStorage = source of │ ─────────────────► │ api/sync.js    │──► Blob: tournament_state.json
 │ truth for the UI         │                    └────────────────┘         (public, overwritten)
 │  cct_players/teams/      │   GET (every 2 s)  direct CDN URL (hardcoded) ◄─┘
 │  matches/auth/last_sync  │ ◄───────────────────────────────────────────
 └──────────────────────────┘      fallback: GET /api/sync
```

- **Whole-state sync.** Every mutation writes localStorage, then `pushToCloud()` POSTs `{players, teams, matches, updatedAt}` (the *entire* state, every ball). Every client polls the blob's public CDN URL every 2 s (`db.js:16-20`, `startRealtimeSync` `db.js:129`) and replaces local data when `remote.updatedAt > localStorage.cct_last_synced_at`.
- **Cross-tab:** `BroadcastChannel('cricket_tournament_sync')`.
- **UI refresh:** `AppDB.subscribe(entity, cb)` → `App.on{Players,Teams,Matches}DataChanged` re-render views.
- **Auth is client-side only** (`AppDB.login`, `db.js:684`): any name + the shared password → `{role}` saved to `localStorage.cct_auth_user`. `isStaff()` just reads that object.
- **Routing:** hash-based (`#live`, `#table`, `#teams`, `#players`, `#history`, `#score`). Only `view-scoring` is gated.

### Data model (all JSON in localStorage / the blob)

- **Player:** `{id, name ("Ritik 3"), fullName, roll, role, year, exp, bat, bowl, field, keeper, isCaptain, isViceCaptain, createdAt}`
- **Team:** `{id, name, motto, captain/viceCaptain (seed: names) | captainId/viceCaptainId (UI: ids), playerIds[]}`
- **Match:** `{id, teamA, teamB (NAMES, not ids), teamAPlayerIds, teamBPlayerIds, overs, currentInnings, status:'live'|'done', strikerId, nonStrikerId, bowlerId, balls[], result, nrrData, createdAt, updatedAt}`
- **Ball:** `{id, innings, batterId, nonStrikerId, bowlerId, runs, extraType: null|wide|noball|bye|legbye|penalty, isWicket, wicketType, outPlayerId, isLegal, totalRuns, isDroppedCatch, snapshot{striker,nonStriker,bowler,innings}, timestamp}`
- Scorecards, NRR, leaderboards and the points table are **all derived** by replaying `balls` (`CricketEngine.replayInnings`).

### Scoring flow (`app.js`)

`recordDelivery` (1301) / `recordExtraRuns` (1397) / `confirmWicketSubmission` (1591) / `confirmDeclareBatsman` (1497) mutate `activeScoringMatch` in memory, push a ball, rotate strike (odd runs, end of over), call `AppDB.updateMatch` → localStorage → cloud push → `checkAutoMatchCompletion` (1716) which auto-finishes the 2nd innings (target chased or innings over) and prompts to start the 2nd innings. `undoLastDelivery` (1666) pops the last ball and restores its `snapshot`.

### Roles as the code actually behaves

| Capability | Spectator | Umpire / Admin |
|---|---|---|
| View live / table / history / players / teams | yes | yes |
| Score matches | no (UI-gated) | yes |
| Add / edit / delete teams & players | **yes (not gated)** | yes |
| Admin vs Umpire difference | — | **none** (same password, role is a dropdown) |

## 4. Run / deploy

- Local: `start.bat` or `python -m http.server 8080`. **Note:** locally `/api/sync` does not exist, but `CDN_URL` is absolute, so a local run *reads production data* (and its pushes 404/501).
- Deploy: Vercel (static + `/api` function). `BLOB_READ_WRITE_TOKEN` must exist in the Vercel project (`.env*` is git-ignored).
- No CI, no tests (`npm test` is the default stub).

---

## 5. Where things need fixing (prioritised)

### P0 — can lose or corrupt tournament data / security holes

1. **FIXED — Cloud wipe on a failed fetch** — `db.js:202-209`. If both the CDN fetch and the API fetch *fail* (offline blip, blocked CDN, timeout), `remoteData` is `null` and the code treats it as "cloud is empty" and **pushes local state with a fresh `updatedAt`**. A new visitor (localStorage freshly seeded with 55 players / 0 matches) or any client with stale data can overwrite the real tournament, including all matches. Fix: distinguish *empty* (`status:'empty'` from the API) from *error*; only seed-push when the API explicitly says empty, never on network failure.
2. **FIXED — Unauthenticated write API** — `api/sync.js:5-7, 29-50`. `POST /api/sync` accepts any JSON from anyone (CORS `*`, no token, no schema/size validation). Anyone can wipe or replace the data with one curl. Fix: require a server-checked secret/token for POST (issued after a server-side login), validate shape, restrict CORS to the site origin.
3. **FIXED — Auth is cosmetic** — `db.js:692` hardcodes the password `sitare@2029` in client JS (and it is in the public repo's README, `README.md:41`); role is chosen from a dropdown; `localStorage.cct_auth_user` can be hand-edited. The README says the admin password is `si`, which the code does not implement. Fix: server-side auth (e.g. `/api/login` returning a signed token used by `/api/sync`), rotate the password since it is public in git history, drop the README credentials.
4. **FIXED — Stored XSS / broken handlers from names** — `escapeHtml` (`app.js:2690`) is used inside inline `onclick="...('${...}')"` attributes (`app.js:843, 860, 883-885, 903-905, 1979-1980, 2051, 2143, 2299, 2304, 2429-2435, 2533-2537`). `&#039;` is decoded by the HTML parser *before* JS runs, so a team/player name containing `'` (e.g. `Kings' XI`) breaks the button, and a crafted name executes JS for every viewer. Combined with P0-2 (anyone can write data) this is a remote stored XSS. Also unescaped in `innerHTML`: `p.role` (`app.js:678, 879, 2522`), `b.dismissal` (`2378`, contains `bowlerName` from stored balls), `b.text`/`tooltip` (`1286, 1925`), `p.id`/`match.id` in `onclick`. Fix: use `data-*` attributes + delegated event listeners (or `addEventListener`) instead of inline handlers, and escape every interpolated value.
5. **FIXED — Spectators can edit/delete teams and players** — `index.html:154-170, 197-216`, `app.js:792-912` render Add/Edit/Delete/Move controls for everyone; `confirmDeleteTeam` (`app.js:691`) and `AppDB.deleteTeam/updateTeam/renameTeam/addTeam/updatePlayer` (`db.js:453-541`) have no `isStaff()` check (only `createMatch/updateMatch/deleteMatch` do). `onAuthStateChanged` fetches `nav-item-teams` (`app.js:338`) but never uses it. Decide intent: if public player self-registration is wanted, still gate edit/delete/move/team ops to staff.
6. **FIXED — Offline / failed pushes are never retried** — `db.js:141-176`. `LAST_SYNC` is set to the new timestamp *before* the POST, and a failed/non-OK response is ignored. After an offline scoring session nothing is re-pushed until another mutation happens, and `pullFromCloud` won't re-push because local `LAST_SYNC` is newer. Fix: mark state dirty, retry with backoff / on `online`, only advance `LAST_SYNC` after a successful response.
7. **FIXED (partly) — Last-write-wins on the whole state, client clocks** — `updatedAt` is `Date.now()` from each device (`db.js:151`), and each push overwrites everything. Two staff devices (umpire scoring + someone editing a squad) silently clobber each other, and a device with a fast/slow clock can win or lose permanently. Fix: server-assigned version/timestamp, optimistic concurrency (`If-Match`/version in the POST), and/or separate blobs/endpoints for matches vs. squads (ideally append-ball API so scoring never overwrites other data).

### P1 — wrong cricket results / scoring logic

8. **"Declare/retire batsman" corrupts the innings** — `engine.js:86` computes `isLegal` from `extraType` only, ignoring `ball.isLegal === false`. The retired pseudo-ball (`app.js:1513-1527`, `wicketType:'retired'`) therefore counts as a *legal ball* (advances the over, bowler's balls, batter's balls, maidens) and as a *wicket* (`engine.js:184-186`, counted in `stats.wickets` → can trigger a premature all-out at `engine.js:285-287` and appears in fall of wickets). Also the retire ball has no `snapshot` (undo won't restore the striker) and no `timestamp`. Fix: treat retired/declared as a non-ball, non-team-wicket event in the engine; keep the batter out without incrementing `wickets`.
9. **Finishing early records a bogus result** — `handleFinishMatch` (`app.js:1786-1824`) allows finishing mid-innings; `generateMatchResultText` (`engine.js:420-438`) then returns the literal `"Match in progress"` as the final result, while `calculatePointsTable` (`engine.js:495-510`) still awards the win to team A. Matches finished before the 2nd innings also add 0 runs / 0 overs to team B's NRR. Fix: block or explicitly handle abandoned/no-result/DLS-style outcomes; never persist "Match in progress".
10. **Team rename/edit breaks history and the table** — matches store team **names** (`db.js:606-607`, `app.js:951-952`) and `calculatePointsTable` keys on `t.name` (`engine.js:445, 466-467`). `renameTeam` (`db.js:531`) and `updateTeam` (`db.js:492`, no duplicate-name check) change the name, so all earlier matches for that team stop counting; deleting a team does the same. Fix: store `teamAId/teamBId` on matches (keep names as display snapshot) and key the table by id.
11. **Wicket modal limitations** — `confirmWicketSubmission` (`app.js:1591-1663`): ignores an active modifier (no wicket on no-ball/free-hit, run-out on a wide), always `runs: 0` (no runs completed on a run-out), doesn't reset `currentModifier`, no timestamp. `fielder` for catches/stumpings is never captured (dismissal shows literal "c Fielder", "st Keeper", `engine.js:200-204`). Hit-wicket falls to the generic branch.
12. **No bowler rules** — nothing forces a new bowler at the end of an over, allows the same bowler for consecutive overs, and no per-bowler over quota (`recordDelivery`, `renderScoringConsole`).
13. **Repeated `confirm()` after 1st innings ends** — `checkAutoMatchCompletion` (`app.js:1744-1750`) prompts after *every* ball once the innings is over; cancelling doesn't lock further scoring. Add an "innings closed" state and block extra deliveries.
14. **All-out threshold with 14-player squads** — `engine.js:285`: `min(10, players-1)` = 10 wickets for 13–14 player squads; confirm that's the intended rule (street/college formats often use fewer, or "last man stands").
15. **Wide/no-ball extras are limited** — instant Wide is always `+1` (`app.js:979-983`); wide+boundary/overthrow runs and no-ball+bye can't be entered except via "Extra Runs" (which doesn't touch striker/bowler correctly).
16. **Undo edge cases** — can't undo a finished match (`status:'done'` isn't the active match); undo right after `startSecondInnings` reverts to innings 1 using the previous ball's snapshot; `confirmDeclareBatsman` plain-replace (no ball) can't be undone.

### P1 — seed/data consistency

17. **Captains/VCs don't show for seeded teams** — seed stores `captain`/`viceCaptain` as *name strings* (`seed.js:10-36, 140-141`) but the UI reads `captainId`/`viceCaptainId` (`app.js:828-829, 870-871`). Player `isCaptain`/`isViceCaptain` flags in the seed are unused too. Fix in `getInitialTournamentData()`: set `captainId`/`viceCaptainId` from the matching player ids.
18. **Year field mismatch** — seed `year` is a number (`seed.js:123`), the edit form's `<select>` expects `"1st Year"…"4th Year"` (`index.html:692-697`, `app.js:751`), so editing a seeded player shows the wrong year and saves a string. Normalise one representation.
19. **Placeholder data** — a player literally named `TBA 1` / "Player To Be Announced" (`seed.js:92`) and fake roll numbers `YR3-001…` (`seed.js:119`). Replace with real data before the tournament; roll-uniqueness is checked on add (`db.js:378`) but not on edit (`db.js:453`).
20. **FIXED — `updatePlayer` stores `teamId` on the player object** (`db.js:458`, patch includes `teamId`) — pollutes the record (and Firestore `update`), and edit/duplicate roll checks are absent.
21. **Deleting a player** leaves their id in past matches (scorecards show raw ids, `app.js:2377, 2414`) and, in Firebase mode, doesn't remove them from teams (`db.js:430-433`). Consider soft-delete.
22. **`ensureSeedData` "isOldData" heuristic** (`db.js:103`) will re-seed (wiping players/teams/matches locally) if a player named "Aarav Sharma" or id `p1` ever exists. Low risk, but remove the legacy hack.

### P2 — sync, PWA, infra

23. **FIXED — Service worker caches the API** — `sw.js:45-63` applies stale-while-revalidate to *all* same-origin requests including `GET /api/sync?_t=…` (unique URL each poll → cache bloat, stale fallback offline) and POSTs (`cache.put` on a POST throws an unhandled rejection). Bypass the SW for `/api/` and non-GET. Also bump `CACHE_NAME` per release (a cache-first shell can serve old JS mix, e.g. new `app.js` + old `db.js`).
24. **Cost / load of polling** — every viewer fetches the blob every 2 s forever (even in background tabs) and every ball re-uploads the full state incl. all `snapshot`s. Use `visibilitychange` to pause, back off, conditional requests (`ETag`), a lightweight `version` file or SSE/WebSocket, and drop `snapshot` from persisted balls (or keep only the last). Also watch Vercel Blob operation limits and the ~4.5 MB serverless body limit as matches accumulate. Set an explicit `cacheControlMaxAge` on `put` (default is long; cache-busting `?_t=` currently masks this).
25. **Hardcoded blob URL** — `db.js:18` pins `https://v0grmksww68yigcw.public.blob.vercel-storage.com/...`; recreating the store or running another deployment breaks sync or points forks/local at production. Have `/api/sync` return the URL or proxy reads only.
26. **Firebase path is half-implemented and conflicts with cloud sync** — `startRealtimeSync()` always runs (`db.js:94`) even when Firestore is active, so two sync engines fight over localStorage; `login()` never signs into Firebase so `firestore.rules` (which require `request.auth`) would reject all writes; `matches` stored as one doc with a growing `balls` array (1 MB doc limit); rules treat any email matching `.*admin.*` as admin (`firestore.rules:11-15`) — anyone could register such an email. Either finish it or delete the Firebase SDK scripts, config modal, rules file and related code.
27. **Manifest/icons** — `icon.jpg` and `icon-512.jpg` are actually 1024×1024 JPEGs (`manifest.json:19-23` claims 512×512 and `maskable`); no PNG 192/512 for installability on all platforms; SVG marked `any maskable`. `icon-512.jpg` is unreferenced.
28. **Missing hardening** — no Content-Security-Policy in `vercel.json`; `X-XSS-Protection` is obsolete; `user-scalable=no`/`maximum-scale=1` in the viewport hurts accessibility.

### P3 — housekeeping / docs

29. **README is stale and leaks secrets** — credentials printed (`README.md:41-42`), squad lists (`:50-53`) differ from `seed.js` (e.g. "Harsh 3", "Rishabh 2" vs seed "Ashwin 3", "Sajan 3"), mentions "Auto-balance / re-shuffle" for admins though no UI uses `TeamEngine.autoBalance/reShuffle`, a `file:///c:/Users/GOLDEN YADAV/...` link to `start.bat` (`:22`), Netlify/Firebase hosting options that no longer work with the Vercel-only backend.
30. **Dead code** — `TeamEngine.autoBalance`, `reShuffle`; `AppDB.resetToDemoData`, `registerPlayer`; `SEED_PLAYERS` (`seed.js:154`); `navTeams` var; `.gitignore` has duplicate entries; `package.json` has a badge-markdown `description`, `main: sw.js`, no `start`/`dev` script, no `engines`.
31. **No tests** — `CricketEngine` is pure and easily testable; highest-value targets: `replayInnings` (extras, retire, over-end, all-out), `calculatePointsTable` (NRR, all-out rule, ties), `generateMatchResultText`, and sync merge logic. A tiny `node --test` suite would catch items 8–10.
32. **Single 117 KB `app.js` with string-templated HTML** — consider splitting (scoring / views / modals) when making the XSS fixes in item 4.

### What the P0 fixes changed (for future editors)

- **Sync model** (`js/db.js`): state is synced per *section* (`players`, `teams`, `matches`). Mutators call `queueSync([...])`, which marks sections dirty (persisted in `cct_dirty_sections`) and pushes only those. A section stays dirty until the server confirms it; `applyRemote` never overwrites a dirty section; the poll loop retries failed pushes every ~5 s. A pull that fails (network error, non-OK) never pushes anything; only an explicit `{status:'empty'}` from the API lets signed-in staff seed the cloud.
- **Server** (`api/`): `login.js` checks `STAFF_PASSWORD`/`ADMIN_PASSWORD` and returns an HMAC-signed 24 h token (`_auth.js`). `sync.js` POST requires that token, validates `{sections:{...}}`, merges only the sent sections into the stored state, assigns a strictly increasing server `updatedAt`, and no longer sends CORS headers. Remaining limitation: two devices editing the *same* section at once are still last-write-wins, and the read-modify-write on the blob is not atomic.
- **UI**: generated HTML uses `data-action` + `data-*` attributes with one delegated click listener (`App.setupActionDelegation` / `dispatchAction`); never add new inline `onclick` with interpolated values. Add/edit/delete team and player controls render only for staff; every `AppDB` write helper calls `requireStaff()`. Public player self-registration was removed as a consequence.
- **Known leftovers**: a few numeric fields (e.g. `match.overs`) are still interpolated unescaped, but data can now only be written by signed-in staff. Firebase mode still does not use the new login. Local dev (`start.bat`) cannot sign in because `/api/login` does not exist there; use `vercel dev`.

## 6. Suggested order of work

1. ~~P0 items 1-7~~ done (set `STAFF_PASSWORD` in Vercel, rotate the exposed password, deploy).
2. Engine fixes with unit tests: retire/declare, "Match in progress" result, id-based team references (items 8-10).
3. Seed cleanup (items 17-19), icons/manifest, remaining README refresh (squad lists), remove dead Firebase/Team-balance code or finish it.
4. Polling cost / payload size (item 24), hardcoded blob URL (item 25).

## 7. Conventions to keep when editing

- Global singleton objects (`App`, `AppDB`, `CricketEngine`, `TeamEngine`), no modules; script order in `index.html` matters (`seed → engine → teams → db → app`).
- State lives in localStorage; always go through `AppDB` mutators so `notifyListeners`, `broadcast` and `pushToCloud` all fire.
- Never store derived stats — everything is replayed from `balls`; add new ball fields additively so old matches still replay.
- FR-n comments in the code refer to an external requirements list (not in the repo).
