'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { GameEngine } = require('../server/game-engine.cjs');
const { defaultDeck, validateDeck, cards } = require('../server/decks.cjs');

const pause = () => new Promise(resolve => setTimeout(resolve, 1));
async function waitFor(engine, predicate) {
  const limit = Date.now() + 4000;
  while (Date.now() < limit) {
    if (engine.testError) throw engine.testError;
    const state = engine.snapshot(0);
    if (predicate(state)) return state;
    await pause();
  }
  throw new Error('No game progress: ' + JSON.stringify(engine.snapshot(0)));
}
function create(t, decks = [defaultDeck(), defaultDeck('nilfgaard')]) {
  let engine;
  engine = new GameEngine({ decks, names: ['Первый', 'Второй'], onError: e => engine.testError = e });
  t.after(() => engine.close());
  engine.start();
  return engine;
}
async function settle(engine) {
  for (let i = 0; i < 30; i++) {
    const state = await waitFor(engine, state => state.waitingFor !== null || state.players.some((_, seat) => engine.snapshot(seat).canAct) || state.phase === 'finished');
    if (state.waitingFor === null) return state;
    const seat = state.waitingFor;
    const prompt = engine.snapshot(seat).prompt;
    const option = prompt.canSkip ? null : typeof prompt.options[0] === 'string' ? prompt.options[0] : prompt.options[0].id;
    engine.act(seat, { kind: 'choice', promptId: prompt.id, option });
  }
  throw new Error('Too many nested decisions');
}
async function turn(engine, action) {
  const state = await settle(engine);
  engine.act(state.turn, action);
  return settle(engine);
}

function arrange(engine, javascript) {
  vm.runInContext(javascript, engine.dom.getInternalVMContext());
}

async function play(engine, seat, index, row, target) {
  const state = engine.snapshot(seat);
  const card = state.hand.find(card => card.index === index);
  assert.ok(card, 'fixture card ' + index);
  engine.act(seat, {kind: 'play', card: card.id, row, target});
  return settle(engine);
}

test('deck validation enforces faction, card inventory and 22-unit/10-special rules', () => {
  for (const faction of ['realms', 'nilfgaard', 'monsters', 'scoiatael', 'skellige']) {
    assert.equal(validateDeck(defaultDeck(faction)).faction, faction);
  }
  const valid = defaultDeck();
  assert.throws(() => validateDeck({ ...valid, leader: defaultDeck('nilfgaard').leader }), /Лидер/);
  assert.throws(() => validateDeck({ ...valid, cards: [[27, 1]] }), /22/);
  assert.throws(() => validateDeck({ ...valid, cards: [...valid.cards, valid.cards[0]] }), /копий/);
  assert.throws(() => validateDeck({ ...valid, cards: [[27, 100], ...valid.cards] }), /копий/);
  assert.throws(() => validateDeck({ ...valid, cards: [...valid.cards, [defaultDeck('nilfgaard').leader, 1]] }), /копий/);
  assert.throws(() => validateDeck({ ...valid, cards: [...valid.cards, [9999, 1]] }), /копий/);
});

test('mulligan prompts and hands are private, including validation of forged choices', async t => {
  const engine = create(t);
  await waitFor(engine, state => state.waitingFor === 0);
  const our = engine.snapshot(0), their = engine.snapshot(1);
  assert.equal(our.hand.length, 10);
  assert.equal(their.hand.length, 10);
  assert.equal(their.prompt, null);
  assert.equal(our.prompt.remaining, 2);
  assert.equal(our.players[1].hand, undefined);
  assert.equal(our.players[1].deck, undefined);
  assert.ok(our.hand.every(card => !their.hand.some(other => other.id === card.id)));
  assert.throws(() => engine.act(1, {kind: 'choice', promptId: our.prompt.id, option: null}), /выбор/);
  assert.throws(() => engine.act(0, {kind: 'choice', promptId: our.prompt.id, option: 'forged'}), /выбор/);
  const first = our.prompt.options[0];
  engine.act(0, {kind: 'choice', promptId: our.prompt.id, option: first.id});
  await waitFor(engine, state => state.prompt?.id !== our.prompt.id && state.prompt?.remaining === 1);
  assert.equal(engine.snapshot(0).hand.length, 10);
  assert.ok(!engine.snapshot(0).hand.some(card => card.id === first.id));
  await settle(engine);
  assert.equal(engine.snapshot(0).round, 1);
});

