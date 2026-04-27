import asyncio
import json
import random
import sqlite3
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

SHIP_SIZES = {
    'carrier': 5,
    'battleship': 4,
    'cruiser': 3,
    'submarine': 3,
    'destroyer': 2,
}
COLS = list('ABCDEFGHIJ')
ROWS = list(range(1, 11))
DB_PATH = 'battleship.db'

connections: dict[str, WebSocket] = {}
lobby_queue: list[str] = []
game_lock = asyncio.Lock()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL')
    return conn


def init_db():
    db = get_db()
    db.executescript('''
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phase TEXT NOT NULL DEFAULT 'setup',
            current_turn TEXT,
            player1 TEXT NOT NULL,
            player2 TEXT NOT NULL,
            announcement TEXT,
            winner TEXT
        );
        CREATE TABLE IF NOT EXISTS ships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            player_name TEXT NOT NULL,
            ship_type TEXT NOT NULL,
            cells TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS shots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            attacker TEXT NOT NULL,
            col TEXT NOT NULL,
            row INTEGER NOT NULL,
            result TEXT NOT NULL,
            ship_type TEXT,
            sequence INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS player_ready (
            game_id INTEGER NOT NULL,
            player_name TEXT NOT NULL,
            PRIMARY KEY (game_id, player_name)
        );
    ''')
    db.commit()
    db.close()


def calculate_cells(ship_type: str, orient: str, col: str, row: int):
    size = SHIP_SIZES.get(ship_type)
    if size is None or col not in COLS or row not in ROWS:
        return None
    col_idx = COLS.index(col)
    cells = []
    if orient == 'h':
        for i in range(size):
            if col_idx + i >= len(COLS):
                return None
            cells.append((COLS[col_idx + i], row))
    elif orient == 'v':
        for i in range(size):
            if row + i > 10:
                return None
            cells.append((col, row + i))
    else:
        return None
    return cells


def build_game_state(db, player_name: str) -> dict:
    game = db.execute(
        'SELECT * FROM games WHERE player1=? OR player2=?',
        (player_name, player_name)
    ).fetchone()

    if not game:
        return {'type': 'state', 'phase': 'lobby', 'player_name': player_name}

    game_id = game['id']
    p1, p2 = game['player1'], game['player2']
    opponent = p2 if player_name == p1 else p1
    phase = game['phase']

    own_board = {f'{c}-{r}': 'empty' for c in COLS for r in ROWS}
    enemy_board = {f'{c}-{r}': 'unknown' for c in COLS for r in ROWS}

    own_ships = db.execute(
        'SELECT * FROM ships WHERE game_id=? AND player_name=?', (game_id, player_name)
    ).fetchall()
    opp_ships = db.execute(
        'SELECT * FROM ships WHERE game_id=? AND player_name=?', (game_id, opponent)
    ).fetchall()

    opp_shots_set = set(
        (s['col'], s['row'])
        for s in db.execute(
            'SELECT col, row FROM shots WHERE game_id=? AND attacker=?', (game_id, opponent)
        ).fetchall()
    )
    my_shots = {
        (s['col'], s['row']): s['result']
        for s in db.execute(
            'SELECT col, row, result FROM shots WHERE game_id=? AND attacker=?', (game_id, player_name)
        ).fetchall()
    }

    for ship in own_ships:
        cells = json.loads(ship['cells'])
        is_sunk = all((c, r) in opp_shots_set for c, r in cells)
        for c, r in cells:
            if is_sunk:
                own_board[f'{c}-{r}'] = 'sunk'
            elif (c, r) in opp_shots_set:
                own_board[f'{c}-{r}'] = 'hit'
            else:
                own_board[f'{c}-{r}'] = 'ship'

    for (c, r), result in my_shots.items():
        enemy_board[f'{c}-{r}'] = result

    for ship in opp_ships:
        cells = json.loads(ship['cells'])
        if all((c, r) in my_shots for c, r in cells):
            for c, r in cells:
                enemy_board[f'{c}-{r}'] = 'sunk'

    if phase == 'finished':
        for ship in opp_ships:
            for c, r in json.loads(ship['cells']):
                key = f'{c}-{r}'
                if enemy_board[key] == 'unknown':
                    enemy_board[key] = 'ship'

    all_shots = db.execute(
        'SELECT * FROM shots WHERE game_id=? ORDER BY sequence', (game_id,)
    ).fetchall()
    shot_history = [
        {'n': s['sequence'], 'attacker': s['attacker'], 'col': s['col'],
         'row': s['row'], 'result': s['result'], 'ship_type': s['ship_type']}
        for s in all_shots
    ]

    return {
        'type': 'state',
        'phase': phase,
        'player_name': player_name,
        'opponent_name': opponent,
        'current_turn': game['current_turn'],
        'own_board': own_board,
        'enemy_board': enemy_board,
        'placed_ships': [s['ship_type'] for s in own_ships],
        'shot_history': shot_history,
        'winner': game['winner'],
        'announcement': game['announcement'],
    }


