#!/usr/bin/env python3
"""Build sheet/Game-Vault-Template.xlsx, the workbook people import into Google Sheets.

Usage: python3 tools/build_template.py   (needs openpyxl)

The column names here are the contract with the app and with sheet/Code.gs.
Rename a column in all three places or not at all.
"""
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

OUT = Path(__file__).resolve().parent.parent / "sheet" / "Game-Vault-Template.xlsx"

HEADER_FILL = PatternFill("solid", fgColor="1A1348")
HEADER_FONT = Font(bold=True, color="FFE04A")
YOU_FILL = PatternFill("solid", fgColor="FFF7D6")   # columns you fill in
BGG_FILL = PatternFill("solid", fgColor="E3F6F8")   # columns BoardGameGeek can fill in later

GAMES = [
    # header, width, group
    ("Game", 34, "you"), ("Shelf", 14, "you"), ("Played", 10, "you"),
    ("P1 Rating", 11, "you"), ("P2 Rating", 11, "you"), ("Expansion", 11, "you"),
    ("Price Paid", 12, "you"), ("Year bought", 12, "you"), ("Notes", 36, "you"),
    ("Players", 10, "bgg"), ("Players (BGG)", 14, "bgg"), ("Best At", 10, "bgg"),
    ("Solo", 8, "bgg"), ("Age", 8, "bgg"), ("BGG Score", 11, "bgg"),
    ("BGG Category", 30, "bgg"), ("BGG ID", 10, "bgg"), ("BGG URL", 30, "bgg"),
    ("BGG Thumbnail", 30, "bgg"), ("BGG Image", 30, "bgg"), ("Excluded", 10, "you"),
]
SAMPLE_GAMES = [
    ["Azul", "Family", "Yes", 8, 8, "", 32, 2022, "Easy to teach.", "2-4", "2-4", "2", "No", "8+", 7.8, "Abstract Strategy, Tile Placement", 230802, "https://boardgamegeek.com/boardgame/230802"],
    ["7 Wonders Duel", "2-Player", "Yes", 8, 9, "", 28, 2023, "", "2", "2", "2", "No", "10+", 8.1, "Card Drafting, Civilization", 173346, "https://boardgamegeek.com/boardgame/173346"],
    ["Cascadia", "Family", "No", "", "", "", 36, 2024, "", "1-4", "1-4", "2-3", "Yes", "10+", 7.9, "Tile Placement, Nature", 295947, "https://boardgamegeek.com/boardgame/295947"],
    ["Catan", "Family", "No", "", "", "", 42, 2020, "", "3-4", "3-4", "4", "No", "10+", 7.1, "Negotiation, Network Building", 13, "https://boardgamegeek.com/boardgame/13"],
    ["Under Falling Skies", "Solo", "No", "", "", "", 29, 2024, "", "1", "1", "1", "Yes", "12+", 7.8, "Solo, Dice Placement", 306735, "https://boardgamegeek.com/boardgame/306735"],
]
PLAYS_HEADERS = [("Date", 13), ("Game", 34), ("Winner", 16), ("Notes", 36), ("P1 Rating", 11), ("P2 Rating", 11), ("Play ID", 38)]
SAMPLE_PLAYS = [
    ["2026-06-06", "Azul", "Player 1", "Close game.", "", "", "sample-1"],
    ["2026-06-14", "7 Wonders Duel", "Player 2", "", "", "", "sample-2"],
]
DINOS = "T-Rex,Velociraptor,Triceratops,Ankylosaurus,Brachiosaurus,Pterodactyl,Spinosaurus,Stegosaurus"
COLORS = "cyan,gold,pink,purple,lime,orange,teal,red"

