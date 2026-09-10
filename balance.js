/*
 * balance.js — измерение качества решений.
 *
 * Отвечает на вопрос, который нельзя проверить обычными тестами:
 * есть ли в игре смысл думать, или существует вариант, который лучше всегда.
 *
 * Запуск: node balance.js [--full]
 *
 * Метрика доминирования: для каждого события перебираем его варианты, оставляя
 * остальные решения случайными, и смотрим, как часто каждый вариант оказывается
 * лучшим. Если один вариант выигрывает почти всегда — решение фиктивное.
 *
 * Оценка ведётся не по деньгам, а по многокритериальному итогу сценария,
 * иначе метрика поощряла бы накопительство.
 */
'use strict';
var E = require('./engine.js');
var C = require('./content.js');

E.setPool(C.pool);
var FULL = process.argv.indexOf('--full') !== -1;
var SAMPLES = FULL ? 400 : 160;

function score(sc, s) {
  var ev = E.evaluate(sc, s);
  // Выполненные требования — главное. Деньги учитываются, но не доминируют.
  return ev.met * 1000000
    + E.netWorth(s) * 0.55
    + s.calm * 2600 + s.quality * 2200 + s.energy * 1800 + s.trust * 700
    - s.stats.late * 40000;
}

function randomChoices(sc, rndInt) {
  return sc.events.map(function (e) {
    return { eventId: e.id, choiceId: e.choices[rndInt(e.choices.length)].id };
  });
}

/* Простой воспроизводимый ГПСЧ, чтобы отчёт по балансу не менялся между прогонами */
function makeRnd(seedStr) {
  var h = E.hashSeed(seedStr);
  var r = E.mulberry32(h);
  return function (n) { return Math.floor(r() * n); };
}

var report = [];
var problems = [];

C.scenarios.forEach(function (scDef) {
  var sc = E.resolveScenario(scDef, C.pool, 'balance-fixed');
  var rndInt = makeRnd('balance|' + sc.id);
  var scLine = { id: sc.id, title: sc.title, events: [] };

  sc.events.forEach(function (ev) {
    var wins = {}, reachable = 0;
    ev.choices.forEach(function (c) { wins[c.id] = 0; });

    for (var t = 0; t < SAMPLES; t++) {
      var seed = 'b' + t;
      var base = randomChoices(sc, rndInt);

      // Проверяем, что событие вообще достижимо при этом наборе решений:
      // из-за requires часть событий появляется лишь на отдельных ветках.
      var probe = E.simulate(sc, seed, base.filter(function (x) { return x.eventId !== ev.id; }));
      var visible = probe.awaiting && probe.awaiting.id === ev.id;
      if (!visible && probe.finished) continue;
      reachable++;

      var best = null, bestId = null;
      ev.choices.forEach(function (c) {
        var ch = base.map(function (x) {
          return x.eventId === ev.id ? { eventId: x.eventId, choiceId: c.id } : x;
        });
        var r = E.simulate(sc, seed, ch);
        if (!r.finished) return;
        var v = score(sc, r.state);
        if (best === null || v > best) { best = v; bestId = c.id; }
      });
      if (bestId) wins[bestId]++;
    }

    var total = Object.keys(wins).reduce(function (a, k) { return a + wins[k]; }, 0) || 1;
    var arr = ev.choices.map(function (c) {
      return { id: c.id, pct: Math.round(100 * wins[c.id] / total) };
    }).sort(function (a, b) { return b.pct - a.pct; });

    var top = arr[0].pct;

    // Часть событий исключена из метрики намеренно: у них ОБЯЗАН быть
    // правильный ответ, в этом их обучающая задача.
    //  - скам: распознать мошенничество;
    //  - lesson: не игнорировать здоровье и не доводить себя до выгорания.
    // Делать из этого дилемму было бы вредным уроком, а не хорошей игрой.
    var isLesson = ev.kind === 'scam' || ev.lesson === true;
    var verdict = isLesson ? 'урок' :
      (top >= 85 ? 'ДОМИНАНТА' : top >= 70 ? 'перевес' : 'ok');
    if (verdict === 'ДОМИНАНТА' || verdict === 'перевес') {
      problems.push({ scenario: sc.title, event: ev.shortTitle, top: top, dist: arr });
    }
    scLine.events.push({ title: ev.shortTitle, templateId: ev.id, dist: arr,
      verdict: verdict, reachable: reachable });
  });

  report.push(scLine);
});


