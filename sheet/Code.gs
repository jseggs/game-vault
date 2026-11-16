/**
 * Game Vault: sheet connection.
 *
 * This script lives inside your copy of the Game Vault sheet and is the only
 * thing the app talks to. It reads and writes this spreadsheet and nothing else.
 *
 * @OnlyCurrentDoc
 *
 * How access works
 * - Deploying this script as a web app gives you a web app URL.
 * - The first device that connects with that URL becomes the owner and is
 *   given the owner key. After that, the URL alone does nothing.
 * - Every later request must carry a key:
 *     owner key   everything, including prices and notes.
 *     family key  the collection plus logging plays and ratings. Prices and
 *                 notes are never sent to a family device, and a family
 *                 device cannot add games.
 * - Keys are kept in this script's private properties, never in the sheet.
 * - "Game Vault > Reset access keys" in the sheet menu revokes every device.
 */

var SCRIPT_VERSION = 2;
var GAMES_SHEET = 'Games';
var PLAYS_SHEET = 'Plays';
var PLAYERS_SHEET = 'Players';
var STATS_SHEET = 'Stats'; // optional
var PLAYS_HEADERS = ['Date', 'Game', 'Winner', 'Notes', 'P1 Rating', 'P2 Rating', 'Play ID'];
// Never sent to family devices.
var PRIVATE_COLUMNS = ['Price Paid', 'Notes'];
// The only Games columns the app may fill in when it adds a game or imports a
// BoardGameGeek collection. Everything else in a row stays yours.
var GAME_COLUMNS = ['Game', 'Shelf', 'Expansion', 'Players', 'Players (BGG)', 'Best At', 'Solo', 'Age',
  'BGG Score', 'BGG Category', 'BGG ID', 'BGG URL', 'BGG Thumbnail', 'BGG Image'];
var MAX_GAMES_PER_SAVE = 100;

// ── Sheet menu ──────────────────────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Game Vault')
    .addItem('How to connect the app', 'showConnectHelp')
    .addItem('Reset access keys', 'resetAccessKeys')
    .addToUi();
}

function showConnectHelp() {
  var claimed = Boolean(PropertiesService.getScriptProperties().getProperty('OWNER_KEY'));
  var message = claimed
    ? 'This sheet is already connected to an owner device.\n\n' +
      'To add another phone or computer, open Game Vault on the connected device, go to Settings, and copy an invite link.\n\n' +
      'Lost access? Use Game Vault > Reset access keys, then connect again with your web app URL.'
    : '1. Open Extensions > Apps Script.\n' +
      '2. Click Deploy > New deployment. Choose type "Web app".\n' +
      '3. Set "Execute as" to Me and "Who has access" to Anyone. Click Deploy and approve access.\n' +
      '4. Copy the Web app URL.\n' +
      '5. In the Game Vault app, open Settings, paste the URL, and tap Connect.\n\n' +
      'The first device to connect becomes the owner.';
  SpreadsheetApp.getUi().alert('Connect Game Vault', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

function resetAccessKeys() {
  var ui = SpreadsheetApp.getUi();
  var answer = ui.alert(
    'Reset access keys?',
    'Every connected device, including yours, will stop working until it is connected again. Your games and plays are not changed.',
    ui.ButtonSet.OK_CANCEL
  );
  if (answer !== ui.Button.OK) return;
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('OWNER_KEY');
  props.deleteProperty('FAMILY_KEY');
  ui.alert('Access keys reset. Connect again by pasting your web app URL into the app.');
}

// ── Web app ─────────────────────────────────────────────────

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    if (params.action === 'claim') return json_(claim_());
    if (params.action === 'data') {
      var role = roleFor_(params.key);
      if (!role) return json_(denied_());
      return json_(readAll_(role));
    }
    return json_({status: 'ok', app: 'Game Vault', version: SCRIPT_VERSION});
  } catch (error) {
    return json_({status: 'error', message: String(error && error.message || error)});
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var role = roleFor_(data.key);
    if (!role) return json_(denied_());
    if (data.action === 'saveGames' && role !== 'owner') {
      return json_({status: 'error', code: 'owner_only', message: 'Only the owner can add games.'});
    }
    lock.waitLock(20000);
    var result = {status: 'ok'};
    if (data.action === 'add') addPlay_(data, result);
    else if (data.action === 'delete') deletePlay_(data, result);
    else if (data.action === 'rate') rateGame_(data, result);
    else if (data.action === 'exclude') setExcluded_(data, result);
    else if (data.action === 'saveGames') saveGames_(data, result);
    else if (data.action !== 'ping') result = {status: 'error', message: 'Unknown action.'};
    return json_(result);
  } catch (error) {
    return json_({status: 'error', message: String(error && error.message || error)});
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function denied_() {
  return {status: 'error', code: 'denied', message: 'This connection has no valid access key. Open a new invite link.'};
}

// ── Access keys ─────────────────────────────────────────────

function newKey_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

/** The first caller becomes the owner. Later calls are refused. */
function claim_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('OWNER_KEY')) {
      return {status: 'error', code: 'claimed', message: 'This sheet already has an owner. Ask them for an invite link, or use Game Vault > Reset access keys in the sheet.'};
    }
    var ownerKey = newKey_();
    props.setProperty('OWNER_KEY', ownerKey);
    props.setProperty('FAMILY_KEY', newKey_());
    return {status: 'ok', ownerKey: ownerKey};
  } finally {
    lock.releaseLock();
  }
}