async def broadcast_game(db, game_id: int):
    game = db.execute('SELECT * FROM games WHERE id=?', (game_id,)).fetchone()
    if not game:
        return
    for pname in [game['player1'], game['player2']]:
        if pname in connections:
            try:
                await connections[pname].send_json(build_game_state(db, pname))
            except Exception:
                pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:3000'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


@app.websocket('/ws')
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    player_name = None
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get('type')
            if msg_type == 'join':
                player_name = data['name'].strip()
                connections[player_name] = websocket
                await handle_join(websocket, player_name)
            elif msg_type == 'place_ship' and player_name:
                await handle_place_ship(websocket, player_name, data)
            elif msg_type == 'ready' and player_name:
                await handle_ready(player_name)
            elif msg_type == 'fire' and player_name:
                await handle_fire(player_name, data['col'], int(data['row']))
            elif msg_type == 'reset':
                await handle_reset()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        if player_name and connections.get(player_name) is websocket:
            del connections[player_name]


async def handle_join(ws: WebSocket, player_name: str):
    async with game_lock:
        db = get_db()
        try:
            game = db.execute(
                'SELECT * FROM games WHERE player1=? OR player2=?',
                (player_name, player_name)
            ).fetchone()

            if game:
                await ws.send_json(build_game_state(db, player_name))
            else:
                if player_name not in lobby_queue:
                    lobby_queue.append(player_name)

                if len(lobby_queue) >= 2:
                    p1 = lobby_queue.pop(0)
                    p2 = lobby_queue.pop(0)
                    first_turn = random.choice([p1, p2])
                    db.execute(
                        'INSERT INTO games (phase, current_turn, player1, player2) VALUES ("setup", ?, ?, ?)',
                        (first_turn, p1, p2)
                    )
                    db.commit()
                    for pname in [p1, p2]:
                        if pname in connections:
                            try:
                                await connections[pname].send_json(build_game_state(db, pname))
                            except Exception:
                                pass
                else:
                    await ws.send_json({'type': 'state', 'phase': 'lobby', 'player_name': player_name})
        finally:
            db.close()


async def handle_place_ship(ws: WebSocket, player_name: str, data: dict):
    async with game_lock:
        db = get_db()
        try:
            game = db.execute(
                "SELECT * FROM games WHERE (player1=? OR player2=?) AND phase='setup'",
                (player_name, player_name)
            ).fetchone()

            if not game:
                await ws.send_json({'type': 'error', 'context': 'placement', 'message': 'No active setup game'})
                return

            game_id = game['id']
            ship_type = data.get('ship', '')
            orient = data.get('orient', 'h')
            col = data.get('col', '')
            row = int(data.get('row', 0))

            if ship_type not in SHIP_SIZES:
                await ws.send_json({'type': 'error', 'context': 'placement', 'message': 'Invalid ship type'})
                return

            if db.execute(
                'SELECT 1 FROM ships WHERE game_id=? AND player_name=? AND ship_type=?',
                (game_id, player_name, ship_type)
            ).fetchone():
                await ws.send_json({'type': 'error', 'context': 'placement',
                                    'message': f'Already placed {ship_type}'})
                return

            cells = calculate_cells(ship_type, orient, col, row)
            if cells is None:
                await ws.send_json({'type': 'error', 'context': 'placement', 'message': 'Ship goes off the grid'})
                return

            occupied = set()
            for s in db.execute(
                'SELECT cells FROM ships WHERE game_id=? AND player_name=?', (game_id, player_name)
            ).fetchall():
                for c, r in json.loads(s['cells']):
                    occupied.add((c, r))

            for c, r in cells:
                if (c, r) in occupied:
                    await ws.send_json({'type': 'error', 'context': 'placement', 'message': 'Ships overlap'})
                    return

            db.execute(
                'INSERT INTO ships (game_id, player_name, ship_type, cells) VALUES (?, ?, ?, ?)',
                (game_id, player_name, ship_type, json.dumps([[c, r] for c, r in cells]))
            )
            db.commit()
            await ws.send_json(build_game_state(db, player_name))
        finally:
            db.close()


