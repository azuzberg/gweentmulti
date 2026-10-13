'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { validateDeck } = require('./decks.cjs');

const publicDir = path.join(__dirname, '../public');
const scripts = ['common.js', 'cards.js', 'decks.js', 'abilities.js', 'factions.js', 'gwent.js']
  .map(name => new vm.Script(fs.readFileSync(path.join(publicDir, name), 'utf8')
    .replace('let dm = new DeckMaker();', 'let dm;'), { filename: name }));
const adapter = new vm.Script(fs.readFileSync(path.join(__dirname, 'engine-adapter.js'), 'utf8'),
  { filename: 'engine-adapter.js' });

class GameEngine {
  constructor({ decks, names, onUpdate = () => {}, onError = () => {} }) {
    this.closed = false;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.dom = new JSDOM(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), {
      url: 'http://game.internal/', runScripts: 'outside-only'
    });
    const context = this.dom.getInternalVMContext();
    context.__host = {
      decksJSON: JSON.stringify(decks.map(validateDeck)),
      namesJSON: JSON.stringify(names),
      update: () => { if (!this.closed) this.onUpdate(); },
      error: error => { if (!this.closed) this.onError(error); }
    };
    for (const script of scripts) script.runInContext(context);
    this.api = adapter.runInContext(context);
  }
  start() { this.api.start(); }
  snapshot(seat) { return this.api.snapshot(seat); }
  act(seat, action) { this.api.act(seat, action); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.api.close();
    this.dom.window.close();
  }
}

module.exports = { GameEngine };
