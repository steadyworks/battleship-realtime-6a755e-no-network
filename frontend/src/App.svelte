<script>
  import { onMount } from 'svelte'

  const COLS = ['A','B','C','D','E','F','G','H','I','J']
  const ROWS = [1,2,3,4,5,6,7,8,9,10]
  const SHIPS = ['carrier','battleship','cruiser','submarine','destroyer']

  let ws = null
  let phase = 'lobby'
  let playerName = ''
  let nameInput = ''
  let opponentName = ''
  let currentTurn = ''
  let ownBoard = makeBoard('empty')
  let enemyBoard = makeBoard('unknown')
  let placedShips = []
  let shotHistory = []
  let winner = null
  let announcement = null
  let placementError = null
  let shotError = null
  let selectedShip = 'carrier'
  let orientation = 'h'

  function makeBoard(def) {
    const b = {}
    for (const c of COLS) for (const r of ROWS) b[`${c}-${r}`] = def
    return b
  }

  function resetState() {
    phase = 'lobby'
    playerName = ''
    nameInput = ''
    opponentName = ''
    currentTurn = ''
    ownBoard = makeBoard('empty')
    enemyBoard = makeBoard('unknown')
    placedShips = []
    shotHistory = []
    winner = null
    announcement = null
    placementError = null
    shotError = null
  }

  function handleMessage(event) {
    const msg = JSON.parse(event.data)

    if (msg.type === 'state') {
      if (msg.phase === 'lobby' && !msg.player_name) {
        resetState()
        return
      }
      phase = msg.phase || 'lobby'
      if (msg.player_name) playerName = msg.player_name
      opponentName = msg.opponent_name || ''
      currentTurn = msg.current_turn || ''
      if (msg.own_board) ownBoard = msg.own_board
      if (msg.enemy_board) enemyBoard = msg.enemy_board
      placedShips = msg.placed_ships || []
      shotHistory = msg.shot_history || []
      winner = msg.winner || null
      announcement = msg.announcement || null
      placementError = null
      shotError = null
    } else if (msg.type === 'error') {
      if (msg.context === 'placement') {
        placementError = msg.message
      } else {
        shotError = msg.message
      }
    }
  }

  function connect() {
    ws = new WebSocket('ws://localhost:3001/ws')
    ws.onmessage = handleMessage
    ws.onclose = () => setTimeout(connect, 1000)
    ws.onerror = () => { try { ws.close() } catch(e) {} }
  }

  onMount(connect)

  function join() {
    const name = nameInput.trim()
    if (!name || !ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ type: 'join', name }))
  }

  function placeShip(col, row) {
    placementError = null
    ws.send(JSON.stringify({ type: 'place_ship', ship: selectedShip, orient: orientation, col, row }))
  }

  function ready() {
    ws.send(JSON.stringify({ type: 'ready' }))
  }

  function fire(col, row) {
    shotError = null
    ws.send(JSON.stringify({ type: 'fire', col, row }))
  }

  function reset() {
    ws.send(JSON.stringify({ type: 'reset' }))
  }

  function ownState(col, row) { return ownBoard[`${col}-${row}`] || 'empty' }
  function enemyState(col, row) { return enemyBoard[`${col}-${row}`] || 'unknown' }
</script>

<div data-testid="phase">{phase}</div>
<button data-testid="reset-btn" on:click={reset}>Reset Game</button>

