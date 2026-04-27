import { test, expect, Browser, BrowserContext, Page } from '@playwright/test'

const FRONTEND = 'http://localhost:3000'

// ---------------------------------------------------------------------------
// Fleet type & constants
// ---------------------------------------------------------------------------

type Orientation = 'h' | 'v'
type ShipEntry = readonly [string, Orientation, string, number]
type Fleet = ReadonlyArray<ShipEntry>

// Alice's default fleet — rows 3-7, cols A-E (no ships in row 1 or cols F-J)
const ALICE_DEFAULT: Fleet = [
  ['carrier',    'h', 'A', 3],  // A3-E3
  ['battleship', 'h', 'A', 4],  // A4-D4
  ['cruiser',    'h', 'A', 5],  // A5-C5
  ['submarine',  'h', 'A', 6],  // A6-C6
  ['destroyer',  'h', 'A', 7],  // A7-B7
] as const

// Bob's default fleet — rows 3-7, cols F-J (no ships in row 1 or cols A-E)
const BOB_DEFAULT: Fleet = [
  ['carrier',    'h', 'F', 3],  // F3-J3
  ['battleship', 'h', 'F', 4],  // F4-I4
  ['cruiser',    'h', 'F', 5],  // F5-H5
  ['submarine',  'h', 'F', 6],  // F6-H6
  ['destroyer',  'h', 'F', 7],  // F7-G7
] as const

// Bob's fleet for hit/sink tests — Battleship at A-1, rest in cols F-J
const BOB_BATTLESHIP_ROW1: Fleet = [
  ['battleship', 'h', 'A', 1],  // A1-D1 — target for hit/sink tests
  ['carrier',    'h', 'F', 3],
  ['cruiser',    'h', 'F', 5],
  ['submarine',  'h', 'F', 6],
  ['destroyer',  'h', 'F', 7],
] as const

// Bob's fleet for game-over test — all ships in rows 1-5, cols A-E
const BOB_SINK_ALL: Fleet = [
  ['carrier',    'h', 'A', 1],  // A1-E1
  ['battleship', 'h', 'A', 2],  // A2-D2
  ['cruiser',    'h', 'A', 3],  // A3-C3
  ['submarine',  'h', 'A', 4],  // A4-C4
  ['destroyer',  'h', 'A', 5],  // A5-B5
] as const

