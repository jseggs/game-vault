#!/usr/bin/env node
/**
 * A stand-in for bgg-service/Code.gs, for developing the app without a BGG
 * token. It answers the same requests with a few canned games.
 *
 *   node tools/fake-bgg-service.js      serve on http://localhost:4176/exec
 *
 * In the app (on localhost only), point at it from the browser console:
 *   localStorage.setItem('gvc-dev-bgg', 'http://localhost:4176/exec'); location.reload();
 *
 * Usernames: "empty" owns nothing, "nobody" is unknown, anything else owns
 * every canned game. The first collection request for a name answers
 * "pending", as BoardGameGeek does.
 */
const http = require('http');

const game = (bggId, name, year, players, community, bestAt, solo, age, score, category, expansion = false) => ({
  bggId: String(bggId), name, year: String(year), expansion, players, playersCommunity: community, bestAt, solo, age, score, category,
  url: 'https://boardgamegeek.com/boardgame/' + bggId, thumbnail: '', image: ''
});
const GAMES = [
  game(230802, 'Azul', 2017, '2-4', '2-4', '2', 'No', '8+', '7.7', 'Abstract Strategy, Tile Placement'),
  game(266192, 'Wingspan', 2019, '1-5', '1-4', '3', 'Yes', '10+', '8.0', 'Animals, Card Game'),
  game(290448, 'Wingspan: European Expansion', 2019, '1-5', '1-4', '3', 'Yes', '10+', '8.4', 'Animals, Expansion for Base-game', true),
  game(167791, 'Terraforming Mars', 2016, '1-5', '1-4', '3', 'Yes', '12+', '8.3', 'Economic, Science Fiction'),
  game(174430, 'Gloomhaven', 2017, '1-4', '1-4', '3', 'Yes', '14+', '8.5', 'Adventure, Fantasy'),
  game(13, 'CATAN', 1995, '3-4', '3-4', '4', 'No', '10+', '7.1', 'Economic, Negotiation'),
  ...Array.from({length: 24}, (_, i) => game(900000 + i, 'Stand-in Game ' + (i + 1), 2020, '2-4', '2-4', '3', 'No', '10+', '7.0', 'Testing'))
];
const seenUsers = new Set();

function answer(params) {
  if (params.action === 'search') {
    const q = String(params.q || '').trim().toLowerCase();
    if (q.length < 2) return {status: 'error', code: 'bad_request', message: 'Type at least two letters to search.'};
    return {status: 'ok', results: GAMES.filter(g => g.name.toLowerCase().includes(q)).slice(0, 10)
      .map(g => ({id: g.bggId, name: g.name, year: g.year, expansion: g.expansion}))};
  }
  if (params.action === 'thing') {
    const ids = String(params.ids || '').split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length || ids.length > 20) return {status: 'error', code: 'bad_request', message: 'Send 1 to 20 BGG IDs.'};
    const found = ids.map(id => GAMES.find(g => g.bggId === id)).filter(Boolean);
    return {status: 'ok', games: found, notFound: ids.filter(id => !found.some(g => g.bggId === id))};
  }
  if (params.action === 'collection') {
    const user = String(params.user || '').trim();
    if (user.toLowerCase() === 'nobody') return {status: 'error', code: 'not_found', message: 'BoardGameGeek does not know that username.'};
    if (!seenUsers.has(user)) { seenUsers.add(user); return {status: 'pending', message: 'Preparing.'}; }
    const items = user.toLowerCase() === 'empty' ? [] : GAMES.map(g => ({id: g.bggId, name: g.name, year: g.year, expansion: g.expansion}));
    return {status: 'ok', user, items};
  }
  return {status: 'ok', name: 'Game Vault BGG lookup (stand-in)', version: 1};
}

const port = Number(process.env.PORT || 4176);
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(answer(Object.fromEntries(url.searchParams))));
}).listen(port, '127.0.0.1', () => console.log(`Stand-in BGG lookup at http://localhost:${port}/exec`));
