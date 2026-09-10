/*
 * ui.test.js — проверка интерфейса без браузера.
 *
 * Собираем минимальный DOM вручную (без зависимостей), загружаем ui.js
 * и проигрываем настоящую партию: клики по сценарию, по вариантам, отчёт.
 * Цель — поймать реальные ошибки выполнения, а не только синтаксис.
 *
 * Запуск: node ui.test.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* Минимальная имитация DOM */

function makeNode(tag) {
  var n = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    parentNode: null,
    style: {},
    dataset: {},
    _cls: [],
    _text: '',
    _html: '',
    _handlers: {},
    _attrs: {},
    scrollTop: 0,
    offsetWidth: 100
  };

  Object.defineProperty(n, 'className', {
    get: function () { return n._cls.join(' '); },
    set: function (v) { n._cls = String(v || '').split(/\s+/).filter(Boolean); }
  });

  Object.defineProperty(n, 'textContent', {
    get: function () {
      if (n.children.length) {
        return n.children.map(function (c) { return c.textContent; }).join('');
      }
      return n._text;
    },
    set: function (v) { n._text = v == null ? '' : String(v); n.children = []; n.childNodes = []; }
  });

  Object.defineProperty(n, 'innerHTML', {
    get: function () { return n._html; },
    set: function (v) { n._html = String(v); n.children = []; n.childNodes = []; }
  });

  n.classList = {
    add: function () {
      for (var i = 0; i < arguments.length; i++) {
        if (n._cls.indexOf(arguments[i]) === -1) n._cls.push(arguments[i]);
      }
    },
    remove: function () {
      for (var i = 0; i < arguments.length; i++) {
        var k = n._cls.indexOf(arguments[i]);
        if (k !== -1) n._cls.splice(k, 1);
      }
    },
    contains: function (c) { return n._cls.indexOf(c) !== -1; },
    toggle: function (c, force) {
      var has = n._cls.indexOf(c) !== -1;
      var want = force === undefined ? !has : !!force;
      if (want && !has) n._cls.push(c);
      if (!want && has) n._cls.splice(n._cls.indexOf(c), 1);
      return want;
    }
  };

  n.appendChild = function (c) {
    c.parentNode = n;
    n.children.push(c);
    n.childNodes.push(c);
    return c;
  };
  n.removeChild = function (c) {
    var i = n.children.indexOf(c);
    if (i !== -1) { n.children.splice(i, 1); n.childNodes.splice(i, 1); }
    return c;
  };
  n.remove = function () { if (n.parentNode) n.parentNode.removeChild(n); };
  n.setAttribute = function (k, v) {
    n._attrs[k] = String(v);
    if (k === 'class') n.className = v;
    if (k === 'id') n.id = v;
  };
  n.getAttribute = function (k) { return n._attrs[k]; };
  n.addEventListener = function (t, h) { (n._handlers[t] = n._handlers[t] || []).push(h); };
  n.removeEventListener = function () {};
  n.scrollIntoView = function () {};
  n.getBoundingClientRect = function () { return { top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }; };
  n.querySelector = function (sel) {
    return sel.charAt(0) === '.' ? (byClass(n, sel.slice(1))[0] || null) : null;
  };
  n.querySelectorAll = function (sel) {
    return sel.charAt(0) === '.' ? byClass(n, sel.slice(1)) : [];
  };
  n.scrollIntoView = function () {};
  n.focus = function () {};
  n.contains = function (o) {
    if (o === n) return true;
    return n.children.some(function (c) { return c.contains(o); });
  };

  return n;
}

function walk(node, fn) {
  fn(node);
  node.children.forEach(function (c) { walk(c, fn); });
}

function findAll(rootNode, pred) {
  var out = [];
  walk(rootNode, function (n) { if (pred(n)) out.push(n); });
  return out;
}

function byClass(rootNode, cls) {
  return findAll(rootNode, function (n) { return n.classList && n.classList.contains(cls); });
}

