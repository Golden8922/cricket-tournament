// Official College Cricket Tournament Dataset
// 4 Official Teams: Sitare Strikers, Falcons, Dominators, Power Smashers
// Player naming format: [FirstName] [Year] (e.g. Ritik 3, Golden 2)

const OFFICIAL_TEAMS_DATA = [
  {
    id: "team_sitare_strikers",
    name: "Sitare Strikers",
    motto: "Explosive. Fearless. Unstoppable.",
    captain: "Ritik 3",
    viceCaptain: "Ankit 2",
    playerIds: []
  },
  {
    id: "team_falcons",
    name: "Falcons",
    motto: "Fast. Fierce. Electrifying.",
    captain: "Manish 3",
    viceCaptain: "Ayush 2",
    playerIds: []
  },
  {
    id: "team_dominators",
    name: "Dominators",
    motto: "Born to battle. Built to win.",
    captain: "Prem 3",
    viceCaptain: "Alok 2",
    playerIds: []
  },
  {
    id: "team_power_smashers",
    name: "Power Smashers",
    motto: "Rise from the cosmos.",
    captain: "Aryan 3",
    viceCaptain: "Adarsh 2",
    playerIds: []
  }
];

const OFFICIAL_PLAYERS_RAW = [
  // ---------------------------------------------------------
  // TEAM 1: SITARE STRIKERS
  // ---------------------------------------------------------
  { teamId: "team_sitare_strikers", fullName: "Ritik Singh", name: "Ritik 3", role: "All-rounder", year: 3, isCaptain: true, bat: 5, bowl: 4, field: 4, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Ankit Kumar Singh", name: "Ankit 2", role: "All-rounder", year: 2, isViceCaptain: true, bat: 4, bowl: 4, field: 4, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Ashwin Yadav", name: "Ashwin 3", role: "All-rounder", year: 3, bat: 4, bowl: 4, field: 4, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Sajan Kumar", name: "Sajan 3", role: "Batter", year: 3, bat: 4, bowl: 2, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Lakhan Rathore", name: "Lakhan 3", role: "Bowler", year: 3, bat: 2, bowl: 5, field: 4, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Ajit Yadav", name: "Ajit 3", role: "All-rounder", year: 3, bat: 3, bowl: 4, field: 4, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Vinay Gupta", name: "Vinay 3", role: "Batter", year: 3, bat: 4, bowl: 1, field: 4, keeper: true },
  { teamId: "team_sitare_strikers", fullName: "Chiru", name: "Chiru 2", role: "Batter", year: 2, bat: 3, bowl: 2, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Avadhesh Kumar", name: "Avadhesh 1", role: "Batter", year: 1, bat: 3, bowl: 2, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Ashish Gupta", name: "Ashish 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Dhannjay Gupta", name: "Dhannjay 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Utkarsh", name: "Utkarsh 1", role: "Bowler", year: 1, bat: 1, bowl: 4, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Avanish Kumar", name: "Avanish 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_sitare_strikers", fullName: "Abhishek Kumar", name: "Abhishek 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },

  // ---------------------------------------------------------
  // TEAM 2: FALCONS
  // ---------------------------------------------------------
  { teamId: "team_falcons", fullName: "Manish Tiwari", name: "Manish 3", role: "Batter", year: 3, isCaptain: true, bat: 5, bowl: 2, field: 4, keeper: false },
  { teamId: "team_falcons", fullName: "Ayush Kumar Singh", name: "Ayush 2", role: "Bowler", year: 2, isViceCaptain: true, bat: 2, bowl: 5, field: 4, keeper: false },
  { teamId: "team_falcons", fullName: "Satish Mahto", name: "Satish 3", role: "All-rounder", year: 3, bat: 4, bowl: 4, field: 4, keeper: false },
  { teamId: "team_falcons", fullName: "Rohit Malviya", name: "Rohit 3", role: "All-rounder", year: 3, bat: 4, bowl: 3, field: 4, keeper: false },
  { teamId: "team_falcons", fullName: "Vivek Kumar", name: "Vivek 3", role: "All-rounder", year: 3, bat: 4, bowl: 3, field: 4, keeper: false },
  { teamId: "team_falcons", fullName: "Shivansh Trivedi", name: "Shivansh 2", role: "Batter", year: 2, bat: 4, bowl: 2, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Piyush Kumar", name: "Piyush K 2", role: "Batter", year: 2, bat: 3, bowl: 1, field: 4, keeper: true },
  { teamId: "team_falcons", fullName: "Golden Yadav", name: "Golden 2", role: "All-rounder", year: 2, bat: 4, bowl: 4, field: 5, keeper: false },
  { teamId: "team_falcons", fullName: "Piyush", name: "Piyush 2", role: "All-rounder", year: 2, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Pramod Prajapati", name: "Pramod 1", role: "Bowler", year: 1, bat: 1, bowl: 4, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Rajesh Chaurasiya", name: "Rajesh 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Krishna Kumar", name: "Krishna 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Raj Gupta", name: "Raj 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_falcons", fullName: "Shubham Kumar", name: "Shubham 1", role: "Bowler", year: 1, bat: 1, bowl: 4, field: 3, keeper: false },

  // ---------------------------------------------------------
  // TEAM 3: DOMINATORS
  // ---------------------------------------------------------
  { teamId: "team_dominators", fullName: "Prem Kumar", name: "Prem 3", role: "All-rounder", year: 3, isCaptain: true, bat: 5, bowl: 4, field: 4, keeper: false },
  { teamId: "team_dominators", fullName: "Alok Prakhar", name: "Alok 2", role: "All-rounder", year: 2, isViceCaptain: true, bat: 4, bowl: 4, field: 4, keeper: false },
  { teamId: "team_dominators", fullName: "Aman Singh", name: "Aman 3", role: "Batter", year: 3, bat: 4, bowl: 2, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Hari Singh Rajpoot", name: "Hari 3", role: "All-rounder", year: 3, bat: 3, bowl: 4, field: 4, keeper: false },
  { teamId: "team_dominators", fullName: "Abhishek Singh", name: "Abhishek 3", role: "All-rounder", year: 3, bat: 4, bowl: 3, field: 4, keeper: false },
  { teamId: "team_dominators", fullName: "Ayush Kumar Yadav", name: "Ayush Y 3", role: "All-rounder", year: 3, bat: 3, bowl: 4, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Anikesh Pal", name: "Anikesh 2", role: "Bowler", year: 2, bat: 1, bowl: 4, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Pradeep", name: "Pradeep 2", role: "Bowler", year: 2, bat: 1, bowl: 4, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Ashish Kumar", name: "Ashish K 1", role: "Batter", year: 1, bat: 3, bowl: 2, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Anuj", name: "Anuj 1", role: "Batter", year: 1, bat: 3, bowl: 1, field: 4, keeper: true },
  { teamId: "team_dominators", fullName: "Surya Prajapat", name: "Surya 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Manish Kumar", name: "Manish K 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Player To Be Announced", name: "TBA 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_dominators", fullName: "Suraj Kumar", name: "Suraj 1", role: "All-rounder", year: 1, bat: 3, bowl: 4, field: 3, keeper: false },

  // ---------------------------------------------------------
  // TEAM 4: POWER SMASHERS
  // ---------------------------------------------------------
  { teamId: "team_power_smashers", fullName: "Anand Kumar Pandey", name: "Anand 3", role: "Batter", year: 3, bat: 4, bowl: 2, field: 4, keeper: false },
  { teamId: "team_power_smashers", fullName: "Adarsh Singh", name: "Adarsh 2", role: "Batter", year: 2, isViceCaptain: true, bat: 4, bowl: 2, field: 4, keeper: false },
  { teamId: "team_power_smashers", fullName: "Rahul Verma", name: "Rahul 3", role: "All-rounder", year: 3, bat: 3, bowl: 3, field: 4, keeper: false },
  { teamId: "team_power_smashers", fullName: "Prabhat Patidar", name: "Prabhat 3", role: "Batter", year: 3, bat: 4, bowl: 1, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Vishal Bharadwaj", name: "Vishal 3", role: "All-rounder", year: 3, bat: 4, bowl: 3, field: 4, keeper: false },
  { teamId: "team_power_smashers", fullName: "Gutman Singh", name: "Gutman 3", role: "Batter", year: 3, bat: 4, bowl: 2, field: 3, keeper: true },
  { teamId: "team_power_smashers", fullName: "Aryan Saini", name: "Aryan 3", role: "All-rounder", year: 3, isCaptain: true, bat: 4, bowl: 4, field: 4, keeper: false },
  { teamId: "team_power_smashers", fullName: "Aditya", name: "Aditya 2", role: "Batter", year: 2, bat: 3, bowl: 2, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Kheenvraj", name: "Kheenvraj 2", role: "Bowler", year: 2, bat: 1, bowl: 4, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Ashish Jha", name: "Ashish J 2", role: "Bowler", year: 2, bat: 2, bowl: 4, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Gaurav", name: "Gaurav 1", role: "Batter", year: 1, bat: 3, bowl: 1, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Raunak Yadav", name: "Raunak 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false },
  { teamId: "team_power_smashers", fullName: "Aryan", name: "Aryan 1", role: "All-rounder", year: 1, bat: 3, bowl: 3, field: 3, keeper: false }
];

// Generate populated teams and players
function getInitialTournamentData() {
  const players = OFFICIAL_PLAYERS_RAW.map((raw, idx) => ({
    id: `p_off_${idx + 1}`,
    name: raw.name, // e.g. "Ritik 3"
    fullName: raw.fullName, // e.g. "Ritik Singh"
    roll: `YR${raw.year}-${String(idx + 1).padStart(3, '0')}`,
    role: raw.role,
    year: raw.year,
    exp: raw.year,
    bat: raw.bat,
    bowl: raw.bowl,
    field: raw.field,
    keeper: raw.keeper || false,
    isCaptain: raw.isCaptain || false,
    isViceCaptain: raw.isViceCaptain || false,
    createdAt: Date.now() - 3600000 * 24
  }));

  const teams = OFFICIAL_TEAMS_DATA.map(t => {
    const teamPlayers = OFFICIAL_PLAYERS_RAW
      .map((raw, idx) => ({ ...raw, id: `p_off_${idx + 1}` }))
      .filter(p => p.teamId === t.id);
    
    return {
      id: t.id,
      name: t.name,
      motto: t.motto,
      captain: t.captain,
      viceCaptain: t.viceCaptain,
      captainId: (teamPlayers.find(p => p.name === t.captain) || {}).id || null,
      viceCaptainId: (teamPlayers.find(p => p.name === t.viceCaptain) || {}).id || null,
      playerIds: teamPlayers.map(p => p.id)
    };
  });

  // Fresh tournament: no preloaded completed matches (starts clean!)
  const matches = [];

  return { teams, players, matches };
}

// Global reference for fallback
const SEED_PLAYERS = getInitialTournamentData().players;