{#if phase === 'lobby'}
  <div data-testid="lobby">
    <h2>Battleship — Join Game</h2>
    <input type="text" bind:value={nameInput} placeholder="Your name" />
    <button data-testid="join-btn" on:click={join}>Join Game</button>
  </div>
{/if}

{#if phase === 'setup'}
  <div data-testid="setup-phase">
    <h2>Setup — Place Your Ships</h2>

    <div class="ship-select">
      {#each SHIPS as ship}
        <button
          data-testid="ship-select-{ship}"
          class:active={selectedShip === ship}
          on:click={() => { selectedShip = ship; placementError = null }}
        >{ship}</button>
      {/each}
    </div>

    <div class="orient">
      <button data-testid="orient-h" class:active={orientation === 'h'} on:click={() => orientation = 'h'}>Horizontal</button>
      <button data-testid="orient-v" class:active={orientation === 'v'} on:click={() => orientation = 'v'}>Vertical</button>
    </div>

    {#if placementError}
      <div data-testid="placement-error">{placementError}</div>
    {/if}

    <div class="board">
      {#each ROWS as row}
        {#each COLS as col}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div
            data-testid="cell-own-{col}-{row}"
            data-state={ownState(col, row)}
            class="cell own {ownState(col, row)}"
            on:click={() => placeShip(col, row)}
          ></div>
        {/each}
      {/each}
    </div>

    <button
      data-testid="ready-btn"
      disabled={placedShips.length < 5}
      on:click={ready}
    >Ready</button>
  </div>
{/if}

{#if phase === 'battle'}
  <div data-testid="battle-phase">
    <h2>Battle</h2>
    <div>Turn: <span data-testid="turn">{currentTurn}</span></div>

    {#if shotError}
      <div data-testid="shot-error">{shotError}</div>
    {/if}

    {#if announcement}
      <div data-testid="announcement">{announcement}</div>
    {/if}

    <div class="boards">
      <div>
        <h3>Your Board</h3>
        <div class="board">
          {#each ROWS as row}
            {#each COLS as col}
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div
                data-testid="cell-own-{col}-{row}"
                data-state={ownState(col, row)}
                class="cell own {ownState(col, row)}"
              ></div>
            {/each}
          {/each}
        </div>
      </div>

      <div>
        <h3>Enemy Board</h3>
        <div class="board">
          {#each ROWS as row}
            {#each COLS as col}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div
                data-testid="cell-enemy-{col}-{row}"
                data-state={enemyState(col, row)}
                class="cell enemy {enemyState(col, row)}"
                on:click={() => fire(col, row)}
              ></div>
            {/each}
          {/each}
        </div>
      </div>
    </div>

    <div data-testid="shot-history">
      {#each shotHistory as shot}
        <div data-testid="shot-{shot.n}">
          #{shot.n} {shot.attacker} → {shot.col}{shot.row}:
          {shot.result === 'sunk' ? `sunk ${shot.ship_type}` : shot.result}
        </div>
      {/each}
    </div>
  </div>
{/if}

{#if phase === 'finished'}
  <div data-testid="finished-phase">
    <h2>Game Over</h2>
    <div>Winner: <span data-testid="winner">{winner}</span></div>

    {#if shotError}
      <div data-testid="shot-error">{shotError}</div>
    {/if}

    {#if announcement}
      <div data-testid="announcement">{announcement}</div>
    {/if}

    <div class="boards">
      <div>
        <h3>Your Board</h3>
        <div class="board">
          {#each ROWS as row}
            {#each COLS as col}
              <!-- svelte-ignore a11y-no-static-element-interactions -->
              <div
                data-testid="cell-own-{col}-{row}"
                data-state={ownState(col, row)}
                class="cell own {ownState(col, row)}"
              ></div>
            {/each}
          {/each}
        </div>
      </div>

      <div>
        <h3>Enemy Board</h3>
        <div class="board">
          {#each ROWS as row}
            {#each COLS as col}
              <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
              <div
                data-testid="cell-enemy-{col}-{row}"
                data-state={enemyState(col, row)}
                class="cell enemy {enemyState(col, row)}"
                on:click={() => fire(col, row)}
              ></div>
            {/each}
          {/each}
        </div>
      </div>
    </div>

    <div data-testid="shot-history">
      {#each shotHistory as shot}
        <div data-testid="shot-{shot.n}">
          #{shot.n} {shot.attacker} → {shot.col}{shot.row}:
          {shot.result === 'sunk' ? `sunk ${shot.ship_type}` : shot.result}
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .board {
    display: grid;
    grid-template-columns: repeat(10, 40px);
    grid-template-rows: repeat(10, 40px);
    gap: 2px;
    margin: 8px 0;
  }
  .cell {
    width: 40px;
    height: 40px;
    border: 1px solid #999;
    cursor: pointer;
    box-sizing: border-box;
  }
  .cell.empty { background: #ddeeff; }
  .cell.ship { background: #556677; }
  .cell.hit { background: #ff6600; }
  .cell.sunk { background: #cc0000; }
  .cell.unknown { background: #aaccee; cursor: pointer; }
  .cell.miss { background: #ffffff; }
  .boards { display: flex; gap: 24px; }
  .active { font-weight: bold; border: 2px solid #000; }
  [data-testid="placement-error"],
  [data-testid="shot-error"] { color: red; margin: 4px 0; }
  [data-testid="announcement"] { color: green; font-weight: bold; margin: 4px 0; }
  [data-testid="turn"] { font-weight: bold; }
</style>