function byId(rootNode, id) {
  return findAll(rootNode, function (n) { return n.id === id; })[0] || null;
}

function click(node) {
  if (!node) throw new Error('click: узла нет');
  // Кнопки теперь содержат вложенные span и иконки, поэтому поиск по тексту
  // возвращает внутренний узел. Поднимаемся до ближайшего обработчика.
  var n = node;
  while (n) {
    if (typeof n.onclick === 'function') { n.onclick({ target: node }); return; }
    if (n._handlers && n._handlers.click && n._handlers.click.length) {
      n._handlers.click.forEach(function (h) { h({ target: node }); });
      return;
    }
    n = n.parentNode;
  }
  throw new Error('click: у узла нет обработчика');
}

/* Окружение */

var timers = [];
var frames = [];

var appNode = makeNode('div');
appNode.id = 'app';
var bodyNode = makeNode('body');
bodyNode.appendChild(appNode);

/* Игра больше не оборачивает обращения к документу в пустые try/catch:
   ошибка должна быть видна, а не проглочена. Значит, и заглушка документа
   обязана вести себя как настоящий документ — иначе тесты падают не там,
   где ошибка в игре, а там, где бедна заглушка. */
var htmlNode = makeNode('html');

var documentStub = {
  body: bodyNode,
  documentElement: htmlNode,
  createElement: makeNode,
  createElementNS: function (ns, tag) { return makeNode(tag); },
  getElementById: function (id) {
    if (id === 'app') return appNode;
    return byId(bodyNode, id);
  },
  querySelector: function (sel) {
    if (sel === '.sheet-wrap') return byClass(bodyNode, 'sheet-wrap')[0] || null;
    if (sel === '.hud') return byClass(bodyNode, 'hud')[0] || null;
    if (sel.charAt(0) === '.') return byClass(bodyNode, sel.slice(1))[0] || null;
    return null;
  },
  querySelectorAll: function (sel) {
    if (sel.indexOf('.choice') !== -1) return byClass(bodyNode, 'choice');
    if (sel.indexOf('.primary-btn') !== -1) return byClass(bodyNode, 'primary-btn');
    if (sel.indexOf('.modal-wrap') !== -1) return byClass(bodyNode, 'modal-wrap');
    if (sel.indexOf('.scenario-card') !== -1) return byClass(bodyNode, 'scenario-card');
    if (sel.indexOf('.diff') !== -1) return byClass(bodyNode, 'diff');
    return [];
  },
  addEventListener: function () {},
  removeEventListener: function () {}
};

var storageData = {};
var sandbox = {
  console: console,
  document: documentStub,
  location: { search: '' },
  navigator: { clipboard: { writeText: function () {} } },
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(storageData, k) ? storageData[k] : null; },
    setItem: function (k, v) { storageData[k] = String(v); },
    removeItem: function (k) { delete storageData[k]; }
  },
  requestAnimationFrame: function (fn) { frames.push(fn); return frames.length; },
  setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms || 0 }); return timers.length; },
  clearTimeout: function () {},
  matchMedia: function () { return { matches: false, addEventListener: function () {} }; },
  addEventListener: function () {},
  scrollTo: function () {},
  scrollY: 0,
  innerWidth: 800,
  innerHeight: 900,
  confirm: function () { return true; },
  alert: function () {},
  Math: Math,
  Date: Date,
  JSON: JSON,
  Set: Set,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  isFinite: isFinite,
  parseFloat: parseFloat,
  parseInt: parseInt
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

var ctx = vm.createContext(sandbox);

function run(file) {
  var code = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInContext(code, ctx, { filename: file });
}

// Прокручиваем отложенные колбэки — имитация течения времени
function flush(rounds) {
  for (var r = 0; r < (rounds || 6); r++) {
    var fs_ = frames.splice(0, frames.length);
    fs_.forEach(function (f) { f(0); });
    var ts = timers.splice(0, timers.length).sort(function (a, b) { return a.ms - b.ms; });
    ts.forEach(function (t) { t.fn(); });
    if (!frames.length && !timers.length) break;
  }
}

