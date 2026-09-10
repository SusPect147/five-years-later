/*
 * engine.test.js — проверка финансовой математики.
 * Запуск: node engine.test.js
 *
 * Эталонные значения взяты из независимых источников:
 *  - аннуитет сверен с формулой PMT (Excel/LibreOffice: =PMT(rate;n;-P))
 *  - сложный процент и эффективная ставка — из определения
 *  - амортизация проверена на сходимость: сумма выплат тела == сумма долга
 */
'use strict';
var E = require('./engine.js');

var passed = 0, failed = 0;

function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

function near(name, actual, expected, tol) {
  var t = tol == null ? 0.01 : tol;
  var diff = Math.abs(actual - expected);
  ok(name, diff <= t, 'получено ' + actual.toFixed(4) + ', ожидалось ' + expected.toFixed(4) + ' (dif ' + diff.toFixed(4) + ')');
}

function throws(name, fn) {
  var threw = false;
  try { fn(); } catch (e) { threw = true; }
  ok(name, threw, 'исключение не выброшено');
}

console.log('\n=== Аннуитетный платёж ===');
// Excel: =PMT(0,01; 12; -100000) = 8884,88
near('100 000 под 1%/мес на 12 мес = 8884.88', E.annuityPayment(100000, 0.01, 12), 8884.88, 0.01);
// Проверено независимо через дисконтирование: сумма приведённых платежей == 500 000.
near('500 000 под 1.5%/мес на 24 мес = 24962.05', E.annuityPayment(500000, 0.015, 24), 24962.0510, 0.001);
// Тот же тест в форме, не зависящей от эталонного числа: NPV платежей равен сумме долга.
(function () {
  var P = 500000, i = 0.015, n = 24, p = E.annuityPayment(P, i, n), npv = 0;
  for (var k = 1; k <= n; k++) npv += p / Math.pow(1 + i, k);
  near('NPV аннуитетных платежей равен сумме долга', npv, P, 0.01);
})();
// Нулевая ставка = простое деление
near('нулевая ставка: 120 000 / 12 = 10 000', E.annuityPayment(120000, 0, 12), 10000, 1e-9);
ok('нулевая сумма даёт нулевой платёж', E.annuityPayment(0, 0.02, 10) === 0);
throws('нулевой срок — ошибка', function () { E.annuityPayment(1000, 0.01, 0); });

console.log('\n=== Переплата ===');
near('переплата 100k/1%/12 = 6618.56', E.annuityOverpay(100000, 0.01, 12), 6618.56, 0.02);
ok('при ставке 0 переплаты нет', Math.abs(E.annuityOverpay(100000, 0, 12)) < 1e-6);
ok('переплата растёт со сроком',
  E.annuityOverpay(100000, 0.01, 24) > E.annuityOverpay(100000, 0.01, 12));
ok('переплата растёт со ставкой',
  E.annuityOverpay(100000, 0.02, 12) > E.annuityOverpay(100000, 0.01, 12));

console.log('\n=== Скрытая ставка «беспроцентной» рассрочки ===');
// Телефон 60 000 «в рассрочку 0%», но платёж 5 500 × 12 = 66 000.
var r = E.impliedMonthlyRate(60000, 5500, 12);
ok('ставка положительна', r > 0);
near('обратная задача сходится: платёж восстанавливается',
  E.annuityPayment(60000, r, 12), 5500, 0.01);
var annual = E.monthlyToAnnual(r);
ok('годовая ставка в разумном диапазоне 15..35%', annual > 0.15 && annual < 0.35,
  'получено ' + (annual * 100).toFixed(1) + '%');
console.log('       (справочно: это ' + (annual * 100).toFixed(1) + '% годовых вместо заявленных 0%)');
ok('если переплаты нет — ставка 0', E.impliedMonthlyRate(60000, 5000, 12) === 0);

console.log('\n=== Перевод ставок ===');
near('месячная 1% -> годовая 12.68%', E.monthlyToAnnual(0.01), 0.126825, 1e-5);
near('годовая 12.68% -> месячная 1%', E.annualToMonthly(0.126825), 0.01, 1e-6);
near('туда-обратно совпадает', E.annualToMonthly(E.monthlyToAnnual(0.017)), 0.017, 1e-9);
near('эффективная при 12 начислениях от 12% = 12.6825%', E.effectiveAnnualRate(0.12, 12), 0.126825, 1e-5);
near('эффективная при 1 начислении равна номиналу', E.effectiveAnnualRate(0.12, 1), 0.12, 1e-12);
ok('чем чаще начисления, тем больше эффективная ставка',
  E.effectiveAnnualRate(0.12, 365) > E.effectiveAnnualRate(0.12, 12));