function roleFor_(key) {
  var given = String(key || '');
  if (!given) return '';
  var props = PropertiesService.getScriptProperties();
  if (given === props.getProperty('OWNER_KEY')) return 'owner';
  if (given === props.getProperty('FAMILY_KEY')) return 'family';
  return '';
}

// ── Reading ─────────────────────────────────────────────────

function readAll_(role) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var owner = role === 'owner';
  var result = {status: 'ok', version: SCRIPT_VERSION, role: role};
  result.games = rows_(ss.getSheetByName(GAMES_SHEET), owner ? [] : PRIVATE_COLUMNS);
  result.plays = rows_(ss.getSheetByName(PLAYS_SHEET), owner ? [] : ['Notes']);
  result.players = rows_(ss.getSheetByName(PLAYERS_SHEET), []);
  result.stats = owner ? rows_(ss.getSheetByName(STATS_SHEET), []) : [];
  if (owner) result.familyKey = PropertiesService.getScriptProperties().getProperty('FAMILY_KEY');
  return result;
}

/** Rows as objects keyed by trimmed header, with values as displayed in the sheet. */
function rows_(sheet, omitColumns) {
  if (!sheet) return [];
  var values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];
  var headers = values[0].map(function (header) { return String(header).trim(); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = {};
    var hasValue = false;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c] || omitColumns.indexOf(headers[c]) >= 0) continue;
      var cell = String(values[r][c] == null ? '' : values[r][c]).trim();
      row[headers[c]] = cell;
      if (cell) hasValue = true;
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

// ── Writing ─────────────────────────────────────────────────

/** Sheet contents plus a header lookup. Creates missing headers when asked. */
function table_(sheet, requiredHeaders) {
  var values = sheet.getDataRange().getValues();
  var headers = (values[0] || []).map(function (header) { return String(header).trim(); });
  (requiredHeaders || []).forEach(function (name) {
    if (headers.indexOf(name) < 0) {
      headers.push(name);
      sheet.getRange(1, headers.length).setValue(name);
    }
  });
  return {
    values: values,
    headers: headers,
    col: function (name) { return headers.indexOf(name); } // 0-based, -1 when absent
  };
}