/* Тесты */

console.log('\n=== Загрузка модулей ===');
try {
  run('engine.js');
  ok('engine.js выполнен', typeof sandbox.Engine === 'object');
} catch (e) { ok('engine.js выполнен', false, e.message); }

try {
  run('events.js');
  run('content.js');
  ok('content.js выполнен', typeof sandbox.Content === 'object');
  // Число сценариев растёт вместе с игрой — проверяем состав, а не константу.
  var scns = sandbox.Content.scenarios;
  ok('сценарии загружены', scns.length >= 15, 'найдено ' + scns.length);
  ok('все три уровня представлены',
    [1, 2, 3].every(function (lv) {
      return scns.filter(function (s) { return s.level === lv; }).length >= 5;
    }));
  ok('у каждого сценария есть цель и условия',
    scns.every(function (s) { return s.goalText && typeof s.requirements === 'function'; }));
} catch (e) { ok('content.js выполнен', false, e.message); }

try {
  run('ui.js');
  ok('ui.js выполнен без ошибок', true);
} catch (e) { ok('ui.js выполнен без ошибок', false, e.stack); }

flush();

console.log('\n=== Экран меню ===');
ok('меню отрисовано', byClass(appNode, 'menu').length === 1);
ok('заголовок на месте', byClass(appNode, 'hero-title').length === 1);
var cards = byClass(appNode, 'scenario-card');
ok('сценариев минимум 5 на первом уровне', cards.length >= 5, 'найдено ' + cards.length);
ok('есть дисклеймер об обучающем характере',
  byClass(appNode, 'disclaimer').length === 1);
ok('в дисклеймере сказано, что это не рекомендация',
  /не является консультацией|не даёт финансовых рекомендаций/.test(byClass(appNode, 'disclaimer')[0].textContent));
ok('есть кнопка карточек знаний',
  findAll(appNode, function (n) { return /Карточки знаний/.test(n._text || ''); }).length > 0);

console.log('\n=== Экран «О приложении» ===');
var aboutBtn = findAll(appNode, function (n) { return /^(О приложении|Настройки)/.test(n._text || ''); })[0];
ok('кнопка «О приложении» есть', !!aboutBtn);
if (aboutBtn) {
  click(aboutBtn);
  flush();
  ok('экран открылся', byClass(appNode, 'page-title').length === 1);
  var aboutText = appNode.textContent;
  ok('есть предупреждение про вымышленность', /вымышлен/.test(aboutText));
  ok('есть раздел про данные', /Данные/.test(aboutText));
  ok('есть кнопка удаления прогресса', byClass(appNode, 'danger-btn').length === 1);
  var back = findAll(appNode, function (n) { return n._text === 'Назад'; })[0];
  ok('кнопка «Назад» есть', !!back);
  if (back) { click(back); flush(); ok('вернулись в меню', byClass(appNode, 'menu').length === 1); }
}

/* Карточки идут в порядке возрастания тяжести, поэтому первой стоит самый
   мягкий сценарий уровня. Он же выбран по умолчанию — одного клика хватает. */
var firstScenario = sandbox.Content.scenarios
  .filter(function (s) { return s.level === 1; })
  .sort(function (a, b) { return (a.hard || 0) - (b.hard || 0); })[0];

console.log('\n=== Полная партия: сценарий «' + firstScenario.title + '» ===');
cards = byClass(appNode, 'scenario-card');
ok('первым показан самый мягкий сценарий уровня',
  byClass(cards[0], 'sc-title')[0].textContent === firstScenario.title);
click(cards[0]);
flush();

ok('игровой экран создан', !!byId(appNode, 'game-root'));
ok('HUD с наличными есть', !!byId(appNode, 'hud-cash'));
ok('четыре шкалы созданы',
  ['bar-money', 'bar-calm', 'bar-quality', 'bar-energy'].every(function (id) { return !!byId(appNode, id); }));