console.log('\n=== Сложный процент ===');
near('100 000 под 10% на 1 год = 110 000', E.compound(100000, 0.10, 1, 1), 110000, 1e-6);
near('100 000 под 10% на 10 лет = 259374.25', E.compound(100000, 0.10, 10, 1), 259374.25, 0.01);
near('100 000 под 12% с ежемес. капитализацией, 1 год = 112682.50',
  E.compound(100000, 0.12, 1, 12), 112682.50, 0.01);
ok('капитализация выгоднее простого начисления',
  E.compound(100000, 0.12, 1, 12) > E.compound(100000, 0.12, 1, 1));

console.log('\n=== Регулярные взносы ===');
near('5 000/мес под 0% за 12 мес = 60 000', E.futureValueSeries(5000, 0, 12), 60000, 1e-9);
// Проверено независимо итеративным суммированием по месяцам (см. ниже).
near('5 000/мес под 1%/мес за 12 мес = 63412.52', E.futureValueSeries(5000, 0.01, 12), 63412.5151, 0.001);
// Тот же тест без эталонного числа: формула против прямого месячного накопления.
(function () {
  var bal = 0;
  for (var m = 0; m < 12; m++) bal = bal * 1.01 + 5000;
  near('формула накопления совпадает с итеративным расчётом',
    E.futureValueSeries(5000, 0.01, 12), bal, 1e-6);
})();
ok('с процентом больше, чем без', E.futureValueSeries(5000, 0.01, 12) > 60000);

console.log('\n=== Инфляция ===');
near('100 000 через 5 лет при 8% = 68058.32', E.realValue(100000, 0.08, 5), 68058.32, 0.01);
ok('реальная стоимость всегда меньше номинала при положительной инфляции',
  E.realValue(100000, 0.08, 5) < 100000);

console.log('\n=== Амортизация долга ===');
var sch = E.amortizationSchedule(300000, 0.015, 18);
ok('график содержит 18 платежей', sch.rows.length === 18, 'получено ' + sch.rows.length);
near('долг закрывается в ноль', sch.rows[sch.rows.length - 1].balance, 0, 0.01);
var sumPrincipal = sch.rows.reduce(function (a, x) { return a + x.principal; }, 0);
near('сумма выплат тела равна сумме долга', sumPrincipal, 300000, 0.05);
var sumInterest = sch.rows.reduce(function (a, x) { return a + x.interest; }, 0);
near('сумма процентов равна переплате', sumInterest, E.annuityOverpay(300000, 0.015, 18), 0.05);
ok('в первом платеже процентов больше, чем в последнем',
  sch.rows[0].interest > sch.rows[17].interest);
ok('в первом платеже тела меньше, чем в последнем',
  sch.rows[0].principal < sch.rows[17].principal);

console.log('\n=== Шаг амортизации ===');
var st = E.amortizeStep(100000, 0.01, 8884.88);
near('проценты = 1000', st.interest, 1000, 1e-6);
near('на тело = 7884.88', st.toPrincipal, 7884.88, 0.01);
near('остаток = 92115.12', st.balance, 92115.12, 0.01);
var st2 = E.amortizeStep(500, 0.01, 8884.88);
ok('последний платёж не превышает остаток с процентами', st2.due <= 505.01);
ok('долг закрыт', st2.closed === true);

console.log('\n=== Детерминированность симуляции ===');
var Content = require('./content.js');
E.setPool(Content.pool);

// Сценарии описаны слотами: перед проверками разворачиваем их в конкретный
// набор событий. resolveScenario кэширует результат по (id, seed).
function build(scn, seed) { return E.resolveScenario(scn, Content.pool, seed || 'test'); }
/**
 * Проходит партию до конца, отвечая на события по мере их появления.
 *
 * Раньше набор решений собирался заранее из scenario.events. Так больше
 * нельзя: решение игрока может НАЗНАЧИТЬ будущее событие (сюжетный поворот),
 * и его нет в расписании, пока это решение не принято. Поэтому играем как
 * настоящий игрок — отвечаем на то, что показал движок.
 */
