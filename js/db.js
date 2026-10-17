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
    LAST_SYNC: 'cct_last_synced_at'
  },

  CLOUD: {
    API_URL: '/api/sync',
    CDN_URL: 'https://v0grmksww68yigcw.public.blob.vercel-storage.com/tournament_state.json',
    POLL_INTERVAL_MS: 2000
  },

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
    if (typeof getInitialTournamentData !== 'undefined') {
      const initData = getInitialTournamentData();
      localStorage.setItem(this.STORAGE_KEYS.PLAYERS, JSON.stringify(initData.players));
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(initData.teams));
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify([]));

      this.notifyListeners('players');
      this.notifyListeners('teams');
      this.notifyListeners('matches');
      this.broadcast('data_reset');
      this.pushToCloud();
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

  async pushToCloud() {
    if (this._cloudPushPromise) {
      this._cloudPushQueued = true;
      return;
    }

    const payload = {
      players: this.getLocalPlayers(),
      teams: this.getLocalTeams(),
      matches: this.getLocalMatches(),
      updatedAt: Date.now()
    };

    localStorage.setItem(this.STORAGE_KEYS.LAST_SYNC, String(payload.updatedAt));

    this._cloudPushPromise = (async () => {
      try {
        const res = await fetch(this.CLOUD.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          this.setConnectionStatus('online');
        }
      } catch (err) {
        console.warn('Cloud sync push warning:', err.message);
      } finally {
        this._cloudPushPromise = null;
        if (this._cloudPushQueued) {
          this._cloudPushQueued = false;
          this.pushToCloud();
        }
      }
    })();
  },

  async pullFromCloud() {
    if (this._isPulling || this._cloudPushPromise) return;
    this._isPulling = true;

    try {
      // First try direct CDN with cache-busting timestamp
      let remoteData = null;
      try {
        const cdnRes = await fetch(`${this.CLOUD.CDN_URL}?_t=${Date.now()}`, { cache: 'no-store' });
        if (cdnRes.ok) {
          remoteData = await cdnRes.json();
        }
      } catch (e) {}

      if (!remoteData || !remoteData.updatedAt) {
        try {
          const apiRes = await fetch(`${this.CLOUD.API_URL}?_t=${Date.now()}`, { cache: 'no-store' });
          if (apiRes.ok) {
            const json = await apiRes.json();
            remoteData = json.data;
          }
        } catch (e) {}
      }

      if (!remoteData || !remoteData.updatedAt) {
        const localMatches = this.getLocalMatches();
        const localPlayers = this.getLocalPlayers();
        if (localPlayers.length > 0 || localMatches.length > 0) {
          await this.pushToCloud();
        }
        return;
      }

      const localSyncedAt = Number(localStorage.getItem(this.STORAGE_KEYS.LAST_SYNC) || 0);

      // Scorer protection: if local has an active match or finished match not in remote yet, push local!
      const localMatches = this.getLocalMatches();
      const hasLocalMatches = localMatches.length > 0;
      const remoteMatches = remoteData.matches || [];
      const hasRemoteMatches = remoteMatches.length > 0;

      if (hasLocalMatches && !hasRemoteMatches && localSyncedAt === 0) {
        await this.pushToCloud();
        return;
      }

      // If remote has newer data than local:
      if (remoteData.updatedAt > localSyncedAt) {
        localStorage.setItem(this.STORAGE_KEYS.LAST_SYNC, String(remoteData.updatedAt));

        let changedPlayers = false;
        let changedTeams = false;
        let changedMatches = false;

        if (Array.isArray(remoteData.players) && remoteData.players.length > 0) {
          const cur = localStorage.getItem(this.STORAGE_KEYS.PLAYERS);
          const next = JSON.stringify(remoteData.players);
          if (cur !== next) {
            localStorage.setItem(this.STORAGE_KEYS.PLAYERS, next);
            changedPlayers = true;
          }
        }

        if (Array.isArray(remoteData.teams) && remoteData.teams.length > 0) {
          const cur = localStorage.getItem(this.STORAGE_KEYS.TEAMS);
          const next = JSON.stringify(remoteData.teams);
          if (cur !== next) {
            localStorage.setItem(this.STORAGE_KEYS.TEAMS, next);
            changedTeams = true;
          }
        }

        if (Array.isArray(remoteData.matches)) {
          const cur = localStorage.getItem(this.STORAGE_KEYS.MATCHES);
          const next = JSON.stringify(remoteData.matches);
          if (cur !== next) {
            localStorage.setItem(this.STORAGE_KEYS.MATCHES, next);
            changedMatches = true;
          }
        }

        if (changedPlayers) this.notifyListeners('players');
        if (changedTeams) this.notifyListeners('teams');
        if (changedMatches) this.notifyListeners('matches');

        if (changedPlayers || changedTeams || changedMatches) {
          this.broadcast('cloud_sync');
        }
      }

      this.setConnectionStatus('online');
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
    this.pushToCloud();

    return newPlayer;
  },

  async registerPlayer(playerData) {
    return this.addPlayer(playerData);
  },

  // Delete player
  async deletePlayer(playerId) {
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
      this.pushToCloud();
    }
  },

  // Update Player (Admin & Umpire can update anytime)
  async updatePlayer(playerId, patchData) {
    const players = this.getLocalPlayers();
    const idx = players.findIndex(p => p.id === playerId);
    if (idx === -1) throw new Error('Player not found');

    players[idx] = { ...players[idx], ...patchData, updatedAt: Date.now() };
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
      await this.firestore.collection('players').doc(playerId).update(patchData);
    }

    this.notifyListeners('players');
    this.broadcast('players');
    this.pushToCloud();
    return players[idx];
  },

  // Update Team (Admin & Umpire can update team details, captain, VC anytime)
  async updateTeam(teamId, patchData) {
    const teams = this.getLocalTeams();
    const idx = teams.findIndex(t => t.id === teamId);
    if (idx === -1) throw new Error('Team not found');

    teams[idx] = { ...teams[idx], ...patchData, updatedAt: Date.now() };
    await this.saveTeams(teams);
    return teams[idx];
  },

  // Add New Team
  async addTeam(teamName) {
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
    const teams = this.getLocalTeams().filter(t => t.id !== teamId);
    await this.saveTeams(teams);
  },

  // Rename Team
  async renameTeam(teamId, newName) {
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
    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('cfg').doc('teams').set({ list: teams, updatedAt: Date.now() });
    } else {
      localStorage.setItem(this.STORAGE_KEYS.TEAMS, JSON.stringify(teams));
      this.notifyListeners('teams');
      this.broadcast('teams');
      this.pushToCloud();
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
      this.pushToCloud();
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
        this.pushToCloud();
      }
    }
  },

  // Delete match (Admin only, FR-22)
  async deleteMatch(matchId) {
    if (!this.isAdmin()) throw new Error('Unauthorized: Admin access required');

    if (this.isFirebaseActive && this.firestore) {
      await this.firestore.collection('matches').doc(matchId).delete();
    } else {
      const matches = this.getLocalMatches().filter(m => m.id !== matchId);
      localStorage.setItem(this.STORAGE_KEYS.MATCHES, JSON.stringify(matches));
      this.notifyListeners('matches');
      this.broadcast('matches');
      this.pushToCloud();
    }
  },

  // Authentication & Role Management (FR-23, FR-24, FR-25)
  isAdmin() {
    return Boolean(this.currentUser && this.currentUser.role === 'admin');
  },

  isUmpire() {
    return Boolean(this.currentUser && (this.currentUser.role === 'umpire' || this.currentUser.role === 'admin'));
  },

  isStaff() {
    return this.isUmpire();
  },

  async login(name, password, role = 'umpire') {
    const cleanName = (name || '').trim();
    const cleanPass = (password || '').trim();

    if (!cleanName) {
      throw new Error('Please enter your name to sign in.');
    }

    if (cleanPass !== 'sitare@2029') {
      throw new Error('Incorrect password! Enter password "sitare@2029" to sign in.');
    }

    const cleanRole = (role === 'admin') ? 'admin' : 'umpire';

    this.currentUser = {
      name: cleanName,
      displayName: cleanName,
      email: cleanName.toLowerCase().replace(/\s+/g, '') + '@tournament.local',
      role: cleanRole,
      uid: 'user_' + Date.now()
    };

    localStorage.setItem(this.STORAGE_KEYS.AUTH, JSON.stringify(this.currentUser));
    this.notifyAuthListeners();
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
