'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalogue = vm.createContext({});
for (const file of ['cards.js', 'decks.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), catalogue);
}
const { cards, presets } = vm.runInContext('({cards: card_dict, presets: premade_deck.map(d => JSON.parse(d))})', catalogue);
const FACTIONS = new Set(['realms', 'nilfgaard', 'monsters', 'scoiatael', 'skellige']);

function validateDeck(input) {
  if (!input || !FACTIONS.has(input.faction) || !Number.isInteger(input.leader)) {
    throw new Error('Выберите фракцию и лидера.');
  }
  const leader = cards[input.leader];
  if (!leader || leader.row !== 'leader' || leader.deck !== input.faction) {
    throw new Error('Лидер должен принадлежать выбранной фракции.');
  }
  if (!Array.isArray(input.cards) || input.cards.length > cards.length) {
    throw new Error('Неверный формат колоды.');
  }
  let units = 0, special = 0;
  const seen = new Set();
  const entries = input.cards.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error('Неверный формат карты.');
    const [index, count] = entry;
    const card = cards[index];
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || !card ||
        card.row === 'leader' || seen.has(index) || count > Number(card.count) ||
        ![input.faction, 'neutral', 'special', 'weather'].includes(card.deck)) {
      throw new Error('Колода содержит недопустимую карту или число копий.');
    }
    seen.add(index);
    if (['special', 'weather'].includes(card.deck)) special += count;
    else units += count;
    return [index, count];
  });
  if (units < 22) throw new Error('В колоде должно быть не менее 22 карт отрядов.');
  if (special > 10) throw new Error('В колоде может быть не более 10 специальных карт.');
  return { faction: input.faction, leader: input.leader, cards: entries };
}

function defaultDeck(faction = 'realms') {
  const preset = presets.find(deck => deck.faction === faction) || presets[0];
  return validateDeck(JSON.parse(JSON.stringify(preset)));
}

module.exports = { validateDeck, defaultDeck, cards };