function text_(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function findGameRow_(table, game) {
  var nameCol = table.col('Game');
  if (nameCol < 0) return -1;
  for (var r = 1; r < table.values.length; r++) {
    if (text_(table.values[r][nameCol]) === text_(game)) return r;
  }
  return -1;
}

/**
 * Text from the app, made safe to write into a cell. A leading apostrophe makes
 * Sheets treat the value as plain text, so nothing sent by a device can run as
 * a formula.
 */
function cellText_(value) {
  var text = String(value == null ? '' : value).slice(0, 2000);
  return /^[=+@]/.test(text) ? "'" + text : text;
}

/** Like cellText_, and also keeps a player range such as "2-4" from being read as a date. */
function gameCell_(value) {
  var text = cellText_(value).trim();
  return /^\d+\s*[-\/.]\s*\d+$/.test(text) ? "'" + text : text;
}

function numberOrBlank_(value) {
  var number = parseFloat(value);
  return isNaN(number) ? '' : number;
}

function addPlay_(data, result) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plays = ss.getSheetByName(PLAYS_SHEET) || ss.insertSheet(PLAYS_SHEET);
  var table = table_(plays, PLAYS_HEADERS);
  var playId = cellText_(data.id) || Utilities.getUuid();
  var record = {
    'Date': cellText_(data.date),
    'Game': cellText_(data.game),
    'Winner': cellText_(data.winner),
    'Notes': cellText_(data.notes),
    'P1 Rating': numberOrBlank_(data.p1Rat),
    'P2 Rating': numberOrBlank_(data.p2Rat),
    'Play ID': playId
  };
  plays.appendRow(table.headers.map(function (header) {
    return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
  }));
  result.playId = playId;

  var games = ss.getSheetByName(GAMES_SHEET);
  if (!games) return;
  var gameTable = table_(games, []);
  var row = findGameRow_(gameTable, data.game);
  if (row < 0) return;
  setCell_(games, gameTable, row, 'Played', 'Yes', data.markPlayed === true);
  setCell_(games, gameTable, row, 'P1 Rating', numberOrBlank_(data.p1Rat), numberOrBlank_(data.p1Rat) !== '');
  setCell_(games, gameTable, row, 'P2 Rating', numberOrBlank_(data.p2Rat), numberOrBlank_(data.p2Rat) !== '');
}

function setCell_(sheet, table, row, header, value, when) {
  var col = table.col(header);
  if (when && col >= 0) sheet.getRange(row + 1, col + 1).setValue(value);
}

function dateText_(value, timeZone) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, timeZone, 'yyyy-MM-dd');
  var text = String(value == null ? '' : value).trim();
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) return slash[3] + '-' + ('0' + slash[1]).slice(-2) + '-' + ('0' + slash[2]).slice(-2);
  return text;
}

function deletePlay_(data, result) {
  result.playDeleted = false;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plays = ss.getSheetByName(PLAYS_SHEET);
  if (!plays) { result.message = 'There is no Plays sheet.'; return; }
  var table = table_(plays, []);
  var idCol = table.col('Play ID');
  var timeZone = ss.getSpreadsheetTimeZone();
  for (var r = table.values.length - 1; r >= 1; r--) {
    var values = table.values[r];
    var byId = data.id && idCol >= 0 && text_(values[idCol]) === text_(data.id);
    // Rows typed by hand have no Play ID: fall back to date + game + winner.
    var byContent = !data.id &&
      dateText_(values[table.col('Date')], timeZone) === dateText_(data.date, timeZone) &&
      text_(values[table.col('Game')]) === text_(data.game) &&
      text_(values[table.col('Winner')]) === text_(data.winner);
    if (byId || byContent) {
      plays.deleteRow(r + 1);
      result.playDeleted = true;
      return;
    }
  }
  result.message = 'No matching play was found in the Plays sheet.';
}

function rateGame_(data, result) {
  result.ratingsUpdated = false;
  var games = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GAMES_SHEET);
  if (!games) return;
  var table = table_(games, ['P1 Rating', 'P2 Rating']);
  var row = findGameRow_(table, data.game);
  if (row < 0) { result.message = 'That game was not found in the Games sheet.'; return; }
  setCell_(games, table, row, 'P1 Rating', numberOrBlank_(data.p1Rat), numberOrBlank_(data.p1Rat) !== '');
  setCell_(games, table, row, 'P2 Rating', numberOrBlank_(data.p2Rat), numberOrBlank_(data.p2Rat) !== '');
  result.ratingsUpdated = true;
}