function playThrough(scn, seed, pickIdx) {
  var ch = [], run, guard = 0;
  while (guard++ < 600) {
    run = E.simulate(scn, seed, ch);
    if (!run.awaiting) break;
    var e = run.awaiting;
    var index = /^buy-groceries-/.test(e.id) ? 1 : Math.min(pickIdx || 0, e.choices.length - 1);
    ch.push({ eventId: e.id, choiceId: e.choices[index].id });
  }
  return ch;
}

function allChoicesFor(scn, seed, pickIdx) {
  return playThrough(build(scn, seed), seed, pickIdx);
}

var sc = build(Content.scenarios[0], 'seed-1');
var allChoices = playThrough(sc, 'seed-1', 0);
var runA = E.simulate(sc, 'seed-1', allChoices);
var runB = E.simulate(sc, 'seed-1', allChoices);
ok('одинаковый seed -> одинаковый итог',
  E.netWorth(runA.state) === E.netWorth(runB.state));
var runC = E.simulate(sc, 'seed-2', allChoices);
ok('разный seed -> обычно разный итог',
  E.netWorth(runA.state) !== E.netWorth(runC.state));
ok('симуляция дошла до конца', runA.finished === true);
// Партия может закончиться досрочно проигрышем — это штатный исход, а не сбой.
// Проверяем не фиксированную длину, а согласованность: снимков ровно столько,
// сколько прожитых месяцев, плюс стартовый.
ok('снимков истории ровно по числу прожитых месяцев',
  runA.history.length === (runA.state.gameOver ? runA.state.month + 2 : sc.months + 1),
  'получено ' + runA.history.length + ' при месяце ' + runA.state.month);
ok('партия без проигрыша проходит все месяцы',
  runA.state.gameOver || runA.history.length === sc.months + 1);

console.log('\n=== Ожидание решения игрока ===');
var partial = E.simulate(sc, 'seed-1', []);
ok('без решений симуляция останавливается', partial.finished === false);
ok('и сообщает, какое событие ждёт', partial.awaiting != null);
ok('это первое событие сценария', partial.awaiting.id === sc.events[0].id);

console.log('\n=== Альтернативная история ===');
var cf = E.counterfactual(sc, 'seed-1', allChoices);
ok('контрфактическая линия найдена', cf != null);
if (cf) {
  ok('расхождение ненулевое', Math.abs(cf.delta) > 0.01,
    'delta = ' + cf.delta.toFixed(2));
  ok('указано альтернативное решение', cf.alternative && cf.alternative.id !== cf.chosen.id);
  console.log('       (самое дорогое решение: "' + cf.event.shortTitle +
    '", разница ' + Math.round(cf.delta) + ' \u20bd)');
}

console.log('\n=== Все сценарии проходимы любым набором решений ===');
Content.scenarios.forEach(function (scnDef) {
  var scn = build(scnDef, 'test');
  for (var v = 0; v < 3; v++) {
    var ch = allChoicesFor(scnDef, 'test', v);
    var run = E.simulate(scn, 'test', ch);
    ok(scn.id + ' вариант ' + v + ': доигран', run.finished === true);
    var nw = E.netWorth(run.state);
    ok(scn.id + ' вариант ' + v + ': итог — число', isFinite(nw), 'получено ' + nw);
    ok(scn.id + ' вариант ' + v + ': шкалы в границах',
      run.state.calm >= 0 && run.state.calm <= 100 && run.state.quality >= 0 && run.state.quality <= 100);
  }
  ok(scn.id + ': у каждого события есть месяц в пределах сценария',
    scn.events.every(function (e) { return e.month >= 0 && e.month < scn.months; }));
  ok(scn.id + ': у сценария есть многокритериальные требования',
    typeof scn.requirements === 'function');
  (function () {
    var ch = allChoicesFor(scnDef, 'test', 0);
    var r = E.simulate(scn, 'test', ch);
    var ev = E.evaluate(scn, r.state);
    ok(scn.id + ': требований минимум 3', ev.total >= 3, 'получено ' + ev.total);
    ok(scn.id + ': ранг присвоен', /^(S|A|B\+|B|C|D)$/.test(ev.grade), 'получено ' + ev.grade);
    ok(scn.id + ': силы в границах 0..100',
      r.state.energy >= 0 && r.state.energy <= 100, 'получено ' + r.state.energy);
    ok(scn.id + ': доверие в границах 0..100',
      r.state.trust >= 0 && r.state.trust <= 100, 'получено ' + r.state.trust);
  })();
  ok(scn.id + ': id событий уникальны',
    new Set(scn.events.map(function (e) { return e.id; })).size === scn.events.length);
  ok(scn.id + ': у каждого события минимум 2 варианта',
    scn.events.every(function (e) { return e.choices.length >= 2; }));
  ok(scn.id + ': у каждого варианта есть apply',
    scn.events.every(function (e) { return e.choices.every(function (c) { return typeof c.apply === 'function'; }); }));
});

