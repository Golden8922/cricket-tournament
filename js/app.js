// Main Application Controller & UI Orchestrator
// College Cricket Tournament PWA

const App = {
  activeView: 'view-live',
  currentModifier: null, // null | 'wide' | 'noball' | 'bye' | 'legbye'
  activeScoringMatch: null,
  wakeLock: null,
  deferredInstallPrompt: null,
  audioCtx: null,

  async init() {
    // 1. Initialize Database
    await AppDB.init();

    // 2. Setup Event Listeners
    this.setupNavigation();
    this.setupTheme();
    this.setupPWA();
    this.setupAuth();
    this.setupTeamsView();
    this.setupTableView();
    this.setupScoringConsole();
    this.setupHistoryAndPlayers();
    this.setupLiveView();

    // 3. Subscribe to DB updates
    AppDB.subscribe('players', () => this.onPlayersDataChanged());
    AppDB.subscribe('teams', () => this.onTeamsDataChanged());
    AppDB.subscribe('matches', () => this.onMatchesDataChanged());
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
          this.openModal('modal-staff-login');
        }
      });
    }

    // Custom login form with Name and password sitare@2029
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

    // Firebase config modal toggle
    const btnOpenFbConfig = document.getElementById('btn-open-firebase-config');
    if (btnOpenFbConfig) {
      btnOpenFbConfig.addEventListener('click', () => {
        this.closeModal('modal-staff-login');
        this.openModal('modal-firebase-config');
        const txt = document.getElementById('firebase-config-textarea');
        if (txt) {
          txt.value = localStorage.getItem(AppDB.STORAGE_KEYS.FIREBASE_CONFIG) || '';
        }
      });
    }

    const btnSaveFbConfig = document.getElementById('btn-save-firebase-config');
    if (btnSaveFbConfig) {
      btnSaveFbConfig.addEventListener('click', async () => {
        const txt = document.getElementById('firebase-config-textarea').value.trim();
        if (!txt) return;
        try {
          const parsed = JSON.parse(txt);
          localStorage.setItem(AppDB.STORAGE_KEYS.FIREBASE_CONFIG, JSON.stringify(parsed));
          await AppDB.initFirebase(parsed);
          this.closeModal('modal-firebase-config');
          this.showToast('Firebase configuration saved and connected!', 'success');
        } catch (err) {
          this.showToast('Invalid JSON configuration', 'error');
        }
      });
    }

    const btnClearFbConfig = document.getElementById('btn-clear-firebase-config');
    if (btnClearFbConfig) {
      btnClearFbConfig.addEventListener('click', () => {
        localStorage.removeItem(AppDB.STORAGE_KEYS.FIREBASE_CONFIG);
        this.closeModal('modal-firebase-config');
        this.showToast('Firebase config cleared. Running in local mode.', 'info');
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

    this.renderPlayersTable();
    this.renderTeamsView();
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
        await AppDB.saveTeams(teams);
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
          await AppDB.updateTeam(teamId, { name, captainId, viceCaptainId, motto });
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
    const optionsHtml = `
      <option value="">-- No Captain Selected --</option>
      ${teamPlayerList.map(p => `<option value="${p.id}" ${p.id === team.captainId ? 'selected' : ''}>${this.escapeHtml(p.name)} (${p.role})</option>`).join('')}
    `;
    const vcOptionsHtml = `
      <option value="">-- No Vice-Captain Selected --</option>
      ${teamPlayerList.map(p => `<option value="${p.id}" ${p.id === team.viceCaptainId ? 'selected' : ''}>${this.escapeHtml(p.name)} (${p.role})</option>`).join('')}
    `;

    if (capSelect) capSelect.innerHTML = optionsHtml;
    if (vcSelect) vcSelect.innerHTML = vcOptionsHtml;

    this.openModal('modal-edit-team');
  },

  async confirmDeleteTeam(teamId, teamName) {
    if (confirm(`Are you sure you want to delete team "${teamName}"? Players will be moved to the unassigned pool.`)) {
      await AppDB.deleteTeam(teamId);
      this.showToast(`Team "${teamName}" removed`, 'info');
      this.renderTeamsView();
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
        ${teams.map(t => `<option value="${t.id}" ${t.id === preselectedTeamId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('')}
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
        ${teams.map(t => `<option value="${t.id}" ${t.id === currentTeamId ? 'selected' : ''}>${this.escapeHtml(t.name)}</option>`).join('')}
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
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button class="btn-primary" onclick="App.openAddTeamModal()">➕ Add New Team</button>
            <button class="btn-secondary" onclick="App.openAddPlayerModal()">👤 Add Player</button>
          </div>
        </div>
      `;
      if (unassignedCard) unassignedCard.style.display = 'none';
      return;
    }

    // Determine unassigned players
    const assignedIds = new Set();
    teams.forEach(t => (t.playerIds || []).forEach(id => assignedIds.add(id)));
    const unassigned = players.filter(p => !assignedIds.has(p.id));

    // Render team cards
    container.innerHTML = teams.map((team) => {
      const stats = TeamEngine.calculateTeamStats(team, pMap);
      const cap = team.captainId ? pMap[team.captainId] : null;
      const vc = team.viceCaptainId ? pMap[team.viceCaptainId] : null;
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
                <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" onclick="App.openEditTeamModal('${team.id}')" title="Edit team leadership & details">✏️</button>
                <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem; color: var(--leather-red);" onclick="App.confirmDeleteTeam('${team.id}', '${this.escapeHtml(team.name)}')" title="Delete team">🗑️</button>
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
            <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem; min-height: 30px; border-color: var(--pitch-green); color: var(--pitch-green);" onclick="App.openAddPlayerModal('${team.id}')">
              ➕ Add Player
            </button>
          </div>

          <div class="team-players-list">
            ${(team.playerIds || []).length > 0 ? (team.playerIds || []).map(pid => {
              const p = pMap[pid];
              if (!p) return '';
              const r = CricketEngine.calculateRating(p);
              const isCap = (p.id === team.captainId);
              const isVc = (p.id === team.viceCaptainId);
              return `
                <div class="player-chip">
                  <div>
                    <strong>${this.escapeHtml(p.name)}</strong>
                    ${isCap ? '<span style="color: var(--gold-amber); font-weight: 800; font-size: 0.75rem; margin-left: 2px;">(C)</span>' : ''}
                    ${isVc ? '<span style="color: #60A5FA; font-weight: 800; font-size: 0.75rem; margin-left: 2px;">(VC)</span>' : ''}
                    <span style="font-size: 0.75rem; color: var(--text-muted); margin-left: 4px;">(${this.escapeHtml(p.roll)})</span>
                    <span style="font-size: 0.75rem; color: var(--text-secondary); margin-left: 4px;">• ${p.role}${p.keeper ? ' 🧤' : ''}</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 4px;">
                    <span class="chip-rating">⭐ ${r}</span>
                    <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" onclick="App.openEditPlayerModal('${p.id}')" title="Edit player details">✏️</button>
                    <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem;" onclick="App.openMovePlayerModal('${p.id}', '${this.escapeHtml(p.name)}')" title="Move to another team or unassign">⇄</button>
                    <button class="icon-btn" style="width: 28px; height: 28px; min-height: 28px; font-size: 0.75rem; color: var(--leather-red);" onclick="App.confirmDeletePlayer('${p.id}', '${this.escapeHtml(p.name)}')" title="Delete player">✕</button>
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
            <span>${this.escapeHtml(p.name)} (${p.role})</span>
            <button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; margin-left: 6px;" onclick="App.openEditPlayerModal('${p.id}')" title="Edit player">✏️</button>
            <button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; margin-left: 4px;" onclick="App.openMovePlayerModal('${p.id}', '${this.escapeHtml(p.name)}')">➕ Assign</button>
            <button class="icon-btn" style="width: 26px; height: 26px; min-height: 26px; font-size: 0.7rem; color: var(--leather-red); margin-left: 4px;" onclick="App.confirmDeletePlayer('${p.id}', '${this.escapeHtml(p.name)}')">✕</button>
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
        const oversVal = Number(document.getElementById('match-overs').value) || 5;

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

    // 2. Modifier Buttons (Wide, No ball, Bye, Leg bye)
    document.querySelectorAll('.modifier-buttons-row .mod-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mod = btn.getAttribute('data-mod');
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

    // 9. Confirm Wicket Modal Button
    const btnConfirmWicket = document.getElementById('btn-confirm-wicket');
    if (btnConfirmWicket) {
      btnConfirmWicket.addEventListener('click', () => this.confirmWicketSubmission());
    }

    // Wicket type selector change for run-out
    const wicketTypeSelect = document.getElementById('wicket-type-select');
    const runoutGroup = document.getElementById('runout-player-group');
    if (wicketTypeSelect && runoutGroup) {
      wicketTypeSelect.addEventListener('change', () => {
        runoutGroup.style.display = wicketTypeSelect.value === 'runout' ? 'block' : 'none';
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
        return `<option value="${pid}" ${pid === liveMatch.strikerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : pid}</option>`;
      }).join('');
      if (!liveMatch.strikerId && availableBatters.length > 0) {
        liveMatch.strikerId = availableBatters[0];
        selectStriker.value = availableBatters[0];
      }
    }

    if (selectNonStriker) {
      selectNonStriker.innerHTML = availableBatters.map(pid => {
        const p = pMap[pid];
        return `<option value="${pid}" ${pid === liveMatch.nonStrikerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : pid}</option>`;
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
        return `<option value="${pid}" ${pid === liveMatch.bowlerId ? 'selected' : ''}>${p ? this.escapeHtml(p.name) : pid}</option>`;
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
      bowlerStats.textContent = `${bw.oversFormatted} ov • ${bw.wickets} wkts, ${bw.runsConceded} runs • Econ: ${bw.economy}`;
    }

    // Current over deliveries reel
    const overBallsContainer = document.getElementById('umpire-over-balls');
    if (overBallsContainer) {
      if (currentInningsStats.currentOverBalls.length > 0) {
        overBallsContainer.innerHTML = currentInningsStats.currentOverBalls.map(b => `
          <div class="ball-badge ${b.type}">${b.text}</div>
        `).join('');
      } else {
        overBallsContainer.innerHTML = `<span style="color: var(--text-muted); font-size: 0.8rem;">Ready for delivery 1</span>`;
      }
    }
  },

  // Record a delivery (FR-11, FR-12, FR-13)
  async recordDelivery(runs) {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const mod = this.currentModifier;

    this.vibrate(40);

    // Save previous snapshot for FR-15 Undo
    const snapshot = {
      strikerId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      currentInnings: match.currentInnings
    };

    const isLegal = (mod !== 'wide' && mod !== 'noball');
    let runsForTeam = runs;
    if (mod === 'wide') runsForTeam = 1 + runs;
    if (mod === 'noball') runsForTeam = 1 + runs;

    const ball = {
      id: 'ball_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      innings: match.currentInnings,
      batterId: match.strikerId,
      nonStrikerId: match.nonStrikerId,
      bowlerId: match.bowlerId,
      runs: runs,
      extraType: mod,
      isWicket: false,
      isLegal: isLegal,
      totalRuns: runsForTeam,
      snapshot: snapshot
    };

    // Calculate if strike swaps (FR-13)
    // On normal/bye/legbye: odd runs swap strike
    // On wide: only if runs (additional runs ran) is odd
    // On no ball: if runs off bat is odd
    let shouldSwapStrike = false;
    if (mod === 'wide') {
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

    // Check if over ended (6 legal balls in current over)
    const currentInningsBalls = match.balls.filter(b => b.innings === match.currentInnings);
    const legalBallsInCurrentInnings = currentInningsBalls.filter(b => b.isLegal).length;

    if (isLegal && (legalBallsInCurrentInnings % 6 === 0)) {
      // Over ended!
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

    // Check automatic innings finish or target chase (FR-14)
    this.checkAutoMatchCompletion();
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
          return `<option value="${pid}">${p ? this.escapeHtml(p.name) : pid}</option>`;
        }).join('');
      } else {
        selectNext.innerHTML = `<option value="none">-- All Out / No more batsmen --</option>`;
      }
    }

    this.openModal('modal-wicket');
  },

  // Confirm Wicket submission
  async confirmWicketSubmission() {
    if (!this.activeScoringMatch) return;
    const match = this.activeScoringMatch;
    const wType = document.getElementById('wicket-type-select').value;
    const runoutWho = document.getElementById('runout-player-select').value;
    const nextBatterId = document.getElementById('select-next-batter').value;

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
      runs: 0,
      extraType: null,
      isWicket: true,
      wicketType: wType,
      outPlayerId: outPlayerId,
      isLegal: true,
      totalRuns: 0,
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

    const result = CricketEngine.generateMatchResultText(match.teamA, match.teamB, in1, in2, match.overs, (match.teamBPlayerIds || []).length);
    const matchNrr = CricketEngine.calculateMatchNetRunRate(match);

    const nrrPrompt = matchNrr ? `\n\nNet Run Rate (NRR) Impact:\n• ${match.teamA}: ${matchNrr.teamA.nrrFormatted} (RR: ${matchNrr.teamA.runRate})\n• ${match.teamB}: ${matchNrr.teamB.nrrFormatted} (RR: ${matchNrr.teamB.runRate})` : '';

    if (confirm(`Finish match and publish final scorecard?\n\nResult: ${result}${nrrPrompt}`)) {
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
  // PUBLIC LIVE SCOREBOARD (FR-17, FR-18)
  // ==========================================
  setupLiveView() {
    const btnRefresh = document.getElementById('btn-refresh-live');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        this.renderLiveView();
        this.showToast('Live scores updated', 'info');
      });
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
          <div style="display: flex; justify-content: center; gap: 8px;">
            <button class="btn-primary" onclick="App.navigateTo('view-history')">View Match History</button>
            <button class="btn-secondary" onclick="App.navigateTo('view-teams')">View Teams & Squads</button>
          </div>
        </div>
      `;

      if (secondaryContainer && completedMatches.length > 0) {
        const latest = completedMatches[0];
        secondaryContainer.innerHTML = `
          <div class="section-header" style="margin-top: 24px;">
            <h3 style="font-size: 1.1rem; font-weight: 700;">Recent Result</h3>
          </div>
          ${this.generateMatchCardHTML(latest, pMap, false)}
        `;
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

    container.innerHTML = `
      <div class="live-hero">
        <div class="live-header-bar">
          <div class="live-pill">
            <span class="status-dot"></span>
            <span>${is2nd ? '2nd Innings' : '1st Innings'} Live</span>
          </div>
          <div class="overs-badge">
            ${liveMatch.overs} Overs Match
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
            ${inStats.recentBalls.length > 0 ? inStats.recentBalls.map(b => `<div class="ball-badge ${b.type}" title="${b.tooltip || ''}">${b.text}</div>`).join('') : '<span style="color: var(--text-muted); font-size: 0.8rem;">No balls bowled yet in this innings</span>'}
          </div>
        </div>

        <!-- Web Share Button (WhatsApp share) -->
        <div class="share-btn-wrap">
          <button class="btn-share" onclick="App.shareLiveMatch('${liveMatch.id}', '${this.escapeHtml(liveMatch.teamA)}', '${this.escapeHtml(liveMatch.teamB)}', '${inStats.totalRuns}/${inStats.wickets}', '${inStats.oversFormatted}')">
            <span>📲 Share Live Score on WhatsApp</span>
          </button>
          <button class="btn-secondary" onclick="App.openFullScorecardModal('${liveMatch.id}')">
            📋 Full Scorecard
          </button>
        </div>
      </div>
    `;

    if (secondaryContainer) secondaryContainer.innerHTML = '';
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
    const in1Balls = (match.balls || []).filter(b => b.innings === 1);
    const in2Balls = (match.balls || []).filter(b => b.innings === 2);

    const in1 = CricketEngine.replayInnings(in1Balls, match.teamAPlayerIds || [], match.teamBPlayerIds || [], match.overs);
    const in2 = CricketEngine.replayInnings(in2Balls, match.teamBPlayerIds || [], match.teamAPlayerIds || [], match.overs);

    const dateStr = match.createdAt ? new Date(match.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const isAdmin = AppDB.isAdmin();

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
          <button class="btn-secondary" style="padding: 6px 14px; min-height: 38px; font-size: 0.8rem;" onclick="App.openFullScorecardModal('${match.id}')">
            📋 Full Scorecard
          </button>

          ${(isAdmin && showDelete) ? `
            <button class="btn-danger" style="padding: 4px 10px; min-height: 34px; font-size: 0.75rem;" onclick="App.confirmDeleteMatch('${match.id}')">
              🗑️ Delete
            </button>
          ` : ''}
        </div>
      </div>
    `;
  },

  async confirmDeleteMatch(matchId) {
    if (!AppDB.isAdmin()) return;
    if (confirm('Are you sure you want to delete this match record? This action cannot be undone.')) {
      await AppDB.deleteMatch(matchId);
      this.showToast('Match record deleted', 'info');
      this.renderHistoryView();
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

    const in1Balls = (match.balls || []).filter(b => b.innings === 1);
    const in2Balls = (match.balls || []).filter(b => b.innings === 2);

    const in1 = CricketEngine.replayInnings(in1Balls, match.teamAPlayerIds || [], match.teamBPlayerIds || [], match.overs);
    const in2 = CricketEngine.replayInnings(in2Balls, match.teamBPlayerIds || [], match.teamAPlayerIds || [], match.overs);

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
                      <span class="player-name">${p ? this.escapeHtml(p.name) : b.id}</span>
                      <span class="dismissal-note">${b.dismissal}</span>
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
                    <td><span class="player-name">${p ? this.escapeHtml(p.name) : bw.id}</span></td>
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

    if (body) {
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

    tbody.innerHTML = filtered.map(s => {
      const isStaff = AppDB.isStaff();
      return `
      <tr>
        <td>
          <div style="font-weight: 700; color: var(--text-primary);">${this.escapeHtml(s.name)}</div>
          <div style="font-size: 0.72rem; color: var(--text-muted);">${this.escapeHtml(s.roll)}</div>
        </td>
        <td>
          <span style="font-size: 0.78rem; background: var(--bg-surface); padding: 2px 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">${s.role}</span>
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
            <button class="btn-secondary" style="padding: 2px 8px; min-height: 28px; font-size: 0.72rem; border-color: var(--gold-amber); color: var(--gold-amber);" onclick="App.openEditPlayerModal('${s.id}')" title="Edit player details">
              ✏️ Edit
            </button>
            ${isAdmin ? `
              <button class="btn-danger" style="padding: 2px 8px; min-height: 28px; font-size: 0.72rem;" onclick="App.confirmDeletePlayer('${s.id}', '${this.escapeHtml(s.name)}')" title="Delete player">
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
    if (!AppDB.isAdmin()) return;
    if (confirm(`Are you sure you want to delete player ${playerName}? They will also be removed from teams.`)) {
      await AppDB.deletePlayer(playerId);
      this.showToast(`Player ${playerName} deleted`, 'info');
      this.renderPlayersTable();
      this.renderTeamsView();
    }
  },

  // ==========================================
  // POINTS TABLE & NET RUN RATE (ICC NRR)
  // ==========================================
  setupTableView() {
    const btnRefresh = document.getElementById('btn-refresh-table');
    if (btnRefresh) {
      btnRefresh.addEventListener('click', () => {
        this.renderPointsTable();
        this.showToast('📊 Standings updated', 'info');
      });
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
              <span>${this.escapeHtml(row.teamName)}</span>
            </div>
            ${row.motto ? `<div class="table-team-motto">"${this.escapeHtml(row.motto)}"</div>` : ''}
          </td>
          <td class="num-cell">${row.played}</td>
          <td class="num-cell" style="font-weight: 700; color: var(--pitch-green);">${row.won}</td>
          <td class="num-cell" style="color: var(--leather-red);">${row.lost}</td>
          <td class="num-cell">${row.tied}</td>
          <td class="num-cell"><span class="pts-badge">${row.points}</span></td>
          <td class="num-cell"><span class="nrr-badge ${nrrClass}">${row.nrrFormatted}</span></td>
          <td class="num-cell">
            <div>${row.runsScored}</div>
            <div class="overs-split">${row.oversFacedDec.toFixed(1)} ov</div>
          </td>
          <td class="num-cell">
            <div>${row.runsConceded}</div>
            <div class="overs-split">${row.oversBowledDec.toFixed(1)} ov</div>
          </td>
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
    this.renderPointsTable();
    if (this.activeView === 'view-scoring') this.renderScoringConsole();
  },

  onMatchesDataChanged() {
    this.renderLiveView();
    this.renderHistoryView();
    this.renderPlayersTable();
    this.renderPointsTable();
    if (this.activeView === 'view-scoring') this.renderScoringConsole();
  },

  renderAll() {
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