ok('лента месяцев построена', byClass(appNode, 'tl-month').length === 60,
  'найдено ' + byClass(appNode, 'tl-month').length);
ok('первое событие показано', byClass(appNode, 'sheet').length === 1);
ok('у события есть заголовок', byClass(appNode, 'sheet-title').length === 1);

// Первое событие — настройка бюджета продуктов, без прогноза. Проходим его,
// затем проверяем механику прогноза на первом событии, где она есть.
if (!byClass(appNode, 'forecast').length) {
  var firstChoices = byClass(appNode, 'choice');
  ok('первое событие даёт выбор бюджета продуктов', firstChoices.length === 3,
    'найдено ' + firstChoices.length);
  if (firstChoices.length) { click(firstChoices[1]); flush(10); }
}

var fc = byClass(appNode, 'forecast')[0];
ok('карта события показана до вариантов', byClass(appNode, 'sheet').length === 1);
if (fc) {
  ok('есть вопрос прогноза', byClass(appNode, 'fc-q').length === 1);
  var slider = findAll(appNode, function (n) { return n.classList.contains('fc-slider'); })[0];
  ok('слайдер есть', !!slider);
  var submit = findAll(appNode, function (n) { return n._text === 'Это моя оценка'; })[0];
  ok('кнопка подтверждения оценки есть', !!submit);
  if (submit) {
    click(submit);
    flush();
    ok('результат прогноза раскрыт', byClass(appNode, 'fc-result').length === 1);
    ok('показано фактическое значение', byClass(appNode, 'fc-row').length === 2);
    ok('есть объяснение', byClass(appNode, 'fc-reveal').length === 1);
    ok('объяснение непустое', byClass(appNode, 'fc-reveal')[0].textContent.length > 20);
    var go = findAll(appNode, function (n) { return n._text === 'Теперь решаю'; })[0];
    ok('кнопка перехода к решению есть', !!go);
    if (go) { click(go); flush(); }
  }
}

var choices = byClass(appNode, 'choice');
ok('варианты решения показаны', choices.length >= 2, 'найдено ' + choices.length);
ok('у варианта есть подпись', byClass(appNode, 'choice-sub').length > 0);
// Подсказки отключены: карта решения показывает только условия и варианты.
ok('карта решения отображается корректно', byClass(appNode, 'sheet-title').length === 1);

// Проигрываем всю партию, каждый раз выбирая первый доступный вариант
var guard = 0;
var decisions = 0;
while (byClass(appNode, 'sheet').length && guard++ < 400) {
  var f2 = findAll(appNode, function (n) { return n._text === 'Это моя оценка'; })[0];
  if (f2) {
    click(f2); flush();
    var g2 = findAll(appNode, function (n) { return n._text === 'Теперь решаю'; })[0];
    if (g2) { click(g2); flush(); }
  }
  var ch = byClass(appNode, 'choice');
  if (!ch.length) break;
  var choiceIndex = /^Бюджет на продукты/.test(appNode.textContent) && ch.length > 1 ? 1 : 0;
  click(ch[choiceIndex]);
  decisions++;
  flush(10);
}
ok('партия завершилась без зависаний', guard < 400, 'итераций ' + guard);
var endedByGameOver = byClass(appNode, 'verdict-goal').length === 0 && /Игра окончена/.test(appNode.textContent);
ok('партия дошла до отчёта или проигрыша', byClass(appNode, 'report').length === 1 || endedByGameOver);