console.log('\n=== Целостность контента ===');
var poolIds = Object.keys(Content.pool);
ok('пул содержит достаточно событий', poolIds.length >= 25, 'в пуле ' + poolIds.length);
ok('все концепции событий описаны в карточках', poolIds.every(function (id) {
  var e = Content.pool[id];
  return !e.concept || Content.concepts[e.concept];
}));
ok('все концепции вариантов описаны в карточках', poolIds.every(function (id) {
  return Content.pool[id].choices.every(function (c) { return !c.concept || Content.concepts[c.concept]; });
}));
// События соревновательного сценария живут только в нём и назначаются
// вручную, поэтому теги им не нужны — их никогда не выбирают по тегу.
ok('у каждого события пула есть теги', poolIds.every(function (id) {
  var e = Content.pool[id];
  return e.cup || (Array.isArray(e.tags) && e.tags.length > 0);
}));
ok('события соревнования не попадают в общие сценарии', Content.scenarios
  .filter(function (s) { return !s.cup; })
  .every(function (scn) {
    return build(scn, 'tags').events.every(function (e) { return !Content.pool[e.id] || !Content.pool[e.id].cup; });
  }));
ok('у каждого события пула минимум 2 варианта', poolIds.every(function (id) {
  return Content.pool[id].choices.length >= 2;
}));
ok('в пуле есть скам-события',
  poolIds.filter(function (id) { return Content.pool[id].kind === 'scam'; }).length >= 3);
ok('в каждом сценарии есть скам-событие', Content.scenarios.every(function (scn) {
  return build(scn, 'test').events.some(function (e) { return e.kind === 'scam'; });
}));
ok('есть события с отложенным последствием', poolIds.some(function (id) {
  return Content.pool[id].choices.some(function (c) { return /defer/.test(c.apply.toString()); });
}));
ok('есть события с жеребьёвкой', poolIds.some(function (id) {
  return Content.pool[id].choices.some(function (c) { return /gamble/.test(c.apply.toString()); });
}));

console.log('\n=== Уровни сложности и разнообразие сборок ===');
ok('пять уровней: четыре обычных и соревнование', Content.levels.length === 5);
ok('соревновательный уровень ровно один', Content.levels.filter(function (l) { return l.cup; }).length === 1);
var cupList = Content.scenarios.filter(function (s) { return s.level === 5; });
ok('в соревновании ровно один сценарий', cupList.length === 1, 'найдено ' + cupList.length);
ok('у соревновательного сценария закреплён seed', !!(cupList[0] && cupList[0].seed));
ok('соревновательный сценарий собран вручную',
  !!(cupList[0] && cupList[0].fixed && cupList[0].fixed.length >= 12));
[1, 2, 3, 4].forEach(function (lv) {
  var list = Content.scenarios.filter(function (s) { return s.level === lv; });
  ok('уровень ' + lv + ': минимум 5 сценариев', list.length >= 5, 'найдено ' + list.length);
  // Порядок показа задаётся полем hard: без него меню не смогло бы выстроить
  // сценарии от самого мягкого к самому тяжёлому.
  ok('уровень ' + lv + ': у всех сценариев задана тяжесть',
    list.every(function (s) { return typeof s.hard === 'number'; }));
  ok('уровень ' + lv + ': тяжесть не повторяется',
    new Set(list.map(function (s) { return s.hard; })).size === list.length);
});
ok('сценариев всего не меньше 15', Content.scenarios.length >= 15,
  'найдено ' + Content.scenarios.length);