function setExcluded_(data, result) {
  var games = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GAMES_SHEET);
  if (!games) return;
  var table = table_(games, ['Excluded']);
  var row = findGameRow_(table, data.game);
  if (row < 0) return;
  setCell_(games, table, row, 'Excluded', data.excluded ? 1 : '', true);
  result.excluded = Boolean(data.excluded);
}

/**
 * Adds games, or fills in missing details on games already listed. Owner only.
 * A game matches an existing row by BGG ID first, then by name. On an existing
 * row only empty cells are filled: nothing you typed is ever overwritten.
 */
function saveGames_(data, result) {
  var incoming = Array.isArray(data.games) ? data.games : [];
  if (incoming.length > MAX_GAMES_PER_SAVE) {
    result.status = 'error';
    result.message = 'Send at most ' + MAX_GAMES_PER_SAVE + ' games at a time.';
    return;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var games = ss.getSheetByName(GAMES_SHEET) || ss.insertSheet(GAMES_SHEET);
  var table = table_(games, GAME_COLUMNS);
  var width = table.headers.length;
  var nameCol = table.col('Game');
  var idCol = table.col('BGG ID');

  var rowById = {};
  var rowByName = {};
  var lastUsed = 0; // last row that holds a game, counting the header as row 0
  for (var r = 1; r < table.values.length; r++) {
    var name = text_(table.values[r][nameCol]);
    if (!name) continue;
    lastUsed = r;
    if (!(name in rowByName)) rowByName[name] = r;
    var id = text_(table.values[r][idCol]);
    if (id && !(id in rowById)) rowById[id] = r;
  }

  var added = [];
  var updated = 0;
  var unchanged = 0;
  incoming.forEach(function (game) {
    var title = String((game && game['Game']) || '').trim();
    if (!title) return;
    var bggId = text_(game['BGG ID']);
    var existing = bggId && rowById[bggId] != null ? rowById[bggId] : rowByName[text_(title)];
    if (existing == null) {
      var row = [];
      for (var c = 0; c < width; c++) {
        var header = table.headers[c];
        row.push(GAME_COLUMNS.indexOf(header) >= 0 ? gameCell_(game[header]) : '');
      }
      added.push(row);
      rowByName[text_(title)] = -1; // a repeat inside this batch is skipped below
      if (bggId) rowById[bggId] = -1;
      return;
    }
    if (existing < 0) { unchanged++; return; }
    // Write only the cells that were empty. Untouched cells are never rewritten,
    // so nothing already in the row can change or be re-read as another type.
    var filled = {};
    GAME_COLUMNS.forEach(function (header) {
      var col = table.col(header);
      var value = gameCell_(game[header]);
      if (header === 'Game' || !value) return;
      var now = table.values[existing][col];
      if (String(now == null ? '' : now).trim() !== '') return;
      filled[col] = value;
      table.values[existing][col] = value; // a repeat inside this batch sees it as filled
    });
    var cols = Object.keys(filled).map(Number).sort(function (x, y) { return x - y; });
    if (!cols.length) { unchanged++; return; }
    // Neighbouring cells go in one write.
    for (var start = 0; start < cols.length;) {
      var end = start;
      while (end + 1 < cols.length && cols[end + 1] === cols[end] + 1) end++;
      var run = cols.slice(start, end + 1).map(function (col) { return filled[col]; });
      games.getRange(existing + 1, cols[start] + 1, 1, run.length).setValues([run]);
      start = end + 1;
    }
    updated++;
  });

  if (added.length) games.getRange(lastUsed + 2, 1, added.length, width).setValues(added);
  result.added = added.length;
  result.updated = updated;
  result.unchanged = unchanged;
}
