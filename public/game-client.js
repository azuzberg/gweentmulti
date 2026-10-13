/* The browser displays server state. The original engine remains the deck editor. */
(() => {
  'use strict';

  const ROW_LABELS = { close: 'Ближний бой', ranged: 'Дальний бой', siege: 'Осадный ряд' };
  const byId = id => document.getElementById(id);
  const addText = (parent, tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    parent.appendChild(element);
    return element;
  };

  class MultiplayerGame {
    constructor({ sendAction, onLeave }) {
      this.sendAction = sendAction;
      this.onLeave = onLeave;
      this.main = document.querySelector('main');
      this.active = false;
      this.selected = null;
      this.cards = new Map();
      this.installStyles();

      this.status = addText(this.main, 'div', '', 'mp-game-status hide');
      this.status.setAttribute('role', 'status');
      this.status.setAttribute('aria-live', 'polite');
      this.overlay = document.createElement('section');
      this.overlay.className = 'mp-game-overlay hide';
      this.overlay.setAttribute('role', 'dialog');
      this.overlay.setAttribute('aria-modal', 'true');
      this.overlay.setAttribute('aria-labelledby', 'mp-prompt-title');
      this.main.appendChild(this.overlay);
      this.preview = this.main.querySelector('.card-preview');
      this.previewControls = document.createElement('div');
      this.previewControls.className = 'mp-preview-controls';
      this.preview.appendChild(this.previewControls);

      // Capture before the upstream listeners: no browser-side rule or AI code runs.
      this.main.addEventListener('click', event => this.handleClick(event), true);
      this.main.addEventListener('keydown', event => {
        if (!this.active) return;
        if (event.key === 'Escape' && !this.snapshot?.prompt) {
          this.hidePreview();
          this.hideOverlay();
          this.highlightRows();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    installStyles() {
      if (byId('mp-game-style')) return;
      const style = document.createElement('style');
      style.id = 'mp-game-style';
      style.textContent = `
        .mp-game-status { position:absolute; z-index:81; top:1.1vw; left:31%; width:43%;
          text-align:center; padding:.55vw 1vw; font-size:1.15vw; color:tan;
          background:rgba(10,10,10,.9); border:1px solid #66512c; pointer-events:none; }
        .mp-game-status.is-turn { color:goldenrod; }
        .mp-game-overlay { position:absolute; inset:0; z-index:1001; display:flex;
          align-items:center; justify-content:center; background:rgba(10,10,10,.95); }
        .mp-game-overlay.hide { display:none; }
        .mp-prompt-panel { width:86%; max-height:94%; text-align:center; padding:1.3vw;
          border:.15vw solid #66512c; background:rgba(20,20,20,.98); box-shadow:0 0 3vw #000; }
        .mp-prompt-panel h2 { font-size:1.65vw; color:goldenrod; font-weight:normal; margin:.2vw 0 .7vw; }
        .mp-prompt-panel p { font-size:1.05vw; line-height:1.5; color:tan; margin:.5vw; }
        .mp-choices { display:flex; gap:1.1vw; overflow:auto; max-height:33vw;
          padding:1vw .6vw; align-items:flex-start; justify-content:safe center; }
        .mp-card-choice { flex:0 0 9.6vw; border:0; padding:.3vw; background:#111;
          color:tan; font-size:.8vw; text-align:center; }
        .mp-card-choice:hover, .mp-card-choice:focus-visible { outline:.15vw solid goldenrod; }
        .mp-card-choice .card-lg { width:9vw; height:17vw; border-radius:.8vw; display:block; }
        .mp-card-choice span { display:block; margin:.5vw 0; }
        .mp-game-button { color:goldenrod; background:#141414; border:.15vw solid #66512c;
          font-size:1.05vw; padding:.5vw 1.1vw; margin:.4vw; }
        .mp-game-button:hover, .mp-game-button:focus-visible { border-color:goldenrod; background:#28221a; }
        .mp-game-button:disabled, .mp-card-choice:disabled { opacity:.45; }
        .mp-preview-controls { position:absolute; top:9vw; left:79.3vw; width:18.1vw;
          display:flex; align-items:center; justify-content:center; }
        .mp-preview-controls .mp-game-button { font-size:.9vw; padding:.35vw .65vw; }
        .mp-selected-card { outline:.15vw solid goldenrod; box-shadow:0 0 1vw #ad8225; }
        .mp-board-active #hand-row .card { cursor:pointer; }
        .mp-board-active #field-op .card, .mp-board-active #field-me .card { pointer-events:auto; }
        .mp-board-active #pass-button { cursor:pointer; }
        .mp-board-active #deck-me, .mp-board-active #deck-op { pointer-events:none; }
        .mp-board-active .card-preview { pointer-events:none; }
        .mp-board-active .mp-preview-controls { pointer-events:auto; }
        .mp-board-active #end-screen > button[data-mp-action="leave"] { left:40%; width:20%; }
      `;
      document.head.appendChild(style);
    }

    cardModel(data) {
      const holder = data.holder == null ? null : {
        id: data.holder,
        tag: data.holder === this.seat ? 'me' : 'op'
      };
      const card = new Card(card_dict[data.index], holder);
      card.mpData = data;
      card.elem.dataset.mpCard = data.id;
      if (['close', 'ranged', 'siege', 'agile'].includes(card.row)) card.setPower(data.power);
      this.cards.set(data.id, card);
      return card;
    }

    fillCards(container, data, context, overlap = 10) {
      container.replaceChildren();
      for (const entry of data) {
        const card = this.cardModel(entry);
        card.elem.dataset.mpContext = context;
        container.appendChild(card.elem);
      }
      if (container.classList.contains('card-container')) {
        // The upstream layout formula preserves the original hand/row spacing.
        new CardContainer(container).resizeCardContainer(overlap, .075, .00325);
      }
    }

    render(snapshot, seat) {
      this.snapshot = snapshot;
      this.seat = seat;
      if (!this.active) EventManager.gameOpened.dispatch();
      this.active = true;
      this.busy = false;
      this.main.classList.remove('noclick');
      this.main.classList.add('mp-board-active');
      this.status.classList.remove('hide');
      byId('deck-customization').classList.add('hide');
      byId('carousel').classList.add('hide');
      byId('popup').classList.add('hide');
      byId('notification-bar').classList.add('hide');
      byId('click-background').classList.add('noclick');
      this.cards.clear();

      snapshot.players.forEach((player, index) => this.renderPlayer(player, index === seat ? 'me' : 'op'));
      this.fillCards(byId('hand-row'), snapshot.hand, 'hand', 11);
      for (const row of snapshot.rows) {
        const tag = row.seat === seat ? 'me' : 'op';
        const element = document.querySelector(`#field-${tag} [data-row="${row.row}"]`);
        element.dataset.mpSeat = String(row.seat);
        element.dataset.mpRow = row.row;
        element.querySelector('.row-score').textContent = String(row.total);
        this.fillCards(element.querySelector('.row-cards'), row.cards, 'board');
        this.fillCards(element.querySelector('.row-special'), row.special ? [row.special] : [], 'board');
        const overlay = element.querySelector('.row-weather');
        overlay.className = `row-weather${row.weather && row.weatherClass ? ` ${row.weatherClass}` : ''}`;
        overlay.style.opacity = row.weather ? '1' : '0';
      }
      this.fillCards(byId('weather'), snapshot.weather, 'board', 4);

      const ourTurn = snapshot.turn === seat && snapshot.phase === 'playing' && !snapshot.prompt && snapshot.canAct !== false;
      this.status.classList.toggle('is-turn', ourTurn);
      this.status.textContent = snapshot.phase === 'finished' ? 'Партия завершена' :
        snapshot.prompt ? (snapshot.prompt.title || 'Выберите действие') :
        snapshot.waitingFor != null ? 'Соперник выбирает действие…' :
        snapshot.round ? `Раунд ${snapshot.round} · ${ourTurn ? 'Ваш ход' : 'Ход соперника'}` : 'Подготовка к партии';
      byId('pass-button').textContent = 'Пас';
      byId('pass-button').classList.toggle('noclick', !ourTurn);
      byId('pass-button').dataset.mpAction = 'pass';
      byId('exit-game').dataset.mpAction = 'exit';
      byId('exit-game').setAttribute('data-title', 'Выйти из партии');

      if (!ourTurn || !snapshot.hand.some(card => card.id === this.selected)) this.hidePreview();
      else if (this.selected) this.showPreview(this.cards.get(this.selected), true);
      this.highlightRows();
      this.renderPrompt(snapshot.prompt);
      this.overlay.querySelectorAll('button').forEach(button => button.disabled = false);
      this.renderEnd(snapshot);
    }

    renderPlayer(player, tag) {
      byId(`name-${tag}`).textContent = player.name;
      byId(`deck-name-${tag}`).textContent = factions[player.faction].name;
      const profile = document.querySelector(`#stats-${tag} .profile-img > div > div`);
      profile.style.backgroundImage = iconURL(`deck_shield_${player.faction}`);
      byId(`hand-count-${tag}`).textContent = String(player.handCount);
      byId(`score-total-${tag}`).firstElementChild.textContent = String(player.total);
      const opponent = this.snapshot.players[tag === 'me' ? 1 - this.seat : this.seat];
      byId(`score-total-${tag}`).classList.toggle('score-leader', player.total > opponent.total);
      byId(`passed-${tag}`).classList.toggle('passed', player.passed);
      byId(`passed-${tag}`).textContent = 'Пас';
      for (let gem = 1; gem <= 2; gem++) byId(`gem${gem}-${tag}`).classList.toggle('gem-on', player.health >= gem);
      const index = tag === 'me' ? this.seat : 1 - this.seat;
      byId(`stats-${tag}`).classList.toggle('current-turn', this.snapshot.turn === index);
      const leader = byId(`leader-${tag}`);
      this.fillCards(leader.firstElementChild, [player.leader], `leader-${tag}`);
      leader.firstElementChild.classList.toggle('fade', !player.leaderAvailable);
      leader.children[1].classList.toggle('hide', !player.leaderAvailable || this.snapshot.turn !== index);
      leader.dataset.mpLeader = tag;
      leader.setAttribute('data-title', tag === 'me' ? 'Способность лидера' : 'Лидер соперника');

      const deck = byId(`deck-${tag}`);
      deck.replaceChildren();
      // A count and card back suffice: the opponent's private cards never reach the browser.
      if (player.deckCount) {
        const back = document.createElement('div');
        back.className = 'deck-card';
        back.style.backgroundImage = iconURL(`deck_back_${player.faction}`, 'jpg');
        deck.appendChild(back);
      }
      addText(deck, 'div', String(player.deckCount), 'deck-counter center');
      const grave = byId(`grave-${tag}`);
      this.fillCards(grave, player.grave, `grave-${tag}`);
      [...grave.children].forEach((card, index) => card.style.left = `${-.03 * index}vw`);
      grave.dataset.mpGrave = tag;
    }

    canAct() {
      return !this.busy && this.snapshot?.phase === 'playing' &&
        this.snapshot.turn === this.seat && !this.snapshot.prompt && this.snapshot.canAct !== false;
    }

    allowedRows(card) {
      if (!card) return [];
      if (card.faction === 'weather' || card.name === 'Scorch' || card.name === 'Decoy') return [];
      const target = card.abilities.includes('spy') ? 1 - this.seat : this.seat;
      const rows = card.isSpecial() ? ['close', 'ranged', 'siege'] :
        card.row === 'agile' ? ['close', 'ranged'] : [card.row];
      return this.snapshot.rows.filter(row => row.seat === target && rows.includes(row.row) &&
        (!card.isSpecial() || !row.special));
    }

    highlightRows() {
      const card = this.selected ? this.cards.get(this.selected) : null;
      const allowed = this.canAct() ? this.allowedRows(card) : [];
      for (const rowElement of this.main.querySelectorAll('.field-row')) {
        rowElement.classList.remove('noclick', 'row-selectable');
        const legal = allowed.some(row => row.seat === Number(rowElement.dataset.mpSeat) && row.row === rowElement.dataset.mpRow);
        rowElement.querySelector('.row-cards').classList.toggle('row-selectable', legal && !card?.isSpecial());
        rowElement.querySelector('.row-special').classList.toggle('row-selectable', legal && !!card?.isSpecial());
        rowElement.querySelector('.row-cards').classList.remove('noclick');
        rowElement.querySelector('.row-special').classList.remove('noclick');
      }
      for (const element of this.main.querySelectorAll('[data-mp-card]')) {
        const model = this.cards.get(element.dataset.mpCard);
        const decoyTarget = this.canAct() && card?.name === 'Decoy' && element.dataset.mpContext === 'board' &&
          model?.isUnit() && element.closest('.field-row')?.dataset.mpSeat === String(this.seat);
        element.classList.toggle('mp-selected-card', element.dataset.mpCard === this.selected || decoyTarget);
      }
      byId('weather').classList.toggle('row-selectable', this.canAct() && card?.faction === 'weather');
    }

    showPreview(card, playable = false) {
      if (!card) return;
      this.preview.classList.remove('hide');
      this.preview.querySelector('.card-lg').style.backgroundImage = largeURL(`${card.faction}_${card.filename}`);
      ui.setDescription(card, this.preview.querySelector('.card-description'));
      this.previewControls.replaceChildren();
      if (playable && (card.faction === 'weather' || card.name === 'Scorch')) {
        this.button(this.previewControls, 'Сыграть', 'play-selected');
      }
      if (playable && card.row === 'leader') this.button(this.previewControls, 'Использовать', 'leader-confirm');
      this.button(this.previewControls, 'Закрыть', 'preview-close');
    }

    hidePreview() {
      this.selected = null;
      this.preview.classList.add('hide');
      this.previewControls.replaceChildren();
    }

    button(parent, label, action, option) {
      const button = addText(parent, 'button', label, 'mp-game-button');
      button.type = 'button';
      button.dataset.mpAction = action;
      if (option !== undefined) button.dataset.mpOption = option == null ? '' : String(option);
      return button;
    }

    panel(title, description) {
      this.overlay.replaceChildren();
      const panel = document.createElement('div');
      panel.className = 'mp-prompt-panel';
      const heading = addText(panel, 'h2', title);
      heading.id = 'mp-prompt-title';
      if (description) addText(panel, 'p', description);
      this.overlay.appendChild(panel);
      this.overlay.classList.remove('hide');
      this.overlay.style.display = '';
      return panel;
    }

    hideOverlay() {
      if (this.snapshot?.prompt) return;
      this.overlay.classList.add('hide');
      this.overlay.replaceChildren();
      this.localOverlay = false;
    }

    renderPrompt(prompt) {
      const key = prompt ? `${prompt.id}:${prompt.remaining}:${prompt.options?.map(option => option.id || option).join(',')}` : null;
      if (key === this.promptKey) return;
      this.promptKey = key;
      if (!prompt) {
        this.hideOverlay();
        return;
      }
      this.localOverlay = false;
      this.hidePreview();
      const panel = this.panel(prompt.title || 'Выберите действие', prompt.description);
      if (prompt.remaining > 1) addText(panel, 'p', `Осталось выбрать: ${prompt.remaining}`);
      if (prompt.kind === 'cards') {
        const choices = document.createElement('div');
        choices.className = 'mp-choices';
        for (const data of prompt.options) {
          const card = this.cards.get(data.id) || this.cardModel(data);
          const choice = document.createElement('button');
          choice.type = 'button';
          choice.className = 'mp-card-choice';
          choice.dataset.mpAction = 'choice';
          choice.dataset.mpOption = data.id;
          choice.setAttribute('aria-label', card.name);
          choice.title = `${card.name}: ${card.desc}`;
          const picture = document.createElement('div');
          picture.className = 'card-lg';
          picture.style.backgroundImage = largeURL(`${card.faction}_${card.filename}`);
          choice.appendChild(picture);
          addText(choice, 'span', card.name);
          choices.appendChild(choice);
        }
        panel.appendChild(choices);
        if (prompt.canSkip) this.button(panel, 'Готово', 'choice', null);
      } else if (prompt.kind === 'row') {
        for (const row of prompt.options) this.button(panel, ROW_LABELS[row] || row, 'choice', row);
        if (prompt.canSkip) this.button(panel, 'Пропустить', 'choice', null);
      } else {
        this.button(panel, prompt.yesLabel || 'Да', 'choice', 'yes');
        this.button(panel, prompt.noLabel || 'Нет', 'choice', 'no');
      }
    }

    showCollection(cards, title) {
      this.hidePreview();
      this.localOverlay = true;
      const panel = this.panel(title, cards.length ? 'Нажмите на карту, чтобы посмотреть её описание.' : 'Здесь пока нет карт.');
      const choices = document.createElement('div');
      choices.className = 'mp-choices';
      for (const data of cards) {
        const card = this.cards.get(data.id) || this.cardModel(data);
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'mp-card-choice';
        choice.dataset.mpAction = 'inspect';
        choice.dataset.mpOption = data.id;
        const image = document.createElement('div');
        image.className = 'card-lg';
        image.style.backgroundImage = largeURL(`${card.faction}_${card.filename}`);
        choice.appendChild(image);
        addText(choice, 'span', card.name);
        choices.appendChild(choice);
      }
      panel.appendChild(choices);
      this.button(panel, 'Закрыть', 'overlay-close');
    }

    renderEnd(snapshot) {
      const screen = byId('end-screen');
      if (snapshot.phase !== 'finished') {
        screen.classList.add('hide');
        return;
      }
      this.hidePreview();
      this.hideOverlay();
      screen.classList.remove('hide');
      screen.style.opacity = '1';
      screen.firstElementChild.className = snapshot.winner == null ? 'end-draw' :
        snapshot.winner === this.seat ? 'end-win' : 'end-lose';
      const rows = screen.querySelectorAll('tr');
      rows[1].children[0].textContent = snapshot.players[this.seat].name;
      rows[2].children[0].textContent = snapshot.players[1 - this.seat].name;
      for (let round = 0; round < 3; round++) {
        rows[0].children[round + 1].textContent = `Раунд ${round + 1}`;
        const result = snapshot.history[round];
        for (let displaySeat = 0; displaySeat < 2; displaySeat++) {
          const index = displaySeat === 0 ? this.seat : 1 - this.seat;
          const cell = rows[displaySeat + 1].children[round + 1];
          cell.textContent = result ? String(result.scores[index]) : '—';
          cell.style.color = result?.winner === index ? 'goldenrod' : '';
        }
      }
      screen.querySelector('p').classList.add('hide');
      [...screen.querySelectorAll('button')].forEach((button, index) => {
        button.classList.toggle('hide', index !== 0);
        if (index === 0) {
          button.textContent = 'Вернуться в лобби';
          button.dataset.mpAction = 'leave';
        }
      });
    }

    handleClick(event) {
      if (!this.active) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = event.target instanceof Element ? event.target : event.target.parentElement;
      const action = target.closest('[data-mp-action]');
      if (action) {
        const name = action.dataset.mpAction;
        if (name === 'preview-close') { this.hidePreview(); this.highlightRows(); }
        else if (name === 'overlay-close') this.hideOverlay();
        else if (name === 'inspect') { this.hideOverlay(); this.showPreview(this.cards.get(action.dataset.mpOption)); }
        else if (name === 'leave' || name === 'exit-confirm') this.onLeave();
        else if (name === 'exit') {
          if (this.snapshot.prompt) return;
          const panel = this.panel('Выйти из партии?', 'Соперник увидит, что вы покинули комнату.');
          this.localOverlay = true;
          this.button(panel, 'Продолжить игру', 'overlay-close');
          this.button(panel, 'Выйти в лобби', 'exit-confirm');
        }
        else if (name === 'pass' && this.canAct()) this.submit({ kind: 'pass' });
        else if (name === 'leader-confirm' && this.canAct() && this.snapshot.players[this.seat].leaderAvailable) this.submit({ kind: 'leader' });
        else if (name === 'play-selected' && this.canAct() && this.selected) this.submit({ kind: 'play', card: this.selected });
        else if (name === 'choice' && !this.busy && this.snapshot.prompt) this.submit({
          kind: 'choice', promptId: this.snapshot.prompt.id, option: action.dataset.mpOption || null
        });
        return;
      }
      if (this.snapshot.prompt || this.localOverlay || this.snapshot.phase === 'finished') return;
      const leader = target.closest('[data-mp-leader]');
      if (leader) {
        const own = leader.dataset.mpLeader === 'me';
        const data = this.snapshot.players[own ? this.seat : 1 - this.seat].leader;
        this.selected = null;
        this.showPreview(this.cards.get(data.id), own && this.canAct() && this.snapshot.players[this.seat].leaderAvailable);
        this.highlightRows();
        return;
      }
      const grave = target.closest('[data-mp-grave]');
      if (grave) {
        const own = grave.dataset.mpGrave === 'me';
        this.showCollection(this.snapshot.players[own ? this.seat : 1 - this.seat].grave, own ? 'Ваш сброс' : 'Сброс соперника');
        this.highlightRows();
        return;
      }
      const cardElement = target.closest('[data-mp-card]');
      const selected = this.cards.get(this.selected);
      const rowElement = target.closest('.field-row');
      if (selected?.name === 'Decoy' && cardElement && rowElement && this.canAct()) {
        const card = this.cards.get(cardElement.dataset.mpCard);
        if (rowElement.dataset.mpSeat === String(this.seat) && card?.isUnit()) {
          this.submit({ kind: 'play', card: this.selected, row: rowElement.dataset.mpRow, target: card.mpData.id });
          return;
        }
      }
      if (cardElement?.dataset.mpContext === 'hand' && this.canAct()) {
        const id = cardElement.dataset.mpCard;
        const card = this.cards.get(id);
        if (this.selected === id && this.allowedRows(card).length === 1) {
          this.submit({ kind: 'play', card: id, row: this.allowedRows(card)[0].row });
        } else {
          this.selected = id;
          this.showPreview(card, true);
          this.highlightRows();
        }
        return;
      }
      if (rowElement && selected && this.canAct()) {
        const row = this.allowedRows(selected).find(row => row.seat === Number(rowElement.dataset.mpSeat) && row.row === rowElement.dataset.mpRow);
        if (row) {
          this.submit({ kind: 'play', card: this.selected, row: row.row });
          return;
        }
      }
      if (target.closest('#weather') && selected?.faction === 'weather' && this.canAct()) {
        this.submit({ kind: 'play', card: this.selected });
        return;
      }
      if (cardElement && cardElement.dataset.mpContext !== 'hand') {
        this.selected = null;
        this.showPreview(this.cards.get(cardElement.dataset.mpCard));
        this.highlightRows();
      } else {
        this.hidePreview();
        this.highlightRows();
      }
    }

    submit(action) {
      if (this.busy) return;
      this.busy = true;
      this.hidePreview();
      this.highlightRows();
      this.status.textContent = 'Ожидание сервера…';
      this.overlay.querySelectorAll('button').forEach(button => button.disabled = true);
      try {
        const result = this.sendAction(action);
        if (result?.catch) result.catch(() => this.unlock());
      } catch (error) {
        this.unlock();
        throw error;
      }
    }

    unlock() {
      if (!this.active) return;
      this.busy = false;
      this.promptKey = undefined;
      this.render(this.snapshot, this.seat);
    }

    reset() {
      this.active = false;
      this.busy = false;
      this.snapshot = null;
      this.promptKey = undefined;
      this.selected = null;
      this.localOverlay = false;
      this.main.classList.remove('mp-board-active');
      this.status.classList.add('hide');
      this.preview.classList.add('hide');
      this.previewControls.replaceChildren();
      this.overlay.classList.add('hide');
      this.overlay.replaceChildren();
      byId('end-screen').classList.add('hide');
      byId('click-background').classList.add('noclick');
      this.cards.clear();
      this.main.querySelectorAll('.row-selectable, .mp-selected-card').forEach(element => element.classList.remove('row-selectable', 'mp-selected-card'));
    }
  }

  window.MultiplayerGame = MultiplayerGame;
})();