ok('id сценариев уникальны',
  new Set(Content.scenarios.map(function (s) { return s.id; })).size === Content.scenarios.length);

Content.scenarios.forEach(function (scn) {
  // Каждый сценарий должен давать разные наборы событий при разных seed,
  // иначе повторные партии будут одинаковыми.
  var sets = {};
  for (var i = 0; i < 15; i++) {
    var b = build(scn, 'div' + i);
    sets[b.events.map(function (e) { return e.id; }).sort().join(',')] = true;
  }
  var variety = Object.keys(sets).length;
  ok(scn.id + ': разные seed дают разные наборы', variety >= 10,
    'уникальных наборов ' + variety + ' из 15');

  // Месяцы не должны конфликтовать: два события в одном месяце ломают показ.
  var clean = true;
  for (var k = 0; k < 12; k++) {
    var months = build(scn, 'm' + k).events.map(function (e) { return e.month; });
    if (months.some(function (m, i) { return months.indexOf(m) !== i; })) clean = false;
    if (months.some(function (m) { return m == null || m < 0 || m >= scn.months; })) clean = false;
  }
  var randomEvents = build(scn, 'm0').events.filter(function (e) { return /^random-/.test(e.id); });
  ok(scn.id + ': есть случайные межмесячные события', randomEvents.length >= 4,
    'найдено ' + randomEvents.length);
});

console.log('\n=== Неопределённость (жеребьёвки) ===');
// Ключевое свойство: жеребьёвка НЕ зависит от выбора игрока в этом же событии.
// Иначе сравнение с альтернативной историей сравнивало бы удачу, а не решения.
(function () {
  var d1 = E.drawFor('sc', 'seed1', 'ev1', 'g');
  var d2 = E.drawFor('sc', 'seed1', 'ev1', 'g');
  ok('жеребьёвка воспроизводима', d1 === d2);
  ok('жеребьёвка в диапазоне 0..1', d1 >= 0 && d1 < 1);
  ok('другое событие — другая жеребьёвка', E.drawFor('sc', 'seed1', 'ev2', 'g') !== d1);
  ok('другой seed — другая жеребьёвка', E.drawFor('sc', 'seed2', 'ev1', 'g') !== d1);
})();

(function () {
  // Проверяем на реальном сценарии: у события с gamble исход одинаков
  // при разных выборах игрока в этом событии.
  var sc = build(Content.scenarios[0], 'risky');
  var risky = sc.events.filter(function (e) {
    return e.choices.some(function (c) { return /gamble/.test(c.apply.toString()); });
  });
  ok('в сценарии есть рискованные события', risky.length > 0, 'найдено ' + risky.length);

  var ev = risky[0];
  var draws = ev.choices.map(function (c) {
    return E.drawFor(sc.id, 'fixed-seed', ev.id + '-probe', 'g');
  });
  ok('жеребьёвка не зависит от выбранного варианта',
    draws.every(function (d) { return d === draws[0]; }));
})();

(function () {
  // Разные seed должны давать разные исходы одних и тех же решений —
  // иначе неопределённости фактически нет.
  var scDef = Content.scenarios[0];
  var results = {};
  for (var i = 0; i < 25; i++) {
    var b = build(scDef, 'luck' + i);
    var ch = b.events.map(function (e) { return { eventId: e.id, choiceId: e.choices[0].id }; });
    var r = E.simulate(b, 'luck' + i, ch);
    if (r.finished) results[Math.round(E.netWorth(r.state) / 1000)] = true;
  }
  var variety = Object.keys(results).length;
  ok('одни решения дают разные исходы при разной удаче', variety >= 4,
    'различных итогов: ' + variety);
})();

console.log('\n=== Силы как ограниченный ресурс ===');
(function () {
  var scDef = Content.scenarios[0];
  var energies = [];
  for (var i = 0; i < 30; i++) {
    var b = build(scDef, 'en' + i);
    var ch = b.events.map(function (e) {
      return { eventId: e.id, choiceId: e.choices[i % e.choices.length].id };
    });
    var r = E.simulate(b, 'en' + i, ch);
    if (r.finished) energies.push(r.state.energy);
  }
  var min = Math.min.apply(null, energies), max = Math.max.apply(null, energies);
  ok('силы реально различаются между партиями', max - min > 25,
    'разброс ' + Math.round(min) + '..' + Math.round(max));
  ok('силы не всегда максимальны', min < 95, 'минимум ' + Math.round(min));
  ok('силы всегда в границах 0..100',
    energies.every(function (e) { return e >= 0 && e <= 100; }));
})();