async def handle_ready(player_name: str):
    async with game_lock:
        db = get_db()
        try:
            game = db.execute(
                "SELECT * FROM games WHERE (player1=? OR player2=?) AND phase='setup'",
                (player_name, player_name)
            ).fetchone()
            if not game:
                return

            game_id = game['id']
            if db.execute(
                'SELECT COUNT(*) FROM ships WHERE game_id=? AND player_name=?',
                (game_id, player_name)
            ).fetchone()[0] < 5:
                return

            db.execute(
                'INSERT OR IGNORE INTO player_ready (game_id, player_name) VALUES (?, ?)',
                (game_id, player_name)
            )
            db.commit()

            ready_count = db.execute(
                'SELECT COUNT(*) FROM player_ready WHERE game_id=?', (game_id,)
            ).fetchone()[0]

            if ready_count >= 2:
                db.execute("UPDATE games SET phase='battle' WHERE id=?", (game_id,))
                db.commit()
                await broadcast_game(db, game_id)
            else:
                ws = connections.get(player_name)
                if ws:
                    await ws.send_json(build_game_state(db, player_name))
        finally:
            db.close()


async def handle_fire(player_name: str, col: str, row: int):
    async with game_lock:
        db = get_db()
        try:
            ws = connections.get(player_name)
            game = db.execute(
                'SELECT * FROM games WHERE player1=? OR player2=?',
                (player_name, player_name)
            ).fetchone()

            if not game:
                if ws:
                    await ws.send_json({'type': 'error', 'context': 'shot', 'message': 'No active game'})
                return

            game_id = game['id']
            phase = game['phase']
            p1, p2 = game['player1'], game['player2']
            defender = p2 if player_name == p1 else p1

            if phase == 'finished':
                if ws:
                    await ws.send_json({'type': 'error', 'context': 'shot', 'message': 'game over'})
                return

            if phase != 'battle':
                return

            if game['current_turn'] != player_name:
                if ws:
                    await ws.send_json({'type': 'error', 'context': 'shot', 'message': 'not your turn'})
                return

            if db.execute(
                'SELECT 1 FROM shots WHERE game_id=? AND attacker=? AND col=? AND row=?',
                (game_id, player_name, col, row)
            ).fetchone():
                if ws:
                    await ws.send_json({'type': 'error', 'context': 'shot', 'message': 'already shot'})
                return

            opp_ships = db.execute(
                'SELECT * FROM ships WHERE game_id=? AND player_name=?', (game_id, defender)
            ).fetchall()

            hit_ship = None
            for ship in opp_ships:
                cells = json.loads(ship['cells'])
                if [col, row] in cells:
                    hit_ship = ship
                    break

            if hit_ship is None:
                result, ship_type = 'miss', None
            else:
                ship_type = hit_ship['ship_type']
                cells = json.loads(hit_ship['cells'])
                existing_hits = set(
                    (s['col'], s['row'])
                    for s in db.execute(
                        'SELECT col, row FROM shots WHERE game_id=? AND attacker=?',
                        (game_id, player_name)
                    ).fetchall()
                )
                unhit_after = [
                    (c, r) for c, r in cells
                    if (c, r) not in existing_hits and not (c == col and r == row)
                ]
                result = 'sunk' if not unhit_after else 'hit'

            seq = db.execute(
                'SELECT COALESCE(MAX(sequence), 0) FROM shots WHERE game_id=?', (game_id,)
            ).fetchone()[0] + 1

            db.execute(
                'INSERT INTO shots (game_id, attacker, col, row, result, ship_type, sequence) VALUES (?,?,?,?,?,?,?)',
                (game_id, player_name, col, row, result, ship_type, seq)
            )

            if result == 'sunk':
                announcement = f'{player_name} sunk {ship_type.capitalize()}'
                db.execute('UPDATE games SET announcement=? WHERE id=?', (announcement, game_id))

                my_shots_set = set(
                    (s['col'], s['row'])
                    for s in db.execute(
                        'SELECT col, row FROM shots WHERE game_id=? AND attacker=?',
                        (game_id, player_name)
                    ).fetchall()
                )
                if all(
                    all((c, r) in my_shots_set for c, r in json.loads(ship['cells']))
                    for ship in opp_ships
                ):
                    db.execute(
                        "UPDATE games SET phase='finished', winner=? WHERE id=?",
                        (player_name, game_id)
                    )
                    db.commit()
                    await broadcast_game(db, game_id)
                    return

            db.execute('UPDATE games SET current_turn=? WHERE id=?', (defender, game_id))
            db.commit()
            await broadcast_game(db, game_id)
        finally:
            db.close()


async def handle_reset():
    async with game_lock:
        db = get_db()
        try:
            db.executescript('''
                DELETE FROM shots;
                DELETE FROM player_ready;
                DELETE FROM ships;
                DELETE FROM games;
            ''')
            db.commit()
            lobby_queue.clear()
        finally:
            db.close()

    for ws in list(connections.values()):
        try:
            await ws.send_json({'type': 'state', 'phase': 'lobby'})
        except Exception:
            pass
