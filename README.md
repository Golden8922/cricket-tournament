# College Cricket Tournament App 🏏

[![Live on Vercel](https://img.shields.io/badge/Vercel-Live_App-black?logo=vercel)](https://sitarekcirc.vercel.app)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Golden8922%2Fcricket--tournament-blue?logo=github)](https://github.com/Golden8922/cricket-tournament)

- 🌐 **Live Website**: [https://sitarekcirc.vercel.app](https://sitarekcirc.vercel.app)
- 📦 **GitHub Repository**: [https://github.com/Golden8922/cricket-tournament](https://github.com/Golden8922/cricket-tournament)

A mobile-first Progressive Web App (PWA) designed to manage an entire college cricket tournament with live scoring, squads, and points table:
- **4 Official Tournament Squads** (Sitare Strikers, Falcons, Dominators, Power Smashers) preloaded with 55 college players formatted by year (e.g. `Ritik 3`, `Golden 2`, `Prem 3`, `Aryan 3`)
- **Direct Team & Player Management**: Umpires and Admins can add, edit, reassign, or rename any team or player anytime
- **Points Table & Net Run Rate (NRR)**: Official ICC formula standings tracking P, W, L, T, Pts, Runs/Overs For & Against, and ±NRR
- **Ball-by-Ball Live Scoring Console** for Umpires (large $\ge 64\text{px}$ touch targets, Screen Wake Lock, haptics & 1-tap Undo)
- **Public Live Scoreboard** updating in real time with ball reel and 1-tap WhatsApp scorecard sharing
- **Permanent Match History & Replay Analytics** with fresh tournament start ($0$ matches played)

---

## 🚀 Quick Start (Local Run)

### Method 1: Double-click Windows Script
Simply double-click [`start.bat`](file:///c:/Users/GOLDEN%20YADAV/Desktop/Cricket/start.bat). It automatically detects Python or Node.js and opens the app at `http://localhost:8080`.

### Method 2: Command Line
```powershell
# Using Python
python -m http.server 8080

# Or using Node
npx serve -l 8080 .
```
Then open `http://localhost:8080` in your phone or browser.

---

## 👥 Roles & Access Control

| Role | Access | How to sign in |
| :--- | :--- | :--- |
| **Spectator / Student** | View live score, points table, squad rosters, match history | Public, no login required |
| **Match Umpire** | Score balls, undo mistakes, finish matches, edit teams and players | Tap **Staff Login** → name, **⚡ Match Umpire**, umpire password |
| **Tournament Admin** | Same as umpire, with its own password | Tap **Staff Login** → name, **👑 Tournament Admin**, admin password |

Passwords are checked on the server (`/api/login`), which returns a signed token that expires after 24 hours. The data API (`/api/sync`) rejects every write that does not carry a valid token, so only signed-in staff can change tournament data.

### Required Vercel environment variables

| Variable | Required | Purpose |
| :--- | :--- | :--- |
| `BLOB_READ_WRITE_TOKEN` | yes | Added automatically when a Vercel Blob store is connected |
| `STAFF_PASSWORD` | recommended | Umpire password. If unset, the server falls back to the legacy password in `api/login.js`. Set it to change the password |
| `ADMIN_PASSWORD` | no | Admin password (defaults to `STAFF_PASSWORD`) |
| `AUTH_SECRET` | no | Token signing key (defaults to `BLOB_READ_WRITE_TOKEN`) |

Set them in Vercel → Project → Settings → Environment Variables, then redeploy. For local testing of the API use `vercel dev` with a `.env.local` file (git-ignored).

### Tests

```bash
npm test
```

---

## 🛡️ Preloaded Official Squads (55 Players)

All 55 players from the official college sheets are loaded with names formatted as `[First Name] [Year]` (e.g., `Ritik 3`, `Golden 2`, `Manish 3`):

1. **Sitare Strikers** (14 Players): Ritik 3 (C), Harsh 3 (VC), Sachin 3, Shivam 3, Prince 3, Ayush 3, Gaurav 3, Sumit 2, Ankit 2, Rishabh 2, Nitin 2, Abhishek 2, Sonu 2, Ashish K 1
2. **Falcons** (13 Players): Aryan 3 (C), Anshu 3 (VC), Aman 3, Himanshu 3, Piyush 3, Abhi 3, Golden 2, Rohit 2, Vikas 2, Chandan 2, Ashish J 2, Saurabh 2, Aditya 1
3. **Dominators** (14 Players): Manish 3 (C), Prince 3 (VC), Vivek 3, Aditya 3, Rahul 3, Vishal 3, Satyam 2, Nikhil 2, Deepak 2, Piyush K 2, Aryan K 2, Sandeep 2, Anshuman 1, Kunal 1
4. **Power Smashers** (14 Players): Prem 3 (C), Priyanshu 3 (VC), Sumit 3, Vikash 3, Ashutosh 3, Raj 3, Sudhir 3, Akash 2, Suraj 2, Amit 2, Abhishek R 2, Mayank 2, Shailesh 1, Harshit 1

---

## 📊 Points Table & Net Run Rate (ICC Standard)

The Points Table calculates standings using the official International Cricket Council (ICC) NRR formula:
$$\text{NRR} = \left(\frac{\text{Total Runs Scored}}{\text{Total Overs Faced}}\right) - \left(\frac{\text{Total Runs Conceded}}{\text{Total Overs Bowled}}\right)$$

- **All Out Rule**: If a team is bowled out (All Out) before completing their allotted overs, the calculation uses the full match quota (e.g. 5.0 overs) rather than the premature balls faced.
- **Points Awarded**: 2 points for a Win, 1 point for a Tie, 0 points for a Loss.
- **Rankings**: Sorted by Points (DESC), then NRR (DESC), then Total Wins (DESC).

---

## ⚙️ Key Engine Features

1. **Automatic Post-Match NRR Calculation**:
   Immediately upon finishing a match, the engine calculates the match Net Run Rate impact for both teams and updates the official tournament standings table according to ICC standards.
2. **Ball-by-Ball Keypad**:
   Direct taps for Dots, 1, 2, 3, 4, 6 and modifier toggles (Wide, No-Ball, Bye, Leg Bye, Wicket).
3. **Screen Wake Lock & Haptics**:
   Keeps phone screen on under outdoor sunlight and delivers subtle tactile vibrations.
4. **Instant 1-Tap Undo**:
   Umpires can instantly undo mistaken deliveries with full state restoration.
5. **WhatsApp Scorecard Sharing**:
   One click exports clean Unicode scorecards directly to WhatsApp groups.

---

## 🌐 Free Hosting Options

1. **Netlify Drop**: Drag and drop the tournament folder directly onto [app.netlify.com/drop](https://app.netlify.com/drop).
2. **GitHub Pages**: Push repo to GitHub and enable Pages in repository settings.
3. **Firebase Hosting**:
   ```bash
   firebase login
   firebase init hosting
   firebase deploy --only hosting
   ```
