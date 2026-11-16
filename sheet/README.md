# The Game Vault sheet

This folder holds everything that lives on the Google side.

- `Game-Vault-Template.xlsx`: the workbook (START HERE, Games, Plays, Players). Rebuild it with `python3 tools/build_template.py`.
- `Code.gs`: the script inside the sheet. It is the only thing the app talks to.
- `appsscript.json`: the script's permission list. It asks for the attached spreadsheet and the sheet menu, nothing else.

## Maintainer: publish the one-click copy link (one time)

People should not have to paste code. Copying a Google Sheet copies its script too, so publish one master sheet:

1. Sign in to the Google account that will own the public template. A separate project account is safer than a personal one: the owner's name is visible on the shared sheet.
2. Upload `Game-Vault-Template.xlsx` to Google Drive, open it with Google Sheets, and choose File > Save as Google Sheets. Name it `Game Vault`.
3. In the sheet, choose Extensions > Apps Script. Replace the contents of `Code.gs` with this folder's `Code.gs`.
4. In Apps Script, open Project Settings and tick "Show appsscript.json manifest file in editor". Replace its contents with this folder's `appsscript.json`. Save.
5. Rename the Apps Script project to `Game Vault`. People see this name on Google's permission screen.
6. Do not deploy the master sheet. Each person deploys their own copy.
7. Reload the sheet and check that the Game Vault menu appears.
8. Share the sheet as "Anyone with the link: Viewer".
9. Take the sheet's address, replace everything from `/edit` onward with `/copy`, and put that in `templateCopyUrl` in `config.js`.

Before sharing, check the master sheet for anything personal: owner name, version history, comments, and sample rows.

## Updating the script later

Raise `SCRIPT_VERSION` in `Code.gs`. People who already copied the sheet keep their old script until they paste in the new one and deploy a new version, so keep changes backward compatible where possible.

## Testing without Google

`node tools/fake-sheet-server.js --test` runs the script's checks against an in-memory spreadsheet.

`node tools/fake-sheet-server.js` serves the same fake at `http://localhost:4175/exec`. With the app also running on localhost, paste that address into Settings to try the full connect, log, rate, and delete flow.