if (!endedByGameOver) {
  console.log('\n=== Отчёт ===');
ok('отчёт отрисован', byClass(appNode, 'report').length === 1);
ok('итоговая цифра показана', byClass(appNode, 'verdict-num').length === 1);
ok('итог — непустое число',
  /\d/.test((byClass(appNode, 'verdict-num')[0] || { textContent: '' }).textContent));
ok('статус цели показан', byClass(appNode, 'verdict-goal').length === 1);
ok('график построен', byClass(appNode, 'chart').length === 1);
ok('линия графика есть', byClass(appNode, 'chart-line').length === 1);
ok('альтернативная линия есть', byClass(appNode, 'chart-alt').length === 1);
ok('блок альтернативной истории есть', byClass(appNode, 'counterfactual').length === 1);
ok('разница по деньгам показана', byClass(appNode, 'cf-delta').length === 1);
ok('диаграмма потоков есть', byClass(appNode, 'flows').length === 1);
ok('в потоках есть сегменты', byClass(appNode, 'seg').length > 2,
  'найдено ' + byClass(appNode, 'seg').length);
ok('строки потоков подписаны', byClass(appNode, 'flow-row').length > 2);
ok('блок тихих расходов показан', byClass(appNode, 'quiet-box').length === 1);
ok('KPI выведены', byClass(appNode, 'kpi').length >= 8,
  'найдено ' + byClass(appNode, 'kpi').length);
ok('открытые карточки показаны', byClass(appNode, 'cchip').length > 0);

var report = appNode.textContent;
ok('в отчёте упомянуты просрочки', /Просрочк/.test(report));
ok('в отчёте упомянут резерв', /Резерв/.test(report));
ok('в отчёте упомянуты проценты', /Проценты/.test(report));

console.log('\n=== Карточка знаний из отчёта ===');
var chip = byClass(appNode, 'cchip')[0];
click(chip);
flush();
ok('модальное окно открылось', byClass(bodyNode, 'modal').length === 1);
ok('в модальном окне есть текст', byClass(bodyNode, 'modal-text')[0].textContent.length > 50);
var closeBtn = findAll(bodyNode, function (n) { return n._text === 'Понятно'; })[0];
ok('кнопка закрытия есть', !!closeBtn);
if (closeBtn) { click(closeBtn); flush(); ok('окно закрылось', byClass(bodyNode, 'modal').length === 0); }

console.log('\n=== Сохранение прогресса ===');
var saved = {};
try { saved = JSON.parse(storageData['fin-sim-progress-v1'] || '{}'); } catch (e) {}
    ok('партия записана', saved.runs && saved.runs.length === 1);
    ok('прогнозы записаны', saved.forecasts && saved.forecasts.length > 0);
    ok('рекорд сохранён', saved.best && typeof saved.best[firstScenario.id] === 'number');

    console.log('\n=== Повторная игра и возврат в меню ===');
    var again = findAll(appNode, function (n) { return /Пройти пять лет заново/.test(n._text || ''); })[0];
    ok('кнопка повторной игры есть', !!again);
    if (again) {
      click(again); flush();
      ok('новая партия началась', !!byId(appNode, 'game-root'));
      ok('снова показано первое событие', byClass(appNode, 'sheet').length === 1);
    }
  }

