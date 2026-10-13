const { test, expect } = require('@playwright/test');
const { createServer } = require('../server.cjs');

async function startServer(deckDurationMs = 30_000) {
  const app = createServer({ deckDurationMs, reconnectGraceMs: 5_000 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}` };
}

async function openPlayer(browser, url, nickname) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__multiplayerPackets = [];
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', event => {
          try { window.__multiplayerPackets.push(JSON.parse(event.data)); }
          catch {}
        });
      }
    };
  });
  await page.goto(url);
  await expect(page.locator('#mp-create')).toBeEnabled();
  await page.locator('#mp-nickname').fill(nickname);
  return { context, page, errors };
}

function latestGame(page) {
  return page.evaluate(() => window.__multiplayerPackets.findLast(packet => packet.type === 'game')?.game || null);
}

async function waitForGame(page, predicate = 'game.round === 1 && !game.prompt && game.waitingFor === null') {
  await page.waitForFunction(expression => {
    const game = window.__multiplayerPackets.findLast(packet => packet.type === 'game')?.game;
    return game && new Function('game', `return ${expression}`)(game);
  }, predicate);
}

async function createAndJoin(host, guest, roomName, useRoomList = true) {
  await host.locator('#mp-room-name').fill(roomName);
  await host.locator('#mp-create').click();
  await expect(host.locator('#mp-waiting')).toBeVisible();
  const code = await host.locator('#mp-waiting-code').textContent();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  if (useRoomList) {
    await guest.getByRole('button', { name: `Войти в комнату ${roomName}`, exact: true }).click();
  } else {
    await guest.locator('#mp-room-code').fill(code);
    await guest.locator('#mp-join').click();
  }
  await expect(host.locator('body')).toHaveAttribute('data-mp-mode', 'deck');
  await expect(guest.locator('body')).toHaveAttribute('data-mp-mode', 'deck');
  return code;
}

async function keepOpeningHands(host, guest) {
  await waitForGame(host, 'game.prompt?.kind === "cards" && game.prompt.canSkip');
  await host.locator('[data-mp-action="choice"][data-mp-option=""]').click();
  await waitForGame(guest, 'game.prompt?.kind === "cards" && game.prompt.canSkip');
  await guest.locator('[data-mp-action="choice"][data-mp-option=""]').click();
  await Promise.all([waitForGame(host), waitForGame(guest)]);
}

test('two browsers create a public room, select decks, play, resume after reload, and finish a shared match', async ({ browser }) => {
  const app = await startServer();
  const players = [];
  try {
    players.push(await openPlayer(browser, app.url, 'Геральт'));
    players.push(await openPlayer(browser, app.url, 'Йеннифэр'));
    const [host, guest] = players.map(player => player.page);
    await createAndJoin(host, guest, 'Белый сад');
    for (const page of [host, guest]) {
      await expect(page.locator('#mp-countdown')).toHaveText(/^(2[5-9]|30)$/);
      await expect(page.locator('#deck-customization')).toBeVisible();
    }
    await host.locator('#start-game').click();
    await expect(host.locator('#start-game')).toBeDisabled();
    await expect(guest.locator('#mp-deck-ready')).toContainText('Соперник готов');
    await guest.locator('#start-game').click();
    await keepOpeningHands(host, guest);

    const initial = await latestGame(host);
    expect(initial.hand).toHaveLength(10);
    expect(initial.players.every(player => !Object.hasOwn(player, 'hand'))).toBe(true);
    const currentSeat = initial.turn;
    const mover = [host, guest][currentSeat];
    const waiting = [host, guest][1 - currentSeat];
    await expect(mover.locator('#pass-button')).not.toHaveClass(/noclick/);
    await expect(waiting.locator('#pass-button')).toHaveClass(/noclick/);

    const unit = await mover.evaluate(() => {
      const game = window.__multiplayerPackets.findLast(packet => packet.type === 'game').game;
      const card = game.hand.find(card => {
        const info = card_dict[card.index];
        return ['close', 'ranged', 'siege', 'agile'].includes(info.row) &&
          !info.ability.includes('medic') && !info.ability.includes('spy');
      });
      const info = card_dict[card.index];
      return { id: card.id, row: info.row === 'agile' ? 'close' : info.row };
    });
    await mover.locator(`#hand-row [data-mp-card="${unit.id}"]`).click();
    await mover.locator(`#field-me [data-row="${unit.row}"] .row-cards`).click();
    await Promise.all([host, guest].map(page => waitForGame(page, `game.turn === ${1 - currentSeat} && game.canAct !== undefined`)));
    const afterPlay = await latestGame(host);
    expect(afterPlay.players[currentSeat].handCount).toBe(9);
    expect(afterPlay.rows.some(row => row.seat === currentSeat && row.cards.some(card => card.id === unit.id))).toBe(true);
    expect((await latestGame(guest)).rows).toEqual(afterPlay.rows);
    await expect(mover.locator(`#field-me [data-row="${unit.row}"] [data-mp-card="${unit.id}"]`)).toBeVisible();
    await expect(waiting.locator(`#field-op [data-row="${unit.row}"] [data-mp-card="${unit.id}"]`)).toBeVisible();

    await mover.reload();
    await waitForGame(mover, `game.turn === ${1 - currentSeat} && game.round === 1`);
    await expect(mover.locator('body')).toHaveAttribute('data-mp-mode', 'playing');
    await expect(mover.locator(`#field-me [data-row="${unit.row}"] [data-mp-card="${unit.id}"]`)).toBeVisible();
    expect((await latestGame(mover)).rows).toEqual(afterPlay.rows);

    for (let step = 0; step < 8; step++) {
      const game = await latestGame(host);
      if (game.phase === 'finished') break;
      const acting = [host, guest][game.turn];
      await waitForGame(acting, 'game.canAct === true');
      await acting.locator('#pass-button').click();
      await expect.poll(async () => {
        const states = await Promise.all([host, guest].map(latestGame));
        return states.every(state => state.revision > game.revision) && states[0].revision === states[1].revision &&
          (states[0].phase === 'finished' || states.some(state => state.canAct));
      }).toBe(true);
    }
    await Promise.all([host, guest].map(page => waitForGame(page, 'game.phase === "finished"')));
    const result = await latestGame(host);
    expect(result.history).toHaveLength(2);
    expect(result.winner).toBe(currentSeat);
    expect((await latestGame(guest)).history).toEqual(result.history);
    for (const page of [host, guest]) {
      await expect(page.locator('#end-screen')).toBeVisible();
      await expect(page.locator('#end-screen table')).toContainText('Геральт');
      await expect(page.locator('#end-screen table')).toContainText('Йеннифэр');
    }
    await host.locator('[data-mp-action="leave"]').click();
    await expect(host.locator('body')).toHaveAttribute('data-mp-mode', 'lobby');
    await expect(guest.locator('body')).toHaveAttribute('data-mp-mode', 'lobby');
    expect(players.flatMap(player => player.errors)).toEqual([]);
  } finally {
    await Promise.all(players.map(player => player.context.close()));
    await app.close();
  }
});