test('server rejects forged moves, wrong rows, wrong turns, and stale revisions', async t => {
  const engine = create(t);
  const state = await settle(engine), seat = state.turn;
  assert.throws(() => engine.act(1 - seat, {kind: 'pass'}), /другого/);
  assert.throws(() => engine.act(seat, {kind: 'play', card: 'forged', row: 'close'}), /руке/);
  assert.throws(() => engine.act(seat, {kind: 'pass', revision: state.revision - 1}), /обновилось/);
  const hand = engine.snapshot(seat).hand;
  const unit = hand.find(card => !['special','weather'].includes(cards[card.index].deck));
  assert.ok(unit);
  assert.throws(() => engine.act(seat, {kind: 'play', card: unit.id, row: 'forged'}), /ряд/);
  const row = cards[unit.index].row === 'agile' ? 'close' : cards[unit.index].row;
  engine.act(seat, {kind: 'play', card: unit.id, row});
  const next = await settle(engine);
  assert.equal(next.turn, 1 - seat);
  assert.ok(next.rows.some(row => row.cards.some(card => card.id === unit.id)));
});

test('nicknames remain text and cannot alter the authoritative rules DOM', async t => {
  const name = '<img id="deck-op" src="x">';
  const engine = new GameEngine({decks: [defaultDeck(), defaultDeck()], names: [name, name]});
  t.after(() => engine.close());
  engine.start();
  await settle(engine);
  assert.equal(engine.snapshot(0).players[0].name, name);
  assert.equal(engine.dom.window.document.querySelectorAll('#deck-op').length, 1);
  assert.equal(engine.dom.window.document.getElementById('name-me').textContent, name);
});

test('two human passes end rounds and preserve Nilfgaard tie advantage', async t => {
  const engine = create(t);
  await settle(engine);
  for (let n = 0; n < 4; n++) await turn(engine, {kind: 'pass'});
  const state = engine.snapshot(0);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 1);
  assert.equal(state.history.length, 2);
  assert.equal(state.players[0].health, 0);
  assert.equal(state.players[1].health, 2);
});

test('Scoia’tael first-turn choice is addressed to either human seat', async t => {
  for (const seat of [0, 1]) {
    const decks = [defaultDeck(), defaultDeck()];
    decks[seat] = defaultDeck('scoiatael');
    const engine = create(t, decks);
    await waitFor(engine, state => state.waitingFor === seat);
    const prompt = engine.snapshot(seat).prompt;
    assert.equal(prompt.kind, 'popup');
    engine.act(seat, {kind: 'choice', promptId: prompt.id, option: 'yes'});
    assert.equal((await settle(engine)).turn, seat);
    engine.close();
  }
});

test('weather, clear weather, horns and scorch preserve ordinary strength and hero immunity', async t => {
  const engine = create(t, [defaultDeck(), defaultDeck()]);
  await settle(engine);
  arrange(engine, `
    player_me.hand.reset(); player_op.hand.reset();
    [28,33,5,4].forEach(i => player_me.hand.addCard(new Card(card_dict[i],player_me)));
    [28,2,10,1].forEach(i => player_op.hand.addCard(new Card(card_dict[i],player_op)));
    game.currPlayer = player_me;
  `);
  await play(engine, 0, 28, 'close');
  await play(engine, 1, 28, 'close');
  await play(engine, 0, 33, 'close');
  let state = await play(engine, 1, 2);
  const row = state.rows.find(row => row.seat === 0 && row.row === 'close');
  assert.equal(row.cards.find(card => card.index === 28).power, 1);
  assert.equal(row.cards.find(card => card.index === 33).power, 10);
  assert.equal(row.weather, true);
  state = await play(engine, 0, 5, 'close');
  assert.equal(state.rows.find(row => row.seat === 0 && row.row === 'close').total, 12);
  await play(engine, 1, 10);
  assert.ok(engine.snapshot(0).rows.flatMap(row => row.cards).some(card => card.index === 33));
  state = await play(engine, 0, 4);
  assert.equal(state.weather.length, 0);
  assert.ok(state.rows.every(row => !row.weather));
});

