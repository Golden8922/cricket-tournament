// Cricket Scoring & Analytics Engine
// College Cricket Tournament PWA

const CricketEngine = {
  // FR-4: Player rating calculation
  // Player rating = min(batting, experience+2) + min(bowling, experience+2) + min(fielding, experience+2) + experience + 1 if wicketkeeper
  calculateRating(player) {
    if (!player) return 0;
    const exp = Math.max(0, Math.min(5, Number(player.exp) || 0));
    const bat = Math.max(1, Math.min(5, Number(player.bat) || 1));
    const bowl = Math.max(1, Math.min(5, Number(player.bowl) || 1));
    const field = Math.max(1, Math.min(5, Number(player.field) || 1));
    const isKeeper = Boolean(player.keeper);

    const cap = exp + 2;
    const cappedBat = Math.min(bat, cap);
    const cappedBowl = Math.min(bowl, cap);
    const cappedField = Math.min(field, cap);

    return cappedBat + cappedBowl + cappedField + exp + (isKeeper ? 1 : 0);
  },

  // Format overs helper: balls -> "O.B" (e.g. 14 balls -> "2.2")
  formatOvers(legalBalls) {
    const ov = Math.floor(legalBalls / 6);
    const rem = legalBalls % 6;
    return `${ov}.${rem}`;
  },

  // FR-21: Pure replay function that derives complete scorecard and figures from stored balls
  replayInnings(balls = [], battingPlayerIds = [], bowlingPlayerIds = [], maxOvers = 5) {
    const stats = {
      totalRuns: 0,
      wickets: 0,
      legalBalls: 0,
      extras: { wide: 0, noball: 0, bye: 0, legbye: 0, total: 0 },
      batters: {},
      bowlers: {},
      fallOfWickets: [],
      oversHistory: [], // array of overs with balls
      currentOverBalls: [],
      recentBalls: [],
      isAllOut: false,
      isInningsOver: false
    };

    // Initialize batting records
    battingPlayerIds.forEach(id => {
      stats.batters[id] = {
        id,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        isOut: false,
        dismissal: "not out",
        strikeRate: "0.00"
      };
    });

    // Initialize bowling records
    bowlingPlayerIds.forEach(id => {
      stats.bowlers[id] = {
        id,
        legalBalls: 0,
        oversFormatted: "0.0",
        maidens: 0,
        runsConceded: 0,
        wickets: 0,
        economy: "0.00"
      };
    });

    let currentOverIndex = 0;
    let overRunsConceded = 0;
    let overLegalBalls = 0;
    let overWickets = 0;
    let overDroppedCatches = 0;
    let overBowlerId = null;
    let overBowlerName = '';

    balls.forEach((ball, idx) => {
      const runs = Number(ball.runs) || 0;
      const extraType = ball.extraType; // null | 'wide' | 'noball' | 'bye' | 'legbye' | 'penalty'
      const isWicket = Boolean(ball.isWicket);
      const isLegal = (extraType !== 'wide' && extraType !== 'noball' && extraType !== 'penalty' && !ball.isPenalty);

      let runsForTeam = runs;
      let runsForBatter = 0;
      let runsForBowler = 0;

      // Ensure batter & bowler records exist
      if (ball.batterId && !stats.batters[ball.batterId]) {
        stats.batters[ball.batterId] = { id: ball.batterId, runs: 0, balls: 0, fours: 0, sixes: 0, isOut: false, dismissal: "not out", strikeRate: "0.00" };
      }
      if (ball.bowlerId && !stats.bowlers[ball.bowlerId]) {
        stats.bowlers[ball.bowlerId] = { id: ball.bowlerId, legalBalls: 0, oversFormatted: "0.0", maidens: 0, runsConceded: 0, wickets: 0, economy: "0.00" };
      }

      const batter = stats.batters[ball.batterId];
      const bowler = stats.bowlers[ball.bowlerId];
      if (ball.bowlerId) {
        overBowlerId = ball.bowlerId;
        overBowlerName = ball.bowlerName || '';
      }

      if (extraType === 'wide') {
        // Wide: 1 run penalty + any additional runs ran
        const extraRuns = 1 + runs;
        runsForTeam = extraRuns;
        runsForBowler = extraRuns;
        stats.extras.wide += extraRuns;
        stats.extras.total += extraRuns;
      } else if (extraType === 'noball') {
        // No ball: 1 penalty + runs off the bat
        runsForTeam = 1 + runs;
        runsForBowler = 1 + runs;
        runsForBatter = runs;
        stats.extras.noball += 1;
        stats.extras.total += 1;
        if (batter) {
          batter.balls += 1; // batter faced delivery
        }
      } else if (extraType === 'bye') {
        // Bye: legal delivery, runs to team extras, 0 to batter, 0 charged to bowler
        runsForTeam = runs;
        runsForBowler = 0;
        stats.extras.bye += runs;
        stats.extras.total += runs;
        if (batter) batter.balls += 1;
      } else if (extraType === 'legbye') {
        // Leg bye: legal delivery, runs to team extras, 0 to batter, 0 charged to bowler
        runsForTeam = runs;
        runsForBowler = 0;
        stats.extras.legbye += runs;
        stats.extras.total += runs;
        if (batter) batter.balls += 1;
      } else if (extraType === 'penalty' || ball.isPenalty) {
        // Extra/Penalty runs: does not consume a legal ball, added to extras & team total
        runsForTeam = runs;
        runsForBowler = runs;
        stats.extras.total += runs;
      } else {
        // Standard legal delivery off the bat
        runsForTeam = runs;
        runsForBatter = runs;
        runsForBowler = runs;
        if (batter) {
          batter.balls += 1;
        }
      }

      // Update batter
      if (batter && runsForBatter > 0) {
        batter.runs += runsForBatter;
        if (runsForBatter === 4) batter.fours += 1;
        if (runsForBatter === 6) batter.sixes += 1;
      }

      // Update bowler
      if (bowler) {
        bowler.runsConceded += runsForBowler;
        overRunsConceded += runsForBowler;
        if (isLegal) {
          bowler.legalBalls += 1;
        }
      }

      // Legal ball increment
      if (isLegal) {
        stats.legalBalls += 1;
        overLegalBalls += 1;
      }

      // Total runs
      stats.totalRuns += runsForTeam;

      // Handle Dropped Catch
      if (ball.isDroppedCatch || ball.droppedCatch) {
        overDroppedCatches += 1;
      }

      // Handle Wicket
      if (isWicket) {
        stats.wickets += 1;
        overWickets += 1;
        const outId = ball.outPlayerId || ball.batterId;
        const outPlayer = stats.batters[outId];
        const wType = ball.wicketType || 'out';

        if (outPlayer) {
          outPlayer.isOut = true;
          if (wType === 'runout') {
            outPlayer.dismissal = `run out`;
          } else if (wType === 'retired' || wType === 'declared') {
            outPlayer.dismissal = `retired / declared`;
          } else if (wType === 'bowled') {
            outPlayer.dismissal = `b ${ball.bowlerName || 'Bowler'}`;
          } else if (wType === 'caught') {
            outPlayer.dismissal = `c Fielder b ${ball.bowlerName || 'Bowler'}`;
          } else if (wType === 'lbw') {
            outPlayer.dismissal = `lbw b ${ball.bowlerName || 'Bowler'}`;
          } else if (wType === 'stumped') {
            outPlayer.dismissal = `st Keeper b ${ball.bowlerName || 'Bowler'}`;
          } else {
            outPlayer.dismissal = `${wType} b ${ball.bowlerName || 'Bowler'}`;
          }
        }

        // Bowler gets wicket unless runout or retired/declared
        if (bowler && wType !== 'runout' && wType !== 'retired' && wType !== 'declared') {
          bowler.wickets += 1;
        }

        stats.fallOfWickets.push({
          wicketNum: stats.wickets,
          score: stats.totalRuns,
          oversFormatted: CricketEngine.formatOvers(stats.legalBalls),
          playerOutId: outId,
          playerOutName: ball.outPlayerName || outId
        });
      }

      // Tracking current over & recent balls
      const badgeData = CricketEngine.createBallBadge(ball, runsForTeam, isWicket);
      stats.currentOverBalls.push(badgeData);
      stats.recentBalls.push(badgeData);
      if (stats.recentBalls.length > 12) {
        stats.recentBalls.shift();
      }

      // Check if over ended (6 legal balls)
      if (isLegal && overLegalBalls === 6) {
        if (bowler && overRunsConceded === 0) {
          bowler.maidens += 1;
        }
        stats.oversHistory.push({
          overNum: currentOverIndex + 1,
          bowlerId: overBowlerId,
          bowlerName: overBowlerName,
          balls: [...stats.currentOverBalls],
          runs: overRunsConceded,
          wickets: overWickets,
          droppedCatches: overDroppedCatches,
          inProgress: false
        });
        stats.currentOverBalls = [];
        overRunsConceded = 0;
        overLegalBalls = 0;
        overWickets = 0;
        overDroppedCatches = 0;
        overBowlerId = null;
        overBowlerName = '';
        currentOverIndex += 1;
      }
    });

    // In-progress over if any balls bowled
    if (stats.currentOverBalls.length > 0) {
      stats.oversHistory.push({
        overNum: currentOverIndex + 1,
        bowlerId: overBowlerId,
        bowlerName: overBowlerName,
        balls: [...stats.currentOverBalls],
        runs: overRunsConceded,
        wickets: overWickets,
        droppedCatches: overDroppedCatches,
        inProgress: true
      });
    }

    // Calculate strike rates
    Object.values(stats.batters).forEach(b => {
      b.strikeRate = b.balls > 0 ? ((b.runs / b.balls) * 100).toFixed(1) : "0.0";
    });

    // Calculate bowling economies & format overs
    Object.values(stats.bowlers).forEach(bw => {
      bw.oversFormatted = CricketEngine.formatOvers(bw.legalBalls);
      const totalOversDec = Math.floor(bw.legalBalls / 6) + (bw.legalBalls % 6) / 6;
      bw.economy = totalOversDec > 0 ? (bw.runsConceded / totalOversDec).toFixed(2) : "0.00";
    });

    // All out condition: team players - 1 wickets or 10 wickets
    const maxWickets = Math.min(10, Math.max(1, battingPlayerIds.length - 1));
    stats.isAllOut = stats.wickets >= maxWickets;
    stats.isInningsOver = stats.isAllOut || stats.legalBalls >= (maxOvers * 6);
    stats.oversFormatted = CricketEngine.formatOvers(stats.legalBalls);

    return stats;
  },

  // Innings stats for a match. Matches entered by hand after the fact ("past matches") carry
  // only final totals in match.summary; every other match is derived from its ball list.
  getInningsStats(match, inningsNo) {
    const battingIds = inningsNo === 1 ? (match.teamAPlayerIds || []) : (match.teamBPlayerIds || []);
    const bowlingIds = inningsNo === 1 ? (match.teamBPlayerIds || []) : (match.teamAPlayerIds || []);
    const summary = match.summary && match.summary[inningsNo === 1 ? 'inn1' : 'inn2'];

    if (summary) {
      const balls = Math.max(0, Number(summary.balls) || 0);
      return {
        totalRuns: Math.max(0, Number(summary.runs) || 0),
        wickets: Math.max(0, Number(summary.wickets) || 0),
        legalBalls: balls,
        oversFormatted: CricketEngine.formatOvers(balls),
        extras: { wide: 0, noball: 0, bye: 0, legbye: 0, total: 0 },
        batters: {},
        bowlers: {},
        fallOfWickets: [],
        oversHistory: [],
        currentOverBalls: [],
        recentBalls: [],
        isAllOut: Boolean(summary.allOut),
        isInningsOver: true
      };
    }

    const inningsBalls = (match.balls || []).filter(b => b.innings === inningsNo);
    return CricketEngine.replayInnings(inningsBalls, battingIds, bowlingIds, match.overs || 5);
  },

  // Helper for badge display of a ball
  createBallBadge(ball, totalRuns, isWicket) {
    if (isWicket) {
      const wicketRuns = Number(ball.runs) > 0 ? `${Number(ball.runs)}` : '';
      return { text: `${wicketRuns}W`, type: "wicket", tooltip: `WICKET (${ball.wicketType || 'Out'}${wicketRuns ? `, ${wicketRuns} run${Number(ball.runs) > 1 ? 's' : ''} completed` : ''})` };
    }
    if (ball.isDroppedCatch || ball.droppedCatch) {
      const runTxt = totalRuns > 0 ? `${totalRuns} (DC)` : "DC";
      return { text: runTxt, type: "dropped", tooltip: `🖐️ Dropped Catch! (${totalRuns} runs)` };
    }
    if (ball.extraType === 'penalty' || ball.isPenalty) {
      return { text: `+${totalRuns}`, type: "penalty", tooltip: `Extra/Penalty Runs (+${totalRuns})` };
    }
    if (ball.extraType === 'wide') {
      const extra = totalRuns > 1 ? `+${totalRuns - 1}` : '';
      return { text: `Wd${extra}`, type: "wide", tooltip: `Wide (${totalRuns} run${totalRuns > 1 ? 's' : ''})` };
    }
    if (ball.extraType === 'noball') {
      const batRuns = ball.runs > 0 ? `+${ball.runs}` : '';
      return { text: `Nb${batRuns}`, type: "noball", tooltip: `No Ball (${totalRuns} total runs)` };
    }
    if (ball.extraType === 'bye') {
      return { text: `${ball.runs}B`, type: "bye", tooltip: `${ball.runs} Bye` };
    }
    if (ball.extraType === 'legbye') {
      return { text: `${ball.runs}Lb`, type: "legbye", tooltip: `${ball.runs} Leg Bye` };
    }
    if (ball.runs === 4) {
      return { text: "4", type: "four", tooltip: "FOUR! Boundary" };
    }
    if (ball.runs === 6) {
      return { text: "6", type: "six", tooltip: "SIX! Maximum" };
    }
    if (ball.runs === 0) {
      return { text: "•", type: "dot", tooltip: "Dot ball" };
    }
    return { text: String(ball.runs), type: "run", tooltip: `${ball.runs} run${ball.runs > 1 ? 's' : ''}` };
  },

  // FR-20: Cumulative tournament player statistics calculated across all matches
  computeAggregatePlayerStats(matches = [], players = []) {
    const pStats = {};

    players.forEach(p => {
      pStats[p.id] = {
        id: p.id,
        name: p.name,
        roll: p.roll,
        role: p.role,
        rating: CricketEngine.calculateRating(p),
        matchesPlayed: 0,
        // Batting
        inningsBatted: 0,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        highestScore: 0,
        dismissals: 0,
        battingAverage: "0.00",
        strikeRate: "0.00",
        // Bowling
        legalBallsBowled: 0,
        oversFormatted: "0.0",
        runsConceded: 0,
        wickets: 0,
        maidens: 0,
        economy: "0.00",
        bowlingAverage: "0.00"
      };
    });

    matches.forEach(match => {
      const allPlayersInMatch = new Set([...(match.teamAPlayerIds || []), ...(match.teamBPlayerIds || [])]);
      allPlayersInMatch.forEach(pid => {
        if (pStats[pid]) pStats[pid].matchesPlayed += 1;
      });

      const in1 = CricketEngine.getInningsStats(match, 1);
      const in2 = CricketEngine.getInningsStats(match, 2);

      [in1, in2].forEach(rep => {
        // Batting aggregates
        Object.values(rep.batters).forEach(b => {
          if (!pStats[b.id]) return;
          const stat = pStats[b.id];
          if (b.balls > 0 || b.isOut) {
            stat.inningsBatted += 1;
            stat.runs += b.runs;
            stat.balls += b.balls;
            stat.fours += b.fours;
            stat.sixes += b.sixes;
            if (b.runs > stat.highestScore) stat.highestScore = b.runs;
            if (b.isOut) stat.dismissals += 1;
          }
        });

        // Bowling aggregates
        Object.values(rep.bowlers).forEach(bw => {
          if (!pStats[bw.id]) return;
          const stat = pStats[bw.id];
          if (bw.legalBalls > 0) {
            stat.legalBallsBowled += bw.legalBalls;
            stat.runsConceded += bw.runsConceded;
            stat.wickets += bw.wickets;
            stat.maidens += bw.maidens;
          }
        });
      });
    });

    // Calculate rates
    Object.values(pStats).forEach(s => {
      s.strikeRate = s.balls > 0 ? ((s.runs / s.balls) * 100).toFixed(1) : "0.0";
      s.battingAverage = s.dismissals > 0 ? (s.runs / s.dismissals).toFixed(2) : (s.runs > 0 ? `${s.runs}*` : "0.00");
      s.oversFormatted = CricketEngine.formatOvers(s.legalBallsBowled);
      const totalOversDec = Math.floor(s.legalBallsBowled / 6) + (s.legalBallsBowled % 6) / 6;
      s.economy = totalOversDec > 0 ? (s.runsConceded / totalOversDec).toFixed(2) : "0.00";
      s.bowlingAverage = s.wickets > 0 ? (s.runsConceded / s.wickets).toFixed(2) : "-";
    });

    return Object.values(pStats);
  },

  // Generates match result text (FR-14)
  generateMatchResultText(teamA, teamB, in1Stats, in2Stats, maxOvers, teamBPlayerCount = 11) {
    const teamARuns = in1Stats.totalRuns;
    const teamBRuns = in2Stats.totalRuns;
    const target = teamARuns + 1;

    if (teamBRuns >= target) {
      const maxWickets = Math.min(10, Math.max(1, teamBPlayerCount - 1));
      const wicketsRemaining = Math.max(0, maxWickets - in2Stats.wickets);
      const ballsRemaining = Math.max(0, (maxOvers * 6) - in2Stats.legalBalls);
      return `${teamB} won by ${wicketsRemaining} wicket${wicketsRemaining !== 1 ? 's' : ''} (${ballsRemaining} balls left)`;
    } else if (in2Stats.isInningsOver) {
      if (teamBRuns === teamARuns) {
        return "Match Tied";
      }
      const runsMargin = teamARuns - teamBRuns;
      return `${teamA} won by ${runsMargin} run${runsMargin !== 1 ? 's' : ''}`;
    }
    return "Match in progress";
  },

  // Calculate Points Table with Net Run Rate (NRR)
  calculatePointsTable(matches = [], teams = []) {
    const table = {};
    const h2h = {}; // h2h[winner][loser] = wins in matches between those two teams
    const recordWin = (winner, loser) => {
      h2h[winner] = h2h[winner] || {};
      h2h[winner][loser] = (h2h[winner][loser] || 0) + 1;
    };

    teams.forEach(t => {
      table[t.name] = {
        teamId: t.id,
        teamName: t.name,
        name: t.name,
        motto: t.motto || '',
        played: 0,
        won: 0,
        lost: 0,
        tied: 0,
        points: 0,
        runsScored: 0,
        oversFacedDec: 0,
        runsConceded: 0,
        oversBowledDec: 0,
        nrr: 0.0,
        nrrFormatted: "0.000"
      };
    });

    matches.forEach(m => {
      if (m.status !== 'done') return;
      const teamA = table[m.teamA];
      const teamB = table[m.teamB];
      if (!teamA || !teamB) return;

      teamA.played += 1;
      teamB.played += 1;

      const in1 = CricketEngine.getInningsStats(m, 1);
      const in2 = CricketEngine.getInningsStats(m, 2);

      const maxOvers = Number(m.overs) || 5;

      // ICC Rule: If team is all out, the full quota of overs is charged for NRR calculation
      const teamAOversFaced = in1.isAllOut ? maxOvers : (Math.floor(in1.legalBalls / 6) + (in1.legalBalls % 6) / 6);
      const teamBOversFaced = in2.isAllOut ? maxOvers : (Math.floor(in2.legalBalls / 6) + (in2.legalBalls % 6) / 6);

      teamA.runsScored += in1.totalRuns;
      teamA.oversFacedDec += teamAOversFaced;
      teamA.runsConceded += in2.totalRuns;
      teamA.oversBowledDec += teamBOversFaced;

      teamB.runsScored += in2.totalRuns;
      teamB.oversFacedDec += teamBOversFaced;
      teamB.runsConceded += in1.totalRuns;
      teamB.oversBowledDec += teamAOversFaced;

      // Result points
      const target = in1.totalRuns + 1;
      if (in2.totalRuns >= target) {
        teamB.won += 1;
        teamB.points += 2;
        teamA.lost += 1;
        recordWin(m.teamB, m.teamA);
      } else if (in2.totalRuns === in1.totalRuns) {
        teamA.tied += 1;
        teamB.tied += 1;
        teamA.points += 1;
        teamB.points += 1;
      } else {
        teamA.won += 1;
        teamA.points += 2;
        teamB.lost += 1;
        recordWin(m.teamA, m.teamB);
      }
    });

    // Compute NRR for each team
    Object.values(table).forEach(row => {
      const forRate = row.oversFacedDec > 0 ? (row.runsScored / row.oversFacedDec) : 0;
      const againstRate = row.oversBowledDec > 0 ? (row.runsConceded / row.oversBowledDec) : 0;
      const nrrVal = forRate - againstRate;
      row.nrr = nrrVal;
      const sign = nrrVal > 0 ? "+" : "";
      row.nrrFormatted = `${sign}${nrrVal.toFixed(3)}`;
    });

    // Sort: Points DESC, NRR DESC, Wins DESC
    return Object.values(table).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.nrr !== a.nrr) return b.nrr - a.nrr;
      if (b.won !== a.won) return b.won - a.won;
      // Last tie-break: head-to-head wins between the two teams
      return ((h2h[b.teamName] || {})[a.teamName] || 0) - ((h2h[a.teamName] || {})[b.teamName] || 0);
    });
  },

  // League matches still to be played, as a list of [teamA, teamB] pairs.
  // Every pair is assumed to meet `rounds` times (1 = single round robin), and any scheduled
  // fixtures beyond that count too. Finished matches are subtracted; a live match is not finished.
  getRemainingLeagueMatches(matches = [], teams = [], fixtures = [], rounds = 1) {
    const names = teams.map(t => t.name);
    const key = (a, b) => [a, b].sort().join('||');
    const played = {};
    const scheduled = {};

    matches.forEach(m => {
      if (m.status !== 'done' || !names.includes(m.teamA) || !names.includes(m.teamB)) return;
      const k = key(m.teamA, m.teamB);
      played[k] = (played[k] || 0) + 1;
    });
    fixtures.forEach(f => {
      if (!names.includes(f.teamA) || !names.includes(f.teamB)) return;
      const k = key(f.teamA, f.teamB);
      scheduled[k] = (scheduled[k] || 0) + 1;
    });

    const remaining = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const k = key(names[i], names[j]);
        const left = Math.max(rounds - (played[k] || 0), (scheduled[k] || 0) - (played[k] || 0), 0);
        for (let c = 0; c < left; c++) remaining.push([names[i], names[j]]);
      }
    }
    return remaining;
  },

  // Which teams are mathematically certain to finish in the top `spots`, whatever happens in
  // the remaining matches (any win/loss/tie combination).
  //   - A team can be overtaken by anyone who can finish on more points.
  //   - On equal points the tie-break (net run rate...) is only treated as settled when neither
  //     team has a match left; otherwise it is assumed to go against the team being checked,
  //     because one big win or loss can swing a net run rate by any amount.
  // `table` must be the sorted result of calculatePointsTable().
  computeQualification(table = [], remaining = [], spots = 2) {
    const n = table.length;
    const qualified = new Set();
    if (n === 0 || spots <= 0) return qualified;
    if (spots >= n) return new Set(table.map(r => r.teamName));

    const index = {};
    table.forEach((r, i) => { index[r.teamName] = i; });
    const base = table.map(r => r.points);
    const left = new Array(n).fill(0);
    const games = [];
    remaining.forEach(([a, b]) => {
      if (index[a] === undefined || index[b] === undefined) return;
      games.push([index[a], index[b]]);
      left[index[a]]++;
      left[index[b]]++;
    });

    // true when team u can finish above team t at equal or higher points
    const overtakes = (pts, u, t) => {
      if (pts[u] !== pts[t]) return pts[u] > pts[t];
      if (left[u] > 0 || left[t] > 0) return true; // tie-break still open
      return u < t;                                  // both finished: current order is final
    };

    const safe = new Set(table.map((r, i) => i));
    const MAX_ENUMERATED = 12;

    if (games.length <= MAX_ENUMERATED) {
      const pts = base.slice();
      const check = () => {
        for (const t of [...safe]) {
          let ahead = 0;
          for (let u = 0; u < n; u++) if (u !== t && overtakes(pts, u, t)) ahead++;
          if (ahead >= spots) safe.delete(t);
        }
      };
      const walk = (g) => {
        if (safe.size === 0) return;
        if (g === games.length) { check(); return; }
        const [a, b] = games[g];
        pts[a] += 2; walk(g + 1); pts[a] -= 2;          // a wins
        pts[b] += 2; walk(g + 1); pts[b] -= 2;          // b wins
        pts[a] += 1; pts[b] += 1; walk(g + 1); pts[a] -= 1; pts[b] -= 1; // tie
      };
      walk(0);
    } else {
      // Too many matches to enumerate: cautious bound (everyone else wins all their matches)
      const most = base.map((p, i) => p + 2 * left[i]);
      for (const t of [...safe]) {
        let ahead = 0;
        for (let u = 0; u < n; u++) {
          if (u === t) continue;
          if (most[u] > base[t] || (most[u] === base[t] && (left[u] > 0 || left[t] > 0 || u < t))) ahead++;
        }
        if (ahead >= spots) safe.delete(t);
      }
    }

    safe.forEach(i => qualified.add(table[i].teamName));
    return qualified;
  },

  // Calculate single match Net Run Rate (NRR) and Run Rates for both teams according to ICC rules
  calculateMatchNetRunRate(match) {
    if (!match) return null;
    const maxOvers = Number(match.overs) || 5;
    const in1 = CricketEngine.getInningsStats(match, 1);
    const in2 = CricketEngine.getInningsStats(match, 2);

    // ICC Tournament Rule: If team is all out, the full quota of overs is charged for NRR calculation
    const teamAOversFaced = in1.isAllOut ? maxOvers : (Math.floor(in1.legalBalls / 6) + (in1.legalBalls % 6) / 6);
    const teamBOversFaced = in2.isAllOut ? maxOvers : (Math.floor(in2.legalBalls / 6) + (in2.legalBalls % 6) / 6);

    const teamARunRate = teamAOversFaced > 0 ? (in1.totalRuns / teamAOversFaced) : 0;
    const teamBRunRate = teamBOversFaced > 0 ? (in2.totalRuns / teamBOversFaced) : 0;

    const teamANrr = teamARunRate - teamBRunRate;
    const teamBNrr = teamBRunRate - teamARunRate;

    return {
      teamA: {
        name: match.teamA,
        runs: in1.totalRuns,
        wickets: in1.wickets,
        oversCharged: teamAOversFaced,
        oversFormatted: in1.oversFormatted,
        isAllOut: in1.isAllOut,
        runRate: teamARunRate.toFixed(2),
        nrrVal: teamANrr,
        nrrFormatted: (teamANrr > 0 ? '+' : '') + teamANrr.toFixed(3)
      },
      teamB: {
        name: match.teamB,
        runs: in2.totalRuns,
        wickets: in2.wickets,
        oversCharged: teamBOversFaced,
        oversFormatted: in2.oversFormatted,
        isAllOut: in2.isAllOut,
        runRate: teamBRunRate.toFixed(2),
        nrrVal: teamBNrr,
        nrrFormatted: (teamBNrr > 0 ? '+' : '') + teamBNrr.toFixed(3)
      }
    };
  }
};