test('the snapshot renderer supports units, leaders, weather, horns, and decoy targets', async ({ browser }) => {
  const app = await startServer();
  let player;
  try {
    player = await openPlayer(browser, app.url, 'Тест карт');
    const page = player.page;
    await page.evaluate(() => {
      const card = (id, index, holder = 0) => ({ id, index, holder, power: Number(card_dict[index].strength) });
      const leader = seat => card(`leader-${seat}`, 22, seat);
      window.__renderCommands = [];
      window.__renderer = new MultiplayerGame({
        sendAction: action => window.__renderCommands.push(action), onLeave() {}
      });
      window.__renderState = {
        revision: 1, phase: 'playing', round: 1, turn: 0, canAct: true, waitingFor: null,
        players: [0, 1].map(seat => ({ name: `Игрок ${seat + 1}`, faction: 'realms', leader: leader(seat),
          health: 2, total: seat === 0 ? 6 : 0, passed: false, leaderAvailable: true,
          handCount: seat === 0 ? 4 : 10, deckCount: 20, grave: [] })),
        hand: [card('decoy', 1), card('frost', 2), card('clear', 4), card('horn', 5)],
        rows: [0, 1].flatMap(seat => ['close', 'ranged', 'siege'].map(row => ({
          seat, row, total: seat === 0 && row === 'siege' ? 6 : 0,
          cards: seat === 0 && row === 'siege' ? [card('unit', 27)] :
            seat === 1 && row === 'close' ? [card('enemy-unit', 27, 1), card('enemy-hero', 3, 1)] : [],
          special: null, weather: false, weatherClass: ''
        }))),
        weather: [card('weather', 9, 1)], prompt: null, history: [], winner: null,
      };
      document.body.dataset.mpMode = 'playing';
      document.getElementById('mp-lobby').hidden = true;
      window.__renderer.render(window.__renderState, 0);
    });
    await expect(page.locator('#hand-row .card')).toHaveCount(4);
    await expect(page.locator('#weather .card')).toHaveCount(1);
    await expect(page.locator('#leader-me .card')).toBeVisible();
    await page.locator('#field-op [data-mp-card="enemy-unit"]').click();
    await expect(page.locator('.card-preview .card-lg')).toBeVisible();
    await expect(page.locator('.card-preview .card-lg')).toHaveCSS('background-image', /ballista/);
    await page.locator('[data-mp-action="preview-close"]').click();
    await page.locator('#field-op [data-mp-card="enemy-hero"]').click();
    await expect(page.locator('.card-preview .card-lg')).toBeVisible();
    await expect(page.locator('.card-preview .card-lg')).toHaveCSS('background-image', /ciri/);
    await page.locator('[data-mp-action="preview-close"]').click();
    await page.locator('#hand-row [data-mp-card="frost"]').click();
    await page.locator('[data-mp-action="play-selected"]').click();
    expect(await page.evaluate(() => window.__renderCommands[0])).toEqual({ kind: 'play', card: 'frost' });
    await page.evaluate(() => window.__renderer.render(window.__renderState, 0));
    await page.locator('#hand-row [data-mp-card="horn"]').click();
    await page.locator('#field-me [data-row="close"] .row-special').click();
    expect(await page.evaluate(() => window.__renderCommands[1])).toEqual({ kind: 'play', card: 'horn', row: 'close' });
    await page.evaluate(() => window.__renderer.render(window.__renderState, 0));
    await page.locator('#hand-row [data-mp-card="decoy"]').click();
    await page.locator('#field-me [data-mp-card="unit"]').click();
    expect(await page.evaluate(() => window.__renderCommands[2])).toEqual({ kind: 'play', card: 'decoy', row: 'siege', target: 'unit' });
    expect(player.errors).toEqual([]);
  } finally {
    await player?.context.close();
    await app.close();
  }
});

test('server deadline starts both players automatically and a room code also works', async ({ browser }) => {
  const app = await startServer(1_500);
  const players = [];
  try {
    players.push(await openPlayer(browser, app.url, 'Ламберт'));
    players.push(await openPlayer(browser, app.url, 'Эскель'));
    const [host, guest] = players.map(player => player.page);
    await createAndJoin(host, guest, 'Автоматический старт', false);
    await expect(host.locator('#mp-countdown')).toHaveText(/^[0-2]$/);
    await keepOpeningHands(host, guest);
    await expect(host.locator('body')).toHaveAttribute('data-mp-mode', 'playing');
    await expect(guest.locator('body')).toHaveAttribute('data-mp-mode', 'playing');
    expect((await latestGame(host)).hand).toHaveLength(10);
    expect((await latestGame(guest)).hand).toHaveLength(10);
    expect(players.flatMap(player => player.errors)).toEqual([]);
  } finally {
    await Promise.all(players.map(player => player.context.close()));
    await app.close();
  }
});
