/* Server-only adapter for the original rules. No browser controls decide a move. */
(() => {
  let closed = false, ready = false, revision = 0, promptNumber = 0, pending = null;
  let actor = null, started = false, finished = false;
  const ids = new WeakMap();
  let cardNumber = 0;
  const indexByImage = new Map(card_dict.map((card, index) => [card.deck + '_' + card.filename, index]));
  const names = JSON.parse(__host.namesJSON);
  const deckData = JSON.parse(__host.decksJSON).map(deck => ({
    faction: deck.faction, leader: card_dict[deck.leader],
    cards: deck.cards.map(([index, count]) => ({ index, count }))
  }));
  const emit = () => { if (!closed) { revision++; __host.update(); } };
  const launch = task => Promise.resolve().then(task).catch(error => {
    if (!closed) __host.error(error);
  });
  const checkOpen = () => { if (closed) throw new Error('Матч закрыт.'); };
  const cardID = card => {
    if (!ids.has(card)) ids.set(card, 'c' + ++cardNumber);
    return ids.get(card);
  };
  const describe = card => card ? ({
    id: cardID(card), index: indexByImage.get(card.faction + '_' + card.filename),
    power: card.power, holder: card.holder?.id ?? null
  }) : null;

  // Animation is presentation only. Keep all placement and removal effects intact.
  sleep = async () => {};
  translateTo = async () => {};
  fadeIn = async elem => { if (elem) elem.classList.remove('hide'); };
  fadeOut = async elem => { if (elem) elem.classList.add('hide'); };
  AudioManager.playSFX = async () => {};
  Card.prototype.animate = async () => {};
  ui.notification = async () => {};
  ui.enablePlayer = () => {};
  ui.showPreviewVisuals = () => {};
  ui.showPreview = () => {};
  ui.hidePreview = () => {};
  Carousel.curr = { cancel() {}, exit() {} };
  Deck.prototype.draw = async function(hand) {
    if (this.cards.length) await board.toHand(this.cards[0], this);
  };

  function ask(seat, data) {
    checkOpen();
    if (pending) throw new Error('Два одновременных выбора недопустимы.');
    return new Promise((resolve, reject) => {
      pending = { seat, data: { ...data, id: 'p' + ++promptNumber }, resolve, reject };
      ready = false;
      emit();
    });
  }

  ui.queueCarousel = async (container, count, action, predicate, sort, canSkip = false, title) => {
    const seat = actor ?? game.currPlayer?.id;
    if (seat !== 0 && seat !== 1) throw new Error('Не определён игрок для выбора карты.');
    for (let remaining = count; remaining > 0; remaining--) {
      const options = container.cards.filter(card => !predicate || predicate(card));
      if (!options.length) break;
      if (sort) options.sort(Card.compare);
      const selected = await ask(seat, {
        kind: 'cards', options: options.map(describe), canSkip, remaining,
        title: title || 'Выберите карту'
      });
      checkOpen();
      if (selected === null) break;
      const card = options.find(card => cardID(card) === selected);
      await action(container, container.cards.indexOf(card));
    }
  };
  ui.viewCardsInContainer = async container => {
    if (!container.cards.length) return;
    await ask(actor ?? game.currPlayer.id, {
      kind: 'cards', options: container.cards.map(describe), canSkip: true,
      remaining: 1, title: 'Карты соперника — нажмите «Продолжить»'
    });
  };
  ui.popup = async (yesLabel, yes, noLabel, no, title, description) => {
    const result = await ask(actor ?? game.currPlayer.id, {
      kind: 'popup', options: ['yes', 'no'], title, description, yesLabel, noLabel, canSkip: false
    });
    checkOpen();
    await (result === 'yes' ? yes() : no());
  };
  ui.waitForRowSelection = async card => {
    const row = await ask(actor ?? game.currPlayer.id, {
      kind: 'row', options: ['close', 'ranged'], canSkip: false,
      title: 'Выберите ряд для ' + card.name
    });
    checkOpen();
    return board.getRow(card, row, card.holder);
  };

  // A canonical seat always keeps its identity, independently of the client's view.
  factions.scoiatael.factionAbility = player => game.gameStart.push(async () => {
    actor = player.id;
    await ui.popup('Ходить первым', () => game.firstPlayer = player,
      'Уступить первый ход', () => game.firstPlayer = player.opponent(),
      'Кто начнёт матч?', 'Способность Скоя’таэл позволяет выбрать первого игрока.');
    actor = null;
    return true;
  });

  // Upstream uses innerHTML for names; never let a nickname alter the rules DOM.
  player_me = new Player(0, '', deckData[0]);
  player_op = new Player(1, '', deckData[1]);
  [player_me, player_op].forEach((player, seat) => {
    player.name = names[seat];
    document.getElementById('name-' + player.tag).textContent = names[seat];
  });
  player_me.controller = new Controller();
  player_op.controller = new Controller();
  const players = [player_me, player_op];

  game.initialRedraw = async () => {
    for (const player of players) {
      actor = player.id;
      await ui.queueCarousel(player.hand, 2, (container, index) => player.deck.swap(container, container.cards[index]),
        () => true, false, true, 'Замените до двух карт или оставьте руку');
    }
    actor = null;
  };
  // Await each transition: the original UI intentionally launches these asynchronously.
  game.startGame = async () => {
    game.initPlayers(player_me, player_op);
    game.setState(GameState.PLAYING);
    await game.runEffects(game.gameStart);
    await game.coinToss();
    for (let i = 0; i < 10; i++) {
      await player_me.deck.draw(player_me.hand);
      await player_op.deck.draw(player_op.hand);
    }
    await game.initialRedraw();
    game.currPlayer = game.firstPlayer;
    await game.startRound();
  };
  game.startRound = async () => {
    checkOpen();
    game.firstPlayer = game.currPlayer;
    game.roundCount++;
    await game.runEffects(game.roundStart);
    for (const player of players) if (!player.canPlay()) player.setPassed(true);
    if (players.every(player => player.passed)) return game.endRound();
    if (game.currPlayer.passed) game.currPlayer = game.currPlayer.opponent();
    await game.startTurn();
  };
  game.startTurn = async () => {
    checkOpen();
    await game.runEffects(game.turnStart);
    actor = null;
    ready = true;
    emit();
  };
  game.endTurn = async () => {
    checkOpen();
    await game.runEffects(game.turnEnd);
    if (players.every(player => player.passed)) return game.endRound();
    if (!game.currPlayer.opponent().passed) game.currPlayer = game.currPlayer.opponent();
    await game.startTurn();
  };
  game.endRound = async () => {
    let diff = player_me.total - player_op.total;
    if (diff === 0) {
      const a = player_me.deck.faction === 'nilfgaard', b = player_op.deck.faction === 'nilfgaard';
      if (a !== b) diff = a ? 1 : -1;
    }
    game.roundHistory.push({winner: diff > 0 ? player_me : diff < 0 ? player_op : null,
      score_me: player_me.total, score_op: player_op.total});
    await game.runEffects(game.roundEnd);
    player_me.endRound(diff > 0);
    player_op.endRound(diff < 0);
    await board.clearRound();
    if (players.some(player => player.health === 0)) {
      finished = true;
      ready = false;
      game.setState(GameState.END_SCREEN);
      emit();
    } else {
      game.currPlayer = diff < 0 ? player_op : diff > 0 ? player_me : game.firstPlayer;
      await game.startRound();
    }
  };

  function snapshot(seat) {
    return {
      revision, phase: finished ? 'finished' : 'playing', round: game.roundCount,
      turn: game.currPlayer?.id ?? null, canAct: ready && game.currPlayer?.id === seat,
      players: players.map(player => ({
        name: player.name, faction: player.deck.faction, leader: describe(player.leader),
        health: player.health, total: player.total, passed: player.passed,
        leaderAvailable: player.leaderAvailable, handCount: player.hand.cards.length,
        deckCount: player.deck.cards.length, grave: player.grave.cards.map(describe)
      })),
      hand: players[seat].hand.cards.map(describe),
      rows: board.row.map((row, i) => ({
        seat: i < 3 ? 1 : 0, row: row.type, total: row.total,
        cards: row.cards.map(describe), special: describe(row.special),
        weather: row.effects.weather,
        weatherClass: row.effects.weather ? ({close:'frost',ranged:'fog',siege:'rain'})[row.type] : ''
      })),
      weather: weather.cards.map(describe),
      prompt: pending?.seat === seat ? pending.data : null,
      waitingFor: pending?.seat ?? null,
      history: game.roundHistory.map(round => ({winner: round.winner?.id ?? null,
        scores: [round.score_me, round.score_op]})),
      winner: finished ? player_me.health > 0 ? 0 : player_op.health > 0 ? 1 : null : null
    };
  }

  function act(seat, action) {
    checkOpen();
    if (!action || !Number.isInteger(seat) || seat < 0 || seat > 1) throw new Error('Неверная команда.');
    if (action.revision !== undefined && action.revision !== revision) throw new Error('Состояние игры обновилось. Повторите ход.');
    if (pending) {
      if (action.kind !== 'choice' || pending.seat !== seat || action.promptId !== pending.data.id) {
        throw new Error('Сначала завершите текущий выбор.');
      }
      const data = pending.data;
      const allowed = data.options.map(option => typeof option === 'string' ? option : option.id);
      if (!(action.option === null && data.canSkip) && !allowed.includes(action.option)) {
        throw new Error('Недопустимый выбор.');
      }
      const selection = pending;
      pending = null;
      emit();
      selection.resolve(action.option);
      return;
    }
    if (finished || !ready || game.currPlayer?.id !== seat) throw new Error('Сейчас ход другого игрока.');
    const player = players[seat];
    let perform;
    if (action.kind === 'pass') {
      perform = async () => player.setPassed(true);
    } else if (action.kind === 'leader') {
      if (!player.leaderAvailable) throw new Error('Способность лидера недоступна.');
      perform = async () => {
        await player.leader.activated[0](player.leader, player);
        player.disableLeader();
      };
    } else if (action.kind === 'play') {
      const card = player.hand.cards.find(card => cardID(card) === action.card);
      if (!card) throw new Error('Этой карты нет в вашей руке.');
      if (card.name === 'Decoy') {
        const row = board.row.find((row, i) => (i < 3 ? 1 : 0) === seat && row.cards.some(c => cardID(c) === action.target));
        const target = row?.cards.find(c => cardID(c) === action.target);
        if (!target || !target.isUnit()) throw new Error('Чучело можно заменить только своим обычным отрядом.');
        perform = async () => {
          await board.toHand(target, row);
          await board.moveTo(card, row, player.hand);
        };
      } else if (card.name === 'Scorch') {
        perform = () => ability_dict.scorch.activated(card);
      } else if (card.faction === 'weather') {
        perform = () => board.toWeather(card, player.hand);
      } else {
        const rows = card.isSpecial() ? ['close', 'ranged', 'siege'] : card.row === 'agile' ? ['close', 'ranged'] : [card.row];
        if (!rows.includes(action.row)) throw new Error('Карта не может быть сыграна в этот ряд.');
        const row = board.getRow(card, action.row, player);
        if (!row || (card.isSpecial() && row.special)) throw new Error('Место специальной карты в этом ряду занято.');
        perform = () => board.moveTo(card, row, player.hand);
      }
    } else throw new Error('Неизвестная команда.');
    ready = false;
    actor = seat;
    emit();
    launch(async () => {
      await perform();
      if (!player.passed && !player.canPlay()) player.setPassed(true);
      actor = null;
      await game.endTurn();
    });
  }
  return {
    start() {
      if (started) return;
      started = true;
      launch(() => game.startGame());
    }, snapshot, act,
    close() {
      closed = true;
      ready = false;
      if (pending) { pending.reject(new Error('Матч закрыт.')); pending = null; }
    }
  };
})()