console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║  БАЛАНС РЕШЕНИЙ                                              ║');
console.log('║  Цель: у события не должно быть варианта, лучшего всегда.    ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

report.forEach(function (sc) {
  console.log('\n### ' + sc.title);
  sc.events.forEach(function (e) {
    var mark = e.verdict === 'ok' ? '  ' : e.verdict === 'перевес' ? ' ~' : ' !';
    var dist = e.dist.map(function (d) { return d.id + ' ' + d.pct + '%'; }).join(' · ');
    console.log(mark + ' ' + e.title.padEnd(24) + dist);
  });
});

var totalEvents = report.reduce(function (a, s) { return a + s.events.length; }, 0);
var lessons = report.reduce(function (a, s) {
  return a + s.events.filter(function (e) { return e.verdict === 'урок'; }).length;
}, 0);
var judged = totalEvents - lessons;
var dominants = problems.filter(function (p) { return p.top >= 85; }).length;
var skewed = problems.filter(function (p) { return p.top >= 70 && p.top < 85; }).length;
var healthy = judged - dominants - skewed;

/*
 *  Контекстность событий — главная метрика для библиотеки сценариев.
 *
 *  Почему не «доминанта внутри сценария»: в конкретных условиях у решения
 *  ВПОЛНЕ может быть один лучший ответ — это нормально и даже правильно.
 *  «Брать подработку» при пустом резерве и при полном — разные задачи.
 *
 *  Настоящий признак плохого дизайна другой: если один и тот же шаблон
 *  события решается одинаково ВО ВСЕХ сценариях, значит контекст не работает
 *  и игрок может выучить ответ один раз. Это и измеряем.
 */
var byTemplate = {};
report.forEach(function (sc) {
  sc.events.forEach(function (e) {
    if (e.verdict === 'урок') return;
    (byTemplate[e.templateId] = byTemplate[e.templateId] || []).push({
      scenario: sc.title, winner: e.dist[0].id, pct: e.dist[0].pct
    });
  });
});

var multi = Object.keys(byTemplate).filter(function (id) { return byTemplate[id].length >= 3; });
var contextual = 0, rigid = [];
multi.forEach(function (id) {
  var winners = {};
  byTemplate[id].forEach(function (x) { winners[x.winner] = (winners[x.winner] || 0) + 1; });
  var distinct = Object.keys(winners).length;
  if (distinct >= 2) contextual++;
  else rigid.push({ id: id, winner: Object.keys(winners)[0], times: byTemplate[id].length });
});

console.log('\n=== Контекстность событий ===');
console.log('Шаблонов, встречающихся в 3+ сценариях: ' + multi.length);
console.log('Из них решаются по-разному в зависимости от условий: ' + contextual +
  '  (' + (multi.length ? Math.round(100 * contextual / multi.length) : 0) + '%)');
if (rigid.length) {
  console.log('\nОтвечаются одинаково везде (можно выучить):');
  rigid.forEach(function (r) {
    console.log('  ' + r.id.padEnd(20) + '-> ' + r.winner + '  (в ' + r.times + ' сценариях)');
  });
}

console.log('\n----------------------------------------------------------------');
console.log('Событий всего:          ' + totalEvents);
console.log('Из них уроки (скам):    ' + lessons + '  (у них правильный ответ обязателен)');
console.log('Оценивается как дилемма:' + judged);
console.log('  с доминантой (≥85%): ' + dominants);
console.log('  с перевесом (70–84%):' + skewed);
console.log('  здоровых:            ' + healthy +
  '  (' + Math.round(100 * healthy / judged) + '%)');
console.log('----------------------------------------------------------------');

if (problems.length) {
  console.log('\nТребуют внимания:');
  problems.sort(function (a, b) { return b.top - a.top; }).forEach(function (p) {
    console.log('  ' + String(p.top).padStart(3) + '%  ' + p.scenario + ' / ' + p.event +
      '  -> ' + p.dist[0].id);
  });
}

/* --- Проверка разнообразия исходов: одна ли стратегия побеждает всегда --- */
console.log('\n=== Устойчивость стратегий (ранги за 12 партий) ===');
C.scenarios.forEach(function (scDef) {
  var sc = E.resolveScenario(scDef, C.pool, 'balance-fixed');
  var strategies = {
    'копить всё':   function (e) { return e.choices[e.choices.length - 1].id; },
    'тратить всё':  function (e) { return e.choices[0].id; },
    'середина':     function (e) { return e.choices[Math.min(1, e.choices.length - 1)].id; }
  };
  var out = [];
  Object.keys(strategies).forEach(function (name) {
    var grades = {}, met = 0;
    for (var i = 0; i < 12; i++) {
      var ch = sc.events.map(function (e) { return { eventId: e.id, choiceId: strategies[name](e) }; });
      var r = E.simulate(sc, 'st' + i, ch);
      if (!r.finished) continue;
      var ev = E.evaluate(sc, r.state);
      grades[ev.grade] = (grades[ev.grade] || 0) + 1;
      met += ev.met;
    }
    out.push('  ' + name.padEnd(12) + ' средне условий ' + (met / 12).toFixed(1) +
      '   ранги: ' + Object.keys(grades).map(function (g) { return g + '×' + grades[g]; }).join(' '));
  });
  console.log('\n' + sc.title);
  out.forEach(function (l) { console.log(l); });
});

process.exit(dominants > 0 ? 1 : 0);
