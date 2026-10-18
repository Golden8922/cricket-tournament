// Unified Database & Authentication Layer
// Vercel Blob cloud sync (polling) on top of localStorage
// Implements FR-1, FR-2, FR-3, FR-18, FR-22, FR-23, FR-24, FR-25

const AppDB = {
  // Configuration
  STORAGE_KEYS: {
    PLAYERS: 'cct_players',
    TEAMS: 'cct_teams',
    MATCHES: 'cct_matches',
    AUTH: 'cct_auth_user',
    LAST_SYNC: 'cct_last_synced_at',
    FIXTURES: 'cct_fixtures',
    DIRTY: 'cct_dirty_sections',
    PENDING_DELETED_MATCHES: 'cct_pending_deleted_matches'
  },

  // Sections of the shared state that are synced independently
  SECTIONS: ['players', 'teams', 'matches', 'fixtures'],

  CLOUD: {
    API_URL: '/api/sync',
    LOGIN_URL: '/api/login',
    CDN_URL: 'https://v0grmksww68yigcw.public.blob.vercel-storage.com/tournament_state.json',
    POLL_LIVE_MS: 2000,
    POLL_IDLE_MS: 8000,
    PUSH_RETRY_MS: 5000
  },

  _pushRetryAt: 0,
  _pollTimer: null,
  _pollingStarted: false,
  lastSyncOkAt: 0, // when we last heard from the server

  broadcastChannel: null,
  _cloudPushPromise: null,
  _cloudPushQueued: false,
  _isPulling: false,
  
  // Real-time listener callbacks
  listeners: {
    players: [],
    teams: [],
    matches: [],
    fixtures: [],
    auth: [],
    status: []
  },

  // Current session state
  currentUser: null, // { email: 'admin@college.edu', role: 'admin' }
  connectionStatus: 'online', // 'online' | 'offline' | 'reconnecting'

  // Initialize DB layer
  async init() {
    // Setup cross-tab sync channel
    if (window.BroadcastChannel) {
      try {
        this.broadcastChannel = new BroadcastChannel('cricket_tournament_sync');
        this.broadcastChannel.onmessage = (event) => {
          this.handleCrossTabMessage(event.data);
        };
      } catch (e) {
        console.warn('BroadcastChannel not supported', e);
      }
    }

    // Monitor browser online/offline events
    window.addEventListener('online', () => {
      this.setConnectionStatus('online');
      this.pullFromCloud();
    });
    window.addEventListener('offline', () => this.setConnectionStatus('offline'));

    // Check saved session
    const savedUser = localStorage.getItem(this.STORAGE_KEYS.AUTH);
    if (savedUser) {
      try {
        this.currentUser = JSON.parse(savedUser);
      } catch (e) {
        this.currentUser = null;
      }
    }
    if (!this.isSessionValid()) {
      this.currentUser = null;
      localStorage.removeItem(this.STORAGE_KEYS.AUTH);
    }

    // Remove a leftover setting from an old, removed option
    try { localStorage.removeItem('cct_firebase_config'); } catch (e) {}

    // Ensure seed data exists locally
    this.ensureSeedData();

    // Start real-time cloud sync across all devices
    this.startRealtimeSync();

    this.notifyStatusListeners();
    this.notifyAuthListeners();
  },

  // Ensure initial seed data exists
  ensureSeedData() {
    const existingPlayers = this.getLocalPlayers();
    const isOldData = existingPlayers.some(p => p.name === 'Aarav Sharma' || p.id === 'p1');
    if ((existingPlayers.length === 0 || isOldData) && typeof getInitialTournamentData !== 'undefined') {
      const initData = getInitialTournamentData();
      localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(initData.players));
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(initData.teams));
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify([])); // Fresh tournament with clean score history!
    }
  },

  // Reset to official 4 teams and 55 players
  resetToDemoData() {
    this.requireStaff();
    if (typeof getInitialTournamentData !== 'undefined') {
      const initData = getInitialTournamentData();
      localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(initData.players));
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(initData.teams));
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify([]));

      this.notifyListeners('players');
      this.notifyListeners('teams');
      this.notifyListeners('matches');
      this.broadcast('data_reset');
      this.queueSync(['players', 'teams', 'matches']);
    }
  },

  // Real-time Cloud Sync Engine (multi-device live scores)
  // Polls quickly while a match is live (or this device has unsent changes / a staff member is
  // signed in), slowly otherwise, and not at all while the tab is hidden.
  startRealtimeSync() {
    if (this._pollingStarted) return;
    this._pollingStarted = true;

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          clearTimeout(this._pollTimer);
        } else {
          this.pullFromCloud();
          this._scheduleNextPoll();
        }
      });
    }

    // Initial pull immediately
    this.pullFromCloud();
    this._scheduleNextPoll();
  },

  _pollDelay() {
    const liveMatch = this.getLocalMatches().some(m => m && m.status === 'live');
    return (liveMatch || this.hasUnsentChanges() || this.isStaff())
      ? this.CLOUD.POLL_LIVE_MS
      : this.CLOUD.POLL_IDLE_MS;
  },

  _scheduleNextPoll() {
    clearTimeout(this._pollTimer);
    if (typeof document !== 'undefined' && document.hidden) return;
    this._pollTimer = setTimeout(async () => {
      await this.pullFromCloud();
      this._scheduleNextPoll();
    }, this._pollDelay());
  },

  // Refresh right now (used by the Refresh buttons and pull-to-refresh)
  async refreshNow() {
    clearTimeout(this._pollTimer);
    await this.pullFromCloud();
    this._scheduleNextPoll();
    return this.lastSyncOkAt;
  },

  // ---- Dirty-section tracking -------------------------------------------
  // A section stays "dirty" until the server confirms it received it, so a
  // failed/offline push is retried and a pull never overwrites unsent work.
  getDirty() {
    try {
      const arr = JSON.parse(localStorage.getItem(this.STORAGE_KEYS.DIRTY) || '[]');
      return Array.isArray(arr) ? arr.filter(s => this.SECTIONS.includes(s)) : [];
    } catch (e) {
      return [];
    }
  },

  setDirty(list) {
    try {
      if (list.length === 0) localStorage.removeItem(this.STORAGE_KEYS.DIRTY);
      else localStorage.setItem(this.STORAGE_KEYS.DIRTY, JSON.stringify(list));
    } catch (e) {}
  },

  // Ids of matches deleted here that the server has not been told about yet
  getPendingDeletedMatches() {
    try {
      const arr = JSON.parse(localStorage.getItem(this.STORAGE_KEYS.PENDING_DELETED_MATCHES) || '[]');
      return Array.isArray(arr) ? arr.filter(id => typeof id === 'string') : [];
    } catch (e) {
      return [];
    }
  },

  setPendingDeletedMatches(ids) {
    try {
      if (ids.length === 0) localStorage.removeItem(this.STORAGE_KEYS.PENDING_DELETED_MATCHES);
      else localStorage.setItem(this.STORAGE_KEYS.PENDING_DELETED_MATCHES, JSON.stringify(ids));
    } catch (e) {}
  },

  hasUnsentChanges() {
    return this.getDirty().length > 0 || this.getPendingDeletedMatches().length > 0;
  },

  markDirty(sections) {
    const set = new Set(this.getDirty());
    sections.forEach(s => { if (this.SECTIONS.includes(s)) set.add(s); });
    this.setDirty([...set]);
  },

  getLocalSection(section) {
    if (section === 'players') return this.getLocalPlayers();
    if (section === 'teams') return this.getLocalTeams();
    if (section === 'fixtures') return this.getLocalFixtures();
    return this.getLocalMatches();
  },

  // Mark sections as changed locally and push them to the cloud
  queueSync(sections) {
    this.markDirty(sections);
    return this.pushToCloud();
  },

  async pushToCloud() {
    if (this._cloudPushPromise) {
      this._cloudPushQueued = true;
      return;
    }

    const token = this.getAuthToken();
    const dirty = this.getDirty();
    const pendingDeleted = this.getPendingDeletedMatches();
    if (!token || (dirty.length === 0 && pendingDeleted.length === 0)) return;

    const sections = {};
    dirty.forEach(s => { sections[s] = this.getLocalSection(s); });

    this._cloudPushPromise = (async () => {
      try {
        const res = await fetch(this.CLOUD.API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ sections, deleted: { matches: pendingDeleted } })
        });

        if (res.ok) {
          const json = await res.json();
          // Clear only sections that were not edited again while the request was in flight
          const stillDirty = this.getDirty().filter(s =>
            !dirty.includes(s) || JSON.stringify(this.getLocalSection(s)) !== JSON.stringify(sections[s])
          );
          this.setDirty(stillDirty);
          this.setPendingDeletedMatches(this.getPendingDeletedMatches().filter(id => !pendingDeleted.includes(id)));
          if (json && json.data) this.applyRemote(json.data);
          this.lastSyncOkAt = Date.now();
          this.setConnectionStatus('online');
        } else if (res.status === 401) {
          // Session expired or token rejected: keep changes dirty, ask for re-login
          this._pushRetryAt = Date.now() + this.CLOUD.PUSH_RETRY_MS;
          this.handleSessionExpired();
        } else {
          this._pushRetryAt = Date.now() + this.CLOUD.PUSH_RETRY_MS;
          console.warn('Cloud sync push rejected:', res.status);
          this.setConnectionStatus('reconnecting');
        }
      } catch (err) {
        this._pushRetryAt = Date.now() + this.CLOUD.PUSH_RETRY_MS;
        console.warn('Cloud sync push warning:', err.message);
        if (navigator.onLine !== false) this.setConnectionStatus('reconnecting');
      } finally {
        this._cloudPushPromise = null;
        if (this._cloudPushQueued) {
          this._cloudPushQueued = false;
          this.pushToCloud();
        }
      }
    })();
  },

  // Merge remote matches into local ones by match id (newest copy wins). Matches that exist
  // only on this device are kept and queued for upload, and deletions are applied via the
  // server's deleted-id list, so a pull can never silently drop a locally scored match.
  mergeMatchesFrom(remoteData) {
    const remoteMatches = Array.isArray(remoteData.matches) ? remoteData.matches : [];
    const pending = new Set(this.getPendingDeletedMatches());
    const deleted = new Set([...(remoteData.deletedMatchIds || []), ...pending]);

    const byId = new Map();
    remoteMatches.forEach(m => {
      if (m && m.id && !deleted.has(m.id)) byId.set(m.id, m);
    });

    let localOnly = false;
    this.getLocalMatches().forEach(m => {
      if (!m || !m.id || deleted.has(m.id)) return;
      const remote = byId.get(m.id);
      if (!remote) {
        byId.set(m.id, m);
        localOnly = true;
      } else if (Number(m.updatedAt || 0) > Number(remote.updatedAt || 0)) {
        byId.set(m.id, m);
      }
    });

    const merged = [...byId.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    const next = JSON.stringify(merged);
    let changed = false;
    if (localStorage.getItem(this.STORAGE_KEYS.MATCHES) !== next) {
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, next);
      changed = true;
    }
    if (localOnly) this.markDirty(['matches']);
    return changed;
  },

  // Apply a remote snapshot to local storage
  applyRemote(remoteData) {
    if (!remoteData || !remoteData.updatedAt) return;
    const changed = [];

    if (Array.isArray(remoteData.matches) && this.mergeMatchesFrom(remoteData)) {
      changed.push('matches');
    }

    // Players and teams: replace with the newer remote copy unless there are unsent local edits
    const localSyncedAt = Number(localStorage.getItem(this.STORAGE_KEYS.LAST_SYNC) || 0);
    if (remoteData.updatedAt > localSyncedAt) {
      localStorage.setItem(this.STORAGE_KEYS.LAST_SYNC, String(remoteData.updatedAt));
      const dirty = this.getDirty();

      ['players', 'teams', 'fixtures'].forEach(section => {
        if (dirty.includes(section)) return;
        const incoming = remoteData[section];
        // Never replace squads with an empty list (an empty fixture list is a valid state)
        if (!Array.isArray(incoming) || (incoming.length === 0 && section !== 'fixtures')) return;

        const key = this.STORAGE_KEYS[section.toUpperCase()];
        const next = JSON.stringify(incoming);
        if (localStorage.getItem(key) !== next) {
          localStorage.setItem(key, next);
          changed.push(section);
        }
      });
    }

    changed.forEach(section => this.notifyListeners(section));
    if (changed.length > 0) this.broadcast('cloud_sync');
  },

  async pullFromCloud() {
    if (this._isPulling || this._cloudPushPromise) return;

    // Retry any unsent local changes first
    if (this.hasUnsentChanges() && this.getAuthToken() && Date.now() >= this._pushRetryAt) {
      this.pushToCloud();
      return;
    }

    this._isPulling = true;

    try {
      let remoteData = null;
      let cloudIsEmpty = false;

      // 1) Direct CDN read with cache-busting timestamp
      try {
        const cdnRes = await fetch(`${this.CLOUD.CDN_URL}?_t=${Date.now()}`, { cache: 'no-store' });
        if (cdnRes.ok) {
          const json = await cdnRes.json();
          if (json && json.updatedAt) remoteData = json;
        }
      } catch (e) {}

      // 2) Fallback: API read. Only an explicit "empty" answer means the cloud has no data.
      if (!remoteData) {
        try {
          const apiRes = await fetch(`${this.CLOUD.API_URL}?_t=${Date.now()}`, { cache: 'no-store' });
          if (apiRes.ok) {
            const json = await apiRes.json();
            if (json && json.status === 'empty') cloudIsEmpty = true;
            else if (json && json.data && json.data.updatedAt) remoteData = json.data;
          }
        } catch (e) {}
      }

      if (!remoteData) {
        if (cloudIsEmpty && this.getAuthToken()) {
          // Cloud confirmed empty: let a signed-in staff member seed it
          this.markDirty(['players', 'teams', 'matches']);
          this.pushToCloud();
        } else if (!cloudIsEmpty && navigator.onLine !== false) {
          // Both reads failed: never push anything, just report the connection state
          this.setConnectionStatus('reconnecting');
        }
        return;
      }

      this.applyRemote(remoteData);
      this.lastSyncOkAt = Date.now();
      this.setConnectionStatus('online');

      // Anything found only on this device (or still unsent) goes up as soon as staff are signed in
      if (this.hasUnsentChanges() && this.getAuthToken()) this.pushToCloud();
    } catch (err) {
      console.warn('Cloud pull error:', err.message);
    } finally {
      this._isPulling = false;
    }
  },

  // Handle cross-tab or remote messages
  handleCrossTabMessage(data) {
    if (!data) return;
    if (['players', 'teams', 'matches'].includes(data.type)) {
      this.notifyListeners(data.type);
    } else if (data.type === 'data_reset' || data.type === 'cloud_sync') {
      this.notifyListeners('players');
      this.notifyListeners('teams');
      this.notifyListeners('matches');
    }
  },

  broadcast(type) {
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({ type, timestamp: Date.now() });
      } catch (e) {}
    }
  },

  // Connection status management
  setConnectionStatus(status) {
    this.connectionStatus = status;
    this.notifyStatusListeners();
  },

  // Add New Player (with optional immediate team assignment)
  async addPlayer(playerData, teamId = null) {
    this.requireStaff();
    const name = (playerData.name || '').trim();
    const roll = (playerData.roll || '').trim();
    if (!name) throw new Error('Player full name is required');
    if (!roll) throw new Error('Roll or enrollment number is required');

    // Duplicate roll numbers check (case-insensitive)
    const players = await this.getPlayers();
    const exists = players.some(p => (p.roll || '').trim().toLowerCase() === roll.toLowerCase());
    if (exists) {
      throw new Error(`Roll number "${roll}" is already registered! Please use a unique roll number.`);
    }

    const newPlayer = {
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      name: name,
      roll: roll,
      role: playerData.role || 'Batter',
      exp: Number(playerData.exp) || 0,
      bat: Number(playerData.bat) || 1,
      bowl: Number(playerData.bowl) || 1,
      field: Number(playerData.field) || 1,
      keeper: Boolean(playerData.keeper),
      createdAt: Date.now()
    };

    const updated = [newPlayer, ...players];
    localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(updated));

    // If assigned to a team
    if (teamId && teamId !== 'unassigned') {
      const teams = this.getLocalTeams();
      const targetTeam = teams.find(t => t.id === teamId || t.name === teamId);
      if (targetTeam) {
        targetTeam.playerIds = targetTeam.playerIds || [];
        if (!targetTeam.playerIds.includes(newPlayer.id)) {
          targetTeam.playerIds.push(newPlayer.id);
          await this.saveTeams(teams);
        }
      }
    }

    this.notifyListeners('players');
    this.notifyListeners('teams');
    this.broadcast('players');
    this.broadcast('teams');
    this.queueSync(['players', 'teams']);

    return newPlayer;
  },

  async registerPlayer(playerData) {
    return this.addPlayer(playerData);
  },

  // Delete player
  async deletePlayer(playerId) {
    this.requireStaff();
    const players = this.getLocalPlayers().filter(p => p.id !== playerId);
    localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(players));
    
    // Also remove from teams
    const teams = this.getLocalTeams();
    teams.forEach(t => {
      t.playerIds = (t.playerIds || []).filter(id => id !== playerId);
    });
    localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));

    this.notifyListeners('players');
    this.notifyListeners('teams');
    this.broadcast('players');
    this.broadcast('teams');
    this.queueSync(['players', 'teams']);
  },

  // Update Player (Admin & Umpire can update anytime)
  async updatePlayer(playerId, patchData) {
    this.requireStaff();
    const players = this.getLocalPlayers();
    const idx = players.findIndex(p => p.id === playerId);
    if (idx === -1) throw new Error('Player not found');

    const { teamId: _teamIdIgnored, ...playerPatch } = patchData;
    players[idx] = { ...players[idx], ...playerPatch, updatedAt: Date.now() };
    localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(players));

    // Handle team change if teamId is provided
    if (patchData.teamId !== undefined) {
      const teams = this.getLocalTeams();
      teams.forEach(t => {
        t.playerIds = (t.playerIds || []).filter(id => id !== playerId);
      });
      if (patchData.teamId && patchData.teamId !== 'unassigned') {
        const targetTeam = teams.find(t => t.id === patchData.teamId || t.name === patchData.teamId);
        if (targetTeam) {
          targetTeam.playerIds = targetTeam.playerIds || [];
          if (!targetTeam.playerIds.includes(playerId)) {
            targetTeam.playerIds.push(playerId);
          }
        }
      }
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));
      this.notifyListeners('teams');
      this.broadcast('teams');
    }


    this.notifyListeners('players');
    this.broadcast('players');
    this.queueSync(['players', 'teams']);
    return players[idx];
  },

  // Update Team (Admin & Umpire can update team details, captain, VC anytime)
  async updateTeam(teamId, patchData) {
    this.requireStaff();
    const teams = this.getLocalTeams();
    const idx = teams.findIndex(t => t.id === teamId);
    if (idx === -1) throw new Error('Team not found');

    teams[idx] = { ...teams[idx], ...patchData, updatedAt: Date.now() };
    await this.saveTeams(teams);
    return teams[idx];
  },

  // Add New Team
  async addTeam(teamName) {
    this.requireStaff();
    const cleanName = (teamName || '').trim();
    if (!cleanName) throw new Error('Team name is required');

    const teams = this.getLocalTeams();
    const exists = teams.some(t => t.name.toLowerCase() === cleanName.toLowerCase());
    if (exists) {
      throw new Error(`A team named "${cleanName}" already exists!`);
    }

    const newTeam = {
      id: 'team_' + Date.now(),
      name: cleanName,
      playerIds: []
    };

    teams.push(newTeam);
    await this.saveTeams(teams);
    return newTeam;
  },

  // Delete Team (preserves players in the pool)
  async deleteTeam(teamId) {
    this.requireStaff();
    const teams = this.getLocalTeams().filter(t => t.id !== teamId);
    await this.saveTeams(teams);
  },

  // Rename Team
  async renameTeam(teamId, newName) {
    this.requireStaff();
    const cleanName = (newName || '').trim();
    if (!cleanName) throw new Error('Team name cannot be empty');

    const teams = this.getLocalTeams();
    const target = teams.find(t => t.id === teamId);
    if (target) {
      target.name = cleanName;
      await this.saveTeams(teams);
    }
  },

  // Get all registered players
  async getPlayers() {
    return this.getLocalPlayers();
  },

  getLocalPlayers() {
    try {
      const str = localStorage.getItem(this.STORAGE_KEYS.PLAYERS);
      return str ? JSON.parse(str) : [];
    } catch (e) {
      return [];
    }
  },

  // Teams Management
  async getTeams() {
    return this.getLocalTeams();
  },

  getLocalTeams() {
    try {
      const str = localStorage.getItem(this.STORAGE_KEYS.TEAMS);
      return str ? JSON.parse(str) : [];
    } catch (e) {
      return [];
    }
  },

  async saveTeams(teams) {
    this.requireStaff();
    localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));
    this.notifyListeners('teams');
    this.broadcast('teams');
    this.queueSync(['teams']);
  },

  // Matches Management (FR-9, FR-11, FR-17, FR-19)
  async getMatches() {
    return this.getLocalMatches();
  },

  getLocalMatches() {
    try {
      const str = localStorage.getItem(this.STORAGE_KEYS.MATCHES);
      return str ? JSON.parse(str) : [];
    } catch (e) {
      return [];
    }
  },

  async getMatch(matchId) {
    const matches = this.getLocalMatches();
    return matches.find(m => m.id === matchId) || null;
  },

  async createMatch(matchData) {
    if (!this.isStaff()) throw new Error('Unauthorized: Umpire or Admin staff access required');

    const newMatch = {
      id: 'm_' + Date.now(),
      teamA: matchData.teamA || 'Team 1',
      teamB: matchData.teamB || 'Team 2',
      teamAPlayerIds: matchData.teamAPlayerIds || [],
      teamBPlayerIds: matchData.teamBPlayerIds || [],
      overs: Number(matchData.overs) || 5,
      currentInnings: 1,
      status: 'live', // 'live' | 'done'
      strikerId: matchData.strikerId || null,
      nonStrikerId: matchData.nonStrikerId || null,
      bowlerId: matchData.bowlerId || null,
      balls: [],
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const matches = [newMatch, ...this.getLocalMatches()];
    localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
    this.notifyListeners('matches');
    this.broadcast('matches');
    this.queueSync(['matches']);

    return newMatch;
  },

  // Record a finished match from its final scores only (no ball-by-ball data).
  // data: { teamA, teamB (names; teamA batted first), overs, inn1/inn2: {runs, wickets, balls, allOut}, playedAt }
  async addPastMatch(data) {
    this.requireStaff();

    const teams = this.getLocalTeams();
    const teamA = teams.find(t => t.name === data.teamA);
    const teamB = teams.find(t => t.name === data.teamB);
    if (!teamA || !teamB) throw new Error('Please select two existing teams');
    if (teamA.name === teamB.name) throw new Error('Please select two different teams');

    const overs = Number(data.overs);
    if (!Number.isInteger(overs) || overs < 1 || overs > 50) throw new Error('Overs must be a whole number from 1 to 50');

    const clean = (inn, label) => {
      const runs = Number(inn && inn.runs);
      const wickets = Number(inn && inn.wickets);
      const balls = Number(inn && inn.balls);
      if (!Number.isInteger(runs) || runs < 0) throw new Error(`${label}: runs must be 0 or more`);
      if (!Number.isInteger(wickets) || wickets < 0 || wickets > 10) throw new Error(`${label}: wickets must be 0 to 10`);
      if (!Number.isInteger(balls) || balls < 0 || balls > overs * 6) throw new Error(`${label}: overs faced cannot exceed ${overs} overs`);
      return { runs, wickets, balls, allOut: Boolean(inn.allOut) };
    };
    const inn1 = clean(data.inn1, `${teamA.name} innings`);
    const inn2 = clean(data.inn2, `${teamB.name} innings`);

    const playedAt = Number(data.playedAt);
    if (!Number.isFinite(playedAt) || playedAt <= 0) throw new Error('Please pick when the match was played');

    const match = {
      id: 'm_past_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      teamA: teamA.name,
      teamB: teamB.name,
      teamAPlayerIds: [],
      teamBPlayerIds: [],
      overs,
      currentInnings: 2,
      status: 'done',
      balls: [],
      manual: true,
      summary: { inn1, inn2 },
      createdAt: playedAt,
      updatedAt: Date.now()
    };

    const in1Stats = CricketEngine.getInningsStats(match, 1);
    const in2Stats = CricketEngine.getInningsStats(match, 2);
    match.result = CricketEngine.generateMatchResultText(
      teamA.name, teamB.name, in1Stats, in2Stats, overs, (teamB.playerIds || []).length || 11
    );
    match.nrrData = CricketEngine.calculateMatchNetRunRate(match);

    const matches = [match, ...this.getLocalMatches()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
    this.notifyListeners('matches');
    this.broadcast('matches');
    this.queueSync(['matches']);
    return match;
  },

  // Undo needs the striker/bowler snapshot only for the most recent balls. Older balls (and every
  // ball of a finished match) drop it so the saved data stays small and syncs faster.
  UNDO_DEPTH: 24,

  pruneBallSnapshots(balls, finished) {
    if (!Array.isArray(balls)) return balls;
    const keepFrom = finished ? balls.length : Math.max(0, balls.length - this.UNDO_DEPTH);
    return balls.map((ball, i) => {
      if (i >= keepFrom || !ball || !ball.snapshot) return ball;
      const { snapshot, ...rest } = ball;
      return rest;
    });
  },

  async updateMatch(matchId, patchData) {
    if (!this.isStaff()) throw new Error('Unauthorized: Staff access required');

    const matches = this.getLocalMatches();
    const idx = matches.findIndex(m => m.id === matchId);
    if (idx !== -1) {
      const finished = (patchData.status || matches[idx].status) === 'done';
      // When a match is finished, also strip the balls already stored (the patch may not include them)
      const ballsToSave = patchData.balls || (finished ? matches[idx].balls : null);
      const patch = ballsToSave ? { ...patchData, balls: this.pruneBallSnapshots(ballsToSave, finished) } : patchData;
      matches[idx] = { ...matches[idx], ...patch, updatedAt: Date.now() };
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
      this.notifyListeners('matches');
      this.broadcast('matches');
      this.queueSync(['matches']);
    }
  },

  // ---- Fixtures (schedule) ----
  getLocalFixtures() {
    try {
      const str = localStorage.getItem(this.STORAGE_KEYS.FIXTURES);
      const list = str ? JSON.parse(str) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  async getFixtures() {
    return this.getLocalFixtures();
  },

  _saveFixtures(list) {
    const sorted = [...list].sort((a, b) => Number(a.scheduledAt || 0) - Number(b.scheduledAt || 0));
    localStorage.setItem(this.STORAGE_KEYS.FIXTURES, JSON.stringify(sorted));
    this.notifyListeners('fixtures');
    this.broadcast('fixtures');
    this.queueSync(['fixtures']);
  },

  // data: { teamA, teamB (team names), scheduledAt (ms), note }
  async addFixture(data) {
    this.requireStaff();
    const teams = this.getLocalTeams();
    if (!teams.some(t => t.name === data.teamA) || !teams.some(t => t.name === data.teamB)) {
      throw new Error('Please select two existing teams');
    }
    if (data.teamA === data.teamB) throw new Error('Please select two different teams');
    const scheduledAt = Number(data.scheduledAt);
    if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) throw new Error('Please pick a date and time');

    const fixture = {
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      teamA: data.teamA,
      teamB: data.teamB,
      scheduledAt,
      note: String(data.note || '').trim().slice(0, 80),
      createdAt: Date.now()
    };
    this._saveFixtures([...this.getLocalFixtures(), fixture]);
    return fixture;
  },

  async updateFixture(fixtureId, data) {
    this.requireStaff();
    const list = this.getLocalFixtures();
    const idx = list.findIndex(f => f.id === fixtureId);
    if (idx === -1) throw new Error('Fixture not found');
    const next = { ...list[idx], ...data };
    if (next.teamA === next.teamB) throw new Error('Please select two different teams');
    if (!Number.isFinite(Number(next.scheduledAt)) || Number(next.scheduledAt) <= 0) throw new Error('Please pick a date and time');
    next.note = String(next.note || '').trim().slice(0, 80);
    list[idx] = next;
    this._saveFixtures(list);
    return next;
  },

  async deleteFixture(fixtureId) {
    this.requireStaff();
    this._saveFixtures(this.getLocalFixtures().filter(f => f.id !== fixtureId));
  },

  // Delete match (Admin & Staff, FR-22)
  async deleteMatch(matchId) {
    if (!this.isStaff()) throw new Error('Unauthorized: Admin or Umpire staff access required');

    const matches = this.getLocalMatches().filter(m => m.id !== matchId);
    localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
    this.setPendingDeletedMatches([...new Set([...this.getPendingDeletedMatches(), matchId])]);
    this.notifyListeners('matches');
    this.broadcast('matches');
    this.queueSync(['matches']);
  },

  // Authentication & Role Management (FR-23, FR-24, FR-25)
  // Credentials are verified by the server (/api/login), which returns a signed,
  // expiring token. /api/sync rejects writes without a valid token, so the checks
  // below only drive the UI; they cannot grant write access on their own.
  isSessionValid() {
    const u = this.currentUser;
    return Boolean(u && u.token && u.exp && Number(u.exp) > Date.now() &&
      (u.role === 'umpire' || u.role === 'admin'));
  },

  getAuthToken() {
    return this.isSessionValid() ? this.currentUser.token : null;
  },

  isAdmin() {
    return this.isSessionValid() && this.currentUser.role === 'admin';
  },

  isUmpire() {
    return this.isSessionValid();
  },

  isStaff() {
    return this.isUmpire();
  },

  requireStaff() {
    if (!this.isStaff()) {
      throw new Error('Unauthorized: please sign in as Umpire or Admin staff.');
    }
  },

  // Server rejected our token (expired / invalid): drop the session, keep unsent changes
  handleSessionExpired() {
    if (!this.currentUser) return;
    this.currentUser = null;
    localStorage.removeItem(this.STORAGE_KEYS.AUTH);
    this.notifyAuthListeners();
  },

  async login(name, password, role = 'umpire') {
    const cleanName = (name || '').trim();
    const cleanPass = password || '';

    if (!cleanName) {
      throw new Error('Please enter your name to sign in.');
    }
    if (!cleanPass) {
      throw new Error('Please enter the password.');
    }

    let res;
    try {
      res = await fetch(this.CLOUD.LOGIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, password: cleanPass, role: role === 'admin' ? 'admin' : 'umpire' })
      });
    } catch (err) {
      throw new Error('Cannot reach the server to sign in. Check your connection and try again.');
    }

    let json = null;
    try { json = await res.json(); } catch (e) {}

    if (!res.ok || !json || !json.token) {
      throw new Error((json && json.error) || 'Sign in failed. Please try again.');
    }

    this.currentUser = {
      name: json.name || cleanName,
      displayName: json.name || cleanName,
      role: json.role,
      token: json.token,
      exp: json.exp,
      uid: 'user_' + Date.now()
    };

    localStorage.setItem(this.STORAGE_KEYS.AUTH, JSON.stringify(this.currentUser));
    this.notifyAuthListeners();

    // Flush any unsent changes / seed an empty cloud now that we can write
    this.pullFromCloud();
    return this.currentUser;
  },

  async logout() {
    this.currentUser = null;
    localStorage.removeItem(this.STORAGE_KEYS.AUTH);
    this.notifyAuthListeners();
  },

  // Real-time Event Subscription
  subscribe(entity, callback) {
    if (this.listeners[entity]) {
      this.listeners[entity].push(callback);
    }
  },

  onStatusChange(callback) {
    this.listeners.status.push(callback);
  },

  onAuthChange(callback) {
    this.listeners.auth.push(callback);
  },

  notifyListeners(entity) {
    if (this.listeners[entity]) {
      this.listeners[entity].forEach(cb => {
        try { cb(); } catch (e) { console.error(e); }
      });
    }
  },

  notifyAuthListeners() {
    this.listeners.auth.forEach(cb => {
      try { cb(this.currentUser); } catch (e) { console.error(e); }
    });
  },

  notifyStatusListeners() {
    this.listeners.status.forEach(cb => {
      try { cb(this.connectionStatus); } catch (e) { console.error(e); }
    });
  }
};
