/**
 * Game Vault: BoardGameGeek lookup service.
 *
 * A small web app the maintainer hosts once. The Game Vault app calls it from
 * the browser to search BoardGameGeek, read game details, and list a BGG
 * user's owned games. It holds the maintainer's BGG API token so that people
 * who set up their own Game Vault do not need one.
 *
 * What it receives: a search phrase, BGG IDs, or a BGG username. Nothing else.
 * It never sees anyone's Google Sheet, access keys, plays, ratings, or prices.
 *
 * Requests (all GET, all answered as JSON):
 *   ?action=search&q=azul             up to 10 candidates: id, name, year, expansion
 *   ?action=thing&ids=230802,13       details for up to 20 BGG IDs
 *   ?action=collection&user=NAME      games NAME owns. May answer
 *                                     {status:"pending"}: ask again in a few seconds.
 *
 * Script properties (Project Settings > Script properties):
 *   BGG_API_TOKEN   required. The maintainer's BoardGameGeek API token.
 *   DAILY_LIMIT     optional. Most BGG requests per UTC day. Default 8000.
 */

var SERVICE_VERSION = 1;
var BGG_API_ROOT = 'https://boardgamegeek.com/xmlapi2';
var MAX_IDS = 20;
var MAX_SEARCH_RESULTS = 10;
var THING_CACHE_SECONDS = 21600;      // 6 hours, the longest Apps Script allows
var SEARCH_CACHE_SECONDS = 21600;
var COLLECTION_CACHE_SECONDS = 600;   // collections change, so keep these briefly
var MIN_GAP_MS = 1300;                // pause between BGG requests, across all callers
var DEFAULT_DAILY_LIMIT = 8000;