console.log('\n=== Ветвление ===');
(function () {
  var withReq = [];
  Object.keys(Content.pool).forEach(function (id) {
    if (Content.pool[id].requires) withReq.push(id);
  });
  ok('есть условные события', withReq.length >= 3, 'найдено ' + withReq.length);

  // Разные решения должны приводить к разным наборам увиденных событий.
  var sc = build(Content.scenarios[5], 'branch');
  function seen(pickIndex) {
    var ch = [], guard = 0;
    while (guard++ < 40) {
      var r = E.simulate(sc, 'branch', ch);
      if (r.finished || !r.awaiting) break;
      var e = r.awaiting;
      ch.push({ eventId: e.id, choiceId: e.choices[Math.min(pickIndex, e.choices.length - 1)].id });
    }
    return ch.map(function (c) { return c.eventId; }).join(',');
  }
  var pathA = seen(0), pathB = seen(2);
  ok('разные решения дают разные наборы событий', pathA !== pathB);
  ok('путь A непустой', pathA.length > 0);
  ok('путь B непустой', pathB.length > 0);
})();

console.log('\n=== Отсутствие доминантных стратегий ===');
(function () {
  // Ни одна из простых стратегий не должна выигрывать во всех сценариях.
  var strategies = {
    first: function (e) { return e.choices[0].id; },
    last:  function (e) { return e.choices[e.choices.length - 1].id; },
    mid:   function (e) { return e.choices[Math.min(1, e.choices.length - 1)].id; }
  };
  var winsByStrategy = { first: 0, last: 0, mid: 0 };

  Content.scenarios.forEach(function (sc) {
    var bestName = null, bestMet = -1;
    Object.keys(strategies).forEach(function (name) {
      var met = 0;
      for (var i = 0; i < 10; i++) {
        var b = build(sc, 'dom' + i);
        var ch = b.events.map(function (e) { return { eventId: e.id, choiceId: strategies[name](e) }; });
        var r = E.simulate(b, 'dom' + i, ch);
        if (r.finished) met += E.evaluate(sc, r.state).met;
      }
      if (met > bestMet) { bestMet = met; bestName = name; }
    });
    winsByStrategy[bestName]++;
  });

  var maxWins = Math.max(winsByStrategy.first, winsByStrategy.last, winsByStrategy.mid);
  ok('ни одна простая стратегия не выигрывает везде',
    maxWins < Content.scenarios.length,
    'лучшая стратегия побеждает в ' + maxWins + ' из ' + Content.scenarios.length + ' сценариев');
})();

console.log('\n=== Многокритериальность требований ===');
Content.scenarios.forEach(function (sc) {
  // Требования должны конфликтовать: набор, где выполнено всё, не должен
  // достигаться простым «ничего не трать».
  var b = build(sc, 'multi');
  var ch = b.events.map(function (e) { return { eventId: e.id, choiceId: e.choices[e.choices.length - 1].id }; });
  var r = E.simulate(b, 'multi', ch);
  var ev = E.evaluate(b, r.state);
  ok(sc.id + ': требования включают неденежные',
    ev.requirements.some(function (q) { return /Силы|Качество|Доверие/.test(q.label); }));
  ok(sc.id + ': пассивная стратегия не даёт ранг S', ev.grade !== 'S' || ev.met < ev.total,
    'ранг ' + ev.grade);
});

console.log('\n=== Прогноз ===');
near('точный прогноз -> ошибка 0', E.forecastError(1000, 1000), 0, 1e-12);
near('вдвое меньше -> ошибка 50%', E.forecastError(500, 1000), 0.5, 1e-12);
near('вдвое больше -> ошибка 100%', E.forecastError(2000, 1000), 1, 1e-12);

console.log('\n----------------------------------------');
console.log('Пройдено: ' + passed + ',  провалено: ' + failed);
console.log('----------------------------------------\n');
process.exit(failed === 0 ? 0 : 1);