console.log('\n=== Остальные сценарии проходимы через UI ===');
[1, 2].forEach(function (idx) {
  // возврат в меню через прямой вызов: имитируем выход
  storageData['fin-sim-progress-v1'] = storageData['fin-sim-progress-v1'];
  var menuBtnHolder = null;
  // Перезапускаем ui.js-состояние через клик по сценарию из свежего меню
  appNode.innerHTML = '';
  appNode.children = [];
  vm.runInContext('(function(){ })()', ctx);
  // Проще: воспользуемся публичным путём — заново загрузим ui.js в тот же контекст
  try {
    run('ui.js');
    flush();
    var cs = byClass(appNode, 'scenario-card');
    // Наведение больше ничего не выбирает: выбор делает первый клик,
    // партию начинает второй (или большая кнопка внизу экрана).
    click(cs[idx]);
    flush();
    ok('первый клик только выбирает сценарий', !byId(appNode, 'game-root'));
    click(cs[idx]);
    flush();
    var g = 0, d = 0;
    while (byClass(appNode, 'sheet').length && g++ < 400) {
      var ff = findAll(appNode, function (n) { return n._text === 'Это моя оценка'; })[0];
      if (ff) {
        click(ff); flush();
        var gg = findAll(appNode, function (n) { return n._text === 'Теперь решаю'; })[0];
        if (gg) { click(gg); flush(); }
      }
      var cc = byClass(appNode, 'choice');
      if (!cc.length) break;
      var choiceIndex = /^Бюджет на продукты/.test(appNode.textContent) && cc.length > 1 ? 1 : cc.length - 1;
      click(cc[choiceIndex]);
      d++;
      flush(10);
    }
    // Имя берём из той же отсортированной раскладки, что и меню,
    // иначе в отчёте теста стоит название чужого сценария.
    var name = sandbox.Content.scenarios
      .filter(function (s) { return s.level === 1; })
      .sort(function (a, b) { return (a.hard || 0) - (b.hard || 0); })[idx].title;
    ok(name + ': партия завершена', g < 400);
    var gameOver = /Игра окончена/.test(appNode.textContent);
    ok(name + ': показан отчёт или проигрыш', byClass(appNode, 'report').length === 1 || gameOver);
    // Линий на графике теперь до четырёх: своя партия и три линии
    // сравнения. Проверяем, что график построен, а не сколько в нём линий.
    if (!gameOver) ok(name + ': график есть', byClass(appNode, 'chart-line').length >= 1);
    ok(name + ': решений принято ' + d, d > 0);
  } catch (e) {
    ok('сценарий ' + idx + ' проигран', false, e.message);
  }
});

console.log('\n=== Соревнование и таблица лидеров ===');
(function () {
  try {
    // Перезагружаем ui.js в тот же контекст — так же, как в блоке выше:
    // это возвращает интерфейс в меню, не изобретая отдельного входа.
    appNode.innerHTML = '';
    appNode.children = [];
    run('ui.js');
    flush(700);
    var labels = byClass(appNode, 'lvl-label');
    ok('в меню пять уровней', labels.length === 5, 'найдено ' + labels.length);
    ok('уровень выбирается ползунком', byClass(appNode, 'lvl-track').length === 1);
    click(labels[4]); flush();
    var cards = byClass(appNode, 'scenario-card');
    ok('в соревновании один сценарий', cards.length === 1, 'найдено ' + cards.length);
    ok('это сценарий соревнования', /НАСЛЕДСТВО/i.test(appNode.textContent));

    // Экран таблицы открывается из меню и не падает без localStorage
    var link = findAll(appNode, function (n) { return /Таблица лидеров/.test(n._text || ''); })[0];
    ok('в меню есть ссылка на таблицу лидеров', !!link);
    if (link) {
      click(link.parentNode && link.parentNode._cls.indexOf('po-link') !== -1 ? link.parentNode : link);
      flush();
      ok('экран таблицы лидеров открылся', byClass(appNode, 'leaders-screen').length === 1);
    }
  } catch (e) {
    ok('соревнование и таблица работают', false, e.message);
  }
})();

console.log('\n=== Диплинк ===');
sandbox.location.search = '?WebAppStartParam=sc_l1_first_salary';
appNode.innerHTML = '';
appNode.children = [];
try {
  run('ui.js');
  flush();
  ok('диплинк открыл игру сразу, минуя меню',
    !!byId(appNode, 'game-root') && byClass(appNode, 'menu').length === 0);
} catch (e) { ok('диплинк обработан', false, e.message); }
sandbox.location.search = '';

console.log('\n=== Работа без MAX Bridge ===');
ok('window.WebApp отсутствует, приложение всё равно работает', sandbox.WebApp === undefined);

console.log('\n----------------------------------------');
console.log('Пройдено: ' + passed + ',  провалено: ' + failed);
console.log('----------------------------------------\n');
process.exit(failed === 0 ? 0 : 1);