function doGet(e) {
  var params = (e && e.parameter) || {};
  try {
    if (params.action === 'search') return json_(search_(params.q));
    if (params.action === 'thing') return json_(things_(params.ids));
    if (params.action === 'collection') return json_(collection_(params.user));
    return json_({
      status: 'ok',
      name: 'Game Vault BGG lookup',
      version: SERVICE_VERSION,
      privacy: 'Receives a search phrase, BGG IDs, or a BGG username. Never receives sheet data.'
    });
  } catch (error) {
    return json_({status: 'error', code: error.code || 'error', message: String(error && error.message || error)});
  }
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

// ── Search ────────────────────────────────────────────────────────────────

function search_(query) {
  var text = String(query || '').trim().slice(0, 80);
  if (text.length < 2) throw fail_('bad_request', 'Type at least two letters to search.');
  var cache = CacheService.getScriptCache();
  var cacheKey = 's:' + digest_(text.toLowerCase());
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var root = fetchBgg_('/search', {query: text, type: 'boardgame,boardgameexpansion'}).getRootElement();
  var byId = {};
  var wanted = normalizeTitle_(text);
  var results = [];
  root.getChildren('item').forEach(function (item) {
    var id = item.getAttribute('id').getValue();
    var isExpansion = item.getAttribute('type').getValue() === 'boardgameexpansion';
    // BGG lists an expansion twice, once as a game and once as an expansion.
    // Keep one entry per ID and remember that it is an expansion.
    if (byId[id]) {
      if (isExpansion) byId[id].expansion = true;
      return;
    }
    var name = item.getChild('name');
    var year = item.getChild('yearpublished');
    if (!name) return;
    byId[id] = {
      id: id,
      name: name.getAttribute('value').getValue(),
      year: year ? year.getAttribute('value').getValue() : '',
      expansion: isExpansion
    };
    results.push(byId[id]);
  });
  results = results.map(function (result) {
    result.score = similarity_(wanted, normalizeTitle_(result.name)) - (result.expansion ? 0.15 : 0);
    return result;
  }).sort(function (a, b) {
    return b.score - a.score || Number(b.year || 0) - Number(a.year || 0);
  }).slice(0, MAX_SEARCH_RESULTS).map(function (result) {
    delete result.score;
    return result;
  });

  var answer = {status: 'ok', results: results};
  putCache_(cache, cacheKey, answer, SEARCH_CACHE_SECONDS);
  return answer;
}

// ── Game details ──────────────────────────────────────────────────────────

function things_(idsText) {
  var ids = String(idsText || '').split(',').map(function (id) { return id.trim(); }).filter(Boolean);
  ids = ids.filter(function (id, index) { return ids.indexOf(id) === index; });
  if (!ids.length) throw fail_('bad_request', 'Send one or more BGG IDs.');
  if (ids.length > MAX_IDS) throw fail_('bad_request', 'Send at most ' + MAX_IDS + ' BGG IDs at a time.');
  ids.forEach(function (id) {
    if (!/^\d{1,9}$/.test(id)) throw fail_('bad_request', 'BGG IDs contain only numbers.');
  });

  var cache = CacheService.getScriptCache();
  var cached = cache.getAll(ids.map(function (id) { return 't:' + id; }));
  var games = {};
  var missing = [];
  ids.forEach(function (id) {
    if (cached['t:' + id]) games[id] = JSON.parse(cached['t:' + id]);
    else missing.push(id);
  });

  if (missing.length) {
    var root = fetchBgg_('/thing', {id: missing.join(','), stats: 1}).getRootElement();
    var fresh = {};
    root.getChildren('item').forEach(function (item) {
      var game = extractThing_(item);
      games[game.bggId] = game;
      fresh['t:' + game.bggId] = JSON.stringify(game);
    });
    if (Object.keys(fresh).length) {
      try { cache.putAll(fresh, THING_CACHE_SECONDS); } catch (ignored) {}
    }
  }

  return {
    status: 'ok',
    games: ids.map(function (id) { return games[id]; }).filter(Boolean),
    notFound: ids.filter(function (id) { return !games[id]; })
  };
}

function extractThing_(thing) {
  var id = thing.getAttribute('id').getValue();
  var names = thing.getChildren('name');
  var primary = names.filter(function (name) {
    return name.getAttribute('type') && name.getAttribute('type').getValue() === 'primary';
  })[0] || names[0];
  var minPlayers = Number(childValue_(thing, 'minplayers')) || 0;
  var maxPlayers = Number(childValue_(thing, 'maxplayers')) || 0;
  var poll = playerPoll_(thing);
  var average = descendantAttribute_(thing, ['statistics', 'ratings', 'average'], 'value');
  var minAge = Number(childValue_(thing, 'minage')) || 0;
  return {
    bggId: id,
    name: primary ? primary.getAttribute('value').getValue() : '',
    year: childValue_(thing, 'yearpublished'),
    expansion: thing.getAttribute('type').getValue() === 'boardgameexpansion',
    players: formatRange_(minPlayers, maxPlayers),
    playersCommunity: poll.summary,
    bestAt: poll.bestAt,
    solo: poll.goodSolo,
    age: minAge ? minAge + '+' : '',
    score: average && !isNaN(Number(average)) && Number(average) > 0 ? Number(average).toFixed(1) : '',
    category: links_(thing, ['boardgamecategory', 'boardgamemechanic']).slice(0, 4).join(', '),
    url: 'https://boardgamegeek.com/boardgame/' + id,
    thumbnail: childText_(thing, 'thumbnail'),
    image: childText_(thing, 'image')
  };
}

/** Reads the "suggested number of players" poll into a range, a best count, and a solo flag. */
function playerPoll_(thing) {
  var polls = thing.getChildren('poll').filter(function (node) {
    return node.getAttribute('name') && node.getAttribute('name').getValue() === 'suggested_numplayers';
  });
  if (!polls.length) return {summary: '', bestAt: '', goodSolo: 'No'};
  var rows = polls[0].getChildren('results').map(function (results) {
    var votes = {};
    results.getChildren('result').forEach(function (result) {
      votes[result.getAttribute('value').getValue()] = Number(result.getAttribute('numvotes').getValue() || 0);
    });
    return {
      count: results.getAttribute('numplayers').getValue(),
      best: votes['Best'] || 0,
      recommended: (votes['Recommended'] || 0) + (votes['Best'] || 0),
      notRecommended: votes['Not Recommended'] || 0
    };
  }).filter(function (row) { return /^\d+$/.test(row.count); });
  var supported = rows.filter(function (row) { return row.recommended > row.notRecommended; })
    .map(function (row) { return Number(row.count); })
    .sort(function (a, b) { return a - b; });
  var top = rows.slice().sort(function (a, b) { return b.best - a.best; })[0];
  var bestAt = top && top.best > 0
    ? rows.filter(function (row) { return row.best === top.best; }).map(function (row) { return row.count; }).join(', ')
    : '';
  var goodSolo = rows.some(function (row) { return row.count === '1' && row.recommended > row.notRecommended; }) ? 'Yes' : 'No';
  return {summary: runs_(supported), bestAt: bestAt, goodSolo: goodSolo};
}

/** [1,2,3,5] becomes "1-3, 5". */
function runs_(counts) {
  if (!counts.length) return '';
  var out = [];
  var start = counts[0];
  var previous = counts[0];
  for (var index = 1; index <= counts.length; index++) {
    if (index < counts.length && counts[index] === previous + 1) {
      previous = counts[index];
      continue;
    }
    out.push(start === previous ? String(start) : start + '-' + previous);
    start = previous = counts[index];
  }
  return out.join(', ');
}

// ── Collection ────────────────────────────────────────────────────────────

function collection_(user) {
  var name = String(user || '').trim();
  if (!/^[A-Za-z0-9_ .\-]{2,40}$/.test(name)) throw fail_('bad_request', 'That does not look like a BGG username.');
  var cache = CacheService.getScriptCache();
  var cacheKey = 'c:' + digest_(name.toLowerCase());
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // BGG lists expansions only when asked for them separately.
  var items = [];
  var parts = [
    {params: {username: name, own: 1, excludesubtype: 'boardgameexpansion'}, expansion: false},
    {params: {username: name, own: 1, subtype: 'boardgameexpansion'}, expansion: true}
  ];
  for (var p = 0; p < parts.length; p++) {
    var document = fetchBgg_('/collection', parts[p].params, true);
    if (!document) return {status: 'pending', message: 'BoardGameGeek is preparing this collection. Trying again shortly.'};
    var root = document.getRootElement();
    if (root.getName() === 'errors') throw fail_('not_found', 'BoardGameGeek does not know that username.');
    root.getChildren('item').forEach(function (item) {
      var title = item.getChild('name');
      var year = item.getChild('yearpublished');
      items.push({
        id: item.getAttribute('objectid').getValue(),
        name: title ? title.getText() : '',
        year: year ? year.getText() : '',
        expansion: parts[p].expansion
      });
    });
  }

  var answer = {status: 'ok', user: name, items: items};
  putCache_(cache, cacheKey, answer, COLLECTION_CACHE_SECONDS);
  return answer;
}

// ── Talking to BoardGameGeek ──────────────────────────────────────────────

/**
 * One request to BGG, spaced out from every other request this service makes.
 * Returns the parsed XML. With allowQueued, returns null when BGG answers 202
 * ("come back later"), which it does while it prepares a collection.
 */
function fetchBgg_(path, params, allowQueued) {
  var properties = PropertiesService.getScriptProperties();
  var token = properties.getProperty('BGG_API_TOKEN');
  if (!token) throw fail_('setup', 'The lookup service is not set up yet: its BGG token is missing.');
  var query = Object.keys(params).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');

  for (var attempt = 0; attempt < 3; attempt++) {
    reserveRequest_(properties);
    var response = UrlFetchApp.fetch(BGG_API_ROOT + path + '?' + query, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.8'
      }
    });
    var code = response.getResponseCode();
    if (code === 200) return XmlService.parse(response.getContentText());
    if (code === 202 && allowQueued) return null;
    if (code === 401 || code === 403) throw fail_('setup', 'BoardGameGeek refused the lookup service. Its token may have expired.');
    if ([202, 429, 500, 502, 503].indexOf(code) < 0) throw fail_('bgg', 'BoardGameGeek answered with status ' + code + '.');
    Utilities.sleep(2500 * (attempt + 1));
  }
  throw fail_('busy', 'BoardGameGeek is busy. Try again in a minute.');
}

