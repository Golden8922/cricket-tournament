// Unified Database & Authentication Layer
// Supports Vercel Cloud Blob Real-Time Sync + Firebase Firestore + LocalStorage fallback
// Implements FR-1, FR-2, FR-3, FR-18, FR-22, FR-23, FR-24, FR-25

const AppDB = {
  // Configuration
  STORAGE_KEYS: {
    PLAYERS: 'cct_players',
    TEAMS: 'cct_teams',
    MATCHES: 'cct_matches',
    AUTH: 'cct_auth_user',
    FIREBASE_CONFIG: 'cct_firebase_config',
    LAST_SYNC: 'cct_last_synced_at',
    DIRTY: 'cct_dirty_sections',
    PENDING_DELETED_MATCHES: 'cct_pending_deleted_matches'
  },

  // Sections of the shared state that are synced independently
  SECTIONS: ['players', 'teams', 'matches'],

  CLOUD: {
    API_URL: '/api/sync',
    LOGIN_URL: '/api/login',
    CDN_URL: 'https://v0grmksww68yigcw.public.blob.vercel-storage.com/tournament_state.json',
    POLL_INTERVAL_MS: 2000,
    PUSH_RETRY_MS: 5000
  },

  _pushRetryAt: 0,

  broadcastChannel: null,
  isFirebaseActive: false,
  firestore: null,
  firebaseAuth: null,
  _cloudPushPromise: null,
  _cloudPushQueued: false,
  _isPulling: false,
  _syncInterval: null,
  
  // Real-time listener callbacks
  listeners: {
    players: [],
    teams: [],
    matches: [],
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

    // Check if custom Firebase Config is configured
    const customConfigStr = localStorage.getItem(this.STORAGE_KEYS.FIREBASE_CONFIG);
    if (customConfigStr && window.firebase) {
      try {
        const config = JSON.parse(customConfigStr);
        if (config.apiKey && config.projectId) {
          await this.initFirebase(config);
        }
      } catch (err) {
        console.warn('Failed to initialize custom Firebase config, using cloud sync mode:', err);
      }
    }

    // Ensure seed data exists locally
    if (!this.isFirebaseActive) {
      this.ensureSeedData();
    }

    // Start real-time cloud sync across all devices (Firestore has its own listeners)
    if (!this.isFirebaseActive) {
      this.startRealtimeSync();
    }

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
      this.queueSync(this.SECTIONS);
    }
  },

  // Real-time Cloud Sync Engine (multi-device live scores)
  startRealtimeSync() {
    if (this._syncInterval) clearInterval(this._syncInterval);

    // Initial pull immediately
    this.pullFromCloud();

    // Poll every 2 seconds for live real-time score updates across all devices
    this._syncInterval = setInterval(() => {
      this.pullFromCloud();
    }, this.CLOUD.POLL_INTERVAL_MS);
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

      ['players', 'teams'].forEach(section => {
        if (dirty.includes(section)) return;
        const incoming = remoteData[section];
        // Never replace squads with an empty list
        if (!Array.isArray(incoming) || incoming.length === 0) return;

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
          this.markDirty(this.SECTIONS);
          this.pushToCloud();
        } else if (!cloudIsEmpty && navigator.onLine !== false) {
          // Both reads failed: never push anything, just report the connection state
          this.setConnectionStatus('reconnecting');
        }
        return;
      }

      this.applyRemote(remoteData);
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

  // Initialize real Firebase when config provided
  async initFirebase(config) {
    if (!window.firebase) return;
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      this.firestore = firebase.firestore();
      this.firebaseAuth = firebase.auth();
      this.isFirebaseActive = true;

      // Enable Firestore offline persistence
      try {
        await this.firestore.enablePersistence({ synchronizeTabs: true });
      } catch (err) {
        console.warn('Firestore persistence notice:', err.code);
      }

      // Attach Firestore real-time snapshots
      this.firestore.collection('players').onSnapshot((snapshot) => {
        const players = [];
        snapshot.forEach(doc => players.push({ id: doc.id, ...doc.data() }));
        localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(players));
        this.notifyListeners('players');
      }, (err) => {
        console.error('Firestore players listener error:', err);
        this.setConnectionStatus('reconnecting');
      });

      this.firestore.collection('cfg').doc('teams').onSnapshot((doc) => {
        if (doc.exists) {
          const teams = doc.data().list || [];
          localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));
          this.notifyListeners('teams');
        }
      });

      this.firestore.collection('matches').onSnapshot((snapshot) => {
        const matches = [];
        snapshot.forEach(doc => matches.push({ id: doc.id, ...doc.data() }));
        localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
        this.notifyListeners('matches');
      }, (err) => {
        console.error('Firestore matches listener error:', err);
        this.setConnectionStatus('reconnecting');
      });

      // Auth listener
      this.firebaseAuth.onAuthStateChanged((user) => {
        if (user) {
          const email = (user.email || '').toLowerCase();
          const role = (email.includes('admin') || email === 'admin@college.edu') ? 'admin' : 'umpire';
          this.currentUser = { email: user.email, role: role, uid: user.uid };
        } else {
          this.currentUser = null;
        }
        localStorage.setItem(this.STORAGE_KEYS.AUTH, JSON.stringify(this.currentUser));
        this.notifyAuthListeners();
      });

      console.log('Firebase Cloud Firestore successfully connected!');
    } catch (err) {
      console.error('Error connecting to Firebase:', err);
      this.isFirebaseActive = false;
    }
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

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('players').doc(newPlayer.id).set(newPlayer);
    } else {
      const updated = [newPlayer, ...players];
      localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(updated));
    }

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
    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('players').doc(playerId).delete();
    } else {
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
    }
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

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('players').doc(playerId).update(playerPatch);
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
    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('cfg').doc('teams').set({ list: teams, updatedAt: Date.now() });
    } else {
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));
      this.notifyListeners('teams');
      this.broadcast('teams');
      this.queueSync(['teams']);
    }
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

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('matches').doc(newMatch.id).set(newMatch);
    } else {
      const matches = [newMatch, ...this.getLocalMatches()];
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
      this.notifyListeners('matches');
      this.broadcast('matches');
      this.queueSync(['matches']);
    }

    return newMatch;
  },

  async updateMatch(matchId, patchData) {
    if (!this.isStaff()) throw new Error('Unauthorized: Staff access required');

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('matches').doc(matchId).update({
        ...patchData,
        updatedAt: Date.now()
      });
    } else {
      const matches = this.getLocalMatches();
      const idx = matches.findIndex(m => m.id === matchId);
      if (idx !== -1) {
        matches[idx] = { ...matches[idx], ...patchData, updatedAt: Date.now() };
        localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
        this.notifyListeners('matches');
        this.broadcast('matches');
        this.queueSync(['matches']);
      }
    }
  },

  // Delete match (Admin & Staff, FR-22)
  async deleteMatch(matchId) {
    if (!this.isStaff()) throw new Error('Unauthorized: Admin or Umpire staff access required');

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('matches').doc(matchId).delete();
    } else {
      const matches = this.getLocalMatches().filter(m => m.id !== matchId);
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
      this.setPendingDeletedMatches([...new Set([...this.getPendingDeletedMatches(), matchId])]);
      this.notifyListeners('matches');
      this.broadcast('matches');
      this.queueSync(['matches']);
    }
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
    if (this.isFirebaseActive && this.firebaseAuth) {
      try {
        await this.firebaseAuth.signOut();
      } catch (e) {}
    }
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
