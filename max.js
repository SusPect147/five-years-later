/*
 * max.js — связь игры с сервером (Supabase) и с MAX.
 *
 * Что делает:
 *   1. Берёт подписанные параметры запуска из MAX и отправляет их с каждым
 *      запросом. Личность игрока сервер определяет по подписи, а не по тому,
 *      что прислал браузер.
 *   2. Когда партия закончена, шлёт на сервер seed и журнал действий.
 *      Балл сервер считает сам, пересчитывая партию тем же движком.
 *      Подменять что-либо в браузере бессмысленно: в таблицу попадёт
 *      только то, что сервер пересчитал сам.
 *   3. Подставляет общую таблицу лидеров вместо локальной и подтягивает
 *      прогресс игрока, чтобы он не терялся при смене устройства.
 *
 * Игра работает и без этого файла: тогда всё остаётся в браузере, как раньше.
 */
(function () {
  'use strict';

  var API = 'https://kackzczkifqoznttniqg.supabase.co/functions/v1/fyl-api';
  var CACHE_KEY = 'fin-sim-board-cache-v1';
  var QUEUE_KEY = 'fin-sim-outbox-v1';

  var B = window.GameBridge;
  if (!B || !B.Leaders) return;

  /*
   * Подписанные параметры запуска MAX кладёт во фрагмент адреса (после #).
   * Мост window.WebApp в разных версиях отдаёт их по-разному, поэтому берём
   * первое, что похоже на подписанную строку: в ней обязательно есть hash=.
   */
  function launchParams() {
    var W = window.WebApp;
    var candidates = [
      (location.hash || '').replace(/^#/, ''),
      (location.search || '').replace(/^\?/, ''),
      W && typeof W.initData === 'string' ? W.initData : '',
      W && typeof W.initDataRaw === 'string' ? W.initDataRaw : '',
      W && typeof W.launchParams === 'string' ? W.launchParams : ''
    ];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (c && c.indexOf('hash=') >= 0) return c;
    }
    return '';
  }

  function post(payload) {
    payload.launch_params = launchParams();
    return fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().catch(function () { return { error: 'bad_json' }; }); });
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватное окно */ }
  }

  /* ----------------------------------------------------------------
   * Таблица лидеров
   *
   * Экрану нужен синхронный список, а сервер отвечает асинхронно.
   * Поэтому список держим в кэше: экран читает кэш, а кэш обновляется
   * в фоне после каждого ответа сервера.
   * ---------------------------------------------------------------- */

  var board = readJSON(CACHE_KEY, []);

  function refreshBoard() {
    return Promise.all([
      post({ action: 'leaderboard', cup: false, limit: 100 }),
      post({ action: 'leaderboard', cup: true, limit: 100 })
    ]).then(function (res) {
      var rows = [];
      res.forEach(function (r) { if (r && r.ok && r.rows) rows = rows.concat(r.rows); });
      board = rows;
      writeJSON(CACHE_KEY, board);
      return board;
    }).catch(function () { return board; });
  }

  var serverSource = {
    kind: 'server',
    list: function () { return board.slice(); },
    add: function (entry) {
      // Показываем результат сразу, не дожидаясь ответа сервера: он тот же,
      // если игра не подделана. В таблице он закрепится после проверки.
      board = board.concat([entry]);
      writeJSON(CACHE_KEY, board);
      submitRun(entry);
      return entry;
    },
    rename: function () { return false; },   // имя приходит из профиля MAX
    clear: function () { board = []; writeJSON(CACHE_KEY, board); }
  };

  /* ----------------------------------------------------------------
   * Отправка партии
   * ---------------------------------------------------------------- */

  function currentRunPayload(entry) {
    var G = B.state;
    if (!G || !G.scenario || !G.choices) return null;
    return {
      action: 'submit',
      scenario_id: G.scenario.id,
      seed: String(G.seed),
      actions: G.choices.slice(),
      client_score: entry ? entry.score : null
    };
  }

  function queue(payload) {
    var q = readJSON(QUEUE_KEY, []);
    q.push(payload);
    writeJSON(QUEUE_KEY, q.slice(-20));
  }

  function submitRun(entry) {
    var payload = currentRunPayload(entry);
    if (!payload) return;
    post(payload).then(function (res) {
      if (!res || !res.ok) {
        // Сеть могла отвалиться — попробуем при следующем запуске.
        if (!res || res.error === 'bad_json' || res.error === 'server_error') queue(payload);
        return;
      }
      refreshBoard();
    }).catch(function () { queue(payload); });
  }

  function flushQueue() {
    var q = readJSON(QUEUE_KEY, []);
    if (!q.length) return;
    writeJSON(QUEUE_KEY, []);
    q.forEach(function (payload) {
      post(payload).catch(function () { queue(payload); });
    });
  }

  /* ----------------------------------------------------------------
   * Прогресс игрока
   * ---------------------------------------------------------------- */

  function pullProgress() {
    return post({ action: 'progress' }).then(function (res) {
      if (!res || !res.ok) return;
      var ids = (res.progress && res.progress.concepts) || [];
      if (ids.length && B.Store && B.Store.learnAll) B.Store.learnAll(ids);
    }).catch(function () { /* не критично */ });
  }

  /* ----------------------------------------------------------------
   * Запуск
   * ---------------------------------------------------------------- */

  // Без подписи MAX сервер не примет ни партию, ни прогресс — в обычном
  // браузере игра просто остаётся локальной.
  if (!launchParams()) return;

  B.Leaders.use(serverSource);

  /*
   * Карточка профиля в игре берёт данные отсюда. Наличие этого объекта —
   * признак того, что игра открыта в MAX и серверу есть что спросить.
   */
  window.FylProfile = {
    online: true,
    load: function () { return post({ action: 'progress' }); }
  };

  /*
   * Экран загрузки ждёт этот промис: пока идут первые запросы к серверу,
   * шкала честно показывает, что ещё не всё готово.
   */
  window.FylBoot = Promise.all([refreshBoard(), pullProgress()]);

  flushQueue();
})();
