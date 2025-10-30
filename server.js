require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Error:', err));

// Models
const UserSchema = new mongoose.Schema({
  uid: { type: String, unique: true },
  username: String,
  piBalance: { type: Number, default: 0 }, // For demo; in real, query Pi
  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,
  wins: { type: Number, default: 0 },
  referrals: { type: Number, default: 0 },
  discountCodes: [String] // e.g., ['WIN10']
});
const User = mongoose.model('User', UserSchema);

const MatchSchema = new mongoose.Schema({
  matchId: String, // Unique from API
  sport: String, // 'nba' or 'football'
  home: String,
  away: String,
  date: Date,
  result: { type: String, default: 'pending' }, // 'home', 'away', 'draw'
  pool: { type: Number, default: 0 },
  entries: [{
    userId: String,
    prediction: String, // 'home', 'away', 'draw'
    entryFee: Number
  }]
});
const Match = mongoose.model('Match', MatchSchema);

// Fetch Live Matches (NBA + Football)
app.get('/matches', async (req, res) => {
  try {
    // NBA Games
    const nbaRes = await axios.get(`${process.env.NBA_API_BASE}/games?per_page=5`);
    const nbaMatches = nbaRes.data.data.map(game => ({
      matchId: `nba_${game.id}`,
      sport: 'nba',
      home: game.home_team.full_name,
      away: game.visitor_team.full_name,
      date: new Date(game.date)
    }));

    // Football Fixtures (e.g., Premier League, league ID 39)
    const footballRes = await axios.get(`${process.env.FOOTBALL_API_BASE}/fixtures?league=39&next=5`, {
      headers: { 'X-RapidAPI-Key': process.env.FOOTBALL_API_KEY }
    });
    const footballMatches = footballRes.data.response.map(fix => ({
      matchId: `fb_${fix.fixture.id}`,
      sport: 'football',
      home: fix.teams.home.name,
      away: fix.teams.away.name,
      date: new Date(fix.fixture.date)
    }));

    // Save new matches to DB if not exist
    for (let m of [...nbaMatches, ...footballMatches]) {
      await Match.findOneAndUpdate({ matchId: m.matchId }, m, { upsert: true });
    }

    const allMatches = await Match.find({ result: 'pending' }).sort({ date: 1 });
    res.json(allMatches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join Challenge
app.post('/join-challenge', async (req, res) => {
  const { userId, matchId, prediction, entryFee = 0.5 } = req.body;
  try {
    const user = await User.findOne({ uid: userId });
    if (!user || !user.isPremium) return res.status(403).json({ error: 'Premium required' });

    const match = await Match.findOne({ matchId });
    if (!match || match.result !== 'pending') return res.status(400).json({ error: 'Invalid match' });

    // In real: Use Pi.createPayment for entryFee (escrow)
    // Demo: Deduct from balance
    if (user.piBalance < entryFee) return res.status(400).json({ error: 'Insufficient balance' });
    user.piBalance -= entryFee;
    await user.save();

    match.pool += entryFee;
    match.entries.push({ userId, prediction, entryFee });
    await match.save();

    res.json({ success: true, pool: match.pool });

    // If enough entries, settle later via cron/job
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settle Match (Call this via cron or webhook when game ends)
async function settleMatch(matchId) {
  const match = await Match.findOne({ matchId });
  if (match.result !== 'pending') return;

  // Get real result
  let result;
  if (match.sport === 'nba') {
    const gameId = match.matchId.split('_')[1];
    const res = await axios.get(`${process.env.NBA_API_BASE}/games/${gameId}`);
    const game = res.data;
    result = game.home_team_score > game.visitor_team_score ? 'home' : 'away';
  } else {
    const fixId = match.matchId.split('_')[1];
    const res = await axios.get(`${process.env.FOOTBALL_API_BASE}/fixtures?id=${fixId}`, {
      headers: { 'X-RapidAPI-Key': process.env.FOOTBALL_API_KEY }
    });
    const goals = res.data.response[0].goals;
    if (goals.home > goals.away) result = 'home';
    else if (goals.home < goals.away) result = 'away';
    else result = 'draw';
  }

  match.result = result;
  await match.save();

  const winners = match.entries.filter(e => e.prediction === result);
  if (winners.length === 0) return; // Pool to house? Optional

  const houseCut = match.pool * 0.1; // 10% commission
  const payoutPerWinner = (match.pool - houseCut) / winners.length;

  for (let w of winners) {
    const user = await User.findOne({ uid: w.userId });
    user.piBalance += payoutPerWinner; // In real: Pi payment
    user.wins += 1;
    // Generate discount code for winner
    const discountCode = `WIN10_${user.wins}`;
    user.discountCodes.push(discountCode);
    await user.save();
    console.log(`Winner ${user.username} gets code: ${discountCode}`);
  }

  console.log(`House earned: ${houseCut} Pi from match ${matchId}`);
}

// Example: Manual settle endpoint for testing
app.post('/settle/:matchId', async (req, res) => {
  await settleMatch(req.params.matchId);
  res.json({ success: true });
});

// Subscribe (0.5 Pi or discounted)
app.post('/subscribe', async (req, res) => {
  let { userId, discountCode } = req.body;
  let amount = 0.5;
  if (discountCode && discountCode.startsWith('WIN10_')) amount = 0.45; // 10% off

  try {
    const user = await User.findOne({ uid: userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // In real: Pi.createPayment(amount)
    // Demo: Deduct
    if (user.piBalance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    user.piBalance -= amount;
    user.isPremium = true;
    user.premiumUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    if (discountCode) user.discountCodes = user.discountCodes.filter(c => c !== discountCode); // Use once
    await user.save();

    console.log(`Subscribed! You earned ${amount} Pi`);
    res.json({ success: true, premiumUntil: user.premiumUntil });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approval/Completion for Pi Payments (Implement as per Pi SDK)
app.post('/approve-payment', (req, res) => {
  const { paymentId } = req.body;
  // Pi.approvePayment(paymentId)
  res.json({ success: true });
});

app.post('/complete-payment', async (req, res) => {
  const { paymentId, txid, userId, type } = req.body; // type: 'sub' or 'entry'
  // Handle based on type
  res.json({ success: true });
});

// Leaderboard
app.get('/leaderboard', async (req, res) => {
  const top = await User.find().sort({ wins: -1 }).limit(10);
  res.json(top.map(u => ({ username: u.username, wins: u.wins })));
});

// Get User Info
app.get('/user/:uid', async (req, res) => {
  const user = await User.findOne({ uid: req.params.uid });
  res.json(user);
});

// Refer (Bonus 0.1 Pi)
app.post('/refer', async (req, res) => {
  const { referrerId, newUserId } = req.body;
  const referrer = await User.findOne({ uid: referrerId });
  referrer.referrals += 1;
  referrer.piBalance += 0.1;
  await referrer.save();
  res.json({ success: true });
});

app.listen(process.env.PORT, () => {
  console.log(`PiPredict running at http://localhost:${process.env.PORT}`);
});