START_HERE = [
    ("Game Vault", "title"),
    ("Your board game collection, in a sheet you own.", "lead"),
    ("", None),
    ("1. Make it yours", "h"),
    ("Open the Players tab and type your two player names. Pick a dinosaur and a color for each.", None),
    ("Open the Games tab. Replace the sample rows with your games. Only the Game column is required.", None),
    ("", None),
    ("2. Switch on the connection", "h"),
    ("In the menu, choose Extensions > Apps Script.", None),
    ("Click Deploy > New deployment. Click the gear and choose Web app.", None),
    ('Set "Execute as" to Me and "Who has access" to Anyone. Click Deploy.', None),
    ('Approve access when asked. Google shows a "Google hasn\'t verified this app" notice for scripts you copy yourself: choose Advanced, then continue.', None),
    ("Copy the Web app URL.", None),
    ("", None),
    ("3. Connect the app", "h"),
    ("Open the Game Vault app, go to Settings, paste the Web app URL, and tap Connect.", None),
    ("The first device to connect becomes the owner. From its Settings you can copy invite links for other phones and people.", None),
    ("", None),
    ("Good to know", "h"),
    ("Do not rename the Games, Plays, or Players tabs, or the column headers in row 1. You may add your own columns.", None),
    ("Yellow columns are yours to fill in. Blue columns can be filled from BoardGameGeek.", None),
    ("Never use File > Share > Publish to web. The app does not need it, and it would make the tab public.", None),
    ("Lost a device or shared a link by mistake? Use the Game Vault menu > Reset access keys, then connect again.", None),
]


def style_header(ws, headers):
    for index, (name, width, *_rest) in enumerate(headers, start=1):
        cell = ws.cell(row=1, column=index, value=name)
        cell.fill, cell.font = HEADER_FILL, HEADER_FONT
        cell.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(index)].width = width
    ws.row_dimensions[1].height = 22
    ws.freeze_panes = "B2"


def main():
    wb = Workbook()

    start = wb.active
    start.title = "START HERE"
    start.column_dimensions["A"].width = 110
    start.sheet_view.showGridLines = False
    for row, (text, kind) in enumerate(START_HERE, start=1):
        cell = start.cell(row=row, column=1, value=text)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        if kind == "title":
            cell.font = Font(bold=True, size=22, color="1A1348")
        elif kind == "lead":
            cell.font = Font(size=12, color="555555")
        elif kind == "h":
            cell.font = Font(bold=True, size=13, color="C2185B")

    games = wb.create_sheet("Games")
    style_header(games, GAMES)
    for r, values in enumerate(SAMPLE_GAMES, start=2):
        for c, value in enumerate(values, start=1):
            games.cell(row=r, column=c, value=value)
    for index, (_name, _width, group) in enumerate(GAMES, start=1):
        fill = YOU_FILL if group == "you" else BGG_FILL
        for r in range(2, 60):
            games.cell(row=r, column=index).fill = fill
    yes_no = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    games.add_data_validation(yes_no)
    yes_no.add("C2:C1000")
    yes_no.add("F2:F1000")
    rating = DataValidation(type="decimal", operator="between", formula1="1", formula2="10", allow_blank=True)
    rating.error, rating.errorTitle = "Ratings go from 1 to 10.", "Rating"
    games.add_data_validation(rating)
    rating.add("D2:E1000")

    plays = wb.create_sheet("Plays")
    style_header(plays, PLAYS_HEADERS)
    for r, values in enumerate(SAMPLE_PLAYS, start=2):
        for c, value in enumerate(values, start=1):
            plays.cell(row=r, column=c, value=value)

    players = wb.create_sheet("Players")
    style_header(players, [("Player #", 10), ("Name", 22), ("Dino", 18), ("Color", 12)])
    for r, values in enumerate([[1, "Player 1", "Velociraptor", "cyan"], [2, "Player 2", "Triceratops", "red"]], start=2):
        for c, value in enumerate(values, start=1):
            players.cell(row=r, column=c, value=value)
    dino = DataValidation(type="list", formula1=f'"{DINOS}"', allow_blank=False)
    color = DataValidation(type="list", formula1=f'"{COLORS}"', allow_blank=False)
    players.add_data_validation(dino)
    players.add_data_validation(color)
    dino.add("C2:C3")
    color.add("D2:D3")

    OUT.parent.mkdir(exist_ok=True)
    wb.save(OUT)
    print(f"Wrote {OUT.relative_to(OUT.parent.parent)}: " + ", ".join(ws.title for ws in wb.worksheets))


if __name__ == "__main__":
    main()
