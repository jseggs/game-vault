# BoardGameGeek lookup service

A small Apps Script web app that the project maintainer hosts once. The Game
Vault app calls it to search BoardGameGeek, read game details, and list a BGG
user's owned games, so people setting up their own vault do not need a BGG
API token.

People who only use Game Vault never touch this folder.

## What it sees

A search phrase, BGG IDs, or a BGG username. It never receives a sheet
address, an access key, plays, ratings, prices, or notes. Games are written to
a person's sheet by that sheet's own script, and only for the owner.

## Before you host it

BoardGameGeek requires a registered application and a token for its XML API,
and its terms decide what a registered application may do. Hosting this for
other people sends their lookups through your registration. Confirm with
BoardGameGeek that your registration covers a public, free, open-source tool
before you put the service address in `config.js`. Keep the "Powered by
BoardGameGeek" logo in the app.

## Set up

1. Sign in to the project Google account and open https://script.new.
2. Name the project "Game Vault BGG lookup".
3. Paste `Code.gs` over the default file.
4. Project Settings: tick "Show appsscript.json manifest file in editor", then
   paste `appsscript.json` over the manifest. Its only permission is
   "connect to an external service".
5. Project Settings > Script properties: add `BGG_API_TOKEN` with your token.
   Optional: `DAILY_LIMIT` (default 8000 BGG requests per UTC day).
6. Deploy > New deployment > Web app. Execute as: Me. Who has access: Anyone.
7. Put the web app URL in `bggServiceUrl` in `../config.js`.

The token lives only in Script properties. Never put it in this repository.

To change the code later, use Deploy > Manage deployments > Edit > New
version, so the address stays the same.

## Requests

| Request | Answer |
|---|---|
| `?action=search&q=azul` | Up to 10 matches: `id`, `name`, `year`, `expansion` |
| `?action=thing&ids=230802,13` | Details for up to 20 IDs |
| `?action=collection&user=NAME` | Owned games. May answer `{"status":"pending"}`; ask again in a few seconds |

Errors come back as `{"status":"error","code":...,"message":...}`.

## Limits

- Requests to BGG are spaced 1.3 seconds apart across all callers, so busy
  periods queue. A 200-game import takes about a minute.
- Game details and searches are cached for 6 hours, collections for 10 minutes.
- The daily limit stops runaway use. Apps Script cannot see a caller's
  address, so there is no per-person limit. If the service outgrows this, move
  it to a host that can rate-limit by address; the app only needs the new URL.

## Developing without a token

`node ../tools/fake-bgg-service.js` serves canned answers in the same shape.
The file's header explains how to point the app at it on localhost.
