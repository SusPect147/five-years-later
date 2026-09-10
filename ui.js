/*
 * ui.js — интерфейс игры «Пять лет спустя».
 *
 * Вся графика делается кодом: SVG и CSS-трансформы, никаких растровых ассетов.
 * Это осознанный выбор под мини-приложение: мгновенная загрузка, вес в килобайтах,
 * предсказуемое поведение в webview мессенджера.
 *
 * Разделение ответственности:
 *   engine.js  — считает деньги
 *   content.js — описывает сценарии
 *   ui.js      — только показывает и собирает решения
 * UI не производит собственных финансовых расчётов.
 *
 * ВЕРСИЯ ИНТЕРФЕЙСА 3 (redesign): premium dark, cinematic game UI.
 * Игровая логика не менялась — переписан только слой представления.
 * Единственное новое вычисление в UI — предварительный просмотр стоимости
 * варианта (previewChoice). Оно выполняется на КОПИИ состояния через настоящий
 * Engine.api, поэтому не может ни изменить партию, ни разойтись с движком.
 */
(function () {
  'use strict';

  var E = window.Engine;
  var C = window.Content;

  // Движок должен знать пул событий, чтобы разворачивать сценарии со слотами,
  // и список инструментов, чтобы считать цены на бирже.
  E.setPool(C.pool);
  if (E.setMarket) E.setMarket(C.instruments || []);

  /* Утилиты */

  var MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  var MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Разряды разделяет УЗКИЙ НЕРАЗРЫВНЫЙ пробел. С обычным тонким браузер
     спокойно переносит «18 000 ₽» на две строки, и сумма разваливается
     пополам прямо посреди предложения. */
  function fmt(x) {
    var v = Math.round(Math.abs(x));
    var s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (x < 0 ? '−' : '') + s + ' ₽';
  }

  function fmtPlain(x) {
    var v = Math.round(Math.abs(x));
    var s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (x < 0 ? '−' : '') + s;
  }

  function fmtShort(x) {
    var a = Math.abs(x);
    if (a >= 1000000) return (x / 1000000).toFixed(1).replace('.0', '') + ' млн';
    if (a >= 1000) return Math.round(x / 1000) + ' тыс';
    return String(Math.round(x));
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* Склонение по числу: 1 месяц, 2 месяца, 5 месяцев. */
  function plural(n, one, few, many) {
    var m = n % 10, h = n % 100;
    if (m === 1 && h !== 11) return one;
    return m >= 2 && m <= 4 && (h < 10 || h >= 20) ? few : many;
  }

  /* Первый элемент списка с нужным значением поля; null, если такого нет. */
  function findIn(list, key, value) {
    for (var i = 0; i < list.length; i++) if (list[i][key] === value) return list[i];
    return null;
  }

  /*
   * Ячейка «подпись — значение». Форма у всех панелей одна, различаются
   * только теги и классы, поэтому семь почти одинаковых функций
   * (exCell, previewCell, ctxCell, vFact, bfRow, fcRow, afterCell)
   * собраны здесь в одном месте.
   */
  function labelValue(boxTag, boxCls, partTag, labCls, valCls, lab, val, mod) {
    var c = el(boxTag, boxCls + (mod ? ' ' + mod : ''));
    c.appendChild(el(partTag, labCls, lab));
    c.appendChild(el(partTag, valCls, val));
    return c;
  }

  /*
   *  СУММЫ В ТЕКСТЕ СОБЫТИЯ
   *
   *  События написаны под доход около 62 000 ₽, а движок пересчитывает
   *  суммы под доход сценария. Из-за этого в тексте стояло «130 000 ₽»,
   *  а списывалось 201 500 ₽: игра называла одну цифру, а делала другое,
   *  и верить ей было нельзя.
   *
   *  Поэтому суммы в текстах записаны как {130000}, а сюда подставляется
   *  ровно то число, которое посчитает движок. Скобки с двумя цифрами
   *  и меньше не трогаем: это может быть кусок регулярного выражения,
   *  а не деньги.
   */

  function evalText(str, state) {
    var st = state || (G.run && G.run.state);
    if (typeof str === 'function') return str(st, E);
    if (str == null) return str;
    return String(str).replace(/\{(\d{3,})\}/g, function (all, n) {
      return fmtPlain(E.scaleAmount(st, +n));
    });
  }

  /*
   *  Блокировка прокрутки страницы
   *
   *  Пока открыто модальное окно (биржа, карточка знаний) или шторка
   *  решения на телефоне, страница под ними не должна ездить. Иначе игрок
   *  прокручивает содержимое окна, промахивается мимо него — и незаметно
   *  уезжает фон, а после закрытия оказывается совсем в другом месте.
   */

  /*
   *  ОШИБКИ
   *
   *  Раньше почти каждый вызов к документу был обёрнут в пустой
   *  try/catch. Выглядело это как забота об устойчивости, а работало
   *  как затычка: сломанный обработчик, опечатка в селекторе или
   *  исключение внутри события молча проглатывались, игра продолжала
   *  идти «почти правильно», и найти причину было невозможно.
   *
   *  Теперь по-другому. Свой код не оборачивается ни во что: если он
   *  падает — он падает, и это видно. Обёртки остались ровно там, где
   *  отсутствие возможности НЕ является ошибкой: хранилище в приватном
   *  окне, matchMedia в старом браузере, мост MAX вне мессенджера.
   *  Такие места помечены явно — feature() и bridge().
   *
   *  Всё, что всё-таки сломалось, попадает сюда: в консоль и в полосу
   *  внизу экрана. Молча не теряется ничего.
   */

  var Fail = {
    seen: [],

    report: function (where, err) {
      var text = where + ': ' + ((err && err.message) || err);
      Fail.seen.push({ where: where, error: err, at: new Date() });
      if (window.console && console.error) console.error('[Пять лет спустя] ' + text, err);
      Fail.show(text);
    },

    /** Полоса внизу экрана: ошибку должно быть видно, а не только в консоли. */
    show: function (text) {
      var box = document.getElementById('err-strip');
      if (!box) {
        box = document.createElement('div');
        box.id = 'err-strip';
        box.className = 'err-strip';
        var close = document.createElement('button');
        close.className = 'err-close';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Скрыть');
        close.onclick = function () { box.remove(); };
        box.appendChild(document.createElement('div')).className = 'err-list';
        box.appendChild(close);
        document.body.appendChild(box);
      }
      var list = box.querySelector('.err-list');
      var row = document.createElement('div');
      row.className = 'err-row';
      row.textContent = text;
      list.appendChild(row);
      while (list.children.length > 4) list.removeChild(list.firstChild);
      box.setAttribute('data-count', String(Fail.seen.length));
    }
  };

  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') return;   // это ловит загрузчик
    Fail.report('Ошибка выполнения', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    Fail.report('Необработанный отказ', e.reason);
  });

  /**
   * Возможность браузера, которой может не быть.
   * Отсутствие — штатная ситуация, поэтому здесь молчание оправдано.
   * Внутрь помещается ОДИН вызов, а не кусок логики: иначе обёртка снова
   * начнёт прятать наши собственные ошибки.
   */
  function feature(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }

  /** Системная настройка «меньше движения». */
  function reducedMotion() {
    return feature(function () {
      return window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    }, false);
  }

  /**
   * Мост MAX. Вне мессенджера его нет — это не ошибка, а обычный запуск
   * в браузере. Всё, что не про отсутствие моста, всплывает наверх.
   */
  function bridge(fn) {
    if (!window.WebApp) return false;
    fn(window.WebApp);
    return true;
  }

  var scrollLocks = 0;

  function setLockClass(on) {
    document.documentElement.classList.toggle('scroll-locked', on);
    document.body.classList.toggle('scroll-locked', on);
  }

  function lockScroll(on) {
    scrollLocks = Math.max(0, scrollLocks + (on ? 1 : -1));
    setLockClass(scrollLocks > 0);
  }

  function clearScrollLocks() {
    scrollLocks = 0;
    setLockClass(false);
  }

  /**
   * Страховка от «залипшего» замка прокрутки.
   *
   * Замок ставится только модальными окнами. Если ни одного окна в разметке
   * нет, а замок остался — счётчик разошёлся с реальностью (окно сняли
   * перерисовкой экрана, обработчик закрытия не сработал, окно закрыли
   * дважды). Раньше это выглядело как «колесо мыши не листает страницу»,
   * и вылечить это можно было только перезагрузкой.
   *
   * Наблюдатель за телом документа приводит замок в соответствие с тем,
   * что на экране на самом деле: нет окон — нет замка.
   */
  function syncScrollLock() {
    if (!document.querySelectorAll('.modal-wrap').length && scrollLocks) clearScrollLocks();
  }

  if (window.MutationObserver) {
    new MutationObserver(syncScrollLock).observe(document.body, { childList: true });
  }

  /**
   * Карта решения больше нигде не перекрывает страницу: и на телефоне,
   * и на ПК это обычная карточка в потоке документа. Функция оставлена,
   * чтобы старые вызовы читались, и всегда отвечает «нет».
   *
   * Почему так: пока карта была шторкой на весь экран, страница под ней
   * стояла на замке. А карта открыта почти всё время партии — значит,
   * почти всё время колесо мыши не листало ничего, и до кошелька,
   * портфеля и хроники было не добраться.
   */
  function sheetIsOverlay() {
    return false;
  }

  /**
   * Смена экрана всегда начинается сверху. Без этого после клика по карточке,
   * до которой пришлось прокрутить меню, игрок попадал на игровой экран
   * с уже уехавшей шапкой времени.
   */
  function resetScroll() {
    // Экран сменился — все замки прокрутки снимаются вместе с их окнами.
    clearScrollLocks();
    if (root) root.scrollTop = 0;
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  /*
   *  Иконки — единый линейный набор, рисуется кодом.
   *  Эмодзи не используются нигде: они выглядят чужеродно в тёмной теме
   *  и по-разному на разных платформах.
   */

  var ICONS = {
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.6v.4"/><path d="M12 17.2h.01"/>',
    gear: '<path d="M4 7.5h9M17 7.5h3M4 16.5h3M11 16.5h9"/><circle cx="15" cy="7.5" r="2.4"/><circle cx="9" cy="16.5" r="2.4"/>',
    arrow: '<path d="M4.5 12h14"/><path d="M13 6.5 18.5 12 13 17.5"/>',
    back: '<path d="M19.5 12h-14"/><path d="M11 6.5 5.5 12 11 17.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
    layers: '<path d="M12 3.5 3.5 8l8.5 4.5L20.5 8z"/><path d="m3.5 13 8.5 4.5 8.5-4.5"/>',
    wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v2.5"/><rect x="4" y="7.5" width="16" height="11.5" rx="2.2"/><path d="M20 11.5h-3.4a1.9 1.9 0 0 0 0 3.8H20"/>',
    shield: '<path d="M12 3.5 5.5 6v5.4c0 3.7 2.6 7.1 6.5 8.6 3.9-1.5 6.5-4.9 6.5-8.6V6z"/>',
    heart: '<path d="M12 19.5s-6.8-4-6.8-8.6A3.9 3.9 0 0 1 12 8.4a3.9 3.9 0 0 1 6.8 2.5c0 4.6-6.8 8.6-6.8 8.6z"/>',
    bolt: '<path d="M13.2 3.5 6 13.2h4.6l-.8 7.3L17.4 11h-4.6z"/>',
    check: '<path d="M4.8 12.4 9.6 17l9.6-10"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.9v2.3M12 18.8v2.3M2.9 12h2.3M18.8 12h2.3M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M18.5 5.5l-1.6 1.6M7.1 16.9l-1.6 1.6"/>',
    moon: '<path d="M20.2 14.4A8.3 8.3 0 0 1 9.6 3.8a8.5 8.5 0 1 0 10.6 10.6z"/>',
    play: '<path d="M8 5.5 18.5 12 8 18.5z"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4"/><path d="M19.8 4.5v4.2h-4.2"/>',
    flag: '<path d="M6 20.5V4"/><path d="M6 5.2h11l-2.4 3.6L17 12.4H6z"/>',
    alert: '<path d="M12 4.5 3 19.5h18z"/><path d="M12 10v4M12 16.8h.01"/>',
    share: '<circle cx="17.5" cy="6" r="2.5"/><circle cx="6.5" cy="12" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="m8.8 10.8 6.4-3.6M8.8 13.2l6.4 3.6"/>',
    trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2h5V7"/><path d="M6.6 7l.9 12.3h9l.9-12.3"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.3 10.5V8.2a3.7 3.7 0 0 1 7.4 0v2.3"/>',
    spark: '<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.4l-1.9-5.6-5.6-1.9L10.1 9z"/>',
    chart: '<path d="M4 19.5h16"/><path d="m5 15 4.5-4.8 3.5 2.6 5.5-6.3"/>',
    dice: '<rect x="4.5" y="4.5" width="15" height="15" rx="3.2"/><path d="M9 9h.01M15 9h.01M9 15h.01M15 15h.01M12 12h.01"/>',
    briefcase: '<rect x="3.5" y="7.5" width="17" height="12" rx="2.2"/><path d="M9 7.5V6a1.8 1.8 0 0 1 1.8-1.8h2.4A1.8 1.8 0 0 1 15 6v1.5"/><path d="M3.5 12.5h17"/>',
    trend: '<path d="M4 16.5 9.5 11l3.5 3.2L20 7"/><path d="M15.5 7H20v4.4"/>',
    trendDown: '<path d="M4 7.5 9.5 13l3.5-3.2L20 17"/><path d="M15.5 17H20v-4.4"/>',
    minus: '<path d="M5.5 12h13"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    coin: '<ellipse cx="12" cy="7.5" rx="7" ry="3"/><path d="M5 7.5v9c0 1.7 3.1 3 7 3s7-1.3 7-3v-9"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'
  };

  function icon(name, cls) {
    var n = el('span', 'ic' + (cls ? ' ' + cls : ''));
    var p = ICONS[name];
    if (!p) return n;
    n.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      p + '</svg>';
    return n;
  }

  /*
   *  Тема оформления
   *
   *  По умолчанию игра идёт за системной настройкой: светлая днём,
   *  тёмная там, где так настроен компьютер. Кнопка в шапке ставит
   *  выбор жёстко и запоминает его — в классе проектор и ноутбук
   *  учителя часто требуют разного.
   *
   *  Значение проставляется атрибутом data-theme на <html> ещё до
   *  отрисовки (скрипт в <head> index.html), иначе при загрузке
   *  успевала бы мигнуть не та тема.
   */

  var Theme = {
    KEY: 'five-years.theme',

    systemDark: function () {
      return feature(function () {
        return window.matchMedia('(prefers-color-scheme:dark)').matches;
      }, false);
    },

    current: function () {
      var el = document.documentElement;
      var set = el && el.getAttribute ? el.getAttribute('data-theme') : null;
      if (set === 'dark' || set === 'light') return set;
      return Theme.systemDark() ? 'dark' : 'light';
    },

    apply: function (t) {
      document.documentElement.setAttribute('data-theme', t);
      // Приватное окно запрещает запись — это не ошибка игры
      feature(function () { localStorage.setItem(Theme.KEY, t); });
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', t === 'dark' ? '#161A22' : '#FFF6E8');
    },

    toggle: function () {
      Theme.apply(Theme.current() === 'dark' ? 'light' : 'dark');
    }
  };

  /** Кнопка переключения темы: солнце в тёмной теме, месяц в светлой. */
  function buildThemeBtn(cls) {
    var b = el('button', cls || 'nav-btn theme-btn');
    function paint() {
      var dark = Theme.current() === 'dark';
      b.innerHTML = '';
      b.appendChild(icon(dark ? 'sun' : 'moon'));
      b.setAttribute('aria-label', dark ? 'Светлая тема' : 'Тёмная тема');
      b.setAttribute('title', dark ? 'Светлая тема' : 'Тёмная тема');
    }
    paint();
    b.onclick = function () {
      MaxBridge.haptic('light');
      Theme.toggle();
      paint();
    };
    return b;
  }

  /* Мост к MAX (работает и без него — в обычном браузере) */

  var MaxBridge = {
    available: false,
    platform: 'browser',
    user: null,

    init: function () {
      var W = window.WebApp;
      if (!W) return;
      this.available = true;
      this.platform = W.platform || 'browser';
      var d = W.initDataUnsafe;
      if (d && d.user) this.user = d.user;
    },

    // Тактильная отдача — самый дешёвый способ сделать интерфейс живым.
    // В вебе и на десктопе метода нет, поэтому всё в try.
    haptic: function (style) {
      bridge(function (W) {
        if (W.HapticFeedback) W.HapticFeedback.impactOccurred(style);
      });
    },
    hapticNotify: function (type) {
      bridge(function (W) {
        if (W.HapticFeedback) W.HapticFeedback.notificationOccurred(type);
      });
    },
    hapticSelect: function () {
      bridge(function (W) {
        if (W.HapticFeedback) W.HapticFeedback.selectionChanged();
      });
    },

    share: function (text) {
      var sent = bridge(function (W) {
        if (!W.shareMaxContent) throw new Error('нет shareMaxContent');
        W.shareMaxContent({ text: text });
      });
      if (sent) return true;
      // Вне MAX — обычный путь: буфер обмена. Его тоже может не быть
      // (страница открыта не по https), и это не поломка игры.
      feature(function () { return navigator.clipboard.writeText(text); });
      return false;
    },

    backButton: function (show, handler) {
      bridge(function (W) {
        var B = W.BackButton;
        if (!B) return;
        if (show) { B.onClick(handler); B.show(); } else { B.hide(); }
      });
    }
  };

  /* Локальный прогресс (без сервера) */

  var Store = {
    KEY: 'fin-sim-progress-v1',
    data: { concepts: [], forecasts: [], runs: [], best: {}, achievements: [] },

    load: function () {
      // Само хранилище может быть запрещено (приватное окно) — это нормально.
      var raw = feature(function () { return localStorage.getItem(Store.KEY); }, null);
      if (!raw) return this.data;
      // А вот испорченное содержимое — уже событие: о нём надо знать.
      try {
        this.data = Object.assign(this.data, JSON.parse(raw));
      } catch (e) {
        Fail.report('Сохранение повреждено, прогресс начат заново', e);
        feature(function () { localStorage.removeItem(Store.KEY); });
      }
      return this.data;
    },
    save: function () {
      var json = JSON.stringify(this.data);
      feature(function () { localStorage.setItem(Store.KEY, json); });
    },
    learnAll: function (ids) {
      var d = this.data, changed = false;
      ids.forEach(function (id) { if (d.concepts.indexOf(id) === -1) { d.concepts.push(id); changed = true; } });
      if (changed) this.save();
    },
    addForecast: function (err) { this.data.forecasts.push(err); this.save(); },
    avgForecastError: function () {
      var f = this.data.forecasts;
      if (!f.length) return null;
      return f.reduce(function (a, b) { return a + b; }, 0) / f.length;
    },
    recentForecastError: function (n) {
      var f = this.data.forecasts.slice(-(n || 5));
      if (!f.length) return null;
      return f.reduce(function (a, b) { return a + b; }, 0) / f.length;
    },
    /* Вместе с итогом сохраняется и сама партия: seed и список решений.
       Движок детерминирован, поэтому этих двух вещей достаточно, чтобы
       собрать экран итогов заново хоть через неделю. Раньше уход с
       экрана итогов означал, что разбор партии потерян навсегда.

       Полные записи занимают место, поэтому решения хранятся только у
       последних RUN_REPLAYS партий: старые остаются строкой в истории. */
    RUN_REPLAYS: 20,
    addRun: function (rec) {
      this.data.runs.push(rec);
      var b = this.data.best[rec.scenarioId];
      if (!b || rec.netWorth > b) this.data.best[rec.scenarioId] = rec.netWorth;
      var runs = this.data.runs;
      for (var i = 0; i < runs.length - this.RUN_REPLAYS; i++) {
        delete runs[i].choices;
        delete runs[i].seed;
      }
      this.save();
    },
    /** Последние партии — свежие первыми. */
    recentRuns: function () {
      return this.data.runs.slice().reverse();
    },
    reset: function () {
      this.data = { concepts: [], forecasts: [], runs: [], best: {}, achievements: [] };
      feature(function () { localStorage.removeItem(Store.KEY); });
    }
  };


  /*
   *  ТАБЛИЦА ЛИДЕРОВ
   *
   *  Источник результатов вынесен отдельно от экрана. Сегодня это
   *  память браузера, завтра — общая база и профиль MAX: имя и
   *  идентификатор игрока придут оттуда, а список строк — из базы.
   *  Экрану всё равно: он просит у источника строки и рисует их.
   *  Чтобы подключить базу, достаточно передать в Leaders.use объект
   *  с теми же четырьмя методами: list, add, rename, clear.
   */

  var Leaders = (function () {
    var KEY = 'fin-sim-leaders-v1';
    var NAME_KEY = 'fin-sim-player-v1';
    var LIMIT = 300;

    var localSource = {
      kind: 'local',
      list: function () {
        var raw = feature(function () { return localStorage.getItem(KEY); }, null);
        if (!raw) return [];
        try {
          var d = JSON.parse(raw);
          return Array.isArray(d) ? d : [];
        } catch (e) {
          Fail.report('Таблица результатов повреждена, начата заново', e);
          feature(function () { localStorage.removeItem(KEY); });
          return [];
        }
      },
      save: function (rows) {
        var json = JSON.stringify(rows.slice(0, LIMIT));
        feature(function () { localStorage.setItem(KEY, json); });
      },
      add: function (entry) {
        var rows = this.list();
        rows.push(entry);
        this.save(rows);
        return entry;
      },
      rename: function (id, name) {
        var rows = this.list(), hit = false;
        rows.forEach(function (r) { if (r.id === id) { r.name = name; hit = true; } });
        if (hit) this.save(rows);
        return hit;
      },
      clear: function () { feature(function () { localStorage.removeItem(KEY); }); }
    };

    var source = localSource;

    /** Кто играет. В MAX имя и id приходят из профиля, в браузере — своё. */
    function me() {
      var u = MaxBridge.user;
      if (u && (u.id || u.username)) {
        return {
          id: 'max:' + (u.id || u.username),
          name: u.first_name || u.username || 'Игрок',
          external: true
        };
      }
      var saved = feature(function () { return localStorage.getItem(NAME_KEY); }, null);
      return { id: 'device', name: saved || '', external: false };
    }

    function setName(name) {
      name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
      feature(function () { localStorage.setItem(NAME_KEY, name); });
      return name;
    }

    function byScore(a, b) {
      return (b.score - a.score) || (b.netWorth - a.netWorth) || (a.at - b.at);
    }

    return {
      /** Подменить источник: сюда встанет база, когда она появится. */
      use: function (src) { if (src && src.list && src.add) source = src; },
      me: me,
      setName: setName,
      submit: function (entry) { return source.add(entry); },
      rename: function (id, name) { return source.rename(id, name); },
      clear: function () { source.clear(); },
      list: function (opts) {
        opts = opts || {};
        var rows = source.list().filter(function (r) {
          if (opts.cupOnly && !r.cup) return false;
          if (opts.scenarioId && r.scenarioId !== opts.scenarioId) return false;
          return true;
        });
        rows.sort(byScore);
        return opts.limit ? rows.slice(0, opts.limit) : rows;
      }
    };
  })();

  /* Состояние игры */

  var G = {
    scenario: null,      // определение сценария (со слотами)
    built: null,         // сценарий с собранными событиями — для отображения
    seed: null,
    choices: [],
    run: null,
    forecastErrors: [],
    screen: 'menu',
    level: 1,
    filter: 'all',        // какие сценарии показывать: все / не сыграно / сыграно
    openSheet: null,
    exPeriod: '1y',
    timelineFull: false,
    replay: null,        // какая сохранённая партия открыта на экране итогов
    returnTo: null,      // куда вернёт «Назад», если пришли не из меню
    picked: null,        // сценарий под курсором/фокусом — для главного CTA
    animating: false,
    desktop: false
  };

  var root = document.getElementById('app');

  function newSeed() {
    return String(Date.now() % 100000) + '-' + Math.floor(Math.random() * 1000);
  }

  function recompute() {
    // Сценарий со слотами разворачивается в конкретный набор событий по seed.
    G.built = E.resolveScenario(G.scenario, C.pool, G.seed);
    G.run = E.simulate(G.built, G.seed, G.choices);
    return G.run;
  }

  /*
   *  ЭКРАН: заставка «Пять лет спустя»
   *
   *  Загрузка здесь — не спиннер, а метафора партии. Пока собирается
   *  сценарий, стрелка часов делает пять оборотов, счётчик в центре
   *  отсчитывает годы, а шкала из 60 месяцев заполняется слева направо.
   *  Кольцо, стрелка, счётчик, шкала и бегунок питаются одним значением
   *  прогресса: это один механизм, а не пять независимых анимаций.
   *
   *  Пропускается по клику, Enter, Esc, пробелу и автоматически —
   *  задерживать игрока на неинтерактивном экране нельзя.
   */

  var SPLASH_MONTHS = 60;      // месяцев в партии
  var SPLASH_YEARS = 5;        // и лет соответственно
  var SPLASH_BUILD_MS = 2900;  // сколько «идут» пять лет
  var SPLASH_HOLD_MS = 1800;   // сколько экран ждёт игрока после «Готово»

  function renderSplash() {
    G.screen = 'splash';
    MaxBridge.backButton(false);
    root.innerHTML = '';

    var reduced = feature(function () {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }, false);

    var w = el('div', 'screen splash');
    var stage = el('div', 'splash-stage');
    var ns = 'http://www.w3.org/2000/svg';

    /* Часы: циферблат на 60 месяцев */

    var clock = el('div', 'splash-clock');
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 112 112');
    svg.setAttribute('aria-hidden', 'true');

    // Градиент кольца: от тусклой латуни к светлой — прогресс «нагревается»
    var defs = document.createElementNS(ns, 'defs');
    var grad = document.createElementNS(ns, 'linearGradient');
    grad.setAttribute('id', 'scGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
    [['0', '#8E7038'], ['0.55', '#C9A15C'], ['1', '#E6C892']].forEach(function (s) {
      var st = document.createElementNS(ns, 'stop');
      st.setAttribute('offset', s[0]);
      st.setAttribute('stop-color', s[1]);
      grad.appendChild(st);
    });
    defs.appendChild(grad);
    svg.appendChild(defs);

    // Засечки: 60 штук по числу месяцев, каждая двенадцатая — граница года
    var cx = 56, cy = 56;
    for (var i = 0; i < SPLASH_MONTHS; i++) {
      var isYear = (i % 12 === 0);
      var a = (i / SPLASH_MONTHS) * Math.PI * 2 - Math.PI / 2;
      var r1 = isYear ? 38 : 41.5;
      var r2 = 45;
      var ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', (cx + Math.cos(a) * r1).toFixed(2));
      ln.setAttribute('y1', (cy + Math.sin(a) * r1).toFixed(2));
      ln.setAttribute('x2', (cx + Math.cos(a) * r2).toFixed(2));
      ln.setAttribute('y2', (cy + Math.sin(a) * r2).toFixed(2));
      ln.setAttribute('class', 'sc-face' + (isYear ? ' year' : ''));
      svg.appendChild(ln);
    }

    var R = 51;
    var CIRC = 2 * Math.PI * R;

    var rail = document.createElementNS(ns, 'circle');
    rail.setAttribute('cx', cx); rail.setAttribute('cy', cy); rail.setAttribute('r', R);
    rail.setAttribute('class', 'sc-rail');
    svg.appendChild(rail);

    // Шлейф стрелки — короткая дуга позади неё, чтобы движение читалось.
    // Пунктир задаётся ровно на длину окружности: с произвольным зазором
    // рисунок повторяется реже, чем виток, и дуга просто пропадает.
    var TR = 34;
    var TR_C = 2 * Math.PI * TR;
    var TR_ARC = TR_C * 0.16;
    var trail = document.createElementNS(ns, 'circle');
    trail.setAttribute('cx', cx); trail.setAttribute('cy', cy); trail.setAttribute('r', String(TR));
    trail.setAttribute('class', 'sc-trail');
    trail.setAttribute('stroke-dasharray', TR_ARC.toFixed(2) + ' ' + (TR_C - TR_ARC).toFixed(2));
    svg.appendChild(trail);

    var ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', cx); ring.setAttribute('cy', cy); ring.setAttribute('r', R);
    ring.setAttribute('class', 'sc-ring');
    ring.setAttribute('stroke-dasharray', CIRC.toFixed(2));
    ring.setAttribute('stroke-dashoffset', CIRC.toFixed(2));
    svg.appendChild(ring);

    // Стрелка сделана коротким штрихом у обода, а не спицей из центра:
    // полноразмерная стрелка перечёркивала цифру года в середине.
    var handG = document.createElementNS(ns, 'g');
    var tail = document.createElementNS(ns, 'path');
    tail.setAttribute('d', 'M56 32V27');
    tail.setAttribute('class', 'sc-hand sc-hand-tail');
    handG.appendChild(tail);
    var hand = document.createElementNS(ns, 'path');
    hand.setAttribute('d', 'M56 26V13');
    hand.setAttribute('class', 'sc-hand');
    handG.appendChild(hand);
    svg.appendChild(handG);

    clock.appendChild(svg);

    var yearBox = el('div', 'sc-year');
    var yearNum = el('div', 'sc-year-num', '0');
    var yearLab = el('div', 'sc-year-lab', 'год');
    yearBox.appendChild(yearNum);
    yearBox.appendChild(yearLab);
    clock.appendChild(yearBox);
    stage.appendChild(clock);

    /* Заголовок */

    stage.appendChild(el('div', 'splash-kicker', 'финансовый симулятор'));

    var title = el('h1', 'splash-title');
    // Внутренний <i> едет из-под маски: у строк появляется вес титра
    var l1 = el('span', 'splash-line'); l1.appendChild(el('i', null, 'Пять лет'));
    var l2 = el('span', 'splash-line splash-line-2'); l2.appendChild(el('i', null, 'спустя'));
    title.appendChild(l1);
    title.appendChild(l2);
    stage.appendChild(title);

    stage.appendChild(el('p', 'splash-sub',
      'Каждое решение кажется разумным в момент, когда вы его принимаете. Счёт приходит позже.'));

    /* Шкала времени = индикатор загрузки */

    var tl = el('div', 'splash-tl');
    var tlRail = el('div', 'stl-rail');
    var ticks = [];
    for (var m = 0; m < SPLASH_MONTHS; m++) {
      var t = el('i', 'stl-tick' + (m % 12 === 0 ? ' year' : ''));
      tlRail.appendChild(t);
      ticks.push(t);
    }
    var head = el('i', 'stl-head');
    tlRail.appendChild(head);
    tl.appendChild(tlRail);

    var yearsRow = el('div', 'stl-years');
    var yearLabels = [];
    for (var y = 1; y <= SPLASH_YEARS; y++) {
      var yl = el('span', 'stl-year', y === 1 ? '1 год' : (y < 5 ? y + ' года' : y + ' лет'));
      yearsRow.appendChild(yl);
      yearLabels.push(yl);
    }
    tl.appendChild(yearsRow);

    var marks = el('div', 'stl-marks');
    marks.appendChild(el('span', null, 'сегодня'));
    marks.appendChild(el('span', null, 'через 60 месяцев'));
    tl.appendChild(marks);
    stage.appendChild(tl);

    /* Журнал сборки: показывает, что именно собирается */

    var steps = [
      { at: .00, text: 'Собираем сценарии' },
      { at: .30, text: 'Раскладываем события по месяцам' },
      { at: .62, text: 'Считаем рынок и цены' },
      { at: .92, text: 'Партия готова' }
    ];
    var log = el('div', 'splash-log');
    var rows = steps.map(function (st) {
      var row = el('div', 'slog-row');
      row.appendChild(el('i', 'slog-dot'));
      row.appendChild(el('span', 'slog-txt', st.text));
      log.appendChild(row);
      return row;
    });
    stage.appendChild(log);

    /* Действия */

    var actions = el('div', 'splash-actions');
    var go = el('button', 'primary-btn splash-cta');
    go.appendChild(el('span', null, 'Начать'));
    go.appendChild(icon('arrow'));
    go.disabled = true;
    go.onclick = function () { MaxBridge.haptic('medium'); leaveSplash(); };
    actions.appendChild(go);
    var skip = el('button', 'link-btn splash-skip', 'Пропустить');
    skip.onclick = function () { leaveSplash(); };
    actions.appendChild(skip);
    stage.appendChild(actions);

    w.appendChild(stage);
    w.appendChild(el('div', 'splash-foot',
      'Обучающая модель. Все организации, бумаги и предложения вымышлены.'));

    root.appendChild(w);
    resetScroll();

    /* Один механизм на всё движение */

    var lit = 0;         // сколько месяцев уже прожито
    var shownYear = 0;   // какой год показан в центре часов
    var doneStep = -1;   // последняя отмеченная строка журнала
    var raf = 0;
    var autoTimer = 0;
    var buildTimer = 0;
    var hotTimers = [];

    // Ход времени почти ровный: резкий easeOut съедал первые годы
    // за первые кадры, и счётчик успевал долететь до пятёрки раньше шкалы.
    function easeOut(p) { return 1 - Math.pow(1 - p, 1.6); }

    function apply(p) {
      if (p < 0) p = 0; else if (p > 1) p = 1;

      // Кольцо и стрелка
      ring.setAttribute('stroke-dashoffset', (CIRC * (1 - p)).toFixed(2));
      var deg = p * 360 * SPLASH_YEARS;
      handG.setAttribute('transform', 'rotate(' + deg.toFixed(2) + ' 56 56)');
      trail.setAttribute('stroke-dashoffset',
        (TR_ARC - (deg / 360) * TR_C % TR_C).toFixed(2));

      // Счётчик лет в центре
      var yr = Math.min(SPLASH_YEARS, Math.floor(p * SPLASH_YEARS) + 1);
      if (yr !== shownYear) {
        shownYear = yr;
        yearNum.textContent = String(yr);
        yearLab.textContent = (yr === 1 ? 'год' : yr < 5 ? 'года' : 'лет');
        yearNum.classList.remove('flip');
        void yearNum.offsetWidth;   // перезапуск анимации переворота
        yearNum.classList.add('flip');
      }

      // Шкала месяцев
      var target = Math.round(p * SPLASH_MONTHS);
      while (lit < target) {
        var node = ticks[lit];
        node.classList.add('lit', 'hot');
        (function (n) {
          hotTimers.push(setTimeout(function () { n.classList.remove('hot'); }, 260));
        })(node);
        lit++;
        if (lit % 12 === 0) {
          var idx = lit / 12 - 1;
          if (yearLabels[idx]) yearLabels[idx].classList.add('on');
        }
      }
      head.style.left = 'calc(' + (p * 100) + '% - 0.5px)';

      // Журнал: активная строка одна, предыдущие отмечены галочкой
      for (var s = 0; s < steps.length; s++) {
        if (p >= steps[s].at && s > doneStep) {
          if (rows[s - 1]) rows[s - 1].classList.add('done');
          rows[s].classList.add('on');
          doneStep = s;
        }
      }
    }

    var finished = false;
    function finish() {
      if (finished || done) return;
      finished = true;
      clearTimeout(buildTimer);
      apply(1);
      // Последняя строка журнала не пульсирует, а горит латунью: партия собрана.
      for (var s = 0; s < rows.length; s++) rows[s].classList.add('done');
      rows[rows.length - 1].classList.add('on', 'ready');
      tl.classList.add('done');
      go.disabled = false;
      go.classList.add('ready');
      MaxBridge.haptic('light');
      autoTimer = setTimeout(leaveSplash, SPLASH_HOLD_MS);
    }

    if (reduced) {
      // «Меньше движения»: экран тот же, но собран сразу.
      finish();
    } else if (window.requestAnimationFrame) {
      var t0 = 0;
      var tick = function (now) {
        if (done || finished) return;
        var p = (now - t0) / SPLASH_BUILD_MS;
        apply(easeOut(Math.min(1, p)));
        if (p < 1) raf = requestAnimationFrame(tick);
        else finish();
      };
      raf = requestAnimationFrame(function (now) {
        t0 = now;
        tick(now);
      });
      // Страховка: во вкладке в фоне requestAnimationFrame останавливается,
      // и без таймера игрок вернулся бы к недособранной заставке.
      buildTimer = setTimeout(finish, SPLASH_BUILD_MS + 150);
    } else {
      finish();   // очень старый движок — просто показываем готовый экран
    }

    /* Лёгкий параллакс: экран отзывается на курсор */

    var onMove = null;
    var finePointer = feature(function () {
      return !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
    }, false);
    if (!reduced && finePointer) {
      onMove = function (e) {
        var dx = (e.clientX / window.innerWidth - .5) * 10;
        var dy = (e.clientY / window.innerHeight - .5) * 7;
        stage.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
      };
      document.addEventListener('mousemove', onMove);
    }

    /* Выход */

    var done = false;
    function leaveSplash() {
      // Автопереход не должен срабатывать, если игрок уже ушёл с заставки
      // другим путём: иначе отложенный таймер выкинет его из партии в меню.
      if (done || G.screen !== 'splash') return;
      done = true;
      if (raf && window.cancelAnimationFrame) cancelAnimationFrame(raf);
      clearTimeout(autoTimer);
      clearTimeout(buildTimer);
      hotTimers.forEach(function (t) { clearTimeout(t); });
      document.removeEventListener('keydown', onKey);
      if (onMove) document.removeEventListener('mousemove', onMove);
      renderMenu();
    }
    function onKey(e) {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') {
        if (e.preventDefault) e.preventDefault();
        leaveSplash();
      }
    }
    document.addEventListener('keydown', onKey);
  }

  /*
   *  ЭКРАН: меню
   *
   *  Композиция: шапка → hero → уровень давления → сценарии-уровни →
   *  компактная сводка прогресса → главный CTA.
   *  Сценарии выглядят как игровые уровни: номер, превью старта, метрики.
   */

  /**
   * Меню.
   *
   * keepScroll — «мягкая» перерисовка: уровень, фильтр, обновлённая
   * карточка. Экран тот же самый, игрок остаётся на том же месте
   * страницы. Без этого любой клик по контейнеру отбрасывал его
   * в самое начало, и список приходилось искать заново.
   */
  function renderMenu(keepScroll) {
    var savedY = keepScroll ? window.scrollY : 0;
    G.screen = 'menu';
    // Выход из партии снимает замок ввода: иначе незавершённая анимация
    // хода могла бы запереть кнопки уже на другом экране.
    G.animating = false;
    MaxBridge.backButton(false);
    root.innerHTML = '';
    var w = el('div', 'screen menu');
    w.appendChild(buildAppbar());

    var wrap = el('div', 'menu-wrap');

    /*
     * Hero
     *       Левая колонка живёт в двух состояниях: вступление и показ игры.
     *       Их собирают отдельные функции, чтобы переключаться без перерисовки
     *       всего меню — иначе при каждом ходе показа экран бы прыгал.
     */
    var hero = el('section', 'hero');
    var copy = el('div', 'hero-copy');
    copy.id = 'hero-copy';
    copy.appendChild(G.demo ? buildDemoPanel() : buildHeroIntro());
    hero.appendChild(copy);
    hero.appendChild(G.demo ? buildDemoChart() : buildHeroPath());
    wrap.appendChild(hero);

    wrap.appendChild(blockHead('01', 'Уровень давления',
      'Определяет размер сумм и цену ошибки', 'block-levels'));
    wrap.appendChild(buildLevelPicker());

    /*
     * Сценарии как уровни
     *       Отдельным узлом: смена уровня давления меняет только его, и ради
     *       неё не нужно пересобирать весь экран.
     */
    wrap.appendChild(buildScenarioSection());

    /* Компактная сводка прогресса */
    var err = Store.avgForecastError();
    var conceptsTotal = Object.keys(C.concepts).length;
    var opened = Store.data.concepts.length;

    var progress = el('section', 'progress-overview');
    var figs = el('div', 'po-figs');
    figs.appendChild(poFig(String(opened), 'из ' + conceptsTotal + ' решений открыто'));
    figs.appendChild(el('i', 'po-div'));
    figs.appendChild(poFig(String(Store.data.runs.length), 'партий сыграно'));
    figs.appendChild(el('i', 'po-div'));
    figs.appendChild(poFig(
      err == null ? '—' : (100 - Math.min(100, err * 100)).toFixed(0) + '%',
      'точность оценок'));
    progress.appendChild(figs);

    var ptr = el('div', 'progress-track');
    var pct = clamp(100 * opened / conceptsTotal, 0, 100);
    var pfill = el('i');
    pfill.style.width = pct.toFixed(1) + '%';
    ptr.appendChild(pfill);
    progress.appendChild(ptr);

    var plinks = el('div', 'po-links');
    var plink = el('button', 'po-link');
    plink.appendChild(el('span', null, 'Карточки знаний'));
    plink.appendChild(icon('arrow'));
    plink.onclick = function () { MaxBridge.haptic('light'); renderLibrary(); };
    plinks.appendChild(plink);

    var llink = el('button', 'po-link');
    llink.appendChild(el('span', null, 'Таблица лидеров'));
    llink.appendChild(icon('arrow'));
    llink.onclick = function () { MaxBridge.haptic('light'); renderLeaders(); };
    plinks.appendChild(llink);

    var alink = el('button', 'po-link');
    alink.appendChild(el('span', null, 'Достижения'));
    alink.appendChild(icon('arrow'));
    alink.onclick = function () { MaxBridge.haptic('light'); renderAchievements(); };
    plinks.appendChild(alink);

    // История партий: итоги больше не одноразовые, к ним можно вернуться.
    var hlink = el('button', 'po-link');
    hlink.appendChild(el('span', null, 'История партий'));
    hlink.appendChild(icon('arrow'));
    hlink.onclick = function () { MaxBridge.haptic('light'); renderHistory(); };
    plinks.appendChild(hlink);
    progress.appendChild(plinks);
    wrap.appendChild(progress);

    /* Главный CTA */
    var cta = el('div', 'menu-cta');
    var info = el('div', 'cta-info');
    info.appendChild(el('div', 'cta-lab', 'Выбран сценарий'));
    var nm = el('div', 'cta-name', G.picked ? G.picked.title : '—');
    nm.id = 'cta-name';
    info.appendChild(nm);
    cta.appendChild(info);

    var actions = el('div', 'cta-actions');
    var dice = el('button', 'ghost-btn dice-btn');
    dice.id = 'cta-dice';
    dice.appendChild(icon('dice'));
    dice.appendChild(el('span', null, 'Случайная'));
    dice.onclick = function () { rollRandom(); };
    actions.appendChild(dice);

    var start = el('button', 'primary-btn cta-main');
    start.id = 'cta-start';
    start.appendChild(el('span', null, 'Начать партию'));
    start.appendChild(icon('arrow'));
    start.onclick = function () {
      if (G.rolling) return;
      MaxBridge.haptic('medium');
      if (G.picked) startScenario(G.picked);
    };
    actions.appendChild(start);
    cta.appendChild(actions);
    wrap.appendChild(cta);

    w.appendChild(wrap);

    var disc = el('div', 'disclaimer');
    disc.textContent = 'Это обучающая модель. Все организации и предложения вымышлены. Приложение не даёт финансовых рекомендаций и не является консультацией.';
    w.appendChild(disc);
    root.appendChild(w);
    if (keepScroll) {
      // Замки прокрутки снимаем (экран пересобран), но само положение
      // страницы возвращаем на место — без плавности: для игрока ничего
      // и не двигалось, он просто нажал на контейнер.
      clearScrollLocks();
      var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.min(savedY, maxY));
    } else {
      resetScroll();
    }
  }

  /**
   * Блок «02 · Сценарий»: заголовок, фильтр и сетка карточек.
   *
   * Единственная часть меню, которая зависит от уровня давления и от
   * фильтра. Отдельной функцией — чтобы при смене уровня менять её одну,
   * а не пересобирать экран: раньше каждый щелчок по ползунку заново
   * строил всё меню, и страница на миг «моргала».
   */
  function buildScenarioSection() {
    var sec = el('div', 'sc-section');
    var list = scenariosFor(G.level);
    if (!G.picked || list.indexOf(G.picked) === -1) G.picked = list[0] || null;

    var playedIds = {};
    Store.data.runs.forEach(function (r) { playedIds[r.scenarioId] = true; });
    var playedHere = list.filter(function (x) { return playedIds[x.id]; }).length;

    sec.appendChild(blockHead('02', 'Сценарий',
      playedHere + ' из ' + list.length + ' сыграно на этом уровне'));

    /* Пятнадцать карточек — это уже список, в котором надо ориентироваться.
       Фильтр отвечает на единственный вопрос, который тут возникает:
       «что я ещё не проходил». Выбор фильтра живёт до конца сессии. */
    var filters = el('div', 'sc-filters');
    [['all', 'Все', list.length],
     ['new', 'Не сыграно', list.length - playedHere],
     ['done', 'Сыграно', playedHere]].forEach(function (f) {
      var b = el('button', 'sc-filter' + (G.filter === f[0] ? ' on' : ''));
      b.appendChild(el('span', null, f[1]));
      b.appendChild(el('span', 'scf-num', String(f[2])));
      b.disabled = f[2] === 0 && f[0] !== 'all';
      b.onclick = function () {
        if (G.rolling) return;
        G.filter = f[0];
        MaxBridge.hapticSelect();
        // Фильтр меняет только список — экран целиком не трогаем.
        refreshScenarios();
      };
      filters.appendChild(b);
    });
    sec.appendChild(filters);

    if (G.filter === 'new') list = list.filter(function (x) { return !playedIds[x.id]; });
    else if (G.filter === 'done') list = list.filter(function (x) { return playedIds[x.id]; });
    if (!list.length) { G.filter = 'all'; list = scenariosFor(G.level); }
    if (list.indexOf(G.picked) === -1) G.picked = list[0] || null;

    var grid = el('div', 'level-grid');
    list.forEach(function (sc, index) {
      var card = el('button', 'scenario-card' + (sc === G.picked ? ' on' : ''));
      card.setAttribute('aria-label', 'Начать сценарий: ' + sc.title);
      card.setAttribute('aria-selected', sc === G.picked ? 'true' : 'false');

      var glow = el('i', 'sc-glow');
      card.appendChild(glow);

      var top = el('div', 'sc-top');
      top.appendChild(el('span', 'sc-index', String(index + 1).padStart(2, '0')));
      var best = Store.data.best[sc.id];
      if (best != null) {
        var badge = el('span', 'sc-badge');
        badge.appendChild(icon('flag'));
        badge.appendChild(el('span', null, fmtShort(best)));
        top.appendChild(badge);
      }
      card.appendChild(top);

      card.appendChild(el('div', 'sc-title', sc.title));
      card.appendChild(el('div', 'sc-tag', sc.tagline));
      card.appendChild(buildStars(sc));

      // Превью ключевого этапа: с чем игрок стартует. Это то, что отличает
      // один «уровень» от другого сильнее, чем название.
      card.appendChild(buildScenarioPreview(sc));

      var meta = el('div', 'sc-meta');
      meta.appendChild(metaChip('clock', sc.months + ' мес'));
      var count = (sc.fixed || []).length + (sc.slots || []).length;
      meta.appendChild(metaChip('layers', '~' + count + ' решений'));
      var played = Store.data.runs.filter(function (r) { return r.scenarioId === sc.id; }).length;
      if (played) meta.appendChild(metaChip('refresh', played + ' ' + plural(played, 'партия', 'партии', 'партий')));
      card.appendChild(meta);

      var goal = el('div', 'sc-goal');
      goal.appendChild(icon('flag'));
      goal.appendChild(el('span', null, sc.goalText));
      card.appendChild(goal);

      // Подпись меняется вместе с состоянием: пока сценарий не выбран,
      // клик выбирает его, а не начинает партию.
      var go = el('span', 'sc-go');
      go.appendChild(el('span', 'sc-go-text', sc === G.picked ? 'Играть' : 'Выбрать'));
      go.appendChild(icon('arrow'));
      card.appendChild(go);

      /* Наведение НЕ выбирает сценарий.
         Раньше выбор ставился на onmouseenter, и после того как курсор уходил
         в пустое место, подсветка оставалась на случайной карточке — выглядело
         так, будто интерфейс завис. Выбор — это действие, а не побочный
         эффект движения мыши. */
      card.onclick = function () {
        if (G.rolling) return;
        if (G.picked === sc) {
          MaxBridge.haptic('medium');
          startScenario(sc);
          return;
        }
        MaxBridge.hapticSelect();
        selectScenario(sc);
      };
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    return sec;
  }

  /**
   * Перерисовать список сценариев на месте.
   *
   * Меняется ровно один узел; шапка, ползунок, сводка прогресса и кнопка
   * внизу остаются теми же самыми объектами. Прокрутка, фокус и анимации
   * за пределами блока не сбиваются.
   */
  function refreshScenarios() {
    var old = document.querySelector('.sc-section');
    var parent = old && old.parentNode;
    // Блока нет (экран не меню или ещё не построен) либо окружение не
    // умеет заменять узлы — тогда обычная сборка меню и есть правильный
    // путь: результат тот же, просто дороже.
    if (!parent || typeof parent.replaceChild !== 'function') { renderMenu(true); return; }
    parent.replaceChild(buildScenarioSection(), old);
    var nameNode = document.getElementById('cta-name');
    if (nameNode) nameNode.textContent = G.picked ? G.picked.title : '—';
  }

  /*
   *  ВЫБОР СЦЕНАРИЯ
   *
   *  Выбор — состояние меню, а не побочный эффект наведения курсора.
   *  Первый клик по карточке выбирает сценарий, второй (или большая
   *  кнопка внизу) начинает партию. Так же работает и жеребьёвка:
   *  кубик только выбирает, играть или нет — решает игрок.
   */

  /** Высота липкой шапки: под ней ничего не должно прятаться. */
  function stickyTop() {
    var bar = document.querySelector('.appbar');
    return (bar ? bar.getBoundingClientRect().height : 0) + 12;
  }

  /**
   * Плавная прокрутка к точке.
   *
   * Штатный behavior:'smooth' проходит любое расстояние примерно за одно
   * и то же время: короткий путь получается мягким, длинный — рывком на
   * полторы тысячи пикселей. Здесь длительность растёт вместе с
   * расстоянием, поэтому и близкий, и далёкий переезд идут с одинаково
   * спокойной скоростью.
   *
   * Любое действие игрока — колесо, палец, клавиша — прокрутку отменяет:
   * перебивать человека, который уже сам куда-то поехал, нельзя.
   */
  var scrollAnim = 0;

  function smoothScrollTo(y) {
    var maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    var to = Math.max(0, Math.min(y, maxY));
    var from = window.scrollY;
    var dist = to - from;
    if (scrollAnim) cancelAnimationFrame(scrollAnim);
    if (Math.abs(dist) < 2) return;
    if (reducedMotion() || !window.requestAnimationFrame) { window.scrollTo(0, to); return; }

    var dur = Math.max(400, Math.min(1800, Math.abs(dist) * 0.7));
    var t0 = null;
    function stop() { if (scrollAnim) cancelAnimationFrame(scrollAnim); scrollAnim = 0; drop(); }
    function drop() {
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    }
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', stop);

    scrollAnim = requestAnimationFrame(function step(now) {
      if (t0 === null) t0 = now;
      var k = Math.min(1, (now - t0) / dur);
      // Плавный разгон и такое же плавное торможение.
      var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      window.scrollTo(0, from + dist * e);
      if (k < 1) scrollAnim = requestAnimationFrame(step);
      else { scrollAnim = 0; drop(); }
    });
  }

  /**
   * Подвести экран так, чтобы элемент оказался у верхней кромки.
   * Нужна там, где игрок переходит от рассматривания к выбору:
   * шапка уезжает, а список занимает весь экран.
   */
  function scrollElementToTop(node) {
    if (!node) return;
    smoothScrollTo(window.scrollY + node.getBoundingClientRect().top - stickyTop());
  }

  /*
   *  ВЫБОР УРОВНЯ — ОДИН ПОЛЗУНОК
   *
   *  Пять карточек занимали целый экран и требовали читать пять
   *  описаний сразу. Ползунок говорит то же самое одной линией:
   *  слева легче, справа тяжелее, а за разрывом — соревнование,
   *  которое не «ещё сложнее», а другое.
   *
   *  Кружок можно тащить, по полосе — щёлкать, по названию — тоже,
   *  и всё это работает с клавиатуры: полоса объявляет себя слайдером.
   *  Пока идёт перетаскивание, меню не пересобирается — иначе узел,
   *  за который держится палец, исчезал бы из-под него. Уровень
   *  назначается один раз, когда кружок отпустили.
   */

  /** Доля полосы, на которой стоит уровень. Перед соревнованием — разрыв. */
  function levelPercent(index, count) {
    if (count <= 1) return 0;
    var lastIsCup = C.levels[count - 1] && C.levels[count - 1].cup;
    if (!lastIsCup) return index / (count - 1);
    // Обычные ступени занимают две трети полосы, остаток — разрыв.
    var normal = count - 1;                       // сколько ступеней сложности
    if (index >= normal) return 1;
    return normal > 1 ? (index / (normal - 1)) * 0.68 : 0;
  }

  /**
   * Доля полосы → координата в CSS.
   *
   * Ноль и единица теперь не кромка полосы, а отступ от неё: крайние
   * засечки отодвинуты внутрь на --lvl-pad, и кружок в крайних положениях
   * целиком лежит на карточке. Одна и та же формула считает положение
   * засечек, кружка, заливки и подсказки — разъехаться им негде.
   */
  function lvlPos(p) {
    return 'calc(var(--lvl-pad) + var(--lvl-span) * ' + p.toFixed(4) + ')';
  }

  function buildLevelPicker() {
    var levels = C.levels;
    var count = levels.length;
    var current = 0;
    levels.forEach(function (lv, i) { if (lv.id === G.level) current = i; });

    var box = el('section', 'level-picker');
    box.setAttribute('data-level', String(levels[current].id));

    /* --- Подписи над полосой ---
       Координаты расставляет layoutLabels: подпись центрируется по своей
       засечке и прижимается к краю, только если иначе вылезет за полосу. */
    var labels = el('div', 'lvl-labels');
    levels.forEach(function (lv, i) {
      var b = el('button', 'lvl-label' + (i === current ? ' on' : '') + (lv.cup ? ' cup' : ''));
      b.type = 'button';
      b.appendChild(el('span', null, lv.title));
      b.onclick = function () {
        if (G.rolling) return;
        MaxBridge.hapticSelect();
        commit(i);
      };
      labels.appendChild(b);
    });
    box.appendChild(labels);

    /* --- Полоса --- */
    var track = el('div', 'lvl-track');
    track.setAttribute('role', 'slider');
    track.setAttribute('tabindex', '0');
    track.setAttribute('aria-label', 'Уровень давления');
    track.setAttribute('aria-orientation', 'horizontal');
    track.setAttribute('aria-valuemin', '1');
    track.setAttribute('aria-valuemax', String(count));

    var rail = el('i', 'lvl-rail');
    track.appendChild(rail);
    // Пунктир перед соревнованием рисуем ДО заливки: иначе он ложится
    // поверх неё, когда кружок доехал до золотой засечки.
    if (levels[count - 1] && levels[count - 1].cup) {
      var gapLine = el('i', 'lvl-gap');
      gapLine.style.left = lvlPos(levelPercent(count - 2, count));
      track.appendChild(gapLine);
    }
    var fill = el('i', 'lvl-fill');
    track.appendChild(fill);

    var notches = [];
    levels.forEach(function (lv, i) {
      var n = el('i', 'lvl-notch' + (lv.cup ? ' cup' : ''));
      n.style.left = lvlPos(levelPercent(i, count));
      track.appendChild(n);
      notches.push(n);
    });

    var knob = el('span', 'lvl-knob');
    knob.appendChild(el('i', 'lvl-knob-dot'));
    track.appendChild(knob);

    // Подсказка над кружком: на телефоне подписи спрятаны, и без неё
    // во время перетаскивания непонятно, что выбрано прямо сейчас.
    var bubble = el('span', 'lvl-bubble');
    track.appendChild(bubble);
    box.appendChild(track);

    /* --- Описание выбранного уровня: всё то же, что было в плитке --- */
    var info = el('div', 'lvl-info');
    var head = el('div', 'lvl-head');
    var name = el('h3', 'lvl-name');
    head.appendChild(name);
    var cnt = el('span', 'diff-count');
    head.appendChild(cnt);
    var dots = el('span', 'diff-dots');
    for (var d = 0; d < count; d++) dots.appendChild(el('i', 'dot'));
    head.appendChild(dots);
    info.appendChild(head);

    var desc = el('div', 'lvl-desc');
    info.appendChild(desc);

    var flag = el('div', 'diff-flag lvl-flag');
    var flagIcon = el('span', 'lvl-flag-ic');
    var flagText = el('span', null, '');
    flag.appendChild(flagIcon);
    flag.appendChild(flagText);
    info.appendChild(flag);

    var risk = el('div', 'diff-risk lvl-risk');
    risk.appendChild(el('span', 'dr-lab', 'Риск'));
    var meter = el('span', 'dr-meter');
    for (var m = 0; m < count; m++) meter.appendChild(el('i'));
    risk.appendChild(meter);
    var riskVal = el('span', 'dr-val');
    risk.appendChild(riskVal);
    info.appendChild(risk);
    box.appendChild(info);

    /* --- Отрисовка состояния без пересборки меню ---
       freeP — «сырое» положение кружка под пальцем. Пока его тащат,
       кружок стоит там, где палец, а подписи и описание уже показывают
       ближайшую ступень. Отпустили — freeP нет, и кружок доезжает до
       засечки сам, обычным переходом. */
    var shown = current;

    /**
     * Цвет полосы на произвольной точке пути.
     *
     * Между засечками цвет не переключается на середине, а держится за
     * текущей ступенью и перетекает в следующую, только когда кружок
     * подошёл к ней вплотную. Смешивание отдано CSS: скрипт лишь называет
     * два соседних цвета ступеней и долю между ними, поэтому переход
     * остаётся правильным в обеих темах.
     */
    function paintColor(p) {
      var i = 0;
      while (i < count - 2 && levelPercent(i + 1, count) <= p) i++;
      var a = levelPercent(i, count), b = levelPercent(i + 1, count);
      var u = b > a ? clamp((p - a) / (b - a), 0, 1) : 0;
      // Переход начинается на подходе к следующей засечке и там же кончается.
      var t = clamp((u - 0.45) / 0.5, 0, 1);
      t = t * t * (3 - 2 * t);
      // Окружения без setProperty (проверки без браузера) просто остаются
      // на цвете из таблицы стилей: сам выбор уровня от этого не зависит.
      if (!box.style || !box.style.setProperty) return;
      box.style.setProperty('--lvl-a', 'var(--lvl-c' + (i + 1) + ')');
      box.style.setProperty('--lvl-b', 'var(--lvl-c' + (i + 2) + ')');
      box.style.setProperty('--lvl',
        t <= 0.001 ? 'var(--lvl-a)'
        : t >= 0.999 ? 'var(--lvl-b)'
        : 'color-mix(in srgb, var(--lvl-b) ' + (t * 100).toFixed(1) + '%, var(--lvl-a))');
    }

    function paint(i, freeP) {
      shown = i;
      var lv = levels[i];
      var p = freeP == null ? levelPercent(i, count) : freeP;
      var at = lvlPos(p);
      knob.style.left = at;
      fill.style.width = at;
      bubble.style.left = at;
      paintColor(p);
      box.setAttribute('data-level', String(lv.id));
      box.classList.toggle('is-cup', !!lv.cup);
      track.setAttribute('aria-valuenow', String(i + 1));
      track.setAttribute('aria-valuetext', lv.title);

      name.textContent = lv.title;
      bubble.textContent = lv.title;
      cnt.textContent = String(scenariosFor(lv.id).length);
      desc.textContent = lv.sub;
      riskVal.textContent = lv.risk || '—';

      var lbs = labels.children;
      for (var k = 0; k < lbs.length; k++) lbs[k].classList.toggle('on', k === i);
      for (var n = 0; n < notches.length; n++) notches[n].classList.toggle('done', n <= i);
      for (var q = 0; q < dots.children.length; q++) {
        dots.children[q].classList.toggle('on', q <= i);
      }
      for (var r = 0; r < meter.children.length; r++) {
        meter.children[r].classList.toggle('on', r <= i);
      }

      var warn = lv.cup
        ? 'Один сценарий на всех, случайности одинаковые — результат идёт в таблицу'
        : lv.id >= 4 ? 'Без подсказок, бюджет в минусе с первого месяца'
        : lv.id === 3 ? 'Без подсказок: цена решения видна, остаток считаете сами'
        : '';
      flag.classList.toggle('hidden', !warn);
      flag.classList.toggle('cup', !!lv.cup);
      flagText.textContent = warn;
      flagIcon.innerHTML = '';
      if (warn) flagIcon.appendChild(icon(lv.cup ? 'flag' : 'alert'));
    }

    /** Отступ полосы от краёв — единственное место, где он читается из CSS. */
    function padPx() {
      var raw = getComputedStyle(track).getPropertyValue('--lvl-pad');
      var v = parseFloat(raw);
      return v > 0 ? v : 22;
    }

    /**
     * Подписи над полосой.
     *
     * Раньше крайние две выравнивались правилами :first-child/:last-child
     * и уезжали от своих засечек. Теперь каждая центрируется по точке и
     * только упирается в край, если иначе вылезла бы за полосу.
     */
    function layoutLabels() {
      var w = labels.clientWidth;
      if (!w) return;
      var pad = padPx();
      var span = Math.max(0, w - pad * 2);
      for (var i = 0; i < labels.children.length; i++) {
        var lb = labels.children[i];
        var center = pad + levelPercent(i, count) * span;
        var lw = lb.offsetWidth;
        lb.style.left = clamp(center - lw / 2, 0, Math.max(0, w - lw)).toFixed(1) + 'px';
      }
    }

    /**
     * Назначить уровень по-настоящему.
     *
     * Сам ползунок при этом никуда не девается — меняется только список
     * сценариев под ним. Короткая задержка нужна не экрану, а пальцам:
     * пока игрок перебирает уровни стрелками или тащит кружок мимо
     * нескольких засечек, пятнадцать карточек не перестраиваются на
     * каждое промежуточное значение.
     */
    var commitTimer = 0;

    function commit(i) {
      if (G.rolling) return;
      paint(i);
      if (levels[i].id === G.level) { clearTimeout(commitTimer); commitTimer = 0; return; }
      clearTimeout(commitTimer);
      commitTimer = setTimeout(function () {
        commitTimer = 0;
        // За это время игрок мог уйти с экрана — тогда менять нечего.
        // Сравнение с false, а не «!»: в окружениях без isConnected
        // свойства просто нет, и проверка не должна отменять выбор молча.
        if (box.isConnected === false || G.screen !== 'menu') return;
        setLevel(levels[i].id);
        // Меняется только список сценариев — экран остаётся на месте.
        refreshScenarios();
      }, reducedMotion() ? 0 : 90);
    }

    /* --- Перетаскивание ---
       Кружок идёт ровно за пальцем, а не прыгает по засечкам: между ними
       он стоит там, где его держат, и только рядом с засечкой мягко к ней
       притягивается. Ступень при этом уже выбрана — ближайшая. */

    /* Границы полосы, снятые в момент нажатия. Во время перетаскивания
       карточка дрожит, и мерить её заново означало бы считать положение
       пальца относительно движущейся мишени: кружок дёргался бы вместе с
       ней. Раскладка за время одного жеста не меняется, поэтому снимок
       остаётся верным до конца жеста. */
    var dragRect = null;

    /** Точка полосы под курсором, в долях от 0 до 1. */
    function pFromX(clientX) {
      var b = dragRect || track.getBoundingClientRect();
      var pad = padPx();
      var span = b.width - pad * 2;
      if (span <= 0) return 0;
      return clamp((clientX - b.left - pad) / span, 0, 1);
    }

    function nearestIndex(p) {
      var best = 0, bestD = Infinity;
      for (var i = 0; i < count; i++) {
        var d = Math.abs(levelPercent(i, count) - p);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    /**
     * Мягкий магнит.
     *
     * Жёсткое прилипание превращает движение в серию прыжков, полное его
     * отсутствие — оставляет кружок висеть между засечками. Здесь притяжение
     * появляется только вплотную к точке и тем сильнее, чем ближе кружок.
     */
    function magnet(p) {
      var np = levelPercent(nearestIndex(p), count);
      var d = np - p;
      var r = 0.05;
      if (Math.abs(d) >= r) return p;
      return p + d * (1 - Math.abs(d) / r) * 0.6;
    }

    var dragging = false;   // палец на полосе
    var moved = false;      // и он уже поехал
    var grabDelta = 0;      // насколько центр кружка смещён от точки захвата
    var pointerId = null;
    var frame = 0;
    var lastX = 0;

    function apply() {
      frame = 0;
      var p = clamp(pFromX(lastX) + grabDelta, 0, 1);
      var i = nearestIndex(p);
      var changed = i !== shown;
      paint(i, magnet(p));
      if (changed) MaxBridge.hapticSelect();
    }

    function onMove(e) {
      if (!dragging) return;
      var x = e.clientX != null ? e.clientX
        : (e.touches && e.touches[0] ? e.touches[0].clientX : null);
      if (x == null) return;
      lastX = x;
      if (!moved) {
        moved = true;
        document.documentElement.classList.add('lvl-grabbing');
      }
      // Больше одного пересчёта на кадр не нужно: pointermove приходит чаще,
      // чем экран успевает перерисоваться.
      if (window.requestAnimationFrame) {
        if (!frame) frame = requestAnimationFrame(apply);
      } else apply();
    }

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      moved = false;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      dragRect = null;
      box.classList.remove('dragging');
      document.documentElement.classList.remove('lvl-grabbing');
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', endDrag);
      track.removeEventListener('pointercancel', endDrag);
      document.removeEventListener('pointerup', endDrag);
      document.removeEventListener('pointercancel', endDrag);
      if (pointerId != null && track.releasePointerCapture) {
        try { track.releasePointerCapture(pointerId); } catch (err) {}
      }
      pointerId = null;
      // .dragging снят — переход вернулся, и кружок сам доезжает до засечки.
      commit(shown);
    }

    track.addEventListener('pointerdown', function (e) {
      if (G.rolling) return;
      if (e.button != null && e.button > 0) return;

      dragging = true;
      moved = false;
      lastX = e.clientX;
      pointerId = e.pointerId != null ? e.pointerId : null;
      track.focus();

      var b = track.getBoundingClientRect();
      dragRect = { left: b.left, width: b.width };
      // Дрожь начинается вместе с жестом, а не с первым движением: карточка
      // отзывается на само прикосновение.
      box.classList.add('dragging');
      var pad = padPx();
      var span = b.width - pad * 2;
      var knobX = b.left + pad + levelPercent(shown, count) * span;
      var p = pFromX(e.clientX);

      if (Math.abs(e.clientX - knobX) <= 26) {
        // Взяли за сам кружок: запоминаем смещение, чтобы он не прыгнул
        // центром под курсор в первый же миг.
        grabDelta = levelPercent(shown, count) - p;
      } else {
        // Щелчок мимо кружка — он плавно переезжает на ближайшую засечку
        // (переход ещё не отключён), и дальше его можно тащить.
        grabDelta = 0;
        var i = nearestIndex(p);
        if (i !== shown) { paint(i); MaxBridge.hapticSelect(); }
      }

      // Захват указателя: палец может уехать за пределы полосы и даже окна —
      // события всё равно придут сюда, и кружок не «отцепится» на полпути.
      if (pointerId != null && track.setPointerCapture) {
        try { track.setPointerCapture(pointerId); } catch (err) {}
      }
      track.addEventListener('pointermove', onMove);
      track.addEventListener('pointerup', endDrag);
      track.addEventListener('pointercancel', endDrag);
      document.addEventListener('pointerup', endDrag);
      document.addEventListener('pointercancel', endDrag);
      e.preventDefault();
    });

    track.addEventListener('keydown', function (e) {
      if (G.rolling) return;
      var i = shown;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = Math.min(count - 1, i + 1);
      else if (e.key === 'PageDown') i = Math.max(0, i - 2);
      else if (e.key === 'PageUp') i = Math.min(count - 1, i + 2);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = count - 1;
      else return;
      e.preventDefault();
      if (i === shown) return;
      MaxBridge.hapticSelect();
      commit(i);
    });

    /* Ширина полосы меняется — подписи пересчитываются. Слушатель снимает
       себя сам, когда меню пересобрано и этот ползунок уже не на экране. */
    function onResize() {
      if (box.isConnected === false) { window.removeEventListener('resize', onResize); return; }
      layoutLabels();
    }
    window.addEventListener('resize', onResize);

    paint(current);
    // Ширину подписей можно измерить только после того, как они попали
    // в документ, — отсюда отложенная раскладка.
    if (window.requestAnimationFrame) requestAnimationFrame(layoutLabels);
    else setTimeout(layoutLabels, 0);
    return box;
  }

  /** Сценарии уровня по возрастанию тяжести: от самого мягкого к самому злому. */
  function scenariosFor(level) {
    return C.scenarios
      .filter(function (x) { return x.level === level; })
      .sort(function (a, b) { return (a.hard || 0) - (b.hard || 0); });
  }

  function setLevel(id) {
    G.level = id;
    G.picked = null;
    Store.data.level = id;
    Store.save();
  }

  /** Сценарии, которые прямо сейчас лежат на экране (с учётом фильтра). */
  function visibleScenarios() {
    var list = scenariosFor(G.level);
    if (G.filter === 'all') return list;
    var played = {};
    Store.data.runs.forEach(function (r) { played[r.scenarioId] = true; });
    var out = list.filter(function (x) {
      return G.filter === 'done' ? played[x.id] : !played[x.id];
    });
    return out.length ? out : list;
  }

  /** Перекрашивает карточки под текущий выбор, не пересобирая экран. */
  function paintPicked() {
    var list = visibleScenarios();
    var cards = document.querySelectorAll('.scenario-card');
    for (var i = 0; i < cards.length; i++) {
      var on = list[i] === G.picked;
      cards[i].classList.toggle('on', on);
      cards[i].setAttribute('aria-selected', on ? 'true' : 'false');
      var lab = cards[i].querySelector('.sc-go-text');
      if (lab) lab.textContent = on ? 'Играть' : 'Выбрать';
    }
    var nameNode = document.getElementById('cta-name');
    if (nameNode) nameNode.textContent = G.picked ? G.picked.title : '—';
  }

  /* Выбор — это только выбор. Экран при нём не двигается вовсе:
     карточка под курсором должна остаться под курсором, иначе второй
     клик («Играть») попадает уже в другую карточку. Прокрутка здесь
     осталась ровно в одном месте — в жеребьёвке, где игрок сам не знает,
     куда смотреть. */
  function selectScenario(sc) {
    G.picked = sc;
    paintPicked();
  }

  /**
   * Жеребьёвка.
   *
   * Кубик бросается ТОЛЬКО среди сценариев выбранного уровня: уровень
   * давления игрок выбирает сам, это решение про сложность, а не про
   * сюжет, и подменять его случайностью нельзя.
   *
   * Партию бросок тоже не начинает: сначала по карточкам пробегает
   * подсветка, затем выбор останавливается на одной, и только после
   * этого кнопка «Начать партию» снова оживает. Игрок видит, что именно
   * ему выпало, и может передумать.
   */
  function rollRandom() {
    if (G.rolling) return;

    var list = visibleScenarios();
    var cards = document.querySelectorAll('.scenario-card');
    if (!list.length || !cards.length) return;

    // Тот же сценарий два раза подряд выглядит как сломанный кубик,
    // поэтому текущий выбор из жеребьёвки исключаем.
    var pool = list.filter(function (x) { return x !== G.picked; });
    if (!pool.length) pool = list;
    var target = pool[Math.floor(Math.random() * pool.length)];
    var finalIdx = list.indexOf(target);
    MaxBridge.haptic('medium');

    if (reducedMotion()) { selectScenario(target); flashPicked(cards[finalIdx]); return; }

    var startIdx = Math.max(0, list.indexOf(G.picked));

    G.rolling = true;
    setCtaBusy(true);
    G.picked = null;
    paintPicked();

    /* Барабан идёт по списку подряд, карточка за карточкой, а не прыгает
       по случайным номерам. Так у движения есть направление: экран едет
       следом ровно с той же скоростью и ни разу не перескакивает через
       полсписка. Число шагов подбирается так, чтобы барабан остановился
       точно на выпавшей карточке. */
    var n = cards.length;
    var least = 9 + Math.floor(Math.random() * 4);
    var steps = least + (((finalIdx - startIdx - least) % n) + n) % n;

    var follow = startFollow();
    var step = 0;

    (function tick() {
      for (var i = 0; i < cards.length; i++) cards[i].classList.remove('rolling');
      var idx = (startIdx + step) % n;
      cards[idx].classList.add('rolling');
      follow.to(cards[idx]);
      MaxBridge.haptic('soft');

      if (step >= steps) {
        setTimeout(function () {
          cards[idx].classList.remove('rolling');
          follow.stop();
          G.rolling = false;
          setCtaBusy(false);
          selectScenario(target);
          flashPicked(cards[idx]);
          MaxBridge.haptic('rigid');
        }, 260);
        return;
      }
      step++;
      // Замедляющийся барабан: шаги удлиняются к концу, поэтому остановка
      // читается как остановка, а не как обрыв анимации.
      setTimeout(tick, 42 + 215 * Math.pow(step / steps, 2.6));
    })();
  }

  /**
   * Ведущая прокрутка на время жеребьёвки.
   *
   * Экран не «догоняет» подсветку рывками к каждой новой карточке, а
   * непрерывно едет к ней: каждый кадр остаток пути сокращается на долю,
   * а новая цель просто заменяет старую. Барабан успевает уйти дальше
   * раньше, чем экран доехал, — и движение получается одним плавным
   * ходом вдоль списка, без остановок и рывков на каждой карточке.
   *
   * Любое движение самого игрока — колесо, палец, клавиша — ведение
   * отменяет: перебивать человека, который смотрит в другое место, нельзя.
   */
  function startFollow() {
    var raf = 0, target = window.scrollY, live = true;

    function maxY() {
      return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    }

    function stop() {
      live = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    }

    function frame() {
      if (!live) { raf = 0; return; }
      var dy = target - window.scrollY;
      if (Math.abs(dy) < 0.5) { window.scrollTo(0, target); raf = 0; return; }
      window.scrollTo(0, window.scrollY + dy * 0.17);
      raf = requestAnimationFrame(frame);
    }

    if (!reducedMotion() && window.requestAnimationFrame) {
      window.addEventListener('wheel', stop, { passive: true });
      window.addEventListener('touchstart', stop, { passive: true });
      window.addEventListener('keydown', stop);
    } else {
      live = false;
    }

    return {
      /** Поставить новую цель: середина карточки — середина свободного экрана. */
      to: function (card) {
        if (!live || !card) return;
        var b = card.getBoundingClientRect();
        var top = stickyTop();
        // Нижняя панель «Выбран сценарий» закрывает низ экрана, поэтому
        // серединой считается середина того, что реально видно.
        var mid = (top + (window.innerHeight - 120)) / 2;
        target = Math.max(0, Math.min(maxY(),
          window.scrollY + b.top + b.height / 2 - mid));
        if (!raf) raf = requestAnimationFrame(frame);
      },
      stop: stop
    };
  }

  /** Короткая вспышка на выпавшей карточке плюс подводка к ней. */
  function flashPicked(card) {
    if (!card) return;
    card.classList.add('landed');
    setTimeout(function () { card.classList.remove('landed'); }, 700);
    // Выпавший сценарий выводим в середину экрана: искать его глазами
    // по списку из пятнадцати карточек — не то, ради чего бросают кубик.
    var box = card.getBoundingClientRect();
    var top = stickyTop();
    smoothScrollTo(window.scrollY + box.top -
      (top + (window.innerHeight - 120 - top - box.height) / 2));
  }

  /** Пока крутится барабан, начинать партию нечем: выбора ещё нет. */
  function setCtaBusy(busy) {
    var start = document.getElementById('cta-start');
    var dice = document.getElementById('cta-dice');
    if (start) start.disabled = !!busy;
    if (dice) dice.classList.toggle('rolling', !!busy);
    var name = document.getElementById('cta-name');
    if (name && busy) name.textContent = 'бросаем кубик…';
  }

  /*
   *  ПОКАЗ ИГРЫ
   *
   *  Меню объясняло игру словами. Но объяснить решение под давлением
   *  словами нельзя — его надо принять. Поэтому прямо в шапке живёт
   *  короткая настоящая партия: те же события, тот же движок, те же
   *  расчёты, только на несколько ходов.
   *
   *  Это не ролик и не заготовленная анимация: игрок сам выбирает,
   *  а график справа рисует его собственный итог месяц за месяцем.
   *  Отсюда и переход в полную партию — уже с пониманием, что внутри.
   */

  var KIND_LABELS = {
    temptation: 'соблазн', shock: 'неожиданность', offer: 'предложение',
    scam: 'осторожно', opportunity: 'возможность', quiet: 'мелочь', social: 'люди'
  };

  /** Как называется вид события на карточке. */
  function kindName(ev) {
    if (ev.id && String(ev.id).indexOf('random-') === 0) return 'случайность';
    return KIND_LABELS[ev.kind] || 'событие';
  }

  var DEMO_STEPS = 6;

  function demoScenario() {
    // Самый мягкий сценарий первого уровня: маленькие суммы,
    // понятные без объяснений.
    return scenariosFor(1)[0] || C.scenarios[0];
  }

  function startDemo() {
    var sc = demoScenario();
    var seed = 'demo-' + Math.floor(Math.random() * 100000);
    G.demo = {
      seed: seed,
      built: E.resolveScenario(sc, C.pool, seed),
      scenario: sc,
      choices: [],
      step: 0,
      last: null
    };
    MaxBridge.haptic('medium');
    renderDemo(true);
  }

  function stopDemo() {
    G.demo = null;
    MaxBridge.haptic('light');
    renderHeroCopy();
    renderHeroVisual();
  }

  /** Пересобирает левую колонку шапки: вступление или показ. */
  function renderHeroCopy() {
    var host = document.getElementById('hero-copy');
    if (!host) return;
    host.innerHTML = '';
    host.appendChild(G.demo ? buildDemoPanel() : buildHeroIntro());
  }

  /** Пересобирает график: декоративный или итог показа. */
  function renderHeroVisual() {
    var old = document.querySelector('.hero-visual');
    if (!old || !old.parentNode) return;
    var next = G.demo ? buildDemoChart() : buildHeroPath();
    old.parentNode.replaceChild(next, old);
  }

  function renderDemo(fresh) {
    renderHeroCopy();
    renderHeroVisual();
    if (fresh) {
      var host = document.getElementById('hero-copy');
      if (host && host.firstChild && host.firstChild.classList) {
        host.firstChild.classList.add('in');
      }
    }
  }

  /** Текущее состояние показа: движок считает всё по-настоящему. */
  function demoRun() {
    return E.simulate(G.demo.built, G.demo.seed, G.demo.choices);
  }

  function buildDemoPanel() {
    var box = el('div', 'demo');
    var run = demoRun();
    var st = run.state;
    var done = G.demo.step >= DEMO_STEPS || !run.awaiting || run.finished;

    /* Шапка показа */
    var top = el('div', 'demo-top');
    var when = el('span', 'demo-when');
    when.appendChild(icon('clock'));
    when.appendChild(el('span', null,
      'Год ' + (1 + Math.floor(st.month / 12)) + ' · ' + MONTHS_FULL[st.month % 12]));
    top.appendChild(when);

    var dots = el('span', 'demo-dots');
    for (var i = 0; i < DEMO_STEPS; i++) {
      dots.appendChild(el('i', 'dd' + (i < G.demo.step ? ' on' : '')));
    }
    top.appendChild(dots);

    var close = el('button', 'demo-close');
    close.setAttribute('aria-label', 'Выйти из показа');
    close.appendChild(icon('close'));
    close.onclick = stopDemo;
    top.appendChild(close);
    box.appendChild(top);

    if (done) { box.appendChild(buildDemoFinale(st)); return box; }

    /* Событие */
    var ev = run.awaiting;
    var kind = el('span', 'demo-kind kind kind-' + (ev.kind || 'quiet'));
    kind.appendChild(el('i', 'kind-dot'));
    kind.appendChild(el('span', null, kindName(ev)));
    box.appendChild(kind);

    box.appendChild(el('h3', 'demo-title', evalText(ev.title, st)));
    box.appendChild(el('p', 'demo-text', evalText(ev.text, st)));

    /* Деньги на руках: без них решение не читается */
    var money = el('div', 'demo-money');
    money.appendChild(demoCell('На руках', fmt(st.cash)));
    money.appendChild(demoCell('Резерв', fmt(st.reserve)));
    money.appendChild(demoCell('Свободно в месяц', fmt(freeMonthly(st))));
    box.appendChild(money);

    /* Варианты: настоящие, с настоящими последствиями */
    var list = el('div', 'demo-choices');
    ev.choices.forEach(function (ch, idx) {
      var b = el('button', 'demo-choice');
      b.appendChild(el('span', 'dc-key', String(idx + 1)));
      var body = el('span', 'dc-body');
      body.appendChild(el('span', 'dc-text', evalText(ch.label, st)));
      if (ch.sub) body.appendChild(el('span', 'dc-sub', evalText(ch.sub, st)));
      b.appendChild(body);
      b.appendChild(icon('arrow', 'dc-go'));
      b.onclick = function () { pickDemo(ev, ch); };
      list.appendChild(b);
    });
    box.appendChild(list);

    /* Чем кончился прошлый ход */
    if (G.demo.last) {
      var back = el('div', 'demo-echo');
      back.appendChild(icon(G.demo.last.good ? 'check' : 'alert'));
      back.appendChild(el('span', null, G.demo.last.text));
      box.appendChild(back);
    }
    return box;
  }

  function demoCell(lab, val) {
    var c = el('span', 'dm');
    c.appendChild(el('span', 'dm-lab', lab));
    c.appendChild(el('span', 'dm-val', val));
    return c;
  }

  /**
   * Выбор в показе. Считаем настоящим движком и сразу показываем,
   * что изменилось: цена решения — это и есть вся игра.
   */
  function pickDemo(ev, ch) {
    if (!G.demo) return;
    var before = demoRun().state;
    MaxBridge.haptic('rigid');

    G.demo.choices.push({ eventId: ev.id, choiceId: ch.id });
    G.demo.step++;

    var after = demoRun().state;
    var dNet = Math.round(E.netWorth(after) - E.netWorth(before));
    var dCalm = Math.round(after.calm - before.calm);
    var parts = [];
    if (Math.abs(dNet) >= 500) parts.push('капитал ' + (dNet > 0 ? '+' : '−') + fmt(Math.abs(dNet)));
    if (Math.abs(dCalm) >= 2) parts.push('спокойствие ' + (dCalm > 0 ? '+' : '−') + Math.abs(dCalm));
    var debt = Math.round(E.debtBalanceTotal(after) - E.debtBalanceTotal(before));
    if (debt > 500) parts.push('долг +' + fmt(debt));

    G.demo.last = {
      good: dNet >= 0 && debt <= 0,
      text: parts.length
        ? 'Прошёл месяц: ' + parts.join(', ')
        : 'Прошёл месяц: деньги на месте, но время потрачено'
    };

    var panel = document.querySelector('.demo');
    if (panel) panel.classList.add('turning');
    setTimeout(function () { if (G.demo) renderDemo(); }, 220);
  }

  function buildDemoFinale(st) {
    var box = el('div', 'demo-end');
    box.appendChild(el('div', 'de-lab', 'Это был показ'));
    // Решений больше, чем месяцев: в одном месяце кроме крупной ситуации
    // случаются и мелкие. Говорим и то, и другое — иначе цифра «3 месяца»
    // после шести выборов выглядит как ошибка счёта.
    box.appendChild(el('h3', 'de-title',
      G.demo.step + ' ' + plural(G.demo.step, 'решение', 'решения', 'решений') + ' за ' +
      st.month + ' ' + plural(st.month, 'месяц', 'месяца', 'месяцев')));

    var figs = el('div', 'de-figs');
    figs.appendChild(demoCell('Капитал', fmt(E.netWorth(st))));
    figs.appendChild(demoCell('Резерв', fmt(st.reserve)));
    figs.appendChild(demoCell('Спокойствие', Math.round(st.calm)));
    box.appendChild(figs);

    box.appendChild(el('p', 'de-text',
      'Впереди ещё ' + (60 - st.month) + ' ' + plural(60 - st.month, 'месяц', 'месяца', 'месяцев') +
      ', и каждое решение тянет за собой следующее. ' +
      'Счёт приходит в конце, и он всегда подробный.'));

    var acts = el('div', 'de-acts');
    var play = el('button', 'primary-btn');
    play.appendChild(el('span', null, 'Играть по-настоящему'));
    play.appendChild(icon('arrow'));
    play.onclick = function () {
      var sc = G.demo ? G.demo.scenario : demoScenario();
      G.demo = null;
      MaxBridge.haptic('medium');
      startScenario(sc);
    };
    acts.appendChild(play);

    var again = el('button', 'ghost-btn');
    again.appendChild(icon('refresh'));
    again.appendChild(el('span', null, 'Ещё раз'));
    again.onclick = startDemo;
    acts.appendChild(again);
    box.appendChild(acts);
    return box;
  }


  /*
   *  График показа: не украшение, а итог именно этой партии.
   *  Сыгранные месяцы — сплошной линией, остаток пути — пунктиром
   *  от последней точки: видно, что впереди ещё почти пять лет.
   */

  function buildDemoChart() {
    var wrap = el('div', 'hero-visual demo-chart');
    /* Окно графика — первый год, а не все пять. Шесть месяцев из
       шестидесяти занимали десятую часть ширины и выглядели как
       случайная закорючка у левого края; на годовом окне видно форму. */
    var W = 440, H = 250, MONTHS = 13;
    var x0 = 24, x1 = W - 24, top = 22, base = 198;

    var run = demoRun();
    var hist = run.history || [];
    var vals = hist.map(function (h) { return h.netWorth; });
    if (vals.length < 2) vals = [0, 0];

    /* Шкала не подгоняется под сыгранные месяцы вплотную: иначе первые
       два хода превращают линию в вертикальный скачок во весь график.
       Держим запас сверху и снизу, и он растёт вместе с партией. */
    var start = vals[0];
    var lo = Math.min.apply(null, vals.concat([start]));
    var hi = Math.max.apply(null, vals.concat([start]));
    var mid = (hi + lo) / 2;
    var range = Math.max(hi - lo, Math.abs(start) * 0.8, 90000);
    lo = mid - range; hi = mid + range;

    function px(m) { return x0 + (x1 - x0) * m / (MONTHS - 1); }
    function py(v) { return base - (base - top) * (v - lo) / (hi - lo || 1); }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, 'class': 'hero-svg', role: 'img',
      'aria-label': 'Ваш капитал по месяцам в показе игры'
    });
    svg.appendChild(svgEl('rect', { x: 2, y: 2, width: W - 4, height: base + 34, rx: 18, 'class': 'hv-plate' }));
    [0, 1, 2].forEach(function (i) {
      var y = top + 14 + i * 54;
      svg.appendChild(svgEl('line', { x1: x0 - 6, x2: x1 + 6, y1: y, y2: y, 'class': 'hv-rule' }));
    });
    for (var y2 = 3; y2 < MONTHS; y2 += 3) {
      var gx = px(y2);
      svg.appendChild(svgEl('line', { x1: gx, x2: gx, y1: top - 6, y2: base + 4, 'class': 'hv-grid' }));
    }

    // Линия «с чего начали»: всё, что выше неё, — заработанное
    svg.appendChild(svgEl('line', {
      x1: x0 - 6, x2: x1 + 6, y1: py(start), y2: py(start), 'class': 'hv-flat'
    }));

    var pts = vals.slice(0, MONTHS).map(function (v, m) { return { x: px(m), y: py(v) }; });
    var d = smoothPath(pts);
    var last = pts[pts.length - 1];

    svg.appendChild(svgEl('path', {
      d: d + ' L' + last.x.toFixed(1) + ' ' + py(start) + ' L' + pts[0].x.toFixed(1) + ' ' + py(start) + ' Z',
      'class': 'hv-area'
    }));
    svg.appendChild(svgEl('path', { d: d, 'class': 'hv-line demo' }));

    // Дорога, которая ещё впереди
    if (pts.length < MONTHS) {
      svg.appendChild(svgEl('path', {
        d: 'M' + last.x.toFixed(1) + ' ' + last.y.toFixed(1) + ' L' + px(MONTHS - 1) + ' ' + last.y.toFixed(1),
        'class': 'hv-rest'
      }));
    }

    var head = svgEl('g', { 'class': 'hv-head' });
    head.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 7, 'class': 'hv-dot-bg' }));
    head.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 7, 'class': 'hv-dot' }));
    svg.appendChild(head);

    [0, 3, 6, 9, 12].forEach(function (mo) {
      var t = svgEl('text', {
        x: px(mo), y: base + 24, 'class': 'hv-year',
        'text-anchor': mo === 0 ? 'start' : (mo === 12 ? 'end' : 'middle')
      });
      t.textContent = mo === 0 ? 'старт' : 'мес ' + mo;
      svg.appendChild(t);
    });
    wrap.appendChild(svg);

    var legend = el('div', 'hv-legend');
    legend.appendChild(legendItem('solid', 'Ваш капитал'));
    legend.appendChild(legendItem('dashed', 'С чего начали'));
    var now = el('span', 'hv-hint');
    now.textContent = fmt(Math.round(vals[vals.length - 1]));
    legend.appendChild(now);
    wrap.appendChild(legend);
    return wrap;
  }


  /** Вступление: то, что видно до нажатия «Показ игры». */
  function buildHeroIntro() {
    var box = el('div', 'hero-intro');
    box.appendChild(el('div', 'hero-kicker', 'Финансовый симулятор'));
    box.appendChild(el('h1', 'hero-title', 'Пять лет спустя'));
    box.appendChild(el('p', 'hero-sub',
      'Пять лет жизни за одну партию. Каждое решение кажется разумным в момент выбора. ' +
      'Счёт приходит позже — и он всегда подробный.'));

    // Цифры вместо трёх одинаковых чипов: сразу видно, сколько тут игры
    var stats = el('div', 'hero-stats');
    stats.appendChild(heroStat(String(C.scenarios.length), 'сценариев'));
    stats.appendChild(heroStat(String(C.levels.length), 'уровня давления'));
    stats.appendChild(heroStat('60', 'месяцев в партии'));
    box.appendChild(stats);

    var hmeta = el('div', 'hero-meta');
    hmeta.appendChild(heroChip('dice', 'Исход зависит от вас и от удачи'));
    hmeta.appendChild(heroChip('coin', 'Настоящие расчёты'));
    box.appendChild(hmeta);

    /* Кнопка показа. Рассказать про игру про решения нельзя —
       решение нужно принять, поэтому здесь сразу дают попробовать. */
    var show = el('button', 'hero-demo-btn');
    show.appendChild(icon('play'));
    var t = el('span', 'hdb-text');
    t.appendChild(el('b', null, 'Показ игры'));
    t.appendChild(el('span', 'hdb-sub', 'шесть ходов настоящей партии, прямо здесь'));
    show.appendChild(t);
    show.appendChild(icon('arrow', 'hdb-go'));
    show.onclick = startDemo;
    box.appendChild(show);
    return box;
  }

  function heroStat(num, lab) {
    var c = el('span', 'hero-stat');
    c.appendChild(el('b', 'hs-num', num));
    c.appendChild(el('span', 'hs-lab', lab));
    return c;
  }

  function heroChip(ic, text) {
    var c = el('span', 'hero-chip');
    c.appendChild(icon(ic));
    c.appendChild(el('span', null, text));
    return c;
  }

  function metaChip(ic, text) {
    var c = el('span', 'chip');
    c.appendChild(icon(ic));
    c.appendChild(el('span', null, text));
    return c;
  }

  function poFig(val, lab) {
    var f = el('div', 'po-fig');
    f.appendChild(el('div', 'po-val', val));
    f.appendChild(el('div', 'po-lab', lab));
    return f;
  }

  function blockHead(num, title, hint, id) {
    var h = el('div', 'block-head');
    if (id) h.id = id;
    h.appendChild(el('span', 'bh-num', num));
    h.appendChild(el('h2', 'bh-title section-label', title));
    if (hint) h.appendChild(el('span', 'bh-hint', hint));
    return h;
  }

  /**
   * Превью старта сценария: три числа, по которым сразу видно,
   * во что игрок входит. Данные берутся из описания сценария как есть.
   */
  function buildScenarioPreview(sc) {
    var st = sc.start || {};
    var box = el('div', 'sc-preview');
    /* Подписи короткие: на компактной карточке три колонки, и длинное
       «Обязательное в месяц» обрезалось многоточием вместе со значением.
       Что доход и расход месячные, видно по самим числам. */
    box.appendChild(previewCell('Доход', fmtShort(st.income || 0) + ' ₽'));
    box.appendChild(previewCell('Расход', fmtShort(st.mandatory || 0) + ' ₽'));
    var debt = (st.debts || []).reduce(function (a, d) { return a + d.balance; }, 0);
    if (debt > 0) box.appendChild(previewCell('Долг', fmtShort(debt) + ' ₽', 'neg'));
    else box.appendChild(previewCell('На руках', fmtShort(st.cash || 0) + ' ₽'));
    return box;
  }

  function previewCell(lab, val, mod) { return labelValue('div', 'scp-cell', 'div', 'scp-lab', 'scp-val', lab, val, mod); }

  /**
   * Hero-визуализация: путь денег во времени. Не график данных, а мотив —
   * линия, которая идёт вверх, проседает и снова идёт вверх, с отметками лет.
   */
  /*
   *  ГРАФИК НА ГЛАВНОЙ
   *
   *  Показывает, о чём игра: одна и та же жизнь идёт двумя путями.
   *  Сплошная линия — путь с решениями, пунктир — «ничего не менять».
   *  Расходятся они не сразу: первый год почти совпадает, и в этом весь
   *  смысл — цена решения приходит позже.
   *
   *  График живой: под курсором едет вертикаль, ближайшая точка каждой
   *  линии подсвечивается, а рядом всплывает месяц и обе суммы. Это не
   *  украшение — иначе кривая остаётся картинкой, а так по ней видно,
   *  что разрыв к пятому году измеряется сотнями тысяч.
   */

  var SVGNS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  /** Плавная интерполяция по опорным точкам: между ними — кубика, не ломаная. */
  function interpolate(points, months) {
    var out = [];
    for (var m = 0; m < months; m++) {
      var i = 0;
      while (i < points.length - 2 && points[i + 1][0] < m) i++;
      var p0 = points[Math.max(0, i - 1)], p1 = points[i];
      var p2 = points[Math.min(points.length - 1, i + 1)];
      var p3 = points[Math.min(points.length - 1, i + 2)];
      var span = p2[0] - p1[0] || 1;
      var t = Math.min(1, Math.max(0, (m - p1[0]) / span));
      var t2 = t * t, t3 = t2 * t;
      // Кэтмулл-Ром: кривая проходит ровно через опорные точки
      out.push(0.5 * ((2 * p1[1]) +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3));
    }
    return out;
  }

  /** Ломаная по точкам, сглаженная кубическими сегментами. */
  function smoothPath(pts) {
    if (!pts.length) return '';
    var d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i];
      var p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) +
           ',' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) +
           ',' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    }
    return d;
  }

  /* Итог партии по месяцам, в тысячах рублей. Числа выдуманы и подобраны
     под типичную партию: провал на второй год, разгон после третьего. */
  var HERO_PLAN = [[0, 18], [7, 118], [13, 96], [19, 64], [27, 306],
                   [35, 508], [43, 688], [51, 1040], [59, 1460]];
  var HERO_DRIFT = [[0, 18], [12, 44], [24, 30], [36, 6], [48, -34], [59, -96]];

  function buildHeroPath() {
    var wrap = el('div', 'hero-visual');
    var W = 440, H = 250, MONTHS = 60;
    var x0 = 24, x1 = W - 24, top = 22, base = 198;

    var plan = interpolate(HERO_PLAN, MONTHS);
    var drift = interpolate(HERO_DRIFT, MONTHS);
    var lo = Math.min.apply(null, drift), hi = Math.max.apply(null, plan);
    function px(m) { return x0 + (x1 - x0) * m / (MONTHS - 1); }
    function py(v) { return base - (base - top) * (v - lo) / (hi - lo || 1); }

    var planPts = plan.map(function (v, m) { return { x: px(m), y: py(v) }; });
    var driftPts = drift.map(function (v, m) { return { x: px(m), y: py(v) }; });

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, 'class': 'hero-svg', role: 'img',
      'aria-label': 'График: путь с решениями против пути без решений за пять лет'
    });

    svg.appendChild(svgEl('rect', { x: 2, y: 2, width: W - 4, height: base + 34, rx: 18, 'class': 'hv-plate' }));

    [0, 1, 2].forEach(function (i) {
      var y = top + 14 + i * 54;
      svg.appendChild(svgEl('line', { x1: x0 - 6, x2: x1 + 6, y1: y, y2: y, 'class': 'hv-rule' }));
    });
    for (var y2 = 1; y2 < 5; y2++) {
      var gx = px(y2 * 12);
      svg.appendChild(svgEl('line', { x1: gx, x2: gx, y1: top - 6, y2: base + 4, 'class': 'hv-grid' }));
    }
    svg.appendChild(svgEl('line', { x1: x0 - 6, x2: x1 + 6, y1: py(0), y2: py(0), 'class': 'hv-base' }));

    var planD = smoothPath(planPts);
    svg.appendChild(svgEl('path', { d: smoothPath(driftPts), 'class': 'hv-flat' }));
    svg.appendChild(svgEl('path', {
      d: planD + ' L' + planPts[planPts.length - 1].x.toFixed(1) + ' ' + base + ' L' + planPts[0].x.toFixed(1) + ' ' + base + ' Z',
      'class': 'hv-area'
    }));
    svg.appendChild(svgEl('path', { d: planD, 'class': 'hv-line' }));

    // Годовые отметки на линии решений
    [12, 24, 36, 48].forEach(function (m, i) {
      var g = svgEl('g', { 'class': 'hv-node', 'data-i': String(i) });
      g.appendChild(svgEl('circle', { cx: planPts[m].x, cy: planPts[m].y, r: 5.5, 'class': 'hv-dot-bg' }));
      g.appendChild(svgEl('circle', { cx: planPts[m].x, cy: planPts[m].y, r: 5.5, 'class': 'hv-dot' }));
      svg.appendChild(g);
    });

    var last = planPts[planPts.length - 1];
    var coin = svgEl('g', { 'class': 'hv-coin' });
    coin.appendChild(svgEl('circle', { cx: last.x, cy: last.y, r: 13, 'class': 'hv-coin-face' }));
    coin.appendChild(svgEl('path', {
      d: 'M' + (last.x - 5) + ' ' + (last.y + 4) + ' L' + (last.x - 1) + ' ' + (last.y - 3) +
         ' L' + (last.x + 2) + ' ' + (last.y + 1) + ' L' + (last.x + 6) + ' ' + (last.y - 7),
      'class': 'hv-coin-mark'
    }));
    svg.appendChild(coin);

    for (var yl = 0; yl < 5; yl++) {
      var t = svgEl('text', { x: px(yl * 12 + 6), y: base + 24, 'class': 'hv-year', 'text-anchor': 'middle' });
      t.textContent = 'год ' + (yl + 1);
      svg.appendChild(t);
    }

    /* Слой наведения */

    var hover = svgEl('g', { 'class': 'hv-hover' });
    var vline = svgEl('line', { x1: 0, x2: 0, y1: top - 10, y2: base + 6, 'class': 'hv-vline' });
    var markPlan = svgEl('circle', { r: 7, 'class': 'hv-mark plan' });
    var markDrift = svgEl('circle', { r: 5.5, 'class': 'hv-mark drift' });
    hover.appendChild(vline);
    hover.appendChild(markDrift);
    hover.appendChild(markPlan);
    svg.appendChild(hover);

    wrap.appendChild(svg);

    var tip = el('div', 'hv-tip');
    tip.innerHTML =
      '<div class="hvt-when"></div>' +
      '<div class="hvt-row plan"><i></i><span class="hvt-lab">С решениями</span><b class="hvt-val"></b></div>' +
      '<div class="hvt-row drift"><i></i><span class="hvt-lab">Без них</span><b class="hvt-val"></b></div>' +
      '<div class="hvt-gap"></div>';
    wrap.appendChild(tip);

    var legend = el('div', 'hv-legend');
    legend.appendChild(legendItem('solid', 'Путь с решениями'));
    legend.appendChild(legendItem('dashed', 'Если ничего не менять'));
    legend.appendChild(el('span', 'hv-hint', 'Наведите на график'));
    wrap.appendChild(legend);

    /* Курсор приходит в пикселях экрана, а рисунок живёт в координатах
       viewBox: пересчитываем через фактическую ширину блока. */
    function monthAt(clientX) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return null;
      var vx = (clientX - box.left) / box.width * W;
      var m = Math.round((vx - x0) / (x1 - x0) * (MONTHS - 1));
      return Math.min(MONTHS - 1, Math.max(0, m));
    }

    function show(m) {
      var pp = planPts[m], dp = driftPts[m];
      vline.setAttribute('x1', pp.x); vline.setAttribute('x2', pp.x);
      markPlan.setAttribute('cx', pp.x); markPlan.setAttribute('cy', pp.y);
      markDrift.setAttribute('cx', dp.x); markDrift.setAttribute('cy', dp.y);
      wrap.classList.add('live');

      var year = Math.floor(m / 12) + 1, mon = m % 12 + 1;
      tip.querySelector('.hvt-when').textContent = 'Год ' + year + ' · месяц ' + mon;
      tip.querySelector('.plan .hvt-val').textContent = fmtK(plan[m]);
      tip.querySelector('.drift .hvt-val').textContent = fmtK(drift[m]);
      tip.querySelector('.hvt-gap').textContent = 'Разница ' + fmtK(plan[m] - drift[m]);

      // Подсказка не должна вылезать за края блока
      var rel = (pp.x - x0) / (x1 - x0);
      tip.style.left = (rel * 100).toFixed(1) + '%';
      tip.classList.toggle('flip', rel > 0.62);
    }

    function hide() { wrap.classList.remove('live'); }

    svg.addEventListener('pointermove', function (e) {
      var m = monthAt(e.clientX);
      if (m != null) show(m);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointerdown', function (e) {
      var m = monthAt(e.clientX);
      if (m != null) show(m);
    });

    return wrap;
  }

  /** Суммы на графике — в тысячах: «1 460 тыс ₽» читается с последнего ряда. */
  function fmtK(v) {
    var n = Math.round(v);
    var sign = n < 0 ? '−' : '';
    return sign + Math.abs(n).toLocaleString('ru-RU') + ' тыс ₽';
  }

  function legendItem(kind, text) {
    var it = el('span', 'hv-lg');
    it.appendChild(el('i', 'hv-lg-line ' + kind));
    it.appendChild(el('span', null, text));
    return it;
  }

  /*
   *  ЗНАК ИГРЫ
   *
   *  Монета со стрелкой часов и растущей линией: пять лет и деньги —
   *  ровно то, из чего состоит партия. Рисуется кодом, чтобы одинаково
   *  выглядеть в обеих темах и не тянуть за собой файл картинки.
   */

  /* Знак игры: монета с цифрой «5» и растущей линией. Цифра нарисована
     контуром, а не набрана шрифтом, — иначе знак менялся бы вместе с
     набором шрифтов у игрока. Координаты те же, что в PNG-аватаре бота. */
  var BRAND_PATHS = [
    'M 178.8 179.4 L 282.1 179.4',                       // верхняя перекладина «5»
    'M 178.8 179.4 L 178.8 264.7',                       // стойка
    'M 178.8 261.4 C 264.1 246.7 301.8 281.1 298.5 318.8'
      + ' C 295.2 356.6 260.8 381.2 221.4 381.2'
      + ' C 193.6 381.2 175.5 369.7 164 353.3',          // чаша
    'M 318 222 L 392 130',                               // растущая линия
    'M 352 130 L 394 130 L 394 172'                      // наконечник
  ];

  function buildBrandMark() {
    var svg = svgEl('svg', { viewBox: '0 0 512 512', 'class': 'brand-svg', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('circle', { cx: 256, cy: 256, r: 240, 'class': 'bm-face' }));
    svg.appendChild(svgEl('circle', { cx: 256, cy: 256, r: 204, 'class': 'bm-ring' }));
    var g = svgEl('g', { transform: 'translate(41 41) scale(.84)' });
    for (var i = 0; i < BRAND_PATHS.length; i++) {
      g.appendChild(svgEl('path', { d: BRAND_PATHS[i], 'class': 'bm-line' }));
    }
    svg.appendChild(g);
    var mark = el('span', 'brand-mark');
    mark.appendChild(svg);
    return mark;
  }

  /* Сложность сценария звёздами — внутри своего уровня.
     Сравнивать через звёзды разные уровни смысла нет: за это отвечает
     полоса «Риск» в карточке уровня. А на экране всегда виден ровно один
     уровень, и там важно другое: какой сценарий полегче, какой потяжелее.
     Карточки уже отсортированы от простых к тяжёлым, поэтому звёзды —
     это просто место в этом списке, разложенное по пяти ступеням. */
  var STAR_WORDS = ['очень просто', 'просто', 'средне', 'тяжело', 'на грани'];

  function scenarioStars(sc) {
    var list = scenariosFor(sc.level);
    var rank = list.indexOf(sc);
    if (rank < 0) rank = 0;
    return Math.min(5, Math.max(1, Math.ceil((rank + 1) / (list.length / 5))));
  }

  function buildStars(sc) {
    var n = scenarioStars(sc);
    var box = el('div', 'sc-stars');
    box.setAttribute('title', 'Сложность внутри уровня: ' + STAR_WORDS[n - 1]);
    box.setAttribute('aria-label',
      'Сложность внутри уровня ' + n + ' из 5: ' + STAR_WORDS[n - 1]);
    for (var i = 0; i < 5; i++) box.appendChild(el('i', i < n ? 'on' : ''));
    return box;
  }

  function buildAppbar(mode) {
    var bar = el('header', 'appbar');
    var brand = el('button', 'brand');
    brand.appendChild(buildBrandMark());
    var bt = el('span', 'brand-text');
    bt.appendChild(el('span', 'brand-name', 'Пять лет спустя'));
    bt.appendChild(el('span', 'brand-sub', 'финансовый симулятор'));
    brand.appendChild(bt);
    brand.onclick = function () { if (G.screen !== 'menu' && G.screen !== 'game') renderMenu(); };
    bar.appendChild(brand);

    var nav = el('nav', 'app-nav');
    nav.appendChild(buildThemeBtn('nav-btn theme-btn'));

    var library = el('button', 'nav-btn');
    library.appendChild(icon('help'));
    library.appendChild(el('span', null, 'Справка'));
    library.onclick = function () { MaxBridge.haptic('light'); renderLibrary(); };
    nav.appendChild(library);

    var about = el('button', 'nav-btn');
    about.appendChild(icon('gear'));
    about.appendChild(el('span', null, 'Настройки'));
    about.onclick = function () { MaxBridge.haptic('light'); renderAbout(); };
    nav.appendChild(about);

    // Профиль/прогресс — компактное кольцо с долей открытых карточек
    var total = Object.keys(C.concepts).length;
    var opened = Store.data.concepts.length;
    var prof = el('div', 'app-profile');
    prof.setAttribute('title', 'Открыто карточек знаний: ' + opened + ' из ' + total);
    prof.appendChild(buildRing(total ? opened / total : 0));
    var pm = el('div', 'ap-meta');
    pm.appendChild(el('span', 'ap-val', opened + '/' + total));
    pm.appendChild(el('span', 'ap-lab', 'прогресс'));
    prof.appendChild(pm);
    nav.appendChild(prof);

    bar.appendChild(nav);
    return bar;
  }

  function buildRing(frac) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'ap-ring');
    svg.setAttribute('aria-hidden', 'true');
    var r = 15.5, cx = 18, cy = 18, len = 2 * Math.PI * r;
    var bg = document.createElementNS(ns, 'circle');
    bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', r);
    bg.setAttribute('class', 'apr-bg');
    svg.appendChild(bg);
    var fg = document.createElementNS(ns, 'circle');
    fg.setAttribute('cx', cx); fg.setAttribute('cy', cy); fg.setAttribute('r', r);
    fg.setAttribute('class', 'apr-fg');
    fg.setAttribute('stroke-dasharray', len.toFixed(1));
    fg.setAttribute('stroke-dashoffset', (len * (1 - clamp(frac, 0, 1))).toFixed(1));
    svg.appendChild(fg);
    return svg;
  }

  /* ЭКРАН: карточки знаний */

  function renderLibrary(focusId) {
    var focusCard = null;
    G.screen = 'library';
    MaxBridge.backButton(true, goBack);
    root.innerHTML = '';
    var w = el('div', 'screen library-screen');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');
    wrap.appendChild(header('Карточки знаний',
      'Темы открываются по мере того, как вы сталкиваетесь с ними в своей истории'));
    var ids = Object.keys(C.concepts);
    var openedCount = ids.filter(function (id) { return Store.data.concepts.indexOf(id) !== -1; }).length;

    var counter = el('div', 'lib-counter');
    counter.appendChild(el('span', 'lc-num', openedCount + ' / ' + ids.length));
    counter.appendChild(el('span', 'lc-lab', 'тем открыто'));
    var lcTrack = el('div', 'lc-track');
    var lcFill = el('i');
    lcFill.style.width = (100 * openedCount / ids.length).toFixed(1) + '%';
    lcTrack.appendChild(lcFill);
    counter.appendChild(lcTrack);
    wrap.appendChild(counter);

    var grid = el('div', 'library-grid');

    ids.forEach(function (id, index) {
      var c = C.concepts[id];
      var known = Store.data.concepts.indexOf(id) !== -1;
      var card = el('div', 'concept' + (known ? ' known' : ' locked'));
      if (!known) {
        // Закрытая тема — слот коллекции, а не карточка с повторяющимся текстом
        card.appendChild(el('span', 'concept-slot', String(index + 1).padStart(2, '0')));
        card.appendChild(icon('lock', 'slot-lock'));
        grid.appendChild(card);
        return;
      }
      var t = el('div', 'concept-top');
      t.appendChild(el('div', 'concept-title', c.title));
      var mark = el('div', 'concept-mark');
      mark.appendChild(icon('check'));
      t.appendChild(mark);
      card.appendChild(t);
      card.appendChild(el('div', 'concept-short', c.short));
      if (known) {
        var body = el('div', 'concept-body', c.text);
        body.style.display = 'none';
        card.appendChild(body);
        card.classList.add('tappable');
        card.onclick = function () {
          var open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          card.classList.toggle('open', !open);
          MaxBridge.hapticSelect();
        };
      }
      // Из разбора партии можно прийти сразу к нужной теме: она
      // открывается развёрнутой, а экран подводится к ней.
      if (focusId === id && known) {
        card.classList.add('open', 'focus');
        var openBody = card.querySelector ? card.querySelector('.concept-body') : null;
        if (openBody) openBody.style.display = 'block';
        focusCard = card;
      }
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    wrap.appendChild(backBtn());
    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
    if (focusCard) {
      var node = focusCard;
      setTimeout(function () { scrollElementToTop(node); }, 60);
    }
  }

  function renderAbout() {
    G.screen = 'about';
    MaxBridge.backButton(true, renderMenu);
    root.innerHTML = '';
    var w = el('div', 'screen about-screen');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');
    wrap.appendChild(header('О приложении', 'Обучающий симулятор финансовых решений'));

    function block(title, text) {
      var b = el('div', 'about-block');
      b.appendChild(el('div', 'about-title', title));
      b.appendChild(el('div', 'about-text', text));
      return b;
    }

    var cols = el('div', 'about-grid');
    cols.appendChild(block('Что это',
      'Симулятор показывает, как решения о деньгах выглядят в момент выбора и чем оказываются через несколько месяцев. ' +
      'Все расчёты детерминированы: одинаковые решения при одинаковом старте всегда дают одинаковый результат.'));

    cols.appendChild(block('Важное предупреждение',
      'Это обучающая модель, а не финансовая консультация и не рекомендация. Все банки, продукты и предложения в игре вымышлены. ' +
      'Ставки и цены выбраны для наглядности и не отражают конкретные рыночные условия.'));

    cols.appendChild(block('Данные',
      'Прогресс хранится только в этом браузере или приложении, на вашем устройстве. ' +
      'Приложение не собирает персональные данные, не запрашивает номер телефона и не передаёт ничего на сервер.'));

    cols.appendChild(block('Разработчик',
      'Учебный проект. Перед публикацией в MAX здесь должны быть указаны реальные сведения о правообладателе, ' +
      'контактные данные, политика обработки персональных данных и возрастная классификация — это требование правил платформы.'));
    wrap.appendChild(cols);

    var danger = el('div', 'danger-zone');
    danger.appendChild(el('div', 'dz-title', 'Сброс прогресса'));
    danger.appendChild(el('div', 'dz-text',
      'Будут удалены открытые карточки, сыгранные партии и рекорды. Действие необратимо.'));
    var del = el('button', 'danger-btn');
    del.appendChild(icon('trash'));
    del.appendChild(el('span', null, 'Удалить мой прогресс'));
    del.onclick = function () {
      if (confirm('Удалить весь прогресс? Действие необратимо.')) {
        Store.reset();
        Leaders.clear();
        MaxBridge.hapticNotify('warning');
        renderMenu();
      }
    };
    danger.appendChild(del);
    wrap.appendChild(danger);

    wrap.appendChild(backBtn());
    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  function header(title, sub) {
    var h = el('div', 'page-head');
    h.appendChild(el('h2', 'page-title', title));
    if (sub) h.appendChild(el('div', 'page-sub', sub));
    return h;
  }

  /**
   * Куда возвращает «Назад».
   *
   * Раньше любой экран уводил в меню, и это ломало разбор партии: игрок
   * открывал карточку знания или таблицу лидеров прямо с экрана итогов —
   * и обратно к итогам попасть уже не мог, потому что заново показать их
   * было нечем. Теперь экран, с которого ушли, кладёт сюда способ на него
   * вернуться, и «Назад» ведёт именно туда.
   */
  function goBack() {
    var back = G.returnTo;
    G.returnTo = null;
    if (typeof back === 'function') { back(); return; }
    renderMenu();
  }

  /** Уйти на другой экран так, чтобы «Назад» вернуло на текущий. */
  function leaveTo(open, comeBack) {
    G.returnTo = comeBack || currentScreenAgain();
    open();
  }

  /**
   * Способ показать текущий экран заново.
   *
   * Нужен, чтобы уход по любой ссылке — карточка знания, таблица лидеров,
   * список достижений — отменялся одной кнопкой «Назад». Возвращается
   * только для экранов, которые действительно можно собрать повторно;
   * для остальных «Назад» ведёт в меню, как и раньше.
   */
  function currentScreenAgain() {
    if (G.screen === 'report') {
      var replay = G.replay;
      return function () { renderReport(replay); };
    }
    if (G.screen === 'history') return renderHistory;
    return null;
  }

  function backBtn(label) {
    var b = el('button', 'ghost-btn back-btn');
    b.appendChild(icon('back'));
    b.appendChild(el('span', null, label || 'Назад'));
    b.onclick = function () { MaxBridge.haptic('light'); goBack(); };
    return b;
  }

  /* ИГРА */

  function startScenario(sc) {
    G.scenario = sc;
    G.animating = false;
    G.startedAt = Date.now();
    /* У соревновательного сценария seed закреплён в самом сценарии:
       события, их порядок и все жеребьёвки у всех игроков одинаковые.
       Иначе сравнивать результаты в таблице было бы нечестно. */
    G.seed = sc.seed || newSeed();
    G.choices = [];
    G.forecastErrors = [];
    G.openSheet = null;
    G.timelineFull = false;
    recompute();
    renderGame(true);
  }

  function renderGame(fresh) {
    G.screen = 'game';
    MaxBridge.backButton(true, function () {
      if (confirm('Выйти из партии? Прогресс этой партии не сохранится.')) renderMenu();
    });

    if (fresh || !document.getElementById('game-root')) {
      root.innerHTML = '';
      var w = el('div', 'screen game');
      w.id = 'game-root';

      /* Верхняя полоса: время и деньги */
      var top = el('div', 'hud');

      var when = el('div', 'hud-when');
      var wy = el('div', 'hud-year');
      wy.id = 'hud-year';
      when.appendChild(wy);
      var wm = el('div', 'hud-month');
      wm.id = 'hud-month';
      when.appendChild(wm);
      var wn = el('div', 'hud-monthname');
      wn.id = 'hud-monthname';
      when.appendChild(wn);
      if (!hintsOn()) {
        var hard = el('div', 'hud-hard');
        hard.appendChild(icon('alert'));
        hard.appendChild(el('span', null, 'Без подсказок'));
        hard.setAttribute('title',
          'Режим «Испытание»: цена решения видна, но остаток и последствия интерфейс за вас не считает');
        when.appendChild(hard);
      }
      top.appendChild(when);

      // Лента месяцев: прошлое приглушено, текущий выделен, будущее едва видно.
      var strip = el('div', 'month-strip');
      strip.id = 'month-strip';
      strip.setAttribute('aria-hidden', 'true');
      top.appendChild(strip);

      var money = el('div', 'hud-money');
      money.appendChild(el('div', 'hud-lab', 'Наличные'));
      var cashv = el('div', 'hud-cash');
      cashv.id = 'hud-cash';
      money.appendChild(cashv);
      var sub = el('div', 'hud-sub');
      sub.id = 'hud-sub';
      money.appendChild(sub);
      top.appendChild(money);

      // Кнопки шапки живут в одной ячейке сетки: добавить пятую колонку
      // значило бы переписывать раскладку HUD на всех размерах экрана.
      var tools = el('div', 'hud-tools');
      tools.appendChild(buildThemeBtn('hud-exit theme-btn'));

      var exit = el('button', 'hud-exit');
      exit.setAttribute('aria-label', 'Выйти в меню');
      exit.appendChild(icon('close'));
      exit.onclick = function () {
        if (confirm('Выйти из партии? Прогресс этой партии не сохранится.')) renderMenu();
      };
      tools.appendChild(exit);
      top.appendChild(tools);

      w.appendChild(top);

      /* Тело: сцена решения + правая колонка состояния и хроники */
      var body = el('div', 'game-body');

      var main = el('main', 'game-main');
      var mount = el('div', 'stage-mount');
      mount.id = 'sheet-mount';
      main.appendChild(mount);
      var idle = el('div', 'stage-idle');
      idle.id = 'stage-idle';
      idle.appendChild(icon('clock', 'idle-ic'));
      idle.appendChild(el('div', 'idle-title', 'Время идёт'));
      idle.appendChild(el('div', 'idle-text', 'Месяцы проходят сами. Игра остановится, когда потребуется решение.'));
      main.appendChild(idle);
      body.appendChild(main);

      var side = el('aside', 'game-side');

      // Компактная панель состояния: название, значение, изменение, индикатор.
      var stats = el('section', 'status-panel');
      stats.id = 'bars';
      stats.appendChild(el('div', 'panel-label', 'Состояние'));
      var barsBox = el('div', 'bars bars-4');
      [
        ['money', 'Резерв', 'wallet'],
        ['calm', 'Спокойствие', 'shield'],
        ['quality', 'Жизнь', 'heart'],
        ['energy', 'Силы', 'bolt']
      ].forEach(function (def) {
        var k = def[0];
        var b = el('div', 'bar bar-' + k);
        var head = el('div', 'bar-head');
        var nameWrap = el('span', 'bar-name');
        nameWrap.appendChild(icon(def[2]));
        nameWrap.appendChild(el('span', null, def[1]));
        head.appendChild(nameWrap);
        var right = el('span', 'bar-right');
        var val = el('strong', 'bar-value');
        val.id = 'bar-value-' + k;
        right.appendChild(val);
        var delta = el('span', 'bar-delta');
        delta.id = 'bar-delta-' + k;
        right.appendChild(delta);
        head.appendChild(right);
        b.appendChild(head);

        // График истории показателя: видно не только текущее значение,
        // но и направление, в котором игрок двигался последние месяцы.
        var spark = el('div', 'bar-spark');
        spark.id = 'bar-spark-' + k;
        b.appendChild(spark);

        var track = el('div', 'bar-track');
        var fill = el('i');
        fill.id = 'bar-' + k;
        track.appendChild(fill);
        b.appendChild(track);
        barsBox.appendChild(b);
      });
      stats.appendChild(barsBox);
      side.appendChild(stats);

      // Кошелёк и портфель: доступны в любой месяц, а не только по событию
      side.appendChild(buildWalletPanel());
      side.appendChild(buildPortfolioPanel());

      // Хроника: лента месяцев со всем, что произошло
      var chron = el('section', 'chronicle');
      var ch = el('div', 'panel-label');
      ch.appendChild(el('span', null, 'Хроника'));
      var scName = el('span', 'panel-sub', G.scenario.title);
      ch.appendChild(scName);
      chron.appendChild(ch);
      var tl = el('div', 'timeline');
      tl.id = 'timeline';
      chron.appendChild(tl);
      side.appendChild(chron);

      body.appendChild(side);
      w.appendChild(body);

      root.appendChild(w);
      resetScroll();
    }

    updateHud();
    buildTimeline();
    buildMonthStrip();
    refreshWallet();
    refreshPortfolio();

    if (G.run.awaiting) {
      // Разгон времени до момента решения — визуальная пауза перед остановкой
      scrollToMonth(G.run.awaiting.month, function () {
        showEvent(G.run.awaiting);
      });
    } else if (G.run.finished) {
      if (G.run.gameOver) {
        setTimeout(function () { renderGameOver(); }, 520);
      } else {
        setTimeout(function () { renderReport(); }, 520);
      }
    }
  }

  function updateHud() {
    var st = G.run.state;
    var cash = document.getElementById('hud-cash');
    var sub = document.getElementById('hud-sub');
    var mo = document.getElementById('hud-month');
    var yr = document.getElementById('hud-year');
    var mn = document.getElementById('hud-monthname');
    if (!cash) return;

    cash.textContent = fmt(st.cash);
    cash.className = 'hud-cash' + (st.cash < 0 ? ' neg' : '');

    var parts = [];
    parts.push('резерв ' + fmtShort(st.reserve));
    parts.push('продукты ' + fmtShort(st.foodBudget) + '/мес');
    var debt = E.debtBalanceTotal(st);
    if (debt > 0) parts.push('долг ' + fmtShort(debt));
    var rm = E.reserveMonths(st);
    if (rm > 0) parts.push(rm.toFixed(1) + ' мес запаса');
    // Кредитный рейтинг виден всегда: иначе он остаётся невидимой величиной,
    // которая однажды молча превращается в отказ банка или в ставку побольше.
    parts.push('рейтинг ' + Math.round(st.creditScore) + ' · ' + E.creditTier(st.creditScore).label);
    sub.textContent = parts.join('  ·  ');

    var m = Math.min(st.month, G.scenario.months - 1);
    if (yr) yr.textContent = 'Год ' + (1 + Math.floor(m / 12));
    if (mo) mo.textContent = 'Месяц ' + ((m % 12) + 1);
    if (mn) mn.textContent = MONTHS_FULL[m % 12];

    // Шкала денег: положение резерва относительно цели «3 месяца».
    var moneyPct = clamp(rm / 3 * 100, 0, 100);
    setBar('bar-money', moneyPct, rm.toFixed(1) + ' мес');
    setBar('bar-calm', st.calm, Math.round(st.calm));
    setBar('bar-quality', st.quality, Math.round(st.quality));
    setBar('bar-energy', st.energy, Math.round(st.energy));

    // Графики истории по каждому показателю
    var hist = G.run.history || [];
    drawSpark('money', hist.map(function (h) {
      var need = st.mandatory + st.foodBudget;
      return clamp(need > 0 ? (h.reserve / need) / 3 * 100 : 0, 0, 100);
    }));
    drawSpark('calm', hist.map(function (h) { return h.calm; }));
    drawSpark('quality', hist.map(function (h) { return h.quality; }));
    drawSpark('energy', hist.map(function (h) { return h.energy; }));
  }

  function setBar(id, pct, label) {
    var n = document.getElementById(id);
    if (!n) return;
    var first = n.dataset.pct == null || n.dataset.pct === '';
    var was = first ? pct : parseFloat(n.dataset.pct);
    var change = first ? 0 : pct - was;
    n.style.width = clamp(pct, 0, 100) + '%';
    var key = id.replace('bar-', '');
    var value = document.getElementById('bar-value-' + key);
    var delta = document.getElementById('bar-delta-' + key);
    if (value) value.textContent = label == null ? Math.round(pct) : label;
    if (delta) {
      delta.textContent = Math.abs(change) < .5 ? '·' : (change > 0 ? '+' : '−') + Math.round(Math.abs(change));
      delta.className = 'bar-delta ' + (change > .5 ? 'up' : change < -.5 ? 'down' : 'flat');
    }
    if (Math.abs(change) > 4) {
      n.classList.remove('pulse');
      void n.offsetWidth;
      n.classList.add('pulse');
      n.classList.toggle('down', pct < was);
    }
    n.dataset.pct = String(pct);
  }

  /**
   * Мини-график показателя: линия по истории партии.
   * Рисуется через SVG, потому что вся графика в проекте делается кодом.
   */
  function drawSpark(key, values) {
    var host = document.getElementById('bar-spark-' + key);
    if (!host) return;
    host.innerHTML = '';
    // Пока истории нет, место под график не занимаем: пустая полоса
    // в панели состояния выглядит как ошибка вёрстки.
    if (!values || values.length < 2) {
      if (host.classList) host.classList.add('empty');
      return;
    }
    if (host.classList) host.classList.remove('empty');

    var W = 100, H = 26;
    var pts = values.map(function (v, i) {
      var x = W * (i / (values.length - 1));
      var y = H - (H - 3) * (clamp(v, 0, 100) / 100) - 1.5;
      return { x: x, y: y };
    });
    var d = pts.map(function (p, i) {
      return (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    }).join(' ');

    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'spark-svg');
    svg.setAttribute('aria-hidden', 'true');

    var area = document.createElementNS(ns, 'path');
    area.setAttribute('d', d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z');
    area.setAttribute('class', 'spark-area');
    svg.appendChild(area);

    var line = document.createElementNS(ns, 'path');
    line.setAttribute('d', d);
    line.setAttribute('class', 'spark-line');
    svg.appendChild(line);

    var last = pts[pts.length - 1];
    var dot = document.createElementNS(ns, 'path');
    dot.setAttribute('d', 'M' + last.x.toFixed(1) + ' ' + last.y.toFixed(1) + 'l0 0');
    dot.setAttribute('class', 'spark-dot');
    svg.appendChild(dot);

    host.appendChild(svg);
  }

  /* Полоса месяцев в шапке */

  function buildMonthStrip() {
    var strip = document.getElementById('month-strip');
    if (!strip) return;
    var st = G.run.state;
    var total = G.scenario.months;
    if (strip.children && strip.children.length === total) {
      // Обновляем состояние без пересборки — так работает анимация перехода
      for (var i = 0; i < total; i++) {
        var t = strip.children[i];
        if (!t || !t.classList) continue;
        t.classList.toggle('past', i < st.month);
        t.classList.toggle('now', i === st.month);
        t.classList.toggle('future', i > st.month);
      }
      return;
    }
    strip.innerHTML = '';
    for (var m = 0; m < total; m++) {
      var tick = el('i', 'ms-tick' +
        (m % 12 === 0 ? ' year' : '') +
        (m < st.month ? ' past' : m === st.month ? ' now' : ' future'));
      strip.appendChild(tick);
    }
  }

  /* Лента месяцев (хроника) */

  /**
   * Помесячный итог: сколько пришло, сколько ушло и почему остаток изменился
   * именно так. Это прямой ответ на вопрос «я же потратил, почему денег больше».
   */
  function monthRecord(st, m) { return findIn(st.monthly || [], 'month', m); }

  function monthSummaryNode(rec) {
    var up = rec.delta >= 0;
    var box = el('details', 'tl-month-sum' + (up ? ' up' : ' down'));
    var sum = el('summary', 'tl-sum-head');
    sum.appendChild(el('span', 'tl-sum-lab', 'Итог месяца'));
    sum.appendChild(el('span', 'tl-sum-val', (up ? '+' : '−') + fmtShort(Math.abs(rec.delta))));
    box.appendChild(sum);

    var rows = [
      ['Доход', rec.income],
      ['Взято в долг', rec.borrowed || 0],
      ['Обязательные расходы', -rec.mandatory],
      ['Продукты', -rec.food],
      ['Подписки', -rec.subs],
      ['Бытовые расходы', -rec.living],
      ['Платежи по долгам', -rec.debt],
      ['Штрафы и минус на счёте', -rec.fees],
      ['Ушло во вложения', -(rec.invested || 0)],
      ['Решения этого месяца', -rec.events],
      ['Прочее', rec.other || 0]
    ];
    rows.forEach(function (r) {
      if (Math.abs(r[1]) < 1) return;
      var line = el('div', 'tl-sum-row' + (r[1] < 0 ? ' out' : ' in'));
      line.appendChild(el('span', 'tl-sum-key', r[0]));
      line.appendChild(el('span', 'tl-sum-num', fmt(Math.round(r[1]))));
      box.appendChild(line);
    });
    var tail = el('div', 'tl-sum-row total');
    tail.appendChild(el('span', 'tl-sum-key', 'Было ' + fmtShort(rec.open) + ' → стало'));
    tail.appendChild(el('span', 'tl-sum-num', fmt(Math.round(rec.close))));
    box.appendChild(tail);
    return box;
  }

  function buildTimeline() {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    tl.innerHTML = '';
    tl.classList.toggle('full', !!G.timelineFull);
    var st = G.run.state;

    // Группируем записи по месяцам
    var byMonth = {};
    st.timeline.forEach(function (t) {
      (byMonth[t.month] = byMonth[t.month] || []).push(t);
    });

    for (var m = 0; m < G.scenario.months; m++) {
      var cell = el('div', 'tl-month');
      cell.id = 'tlm-' + m;
      if (m % 12 === 0) cell.classList.add('year-start');
      if (m < st.month) cell.classList.add('past');
      if (m === st.month) cell.classList.add('now');
      if (m > st.month) cell.classList.add('future');
      // На телефоне у ленты нет своего скроллера, и за 60 месяцев страница
      // вырастает до нескольких тысяч пикселей. Далёкие месяцы помечаем,
      // чтобы свернуть их до нажатия «показать всю хронику».
      if (m < st.month - 11) cell.classList.add('far-past');
      if (m > st.month + 2) cell.classList.add('far-future');

      var spine = el('div', 'tl-spine');
      spine.appendChild(el('i', 'tl-node'));
      cell.appendChild(spine);

      var body = el('div', 'tl-body');
      if (m % 12 === 0) body.appendChild(el('div', 'tl-year', 'Год ' + (1 + Math.floor(m / 12))));
      var nameRow = el('div', 'tl-name-row');
      nameRow.appendChild(el('span', 'tl-name', MONTHS[m % 12]));
      if (m === st.month) nameRow.appendChild(el('span', 'tl-badge', 'сейчас'));
      body.appendChild(nameRow);

      var recs = byMonth[m] || [];

      if (m <= st.month) {
        var snap = G.run.history[m + 1];
        if (snap) {
          var row = el('div', 'tl-figures');
          row.appendChild(el('span', 'fig', fmtShort(snap.cash + snap.reserve)));
          if (snap.debt > 0) row.appendChild(el('span', 'fig neg', '−' + fmtShort(snap.debt)));
          body.appendChild(row);
        }
        recs.forEach(function (r) {
          // Итог месяца — не рядовая запись, а объяснение движения остатка,
          // поэтому он рисуется отдельной раскрывающейся строкой.
          if (r.type === 'month-up' || r.type === 'month-down') return;
          var chip = el('div', 'tl-rec ' + r.type);
          chip.appendChild(el('span', 'rec-text', r.label));
          if (r.amount) chip.appendChild(el('span', 'rec-amt', fmt(r.amount)));
          body.appendChild(chip);
        });
        var mrec = monthRecord(st, m);
        if (mrec) body.appendChild(monthSummaryNode(mrec));
      }

      cell.appendChild(body);
      tl.appendChild(cell);
    }

    // Кнопка появляется только там, где часть месяцев скрыта (телефон)
    if (!G.timelineFull && st.month > 12) {
      var more = el('button', 'tl-more');
      more.appendChild(el('span', null, 'Показать всю хронику'));
      more.appendChild(icon('arrow'));
      more.onclick = function () {
        G.timelineFull = true;
        MaxBridge.hapticSelect();
        buildTimeline();
      };
      tl.appendChild(more);
    }
  }

  /**
   * Пауза «время идёт» перед следующим решением.
   *
   * Ленту больше не прокручиваем: у неё нет своей прокрутки, а дёргать
   * страницу под игроком нельзя — он в этот момент читает карточку.
   * Текущий месяц и так всегда виден: далёкие месяцы свёрнуты.
   */
  function scrollToMonth(m, done) {
    var tl = document.getElementById('timeline');
    if (tl && tl.classList) tl.classList.add('rushing');
    setTimeout(function () {
      if (tl && tl.classList) tl.classList.remove('rushing');
      MaxBridge.haptic('soft');
      if (done) done();
    }, 460);
  }

  /*
   *  Предварительная стоимость варианта
   *
   *  Игрок должен видеть, сколько денег стоит вариант, ДО того как выберет.
   *  Считается не в UI: копия состояния прогоняется через настоящий Engine.api,
   *  затем берётся разница. Поэтому цифры не могут разойтись с движком.
   *
   *  Жеребьёвки (gamble) и отложенные последствия (defer) НЕ выполняются:
   *  это скрытая часть механики, раскрывать её заранее нельзя.
   */

  function clonePlain(o, depth) {
    if (o === null || typeof o !== 'object') return o;
    if ((depth || 0) > 8) return null;
    if (Array.isArray(o)) {
      var arr = [];
      for (var i = 0; i < o.length; i++) arr.push(clonePlain(o[i], (depth || 0) + 1));
      return arr;
    }
    var r = {};
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      r[k] = (typeof v === 'function') ? v : clonePlain(v, (depth || 0) + 1);
    }
    return r;
  }

  function previewChoice(ch) {
    if (!ch || typeof ch.apply !== 'function' || !E.api) return null;
    var before = G.run.state;
    var s = clonePlain(before);
    if (!s) return null;

    var mock = {};
    Object.keys(E.api).forEach(function (k) { mock[k] = E.api[k]; });
    mock.gamble = function () { return null; };   // скрытое остаётся скрытым
    mock.peek = function () { return 0; };
    mock.defer = function () { };                 // последствия в будущем не раскрываем
    mock.schedule = function () { };              // и сюжетные повороты тоже

    /* Единственная обёртка на всю оценку: событие пишется вручную, и
       ошибка в его apply не должна ронять экран целиком. Но и молчать
       о ней нельзя — иначе строка цены просто исчезает, а почему,
       не знает никто. */
    try {
      ch.apply(s, mock, E);
    } catch (e) {
      Fail.report('Не удалось посчитать цену варианта «' + (ch.label || ch.id) + '»', e);
      return null;
    }

    var fb = before.flows, fa = s.flows;
    function fd(k) { return (fa[k] || 0) - (fb[k] || 0); }

    var spentNow = fd('fun') + fd('shocks') + fd('living') + fd('food') +
      fd('mandatory') + fd('invested') + fd('debtPaid') + fd('fees') + fd('interest');
    var borrowed = fd('borrowed');
    var earned = fd('income');
    var saved = fd('saved');

    var beforeIds = {};
    before.debts.forEach(function (d) { beforeIds[d.id] = d; });
    var newDebts = s.debts.filter(function (d) { return !beforeIds[d.id]; });

    var changedDebts = 0;
    s.debts.forEach(function (d) {
      var b = beforeIds[d.id];
      if (b && Math.abs(d.payment - b.payment) > 1) changedDebts += d.payment - b.payment;
    });

    var out = {
      spentNow: Math.round(spentNow),
      borrowed: Math.round(borrowed),
      earned: Math.round(earned),
      saved: Math.round(saved),
      newDebts: newDebts,
      paymentDelta: Math.round(changedDebts),
      income: Math.round(s.income - before.income),
      mandatory: Math.round(s.mandatory - before.mandatory),
      food: Math.round(s.foodBudget - before.foodBudget),
      subs: Math.round(E.subsTotal(s) - E.subsTotal(before)),
      autoSave: s.autoSave - before.autoSave,
      autoSaveAmount: Math.round((s.autoSave - before.autoSave) * before.income),
      living: Math.round((s.livingShare - before.livingShare) * before.income),
      assets: Math.round(E.assetsTotal(s) - E.assetsTotal(before)),
      debtPaid: Math.round(E.debtBalanceTotal(before) - E.debtBalanceTotal(s) +
        newDebts.reduce(function (a, d) { return a + d.balance; }, 0)),
      refused: (s.stats.creditRefused - before.stats.creditRefused) > 0,
      // Ответ банка: сколько просили и сколько на самом деле дадут.
      // Обращение опознаём по счётчику, а не по сравнению объектов:
      // копия состояния создаёт новый объект, и сравнение всегда было бы
      // истинным. Формула та же, что и в настоящем расчёте, поэтому
      // предупреждение не может разойтись с исходом.
      credit: (s.creditSeq || 0) !== (before.creditSeq || 0) ? s.lastCredit : null,
      // Состояние сразу после решения: главный вопрос игрока — «что у меня
      // останется», а не только «сколько это стоит».
      after: {
        cash: Math.round(s.cash),
        reserve: Math.round(s.reserve),
        free: freeMonthly(s)
      }
    };
    return out;
  }

  /** Строит строку конкретики под вариантом решения. */
  function buildCostLine(ch) {
    var p = previewChoice(ch);
    if (!p) return null;

    var row = el('div', 'choice-cost');
    var items = [];

    function add(text, cls, ic) { items.push({ text: text, cls: cls || '', ic: ic }); }

    /* Ответ банка — первым, до всех остальных цифр.
       Раньше игрок выбирал «взять кредит», банк отказывал по рейтингу,
       и не происходило ничего: ни денег, ни долга, ни объяснения.
       Теперь отказ и урезанная сумма видны ещё до выбора — а заодно
       это и есть тот самый урок про кредитный рейтинг. */
    if (p.credit && p.credit.refused) {
      add(p.credit.limit > 0
        ? 'банк откажет: одобрят не больше ' + fmt(p.credit.limit) +
          ' при рейтинге ' + Math.round(G.run.state.creditScore)
        : 'банк откажет: с рейтингом ' + Math.round(G.run.state.creditScore) +
          ' кредит не дадут', 'out', 'alert');
    } else if (p.credit && p.credit.cut) {
      add('банк одобрит только ' + fmt(p.credit.given) + ' из ' + fmt(p.credit.asked),
          'debt', 'alert');
    }

    if (p.spentNow > 0) add('−' + fmt(p.spentNow) + ' сразу', 'out', 'wallet');
    if (p.borrowed > 0) add('+' + fmt(p.borrowed) + ' на руки', 'debt', 'coin');
    if (p.earned > 0) add('+' + fmt(p.earned) + ' разово', 'in', 'coin');
    if (p.saved > 0) add(fmt(p.saved) + ' в резерв', 'in', 'shield');
    if (p.debtPaid > 0) add('−' + fmt(p.debtPaid) + ' долга', 'in', 'check');
    if (p.assets > 0 && p.spentNow <= 0) add(fmt(p.assets) + ' во вложения', 'in', 'chart');

    p.newDebts.forEach(function (d) {
      var months = d.months || 0;
      var total = Math.round(d.payment * months);
      var over = Math.round(total - d.balance);
      var txt = fmt(Math.round(d.payment)) + '/мес × ' + months + ' мес';
      if (total > 0) txt += ' · всего ' + fmt(total);
      if (over > 500) txt += ' · переплата ' + fmt(over);
      add(txt, 'debt', 'clock');
    });

    if (p.paymentDelta !== 0 && !p.newDebts.length) {
      add('платёж по долгам ' + (p.paymentDelta > 0 ? '+' : '−') +
        fmt(Math.abs(p.paymentDelta)) + '/мес', p.paymentDelta > 0 ? 'debt' : 'in', 'clock');
    }
    if (p.income !== 0) {
      add('доход ' + (p.income > 0 ? '+' : '−') + fmt(Math.abs(p.income)) + '/мес',
        p.income > 0 ? 'in' : 'out', 'chart');
    }
    if (p.mandatory !== 0) {
      add('обязательные ' + (p.mandatory > 0 ? '+' : '−') + fmt(Math.abs(p.mandatory)) + '/мес',
        p.mandatory > 0 ? 'out' : 'in', 'alert');
    }
    if (p.food !== 0) {
      add('продукты ' + fmt(Math.abs(G.run.state.foodBudget + p.food)) + '/мес',
        p.food > 0 ? 'out' : 'in', 'wallet');
    }
    if (p.subs !== 0) {
      add('подписки ' + (p.subs > 0 ? '+' : '−') + fmt(Math.abs(p.subs)) + '/мес',
        p.subs > 0 ? 'out' : 'in', 'refresh');
    }
    if (Math.abs(p.autoSave) > 0.001) {
      add('автоперевод ' + Math.round((G.run.state.autoSave + p.autoSave) * 100) + '% ≈ ' +
        fmt(Math.abs(Math.round((G.run.state.autoSave + p.autoSave) * G.run.state.income))) + '/мес',
        'in', 'shield');
    }
    if (p.living !== 0) {
      add('быт ' + (p.living > 0 ? '+' : '−') + fmt(Math.abs(p.living)) + '/мес',
        p.living > 0 ? 'out' : 'in', 'wallet');
    }

    if (!items.length) add('Без прямых денежных затрат', 'flat', 'check');

    items.slice(0, 4).forEach(function (it) {
      var c = el('span', 'cost ' + it.cls);
      if (it.ic) c.appendChild(icon(it.ic));
      c.appendChild(el('span', null, it.text));
      row.appendChild(c);
    });

    // Что останется после решения. Показываем только когда деньги
    // действительно двигаются — иначе строка была бы шумом.
    // В «Испытании» не показываем совсем: это единственная часть строки,
    // которая не называет цену, а делает за игрока вывод о его положении.
    var moves = hintsOn() && (p.spentNow > 0 || p.borrowed > 0 || p.earned > 0 || p.saved > 0 ||
      p.newDebts.length > 0 || p.income !== 0 || p.mandatory !== 0 ||
      p.subs !== 0 || p.food !== 0 || Math.abs(p.autoSave) > 0.001 || p.living !== 0);
    if (moves) {
      var st = G.run.state;
      var after = el('div', 'choice-after');
      after.appendChild(afterCell('останется на руках', fmt(p.after.cash), p.after.cash < 0));
      if (Math.round(p.after.reserve) !== Math.round(st.reserve)) {
        after.appendChild(el('i', 'ca-sep'));
        after.appendChild(afterCell('резерв', fmt(p.after.reserve), false));
      }
      if (p.after.free !== freeMonthly(st)) {
        after.appendChild(el('i', 'ca-sep'));
        after.appendChild(afterCell('свободно в месяц', fmt(p.after.free), p.after.free < 0));
      }
      row.appendChild(after);
    }
    return row;
  }

  function afterCell(lab, val, bad) { return labelValue('span', 'ca', 'span', 'ca-lab', 'ca-val', lab, val, bad ? 'bad' : ''); }

  /*
   *  БИРЖА И ПОРТФЕЛЬ
   *
   *  Игрок может покупать и продавать в любой месяц, а не только когда
   *  выпало событие про вложения. Это принципиально: половина ошибок
   *  с деньгами делается не в момент предложения, а между ними.
   *
   *  Сделка записывается в тот же поток, что и решения, с пометкой
   *  «сколько решений было принято до неё». Движок вставляет её ровно
   *  в это место при пересчёте партии, поэтому цена сделки совпадает
   *  с той, что игрок видел на экране.
   */

  /** Сколько решений принято к этому моменту — позиция сделки в потоке. */
  function tradeAfter() {
    var n = 0;
    G.choices.forEach(function (c) { if (!c.type) n++; });
    return n;
  }

  function instrumentById(id) { return findIn(C.instruments || [], 'id', id); }

  function riskLabel(r) {
    var labels = C.riskLabels || [];
    return labels[r] || '—';
  }

  /** Цена инструмента в текущем месяце партии. */
  function instPrice(id, month) {
    var st = G.run.state;
    return E.priceAt(st.scenarioId, G.seed, id, month == null ? st.month : month);
  }

  /*
   *  Свечной график
   *
   *  Движок считает одну цену на месяц — этого достаточно для сделок,
   *  но не для графика: свеча требует открытия, максимума, минимума
   *  и закрытия. Промежуточные точки достраиваются здесь, детерминированно
   *  из того же seed. Это ТОЛЬКО отображение: сделки по-прежнему проходят
   *  по месячной цене движка, поэтому «внутри месяца» ничего не купить.
   */

  /* Точек внутри месяца. Их восемь, а не четыре, по одной причине: из двух
     точек свеча получиться не может. При коротком окне на свечу приходилось
     ровно две точки, и тогда открытие совпадало с минимумом, а закрытие с
     максимумом — тени исчезали, и график превращался в ряд голых
     прямоугольников. Восемь точек дают тень при любом периоде. */
  var STEPS_PER_MONTH = 8;

  function subNoise(instId, m, w) {
    var h = E.hashSeed(String(G.seed) + '|' + instId + '|' + m + '|' + w);
    return E.mulberry32(h)() * 2 - 1;
  }

  /** Цены с шагом в четверть месяца от fromMonth до toMonth включительно. */
  function subPrices(instId, fromMonth, toMonth) {
    var inst = instrumentById(instId);
    /* Размах внутри периода. Он и рисует тени свечей: при слишком малом
       значении свеча превращалась в голый прямоугольник без теней, и
       график терял половину смысла — по тени видно, куда цену дёргало
       внутри месяца. Небольшая добавка держит тень заметной даже у самых
       спокойных бумаг. */
    var wiggle = inst ? Math.min(0.5, (inst.vol || 0) * 0.95 + 0.005) : 0;
    var out = [];
    for (var m = Math.max(0, fromMonth); m <= toMonth; m++) {
      var prev = instPrice(instId, Math.max(0, m - 1));
      var now = instPrice(instId, m);
      for (var w = 0; w < STEPS_PER_MONTH; w++) {
        var t = (w + 1) / STEPS_PER_MONTH;
        var base = prev + (now - prev) * t;
        // Последняя точка месяца — ровно цена движка: график и сделка сходятся.
        var v = (w === STEPS_PER_MONTH - 1) ? now : base * (1 + wiggle * subNoise(instId, m, w));
        out.push(Math.max(base * 0.2, v));
      }
    }
    return out;
  }

  /**
   * Сворачивает точки в свечи: открытие, максимум, минимум, закрытие.
   * Вместе со свечой запоминается месяц, к которому она относится, —
   * иначе подсказке нечего сказать о том, КОГДА это было.
   */
  function toCandles(points, target, fromMonth) {
    var n = points.length;
    if (!n) return [];
    /* Не меньше четырёх точек на свечу: из двух точек тени не получится
       ни при каком периоде. */
    var per = Math.max(4, Math.ceil(n / (target || 42)));
    var out = [];
    for (var i = 0; i < n; i += per) {
      var chunk = points.slice(i, i + per);
      if (!chunk.length) break;
      out.push({
        o: chunk[0],
        c: chunk[chunk.length - 1],
        h: Math.max.apply(null, chunk),
        l: Math.min.apply(null, chunk),
        m: (fromMonth || 0) + Math.floor((i + chunk.length - 1) / STEPS_PER_MONTH)
      });
    }
    return out;
  }
  /** Изменение цены за последние n месяцев, в долях. */
  function instChange(id, back) {
    var st = G.run.state;
    var now = st.month;
    var from = Math.max(0, now - (back || 12));
    var a = instPrice(id, from), b = instPrice(id, now);
    if (!(a > 0)) return 0;
    return b / a - 1;
  }

  function fmtUnits(inst, units) {
    if (units >= 1000) return Math.round(units).toLocaleString('ru-RU').replace(/ /g, ' ');
    if (units >= 100) return units.toFixed(1);
    if (units >= 1) return units.toFixed(2);
    return units.toFixed(4);
  }

  /** Цена бумаги: у дешёвых инструментов копейки имеют значение. */
  function fmtPrice(x) {
    if (Math.abs(x) >= 100) return fmt(Math.round(x));
    var v = Math.round(x * 100) / 100;
    return v.toFixed(2).replace('.', ',') + ' ₽';
  }

  function fmtPct(x) {
    return (x >= 0 ? '+' : '−') + (Math.abs(x) * 100).toFixed(1) + '%';
  }

  /**
   * Выполнить сделку. Партия пересчитывается целиком — это дешевле, чем
   * держать отдельную ветку состояния, и гарантирует, что портфель
   * не разойдётся с движком.
   */
  function doTrade(t) {
    t.type = 'trade';
    t.after = tradeAfter();
    t.month = G.run.state.month;
    G.choices.push(t);
    recompute();
    updateHud();
    buildTimeline();
    buildMonthStrip();
    refreshWallet();
    refreshPortfolio();
    // Стоимость вариантов на открытой карте считается от наличных,
    // а они только что изменились — пересобираем строки цены.
    if (G.openSheet && G.openSheet.stage === 'choices') {
      showChoices(G.openSheet.ev, G.openSheet.body, G.openSheet.overlay);
    }
    MaxBridge.haptic('rigid');
  }

  function canTrade() {
    return G.screen === 'game' && G.run && !G.run.finished;
  }

  /**
   * «Испытание» проходит без подсказок интерфейса.
   *
   * Граница проходит между ЦЕНОЙ и ВЫВОДОМ.
   *
   * Цена остаётся всегда: сколько спишется сразу, какой платёж и на какой срок,
   * сколько выйдет всего и сколько из этого переплата, как изменятся доход,
   * обязательные расходы и подписки. Это условия предложения — их в жизни
   * тоже видно, и прятать их значило бы заставлять угадывать вслепую.
   *
   * Скрывается вывод — то, что игра считает за игрока: каким станет остаток
   * на руках и сколько после этого останется свободных денег в месяц, сводка
   * положения на карточке, запас резерва в месяцах и поясняющие реплики.
   * Эту арифметику в «Испытании» игрок делает сам.
   */
  function hintsOn() {
    var lvl = G.scenario ? G.scenario.level : G.level;
    return lvl < 3;
  }

  /*
   *  КОШЕЛЁК: резерв и досрочное погашение
   *
   *  Раньше распоряжаться резервом и гасить долг можно было только тогда,
   *  когда об этом спросило событие. Это неверно по сути: и то, и другое —
   *  решения, которые в жизни принимают когда захотят, а не по расписанию.
   */

  /*
   * Каркас панели правой колонки: заголовок с подписью и пустое тело.
   * Наполняют его потом refreshWallet и refreshPortfolio — по id.
   */
  function buildSidePanel(id, title, subId, bodyId) {
    var box = el('section', id);
    box.id = id;
    var head = el('div', 'panel-label');
    head.appendChild(el('span', null, title));
    var sub = el('span', 'panel-sub');
    sub.id = subId;
    head.appendChild(sub);
    box.appendChild(head);
    var body = el('div', bodyId);
    body.id = bodyId;
    box.appendChild(body);
    return box;
  }

  function buildWalletPanel() { return buildSidePanel('wallet-panel', 'Кошелёк', 'wl-cash', 'wl-body'); }

  function refreshWallet() {
    var body = document.getElementById('wl-body');
    if (!body) return;
    var st = G.run.state;
    var cashNode = document.getElementById('wl-cash');
    if (cashNode) cashNode.textContent = fmt(Math.round(st.cash)) + ' на счету';

    body.innerHTML = '';

    /* --- Резерв --- */
    var res = el('div', 'wl-row');
    var rTop = el('div', 'wl-top');
    var rName = el('span', 'wl-name');
    rName.appendChild(icon('shield'));
    rName.appendChild(el('span', null, 'Резерв'));
    rTop.appendChild(rName);
    var rv = el('span', 'wl-val', fmt(Math.round(st.reserve)));
    rTop.appendChild(rv);
    res.appendChild(rTop);
    if (hintsOn()) {
      res.appendChild(el('div', 'wl-hint',
        E.reserveMonths(st).toFixed(1) + ' месяца обязательных расходов'));
    }

    var rActs = el('div', 'wl-acts');
    var toRes = el('button', 'wl-act');
    toRes.appendChild(icon('plus'));
    toRes.appendChild(el('span', null, 'Отложить'));
    toRes.disabled = !canTrade() || st.cash < 500;
    toRes.onclick = function () {
      openAmountForm(res, {
        title: 'Отложить в резерв',
        min: 500, max: Math.floor(st.cash),
        hint: 'Деньги останутся вашими, но перестанут быть «свободными».',
        confirm: 'Отложить',
        onDone: function (amount) { doTrade({ op: 'toReserve', amount: amount }); refreshWallet(); }
      });
    };
    rActs.appendChild(toRes);

    var fromRes = el('button', 'wl-act');
    fromRes.appendChild(icon('minus'));
    fromRes.appendChild(el('span', null, 'Снять'));
    fromRes.disabled = !canTrade() || st.reserve < 500;
    fromRes.onclick = function () {
      openAmountForm(res, {
        title: 'Снять из резерва',
        min: 500, max: Math.floor(st.reserve),
        hint: 'Резерв для того и нужен. Но каждый раз стоит спросить: это та самая ситуация?',
        confirm: 'Снять',
        onDone: function (amount) { doTrade({ op: 'fromReserve', amount: amount }); refreshWallet(); }
      });
    };
    rActs.appendChild(fromRes);
    res.appendChild(rActs);
    body.appendChild(res);

    /* --- Долги --- */
    var debts = st.debts || [];
    if (debts.length) {
      debts.forEach(function (d) {
        var row = el('div', 'wl-row debt');
        var top = el('div', 'wl-top');
        var nm = el('span', 'wl-name');
        nm.appendChild(icon('alert'));
        nm.appendChild(el('span', null, d.label));
        top.appendChild(nm);
        top.appendChild(el('span', 'wl-val neg', fmt(Math.round(d.balance))));
        row.appendChild(top);
        row.appendChild(el('div', 'wl-hint',
          'платёж ' + fmt(Math.round(d.payment)) + '/мес · ставка ' +
          (E.monthlyToAnnual(d.monthlyRate) * 100).toFixed(1) + '% годовых'));

        var acts = el('div', 'wl-acts');
        var pay = el('button', 'wl-act strong');
        pay.appendChild(icon('check'));
        pay.appendChild(el('span', null, 'Погасить'));
        pay.disabled = !canTrade() || (st.cash < 500 && st.reserve < 500);
        pay.onclick = function () {
          var maxCash = Math.min(Math.floor(d.balance), Math.max(0, Math.floor(st.cash)));
          openAmountForm(row, {
            title: 'Погасить: ' + d.label,
            min: Math.min(500, maxCash || 500),
            max: Math.max(500, maxCash),
            hint: 'Каждый досрочно погашенный рубль убирает проценты, которые на него ещё начислялись бы.',
            confirm: 'Погасить',
            disabled: maxCash < 500,
            disabledText: 'На счету нет свободных денег. Сначала снимите из резерва.',
            onDone: function (amount) { doTrade({ op: 'repay', amount: amount, debtId: d.id }); refreshWallet(); }
          });
        };
        acts.appendChild(pay);
        row.appendChild(acts);
        body.appendChild(row);
      });
    } else {
      var none = el('div', 'wl-empty');
      none.appendChild(icon('check'));
      none.appendChild(el('span', null, 'Долгов нет'));
      body.appendChild(none);
    }
  }

  /**
   * Универсальная форма «выбрать сумму». Используется и для резерва,
   * и для погашения долга: механика одна, меняются только подписи.
   */
  function openAmountForm(host, opt) {
    var old = host.querySelector ? host.querySelector('.amount-form') : null;
    if (old) { old.remove(); return; }
    var forms = document.querySelectorAll('.amount-form');
    if (forms) for (var i = 0; i < forms.length; i++) forms[i].remove();

    var form = el('div', 'amount-form');
    form.appendChild(el('div', 'af-title', opt.title));

    if (opt.disabled) {
      form.appendChild(el('div', 'af-hint', opt.disabledText || 'Действие сейчас недоступно'));
      var close0 = el('button', 'link-btn', 'Понятно');
      close0.onclick = function () { form.remove(); };
      form.appendChild(close0);
      host.appendChild(form);
      return;
    }

    var min = Math.max(1, Math.floor(opt.min));
    var max = Math.max(min, Math.floor(opt.max));
    var val = el('div', 'af-val');
    var slider = el('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(Math.max(100, Math.round((max - min) / 200 / 100) * 100 || 100));
    slider.value = String(Math.round((min + max) / 2));
    slider.className = 'fc-slider';
    slider.setAttribute('aria-label', opt.title);

    var amount = parseFloat(slider.value);
    function render() {
      amount = Math.max(min, Math.min(max, Math.round(parseFloat(slider.value) || min)));
      val.textContent = fmt(amount);
    }
    slider.oninput = function () { render(); MaxBridge.hapticSelect(); };

    form.appendChild(val);
    form.appendChild(slider);
    var scale = el('div', 'fc-scale');
    scale.appendChild(el('span', null, fmt(min)));
    scale.appendChild(el('span', null, fmt(max)));
    form.appendChild(scale);

    var presets = el('div', 'bf-presets');
    [['Четверть', Math.round(max * .25)], ['Половина', Math.round(max * .5)], ['Всё', max]]
      .forEach(function (def) {
        if (def[1] < min) return;
        var b = el('button', 'bf-preset');
        b.appendChild(el('span', null, def[0]));
        b.onclick = function () { slider.value = String(def[1]); render(); MaxBridge.hapticSelect(); };
        presets.appendChild(b);
      });
    form.appendChild(presets);

    if (opt.hint && hintsOn()) form.appendChild(el('div', 'af-hint', opt.hint));

    var go = el('button', 'primary-btn small');
    go.appendChild(el('span', null, opt.confirm || 'Подтвердить'));
    go.appendChild(icon('check'));
    go.onclick = function () { form.remove(); opt.onDone(amount); };
    form.appendChild(go);

    var cancel = el('button', 'link-btn', 'Отмена');
    cancel.onclick = function () { form.remove(); };
    form.appendChild(cancel);

    render();
    host.appendChild(form);
  }

  /* Панель портфеля в правой колонке */

  function buildPortfolioPanel() { return buildSidePanel('portfolio-panel', 'Портфель', 'pf-total', 'pf-body'); }

  function refreshPortfolio() {
    var body = document.getElementById('pf-body');
    if (!body) return;
    var st = G.run.state;
    var total = E.portfolioValue(st);

    var totalNode = document.getElementById('pf-total');
    if (totalNode) totalNode.textContent = total > 0 ? fmt(Math.round(total)) : 'пусто';

    var groot = document.getElementById('game-root');
    if (groot && groot.classList) {
      groot.classList.toggle('has-portfolio', !!(st.portfolio && st.portfolio.length));
    }

    body.innerHTML = '';

    if (!st.portfolio || !st.portfolio.length) {
      var empty = el('div', 'pf-empty');
      empty.appendChild(icon('trend', 'pf-empty-ic'));
      empty.appendChild(el('div', 'pf-empty-text',
        'Свободные деньги лежат без движения. Их можно вложить — или сознательно не вкладывать.'));
      body.appendChild(empty);
    } else {
      var list = el('div', 'pf-list');
      st.portfolio.forEach(function (h) {
        list.appendChild(buildHolding(h));
      });
      body.appendChild(list);

      var invested = st.portfolio.reduce(function (a, h) { return a + h.cost; }, 0);
      var pnl = total - invested;
      var sumRow = el('div', 'pf-sum' + (pnl >= 0 ? ' up' : ' down'));
      sumRow.appendChild(el('span', 'pf-sum-lab', 'Всего вложено ' + fmt(Math.round(invested))));
      sumRow.appendChild(el('span', 'pf-sum-val',
        (pnl >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(pnl))).replace('−', '')));
      body.appendChild(sumRow);
    }

    var open = el('button', 'pf-open');
    open.appendChild(icon('briefcase'));
    open.appendChild(el('span', null, st.portfolio && st.portfolio.length ? 'Открыть биржу' : 'Перейти на биржу'));
    open.appendChild(icon('arrow'));
    open.disabled = !canTrade();
    open.onclick = function () { MaxBridge.haptic('light'); openExchange(); };
    body.appendChild(open);
  }

  function buildHolding(h) {
    var st = G.run.state;
    var inst = instrumentById(h.instId);
    if (!inst) return el('div');
    var value = E.holdingValue(st, h);
    var pnl = value - h.cost;
    var pct = h.cost > 0 ? pnl / h.cost : 0;

    var row = el('div', 'pf-row' + (pnl >= 0 ? ' up' : ' down'));
    var main = el('div', 'pf-main');
    main.appendChild(el('span', 'pf-name', inst.name));
    main.appendChild(el('span', 'pf-units', fmtUnits(inst, h.units) + ' ' + inst.unit +
      ' · куплено на ' + fmtShort(h.cost) + ' ₽'));
    row.appendChild(main);

    var right = el('div', 'pf-right');
    right.appendChild(el('span', 'pf-val', fmt(Math.round(value))));
    right.appendChild(el('span', 'pf-pnl', fmtPct(pct)));
    row.appendChild(right);

    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.onclick = function () {
      row.classList.toggle('open');
      MaxBridge.hapticSelect();
    };

    var acts = el('div', 'pf-acts');
    var half = el('button', 'pf-act');
    half.appendChild(el('span', null, 'Продать половину'));
    half.disabled = !canTrade();
    half.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      doTrade({ op: 'sell', instId: h.instId, share: 0.5 });
    };
    acts.appendChild(half);
    var all = el('button', 'pf-act strong');
    all.appendChild(el('span', null, 'Продать всё'));
    all.disabled = !canTrade();
    all.onclick = function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      doTrade({ op: 'sell', instId: h.instId, share: 1 });
    };
    acts.appendChild(all);
    row.appendChild(acts);
    return row;
  }

  /* Модальное окно биржи */

  function openExchange() {
    if (!canTrade()) return;
    var st = G.run.state;

    var wrap = el('div', 'modal-wrap exchange-wrap');
    var m = el('div', 'modal exchange');

    var head = el('div', 'ex-head');
    var ht = el('div', 'ex-title');
    ht.appendChild(icon('briefcase'));
    ht.appendChild(el('span', null, 'Биржа'));
    head.appendChild(ht);
    var hm = el('div', 'ex-when', MONTHS_FULL[st.month % 12] + ' · год ' + (1 + Math.floor(st.month / 12)));
    head.appendChild(hm);
    var cash = el('div', 'ex-cash');
    cash.appendChild(el('span', 'ex-cash-lab', 'Свободные деньги'));
    var cashVal = el('strong', 'ex-cash-val', fmt(Math.round(st.cash)));
    cashVal.id = 'ex-cash-val';
    cash.appendChild(cashVal);
    head.appendChild(cash);
    var close = el('button', 'ex-close');
    close.setAttribute('aria-label', 'Закрыть биржу');
    close.appendChild(icon('close'));
    head.appendChild(close);
    m.appendChild(head);

    // Период графиков — общий для всех бумаг, как вкладки на бирже
    var periods = el('div', 'ex-periods');
    periods.setAttribute('role', 'tablist');
    EX_PERIODS.forEach(function (pd) {
      var b = el('button', 'ex-period' + (pd.id === G.exPeriod ? ' on' : ''), pd.label);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', pd.id === G.exPeriod ? 'true' : 'false');
      b.onclick = function () {
        G.exPeriod = pd.id;
        MaxBridge.hapticSelect();
        var all = periods.children;
        for (var i = 0; i < all.length; i++) {
          all[i].classList.toggle('on', all[i] === b);
          all[i].setAttribute('aria-selected', all[i] === b ? 'true' : 'false');
        }
        refreshExchange();
      };
      periods.appendChild(b);
    });
    m.appendChild(periods);

    var scroller = el('div', 'ex-scroll');
    scroller.id = 'ex-scroll';
    m.appendChild(scroller);

    var note = el('div', 'ex-note');
    note.appendChild(icon('alert'));
    note.appendChild(el('span', null,
      'Все бумаги и монеты вымышлены. Комиссия брокера ' +
      ((E.TRADE_FEE || 0.003) * 100).toFixed(1).replace('.0', '') +
      '% берётся и при покупке, и при продаже.'));
    scroller.appendChild(note);

    renderExchangeBody(scroller);

    wrap.appendChild(m);
    var shutDone = false;
    function shut() {
      if (shutDone) return;
      shutDone = true;
      wrap.classList.remove('in');
      lockScroll(false);
      setTimeout(function () { wrap.remove(); }, 220);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    close.onclick = shut;
    wrap.onclick = function (e) { if (e.target === wrap) shut(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    lockScroll(true);
    requestAnimationFrame(function () { wrap.classList.add('in'); });
  }

  function renderExchangeBody(scroller) {
    var st = G.run.state;
    // Всё после заметки пересобирается: после сделки цифры меняются везде.
    var old = document.getElementById('ex-content');
    if (old) old.remove();
    var content = el('div');
    content.id = 'ex-content';

    // Безрисковые деньги — первым делом: это ответ на вопрос «а куда
    // положить, чтобы не потерять», который иначе уводит в покупку бумаг.
    content.appendChild(buildSavingsCard());

    if (st.portfolio && st.portfolio.length) {
      content.appendChild(exSection('Ваши вложения'));
      // Сводка по всему портфелю: одна строка вместо складывания в уме.
      var value = E.portfolioValue(st);
      var cost = st.portfolio.reduce(function (a, h) { return a + h.cost; }, 0);
      var pnl = value - cost;
      var tot = el('div', 'ex-total' + (pnl >= 0 ? ' up' : ' down'));
      tot.appendChild(exCell('Вложено', fmt(Math.round(cost))));
      tot.appendChild(exCell('Стоит сейчас', fmt(Math.round(value))));
      tot.appendChild(exCell(pnl >= 0 ? 'Прибыль на бумаге' : 'Убыток на бумаге',
        (pnl >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(pnl))).replace('−', ''),
        pnl >= 0 ? 'good' : 'bad'));
      tot.appendChild(exCell('Доля от капитала',
        (100 * value / Math.max(1, Math.abs(E.netWorth(st)))).toFixed(0) + '%'));
      content.appendChild(tot);
      var pos = el('div', 'ex-positions');
      st.portfolio.forEach(function (h) { pos.appendChild(buildExPosition(h)); });
      content.appendChild(pos);
    }

    content.appendChild(exSection('Что можно купить'));
    var groups = {};
    var order = [];
    (C.instruments || []).forEach(function (inst) {
      if (!groups[inst.group]) { groups[inst.group] = []; order.push(inst.group); }
      groups[inst.group].push(inst);
    });
    order.forEach(function (g) {
      content.appendChild(el('div', 'ex-group', g));
      groups[g].forEach(function (inst) { content.appendChild(buildExItem(inst)); });
    });

    scroller.appendChild(content);
  }

  function exSection(title) {
    return el('div', 'ex-section', title);
  }

  function refreshExchange() {
    var scroller = document.getElementById('ex-scroll');
    if (scroller) renderExchangeBody(scroller);
    var cv = document.getElementById('ex-cash-val');
    if (cv) cv.textContent = fmt(Math.round(G.run.state.cash));
  }

  function buildExPosition(h) {
    var st = G.run.state;
    var inst = instrumentById(h.instId);
    if (!inst) return el('div');
    var value = E.holdingValue(st, h);
    var pnl = value - h.cost;
    var pct = h.cost > 0 ? pnl / h.cost : 0;
    var avg = h.units > 0 ? h.cost / h.units : 0;

    var row = el('div', 'ex-pos' + (pnl >= 0 ? ' up' : ' down'));
    var top = el('div', 'exp-top');
    top.appendChild(el('span', 'exp-name', inst.name));
    top.appendChild(el('span', 'exp-pct', fmtPct(pct)));
    row.appendChild(top);

    var grid = el('div', 'exp-grid');
    grid.appendChild(exCell('Куплено', fmtUnits(inst, h.units) + ' ' + inst.unit));
    grid.appendChild(exCell('Средняя цена', fmtPrice(avg)));
    grid.appendChild(exCell('Цена сейчас', fmtPrice(instPrice(h.instId))));
    grid.appendChild(exCell('Стоит сейчас', fmt(Math.round(value))));
    grid.appendChild(exCell(pnl >= 0 ? 'Прибыль на бумаге' : 'Убыток на бумаге',
      (pnl >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(pnl))).replace('−', ''), pnl >= 0 ? 'good' : 'bad'));
    row.appendChild(grid);

    if (hintsOn()) {
      row.appendChild(el('div', 'exp-hint',
        pnl >= 0
          ? 'Пока бумага не продана, это не деньги: цена может вернуться назад.'
          : 'Убыток становится настоящим только в момент продажи — но и ждать можно бесконечно.'));
    }

    var acts = el('div', 'exp-acts');
    [['Продать четверть', .25], ['Продать половину', .5], ['Продать всё', 1]].forEach(function (def) {
      var b = el('button', 'ghost-btn small' + (def[1] === 1 ? ' danger' : ''));
      b.appendChild(el('span', null, def[0]));
      b.onclick = function () {
        doTrade({ op: 'sell', instId: h.instId, share: def[1] });
        refreshExchange();
      };
      acts.appendChild(b);
    });
    row.appendChild(acts);
    return row;
  }

  function exCell(lab, val, mod) { return labelValue('div', 'exp-cell', 'span', 'expc-lab', 'expc-val', lab, val, mod); }

  /** Период графика: сколько месяцев показываем. */
  var EX_PERIODS = [
    { id: '6m', label: '6М', months: 6 },
    { id: '1y', label: '1Г', months: 12 },
    { id: '3y', label: '3Г', months: 36 },
    { id: 'all', label: 'Всё', months: 999 }
  ];

  function exPeriod() {
    var p = EX_PERIODS.filter(function (x) { return x.id === G.exPeriod; })[0];
    return p || EX_PERIODS[1];
  }

  function buildExItem(inst) {
    var st = G.run.state;
    var px = instPrice(inst.id);
    var per = exPeriod();
    var back = Math.max(1, Math.min(per.months, st.month));
    var change = st.month > 0 ? instChange(inst.id, back) : 0;
    var up = change >= 0;

    var item = el('div', 'ex-item' + (up ? ' up' : ' down'));

    var head = el('div', 'exi-head');
    var nameWrap = el('div', 'exi-name-wrap');
    nameWrap.appendChild(el('span', 'exi-name', inst.name));
    nameWrap.appendChild(el('span', 'exi-ticker', inst.ticker));
    head.appendChild(nameWrap);
    item.appendChild(head);

    /* Цена крупно и отдельной строкой, а под ней — изменение за период,
       как в биржевом приложении. Раньше цена жила в правом верхнем углу
       мелким текстом: главное число карточки читалось последним. */
    var priceBox = el('div', 'exi-price');
    priceBox.appendChild(el('span', 'exip-val', fmtPrice(px)));
    if (st.month > 0) {
      var was = instPrice(inst.id, Math.max(0, st.month - back));
      var chg = el('span', 'exip-chg ' + (up ? 'up' : 'down'));
      chg.appendChild(icon(up ? 'trend' : 'trendDown'));
      chg.appendChild(el('span', 'exip-pct', fmtPct(change)));
      chg.appendChild(el('span', 'exip-abs',
        (px - was >= 0 ? '+' : '−') + fmtPrice(Math.abs(px - was))));
      chg.appendChild(el('span', 'exip-per', per.label));
      priceBox.appendChild(chg);
    }
    item.appendChild(priceBox);

    item.appendChild(el('div', 'exi-desc', inst.short));

    // Риск показан рядом с ценой, а не спрятан в описании: это второе
    // число, по которому бумаги вообще сравнивают.
    var riskRow = el('div', 'exi-risk r' + (inst.risk || 0));
    riskRow.appendChild(el('span', 'exir-lab', 'Риск'));
    var meter = el('span', 'exir-meter');
    for (var rk = 0; rk < 6; rk++) {
      meter.appendChild(el('i', rk < (inst.risk || 0) ? 'on' : null));
    }
    riskRow.appendChild(meter);
    riskRow.appendChild(el('span', 'exir-val', riskLabel(inst.risk || 0)));
    item.appendChild(riskRow);

    item.appendChild(buildCandleChart(inst.id, back));

    var desc = el('div', 'exi-full', inst.text);
    desc.style.display = 'none';

    var foot = el('div', 'exi-foot');
    var more = el('button', 'exi-more');
    more.appendChild(icon('help'));
    more.appendChild(el('span', null, 'Что это'));
    more.onclick = function () {
      var open = desc.style.display !== 'none';
      desc.style.display = open ? 'none' : 'block';
      more.classList.toggle('on', !open);
    };
    foot.appendChild(more);

    var buyWrap = el('div', 'exi-buy');
    var affordable = st.cash >= (inst.min || 1000);
    var openBtn = el('button', 'primary-btn small');
    openBtn.appendChild(icon('plus'));
    openBtn.appendChild(el('span', null, affordable ? 'Купить' : 'Не хватает денег'));
    openBtn.disabled = !affordable;
    openBtn.onclick = function () {
      buyWrap.innerHTML = '';
      foot.classList.add('open');
      buyWrap.appendChild(buildBuyForm(inst));
      MaxBridge.hapticSelect();
    };
    buyWrap.appendChild(openBtn);
    foot.appendChild(buyWrap);

    item.appendChild(foot);
    item.appendChild(desc);

    return item;
  }

  /** Форма покупки: сумма, что за неё дадут и сколько возьмёт брокер. */
  function buildBuyForm(inst) {
    var st = G.run.state;
    var min = inst.min || 1000;
    var max = Math.floor(st.cash);
    var form = el('div', 'buy-form');

    var amount = Math.min(max, Math.max(min, Math.round(max * 0.25 / 500) * 500));

    var val = el('div', 'bf-val');
    var calc = el('div', 'bf-calc');

    var slider = el('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '500';
    slider.value = String(amount);
    slider.className = 'fc-slider bf-slider';
    slider.setAttribute('aria-label', 'Сумма покупки');

    function render() {
      amount = Math.max(min, Math.min(max, parseFloat(slider.value) || min));
      val.textContent = fmt(amount);
      var fee = Math.round(amount * (E.TRADE_FEE || 0.003));
      var px = instPrice(inst.id);
      var units = px > 0 ? (amount - fee) / px : 0;
      calc.innerHTML = '';
      calc.appendChild(bfRow('Получите', fmtUnits(inst, units) + ' ' + inst.unit));
      calc.appendChild(bfRow('Комиссия брокера', fmt(fee)));
      calc.appendChild(bfRow('Останется наличными', fmt(Math.round(st.cash - amount)),
        st.cash - amount < 0 ? 'bad' : null));
    }
    slider.oninput = function () { render(); MaxBridge.hapticSelect(); };

    var presets = el('div', 'bf-presets');
    [['5 000', 5000], ['10 000', 10000], ['25 000', 25000], ['Четверть', Math.round(max * .25)], ['Половина', Math.round(max * .5)]]
      .forEach(function (def) {
        if (def[1] < min || def[1] > max) return;
        var b = el('button', 'bf-preset');
        b.appendChild(el('span', null, def[0]));
        b.onclick = function () { slider.value = String(def[1]); render(); MaxBridge.hapticSelect(); };
        presets.appendChild(b);
      });

    form.appendChild(el('div', 'bf-lab', 'Сколько вложить'));
    form.appendChild(val);
    form.appendChild(slider);
    var scale = el('div', 'fc-scale');
    scale.appendChild(el('span', null, fmt(min)));
    scale.appendChild(el('span', null, fmt(max)));
    form.appendChild(scale);
    if (presets.children && presets.children.length) form.appendChild(presets);
    form.appendChild(calc);

    var go = el('button', 'primary-btn');
    go.appendChild(el('span', null, 'Купить'));
    go.appendChild(icon('check'));
    go.onclick = function () {
      doTrade({ op: 'buy', instId: inst.id, amount: amount });
      refreshExchange();
    };
    form.appendChild(go);

    var cancel = el('button', 'link-btn', 'Отмена');
    cancel.onclick = function () {
      var wrap = form.parentNode;
      if (!wrap) return;
      wrap.innerHTML = '';
      var again = el('button', 'primary-btn small');
      again.appendChild(icon('plus'));
      again.appendChild(el('span', null, 'Купить'));
      again.onclick = function () { wrap.innerHTML = ''; wrap.appendChild(buildBuyForm(inst)); };
      wrap.appendChild(again);
      if (wrap.parentNode && wrap.parentNode.classList) wrap.parentNode.classList.remove('open');
    };
    form.appendChild(cancel);

    render();
    return form;
  }

  function bfRow(lab, value, mod) { return labelValue('div', 'bf-row', 'span', 'bf-row-lab', 'bf-row-val', lab, value, mod); }

  /** График цены инструмента от начала партии до текущего месяца. */
  /** Подпись на ценовой шкале: без потери точности на узком диапазоне. */
  function axisLabel(v) {
    var a = Math.abs(v);
    if (a >= 100000) return Math.round(v / 1000) + 'к';
    if (a >= 10000) return (v / 1000).toFixed(1).replace('.', ',') + 'к';
    if (a >= 100) return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (a >= 10) return v.toFixed(1).replace('.', ',');
    return v.toFixed(2).replace('.', ',');
  }

  /**
   * Свечной график цены — в том виде, в каком его рисуют биржевые
   * приложения: только свечи на чистом фоне.
   *
   * Что убрано и почему: заливка под линией закрытий и сама эта линия
   * перекрывали свечи и мешали читать тени, а рамка ценовой шкалы
   * съедала ширину. Осталось ровно то, по чему график и читают:
   *  - свечи: зелёная — период закрылся выше открытия, красная — ниже,
   *    тень показывает размах внутри периода;
   *  - редкая пунктирная сетка и цены справа, за пределами поля свечей;
   *  - линия текущей цены с ярлыком её цвета — сразу видно, где «сейчас»;
   *  - время только по краям: начало и конец отрезка;
   *  - наведение: перекрестье, подсветка свечи и подсказка с открытием,
   *    максимумом, минимумом и закрытием.
   */
  function buildCandleChart(instId, back) {
    var st = G.run.state;
    var wrap = el('div', 'exi-chart');
    if (st.month < 1) {
      wrap.appendChild(el('div', 'chart-empty', 'История появится со второго месяца'));
      return wrap;
    }
    var from = Math.max(0, st.month - back);
    var pts = subPrices(instId, from, st.month);
    var candles = toCandles(pts, 40, from);
    if (candles.length < 2) {
      wrap.appendChild(el('div', 'chart-empty', 'Данных пока мало'));
      return wrap;
    }

    var hi = Math.max.apply(null, candles.map(function (c) { return c.h; }));
    var lo = Math.min.apply(null, candles.map(function (c) { return c.l; }));
    if (hi - lo < 1e-9) { hi = lo * 1.02 + 1; lo = lo * 0.98; }
    var pad = (hi - lo) * 0.12;
    hi += pad; lo -= pad;

    var W = 620, H = 210, padR = 62, padB = 22, padT = 10;
    var innerW = W - padR;
    var step = innerW / candles.length;
    var bodyW = Math.max(2.5, Math.min(10, step * 0.6));
    var last = candles[candles.length - 1].c;
    var rising = last >= candles[0].o;

    function X(i) { return step * (i + 0.5); }
    function Y(v) { return padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo)); }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H,
      'class': 'candle-svg' + (rising ? ' up' : ' down'),
      role: 'img',
      'aria-label': 'График цены за выбранный период'
    });

    // Сетка и цены справа
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var v = lo + (hi - lo) * (1 - t);
      var y = Y(v);
      svg.appendChild(svgEl('line', {
        x1: 0, x2: innerW, y1: y.toFixed(1), y2: y.toFixed(1), 'class': 'candle-grid'
      }));
      var tx = svgEl('text', { x: W - 6, y: (y + 3.6).toFixed(1), 'class': 'candle-axis' });
      tx.textContent = axisLabel(v);
      svg.appendChild(tx);
    });

    // Свечи
    candles.forEach(function (c, i) {
      var x = X(i);
      var cls = 'candle ' + (c.c >= c.o ? 'up' : 'down');
      svg.appendChild(svgEl('line', {
        x1: x.toFixed(1), x2: x.toFixed(1),
        y1: Y(c.h).toFixed(1), y2: Y(c.l).toFixed(1),
        'class': cls + ' wick'
      }));
      var top = Y(Math.max(c.o, c.c));
      var bot = Y(Math.min(c.o, c.c));
      svg.appendChild(svgEl('rect', {
        x: (x - bodyW / 2).toFixed(1), y: top.toFixed(1),
        width: bodyW.toFixed(1), height: Math.max(1.4, bot - top).toFixed(1),
        rx: 1,
        'class': cls + ' body'
      }));
    });

    // Время только по краям отрезка
    [[0, 'start'], [candles.length - 1, 'end']].forEach(function (pair) {
      var c = candles[pair[0]];
      var t = svgEl('text', {
        x: pair[1] === 'start' ? 2 : innerW - 2,
        y: (H - 6).toFixed(1),
        'class': 'candle-time', 'text-anchor': pair[1]
      });
      t.textContent = MONTHS_SHORT[c.m % 12] + ' ' + (1 + Math.floor(c.m / 12));
      svg.appendChild(t);
    });

    // Текущая цена: пунктир по всей ширине и ярлык на шкале
    var ly = Y(last);
    svg.appendChild(svgEl('line', {
      x1: 0, x2: innerW, y1: ly.toFixed(1), y2: ly.toFixed(1), 'class': 'candle-last'
    }));
    var pill = svgEl('g', { 'class': 'candle-pill' });
    pill.appendChild(svgEl('rect', {
      x: (innerW + 3).toFixed(1), y: (ly - 8.5).toFixed(1),
      width: (padR - 6).toFixed(1), height: 17, rx: 3
    }));
    var pt = svgEl('text', { x: (W - 6).toFixed(1), y: (ly + 3.6).toFixed(1) });
    pt.textContent = axisLabel(last);
    pill.appendChild(pt);
    svg.appendChild(pill);

    /* Слой наведения */

    var hover = svgEl('g', { 'class': 'candle-hover' });
    var halo = svgEl('rect', { 'class': 'candle-halo', rx: 2 });
    var vline = svgEl('line', { x1: 0, x2: 0, y1: padT - 4, y2: H - padB + 2, 'class': 'candle-vline' });
    hover.appendChild(halo);
    hover.appendChild(vline);
    svg.appendChild(hover);

    wrap.appendChild(svg);

    var tip = el('div', 'cd-tip');
    tip.innerHTML =
      '<div class="cdt-when"></div>' +
      '<div class="cdt-row"><span>Открытие</span><b class="cdt-o"></b></div>' +
      '<div class="cdt-row"><span>Максимум</span><b class="cdt-h"></b></div>' +
      '<div class="cdt-row"><span>Минимум</span><b class="cdt-l"></b></div>' +
      '<div class="cdt-row close"><span>Закрытие</span><b class="cdt-c"></b></div>' +
      '<div class="cdt-delta"></div>';
    wrap.appendChild(tip);

    function candleAt(clientX) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return null;
      var vx = (clientX - box.left) / box.width * W;
      var i = Math.floor(vx / step);
      return Math.max(0, Math.min(candles.length - 1, i));
    }

    function show(i) {
      var c = candles[i];
      var x = X(i);
      vline.setAttribute('x1', x.toFixed(1));
      vline.setAttribute('x2', x.toFixed(1));
      halo.setAttribute('x', (x - bodyW / 2 - 2.5).toFixed(1));
      halo.setAttribute('y', (Y(c.h) - 2.5).toFixed(1));
      halo.setAttribute('width', (bodyW + 5).toFixed(1));
      halo.setAttribute('height', Math.max(5, Y(c.l) - Y(c.h) + 5).toFixed(1));
      wrap.classList.add('live');

      var d = c.o > 0 ? c.c / c.o - 1 : 0;
      tip.querySelector('.cdt-when').textContent =
        MONTHS_FULL[c.m % 12] + ' · год ' + (1 + Math.floor(c.m / 12));
      tip.querySelector('.cdt-o').textContent = fmtPrice(c.o);
      tip.querySelector('.cdt-h').textContent = fmtPrice(c.h);
      tip.querySelector('.cdt-l').textContent = fmtPrice(c.l);
      tip.querySelector('.cdt-c').textContent = fmtPrice(c.c);
      var dl = tip.querySelector('.cdt-delta');
      dl.textContent = 'За период ' + fmtPct(d);
      dl.className = 'cdt-delta ' + (d >= 0 ? 'up' : 'down');

      var rel = x / W;
      tip.style.left = (rel * 100).toFixed(1) + '%';
      tip.classList.toggle('flip', rel > 0.55);
    }

    function hide() { wrap.classList.remove('live'); }

    svg.addEventListener('pointermove', function (e) {
      var i = candleAt(e.clientX);
      if (i != null) show(i);
    });
    svg.addEventListener('pointerdown', function (e) {
      var i = candleAt(e.clientX);
      if (i != null) show(i);
    });
    svg.addEventListener('pointerleave', hide);

    return wrap;
  }

  /*
   *  НАКОПИТЕЛЬНЫЙ СЧЁТ
   *
   *  На месте счёта раньше стоял «вклад» — бумага с нулевым колебанием
   *  цены. Её покупали один раз и получали бесконечный безрисковый доход:
   *  решения после этого ничего не решали. Счёт устроен как банковский и
   *  потому спорит сам с собой: повышенная ставка действует только на
   *  первые несколько сотен тысяч и только в месяц без снятий, а процент
   *  считается по минимальному остатку. Деньги остаются доступными в
   *  любой день — но за эту доступность приходится платить доходностью.
   */

  /** Сколько принесёт такой остаток за полный месяц — для прогноза «дальше». */
  function monthGainOn(balance, rates) {
    var top = Math.min(balance, rates.cap);
    var rest = Math.max(0, balance - top);
    function m(annual) { return Math.pow(1 + annual, 1 / 12) - 1; }
    return top * m(rates.boost) + rest * m(rates.base);
  }

  function buildSavingsCard() {
    var st = G.run.state;
    var acc = st.savings || { balance: 0, minMonth: 0, earned: 0, withdrew: false };
    var rates = E.savingsRates(st);
    var gain = E.savingsMonthGain(st);

    var card = el('section', 'sav-card' + (rates.boosted ? '' : ' plain'));

    var head = el('div', 'sav-head');
    var ttl = el('div', 'sav-title');
    ttl.appendChild(icon('shield'));
    ttl.appendChild(el('span', null, 'Накопительный счёт'));
    head.appendChild(ttl);
    head.appendChild(el('span', 'sav-rate',
      (rates.boost * 100).toFixed(0) + '% на первые ' + fmtShort(rates.cap) +
      ' · ' + (rates.base * 100).toFixed(1).replace('.', ',') + '% дальше'));
    card.appendChild(head);

    var sum = el('div', 'sav-sum');
    sum.appendChild(el('span', 'sav-bal', fmt(Math.round(acc.balance))));
    if (acc.earned > 0) {
      sum.appendChild(el('span', 'sav-earned', 'начислено за партию +' + fmt(Math.round(acc.earned))));
    }
    card.appendChild(sum);

    /* Состояние месяца: за что именно начислят процент и почему столько.
       Три разных случая, и каждый надо назвать своими словами — иначе
       «начислят 0 ₽» на счёте с деньгами выглядит как ошибка. */
    var fresh = acc.balance > 0 && acc.minMonth < acc.balance;
    var text, tone;
    if (!rates.boosted) {
      tone = 'warn';
      text = 'В этом месяце со счёта снимали, поэтому весь месяц пойдёт по базовой ставке: ' +
        'начислят около ' + fmt(gain) + '. С первого числа следующего месяца ставка снова повышенная.';
    } else if (acc.balance <= 0) {
      tone = 'ok';
      text = 'Повышенная ставка действует. Процент начисляется с того месяца, ' +
        'который деньги пролежали на счёте целиком.';
    } else if (fresh) {
      tone = 'ok';
      text = gain > 0
        ? 'За этот месяц начислят около ' + fmt(gain) + ': процент идёт по минимальному остатку, ' +
          'а пополнение середины месяца учтётся со следующего.'
        : 'Деньги легли на счёт в этом месяце, поэтому первый процент придёт по итогам следующего — ' +
          'около ' + fmt(Math.round(monthGainOn(acc.balance, rates))) + '.';
    } else {
      tone = 'ok';
      text = 'Повышенная ставка действует. В конце месяца начислят около ' + fmt(gain) + '.';
    }
    var stat = el('div', 'sav-state ' + tone);
    stat.appendChild(icon(tone === 'ok' ? 'check' : 'alert'));
    stat.appendChild(el('span', null, text));
    card.appendChild(stat);

    if (hintsOn()) {
      card.appendChild(el('div', 'sav-hint',
        'Процент считается по минимальному остатку за месяц: положить в последний день и получить ' +
        'за весь месяц не выйдет. Снять можно когда угодно и без потерь — кроме процента этого месяца.'));
    }

    var acts = el('div', 'sav-acts');
    var slot = el('div', 'sav-form');

    function opener(label, mode, cls, ic) {
      var b = el('button', cls);
      b.appendChild(icon(ic));
      b.appendChild(el('span', null, label));
      b.onclick = function () {
        var same = slot.getAttribute('data-mode') === mode;
        slot.innerHTML = '';
        slot.setAttribute('data-mode', same ? '' : mode);
        if (!same) slot.appendChild(buildSavingsForm(mode));
        MaxBridge.hapticSelect();
      };
      return b;
    }

    var canIn = st.cash >= 1000;
    var addBtn = opener('Пополнить', 'in', 'primary-btn small', 'plus');
    addBtn.disabled = !canIn;
    if (!canIn) addBtn.querySelector('span:last-child').textContent = 'Нечего вносить';
    acts.appendChild(addBtn);

    if (acc.balance >= 1) acts.appendChild(opener('Снять', 'out', 'ghost-btn small', 'minus'));
    card.appendChild(acts);
    card.appendChild(slot);
    return card;
  }

  /** Форма пополнения или снятия. Та же механика, что у формы покупки. */
  function buildSavingsForm(mode) {
    var st = G.run.state;
    var acc = st.savings || { balance: 0 };
    var into = mode === 'in';
    var max = Math.floor(into ? Math.max(0, st.cash) : acc.balance);
    var min = Math.min(1000, max);
    var form = el('div', 'buy-form');
    if (max < 1) {
      form.appendChild(el('div', 'bf-lab', into ? 'Свободных денег нет' : 'На счёте пусто'));
      return form;
    }

    var amount = Math.max(min, Math.round(max * 0.5 / 500) * 500);
    var val = el('div', 'bf-val');
    var calc = el('div', 'bf-calc');

    var slider = el('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = '500';
    slider.value = String(amount);
    slider.className = 'fc-slider bf-slider';
    slider.setAttribute('aria-label', into ? 'Сколько положить' : 'Сколько снять');

    function render() {
      amount = Math.max(min, Math.min(max, parseFloat(slider.value) || min));
      val.textContent = fmt(amount);
      var after = into ? acc.balance + amount : acc.balance - amount;
      calc.innerHTML = '';
      calc.appendChild(bfRow('Останется наличными',
        fmt(Math.round(into ? st.cash - amount : st.cash + amount))));
      calc.appendChild(bfRow('Будет на счёте', fmt(Math.round(after))));
      if (!into) {
        calc.appendChild(bfRow('Ставка этого месяца', 'базовая', 'bad'));
      }
    }
    slider.oninput = function () { render(); MaxBridge.hapticSelect(); };

    var presets = el('div', 'bf-presets');
    [['Четверть', Math.round(max * .25)], ['Половина', Math.round(max * .5)], ['Всё', max]]
      .forEach(function (def) {
        if (def[1] < min || def[1] > max) return;
        var b = el('button', 'bf-preset');
        b.appendChild(el('span', null, def[0]));
        b.onclick = function () { slider.value = String(def[1]); render(); MaxBridge.hapticSelect(); };
        presets.appendChild(b);
      });

    form.appendChild(el('div', 'bf-lab', into ? 'Сколько положить' : 'Сколько снять'));
    form.appendChild(val);
    form.appendChild(slider);
    var scale = el('div', 'fc-scale');
    scale.appendChild(el('span', null, fmt(min)));
    scale.appendChild(el('span', null, fmt(max)));
    form.appendChild(scale);
    form.appendChild(presets);
    form.appendChild(calc);

    var go = el('button', into ? 'primary-btn small' : 'ghost-btn small');
    go.appendChild(el('span', null, into ? 'Положить на счёт' : 'Снять со счёта'));
    go.onclick = function () {
      doTrade({ op: into ? 'saveIn' : 'saveOut', amount: amount });
      refreshExchange();
    };
    form.appendChild(go);

    render();
    return form;
  }

  /* Карта события — центральный компонент игры */

  function showEvent(ev) {
    var idle = document.getElementById('stage-idle');
    if (idle && idle.classList) idle.classList.add('hidden');

    var overlay = el('div', 'sheet-wrap');
    overlay.setAttribute('role', 'presentation');
    var sheet = el('section', 'sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Финансовое решение: ' + ev.title);

    var kindLabel = kindName(ev);

    var head = el('div', 'sheet-head');
    var kindChip = el('span', 'kind kind-' + ev.kind);
    kindChip.appendChild(el('i', 'kind-dot'));
    kindChip.appendChild(el('span', null, kindLabel));
    head.appendChild(kindChip);
    // Межмесячные ситуации отмечены явно: игрок должен понимать, что это
    // не «событие месяца», а то, что просто случилось по дороге.
    if (ev.interstitial) head.appendChild(el('span', 'kind kind-inter', 'между делом'));
    var when = el('span', 'sheet-month');
    when.appendChild(icon('clock'));
    when.appendChild(el('span', null, MONTHS_FULL[ev.month % 12] + ' · год ' + (1 + Math.floor(ev.month / 12))));
    head.appendChild(when);
    sheet.appendChild(head);

    sheet.appendChild(el('h3', 'sheet-title', evalText(ev.title)));
    // Суммы в разных сценариях разные, и текст обязан называть те же числа,
    // которые спишет движок. Подстановку делает evalText.
    sheet.appendChild(el('p', 'sheet-text', evalText(ev.text)));

    // Контекст: с какими деньгами игрок подходит к решению.
    // В «Испытании» его нет — считать своё положение игрок должен сам.
    var st = G.run.state;
    if (hintsOn()) {
      var ctx = el('div', 'sheet-ctx');
      ctx.appendChild(ctxCell('На руках', fmt(st.cash), st.cash < 0 ? 'neg' : ''));
      ctx.appendChild(ctxCell('Резерв', fmt(st.reserve)));
      ctx.appendChild(ctxCell('Свободно в месяц', fmt(freeMonthly(st)), freeMonthly(st) < 0 ? 'neg' : ''));
      var dbt = E.debtBalanceTotal(st);
      if (dbt > 0) ctx.appendChild(ctxCell('Долг', fmt(dbt), 'neg'));
      sheet.appendChild(ctx);
    }

    var body = el('div', 'sheet-body');
    sheet.appendChild(body);

    // Ссылка на открытую карту: после сделки на бирже наличные меняются,
    // и строки стоимости вариантов нужно пересобрать.
    G.openSheet = { ev: ev, body: body, overlay: overlay, stage: 'forecast' };

    overlay.appendChild(sheet);
    var mount = document.getElementById('sheet-mount') || document.getElementById('game-root');
    mount.appendChild(overlay);
    requestAnimationFrame(function () {
      overlay.classList.add('in');
      revealSheet(overlay);
    });
    MaxBridge.haptic(ev.kind === 'shock' || ev.kind === 'scam' ? 'heavy' : 'medium');

    // Сначала прогноз, если он есть у события
    if (ev.forecast) {
      showForecast(ev, body, function () { showChoices(ev, body, overlay); });
    } else {
      showChoices(ev, body, overlay);
    }
  }

  /**
   * Новая карта решения появляется в потоке страницы, а не поверх неё.
   * Чтобы игрок не искал её глазами, страница сама подъезжает к карте —
   * но только если карта не видна целиком и игрок сейчас ничего не листает.
   * Прокрутку не отбираем: колесо в любой момент важнее нашей анимации.
   */
  function revealSheet(overlay) {
    var box = overlay.getBoundingClientRect();
    var hud = document.querySelector('.hud');
    var top = hud ? hud.getBoundingClientRect().height + 12 : 12;
    if (box.top >= top && box.bottom <= window.innerHeight) return;
    var y = window.scrollY + box.top - top;
    window.scrollTo({ top: Math.max(0, y), behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  /** Сколько денег остаётся в месяц после обязательных статей. */
  function freeMonthly(st) {
    return Math.round(st.income - st.mandatory - st.foodBudget -
      E.subsTotal(st) - E.debtPaymentsTotal(st) - st.income * st.livingShare);
  }

  function ctxCell(lab, val, mod) { return labelValue('div', 'sctx', 'span', 'sctx-lab', 'sctx-val', lab, val, mod); }

  function showForecast(ev, body, next) {
    body.innerHTML = '';
    var f = ev.forecast;
    var box = el('div', 'forecast');
    var step = el('div', 'event-step');
    step.appendChild(icon('spark'));
    step.appendChild(el('span', null, 'Сначала оцените ситуацию'));
    box.appendChild(step);
    box.appendChild(el('div', 'fc-q', evalText(f.question)));

    // Границы шкалы могут зависеть от сценария: если сумма кредита
    // пересчитана под доход, то и правильный ответ уезжает вместе с ней,
    // а на старой шкале его просто не выставить.
    var fMax = typeof f.max === 'function' ? f.max(E, G.run.state) : f.max;
    var fStep = typeof f.step === 'function' ? f.step(E, G.run.state) : f.step;

    var val = el('div', 'fc-val');
    var slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(fMax);
    slider.step = String(fStep);
    slider.value = String(Math.round(fMax / 4 / fStep) * fStep);
    slider.className = 'fc-slider';
    slider.setAttribute('aria-label', evalText(f.question));

    function show() {
      val.textContent = f.unit
        ? (parseFloat(slider.value).toFixed(fStep < 1 ? 1 : 0) + f.unit)
        : fmt(parseFloat(slider.value));
    }
    slider.oninput = function () { show(); MaxBridge.hapticSelect(); };
    show();

    box.appendChild(val);
    box.appendChild(slider);
    var scale = el('div', 'fc-scale');
    scale.appendChild(el('span', null, f.unit ? '0' + f.unit : fmt(0)));
    scale.appendChild(el('span', null, f.unit ? fMax + f.unit : fmt(fMax)));
    box.appendChild(scale);

    var btn = el('button', 'primary-btn');
    btn.appendChild(el('span', null, 'Это моя оценка'));
    btn.onclick = function () {
      var guess = parseFloat(slider.value);
      var actual = f.actual(E, G.run.state);
      var err = E.forecastError(guess, actual);
      G.forecastErrors.push(err);
      Store.addForecast(err);
      MaxBridge.hapticNotify(err < 0.2 ? 'success' : 'warning');

      box.innerHTML = '';
      box.classList.add('revealed');
      var res = el('div', 'fc-result');
      var accurate = err < 0.2;
      var badge = el('div', 'fc-badge ' + (accurate ? 'good' : 'off'));
      badge.appendChild(icon(accurate ? 'check' : 'alert'));
      badge.appendChild(el('span', null, accurate ? 'близко' : 'мимо'));
      res.appendChild(badge);
      var cmp = el('div', 'fc-cmp');
      cmp.appendChild(fcRow('Ваша оценка', f.unit ? guess.toFixed(1) + f.unit : fmt(guess), false));
      cmp.appendChild(fcRow('На самом деле', f.unit ? actual.toFixed(1) + f.unit : fmt(actual), true));
      res.appendChild(cmp);
      res.appendChild(el('div', 'fc-reveal', f.reveal(E, G.run.state)));
      box.appendChild(res);

      var go = el('button', 'primary-btn');
      go.appendChild(el('span', null, 'Теперь решаю'));
      go.appendChild(icon('arrow'));
      go.onclick = function () { MaxBridge.haptic('light'); next(); };
      box.appendChild(go);
    };
    box.appendChild(btn);

    var skip = el('button', 'link-btn', 'Пропустить оценку');
    skip.onclick = function () { next(); };
    box.appendChild(skip);

    body.appendChild(box);
  }

  function fcRow(label, value, strong) { return labelValue('div', 'fc-row', 'span', 'fc-row-lab', 'fc-row-val', label, value, strong ? 'strong' : ''); }

  function showChoices(ev, body, overlay) {
    body.innerHTML = '';
    G.openSheet = { ev: ev, body: body, overlay: overlay, stage: 'choices' };

    var step = el('div', 'event-step');
    step.appendChild(icon('dice'));
    step.appendChild(el('span', null, 'Ваше решение'));
    body.appendChild(step);

    var list = el('div', 'choices');
    list.setAttribute('role', 'list');
    /* Показываем только то, что в этом состоянии действительно можно
       сделать: «закрыть часть долга» без долгов и «взять из резерва» при
       пустом резерве были решениями без последствий. Фильтр живёт в
       движке — тот же список видит и разбор «а если бы». */
    E.availableChoices(ev, G.run.state).forEach(function (ch, idx) {
      var b = el('button', 'choice');
      var chLabel = evalText(ch.label);
      var chSub = evalText(ch.sub);
      b.setAttribute('role', 'listitem');
      b.setAttribute('aria-label', 'Вариант ' + (idx + 1) + ': ' + chLabel + (chSub ? '. ' + chSub : ''));

      var lab = el('div', 'choice-label');
      // Горячая цифра: на ПК решения выбираются с клавиатуры.
      lab.appendChild(el('span', 'choice-key', String(idx + 1)));
      lab.appendChild(el('span', 'choice-text', chLabel));
      b.appendChild(lab);

      if (chSub) b.appendChild(el('div', 'choice-sub', chSub));

      // Конкретика денег: сколько это стоит прямо сейчас и что тянет за собой.
      // Показывается на всех уровнях — это цена, а не подсказка.
      var cost = buildCostLine(ch);
      if (cost) b.appendChild(cost);

      var mark = el('span', 'choice-mark');
      mark.appendChild(icon('arrow'));
      b.appendChild(mark);

      b.onclick = function () {
        if (G.animating) return;
        G.animating = true;
        MaxBridge.haptic('rigid');
        b.classList.add('picked');
        // Карта сворачивается и уходит в ленту — решение становится частью истории
        overlay.classList.add('commit');
        setTimeout(function () {
          overlay.remove();
          G.openSheet = null;
          // Замок снимает уже commitChoice — когда следующий ход окажется
          // на экране. Иначе между уходом карточки и появлением следующей
          // остаётся окно, в котором клик попадает в пустоту, а состояние
          // успевает уехать вперёд.
          commitChoice(ev, ch);
        }, 380);
      };
      list.appendChild(b);
    });
    body.appendChild(list);
  }

  function commitChoice(ev, ch) {
    G.choices.push({ eventId: ev.id, choiceId: ch.id });
    recompute();
    var learned = G.run.state.concepts;
    Store.learnAll(learned);
    updateHud();
    buildTimeline();
    buildMonthStrip();
    refreshWallet();
    refreshPortfolio();

    if (G.run.awaiting) {
      // Ход запоминаем сейчас, а не читаем из G в отложенном вызове:
      // за время проматывания ленты игрок мог выйти в меню или начать
      // партию заново, и тогда G.run.awaiting уже пуст.
      var next = G.run.awaiting;
      scrollToMonth(next.month, function () {
        G.animating = false;
        if (G.run && G.run.awaiting === next) showEvent(next);
      });
    } else if (G.run.finished) {
      var idle = document.getElementById('stage-idle');
      if (idle && idle.classList) idle.classList.remove('hidden');
      var finish = G.run.gameOver ? renderGameOver : renderReport;
      scrollToMonth(G.scenario.months - 1, function () {
        setTimeout(function () { G.animating = false; finish(); }, 420);
      });
    } else {
      // Ни следующего хода, ни финала быть не может, но если такое
      // случится — экран не должен остаться запертым.
      G.animating = false;
    }
  }





  /*
   *  КАРТИНКА С ИТОГОМ
   *
   *  То же самое, что игрок видит на экране, только нарисованное на
   *  canvas: карточка итога один в один — шапка партии, балл со шкалой
   *  «из 100», ранг с расшифровкой и лестницей рангов, вывод одной
   *  фразой, четыре числа и условия сценария.
   *
   *  Раньше здесь жила своя, ни на что не похожая вёрстка: другой набор
   *  показателей, другой порядок, другие подписи. Сохранённая картинка
   *  выглядела как результат из другой игры, и сверить её с экраном было
   *  нельзя. Теперь она собирается из тех же данных, что и панель, а
   *  цвета берутся из тех же токенов темы.
   */

  function drawResultCard(data) {
    var W = 1080, PAD = 64;
    var dark = Theme.current() === 'dark';
    var col = {
      bg: dark ? '#0B0B0D' : '#FFF6E8',
      card: dark ? '#17171A' : '#FFFFFF',
      card2: dark ? '#1D1D21' : '#FFF9EF',
      line: dark ? '#F0EADF' : '#1E1710',
      hair: dark ? '#3A3A44' : '#EBDCC2',
      ink: dark ? '#000000' : '#1E1710',
      txt: dark ? '#F7F4EE' : '#241B10',
      txt2: dark ? '#D2CDC4' : '#544737',
      txt3: dark ? '#A09A90' : '#7B6C58',
      txt4: dark ? '#7B766D' : '#9E8F7B',
      acc: dark ? '#FFC21A' : '#2F6BE4',
      accHi: dark ? '#FFD770' : '#1B4CB8',
      accInk: dark ? '#141008' : '#FFFFFF',
      gold: '#F5B72E',
      pos: dark ? '#4ECB8C' : '#0F9A66',
      neg: dark ? '#FF5A4E' : '#E0554A',
      warn: dark ? '#FFC21A' : '#D9930B',
      dot: dark ? 'rgba(255,255,255,.09)' : 'rgba(150,112,52,.14)'
    };
    var FONT = '"Nunito","Segoe UI",system-ui,-apple-system,sans-serif';

    // Измерения делаем на черновом холсте: высоту картинки нельзя задать,
    // пока не известно, во сколько строк ляжет фраза вывода.
    var probe = document.createElement('canvas').getContext('2d');
    if (!probe) return null;
    function setFont(ctx, size, weight) {
      ctx.font = (weight || 800) + ' ' + size + 'px ' + FONT;
    }
    function wrap(ctx, text, size, weight, maxW) {
      setFont(ctx, size, weight);
      var words = String(text || '').split(/\s+/), lines = [], line = '';
      words.forEach(function (w) {
        var next = line ? line + ' ' + w : w;
        if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = w; }
        else line = next;
      });
      if (line) lines.push(line);
      return lines;
    }

    var cardW = W - PAD * 2;
    var innerW = cardW - 96;                    // поля внутри карточки
    /* На экране балл, ранг и фраза вывода стоят в одну строку — там для
       трёх колонок хватает ширины. На картинке шириной 1080 третья колонка
       съеживалась до пары слов, поэтому фраза переехала в свою строку под
       баллом. Порядок чтения тот же: сколько → какой ранг → что это значит. */
    var GRADE_W = 320;
    var sayLines = wrap(probe, data.say, 26, 650, innerW);
    var reqRows = Math.ceil(data.reqs.length / 2);

    var SCORE_H = 206;                          // балл и плита ранга
    var SAY_H = 30 + 30 + sayLines.length * 36;
    var LADDER_H = 62;
    var FACT_H = 122;
    var REQ_H = 68;
    var cardH = 52 + 34 + SCORE_H + SAY_H + 26 + LADDER_H + 30
      + FACT_H * 2 + 20 + REQ_H * reqRows + (reqRows - 1) * 14 + 52;
    var H = 176 + cardH + 168 + 74;

    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    if (!g) return null;
    function font(size, weight) { setFont(g, size, weight); }
    function rrect(x, y, w, h, r) {
      g.beginPath();
      g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r);
      g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r);
      g.arcTo(x, y, x + w, y, r);
      g.closePath();
    }
    /** Плита-«наклейка»: сплошная тень со смещением плюс плотный контур. */
    function sticker(x, y, w, h, r, fill, stroke) {
      g.fillStyle = col.ink;
      rrect(x, y + 9, w, h, r); g.fill();
      g.fillStyle = fill || col.card;
      rrect(x, y, w, h, r); g.fill();
      g.lineWidth = 4; g.strokeStyle = stroke || col.line;
      rrect(x, y, w, h, r); g.stroke();
    }

    // Фон в точку — тот же, что на сайте
    g.fillStyle = col.bg; g.fillRect(0, 0, W, H);
    g.fillStyle = col.dot;
    for (var yy = 24; yy < H; yy += 34) {
      for (var xx = 24; xx < W; xx += 34) { g.beginPath(); g.arc(xx, yy, 2.4, 0, Math.PI * 2); g.fill(); }
    }

    // Шапка: монета и название игры
    g.save();
    g.translate(72, 74);
    g.scale(0.16, 0.16);
    g.fillStyle = col.gold;
    g.beginPath(); g.arc(256, 256, 240, 0, Math.PI * 2); g.fill();
    g.lineWidth = 22; g.strokeStyle = '#2A2012'; g.stroke();
    g.lineWidth = 38; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(178.8, 179.4); g.lineTo(282.1, 179.4);
    g.moveTo(178.8, 179.4); g.lineTo(178.8, 264.7);
    g.moveTo(178.8, 261.4);
    g.bezierCurveTo(264.1, 246.7, 301.8, 281.1, 298.5, 318.8);
    g.bezierCurveTo(295.2, 356.6, 260.8, 381.2, 221.4, 381.2);
    g.bezierCurveTo(193.6, 381.2, 175.5, 369.7, 164, 353.3);
    g.moveTo(318, 222); g.lineTo(392, 130);
    g.moveTo(352, 130); g.lineTo(394, 130); g.lineTo(394, 172);
    g.stroke();
    g.restore();

    g.textBaseline = 'alphabetic';
    g.fillStyle = col.txt; font(34);
    g.fillText('Пять лет спустя', 160, 86);
    g.fillStyle = col.txt3; font(19, 700);
    g.fillText('ФИНАНСОВЫЙ СИМУЛЯТОР', 160, 116);

    /* Карточка итога */
    var cx = PAD, cy = 176, ix = cx + 48;
    sticker(cx, cy, cardW, cardH, 40);

    // Цветная полоса сверху — как на экране
    g.save();
    rrect(cx, cy, cardW, cardH, 40); g.clip();
    g.fillStyle = data.done ? col.pos : col.neg;
    g.fillRect(cx, cy, cardW, 10);
    g.restore();

    var y = cy + 52 + 24;

    // Шапка карточки: партия и уровень
    g.fillStyle = data.done ? col.acc : col.neg; font(19, 800);
    var kick = 'ПЯТЬ ЛЕТ СПУСТЯ';
    g.fillText(kick, ix, y);
    var kw = g.measureText(kick).width;
    g.fillStyle = col.txt2; font(19, 750);
    g.fillText('  ·  ' + data.scenario + (data.level ? '  ·  ' + data.level.toUpperCase() : ''), ix + kw, y);

    // Балл
    y += 46;
    g.fillStyle = col.txt3; font(20, 800);
    g.fillText('ВАШ РЕЗУЛЬТАТ', ix, y);
    y += 118;
    g.fillStyle = data.done ? col.accHi : col.txt; font(140);
    g.fillText(String(data.score), ix, y);
    var sw = g.measureText(String(data.score)).width;
    g.fillStyle = col.txt4; font(30, 750);
    g.fillText('/ 100', ix + sw + 16, y);
    g.fillStyle = col.txt3; font(20, 700);
    g.fillText('ФИНАНСОВАЯ УСТОЙЧИВОСТЬ', ix, y + 40);

    // Плита ранга — у правого края той же строки
    var gw = GRADE_W, gh = 178;
    var gx = ix + innerW - gw;
    var gy = cy + 52 + 52;
    sticker(gx, gy, gw, gh, 26, data.done ? col.card2 : col.card,
      data.done ? col.acc : col.line);
    g.fillStyle = col.txt3; font(18, 800);
    g.fillText('РАНГ', gx + 28, gy + 42);
    g.fillStyle = col.accHi; font(62);
    g.fillText(data.grade, gx + 28, gy + 106);
    g.fillStyle = col.txt3; font(17, 650);
    wrap(g, data.gradeHint, 17, 650, gw - 56).slice(0, 2).forEach(function (ln, i) {
      g.fillText(ln, gx + 28, gy + 138 + i * 22);
    });

    // Вывод одной фразой — отдельной строкой во всю ширину
    var sy = cy + 52 + 34 + SCORE_H;
    g.strokeStyle = col.hair; g.lineWidth = 3;
    g.beginPath(); g.moveTo(ix, sy); g.lineTo(ix + innerW, sy); g.stroke();
    g.fillStyle = col.txt4; font(17, 800);
    g.fillText(String(data.sayLab).toUpperCase(), ix, sy + 34);
    g.fillStyle = col.txt2; font(26, 650);
    sayLines.forEach(function (ln, i) {
      g.fillText(ln, ix, sy + 70 + i * 36);
    });

    // Лестница рангов
    y = cy + 52 + 34 + SCORE_H + SAY_H + 26;
    var cellW = (innerW - 5 * 8) / 6;
    data.grades.forEach(function (gr, i) {
      var x = ix + i * (cellW + 8);
      var on = gr === data.grade;
      g.fillStyle = on ? (data.done ? col.acc : col.warn) : col.card2;
      rrect(x, y, cellW, LADDER_H - 12, 12); g.fill();
      g.lineWidth = 2; g.strokeStyle = on ? (data.done ? col.acc : col.warn) : col.hair;
      rrect(x, y, cellW, LADDER_H - 12, 12); g.stroke();
      g.fillStyle = on ? col.accInk : col.txt4;
      font(20, 800); g.textAlign = 'center';
      g.fillText(gr, x + cellW / 2, y + 34);
      g.textAlign = 'left';
    });

    // Четыре числа
    y += LADDER_H + 30;
    var fw = (innerW - 20) / 2;
    data.facts.slice(0, 4).forEach(function (f, i) {
      var x = ix + (i % 2) * (fw + 20);
      var fy = y + Math.floor(i / 2) * (FACT_H + 8);
      g.fillStyle = col.card2;
      rrect(x, fy, fw, FACT_H - 8, 18); g.fill();
      g.lineWidth = 2; g.strokeStyle = col.hair;
      rrect(x, fy, fw, FACT_H - 8, 18); g.stroke();
      g.fillStyle = col.txt4; font(17, 800);
      g.fillText(String(f[0]).toUpperCase(), x + 26, fy + 42);
      g.fillStyle = f[2] === 'good' ? col.pos : f[2] === 'bad' ? col.neg
        : f[2] === 'warn' ? col.warn : col.txt;
      font(34);
      g.fillText(f[1], x + 26, fy + 88);
    });

    // Условия сценария
    y += FACT_H * 2 + 20;
    data.reqs.forEach(function (r, i) {
      var x = ix + (i % 2) * (fw + 20);
      var ry = y + Math.floor(i / 2) * (REQ_H + 14);
      g.fillStyle = col.card2;
      rrect(x, ry, fw, REQ_H, 14); g.fill();
      g.lineWidth = 2; g.strokeStyle = r[0] ? col.pos : col.hair;
      rrect(x, ry, fw, REQ_H, 14); g.stroke();

      g.fillStyle = r[0] ? col.pos : col.neg;
      g.beginPath(); g.arc(x + 34, ry + REQ_H / 2, 13, 0, Math.PI * 2); g.fill();
      g.strokeStyle = col.card2; g.lineWidth = 3.4;
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      if (r[0]) {
        g.moveTo(x + 28, ry + REQ_H / 2);
        g.lineTo(x + 32.5, ry + REQ_H / 2 + 5);
        g.lineTo(x + 40, ry + REQ_H / 2 - 5.5);
      } else {
        g.moveTo(x + 29.5, ry + REQ_H / 2 - 4.5); g.lineTo(x + 38.5, ry + REQ_H / 2 + 4.5);
        g.moveTo(x + 38.5, ry + REQ_H / 2 - 4.5); g.lineTo(x + 29.5, ry + REQ_H / 2 + 4.5);
      }
      g.stroke();

      g.fillStyle = r[0] ? col.txt2 : col.txt3; font(22, 650);
      var label = wrap(g, r[1], 22, 650, fw - 80)[0] || '';
      g.fillText(label, x + 60, ry + REQ_H / 2 + 8);
    });

    /* Подпись игрока */
    var fy2 = cy + cardH + 34;
    sticker(PAD, fy2, cardW, 118, 28);
    g.fillStyle = col.txt; font(34);
    g.fillText(data.name, PAD + 48, fy2 + 56);
    g.fillStyle = col.txt3; font(20, 700);
    g.fillText(data.sub, PAD + 48, fy2 + 90);

    g.fillStyle = col.txt4; font(20, 700); g.textAlign = 'center';
    g.fillText('обучающая игра о деньгах · все организации вымышлены', W / 2, H - 40);
    g.textAlign = 'left';
    return c;
  }

  /** Сохранить картинку. Если скачивание запрещено — открыть в новой вкладке. */
  function exportResultImage(data, label) {
    var canvas = drawResultCard(data);
    if (!canvas) { Fail.report('Не получилось нарисовать картинку итога'); return; }
    var name = 'пять-лет-спустя-' + data.score + '.png';

    function fallback(url) {
      var win = window.open();
      if (win && win.document) {
        win.document.write('<title>Итог партии</title>' +
          '<body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center">' +
          '<img src="' + url + '" style="max-width:100%;height:auto">');
      } else {
        location.href = url;
      }
    }

    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (!blob) { fallback(canvas.toDataURL('image/png')); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        if ('download' in a) {
          a.href = url; a.download = name;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        } else {
          fallback(url);
        }
        if (label) {
          label.textContent = 'Картинка сохранена';
          setTimeout(function () { label.textContent = 'Картинкой'; }, 2200);
        }
      }, 'image/png');
    } else {
      fallback(canvas.toDataURL('image/png'));
    }
  }

  /*
   *  РАЗБОР ПАРТИИ
   *
   *  Отчёт показывает, что получилось. Разбор объясняет, почему.
   *  Две части: решения, которые стоили дороже всего (движок честно
   *  пересчитывает партию с другим выбором), и советы — они выводятся
   *  из того, что игрок делал, а не из общих слов.
   */

  var MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
                      'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  function whenLabel(month) {
    return 'год ' + (Math.floor(month / 12) + 1) + ' · ' + MONTHS_SHORT[month % 12];
  }

  /** Список решений, отсортированный по цене ошибки. */
  function buildReviewDecisions(list) {
    var box = el('div', 'review-list');
    list.forEach(function (cf, i) {
      var better = cf.delta > 0;          // альтернатива была выгоднее
      var row = el('article', 'review-item' + (better ? ' worse' : ' better'));

      var top = el('div', 'ri-top');
      top.appendChild(el('span', 'ri-num', String(i + 1)));
      var ttl = el('div', 'ri-titles');
      ttl.appendChild(el('div', 'ri-title', evalText(cf.event.title, cf.state)));
      ttl.appendChild(el('div', 'ri-when', whenLabel(cf.month)));
      top.appendChild(ttl);
      var amount = el('div', 'ri-delta');
      amount.appendChild(el('span', 'ri-delta-num',
        (better ? '+' : '') + fmtShort(Math.abs(cf.delta))));
      amount.appendChild(el('span', 'ri-delta-lab', better ? 'можно было получить' : 'вы выиграли'));
      top.appendChild(amount);
      row.appendChild(top);

      var lines = el('div', 'ri-lines');
      var mine = el('div', 'ri-line mine');
      mine.appendChild(el('span', 'ri-lab', 'Вы выбрали'));
      mine.appendChild(el('span', 'ri-val', evalText(cf.chosen.label, cf.state)));
      lines.appendChild(mine);
      var alt = el('div', 'ri-line alt');
      alt.appendChild(el('span', 'ri-lab', better ? 'Лучше было' : 'Хуже было'));
      alt.appendChild(el('span', 'ri-val', evalText(cf.alternative.label, cf.state)));
      lines.appendChild(alt);
      row.appendChild(lines);

      // Тема, к которой это решение относится: её карточку можно открыть
      var conceptId = cf.event.concept || cf.chosen.concept || cf.alternative.concept;
      if (conceptId && C.concepts[conceptId]) {
        var chip = el('button', 'ri-concept');
        chip.appendChild(icon('spark'));
        chip.appendChild(el('span', null, C.concepts[conceptId].title));
        chip.onclick = function () {
          MaxBridge.haptic('light');
          leaveTo(function () { renderLibrary(conceptId); });
        };
        row.appendChild(chip);
      }
      box.appendChild(row);
    });
    return box;
  }

  /**
   * Советы. Каждый — это правило: когда показывать, что сказать и какую
   * карточку знаний открыть. Показываются только сработавшие, сначала
   * самые дорогие.
   */
  function adviceFor(st, evaluation) {
    var stats = st.stats;
    var months = (G.scenario && G.scenario.months) || 60;
    var subsShare = st.flows && st.flows.subs ? st.flows.subs / Math.max(1, st.flows.income) : 0;
    var errAvg = (G.forecastErrors && G.forecastErrors.length)
      ? G.forecastErrors.reduce(function (a, b) { return a + b; }, 0) / G.forecastErrors.length : null;
    var reserve = E.reserveMonths(st);
    var debt = E.debtBalanceTotal(st);
    // Цена долга за пять лет — это тело и проценты вместе.
    var debtCost = (st.flows.debtPaid || 0) + (st.flows.interest || 0) + (st.flows.feesOnDebt || 0);

    var rules = [
      { on: stats.late > 0, weight: 100, concept: 'late',
        title: 'Просрочки: ' + stats.late,
        text: 'Каждая стоила пеней и кредитного рейтинга — по нему банк считает вашу ставку в следующий раз. Если платить нечем, звонить в банк надо до срока платежа, а не после.' },
      { on: stats.scamHit > 0, weight: 95, concept: 'verify',
        title: 'Попались на схему ' + stats.scamHit + ' раз',
        text: 'Общее у всех таких историй одно: решение просили принять срочно и по чужому каналу связи. Правило простое — положить трубку и перезвонить самому по номеру с карты или из приложения.' },
      { on: stats.hungryMonths >= 2 || stats.starvationMonths >= 1, weight: 92, concept: 'cashflow',
        title: 'Были месяцы без денег на еду',
        text: 'Это не про экономию, а про кассовый разрыв: обязательные платежи съели месяц раньше, чем пришёл доход. Такие месяцы лечатся резервом и пересмотром обязательных, а не силой воли.' },
      { on: reserve < 1, weight: 90, concept: 'reserve',
        title: 'Резерв меньше месяца',
        text: 'Любая поломка при таком запасе превращается в долг под проценты. Ориентир — три месяца обязательных расходов; проще всего добираться автопереводом в день зарплаты.' },
      { on: debt > 0 && debtCost > st.flows.income * 0.18, weight: 85, concept: 'avalanche',
        title: 'На долги ушло ' + fmtShort(debtCost),
        text: 'Это пятая часть всего, что вы заработали. Проценты гасятся быстрее всего, если бить по самому дорогому долгу, а не по самому большому или самому неприятному.' },
      { on: subsShare > 0.04, weight: 80, concept: 'subs',
        title: 'Подписки съели ' + fmtShort(st.flows.subs),
        text: 'Ни одно из этих списаний не проходило через ваше решение — именно поэтому они не ощущались. Раз в полгода стоит открывать список подписок и вычёркивать всё, чем не пользовались месяц.' },
      { on: errAvg != null && errAvg > 0.3, weight: 70, concept: 'effrate',
        title: 'Оценки мимо в среднем на ' + Math.round(errAvg * 100) + '%',
        text: 'Переплату и проценты вы недооценивали. Привычка считать «сколько всего заплачу» вместо «какой платёж в месяц» меняет решение о рассрочке чаще, чем любая сила воли.' },
      { on: stats.creditRefused > 0, weight: 68, concept: 'creditscore',
        title: 'Банк отказал ' + stats.creditRefused + ' раз',
        text: 'Рейтинг — это память о ваших платежах. Он растёт медленно, от аккуратных месяцев, и падает быстро, от одной просрочки. Восстанавливать его дороже, чем беречь.' },
      { on: st.energy < 40, weight: 65, concept: 'energy',
        title: 'Финиш на нуле сил (' + Math.round(st.energy) + ')',
        text: 'Силы — такой же ресурс, как деньги: на нуле человек соглашается на первое попавшееся решение и переплачивает. Подработки и вторая смена окупаются, пока не начинают стоить здоровья.' },
      { on: st.quality < 45, weight: 60, concept: 'lifestyle',
        title: 'Качество жизни просело до ' + Math.round(st.quality),
        text: 'Экономия, которая держится только на отказе от всего, обычно заканчивается срывом и крупной покупкой. Дешевле оставить себе небольшую статью «на себя» и не трогать резерв.' },
      { on: stats.gambles >= 3 && stats.badBreaks > stats.luckyBreaks, weight: 55, concept: 'risk',
        title: 'Рискованных ставок: ' + stats.gambles,
        text: 'Часть из них не сыграла — это нормально, так устроен риск. Оценивать решение стоит по тому, что было известно до броска, и по тому, переживёте ли вы худший исход.' },
      { on: (st.portfolio || []).length === 0 && st.assets.length === 0 && st.cash > 200000, weight: 50, concept: 'inflation',
        title: 'Деньги пролежали без движения',
        text: 'Наличные не стоят на месте — их обесценивает инфляция. Это не призыв рисковать: вклад или короткие облигации сохраняют покупательную способность, оставляя деньги доступными.' },
      { on: stats.loansTaken >= 3, weight: 45, concept: 'debtload',
        title: 'Кредитов взято: ' + stats.loansTaken,
        text: 'Каждый новый долг уменьшает свободный остаток и сужает выбор в следующем месяце. Долговая нагрузка выше трети дохода — это уже жизнь на условиях кредитора.' },
      { on: evaluation && evaluation.total && evaluation.met < evaluation.total, weight: 40, concept: null,
        title: 'Цели сценария выполнены не все: ' + evaluation.met + ' из ' + evaluation.total,
        text: 'Условия видны с самого начала — на карточке сценария. Держать их в голове с первого месяца выгоднее, чем вспоминать о них на пятом году.' },
      { on: stats.late === 0 && reserve >= 3 && debt === 0, weight: 20, concept: 'compound', good: true,
        title: 'Пять лет без единого срыва',
        text: 'Ни просрочек, ни долгов, резерв на месте. Дальше работает уже не дисциплина, а время: те же суммы, оставленные в долгую, растут сами.' },
      { on: stats.scamAvoided >= 3 && stats.scamHit === 0, weight: 18, concept: 'scam', good: true,
        title: 'Все схемы распознаны',
        text: 'Вы ни разу не попались, и это не везение: во всех случаях сначала торопили, а потом просили деньги. Этот признак работает и вне игры.' }
    ];

    return rules.filter(function (r) { return r.on; })
      .sort(function (a, b) { return b.weight - a.weight; })
      .slice(0, 6);
  }

  function buildAdvice(list) {
    var box = el('div', 'advice');
    list.forEach(function (a) {
      var card = el('article', 'advice-item' + (a.good ? ' good' : ''));
      var h = el('div', 'ad-head');
      h.appendChild(icon(a.good ? 'check' : 'alert'));
      h.appendChild(el('span', 'ad-title', a.title));
      card.appendChild(h);
      card.appendChild(el('div', 'ad-text', a.text));
      if (a.concept && C.concepts[a.concept]) {
        var chip = el('button', 'ri-concept');
        chip.appendChild(icon('spark'));
        chip.appendChild(el('span', null, C.concepts[a.concept].title));
        chip.onclick = function () {
          MaxBridge.haptic('light');
          leaveTo(function () { renderLibrary(a.concept); });
        };
        card.appendChild(chip);
      }
      box.appendChild(card);
    });
    return box;
  }

  /*
   *  ДОСТИЖЕНИЯ
   *
   *  Каждое достижение — это условие над итогом партии и общим
   *  прогрессом. Проверяются они в одном месте и в один момент:
   *  когда партия закончилась. Секретные до открытия показываются
   *  вопросительным знаком — иначе половина из них перестаёт быть
   *  поводом что-то попробовать.
   */

  var ACHIEVEMENTS = [
    /* --- Обычные: отмечают, что игрок понял правило --- */
    { id: 'finish', title: 'Пять лет спустя', hint: 'Доиграть партию до конца',
      test: function (c) { return c.finished; } },
    { id: 'no-late', title: 'Ни одной просрочки', hint: 'Пройти партию, ни разу не пропустив платёж',
      test: function (c) { return c.finished && c.stats.late === 0; } },
    { id: 'cushion', title: 'Подушка', hint: 'Финишировать с резервом не меньше трёх месяцев',
      test: function (c) { return c.reserveMonths >= 3; } },
    { id: 'debt-free', title: 'Чисто', hint: 'Закончить пять лет без единого долга',
      test: function (c) { return c.finished && c.debt === 0; } },
    { id: 'scam-proof', title: 'Не поддался', hint: 'Распознать три схемы и не попасться ни разу',
      test: function (c) { return c.stats.scamAvoided >= 3 && c.stats.scamHit === 0; } },
    { id: 'investor', title: 'Деньги работают', hint: 'Закончить партию с вложениями на счету',
      test: function (c) { return c.portfolio > 0 || c.st.assets.length > 0; } },
    { id: 'sharp-eye', title: 'Точный глаз', hint: 'Средняя ошибка оценок меньше 15%',
      test: function (c) { return c.forecasts.length >= 3 && c.forecastError < 0.15; } },
    { id: 'all-goals', title: 'Все цели', hint: 'Выполнить все условия сценария',
      test: function (c) { return c.finished && c.met === c.total && c.total > 0; } },
    { id: 'grade-a', title: 'Оценка A', hint: 'Получить высшую оценку за партию',
      test: function (c) { return c.grade === 'A'; } },
    { id: 'collector', title: 'Коллекционер', hint: 'Открыть 20 карточек знаний',
      test: function (c) { return c.concepts >= 20; } },
    { id: 'marathon', title: 'Марафонец', hint: 'Сыграть десять партий',
      test: function (c) { return c.runs >= 10; } },
    { id: 'calm', title: 'Железные нервы', hint: 'Финишировать со спокойствием не ниже 90',
      test: function (c) { return c.st.calm >= 90; } },
    { id: 'cup-run', title: 'Соревнующийся', hint: 'Доиграть соревновательный сценарий',
      test: function (c) { return c.finished && c.cup; } },
    { id: 'balanced', title: 'Всё по местам', hint: 'Финиш: спокойствие, качество и силы не ниже 60',
      test: function (c) { return c.st.calm >= 60 && c.st.quality >= 60 && c.st.energy >= 60; } },

    /* --- Сложные: требуют разыгрывать партию, а не просто дожить --- */
    { id: 'millionaire', title: 'Миллион', hard: true, hint: 'Финишировать с капиталом от 2 000 000 ₽',
      test: function (c) { return c.netWorth >= 2000000; } },
    { id: 'iron-budget', title: 'Железный бюджет', hard: true,
      hint: 'Ни одного месяца в минусе и ни одной просрочки',
      test: function (c) { return c.finished && c.stats.monthsNegative === 0 && c.stats.late === 0; } },
    { id: 'champion', title: 'Чемпион', hard: true, hint: 'Балл 90 и выше в соревновании',
      test: function (c) { return c.cup && c.score >= 90; } },
    { id: 'hell-pass', title: 'Адский зачёт', hard: true,
      hint: 'Выполнить все цели на уровне «Адская жизнь»',
      test: function (c) { return c.level === 4 && c.met === c.total && c.total > 0; } },
    { id: 'grandmaster', title: 'Гроссмейстер', hard: true,
      hint: 'Доиграть хотя бы по одной партии на каждом из пяти уровней',
      test: function (c) {
        var seen = {};
        c.runsList.forEach(function (r) { if (r.level) seen[r.level] = true; });
        return [1, 2, 3, 4, 5].every(function (l) { return seen[l]; });
      } },
    { id: 'librarian', title: 'Библиотекарь', hard: true, hint: 'Открыть все карточки знаний',
      test: function (c) { return c.concepts >= c.conceptsTotal; } },
    { id: 'perfect', title: 'Безупречно', hard: true, hint: 'Балл 95 и выше в любой партии',
      test: function (c) { return c.score >= 95; } },

    /* --- Секретные: про них нигде не написано --- */
    { id: 'ascetic', title: 'Аскет', secret: true,
      hint: 'За пять лет не потратить на удовольствия ни рубля',
      test: function (c) { return c.finished && (c.st.flows.fun || 0) === 0; } },
    { id: 'banker', title: 'Любимец банка', secret: true,
      hint: 'Довести кредитный рейтинг до 800',
      test: function (c) { return c.st.creditScore >= 800; } },
    { id: 'own-money', title: 'Только свои', secret: true,
      hint: 'Пройти партию, ни разу не взяв кредит',
      test: function (c) { return c.finished && c.stats.loansTaken === 0; } },
    { id: 'heir', title: 'Наследник', secret: true,
      hint: 'В соревновании принять наследство и закрыть чужой долг полностью',
      test: function (c) {
        if (!c.cup || !c.finished) return false;
        if (!c.st.flags.flat || c.st.flags.flat === 'no') return false;
        var heir = c.st.debts.filter(function (d) { return d.id === 'heir'; })[0];
        return !heir || heir.balance <= 0;
      } },
    { id: 'lucky', title: 'Везунчик', secret: true,
      hint: 'Пять удачных исходов подряд не бывает — а у вас было',
      test: function (c) { return c.stats.luckyBreaks >= 5 && c.stats.badBreaks === 0; } },
    { id: 'sprinter', title: 'Пять лет за полчаса', secret: true,
      hint: 'Доиграть партию меньше чем за тридцать минут',
      test: function (c) { return c.finished && c.elapsed > 0 && c.elapsed < 30 * 60 * 1000; } },
    { id: 'no-loss', title: 'Ни шагу назад', secret: true,
      hint: 'Закончить каждый из пяти лет с капиталом больше, чем начали год',
      test: function (c) {
        if (!c.finished || !c.history || c.history.length < 60) return false;
        for (var y = 0; y < 5; y++) {
          var a = y === 0 ? 0 : c.history[y * 12 - 1].netWorth;
          var b = c.history[Math.min(c.history.length - 1, (y + 1) * 12 - 1)].netWorth;
          if (b <= a) return false;
        }
        return true;
      } }
  ];

  var Achievements = (function () {
    function have() { return Store.data.achievements || (Store.data.achievements = []); }

    /** Собрать всё, что нужно условиям, в один объект. */
    function context(extra) {
      var st = extra.state;
      var d = Store.data;
      return {
        st: st,
        stats: st.stats,
        finished: !!extra.finished,
        cup: !!(G.scenario && G.scenario.cup),
        level: G.scenario ? G.scenario.level : 0,
        score: extra.score || 0,
        grade: extra.grade || '',
        met: extra.met || 0,
        total: extra.total || 0,
        netWorth: E.netWorth(st),
        debt: E.debtBalanceTotal(st),
        reserveMonths: E.reserveMonths(st),
        portfolio: E.portfolioValue ? E.portfolioValue(st) : 0,
        history: extra.history || [],
        forecasts: G.forecastErrors || [],
        forecastError: (G.forecastErrors && G.forecastErrors.length)
          ? G.forecastErrors.reduce(function (a, b) { return a + b; }, 0) / G.forecastErrors.length
          : 1,
        concepts: d.concepts.length,
        conceptsTotal: Object.keys(C.concepts).length,
        runs: d.runs.length,
        runsList: d.runs,
        elapsed: G.startedAt ? Date.now() - G.startedAt : 0
      };
    }

    return {
      all: function () { return ACHIEVEMENTS; },
      unlocked: function () { return have().slice(); },
      has: function (id) { return have().indexOf(id) !== -1; },
      /** Проверить всё и вернуть только что открытые. */
      check: function (extra) {
        var ctx = context(extra);
        var got = have(), fresh = [];
        ACHIEVEMENTS.forEach(function (a) {
          if (got.indexOf(a.id) !== -1) return;
          var ok = false;
          try { ok = !!a.test(ctx); }
          catch (e) { Fail.report('Достижение «' + a.title + '» не проверилось', e); }
          if (ok) { got.push(a.id); fresh.push(a); }
        });
        if (fresh.length) Store.save();
        return fresh;
      }
    };
  })();


  /** Карточка достижения. Секретные до открытия не раскрываются. */
  function achCard(a, unlocked) {
    var secret = a.secret && !unlocked;
    var card = el('article', 'ach' + (unlocked ? ' on' : '') +
      (a.hard ? ' hard' : '') + (a.secret ? ' secret' : ''));

    var mark = el('div', 'ach-mark');
    mark.appendChild(icon(unlocked ? 'check' : secret ? 'help' : 'lock'));
    card.appendChild(mark);

    var body = el('div', 'ach-body');
    body.appendChild(el('div', 'ach-title', secret ? 'Секретное достижение' : a.title));
    body.appendChild(el('div', 'ach-hint', secret
      ? 'Условие держится в тайне. Открывается само, когда случится.'
      : a.hint));
    card.appendChild(body);

    if (a.hard) card.appendChild(el('span', 'ach-tag', 'сложное'));
    else if (a.secret) card.appendChild(el('span', 'ach-tag secret', 'секретное'));
    return card;
  }

  /* ЭКРАН: достижения */

  function renderAchievements() {
    G.screen = 'achievements';
    MaxBridge.backButton(true, goBack);
    root.innerHTML = '';
    var w = el('div', 'screen ach-screen');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');
    wrap.appendChild(header('Достижения',
      'Открываются сами по итогам партии. Сложные требуют играть точно, секретные — просто попробовать что-то необычное'));

    var all = Achievements.all();
    var got = Achievements.unlocked();
    var open = all.filter(function (a) { return got.indexOf(a.id) !== -1; }).length;

    var counter = el('div', 'lib-counter');
    counter.appendChild(el('span', 'lc-num', open + ' / ' + all.length));
    counter.appendChild(el('span', 'lc-lab', 'открыто'));
    var track = el('div', 'lc-track');
    var fill = el('i');
    fill.style.width = (100 * open / all.length).toFixed(1) + '%';
    track.appendChild(fill);
    counter.appendChild(track);
    wrap.appendChild(counter);

    [['Обычные', function (a) { return !a.hard && !a.secret; }],
     ['Сложные', function (a) { return a.hard; }],
     ['Секретные', function (a) { return a.secret; }]].forEach(function (group) {
      var list = all.filter(group[1]);
      if (!list.length) return;
      var mine = list.filter(function (a) { return got.indexOf(a.id) !== -1; }).length;
      wrap.appendChild(el('div', 'section-label', group[0] + ' · ' + mine + ' из ' + list.length));
      var grid = el('div', 'ach-grid');
      list.forEach(function (a) { grid.appendChild(achCard(a, got.indexOf(a.id) !== -1)); });
      wrap.appendChild(grid);
    });

    wrap.appendChild(backBtn());
    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  /*
   *  ЭКРАН: ИСТОРИЯ ПАРТИЙ
   *
   *  Список доигранных партий, свежие сверху. У последних двадцати
   *  сохранены seed и решения — их итог открывается целиком, вместе с
   *  графиком и разбором. У остальных остаётся строка: чем закончилось
   *  и когда. Так экран итогов перестал быть одноразовым.
   */

  function scenarioById(id) {
    for (var i = 0; i < C.scenarios.length; i++) {
      if (C.scenarios[i].id === id) return C.scenarios[i];
    }
    return null;
  }

  function renderHistory() {
    G.screen = 'history';
    G.replay = null;
    MaxBridge.backButton(true, renderMenu);
    root.innerHTML = '';
    var w = el('div', 'screen history-screen');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');
    wrap.appendChild(header('История партий',
      'Все партии, доигранные до конца. У недавних открывается полный итог — с графиком, разбором и советами'));

    var runs = Store.recentRuns();
    if (!runs.length) {
      var empty = el('div', 'hist-empty');
      empty.appendChild(el('div', 'he-title', 'Пока пусто'));
      empty.appendChild(el('div', 'he-text',
        'Первая доигранная партия появится здесь сразу после экрана итогов.'));
      wrap.appendChild(empty);
      wrap.appendChild(backBtn('В меню'));
      w.appendChild(wrap);
      root.appendChild(w);
      resetScroll();
      return;
    }

    var best = runs.reduce(function (a, r) { return Math.max(a, r.score || 0); }, 0);
    var figs = el('div', 'po-figs hist-figs');
    figs.appendChild(poFig(String(runs.length), 'партий доиграно'));
    figs.appendChild(el('i', 'po-div'));
    figs.appendChild(poFig(String(best), 'лучший балл'));
    figs.appendChild(el('i', 'po-div'));
    figs.appendChild(poFig(
      String(runs.filter(function (r) { return r.goal; }).length), 'целей выполнено'));
    wrap.appendChild(figs);

    var list = el('div', 'hist-list');
    runs.forEach(function (r) {
      var sc = scenarioById(r.scenarioId);
      var full = !!(r.choices && r.seed != null && sc);
      var row = el(full ? 'button' : 'div', 'hist-row' + (full ? ' open' : '') +
        (r.goal ? ' done' : ''));

      var when = el('div', 'hr-when');
      when.appendChild(el('span', 'hr-date', fmtDate(r.at)));
      when.appendChild(el('span', 'hr-grade', r.grade || '—'));
      row.appendChild(when);

      var mid = el('div', 'hr-mid');
      mid.appendChild(el('div', 'hr-title', r.title || (sc && sc.title) || 'Партия'));
      var meta = el('div', 'hr-meta');
      meta.appendChild(el('span', null, 'Капитал ' + fmtShort(r.netWorth)));
      meta.appendChild(el('span', null, 'Балл ' + (r.score || 0)));
      meta.appendChild(el('span', null, r.goal ? 'цель выполнена' : 'цель не выполнена'));
      mid.appendChild(meta);
      row.appendChild(mid);

      if (full) {
        var go = el('span', 'hr-go');
        go.appendChild(el('span', null, 'Итоги'));
        go.appendChild(icon('arrow'));
        row.appendChild(go);
        row.onclick = function () { MaxBridge.haptic('light'); renderReport(r); };
      } else {
        row.appendChild(el('span', 'hr-old', 'запись без разбора'));
      }
      list.appendChild(row);
    });
    wrap.appendChild(list);

    wrap.appendChild(backBtn('В меню'));
    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  /* ЭКРАН: таблица лидеров */

  function fmtDate(ts) {
    var d = new Date(ts);
    function two(n) { return (n < 10 ? '0' : '') + n; }
    return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
  }

  function cupScenario() {
    for (var i = 0; i < C.scenarios.length; i++) if (C.scenarios[i].cup) return C.scenarios[i];
    return null;
  }

  function renderLeaders(tab) {
    G.screen = 'leaders';
    G.leadersTab = tab || G.leadersTab || 'cup';
    MaxBridge.backButton(true, goBack);
    root.innerHTML = '';
    var w = el('div', 'screen leaders-screen');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');
    wrap.appendChild(header('Таблица лидеров',
      'Партии, доигранные до конца. Соревнование сравнивать честно: сценарий и все случайности в нём у всех одинаковые'));

    var me = Leaders.me();

    /* --- Переключатель: соревнование или вообще всё --- */
    var tabs = el('div', 'sc-filters');
    [['cup', 'Соревнование'], ['all', 'Все партии']].forEach(function (t) {
      var b = el('button', 'sc-filter' + (G.leadersTab === t[0] ? ' on' : ''));
      b.appendChild(el('span', null, t[1]));
      var n = Leaders.list({ cupOnly: t[0] === 'cup' }).length;
      b.appendChild(el('span', 'scf-num', String(n)));
      b.onclick = function () { MaxBridge.hapticSelect(); renderLeaders(t[0]); };
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    var rows = Leaders.list({ cupOnly: G.leadersTab === 'cup', limit: 50 });

    if (!rows.length) {
      var empty = el('div', 'leaders-empty');
      empty.appendChild(icon('flag'));
      var et = el('div', null);
      et.appendChild(el('div', 'le-title', G.leadersTab === 'cup'
        ? 'Соревнование ещё никто не проходил'
        : 'Здесь появятся доигранные партии'));
      et.appendChild(el('div', 'le-sub', G.leadersTab === 'cup'
        ? 'Уровень «Соревнование» в меню: один сценарий, одинаковый для всех.'
        : 'Партия попадает в таблицу, когда прожиты все шестьдесят месяцев.'));
      empty.appendChild(et);
      wrap.appendChild(empty);
    } else {
      var table = el('div', 'leaders');
      var head = el('div', 'lead-row lead-head');
      ['#', 'Игрок', 'Балл', 'Капитал', 'Цели', 'Дата'].forEach(function (t, i) {
        head.appendChild(el('span', 'lead-c c' + i, t));
      });
      table.appendChild(head);

      rows.forEach(function (r, i) {
        var mine = r.playerId === me.id;
        var row = el('div', 'lead-row' + (mine ? ' mine' : '') + (i < 3 ? ' top top-' + (i + 1) : ''));
        row.appendChild(el('span', 'lead-c c0 lead-place', String(i + 1)));

        var who = el('span', 'lead-c c1 lead-who');
        who.appendChild(el('span', 'lw-name', r.name || 'Аноним'));
        who.appendChild(el('span', 'lw-sub', G.leadersTab === 'cup'
          ? ('оценка ' + (r.grade || '—'))
          : (r.title || 'сценарий')));
        row.appendChild(who);

        row.appendChild(el('span', 'lead-c c2 lead-score', String(r.score)));
        row.appendChild(el('span', 'lead-c c3', fmtShort(r.netWorth)));
        row.appendChild(el('span', 'lead-c c4', (r.met != null ? r.met + '/' + r.total : '—')));
        row.appendChild(el('span', 'lead-c c5', fmtDate(r.at)));
        table.appendChild(row);
      });
      wrap.appendChild(table);
    }

    /* --- Как вас подписывать --- */
    if (!me.external) {
      var nameBox = el('section', 'lead-name');
      nameBox.appendChild(el('div', 'section-label', 'Ваше имя в таблице'));
      var line = el('div', 'ln-line');
      var input = el('input', 'ln-input');
      input.setAttribute('type', 'text');
      input.setAttribute('maxlength', '24');
      input.setAttribute('placeholder', 'Как вас записывать');
      input.value = me.name || '';
      var save = el('button', 'ghost-btn small');
      save.appendChild(el('span', null, 'Сохранить'));
      save.onclick = function () {
        var v = Leaders.setName(input.value);
        MaxBridge.haptic('light');
        // Уже записанные партии этого устройства подписываются задним числом:
        // иначе первый результат навсегда остался бы «Анонимом».
        Leaders.list({}).forEach(function (r) {
          if (r.playerId === 'device') Leaders.rename(r.id, v || 'Аноним');
        });
        renderLeaders(G.leadersTab);
      };
      line.appendChild(input);
      line.appendChild(save);
      nameBox.appendChild(line);
      nameBox.appendChild(el('div', 'ln-hint',
        'Пока таблица живёт в этом браузере. Когда игра подключится к общей базе и профилю MAX, имя и место возьмутся оттуда.'));
      wrap.appendChild(nameBox);
    }

    var back = el('button', 'ghost-btn');
    back.appendChild(icon('back'));
    back.appendChild(el('span', null, 'Назад'));
    back.onclick = function () { MaxBridge.haptic('light'); renderMenu(); };
    var acts = el('div', 'actions');
    acts.appendChild(back);
    var cup = cupScenario();
    if (cup) {
      var go = el('button', 'primary-btn');
      go.appendChild(el('span', null, 'Играть соревнование'));
      go.appendChild(icon('arrow'));
      go.onclick = function () { MaxBridge.haptic('medium'); startScenario(cup); };
      acts.appendChild(go);
    }
    wrap.appendChild(acts);

    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  /* ЭКРАН: проигрыш */

  function renderGameOver() {
    G.screen = 'gameover';
    MaxBridge.backButton(true, renderMenu);
    var st = G.run.state;

    root.innerHTML = '';
    var w = el('div', 'screen report');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');

    var verdict = el('div', 'verdict miss');
    verdict.appendChild(el('div', 'verdict-kicker', 'Игра окончена'));
    verdict.appendChild(el('div', 'verdict-num', 'Пять лет не сложились'));
    verdict.appendChild(el('div', 'verdict-lab', st.gameOverReason || 'Условия жизни стали невыносимыми'));
    wrap.appendChild(verdict);

    MaxBridge.hapticNotify('error');

    wrap.appendChild(el('div', 'section-label', 'Что пошло не так'));
    var reasons = el('div', 'requirements');
    /* Проверяем ровно те условия, по которым движок заканчивает партию.
       Раньше голодные месяцы здесь не проверялись, и при этом финале блок
       «Что пошло не так» оставался пустым — заголовок был, строк не было. */
    var shown = 0;
    function reason(cond, text) {
      if (!cond) return;
      reasons.appendChild(reqRow(false, text));
      shown++;
    }
    reason(st.quality <= 5, 'Качество жизни: ' + Math.round(st.quality) + ' / 100');
    reason(st.calm <= 5, 'Спокойствие: ' + Math.round(st.calm) + ' / 100');
    reason(st.stats.hungryMonths >= 3,
      'Не хватало на еду ' + st.stats.hungryMonths + ' ' + plural(st.stats.hungryMonths, 'месяц', 'месяца', 'месяцев') + ' подряд');
    reason(st.stats.starvationMonths >= 2,
      'Не хватало на обязательные платежи ' + st.stats.starvationMonths + ' '
      + plural(st.stats.starvationMonths, 'месяц', 'месяца', 'месяцев') + ' подряд');
    // Подстраховка: причина всегда должна быть названа хотя бы одной строкой.
    if (!shown) reasons.appendChild(reqRow(false, st.gameOverReason || 'Условия жизни стали невыносимыми'));
    wrap.appendChild(reasons);

    // Показатели на момент проигрыша
    wrap.appendChild(el('div', 'section-label', 'Состояние на момент проигрыша'));
    var grid = el('div', 'kpi-grid');
    grid.appendChild(kpi('Наличные', fmt(st.cash), st.cash >= 0));
    grid.appendChild(kpi('Резерв', fmt(st.reserve), st.reserve >= 0));
    grid.appendChild(kpi('Спокойствие', Math.round(st.calm) + ' / 100', st.calm >= 55));
    grid.appendChild(kpi('Качество жизни', Math.round(st.quality) + ' / 100', st.quality >= 55));
    grid.appendChild(kpi('Силы', Math.round(st.energy) + ' / 100', st.energy >= 35));
    grid.appendChild(kpi('Долги', fmtShort(E.debtBalanceTotal(st)), E.debtBalanceTotal(st) === 0));
    grid.appendChild(kpi('Кредитный рейтинг',
      Math.round(st.creditScore) + ' · ' + E.creditTier(st.creditScore).label,
      st.creditScore >= 660));
    wrap.appendChild(grid);

    var actions = el('div', 'actions');
    var again = el('button', 'primary-btn');
    again.appendChild(icon('refresh'));
    again.appendChild(el('span', null, 'Попробовать снова'));
    again.onclick = function () { MaxBridge.haptic('medium'); startScenario(G.scenario); };
    actions.appendChild(again);

    var other = el('button', 'ghost-btn');
    other.appendChild(icon('layers'));
    other.appendChild(el('span', null, 'Другой сценарий'));
    other.onclick = function () { MaxBridge.haptic('light'); renderMenu(); };
    actions.appendChild(other);
    wrap.appendChild(actions);

    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  function reqRow(done, label) {
    var row = el('div', 'requirement ' + (done ? 'done' : 'miss'));
    var mark = el('span', 'req-mark');
    mark.appendChild(icon(done ? 'check' : 'close'));
    row.appendChild(mark);
    row.appendChild(el('span', 'req-label', label));
    return row;
  }

  /* ЭКРАН: итог пяти лет */

  /**
   * Итоговый балл 0–100 — только представление. Складывается из выполненных
   * условий сценария (главное) и того, в каком состоянии игрок пришёл к финалу.
   * Движок этот балл не использует: он не влияет ни на что, кроме экрана итога.
   */
  /** Лестница рангов и что каждый значит. Порядок — снизу вверх. */
  var GRADES = ['D', 'C', 'B', 'B+', 'A', 'S'];
  var GRADE_HINT = {
    D: 'ни одно условие не выполнено',
    C: 'выполнена меньше половины условий',
    B: 'выполнена часть условий',
    'B+': 'все условия выполнены',
    A: 'все условия и жизнь в порядке',
    S: 'всё до единого, без единого срыва'
  };

  /**
   * Вывод партии одной фразой.
   *
   * Собирается из того же, по чему считался балл: выполненные условия,
   * запас прочности, аккуратность с платежами и то, во что превратился
   * стартовый капитал. Никаких оценок вроде «отлично» — только факты,
   * из которых оценка следует сама.
   */
  function verdictLine(st, evaluation, nw, startNW) {
    var parts = [];
    var months = E.reserveMonths(st);
    var late = st.stats.late;
    var grew = startNW > 0 && nw > startNW ? nw / startNW : 0;

    if (!evaluation.done) {
      var missed = evaluation.requirements.filter(function (r) { return !r.done; });
      parts.push('не выполнено: ' + missed.map(function (r) {
        return String(r.label).toLowerCase();
      }).slice(0, 2).join(', '));
    }

    parts.push(months >= 3
      ? 'резерв на ' + months.toFixed(months >= 10 ? 0 : 1) + ' мес расходов'
      : months >= 1 ? 'резерва хватит на ' + months.toFixed(1) + ' мес'
      : 'подушки на чёрный день так и не появилось');

    parts.push(late === 0 ? 'ни одной просрочки'
      : 'просрочек: ' + late + (late > 3 ? ' — это и есть цена ставки по кредитам' : ''));

    if (grew >= 2) {
      var times = grew.toFixed(grew >= 10 ? 0 : 1);
      // «в 76 раза» — режет глаз. Дробное число всегда «раза», целое
      // склоняется по последней цифре, кроме второго десятка.
      var whole = times.indexOf('.') === -1 ? parseInt(times, 10) : null;
      var word = 'раза';
      if (whole != null) {
        var t2 = whole % 100, t1 = whole % 10;
        word = (t2 >= 11 && t2 <= 14) ? 'раз'
          : t1 === 1 ? 'раз' : (t1 >= 2 && t1 <= 4) ? 'раза' : 'раз';
      }
      parts.push('капитал вырос в ' + times + ' ' + word);
    }
    else if (nw < 0) parts.push('на финише вы в минусе');

    var text = parts.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  }

  /** Одно число итога: подпись сверху, значение снизу. */
  function vFact(label, value, tone) { return labelValue('div', 'vfact', 'span', 'vf-lab', 'vf-val', label, value, tone); }

  function resultScore(st, evaluation) {
    var goals = evaluation.total ? evaluation.met / evaluation.total : 0;
    var life = (clamp(st.calm, 0, 100) + clamp(st.quality, 0, 100) + clamp(st.energy, 0, 100)) / 300;
    var reserve = clamp(E.reserveMonths(st) / 3, 0, 1);
    return Math.round(clamp(100 * (goals * 0.55 + life * 0.28 + reserve * 0.17), 0, 100));
  }

  /**
   * Экран итогов.
   *
   * replay — сохранённая партия из истории. Тогда экран собирается заново
   * из seed и списка решений, но НИЧЕГО не записывает: результат уже был
   * засчитан в тот раз. Раньше запись шла прямо в начале функции, поэтому
   * повторный показ итогов удваивал бы партию в статистике и в таблице
   * лидеров — и именно поэтому вернуться на этот экран было нельзя.
   */
  function renderReport(replay) {
    G.screen = 'report';
    if (replay) {
      G.scenario = scenarioById(replay.scenarioId) || G.scenario;
      G.seed = replay.seed;
      G.choices = (replay.choices || []).map(function (c) { return c; });
      recompute();
    }
    // Возврат ведёт туда, откуда пришли: из истории — в историю, из
    // партии — в меню.
    var home = replay ? function () { renderHistory(); } : renderMenu;
    MaxBridge.backButton(true, home);
    var reopen = function () { renderReport(replay); };
    G.replay = replay || null;
    var st = G.run.state;
    var nw = E.netWorth(st);
    var evaluation = E.evaluate(G.built, st);

    var score = resultScore(st, evaluation);
    /* Рекорд по сценарию читаем ДО записи партии: addRun ниже сам обновит
       его текущим результатом, и после записи «прошлый рекорд» всегда
       равнялся бы сегодняшнему. */
    var bestBefore = Store.data.best[G.scenario.id];
    var who = Leaders.me();
    var entry;

    if (replay) {
      // Повтор: ничего не записываем, строку в таблице ищем по её id.
      entry = Leaders.list({}).filter(function (r) { return r.id === replay.entryId; })[0]
        || { id: replay.entryId, name: replay.name || who.name || 'Аноним' };
    } else {
      var stamp = Date.now();
      var entryId = 'r' + stamp + '-' + Math.floor(Math.random() * 1e6).toString(36);

      Store.addRun({
        scenarioId: G.scenario.id,
        title: G.scenario.title,
        netWorth: Math.round(nw),
        calm: Math.round(st.calm),
        quality: Math.round(st.quality),
        energy: Math.round(st.energy),
        score: score,
        level: G.scenario.level,
        grade: evaluation.grade,
        goal: evaluation.done,
        at: stamp,
        // Партия целиком: по seed и решениям экран собирается заново.
        seed: G.seed,
        choices: G.choices.slice(),
        entryId: entryId
      });

      /* Партия дошла до конца — значит, ей есть место в таблице.
         Запись уходит сразу, чтобы результат не потерялся, а подписать
         её именем можно прямо на этом экране. */
      entry = Leaders.submit({
        id: entryId,
        playerId: who.id,
        name: who.name || 'Аноним',
        scenarioId: G.scenario.id,
        title: G.scenario.title,
        level: G.scenario.level,
        cup: !!G.scenario.cup,
        score: score,
        netWorth: Math.round(nw),
        grade: evaluation.grade,
        met: evaluation.met,
        total: evaluation.total,
        at: stamp
      });
    }

    root.innerHTML = '';
    var w = el('div', 'screen report');
    w.appendChild(buildAppbar());
    var wrap = el('div', 'menu-wrap');

    /*
     * Финальный экран истории
     *       Одна карточка вместо трёх разрозненных блоков. Раньше балл, ранг и
     *       капитал стояли по краям широкой строки с провалом посередине, условия
     *       сценария висели отдельным рядом чипов под карточкой, а сам ранг был
     *       буквой без всякого масштаба: «A» — это близко к пределу или нет?
     *       Теперь всё держится вместе: шапка называет партию, крупный балл
     *       стоит рядом с рангом и шкалой рангов, под ними ряд чисел, за которые
     *       игрок и играл, и тут же — условия сценария.
     */
    var startNW = G.run.history.length ? G.run.history[0].netWorth : 0;
    var level = C.levels.filter(function (l) { return l.id === G.scenario.level; })[0];

    var verdict = el('section', 'verdict' + (evaluation.done ? ' ok' : ' miss'));

    var vhead = el('div', 'verdict-head');
    vhead.appendChild(el('span', 'verdict-kicker', 'Пять лет спустя'));
    vhead.appendChild(el('span', 'vh-dot'));
    vhead.appendChild(el('span', 'verdict-scen', G.scenario.title));
    if (level) {
      vhead.appendChild(el('span', 'vh-dot'));
      vhead.appendChild(el('span', 'verdict-level', level.title));
    }
    verdict.appendChild(vhead);

    var scoreRow = el('div', 'score-row');
    var big = el('div', 'score-big');
    big.appendChild(el('div', 'score-lab', 'Ваш результат'));
    var num = el('div', 'score-num');
    num.appendChild(el('span', null, String(score)));
    num.appendChild(el('span', 'score-max', '/ 100'));
    big.appendChild(num);
    big.appendChild(el('div', 'score-name', 'Финансовая устойчивость'));
    scoreRow.appendChild(big);

    var gradeBox = el('div', 'grade-box');
    gradeBox.appendChild(el('div', 'grade-lab', 'Ранг'));
    gradeBox.appendChild(el('div', 'grade-val', evaluation.grade));
    gradeBox.appendChild(el('div', 'grade-hint', GRADE_HINT[evaluation.grade] || ''));
    scoreRow.appendChild(gradeBox);

    /* Одна фраза о том, чем всё кончилось. Балл и ранг — числа, а вывод
       по-русски игрок иначе делает сам, и не всегда верно. Заодно она
       занимает правую половину строки, которая до этого пустовала. */
    var say = el('div', 'verdict-say');
    say.appendChild(el('div', 'vs-lab', evaluation.done ? 'Что получилось' : 'Чего не хватило'));
    say.appendChild(el('div', 'vs-text', verdictLine(st, evaluation, nw, startNW)));
    scoreRow.appendChild(say);
    verdict.appendChild(scoreRow);

    // Шкала рангов: видно, куда попал результат и что было бы выше.
    var scale = el('div', 'grade-scale');
    GRADES.forEach(function (g) {
      var cell = el('span', 'gs-cell' + (g === evaluation.grade ? ' on' : ''));
      cell.appendChild(el('span', null, g));
      scale.appendChild(cell);
    });
    verdict.appendChild(scale);

    /* Числа, ради которых партия и игралась. Каждое — ответ на вопрос,
       который иначе пришлось бы считать в уме. */
    var record = bestBefore == null || nw > bestBefore;
    /* Один список — и для панели, и для картинки, которую игрок сохраняет.
       Пока они собирались порознь, картинка показывала другие показатели
       в другом порядке. */
    var verdictFacts = [
      ['Итоговый капитал', fmt(nw), nw >= 0 ? 'good' : 'bad'],
      ['Изменение за пять лет',
        (nw - startNW >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(nw - startNW))).replace('−', ''),
        nw - startNW >= 0 ? 'good' : 'bad'],
      ['Условия сценария', evaluation.met + ' из ' + evaluation.total,
        evaluation.done ? 'good' : 'warn'],
      [bestBefore == null ? 'Первый результат здесь'
        : record ? 'Личный рекорд побит' : 'Ваш рекорд по сценарию',
        fmtShort(bestBefore == null ? nw : Math.max(bestBefore, nw)),
        record ? 'good' : null]
    ];
    var facts = el('div', 'verdict-facts');
    verdictFacts.forEach(function (f) { facts.appendChild(vFact(f[0], f[1], f[2])); });
    verdict.appendChild(facts);

    // Условия сценария — внутри карточки: это часть результата, а не сноска.
    var reqs = el('div', 'requirements');
    evaluation.requirements.forEach(function (r) {
      reqs.appendChild(reqRow(r.done, r.label));
    });
    verdict.appendChild(reqs);
    wrap.appendChild(verdict);

    MaxBridge.hapticNotify(evaluation.done ? 'success' : 'warning');

    /* Четыре характеристики крупно */
    wrap.appendChild(el('div', 'section-label', 'Каким вы пришли к финалу'));
    var four = el('div', 'final-stats');
    four.appendChild(finalStat('wallet', 'Резерв', E.reserveMonths(st).toFixed(1) + ' мес',
      clamp(E.reserveMonths(st) / 3 * 100, 0, 100), 'money'));
    four.appendChild(finalStat('shield', 'Спокойствие', Math.round(st.calm) + ' / 100', st.calm, 'calm'));
    four.appendChild(finalStat('heart', 'Жизнь', Math.round(st.quality) + ' / 100', st.quality, 'quality'));
    four.appendChild(finalStat('bolt', 'Силы', Math.round(st.energy) + ' / 100', st.energy, 'energy'));
    wrap.appendChild(four);

    /* Разбор считается ровно один раз и кормит сразу всё: и самое дорогое
       решение, и раздел «Разбор», и линию идеальной партии на графике. */
    var cfAll = E.counterfactualList(G.built, G.seed, G.choices, 0);
    var cfList = cfAll.slice(0, 4);
    var cf = cfAll[0] || null;

    /* «Идеальный выбор» рисуем, только если он и правда лучше вашего:
       линия, совпадающая с вашей, ничего не добавляет, а подпись рядом
       с ней читалась бы как насмешка. */
    var ideal = E.idealRun(G.built, G.seed, G.choices, null, cfAll);
    if (ideal && E.netWorth(ideal.state) - E.netWorth(st) < 1) ideal = null;
    var avg = E.averageHistory(G.built, G.seed, 5, null, G.run.history.length);

    /* Решения по месяцам: что было выбрано, что было лучшим и во сколько
       обошлась разница. Отсюда и берётся разбор по клику на график. */
    var byMonth = {};
    var known = {};
    function altOf(ev, id) {
      var list = (ev && ev.choices) || [];
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    function addDecision(month, rec) {
      if (month == null) return;
      (byMonth[month] = byMonth[month] || []).push(rec);
    }
    cfAll.forEach(function (r) {
      known[r.event.id] = true;
      addDecision(r.month, {
        event: r.event,
        chosen: r.chosen,
        best: r.up ? altOf(r.event, r.up.id) : null,
        gain: r.up ? r.up.delta : 0,
        worst: r.delta < 0 ? r : null
      });
    });
    (G.choices || []).forEach(function (c) {
      if (!c || c.type === 'trade' || known[c.eventId]) return;
      var ev = (G.built.events || []).filter(function (e) { return e.id === c.eventId; })[0];
      if (!ev) return;
      known[ev.id] = true;
      addDecision(ev.month, { event: ev, chosen: altOf(ev, c.choiceId), best: null, gain: 0 });
    });

    var decisions = [];
    Object.keys(byMonth).forEach(function (m) {
      decisions.push({
        month: +m,
        better: byMonth[m].some(function (d) { return d.best && d.gain > 0; })
      });
    });

    wrap.appendChild(el('div', 'section-label', 'Как менялся ваш итог'));
    wrap.appendChild(buildChart([
      { key: 'mine', label: 'Ваша партия', points: G.run.history },
      cf ? { key: 'alt', label: 'Если бы выбрали иначе', points: cf.history } : null,
      ideal ? { key: 'ideal', label: 'Идеальный выбор', points: ideal.history } : null,
      avg ? { key: 'avg', label: 'Среднестатистический', points: avg } : null
    ], {
      decisions: decisions,
      detail: function (m) { return buildMonthDetail(m, byMonth, st, G.run.history); }
    }));

    if (cf) {
      var alt = el('div', 'counterfactual');
      alt.appendChild(el('div', 'cf-kicker', 'Самое дорогое решение за пять лет'));
      alt.appendChild(el('div', 'cf-title', cf.event.title));
      var cfl = el('div', 'cf-lines');
      cfl.appendChild(cfRow('Вы выбрали', cf.chosen.label, false));
      cfl.appendChild(cfRow('Альтернатива', cf.alternative.label, false));
      alt.appendChild(cfl);
      var deltaBox = el('div', 'cf-delta ' + (cf.delta > 0 ? 'worse' : 'better'));
      // Знак ставим только когда альтернатива была выгоднее: минус перед
      // суммой, которую игрок выиграл своим решением, читался как потеря.
      deltaBox.appendChild(el('span', 'cf-delta-num',
        (cf.delta > 0 ? '+' : '') + fmt(Math.abs(cf.delta)).replace('−', '')));
      deltaBox.appendChild(el('span', 'cf-delta-lab',
        cf.delta > 0 ? 'столько вы бы имели, выбрав иначе' : 'ваш выбор оказался выгоднее на эту сумму'));
      alt.appendChild(deltaBox);
      wrap.appendChild(alt);
    }

    /* Разбор: что стоило дороже всего */
    if (cfList.length) {
      wrap.appendChild(el('div', 'section-label', 'Разбор: решения, которые решили итог'));
      var rnote = el('div', 'review-note');
      rnote.textContent = 'Партия пересчитана с начала для каждого варианта. Разница в капитале — это цена одного этого решения, а не совпадение.';
      wrap.appendChild(rnote);
      wrap.appendChild(buildReviewDecisions(cfList));
    }

    /* Советы по этой партии */
    var advice = adviceFor(st, evaluation);
    if (advice.length) {
      wrap.appendChild(el('div', 'section-label', 'Что стоит изменить в следующий раз'));
      wrap.appendChild(buildAdvice(advice));
    }

    /* Ключевые решения этой партии */
    var keyMoments = buildKeyMoments(st);
    if (keyMoments) {
      wrap.appendChild(el('div', 'section-label', 'Ключевые события вашей истории'));
      wrap.appendChild(keyMoments);
    }

    // Исходы рискованных решений. Показываем отдельно, чтобы игрок различал
    // качество решения и качество удачи — это главная мысль карточки «Риск».
    if (st.outcomes && st.outcomes.length) {
      wrap.appendChild(el('div', 'section-label', 'Чем закончились ваши ставки'));
      var box = el('div', 'outcomes');
      st.outcomes.forEach(function (o) {
        var row = el('div', 'outcome ' + (o.good ? 'good' : 'bad'));
        row.appendChild(el('span', 'oc-month', MONTHS[o.month % 12]));
        row.appendChild(el('span', 'oc-text', o.label));
        box.appendChild(row);
      });
      var lucky = st.stats.luckyBreaks;
      var note = el('div', 'outcomes-note');
      note.textContent = 'Удачных исходов ' + lucky + ' из ' + st.stats.gambles +
        '. Решение оценивают по тому, что было известно на момент выбора, а не по тому, чем всё кончилось.';
      box.appendChild(note);
      wrap.appendChild(box);
    }

    // Итог вложений: отдельно, потому что «выросло на бумаге» и «получено
    // деньгами» — разные вещи, и в отчёте это должно быть видно.
    if (st.stats.trades > 0 || (st.portfolio && st.portfolio.length)) {
      wrap.appendChild(el('div', 'section-label', 'Чем закончились вложения'));
      wrap.appendChild(buildInvestSummary(st));
    }

    wrap.appendChild(el('div', 'section-label', 'Куда ушли деньги за пять лет'));
    wrap.appendChild(buildFlows(st));

    // Тихие расходы отдельной строкой — самое неприятное открытие отчёта
    if (st.flows.subs > 0) {
      var quiet = el('div', 'quiet-box');
      quiet.appendChild(el('div', 'quiet-lab', 'Подписки и мелкие списания'));
      quiet.appendChild(el('div', 'quiet-num', fmt(st.flows.subs)));
      quiet.appendChild(el('div', 'quiet-note',
        'Ни одно из этих списаний не проходило через ваше решение. Именно поэтому они не ощущались.'));
      wrap.appendChild(quiet);
    }

    // Показатели
    wrap.appendChild(el('div', 'section-label', 'Итоги'));
    var grid = el('div', 'kpi-grid');
    grid.appendChild(kpi('Спокойствие', Math.round(st.calm) + ' / 100', st.calm >= 55));
    grid.appendChild(kpi('Качество жизни', Math.round(st.quality) + ' / 100', st.quality >= 55));
    grid.appendChild(kpi('Силы', Math.round(st.energy) + ' / 100', st.energy >= 35));
    grid.appendChild(kpi('Доверие близких', Math.round(st.trust) + ' / 100', st.trust >= 50));
    grid.appendChild(kpi('Резерв', E.reserveMonths(st).toFixed(1) + ' мес', E.reserveMonths(st) >= 3));
    grid.appendChild(kpi('Долги', fmtShort(E.debtBalanceTotal(st)), E.debtBalanceTotal(st) === 0));
    grid.appendChild(kpi('Проценты и штрафы', fmtShort(st.flows.interest + st.flows.fees + st.flows.feesOnDebt), (st.flows.interest + st.flows.fees + st.flows.feesOnDebt) < 15000));
    grid.appendChild(kpi('Просрочки', String(st.stats.late), st.stats.late === 0));
    grid.appendChild(kpi('Взято кредитов', String(st.stats.loansTaken || 0), (st.stats.loansTaken || 0) === 0));
    grid.appendChild(kpi('Кредитный рейтинг',
      Math.round(st.creditScore) + ' · ' + E.creditTier(st.creditScore).label,
      st.creditScore >= 660));
    if (st.stats.creditRefused > 0) {
      grid.appendChild(kpi('Отказов банка', String(st.stats.creditRefused), false));
    }
    if (st.stats.scamHit + st.stats.scamAvoided > 0) {
      grid.appendChild(kpi('Схемы распознаны', st.stats.scamAvoided + ' из ' + (st.stats.scamHit + st.stats.scamAvoided), st.stats.scamHit === 0));
    }
    var fe = G.forecastErrors.length
      ? (100 - Math.min(100, 100 * G.forecastErrors.reduce(function (a, b) { return a + b; }, 0) / G.forecastErrors.length)).toFixed(0) + '%'
      : '—';
    grid.appendChild(kpi('Точность оценок', fe, true));
    wrap.appendChild(grid);

    // Открытые карточки
    if (st.concepts.length) {
      wrap.appendChild(el('div', 'section-label', 'Открыто в этой партии'));
      var cw = el('div', 'concept-chips');
      st.concepts.forEach(function (id) {
        var c = C.concepts[id];
        if (!c) return;
        var chip = el('button', 'cchip');
        chip.appendChild(icon('spark'));
        chip.appendChild(el('span', null, c.title));
        chip.onclick = function () { MaxBridge.haptic('light'); showConceptModal(id); };
        cw.appendChild(chip);
      });
      wrap.appendChild(cw);
    }

    /*
     * Достижения, открытые этой партией
     *       При повторном просмотре проверка не запускается: достижения уже
     *       открыты, и «открыто достижений» во второй раз было бы неправдой.
     *       Зато рядом появляется вход в общий список — и возврат оттуда
     *       ведёт обратно сюда, а не в меню.
     */
    var fresh = replay ? [] : Achievements.check({
      state: st, finished: true, score: score, grade: evaluation.grade,
      met: evaluation.met, total: evaluation.total, history: G.run.history
    });
    if (fresh.length) {
      wrap.appendChild(el('div', 'section-label', 'Открыто достижений: ' + fresh.length));
      var ab = el('div', 'ach-fresh');
      fresh.forEach(function (a) { ab.appendChild(achCard(a, true)); });
      wrap.appendChild(ab);
    }
    var achGo = el('button', 'ghost-btn small ach-go');
    achGo.appendChild(icon('spark'));
    achGo.appendChild(el('span', null, fresh.length ? 'Все достижения' : 'Достижения'));
    achGo.onclick = function () {
      MaxBridge.haptic('light');
      leaveTo(renderAchievements, reopen);
    };
    wrap.appendChild(achGo);

    /* Место в таблице */
    var place = Leaders.list({ cupOnly: !!G.scenario.cup })
      .map(function (r) { return r.id; }).indexOf(entry.id) + 1;
    var lead = el('section', 'lead-result');
    var lr = el('div', 'lr-line');
    lr.appendChild(el('span', 'lr-place', place > 0 ? '#' + place : '—'));
    var lrt = el('div', 'lr-text');
    lrt.appendChild(el('div', 'lr-title', G.scenario.cup
      ? 'Место в таблице соревнования'
      : 'Место среди всех доигранных партий'));
    lrt.appendChild(el('div', 'lr-sub', 'Балл ' + score + ' · подписано как «' + entry.name + '»'));
    lr.appendChild(lrt);
    var lrGo = el('button', 'ghost-btn small');
    lrGo.appendChild(el('span', null, 'Таблица'));
    lrGo.onclick = function () {
      MaxBridge.haptic('light');
      leaveTo(function () { renderLeaders(G.scenario.cup ? 'cup' : 'all'); }, reopen);
    };
    lr.appendChild(lrGo);
    lead.appendChild(lr);

    // Подписать результат можно прямо здесь: имя спрашивается один раз
    // и запоминается, а в MAX оно и так известно из профиля.
    if (!who.external) {
      var nline = el('div', 'ln-line');
      var ninput = el('input', 'ln-input');
      ninput.setAttribute('type', 'text');
      ninput.setAttribute('maxlength', '24');
      ninput.setAttribute('placeholder', 'Ваше имя для таблицы');
      ninput.value = who.name || '';
      var nsave = el('button', 'ghost-btn small');
      nsave.appendChild(el('span', null, 'Подписать'));
      nsave.onclick = function () {
        var v = Leaders.setName(ninput.value) || 'Аноним';
        Leaders.list({}).forEach(function (r) { if (r.playerId === 'device') Leaders.rename(r.id, v); });
        entry.name = v;
        MaxBridge.haptic('light');
        renderLeaders(G.scenario.cup ? 'cup' : 'all');
      };
      nline.appendChild(ninput);
      nline.appendChild(nsave);
      lead.appendChild(nline);
    }
    wrap.appendChild(lead);

    // Действия
    var actions = el('div', 'actions');
    var again = el('button', 'primary-btn');
    again.appendChild(icon('refresh'));
    again.appendChild(el('span', null, 'Пройти пять лет заново'));
    again.onclick = function () { MaxBridge.haptic('medium'); startScenario(G.scenario); };
    actions.appendChild(again);

    var other = el('button', 'ghost-btn');
    other.appendChild(icon('layers'));
    other.appendChild(el('span', null, 'Другой сценарий'));
    other.onclick = function () { MaxBridge.haptic('light'); renderMenu(); };
    actions.appendChild(other);

    // Картинкой — то, что реально показывают друзьям и вешают в отчёт
    var pngBtn = el('button', 'ghost-btn');
    pngBtn.appendChild(icon('spark'));
    var pngLabel = el('span', null, 'Картинкой');
    pngBtn.appendChild(pngLabel);
    pngBtn.onclick = function () {
      MaxBridge.haptic('light');
      /* Картинка собирается из тех же величин, что и панель наверху
         экрана: те же подписи, тот же порядок, те же цвета итога. Иначе
         сохранённый результат выглядел бы как результат другой игры. */
      exportResultImage({
        score: score,
        grade: evaluation.grade,
        gradeHint: GRADE_HINT[evaluation.grade] || '',
        grades: GRADES,
        done: evaluation.done,
        scenario: G.scenario.title,
        level: level ? level.title : '',
        sayLab: evaluation.done ? 'Что получилось' : 'Чего не хватило',
        say: verdictLine(st, evaluation, nw, startNW),
        facts: verdictFacts,
        reqs: evaluation.requirements.map(function (r) { return [!!r.done, r.label]; }),
        name: entry.name,
        sub: (G.scenario.cup ? 'соревнование · ' : '') +
             'место в таблице #' + (place > 0 ? place : '—') + ' · ' + fmtDate(Date.now())
      }, pngLabel);
    };
    actions.appendChild(pngBtn);

    var shareBtn = el('button', 'ghost-btn subtle');
    shareBtn.appendChild(icon('share'));
    var shareLabel = el('span', null, 'Поделиться');
    shareBtn.appendChild(shareLabel);
    shareBtn.onclick = function () {
      var text = 'Симулятор «Пять лет спустя», сценарий «' + G.scenario.title + '»: итог ' +
        fmt(nw) + ', спокойствие ' + Math.round(st.calm) + '/100. ' +
        (cf ? 'Самое дорогое решение обошлось в ' + fmt(Math.abs(cf.delta)) + '.' : '');
      var viaMax = MaxBridge.share(text);
      if (!viaMax) {
        shareLabel.textContent = 'Скопировано';
        setTimeout(function () { shareLabel.textContent = 'Поделиться'; }, 1600);
      }
      MaxBridge.haptic('light');
    };
    actions.appendChild(shareBtn);
    wrap.appendChild(actions);

    w.appendChild(wrap);
    root.appendChild(w);
    resetScroll();
  }

  /**
   * Итог по бирже. Отдельно показываем зафиксированный результат
   * (то, что реально стало деньгами) и то, что осталось лежать в бумагах.
   */
  function buildInvestSummary(st) {
    var box = el('div', 'invest-sum');

    var open = E.portfolioValue(st);
    var openCost = (st.portfolio || []).reduce(function (a, h) { return a + h.cost; }, 0);
    var unrealized = open - openCost;
    var realized = st.stats.realized || 0;

    var grid = el('div', 'kpi-grid');
    grid.appendChild(kpi('Вложено всего', fmtShort(st.stats.invested || 0) + ' ₽', true));
    grid.appendChild(kpi('Сделок', String(st.stats.trades || 0), true));
    grid.appendChild(kpi('Зафиксировано деньгами',
      (realized >= 0 ? '+' : '−') + fmtShort(Math.abs(Math.round(realized))) + ' ₽', realized >= 0));
    grid.appendChild(kpi('Комиссии брокера', fmtShort(Math.round(st.flows.tradeFees || 0)) + ' ₽',
      (st.flows.tradeFees || 0) < 3000));
    if (open > 0) {
      grid.appendChild(kpi('Осталось в бумагах', fmtShort(Math.round(open)) + ' ₽', true));
      grid.appendChild(kpi('Из них прибыль на бумаге',
        (unrealized >= 0 ? '+' : '−') + fmtShort(Math.abs(Math.round(unrealized))) + ' ₽', unrealized >= 0));
    }
    box.appendChild(grid);

    if (st.portfolio && st.portfolio.length) {
      var list = el('div', 'invest-list');
      st.portfolio.forEach(function (h) {
        var inst = instrumentById(h.instId);
        if (!inst) return;
        var value = E.holdingValue(st, h);
        var pct = h.cost > 0 ? (value - h.cost) / h.cost : 0;
        var row = el('div', 'invest-row ' + (pct >= 0 ? 'up' : 'down'));
        row.appendChild(el('span', 'ir-name', inst.name));
        row.appendChild(el('span', 'ir-cost', 'вложено ' + fmtShort(h.cost) + ' ₽'));
        row.appendChild(el('span', 'ir-val', fmt(Math.round(value))));
        row.appendChild(el('span', 'ir-pct', fmtPct(pct)));
        box.appendChild(list);
        list.appendChild(row);
      });
    }

    var note = el('div', 'invest-note');
    if ((st.stats.trades || 0) === 0) {
      note.textContent = 'За пять лет вы не сделали ни одной сделки. Это тоже решение: деньги на счёте не рискуют, но и не обгоняют инфляцию.';
    } else if (realized < 0 && unrealized > -realized) {
      note.textContent = 'Часть убытков вы зафиксировали продажей, хотя оставшиеся бумаги в итоге выросли. Это самая частая ошибка: продавать на падении, когда страшнее всего.';
    } else if ((st.stats.tradeLosses || 0) > (st.stats.tradeWins || 0)) {
      note.textContent = 'Убыточных продаж было больше, чем прибыльных. Дело редко в выборе бумаги — чаще в том, что деньги понадобились раньше, чем вложение успело сработать.';
    } else {
      note.textContent = 'Доход от вложений считается после комиссий и только по проданным бумагам. Пока актив не продан, прибыль существует лишь на экране.';
    }
    box.appendChild(note);
    return box;
  }

  function finalStat(ic, name, val, pct, key) {
    var c = el('div', 'fstat fstat-' + key);
    var head = el('div', 'fstat-head');
    head.appendChild(icon(ic));
    head.appendChild(el('span', 'fstat-name', name));
    c.appendChild(head);
    c.appendChild(el('div', 'fstat-val', val));
    var tr = el('div', 'fstat-track');
    var fill = el('i');
    fill.style.width = clamp(pct, 0, 100).toFixed(0) + '%';
    tr.appendChild(fill);
    c.appendChild(tr);
    return c;
  }

  /**
   * Хроника важного: берём из ленты записи, которые действительно
   * меняли ход истории (крупные суммы, долги, удачи и провалы).
   */
  function buildKeyMoments(st) {
    var picks = (st.timeline || []).filter(function (t) {
      if (t.type === 'month-up' || t.type === 'month-down') return false;
      return Math.abs(t.amount || 0) >= 15000 || t.type === 'debt' || t.type === 'bad' || t.type === 'good';
    });
    if (!picks.length) return null;
    picks.sort(function (a, b) { return Math.abs(b.amount || 0) - Math.abs(a.amount || 0); });
    picks = picks.slice(0, 8).sort(function (a, b) { return a.month - b.month; });

    var box = el('div', 'moments');
    picks.forEach(function (t) {
      var row = el('div', 'moment ' + (t.type || 'info'));
      var when = el('span', 'mo-when');
      when.appendChild(el('span', 'mo-year', 'Г' + (1 + Math.floor(t.month / 12))));
      when.appendChild(el('span', 'mo-month', MONTHS[t.month % 12]));
      row.appendChild(when);
      row.appendChild(el('i', 'mo-dot'));
      row.appendChild(el('span', 'mo-text', t.label));
      if (t.amount) row.appendChild(el('span', 'mo-amt', fmt(t.amount)));
      box.appendChild(row);
    });
    return box;
  }

  function cfRow(label, value) {
    var r = el('div', 'cf-row');
    r.appendChild(el('span', 'cf-row-lab', label));
    r.appendChild(el('span', 'cf-row-val', value));
    return r;
  }

  function kpi(label, value, good) {
    var c = el('div', 'kpi' + (good ? ' good' : ' bad'));
    c.appendChild(el('div', 'kpi-val', value));
    c.appendChild(el('div', 'kpi-lab', label));
    return c;
  }

  function showConceptModal(id) {
    var c = C.concepts[id];
    var wrap = el('div', 'modal-wrap');
    var m = el('div', 'modal');
    var k = el('div', 'modal-kicker');
    k.appendChild(icon('spark'));
    k.appendChild(el('span', null, 'карточка знаний'));
    m.appendChild(k);
    m.appendChild(el('h3', 'modal-title', c.title));
    m.appendChild(el('div', 'modal-short', c.short));
    m.appendChild(el('p', 'modal-text', c.text));
    var close = el('button', 'primary-btn');
    close.appendChild(el('span', null, 'Понятно'));
    close.onclick = function () {
      wrap.classList.remove('in');
      lockScroll(false);
      setTimeout(function () { wrap.remove(); }, 220);
    };
    m.appendChild(close);
    wrap.appendChild(m);
    wrap.onclick = function (e) { if (e.target === wrap) close.onclick(); };
    document.body.appendChild(wrap);
    lockScroll(true);
    requestAnimationFrame(function () { wrap.classList.add('in'); });
  }

  /*
   *  SVG-график итогов: четыре линии
   *
   *  Одна линия ни о чём не говорит: полтора миллиона — это много или
   *  мало? Смысл появляется от соседних линий, и каждая отвечает на свой
   *  вопрос: сколько стоило одно решение, где был потолок этого сценария
   *  и как выглядит партия, сыгранная не думая. Все линии посчитаны тем
   *  же движком и тем же seed — значит, разница между ними это разница
   *  решений, а не разница везения.
   *
   *  Наведение устроено ровно как на графике первого экрана: вертикаль
   *  по месяцу, точки на всех линиях и подсказка с числами.
   */

  /**
   * opts.decisions — месяцы, в которых игрок что-то решал, с отметкой,
   * был ли вариант лучше выбранного. По ним под графиком рисуются засечки:
   * без них клик по кривой был бы догадкой, а не действием.
   * opts.detail(month) — что показать под графиком по клику.
   */
  function buildChart(lines, opts) {
    opts = opts || {};
    lines = (lines || []).filter(function (l) { return l && l.points && l.points.length > 1; });
    if (!lines.length) return el('div', 'chart');

    var W = 340, H = 200, padL = 12, padR = 12, padT = 14, padB = 26;
    var months = Math.max.apply(null, lines.map(function (l) { return l.points.length; }));

    var vals = [];
    lines.forEach(function (l) {
      l.points.forEach(function (h) { vals.push(h.netWorth); });
    });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max - min < 1) max = min + 1;
    var span = max - min;
    min -= span * 0.10; max += span * 0.10; span = max - min;

    function X(i) { return padL + (W - padL - padR) * (i / Math.max(1, months - 1)); }
    function Y(v) { return padT + (H - padT - padB) * (1 - (v - min) / span); }

    /** Значение линии в месяце m: короткая линия держит своё последнее. */
    function at(l, m) { return l.points[Math.min(m, l.points.length - 1)].netWorth; }

    function pathOf(l) {
      var d = '';
      for (var m = 0; m < months; m++) {
        d += (m ? 'L' : 'M') + X(m).toFixed(1) + ' ' + Y(at(l, m)).toFixed(1);
      }
      return d;
    }

    var wrap = el('div', 'chart');
    var svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, 'class': 'chart-svg', role: 'img',
      'aria-label': 'График капитала: ваша партия и три линии для сравнения'
    });

    // Отметки лет — время видно на графике
    for (var yy = 1; yy < Math.ceil(months / 12); yy++) {
      svg.appendChild(svgEl('line', {
        x1: X(yy * 12).toFixed(1), x2: X(yy * 12).toFixed(1),
        y1: padT, y2: H - padB, 'class': 'chart-grid'
      }));
    }

    // Линия нуля: пересечение с ней — это переход капитала через ноль
    if (min < 0 && max > 0) {
      svg.appendChild(svgEl('line', {
        x1: padL, x2: W - padR, y1: Y(0).toFixed(1), y2: Y(0).toFixed(1), 'class': 'chart-zero'
      }));
    }

    // Заливка только под своей линией: остальные — линии сравнения,
    // закрашивать их значило бы спорить самому с собой за внимание.
    var mine = lines.filter(function (l) { return l.key === 'mine'; })[0];
    if (mine) {
      svg.appendChild(svgEl('path', {
        d: pathOf(mine) + ' L' + X(months - 1).toFixed(1) + ' ' + Y(min).toFixed(1) +
           ' L' + X(0).toFixed(1) + ' ' + Y(min).toFixed(1) + ' Z',
        'class': 'chart-area'
      }));
    }

    // Линии сравнения рисуются раньше своей: своя должна остаться сверху.
    var nodes = {};
    lines.slice().sort(function (a, b) {
      return (a.key === 'mine' ? 1 : 0) - (b.key === 'mine' ? 1 : 0);
    }).forEach(function (l) {
      nodes[l.key] = svgEl('path', { d: pathOf(l), 'class': 'chart-line ln-' + l.key });
      svg.appendChild(nodes[l.key]);
    });

    /*
     * Засечки месяцев, в которых принимались решения
     *       Янтарная — в том месяце был вариант лучше выбранного; серая — ваш
     *       выбор был лучшим из показанных. Это и подсказывает, куда нажимать.
     */
    var picks = {};
    (opts.decisions || []).forEach(function (d) {
      if (d.month == null || d.month >= months) return;
      if (!picks[d.month] || d.better) picks[d.month] = d;
    });
    var marksRow = svgEl('g', { 'class': 'chart-picks' });
    Object.keys(picks).forEach(function (m) {
      marksRow.appendChild(svgEl('rect', {
        x: (X(+m) - 0.7).toFixed(1), y: (H - padB + 9).toFixed(1),
        width: 1.4, height: 3.4, rx: 0.7,
        'class': 'chart-pick' + (picks[m].better ? ' miss' : '')
      }));
    });
    svg.appendChild(marksRow);

    /* Слой наведения */

    var hover = svgEl('g', { 'class': 'chart-hover' });
    hover.appendChild(svgEl('line', {
      x1: 0, x2: 0, y1: padT - 6, y2: H - padB + 4, 'class': 'chart-vline'
    }));
    var vline = hover.firstChild;
    var marks = {};
    lines.forEach(function (l) {
      marks[l.key] = svgEl('circle', { r: l.key === 'mine' ? 5 : 3.6, 'class': 'chart-mark m-' + l.key });
      hover.appendChild(marks[l.key]);
    });
    svg.appendChild(hover);
    wrap.appendChild(svg);

    var tip = el('div', 'chart-tip');
    var when = el('div', 'ct-when');
    tip.appendChild(when);
    var rows = {};
    lines.forEach(function (l) {
      var r = el('div', 'ct-row r-' + l.key);
      r.appendChild(el('i'));
      r.appendChild(el('span', 'ct-lab', l.label));
      var v = el('b', 'ct-val');
      r.appendChild(v);
      rows[l.key] = v;
      tip.appendChild(r);
    });
    var gapNode = el('div', 'ct-gap');
    tip.appendChild(gapNode);
    wrap.appendChild(tip);

    /* Легенда переключает линии: четыре кривые сразу читаются тяжело,
       и возможность убрать лишнее — половина пользы от сравнения. */
    var lg = el('div', 'chart-legend');
    lines.forEach(function (l) {
      var b = el('button', 'lg-item on lg-' + l.key);
      b.appendChild(el('i', 'lg-line'));
      b.appendChild(el('span', null, l.label));
      b.onclick = function () {
        var on = b.classList.toggle('on');
        if (nodes[l.key]) nodes[l.key].classList.toggle('off', !on);
        if (marks[l.key]) marks[l.key].classList.toggle('off', !on);
        var row = tip.querySelector('.r-' + l.key);
        if (row) row.classList.toggle('off', !on);
        MaxBridge.hapticSelect();
      };
      lg.appendChild(b);
    });
    if (opts.detail) {
      // Подсказка объясняет и засечки: без неё янтарные метки под графиком
      // выглядят просто украшением.
      var how = el('span', 'chart-how');
      how.appendChild(el('i', 'chart-how-tick'));
      how.appendChild(el('span', null, 'засечка — месяц с решением, янтарная — там был вариант лучше. Нажмите на график'));
      lg.appendChild(how);
    } else {
      lg.appendChild(el('span', 'hv-hint', 'Наведите на график'));
    }
    wrap.appendChild(lg);

    /* Разбор выбранного месяца. Пустой блок не занимает места, поэтому
       график выглядит как раньше, пока по нему не нажали. */
    var detail = el('div', 'chart-detail');
    wrap.appendChild(detail);

    function monthAt(clientX) {
      var box = svg.getBoundingClientRect();
      if (!box.width) return null;
      var vx = (clientX - box.left) / box.width * W;
      var m = Math.round((vx - padL) / (W - padL - padR) * (months - 1));
      return Math.min(months - 1, Math.max(0, m));
    }

    function show(m) {
      var x = X(m);
      vline.setAttribute('x1', x.toFixed(1));
      vline.setAttribute('x2', x.toFixed(1));
      lines.forEach(function (l) {
        var v = at(l, m);
        marks[l.key].setAttribute('cx', x.toFixed(1));
        marks[l.key].setAttribute('cy', Y(v).toFixed(1));
        rows[l.key].textContent = fmtShort(v);
      });
      wrap.classList.add('live');

      when.textContent = 'Год ' + (Math.floor(m / 12) + 1) + ' · месяц ' + (m % 12 + 1);
      var avg = lines.filter(function (l) { return l.key === 'avg'; })[0];
      var me = lines.filter(function (l) { return l.key === 'mine'; })[0];
      gapNode.textContent = (avg && me)
        ? 'Вы против среднего: ' + (at(me, m) >= at(avg, m) ? '+' : '−') +
          fmtShort(Math.abs(at(me, m) - at(avg, m)))
        : '';

      var rel = (x - padL) / (W - padL - padR);
      tip.style.left = (rel * 100).toFixed(1) + '%';
      tip.classList.toggle('flip', rel > 0.6);
    }

    /* Наведение показывает числа, нажатие — закрепляет месяц и раскрывает
       разбор под графиком. Уводя курсор, возвращаемся к закреплённому
       месяцу, а не гасим всё: иначе разбор внизу относился бы к месяцу,
       который на графике уже ничем не отмечен. */
    var pinned = null;

    function pin(m) {
      pinned = m;
      show(m);
      wrap.classList.add('pinned');
      if (!opts.detail) return;
      detail.innerHTML = '';
      var node = opts.detail(m);
      if (node) detail.appendChild(node);
      detail.classList.toggle('on', !!node);
    }

    svg.addEventListener('pointermove', function (e) {
      var m = monthAt(e.clientX);
      if (m != null) show(m);
    });
    svg.addEventListener('pointerdown', function (e) {
      var m = monthAt(e.clientX);
      if (m == null) return;
      // Нажатие рядом с засечкой считается нажатием по ней: попасть в
      // один месяц из шестидесяти пальцем нельзя.
      var near = null, bestD = 3;
      Object.keys(picks).forEach(function (k) {
        var d = Math.abs(+k - m);
        if (d < bestD) { bestD = d; near = +k; }
      });
      MaxBridge.hapticSelect();
      pin(near != null ? near : m);
    });
    svg.addEventListener('pointerleave', function () {
      if (pinned != null) { show(pinned); return; }
      wrap.classList.remove('live');
    });

    return wrap;
  }

  /*
   *  РАЗБОР ОДНОГО МЕСЯЦА
   *
   *  График показывал, ЧТО случилось: вот здесь линия пошла вниз. Но не
   *  отвечал на единственный вопрос, который после этого возникает —
   *  почему. Ответ состоит из двух частей, и обе уже посчитаны:
   *   - решение месяца: что игрок выбрал, какой вариант оказался бы лучше
   *     и во сколько обошлась разница (это тот же перебор, что кормит
   *     раздел «Разбор» и линию идеальной партии);
   *   - движение денег за месяц: сколько пришло и куда ушло. Именно
   *     здесь обычно и находится провал — не в решении, а в том, что
   *     обязательные расходы съели весь доход.
   */

  function buildMonthDetail(m, byMonth, st, history) {
    var box = el('div', 'md');

    var head = el('div', 'md-head');
    head.appendChild(el('span', 'md-when',
      'Год ' + (Math.floor(m / 12) + 1) + ' · месяц ' + (m % 12 + 1)));
    var was = history[Math.max(0, m - 1)], now = history[Math.min(history.length - 1, m)];
    if (was && now) {
      var move = now.netWorth - was.netWorth;
      var mv = el('span', 'md-move ' + (move >= 0 ? 'up' : 'down'));
      mv.appendChild(el('span', null, 'Капитал за месяц ' +
        (move >= 0 ? '+' : '−') + fmtShort(Math.abs(move))));
      head.appendChild(mv);
    }
    box.appendChild(head);

    /* Решения этого месяца */
    var rows = byMonth[m] || [];
    if (!rows.length) {
      box.appendChild(el('div', 'md-none',
        'В этом месяце решений не было — двигались только регулярные статьи бюджета.'));
    }
    rows.forEach(function (d) {
      var card = el('div', 'md-choice' + (d.best && d.gain > 0 ? ' miss' : ' ok'));
      card.appendChild(el('div', 'md-ev', evalText(d.event.shortTitle || d.event.title)));

      var mine = el('div', 'md-line mine');
      mine.appendChild(el('span', 'md-lab', 'Вы выбрали'));
      mine.appendChild(el('span', 'md-val', d.chosen ? evalText(d.chosen.label) : '—'));
      card.appendChild(mine);

      if (d.best && d.gain > 0) {
        var better = el('div', 'md-line best');
        better.appendChild(el('span', 'md-lab', 'Лучше было'));
        better.appendChild(el('span', 'md-val', evalText(d.best.label)));
        card.appendChild(better);
        card.appendChild(el('div', 'md-cost',
          'Разница к итогу партии: +' + fmt(Math.round(d.gain))));
      } else {
        card.appendChild(el('div', 'md-cost good',
          'Из показанных вариантов ваш оказался лучшим'));
      }
      box.appendChild(card);
    });

    /* Куда ушли деньги в этом месяце */
    var rec = (st.monthly || []).filter(function (x) { return x.month === m; })[0];
    if (rec) {
      box.appendChild(el('div', 'md-sub', 'Движение денег за месяц'));
      var flows = el('div', 'md-flows');
      [['Доход', rec.income, 'in'],
       ['Взято в долг', rec.borrowed, 'in'],
       ['Обязательные', -rec.mandatory, 'out'],
       ['Продукты', -rec.food, 'out'],
       ['Подписки', -rec.subs, 'out'],
       ['Быт', -rec.living, 'out'],
       ['Долги', -rec.debt, 'out'],
       ['Штрафы и комиссии', -rec.fees, 'out'],
       ['Вложения', -rec.invested, 'out'],
       ['События месяца', -rec.events, 'out']
      ].forEach(function (f) {
        if (!f[1]) return;
        var row = el('div', 'mdf ' + (f[1] >= 0 ? 'in' : 'out'));
        row.appendChild(el('span', 'mdf-lab', f[0]));
        row.appendChild(el('span', 'mdf-val',
          (f[1] >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(f[1])))));
        flows.appendChild(row);
      });
      box.appendChild(flows);

      var diff = rec.close - rec.open;
      var tot = el('div', 'md-total ' + (diff >= 0 ? 'up' : 'down'));
      tot.appendChild(el('span', null, 'Осталось на конец месяца'));
      tot.appendChild(el('b', null, fmt(Math.round(rec.close)) +
        '  (' + (diff >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(diff))) + ')'));
      box.appendChild(tot);
    }

    /* Что записала лента событий */
    var notes = (st.timeline || []).filter(function (t) {
      // «Итог месяца» — не событие, а та же сумма, что уже стоит строкой
      // ниже: в списке «крупнее всего» она всегда была бы первой и всегда
      // лишней.
      return t.month === m && t.amount && Math.abs(t.amount) > 0 &&
        t.type !== 'month-up' && t.type !== 'month-down';
    }).sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); }).slice(0, 4);
    if (notes.length) {
      box.appendChild(el('div', 'md-sub', 'Крупнее всего в этом месяце'));
      var list = el('div', 'md-notes');
      notes.forEach(function (t) {
        var n = el('div', 'mdn ' + (t.amount >= 0 ? 'in' : 'out'));
        n.appendChild(el('span', 'mdn-lab', t.label));
        n.appendChild(el('span', 'mdn-val',
          (t.amount >= 0 ? '+' : '−') + fmt(Math.abs(Math.round(t.amount)))));
        list.appendChild(n);
      });
      box.appendChild(list);
    }

    return box;
  }

  /* Диаграмма потоков */

  function buildFlows(st) {
    var f = st.flows;
    var items = [
      { k: 'mandatory', label: 'Обязательные расходы', v: f.mandatory, cls: 'f-mand' },
      { k: 'food', label: 'Продукты', v: f.food, cls: 'f-food' },
      { k: 'debtPaid', label: 'Платежи по долгам', v: f.debtPaid, cls: 'f-debt' },
      { k: 'interest', label: 'Проценты', v: f.interest, cls: 'f-int' },
      { k: 'fees', label: 'Штрафы и минус на счёте', v: f.fees + f.feesOnDebt, cls: 'f-fee' },
      { k: 'subs', label: 'Подписки', v: f.subs, cls: 'f-subs' },
      { k: 'living', label: 'Бытовые расходы', v: f.living, cls: 'f-living' },
      { k: 'invested', label: 'Вложено в активы', v: f.invested, cls: 'f-save' },
      { k: 'shocks', label: 'Неожиданности', v: f.shocks, cls: 'f-shock' },
      { k: 'fun', label: 'Покупки и траты на себя', v: f.fun, cls: 'f-fun' },
      { k: 'saved', label: 'Отложено в резерв', v: f.saved, cls: 'f-save' }
    ].filter(function (x) { return x.v > 0.5; });

    var total = items.reduce(function (a, x) { return a + x.v; }, 0) || 1;
    items.sort(function (a, b) { return b.v - a.v; });

    var wrap = el('div', 'flows');

    var head = el('div', 'flows-head');
    head.appendChild(el('span', 'flows-lab', 'Доход за пять лет'));
    head.appendChild(el('span', 'flows-val', fmt(f.income)));
    wrap.appendChild(head);

    var track = el('div', 'flows-track');
    items.forEach(function (x) {
      var seg = el('i', 'seg ' + x.cls);
      seg.style.width = (100 * x.v / total) + '%';
      seg.title = x.label + ': ' + fmt(x.v);
      track.appendChild(seg);
    });
    wrap.appendChild(track);

    items.forEach(function (x) {
      var row = el('div', 'flow-row');
      var lab = el('div', 'flow-lab');
      lab.appendChild(el('i', 'swatch ' + x.cls));
      lab.appendChild(el('span', null, x.label));
      row.appendChild(lab);
      var right = el('div', 'flow-right');
      right.appendChild(el('span', 'flow-val', fmt(x.v)));
      right.appendChild(el('span', 'flow-pct', Math.round(100 * x.v / total) + '%'));
      row.appendChild(right);
      wrap.appendChild(row);

      // Анимация роста полосы после вставки
      requestAnimationFrame(function () { row.classList.add('in'); });
    });

    return wrap;
  }

  /* Старт */

  MaxBridge.init();
  // Мост MAX грузится асинхронно и может прийти уже после старта игры.
  // Тогда страница зовёт нас обратно, и мост подключается на ходу.
  window.__maxBridgeReady = function () {
    MaxBridge.init();
    document.body.dataset.platform = MaxBridge.platform;
  };
  Store.load();
  if (Store.data.level) G.level = Store.data.level;

  /*
   *  Определение раскладки
   *
   *  MAX работает и в мобильной шторке, и на десктопе (экраны от 1440px),
   *  и в веб-клиенте. Мобильный интерфейс на большом экране выглядит бедно,
   *  поэтому на ПК включается другая раскладка: две колонки, боковая панель
   *  события вместо всплывающей шторки, поддержка клавиатуры и hover.
   */

  function detectLayout() {
    var byPlatform = MaxBridge.platform === 'desktop' || MaxBridge.platform === 'web';
    var byWidth = (window.innerWidth || 0) >= 901;   // тот же порог, что и в CSS (max-width:900px)
    var hasMouse = false;
    hasMouse = feature(function () {
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    }, false);
    // Ширина — главный критерий: в MAX на десктопе мини-приложение может
    // открываться в узкой шторке, и тогда мобильная раскладка уместнее.
    var desktop = byWidth && (hasMouse || byPlatform);
    if (desktop !== G.desktop || !document.body.className) {
      G.desktop = desktop;
      document.body.classList.toggle('desktop', desktop);
      document.body.classList.toggle('mobile', !desktop);
    }
    return desktop;
  }

  detectLayout();

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var was = G.desktop;
      if (detectLayout() !== was) {
        // Перерисовываем текущий экран под новую раскладку
        if (G.screen === 'menu') renderMenu();
        else if (G.screen === 'game') renderGame(true);
        else if (G.screen === 'report') renderReport();
      }
    }, 180);
  });


  /*
   *  ФОН: ПОЛЕ ТОЧЕК
   *
   *  На ПК фон перестаёт быть картинкой. Точки расступаются перед
   *  курсором и иногда собираются слева в надпись, а потом так же
   *  плавно расходятся по своим местам.
   *
   *  Правила, по которым это сделано именно так:
   *  — Возврат и расталкивание считает одна и та же пружина. Поэтому
   *    любое движение получается плавным само по себе, без списка
   *    ключевых кадров и без «дёрганья» в конце.
   *  — Кадры считаются только пока что-то движется. Когда поле замерло
   *    и курсор ушёл, цикл останавливается совсем.
   *  — На телефоне, при «уменьшить движение» и на узких экранах холст
   *    не включается: фон там рисует CSS, точка в точку такой же.
   */

  var DotField = (function () {
    var GAP = 22;        // шаг сетки — тот же, что у фоновой картинки в CSS
    var MAX_DOTS = 4800; // выше этого сетку разрежаем: кадр важнее плотности
    var EDGE = 190;      // запас поля за краями экрана, откуда приходят точки
    var DOT_R = 1.5;     // радиус точки
    var PUSH_R = 135;    // на таком расстоянии курсор начинает расталкивать
    var PUSH = 3.2;      // сила расталкивания
    var K = 0.05;        // жёсткость возврата
    var DAMP = 0.86;     // затухание: чем меньше, тем короче колебание
    var WORDS = ['5', 'hammer147'];

    var canvas, ctx, sprite;
    var dots = [], cols = 0, rows = 0, gap = 22;
    var w = 0, h = 0, dpr = 1;
    var on = false, raf = 0, resizeT = 0;
    var px = -9999, py = -9999, pointerOn = false, lastMove = 0;
    var word = null, wordT = 0;

    function available() {
      if (!canvas || !ctx) return false;
      if (reducedMotion()) return false;
      if (!window.matchMedia) return false;
      if (!window.matchMedia('(hover:hover) and (pointer:fine)').matches) return false;
      return window.innerWidth >= 900;
    }

    /** Цвет берём из темы, а не из константы: тем две, и они переключаются.
        Цвет один на все точки: надпись читается плотностью, а не подсветкой. */
    function palette() {
      var cs = getComputedStyle(document.documentElement);
      var base = (cs.getPropertyValue('--bg-dot') || '').trim();
      if (!base || base === 'transparent') return null;
      return base;
    }

    function makeSprite(color, r) {
      var c = document.createElement('canvas');
      var size = Math.ceil(r * 2 * dpr) + 2;
      c.width = c.height = size;
      var g = c.getContext('2d');
      g.fillStyle = color;
      g.beginPath();
      g.arc(size / 2, size / 2, r * dpr, 0, Math.PI * 2);
      g.fill();
      return c;
    }

    function build() {
      var color = palette();
      if (!color) { off(); return; }
      // Точке хватает полутора пикселей на пиксель экрана: она круглая
      // и маленькая, а каждый лишний слой — это лишняя работа в кадре.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx = canvas.getContext('2d');

      sprite = makeSprite(color, DOT_R);

      /* Поле шире экрана на EDGE с каждой стороны. Эти точки не видны,
         пока стоят дома, и нужны ровно для одного: когда на надпись не
         хватает соседей, недостающие приходят из-за края экрана —
         вместо того чтобы выдирать их из середины фона. */
      gap = GAP;
      var total = function () {
        cols = Math.ceil((w + EDGE * 2) / gap) + 1;
        rows = Math.ceil((h + EDGE * 2) / gap) + 1;
        return cols * rows;
      };
      // На большом экране сетка с шагом 22 даёт под десять тысяч точек:
      // столько в кадре не нужно, шаг подрастает.
      while (total() > MAX_DOTS && gap < 40) gap += 2;
      dots = [];
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var hx = c * gap - EDGE, hy = r * gap - EDGE;
          dots.push({
            hx: hx, hy: hy,          // дом
            x: hx, y: hy,            // где сейчас
            tx: hx, ty: hy,          // куда тянет пружина
            vx: 0, vy: 0,
            c: c, r: r,
            pend: null, pendAt: 0,   // отложенная цель и её час
            busy: false              // занята буквой
          });
        }
      }
      word = null;
      draw();
    }

    function on2() { return on; }

    function off() {
      on = false;
      document.documentElement.classList.remove('dots-live');
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }

    function wake() {
      if (!on || raf) return;
      raf = requestAnimationFrame(frame);
    }

    function frame() {
      raf = 0;
      var moving = 0;
      var pr2 = PUSH_R * PUSH_R;
      // Окно сетки вокруг курсора: точки вне его и уже стоящие на месте
      // считать незачем — это девять десятых поля.
      var c0 = -1, c1 = -1, r0 = -1, r1 = -1;
      if (pointerOn) {
        var span = Math.ceil(PUSH_R / gap) + 1;
        var pc = Math.floor((px + EDGE) / gap), pr = Math.floor((py + EDGE) / gap);
        c0 = pc - span; c1 = pc + span;
        r0 = pr - span; r1 = pr + span;
      }
      var now = Date.now();
      for (var i = 0; i < dots.length; i++) {
        var d = dots[i];
        // Отложенная цель: точка трогается не вместе со всеми, а в свой час.
        // Из этих задержек и складывается «надпись проявляется/тает».
        if (d.pend && now >= d.pendAt) {
          d.tx = d.pend[0]; d.ty = d.pend[1]; d.pend = null;
        }
        var near = pointerOn && d.c >= c0 && d.c <= c1 && d.r >= r0 && d.r <= r1;
        if (!near && !d.pend && d.vx === 0 && d.vy === 0 && d.x === d.tx && d.y === d.ty) continue;

        var fx = (d.tx - d.x) * K;
        var fy = (d.ty - d.y) * K;
        if (near) {
          var rx = d.x - px, ry = d.y - py;
          var r2 = rx * rx + ry * ry;
          if (r2 < pr2 && r2 > 0.5) {
            var dist = Math.sqrt(r2);
            var f = 1 - dist / PUSH_R;
            f = f * f * PUSH;
            fx += rx / dist * f;
            fy += ry / dist * f;
          }
        }
        d.vx = (d.vx + fx) * DAMP;
        d.vy = (d.vy + fy) * DAMP;
        d.x += d.vx;
        d.y += d.vy;

        if (Math.abs(d.vx) < 0.015 && Math.abs(d.vy) < 0.015 &&
            Math.abs(d.tx - d.x) < 0.06 && Math.abs(d.ty - d.y) < 0.06) {
          d.x = d.tx; d.y = d.ty; d.vx = 0; d.vy = 0;
        } else {
          moving++;
        }
        // Точка, ждущая своего часа, тоже держит цикл живым.
        if (d.pend) moving++;
      }
      draw();
      // Пока курсор стоит на месте, считать нечего: точки уже разошлись
      // и держатся. Цикл просыпается от следующего движения мыши.
      var fresh = pointerOn && (Date.now() - lastMove) < 900;
      if (moving || fresh) raf = requestAnimationFrame(frame);
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var hw = sprite.width / 2;
      var lim = canvas.width + hw, limY = canvas.height + hw;
      for (var i = 0; i < dots.length; i++) {
        var x = dots[i].x * dpr, y = dots[i].y * dpr;
        // Точки из запаса за краем экрана рисовать незачем.
        if (x < -hw || y < -hw || x > lim || y > limY) continue;
        ctx.drawImage(sprite, x - hw, y - hw);
      }
    }

    /*
     * Надпись из точек
     * Текст рисуется в отдельный холст, снимается по сетке в список
     * точек-целей, и к каждой цели притягивается ближайшая свободная
     * точка поля. Отсюда «слетаются» ближние точки, а не случайные —
     * движение читается как сборка, а не как телепорт.
     */

    /** Ширина свободной колонки слева от карточек. */
    function freeColumn() {
      var box = document.querySelector('.menu-wrap') || document.querySelector('.screen');
      var left = box ? box.getBoundingClientRect().left : w * 0.08;
      return Math.max(0, left - 30);
    }

    function wordTargets(text) {
      var avail = freeColumn();
      if (avail < 74) return null;               // слева нет места — не мешаем

      var single = text.length <= 2;
      var oc = document.createElement('canvas');
      var g = oc.getContext('2d');
      function fontAt(size) {
        return '800 ' + size + 'px Nunito, "Segoe UI", system-ui, sans-serif';
      }
      g.font = fontAt(100);
      var w100 = g.measureText(text).width;      // ширина текста при кегле 100

      /* Длинное слово ставим вертикально: в поле между краем экрана и
         карточками оно иначе не помещается, а лезть под карточки нельзя —
         надпись просто исчезнет за ними. Цифра остаётся горизонтальной. */
      var vertical = !single;
      var size, tw, th;
      if (vertical) {
        size = Math.min(avail / 1.1, h * 0.62 / (w100 / 100));
        size = Math.max(24, Math.min(78, size));
      } else {
        size = Math.min(avail / (w100 / 100), h * 0.4);
        size = Math.max(64, Math.min(300, size));
      }
      g.font = fontAt(size);
      tw = Math.ceil(g.measureText(text).width);
      th = Math.ceil(size * 1.22);

      oc.width = vertical ? th : tw + 8;
      oc.height = vertical ? tw + 8 : th;
      g = oc.getContext('2d');
      g.font = fontAt(size);
      g.textBaseline = 'middle';
      g.fillStyle = '#fff';
      if (vertical) {
        g.translate(th / 2, oc.height / 2);
        g.rotate(-Math.PI / 2);
        g.fillText(text, -tw / 2, 0);
      } else {
        g.fillText(text, 4, th / 2);
      }

      var data = g.getImageData(0, 0, oc.width, oc.height).data;
      var ox = Math.round(Math.max(12, (avail - oc.width) / 2 + 14));
      var oy = Math.round(h * 0.5 - oc.height / 2);

      /* Шаг выборки подбираем так, чтобы точек хватило на всю надпись.
         Прореживать готовый список нельзя: выкидывая каждую вторую точку,
         легко разорвать штрих буквы — надпись рассыпается. */
      function sample(step) {
        var out = [];
        for (var y = 0; y < oc.height; y += step) {
          for (var x = 0; x < oc.width; x += step) {
            if (data[(y * oc.width + x) * 4 + 3] > 140) out.push({ x: ox + x, y: oy + y });
          }
        }
        return out;
      }
      /* Цвет у всех точек один, поэтому надпись читается только плотностью:
         внутри букв точки стоят в пять раз чаще, чем в поле. Отсюда и запас
         за краем экрана — на такую плотность соседей не хватает. */
      var step = single ? Math.max(6, Math.round(size / 34)) : 5;
      var out = sample(step);
      while (out.length > 520 && step < 26) { step += 1; out = sample(step); }
      return out;
    }

    function startWord() {
      wordT = 0;
      if (!on || word || document.hidden || G.screen === 'game') { scheduleWord(); return; }
      var text = WORDS[Math.floor(Math.random() * WORDS.length)];
      var targets = wordTargets(text);
      if (!targets || targets.length < 12) { scheduleWord(); return; }

      var cx = 0, cy = 0, j;
      for (j = 0; j < targets.length; j++) { cx += targets[j].x; cy += targets[j].y; }
      cx /= targets.length; cy /= targets.length;

      /* Кандидаты — точки вокруг будущей надписи. Круг растёт до тех пор,
         пока свободных точек не станет заметно больше, чем букв: сначала
         в дело идут ближайшие соседи, а если их не хватает — точки из
         запаса за краем экрана. Так надпись собирается «из окрестности»,
         а не выедает дыру посреди фона. */
      var pool = [], reach = 260;
      while (reach < 1400) {
        pool = [];
        for (j = 0; j < dots.length; j++) {
          var dd = dots[j];
          if (dd.busy) continue;
          var ddx = dd.hx - cx, ddy = dd.hy - cy;
          if (ddx * ddx + ddy * ddy < reach * reach) pool.push(dd);
        }
        if (pool.length > targets.length * 1.35) break;
        reach += 140;
      }
      if (pool.length < targets.length) { scheduleWord(); return; }

      // Буквы разбираем от середины надписи наружу: середина получает
      // самых близких соседей, а тянуться издалека приходится краям.
      targets.sort(function (p1, p2) {
        var d1 = (p1.x - cx) * (p1.x - cx) + (p1.y - cy) * (p1.y - cy);
        var d2 = (p2.x - cx) * (p2.x - cx) + (p2.y - cy) * (p2.y - cy);
        return d1 - d2;
      });

      var used = [], tNow = Date.now();
      for (j = 0; j < targets.length; j++) {
        var best = -1, bestD = Infinity;
        for (var k = 0; k < pool.length; k++) {
          var p = pool[k];
          if (p.busy) continue;
          var ax = p.hx - targets[j].x, ay = p.hy - targets[j].y;
          var dist = ax * ax + ay * ay;
          if (dist < bestD) { bestD = dist; best = k; }
        }
        if (best < 0) break;
        var dot = pool[best];
        dot.busy = true;
        /* Волна от середины наружу: первые точки уже складываются в буквы,
           когда дальние только трогаются с места. Надпись не возникает
           целиком, а проявляется. */
        dot.pend = [targets[j].x, targets[j].y];
        dot.pendAt = tNow + (j / targets.length) * 900 + Math.random() * 120;
        used.push(dot);
      }
      word = used;
      wake();
      /* Надпись собирается около двух секунд (волна плюс сама пружина),
         поэтому и держать её надо дольше: считаем время от начала сборки. */
      wordT = setTimeout(endWord, text.length <= 2 ? 4400 : 5400);
    }

    function endWord() {
      // Слово могло исчезнуть само (смена темы пересобирает поле).
      // Даже в этом случае следующее нужно назначить, иначе надписи
      // пропадут до перезагрузки страницы.
      if (word) {
        /* Расходятся вразнобой: у каждой точки своя задержка в пределах
           полутора секунд. Надпись не исчезает, а тает — сначала в ней
           появляются прорехи, потом остаётся только россыпь. */
        var t0 = Date.now();
        for (var i = 0; i < word.length; i++) {
          var d = word[i];
          d.busy = false;
          d.pend = [d.hx, d.hy];
          d.pendAt = t0 + Math.random() * 1500;
        }
        word = null;
      }
      wake();
      scheduleWord();
    }

    function scheduleWord() {
      clearTimeout(wordT);
      wordT = setTimeout(startWord, 20000 + Math.random() * 25000);
    }

    function pointerMove(e) {
      px = e.clientX; py = e.clientY;
      pointerOn = true;
      lastMove = Date.now();
      wake();
    }

    function pointerOut() { pointerOn = false; wake(); }

    function start() {
      canvas = document.getElementById('dotfield');
      if (!canvas || !canvas.getContext) return;      // тесты и старые браузеры
      ctx = canvas.getContext('2d');
      if (!ctx || !window.requestAnimationFrame) return;
      if (!available()) return;
      on = true;
      document.documentElement.classList.add('dots-live');
      build();
      if (!on) return;

      window.addEventListener('pointermove', pointerMove, { passive: true });
      window.addEventListener('pointerdown', pointerMove, { passive: true });
      document.addEventListener('pointerleave', pointerOut);
      window.addEventListener('blur', pointerOut);
      window.addEventListener('resize', function () {
        clearTimeout(resizeT);
        resizeT = setTimeout(function () {
          if (!available()) { off(); return; }
          if (!on) { start(); return; }
          build();
        }, 200);
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { pointerOn = false; }
        else wake();
      });
      // Тема переключается прямо на <html> — перестраиваем цвета точек.
      if (window.MutationObserver) {
        new MutationObserver(function () { if (on) build(); })
          .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      scheduleWord();
    }

    return { start: start, live: on2 };
  })();

  // Клавиатура: на ПК решения выбираются цифрами, Esc закрывает панель.
  document.addEventListener('keydown', function (e) {
    if (!G.desktop) return;
    if (e.key === 'Escape') {
      var sheet = document.querySelector('.sheet-wrap');
      if (sheet && G.screen !== 'game') return;
    }
    if (/^[1-9]$/.test(e.key)) {
      var buttons = document.querySelectorAll('.sheet-wrap .choice, .sheet-wrap .primary-btn');
      var idx = parseInt(e.key, 10) - 1;
      if (buttons && buttons[idx]) { buttons[idx].click(); e.preventDefault(); }
    }
  });

  // Диплинк ?startapp=sc_<id> — прямой заход в сценарий
  (function () {
    var param = null;
    bridge(function (W) {
      var d = W.initDataUnsafe;
      if (d && d.start_param) param = d.start_param;
    });
    if (!param) {
      var m = /[?&]WebAppStartParam=([^&]+)/.exec(location.search);
      if (m) param = decodeURIComponent(m[1]);
    }
    if (param && /^sc_/.test(param)) {
      var id = param.slice(3).replace(/_/g, '-');
      var sc = C.scenarios.filter(function (x) { return x.id === id; })[0];
      if (sc) { startScenario(sc); return; }
    }
    // Заставка показывается только при обычном заходе: диплинк ведёт прямо в партию.
    renderSplash();
  })();

  // Служебное: платформа в подписи, чтобы при отладке было видно окружение
  document.body.dataset.platform = MaxBridge.platform;

  /*
   * Мост для серверного слоя (max.js). Сам ничего не делает и ничего не
   * меняет: просто открывает доступ к состоянию партии и к источнику
   * таблицы лидеров, чтобы сервер мог проверить партию и подставить общий
   * список результатов. Без max.js игра работает ровно как раньше.
   */
  window.GameBridge = {
    version: 1,
    state: G,
    Leaders: Leaders,
    Store: Store,
    Max: MaxBridge,
    Content: C,
    Engine: E
  };

  DotField.start();
})();
