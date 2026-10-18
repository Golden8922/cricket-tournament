// Main Application Controller & UI Orchestrator
// College Cricket Tournament PWA

const App = {
  activeView: 'view-live',
  QUALIFY_SPOTS: 2, // top N teams get a "Q" mark in the points table
  _refreshing: false,
  currentModifier: null, // null | 'wide' | 'noball' | 'bye' | 'legbye'
  activeScoringMatch: null,
  wakeLock: null,
  deferredInstallPrompt: null,
  audioCtx: null,

  async init() {
    // First-ever visit on this device: show a skeleton instead of seed data until the first sync ends
    if (!localStorage.getItem('cct_last_synced_at')) {
      const appEl = document.getElementById('app');
      if (appEl) appEl.classList.add('is-first-load');
      setTimeout(() => this.finishFirstLoad(), 6000);
    }

    // 1. Initialize Database
    await AppDB.init();

    // 2. Setup Event Listeners
    this.setupActionDelegation();
    this.setupNavigation();
    this.setupTheme();
    this.setupPWA();
    this.setupAuth();
    this.setupTeamsView();
    this.setupTableView();
    this.setupScoringConsole();
    this.setupHistoryAndPlayers();
    this.setupLiveView();
    this.setupSyncBar();
    this.setupPullToRefresh();
    this.setupFixtures();

    // 3. Subscribe to DB updates
    AppDB.subscribe('players', () => this.onPlayersDataChanged());
    AppDB.subscribe('teams', () => this.onTeamsDataChanged());
    AppDB.subscribe('matches', () => this.onMatchesDataChanged());
    AppDB.subscribe('fixtures', () => this.onFixturesDataChanged());
    AppDB.onAuthChange((user) => this.onAuthStateChanged(user));
    AppDB.onStatusChange((status) => this.onConnectionStatusChanged(status));

    // 4. Initial Render
    this.onAuthStateChanged(AppDB.currentUser);
    this.renderAll();

    // 5. Restore View from URL hash or default
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash) {
      this.navigateTo(`view-${initialHash}`);
    } else {
      this.navigateTo('view-live');
    }
  },

  // ==========================================
  // SYNC BAR, REFRESH & PULL-TO-REFRESH
  // ==========================================
  finishFirstLoad() {
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('is-first-load');
  },

  formatAgo(ms) {
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs} s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins} min`;
    return `${Math.floor(mins / 60)} h`;
  },

  setupSyncBar() {
    const btn = document.getElementById('sync-bar-refresh');
    if (btn) btn.addEventListener('click', () => this.refreshNow(true));
    this.updateSyncBar();
    setInterval(() => this.updateSyncBar(), 1000);
  },

  updateSyncBar() {
    const bar = document.getElementById('sync-bar');
    const text = document.getElementById('sync-bar-text');
    if (!bar || !text) return;

    const now = Date.now();
    const last = AppDB.lastSyncOkAt;
    let cls = 'busy';
    let msg = 'Syncing latest data…';

    if (this._refreshing) {
      msg = 'Refreshing…';
    } else if (AppDB.connectionStatus === 'offline') {
      cls = 'offline';
      msg = last ? `Offline • last updated ${this.formatAgo(now - last)} ago` : 'Offline • showing saved data';
    } else if (last) {
      const age = now - last;
      if (AppDB.connectionStatus === 'reconnecting' || age > 30000) {
        cls = 'stale';
        msg = `Reconnecting… last updated ${this.formatAgo(age)} ago`;
      } else {
        cls = 'ok';
        msg = age < 4000 ? 'Live • updated just now' : `Live • updated ${this.formatAgo(age)} ago`;
      }
    }
    if (AppDB.isStaff() && AppDB.hasUnsentChanges()) msg += ' • saving your changes…';

    bar.className = `sync-bar ${cls}`;
    text.textContent = msg;
  },

  async refreshNow(manual = false) {
    if (this._refreshing) return;
    this._refreshing = true;
    this.updateSyncBar();
    const before = AppDB.lastSyncOkAt;
    try {
      await AppDB.refreshNow();
      this.renderAll();
      if (manual) {
        if (AppDB.lastSyncOkAt > before) this.showToast('Latest data loaded', 'success');
        else this.showToast("Couldn't reach the server. Showing saved data.", 'info');
      }
    } catch (err) {
      if (manual) this.showToast("Couldn't refresh right now.", 'error');
    } finally {
      this._refreshing = false;
      this.updateSyncBar();
    }
  },

  // Pull down at the top of a page to refresh (not on the scoring screen, not with a dialog open)
  setupPullToRefresh() {
    const indicator = document.getElementById('ptr-indicator');
    const label = document.getElementById('ptr-indicator-text');
    if (!indicator || !label) return;

    const THRESHOLD = 80;
    let startY = 0;
    let startX = 0;
    let pulling = false;
    let dist = 0;

    const reset = () => {
      pulling = false;
      dist = 0;
      indicator.classList.remove('visible');
    };

    document.addEventListener('touchstart', (e) => {
      const blocked = window.scrollY > 0 || this.activeView === 'view-scoring' ||
        document.querySelector('.modal-overlay.active') || e.touches.length !== 1;
      if (blocked || this._refreshing) { pulling = false; return; }
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      pulling = true;
      dist = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      const dx = Math.abs(e.touches[0].clientX - startX);
      if (dy <= 10 || dx > dy) { indicator.classList.remove('visible'); dist = 0; return; }
      dist = dy;
      label.textContent = dist > THRESHOLD ? '↑ Release to refresh' : '↓ Pull to refresh';
      indicator.style.transform = `translate(-50%, ${Math.min(dist, 120) - 50}px)`;
      indicator.classList.add('visible');
    }, { passive: true });

    document.addEventListener('touchend', async () => {
      const shouldRefresh = pulling && dist > THRESHOLD;
      if (!shouldRefresh) { reset(); indicator.style.transform = ''; return; }
      pulling = false;
      label.textContent = 'Refreshing…';
      indicator.classList.add('refreshing');
      await this.refreshNow(true);
      indicator.classList.remove('refreshing', 'visible');
      indicator.style.transform = '';
      dist = 0;
    }, { passive: true });

    document.addEventListener('touchcancel', () => { reset(); indicator.style.transform = ''; }, { passive: true });
  },

  // ==========================================
  // POINTS TABLE LEGEND
  // ==========================================
  updateTableLegend() {
    const el = document.getElementById('table-legend');
    if (!el) return;
    el.innerHTML = `<span class="q-badge" style="margin-left:0">Q</span> in a qualifying position (top ${this.QUALIFY_SPOTS}). Teams level on points are ranked by net run rate, then wins, then head-to-head.`;
  },

  // ==========================================
  // FIXTURES / SCHEDULE
  // ==========================================
  // Pair every fixture with the result (or live match) between the same two teams
  getFixtureViews() {
    const fixtures = AppDB.getLocalFixtures();
    const matches = AppDB.getLocalMatches();
    const samePair = (m, f) =>
      (m.teamA === f.teamA && m.teamB === f.teamB) || (m.teamA === f.teamB && m.teamB === f.teamA);
    const done = matches.filter(m => m.status === 'done').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const live = matches.find(m => m.status === 'live');
    const claimed = new Set();
    let liveClaimed = false;

    return fixtures.map(f => {
      const result = done.find(m => !claimed.has(m.id) && samePair(m, f));
      if (result) {
        claimed.add(result.id);
        return { fixture: f, status: 'done', match: result };
      }
      if (live && !liveClaimed && samePair(live, f)) {
        liveClaimed = true;
        return { fixture: f, status: 'live', match: live };
      }
      return { fixture: f, status: 'upcoming', match: null };
    });
  },

  renderNextFixtureHtml() {
    const next = this.getFixtureViews().find(v => v.status === 'upcoming');
    if (!next) return '';
    const f = next.fixture;
    const when = new Date(f.scheduledAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<p style="margin-bottom: 16px; font-size: 0.9rem;">📅 Next match: <strong>${this.escapeHtml(f.teamA)} vs ${this.escapeHtml(f.teamB)}</strong><br><span style="color: var(--text-muted);">${this.escapeHtml(when)}</span></p>`;
  },

  onFixturesDataChanged() {
    this.renderFixturesView();
    this.renderLiveView();
  },

  renderFixturesView() {
    const container = document.getElementById('fixtures-list');
    if (!container) return;

    const views = this.getFixtureViews();
    const staff = AppDB.isStaff();

    if (views.length === 0) {
      container.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">📅</div>
          <div class="empty-title">No fixtures yet</div>
          <p>${staff ? 'Tap "Add Fixture" to schedule the first match.' : 'The tournament schedule will appear here.'}</p>
        </div>`;
      return;
    }

    const nextIdx = views.findIndex(v => v.status === 'upcoming');
    let lastDay = '';
    container.innerHTML = views.map((v, idx) => {
      const f = v.fixture;
      const d = new Date(f.scheduledAt);
      const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
      const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const header = day !== lastDay ? `<div class="fixture-day">${this.escapeHtml(day)}</div>` : '';
      lastDay = day;

      let chip = '<span class="fixture-chip">Upcoming</span>';
      let cardClass = 'fixture-card';
      let resultHtml = '';
      if (v.status === 'live') {
        chip = '<span class="fixture-chip live">● LIVE</span>';
        cardClass += ' is-live';
      } else if (v.status === 'done') {
        chip = '<span class="fixture-chip done">Finished</span>';
        const in1 = CricketEngine.getInningsStats(v.match, 1);
        const in2 = CricketEngine.getInningsStats(v.match, 2);
        const aBatsFirst = v.match.teamA === f.teamA;
        const scoreA = aBatsFirst ? in1 : in2;
        const scoreB = aBatsFirst ? in2 : in1;
        resultHtml = `<div class="fixture-result">🏆 ${this.escapeHtml(v.match.result || 'Match completed')}<br><span style="font-weight: 600; color: var(--text-secondary); font-size: 0.78rem;">${this.escapeHtml(f.teamA)} ${scoreA.totalRuns}/${scoreA.wickets} • ${this.escapeHtml(f.teamB)} ${scoreB.totalRuns}/${scoreB.wickets}</span></div>`;
      } else if (idx === nextIdx) {
        chip = '<span class="fixture-chip next">Next</span>';
        cardClass += ' is-next';
      }

      const actions = staff ? `
        <div class="fixture-actions">
          <button class="btn-secondary" style="padding: 4px 10px; min-height: 32px; font-size: 0.75rem;" data-action="editFixture" data-id="${this.escapeHtml(f.id)}">✏️ Edit</button>
          <button class="btn-danger" style="padding: 4px 10px; min-height: 32px; font-size: 0.75rem;" data-action="deleteFixture" data-id="${this.escapeHtml(f.id)}">🗑️ Delete</button>
        </div>` : '';

      return `${header}
        <div class="${cardClass}">
          <div class="fixture-top"><span>🕒 ${this.escapeHtml(time)}${f.note ? ' • ' + this.escapeHtml(f.note) : ''}</span>${chip}</div>
          <div class="fixture-teams"><span>${this.escapeHtml(f.teamA)}</span><span class="vs-badge">VS</span><span class="fixture-side-b">${this.escapeHtml(f.teamB)}</span></div>
          ${resultHtml}${actions}
        </div>`;
    }).join('');
  },

  setupFixtures() {
    const btn = document.getElementById('btn-open-add-fixture');
    if (btn) btn.addEventListener('click', () => this.openFixtureModal());

    const form = document.getElementById('form-fixture');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const val = (id) => document.getElementById(id)?.value;
        const when = val('fixture-datetime');
        const data = {
          teamA: val('fixture-team-a'),
          teamB: val('fixture-team-b'),
          scheduledAt: when ? new Date(when).getTime() : NaN,
          note: val('fixture-note')
        };
        const fixtureId = val('fixture-id');
        try {
          if (fixtureId) await AppDB.updateFixture(fixtureId, data);
          else await AppDB.addFixture(data);
          this.closeModal('modal-fixture');
          this.showToast(fixtureId ? 'Fixture updated' : 'Fixture added', 'success');
          this.renderFixturesView();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }
  },

  async openFixtureModal(fixtureId = null) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to edit fixtures', 'error');
      return;
    }
    const teams = await AppDB.getTeams();
    if (teams.length < 2) {
      this.showToast('Create at least two teams first', 'error');
      return;
    }
    const existing = fixtureId ? AppDB.getLocalFixtures().find(f => f.id === fixtureId) : null;

    const options = (selected) => teams.map(t =>
      `<option value="${this.escapeHtml(t.name)}" ${t.name === selected ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
    document.getElementById('fixture-team-a').innerHTML = options(existing ? existing.teamA : teams[0].name);
    document.getElementById('fixture-team-b').innerHTML = options(existing ? existing.teamB : teams[1].name);
    document.getElementById('fixture-id').value = existing ? existing.id : '';
    document.getElementById('fixture-datetime').value = this.toLocalInputValue(existing ? existing.scheduledAt : Date.now());
    document.getElementById('fixture-note').value = existing ? (existing.note || '') : '';
    document.getElementById('fixture-modal-title').textContent = existing ? '✏️ Edit Fixture' : '➕ Add Fixture';
    this.openModal('modal-fixture');
  },

  async confirmDeleteFixture(fixtureId) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to delete fixtures', 'error');
      return;
    }
    if (!confirm('Delete this fixture? (Match results are not affected.)')) return;
    try {
      await AppDB.deleteFixture(fixtureId);
      this.showToast('Fixture deleted', 'info');
      this.renderFixturesView();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // ==========================================
  // ADD A PLAYER DURING A LIVE MATCH
  // ==========================================
  openLiveAddPlayerModal() {
    const match = this.activeScoringMatch;
    if (!match) {
      this.showToast('Start a match first', 'error');
      return;
    }
    const form = document.getElementById('form-live-add-player');
    if (form) form.reset();
    const battingTeam = match.currentInnings === 2 ? match.teamB : match.teamA;
    const bowlingTeam = match.currentInnings === 2 ? match.teamA : match.teamB;
    const select = document.getElementById('live-player-team');
    if (select) {
      select.innerHTML = [battingTeam, bowlingTeam].map((name, i) =>
        `<option value="${this.escapeHtml(name)}">${this.escapeHtml(name)} (${i === 0 ? 'batting' : 'bowling'})</option>`).join('');
    }
    this.openModal('modal-live-add-player');
  },

  async submitLiveAddPlayer() {
    const live = this.activeScoringMatch;
    if (!live) return;
    const val = (id) => (document.getElementById(id)?.value || '').trim();
    const name = val('live-player-name');
    const teamName = val('live-player-team');
    const role = val('live-player-role') || 'All-rounder';
    const roll = val('live-player-roll') || ('LIVE-' + Date.now().toString(36).toUpperCase());
    if (!name) {
      this.showToast('Please enter the player name', 'error');
      return;
    }
    try {
      const player = await AppDB.addPlayer({ name, roll, role, exp: 2, bat: 3, bowl: 3, field: 3, keeper: false }, teamName);
      // The match keeps its own list of who is playing: add the new player to it as well
      const fresh = await AppDB.getMatch(live.id);
      const key = teamName === fresh.teamA ? 'teamAPlayerIds' : 'teamBPlayerIds';
      await AppDB.updateMatch(live.id, { [key]: [...(fresh[key] || []), player.id] });
      this.closeModal('modal-live-add-player');
      this.showToast(`${name} added to ${teamName}`, 'success');
      this.renderScoringConsole();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // ==========================================
  // BOWLER RULES: overs limit + next bowler prompt
  // ==========================================
  getCurrentInningsStats(match) {
    const is2nd = match.currentInnings === 2;
    const battingIds = is2nd ? (match.teamBPlayerIds || []) : (match.teamAPlayerIds || []);
    const bowlingIds = is2nd ? (match.teamAPlayerIds || []) : (match.teamBPlayerIds || []);
    const balls = (match.balls || []).filter(b => b.innings === match.currentInnings);
    return CricketEngine.replayInnings(balls, battingIds, bowlingIds, match.overs);
  },

  // Standard rule: no bowler bowls more than one fifth of the overs (8 overs -> 2 each).
  // Raised automatically when the bowling squad is too small to cover all the overs.
  getBowlerOverLimit(match) {
    const bowlingIds = match.currentInnings === 2 ? (match.teamAPlayerIds || []) : (match.teamBPlayerIds || []);
    const squad = Math.max(1, bowlingIds.length);
    return Math.max(Math.ceil(match.overs / 5), Math.ceil(match.overs / squad));
  },

  ensureBowlerAllowed(match) {
    const limit = this.getBowlerOverLimit(match);
    const bowler = this.getCurrentInningsStats(match).bowlers[match.bowlerId];
    if (bowler && bowler.legalBalls >= limit * 6) {
      this.showToast(`This bowler has bowled the maximum ${limit} overs. Choose another bowler to continue.`, 'error');
      this.openNextBowlerPrompt();
      return false;
    }
    return true;
  },

  // After the 6th legal ball of an over (and the innings is not over): choose the next bowler
  maybePromptNextBowler(match) {
    const balls = (match.balls || []).filter(b => b.innings === match.currentInnings);
    const legal = balls.filter(b => b.isLegal).length;
    const last = balls[balls.length - 1];
    if (!last || !last.isLegal || legal === 0 || legal % 6 !== 0) return;

    const stats = this.getCurrentInningsStats(match);
    if (stats.isInningsOver) return;
    if (match.currentInnings === 2) {
      const first = CricketEngine.getInningsStats(match, 1);
      if (stats.totalRuns > first.totalRuns) return; // target chased, match is over
    }
    this.openNextBowlerPrompt();
  },

  openNextBowlerPrompt() {
    const match = this.activeScoringMatch;
    if (!match) return;
    const bowlingIds = match.currentInnings === 2 ? (match.teamAPlayerIds || []) : (match.teamBPlayerIds || []);
    const stats = this.getCurrentInningsStats(match);
    const limit = this.getBowlerOverLimit(match);
    const pMap = {};
    AppDB.getLocalPlayers().forEach(p => { pMap[p.id] = p; });

    const balls = (id) => (stats.bowlers[id] && stats.bowlers[id].legalBalls) || 0;
    const available = bowlingIds.filter(id => balls(id) < limit * 6);
    // The bowler who just finished an over cannot bowl the next one, unless nobody else is left
    let choices = available.filter(id => id !== match.bowlerId);
    if (choices.length === 0) choices = available;
    if (choices.length === 0) return;

    const select = document.getElementById('select-next-bowler');
    const info = document.getElementById('next-bowler-info');
    if (!select) return;
    select.innerHTML = choices.map(id => {
      const name = pMap[id] ? pMap[id].name : id;
      return `<option value="${this.escapeHtml(id)}">${this.escapeHtml(name)} (${CricketEngine.formatOvers(balls(id))} ov bowled)</option>`;
    }).join('');
    const prev = pMap[match.bowlerId];
    if (info) {
      info.textContent = `${prev ? prev.name : 'The last bowler'} finished the over. Maximum ${limit} overs per bowler.`;
    }
    this._nextBowlerMatchId = match.id;
    this.openModal('modal-next-bowler');
  },

  async confirmNextBowler() {
    const select = document.getElementById('select-next-bowler');
    const matchId = this._nextBowlerMatchId;
    if (!select || !select.value || !matchId) return;
    try {
      await AppDB.updateMatch(matchId, { bowlerId: select.value });
      if (this.activeScoringMatch && this.activeScoringMatch.id === matchId) {
        this.activeScoringMatch.bowlerId = select.value;
      }
      this.closeModal('modal-next-bowler');
      this.renderScoringConsole();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  // ==========================================
  // SHARE A RESULT (image card + text for WhatsApp)
  // ==========================================
  async shareResultCard(matchId) {
    const match = await AppDB.getMatch(matchId);
    if (!match) return;
    const in1 = CricketEngine.getInningsStats(match, 1);
    const in2 = CricketEngine.getInningsStats(match, 2);
    const when = match.createdAt
      ? new Date(match.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    const result = match.result || 'Match completed';
    const text = `🏏 COLLEGE CRICKET TOURNAMENT\n\n${match.teamA}: ${in1.totalRuns}/${in1.wickets} (${in1.oversFormatted} ov)\n${match.teamB}: ${in2.totalRuns}/${in2.wickets} (${in2.oversFormatted} ov)\n\n🏆 ${result}\n\n${window.location.origin}${window.location.pathname}#history`;

    let file = null;
    try {
      const blob = await this.renderResultCardBlob(match, in1, in2, when, result);
      if (blob) file = new File([blob], 'match-result.png', { type: 'image/png' });
    } catch (e) { /* fall back to text only */ }

    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text, title: 'Match result' });
        return;
      }
      if (navigator.share) {
        await navigator.share({ text, title: 'Match result' });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user closed the share sheet
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  },

  renderResultCardBlob(match, in1, in2, when, result) {
    return new Promise((resolve) => {
      const W = 1080, H = 1080;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);

      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#0B132B');
      grad.addColorStop(1, '#142247');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      const font = (size, weight = 700) => `${weight} ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
      const fit = (text, maxWidth, size, weight) => {
        let s = size;
        ctx.font = font(s, weight);
        while (ctx.measureText(text).width > maxWidth && s > 24) { s -= 2; ctx.font = font(s, weight); }
      };
      const wrap = (text, maxWidth) => {
        const words = String(text).split(' ');
        const lines = [];
        let line = '';
        words.forEach(w => {
          const test = line ? line + ' ' + w : w;
          if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else { line = test; }
        });
        if (line) lines.push(line);
        return lines;
      };

      ctx.textAlign = 'center';
      ctx.fillStyle = '#00E699';
      ctx.font = font(44, 800);
      ctx.fillText('COLLEGE CRICKET TOURNAMENT', W / 2, 120);
      ctx.fillStyle = '#94A3B8';
      ctx.font = font(34, 600);
      ctx.fillText(`${when ? when + '  •  ' : ''}${match.overs} overs match`, W / 2, 175);

      const block = (name, st, y) => {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(80, y, W - 160, 230);
        ctx.fillStyle = '#FFFFFF';
        fit(name, W - 240, 56, 800);
        ctx.fillText(name, W / 2, y + 85);
        ctx.fillStyle = '#FFB703';
        ctx.font = font(100, 800);
        ctx.fillText(`${st.totalRuns}/${st.wickets}`, W / 2, y + 185);
        ctx.fillStyle = '#94A3B8';
        ctx.font = font(32, 600);
        ctx.textAlign = 'right';
        ctx.fillText(`(${st.oversFormatted} ov)`, W - 110, y + 185);
        ctx.textAlign = 'center';
      };
      block(match.teamA, in1, 240);
      block(match.teamB, in2, 500);

      ctx.fillStyle = 'rgba(0,230,153,0.15)';
      ctx.fillRect(80, 770, W - 160, 170);
      ctx.fillStyle = '#00E699';
      ctx.font = font(46, 800);
      const lines = wrap('🏆 ' + result, W - 220).slice(0, 3);
      const startY = 770 + 85 - ((lines.length - 1) * 28);
      lines.forEach((l, i) => ctx.fillText(l, W / 2, startY + i * 56));

      ctx.fillStyle = '#64748B';
      ctx.font = font(30, 600);
      ctx.fillText(window.location.host || 'college cricket tournament', W / 2, 1030);

      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  },

  // ==========================================
  // DELEGATED ACTIONS (no inline JS in generated HTML)
  // Buttons carry data-action + data-* values; values are read back from
  // dataset, so names containing quotes/markup can never reach a JS context.
  // ==========================================
  setupActionDelegation() {
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el) return;
      this.dispatchAction(el.dataset);
    });
  },

  dispatchAction(d) {
    switch (d.action) {
      case 'openAddTeam': return this.openAddTeamModal();
      case 'openAddPlayer': return this.openAddPlayerModal(d.id || null);
      case 'openEditTeam': return this.openEditTeamModal(d.id);
      case 'deleteTeam': return this.confirmDeleteTeam(d.id, d.name);
      case 'openEditPlayer': return this.openEditPlayerModal(d.id);
      case 'movePlayer': return this.openMovePlayerModal(d.id, d.name);
      case 'deletePlayer': return this.confirmDeletePlayer(d.id, d.name);
      case 'navigate': return this.navigateTo(d.view);
      case 'deleteMatch': return this.confirmDeleteMatch(d.id);
      case 'editMatchDate': return this.openEditMatchDateModal(d.id);
      case 'editFixture': return this.openFixtureModal(d.id);
      case 'deleteFixture': return this.confirmDeleteFixture(d.id);
      case 'shareResult': return this.shareResultCard(d.id);
      case 'scorecard': return this.openFullScorecardModal(d.id);
      case 'toggleOver': return this.toggleOverHistory(d.target);
      case 'share': return this.shareLiveMatch(d.id, d.teamA, d.teamB, d.score, d.overs);
    }
  },

  // ==========================================
  // NAVIGATION & VIEW ROUTING
  // ==========================================
  setupNavigation() {
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '');
      const viewId = `view-${hash}`;
      if (document.getElementById(viewId)) {
        this.navigateTo(viewId, false);
      }
    });

    document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = item.getAttribute('data-view');
        this.navigateTo(targetView);
      });
    });

    // Brand link to home
    const brandHome = document.getElementById('brand-home-link');
    if (brandHome) {
      brandHome.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateTo('view-live');
      });
    }

    // Modal close buttons
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close-modal');
        this.closeModal(modalId);
      });
    });
  },

  navigateTo(viewId, updateHash = true) {
    // Access control checks: only Scoring console requires Staff authentication
    if (viewId === 'view-scoring' && !AppDB.isStaff()) {
      this.showToast('Umpire or Admin login required to Score', 'error');
      this.openModal('modal-staff-login');
      return;
    }

    this.activeView = viewId;

    // Toggle panels
    document.querySelectorAll('.view-panel').forEach(panel => {
      panel.classList.toggle('active', panel.id === viewId);
    });

    // Update bottom nav active state
    document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-view') === viewId);
    });

    if (updateHash) {
      window.location.hash = viewId.replace('view-', '');
    }

    // Manage Screen Wake Lock for Umpire console (FR-16)
    if (viewId === 'view-scoring') {
      this.requestWakeLock();
    } else {
      this.releaseWakeLock();
    }

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  // ==========================================
  // SCREEN WAKE LOCK & HAPTICS (FR-16)
  // ==========================================
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        const badge = document.getElementById('wake-lock-status-badge');
        if (badge) badge.style.display = 'inline-flex';
      } catch (err) {
        console.warn('Wake Lock error:', err);
      }
    }
  },

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
    const badge = document.getElementById('wake-lock-status-badge');
    if (badge) badge.style.display = 'none';
  },

  vibrate(duration = 50) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(duration); } catch (e) {}
    }
    this.playBatClickSound();
  },

  playBatClickSound() {
    try {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) this.audioCtx = new AudioContext();
      }
      if (this.audioCtx && this.audioCtx.state === 'running') {
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, this.audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(110, this.audioCtx.currentTime + 0.06);
        gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.06);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.06);
      }
    } catch (e) {}
  },

  // ==========================================
  // THEME & OUTDOOR HIGH-CONTRAST MODE
  // ==========================================
  setupTheme() {
    const themeBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = document.getElementById('theme-icon');

    // Check system preference or saved
    const savedTheme = localStorage.getItem('cct_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    this.updateThemeIcon(savedTheme);

    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        let next = 'dark';
        if (current === 'dark') next = 'outdoor';
        else if (current === 'outdoor') next = 'light';
        else next = 'dark';

        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('cct_theme', next);
        this.updateThemeIcon(next);
        this.showToast(`Theme: ${next.toUpperCase()}`, 'info');
      });
    }
  },

  updateThemeIcon(theme) {
    const icon = document.getElementById('theme-icon');
    if (!icon) return;
    if (theme === 'outdoor') icon.textContent = '☀️';
    else if (theme === 'light') icon.textContent = '🌤️';
    else icon.textContent = '🌙';
  },

  // ==========================================
  // PWA & SERVICE WORKER
  // ==========================================
  setupPWA() {
    if ('serviceWorker' in navigator) {
      // When an updated service worker takes control, reload once so people never keep an old version
      const hadController = Boolean(navigator.serviceWorker.controller);
      let reloadedForUpdate = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloadedForUpdate) return;
        reloadedForUpdate = true;
        window.location.reload();
      });

      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
          .then(() => console.log('Service Worker registered successfully!'))
          .catch(err => console.warn('Service Worker registration note:', err));
      });
    }

    const installBanner = document.getElementById('pwa-install-banner');
    const installBtn = document.getElementById('btn-pwa-install');
    const dismissBtn = document.getElementById('btn-pwa-dismiss');

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredInstallPrompt = e;
      if (installBanner) installBanner.classList.add('visible');
    });

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (this.deferredInstallPrompt) {
          this.deferredInstallPrompt.prompt();
          const { outcome } = await this.deferredInstallPrompt.userChoice;
          if (outcome === 'accepted') {
            this.showToast('App installed to your device!', 'success');
          }
          this.deferredInstallPrompt = null;
        }
        if (installBanner) installBanner.classList.remove('visible');
      });
    }

    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        if (installBanner) installBanner.classList.remove('visible');
      });
    }
  },

  // ==========================================
  // AUTHENTICATION & ACCESS CONTROL (FR-23, FR-24)
  // ==========================================
  setupAuth() {
    const authBtn = document.getElementById('staff-auth-btn');
    if (authBtn) {
      authBtn.addEventListener('click', () => {
        if (AppDB.currentUser) {
          // Log out confirm
          const displayName = AppDB.currentUser.name || AppDB.currentUser.displayName || 'Staff';
          if (confirm(`Signed in as "${displayName}" (${AppDB.currentUser.role.toUpperCase()}). Do you want to sign out?`)) {
            AppDB.logout();
            this.showToast('Signed out successfully', 'info');
          }
        } else {
          // Always open with an empty form (no leftover or autofilled password)
          const form = document.getElementById('staff-login-form');
          if (form) form.reset();
          this.openModal('modal-staff-login');
        }
      });
    }

    // Staff login form: credentials are verified server-side by /api/login
    const loginForm = document.getElementById('staff-login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = (document.getElementById('login-name')?.value || '').trim();
        const pass = document.getElementById('login-password')?.value || '';
        const role = document.getElementById('login-role')?.value || 'umpire';

        try {
          const user = await AppDB.login(name, pass, role);
          this.closeModal('modal-staff-login');
          loginForm.reset();
          this.showToast(`Welcome, ${user.name}! Signed in as ${user.role.toUpperCase()}`, 'success');
          if (user.role === 'admin') this.navigateTo('view-teams');
          else this.navigateTo('view-scoring');
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }
  },

  onAuthStateChanged(user) {
    const authBtnLabel = document.getElementById('auth-btn-label');
    const authBtnIcon = document.getElementById('auth-btn-icon');
    const staffBtn = document.getElementById('staff-auth-btn');
    const navTeams = document.getElementById('nav-item-teams');
    const navScoring = document.getElementById('nav-item-scoring');
    const adminCols = document.querySelectorAll('.admin-only-col');

    if (user) {
      const isAdm = (user.role === 'admin');
      const isUmp = (user.role === 'umpire');
      const displayName = user.name || user.displayName || (isAdm ? 'Admin' : 'Umpire');

      if (staffBtn) staffBtn.classList.add('logged-in');
      if (authBtnLabel) authBtnLabel.textContent = `${displayName} ${isAdm ? '👑' : '⚡'}`;
      if (authBtnIcon) authBtnIcon.textContent = '👤';

      // Staff only tab
      if (navScoring) navScoring.classList.toggle('visible', isAdm || isUmp);
      adminCols.forEach(col => col.style.display = (isAdm || isUmp) ? 'table-cell' : 'none');
    } else {
      if (staffBtn) staffBtn.classList.remove('logged-in');
      if (authBtnLabel) authBtnLabel.textContent = 'Staff Login';
      if (authBtnIcon) authBtnIcon.textContent = '🔐';

      // Hide scoring tab for spectators
      if (navScoring) navScoring.classList.remove('visible');
      adminCols.forEach(col => col.style.display = 'none');

      // If currently on scoring view, redirect to Live
      if (this.activeView === 'view-scoring') {
        this.navigateTo('view-live');
      }
    }

    // Controls that only staff may use (add team / add player)
    const staffNow = AppDB.isStaff();
    document.querySelectorAll('[data-staff-only]').forEach(el => {
      el.style.display = staffNow ? '' : 'none';
    });

    this.renderPlayersTable();
    this.renderTeamsView();
    this.renderFixturesView();
  },

  onConnectionStatusChanged(status) {
    const badge = document.getElementById('connection-status-pill');
    const text = document.getElementById('connection-status-text');
    const offlineBanner = document.getElementById('offline-alert-banner');

    if (!badge || !text) return;

    badge.className = 'status-badge';
    if (status === 'offline') {
      badge.classList.add('offline');
      text.textContent = 'Offline';
      if (offlineBanner) offlineBanner.classList.add('visible');
    } else if (status === 'reconnecting') {
      badge.classList.add('reconnecting');
      text.textContent = 'Reconnecting';
      if (offlineBanner) offlineBanner.classList.add('visible');
    } else {
      text.textContent = 'Live';
      if (offlineBanner) offlineBanner.classList.remove('visible');
    }

    if (AppDB.lastSyncOkAt) this.finishFirstLoad();
    this.updateSyncBar();
  },

  // ==========================================
  // TEAMS & PLAYERS MANAGEMENT
  // ==========================================
  setupTeamsView() {
    const btnExport = document.getElementById('btn-export-teams');

    // Add Team buttons
    const btnOpenAddTeam = document.getElementById('btn-open-add-team-modal');
    if (btnOpenAddTeam) {
      btnOpenAddTeam.addEventListener('click', () => this.openAddTeamModal());
    }

    // Add Player buttons
    const btnOpenAddPlayer = document.getElementById('btn-open-add-player-modal');
    const btnPlayerTabAdd = document.getElementById('btn-player-tab-add');
    if (btnOpenAddPlayer) {
      btnOpenAddPlayer.addEventListener('click', () => this.openAddPlayerModal());
    }
    if (btnPlayerTabAdd) {
      btnPlayerTabAdd.addEventListener('click', () => this.openAddPlayerModal());
    }

    // Form: Add Team
    const formAddTeam = document.getElementById('form-add-team');
    if (formAddTeam) {
      formAddTeam.addEventListener('submit', async (e) => {
        e.preventDefault();
        const teamName = document.getElementById('new-team-name').value.trim();
        try {
          await AppDB.addTeam(teamName);
          this.closeModal('modal-add-team');
          formAddTeam.reset();
          this.showToast(`🏆 Team "${teamName}" created successfully!`, 'success');
          this.renderTeamsView();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    // Form: Rename Team
    const formRenameTeam = document.getElementById('form-rename-team');
    if (formRenameTeam) {
      formRenameTeam.addEventListener('submit', async (e) => {
        e.preventDefault();
        const teamId = document.getElementById('rename-team-id').value;
        const newName = document.getElementById('rename-team-input').value.trim();
        try {
          await AppDB.renameTeam(teamId, newName);
          this.closeModal('modal-rename-team');
          this.showToast(`Team renamed to "${newName}"`, 'success');
          this.renderTeamsView();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    // Form: Add Player & live rating preview
    const formAddPlayer = document.getElementById('form-add-player');
    const pExpSlider = document.getElementById('player-input-exp');
    const pBatSlider = document.getElementById('player-input-bat');
    const pBowlSlider = document.getElementById('player-input-bowl');
    const pFieldSlider = document.getElementById('player-input-field');
    const pKeeperCheckbox = document.getElementById('player-input-keeper');

    const updateAddPlayerPreview = () => {
      if (!pExpSlider) return;
      const exp = Number(pExpSlider.value) || 0;
      const bat = Number(pBatSlider.value) || 1;
      const bowl = Number(pBowlSlider.value) || 1;
      const field = Number(pFieldSlider.value) || 1;
      const keeper = pKeeperCheckbox.checked;

      const levels = ['Level 0: Gully', 'Level 1: School', 'Level 2: College', 'Level 3: District', 'Level 4: State', 'Level 5: National'];
      const expDisplay = document.getElementById('player-exp-display');
      const batDisplay = document.getElementById('player-bat-display');
      const bowlDisplay = document.getElementById('player-bowl-display');
      const fieldDisplay = document.getElementById('player-field-display');
      const previewScore = document.getElementById('player-rating-preview-val');

      if (expDisplay) expDisplay.textContent = levels[exp] || `Level ${exp}`;
      if (batDisplay) batDisplay.textContent = bat;
      if (bowlDisplay) bowlDisplay.textContent = bowl;
      if (fieldDisplay) fieldDisplay.textContent = field;

      const rating = CricketEngine.calculateRating({ exp, bat, bowl, field, keeper });
      if (previewScore) previewScore.textContent = rating;
    };

    [pExpSlider, pBatSlider, pBowlSlider, pFieldSlider, pKeeperCheckbox].forEach(el => {
      if (el) el.addEventListener('input', updateAddPlayerPreview);
    });
    updateAddPlayerPreview();

    if (formAddPlayer) {
      formAddPlayer.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = document.getElementById('player-input-name').value.trim();
        const roll = document.getElementById('player-input-roll').value.trim();
        const role = document.getElementById('player-input-role').value;
        const teamId = document.getElementById('player-input-team').value;
        const exp = Number(pExpSlider.value);
        const bat = Number(pBatSlider.value);
        const bowl = Number(pBowlSlider.value);
        const field = Number(pFieldSlider.value);
        const keeper = pKeeperCheckbox.checked;

        try {
          await AppDB.addPlayer({ name, roll, role, exp, bat, bowl, field, keeper }, teamId);
          this.closeModal('modal-add-player');
          formAddPlayer.reset();
          pExpSlider.value = 2;
          pBatSlider.value = 3;
          pBowlSlider.value = 3;
          pFieldSlider.value = 3;
          pKeeperCheckbox.checked = false;
          updateAddPlayerPreview();

          this.showToast(`👤 Player "${name}" added successfully!`, 'success');
          this.renderTeamsView();
          this.renderPlayersTable();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    if (btnExport) {
      btnExport.addEventListener('click', async () => {
        const teams = await AppDB.getTeams();
        const players = await AppDB.getPlayers();
        const pMap = {};
        players.forEach(p => { pMap[p.id] = p; });

        let exportText = `🏏 COLLEGE CRICKET TOURNAMENT - TEAM ROSTERS 🏏\n\n`;
        teams.forEach((t) => {
          const stats = TeamEngine.calculateTeamStats(t, pMap);
          exportText += `🏆 ${t.name.toUpperCase()} (Total Rating: ${stats.totalRating}, Players: ${stats.count})\n`;
          (t.playerIds || []).forEach((pid, pIdx) => {
            const p = pMap[pid];
            if (p) {
              exportText += `  ${pIdx + 1}. ${p.name} (${p.roll}) - ${p.role} [Rating: ${CricketEngine.calculateRating(p)}]\n`;
            }
          });
          exportText += `\n`;
        });

        if (navigator.clipboard) {
          navigator.clipboard.writeText(exportText).then(() => {
            this.showToast('📋 Team rosters copied to clipboard for WhatsApp sharing!', 'success');
          });
        }
      });
    }

    // Move player modal confirm
    const btnConfirmMove = document.getElementById('btn-confirm-move');
    if (btnConfirmMove) {
      btnConfirmMove.addEventListener('click', async () => {
        const playerId = btnConfirmMove.dataset.playerId;
        const targetTeamVal = document.getElementById('select-target-team').value;
        const teams = await AppDB.getTeams();
        
        let sourceIndex = -1;
        teams.forEach((t, idx) => {
          if (t.playerIds && t.playerIds.includes(playerId)) {
            sourceIndex = idx;
          }
        });

        const targetIndex = targetTeamVal === 'unassigned' ? -1 : Number(targetTeamVal);
        TeamEngine.movePlayer(playerId, sourceIndex, targetIndex, teams);
        try {
          await AppDB.saveTeams(teams);
        } catch (err) {
          this.showToast(err.message, 'error');
          return;
        }
        this.closeModal('modal-move-player');
        this.showToast('Player reassigned successfully', 'success');
        this.renderTeamsView();
      });
    }

    // Form: Edit Team (Leadership & details)
    const formEditTeam = document.getElementById('form-edit-team');
    if (formEditTeam) {
      formEditTeam.addEventListener('submit', async (e) => {
        e.preventDefault();
        const teamId = document.getElementById('edit-team-id').value;
        const name = document.getElementById('edit-team-name').value.trim();
        const captainId = document.getElementById('edit-team-captain').value || null;
        const viceCaptainId = document.getElementById('edit-team-vice-captain').value || null;
        const motto = document.getElementById('edit-team-motto').value.trim();

        try {
          // captain/viceCaptain (old name-based fields) are cleared: the choice made here is final
          await AppDB.updateTeam(teamId, { name, captainId, viceCaptainId, captain: null, viceCaptain: null, motto });
          this.closeModal('modal-edit-team');
          this.showToast(`🏆 Team "${name}" updated successfully!`, 'success');
          this.renderTeamsView();
          this.renderPointsTable();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    // Form: Edit Player (Full details, team assignment & ratings)
    const formEditPlayer = document.getElementById('form-edit-player');
    if (formEditPlayer) {
      formEditPlayer.addEventListener('submit', async (e) => {
        e.preventDefault();
        const playerId = document.getElementById('edit-player-id').value;
        const name = document.getElementById('edit-player-name').value.trim();
        const roll = document.getElementById('edit-player-roll').value.trim();
        const fullName = document.getElementById('edit-player-fullname').value.trim();
        const role = document.getElementById('edit-player-role').value;
        const year = document.getElementById('edit-player-year').value;
        const teamId = document.getElementById('edit-player-team').value;
        const exp = Number(document.getElementById('edit-player-exp').value);
        const bat = Number(document.getElementById('edit-player-bat').value);
        const bowl = Number(document.getElementById('edit-player-bowl').value);
        const field = Number(document.getElementById('edit-player-field').value);
        const keeper = document.getElementById('edit-player-keeper').checked;

        try {
          await AppDB.updatePlayer(playerId, {
            name,
            roll,
            fullName,
            role,
            year,
            exp,
            bat,
            bowl,
            field,
            keeper,
            teamId
          });
          this.closeModal('modal-edit-player');
          this.showToast(`👤 Player "${name}" updated successfully!`, 'success');
          this.renderTeamsView();
          this.renderPlayersTable();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }
  },

  // Captain / vice-captain of a team. Teams created before leaders were stored by id only carry
  // names (and per-player flags), so fall back to those until someone picks leaders in Edit Team.
  getTeamLeaders(team, pMap) {
    const members = (team.playerIds || []).map(id => pMap[id]).filter(Boolean);
    const pick = (explicitId, legacyName, flag) => {
      if (explicitId !== undefined) return explicitId ? (pMap[explicitId] || null) : null;
      return members.find(p => p.name === legacyName) || members.find(p => p[flag]) || null;
    };
    return {
      cap: pick(team.captainId, team.captain, 'isCaptain'),
      vc: pick(team.viceCaptainId, team.viceCaptain, 'isViceCaptain')
    };
  },

  openAddTeamModal() {
    const form = document.getElementById('form-add-team');
    if (form) form.reset();
    this.openModal('modal-add-team');
  },

  openRenameTeamModal(teamId, currentName) {
    const idInput = document.getElementById('rename-team-id');
    const nameInput = document.getElementById('rename-team-input');
    if (idInput) idInput.value = teamId;
    if (nameInput) nameInput.value = currentName;
    this.openModal('modal-rename-team');
  },

  async openEditTeamModal(teamId) {
    const teams = await AppDB.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) return;

    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    const idInput = document.getElementById('edit-team-id');
    const nameInput = document.getElementById('edit-team-name');
    const capSelect = document.getElementById('edit-team-captain');
    const vcSelect = document.getElementById('edit-team-vice-captain');
    const mottoInput = document.getElementById('edit-team-motto');

    if (idInput) idInput.value = team.id;
    if (nameInput) nameInput.value = team.name;
    if (mottoInput) mottoInput.value = team.motto || '';

    // Populate squad members for Captain & VC selection
    const teamPlayerList = (team.playerIds || []).map(pid => pMap[pid]).filter(Boolean);
    const leaders = this.getTeamLeaders(team, pMap);
    const optionsHtml = `
      <option value="">-- No Captain Selected --</option>
      ${teamPlayerList.map(p => `<option value="${this.escapeHtml(p.id)}" ${leaders.cap && p.id === leaders.cap.id ? 'selected' : ''}>${this.escapeHtml(p.name)} (${this.escapeHtml(p.role)})</option>`).join('')}
    `;
    const vcOptionsHtml = `
      <option value="">-- No Vice-Captain Selected --</option>
      ${teamPlayerList.map(p => `<option value="${this.escapeHtml(p.id)}" ${leaders.vc && p.id === leaders.vc.id ? 'selected' : ''}>${this.escapeHtml(p.name)} (${this.escapeHtml(p.role)})</option>`).join('')}
    `;

    if (capSelect) capSelect.innerHTML = optionsHtml;
    if (vcSelect) vcSelect.innerHTML = vcOptionsHtml;

    this.openModal('modal-edit-team');
  },

  async confirmDeleteTeam(teamId, teamName) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to delete teams', 'error');
      return;
    }
    if (confirm(`Are you sure you want to delete team "${teamName}"? Players will be moved to the unassigned pool.`)) {
      try {
        await AppDB.deleteTeam(teamId);
        this.showToast(`Team "${teamName}" removed`, 'info');
        this.renderTeamsView();
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    }
  },

  async openAddPlayerModal(preselectedTeamId = null) {
    const form = document.getElementById('form-add-player');
    const select = document.getElementById('player-input-team');
    if (form) form.reset();

    const teams = await AppDB.getTeams();
    if (select) {
      select.innerHTML = `
        <option value="unassigned">-- Unassigned Pool --</option>
        ${teams.map(t => `<option value="${this.escapeHtml(t.id)}" ${t.id === preselectedTeamId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('')}
      `;
    }

    this.openModal('modal-add-player');
  },

  async openEditPlayerModal(playerId) {
    const players = await AppDB.getPlayers();
    const player = players.find(p => p.id === playerId);
    if (!player) return;

    const teams = await AppDB.getTeams();
    let currentTeamId = 'unassigned';
    teams.forEach(t => {
      if ((t.playerIds || []).includes(playerId)) {
        currentTeamId = t.id;
      }
    });

    const idInput = document.getElementById('edit-player-id');
    const nameInput = document.getElementById('edit-player-name');
    const rollInput = document.getElementById('edit-player-roll');
    const fullnameInput = document.getElementById('edit-player-fullname');
    const roleSelect = document.getElementById('edit-player-role');
    const yearSelect = document.getElementById('edit-player-year');
    const teamSelect = document.getElementById('edit-player-team');
    const expSlider = document.getElementById('edit-player-exp');
    const batSlider = document.getElementById('edit-player-bat');
    const bowlSlider = document.getElementById('edit-player-bowl');
    const fieldSlider = document.getElementById('edit-player-field');
    const keeperCheckbox = document.getElementById('edit-player-keeper');
    const expDisplay = document.getElementById('edit-player-exp-display');
    const batDisplay = document.getElementById('edit-player-bat-display');
    const bowlDisplay = document.getElementById('edit-player-bowl-display');
    const fieldDisplay = document.getElementById('edit-player-field-display');
    const ratingPreview = document.getElementById('edit-player-rating-preview');

    if (idInput) idInput.value = player.id;
    if (nameInput) nameInput.value = player.name || '';
    if (rollInput) rollInput.value = player.roll || '';
    if (fullnameInput) fullnameInput.value = player.fullName || player.originalName || player.name || '';
    if (roleSelect) roleSelect.value = player.role || 'Batter';
    if (yearSelect) yearSelect.value = player.year || '3rd Year';
    if (expSlider) expSlider.value = player.exp ?? 2;
    if (batSlider) batSlider.value = player.bat ?? 3;
    if (bowlSlider) bowlSlider.value = player.bowl ?? 3;
    if (fieldSlider) fieldSlider.value = player.field ?? 3;
    if (keeperCheckbox) keeperCheckbox.checked = Boolean(player.keeper);

    if (teamSelect) {
      teamSelect.innerHTML = `
        <option value="unassigned" ${currentTeamId === 'unassigned' ? 'selected' : ''}>-- Unassigned Pool --</option>
        ${teams.map(t => `<option value="${this.escapeHtml(t.id)}" ${t.id === currentTeamId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('')}
      `;
    }

    const updatePreview = () => {
      const exp = Number(expSlider ? expSlider.value : 2);
      const bat = Number(batSlider ? batSlider.value : 3);
      const bowl = Number(bowlSlider ? bowlSlider.value : 3);
      const field = Number(fieldSlider ? fieldSlider.value : 3);
      const keeper = keeperCheckbox ? keeperCheckbox.checked : false;

      if (expDisplay) expDisplay.textContent = `Level ${exp}`;
      if (batDisplay) batDisplay.textContent = bat;
      if (bowlDisplay) bowlDisplay.textContent = bowl;
      if (fieldDisplay) fieldDisplay.textContent = field;

      const r = CricketEngine.calculateRating({ exp, bat, bowl, field, keeper });
      if (ratingPreview) ratingPreview.textContent = r;
    };

    updatePreview();

    if (expSlider) expSlider.oninput = updatePreview;
    if (batSlider) batSlider.oninput = updatePreview;
    if (bowlSlider) bowlSlider.oninput = updatePreview;
    if (fieldSlider) fieldSlider.oninput = updatePreview;
    if (keeperCheckbox) keeperCheckbox.onchange = updatePreview;

    this.openModal('modal-edit-player');
  },

  async renderTeamsView() {
    const container = document.getElementById('teams-roster-container');
    const unassignedCard = document.getElementById('unassigned-players-card');
    const unassignedChips = document.getElementById('unassigned-chips-container');
    const unassignedCount = document.getElementById('unassigned-count');
    if (!container) return;

    const teams = await AppDB.getTeams();
    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    if (teams.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🛡️</div>
          <div class="empty-title">No teams created yet</div>
          <p style="margin-bottom: 12px;">Create custom teams or auto-balance from registered players.</p>
          ${AppDB.isStaff() ? `<div style="display: flex; gap: 8px; justify-content: center;"><button class="btn-primary" data-action="openAddTeam">➕ Add New Team</button>
            <button class="btn-secondary" data-action="openAddPlayer">👤 Add Player</button></div>` : ''}
        </div>
      `;
      if (unassignedCard) unassignedCard.style.display = 'none';
      return;
    }

    // Determine unassigned players
    const assignedIds = new Set();
    teams.forEach(t => (t.playerIds || []).forEach(id => assignedIds.add(id)));
    const unassigned = players.filter(p => !assignedIds.has(p.id));
    const isStaff = AppDB.isStaff();

    // Render team cards
    container.innerHTML = teams.map((team) => {
      const stats = TeamEngine.calculateTeamStats(team, pMap);
      const { cap, vc } = this.getTeamLeaders(team, pMap);
      const leadParts = [];
      if (cap) leadParts.push(`👑 <strong>${this.escapeHtml(cap.name)}</strong> (C)`);
      if (vc) leadParts.push(`⚡ <strong>${this.escapeHtml(vc.name)}</strong> (VC)`);
      const leadHtml = leadParts.length > 0 ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 2px;">${leadParts.join(' • ')}</div>` : '';
      const mottoHtml = team.motto ? `<div style="font-size: 0.75rem; color: var(--gold-amber); font-style: italic; margin-top: 2px;">"${this.escapeHtml(team.motto)}"</div>` : '';

      return `
        <div class="team-card">
          <div class="team-card-header">
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <h3 style="font-size: 1.15rem; font-weight: 800;">${this.escapeHtml(team.name)}</h3>
                ${isStaff ? `<button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" data-action="openEditTeam" data-id="${this.escapeHtml(team.id)}" title="Edit team leadership & details">✏️</button>
                <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem; color: var(--leather-red);" data-action="deleteTeam" data-id="${this.escapeHtml(team.id)}" data-name="${this.escapeHtml(team.name)}" title="Delete team">🗑️</button>` : ''}
              </div>
              ${leadHtml}
              ${mottoHtml}
              <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
                ${stats.count} players • Avg Rating: ${stats.avgRating}
              </div>
            </div>
            <div class="team-rating-badge">
              Rating: ${stats.totalRating}
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
            <div style="font-size: 0.72rem; color: var(--text-muted);">
              ${stats.roles.Batter} Bat • ${stats.roles.Bowler} Bowl • ${stats.roles['All-rounder']} AR • ${stats.keepers} WK
            </div>
            ${isStaff ? `<button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; min-height: 30px; border-color: var(--pitch-green); color: var(--pitch-green);" data-action="openAddPlayer" data-id="${this.escapeHtml(team.id)}">
              ➕ Add Player
            </button>` : ''}
          </div>

          <div class="team-players-list">
            ${(team.playerIds || []).length > 0 ? (team.playerIds || []).map(pid => {
              const p = pMap[pid];
              if (!p) return '';
              const r = CricketEngine.calculateRating(p);
              const isCap = Boolean(cap && p.id === cap.id);
              const isVc = Boolean(vc && p.id === vc.id);
              return `
                <div class="player-chip">
                  <div>
                    <strong>${this.escapeHtml(p.name)}</strong>
                    ${isCap ? '<span style="color: var(--gold-amber); font-weight: 800; font-size: 0.75rem; margin-left: 2px;">(C)</span>' : ''}
                    ${isVc ? '<span style="color: #60A5FA; font-weight: 800; font-size: 0.75rem; margin-left: 2px;">(VC)</span>' : ''}
                    <span style="font-size: 0.75rem; color: var(--text-muted); margin-left: 4px;">(${this.escapeHtml(p.roll)})</span>
                    <span style="font-size: 0.75rem; color: var(--text-secondary); margin-left: 4px;">• ${this.escapeHtml(p.role)}${p.keeper ? ' 🧤' : ''}</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 4px;">
                    <span class="chip-rating">⭐ ${r}</span>
                    ${isStaff ? `<button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" data-action="openEditPlayer" data-id="${this.escapeHtml(p.id)}" title="Edit player details">✏️</button>
                    <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" data-action="movePlayer" data-id="${this.escapeHtml(p.id)}" data-name="${this.escapeHtml(p.name)}" title="Move to another team or unassign">⇄</button>
                    <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem; color: var(--leather-red);" data-action="deletePlayer" data-id="${this.escapeHtml(p.id)}" data-name="${this.escapeHtml(p.name)}" title="Delete player">✕</button>` : ''}
                  </div>
                </div>
              `;
            }).join('') : '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 8px 0; text-align: center;">No players assigned yet. Tap "+ Add Player" above!</div>'}
          </div>
        </div>
      `;
    }).join('');

    // Render unassigned section
    if (unassignedCard && unassignedChips) {
      if (unassigned.length > 0) {
        unassignedCard.style.display = 'block';
        if (unassignedCount) unassignedCount.textContent = unassigned.length;
        unassignedChips.innerHTML = unassigned.map(p => `
          <div class="player-chip" style="display: inline-flex; width: auto;">
            <span>${this.escapeHtml(p.name)} (${this.escapeHtml(p.role)})</span>
            ${isStaff ? `<button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; margin-left: 6px;" data-action="openEditPlayer" data-id="${this.escapeHtml(p.id)}" title="Edit player">✏️</button>
            <button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; margin-left: 4px;" data-action="movePlayer" data-id="${this.escapeHtml(p.id)}" data-name="${this.escapeHtml(p.name)}">➕ Assign</button>
            <button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; color: var(--leather-red); margin-left: 4px;" data-action="deletePlayer" data-id="${this.escapeHtml(p.id)}" data-name="${this.escapeHtml(p.name)}">✕</button>` : ''}
          </div>
        `).join('');
      } else {
        unassignedCard.style.display = 'none';
      }
    }
  },

  async openMovePlayerModal(playerId, playerName) {
    const modal = document.getElementById('modal-move-player');
    const info = document.getElementById('move-player-info');
    const select = document.getElementById('select-target-team');
    const btn = document.getElementById('btn-confirm-move');
    if (!modal || !select || !btn) return;

    btn.dataset.playerId = playerId;
    if (info) info.textContent = `Reassign: ${playerName}`;

    const teams = await AppDB.getTeams();
    select.innerHTML = `
      <option value="unassigned">-- Move to Unassigned --</option>
      ${teams.map((t, idx) => `<option value="${idx}">${this.escapeHtml(t.name)}</option>`).join('')}
    `;

    this.openModal('modal-move-player');
  },

  // ==========================================
  // MATCH SCORING CONSOLE (Umpire, FR-9 to FR-16)
  // ==========================================
  setupScoringConsole() {
    // 1. Start Match Button
    const btnStart = document.getElementById('btn-start-match');
    if (btnStart) {
      btnStart.addEventListener('click', async () => {
        const teamAVal = document.getElementById('match-team-a').value;
        const teamBVal = document.getElementById('match-team-b').value;
        const oversVal = Number(document.getElementById('match-overs').value);

        if (!Number.isInteger(oversVal) || oversVal < 1 || oversVal > 50) {
          this.showToast('Please enter the overs as a whole number from 1 to 50', 'error');
          return;
        }

        if (teamAVal === teamBVal) {
          this.showToast('Please select two different teams!', 'error');
          return;
        }

        const teams = await AppDB.getTeams();
        const teamA = teams.find(t => t.name === teamAVal) || { name: teamAVal, playerIds: [] };
        const teamB = teams.find(t => t.name === teamBVal) || { name: teamBVal, playerIds: [] };

        if ((teamA.playerIds || []).length < 2 || (teamB.playerIds || []).length < 2) {
          this.showToast('Both teams need at least 2 players to start a match!', 'error');
          return;
        }

        const match = await AppDB.createMatch({
          teamA: teamA.name,
          teamB: teamB.name,
          teamAPlayerIds: teamA.playerIds,
          teamBPlayerIds: teamB.playerIds,
          overs: oversVal,
          strikerId: teamA.playerIds[0],
          nonStrikerId: teamA.playerIds[1],
          bowlerId: teamB.playerIds[0]
        });

        this.showToast(`🏏 Match started! ${teamA.name} bats first.`, 'success');
        this.renderScoringConsole();
      });
    }

    // 2. Modifier Buttons (Wide, No ball, Drop Catch, Bye, Leg bye)
    document.querySelectorAll('.modifier-buttons-row .mod-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mod = btn.getAttribute('data-mod');
        if (mod === 'wide') {
          // Instant Wide (+1): 1-tap immediately scores wide delivery and updates scoreboard
          this.recordDelivery(0, 'wide');
          return;
        }

        if (this.currentModifier === mod) {
          // Deselect
          this.currentModifier = null;
          btn.classList.remove('active');
        } else {
          document.querySelectorAll('.modifier-buttons-row .mod-btn').forEach(b => b.classList.remove('active'));
          this.currentModifier = mod;
          btn.classList.add('active');
          this.vibrate(20);
        }
      });
    });

    // Extra Runs Modal Open
    const btnOpenExtra = document.getElementById('btn-open-extra-runs');
    if (btnOpenExtra) {
      btnOpenExtra.addEventListener('click', () => {
        this.openModal('modal-extra-runs');
      });
    }

    const btnCustomExtra = document.getElementById('btn-submit-custom-extra');
    if (btnCustomExtra) {
      btnCustomExtra.addEventListener('click', () => {
        const val = Number(document.getElementById('custom-extra-runs-input')?.value);
        if (val && val > 0) {
          this.recordExtraRuns(val);
        }
      });
    }

    // Declare / Replace Batsman Buttons
    const btnDeclareStriker = document.getElementById('btn-declare-striker');
    if (btnDeclareStriker) {
      btnDeclareStriker.addEventListener('click', () => {
        this.openDeclareBatsmanModal('striker');
      });
    }

    const btnDeclareNonStriker = document.getElementById('btn-declare-non-striker');
    if (btnDeclareNonStriker) {
      btnDeclareNonStriker.addEventListener('click', () => {
        this.openDeclareBatsmanModal('nonStriker');
      });
    }

    const btnConfirmDeclare = document.getElementById('btn-confirm-declare-retire');
    if (btnConfirmDeclare) {
      btnConfirmDeclare.addEventListener('click', () => {
        this.confirmDeclareBatsman(true);
      });
    }

    const btnConfirmSimpleSwap = document.getElementById('btn-confirm-simple-swap');
    if (btnConfirmSimpleSwap) {
      btnConfirmSimpleSwap.addEventListener('click', () => {
        this.confirmDeclareBatsman(false);
      });
    }

    // 3. Scoring Keypad Numbers: 0, 1, 2, 3, 4, 6
    document.querySelectorAll('.scoring-keypad .score-key[data-run]').forEach(btn => {
      btn.addEventListener('click', () => {
        const runs = Number(btn.getAttribute('data-run'));
        this.recordDelivery(runs);
      });
    });

    // 4. Wicket Key
    const keyOut = document.getElementById('key-out');
    if (keyOut) {
      keyOut.addEventListener('click', () => {
        this.openWicketModal();
      });
    }

    // 5. Undo Key (FR-15)
    const keyUndo = document.getElementById('key-undo');
    if (keyUndo) {
      keyUndo.addEventListener('click', () => {
        this.undoLastDelivery();
      });
    }

    // 6. Swap Strike Manual Override
    const btnSwapStrike = document.getElementById('btn-swap-strike');
    if (btnSwapStrike) {
      btnSwapStrike.addEventListener('click', () => {
        this.swapStrikeManually();
      });
    }

    // 7. Striker / Non-striker / Bowler changes
    const selectStriker = document.getElementById('select-striker');
    const selectNonStriker = document.getElementById('select-non-striker');
    const selectBowler = document.getElementById('select-bowler');

    if (selectStriker) {
      selectStriker.addEventListener('change', async () => {
        if (!this.activeScoringMatch) return;
        this.activeScoringMatch.strikerId = selectStriker.value;
        await AppDB.updateMatch(this.activeScoringMatch.id, { strikerId: selectStriker.value });
        this.renderScoringConsole();
      });
    }

    if (selectNonStriker) {
      selectNonStriker.addEventListener('change', async () => {
        if (!this.activeScoringMatch) return;
        this.activeScoringMatch.nonStrikerId = selectNonStriker.value;
        await AppDB.updateMatch(this.activeScoringMatch.id, { nonStrikerId: selectNonStriker.value });
        this.renderScoringConsole();
      });
    }

    if (selectBowler) {
      selectBowler.addEventListener('change', async () => {
        if (!this.activeScoringMatch) return;
        const limit = this.getBowlerOverLimit(this.activeScoringMatch);
        const chosen = this.getCurrentInningsStats(this.activeScoringMatch).bowlers[selectBowler.value];
        if (chosen && chosen.legalBalls >= limit * 6) {
          this.showToast(`That bowler has already bowled the maximum ${limit} overs. Please choose another bowler.`, 'error');
          this.renderScoringConsole();
          return;
        }
        this.activeScoringMatch.bowlerId = selectBowler.value;
        await AppDB.updateMatch(this.activeScoringMatch.id, { bowlerId: selectBowler.value });
        this.renderScoringConsole();
      });
    }

    // 8. End Innings / Finish Match (FR-14)
    const btnEndInnings = document.getElementById('btn-end-innings');
    const btnFinishMatch = document.getElementById('btn-finish-match');

    if (btnEndInnings) {
      btnEndInnings.addEventListener('click', () => this.handleEndInnings());
    }

    if (btnFinishMatch) {
      btnFinishMatch.addEventListener('click', () => this.handleFinishMatch());
    }

    const btnDeleteLiveMatch = document.getElementById('btn-delete-live-match');
    if (btnDeleteLiveMatch) {
      btnDeleteLiveMatch.addEventListener('click', () => {
        if (this.activeScoringMatch) {
          this.confirmDeleteMatch(this.activeScoringMatch.id);
        }
      });
    }

    // Add a player while the match is live
    const btnLiveAddPlayer = document.getElementById('btn-live-add-player');
    if (btnLiveAddPlayer) {
      btnLiveAddPlayer.addEventListener('click', () => this.openLiveAddPlayerModal());
    }
    const formLiveAddPlayer = document.getElementById('form-live-add-player');
    if (formLiveAddPlayer) {
      formLiveAddPlayer.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submitLiveAddPlayer();
      });
    }

    // Next bowler (after an over)
    const btnConfirmNextBowler = document.getElementById('btn-confirm-next-bowler');
    if (btnConfirmNextBowler) {
      btnConfirmNextBowler.addEventListener('click', () => this.confirmNextBowler());
    }

    // 9. Confirm Wicket Modal Button
    const btnConfirmWicket = document.getElementById('btn-confirm-wicket');
    if (btnConfirmWicket) {
      btnConfirmWicket.addEventListener('click', () => this.confirmWicketSubmission());
    }

    // Wicket type selector change for run-out
    const wicketTypeSelect = document.getElementById('wicket-type-select');
    const runoutGroup = document.getElementById('runout-player-group');
    const runoutRunsGroup = document.getElementById('runout-runs-group');
    if (wicketTypeSelect && runoutGroup) {
      wicketTypeSelect.addEventListener('change', () => {
        runoutGroup.style.display = wicketTypeSelect.value === 'runout' ? 'block' : 'none';
        if (runoutRunsGroup) runoutRunsGroup.style.display = wicketTypeSelect.value === 'runout' ? 'block' : 'none';
      });
    }
  },

  async renderScoringConsole() {
    const setupSection = document.getElementById('umpire-match-setup');
    const consoleSection = document.getElementById('umpire-live-console');
    if (!setupSection || !consoleSection) return;

    // Find live match
    const matches = await AppDB.getMatches();
    const liveMatch = matches.find(m => m.status === 'live');
    this.activeScoringMatch = liveMatch || null;

    if (!liveMatch) {
      // Show setup
      setupSection.style.display = 'block';
      consoleSection.style.display = 'none';

      const teams = await AppDB.getTeams();
      const selectA = document.getElementById('match-team-a');
      const selectB = document.getElementById('match-team-b');
      if (selectA && selectB) {
        selectA.innerHTML = teams.map((t, i) => `<option value="${this.escapeHtml(t.name)}" ${i === 0 ? 'selected' : ''}>${this.escapeHtml(t.name)} (${(t.playerIds || []).length} players)</option>`).join('');
        selectB.innerHTML = teams.map((t, i) => `<option value="${this.escapeHtml(t.name)}" ${i === 1 ? 'selected' : ''}>${this.escapeHtml(t.name)} (${(t.playerIds || []).length} players)</option>`).join('');
      }
      return;
    }

    // Active live match present
    setupSection.style.display = 'none';
    consoleSection.style.display = 'flex';

    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    const is2ndInnings = (liveMatch.currentInnings === 2);
    const battingTeamName = is2ndInnings ? liveMatch.teamB : liveMatch.teamA;
    const bowlingTeamName = is2ndInnings ? liveMatch.teamA : liveMatch.teamB;
    const battingPlayerIds = is2ndInnings ? (liveMatch.teamBPlayerIds || []) : (liveMatch.teamAPlayerIds || []);
    const bowlingPlayerIds = is2ndInnings ? (liveMatch.teamAPlayerIds || []) : (liveMatch.teamBPlayerIds || []);

    const inningsBalls = (liveMatch.balls || []).filter(b => b.innings === liveMatch.currentInnings);
    const currentInningsStats = CricketEngine.replayInnings(inningsBalls, battingPlayerIds, bowlingPlayerIds, liveMatch.overs);

    // Update Header
    const inningsLabel = document.getElementById('umpire-innings-label');
    const matchTitle = document.getElementById('umpire-match-title');
    const bigScore = document.getElementById('umpire-big-score');
    const targetInfo = document.getElementById('umpire-target-info');

    if (inningsLabel) inningsLabel.textContent = `${liveMatch.currentInnings === 1 ? '1st' : '2nd'} INNINGS • ${battingTeamName.toUpperCase()} BATTING`;
    if (matchTitle) matchTitle.textContent = `${liveMatch.teamA} vs ${liveMatch.teamB} (${liveMatch.overs} Overs)`;
    if (bigScore) {
      bigScore.innerHTML = `
        ${currentInningsStats.totalRuns}/${currentInningsStats.wickets}
        <span style="font-size: 1.3rem; color: var(--text-secondary); margin-left: 8px;">(${currentInningsStats.oversFormatted} ov)</span>
      `;
    }

    // In 2nd innings, show target
    if (is2ndInnings && targetInfo) {
      const in1Balls = (liveMatch.balls || []).filter(b => b.innings === 1);
      const in1Stats = CricketEngine.replayInnings(in1Balls, liveMatch.teamAPlayerIds || [], liveMatch.teamBPlayerIds || [], liveMatch.overs);
      const target = in1Stats.totalRuns + 1;
      const needed = Math.max(0, target - currentInningsStats.totalRuns);
      const ballsRem = Math.max(0, (liveMatch.overs * 6) - currentInningsStats.legalBalls);
      targetInfo.style.display = 'block';
      targetInfo.textContent = `🎯 Target: ${target} runs | Need ${needed} runs from ${ballsRem} balls`;
    } else if (targetInfo) {
      targetInfo.style.display = 'none';
    }

    // Populate Batter Selectors
    const selectStriker = document.getElementById('select-striker');
    const selectNonStriker = document.getElementById('select-non-striker');
    const selectBowler = document.getElementById('select-bowler');

    // Filter out batsmen who are out
    const availableBatters = battingPlayerIds.filter(pid => {
      const bStat = currentInningsStats.batters[pid];
      return !bStat || !bStat.isOut;
    });

    if (selectStriker) {
      selectStriker.innerHTML = availableBatters.map(pid => {
        const p = pMap[pid];
        return `<option value="${this.escapeHtml(pid)}" ${pid === liveMatch.strikerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : this.escapeHtml(pid)}</option>`;
      }).join('');
      if (!liveMatch.strikerId && availableBatters.length > 0) {
        liveMatch.strikerId = availableBatters[0];
        selectStriker.value = availableBatters[0];
      }
    }

    if (selectNonStriker) {
      selectNonStriker.innerHTML = availableBatters.map(pid => {
        const p = pMap[pid];
        return `<option value="${this.escapeHtml(pid)}" ${pid === liveMatch.nonStrikerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : this.escapeHtml(pid)}</option>`;
      }).join('');
      if (!liveMatch.nonStrikerId && availableBatters.length > 1) {
        liveMatch.nonStrikerId = availableBatters[1];
        selectNonStriker.value = availableBatters[1];
      }
    }

    // Populate Bowler Selector (bowling team)
    if (selectBowler) {
      selectBowler.innerHTML = bowlingPlayerIds.map(pid => {
        const p = pMap[pid];
        return `<option value="${this.escapeHtml(pid)}" ${pid === liveMatch.bowlerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : this.escapeHtml(pid)}</option>`;
      }).join('');
      if (!liveMatch.bowlerId && bowlingPlayerIds.length > 0) {
        liveMatch.bowlerId = bowlingPlayerIds[0];
        selectBowler.value = bowlingPlayerIds[0];
      }
    }

    // Live batter & bowler stats snippets
    const strikerStats = document.getElementById('striker-live-stats');
    const nonStrikerStats = document.getElementById('non-striker-live-stats');
    const bowlerStats = document.getElementById('bowler-live-stats');

    if (strikerStats && liveMatch.strikerId) {
      const b = currentInningsStats.batters[liveMatch.strikerId] || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
      strikerStats.textContent = `${b.runs} (${b.balls}) • 4s: ${b.fours}, 6s: ${b.sixes} • SR: ${b.strikeRate}`;
    }

    if (nonStrikerStats && liveMatch.nonStrikerId) {
      const b = currentInningsStats.batters[liveMatch.nonStrikerId] || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
      nonStrikerStats.textContent = `${b.runs} (${b.balls}) • 4s: ${b.fours}, 6s: ${b.sixes} • SR: ${b.strikeRate}`;
    }

    if (bowlerStats && liveMatch.bowlerId) {
      const bw = currentInningsStats.bowlers[liveMatch.bowlerId] || { oversFormatted: '0.0', wickets: 0, runsConceded: 0, economy: '0.00' };
      bowlerStats.textContent = `${bw.oversFormatted}/${this.getBowlerOverLimit(liveMatch)} ov • ${bw.wickets} wkts, ${bw.runsConceded} runs • Econ: ${bw.economy}`;
    }

    // Current over deliveries reel
    const overBallsContainer = document.getElementById('umpire-over-balls');
    if (overBallsContainer) {
      if (currentInningsStats.currentOverBalls.length > 0) {
        overBallsContainer.innerHTML = currentInningsStats.currentOverBalls.map(b => `
          <div class="ball-badge ${b.type}">${this.escapeHtml(b.text)}</div>
        `).join('');
      } else {
        overBallsContainer.innerHTML = `<span style="color: var(--text-muted); font-size: 0.8rem;">Ready for delivery 1</span>`;
      }
    }

    // Populate Over-by-Over History in Umpire Console
    const umpireOversLog = document.getElementById('umpire-overs-history-log');
    if (umpireOversLog) {
      umpireOversLog.innerHTML = this.renderOversHistoryHTML(currentInningsStats, pMap);
    }
  },

  // Record a delivery (FR-11, FR-12, FR-13)
  async recordDelivery(runs, forcedModifier = null) {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const mod = forcedModifier || this.currentModifier;

    if (!this.ensureBowlerAllowed(match)) return;

    this.vibrate(40);

    // Save previous snapshot for FR-15 Undo
    const snapshot = {
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      currentInnings: match.currentInnings
    };

    const isDroppedCatch = (mod === 'dropcatch');
    const extraType = (mod === 'dropcatch') ? null : mod;
    const isLegal = (extraType !== 'wide' && extraType !== 'noball');

    let runsForTeam = runs;
    if (extraType === 'wide') runsForTeam = 1 + runs;
    if (extraType === 'noball') runsForTeam = 1 + runs;

    const ball = {
      id: 'ball_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      innings: match.currentInnings,
      batterId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      runs: runs,
      extraType: extraType,
      isWicket: false,
      isLegal: isLegal,
      totalRuns: runsForTeam,
      isDroppedCatch: isDroppedCatch,
      droppedCatch: isDroppedCatch,
      snapshot: snapshot,
      timestamp: Date.now()
    };

    // Calculate if strike swaps (FR-13)
    let shouldSwapStrike = false;
    if (extraType === 'wide') {
      shouldSwapStrike = (runs % 2 === 1);
    } else {
      shouldSwapStrike = (runs % 2 === 1);
    }

    if (shouldSwapStrike) {
      const temp = match.strikerId;
      match.strikerId = match.nonStrikerId;
      match.nonStrikerId = temp;
    }

    match.balls = match.balls || [];
    match.balls.push(ball);

    // Reset modifier
    this.currentModifier = null;
    document.querySelectorAll('.modifier-buttons-row .mod-btn').forEach(b => b.classList.remove('active'));

    // Toast notifications
    if (forcedModifier === 'wide') {
      this.showToast('Wide ball! +1 Run added to score.', 'info');
    } else if (isDroppedCatch) {
      this.showToast(`🖐️ Dropped Catch recorded! ${runs} runs scored.`, 'info');
    }

    // Check if over ended (6 legal balls in current over)
    const currentInningsBalls = match.balls.filter(b => b.innings === match.currentInnings);
    const legalBallsInCurrentInnings = currentInningsBalls.filter(b => b.isLegal).length;

    if (isLegal && (legalBallsInCurrentInnings % 6 === 0)) {
      // Strike swaps at end of over (FR-13)
      const temp = match.strikerId;
      match.strikerId = match.nonStrikerId;
      match.nonStrikerId = temp;

      this.showToast('🔔 Over Completed! Strike rotated.', 'info');
    }

    // Save to DB
    await AppDB.updateMatch(match.id, {
      balls: match.balls,
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId
    });

    this.renderScoringConsole();

    // Over finished: ask who bowls next
    this.maybePromptNextBowler(match);

    // Check automatic innings finish or target chase (FR-14)
    this.checkAutoMatchCompletion();
  },

  // Record Extra / Penalty Runs without increasing ball count
  async recordExtraRuns(runs) {
    if (!this.activeScoringMatch) {
      this.showToast('No active match currently being scored', 'error');
      return;
    }
    const match = this.activeScoringMatch;
    const numRuns = Math.max(1, Number(runs) || 1);

    const snapshot = {
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      currentInnings: match.currentInnings
    };

    const ball = {
      id: 'ball_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      innings: match.currentInnings,
      batterId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      runs: numRuns,
      extraType: 'penalty',
      isLegal: false,
      isPenalty: true,
      isWicket: false,
      totalRuns: numRuns,
      snapshot: snapshot,
      timestamp: Date.now()
    };

    match.balls = match.balls || [];
    match.balls.push(ball);

    await AppDB.updateMatch(match.id, {
      balls: match.balls
    });

    this.closeModal('modal-extra-runs');
    this.vibrate(25);
    this.showToast(`+${numRuns} Extra/Penalty Runs added (Ball count not increased)`, 'success');
    this.renderScoringConsole();
  },

  // Open Declare / Replace Batsman Modal
  openDeclareBatsmanModal(targetRole = 'striker') {
    if (!this.activeScoringMatch) {
      this.showToast('No active match currently loaded', 'error');
      return;
    }
    const match = this.activeScoringMatch;
    this._declareTargetRole = targetRole;

    const is2nd = (match.currentInnings === 2);
    const battingPlayerIds = is2nd ? (match.teamBPlayerIds || []) : (match.teamAPlayerIds || []);
    const battingTeamName = is2nd ? match.teamB : match.teamA;

    const currentId = (targetRole === 'striker') ? match.strikerId : match.nonStrikerId;
    const otherId = (targetRole === 'striker') ? match.nonStrikerId : match.strikerId;

    const players = AppDB.getLocalPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    const currentP = pMap[currentId];
    const roleLabel = (targetRole === 'striker') ? '⭐ Striker (On Strike)' : 'Non-Striker';

    const titleElem = document.getElementById('declare-modal-title');
    if (titleElem) {
      titleElem.textContent = `⭐ Declare / Replace ${roleLabel}`;
    }

    const infoElem = document.getElementById('declare-current-info');
    if (infoElem) {
      infoElem.innerHTML = `
        <div style="font-weight: 700; color: var(--pitch-green); margin-bottom: 2px;">
          ${roleLabel}: <strong>${currentP ? this.escapeHtml(currentP.name) : 'None'}</strong>
        </div>
        <div style="font-size: 0.78rem; color: var(--text-muted);">
          Team: <strong>${this.escapeHtml(battingTeamName)}</strong>
        </div>
      `;
    }

    const selectElem = document.getElementById('select-replacement-player');
    if (selectElem) {
      // Find candidate players from batting squad (exclude the other batsman currently at the crease)
      const candidateIds = battingPlayerIds.filter(pid => pid !== otherId);

      selectElem.innerHTML = candidateIds.map(pid => {
        const p = pMap[pid];
        const isCurrent = (pid === currentId);
        return `<option value="${this.escapeHtml(pid)}" ${isCurrent ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : this.escapeHtml(pid)} ${isCurrent ? '(Currently At Crease)' : ''}</option>`;
      }).join('');
    }

    this.openModal('modal-declare-batsman');
  },

  // Confirm Declare or Replace Batsman
  async confirmDeclareBatsman(isRetire = true) {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const targetRole = this._declareTargetRole || 'striker';
    const selectElem = document.getElementById('select-replacement-player');
    const newPlayerId = selectElem ? selectElem.value : null;

    if (!newPlayerId) {
      this.showToast('Please select a player to come to the crease', 'error');
      return;
    }

    const currentId = (targetRole === 'striker') ? match.strikerId : match.nonStrikerId;

    if (isRetire && currentId && currentId !== newPlayerId) {
      // Record retired/declared delivery in match balls
      const ball = {
        id: 'ball_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
        innings: match.currentInnings,
        batterId: currentId,
        outPlayerId: currentId,
        nonStrikerId: match.nonStrikerId,
        bowlerId: match.bowlerId,
        runs: 0,
        extraType: null,
        isWicket: true,
        wicketType: 'retired',
        isLegal: false,
        totalRuns: 0,
        timestamp: Date.now()
      };
      match.balls = match.balls || [];
      match.balls.push(ball);
    }

    // Set new player to the crease
    if (targetRole === 'striker') {
      match.strikerId = newPlayerId;
    } else {
      match.nonStrikerId = newPlayerId;
    }

    await AppDB.updateMatch(match.id, {
      balls: match.balls,
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId
    });

    this.closeModal('modal-declare-batsman');
    const players = AppDB.getLocalPlayers();
    const p = players.find(x => x.id === newPlayerId);
    this.showToast(`${p ? p.name : 'Player'} is now at the crease!`, 'success');
    this.renderScoringConsole();
  },

  // Open Wicket Modal (FR-11, FR-13)
  async openWicketModal() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const is2nd = (match.currentInnings === 2);
    const battingPlayerIds = is2nd ? (match.teamBPlayerIds || []) : (match.teamAPlayerIds || []);

    const inningsBalls = (match.balls || []).filter(b => b.innings === match.currentInnings);
    const inStats = CricketEngine.replayInnings(inningsBalls, battingPlayerIds, [], match.overs);

    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    // Available next batters (haven't batted or got out)
    const nextBatters = battingPlayerIds.filter(pid => {
      const b = inStats.batters[pid];
      const isAlreadyOut = b && b.isOut;
      const isCurrentStriker = (pid === match.strikerId);
      const isCurrentNonStriker = (pid === match.nonStrikerId);
      return !isAlreadyOut && !isCurrentStriker && !isCurrentNonStriker;
    });

    const selectNext = document.getElementById('select-next-batter');
    if (selectNext) {
      if (nextBatters.length > 0) {
        selectNext.innerHTML = nextBatters.map(pid => {
          const p = pMap[pid];
          return `<option value="${this.escapeHtml(pid)}">${p ? this.escapeHtml(p.name) : this.escapeHtml(pid)}</option>`;
        }).join('');
      } else {
        selectNext.innerHTML = `<option value="none">-- All Out / No more batsmen --</option>`;
      }
    }

    // Keep the run-out pickers in sync with the remembered dismissal type
    const wicketTypeNow = document.getElementById('wicket-type-select');
    const showRunout = Boolean(wicketTypeNow && wicketTypeNow.value === 'runout');
    ['runout-player-group', 'runout-runs-group'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = showRunout ? 'block' : 'none';
    });
    const runoutRunsSelect = document.getElementById('runout-runs-select');
    if (runoutRunsSelect) runoutRunsSelect.value = '0';

    this.openModal('modal-wicket');
  },

  // Confirm Wicket submission
  async confirmWicketSubmission() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const wType = document.getElementById('wicket-type-select').value;
    const runoutWho = document.getElementById('runout-player-select').value;
    const nextBatterId = document.getElementById('select-next-batter').value;
    const runoutRuns = (wType === 'runout')
      ? Math.max(0, Math.min(3, Number(document.getElementById('runout-runs-select')?.value) || 0))
      : 0;

    if (!this.ensureBowlerAllowed(match)) {
      this.closeModal('modal-wicket');
      return;
    }

    this.vibrate(80);

    const snapshot = {
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      currentInnings: match.currentInnings
    };

    let outPlayerId = match.strikerId;
    if (wType === 'runout' && runoutWho === 'nonStriker') {
      outPlayerId = match.nonStrikerId;
    }

    const ball = {
      id: 'ball_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      innings: match.currentInnings,
      batterId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      runs: runoutRuns,
      extraType: null,
      isWicket: true,
      wicketType: wType,
      outPlayerId: outPlayerId,
      isLegal: true,
      totalRuns: runoutRuns,
      snapshot: snapshot
    };

    // Replace out player with next batsman
    if (nextBatterId && nextBatterId !== 'none') {
      if (outPlayerId === match.strikerId) {
        match.strikerId = nextBatterId;
      } else {
        match.nonStrikerId = nextBatterId;
      }
    }

    // Batters crossed if an odd number of runs was completed before the run out
    if (runoutRuns % 2 === 1) {
      const crossed = match.strikerId;
      match.strikerId = match.nonStrikerId;
      match.nonStrikerId = crossed;
    }

    match.balls = match.balls || [];
    match.balls.push(ball);

    // Check if legal ball completed over
    const currentInningsBalls = match.balls.filter(b => b.innings === match.currentInnings);
    const legalBallsInCurrentInnings = currentInningsBalls.filter(b => b.isLegal).length;
    if (legalBallsInCurrentInnings % 6 === 0) {
      const temp = match.strikerId;
      match.strikerId = match.nonStrikerId;
      match.nonStrikerId = temp;
      this.showToast('🔔 WICKET & Over Finished! Strike rotated.', 'info');
    } else {
      this.showToast('🚨 WICKET! Batsman dismissed.', 'error');
    }

    this.closeModal('modal-wicket');

    await AppDB.updateMatch(match.id, {
      balls: match.balls,
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId
    });

    this.renderScoringConsole();
    this.maybePromptNextBowler(match);
    this.checkAutoMatchCompletion();
  },

  // Undo Last Delivery (FR-15)
  async undoLastDelivery() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    if (!match.balls || match.balls.length === 0) {
      this.showToast('No balls to undo in this match!', 'info');
      return;
    }

    const lastBall = match.balls[match.balls.length - 1];
    if (lastBall.snapshot) {
      match.strikerId = lastBall.snapshot.strikerId;
      match.nonStrikerId = lastBall.snapshot.nonStrikerId;
      match.bowlerId = lastBall.snapshot.bowlerId;
      match.currentInnings = lastBall.snapshot.currentInnings;
    }

    match.balls.pop();
    this.vibrate(30);

    await AppDB.updateMatch(match.id, {
      balls: match.balls,
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      currentInnings: match.currentInnings
    });

    this.showToast('↺ Last ball undone successfully!', 'info');
    this.renderScoringConsole();
  },

  // Swap strike manually
  async swapStrikeManually() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const temp = match.strikerId;
    match.strikerId = match.nonStrikerId;
    match.nonStrikerId = temp;

    await AppDB.updateMatch(match.id, {
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId
    });

    this.vibrate(25);
    this.showToast('Strike swapped manually', 'info');
    this.renderScoringConsole();
  },

  // Check if Innings or Match finished automatically
  async checkAutoMatchCompletion() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;

    const is2nd = (match.currentInnings === 2);
    const battingPlayerIds = is2nd ? (match.teamBPlayerIds || []) : (match.teamAPlayerIds || []);
    const bowlingPlayerIds = is2nd ? (match.teamAPlayerIds || []) : (match.teamBPlayerIds || []);

    const inBalls = (match.balls || []).filter(b => b.innings === match.currentInnings);
    const inStats = CricketEngine.replayInnings(inBalls, battingPlayerIds, bowlingPlayerIds, match.overs);

    // Check target chased in 2nd innings
    if (is2nd) {
      const in1Balls = (match.balls || []).filter(b => b.innings === 1);
      const in1Stats = CricketEngine.replayInnings(in1Balls, match.teamAPlayerIds || [], match.teamBPlayerIds || [], match.overs);
      const target = in1Stats.totalRuns + 1;

      if (inStats.totalRuns >= target || inStats.isInningsOver) {
        // Match Finished!
        const resultText = CricketEngine.generateMatchResultText(match.teamA, match.teamB, in1Stats, inStats, match.overs, battingPlayerIds.length);
        match.status = 'done';
        match.result = resultText;
        await AppDB.updateMatch(match.id, { status: 'done', result: resultText });
        this.showToast(`🏆 Match Finished! ${resultText}`, 'success');
        this.renderScoringConsole();
        this.navigateTo('view-history');
        return;
      }
    } else {
      // 1st innings over (overs completed or all out)
      if (inStats.isInningsOver) {
        if (confirm(`1st Innings ended! ${match.teamA} scored ${inStats.totalRuns}/${inStats.wickets}. Ready to start 2nd Innings?`)) {
          this.startSecondInnings();
        }
      }
    }
  },

  async handleEndInnings() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;

    if (match.currentInnings === 1) {
      if (confirm(`End 1st Innings now and start 2nd Innings chase for ${match.teamB}?`)) {
        this.startSecondInnings();
      }
    } else {
      this.handleFinishMatch();
    }
  },

  async startSecondInnings() {
    const match = this.activeScoringMatch;
    match.currentInnings = 2;
    // Set 2nd innings openers & opening bowler
    match.strikerId = (match.teamBPlayerIds && match.teamBPlayerIds[0]) || null;
    match.nonStrikerId = (match.teamBPlayerIds && match.teamBPlayerIds[1]) || null;
    match.bowlerId = (match.teamAPlayerIds && match.teamAPlayerIds[0]) || null;

    await AppDB.updateMatch(match.id, {
      currentInnings: 2,
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId
    });

    this.showToast(`🏏 2nd Innings Started! ${match.teamB} chasing.`, 'success');
    this.renderScoringConsole();
  },

  async handleFinishMatch() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;

    const in1Balls = (match.balls || []).filter(b => b.innings === 1);
    const in2Balls = (match.balls || []).filter(b => b.innings === 2);

    const in1 = CricketEngine.replayInnings(in1Balls, match.teamAPlayerIds || [], match.teamBPlayerIds || [], match.overs);
    const in2 = CricketEngine.replayInnings(in2Balls, match.teamBPlayerIds || [], match.teamAPlayerIds || [], match.overs);

    let result = CricketEngine.generateMatchResultText(match.teamA, match.teamB, in1, in2, match.overs, (match.teamBPlayerIds || []).length);
    const matchNrr = CricketEngine.calculateMatchNetRunRate(match);

    // Finishing before the match is complete: say so in the result instead of "Match in progress"
    const chased = in2.totalRuns > in1.totalRuns;
    const isComplete = chased || (match.currentInnings === 2 && in2.isInningsOver);
    if (result === 'Match in progress') {
      const lead = in1.totalRuns - in2.totalRuns;
      result = lead === 0
        ? 'Match Tied (ended early)'
        : `${match.teamA} won by ${lead} run${lead !== 1 ? 's' : ''} (ended early)`;
    }
    const earlyWarning = isComplete ? '' :
      `⚠️ This match is NOT complete (${match.currentInnings === 1 ? '1st innings still in progress' : match.teamB + ' are still batting'}). Finishing now locks the score and gives points on the runs scored so far.\n\n`;

    const nrrPrompt = matchNrr ? `\n\nNet Run Rate (NRR) Impact:\n• ${match.teamA}: ${matchNrr.teamA.nrrFormatted} (RR: ${matchNrr.teamA.runRate})\n• ${match.teamB}: ${matchNrr.teamB.nrrFormatted} (RR: ${matchNrr.teamB.runRate})` : '';

    if (confirm(`${earlyWarning}Finish match and publish final scorecard?\n\nResult: ${result}${nrrPrompt}`)) {
      match.status = 'done';
      match.result = result;
      match.nrrData = matchNrr;

      await AppDB.updateMatch(match.id, {
        status: 'done',
        result: result,
        nrrData: matchNrr
      });

      // Recalculate official tournament points table immediately with NRR
      const allMatches = await AppDB.getMatches();
      const allTeams = await AppDB.getTeams();
      const updatedTable = CricketEngine.calculatePointsTable(allMatches, allTeams);

      this.showToast(`🏆 Match complete! Net Run Rates & Standings updated.`, 'success');
      this.renderScoringConsole();
      this.renderPointsTable();

      // Open Post-Match NRR breakdown modal
      this.openMatchCompletedNRRModal(match, matchNrr, updatedTable);
    }
  },

  openMatchCompletedNRRModal(match, matchNrr, updatedTable) {
    const subtitle = document.getElementById('match-nrr-subtitle');
    const breakdown = document.getElementById('match-nrr-breakdown');
    const standings = document.getElementById('match-nrr-standings-preview');

    if (subtitle) subtitle.textContent = match.result || 'Match Completed';

    if (breakdown && matchNrr) {
      breakdown.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <!-- Team A -->
          <div style="background: var(--bg-surface-2); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
            <div style="font-weight: 700; font-size: 0.95rem; margin-bottom: 4px;">${this.escapeHtml(matchNrr.teamA.name)}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 6px;">
              ${matchNrr.teamA.runs}/${matchNrr.teamA.wickets} in ${matchNrr.teamA.oversFormatted} ov
              ${matchNrr.teamA.isAllOut ? '<span style="color: var(--leather-red); font-size: 0.72rem; font-weight: 700;"> (All Out - Full quota charged)</span>' : ''}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; margin-top: 4px;">
              <span>Run Rate: <strong>${matchNrr.teamA.runRate}</strong></span>
              <span class="nrr-badge ${matchNrr.teamA.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">${matchNrr.teamA.nrrFormatted}</span>
            </div>
          </div>

          <!-- Team B -->
          <div style="background: var(--bg-surface-2); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
            <div style="font-weight: 700; font-size: 0.95rem; margin-bottom: 4px;">${this.escapeHtml(matchNrr.teamB.name)}</div>
            <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 6px;">
              ${matchNrr.teamB.runs}/${matchNrr.teamB.wickets} in ${matchNrr.teamB.oversFormatted} ov
              ${matchNrr.teamB.isAllOut ? '<span style="color: var(--leather-red); font-size: 0.72rem; font-weight: 700;"> (All Out - Full quota charged)</span>' : ''}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8rem; margin-top: 4px;">
              <span>Run Rate: <strong>${matchNrr.teamB.runRate}</strong></span>
              <span class="nrr-badge ${matchNrr.teamB.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">${matchNrr.teamB.nrrFormatted}</span>
            </div>
          </div>
        </div>
      `;
    }

    if (standings && updatedTable) {
      standings.innerHTML = `
        <table class="cricket-table" style="font-size: 0.8rem;">
          <thead>
            <tr>
              <th style="width: 30px;">#</th>
              <th>Team</th>
              <th class="num-cell">P</th>
              <th class="num-cell">Pts</th>
              <th class="num-cell">Tournament NRR</th>
            </tr>
          </thead>
          <tbody>
            ${updatedTable.map((t, idx) => `
              <tr style="${(t.teamName === match.teamA || t.teamName === match.teamB) ? 'background: rgba(0, 230, 153, 0.08); font-weight: 700;' : ''}">
                <td style="text-align: center;">${idx + 1}</td>
                <td>${this.escapeHtml(t.teamName)}</td>
                <td class="num-cell">${t.played}</td>
                <td class="num-cell"><span class="pts-badge" style="font-size: 0.75rem; padding: 1px 6px;">${t.points}</span></td>
                <td class="num-cell"><span class="nrr-badge ${t.nrr > 0 ? 'nrr-positive' : (t.nrr < 0 ? 'nrr-negative' : 'nrr-neutral')}">${t.nrrFormatted}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    this.openModal('modal-match-nrr');
  },

  // ==========================================
  // OVER-BY-OVER HISTORY HELPERS
  // ==========================================
  renderOversHistoryHTML(inStats, pMap = {}) {
    if (!inStats || !inStats.oversHistory || inStats.oversHistory.length === 0) {
      return `<div style="text-align: center; color: var(--text-muted); font-size: 0.82rem; padding: 12px 8px;">No deliveries bowled in this innings yet</div>`;
    }

    return `
      <div class="overs-history-container" style="display: flex; flex-direction: column; gap: 8px;">
        ${inStats.oversHistory.map(over => {
          const bowlerObj = pMap[over.bowlerId];
          const bowlerName = bowlerObj ? bowlerObj.name : (over.bowlerName || over.bowlerId || 'Bowler');
          const isProgress = over.inProgress;
          const wktText = over.wickets > 0 ? `<span style="color: var(--leather-red); font-weight: 700;"> • ${over.wickets} Wkt${over.wickets > 1 ? 's' : ''}</span>` : '';
          const droppedText = over.droppedCatches > 0 ? `<span style="color: #ff9800; font-weight: 700; background: rgba(255,152,0,0.12); padding: 1px 6px; border-radius: 4px; margin-left: 6px;">🖐️ ${over.droppedCatches} Catch Dropped</span>` : '';

          return `
            <div class="over-history-card card" style="padding: 10px 12px; margin: 0; background: var(--bg-surface-2); border: 1px solid ${isProgress ? 'var(--pitch-green)' : 'var(--border-subtle)'}; border-radius: var(--radius-sm);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 6px;">
                  <span style="font-weight: 800; font-size: 0.88rem; color: var(--text-primary);">Over ${over.overNum}</span>
                  ${isProgress ? '<span class="status-badge" style="background: rgba(0, 230, 153, 0.15); color: var(--pitch-green); font-size: 0.68rem; padding: 1px 6px;">Current</span>' : ''}
                  <span style="font-size: 0.8rem; color: var(--electric-blue); font-weight: 600;">⚡ ${this.escapeHtml(bowlerName)}</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-secondary);">
                  <strong style="color: var(--text-primary);">${over.runs} runs</strong>${wktText}${droppedText}
                </div>
              </div>
              <div class="balls-reel" style="gap: 5px; min-height: 32px; padding: 2px 0;">
                ${over.balls.map(b => `<div class="ball-badge ${b.type}" title="${this.escapeHtml(b.tooltip || '')}">${this.escapeHtml(b.text)}</div>`).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  },

  toggleOverHistory(elementId) {
    const elem = document.getElementById(elementId);
    if (!elem) return;
    const isHidden = (elem.style.display === 'none');
    elem.style.display = isHidden ? 'block' : 'none';
    const icon = document.getElementById(elementId + '-toggle-icon');
    if (icon) {
      icon.textContent = isHidden ? '▲ Hide' : '▼ View All';
    }
  },

  // ==========================================
  // PUBLIC LIVE SCOREBOARD (FR-17, FR-18)
  // ==========================================
  setupLiveView() {
    const btnRefresh = document.getElementById('btn-refresh-live');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.refreshNow(true));
    }
  },

  async renderLiveView() {
    const container = document.getElementById('live-match-container');
    const secondaryContainer = document.getElementById('secondary-matches-container');
    if (!container) return;

    const matches = await AppDB.getMatches();
    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    // Look for live match
    const liveMatch = matches.find(m => m.status === 'live');
    const completedMatches = matches.filter(m => m.status === 'done');

    if (!liveMatch) {
      container.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">🏏</div>
          <div class="empty-title">No Match Currently Live</div>
          <p style="margin-bottom: 16px;">The tournament umpire will start live ball-by-ball scoring once players take the field.</p>
          ${this.renderNextFixtureHtml()}
          <div style="display: flex; justify-content: center; gap: 8px;">
            <button class="btn-primary" data-action="navigate" data-view="view-history">View Match History</button>
            <button class="btn-secondary" data-action="navigate" data-view="view-teams">View Teams & Squads</button>
          </div>
        </div>
      `;

      if (secondaryContainer) {
        secondaryContainer.innerHTML = this.renderRecentResultsHTML(completedMatches, pMap);
      }
      return;
    }

    // Live Match Hero Card (FR-17)
    const is2nd = (liveMatch.currentInnings === 2);
    const battingTeam = is2nd ? liveMatch.teamB : liveMatch.teamA;
    const bowlingTeam = is2nd ? liveMatch.teamA : liveMatch.teamB;
    const battingPlayerIds = is2nd ? (liveMatch.teamBPlayerIds || []) : (liveMatch.teamAPlayerIds || []);
    const bowlingPlayerIds = is2nd ? (liveMatch.teamAPlayerIds || []) : (liveMatch.teamBPlayerIds || []);

    const inningsBalls = (liveMatch.balls || []).filter(b => b.innings === liveMatch.currentInnings);
    const inStats = CricketEngine.replayInnings(inningsBalls, battingPlayerIds, bowlingPlayerIds, liveMatch.overs);

    // First innings stats
    const in1Balls = (liveMatch.balls || []).filter(b => b.innings === 1);
    const in1Stats = CricketEngine.replayInnings(in1Balls, liveMatch.teamAPlayerIds || [], liveMatch.teamBPlayerIds || [], liveMatch.overs);

    // Current run rate
    const totalLegalBalls = inStats.legalBalls;
    const crr = totalLegalBalls > 0 ? ((inStats.totalRuns / totalLegalBalls) * 6).toFixed(2) : "0.00";

    // Target calculation
    let targetHtml = '';
    if (is2nd) {
      const target = in1Stats.totalRuns + 1;
      const runsNeeded = Math.max(0, target - inStats.totalRuns);
      const ballsRem = Math.max(0, (liveMatch.overs * 6) - inStats.legalBalls);
      const rrr = ballsRem > 0 ? ((runsNeeded / ballsRem) * 6).toFixed(2) : "0.00";
      targetHtml = `
        <div class="target-banner">
          <span>🎯 Target: <strong>${target}</strong> (${runsNeeded} runs from ${ballsRem} balls)</span>
          <span>RRR: <strong>${rrr}</strong></span>
        </div>
      `;
    }

    // Striker and Non-striker details
    const striker = inStats.batters[liveMatch.strikerId] || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
    const strikerP = pMap[liveMatch.strikerId];
    const nonStriker = inStats.batters[liveMatch.nonStrikerId] || { runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: '0.0' };
    const nonStrikerP = pMap[liveMatch.nonStrikerId];
    const bowler = inStats.bowlers[liveMatch.bowlerId] || { oversFormatted: '0.0', wickets: 0, runsConceded: 0, economy: '0.00' };
    const bowlerP = pMap[liveMatch.bowlerId];
    const isStaff = AppDB.isStaff();

    container.innerHTML = `
      <div class="live-hero">
        <div class="live-header-bar">
          <div class="live-pill">
            <span class="status-dot"></span>
            <span>${is2nd ? '2nd Innings' : '1st Innings'} Live</span>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <div class="overs-badge">
              ${liveMatch.overs} Overs Match
            </div>
            ${isStaff ? `
              <button class="btn-danger" style="padding: 2px 8px; min-height: 26px; font-size: 0.72rem;" data-action="deleteMatch" data-id="${this.escapeHtml(liveMatch.id)}" title="Delete live match">
                🗑️ Delete
              </button>
            ` : ''}
          </div>
        </div>

        <div class="match-teams-title">
          <span>${this.escapeHtml(liveMatch.teamA)}</span>
          <span class="vs-badge">VS</span>
          <span>${this.escapeHtml(liveMatch.teamB)}</span>
        </div>

        <!-- Digital Score Display -->
        <div class="digital-score-box">
          <div>
            <div style="font-size: 0.85rem; color: var(--text-muted); font-weight: 700; text-transform: uppercase;">
              ${this.escapeHtml(battingTeam)}
            </div>
            <div class="main-score">
              ${inStats.totalRuns}/${inStats.wickets}
              <span style="font-size: 1.25rem; color: var(--text-secondary); margin-left: 6px;">(${inStats.oversFormatted} ov)</span>
            </div>
          </div>
          <div class="score-details">
            <div>CRR: <strong>${crr}</strong></div>
            ${is2nd ? `<div style="font-size: 0.8rem; color: var(--text-muted);">${this.escapeHtml(liveMatch.teamA)}: ${in1Stats.totalRuns}/${in1Stats.wickets} (${in1Stats.oversFormatted})</div>` : ''}
          </div>
          ${targetHtml}
        </div>

        <!-- On-Field Batters & Bowler -->
        <div class="onfield-grid">
          <!-- Batters Card -->
          <div class="field-person-card striker">
            <div class="field-person-header">
              <span>🏏 Batting</span>
              <span class="strike-star">⭐ on strike</span>
            </div>
            <div style="font-size: 0.85rem; margin-bottom: 4px;">
              <strong>${strikerP ? this.escapeHtml(strikerP.name) : 'Striker'}*</strong>:
              <span style="font-family: var(--font-mono); font-weight: 700; color: var(--pitch-green);">${striker.runs}</span> (${striker.balls})
              <span style="font-size: 0.75rem; color: var(--text-muted);">[4s: ${striker.fours}, 6s: ${striker.sixes}]</span>
            </div>
            <div style="font-size: 0.85rem; color: var(--text-secondary);">
              <strong>${nonStrikerP ? this.escapeHtml(nonStrikerP.name) : 'Non-Striker'}</strong>:
              <span style="font-family: var(--font-mono);">${nonStriker.runs}</span> (${nonStriker.balls})
              <span style="font-size: 0.75rem; color: var(--text-muted);">[4s: ${nonStriker.fours}, 6s: ${nonStriker.sixes}]</span>
            </div>
          </div>

          <!-- Bowler Card -->
          <div class="field-person-card">
            <div class="field-person-header">
              <span>⚡ Bowling</span>
              <span style="font-family: var(--font-mono); font-size: 0.8rem; color: var(--electric-blue);">Econ: ${bowler.economy}</span>
            </div>
            <div style="font-size: 0.88rem; font-weight: 700; margin-bottom: 2px;">
              ${bowlerP ? this.escapeHtml(bowlerP.name) : 'Bowler'}
            </div>
            <div class="field-person-stats">
              <span>Overs: <strong>${bowler.oversFormatted}</strong></span>
              <span>Wkts: <strong style="color: var(--leather-red);">${bowler.wickets}</strong></span>
              <span>Runs: <strong>${bowler.runsConceded}</strong></span>
            </div>
          </div>
        </div>

        <!-- Recent Deliveries Reel (FR-17: Last 12 balls) -->
        <div class="recent-balls-section">
          <div class="recent-balls-label">Recent Balls (Last 12)</div>
          <div class="balls-reel">
            ${inStats.recentBalls.length > 0 ? inStats.recentBalls.map(b => `<div class="ball-badge ${b.type}" title="${this.escapeHtml(b.tooltip || '')}">${this.escapeHtml(b.text)}</div>`).join('') : '<span style="color: var(--text-muted); font-size: 0.8rem;">No balls bowled yet in this innings</span>'}
          </div>
        </div>

        <!-- Over-by-Over History (anyone can see history of every over + dropped catches) -->
        <div class="over-history-section" style="margin-top: 14px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; cursor: pointer;" data-action="toggleOver" data-target="live-over-history">
            <span style="font-size: 0.88rem; font-weight: 800; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
              <span>📊 Over-by-Over History</span>
              <span class="overs-badge" style="font-size: 0.72rem; padding: 1px 6px;">${inStats.oversHistory.length} Overs</span>
            </span>
            <span id="live-over-history-toggle-icon" style="font-size: 0.75rem; color: var(--pitch-green); font-weight: 700;">▲ Hide</span>
          </div>
          <div id="live-over-history" style="display: block;">
            ${this.renderOversHistoryHTML(inStats, pMap)}
          </div>
        </div>

        <!-- Web Share Button (WhatsApp share) -->
        <div class="share-btn-wrap" style="margin-top: 14px;">
          <button class="btn-share" data-action="share" data-id="${this.escapeHtml(liveMatch.id)}" data-team-a="${this.escapeHtml(liveMatch.teamA)}" data-team-b="${this.escapeHtml(liveMatch.teamB)}" data-score="${inStats.totalRuns}/${inStats.wickets}" data-overs="${inStats.oversFormatted}">
            <span>📲 Share Live Score on WhatsApp</span>
          </button>
          <button class="btn-secondary" data-action="scorecard" data-id="${this.escapeHtml(liveMatch.id)}">
            📋 Full Scorecard
          </button>
        </div>
      </div>
    `;

    if (secondaryContainer) {
      secondaryContainer.innerHTML = this.renderRecentResultsHTML(completedMatches, pMap);
    }
  },

  // Latest finished matches (newest first by match date) shown under the live view
  renderRecentResultsHTML(completedMatches, pMap, limit = 3) {
    if (!completedMatches || completedMatches.length === 0) return '';
    const recent = [...completedMatches]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit);
    return `
      <div class="section-header" style="margin-top: 24px;">
        <h3 style="font-size: 1.1rem; font-weight: 700;">Recent Matches</h3>
        <button class="btn-secondary" style="padding: 4px 10px; min-height: 30px; font-size: 0.75rem;" data-action="navigate" data-view="view-history">View all</button>
      </div>
      ${recent.map(m => this.generateMatchCardHTML(m, pMap, false)).join('')}
    `;
  },

  // ---- Add past match (staff) ----
  // "8.0" -> 48 balls, "3.3" -> 21 balls, "8" -> 48. Returns NaN for anything else.
  parseOversToBalls(text) {
    const m = /^\s*(\d+)(?:\.([0-5]))?\s*$/.exec(String(text || ''));
    if (!m) return NaN;
    return Number(m[1]) * 6 + Number(m[2] || 0);
  },

  readPastMatchForm() {
    const val = (id) => document.getElementById(id)?.value;
    const num = (id) => (val(id) === '' ? NaN : Number(val(id)));
    const when = val('past-datetime');
    return {
      teamA: val('past-team-a'),
      teamB: val('past-team-b'),
      overs: num('past-overs'),
      inn1: {
        runs: num('past-a-runs'), wickets: num('past-a-wkts'),
        balls: this.parseOversToBalls(val('past-a-overs')),
        allOut: document.getElementById('past-a-allout')?.checked
      },
      inn2: {
        runs: num('past-b-runs'), wickets: num('past-b-wkts'),
        balls: this.parseOversToBalls(val('past-b-overs')),
        allOut: document.getElementById('past-b-allout')?.checked
      },
      playedAt: when ? new Date(when).getTime() : NaN
    };
  },

  // Shows the result the table will use, before saving
  updatePastMatchPreview() {
    const box = document.getElementById('past-result-preview');
    if (!box) return;
    const d = this.readPastMatchForm();
    const ok = [d.inn1.runs, d.inn1.wickets, d.inn1.balls, d.inn2.runs, d.inn2.wickets, d.inn2.balls].every(n => Number.isFinite(n));
    if (!ok || !d.teamA || !d.teamB || d.teamA === d.teamB) {
      box.style.display = 'none';
      return;
    }
    const teams = AppDB.getLocalTeams();
    const teamB = teams.find(t => t.name === d.teamB);
    const tmp = { overs: d.overs, summary: { inn1: d.inn1, inn2: d.inn2 } };
    const result = CricketEngine.generateMatchResultText(
      d.teamA, d.teamB,
      CricketEngine.getInningsStats(tmp, 1), CricketEngine.getInningsStats(tmp, 2),
      d.overs, ((teamB && teamB.playerIds) || []).length || 11
    );
    box.style.display = 'block';
    box.textContent = `Result: ${result}`;
  },

  async openAddPastMatchModal() {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to add a match', 'error');
      return;
    }
    const form = document.getElementById('form-add-past-match');
    if (form) form.reset();
    const teams = await AppDB.getTeams();
    const options = (selectedIdx) => teams.map((t, i) =>
      `<option value="${this.escapeHtml(t.name)}" ${i === selectedIdx ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('');
    const selA = document.getElementById('past-team-a');
    const selB = document.getElementById('past-team-b');
    if (selA) selA.innerHTML = options(0);
    if (selB) selB.innerHTML = options(1);
    const dt = document.getElementById('past-datetime');
    if (dt) dt.value = this.toLocalInputValue(Date.now());
    const overs = document.getElementById('past-overs');
    if (overs) overs.value = 8;
    const box = document.getElementById('past-result-preview');
    if (box) box.style.display = 'none';
    this.openModal('modal-add-past-match');
  },

  // ---- Edit match date/time (staff) ----
  toLocalInputValue(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  async openEditMatchDateModal(matchId) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to edit match date', 'error');
      return;
    }
    const match = await AppDB.getMatch(matchId);
    if (!match) return;
    const idInput = document.getElementById('edit-match-date-id');
    const info = document.getElementById('edit-match-date-info');
    const input = document.getElementById('edit-match-datetime');
    if (idInput) idInput.value = match.id;
    if (info) info.textContent = `${match.teamA} vs ${match.teamB}`;
    if (input) input.value = this.toLocalInputValue(match.createdAt);
    this.openModal('modal-edit-match-date');
  },

  // Web Share API
  shareLiveMatch(matchId, teamA, teamB, score, overs) {
    const text = `🏏 COLLEGE CRICKET TOURNAMENT LIVE!\n${teamA} vs ${teamB}\nScore: ${score} in ${overs} overs\nWatch live ball-by-ball score: ${window.location.origin}${window.location.pathname}#live`;
    if (navigator.share) {
      navigator.share({
        title: `${teamA} vs ${teamB} - Live Cricket Score`,
        text: text,
        url: window.location.href
      }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('📋 Live score summary copied to clipboard for WhatsApp!', 'success');
      });
    }
  },

  // ==========================================
  // MATCH HISTORY & PLAYERS (FR-19, FR-20, FR-21, FR-22)
  // ==========================================
  setupHistoryAndPlayers() {
    // Add past match (final scores only)
    const btnAddPast = document.getElementById('btn-open-add-past-match');
    if (btnAddPast) {
      btnAddPast.addEventListener('click', () => this.openAddPastMatchModal());
    }
    const formAddPast = document.getElementById('form-add-past-match');
    if (formAddPast) {
      formAddPast.addEventListener('input', () => this.updatePastMatchPreview());
      formAddPast.addEventListener('change', () => this.updatePastMatchPreview());
      formAddPast.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = this.readPastMatchForm();
        try {
          if (Number.isNaN(data.inn1.balls) || Number.isNaN(data.inn2.balls)) {
            throw new Error('Overs must look like 8.0 or 3.3 (the digit after the dot is balls, 0 to 5)');
          }
          const match = await AppDB.addPastMatch(data);
          this.closeModal('modal-add-past-match');
          this.showToast(`Saved: ${match.result}`, 'success');
          this.renderHistoryView();
          this.renderLiveView();
          this.renderPointsTable();
          this.renderPlayersTable();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    // Edit match date/time form
    const formEditMatchDate = document.getElementById('form-edit-match-date');
    if (formEditMatchDate) {
      formEditMatchDate.addEventListener('submit', async (e) => {
        e.preventDefault();
        const matchId = document.getElementById('edit-match-date-id').value;
        const value = document.getElementById('edit-match-datetime').value;
        const ts = value ? new Date(value).getTime() : NaN;
        if (!matchId || Number.isNaN(ts)) {
          this.showToast('Please pick a valid date and time', 'error');
          return;
        }
        try {
          await AppDB.updateMatch(matchId, { createdAt: ts });
          this.closeModal('modal-edit-match-date');
          this.showToast('Match date updated', 'success');
          this.renderHistoryView();
          this.renderLiveView();
        } catch (err) {
          this.showToast(err.message, 'error');
        }
      });
    }

    // History search
    const historySearch = document.getElementById('history-search-input');
    if (historySearch) {
      historySearch.addEventListener('input', () => this.renderHistoryView());
    }

    // Players search & sort toggles
    const playersSearch = document.getElementById('players-search-input');
    if (playersSearch) {
      playersSearch.addEventListener('input', () => this.renderPlayersTable());
    }

    const sortRuns = document.getElementById('sort-players-runs');
    const sortWickets = document.getElementById('sort-players-wickets');
    const sortRating = document.getElementById('sort-players-rating');

    this.playerSortMode = 'runs';

    if (sortRuns) {
      sortRuns.addEventListener('click', () => {
        this.playerSortMode = 'runs';
        this.renderPlayersTable();
      });
    }
    if (sortWickets) {
      sortWickets.addEventListener('click', () => {
        this.playerSortMode = 'wickets';
        this.renderPlayersTable();
      });
    }
    if (sortRating) {
      sortRating.addEventListener('click', () => {
        this.playerSortMode = 'rating';
        this.renderPlayersTable();
      });
    }
  },

  async renderHistoryView() {
    const container = document.getElementById('history-matches-list');
    if (!container) return;

    const matches = await AppDB.getMatches();
    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    const search = (document.getElementById('history-search-input')?.value || '').toLowerCase();
    const finishedMatches = matches.filter(m => m.status === 'done').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const filtered = finishedMatches.filter(m => {
      return (m.teamA || '').toLowerCase().includes(search) ||
             (m.teamB || '').toLowerCase().includes(search) ||
             (m.result || '').toLowerCase().includes(search);
    });

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">🏆</div>
          <div class="empty-title">No Completed Matches Yet</div>
          <p>Completed matches will appear here automatically with permanent ball-by-ball scorecards.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(m => this.generateMatchCardHTML(m, pMap, true)).join('');
  },

  generateMatchCardHTML(match, pMap, showDelete = true) {
    const in1 = CricketEngine.getInningsStats(match, 1);
    const in2 = CricketEngine.getInningsStats(match, 2);

    const dateStr = match.createdAt ? new Date(match.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const canDelete = AppDB.isStaff();

    return `
      <div class="card" style="margin-bottom: 14px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">${dateStr} • ${match.overs} OVERS MATCH</span>
          <span class="status-badge" style="background: rgba(0, 230, 153, 0.12); color: var(--pitch-green); font-size: 0.72rem;">FINISHED</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px; margin-bottom: 10px;">
          <div>
            <div style="font-weight: 700; font-size: 1rem;">${this.escapeHtml(match.teamA)}</div>
            <div style="font-family: var(--font-mono); font-size: 1.15rem; color: var(--text-primary); font-weight: 800;">
              ${in1.totalRuns}/${in1.wickets} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 400;">(${in1.oversFormatted})</span>
            </div>
          </div>
          <span class="vs-badge">VS</span>
          <div style="text-align: right;">
            <div style="font-weight: 700; font-size: 1rem;">${this.escapeHtml(match.teamB)}</div>
            <div style="font-family: var(--font-mono); font-size: 1.15rem; color: var(--text-primary); font-weight: 800;">
              ${in2.totalRuns}/${in2.wickets} <span style="font-size: 0.8rem; color: var(--text-muted); font-weight: 400;">(${in2.oversFormatted})</span>
            </div>
          </div>
        </div>

        <div style="background: rgba(0, 230, 153, 0.08); border-left: 3px solid var(--pitch-green); padding: 8px 12px; border-radius: 4px; font-weight: 700; font-size: 0.85rem; color: var(--pitch-green); margin-bottom: 8px;">
          🏆 ${this.escapeHtml(match.result || 'Match Completed')}
        </div>

        ${(() => {
          const matchNrr = match.nrrData || CricketEngine.calculateMatchNetRunRate(match);
          if (!matchNrr) return '';
          return `
            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 10px; background: var(--bg-surface-2); padding: 6px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
              <div>
                <strong>${this.escapeHtml(match.teamA)}:</strong> RR ${matchNrr.teamA.runRate} • <span class="nrr-badge ${matchNrr.teamA.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">NRR ${matchNrr.teamA.nrrFormatted}</span>
              </div>
              <div>
                <strong>${this.escapeHtml(match.teamB)}:</strong> RR ${matchNrr.teamB.runRate} • <span class="nrr-badge ${matchNrr.teamB.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">NRR ${matchNrr.teamB.nrrFormatted}</span>
              </div>
            </div>
          `;
        })()}

        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button class="btn-secondary" style="padding: 6px 14px; min-height: 38px; font-size: 0.8rem;" data-action="scorecard" data-id="${this.escapeHtml(match.id)}">
              📋 Full Scorecard
            </button>
            <button class="btn-share" style="padding: 6px 14px; min-height: 38px; font-size: 0.8rem;" data-action="shareResult" data-id="${this.escapeHtml(match.id)}">
              📲 Share
            </button>
          </div>

          ${(canDelete && showDelete) ? `
            <div style="display: flex; gap: 6px;">
              <button class="btn-secondary" style="padding: 4px 10px; min-height: 34px; font-size: 0.75rem;" data-action="editMatchDate" data-id="${this.escapeHtml(match.id)}">
                🕒 Edit Date
              </button>
              <button class="btn-danger" style="padding: 4px 10px; min-height: 34px; font-size: 0.75rem;" data-action="deleteMatch" data-id="${this.escapeHtml(match.id)}">
                🗑️ Delete
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  },

  async confirmDeleteMatch(matchId) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to delete matches', 'error');
      return;
    }
    if (confirm('Are you sure you want to delete this match record? This action cannot be undone.')) {
      try {
        await AppDB.deleteMatch(matchId);
      } catch (err) {
        this.showToast(err.message, 'error');
        return;
      }
      this.showToast('Match record deleted', 'info');
      this.renderHistoryView();
      this.renderLiveView();
      this.renderPointsTable();
      this.renderScoringConsole();
      this.renderPlayersTable();
    }
  },

  // Open Full Scorecard Modal (FR-17, FR-19)
  async openFullScorecardModal(matchId) {
    const match = await AppDB.getMatch(matchId);
    if (!match) return;

    const players = await AppDB.getPlayers();
    const pMap = {};
    players.forEach(p => { pMap[p.id] = p; });

    const title = document.getElementById('scorecard-modal-title');
    const sub = document.getElementById('scorecard-modal-subtitle');
    const body = document.getElementById('scorecard-modal-body');
    const btnShare = document.getElementById('btn-scorecard-share');

    if (title) title.textContent = `${match.teamA} vs ${match.teamB}`;
    if (sub) sub.textContent = `${match.overs} Overs Match • ${match.result || 'In Progress'}`;

    const in2Balls = (match.balls || []).filter(b => b.innings === 2);

    const in1 = CricketEngine.getInningsStats(match, 1);
    const in2 = CricketEngine.getInningsStats(match, 2);

    const renderInningsTable = (teamBattingName, repStats) => `
      <div style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border-medium);">
          <h4 style="font-size: 0.95rem; font-weight: 800; color: var(--pitch-green);">${this.escapeHtml(teamBattingName)} Batting</h4>
          <span style="font-family: var(--font-mono); font-weight: 800; font-size: 1.1rem;">${repStats.totalRuns}/${repStats.wickets} (${repStats.oversFormatted} ov)</span>
        </div>

        <div class="table-responsive">
          <table class="cricket-table">
            <thead>
              <tr>
                <th>Batter</th>
                <th class="num-cell">R</th>
                <th class="num-cell">B</th>
                <th class="num-cell">4s</th>
                <th class="num-cell">6s</th>
                <th class="num-cell">SR</th>
              </tr>
            </thead>
            <tbody>
              ${Object.values(repStats.batters).filter(b => b.balls > 0 || b.isOut).map(b => {
                const p = pMap[b.id];
                return `
                  <tr>
                    <td>
                      <span class="player-name">${p ? this.escapeHtml(p.name) : this.escapeHtml(b.id)}</span>
                      <span class="dismissal-note">${this.escapeHtml(b.dismissal)}</span>
                    </td>
                    <td class="num-cell" style="font-weight: 700;">${b.runs}</td>
                    <td class="num-cell">${b.balls}</td>
                    <td class="num-cell">${b.fours}</td>
                    <td class="num-cell">${b.sixes}</td>
                    <td class="num-cell">${b.strikeRate}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <div style="font-size: 0.78rem; color: var(--text-muted); margin: 6px 0;">
          Extras: <strong>${repStats.extras.total}</strong> (w ${repStats.extras.wide}, nb ${repStats.extras.noball}, b ${repStats.extras.bye}, lb ${repStats.extras.legbye})
        </div>

        <!-- Bowling Table -->
        <div class="table-responsive" style="margin-top: 10px;">
          <table class="cricket-table">
            <thead>
              <tr>
                <th>Bowler</th>
                <th class="num-cell">O</th>
                <th class="num-cell">M</th>
                <th class="num-cell">R</th>
                <th class="num-cell">W</th>
                <th class="num-cell">Econ</th>
              </tr>
            </thead>
            <tbody>
              ${Object.values(repStats.bowlers).filter(bw => bw.legalBalls > 0).map(bw => {
                const p = pMap[bw.id];
                return `
                  <tr>
                    <td><span class="player-name">${p ? this.escapeHtml(p.name) : this.escapeHtml(bw.id)}</span></td>
                    <td class="num-cell">${bw.oversFormatted}</td>
                    <td class="num-cell">${bw.maidens}</td>
                    <td class="num-cell">${bw.runsConceded}</td>
                    <td class="num-cell" style="font-weight: 700; color: var(--leather-red);">${bw.wickets}</td>
                    <td class="num-cell">${bw.economy}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>

        <!-- Innings Over-by-Over History -->
        <div style="margin-top: 12px; background: var(--bg-surface-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 10px;">
          <div style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;" data-action="toggleOver" data-target="scorecard-overs-${this.escapeHtml(teamBattingName).replace(/[^a-zA-Z0-9]/g, '_')}">
            <span style="font-size: 0.82rem; font-weight: 700; color: var(--text-secondary);">
              📊 Over-by-Over Log & Dropped Catches (${repStats.oversHistory.length} Overs)
            </span>
            <span id="scorecard-overs-${this.escapeHtml(teamBattingName).replace(/[^a-zA-Z0-9]/g, '_')}-toggle-icon" style="font-size: 0.75rem; color: var(--pitch-green); font-weight: 700;">▼ View All</span>
          </div>
          <div id="scorecard-overs-${this.escapeHtml(teamBattingName).replace(/[^a-zA-Z0-9]/g, '_')}" style="display: none; margin-top: 8px;">
            ${this.renderOversHistoryHTML(repStats, pMap)}
          </div>
        </div>
      </div>
    `;

    const matchNrr = match.nrrData || CricketEngine.calculateMatchNetRunRate(match);
    const nrrSectionHtml = matchNrr ? `
      <div style="background: var(--bg-surface-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 12px; margin-top: 14px;">
        <h4 style="font-size: 0.88rem; font-weight: 800; color: var(--gold-amber); margin: 0 0 8px 0;">⚡ Tournament Net Run Rate (NRR) Analysis</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.8rem;">
          <div>
            <strong>${this.escapeHtml(matchNrr.teamA.name)}:</strong> ${matchNrr.teamA.runs} runs in ${matchNrr.teamA.oversCharged.toFixed(1)} ov (RR: ${matchNrr.teamA.runRate})<br>
            Match NRR: <span class="nrr-badge ${matchNrr.teamA.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">${matchNrr.teamA.nrrFormatted}</span>
          </div>
          <div>
            <strong>${this.escapeHtml(matchNrr.teamB.name)}:</strong> ${matchNrr.teamB.runs} runs in ${matchNrr.teamB.oversCharged.toFixed(1)} ov (RR: ${matchNrr.teamB.runRate})<br>
            Match NRR: <span class="nrr-badge ${matchNrr.teamB.nrrVal >= 0 ? 'nrr-positive' : 'nrr-negative'}">${matchNrr.teamB.nrrFormatted}</span>
          </div>
        </div>
      </div>
    ` : '';

    if (body && match.summary) {
      // Entered by hand from final scores: show totals only (there is no ball-by-ball data)
      const totalsRow = (name, st, label) => `
        <div style="display: flex; justify-content: space-between; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--border-subtle);">
          <div><strong>${this.escapeHtml(name)}</strong> <span style="font-size: 0.75rem; color: var(--text-muted);">${label}</span></div>
          <span style="font-family: var(--font-mono); font-weight: 800; font-size: 1.1rem;">${st.totalRuns}/${st.wickets} (${st.oversFormatted} ov)${st.isAllOut ? ' • all out' : ''}</span>
        </div>`;
      body.innerHTML = `
        <p style="color: var(--text-muted); font-size: 0.82rem; margin-bottom: 8px;">Result entered from the final scores. No ball-by-ball scorecard was recorded for this match.</p>
        ${totalsRow(match.teamA, in1, '1st innings')}
        ${totalsRow(match.teamB, in2, '2nd innings')}
        ${nrrSectionHtml}
      `;
    } else if (body) {
      body.innerHTML = `
        ${renderInningsTable(match.teamA, in1)}
        ${(in2Balls.length > 0 || match.currentInnings === 2) ? renderInningsTable(match.teamB, in2) : '<p style="color: var(--text-muted); font-size: 0.85rem;">2nd Innings not yet commenced</p>'}
        ${nrrSectionHtml}
      `;
    }

    if (btnShare) {
      btnShare.onclick = () => {
        this.shareLiveMatch(match.id, match.teamA, match.teamB, `${in1.totalRuns}/${in1.wickets} & ${in2.totalRuns}/${in2.wickets}`, match.overs);
      };
    }

    this.openModal('modal-scorecard');
  },

  // Players Leaderboard Table (FR-20, FR-21, FR-22)
  async renderPlayersTable() {
    const tbody = document.getElementById('players-table-body');
    if (!tbody) return;

    const matches = await AppDB.getMatches();
    const players = await AppDB.getPlayers();
    const isAdmin = AppDB.isAdmin();

    // FR-21: Stats are derived by replaying stored balls
    const stats = CricketEngine.computeAggregatePlayerStats(matches, players);

    const search = (document.getElementById('players-search-input')?.value || '').toLowerCase();
    let filtered = stats.filter(s => {
      return (s.name || '').toLowerCase().includes(search) ||
             (s.roll || '').toLowerCase().includes(search) ||
             (s.role || '').toLowerCase().includes(search);
    });

    // Sorting
    if (this.playerSortMode === 'runs') {
      filtered.sort((a, b) => b.runs - a.runs || b.strikeRate - a.strikeRate);
    } else if (this.playerSortMode === 'wickets') {
      filtered.sort((a, b) => b.wickets - a.wickets || a.economy - b.economy);
    } else if (this.playerSortMode === 'rating') {
      filtered.sort((a, b) => b.rating - a.rating);
    }

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">No players found</td></tr>`;
      return;
    }

    const isStaff = AppDB.isStaff();
    document.querySelectorAll('.admin-only-col').forEach(el => {
      el.style.display = isStaff ? 'table-cell' : 'none';
    });

    tbody.innerHTML = filtered.map(s => {
      return `
      <tr>
        <td>
          <div style="font-weight: 700; color: var(--text-primary);">${this.escapeHtml(s.name)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">${this.escapeHtml(s.roll)}</div>
        </td>
        <td>
          <span style="font-size: 0.78rem; background: var(--bg-surface); padding: 2px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">${this.escapeHtml(s.role)}</span>
        </td>
        <td class="num-cell" style="font-weight: 800; color: var(--gold-amber);">⭐ ${s.rating}</td>
        <td class="num-cell" style="font-weight: 700; color: var(--pitch-green);">${s.runs} <span style="font-size: 0.72rem; color: var(--text-muted);">(${s.balls})</span></td>
        <td class="num-cell">${s.fours} / ${s.sixes}</td>
        <td class="num-cell">${s.strikeRate}</td>
        <td class="num-cell" style="font-weight: 700; color: var(--leather-red);">${s.wickets}</td>
        <td class="num-cell">${s.oversFormatted}</td>
        <td class="num-cell">${s.economy}</td>
        <td class="admin-only-col" style="${isStaff ? 'display: table-cell;' : 'display: none;'}">
          <div style="display: flex; gap: 4px; justify-content: flex-end;">
            <button class="btn-secondary" style="padding: 2px 8px; min-height: 28px; font-size: 0.72rem; border-color: var(--gold-amber); color: var(--gold-amber);" data-action="openEditPlayer" data-id="${this.escapeHtml(s.id)}" title="Edit player details">
              ✏️ Edit
            </button>
            ${isStaff ? `
              <button class="btn-danger" style="padding: 2px 8px; min-height: 28px; font-size: 0.72rem;" data-action="deletePlayer" data-id="${this.escapeHtml(s.id)}" data-name="${this.escapeHtml(s.name)}" title="Delete player">
                ✕
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
    }).join('');
  },

  async confirmDeletePlayer(playerId, playerName) {
    if (!AppDB.isStaff()) {
      this.showToast('Staff/Admin login required to delete players', 'error');
      return;
    }
    if (confirm(`Are you sure you want to delete player ${playerName}? They will also be removed from teams.`)) {
      try {
        await AppDB.deletePlayer(playerId);
        this.showToast(`Player ${playerName} deleted`, 'info');
        this.renderPlayersTable();
        this.renderTeamsView();
      } catch (err) {
        this.showToast(err.message, 'error');
      }
    }
  },

  // ==========================================
  // POINTS TABLE & NET RUN RATE (ICC NRR)
  // ==========================================
  setupTableView() {
    const btnRefresh = document.getElementById('btn-refresh-table');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => this.refreshNow(true));
    }
  },

  async renderPointsTable() {
    const tbody = document.getElementById('points-table-body');
    if (!tbody) return;

    const matches = await AppDB.getMatches();
    const teams = await AppDB.getTeams();

    if (teams.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">No teams registered yet</td></tr>`;
      return;
    }

    const tableRows = CricketEngine.calculatePointsTable(matches, teams);
    const showQ = tableRows.some(r => r.played > 0);
    this.updateTableLegend();

    tbody.innerHTML = tableRows.map((row, idx) => {
      const rank = idx + 1;
      let rankClass = '';
      if (rank === 1) rankClass = 'rank-1';
      else if (rank === 2) rankClass = 'rank-2';
      else if (rank === 3) rankClass = 'rank-3';

      const nrrClass = row.nrr > 0 ? 'nrr-positive' : (row.nrr < 0 ? 'nrr-negative' : 'nrr-neutral');

      return `
        <tr>
          <td style="text-align: center;">
            <span class="rank-badge ${rankClass}">${rank}</span>
          </td>
          <td>
            <div class="table-team-name">
              <span>${this.escapeHtml(row.teamName)}</span>${showQ && rank <= this.QUALIFY_SPOTS ? '<span class="q-badge" title="In a qualifying position">Q</span>' : ''}
            </div>
            ${row.motto ? `<div class="table-team-motto">"${this.escapeHtml(row.motto)}"</div>` : ''}
          </td>
          <td class="num-cell">${row.played}</td>
          <td class="num-cell" style="font-weight: 700; color: var(--pitch-green);">${row.won}</td>
          <td class="num-cell" style="color: var(--leather-red);">${row.lost}</td>
          <td class="num-cell">${row.tied}</td>
          <td class="num-cell"><span class="pts-badge">${row.points}</span></td>
          <td class="num-cell"><span class="nrr-badge ${nrrClass}">${row.nrrFormatted}</span></td>
        </tr>
      `;
    }).join('');
  },

  // ==========================================
  // REAL-TIME DATA CALLBACKS
  // ==========================================
  onPlayersDataChanged() {
    this.renderPlayersTable();
    this.renderTeamsView();
    if (this.activeView === 'view-scoring') this.renderScoringConsole();
    if (this.activeView === 'view-live') this.renderLiveView();
  },

  onTeamsDataChanged() {
    this.renderTeamsView();
    this.renderFixturesView();
    this.renderPointsTable();
    if (this.activeView === 'view-scoring') this.renderScoringConsole();
  },

  onMatchesDataChanged() {
    this.renderFixturesView();
    this.renderLiveView();
    this.renderHistoryView();
    this.renderPlayersTable();
    this.renderPointsTable();
    if (this.activeView === 'view-scoring') this.renderScoringConsole();
  },

  renderAll() {
    this.renderFixturesView();
    this.renderLiveView();
    this.renderPointsTable();
    this.renderHistoryView();
    this.renderPlayersTable();
    this.renderTeamsView();
    this.renderScoringConsole();
  },

  // ==========================================
  // MODAL & TOAST HELPERS
  // ==========================================
  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
  },

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
    toast.textContent = message;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  App.init();
});