// Alice's fleet for game-over test — rows 7-10, cols A-E
// Bob safely fires into cols I-J without hitting Alice's ships
const ALICE_ROWS7_10: Fleet = [
  ['carrier',    'h', 'A', 7],  // A7-E7
  ['battleship', 'h', 'A', 8],  // A8-D8
  ['cruiser',    'h', 'A', 9],  // A9-C9
  ['submarine',  'h', 'A', 10], // A10-C10
  ['destroyer',  'h', 'D', 9],  // D9-E9  (no overlap with cruiser at A-C9)
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function placeShip(page: Page, ship: string, orient: Orientation, col: string, row: number) {
  await page.getByTestId(`ship-select-${ship}`).click()
  await page.getByTestId(`orient-${orient}`).click()
  await page.getByTestId(`cell-own-${col}-${row}`).click()
}

async function placeFleet(page: Page, fleet: Fleet) {
  for (const [ship, orient, col, row] of fleet) {
    await placeShip(page, ship, orient, col, row)
  }
}

async function joinPlayer(page: Page, name: string) {
  await expect(page.getByTestId('lobby')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('lobby').locator('input').first().fill(name)
  await page.getByTestId('join-btn').click()
}

/** Navigate both pages, click reset, verify both clients land in lobby. */
async function resetToLobby(alice: Page, bob: Page) {
  await Promise.all([alice.goto(FRONTEND), bob.goto(FRONTEND)])
  await expect(alice.getByTestId('reset-btn')).toBeVisible({ timeout: 15_000 })
  await expect(bob.getByTestId('reset-btn')).toBeVisible({ timeout: 15_000 })
  await alice.getByTestId('reset-btn').click()
  await expect(alice.getByTestId('phase')).toHaveText('lobby', { timeout: 12_000 })
  await expect(bob.getByTestId('phase')).toHaveText('lobby', { timeout: 12_000 })
}

/** Open two fresh browser contexts, navigate to FRONTEND, and reset to lobby. */
async function createContexts(browser: Browser): Promise<{
  alice: Page
  bob: Page
  ctx1: BrowserContext
  ctx2: BrowserContext
  cleanup: () => Promise<void>
}> {
  const ctx1 = await browser.newContext()
  const ctx2 = await browser.newContext()
  const alice = await ctx1.newPage()
  const bob = await ctx2.newPage()
  await resetToLobby(alice, bob)
  const cleanup = async () => {
    await ctx1.close().catch(() => {})
    await ctx2.close().catch(() => {})
  }
  return { alice, bob, ctx1, ctx2, cleanup }
}

/** Join both players and wait for setup phase. */
async function goToSetup(alice: Page, bob: Page) {
  await joinPlayer(alice, 'Alice')
  await joinPlayer(bob, 'Bob')
  await expect(alice.getByTestId('phase')).toHaveText('setup', { timeout: 15_000 })
  await expect(bob.getByTestId('phase')).toHaveText('setup', { timeout: 15_000 })
}

/** Full flow to battle phase with configurable fleets. */
async function goToBattle(
  alice: Page,
  bob: Page,
  aliceFleet: Fleet = ALICE_DEFAULT,
  bobFleet: Fleet = BOB_DEFAULT,
) {
  await goToSetup(alice, bob)
  await placeFleet(alice, aliceFleet)
  await expect(alice.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
  await placeFleet(bob, bobFleet)
  await expect(bob.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
  await alice.getByTestId('ready-btn').click()
  await bob.getByTestId('ready-btn').click()
  await expect(alice.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
  await expect(bob.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
}

/**
 * Alice fires a cell and waits for the turn indicator on her page to
 * show "Bob", confirming the server processed the shot.
 */
async function aliceFires(alice: Page, col: string, row: number) {
  await alice.getByTestId(`cell-enemy-${col}-${row}`).click()
  await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
}

/**
 * Bob fires a cell and waits for the turn indicator on his page to
 * show "Alice", confirming the server processed the shot.
 */
async function bobFires(bob: Page, col: string, row: number) {
  await bob.getByTestId(`cell-enemy-${col}-${row}`).click()
  await expect(bob.getByTestId('turn')).toHaveText('Alice', { timeout: 10_000 })
}

// ---------------------------------------------------------------------------
// TC-01: Player Pairing
// ---------------------------------------------------------------------------

test('TC-01: two players joining are paired into setup phase', async ({ browser }) => {
  test.setTimeout(60_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await joinPlayer(alice, 'Alice')
    await joinPlayer(bob, 'Bob')
    await expect(alice.getByTestId('phase')).toHaveText('setup', { timeout: 15_000 })
    await expect(bob.getByTestId('phase')).toHaveText('setup', { timeout: 15_000 })
    await expect(alice.getByTestId('setup-phase')).toBeVisible()
    await expect(bob.getByTestId('setup-phase')).toBeVisible()
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-02: Off-Grid Placement Rejected
// ---------------------------------------------------------------------------

test('TC-02: carrier at G-1 horizontal is rejected (extends off-grid)', async ({ browser }) => {
  test.setTimeout(60_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    // Carrier (size 5) starting at G-1 horizontal would reach K-1 — off-grid
    await alice.getByTestId('ship-select-carrier').click()
    await alice.getByTestId('orient-h').click()
    await alice.getByTestId('cell-own-G-1').click()
    await expect(alice.getByTestId('placement-error')).toBeVisible({ timeout: 10_000 })
    // No cell in row 1 should carry a ship
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      await expect(alice.getByTestId(`cell-own-${col}-1`)).not.toHaveAttribute('data-state', 'ship')
    }
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-03: Overlapping Placement Rejected
// ---------------------------------------------------------------------------

test('TC-03: overlapping ship placement is rejected; original ship unchanged', async ({ browser }) => {
  test.setTimeout(60_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    // Battleship (4) at A-1 horizontal → covers A-1, B-1, C-1, D-1
    await placeShip(alice, 'battleship', 'h', 'A', 1)
    await expect(alice.getByTestId('cell-own-A-1')).toHaveAttribute('data-state', 'ship', { timeout: 8_000 })
    await expect(alice.getByTestId('cell-own-B-1')).toHaveAttribute('data-state', 'ship')
    await expect(alice.getByTestId('cell-own-C-1')).toHaveAttribute('data-state', 'ship')
    await expect(alice.getByTestId('cell-own-D-1')).toHaveAttribute('data-state', 'ship')
    // Cruiser (3) at C-1 horizontal → overlaps C-1 and D-1 — should be rejected
    await placeShip(alice, 'cruiser', 'h', 'C', 1)
    await expect(alice.getByTestId('placement-error')).toBeVisible({ timeout: 10_000 })
    // Original battleship cells must be unchanged
    await expect(alice.getByTestId('cell-own-A-1')).toHaveAttribute('data-state', 'ship')
    await expect(alice.getByTestId('cell-own-B-1')).toHaveAttribute('data-state', 'ship')
    await expect(alice.getByTestId('cell-own-C-1')).toHaveAttribute('data-state', 'ship')
    await expect(alice.getByTestId('cell-own-D-1')).toHaveAttribute('data-state', 'ship')
    // E-1 must not have acquired a ship state
    await expect(alice.getByTestId('cell-own-E-1')).not.toHaveAttribute('data-state', 'ship')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-04: Duplicate Ship Type Rejected
// ---------------------------------------------------------------------------

test('TC-04: placing the same ship type twice is rejected', async ({ browser }) => {
  test.setTimeout(60_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    await placeShip(alice, 'destroyer', 'h', 'A', 10)
    await expect(alice.getByTestId('cell-own-A-10')).toHaveAttribute('data-state', 'ship', { timeout: 8_000 })
    // Try placing a second destroyer
    await placeShip(alice, 'destroyer', 'h', 'F', 10)
    await expect(alice.getByTestId('placement-error')).toBeVisible({ timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-05: Ready Button Gating
// ---------------------------------------------------------------------------

test('TC-05: ready button disabled with <5 ships, enabled after all 5 placed', async ({ browser }) => {
  test.setTimeout(60_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    await expect(alice.getByTestId('ready-btn')).toBeDisabled()
    // Place 4 ships — button must stay disabled
    await placeShip(alice, 'carrier',    'h', 'A', 3)
    await placeShip(alice, 'battleship', 'h', 'A', 4)
    await placeShip(alice, 'cruiser',    'h', 'A', 5)
    await placeShip(alice, 'submarine',  'h', 'A', 6)
    await expect(alice.getByTestId('ready-btn')).toBeDisabled()
    // Place the 5th ship — button must become enabled
    await placeShip(alice, 'destroyer', 'h', 'A', 7)
    await expect(alice.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-06: Phase Transitions to Battle When Both Players Ready
// ---------------------------------------------------------------------------

test('TC-06: both ready → battle phase; both clients show the same initial turn', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    await placeFleet(alice, ALICE_DEFAULT)
    await expect(alice.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
    await placeFleet(bob, BOB_DEFAULT)
    await expect(bob.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
    await alice.getByTestId('ready-btn').click()
    await bob.getByTestId('ready-btn').click()
    await expect(alice.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
    await expect(bob.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
    const turn = (await alice.getByTestId('turn').textContent({ timeout: 10_000 }))?.trim()
    expect(['Alice', 'Bob']).toContain(turn)
    await expect(bob.getByTestId('turn')).toHaveText(turn ?? '', { timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-07: Turn Alternation After Miss
// ---------------------------------------------------------------------------

test('TC-07: miss switches turn to opponent; own board stays empty', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob)
    // A-1 has no Bob ship (Bob's fleet is entirely in cols F-J, rows 3-7)
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('cell-enemy-A-1')).toHaveAttribute('data-state', 'miss', { timeout: 10_000 })
    await expect(bob.getByTestId('cell-own-A-1')).toHaveAttribute('data-state', 'empty', { timeout: 10_000 })
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
    await expect(bob.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-08: Turn Alternation After Hit (No Extra Turn on Hit)
// ---------------------------------------------------------------------------

test('TC-08: hit does not grant an extra turn — turn passes to opponent', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob, ALICE_DEFAULT, BOB_BATTLESHIP_ROW1)
    // A-1 holds Bob's Battleship
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('cell-enemy-A-1')).toHaveAttribute('data-state', 'hit', { timeout: 10_000 })
    await expect(bob.getByTestId('cell-own-A-1')).toHaveAttribute('data-state', 'hit', { timeout: 10_000 })
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
    await expect(bob.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-09: Out-of-Turn Shot Rejected
// ---------------------------------------------------------------------------

test('TC-09: inactive player shot is rejected; board unchanged', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob)
    // Alice fires a miss; turn passes to Bob
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
    // Alice fires again while it is Bob's turn — should be rejected
    await alice.getByTestId('cell-enemy-B-2').click()
    await expect(alice.getByTestId('shot-error')).toBeVisible({ timeout: 10_000 })
    // B-2 must remain unknown (no state change)
    await expect(alice.getByTestId('cell-enemy-B-2')).toHaveAttribute('data-state', 'unknown')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-10: Already-Shot Cell Rejected
// ---------------------------------------------------------------------------

test('TC-10: firing at an already-shot cell is rejected with "already shot"', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob)
    // Round 1: Alice → A-1 (miss), Bob → J-1 (miss; Alice has no ship in col J)
    await aliceFires(alice, 'A', 1)
    await bobFires(bob, 'J', 1)
    // Alice fires A-1 again
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('shot-error')).toBeVisible({ timeout: 10_000 })
    await expect(alice.getByTestId('shot-error')).toContainText('already shot')
    // State must be unchanged — still miss
    await expect(alice.getByTestId('cell-enemy-A-1')).toHaveAttribute('data-state', 'miss')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-11: Sinking Flips All Ship Cells to Sunk
// ---------------------------------------------------------------------------

test('TC-11: sinking a ship flips all its cells to sunk on both boards', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    // Bob's Battleship: A-1, B-1, C-1, D-1
    await goToBattle(alice, bob, ALICE_DEFAULT, BOB_BATTLESHIP_ROW1)
    // Three hits with Bob responding each time, then the fourth sinks the ship
    await aliceFires(alice, 'A', 1)  // hit
    await bobFires(bob, 'J', 1)
    await aliceFires(alice, 'B', 1)  // hit
    await bobFires(bob, 'J', 2)
    await aliceFires(alice, 'C', 1)  // hit
    await bobFires(bob, 'J', 3)
    // Final hit — Battleship sunk
    await alice.getByTestId('cell-enemy-D-1').click()
    // All four cells must be sunk on both boards
    for (const col of ['A', 'B', 'C', 'D']) {
      await expect(alice.getByTestId(`cell-enemy-${col}-1`)).toHaveAttribute('data-state', 'sunk', { timeout: 12_000 })
      await expect(bob.getByTestId(`cell-own-${col}-1`)).toHaveAttribute('data-state', 'sunk', { timeout: 12_000 })
    }
    // Sinking announcement must appear and name the ship
    await expect(alice.getByTestId('announcement')).toBeVisible({ timeout: 10_000 })
    await expect(alice.getByTestId('announcement')).toContainText('sunk')
    await expect(alice.getByTestId('announcement')).toContainText('Battleship')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-12: Game Over When All Ships Sunk
// ---------------------------------------------------------------------------

test('TC-12: game over when all ships sunk; further shots rejected with "game over"', async ({ browser }) => {
  test.setTimeout(180_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    // Bob: carrier A1-E1, battleship A2-D2, cruiser A3-C3, submarine A4-C4, destroyer A5-B5
    // Alice: all ships in rows 7-10 cols A-E — safe from Bob's return fire in cols I-J
    await goToBattle(alice, bob, ALICE_ROWS7_10, BOB_SINK_ALL)

    const aliceShots: [string, number][] = [
      // Carrier A-1..E-1
      ['A', 1], ['B', 1], ['C', 1], ['D', 1], ['E', 1],
      // Battleship A-2..D-2
      ['A', 2], ['B', 2], ['C', 2], ['D', 2],
      // Cruiser A-3..C-3
      ['A', 3], ['B', 3], ['C', 3],
      // Submarine A-4..C-4
      ['A', 4], ['B', 4], ['C', 4],
      // Destroyer A-5..B-5
      ['A', 5], ['B', 5],
    ]
    // Bob fires into I-J cols where Alice has no ships (safe misses)
    const bobSafeShots: [string, number][] = [
      ['J', 1], ['J', 2], ['J', 3], ['J', 4], ['J', 5],
      ['J', 6], ['J', 7], ['J', 8], ['J', 9], ['J', 10],
      ['I', 1], ['I', 2], ['I', 3], ['I', 4], ['I', 5], ['I', 6],
    ]

    for (let i = 0; i < aliceShots.length; i++) {
      const [col, row] = aliceShots[i]
      await alice.getByTestId(`cell-enemy-${col}-${row}`).click()
      // After every shot except the last, Bob takes his turn
      if (i < aliceShots.length - 1) {
        await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
        const [bc, br] = bobSafeShots[i]
        await bob.getByTestId(`cell-enemy-${bc}-${br}`).click()
        await expect(bob.getByTestId('turn')).toHaveText('Alice', { timeout: 10_000 })
      }
    }

    // Both clients must show finished phase with Alice as winner
    await expect(alice.getByTestId('phase')).toHaveText('finished', { timeout: 15_000 })
    await expect(bob.getByTestId('phase')).toHaveText('finished', { timeout: 15_000 })
    await expect(alice.getByTestId('winner')).toHaveText('Alice', { timeout: 10_000 })
    await expect(bob.getByTestId('winner')).toHaveText('Alice', { timeout: 10_000 })

    // Further shots from Alice must be rejected with "game over"
    await alice.getByTestId('cell-enemy-F-6').click()
    await expect(alice.getByTestId('shot-error')).toBeVisible({ timeout: 10_000 })
    await expect(alice.getByTestId('shot-error')).toContainText('game over')
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-13: Reconnect Mid-Battle Restores Full State
// ---------------------------------------------------------------------------

test('TC-13: reloading and rejoining restores board state, shot history, and turn', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob)
    // Fire 4 shots for a mix of outcomes:
    //   Shot 1 – Alice → A-1 on Bob's board  (miss; Bob has no ship at A-1)
    //   Shot 2 – Bob   → A-3 on Alice's board (hit;  Alice's carrier starts at A-3)
    //   Shot 3 – Alice → B-1 on Bob's board  (miss)
    //   Shot 4 – Bob   → J-1 on Alice's board (miss; Alice has no ship in col J)
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
    await bob.getByTestId('cell-enemy-A-3').click()   // hits Alice's carrier
    await expect(bob.getByTestId('turn')).toHaveText('Alice', { timeout: 10_000 })
    await alice.getByTestId('cell-enemy-B-1').click()
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })
    await bob.getByTestId('cell-enemy-J-1').click()
    await expect(bob.getByTestId('turn')).toHaveText('Alice', { timeout: 10_000 })

    // Capture the current turn label before reload
    const turnBeforeReload = (await alice.getByTestId('turn').textContent())?.trim() ?? 'Alice'

    // Reload Alice's tab; server must keep the game alive
    await alice.reload()

    // Alice re-joins with the same display name
    await expect(alice.getByTestId('lobby')).toBeVisible({ timeout: 15_000 })
    await alice.getByTestId('lobby').locator('input').first().fill('Alice')
    await alice.getByTestId('join-btn').click()

    // Must be restored to battle phase
    await expect(alice.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })

    // Enemy board state
    await expect(alice.getByTestId('cell-enemy-A-1')).toHaveAttribute('data-state', 'miss', { timeout: 10_000 })
    await expect(alice.getByTestId('cell-enemy-B-1')).toHaveAttribute('data-state', 'miss', { timeout: 10_000 })
    // Own board state (Bob hit Alice's carrier at A-3)
    await expect(alice.getByTestId('cell-own-A-3')).toHaveAttribute('data-state', 'hit', { timeout: 10_000 })

    // Shot history contains 4 ordered entries
    await expect(alice.getByTestId('shot-1')).toBeVisible({ timeout: 10_000 })
    await expect(alice.getByTestId('shot-2')).toBeVisible()
    await expect(alice.getByTestId('shot-3')).toBeVisible()
    await expect(alice.getByTestId('shot-4')).toBeVisible()

    // Turn matches pre-reload state
    await expect(alice.getByTestId('turn')).toHaveText(turnBeforeReload, { timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-14: Concurrent Ready Does Not Corrupt Game State
// ---------------------------------------------------------------------------

test('TC-14: simultaneous ready clicks produce exactly one clean battle transition', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToSetup(alice, bob)
    await placeFleet(alice, ALICE_DEFAULT)
    await expect(alice.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
    await placeFleet(bob, BOB_DEFAULT)
    await expect(bob.getByTestId('ready-btn')).toBeEnabled({ timeout: 8_000 })
    // Fire both ready clicks in the same event-loop tick
    await Promise.all([
      alice.getByTestId('ready-btn').click(),
      bob.getByTestId('ready-btn').click(),
    ])
    await expect(alice.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
    await expect(bob.getByTestId('phase')).toHaveText('battle', { timeout: 15_000 })
    // Exactly one player's name must appear in the turn indicator on both clients
    const turn = (await alice.getByTestId('turn').textContent({ timeout: 10_000 }))?.trim()
    expect(['Alice', 'Bob']).toContain(turn)
    await expect(bob.getByTestId('turn')).toHaveText(turn ?? '', { timeout: 10_000 })
  } finally {
    await cleanup()
  }
})

// ---------------------------------------------------------------------------
// TC-15: Reset Clears All State
// ---------------------------------------------------------------------------

test('TC-15: reset returns both clients to lobby; state persists across reload', async ({ browser }) => {
  test.setTimeout(90_000)
  const { alice, bob, cleanup } = await createContexts(browser)
  try {
    await goToBattle(alice, bob)
    // Fire at least one shot so there is real game state to wipe
    await alice.getByTestId('cell-enemy-A-1').click()
    await expect(alice.getByTestId('turn')).toHaveText('Bob', { timeout: 10_000 })

    // Reset from Alice's context
    await alice.getByTestId('reset-btn').click()
    await expect(alice.getByTestId('phase')).toHaveText('lobby', { timeout: 12_000 })
    await expect(bob.getByTestId('phase')).toHaveText('lobby', { timeout: 12_000 })
    await expect(alice.getByTestId('lobby')).toBeVisible()
    await expect(bob.getByTestId('lobby')).toBeVisible()

    // Reload both pages and verify lobby persists (no stale game in DB)
    await Promise.all([alice.reload(), bob.reload()])
    await expect(alice.getByTestId('phase')).toHaveText('lobby', { timeout: 15_000 })
    await expect(bob.getByTestId('phase')).toHaveText('lobby', { timeout: 15_000 })
    await expect(alice.getByTestId('lobby')).toBeVisible({ timeout: 10_000 })
    await expect(bob.getByTestId('lobby')).toBeVisible({ timeout: 10_000 })
  } finally {
    await cleanup()
  }
})