/** Waits for this request's turn and counts it against the daily limit. */
function reserveRequest_(properties) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (error) {
    throw fail_('busy', 'The lookup service is busy. Try again in a minute.');
  }
  try {
    var today = Utilities.formatDate(new Date(), 'Etc/UTC', 'yyyy-MM-dd');
    var state = JSON.parse(properties.getProperty('USAGE') || '{}');
    if (state.day !== today) state = {day: today, count: 0, last: 0};
    var limit = Number(properties.getProperty('DAILY_LIMIT')) || DEFAULT_DAILY_LIMIT;
    if (state.count >= limit) throw fail_('limit', 'The lookup service has reached its daily limit. It resets at midnight UTC.');
    var wait = MIN_GAP_MS - (Date.now() - Number(state.last || 0));
    if (wait > 0) Utilities.sleep(wait);
    state.count += 1;
    state.last = Date.now();
    properties.setProperty('USAGE', JSON.stringify(state));
  } finally {
    lock.releaseLock();
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────

function putCache_(cache, key, value, seconds) {
  var text = JSON.stringify(value);
  if (text.length > 95000) return; // over the cache's size limit: serve uncached
  try { cache.put(key, text, seconds); } catch (ignored) {}
}

function digest_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)).slice(0, 40);
}

function normalizeTitle_(value) {
  return String(value || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 0 to 1. Rewards an exact title, then a title that starts with the query, then shared words. */
function similarity_(query, title) {
  if (!query || !title) return 0;
  if (query === title) return 1;
  var queryWords = query.split(' ');
  var titleWords = title.split(' ');
  var shared = queryWords.filter(function (word) { return titleWords.indexOf(word) >= 0; }).length;
  var overlap = shared / Math.max(queryWords.length, titleWords.length);
  return Math.min(0.95, overlap * 0.7 + (title.indexOf(query) === 0 ? 0.25 : 0));
}

function links_(item, types) {
  return item.getChildren('link').filter(function (link) {
    return types.indexOf(link.getAttribute('type').getValue()) >= 0;
  }).map(function (link) { return link.getAttribute('value').getValue(); });
}

function childValue_(element, name) {
  var child = element.getChild(name);
  return child && child.getAttribute('value') ? child.getAttribute('value').getValue() : '';
}

function childText_(element, name) {
  var child = element.getChild(name);
  return child ? String(child.getText() || '').trim() : '';
}

function descendantAttribute_(element, path, attribute) {
  var current = element;
  for (var index = 0; index < path.length && current; index++) current = current.getChild(path[index]);
  return current && current.getAttribute(attribute) ? current.getAttribute(attribute).getValue() : '';
}

function formatRange_(min, max) {
  if (!min && !max) return '';
  if (!min || !max || min === max) return String(min || max);
  return min + '-' + max;
}
