/* Lobby, shared deck-selection deadline, and reconnectable WebSocket transport. */
(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const storage = {
        get(store, key) { try { return window[store].getItem(key); } catch { return null; } },
        set(store, key, value) { try { window[store].setItem(key, value); } catch { /* Storage may be unavailable. */ } },
        remove(store, key) { try { window[store].removeItem(key); } catch { /* Storage may be unavailable. */ } }
    };
    const state = {
        socket: null, connected: false, playerId: null, room: null, seat: null,
        token: storage.get('sessionStorage', 'gwent-mp-token'), rooms: [],
        serverOffset: 0, deckDurationMs: 30000, retry: 0, retryTimer: null,
        feedbackTimer: null, deckUpdateTimer: null, pendingReady: false, gameClient: null
    };

    byId('mp-nickname').value = storage.get('localStorage', 'gwent-mp-nickname') || '';
    byId('mp-nickname').addEventListener('input', () => {
        storage.set('localStorage', 'gwent-mp-nickname', byId('mp-nickname').value.trim());
    });
    byId('mp-room-code').addEventListener('input', event => {
        event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    function nickname() {
        const value = byId('mp-nickname').value.trim() || 'Игрок';
        storage.set('localStorage', 'gwent-mp-nickname', value);
        return value;
    }
    function feedback(message) {
        clearTimeout(state.feedbackTimer);
        byId('mp-feedback').textContent = message;
        byId('mp-feedback').hidden = false;
        state.feedbackTimer = setTimeout(() => { byId('mp-feedback').hidden = true; }, 6500);
    }
    function send(message) {
        if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) {
            feedback('Связь с сервером прервана. Дождитесь восстановления соединения.');
            return false;
        }
        state.socket.send(JSON.stringify(message));
        return true;
    }
    function updateConnection(connected, label) {
        state.connected = connected;
        byId('mp-connection-status').dataset.online = String(connected);
        byId('mp-connection-text').textContent = label;
        byId('mp-create').disabled = !connected;
        byId('mp-join').disabled = !connected;
        byId('mp-leave-room').disabled = !connected;
        byId('mp-leave-deck').disabled = !connected;
        for (const button of byId('mp-room-list').querySelectorAll('button')) button.disabled = !connected;
        updateDeckStatus();
    }
    function synchronizeTime(serverTime) {
        if (Number.isFinite(serverTime)) state.serverOffset = serverTime - Date.now();
    }
    function selectedDeck() { return JSON.parse(dm.deckToJSON()); }
    function ownPlayer() { return state.room?.players?.find(player => player.id === state.playerId); }
    function ready() { return Boolean(ownPlayer()?.ready || state.pendingReady); }

    function closeDeckOverlays() {
        // The original faction/leader picker lives inside the board. Clear its queue
        // before switching to online play so a timed-out picker cannot cover the match.
        ui.carousels.length = 0;
        if (Carousel.curr) {
            Carousel.curr.cancelled = true;
            Carousel.clearCurrent();
        }
        byId('carousel').classList.add('hide');
        ui.preview?.classList.add('hide');
        byId('popup').classList.add('hide');
        byId('notification-bar').classList.add('hide');
        document.querySelector('main').classList.remove('noclick');
    }

    function mode(name) {
        document.body.dataset.mpMode = name;
        byId('mp-lobby').hidden = name === 'deck' || name === 'playing';
        byId('mp-browser').hidden = name !== 'lobby';
        byId('mp-waiting').hidden = name !== 'waiting';
        byId('mp-deck-toolbar').hidden = name !== 'deck';
        byId('deck-customization').classList.toggle('hide', name !== 'deck');
        document.querySelector('main').setAttribute('aria-hidden', String(name === 'lobby' || name === 'waiting'));
    }

    function renderRooms() {
        const rooms = state.rooms.filter(room => room.phase === 'waiting' && room.players.length < 2);
        const list = byId('mp-room-list');
        list.replaceChildren();
        byId('mp-room-count').textContent = String(rooms.length);
        byId('mp-empty').hidden = rooms.length > 0;
        byId('mp-empty-text').textContent = state.connected ? 'Пока нет открытых комнат' : 'Подключаемся к таверне…';
        for (const room of rooms) {
            const item = document.createElement('li');
            const icon = document.createElement('img');
            icon.src = 'img/icons/deck_shield_realms.png';
            icon.alt = '';
            icon.className = 'mp-room-icon';
            const details = document.createElement('div');
            details.className = 'mp-room-details';
            const title = document.createElement('h3');
            title.textContent = room.name;
            const meta = document.createElement('p');
            const code = document.createElement('span');
            code.className = 'mp-code';
            code.textContent = room.code;
            const host = document.createElement('span');
            host.textContent = `${room.players[0]?.name || 'Игрок'} · ${room.players.length}/2`;
            meta.append(code, host);
            details.append(title, meta);
            const join = document.createElement('button');
            join.type = 'button';
            join.className = 'mp-button';
            join.textContent = 'Войти';
            join.disabled = !state.connected;
            join.setAttribute('aria-label', `Войти в комнату ${room.name}`);
            join.addEventListener('click', () => send({type: 'join', code: room.code, nickname: nickname()}));
            item.append(icon, details, join);
            list.append(item);
        }
    }

    function renderWaiting() {
        byId('mp-waiting-title').textContent = state.room.name;
        byId('mp-waiting-code').textContent = state.room.code;
        const slots = byId('mp-player-slots');
        slots.replaceChildren();
        for (let seat = 0; seat < 2; seat++) {
            const player = state.room.players[seat];
            const slot = document.createElement('div');
            slot.className = `mp-player-slot${player ? '' : ' mp-vacant'}`;
            const crest = document.createElement('img');
            crest.src = `img/icons/deck_shield_${seat === 0 ? 'realms' : 'nilfgaard'}.png`;
            crest.alt = '';
            const name = document.createElement('strong');
            name.textContent = player?.name || 'Место свободно';
            const status = document.createElement('span');
            status.textContent = player ? (player.connected === false ? 'Восстанавливает соединение' : player.id === state.playerId ? 'Вы · за столом' : 'За столом') : 'Соперник ещё не присоединился';
            slot.append(crest, name, status);
            slots.append(slot);
        }
    }

    function remainingSeconds() {
        return Math.max(0, Math.ceil((state.room.deadline - Date.now() - state.serverOffset) / 1000));
    }
    function updateDeckStatus() {
        if (state.room?.phase !== 'deck') return;
        const players = state.room.players;
        const meReady = ready();
        const other = players.find(player => player.id !== state.playerId);
        const text = meReady ? 'Ваша колода готова. Ожидаем соперника.' : other?.ready ? 'Соперник готов. Подтвердите свою колоду.' : 'Подтвердите колоду — игра начнётся, когда оба будут готовы';
        byId('mp-deck-ready').textContent = other?.connected === false ? `${text} Соперник восстанавливает соединение.` : text;
        byId('start-game').textContent = meReady ? 'Колода подтверждена' : 'Подтвердить колоду';
        byId('start-game').disabled = !state.connected || meReady || remainingSeconds() === 0;
        document.body.dataset.mpReady = String(meReady);
        for (const id of ['change-faction', 'upload-deck']) byId(id).setAttribute('aria-disabled', String(meReady));
        byId('add-file').disabled = meReady;
    }
    function updateCountdown() {
        if (state.room?.phase !== 'deck') return;
        const seconds = remainingSeconds();
        byId('mp-countdown').textContent = String(seconds);
        byId('mp-countdown').parentElement.dataset.urgent = String(seconds <= 10);
        if (seconds === 0) {
            byId('mp-deck-ready').textContent = 'Время истекло. Начинаем партию…';
            byId('start-game').disabled = true;
        }
    }
    function submitDeckUpdate() {
        clearTimeout(state.deckUpdateTimer);
        if (state.room?.phase === 'deck' && state.connected && !ready()) {
            send({type: 'deck_update', deck: selectedDeck()});
        }
    }
    function scheduleDeckUpdate() {
        clearTimeout(state.deckUpdateTimer);
        if (state.room?.phase === 'deck' && !ready()) state.deckUpdateTimer = setTimeout(submitDeckUpdate, 100);
    }
    const originalUpdate = dm.update.bind(dm);
    dm.update = function (...args) {
        const result = originalUpdate(...args);
        scheduleDeckUpdate();
        return result;
    };
    // Upstream changes a leader without calling update(). Observe its preview too.
    new MutationObserver(scheduleDeckUpdate).observe(byId('card-leader').children[1], {attributes: true, attributeFilter: ['style']});
    dm.startNewGame = function () {
        if (state.room?.phase !== 'deck' || ready()) return;
        if (dm.stats.units < 22 || dm.stats.special > 10) {
            feedback('Для игры нужно не меньше 22 карт отрядов и не больше 10 особых карт.');
            return;
        }
        if (send({type: 'ready', deck: selectedDeck()})) {
            state.pendingReady = true;
            closeDeckOverlays();
            updateDeckStatus();
        }
    };

    function handleRoom(room, seat) {
        const previous = state.room;
        state.room = room;
        state.seat = seat;
        state.pendingReady = false;
        if (!room) {
            state.gameClient?.reset();
            closeDeckOverlays();
            document.body.dataset.mpReady = 'false';
            mode('lobby');
            renderRooms();
            return;
        }
        synchronizeTime(room.serverTime);
        if (room.phase === 'waiting') {
            closeDeckOverlays();
            mode('waiting');
            renderWaiting();
        } else if (room.phase === 'deck') {
            mode('deck');
            const firstEntry = previous?.phase !== 'deck' || previous?.code !== room.code;
            if (firstEntry) {
                closeDeckOverlays();
                // Existing saved decks are kept; only an empty editor gets a starter.
                if (dm.stats.total === 0) {
                    const standard = premade_deck.map(deck => JSON.parse(deck)).find(deck => deck.faction === dm.faction);
                    if (standard) dm.loadPlayerDeck(standard);
                }
                EventManager.customizationOpened.dispatch();
                submitDeckUpdate();
            }
            updateDeckStatus();
            updateCountdown();
        } else if (room.phase === 'playing' || room.phase === 'finished') {
            closeDeckOverlays();
            mode('playing');
        }
    }

    function handleMessage(message) {
        if (message.type === 'welcome') {
            state.playerId = message.playerId;
            state.token = message.token;
            state.retry = 0;
            if (Number.isFinite(message.deckDurationMs)) state.deckDurationMs = message.deckDurationMs;
            storage.set('sessionStorage', 'gwent-mp-token', state.token);
            synchronizeTime(message.serverTime);
            updateConnection(true, 'Соединение установлено');
            renderRooms();
        } else if (message.type === 'lobby') {
            state.rooms = message.rooms || [];
            renderRooms();
        } else if (message.type === 'room') {
            handleRoom(message.room, message.seat);
        } else if (message.type === 'game') {
            closeDeckOverlays();
            mode('playing');
            if (!state.gameClient) {
                state.gameClient = new window.MultiplayerGame({
                    sendAction: action => {
                        if (!send({type: 'action', action})) state.gameClient?.unlock();
                    },
                    onLeave: () => send({type: 'leave'})
                });
            }
            state.gameClient.render(message.game, message.seat);
        } else if (message.type === 'error') {
            state.pendingReady = false;
            state.gameClient?.unlock();
            updateDeckStatus();
            feedback(message.message || 'Не удалось выполнить действие. Попробуйте ещё раз.');
        } else if (message.type === 'left') {
            handleRoom(null, null);
        }
    }

    function connect() {
        clearTimeout(state.retryTimer);
        const url = new URL('/ws', window.location.href);
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        if (state.token) url.searchParams.set('token', state.token);
        const socket = new WebSocket(url);
        state.socket = socket;
        updateConnection(false, state.retry ? 'Восстанавливаем соединение…' : 'Подключение…');
        socket.addEventListener('message', event => {
            if (socket !== state.socket) return;
            let message;
            try { message = JSON.parse(event.data); } catch { feedback('Сервер прислал некорректный ответ.'); return; }
            handleMessage(message);
        });
        socket.addEventListener('close', event => {
            if (socket !== state.socket) return;
            if (event.code === 4001) {
                clearTimeout(state.retryTimer);
                state.token = null;
                storage.remove('sessionStorage', 'gwent-mp-token');
                updateConnection(false, 'Эта сессия открыта в другой вкладке');
                feedback('Партия открыта в другой вкладке. Играйте там; обновите эту страницу, чтобы создать отдельную сессию.');
                return;
            }
            updateConnection(false, 'Связь прервана. Подключаемся…');
            const delay = Math.min(5000, 1000 * (2 ** state.retry++));
            state.retryTimer = setTimeout(connect, delay);
        });
        socket.addEventListener('error', () => { /* close starts the reconnect attempt. */ });
    }

    byId('mp-create-form').addEventListener('submit', event => {
        event.preventDefault();
        send({type: 'create', name: byId('mp-room-name').value.trim(), nickname: nickname()});
    });
    byId('mp-join-form').addEventListener('submit', event => {
        event.preventDefault();
        const code = byId('mp-room-code').value.trim().toUpperCase();
        if (code) send({type: 'join', code, nickname: nickname()});
    });
    for (const id of ['mp-leave-room', 'mp-leave-deck']) {
        byId(id).addEventListener('click', () => send({type: 'leave'}));
    }
    byId('mp-copy-code').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(state.room.code);
            byId('mp-copy-code').textContent = 'Код скопирован';
            setTimeout(() => { byId('mp-copy-code').textContent = 'Копировать код'; }, 2000);
        } catch {
            const range = document.createRange();
            range.selectNodeContents(byId('mp-waiting-code'));
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            feedback('Код выделен. Скопируйте его и отправьте сопернику.');
        }
    });
    for (const id of ['change-faction', 'download-deck']) {
        byId(id).addEventListener('keydown', event => {
            if ((event.key === 'Enter' || event.key === ' ') && byId(id).getAttribute('aria-disabled') !== 'true') {
                event.preventDefault();
                byId(id).click();
            }
        });
    }
    setInterval(updateCountdown, 200);
    renderRooms();
    connect();
})();
