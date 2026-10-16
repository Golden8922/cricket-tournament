// Team Balancing & Management Engine
// Implements FR-4, FR-5, FR-6, FR-7, FR-8

const TeamEngine = {
  DEFAULT_TEAM_NAMES: [
    "Titans", "Warriors", "Super Kings", "Strikers", 
    "Royals", "Challengers", "Blasters", "Knights", 
    "Hawks", "Thunderbolts", "Falcons", "Panthers", 
    "Stormers", "Rangers", "Gladiators", "Vipers"
  ],

  // FR-5: Auto-balance: sorts players by rating and snake-drafts them into N teams (2 to 16)
  autoBalance(players, numTeams = 2, teamNames = []) {
    const N = Math.max(2, Math.min(16, Number(numTeams) || 2));
    
    // Sort players descending by skill rating (tie break on experience then roll)
    const sorted = [...players].map(p => ({
      ...p,
      calculatedRating: CricketEngine.calculateRating(p)
    })).sort((a, b) => {
      if (b.calculatedRating !== a.calculatedRating) {
        return b.calculatedRating - a.calculatedRating;
      }
      if ((b.exp || 0) !== (a.exp || 0)) {
        return (b.exp || 0) - (a.exp || 0);
      }
      return (a.name || '').localeCompare(b.name || '');
    });

    // Initialize N teams
    const teams = [];
    for (let i = 0; i < N; i++) {
      const name = (teamNames[i] && teamNames[i].trim()) || this.DEFAULT_TEAM_NAMES[i % this.DEFAULT_TEAM_NAMES.length] || `Team ${i + 1}`;
      teams.push({
        id: `team_${i + 1}`,
        name: name,
        playerIds: []
      });
    }

    // Snake draft assignment
    sorted.forEach((player, idx) => {
      const round = Math.floor(idx / N);
      const isReversed = (round % 2 === 1);
      const slot = idx % N;
      const teamIndex = isReversed ? (N - 1 - slot) : slot;
      teams[teamIndex].playerIds.push(player.id);
    });

    return teams;
  },

  // FR-6: Re-shuffle groups players into tiers of N with similar rating,
  // shuffles inside each tier and snake-drafts again,
  // so every re-shuffle stays balanced but gives different teams.
  reShuffle(players, numTeams = 2, teamNames = []) {
    const N = Math.max(2, Math.min(16, Number(numTeams) || 2));

    // 1. Sort players descending by rating
    const sorted = [...players].map(p => ({
      ...p,
      calculatedRating: CricketEngine.calculateRating(p)
    })).sort((a, b) => b.calculatedRating - a.calculatedRating);

    // 2. Group into tiers of N
    const tiers = [];
    for (let i = 0; i < sorted.length; i += N) {
      tiers.push(sorted.slice(i, i + N));
    }

    // 3. Shuffle inside each tier (Fisher-Yates)
    tiers.forEach(tier => {
      for (let i = tier.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tier[i], tier[j]] = [tier[j], tier[i]];
      }
    });

    // 4. Flatten back into tiered array
    const tieredShuffledPlayers = tiers.flat();

    // 5. Initialize teams & snake draft
    const teams = [];
    for (let i = 0; i < N; i++) {
      const name = (teamNames[i] && teamNames[i].trim()) || this.DEFAULT_TEAM_NAMES[i % this.DEFAULT_TEAM_NAMES.length] || `Team ${i + 1}`;
      teams.push({
        id: `team_${i + 1}`,
        name: name,
        playerIds: []
      });
    }

    tieredShuffledPlayers.forEach((player, idx) => {
      const round = Math.floor(idx / N);
      const isReversed = (round % 2 === 1);
      const slot = idx % N;
      const teamIndex = isReversed ? (N - 1 - slot) : slot;
      teams[teamIndex].playerIds.push(player.id);
    });

    return teams;
  },

  // FR-7: Calculate team metrics: player count, total rating, average rating, role breakdown
  calculateTeamStats(team, playersMap = {}) {
    const playerIds = team.playerIds || [];
    let totalRating = 0;
    const roles = { Batter: 0, Bowler: 0, "All-rounder": 0, Wicketkeeper: 0 };
    let keepers = 0;

    playerIds.forEach(id => {
      const p = playersMap[id];
      if (p) {
        totalRating += CricketEngine.calculateRating(p);
        if (roles[p.role] !== undefined) roles[p.role]++;
        if (p.keeper) keepers++;
      }
    });

    const count = playerIds.length;
    const avgRating = count > 0 ? (totalRating / count).toFixed(1) : "0.0";

    return {
      count,
      totalRating,
      avgRating,
      roles,
      keepers
    };
  },

  // FR-7: Admin can move any player between teams or to Unassigned
  movePlayer(playerId, sourceTeamIndex, targetTeamIndex, teams, unassignedIds = []) {
    // If source is a team
    if (sourceTeamIndex >= 0 && sourceTeamIndex < teams.length) {
      teams[sourceTeamIndex].playerIds = teams[sourceTeamIndex].playerIds.filter(id => id !== playerId);
    } else {
      // Source was unassigned
      const uIndex = unassignedIds.indexOf(playerId);
      if (uIndex > -1) unassignedIds.splice(uIndex, 1);
    }

    // Target assignment
    if (targetTeamIndex === -1 || targetTeamIndex === 'unassigned') {
      // Move to unassigned
      if (!unassignedIds.includes(playerId)) {
        unassignedIds.push(playerId);
      }
    } else if (targetTeamIndex >= 0 && targetTeamIndex < teams.length) {
      // Move to target team
      if (!teams[targetTeamIndex].playerIds.includes(playerId)) {
        teams[targetTeamIndex].playerIds.push(playerId);
      }
    }

    return { teams, unassignedIds };
  }
};