test('spy draws privately, changes sides, and decoy returns a non-hero unit', async t => {
  const engine = create(t, [defaultDeck(), defaultDeck()]);
  await settle(engine);
  arrange(engine, `
    player_me.hand.reset(); player_op.hand.reset();
    [41,1].forEach(i=>player_me.hand.addCard(new Card(card_dict[i],player_me)));
    [1,33].forEach(i=>player_op.hand.addCard(new Card(card_dict[i],player_op)));
    game.currPlayer = player_me;
  `);
  const before = engine.snapshot(0).players[0].deckCount;
  let state = await play(engine, 0, 41, 'close');
  const spy = state.rows.find(row => row.seat === 1 && row.row === 'close').cards.find(card => card.index === 41);
  assert.equal(spy.holder, 1);
  assert.equal(state.players[0].handCount, 3);
  assert.equal(state.players[0].deckCount, before - 2);
  state = await play(engine, 1, 1, 'close', spy.id);
  assert.ok(engine.snapshot(1).hand.some(card => card.id === spy.id));
  assert.equal(state.rows.find(row => row.seat === 1 && row.row === 'close').cards.some(card => card.id === spy.id), false);
});

test('remote human medic chooses an agile grave unit and its combat row', async t => {
  const engine = create(t, [defaultDeck(), defaultDeck('scoiatael')]);
  await settle(engine);
  arrange(engine, `
    player_op.hand.reset(); player_op.grave.reset();
    player_op.hand.addCard(new Card(card_dict[32],player_op));
    player_op.grave.addCard(new Card(card_dict[144],player_op));
    game.currPlayer = player_op;
  `);
  const medic = engine.snapshot(1).hand[0];
  engine.act(1, {kind: 'play', card: medic.id, row: 'siege'});
  await waitFor(engine, state => state.waitingFor === 1);
  let prompt = engine.snapshot(1).prompt;
  assert.equal(engine.snapshot(0).prompt, null);
  assert.equal(prompt.options[0].index, 144);
  engine.act(1, {kind: 'choice', promptId: prompt.id, option: prompt.options[0].id});
  await waitFor(engine, state => engine.snapshot(1).prompt?.kind === 'row');
  prompt = engine.snapshot(1).prompt;
  engine.act(1, {kind: 'choice', promptId: prompt.id, option: 'ranged'});
  const state = await settle(engine);
  assert.ok(state.rows.find(row => row.seat === 1 && row.row === 'ranged').cards.some(card => card.index === 144));
  assert.equal(state.players[1].grave.length, 0);
});

test('representative games complete for all faction pairings without local AI', async t => {
  const factions = ['realms', 'nilfgaard', 'monsters', 'scoiatael', 'skellige'];
  for (const a of factions) for (const b of factions) {
    const engine = create(t, [defaultDeck(a), defaultDeck(b)]);
    await settle(engine);
    for (let actions = 0; actions < 120 && engine.snapshot(0).phase !== 'finished'; actions++) {
      const state = await settle(engine), seat = state.turn;
      const own = engine.snapshot(seat);
      // Exercise real placement/effects before preserving the remaining hand for later rounds.
      const entry = own.hand.find(card => !['special','weather'].includes(cards[card.index].deck));
      const shouldPlay = entry && own.rows.filter(row => row.seat === seat).flatMap(row => row.cards).length < 3;
      if (shouldPlay) {
        const row = cards[entry.index].row === 'agile' ? 'close' : cards[entry.index].row;
        await turn(engine, {kind: 'play', card: entry.id, row});
      } else await turn(engine, {kind: 'pass'});
    }
    assert.equal(engine.snapshot(0).phase, 'finished', a + ' vs ' + b);
    assert.ok(engine.snapshot(0).history.length >= 2);
    engine.close();
  }
});

test('every activated leader runs with server prompts for either human', async t => {
  for (const index of cards.map((card, index) => card.row === 'leader' ? index : -1).filter(index => index >= 0)) {
    for (const seat of [0, 1]) {
      const deck = defaultDeck(cards[index].deck);
      deck.leader = index;
      const decks = [defaultDeck(), defaultDeck()];
      decks[seat] = deck;
      const engine = create(t, decks);
      let state = await settle(engine);
      if (state.turn !== seat) state = await turn(engine, {kind: 'pass'});
      if (engine.snapshot(seat).players[seat].leaderAvailable) {
        await turn(engine, {kind: 'leader'});
        assert.equal(engine.snapshot(seat).players[seat].leaderAvailable, false, 'leader ' + index);
      }
      engine.close();
    }
  }
});
