/*
 * events.js — пул событий.
 *
 * Каждое событие — самостоятельный шаблон с тегами. Месяц НЕ задаётся здесь:
 * его назначает сборщик сценария (Engine.buildEvents), поэтому одно событие
 * может встречаться в разных сценариях в разное время.
 *
 * Теги определяют, в какой слот сценария событие может попасть:
 *   деньги:   debt, credit, save, invest, bigbuy, subs
 *   жизнь:    health, energy, family, social, housing
 *   работа:   career, income, sidejob, risk
 *   угрозы:   scam, shock
 *   уровень:  easy, mid, hard
 *
 * Поля события:
 *   kind      — тип для оформления: temptation/shock/offer/opportunity/scam/social/quiet
 *   lesson    — true, если у события ОБЯЗАН быть правильный ответ (здоровье, мошенники)
 *   requires  — (s, E) => bool, условие появления
 *   forecast  — механика предсказания
 *   choices   — варианты, каждый с apply(s, api, Engine)
 *
 * ВАЖНО: все организации и предложения вымышлены. Обучающая модель,
 * а не финансовая рекомендация.
 */
(function (root) {
  'use strict';

  var POOL = {};

  function ev(id, def) { def.id = id; POOL[id] = def; }

  /**
   * Масштаб суммы под доход игрока.
   * База рассчитана на доход ~62 000 ₽. Без этого одна и та же поломка
   * на 18 000 ₽ была бы мелочью для одного сценария и катастрофой для другого,
   * а межмесячных ситуаций теперь много — перекос копился бы каждый месяц.
   */
  function sum(s, base) {
    // Формула живёт в движке: по ней же интерфейс подставляет суммы
    // в текст события, поэтому второй копии здесь быть не должно.
    var E = root.Engine;
    if (E && E.scaleAmount) return E.scaleAmount(s, base);
    var k = Math.max(0.55, Math.min(2.2, ((s && s.income) || 62000) / 62000));
    return Math.round(base * k / 500) * 500;
  }

  /* ДЕНЬГИ: покупки, рассрочки, кредиты */

  ev('buy-phone', {
    kind: 'temptation', tags: ['bigbuy', 'credit', 'easy', 'mid'],
    shortTitle: 'Телефон', title: 'Телефон за 60 000 ₽',
    text: 'Старый работает, но еле тянет. Рассрочка «0%»: 5 500 ₽ × 12 месяцев. При полной оплате цена та же — 60 000 ₽.',
    forecast: {
      question: 'Сколько вы переплатите за «беспроцентную» рассрочку?', max: 15000, step: 500,
      actual: function () { return 6000; },
      reveal: function (E) {
        var r = E.impliedMonthlyRate(60000, 5500, 12);
        return 'Переплата 6 000 ₽ — это ' + (E.monthlyToAnnual(r) * 100).toFixed(1) +
          '% годовых при заявленных «0%». Покупка может быть оправданной, но цена у неё есть.';
      }
    },
    choices: [
      { id: 'take', label: 'Взять в рассрочку', sub: '5 500 ₽/мес весь год',
        apply: function (s, a, E) { a.addDebt(s, { id: 'phone', label: 'Телефон', principal: 60000, payment: 5500, months: 12, monthlyRate: E.impliedMonthlyRate(60000, 5500, 12) }); a.energy(s, 6); a.mood(s, -3, 11); a.flag(s, 'good_phone'); } },
      { id: 'used', label: 'Купить б/у за 26 000 ₽', sub: 'Проще, но без гарантии',
        apply: function (s, a) { a.spend(s, 26000, 'Телефон б/у', 'fun'); a.mood(s, -1, 3); a.gamble(s, 'buy-phone-used', [
          { p: .6, label: 'Б/у телефон работает нормально', good: true, effect: function (s, a) { a.mood(s, 2, 1); } },
          { p: .4, label: 'Б/у телефон сломался: −24 000 ₽', bad: true, effect: function (s, a) { a.spend(s, 24000, 'Срочная замена телефона', 'shocks'); a.energy(s, -8); a.mood(s, -7, -5); } }
        ]); } },
      { id: 'wait', label: 'Обойтись пока старым', sub: 'Ноль расходов, минус удобство',
        apply: function (s, a) { a.mood(s, 3, -5); a.energy(s, -3); } }
    ]
  });

  ev('buy-laptop', {
    kind: 'temptation', tags: ['bigbuy', 'credit', 'career', 'mid'],
    shortTitle: 'Ноутбук', title: 'Рабочий ноутбук на пределе',
    text: 'Работать можно, но всё тормозит и вы теряете время. Новый стоит 95 000 ₽, приличный б/у — 42 000 ₽.',
    choices: [
      { id: 'new', label: 'Новый за 95 000 ₽', sub: 'Надолго, +силы каждый месяц',
        apply: function (s, a) { a.spend(s, 95000, 'Ноутбук', 'fun'); a.energy(s, 10); a.mood(s, -2, 7); a.defer(s, 2, { energy: 8, label: 'Работать стало легче' }); } },
      { id: 'used', label: 'Б/у за 42 000 ₽', sub: 'Компромисс',
        apply: function (s, a) { a.spend(s, 42000, 'Ноутбук б/у', 'fun'); a.energy(s, 4); a.mood(s, 0, 2); a.gamble(s, 'laptop-used', [{ p: .62, label: 'Б/у ноутбук работает', good: true, effect: function (s, a) { a.mood(s, 1, 1); } }, { p: .38, label: 'Б/у ноутбук подвёл: −22 000 ₽', bad: true, effect: function (s, a) { a.spend(s, 22000, 'Замена ноутбука', 'shocks'); a.energy(s, -8); a.mood(s, -5, -3); } }]); } },
      { id: 'wait', label: 'Терпеть', sub: 'Экономия сейчас, потеря времени',
        apply: function (s, a) { a.energy(s, -10); a.mood(s, 1, -5); a.defer(s, 3, { energy: -8, label: 'Медленный ноутбук выматывает', type: 'bad' }); } }
    ]
  });

  ev('credit-card', {
    kind: 'offer', tags: ['credit', 'debt', 'mid', 'hard'], concept: 'grace',
    shortTitle: 'Кредитка', title: 'Карта с грейс-периодом 120 дней',
    text: 'Лимит 150 000 ₽. Процентов нет, если гасить полностью и в срок. Иначе — 32% годовых на всю задолженность.',
    choices: [
      { id: 'backup', label: 'Оформить как запас', sub: 'Не тратить без крайней нужды',
        apply: function (s, a) { a.flag(s, 'has_card'); a.mood(s, 2, 0); a.note(s, 'Кредитка оформлена как резерв', 0, 'info'); a.gamble(s, 'card-temptation', [{ p: .45, label: 'Лимит не тронули', good: true, effect: function (s, a) { a.mood(s, 3, 0); } }, { p: .55, label: 'Потратили часть лимита', bad: true, effect: function (s, a) { a.addDebt(s, { id: 'cc_slip', label: 'Долг по карте', principal: 46000, annualRate: .32, months: 12, cashNow: 46000 }); a.spend(s, 46000, 'Незаметные траты по карте', 'fun'); a.mood(s, -5, 6); } }]); } },
      { id: 'spend', label: 'Оформить и потратить', sub: 'Обновить всё сразу',
        apply: function (s, a) { a.addDebt(s, { id: 'cc', label: 'Кредитка', principal: 90000, annualRate: .32, months: 12, cashNow: 90000 }); a.spend(s, 90000, 'Покупки по кредитке', 'fun'); a.mood(s, -8, 15); } },
      { id: 'no', label: 'Отказаться', sub: 'Меньше соблазна',
        apply: function (s, a) { a.mood(s, 2, -1); } }
    ]
  });

  ev('debt-consolidate', {
    kind: 'offer', tags: ['debt', 'credit', 'mid', 'hard'], concept: 'avalanche',
    requires: function (s, E) { return E.debtBalanceTotal(s) > 60000; },
    shortTitle: 'Объединение долгов', title: 'Предложение объединить кредиты',
    text: 'Банк предлагает свести долги в один: платёж ниже на треть, но срок длиннее и общая переплата выше.',
    choices: [
      { id: 'yes', label: 'Объединить', sub: 'Платёж ниже, переплата выше',
        apply: function (s, a) { s.debts.forEach(function (d) { d.months += 14; d.payment *= .66; }); a.mood(s, 6, 3); a.flag(s, 'consolidated'); a.note(s, 'Долги объединены', 0, 'info'); } },
      { id: 'no', label: 'Оставить как есть', sub: 'Тяжелее сейчас, дешевле в итоге',
        apply: function (s, a) { a.mood(s, -3, -2); } },
      { id: 'attack', label: 'Наоборот, ускорить выплату', sub: 'Ещё тяжелее, но быстрее свобода',
        apply: function (s, a) { s.debts.forEach(function (d) { d.payment *= 1.35; }); a.mood(s, -6, -7); a.flag(s, 'aggressive_debt'); } },
      { id: 'snowball', label: 'Добить самый маленький долг', sub: 'Список станет короче уже в этом месяце',
        concept: 'snowball',
        apply: function (s, a) {
          // Метод снежного кома: платим по самому маленькому остатку.
          // Математически он уступает лавине, зато список долгов виден глазами.
          var small = null;
          s.debts.forEach(function (d) { if (d.balance > 0 && (!small || d.balance < small.balance)) small = d; });
          if (!small) { a.mood(s, 2, 0); return; }
          var pay = Math.min(Math.max(0, s.cash), small.balance);
          if (pay > 0) { a.repay(s, pay, { debtId: small.id }); }
          a.mood(s, 7, 2);
          a.energy(s, -4);
        } }
    ]
  });

  ev('early-payoff', {
    kind: 'offer', tags: ['debt', 'save', 'mid'], concept: 'annuity',
    requires: function (s, E) { return E.debtBalanceTotal(s) > 30000 && s.cash > 60000; },
    shortTitle: 'Досрочное погашение', title: 'Есть свободные деньги',
    text: 'Можно досрочно погасить часть долга или положить эти деньги в резерв под проценты.',
    choices: [
      { id: 'debt', label: 'Погасить долг', sub: 'Меньше процентов дальше',
        apply: function (s, a) { var d = s.debts.sort(function (x, y) { return y.monthlyRate - x.monthlyRate; })[0]; if (d) { var x = Math.min(s.cash * .6, d.balance); d.balance -= x; s.cash -= x; s.flows.debtPaid += x; a.note(s, 'Досрочно погашено: ' + d.label, -x, 'good'); } a.mood(s, 6, -2); } },
      { id: 'reserve', label: 'В резерв', sub: 'Меньше риска, но долг остаётся',
        apply: function (s, a) { a.toReserve(s, s.cash * .6); a.mood(s, 4, 0); } },
      { id: 'split', label: 'Пополам', sub: 'И то, и другое понемногу',
        apply: function (s, a) { var half = s.cash * .3; var d = s.debts[0]; if (d) { var x = Math.min(half, d.balance); d.balance -= x; s.cash -= x; s.flows.debtPaid += x; } a.toReserve(s, half); a.mood(s, 5, -1); } }
    ]
  });

  /* НАКОПЛЕНИЯ И ВЛОЖЕНИЯ */

  ev('autosave-rule', {
    kind: 'opportunity', tags: ['save', 'easy', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'Правило накоплений', title: 'Сколько откладывать автоматически?',
    text: 'Автоперевод уводит часть дохода в резерв до того, как деньги попадут в бытовой оборот. Работает потому, что не требует решения каждый месяц.',
    choices: [
      { id: 'hard', label: 'Откладывать 25%', sub: 'Быстро, но жизнь теснее', concept: 'ruin',
        apply: function (s, a) { a.setAutoSave(s, .25); a.mood(s, 9, -5); a.flag(s, 'disciplined'); a.note(s, 'Автоперевод: 25%', 0, 'good'); } },
      { id: 'soft', label: 'Откладывать 10%', sub: 'Умеренно',
        apply: function (s, a) { a.setAutoSave(s, .10); a.mood(s, 2, -1); a.note(s, 'Автоперевод: 10%', 0, 'good'); } },
      { id: 'none', label: 'Без автоперевода', sub: 'Сначала понять бюджет', concept: 'optionality',
        apply: function (s, a) { a.mood(s, 0, 3); a.flag(s, 'flexible'); } }
    ]
  });

  ev('deposit-choice', {
    kind: 'offer', tags: ['save', 'invest', 'easy', 'mid'], concept: 'deposit',
    shortTitle: 'Два вклада', title: 'Куда положить накопления?',
    text: 'Первый вклад: 13% годовых, снятие в любой момент. Второй: 12,8% с ежемесячной капитализацией, но при досрочном снятии проценты теряются.',
    forecast: {
      question: 'Какая эффективная ставка у второго вклада?', max: 20, step: .1, unit: '%',
      actual: function (E) { return E.effectiveAnnualRate(.128, 12) * 100; },
      reveal: function (E) {
        return 'Второй даёт ' + (E.effectiveAnnualRate(.128, 12) * 100).toFixed(2) +
          '% эффективно — больше первого. Но деньги в нём заперты, а значит это не резерв.';
      }
    },
    choices: [
      { id: 'flex', label: 'Доступный под 13%', sub: 'Можно снять когда угодно', concept: 'liquidity',
        apply: function (s, a) { var x = a.toReserve(s, Math.max(0, Math.min(s.cash * 0.7, s.cash - s.mandatory))); a.addAsset(s, { id: 'dep_flex', label: 'Вклад (доступный)', value: 0, annualRate: .09 }); a.note(s, 'Резерв пополнен', x, 'good'); a.mood(s, 2, -2); } },
      { id: 'locked', label: 'Запертый под 12,8%', sub: 'Доходнее, но недоступен', concept: 'effrate',
        apply: function (s, a, E) { var x = Math.max(0, Math.min(s.cash * 0.6, s.cash - s.mandatory));  a.spend(s, x, 'Вклад', 'invested'); a.addAsset(s, { id: 'dep_lock', label: 'Вклад (заперт)', value: x * 1.06, annualRate: E.effectiveAnnualRate(.168, 12), kind: 'locked' }); a.mood(s, 1, 0); a.flag(s, 'money_locked'); a.defer(s, 4, { calm: -5, label: 'Деньги заперты, если понадобятся', type: 'bad' }); } },
      { id: 'cash', label: 'Оставить наличными', sub: 'Спокойнее, но инфляция', concept: 'inflation',
        apply: function (s, a) { a.mood(s, 1, 1); } }
    ]
  });

  ev('invest-offer', {
    kind: 'offer', tags: ['invest', 'risk', 'mid', 'hard'], concept: 'diversify',
    requires: function (s) { return s.cash > 90000; },
    shortTitle: 'Фонд', title: 'Предложение вложиться в фонд',
    text: 'Консервативный фонд: в среднем 14% годовых, но бывают просадки. Можно вложить 120 000 ₽, часть суммы или отказаться.',
    choices: [
      { id: 'all', label: 'Вложить 120 000 ₽', sub: 'Больше потенциал, больше риск', concept: 'expected',
        apply: function (s, a) { a.spend(s, 120000, 'Вложение в фонд', 'invested'); a.gamble(s, 'invest-all', [
          { p: .58, label: 'Фонд вырос: +31 000 ₽', good: true, effect: function (s, a) { a.addAsset(s, { id: 'fund', label: 'Фонд', value: 151000, annualRate: .06 }); a.mood(s, 6, 2); } },
          { p: .42, label: 'Фонд просел: −26 000 ₽', bad: true, effect: function (s, a) { a.addAsset(s, { id: 'fund', label: 'Фонд', value: 94000, annualRate: .06 }); a.mood(s, -8, -3); } }
        ]); } },
      { id: 'part', label: 'Вложить 45 000 ₽', sub: 'Попробовать малым', concept: 'ruin',
        apply: function (s, a) { a.spend(s, 45000, 'Вложение в фонд', 'invested'); a.gamble(s, 'invest-part', [
          { p: .58, label: 'Фонд вырос: +11 000 ₽', good: true, effect: function (s, a) { a.addAsset(s, { id: 'fund', label: 'Фонд', value: 56000, annualRate: .06 }); a.mood(s, 3, 1); } },
          { p: .42, label: 'Фонд просел: −9 000 ₽', bad: true, effect: function (s, a) { a.addAsset(s, { id: 'fund', label: 'Фонд', value: 36000, annualRate: .06 }); a.mood(s, -3, -1); } }
        ]); } },
      { id: 'no', label: 'Отказаться', sub: 'Сначала резерв',
        apply: function (s, a) { a.mood(s, 2, 0); } }
    ]
  });

  ev('subs-creep', {
    kind: 'quiet', tags: ['subs', 'easy', 'mid'], concept: 'subs',
    shortTitle: 'Подписки', title: 'Три бесплатных пробных периода',
    text: 'Кино, спорт и хранилище — первый месяц бесплатно. Отменить можно в любой момент, если не забыть.',
    choices: [
      { id: 'all', label: 'Подключить все три', sub: 'Потом разберусь',
        apply: function (s, a) { a.addSub(s, 'Кино', 599); a.addSub(s, 'Спорт', 890); a.addSub(s, 'Хранилище', 349); a.mood(s, 0, 6); a.defer(s, 3, { label: 'Пробные периоды закончились, списания идут', calm: -3, type: 'bad' }); } },
      { id: 'one', label: 'Только одну', sub: '599 ₽/мес',
        apply: function (s, a) { a.addSub(s, 'Кино', 599); a.mood(s, 0, 2); } },
      { id: 'none', label: 'Ничего не подключать', sub: '',
        apply: function (s, a) { a.mood(s, 1, -6); } }
    ]
  });

  ev('subs-audit', {
    kind: 'quiet', tags: ['subs', 'mid', 'hard'], concept: 'subs',
    requires: function (s, E) { return E.subsTotal(s) > 800; },
    shortTitle: 'Ревизия списаний', title: 'Посмотреть, что списывается',
    text: 'В выписке нашлось несколько регулярных платежей. Некоторыми вы пользуетесь, некоторыми — нет.',
    choices: [
      { id: 'cut', label: 'Отменить всё лишнее', sub: 'Освободить деньги, минус привычки',
        apply: function (s, a) { var freed = a.removeSubs(s); a.note(s, 'Отменены подписки: +' + Math.round(freed) + ' \u20bd/мес', 0, 'good'); a.mood(s, 2, -14); a.energy(s, -6); } },
      { id: 'keep', label: 'Оставить всё', sub: 'Это мелочь',
        apply: function (s, a) { a.mood(s, -4, 2); } },
      { id: 'trim', label: 'Отменить половину', sub: 'Убрать то, чем не пользуетесь',
        apply: function (s, a) { var half = Math.round(s.subs.length / 2); var freed = 0; for (var i = 0; i < half; i++) { if (s.subs.length) { freed += s.subs[0].amount; s.subs.shift(); } } a.note(s, 'Отменено лишнее: +' + Math.round(freed) + ' \u20bd/мес', 0, 'good'); a.mood(s, 2, -4); } }
    ]
  });

  /* РАБОТА И ДОХОД */

  ev('side-job', {
    kind: 'opportunity', tags: ['sidejob', 'income', 'easy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Подработка', title: 'Вечерняя подработка',
    text: 'Знакомый предлагает {38000} ₽ в месяц за 12–14 часов в неделю. Деньги сразу, но вечера уйдут туда.',
    choices: [
      { id: 'take', label: 'Взять на 4 месяца', sub: '+{38000} ₽/мес, −16 сил в месяц',
        apply: function (s, a) { a.tempIncome(s, sum(s, 38000), 4, { label: 'Подработка закончилась', calm: 2 }); a.energy(s, -16); a.mood(s, 3, -4); a.flag(s, 'side_job'); a.defer(s, 4, { energy: -14, label: 'Накопилась усталость', type: 'bad' }); } },
      { id: 'trial', label: 'Договориться на 2 месяца', sub: '+{24000} ₽/мес, меньше риска', concept: 'negotiation',
        apply: function (s, a) { a.tempIncome(s, sum(s, 24000), 2, { label: 'Проект завершён', calm: 1 }); a.energy(s, -10); a.mood(s, 1, -2); } },
      { id: 'no', label: 'Отказаться', sub: 'Оставить себе вечера',
        apply: function (s, a) { a.energy(s, 4); a.mood(s, 0, 3); a.flag(s, 'free_evenings'); } }
    ]
  });

  ev('course-gamble', {
    kind: 'opportunity', tags: ['career', 'risk', 'easy', 'mid'], concept: 'risk',
    shortTitle: 'Курс и переход', title: 'Шанс перейти в сильную команду',
    text: 'Курс и тестовое стоят 35 000 ₽ и много вечеров. По итогам — шанс на позицию с заметно большим доходом. Берут примерно одного из двух.',
    choices: [
      { id: 'full', label: 'Курс + сильное тестовое', sub: '35 000 ₽, шанс 58%, −35 сил', concept: 'expected',
        apply: function (s, a) { a.spend(s, 35000, 'Курс и тестовое', 'fun'); a.energy(s, -35); a.gamble(s, 'course-full', [
          { p: .58, label: 'Оффер принят: +33 000 ₽/мес', good: true, effect: function (s, a) { a.incomeDelta(s, 33000); a.mood(s, 12, 6); a.flag(s, 'career_win'); } },
          { p: .42, label: 'Оффера нет, но портфолио сильнее', effect: function (s, a) { a.mood(s, -5, 2); a.flag(s, 'portfolio'); } }
        ]); } },
      { id: 'light', label: 'Только тестовое самому', sub: '0 ₽, шанс 28%, −18 сил',
        apply: function (s, a) { a.energy(s, -18); a.gamble(s, 'course-light', [
          { p: .28, label: 'Оффер: +25 000 ₽/мес', good: true, effect: function (s, a) { a.incomeDelta(s, 25000); a.mood(s, 10, 4); a.flag(s, 'career_win'); } },
          { p: .72, label: 'Отказ, но опыт интервью получен', effect: function (s, a) { a.mood(s, -2, 1); a.flag(s, 'portfolio'); } }
        ]); } },
      { id: 'skip', label: 'Не рисковать сейчас', sub: 'Сохранить деньги и силы',
        apply: function (s, a) { a.energy(s, 8); a.mood(s, 2, 2); } }
    ]
  });

  ev('raise-ask', {
    kind: 'opportunity', tags: ['career', 'income', 'mid', 'hard'], concept: 'negotiation',
    shortTitle: 'Разговор о зарплате', title: 'Попросить повышение',
    text: 'Вы тянете больше, чем год назад. Руководитель занят и не любит такие разговоры. Отказ ничего не стоит, кроме неловкости.',
    choices: [
      { id: 'ask', label: 'Попросить прибавку', sub: 'Шанс 52% на +21 000 ₽/мес',
        apply: function (s, a) { a.energy(s, -6); a.gamble(s, 'raise-ask', [
          { p: .52, label: 'Прибавка согласована: +21 000 ₽/мес', good: true, effect: function (s, a) { a.incomeDelta(s, 21000); a.mood(s, 9, 4); } },
          { p: .48, label: 'Отказали, но обещали пересмотреть', effect: function (s, a) { a.mood(s, -4, -2); a.defer(s, 4, { income: 9000, label: 'Небольшая индексация' }); } }
        ]); } },
      { id: 'prepare', label: 'Сначала собрать аргументы', sub: '−12 сил, шанс выше',
        apply: function (s, a) { a.energy(s, -26); a.mood(s, -2, -4); a.gamble(s, 'raise-prepared', [
          { p: .68, label: 'Аргументы сработали: +26 000 ₽/мес', good: true, effect: function (s, a) { a.incomeDelta(s, 26000); a.mood(s, 11, 5); } },
          { p: .30, label: 'Отказ, несмотря на подготовку', bad: true, effect: function (s, a) { a.mood(s, -7, -3); } }
        ]); } },
      { id: 'wait', label: 'Не поднимать тему', sub: 'Спокойнее, но доход тот же',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  ev('freelance', {
    kind: 'opportunity', tags: ['sidejob', 'risk', 'mid', 'hard'], concept: 'risk',
    shortTitle: 'Проект на стороне', title: 'Клиент предлагает проект',
    text: 'Оплата 90 000 ₽: аванс 20%, остальное после сдачи. Правок может оказаться больше обещанного.',
    choices: [
      { id: 'take', label: 'Взять проект', sub: 'Аванс сразу, −32 силы',
        apply: function (s, a) { a.earn(s, 18000, 'Аванс'); a.energy(s, -32); a.gamble(s, 'freelance-take', [
          { p: .55, label: 'Проект принят: +72 000 ₽', good: true, effect: function (s, a) { a.earn(s, 72000, 'Оплата проекта'); a.mood(s, 8, 3); } },
          { p: .45, label: 'Правки съели месяц, доплаты нет', bad: true, effect: function (s, a) { a.energy(s, -16); a.mood(s, -9, -6); } }
        ]); } },
      { id: 'negotiate', label: 'Просить 50% аванса', sub: 'Риск ниже, сделка вероятнее сорвётся', concept: 'negotiation',
        apply: function (s, a) { a.gamble(s, 'freelance-negotiate', [
          { p: .45, label: 'Клиент согласился: +90 000 ₽', good: true, effect: function (s, a) { a.earn(s, 90000, 'Оплата проекта'); a.energy(s, -22); a.mood(s, 8, 2); } },
          { p: .55, label: 'Клиент выбрал другого', effect: function (s, a) { a.mood(s, -2, 0); } }
        ]); } },
      { id: 'no', label: 'Отказаться', sub: 'Не перегружать год',
        apply: function (s, a) { a.energy(s, 10); a.mood(s, 2, 3); } }
    ]
  });

  ev('job-offer-weak', {
    kind: 'offer', tags: ['career', 'income', 'hard'], concept: 'optionality',
    shortTitle: 'Слабый оффер', title: 'Оффер, но не тот',
    text: 'Работа не по профилю и с меньшим доходом. Стабильно, но через год вернуться в профессию будет труднее.',
    choices: [
      { id: 'accept', label: 'Согласиться', sub: 'Доход есть, развитие стоит',
        apply: function (s, a) { a.incomeDelta(s, 62000); a.mood(s, 5, -16); a.energy(s, -8); a.flag(s, 'weak_job'); a.defer(s, 4, { quality: -8, label: 'Работа не по профилю выматывает', type: 'bad' }); } },
      { id: 'wait', label: 'Отказаться и искать своё', sub: 'Без дохода, но с перспективой',
        apply: function (s, a) { a.energy(s, -10); a.mood(s, -6, 2); a.flag(s, 'held_out'); a.gamble(s, 'offer-hold', [{ p: .52, label: 'Нашлась работа по профилю: +104 000 ₽/мес', good: true, effect: function (s, a) { a.defer(s, 2, { income: 104000, label: 'Новая работа по профилю', calm: 12, quality: 8 }); } }, { p: .48, label: 'Поиск затянулся', bad: true, effect: function (s, a) { a.mood(s, -8, -5); } }]); } },
      { id: 'part', label: 'Просить частичную занятость', sub: 'Может не согласиться', concept: 'negotiation',
        apply: function (s, a) { a.gamble(s, 'offer-part', [
          { p: .5, label: 'Согласовали частичную занятость', good: true, effect: function (s, a) { a.incomeDelta(s, 46000); a.mood(s, 5, -1); } },
          { p: .5, label: 'Отказали, оффер ушёл', bad: true, effect: function (s, a) { a.mood(s, -6, -3); } }
        ]); } }
    ]
  });

  ev('promotion-load', {
    kind: 'opportunity', tags: ['career', 'energy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Повышение', title: 'Повышение с нагрузкой',
    text: 'Предлагают руководить направлением: +42 000 ₽ в месяц, но рабочий день станет длиннее и ответственности больше.',
    choices: [
      { id: 'yes', label: 'Согласиться', sub: '+42 000 ₽/мес, −30 сил',
        apply: function (s, a) { a.incomeDelta(s, 42000); a.energy(s, -30); a.mood(s, 2, -9); a.defer(s, 3, { energy: -14, quality: -5, label: 'Нагрузка накапливается', type: 'bad' }); a.defer(s, 6, { energy: -10, label: 'Устали от ответственности', type: 'bad' }); } },
      { id: 'later', label: 'Попросить отсрочку', sub: 'Через полгода, если будут силы', concept: 'negotiation',
        apply: function (s, a) { a.defer(s, 5, { income: 24000, label: 'Повышение вступило в силу', calm: 5 }); a.mood(s, 2, 1); } },
      { id: 'no', label: 'Отказаться', sub: 'Сохранить темп жизни',
        apply: function (s, a) { a.energy(s, 6); a.mood(s, 2, 6); } }
    ]
  });

  /* ШОКИ */

  ev('dental', {
    kind: 'shock', tags: ['health', 'shock', 'easy', 'mid'], concept: 'reserve',
    shortTitle: 'Стоматология', title: 'Зуб, который нельзя отложить',
    text: 'Лечение стоит 34 000 ₽. Дешёвая клиника просит 18 000 ₽, но качество неизвестно. Есть и кредит клиники под 3% в месяц.',
    choices: [
      { id: 'good', label: 'Проверенная клиника', sub: '34 000 ₽ сразу',
        apply: function (s, a) { a.spend(s, 34000, 'Лечение', 'shocks'); a.mood(s, 3, 3); a.energy(s, 4); } },
      { id: 'cheap', label: 'Дешёвая клиника', sub: '18 000 ₽, риск переделки',
        apply: function (s, a) { a.spend(s, 18000, 'Дешёвое лечение', 'shocks'); a.gamble(s, 'dental-cheap', [
          { p: .52, label: 'Лечение прошло нормально', good: true, effect: function (s, a) { a.mood(s, 2, 0); } },
          { p: .48, label: 'Пришлось переделывать: −44 000 ₽', bad: true, effect: function (s, a) { a.spend(s, 44000, 'Переделка лечения', 'shocks'); a.energy(s, -14); a.mood(s, -11, -8); } }
        ]); } },
      { id: 'credit', label: 'Рассрочка клиники', sub: '6 месяцев под 3%/мес', concept: 'annuity',
        apply: function (s, a) { a.addDebt(s, { id: 'dental', label: 'Лечение', principal: 34000, monthlyRate: .03, months: 6 }); a.mood(s, -5, 1); } }
    ]
  });

  ev('health-signal', {
    kind: 'shock', tags: ['health', 'energy', 'mid', 'hard'], concept: 'energy', lesson: true,
    shortTitle: 'Здоровье', title: 'Организм подаёт сигнал',
    text: 'Нужно обследование и отдых: 42 000 ₽ и две недели. Можно отложить — сейчас не лучший момент.',
    choices: [
      { id: 'treat', label: 'Заняться здоровьем', sub: '−42 000 ₽, +22 силы',
        apply: function (s, a) { a.spend(s, 42000, 'Обследование и отдых', 'shocks'); a.energy(s, 22); a.mood(s, 6, 4); } },
      { id: 'delay', label: 'Отложить', sub: 'Ноль сейчас, риск дальше',
        apply: function (s, a) { a.energy(s, -12); a.mood(s, -5, -6); a.gamble(s, 'health-delay', [
          { p: .45, label: 'Обошлось само', effect: function (s, a) { a.mood(s, 2, 1); } },
          { p: .55, label: 'Стало хуже: −88 000 ₽ и потеря сил', bad: true, effect: function (s, a) { a.spend(s, 88000, 'Лечение', 'shocks'); a.energy(s, -22); a.mood(s, -10, -12); } }
        ]); } }
    ]
  });

  ev('appliance-break', {
    kind: 'shock', tags: ['shock', 'housing', 'easy', 'mid'], concept: 'reserve',
    shortTitle: 'Техника сломалась', title: 'Холодильник перестал morozить',
    text: 'Ремонт 14 000 ₽ без гарантий, новый — 58 000 ₽. Без холодильника жить неудобно и дороже.',
    choices: [
      { id: 'repair', label: 'Ремонт', sub: '14 000 ₽, может не помочь',
        apply: function (s, a) { a.spend(s, 14000, 'Ремонт холодильника', 'shocks'); a.gamble(s, 'appliance-repair', [
          { p: .6, label: 'Ремонт помог', good: true, effect: function (s, a) { a.mood(s, 2, 1); } },
          { p: .4, label: 'Сломался снова: пришлось купить новый', bad: true, effect: function (s, a) { a.spend(s, 58000, 'Новый холодильник', 'shocks'); a.mood(s, -6, -3); } }
        ]); } },
      { id: 'new', label: 'Купить новый', sub: '58 000 ₽, надолго',
        apply: function (s, a) { a.spend(s, 58000, 'Холодильник', 'shocks'); a.mood(s, -2, 4); } },
      { id: 'wait', label: 'Пожить без него', sub: 'Экономия, но расходы на еду выше',
        apply: function (s, a) { a.mandatoryDelta(s, 4500); a.mood(s, -3, -9); a.energy(s, -6); } }
    ]
  });

  ev('rent-hike', {
    kind: 'shock', tags: ['housing', 'shock', 'mid', 'hard'], concept: 'optionality',
    shortTitle: 'Аренда выросла', title: 'Хозяин повышает плату',
    text: 'Аренда вырастет на 12 000 ₽ в месяц. Можно согласиться, торговаться или искать другое жильё.',
    choices: [
      { id: 'accept', label: 'Согласиться', sub: '+12 000 ₽/мес расходов',
        apply: function (s, a) { a.mandatoryDelta(s, 12000); a.mood(s, -4, -2); } },
      { id: 'negotiate', label: 'Торговаться', sub: 'Может выйти дешевле', concept: 'negotiation',
        apply: function (s, a) { a.gamble(s, 'rent-negotiate', [
          { p: .5, label: 'Договорились на +5 000 ₽', good: true, effect: function (s, a) { a.mandatoryDelta(s, 5000); a.mood(s, 4, 0); } },
          { p: .5, label: 'Хозяин настоял на своём', effect: function (s, a) { a.mandatoryDelta(s, 12000); a.mood(s, -5, -3); } }
        ]); } },
      { id: 'move', label: 'Переехать', sub: '−38 000 ₽ сразу, потом дешевле',
        apply: function (s, a) { a.spend(s, 38000, 'Переезд', 'shocks'); a.mandatoryDelta(s, -6000); a.energy(s, -24); a.mood(s, 0, -16); a.defer(s, 2, { energy: -8, label: 'Обустройство на новом месте' }); } }
    ]
  });

  ev('income-drop', {
    kind: 'shock', tags: ['income', 'shock', 'mid', 'hard'], concept: 'negotiation',
    shortTitle: 'Доход просел', title: 'Урезали бонусы',
    text: 'Доход снизился на 16 000 ₽ в месяц. Платежи остались те же. Можно тянуть, договариваться с банком или сокращать расходы.',
    choices: [
      { id: 'tight', label: 'Тянуть как есть', sub: 'Без переговоров',
        apply: function (s, a) { a.incomeDelta(s, -16000); a.mood(s, -7, -10); a.energy(s, -8); } },
      { id: 'talk', label: 'Просить реструктуризацию', sub: 'Платёж меньше, срок длиннее',
        apply: function (s, a) { a.incomeDelta(s, -16000); var d = s.debts[0]; if (d) { d.months += 12; d.payment *= .76; } a.mood(s, -1, -3); } },
      { id: 'cut', label: 'Резать расходы', sub: '−9 000 ₽/мес, минус комфорт',
        apply: function (s, a) { a.incomeDelta(s, -16000); a.mandatoryDelta(s, -9000); a.removeSubs(s); a.mood(s, 0, -22); a.energy(s, -10); } }
    ]
  });

  /* МОШЕННИКИ (у этих событий правильный ответ обязателен) */

  ev('scam-bank-call', {
    kind: 'scam', tags: ['scam', 'easy', 'mid', 'hard'], concept: 'scam',
    shortTitle: 'Звонок «из банка»', title: '«Подозрительная операция»',
    text: 'Звонящий знает ваше имя и последние цифры карты. Просит код из СМС, чтобы «отменить перевод». Торопит: «У вас 30 секунд».',
    choices: [
      { id: 'obey', label: 'Назвать код', sub: 'Успеть остановить списание', scamHit: true,
        apply: function (s, a) { var loss = Math.min(s.cash + s.reserve, 52000); a.spend(s, loss, 'Мошенники', 'shocks'); a.mood(s, -20, -6); } },
      { id: 'check', label: 'Положить трубку, перезвонить банку', sub: 'По номеру с карты',
        concept: 'verify',
        apply: function (s, a) { a.note(s, 'Мошенничество распознано', 0, 'good'); a.mood(s, 4, 0); } }
    ]
  });

  ev('scam-fine', {
    kind: 'scam', tags: ['scam', 'easy', 'mid'], concept: 'scam',
    shortTitle: 'Штраф со скидкой', title: 'СМС о штрафе',
    text: '«Оплатите штраф 5 000 ₽ в течение двух часов со скидкой 50%». Ссылка похожа на официальный сайт, но адрес слегка другой.',
    choices: [
      { id: 'pay', label: 'Оплатить по ссылке', sub: 'Успеть со скидкой', scamHit: true,
        apply: function (s, a) { var loss = Math.min(s.cash + s.reserve, 58000); a.spend(s, loss, 'Фишинговая страница', 'shocks'); a.mood(s, -17, -4); } },
      { id: 'check', label: 'Проверить в приложении', sub: 'Сначала убедиться',
        apply: function (s, a) { a.note(s, 'Фишинг распознан', 0, 'good'); a.mood(s, 4, 0); } }
    ]
  });

  ev('scam-invest', {
    kind: 'scam', tags: ['scam', 'invest', 'mid', 'hard'], concept: 'fomo',
    shortTitle: '«Гарантированные 30%»', title: 'Знакомый предлагает вложиться',
    text: 'Платформа обещает гарантированные 30% в месяц. Знакомый показывает скриншот первой выплаты. Мест «осталось на два дня».',
    choices: [
      { id: 'invest', label: 'Вложить 100 000 ₽', sub: 'Знакомый ведь получил', scamHit: true,
        apply: function (s, a) { var loss = Math.min(s.cash + s.reserve, 100000); a.spend(s, loss, 'Вложение в схему', 'shocks'); a.defer(s, 1, { cash: Math.round(loss * .3), label: 'Первая выплата пришла', calm: 5 }); a.defer(s, 2, { label: 'Платформа исчезла, деньги не вернуть', calm: -26, quality: -8, type: 'bad' }); } },
      { id: 'small', label: 'Вложить 15 000 «на пробу»', sub: 'Проверить малой суммой', scamHit: true,
        apply: function (s, a) { a.spend(s, 15000, 'Вложение в схему', 'shocks'); a.defer(s, 2, { label: 'Платформа исчезла: 15 000 ₽ потеряны', calm: -9, type: 'bad' }); } },
      { id: 'no', label: 'Отказаться', sub: 'Гарантий не бывает',
        apply: function (s, a) { a.note(s, 'Схема распознана', 0, 'good'); a.mood(s, 5, 0); } }
    ]
  });

  ev('scam-mfo', {
    kind: 'scam', tags: ['scam', 'debt', 'hard'], concept: 'mfo',
    shortTitle: 'Быстрый займ', title: '30 000 ₽ за 15 минут',
    text: '«Всего 1% в день», проверок нет. Деньги нужны сейчас.',
    forecast: {
      question: 'Сколько это в годовых процентах?', max: 400, step: 5, unit: '%',
      actual: function () { return 365; },
      reveal: function () { return '365% простым счётом, а со сложным начислением — в разы больше. Самый дорогой способ занять деньги.'; }
    },
    choices: [
      { id: 'take', label: 'Взять займ', sub: '1% в день', scamHit: true,
        apply: function (s, a) { a.addDebt(s, { id: 'mfo', label: 'Быстрый займ', principal: 30000, monthlyRate: .30, months: 6, cashNow: 30000 }); a.mood(s, -10, 2); } },
      { id: 'no', label: 'Не брать', sub: 'Искать другой выход',
        apply: function (s, a) { a.note(s, 'Дорогой займ распознан', 0, 'good'); a.mood(s, 3, -2); } }
    ]
  });

  /* ЛЮДИ И ОТНОШЕНИЯ */

  ev('friend-loan', {
    kind: 'social', tags: ['social', 'family', 'easy', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Друг просит в долг', title: 'Просьба, на которую трудно сказать нет',
    text: 'Друг просит 62 000 ₽ до зарплаты. Раньше возвращал, но с задержками.',
    choices: [
      { id: 'full', label: 'Дать всю сумму', sub: '62 000 ₽, возврат не гарантирован',
        apply: function (s, a) { a.spend(s, 62000, 'Долг другу', 'fun'); a.trust(s, 16); a.gamble(s, 'friend-repay', [
          { p: .5, label: 'Друг вернул деньги', good: true, effect: function (s, a) { a.defer(s, 3, { cash: 62000, label: 'Долг возвращён', calm: 3 }); } },
          { p: .28, label: 'Вернул позже и частично', effect: function (s, a) { a.defer(s, 5, { cash: 24000, label: 'Возвращена часть', calm: -2 }); } },
          { p: .17, label: 'Не вернул: деньги потеряны', bad: true, effect: function (s, a) { a.trust(s, -10); a.mood(s, -8, -4); } }
        ]); } },
      { id: 'part', label: 'Дать треть', sub: '20 000 ₽, честно объяснить',
        apply: function (s, a) { a.spend(s, 20000, 'Долг другу', 'fun'); a.trust(s, -4); a.mood(s, -2, -2); a.defer(s, 3, { cash: 14000, label: 'Друг вернул часть', calm: 1 }); } },
      { id: 'no', label: 'Отказать', sub: 'Сохранить деньги, минус доверие',
        apply: function (s, a) { a.trust(s, -14); a.mood(s, -3, -2); } }
    ]
  });

  ev('family-help', {
    kind: 'social', tags: ['family', 'social', 'mid', 'hard'], concept: 'trust',
    shortTitle: 'Помощь родным', title: 'Родным нужна помощь',
    text: 'Нужно 96 000 ₽ на лечение родственника. Это не долг, а помощь: возврата не будет.',
    choices: [
      { id: 'all', label: 'Дать всю сумму', sub: '−96 000 ₽, +20 доверия',
        apply: function (s, a) { a.spend(s, 96000, 'Помощь родным', 'fun'); a.trust(s, 20); a.mood(s, 0, 2); a.energy(s, -6); } },
      { id: 'part', label: 'Дать сколько можете', sub: '−25 000 ₽, +10 доверия',
        apply: function (s, a) { a.spend(s, 25000, 'Помощь родным', 'fun'); a.trust(s, 2); a.mood(s, -2, -1); } },
      { id: 'time', label: 'Помочь делом, а не деньгами', sub: '−34 силы, +12 доверия',
        apply: function (s, a) { a.energy(s, -34); a.trust(s, 12); a.mood(s, -2, -8); a.defer(s, 2, { energy: -10, label: 'Помощь родным выматывает', type: 'bad' }); } }
    ]
  });

  ev('wedding-invite', {
    kind: 'social', tags: ['social', 'easy', 'mid'], concept: 'social',
    shortTitle: 'Свадьба друзей', title: 'Приглашение на свадьбу в другом городе',
    text: 'Дорога, подарок и наряд — около 48 000 ₽. Друзья очень ждут.',
    choices: [
      { id: 'go', label: 'Поехать', sub: '−48 000 ₽, +12 доверия',
        apply: function (s, a) { a.spend(s, 48000, 'Свадьба', 'fun'); a.trust(s, 12); a.mood(s, 3, 12); a.energy(s, -8); } },
      { id: 'modest', label: 'Поехать скромнее', sub: '−22 000 ₽, +6 доверия',
        apply: function (s, a) { a.spend(s, 22000, 'Свадьба', 'fun'); a.trust(s, 6); a.mood(s, 1, 6); } },
      { id: 'skip', label: 'Не поехать', sub: 'Сэкономить, −12 доверия',
        apply: function (s, a) { a.trust(s, -12); a.mood(s, -2, -4); } }
    ]
  });

  ev('roommate', {
    kind: 'offer', tags: ['housing', 'easy', 'mid'], concept: 'optionality',
    shortTitle: 'Сосед съезжает', title: 'Квартира стала дороже',
    text: 'Сосед уезжает. Можно быстро найти нового, искать тщательно или месяц платить одному.',
    choices: [
      { id: 'fast', label: 'Взять первого кандидата', sub: 'Расходы ниже сразу, но риск',
        apply: function (s, a) { a.mandatoryDelta(s, -11000); a.gamble(s, 'roommate-fast', [
          { p: .58, label: 'Сосед оказался нормальным', good: true, effect: function (s, a) { a.mood(s, 4, 2); } },
          { p: .42, label: 'Сосед съехал без оплаты: −38 000 ₽', bad: true, effect: function (s, a) { a.spend(s, 38000, 'Долг соседа', 'shocks'); a.mandatoryDelta(s, 11000); a.mood(s, -10, -7); } }
        ]); } },
      { id: 'careful', label: 'Искать месяц и проверять', sub: 'Дороже сейчас, надёжнее потом',
        apply: function (s, a) { a.spend(s, 11000, 'Месяц без соседа', 'mandatory'); a.defer(s, 1, { mandatory: -9000, label: 'Найден надёжный сосед', calm: 5, quality: 2 }); } },
      { id: 'alone', label: 'Жить одному', sub: 'Дороже, но спокойнее',
        apply: function (s, a) { a.mandatoryDelta(s, 3000); a.mood(s, 3, 8); } }
    ]
  });

  /* ОТДЫХ И КАЧЕСТВО ЖИЗНИ */

  ev('vacation', {
    kind: 'offer', tags: ['energy', 'easy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Отпуск', title: 'Две недели отдыха',
    text: 'Поездка стоит 72 000 ₽. Можно поехать, остаться и взять смены или отдохнуть дома.',
    choices: [
      { id: 'trip', label: 'Поехать', sub: '−72 000 ₽, +24 силы, +15 качества',
        apply: function (s, a) { a.spend(s, 72000, 'Поездка', 'fun'); a.energy(s, 24); a.mood(s, 2, 15); a.trust(s, 4); } },
      { id: 'home', label: 'Отдохнуть дома', sub: '−6 000 ₽, +13 сил',
        apply: function (s, a) { a.spend(s, 6000, 'Отдых дома', 'fun'); a.energy(s, 13); a.mood(s, 1, 2); } },
      { id: 'work', label: 'Работать вместо отпуска', sub: '+28 000 ₽, −26 сил',
        apply: function (s, a) { a.earn(s, 28000, 'Смены вместо отпуска'); a.energy(s, -26); a.mood(s, -5, -8); } }
    ]
  });

  ev('gym-health', {
    kind: 'offer', tags: ['health', 'energy', 'easy', 'mid'], concept: 'energy',
    shortTitle: 'Спорт', title: 'Заняться здоровьем заранее',
    text: 'Годовой абонемент стоит 32 000 ₽. Это расход сейчас и силы потом — но только если ходить.',
    choices: [
      { id: 'year', label: 'Годовой абонемент', sub: '−32 000 ₽, эффект если ходить',
        apply: function (s, a) { a.spend(s, 32000, 'Абонемент', 'fun'); a.gamble(s, 'gym-year', [
          { p: .5, label: 'Ходили регулярно: +силы весь год', good: true, effect: function (s, a) { a.energy(s, 14); a.defer(s, 3, { energy: 12, label: 'Спорт даёт силы' }); a.defer(s, 6, { energy: 10, label: 'Спорт даёт силы' }); a.mood(s, 4, 8); } },
          { p: .5, label: 'Забросили через месяц', bad: true, effect: function (s, a) { a.mood(s, -4, -2); } }
        ]); } },
      { id: 'month', label: 'Платить по месяцам', sub: '3 200 ₽/мес, можно бросить', concept: 'optionality',
        apply: function (s, a) { a.addSub(s, 'Спорт', 3200); a.energy(s, 8); a.mood(s, 2, 4); } },
      { id: 'free', label: 'Бегать бесплатно', sub: 'Ноль расходов, нужна дисциплина',
        apply: function (s, a) { a.gamble(s, 'gym-free', [
          { p: .38, label: 'Привычка закрепилась', good: true, effect: function (s, a) { a.energy(s, 12); a.mood(s, 3, 5); } },
          { p: .62, label: 'Не пошло', effect: function (s, a) { a.mood(s, -1, -1); } }
        ]); } }
    ]
  });

  ev('bonus-year', {
    kind: 'offer', tags: ['income', 'save', 'easy', 'mid', 'hard'], concept: 'avalanche',
    shortTitle: 'Премия', title: 'Годовая премия 90 000 ₽',
    text: 'Деньги сверх обычного дохода. Один ход, который определит, чем закончится год.',
    choices: [
      { id: 'reserve', label: 'В резерв', sub: 'Устойчивость',
        apply: function (s, a) { a.earn(s, 90000, 'Премия'); a.toReserve(s, 90000); a.mood(s, 9, -8); } },
      { id: 'debt', label: 'На дорогой долг', needs: 'debt',
        sub: function (s, E) { return 'Останется долгов на ' + money(Math.max(0, E.debtBalanceTotal(s) - 90000)); },
        apply: function (s, a) { a.earn(s, 90000, 'Премия'); var d = s.debts.sort(function (x, y) { return y.monthlyRate - x.monthlyRate; })[0]; if (d) { var x = Math.min(90000, d.balance); d.balance -= x; s.cash -= x; s.flows.debtPaid += x; a.note(s, 'Досрочно погашено: ' + d.label, -x, 'good'); } a.mood(s, 9, 0); } },
      { id: 'split', label: '60% резерв, 30% себе', sub: 'И будущее, и настоящее',
        apply: function (s, a) { a.earn(s, 90000, 'Премия'); a.toReserve(s, 54000); a.spend(s, 27000, 'Отдых', 'fun'); a.energy(s, 9); a.mood(s, 3, 8); } }
    ]
  });

  ev('buy-groceries', {
    kind: 'quiet', tags: ['food'],
    shortTitle: 'Бюджет на продукты', title: 'Сколько тратить на продукты?',
    text: 'Выберите ежемесячный бюджет на еду на ближайший год. Он будет списываться каждый месяц и напрямую влияет на самочувствие.',
    choices: [
      { id: 'minimal', label: 'Экономно', sub: 'Только самое необходимое',
        apply: function (s, a) { var x = Math.max(sum(s, 7200), sum(s, 8000)); a.setFoodBudget(s, x); a.note(s, 'Бюджет на продукты: ' + x + ' \u20bd/мес', -x, 'bad'); } },
      { id: 'budget', label: 'Обычный набор', sub: 'Ничего лишнего, но без ограничений',
        apply: function (s, a) { var x = Math.max(sum(s, 10000), sum(s, 12000)); a.setFoodBudget(s, x); a.note(s, 'Бюджет на продукты: ' + x + ' \u20bd/мес', -x, 'info'); } },
      { id: 'comfort', label: 'С запасом', sub: 'Разнообразная и качественная еда',
        apply: function (s, a) { var x = Math.max(sum(s, 15000), sum(s, 20000)); a.setFoodBudget(s, x); a.note(s, 'Бюджет на продукты: ' + x + ' \u20bd/мес', -x, 'good'); } }
    ]
  });

  ev('random-loss', {
    kind: 'shock', tags: ['random'],
    shortTitle: 'Внеплановая трата', title: 'Неожиданная трата',
    text: 'В обычной жизни не всё можно запланировать: поломка, штраф или срочная покупка. Как закрыть расход?',
    choices: [
      { id: 'cash', label: 'Оплатить из наличных', sub: 'Закрыть сразу',
        apply: function (s, a) { a.spend(s, sum(s, 13000), 'Внеплановая трата', 'shocks'); a.mood(s, -3, -1); } },
      { id: 'reserve', label: 'Взять из резерва', needs: 'reserve',
        sub: function (s) { return 'В резерве сейчас ' + money(Math.round(s.reserve)); },
        apply: function (s, a) { var need = sum(s, 13000); var x = Math.min(need, s.reserve); s.reserve -= x; s.flows.shocks += x; a.spend(s, need - x, 'Внеплановая трата', 'shocks'); a.note(s, 'Из резерва на внеплановую трату', -x, 'reserve'); a.mood(s, -5, 0); } },
      { id: 'delay', label: 'Отложить проблему', sub: 'Экономия сейчас, риск позже',
        apply: function (s, a) { a.defer(s, 2, { cash: -sum(s, 25000), label: 'Отложенная проблема стала дороже', bucket: 'shocks', calm: -6, quality: -4 }); a.mood(s, -2, -2); } }
    ]
  });

  ev('random-windfall', {
    kind: 'opportunity', tags: ['random'],
    shortTitle: 'Неожиданные деньги', title: 'Неожиданное пополнение',
    text: 'Вернули старый долг, пришёл налоговый вычет или небольшое наследство. На что направить {45000} ₽?',
    choices: [
      { id: 'reserve', label: 'Отправить в резерв', sub: 'Больше устойчивости',
        apply: function (s, a) { var w = sum(s, 45000); a.earn(s, w, 'Неожиданное пополнение'); a.toReserve(s, w); a.mood(s, 5, 0); } },
      { id: 'debt', label: 'Закрыть часть долга', needs: 'debt',
        sub: function (s, E) { return 'Сейчас долгов на ' + money(E.debtBalanceTotal(s)); },
        apply: function (s, a) { a.earn(s, sum(s, 45000), 'Неожиданное пополнение'); var d = s.debts.sort(function (x, y) { return y.monthlyRate - x.monthlyRate; })[0]; if (d) { var x = Math.min(sum(s, 45000), d.balance); d.balance -= x; s.cash -= x; s.flows.debtPaid += x; } a.mood(s, 5, -1); } },
      { id: 'life', label: 'Часть себе, часть в запас', sub: '{15000} ₽ на жизнь, остальное — резерв',
        apply: function (s, a) { a.earn(s, sum(s, 45000), 'Неожиданное пополнение'); a.spend(s, sum(s, 15000), 'Отдых и важные покупки', 'fun'); a.toReserve(s, sum(s, 30000)); a.energy(s, 7); a.mood(s, 2, 7); } }
    ]
  });

  ev('random-invest', {
    kind: 'opportunity', tags: ['random'],
    requires: function (s) { return s.cash >= 30000; },
    shortTitle: 'Инвестиционная возможность', title: 'Появилась возможность вложиться',
    text: 'Коллега предлагает поучаствовать в небольшом проекте. Доход не гарантирован, деньги будут недоступны несколько месяцев.',
    choices: [
      { id: 'invest', label: 'Вложить 30 000 ₽', sub: 'Рискнуть частью свободных денег',
        apply: function (s, a) { a.spend(s, 30000, 'Вложение в проект', 'invested'); a.gamble(s, 'random-invest-' + s.month, [
          { p: .55, label: 'Проект принёс 48 000 ₽', good: true, effect: function (s, a) { a.earn(s, 48000, 'Доход от проекта'); a.mood(s, 5, 2); } },
          { p: .45, label: 'Проект не окупился', bad: true, effect: function (s, a) { a.mood(s, -6, -3); } }
        ]); } },
      { id: 'small', label: 'Вложить 10 000 ₽', sub: 'Проверить идею малой суммой',
        apply: function (s, a) { a.spend(s, 10000, 'Пробное вложение', 'invested'); a.gamble(s, 'random-invest-small-' + s.month, [
          { p: .55, label: 'Пробное вложение вернулось с прибылью', good: true, effect: function (s, a) { a.earn(s, 16000, 'Доход от проекта'); a.mood(s, 2, 1); } },
          { p: .45, label: 'Пробное вложение не окупилось', bad: true, effect: function (s, a) { a.mood(s, -2, -1); } }
        ]); } },
      { id: 'skip', label: 'Пропустить', sub: 'Ликвидность важнее',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  ev('random-sell-investment', {
    kind: 'offer', tags: ['random'],
    requires: function (s) { return s.assets.length > 0; },
    shortTitle: 'Продать актив', title: 'Нужны деньги или оставить актив?',
    text: 'Один из ваших активов можно продать сейчас. Это даст деньги сразу, но лишит будущего роста.',
    choices: [
      { id: 'sell', label: 'Продать актив', sub: 'Получить деньги сейчас',
        apply: function (s, a) { var asset = s.assets.sort(function (x, y) { return y.value - x.value; })[0]; if (asset) { s.assets.splice(s.assets.indexOf(asset), 1); a.earn(s, asset.value * .92, 'Продажа актива'); a.mood(s, 4, -2); } } },
      { id: 'keep', label: 'Оставить в росте', sub: 'Не забирать деньги из актива',
        apply: function (s, a) { a.mood(s, 1, 1); } }
    ]
  });

  /*
   *  МЕЖМЕСЯЧНЫЕ СОБЫТИЯ
   *
   *  Возникают между ключевыми решениями и делают ход времени живым:
   *  удача, беда, соблазн и возможность занять денег. Все исходы решает
   *  жеребьёвка, привязанная к seed и событию, но НЕ к выбору игрока.
   */

  ev('random-casino', {
    kind: 'temptation', tags: ['random'], concept: 'expected',
    requires: function (s) { return s.cash >= 12000; },
    shortTitle: 'Ставка', title: 'Быстрые деньги в казино',
    text: 'Знакомый рассказывает, как поднял сумму за вечер. Заведение работает в плюс всегда — иначе бы его не было. Но соблазн реальный.',
    choices: [
      { id: 'big', label: 'Поставить 30 000 ₽', sub: 'Шанс на крупный выигрыш', concept: 'ruin',
        apply: function (s, a) {
          var bet = Math.min(30000, Math.max(0, s.cash));
          a.spend(s, bet, 'Ставка в казино', 'fun');
          a.gamble(s, 'casino-big-' + s.month, [
            { p: .12, label: 'Повезло: выигрыш ' + Math.round(bet * 2.5) + ' ₽', good: true,
              effect: function (s, a) { a.earn(s, bet * 2.5, 'Выигрыш в казино'); a.mood(s, 6, 9); } },
            { p: .88, label: 'Проигрыш в казино: −' + Math.round(bet) + ' ₽', bad: true,
              effect: function (s, a) { a.mood(s, -11, -6); a.energy(s, -6); } }
          ]);
        } },
      { id: 'small', label: 'Поставить 5 000 ₽', sub: 'Развлечение с известной ценой',
        apply: function (s, a) {
          var bet = Math.min(5000, Math.max(0, s.cash));
          a.spend(s, bet, 'Ставка в казино', 'fun');
          a.gamble(s, 'casino-small-' + s.month, [
            { p: .16, label: 'Небольшой выигрыш в казино', good: true,
              effect: function (s, a) { a.earn(s, bet * 2, 'Выигрыш в казино'); a.mood(s, 3, 4); } },
            { p: .84, label: 'Проигрыш в казино', bad: true,
              effect: function (s, a) { a.mood(s, -4, -1); } }
          ]);
        } },
      { id: 'skip', label: 'Не играть', sub: 'Единственный вариант с плюсом в среднем',
        apply: function (s, a) { a.mood(s, 2, -1); } }
    ]
  });

  ev('random-inheritance', {
    kind: 'opportunity', tags: ['random'], concept: 'liquidity',
    shortTitle: 'Наследство', title: 'Вам досталось наследство',
    text: 'Дальний родственник оставил 320 000 ₽. Деньги пришли сразу и целиком: теперь всё зависит от того, куда они уйдут.',
    choices: [
      { id: 'reserve', label: 'Всё в резерв', sub: 'Подушка на годы вперёд',
        apply: function (s, a) { a.earn(s, 320000, 'Наследство'); a.toReserve(s, 320000); a.mood(s, 11, 2); } },
      { id: 'debt', label: 'Закрыть долги, остальное в резерв', needs: 'debt',
        sub: function (s, E) { return 'Сначала убрать проценты: сейчас долгов на ' + money(E.debtBalanceTotal(s)); },
        apply: function (s, a) {
          a.earn(s, 320000, 'Наследство');
          var left = 320000;
          s.debts.sort(function (x, y) { return y.monthlyRate - x.monthlyRate; }).forEach(function (d) {
            if (left <= 0 || d.balance <= 0) return;
            var pay = Math.min(left, d.balance);
            d.balance -= pay; s.cash -= pay; left -= pay; s.flows.debtPaid += pay;
            a.note(s, 'Погашено из наследства: ' + d.label, -pay, 'good');
          });
          if (left > 0) a.toReserve(s, left);
          a.mood(s, 13, 3);
        } },
      { id: 'invest', label: 'Вложить в актив под 9% годовых', sub: 'Доходнее, но менее доступно',
        apply: function (s, a) { a.earn(s, 320000, 'Наследство'); a.spend(s, 300000, 'Вложение наследства', 'invested'); a.addAsset(s, { id: 'inherit-asset', label: 'Долгосрочный актив', value: 300000, annualRate: .09 }); a.mood(s, 7, 3); } },
      { id: 'spend', label: 'Обновить жизнь сейчас', sub: 'Много удовольствия, ноль устойчивости',
        apply: function (s, a) { a.earn(s, 320000, 'Наследство'); a.spend(s, 240000, 'Крупные покупки', 'fun'); a.toReserve(s, 80000); a.mood(s, 4, 22); a.energy(s, 8); } }
    ]
  });

  ev('random-loan-offer', {
    kind: 'offer', tags: ['random'], concept: 'debtload',
    shortTitle: 'Кредит наличными', title: 'Банк одобрил кредит наличными',
    text: 'Предодобрено 250 000 ₽ под 24% годовых на 36 месяцев. Деньги придут сразу, платёж появится в бюджете уже в этом месяце.',
    choices: [
      { id: 'big', label: 'Взять 250 000 ₽', sub: 'Много денег сейчас, платёж на 3 года',
        apply: function (s, a) { a.borrow(s, { id: 'loan-big-' + s.month, label: 'Кредит наличными', principal: 250000, annualRate: .24, months: 36 }); a.mood(s, -4, 9); } },
      { id: 'small', label: 'Взять 80 000 ₽', sub: 'Меньше денег, меньше нагрузки',
        apply: function (s, a) { a.borrow(s, { id: 'loan-small-' + s.month, label: 'Небольшой кредит', principal: 80000, annualRate: .24, months: 24 }); a.mood(s, -1, 4); } },
      { id: 'no', label: 'Отказаться', sub: 'Без нового платежа в бюджете',
        apply: function (s, a) { a.mood(s, 3, -1); } }
    ]
  });

  ev('random-emergency-loan', {
    kind: 'shock', tags: ['random'], concept: 'negotiation',
    requires: function (s, E) { return s.cash < s.mandatory * 0.6; },
    shortTitle: 'Срочно нужны деньги', title: 'Денег до зарплаты не хватает',
    text: 'Расходы уже случились, а денег на счёте мало. Занять можно быстро, но у каждого способа своя цена.',
    choices: [
      { id: 'bank', label: 'Кредит в банке под 26%', sub: 'Дорого, зато предсказуемо',
        apply: function (s, a) { a.borrow(s, { id: 'loan-eme-' + s.month, label: 'Кредит до зарплаты', principal: 60000, annualRate: .26, months: 18 }); a.mood(s, -3, 2); } },
      { id: 'family', label: 'Попросить у близких', sub: 'Дешевле деньгами, дороже отношениями',
        apply: function (s, a) { a.earn(s, 45000, 'Помощь близких'); a.trust(s, -14); a.mood(s, -2, 1); a.defer(s, 5, { cash: -45000, label: 'Вернули долг близким', bucket: 'fun' }); } },
      { id: 'cut', label: 'Урезать расходы и потерпеть', sub: 'Без долга, но тяжело',
        apply: function (s, a) { a.mandatoryDelta(s, -4000); a.mood(s, -5, -9); a.energy(s, -7); } }
    ]
  });

  ev('random-market-dip', {
    kind: 'offer', tags: ['random'], concept: 'diversify',
    requires: function (s) { return s.cash >= 40000; },
    shortTitle: 'Рынок просел', title: 'Активы подешевели',
    text: 'Рынок упал на 18%. Купить сейчас дешевле, чем месяц назад, но никто не обещает, что падение закончилось.',
    choices: [
      { id: 'buy', label: 'Вложить 60 000 ₽', sub: 'Покупка на спаде',
        apply: function (s, a) {
          var amount = Math.min(60000, Math.max(0, s.cash));
          a.spend(s, amount, 'Покупка активов на спаде', 'invested');
          a.gamble(s, 'market-dip-' + s.month, [
            { p: .58, label: 'Рынок восстановился: актив вырос', good: true,
              effect: function (s, a) { a.addAsset(s, { id: 'dip-' + s.month, label: 'Портфель', value: amount * 1.28, annualRate: .1 }); a.mood(s, 6, 2); } },
            { p: .42, label: 'Падение продолжилось: актив просел', bad: true,
              effect: function (s, a) { a.addAsset(s, { id: 'dip-' + s.month, label: 'Портфель', value: amount * .74, annualRate: .1 }); a.mood(s, -7, -2); } }
          ]);
        } },
      { id: 'wait', label: 'Подождать ясности', sub: 'Деньги остаются доступными',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  ev('random-medical-bill', {
    kind: 'shock', tags: ['random'], concept: 'insurance',
    shortTitle: 'Лечение', title: 'Понадобилось лечение',
    text: 'Обследование и лечение стоят {38000} ₽. Откладывать можно, но проблема редко становится дешевле.',
    choices: [
      { id: 'pay', label: 'Оплатить сразу', sub: 'Дорого, но закрыто',
        apply: function (s, a) { a.spend(s, sum(s, 38000), 'Лечение', 'shocks'); a.energy(s, 9); a.mood(s, 2, 3); } },
      { id: 'loan', label: 'Оплатить в кредит', sub: 'Сейчас легче, дальше платёж',
        apply: function (s, a) { a.borrow(s, { id: 'loan-med-' + s.month, label: 'Кредит на лечение', principal: sum(s, 38000), annualRate: .22, months: 18 }); a.energy(s, 9); a.mood(s, -2, 2); } },
      { id: 'skip', label: 'Отложить лечение', sub: 'Экономия сейчас, риск потом',
        apply: function (s, a) { a.mood(s, -4, -5); a.energy(s, -10); a.defer(s, 4, { cash: -sum(s, 70000), label: 'Запущенная болезнь обошлась дороже', bucket: 'shocks', energy: -12, calm: -8 }); } }
    ]
  });


  /*
   *  КРЕДИТЫ: рейтинг, ставка, досрочное погашение, рефинансирование
   *
   *  Главная мысль всего блока: ставка — не свойство банка, а цена вашей
   *  кредитной истории. Одна просрочка стоит месяцев аккуратности, и стоит
   *  она деньгами, которые можно посчитать.
   */

  ev('credit-offer-rate', {
    kind: 'offer', tags: ['credit', 'debt', 'easy', 'mid', 'hard'], concept: 'creditscore',
    shortTitle: 'Кредит по вашей ставке', title: 'Банк назвал вашу ставку',
    text: 'Заявка на кредит одобрена. Ставка зависит от кредитного рейтинга: у одного и того же банка для разных людей она разная. Сумма — то, что банк готов дать именно вам.',
    forecast: {
      question: 'Сколько составит переплата за 3 года при ставке 22% на {200000} ₽?',
      // Сумма кредита пересчитывается под доход сценария, значит и границы
      // ползунка обязаны ехать за ней: иначе правильный ответ просто
      // не помещается на шкалу.
      max: function (E, s) { return sum(s, 120000); },
      step: function (E, s) { return sum(s, 2000); },
      actual: function (E, s) { return E.annuityOverpay(sum(s, 200000), E.annualToMonthly(0.22), 36); },
      reveal: function (E, s) {
        return 'Переплата ' + Math.round(E.annuityOverpay(sum(s, 200000), E.annualToMonthly(0.22), 36)) +
          ' \u20bd. При ставке на 5 пунктов ниже она была бы ' +
          Math.round(E.annuityOverpay(sum(s, 200000), E.annualToMonthly(0.17), 36)) +
          ' \u20bd. Разницу оплачивает кредитная история.';
      }
    },
    choices: [
      { id: 'take', label: 'Взять кредит', sub: 'Ставка по рейтингу, срок 36 месяцев',
        apply: function (s, a, E) {
          // Спрашиваем банк через askCredit: так ответ попадает в состояние,
          // и предварительный расчёт может честно предупредить об отказе.
          var want = a.askCredit(s, sum(s, 200000));
          if (!want) { a.note(s, 'Банк отказал: рейтинг слишком низкий', 0, 'bad'); s.stats.creditRefused++; a.mood(s, -4, -1); return; }
          a.borrow(s, { id: 'cr-rate-' + s.month, label: 'Кредит наличными', principal: want, baseAnnualRate: 0.22, months: 36, checkLimit: false });
          a.mood(s, -3, 7);
        } },
      { id: 'half', label: 'Взять половину суммы', sub: 'Меньше нагрузка на бюджет', concept: 'debtload',
        apply: function (s, a, E) {
          var want = Math.min(E.creditLimit(s), sum(s, 200000)) / 2;
          if (want < sum(s, 15000)) { a.note(s, 'Банк отказал в кредите', 0, 'bad'); s.stats.creditRefused++; a.mood(s, -3, -1); return; }
          a.borrow(s, { id: 'cr-rate-h-' + s.month, label: 'Кредит наличными', principal: want, baseAnnualRate: 0.22, months: 30 });
          a.mood(s, -1, 3);
        } },
      { id: 'no', label: 'Отказаться', sub: 'Рейтинг сохранится, платежа не будет',
        apply: function (s, a) { a.credit(s, 4); a.mood(s, 3, -1); } }
    ]
  });

  ev('credit-refinance', {
    kind: 'offer', tags: ['credit', 'debt', 'mid', 'hard'], concept: 'refinance',
    requires: function (s, E) { return E.debtBalanceTotal(s) > 80000; },
    shortTitle: 'Рефинансирование', title: 'Перевести долги в другой банк',
    text: 'Долги можно свести в один кредит под новую ставку. Ставку назначают по рейтингу: при хорошей истории это экономия, при испорченной — ухудшение.',
    choices: [
      { id: 'yes', label: 'Рефинансировать на 36 месяцев', sub: 'Ставка по рейтингу',
        apply: function (s, a, E) {
          var before = E.debtPaymentsTotal(s);
          a.refinance(s, { baseAnnualRate: 0.19, months: 36 });
          var after = E.debtPaymentsTotal(s);
          a.note(s, after < before ? 'Платёж снизился' : 'Платёж вырос', Math.round(before - after), after < before ? 'good' : 'bad');
          a.mood(s, after < before ? 6 : -5, 1);
        } },
      { id: 'long', label: 'Растянуть на 60 месяцев', sub: 'Платёж ниже, переплата выше', concept: 'annuity',
        apply: function (s, a, E) { a.refinance(s, { baseAnnualRate: 0.19, months: 60 }); a.mood(s, 4, 3); } },
      { id: 'no', label: 'Оставить как есть', sub: 'Ничего не меняем',
        apply: function (s, a) { a.mood(s, -1, 0); } }
    ]
  });

  ev('credit-early-repay', {
    kind: 'offer', tags: ['credit', 'debt', 'save', 'mid', 'hard'], concept: 'avalanche',
    requires: function (s, E) { return E.debtBalanceTotal(s) > 20000 && s.cash > 40000; },
    shortTitle: 'Гасить досрочно', title: 'Есть свободные деньги: гасить долг?',
    text: 'Досрочное погашение убирает будущие проценты и поднимает рейтинг. Но деньги, ушедшие в долг, перестают быть доступными: резерв от этого не растёт.',
    choices: [
      { id: 'avalanche', label: 'Гасить самый дорогой долг', sub: 'Меньше переплата', concept: 'avalanche',
        apply: function (s, a) { a.repay(s, s.cash * 0.6); a.mood(s, 5, -2); } },
      { id: 'snowball', label: 'Гасить самый маленький долг', sub: 'Дороже, зато виден результат',
        apply: function (s, a) { a.repay(s, s.cash * 0.6, { snowball: true }); a.mood(s, 7, 0); } },
      { id: 'reserve', label: 'Не гасить, пополнить резерв', sub: 'Доступность важнее экономии', concept: 'liquidity',
        apply: function (s, a) { a.toReserve(s, s.cash * 0.6); a.mood(s, 3, 0); } }
    ]
  });

  ev('credit-microloan', {
    kind: 'scam', tags: ['credit', 'debt', 'mid', 'hard'], lesson: true, concept: 'mfo',
    shortTitle: 'Займ до зарплаты', title: 'Деньги за 5 минут без проверок',
    text: '«0,8% в день, одобрение всем». Ставка выглядит маленькой, потому что названа за день, а не за год.',
    forecast: {
      question: 'Сколько это процентов годовых?', max: 400, step: 5, unit: '%',
      actual: function () { return 292; },
      reveal: function () { return '0,8% в день — это 292% годовых простыми процентами и более 1 500% с капитализацией. Ставку специально называют за день, чтобы она звучала как мелочь.'; }
    },
    choices: [
      { id: 'take', label: 'Взять 30 000 ₽ до зарплаты', sub: '0,8% в день', scamHit: true,
        apply: function (s, a) { a.borrow(s, { id: 'mfo-' + s.month, label: 'Займ МФО', principal: 30000, annualRate: 2.92, months: 6, checkLimit: false }); a.credit(s, -30); a.mood(s, -9, 3); } },
      { id: 'bank', label: 'Пойти в банк за обычным кредитом', sub: 'Дольше, но в разы дешевле',
        apply: function (s, a, E) {
          if (!a.askCredit(s, 30000)) { a.note(s, 'Банк отказал, но и долга под 292% нет', 0, 'info'); a.mood(s, -2, -2); return; }
          a.borrow(s, { id: 'bank-' + s.month, label: 'Кредит в банке', principal: 30000, baseAnnualRate: 0.24, months: 12, checkLimit: false });
          a.mood(s, 1, 1);
        } },
      { id: 'no', label: 'Не занимать вообще', sub: 'Урезать расходы и дотерпеть',
        apply: function (s, a) { a.livingDelta(s, -0.02); a.mood(s, 2, -6); a.energy(s, -5); } }
    ]
  });

  ev('credit-guarantor', {
    kind: 'social', tags: ['credit', 'social', 'family', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Поручительство', title: 'Друг просит стать поручителем',
    text: 'Поручитель платит вместо заёмщика, если тот перестал платить, — и его кредитный рейтинг падает вместе с чужим. Отказ стоит отношений, согласие может стоить денег.',
    choices: [
      { id: 'yes', label: 'Согласиться', sub: 'Отношения дороже',
        apply: function (s, a) { a.trust(s, 10); a.gamble(s, 'guarantor-' + s.month, [
          { p: .68, label: 'Друг платит исправно', good: true, effect: function (s, a) { a.mood(s, 3, 2); a.trust(s, 5); } },
          { p: .32, label: 'Друг перестал платить: долг перешёл к вам', bad: true, effect: function (s, a) { a.addDebt(s, { id: 'guar-' + s.month, label: 'Долг за друга', principal: sum(s, 120000), annualRate: .25, months: 24 }); a.credit(s, -40); a.trust(s, -18); a.mood(s, -12, -6); } }
        ]); } },
      { id: 'money', label: 'Не поручаться, но дать денег', sub: 'Сумма, которую готовы потерять', concept: 'ruin',
        apply: function (s, a) { a.spend(s, sum(s, 30000), 'Помощь другу', 'fun'); a.trust(s, 6); a.mood(s, 2, 1); } },
      { id: 'no', label: 'Отказаться и объяснить почему', sub: 'Честно, но неприятно', concept: 'negotiation',
        apply: function (s, a) { a.trust(s, -8); a.mood(s, -3, -2); } }
    ]
  });

  ev('credit-restructure', {
    kind: 'offer', tags: ['credit', 'debt', 'hard'], concept: 'negotiation',
    requires: function (s, E) { return E.debtPaymentsTotal(s) > s.income * 0.3; },
    shortTitle: 'Платить нечем', title: 'Платежи перестали помещаться в бюджет',
    text: 'Есть три пути: договориться с банком заранее, платить через силу или молча пропустить платёж. Третий вариант дороже всех, хотя выглядит самым лёгким.',
    choices: [
      { id: 'talk', label: 'Прийти в банк заранее', sub: 'Каникулы на 3 месяца', concept: 'negotiation',
        apply: function (s, a) { s.debts.forEach(function (d) { d.payment *= 0.45; d.months += 6; }); a.note(s, 'Согласованы кредитные каникулы', 0, 'info'); a.credit(s, -8); a.mood(s, 7, 2); a.defer(s, 3, { label: 'Каникулы закончились, платёж вернулся', calm: -3, effect: function (s2) { s2.debts.forEach(function (d) { d.payment /= 0.45; }); } }); } },
      { id: 'push', label: 'Платить через силу', sub: 'Урезать всё остальное',
        apply: function (s, a) { a.livingDelta(s, -0.04); a.setFoodBudget(s, Math.max(7000, s.foodBudget - 3000)); a.mood(s, -6, -10); a.energy(s, -8); } },
      { id: 'skip', label: 'Пропустить платёж', sub: 'Проще всего сегодня',
        concept: 'late',
        apply: function (s, a) { s.debts.forEach(function (d) { d.balance *= 1.03; }); a.credit(s, -55); s.stats.late++; a.note(s, 'Пропущен платёж: штраф и удар по рейтингу', 0, 'bad'); a.mood(s, -10, -3); } }
    ]
  });

  /*
   *  БЫТ: небольшие ежемесячные решения
   *
   *  Нужны потому, что теперь событие есть в каждом месяце. Крупные дилеммы
   *  каждый месяц утомили бы и обесценились — а быт как раз и есть то место,
   *  где деньги утекают незаметно.
   */

  ev('daily-living-review', {
    kind: 'quiet', tags: ['save', 'easy', 'mid', 'hard'], concept: 'lifestyle',
    shortTitle: 'Бытовые расходы', title: 'Куда уходит остальное',
    text: 'Кроме аренды, еды и подписок каждый месяц уходит ещё часть дохода: транспорт, кафе, одежда, подарки, мелочи. Эту долю можно менять — но не обнулить.',
    choices: [
      { id: 'cut', label: 'Жить заметно скромнее', sub: 'Меньше трат, меньше радости',
        apply: function (s, a) { a.livingDelta(s, -0.04); a.mood(s, 1, -7); } },
      { id: 'trim', label: 'Подрезать лишнее', sub: 'Небольшая экономия',
        apply: function (s, a) { a.livingDelta(s, -0.02); a.mood(s, 1, -2); } },
      { id: 'keep', label: 'Оставить как есть', sub: 'Жизнь важнее таблицы',
        apply: function (s, a) { a.mood(s, 0, 3); } }
    ]
  });

  ev('daily-savings-review', {
    kind: 'quiet', tags: ['save', 'easy', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'Автоперевод', title: 'Пересмотреть автоперевод в резерв',
    text: 'Доля дохода, уходящая в резерв автоматически, — единственная привычка, которая работает без ежемесячного решения.',
    choices: [
      { id: 'up', label: 'Поднять до 20%', sub: 'Резерв растёт быстрее',
        apply: function (s, a) { a.setAutoSave(s, Math.min(0.2, s.autoSave + 0.1)); a.mood(s, 4, -3); } },
      { id: 'keep', label: 'Оставить как есть', sub: '',
        apply: function (s, a) { a.mood(s, 0, 1); } },
      { id: 'down', label: 'Снизить или отключить', sub: 'Больше денег в обороте', concept: 'optionality',
        apply: function (s, a) { a.setAutoSave(s, Math.max(0, s.autoSave - 0.1)); a.mood(s, -2, 4); } }
    ]
  });

  ev('daily-transport', {
    kind: 'quiet', tags: ['easy', 'mid', 'hard'],
    shortTitle: 'Дорога', title: 'Как добираться до работы',
    text: 'Проездной дешевле, такси быстрее и оставляет силы. Разница за месяц не выглядит большой — за год выглядит.',
    choices: [
      { id: 'taxi', label: 'Ездить на такси', sub: 'Дорого, зато не выматывает',
        apply: function (s, a) { a.spend(s, sum(s, 9000), 'Такси', 'fun'); a.energy(s, 5); a.mood(s, 1, 3); } },
      { id: 'pass', label: 'Проездной', sub: 'Дёшево и предсказуемо',
        apply: function (s, a) { a.spend(s, sum(s, 2500), 'Проездной', 'fun'); a.mood(s, 1, 0); } },
      { id: 'walk', label: 'Ходить пешком', sub: 'Бесплатно, но долго',
        apply: function (s, a) { a.energy(s, -4); a.mood(s, 0, -1); a.defer(s, 2, { energy: 4, label: 'Привычка ходить пешком окупилась' }); } }
    ]
  });

  ev('daily-clothes', {
    kind: 'temptation', tags: ['easy', 'mid', 'hard'],
    shortTitle: 'Одежда', title: 'Пора обновить гардероб',
    text: 'Часть вещей износилась. Можно закрыть вопрос дёшево, можно купить надолго, можно отложить.',
    choices: [
      { id: 'good', label: 'Купить качественное', sub: 'Дороже сейчас, дольше носится',
        apply: function (s, a) { a.spend(s, sum(s, 24000), 'Одежда', 'fun'); a.mood(s, 0, 7); a.defer(s, 8, { quality: 3, label: 'Вещи всё ещё как новые' }); } },
      { id: 'cheap', label: 'Взять подешевле', sub: 'Хватит на сезон',
        apply: function (s, a) { a.spend(s, sum(s, 8000), 'Одежда', 'fun'); a.mood(s, 0, 3); a.defer(s, 5, { cash: -sum(s, 8000), label: 'Дешёвые вещи пришлось менять', bucket: 'fun' }); } },
      { id: 'wait', label: 'Обойтись тем, что есть', sub: '',
        apply: function (s, a) { a.mood(s, 1, -3); } }
    ]
  });

  ev('daily-friend-birthday', {
    kind: 'social', tags: ['social', 'easy', 'mid', 'hard'], concept: 'trust',
    shortTitle: 'День рождения', title: 'Юбилей у близкого человека',
    text: 'Подарок и вечер стоят денег. Отношения — это тоже накопления, только другой валютой.',
    choices: [
      { id: 'big', label: 'Хороший подарок и вечер', sub: 'Дорого, но запомнится',
        apply: function (s, a) { a.spend(s, sum(s, 15000), 'Подарок и вечер', 'fun'); a.trust(s, 7); a.mood(s, 3, 6); } },
      { id: 'small', label: 'Скромный подарок', sub: 'Внимание важнее суммы',
        apply: function (s, a) { a.spend(s, sum(s, 4000), 'Подарок', 'fun'); a.trust(s, 3); a.mood(s, 1, 2); } },
      { id: 'skip', label: 'Поздравить сообщением', sub: 'Бесплатно',
        apply: function (s, a) { a.trust(s, -5); a.mood(s, -1, -2); } }
    ]
  });

  ev('daily-utility-bill', {
    kind: 'shock', tags: ['housing', 'easy', 'mid', 'hard'], concept: 'inflation',
    shortTitle: 'Счета выросли', title: 'Коммунальные счета подросли',
    text: 'Тариф пересчитали. Сумма небольшая, но она теперь будет приходить каждый месяц.',
    choices: [
      { id: 'accept', label: 'Просто платить', sub: 'Обязательные расходы вырастут',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 800)); a.mood(s, -2, 0); } },
      { id: 'save', label: 'Поставить счётчики и экономить', sub: 'Разовая трата, потом меньше',
        apply: function (s, a) { a.spend(s, sum(s, 12000), 'Счётчики и утепление', 'fun'); a.mandatoryDelta(s, -sum(s, 1200)); a.mood(s, 2, -1); } },
      { id: 'fight', label: 'Разбираться с начислениями', sub: 'Время и нервы, шанс на перерасчёт', concept: 'negotiation',
        apply: function (s, a) { a.energy(s, -6); a.gamble(s, 'utility-' + s.month, [
          { p: .45, label: 'Перерасчёт сделали', good: true, effect: function (s, a) { a.mood(s, 5, 1); } },
          { p: .55, label: 'Перерасчёта не будет', bad: true, effect: function (s, a) { a.mandatoryDelta(s, sum(s, 800)); a.mood(s, -4, -1); } }
        ]); } }
    ]
  });

  ev('daily-home-fix', {
    kind: 'shock', tags: ['housing', 'easy', 'mid', 'hard'],
    shortTitle: 'Мелкий ремонт', title: 'Что-то сломалось дома',
    text: 'Кран, дверь, розетка — по отдельности мелочь. Вопрос в том, чинить сразу или ждать, пока станет большой проблемой.',
    choices: [
      { id: 'now', label: 'Вызвать мастера', sub: 'Быстро и надёжно',
        apply: function (s, a) { a.spend(s, sum(s, 7000), 'Ремонт', 'shocks'); a.mood(s, 2, 1); } },
      { id: 'self', label: 'Починить самому', sub: 'Дёшево, но потратит силы',
        apply: function (s, a) { a.spend(s, sum(s, 1500), 'Материалы', 'shocks'); a.energy(s, -7); a.gamble(s, 'homefix-' + s.month, [
          { p: .7, label: 'Починили сами', good: true, effect: function (s, a) { a.mood(s, 3, 1); } },
          { p: .3, label: 'Сделали хуже, пришлось звать мастера', bad: true, effect: function (s, a) { a.spend(s, sum(s, 11000), 'Переделка', 'shocks'); a.mood(s, -4, -2); } }
        ]); } },
      { id: 'later', label: 'Отложить', sub: 'Пока терпимо',
        apply: function (s, a) { a.mood(s, -1, -2); a.defer(s, 3, { cash: -sum(s, 16000), label: 'Мелкая поломка стала крупной', bucket: 'shocks', calm: -4 }); } }
    ]
  });

  ev('daily-rest', {
    kind: 'quiet', tags: ['energy', 'health', 'easy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Выходные', title: 'Как провести выходные',
    text: 'Силы — такой же ограниченный ресурс, как деньги. Разница в том, что их нельзя занять.',
    choices: [
      { id: 'trip', label: 'Съездить куда-нибудь', sub: 'Дорого, но восстанавливает',
        apply: function (s, a) { a.spend(s, sum(s, 14000), 'Поездка на выходные', 'fun'); a.energy(s, 14); a.mood(s, 5, 8); } },
      { id: 'home', label: 'Отдохнуть дома', sub: 'Бесплатно и спокойно',
        apply: function (s, a) { a.energy(s, 7); a.mood(s, 2, 1); } },
      { id: 'work', label: 'Поработать в выходные', sub: 'Деньги вместо отдыха',
        apply: function (s, a) { a.earn(s, sum(s, 12000), 'Работа в выходные'); a.energy(s, -12); a.mood(s, -3, -4); } }
    ]
  });

  ev('daily-insurance', {
    kind: 'offer', tags: ['save', 'easy', 'mid', 'hard'], concept: 'insurance',
    shortTitle: 'Страховка', title: 'Предлагают оформить страховку',
    text: 'В среднем страховка невыгодна — иначе страховых компаний не было бы. Смысл не в выгоде, а в замене редкой катастрофы на маленький предсказуемый платёж.',
    choices: [
      { id: 'yes', label: 'Оформить', sub: 'Небольшой платёж каждый месяц',
        apply: function (s, a) { a.addSub(s, 'Страховка', Math.round(sum(s, 1400))); a.flag(s, 'insured'); a.mood(s, 4, 0); } },
      { id: 'no', label: 'Отказаться', sub: 'Экономия, но риск на себе',
        apply: function (s, a) { a.mood(s, -1, 1); a.gamble(s, 'noinsurance-' + s.month, [
          { p: .82, label: 'Ничего не случилось', effect: function (s, a) { a.mood(s, 1, 0); } },
          { p: .18, label: 'Случилось то, что покрыла бы страховка', bad: true, effect: function (s, a) { a.spend(s, sum(s, 60000), 'Незастрахованный ущерб', 'shocks'); a.mood(s, -9, -5); } }
        ]); } }
    ]
  });

  ev('daily-learning', {
    kind: 'opportunity', tags: ['career', 'easy', 'mid', 'hard'], concept: 'opportunity',
    shortTitle: 'Небольшое обучение', title: 'Короткий курс по работе',
    text: 'Курс стоит денег и вечеров. Окупаемость считается просто: цена делится на прибавку к месячному доходу.',
    choices: [
      { id: 'take', label: 'Пройти курс', sub: 'Расход сейчас, доход потом',
        apply: function (s, a) { a.spend(s, sum(s, 18000), 'Курс', 'fun'); a.energy(s, -10); a.defer(s, 4, { income: sum(s, 6000), label: 'Новые навыки пригодились', calm: 3 }); } },
      { id: 'free', label: 'Учиться бесплатно самому', sub: 'Дольше и без гарантий',
        apply: function (s, a) { a.energy(s, -13); a.gamble(s, 'selflearn-' + s.month, [
          { p: .5, label: 'Самообучение дало результат', good: true, effect: function (s, a) { a.incomeDelta(s, sum(s, 5000)); a.mood(s, 4, 1); } },
          { p: .5, label: 'Без структуры дело заглохло', effect: function (s, a) { a.mood(s, -3, -1); } }
        ]); } },
      { id: 'skip', label: 'Не сейчас', sub: 'Сохранить силы',
        apply: function (s, a) { a.energy(s, 4); a.mood(s, 1, 1); } }
    ]
  });

  /* НОВЫЕ МЕЖМЕСЯЧНЫЕ СИТУАЦИИ */

  ev('random-small-expense', {
    kind: 'shock', tags: ['random'],
    shortTitle: 'Мелкий расход', title: 'Мелочь, которая не была в плане',
    text: 'Лекарства, ремонт обуви, зарядка вместо сломанной. Ничего страшного — но это происходит почти каждый месяц.',
    choices: [
      { id: 'pay', label: 'Оплатить', sub: 'Закрыть и забыть',
        apply: function (s, a) { a.spend(s, sum(s, 6000), 'Мелкий расход', 'shocks'); a.mood(s, 0, 0); } },
      { id: 'cheap', label: 'Найти вариант подешевле', sub: 'Экономия времени против экономии денег',
        apply: function (s, a) { a.spend(s, sum(s, 2500), 'Мелкий расход', 'shocks'); a.energy(s, -3); a.mood(s, 0, -1); } }
    ]
  });

  ev('random-side-gig', {
    kind: 'opportunity', tags: ['random'], concept: 'energy',
    shortTitle: 'Разовая халтура', title: 'Предложили разовую подработку',
    text: 'Работа на несколько вечеров. Деньги сразу, силы тоже сразу.',
    choices: [
      { id: 'take', label: 'Взяться', sub: 'Деньги за счёт вечеров',
        apply: function (s, a) { a.earn(s, sum(s, 20000), 'Разовая подработка'); a.energy(s, -11); a.mood(s, 1, -2); } },
      { id: 'no', label: 'Отказаться', sub: 'Оставить себе вечера',
        apply: function (s, a) { a.energy(s, 3); a.mood(s, 1, 2); } }
    ]
  });

  ev('random-price-jump', {
    kind: 'shock', tags: ['random'], concept: 'inflation',
    shortTitle: 'Всё подорожало', title: 'Цены заметно выросли',
    text: 'Продукты и обязательные расходы подорожали сильнее обычного. Доход при этом не изменился.',
    choices: [
      { id: 'absorb', label: 'Ничего не менять', sub: 'Расходы вырастут',
        apply: function (s, a) { a.spend(s, sum(s, 4000), 'Подорожание', 'shocks'); a.mandatoryDelta(s, sum(s, 800)); a.mood(s, -3, -1); } },
      { id: 'adapt', label: 'Пересобрать корзину', sub: 'Дешевле, но однообразнее',
        apply: function (s, a) { var floor = Math.round(sum(s, 9000) * Math.pow(1 + s._inflation, s.month)); a.setFoodBudget(s, Math.max(floor, s.foodBudget - sum(s, 1200))); a.energy(s, -4); a.mood(s, 0, -3); } }
    ]
  });

  ev('random-fine', {
    kind: 'shock', tags: ['random'],
    shortTitle: 'Штраф', title: 'Пришёл штраф',
    text: 'Штраф можно оплатить со скидкой в первые дни или обжаловать, потратив время.',
    choices: [
      { id: 'fast', label: 'Оплатить сразу со скидкой', sub: 'Дешевле в два раза',
        apply: function (s, a) { a.spend(s, sum(s, 2500), 'Штраф со скидкой', 'fees'); a.mood(s, -1, 0); } },
      { id: 'appeal', label: 'Обжаловать', sub: 'Время против денег',
        apply: function (s, a) { a.energy(s, -5); a.gamble(s, 'fine-' + s.month, [
          { p: .4, label: 'Штраф отменили', good: true, effect: function (s, a) { a.mood(s, 4, 1); } },
          { p: .6, label: 'Штраф оставили, скидка сгорела', bad: true, effect: function (s, a) { a.spend(s, sum(s, 5000), 'Штраф', 'fees'); a.mood(s, -4, -1); } }
        ]); } }
    ]
  });

  ev('random-scam-sms', {
    kind: 'scam', tags: ['random'], lesson: true, concept: 'scam',
    shortTitle: 'Подозрительное СМС', title: '«Списание 14 900 ₽. Если не вы — позвоните»',
    text: 'В сообщении незнакомый номер и просьба срочно перезвонить. Спешка — главный инструмент мошенника.',
    choices: [
      { id: 'call', label: 'Перезвонить по номеру из СМС', sub: 'Разобраться скорее', scamHit: true,
        apply: function (s, a) { a.spend(s, sum(s, 48000), 'Перевод мошенникам', 'shocks'); a.mood(s, -14, -8); } },
      { id: 'bank', label: 'Позвонить в банк по номеру с карты', sub: 'Проверить самому',
        apply: function (s, a) { a.note(s, 'Списания не было: сообщение поддельное', 0, 'good'); a.mood(s, 3, 0); } },
      { id: 'ignore', label: 'Просто удалить', sub: 'Ничего не делать',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  ev('random-gift', {
    kind: 'opportunity', tags: ['random'],
    shortTitle: 'Приятная мелочь', title: 'Небольшие незапланированные деньги',
    text: 'Кэшбэк, возврат за отменённый заказ или подарок. Сумма маленькая — и именно поэтому обычно исчезает бесследно.',
    choices: [
      { id: 'save', label: 'Отправить в резерв', sub: 'Скучно, но работает',
        apply: function (s, a) { a.earn(s, sum(s, 9000), 'Небольшое пополнение'); a.toReserve(s, sum(s, 9000)); a.mood(s, 2, 0); } },
      { id: 'spend', label: 'Потратить на себя', sub: 'Немного радости',
        apply: function (s, a) { a.earn(s, sum(s, 9000), 'Небольшое пополнение'); a.spend(s, sum(s, 9000), 'Приятная трата', 'fun'); a.mood(s, 1, 5); } }
    ]
  });

  ev('random-bonus', {
    kind: 'opportunity', tags: ['random'], concept: 'lifestyle',
    shortTitle: 'Премия', title: 'На работе выписали премию',
    text: 'Разовые деньги опаснее регулярных: их легко записать в «свободные» и незаметно вплести в бытовые расходы.',
    choices: [
      { id: 'reserve', label: 'Всю премию в резерв', sub: 'До того, как она попала в оборот',
        apply: function (s, a) { a.earn(s, sum(s, 55000), 'Премия'); a.toReserve(s, sum(s, 55000)); a.mood(s, 5, 0); } },
      { id: 'split', label: 'Половину в резерв, половину себе', sub: 'Компромисс',
        apply: function (s, a) { a.earn(s, sum(s, 55000), 'Премия'); a.toReserve(s, sum(s, 27500)); a.spend(s, sum(s, 27500), 'Приятные траты', 'fun'); a.mood(s, 4, 6); } },
      { id: 'spend', label: 'Потратить целиком', sub: 'Заслужил',
        apply: function (s, a) { a.earn(s, sum(s, 55000), 'Премия'); a.spend(s, sum(s, 55000), 'Крупные покупки', 'fun'); a.livingDelta(s, 0.01); a.mood(s, 2, 12); } }
    ]
  });

  ev('random-credit-check', {
    kind: 'quiet', tags: ['random'], concept: 'creditscore',
    shortTitle: 'Кредитный рейтинг', title: 'Пришёл отчёт по кредитной истории',
    text: 'Рейтинг — это память банков о том, как вы обращались с долгами. Он растёт месяцами и падает за один пропущенный платёж. Цена у него денежная: ставка.',
    choices: [
      { id: 'check', label: 'Разобраться в отчёте', sub: 'Понять, из чего он складывается',
        apply: function (s, a, E) {
          var t = E.creditTier(s.creditScore);
          a.note(s, 'Рейтинг ' + Math.round(s.creditScore) + ' \u2014 ' + t.label +
            '. Доступно к займу: ' + Math.round(E.creditLimit(s)) + ' \u20bd', 0, 'info');
          a.mood(s, 2, 0);
        } },
      { id: 'fix', label: 'Заняться рейтингом', sub: 'Аккуратность в обмен на удобство',
        apply: function (s, a) { a.credit(s, 18); a.livingDelta(s, -0.01); a.mood(s, 1, -2); } },
      { id: 'skip', label: 'Не читать', sub: '',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });


  /*
   *  БЫТОВЫЕ СИТУАЦИИ МЕСЯЦА
   *
   *  Их задача — плотность жизни. Каждая мелочь по отдельности не решает
   *  ничего, но за пять лет из них складывается половина бюджета.
   *  Суммы масштабируются под доход сценария, поэтому текст ситуации
   *  вычисляется на лету: числа в описании всегда совпадают с теми,
   *  что игрок реально заплатит.
   */

  /** Формат суммы для текста ситуации. */
  function money(x) {
    return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
  }

  ev('daily-tooth-check', {
    kind: 'quiet', tags: ['health', 'easy', 'mid', 'hard'],
    shortTitle: 'Осмотр у стоматолога', title: 'Плановый осмотр',
    text: function (s) {
      return 'Прошло полгода с последнего визита. Осмотр и чистка стоят ' + money(sum(s, 5500)) +
        '. Ничего не болит, и это главный аргумент, чтобы не идти.';
    },
    choices: [
      { id: 'go', label: 'Сходить', sub: 'Дешевле, чем лечить потом',
        apply: function (s, a) { a.spend(s, sum(s, 5500), 'Осмотр и чистка', 'living'); a.mood(s, 3, 1); a.flag(s, 'dental_ok'); } },
      { id: 'skip', label: 'Отложить до боли', sub: 'Сэкономить сейчас',
        apply: function (s, a) {
          a.mood(s, -1, 1);
          a.gamble(s, 'tooth-skip', [
            { p: .58, label: 'Зубы пока в порядке', good: true, effect: function (s, a) { a.mood(s, 1, 0); } },
            { p: .42, label: 'Через месяц пришлось лечить дороже', bad: true,
              effect: function (s, a) { a.defer(s, 2, { cash: -sum(s, 21000), label: 'Лечение запущенного зуба', bucket: 'shocks', calm: -6, type: 'bad' }); } }
          ]);
        } }
    ]
  });

  ev('daily-screen-crack', {
    kind: 'shock', tags: ['bigbuy', 'easy', 'mid'],
    shortTitle: 'Разбитый экран', title: 'Телефон упал экраном вниз',
    text: function (s) {
      return 'Работает, но трещина через весь экран. Замена в сервисе — ' + money(sum(s, 9000)) +
        ', неоригинальный экран у мастера в переходе — ' + money(sum(s, 4000)) + '.';
    },
    choices: [
      { id: 'service', label: 'Официальный сервис', sub: 'Гарантия и спокойствие',
        apply: function (s, a) { a.spend(s, sum(s, 9000), 'Замена экрана', 'shocks'); a.mood(s, 2, 1); } },
      { id: 'cheap', label: 'Мастер подешевле', sub: 'Экономия против риска',
        apply: function (s, a) {
          a.spend(s, sum(s, 4000), 'Замена экрана у мастера', 'shocks');
          a.gamble(s, 'screen-cheap', [
            { p: .62, label: 'Дешёвый экран работает нормально', good: true, effect: function (s, a) { a.mood(s, 2, 0); } },
            { p: .38, label: 'Экран потёк через месяц, пришлось менять снова', bad: true,
              effect: function (s, a) { a.defer(s, 1, { cash: -sum(s, 8000), label: 'Повторная замена экрана', bucket: 'shocks', calm: -5, type: 'bad' }); } }
          ]);
        } },
      { id: 'live', label: 'Жить с трещиной', sub: 'Ноль рублей, минус нервы',
        apply: function (s, a) { a.mood(s, -3, -4); a.energy(s, -2); } }
    ]
  });

  ev('daily-fridge-noise', {
    kind: 'quiet', tags: ['housing', 'easy', 'mid', 'hard'],
    shortTitle: 'Холодильник шумит', title: 'Холодильник стал громче',
    text: function (s) {
      return 'Гудит и хуже морозит. Диагностика и ремонт — около ' + money(sum(s, 7000)) +
        '. Новый стоит ' + money(sum(s, 45000)) + '.';
    },
    choices: [
      { id: 'fix', label: 'Отремонтировать', sub: 'Продлить жизнь старому',
        apply: function (s, a) {
          a.spend(s, sum(s, 7000), 'Ремонт холодильника', 'living');
          a.gamble(s, 'fridge-fix', [
            { p: .7, label: 'Ремонт помог', good: true, effect: function (s, a) { a.mood(s, 2, 1); } },
            { p: .3, label: 'Через полгода холодильник встал окончательно', bad: true,
              effect: function (s, a) { a.defer(s, 6, { cash: -sum(s, 42000), label: 'Пришлось купить холодильник', bucket: 'shocks', calm: -6, type: 'bad' }); } }
          ]);
        } },
      { id: 'new', label: 'Купить новый сразу', sub: 'Дорого, но надолго',
        apply: function (s, a) { a.spend(s, sum(s, 45000), 'Новый холодильник', 'fun'); a.mood(s, -2, 6); a.flag(s, 'new_fridge'); } },
      { id: 'wait', label: 'Пусть шумит', sub: 'Пока морозит — и ладно',
        apply: function (s, a) {
          a.mood(s, 0, -2);
          a.gamble(s, 'fridge-wait', [
            { p: .55, label: 'Холодильник дотянул', good: true, effect: function (s, a) { a.mood(s, 1, 0); } },
            { p: .45, label: 'Холодильник встал, продукты пропали', bad: true,
              effect: function (s, a) { a.defer(s, 3, { cash: -sum(s, 48000), label: 'Срочная замена холодильника', bucket: 'shocks', calm: -9, quality: -4, type: 'bad' }); } }
          ]);
        } }
    ]
  });

  ev('daily-pet-vet', {
    kind: 'shock', tags: ['health', 'family', 'easy', 'mid', 'hard'],
    shortTitle: 'Ветеринар', title: 'Питомец заболел',
    text: function (s) {
      return 'Кот второй день не ест. Приём с анализами — ' + money(sum(s, 6500)) +
        ', полный курс лечения может выйти в ' + money(sum(s, 19000)) + '.';
    },
    choices: [
      { id: 'full', label: 'Лечить как сказал врач', sub: 'Полный курс',
        apply: function (s, a) { a.spend(s, sum(s, 19000), 'Лечение питомца', 'shocks'); a.mood(s, 4, 3); a.trust(s, 2); } },
      { id: 'min', label: 'Только приём и подождать', sub: 'Минимум сейчас',
        apply: function (s, a) {
          a.spend(s, sum(s, 6500), 'Приём у ветеринара', 'shocks');
          a.gamble(s, 'pet-min', [
            { p: .6, label: 'Питомец поправился сам', good: true, effect: function (s, a) { a.mood(s, 3, 2); } },
            { p: .4, label: 'Стало хуже, лечение вышло дороже', bad: true,
              effect: function (s, a) { a.defer(s, 1, { cash: -sum(s, 24000), label: 'Экстренное лечение питомца', bucket: 'shocks', calm: -8, quality: -5, type: 'bad' }); } }
          ]);
        } }
    ]
  });

  ev('daily-glasses', {
    kind: 'quiet', tags: ['health', 'easy', 'mid'],
    shortTitle: 'Очки', title: 'Стало хуже видно',
    text: function (s) {
      return 'К вечеру буквы расплываются. Проверка зрения и простые очки — ' + money(sum(s, 8000)) +
        ', с хорошими линзами и оправой — ' + money(sum(s, 22000)) + '.';
    },
    choices: [
      { id: 'good', label: 'Взять хорошие', sub: 'Носить каждый день несколько лет',
        apply: function (s, a) { a.spend(s, sum(s, 22000), 'Очки', 'fun'); a.energy(s, 6); a.mood(s, 1, 4); } },
      { id: 'basic', label: 'Взять простые', sub: 'Функция без удовольствия',
        apply: function (s, a) { a.spend(s, sum(s, 8000), 'Простые очки', 'living'); a.energy(s, 3); a.mood(s, 1, 0); } },
      { id: 'none', label: 'Обойтись', sub: 'Щуриться бесплатно',
        apply: function (s, a) { a.energy(s, -7); a.mood(s, -2, -3); } }
    ]
  });

  ev('daily-season-clothes', {
    kind: 'quiet', tags: ['bigbuy', 'easy', 'mid', 'hard'],
    shortTitle: 'Сезонные вещи', title: 'Сезон сменился',
    text: function (s) {
      return 'Прошлогодняя куртка не пережила зиму. Приличная — ' + money(sum(s, 14000)) +
        ', на распродаже прошлой коллекции — ' + money(sum(s, 6000)) + '.';
    },
    choices: [
      { id: 'new', label: 'Купить новую', sub: 'Сразу и без поисков',
        apply: function (s, a) { a.spend(s, sum(s, 14000), 'Куртка', 'fun'); a.mood(s, 1, 4); } },
      { id: 'sale', label: 'Искать на распродаже', sub: 'Дешевле, но потратите вечер',
        apply: function (s, a) { a.spend(s, sum(s, 6000), 'Куртка с распродажи', 'fun'); a.energy(s, -4); a.mood(s, 2, 1); } },
      { id: 'old', label: 'Дотянуть в старой', sub: 'Ноль рублей',
        apply: function (s, a) { a.mood(s, 0, -4); a.energy(s, -3); } }
    ]
  });

  ev('daily-energy-bill', {
    kind: 'shock', tags: ['housing', 'easy', 'mid', 'hard'],
    shortTitle: 'Счёт за свет', title: 'Счёт пришёл больше обычного',
    text: function (s) {
      return 'В квитанции на ' + money(sum(s, 4200)) + ' больше привычного: перерасчёт за полгода. ' +
        'Можно оспорить, но это очереди и звонки.';
    },
    choices: [
      { id: 'pay', label: 'Просто заплатить', sub: 'Быстро и без нервов',
        apply: function (s, a) { a.spend(s, sum(s, 4200), 'Перерасчёт за свет', 'mandatory'); a.mood(s, -2, 0); } },
      { id: 'fight', label: 'Пойти разбираться', sub: 'Время в обмен на деньги',
        apply: function (s, a) {
          a.energy(s, -8); a.mood(s, -3, -1);
          a.gamble(s, 'bill-fight', [
            { p: .5, label: 'Перерасчёт отменили', good: true, effect: function (s, a) { a.mood(s, 6, 1); } },
            { p: .5, label: 'Перерасчёт признали верным', bad: true,
              effect: function (s, a) { a.spend(s, sum(s, 4200), 'Перерасчёт за свет', 'mandatory'); a.mood(s, -4, 0); } }
          ]);
        } }
    ]
  });

  ev('daily-rent-raise', {
    kind: 'shock', tags: ['housing', 'mid', 'hard'],
    shortTitle: 'Аренда дороже', title: 'Хозяин поднимает плату',
    text: function (s) {
      return 'С нового месяца аренда вырастет на ' + money(sum(s, 4500)) + ' в месяц. ' +
        'Переезд обойдётся примерно в ' + money(sum(s, 30000)) + ' и месяц нервов.';
    },
    concept: 'lifestyle',
    choices: [
      { id: 'accept', label: 'Согласиться', sub: 'Остаться на месте',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 4500)); a.mood(s, -4, 0); } },
      { id: 'negotiate', label: 'Поторговаться', sub: 'Спрашивать бесплатно',
        concept: 'negotiation',
        apply: function (s, a) {
          a.gamble(s, 'rent-neg', [
            { p: .45, label: 'Хозяин оставил прежнюю цену', good: true, effect: function (s, a) { a.mood(s, 7, 1); } },
            { p: .35, label: 'Сошлись на половине прибавки', good: true, effect: function (s, a) { a.mandatoryDelta(s, sum(s, 2200)); a.mood(s, 2, 0); } },
            { p: .20, label: 'Хозяин не уступил', bad: true, effect: function (s, a) { a.mandatoryDelta(s, sum(s, 4500)); a.mood(s, -5, -1); } }
          ]);
        } },
      { id: 'move', label: 'Искать другое жильё', sub: 'Разово дорого, дальше дешевле',
        apply: function (s, a) { a.spend(s, sum(s, 30000), 'Переезд', 'shocks'); a.mandatoryDelta(s, -sum(s, 2000)); a.energy(s, -14); a.mood(s, -6, -3); } }
    ]
  });

  ev('daily-transport-pass', {
    kind: 'quiet', tags: ['easy', 'mid', 'hard'],
    shortTitle: 'Дорога на работу', title: 'Проездной подорожал',
    text: function (s) {
      return 'Годовой проездной стоит ' + money(sum(s, 18000)) + ' сразу, помесячно выйдет ' +
        money(sum(s, 2100)) + ' в месяц. Разница за год — ' + money(sum(s, 7200)) + '.';
    },
    choices: [
      { id: 'year', label: 'Взять годовой', sub: 'Крупная сумма сразу, экономия за год',
        apply: function (s, a) { a.spend(s, sum(s, 18000), 'Годовой проездной', 'mandatory'); a.mandatoryDelta(s, -sum(s, 600)); a.mood(s, 3, 1); } },
      { id: 'month', label: 'Платить помесячно', sub: 'Дороже, но по частям',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 500)); a.mood(s, 0, 0); } },
      { id: 'walk', label: 'Ходить пешком часть пути', sub: 'Экономия и время',
        apply: function (s, a) { a.mandatoryDelta(s, -sum(s, 400)); a.energy(s, -5); a.mood(s, 1, 2); } }
    ]
  });

  ev('daily-delivery-habit', {
    kind: 'temptation', tags: ['subs', 'easy', 'mid', 'hard'], concept: 'subs',
    shortTitle: 'Доставка еды', title: 'Доставка стала привычкой',
    text: function (s) {
      return 'За месяц на доставку ушло ' + money(sum(s, 11000)) + '. Каждый заказ казался разумным: ' +
        'поздно, устал, некогда готовить.';
    },
    choices: [
      { id: 'stop', label: 'Свести к одному разу в неделю', sub: 'Готовить чаще',
        apply: function (s, a) { a.livingDelta(s, -0.02); a.energy(s, -5); a.mood(s, 3, -2); a.flag(s, 'cooks'); } },
      { id: 'limit', label: 'Поставить лимит на месяц', sub: 'Компромисс',
        apply: function (s, a) { a.livingDelta(s, -0.01); a.energy(s, -2); a.mood(s, 2, 0); } },
      { id: 'keep', label: 'Оставить как есть', sub: 'Это покупка времени',
        apply: function (s, a) { a.livingDelta(s, 0.01); a.energy(s, 4); a.mood(s, 0, 3); } }
    ]
  });

  ev('daily-marketplace', {
    kind: 'temptation', tags: ['bigbuy', 'easy', 'mid', 'hard'], concept: 'impulse',
    shortTitle: 'Распродажа', title: 'Большая распродажа',
    text: function (s) {
      return 'В корзине набралось на ' + money(sum(s, 16000)) + '. Половина — вещи, о которых вы не думали ' +
        'до того, как увидели скидку.';
    },
    choices: [
      { id: 'all', label: 'Забрать всю корзину', sub: 'Скидка кончится завтра',
        apply: function (s, a) { a.spend(s, sum(s, 16000), 'Покупки на распродаже', 'fun'); a.mood(s, -2, 8); } },
      { id: 'need', label: 'Оставить только нужное', sub: 'Убрать половину',
        apply: function (s, a) { a.spend(s, sum(s, 6000), 'Нужные покупки', 'fun'); a.mood(s, 3, 3); } },
      { id: 'none', label: 'Закрыть вкладку', sub: 'Ничего не покупать',
        apply: function (s, a) { a.mood(s, 4, -2); a.flag(s, 'resists_sales'); } }
    ]
  });

  ev('daily-bank-fee', {
    kind: 'quiet', tags: ['subs', 'easy', 'mid', 'hard'], concept: 'subs',
    shortTitle: 'Плата за карту', title: 'Банк ввёл плату за обслуживание',
    text: function (s) {
      return money(sum(s, 350)) + ' в месяц. Отменяется, если держать на счету неснижаемый остаток ' +
        money(sum(s, 60000)) + ' или перейти на другой тариф с меньшим кэшбэком.';
    },
    choices: [
      { id: 'pay', label: 'Платить', sub: 'Ничего не менять',
        apply: function (s, a) { a.addSub(s, 'Обслуживание карты', sum(s, 350)); a.mood(s, -1, 0); } },
      { id: 'switch', label: 'Сменить тариф', sub: 'Без платы, но и без кэшбэка',
        apply: function (s, a) { a.livingDelta(s, 0.004); a.mood(s, 1, 0); } },
      { id: 'move', label: 'Уйти в другой банк', sub: 'Вечер на переоформление',
        apply: function (s, a) { a.energy(s, -6); a.mood(s, 2, -1); a.credit(s, -3); } }
    ]
  });

  ev('daily-medicine-course', {
    kind: 'shock', tags: ['health', 'easy', 'mid', 'hard'],
    shortTitle: 'Курс лекарств', title: 'Врач выписал курс',
    text: function (s) {
      return 'Оригинальные препараты на месяц — ' + money(sum(s, 12000)) + '. ' +
        'Аналоги того же действующего вещества — ' + money(sum(s, 4500)) + '.';
    },
    choices: [
      { id: 'brand', label: 'Взять оригиналы', sub: 'Как выписал врач',
        apply: function (s, a) { a.spend(s, sum(s, 12000), 'Лекарства', 'shocks'); a.energy(s, 8); a.mood(s, 2, 2); } },
      { id: 'generic', label: 'Спросить про аналоги', sub: 'То же вещество дешевле',
        concept: 'negotiation',
        apply: function (s, a) { a.spend(s, sum(s, 4500), 'Лекарства-аналоги', 'shocks'); a.energy(s, 7); a.mood(s, 3, 1); } },
      { id: 'half', label: 'Пропить половину курса', sub: 'Сэкономить на второй половине',
        apply: function (s, a) {
          a.spend(s, sum(s, 6000), 'Половина курса', 'shocks');
          a.gamble(s, 'course-half', [
            { p: .45, label: 'Хватило и половины курса', good: true, effect: function (s, a) { a.energy(s, 4); } },
            { p: .55, label: 'Болезнь вернулась, лечение началось заново', bad: true,
              effect: function (s, a) { a.defer(s, 2, { cash: -sum(s, 15000), label: 'Повторное лечение', bucket: 'shocks', energy: -10, calm: -6, type: 'bad' }); } }
          ]);
        } }
    ]
  });

  ev('daily-back-pain', {
    kind: 'shock', tags: ['health', 'energy', 'easy', 'mid', 'hard'],
    shortTitle: 'Спина', title: 'Прострелило спину',
    text: function (s) {
      return 'Сидячая работа даёт о себе знать. Курс массажа и врач — ' + money(sum(s, 15000)) +
        '. Можно потерпеть и полежать неделю.';
    },
    choices: [
      { id: 'treat', label: 'Лечиться', sub: 'Деньги в обмен на силы',
        apply: function (s, a) { a.spend(s, sum(s, 15000), 'Лечение спины', 'shocks'); a.energy(s, 12); a.mood(s, 2, 3); } },
      { id: 'rest', label: 'Взять больничный', sub: 'Меньше денег, больше отдыха',
        apply: function (s, a) { a.tempIncome(s, -sum(s, 9000), 2, { label: 'Больничный' }); a.energy(s, 8); a.mood(s, 0, 1); } },
      { id: 'ignore', label: 'Работать через боль', sub: 'Ноль расходов',
        apply: function (s, a) { a.energy(s, -12); a.mood(s, -5, -6); a.defer(s, 4, { energy: -8, label: 'Спина снова напомнила о себе', type: 'bad' }); } }
    ]
  });

  ev('daily-parents-meds', {
    kind: 'social', tags: ['family', 'social', 'easy', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Помощь родителям', title: 'Родителям нужны лекарства',
    text: function (s) {
      return 'Просят помочь: курс стоит ' + money(sum(s, 13000)) + '. Просят впервые за долгое время.';
    },
    choices: [
      { id: 'full', label: 'Оплатить полностью', sub: 'Взять на себя',
        apply: function (s, a) { a.spend(s, sum(s, 13000), 'Лекарства родителям', 'living'); a.trust(s, 10); a.mood(s, 5, 2); } },
      { id: 'half', label: 'Оплатить половину', sub: 'Помочь и не сорвать бюджет',
        apply: function (s, a) { a.spend(s, sum(s, 6500), 'Помощь родителям', 'living'); a.trust(s, 5); a.mood(s, 2, 1); } },
      { id: 'later', label: 'Сказать, что сейчас не могу', sub: 'Честно, но тяжело',
        apply: function (s, a) { a.trust(s, -8); a.mood(s, -9, -3); } }
    ]
  });

  ev('daily-colleague-loan', {
    kind: 'social', tags: ['social', 'easy', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Коллега просит занять', title: 'Коллега просит до зарплаты',
    text: function (s) {
      return 'Просит ' + money(sum(s, 15000)) + ' на две недели. Вы работаете вместе два года, ' +
        'но близкими друзьями вас не назовёшь.';
    },
    choices: [
      { id: 'yes', label: 'Занять', sub: 'Помочь коллеге',
        apply: function (s, a) {
          a.spend(s, sum(s, 15000), 'Занял коллеге', 'living'); a.trust(s, 3);
          a.gamble(s, 'colleague-loan', [
            { p: .62, label: 'Коллега вернул в срок', good: true, effect: function (s, a) { a.earn(s, sum(s, 15000), 'Коллега вернул долг'); a.trust(s, 4); a.mood(s, 3, 0); } },
            { p: .38, label: 'Коллега тянет с возвратом', bad: true, effect: function (s, a) { a.mood(s, -6, -2); a.trust(s, -2); } }
          ]);
        } },
      { id: 'part', label: 'Дать треть', sub: 'Сумма, которую не жалко',
        concept: 'ruin',
        apply: function (s, a) { a.spend(s, sum(s, 5000), 'Занял коллеге', 'living'); a.trust(s, 2); a.mood(s, 2, 0); } },
      { id: 'no', label: 'Отказать', sub: 'Неловко, но без риска',
        apply: function (s, a) { a.mood(s, -2, 0); a.trust(s, -2); } }
    ]
  });

  ev('daily-overtime-weekend', {
    kind: 'offer', tags: ['career', 'energy', 'income', 'easy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Работа в выходные', title: 'Просят выйти в субботу',
    text: function (s) {
      return 'Горит проект. Обещают ' + money(sum(s, 12000)) + ' сверху и «запомнят». ' +
        'Это два выходных подряд без отдыха.';
    },
    choices: [
      { id: 'yes', label: 'Выйти', sub: 'Деньги и репутация против отдыха',
        apply: function (s, a) { a.earn(s, sum(s, 12000), 'Работа в выходные'); a.energy(s, -14); a.mood(s, -3, -4); a.flag(s, 'reliable'); } },
      { id: 'once', label: 'Выйти на один день', sub: 'Половина и того, и другого',
        apply: function (s, a) { a.earn(s, sum(s, 6000), 'Подработка в выходной'); a.energy(s, -7); a.mood(s, -1, -1); } },
      { id: 'no', label: 'Отказаться', sub: 'Сохранить выходные',
        apply: function (s, a) { a.energy(s, 5); a.mood(s, 2, 3); } }
    ]
  });

  ev('daily-tax-deduction', {
    kind: 'opportunity', tags: ['income', 'save', 'easy', 'mid', 'hard'], concept: 'tax',
    shortTitle: 'Налоговый вычет', title: 'Можно вернуть налог',
    text: function (s) {
      return 'За лечение и обучение за прошлый год можно вернуть примерно ' + money(sum(s, 22000)) +
        '. Нужно собрать справки и заполнить декларацию — это вечер, а то и два.';
    },
    choices: [
      { id: 'file', label: 'Подать документы', sub: 'Вечер работы за живые деньги',
        apply: function (s, a) { a.energy(s, -6); a.defer(s, 3, { cash: sum(s, 22000), label: 'Налоговый вычет вернулся', type: 'good', calm: 5 }); a.mood(s, 2, 0); } },
      { id: 'later', label: 'Отложить на потом', sub: 'Срок ещё есть',
        apply: function (s, a) {
          a.gamble(s, 'deduction-later', [
            { p: .35, label: 'Всё-таки собрались и подали', good: true, effect: function (s, a) { a.defer(s, 6, { cash: sum(s, 22000), label: 'Налоговый вычет вернулся', type: 'good' }); } },
            { p: .65, label: 'Так и не собрались', bad: true, effect: function (s, a) { a.mood(s, -3, 0); } }
          ]);
        } },
      { id: 'skip', label: 'Не связываться', sub: 'Меньше бумаг',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });

  ev('daily-cashback-card', {
    kind: 'offer', tags: ['credit', 'subs', 'easy', 'mid'],
    shortTitle: 'Карта с кэшбэком', title: 'Дебетовая карта с кэшбэком',
    text: function (s) {
      return 'Кэшбэк до 5% в выбранных категориях. Обслуживание ' + money(sum(s, 199)) +
        ' в месяц, бесплатно при тратах от ' + money(sum(s, 30000)) + ' в месяц.';
    },
    choices: [
      { id: 'take', label: 'Оформить', sub: 'Возврат части трат',
        apply: function (s, a) { a.addSub(s, 'Обслуживание карты', sum(s, 199)); a.livingDelta(s, -0.008); a.mood(s, 2, 1); a.flag(s, 'cashback'); } },
      { id: 'no', label: 'Не оформлять', sub: 'Меньше карт — меньше мыслей',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  ev('daily-subscription-audit', {
    kind: 'quiet', tags: ['subs', 'easy', 'mid', 'hard'], concept: 'subs',
    shortTitle: 'Ревизия подписок', title: 'Проверить, за что списывают',
    text: function (s) {
      return 'В выписке нашлись списания, о которых вы забыли. Разбор займёт полчаса.';
    },
    choices: [
      { id: 'clean', label: 'Отключить всё лишнее', sub: 'Полчаса за деньги каждый месяц',
        apply: function (s, a) { a.removeSubs(s); a.mood(s, 4, -3); a.flag(s, 'subs_clean'); } },
      { id: 'some', label: 'Отключить половину', sub: 'Компромисс',
        apply: function (s, a) {
          var half = Math.floor(s.subs.length / 2);
          for (var i = 0; i < half; i++) s.subs.pop();
          a.note(s, 'Часть подписок отключена', 0, 'good'); a.mood(s, 2, -1);
        } },
      { id: 'skip', label: 'Потом', sub: 'Сейчас нет сил',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });

  ev('daily-work-laptop', {
    kind: 'offer', tags: ['career', 'bigbuy', 'mid', 'hard'], concept: 'opportunity',
    shortTitle: 'Техника для работы', title: 'Нужен свой ноутбук для подработки',
    text: function (s) {
      return 'Заказы есть, но на домашнем компьютере работать невозможно. Ноутбук — ' +
        money(sum(s, 70000)) + '. Заказы принесут примерно ' + money(sum(s, 14000)) + ' в месяц.';
    },
    choices: [
      { id: 'buy', label: 'Купить', sub: 'Расход, который повышает доход',
        concept: 'opportunity',
        apply: function (s, a) { a.spend(s, sum(s, 70000), 'Ноутбук для работы', 'invested'); a.incomeDelta(s, sum(s, 14000)); a.energy(s, -6); a.mood(s, -3, 3); } },
      { id: 'credit', label: 'Взять в кредит', sub: 'Начать зарабатывать сразу',
        apply: function (s, a, E) { a.borrow(s, { id: 'laptop', label: 'Кредит на ноутбук', principal: sum(s, 70000), baseAnnualRate: .24, months: 18 }); a.incomeDelta(s, sum(s, 14000)); a.energy(s, -6); a.mood(s, -6, 2); } },
      { id: 'wait', label: 'Копить и ждать', sub: 'Без долга, но и без дохода',
        apply: function (s, a) { a.mood(s, 1, -3); } }
    ]
  });

  ev('daily-friend-trip', {
    kind: 'temptation', tags: ['social', 'family', 'easy', 'mid'], concept: 'social',
    shortTitle: 'Поездка с друзьями', title: 'Друзья зовут в поездку',
    text: function (s) {
      return 'Неделя на всех обойдётся примерно в ' + money(sum(s, 55000)) + '. ' +
        'Собираются те, с кем вы давно не виделись.';
    },
    choices: [
      { id: 'go', label: 'Поехать', sub: 'Дорого и здорово',
        apply: function (s, a) { a.spend(s, sum(s, 55000), 'Поездка с друзьями', 'fun'); a.energy(s, 12); a.trust(s, 6); a.mood(s, 5, 14); } },
      { id: 'short', label: 'Приехать на выходные', sub: 'Половина впечатлений за треть цены',
        apply: function (s, a) { a.spend(s, sum(s, 18000), 'Короткая поездка', 'fun'); a.energy(s, 6); a.trust(s, 3); a.mood(s, 3, 7); } },
      { id: 'skip', label: 'Остаться', sub: 'Деньги целы',
        apply: function (s, a) { a.mood(s, 1, -7); a.trust(s, -3); } }
    ]
  });

  ev('daily-course-discount', {
    kind: 'temptation', tags: ['career', 'bigbuy', 'easy', 'mid', 'hard'], concept: 'opportunity',
    shortTitle: 'Курс со скидкой', title: 'Курс, последний день скидки',
    text: function (s) {
      return 'Обучение стоит ' + money(sum(s, 48000)) + ' вместо ' + money(sum(s, 90000)) +
        '. Обещают рост дохода, но гарантий нет, а таймер на сайте идёт.';
    },
    choices: [
      { id: 'buy', label: 'Купить сейчас', sub: 'Скидка кончается',
        apply: function (s, a) {
          a.spend(s, sum(s, 48000), 'Курс', 'invested'); a.energy(s, -10);
          a.gamble(s, 'course-buy', [
            { p: .5, label: 'Курс пройден, доход вырос', good: true, effect: function (s, a) { a.defer(s, 5, { income: sum(s, 11000), label: 'Новые навыки дали прибавку', type: 'good' }); } },
            { p: .5, label: 'Курс заброшен на середине', bad: true, effect: function (s, a) { a.mood(s, -7, -3); } }
          ]);
        } },
      { id: 'think', label: 'Взять паузу на неделю', sub: 'Скидка обычно возвращается',
        concept: 'sunk',
        apply: function (s, a) {
          a.mood(s, 2, 0);
          a.gamble(s, 'course-wait', [
            { p: .7, label: 'Такая же скидка появилась снова', good: true, effect: function (s, a) { a.note(s, 'Скидка вернулась — срочности не было', 0, 'info'); a.mood(s, 4, 0); } },
            { p: .3, label: 'Скидка больше не повторилась', bad: true, effect: function (s, a) { a.mood(s, -3, -1); } }
          ]);
        } },
      { id: 'free', label: 'Учиться самому', sub: 'Бесплатно, но нужна дисциплина',
        apply: function (s, a) {
          a.energy(s, -8);
          a.gamble(s, 'self-learn', [
            { p: .38, label: 'Самообучение дало результат', good: true, effect: function (s, a) { a.defer(s, 6, { income: sum(s, 7000), label: 'Самообучение окупилось', type: 'good' }); } },
            { p: .62, label: 'Самому не пошло', bad: true, effect: function (s, a) { a.mood(s, -3, -2); } }
          ]);
        } }
    ]
  });

  ev('daily-old-debt-returned', {
    kind: 'opportunity', tags: ['save', 'social', 'easy', 'mid', 'hard'],
    requires: function (s) { return s.trust >= 45; },
    shortTitle: 'Вернули старый долг', title: 'Неожиданно вернули долг',
    text: function (s) {
      return 'Знакомый, о долге которого вы забыли, вернул ' + money(sum(s, 25000)) + '. ' +
        'Деньги, которых вы уже не ждали.';
    },
    choices: [
      { id: 'reserve', label: 'Отправить в резерв', sub: 'Не заметить, что они были',
        apply: function (s, a) { a.earn(s, sum(s, 25000), 'Долг вернули'); a.toReserve(s, sum(s, 25000)); a.trust(s, 3); a.mood(s, 4, 0); } },
      { id: 'spend', label: 'Потратить на себя', sub: 'Это же подарок судьбы',
        apply: function (s, a) { a.earn(s, sum(s, 25000), 'Долг вернули'); a.spend(s, sum(s, 25000), 'Траты на себя', 'fun'); a.mood(s, 2, 10); } },
      { id: 'debt', label: 'Погасить свой долг', needs: 'debt',
        sub: function (s, E) { return 'Свой долг сейчас — ' + money(E.debtBalanceTotal(s)); },
        apply: function (s, a) { a.earn(s, sum(s, 25000), 'Долг вернули'); a.repay(s, sum(s, 25000)); a.mood(s, 5, 0); } }
    ]
  });

  ev('daily-emergency-thought', {
    kind: 'quiet', tags: ['save', 'easy', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'А если уволят', title: 'Мысль перед сном',
    text: function (s, E) {
      var m = E.reserveMonths(s);
      return 'Вы посчитали, сколько протянете без дохода: ' + m.toFixed(1) +
        ' месяца. Ориентир, о котором все говорят, — три.';
    },
    choices: [
      { id: 'boost', label: 'Резко увеличить резерв', sub: 'Жить теснее несколько месяцев',
        apply: function (s, a) { a.setAutoSave(s, Math.min(0.3, s.autoSave + 0.08)); a.mood(s, 6, -5); a.flag(s, 'disciplined'); } },
      { id: 'small', label: 'Добавить понемногу', sub: 'Небольшой шаг',
        apply: function (s, a) { a.setAutoSave(s, Math.min(0.25, s.autoSave + 0.03)); a.mood(s, 3, -1); } },
      { id: 'sleep', label: 'Уснуть', sub: 'Подумать об этом позже',
        apply: function (s, a) { a.mood(s, -2, 1); } }
    ]
  });

  ev('daily-home-repair-small', {
    kind: 'quiet', tags: ['housing', 'easy', 'mid', 'hard'],
    shortTitle: 'Течёт кран', title: 'Кран подтекает',
    text: function (s) {
      return 'Капает вторую неделю. Мастер возьмёт ' + money(sum(s, 3500)) + ', ' +
        'запчасть для самостоятельного ремонта — ' + money(sum(s, 900)) + '.';
    },
    choices: [
      { id: 'master', label: 'Вызвать мастера', sub: 'Быстро и надёжно',
        apply: function (s, a) { a.spend(s, sum(s, 3500), 'Мастер', 'living'); a.mood(s, 2, 1); } },
      { id: 'self', label: 'Починить самому', sub: 'Дешевле, но вечер и риск',
        apply: function (s, a) {
          a.spend(s, sum(s, 900), 'Запчасть', 'living'); a.energy(s, -5);
          a.gamble(s, 'self-fix', [
            { p: .68, label: 'Починили сами', good: true, effect: function (s, a) { a.mood(s, 4, 1); } },
            { p: .32, label: 'Сделали хуже, пришлось звать мастера', bad: true, effect: function (s, a) { a.spend(s, sum(s, 6000), 'Мастер после самостоятельного ремонта', 'shocks'); a.mood(s, -5, -2); } }
          ]);
        } },
      { id: 'wait', label: 'Подождать', sub: 'Капает и капает',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 300)); a.mood(s, -1, -2); } }
    ]
  });

  ev('daily-neighbor-flood', {
    kind: 'shock', tags: ['housing', 'social', 'mid', 'hard'],
    shortTitle: 'Затопили соседей', title: 'Прорвало шланг',
    text: function (s) {
      return 'Соседи снизу пришли с фотографиями потолка. Оценка ущерба на глаз — ' +
        money(sum(s, 60000)) + '. Страховки у вас нет.';
    },
    concept: 'insurance',
    choices: [
      { id: 'pay', label: 'Сразу договориться и заплатить', sub: 'Дорого, но конец истории',
        apply: function (s, a) { a.spend(s, sum(s, 60000), 'Ущерб соседям', 'shocks'); a.trust(s, 4); a.mood(s, -6, -3); } },
      { id: 'part', label: 'Предложить половину', sub: 'Торг с соседями',
        apply: function (s, a) {
          a.spend(s, sum(s, 30000), 'Частичная компенсация', 'shocks'); a.mood(s, -4, -2);
          a.schedule(s, 3, 'arc-flood-court');
        } },
      { id: 'refuse', label: 'Сказать, что виноват стояк', sub: 'Ничего не платить сейчас',
        apply: function (s, a) { a.mood(s, -3, 0); a.trust(s, -6); a.schedule(s, 3, 'arc-flood-court'); a.flag(s, 'flood_denied'); } }
    ]
  });

  /* РАБОТА, ДОХОД И ЛЮДИ */

  ev('daily-boss-hint', {
    kind: 'offer', tags: ['career', 'income', 'mid', 'hard'],
    shortTitle: 'Намёк начальника', title: 'Начальник намекнул на повышение',
    text: function (s) {
      return 'Разговор в коридоре: «есть мысли по твоей позиции, вернёмся к этому». ' +
        'Ни срока, ни цифры. Прибавка, если случится, будет около ' + money(sum(s, 18000)) + ' в месяц.';
    },
    choices: [
      { id: 'push', label: 'Попросить конкретику', sub: 'Спросить про сроки и сумму',
        concept: 'negotiation',
        apply: function (s, a) { a.mood(s, 1, 0); a.energy(s, -2); a.flag(s, 'asked_promo'); a.schedule(s, 4, 'arc-promotion'); } },
      { id: 'wait', label: 'Ждать и работать лучше', sub: 'Показать себя делом',
        apply: function (s, a) { a.energy(s, -8); a.mood(s, 0, -2); a.schedule(s, 4, 'arc-promotion'); } },
      { id: 'look', label: 'Начать смотреть вакансии', sub: 'Не полагаться на обещание',
        apply: function (s, a) { a.energy(s, -5); a.flag(s, 'job_hunting'); a.mood(s, 2, 0); a.schedule(s, 4, 'arc-promotion'); } }
    ]
  });

  ev('arc-promotion', {
    kind: 'offer', tags: ['career', 'income'],
    requires: function (s) { return true; },
    shortTitle: 'Судьба повышения', title: 'Разговор состоялся',
    text: function (s) {
      return s.flags.asked_promo
        ? 'Вы спрашивали прямо — и получили прямой ответ.'
        : 'Прошло четыре месяца. Про повышение вспомнили сами.';
    },
    choices: [
      { id: 'hear', label: 'Выслушать решение', sub: 'Узнать, чем всё кончилось',
        apply: function (s, a) {
          var chance = s.flags.asked_promo ? .55 : .33;
          a.gamble(s, 'promo-result', [
            { p: chance, label: 'Повышение согласовали', good: true,
              effect: function (s, a) { a.incomeDelta(s, sum(s, 18000)); a.mood(s, 12, 6); a.energy(s, -4); } },
            { p: .27, label: 'Повышение перенесли на следующий год', bad: true,
              effect: function (s, a) { a.mood(s, -8, -3); } },
            { p: 1 - chance - .27, label: 'Повысили другого сотрудника', bad: true,
              effect: function (s, a) { a.mood(s, -12, -5); a.energy(s, -6); a.flag(s, 'passed_over'); } }
          ]);
        } },
      { id: 'leave', label: 'Уйти к другому работодателю', sub: 'Дольше и рискованнее без подготовки',
        apply: function (s, a) {
          // Тот, кто заранее смотрел вакансии, уходит в лучшую позицию.
          // Решение «искать заранее» окупается именно здесь.
          var ready = !!s.flags.job_hunting;
          a.gamble(s, 'promo-leave', [
            { p: ready ? .58 : .3, label: 'Новая работа с большей зарплатой', good: true,
              effect: function (s, a) { a.incomeDelta(s, sum(s, 24000)); a.energy(s, -12); a.mood(s, 8, 2); } },
            { p: ready ? .42 : .7, label: 'Переход оказался хуже прежнего места', bad: true,
              effect: function (s, a) { a.incomeDelta(s, -sum(s, 4000)); a.energy(s, -14); a.mood(s, -10, -6); } }
          ]);
        } }
    ]
  });

  ev('daily-new-job-offer', {
    kind: 'offer', tags: ['career', 'income', 'mid', 'hard'],
    shortTitle: 'Оффер', title: 'Предложение с испытательным сроком',
    text: function (s) {
      return 'Зарплата выше на ' + money(sum(s, 22000)) + ', но три месяца испытательного срока ' +
        'и незнакомая команда. На текущем месте спокойно и предсказуемо.';
    },
    choices: [
      { id: 'take', label: 'Согласиться', sub: 'Больше денег, больше риска',
        apply: function (s, a) { a.incomeDelta(s, sum(s, 22000)); a.energy(s, -10); a.mood(s, 2, 3); a.flag(s, 'probation'); a.schedule(s, 3, 'arc-probation'); } },
      { id: 'negotiate', label: 'Попросить больше', sub: 'Торговаться на входе',
        concept: 'negotiation',
        apply: function (s, a) {
          a.gamble(s, 'offer-neg', [
            { p: .48, label: 'Подняли предложение', good: true, effect: function (s, a) { a.incomeDelta(s, sum(s, 30000)); a.energy(s, -10); a.mood(s, 6, 3); a.flag(s, 'probation'); a.schedule(s, 3, 'arc-probation'); } },
            { p: .37, label: 'Оставили как есть, вы согласились', good: true, effect: function (s, a) { a.incomeDelta(s, sum(s, 22000)); a.energy(s, -10); a.mood(s, 1, 2); a.flag(s, 'probation'); a.schedule(s, 3, 'arc-probation'); } },
            { p: .15, label: 'Предложение отозвали', bad: true, effect: function (s, a) { a.mood(s, -9, -3); } }
          ]);
        } },
      { id: 'stay', label: 'Остаться', sub: 'Стабильность дороже',
        apply: function (s, a) { a.mood(s, 3, 1); a.energy(s, 3); } }
    ]
  });

  ev('arc-probation', {
    kind: 'shock', tags: ['career'],
    requires: function (s) { return !!s.flags.probation; },
    shortTitle: 'Конец испытательного', title: 'Три месяца прошли',
    text: 'Сегодня разговор с руководителем об итогах испытательного срока.',
    choices: [
      { id: 'prepare', label: 'Прийти со списком сделанного', sub: 'Вечер подготовки повышает шансы',
        concept: 'negotiation',
        apply: function (s, a) {
          a.energy(s, -5);
          a.gamble(s, 'probation-end', [
            { p: .86, label: 'Испытательный пройден', good: true,
              effect: function (s, a) { a.mood(s, 12, 4); a.energy(s, 5); a.flag(s, 'probation', false); } },
            { p: .14, label: 'Не сработались, пришлось искать заново', bad: true,
              effect: function (s, a) { a.incomeDelta(s, -sum(s, 26000)); a.tempIncome(s, -sum(s, 8000), 2, { label: 'Месяц без работы' }); a.mood(s, -16, -8); a.energy(s, -10); } }
          ]);
        } },
      { id: 'meet', label: 'Просто пойти на разговор', sub: 'Как есть',
        apply: function (s, a) {
          a.gamble(s, 'probation-end', [
            { p: .72, label: 'Испытательный пройден', good: true,
              effect: function (s, a) { a.mood(s, 10, 4); a.energy(s, 5); a.flag(s, 'probation', false); } },
            { p: .28, label: 'Не сработались, пришлось искать заново', bad: true,
              effect: function (s, a) { a.incomeDelta(s, -sum(s, 26000)); a.tempIncome(s, -sum(s, 8000), 2, { label: 'Месяц без работы' }); a.mood(s, -16, -8); a.energy(s, -10); } }
          ]);
        } }
    ]
  });

  ev('daily-friend-business', {
    kind: 'offer', tags: ['risk', 'social', 'invest', 'mid', 'hard'], concept: 'expected',
    shortTitle: 'Дело друга', title: 'Друг зовёт в долю',
    text: function (s) {
      return 'Кофейня у метро. Просит ' + money(sum(s, 120000)) + ' за четверть дела. ' +
        'Показывает расчёты, в которых всё сходится. Расчёты всегда сходятся.';
    },
    choices: [
      { id: 'in', label: 'Войти в долю', sub: 'Ставка на друга и на место',
        concept: 'ruin',
        apply: function (s, a) { a.spend(s, sum(s, 120000), 'Доля в деле друга', 'invested'); a.trust(s, 6); a.mood(s, -4, 5); a.flag(s, 'business_share'); a.schedule(s, 6, 'arc-business'); } },
      { id: 'small', label: 'Войти маленькой суммой', sub: 'Столько, сколько не жалко',
        apply: function (s, a) { a.spend(s, sum(s, 35000), 'Небольшая доля', 'invested'); a.trust(s, 3); a.mood(s, 0, 2); a.flag(s, 'business_small'); a.schedule(s, 6, 'arc-business'); } },
      { id: 'no', label: 'Отказаться', sub: 'Дружба отдельно, деньги отдельно',
        apply: function (s, a) { a.trust(s, -4); a.mood(s, 1, -1); } }
    ]
  });

  ev('arc-business', {
    kind: 'offer', tags: ['risk', 'social'], concept: 'cashflow',
    requires: function (s) { return !!(s.flags.business_share || s.flags.business_small); },
    shortTitle: 'Дело друга: полгода', title: 'Прошло полгода',
    text: 'Друг зовёт поговорить о делах кофейни. По голосу непонятно, хорошая новость или плохая.',
    choices: [
      { id: 'numbers', label: 'Попросить показать отчётность', sub: 'Неудобный разговор, зато по цифрам',
        concept: 'negotiation',
        apply: function (s, a) {
          a.energy(s, -4); a.trust(s, -2);
          a.note(s, 'Вы увидели реальные обороты кофейни', 0, 'info');
          a.gamble(s, 'business-result', [
            { p: .30, label: 'Дело пошло, доля приносит доход', good: true,
              effect: function (s, a) { a.incomeDelta(s, Math.round((s.flags.business_share ? sum(s, 120000) : sum(s, 35000)) * 0.10)); a.mood(s, 10, 6); } },
            { p: .28, label: 'Дело держится, но денег пока не приносит', good: false,
              effect: function (s, a) { a.mood(s, -1, 0); } },
            { p: .24, label: 'По отчётам видно: без новых денег не выжить', bad: true,
              effect: function (s, a) { a.mood(s, -5, -2); a.flag(s, 'saw_numbers'); a.schedule(s, 2, 'arc-business-more'); } },
            { p: .18, label: 'Кофейня закрывается, деньги потеряны', bad: true,
              effect: function (s, a) { a.mood(s, -12, -6); a.trust(s, -4); } }
          ]);
        } },
      { id: 'listen', label: 'Просто выслушать', sub: 'Поверить на слово',
        apply: function (s, a) {
          var big = !!s.flags.business_share;
          var stake = big ? sum(s, 120000) : sum(s, 35000);
          a.gamble(s, 'business-result', [
            { p: .30, label: 'Дело пошло, доля приносит доход', good: true,
              effect: function (s, a) { a.incomeDelta(s, Math.round(stake * 0.10)); a.mood(s, 10, 6); a.trust(s, 5); } },
            { p: .28, label: 'Дело держится, но денег пока не приносит', good: false,
              effect: function (s, a) { a.mood(s, -2, 0); } },
            { p: .24, label: 'Нужны ещё вложения, иначе всё встанет', bad: true,
              effect: function (s, a) { a.mood(s, -7, -3); a.schedule(s, 2, 'arc-business-more'); } },
            { p: .18, label: 'Кофейня закрылась, деньги потеряны', bad: true,
              effect: function (s, a) { a.mood(s, -14, -7); a.trust(s, -6); a.note(s, 'Вложение в дело друга потеряно: ' + Math.round(stake) + ' ₽', 0, 'bad'); } }
          ]);
        } }
    ]
  });

  ev('arc-business-more', {
    kind: 'temptation', tags: ['risk', 'social'], concept: 'sunk',
    requires: function (s) { return !!(s.flags.business_share || s.flags.business_small); },
    shortTitle: 'Дело просит ещё', title: 'Нужно доложить денег',
    text: function (s) {
      return 'Друг просит ещё ' + money(sum(s, 60000)) + ': «осталось совсем чуть-чуть». ' +
        'Уже вложенное вернуть нельзя в любом случае.';
    },
    choices: [
      { id: 'more', label: 'Доложить', sub: 'Жалко бросать на середине',
        apply: function (s, a) {
          a.spend(s, sum(s, 60000), 'Дополнительное вложение в дело', 'invested');
          a.gamble(s, 'business-more', [
            { p: .34, label: 'Второе вложение спасло дело', good: true, effect: function (s, a) { a.incomeDelta(s, sum(s, 12000)); a.mood(s, 9, 4); } },
            { p: .66, label: 'Дело всё равно закрылось', bad: true, effect: function (s, a) { a.mood(s, -15, -8); a.trust(s, -5); } }
          ]);
        } },
      { id: 'stop', label: 'Остановиться', sub: 'Потраченного уже не вернуть',
        concept: 'sunk',
        apply: function (s, a) { a.mood(s, -5, -2); a.trust(s, -4); a.flag(s, 'cut_losses'); } }
    ]
  });

  ev('daily-guarantor-ask', {
    kind: 'social', tags: ['credit', 'social', 'family', 'mid', 'hard'], concept: 'debtload',
    shortTitle: 'Поручительство', title: 'Просят стать поручителем',
    text: function (s) {
      return 'Родственник берёт кредит на ' + money(sum(s, 400000)) + ' и просит подписать поручительство. ' +
        'Если он перестанет платить, платить будете вы.';
    },
    choices: [
      { id: 'yes', label: 'Подписать', sub: 'Помочь родственнику',
        apply: function (s, a) { a.trust(s, 8); a.credit(s, -10); a.mood(s, -3, 1); a.flag(s, 'guarantor'); a.schedule(s, 8, 'arc-guarantor'); } },
      { id: 'no', label: 'Отказать', sub: 'Сохранить свою кредитную историю',
        apply: function (s, a) { a.trust(s, -9); a.mood(s, -6, -1); } }
    ]
  });

  ev('arc-guarantor', {
    kind: 'shock', tags: ['credit', 'debt'], concept: 'guarantor',
    requires: function (s) { return !!s.flags.guarantor; },
    shortTitle: 'Звонок из банка', title: 'Звонят по кредиту родственника',
    text: 'Платежей нет третий месяц. Банк напоминает, что вы поручитель.',
    choices: [
      { id: 'pay', label: 'Закрыть просрочку самому', sub: 'Спасти свою кредитную историю',
        apply: function (s, a) {
          a.spend(s, sum(s, 38000), 'Платёж за родственника', 'shocks');
          a.credit(s, 4); a.trust(s, 4); a.mood(s, -6, -2);
          a.note(s, 'Просрочка закрыта, но кредит остался на вас', 0, 'info');
        } },
      { id: 'check', label: 'Сначала разобраться', sub: 'Выяснить, что произошло',
        apply: function (s, a) {
          a.gamble(s, 'guarantor-result', [
            { p: .52, label: 'Родственник закрыл просрочку сам', good: true,
              effect: function (s, a) { a.mood(s, 6, 1); a.trust(s, 2); } },
            { p: .48, label: 'Платить пришлось вам', bad: true,
              effect: function (s, a, E) {
                a.addDebt(s, { id: 'guarantee', label: 'Долг за поручительство', principal: sum(s, 260000), annualRate: .22, months: 36 });
                a.credit(s, -30); a.trust(s, -10); a.mood(s, -18, -8);
              } }
          ]);
        } }
    ]
  });

  ev('daily-card-fraud', {
    kind: 'scam', tags: ['scam', 'easy', 'mid', 'hard'], lesson: true, concept: 'scam',
    shortTitle: 'Списание по карте', title: 'Со счёта списали деньги',
    text: function (s) {
      return 'Пришло уведомление: списано ' + money(sum(s, 34000)) + ' в незнакомом магазине. ' +
        'Вы ничего не покупали.';
    },
    choices: [
      { id: 'bank', label: 'Заблокировать карту и подать заявление', sub: 'Официальный путь',
        scamHit: false,
        apply: function (s, a) { a.spend(s, sum(s, 34000), 'Мошенническое списание', 'shocks'); a.energy(s, -5); a.mood(s, -7, -2); a.schedule(s, 2, 'arc-fraud-refund'); a.flag(s, 'fraud_claim'); } },
      { id: 'call', label: 'Перезвонить по номеру из СМС', sub: 'Быстрее всего',
        scamHit: true,
        apply: function (s, a) { a.spend(s, sum(s, 34000), 'Мошенническое списание', 'shocks'); a.spend(s, sum(s, 45000), 'Второе списание после звонка', 'shocks'); a.mood(s, -14, -6); a.note(s, 'Номер из СМС вёл к тем же мошенникам', 0, 'bad'); } },
      { id: 'wait', label: 'Подождать: вдруг вернётся', sub: 'Ничего не делать',
        scamHit: false,
        apply: function (s, a) { a.spend(s, sum(s, 34000), 'Мошенническое списание', 'shocks'); a.mood(s, -9, -4); } }
    ]
  });

  ev('arc-fraud-refund', {
    kind: 'offer', tags: ['scam'],
    requires: function (s) { return !!s.flags.fraud_claim; },
    shortTitle: 'Ответ банка', title: 'Банк рассмотрел заявление',
    text: 'Прошло два месяца с подачи заявления о мошенническом списании.',
    choices: [
      { id: 'push', label: 'Дополнить заявление и настоять', sub: 'Ещё вечер бумаг ради шанса',
        apply: function (s, a) {
          a.energy(s, -5);
          a.gamble(s, 'fraud-refund', [
            { p: .72, label: 'Банк вернул деньги', good: true,
              effect: function (s, a) { a.earn(s, sum(s, 34000), 'Возврат мошеннического списания'); a.mood(s, 11, 2); } },
            { p: .28, label: 'Банк отказал даже после жалобы', bad: true,
              effect: function (s, a) { a.mood(s, -11, -3); } }
          ]);
        } },
      { id: 'open', label: 'Просто прочитать ответ', sub: 'Принять решение банка',
        apply: function (s, a) {
          a.gamble(s, 'fraud-refund', [
            { p: .58, label: 'Банк вернул деньги', good: true,
              effect: function (s, a) { a.earn(s, sum(s, 34000), 'Возврат мошеннического списания'); a.mood(s, 10, 2); } },
            { p: .42, label: 'Банк отказал: операция подтверждена кодом', bad: true,
              effect: function (s, a) { a.mood(s, -10, -3); a.note(s, 'Код из СМС — это подпись. Отказ законен', 0, 'bad'); } }
          ]);
        } }
    ]
  });

  ev('daily-used-car', {
    kind: 'temptation', tags: ['bigbuy', 'credit', 'mid', 'hard'], concept: 'depreciation',
    shortTitle: 'Машина с рук', title: 'Машина по хорошей цене',
    text: function (s) {
      return 'Продают за ' + money(sum(s, 520000)) + ' — на ' + money(sum(s, 90000)) +
        ' дешевле рынка. Владелец торопит. Диагностика в сервисе стоит ' + money(sum(s, 6000)) + '.';
    },
    choices: [
      { id: 'check', label: 'Сначала диагностика', sub: 'Потерять день, узнать правду',
        apply: function (s, a) {
          a.spend(s, sum(s, 6000), 'Диагностика', 'living'); a.energy(s, -4);
          a.gamble(s, 'car-check', [
            { p: .45, label: 'Машина оказалась битой — покупку отменили', good: true,
              effect: function (s, a) { a.mood(s, 8, -2); a.note(s, 'Диагностика сэкономила сотни тысяч', 0, 'good'); } },
            { p: .55, label: 'Машина в порядке, купили', good: true,
              effect: function (s, a) { a.spend(s, sum(s, 520000), 'Машина', 'fun'); a.mandatoryDelta(s, sum(s, 11000)); a.mood(s, -4, 12); a.flag(s, 'has_car'); a.schedule(s, 5, 'arc-car'); } }
          ]);
        } },
      { id: 'buy', label: 'Брать сразу', sub: 'Другой купит',
        apply: function (s, a) { a.spend(s, sum(s, 520000), 'Машина', 'fun'); a.mandatoryDelta(s, sum(s, 11000)); a.mood(s, -6, 14); a.flag(s, 'has_car'); a.flag(s, 'car_unchecked'); a.schedule(s, 5, 'arc-car'); } },
      { id: 'no', label: 'Пройти мимо', sub: 'Машина — это не только цена',
        apply: function (s, a) { a.mood(s, 2, -4); } }
    ]
  });

  ev('arc-car', {
    kind: 'shock', tags: ['bigbuy'],
    requires: function (s) { return !!s.flags.has_car; },
    shortTitle: 'Машина через полгода', title: 'Машина застучала',
    text: 'Полгода прошло. Утром при запуске появился звук, которого раньше не было.',
    choices: [
      { id: 'service', label: 'В сервис', sub: 'Узнать, насколько всё плохо',
        apply: function (s, a) {
          var bad = s.flags.car_unchecked ? .6 : .32;
          a.gamble(s, 'car-trouble', [
            { p: 1 - bad, label: 'Обошлось мелким ремонтом', good: true,
              effect: function (s, a) { a.spend(s, sum(s, 14000), 'Ремонт машины', 'shocks'); a.mood(s, 2, 0); } },
            { p: bad, label: 'Серьёзный ремонт двигателя', bad: true,
              effect: function (s, a) { a.spend(s, sum(s, 130000), 'Ремонт двигателя', 'shocks'); a.mood(s, -12, -5); } }
          ]);
        } },
      { id: 'sell', label: 'Продать пока едет', sub: 'Выйти из истории',
        apply: function (s, a) { a.earn(s, sum(s, 430000), 'Продажа машины'); a.mandatoryDelta(s, -sum(s, 11000)); a.flag(s, 'has_car', false); a.mood(s, 3, -8); } }
    ]
  });

  ev('arc-flood-court', {
    kind: 'shock', tags: ['housing', 'social'],
    shortTitle: 'Соседи и суд', title: 'Соседи пошли дальше',
    text: function (s) {
      return s.flags.flood_denied
        ? 'Соседи заказали независимую оценку и подали в суд. Сумма в иске — ' + money(sum(s, 95000)) + ' плюс судебные расходы.'
        : 'Соседям не хватило половины: они заказали оценку и требуют остальное — ' + money(sum(s, 40000)) + '.';
    },
    concept: 'insurance',
    choices: [
      { id: 'settle', label: 'Договориться до суда', sub: 'Заплатить и закрыть вопрос',
        apply: function (s, a) {
          var amount = s.flags.flood_denied ? sum(s, 70000) : sum(s, 40000);
          a.spend(s, amount, 'Мировое соглашение с соседями', 'shocks');
          a.trust(s, 3); a.mood(s, 2, -2);
        } },
      { id: 'court', label: 'Идти в суд', sub: 'Время и нервы против шанса заплатить меньше',
        apply: function (s, a) {
          a.energy(s, -12); a.mood(s, -8, -4);
          a.gamble(s, 'flood-court', [
            { p: .38, label: 'Суд снизил сумму', good: true,
              effect: function (s, a) { a.spend(s, sum(s, 30000), 'Выплата по решению суда', 'shocks'); a.mood(s, 5, 0); } },
            { p: .62, label: 'Суд встал на сторону соседей', bad: true,
              effect: function (s, a) { a.spend(s, sum(s, 110000), 'Выплата и судебные расходы', 'shocks'); a.mood(s, -10, -4); } }
          ]);
        } },
      { id: 'insure', label: 'Заплатить и застраховать жильё', sub: 'Урок с продолжением',
        concept: 'insurance',
        apply: function (s, a) {
          var amount = s.flags.flood_denied ? sum(s, 70000) : sum(s, 40000);
          a.spend(s, amount, 'Выплата соседям', 'shocks');
          a.addSub(s, 'Страховка жилья', sum(s, 850));
          a.flag(s, 'insured_home'); a.mood(s, 4, -1); a.trust(s, 3);
        } }
    ]
  });

  /*
   *  РЫНОК И ВЛОЖЕНИЯ
   *
   *  Эти ситуации не покупают за игрока — они подталкивают открыть биржу
   *  и решить самому. Покупка и продажа живут в отдельном экране,
   *  доступном в любой месяц.
   */

  ev('daily-invest-start', {
    kind: 'opportunity', tags: ['invest', 'save', 'easy', 'mid', 'hard'], concept: 'inflation',
    requires: function (s, E) { return s.cash > 40000 && (!s.portfolio || !s.portfolio.length); },
    shortTitle: 'Деньги лежат', title: 'Деньги лежат без дела',
    text: function (s, E) {
      var infl = Math.pow(1 + (s._inflation || 0.004), 12) - 1;
      return 'На счету накопилось ' + money(s.cash) + '. Цены растут примерно на ' +
        (infl * 100).toFixed(1) + '% в год: деньги, которые просто лежат, каждый год покупают меньше.';
    },
    choices: [
      { id: 'open', label: 'Разобраться с биржей', sub: 'Открыть биржу и решить самому',
        apply: function (s, a) { a.mood(s, 3, 0); a.energy(s, -3); a.note(s, 'Биржа доступна в любой месяц — в панели «Портфель»', 0, 'info'); a.learn(s, 'diversify'); } },
      { id: 'deposit', label: 'Просто отложить в резерв', sub: 'Без риска и без роста',
        apply: function (s, a) { a.toReserve(s, s.cash * 0.5); a.mood(s, 3, -1); } },
      { id: 'later', label: 'Не сейчас', sub: 'Оставить на счету',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });

  ev('daily-portfolio-drop', {
    kind: 'shock', tags: ['invest', 'risk', 'easy', 'mid', 'hard'], concept: 'risk',
    requires: function (s) { return !!(s.portfolio && s.portfolio.length); },
    shortTitle: 'Портфель просел', title: 'Приложение брокера прислало уведомление',
    text: function (s, E) {
      var v = E.portfolioValue(s);
      var cost = s.portfolio.reduce(function (x, h) { return x + h.cost; }, 0);
      var pct = cost > 0 ? (v - cost) / cost * 100 : 0;
      return 'Ваши вложения сейчас стоят ' + money(v) + ' — это ' +
        (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% к вложенному. ' +
        'Экран обновляется каждый день, и каждый день хочется что-то сделать.';
    },
    choices: [
      { id: 'hold', label: 'Ничего не делать', sub: 'План не менялся',
        apply: function (s, a) { a.mood(s, 2, 0); a.learn(s, 'risk'); } },
      { id: 'check', label: 'Открыть биржу и решить', sub: 'Посмотреть цены самому',
        apply: function (s, a) { a.energy(s, -2); a.note(s, 'Биржа открыта в панели «Портфель»', 0, 'info'); } },
      { id: 'panic', label: 'Проверять цену каждый день', sub: 'Спокойствия это не добавит',
        apply: function (s, a) { a.mood(s, -6, -2); a.energy(s, -5); } }
    ]
  });

  ev('daily-crypto-hype', {
    kind: 'temptation', tags: ['invest', 'risk', 'easy', 'mid', 'hard'], concept: 'expected',
    shortTitle: 'Знакомый и крипта', title: 'Знакомый показывает скриншот',
    text: 'На скриншоте — плюс 240% за три месяца. Про сделки, где он потерял, разговора не заходит.',
    choices: [
      { id: 'ask', label: 'Расспросить подробнее', sub: 'Сколько он вложил и сколько потерял раньше',
        concept: 'expected',
        apply: function (s, a) { a.mood(s, 2, 1); a.learn(s, 'expected'); a.note(s, 'Выяснилось: до этого он терял дважды', 0, 'info'); } },
      { id: 'small', label: 'Решить самому на бирже', sub: 'Открыть биржу, если хочется',
        apply: function (s, a) { a.mood(s, 0, 2); a.energy(s, -2); } },
      { id: 'ignore', label: 'Пропустить мимо ушей', sub: 'Чужая удача — не стратегия',
        apply: function (s, a) { a.mood(s, 2, -1); } }
    ]
  });

  ev('daily-invest-regular', {
    kind: 'opportunity', tags: ['invest', 'save', 'mid', 'hard'], concept: 'compound',
    requires: function (s) { return s.income > 0 && s.cash > 20000; },
    shortTitle: 'Вкладывать регулярно', title: 'Понемногу каждый месяц',
    text: function (s) {
      return 'Мысль: вместо того чтобы гадать, когда входить, откладывать фиксированную сумму ' +
        'каждый месяц. Например, ' + money(sum(s, 8000)) + '.';
    },
    choices: [
      { id: 'auto', label: 'Увеличить автоперевод', sub: 'Решение, которое не надо принимать заново',
        apply: function (s, a) { a.setAutoSave(s, Math.min(0.3, s.autoSave + 0.05)); a.mood(s, 4, -2); a.learn(s, 'compound'); } },
      { id: 'manual', label: 'Покупать вручную на бирже', sub: 'Больше контроля, больше соблазна',
        apply: function (s, a) { a.mood(s, 1, 1); a.energy(s, -2); } },
      { id: 'no', label: 'Пока не готов', sub: 'Оставить как есть',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });

  /* НОВЫЕ МЕЖМЕСЯЧНЫЕ СЛУЧАЙНОСТИ */

  ev('random-market-crash', {
    kind: 'shock', tags: ['random', 'invest', 'risk'], concept: 'risk',
    shortTitle: 'Рынок падает', title: 'Рынок падает третий день',
    text: 'Заголовки одинаковые во всех новостях. Люди вокруг обсуждают, что надо срочно что-то делать.',
    choices: [
      { id: 'calm', label: 'Не открывать приложение', sub: 'Решения в панике редко бывают удачными',
        apply: function (s, a) { a.mood(s, 1, 0); a.learn(s, 'risk'); } },
      { id: 'look', label: 'Посмотреть цены', sub: 'Биржа открыта в панели «Портфель»',
        apply: function (s, a) { a.mood(s, -3, 0); a.energy(s, -2); } }
    ]
  });

  ev('random-forgot-sub', {
    kind: 'quiet', tags: ['random', 'subs'], concept: 'subs',
    shortTitle: 'Забытая подписка', title: 'Списание, о котором вы забыли',
    text: function (s) {
      return 'Сервис, которым вы не пользовались полгода, списал ' + money(sum(s, 690)) + '.';
    },
    choices: [
      { id: 'cancel', label: 'Отключить', sub: 'Минус одно списание',
        apply: function (s, a) { a.mood(s, 2, 0); a.note(s, 'Подписка отключена', 0, 'good'); if (s.subs.length) s.subs.pop(); } },
      { id: 'keep', label: 'Оставить, вдруг пригодится', sub: 'Ещё немного',
        apply: function (s, a) { a.addSub(s, 'Сервис', sum(s, 690)); a.mood(s, 0, 1); } }
    ]
  });

  ev('random-cashback', {
    kind: 'opportunity', tags: ['random'],
    shortTitle: 'Кэшбэк', title: 'Вернулся кэшбэк за квартал',
    text: function (s) { return 'На счёт пришло ' + money(sum(s, 3400)) + ' — возврат части трат.'; },
    choices: [
      { id: 'save', label: 'Отложить', sub: 'Считать это не своими деньгами',
        apply: function (s, a) { a.earn(s, sum(s, 3400), 'Кэшбэк'); a.toReserve(s, sum(s, 3400)); a.mood(s, 2, 0); } },
      { id: 'spend', label: 'Потратить', sub: 'Небольшая радость',
        apply: function (s, a) { a.earn(s, sum(s, 3400), 'Кэшбэк'); a.spend(s, sum(s, 3400), 'Приятная мелочь', 'fun'); a.mood(s, 1, 3); } }
    ]
  });

  ev('random-tax-letter', {
    kind: 'shock', tags: ['random'],
    shortTitle: 'Письмо из налоговой', title: 'Пришло уведомление о налоге',
    text: function (s) { return 'Налог на имущество за прошлый год — ' + money(sum(s, 5200)) + '. Срок — до конца месяца.'; },
    choices: [
      { id: 'pay', label: 'Заплатить сразу', sub: 'Без пеней',
        apply: function (s, a) { a.spend(s, sum(s, 5200), 'Налог', 'mandatory'); a.mood(s, 1, 0); } },
      { id: 'later', label: 'Отложить', sub: 'Пени 0,1% в день',
        apply: function (s, a) { a.defer(s, 3, { cash: -sum(s, 6300), label: 'Налог с пенями', bucket: 'fees', calm: -4, type: 'bad' }); a.mood(s, -2, 0); } }
    ]
  });

  ev('random-friend-repay', {
    kind: 'opportunity', tags: ['random', 'social'],
    shortTitle: 'Друг вернул долг', title: 'Друг вернул деньги',
    text: function (s) { return 'Тот самый долг, о котором вы уже не думали: ' + money(sum(s, 18000)) + '.'; },
    choices: [
      { id: 'ok', label: 'Забрать', sub: 'И не напоминать про сроки',
        apply: function (s, a) { a.earn(s, sum(s, 18000), 'Друг вернул долг'); a.trust(s, 4); a.mood(s, 5, 1); } },
      { id: 'forgive', label: 'Простить остаток', sub: 'Забрать половину и закрыть тему',
        concept: 'social',
        apply: function (s, a) { a.earn(s, Math.round(sum(s, 18000) / 2), 'Друг вернул часть долга'); a.trust(s, 9); a.mood(s, 3, 3); } }
    ]
  });

  ev('random-lost-card', {
    kind: 'quiet', tags: ['random'],
    shortTitle: 'Потерянная карта', title: 'Карта потерялась',
    text: function (s) { return 'Перевыпуск стоит ' + money(sum(s, 900)) + ', неделю придётся жить наличными.'; },
    choices: [
      { id: 'fast', label: 'Срочный перевыпуск', sub: 'Дороже, но сразу',
        apply: function (s, a) { a.spend(s, sum(s, 2500), 'Срочный перевыпуск карты', 'living'); a.mood(s, 1, 1); } },
      { id: 'slow', label: 'Обычный перевыпуск', sub: 'Неделя без карты',
        apply: function (s, a) { a.spend(s, sum(s, 900), 'Перевыпуск карты', 'living'); a.energy(s, -3); a.mood(s, -1, -1); } }
    ]
  });

  ev('random-utility-recalc', {
    kind: 'opportunity', tags: ['random', 'housing'],
    shortTitle: 'Перерасчёт', title: 'Перерасчёт в вашу пользу',
    text: function (s) { return 'Управляющая компания пересчитала отопление: ' + money(sum(s, 4100)) + ' зачтётся в следующие месяцы.'; },
    choices: [
      { id: 'credit', label: 'Оставить в зачёт', sub: 'Следующие счета будут меньше',
        apply: function (s, a) { a.mandatoryDelta(s, -Math.round(sum(s, 4100) / 6)); a.mood(s, 3, 1); } },
      { id: 'cash', label: 'Попросить вернуть деньгами', sub: 'Заявление и две недели ожидания',
        apply: function (s, a) { a.energy(s, -3); a.defer(s, 2, { cash: sum(s, 4100), label: 'Возврат за отопление', type: 'good' }); a.mood(s, 2, 0); } }
    ]
  });

  ev('random-freelance-ping', {
    kind: 'opportunity', tags: ['random', 'sidejob', 'energy'], concept: 'energy',
    shortTitle: 'Неожиданный заказ', title: 'Написал старый заказчик',
    text: function (s) { return 'Срочная работа на выходные, оплата ' + money(sum(s, 25000)) + '. Ответ нужен сегодня.'; },
    choices: [
      { id: 'take', label: 'Взять', sub: 'Деньги за выходные',
        apply: function (s, a) { a.earn(s, sum(s, 25000), 'Разовый заказ'); a.energy(s, -13); a.mood(s, 2, -4); } },
      { id: 'no', label: 'Отказаться', sub: 'Выходные останутся выходными',
        apply: function (s, a) { a.energy(s, 4); a.mood(s, 0, 3); } }
    ]
  });

  ev('random-price-drop', {
    kind: 'temptation', tags: ['random', 'bigbuy'],
    shortTitle: 'Подешевело', title: 'То, что вы хотели, подешевело',
    text: function (s) { return 'Цена упала до ' + money(sum(s, 27000)) + '. Вы хотели это ещё полгода назад.'; },
    choices: [
      { id: 'buy', label: 'Купить', sub: 'Хотели же',
        apply: function (s, a) { a.spend(s, sum(s, 27000), 'Отложенная покупка', 'fun'); a.mood(s, 0, 9); } },
      { id: 'skip', label: 'Уже не нужно', sub: 'Полгода прожили без этого',
        apply: function (s, a) { a.mood(s, 3, -1); } }
    ]
  });

  ev('random-neighbor-noise', {
    kind: 'quiet', tags: ['random', 'housing'],
    shortTitle: 'Ремонт у соседей', title: 'У соседей ремонт',
    text: 'Перфоратор с восьми утра. Работать из дома невозможно, спать — тем более.',
    choices: [
      { id: 'cowork', label: 'Работать из кафе', sub: 'Тишина за деньги',
        apply: function (s, a) { a.spend(s, sum(s, 5500), 'Кафе вместо дома', 'living'); a.energy(s, 3); a.mood(s, 1, 1); } },
      { id: 'endure', label: 'Терпеть', sub: 'Бесплатно и мучительно',
        apply: function (s, a) { a.energy(s, -8); a.mood(s, -4, -3); } }
    ]
  });

  ev('random-broken-shoes', {
    kind: 'quiet', tags: ['random'],
    shortTitle: 'Порвалась обувь', title: 'Обувь не дожила до сезона',
    text: function (s) { return 'Ремонт — ' + money(sum(s, 1800)) + ', новая пара — ' + money(sum(s, 9000)) + '.'; },
    choices: [
      { id: 'fix', label: 'Отдать в ремонт', sub: 'Ещё сезон продержится',
        apply: function (s, a) { a.spend(s, sum(s, 1800), 'Ремонт обуви', 'living'); a.mood(s, 1, 0); } },
      { id: 'new', label: 'Купить новую', sub: 'Надолго',
        apply: function (s, a) { a.spend(s, sum(s, 9000), 'Новая обувь', 'fun'); a.mood(s, 0, 3); } }
    ]
  });

  ev('random-refund', {
    kind: 'opportunity', tags: ['random'],
    shortTitle: 'Возврат', title: 'Вернули деньги за отменённую услугу',
    text: function (s) { return 'Отменённая поездка или несостоявшийся заказ: ' + money(sum(s, 7500)) + ' вернулись на карту.'; },
    choices: [
      { id: 'reserve', label: 'Сразу в резерв', sub: 'Эти деньги вы уже мысленно потратили',
        apply: function (s, a) { a.earn(s, sum(s, 7500), 'Возврат средств'); a.toReserve(s, sum(s, 7500)); a.mood(s, 3, 0); } },
      { id: 'spend', label: 'Оставить на счету', sub: 'Пусть просто будут',
        apply: function (s, a) { a.earn(s, sum(s, 7500), 'Возврат средств'); a.mood(s, 1, 2); } }
    ]
  });

  /*
   *  Какие события годятся на роль «событие месяца».
   *
   *  Теперь событие есть в каждом месяце, а уникальных шаблонов на пять лет
   *  не хватает — значит, часть будет повторяться. Повторять можно не всё:
   *  «выбрать правило накоплений» или «положить все деньги на вклад» —
   *  разовые решения, и на третий раз они ломают и логику, и баланс.
   *  Здесь перечислены ситуации, которые в жизни действительно повторяются.
   */

  /*
   *  ВЕРСИЯ 4: КРУПНЫЕ СИТУАЦИИ
   *
   *  Основные события — те, что занимают месячный слот целиком. Их было
   *  заметно меньше, чем слотов в сценариях, и за пять лет одна и та же
   *  ситуация приходила по три-четыре раза. Особенно голодали теги
   *  health, energy, sidejob, family и shock: у них на весь пул
   *  приходилось по одному-два события, и месяц становился предсказуемым.
   *
   *  Все организации, предложения и суммы вымышлены.
   */

  /* Здоровье */

  ev('health-checkup', {
    kind: 'offer', tags: ['health', 'easy', 'mid', 'hard'], concept: 'insurance',
    shortTitle: 'Обследование', title: 'Плановое обследование',
    text: 'Врач предлагает пройти полное обследование: {14000} ₽ и один рабочий день. Ничего не болит — в этом и вопрос.',
    choices: [
      { id: 'full', label: 'Пройти полностью', sub: '{14000} ₽, спокойнее на годы вперёд',
        apply: function (s, a) { a.spend(s, sum(s, 14000), 'Обследование', 'shocks'); a.mood(s, 6, 2); a.flag(s, 'checked_health'); a.defer(s, 8, { energy: 6, label: 'Проблему поймали рано', type: 'good' }); } },
      { id: 'basic', label: 'Только анализы', sub: '{4000} ₽, половина картины',
        apply: function (s, a) { a.spend(s, sum(s, 4000), 'Анализы', 'shocks'); a.mood(s, 2, 0); } },
      { id: 'skip', label: 'Отложить до симптомов', sub: '0 ₽ сейчас',
        apply: function (s, a) { a.mood(s, -1, 0); a.gamble(s, 'health-checkup-skip', [
          { p: .24, label: 'Запущенная проблема: лечение дороже', bad: true, effect: function (s, a) { a.spend(s, sum(s, 46000), 'Лечение', 'shocks'); a.energy(s, -16); a.mood(s, -8, -6); } },
          { p: .76, label: 'В этот раз обошлось', effect: function (s, a) { a.mood(s, 1, 0); } }
        ]); } }
    ]
  });

  ev('health-surgery', {
    kind: 'shock', tags: ['health', 'shock', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'Операция', title: 'Нужна операция',
    text: 'Плановая, но откладывать нельзя. По квоте — очередь на четыре месяца и боль всё это время. Платно — {130000} ₽ и через неделю.',
    choices: [
      { id: 'pay', label: 'Оплатить и сделать сейчас', sub: '{130000} ₽ сразу',
        apply: function (s, a) { a.spend(s, sum(s, 130000), 'Операция', 'shocks'); a.energy(s, -12); a.mood(s, 4, 4); a.defer(s, 2, { energy: 14, label: 'Восстановился', type: 'good' }); } },
      { id: 'credit', label: 'Взять кредит на лечение', sub: 'Долг на 24 месяца', concept: 'annuity',
        apply: function (s, a) { a.borrow(s, { id: 'med', label: 'Кредит на лечение', principal: sum(s, 130000), months: 24, baseAnnualRate: .21 }); a.energy(s, -12); a.mood(s, 1, 3); } },
      { id: 'queue', label: 'Ждать квоту', sub: '0 ₽, четыре месяца боли',
        apply: function (s, a) { a.energy(s, -22); a.mood(s, -9, -10); a.defer(s, 4, { energy: 10, quality: 6, label: 'Дождался очереди', type: 'good' }); } }
    ]
  });

  ev('health-parent-care', {
    kind: 'social', tags: ['health', 'family', 'mid', 'hard'], concept: 'trust',
    shortTitle: 'Родителям нужна помощь', title: 'Родителям нужна сиделка',
    text: 'Три раза в неделю кто-то должен быть рядом. Сиделка — {24000} ₽ в месяц. Можно ездить самому, но это шесть вечеров и дорога.',
    choices: [
      { id: 'hire', label: 'Нанять сиделку', sub: '{24000} ₽/мес на 6 месяцев',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 24000)); a.trust(s, 6); a.mood(s, 3, 0); a.defer(s, 6, { mandatory: -sum(s, 24000), label: 'Помощь больше не нужна', type: 'good' }); } },
      { id: 'self', label: 'Ездить самому', sub: '0 ₽, −20 сил в месяц',
        apply: function (s, a) { a.energy(s, -20); a.trust(s, 12); a.mood(s, -3, -6); a.defer(s, 3, { energy: -12, label: 'Дорога выматывает', type: 'bad' }); } },
      { id: 'split', label: 'Разделить с роднёй', sub: '{11000} ₽/мес и часть вечеров',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 11000)); a.energy(s, -9); a.trust(s, 8); a.defer(s, 6, { mandatory: -sum(s, 11000), label: 'Дежурства закончились' }); } }
    ]
  });

  ev('health-burnout', {
    kind: 'shock', tags: ['health', 'energy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Организм сдаёт', title: 'Организм подаёт счёт',
    text: 'Спина, сон и постоянная усталость. Врач говорит прямо: или месяц разгрузки сейчас, или полгода лечения потом.',
    choices: [
      { id: 'leave', label: 'Взять отпуск за свой счёт', sub: '−1 месяц дохода, +30 сил',
        apply: function (s, a) { a.tempIncome(s, -Math.round(s.income * 0.9), 1, { label: 'Вернулся к работе' }); a.energy(s, 30); a.mood(s, 8, 6); } },
      { id: 'therapy', label: 'Лечение без отрыва', sub: '{32000} ₽, +14 сил',
        apply: function (s, a) { a.spend(s, sum(s, 32000), 'Лечение', 'shocks'); a.energy(s, 14); a.mood(s, 2, 2); } },
      { id: 'push', label: 'Дотерпеть', sub: '0 ₽, но счёт растёт',
        apply: function (s, a) { a.energy(s, -14); a.mood(s, -6, -6); a.defer(s, 5, { cash: -sum(s, 62000), energy: -12, label: 'Пришлось лечиться всерьёз', type: 'bad' }); } }
    ]
  });

  /* Силы и время */

  ev('energy-commute', {
    kind: 'offer', tags: ['energy', 'housing', 'easy', 'mid'], concept: 'lifestyle',
    shortTitle: 'Дорога на работу', title: 'Два часа в дороге каждый день',
    text: 'Ближе к работе жильё дороже на {12000} ₽ в месяц. Дальше — дешевле, но десять часов в неделю уходят в дорогу.',
    choices: [
      { id: 'move', label: 'Переехать ближе', sub: '+{12000} ₽/мес, +14 сил',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 12000)); a.energy(s, 14); a.mood(s, 4, 7); a.spend(s, sum(s, 26000), 'Переезд', 'shocks'); } },
      { id: 'stay', label: 'Остаться и терпеть', sub: '0 ₽, −10 сил в месяц',
        apply: function (s, a) { a.energy(s, -10); a.mood(s, -2, -4); a.defer(s, 6, { energy: -8, label: 'Дорога вымотала', type: 'bad' }); } },
      { id: 'remote', label: 'Договориться о двух днях дома', sub: '0 ₽, +7 сил', concept: 'negotiation',
        apply: function (s, a) { a.energy(s, 7); a.mood(s, 3, 3); } }
    ]
  });

  ev('energy-sleep-debt', {
    kind: 'quiet', tags: ['energy', 'easy', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Недосып', title: 'Сон стал роскошью',
    text: 'Пять часов сна четвёртую неделю подряд. Пока держитесь на кофе — и на том, что счёт за это приходит не сразу.',
    choices: [
      { id: 'fix', label: 'Перестроить режим', sub: '−1 вечер в неделю, +18 сил',
        apply: function (s, a) { a.energy(s, 18); a.mood(s, 5, 3); a.flag(s, 'sleep_fixed'); } },
      { id: 'pills', label: 'Купить снотворное', sub: '{5500} ₽, +8 сил',
        apply: function (s, a) { a.spend(s, sum(s, 5500), 'Аптека', 'shocks'); a.energy(s, 8); a.mood(s, 1, 0); } },
      { id: 'ignore', label: 'Не обращать внимания', sub: '0 ₽',
        apply: function (s, a) { a.energy(s, -12); a.mood(s, -4, -3); } }
    ]
  });

  ev('energy-hobby', {
    kind: 'offer', tags: ['energy', 'social', 'easy', 'mid'], concept: 'lifestyle',
    shortTitle: 'Хобби', title: 'Вернуться к тому, что любили',
    text: 'Мастерская, бассейн или музыка — {4900} ₽ в месяц и два вечера. Пользы в деньгах нет никакой.',
    choices: [
      { id: 'yes', label: 'Записаться', sub: '{4900} ₽/мес, +качество жизни',
        apply: function (s, a) { a.addSub(s, 'Хобби', sum(s, 4900)); a.mood(s, 6, 11); a.energy(s, 5); } },
      { id: 'trial', label: 'Взять пробный месяц', sub: '{1500} ₽ разово',
        apply: function (s, a) { a.spend(s, sum(s, 1500), 'Пробное занятие', 'fun'); a.mood(s, 3, 5); } },
      { id: 'no', label: 'Не сейчас', sub: '0 ₽',
        apply: function (s, a) { a.mood(s, 0, -3); } }
    ]
  });

  /* Подработка и доход */

  ev('sidejob-nights', {
    kind: 'opportunity', tags: ['sidejob', 'income', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Ночные смены', title: 'Ночные смены на складе',
    text: 'Восемь ночей в месяц — {31000} ₽ сверху. Днём вы всё равно работаете.',
    choices: [
      { id: 'take', label: 'Взять на три месяца', sub: '+{31000} ₽/мес, −22 силы',
        apply: function (s, a) { a.tempIncome(s, sum(s, 31000), 3, { label: 'Смены закончились', calm: 2 }); a.energy(s, -22); a.mood(s, 1, -7); a.defer(s, 3, { energy: -10, label: 'Отсыпаться пришлось долго', type: 'bad' }); } },
      { id: 'half', label: 'Четыре ночи в месяц', sub: '+{16000} ₽/мес, −11 сил',
        apply: function (s, a) { a.tempIncome(s, sum(s, 16000), 3, { label: 'Смены закончились' }); a.energy(s, -11); a.mood(s, 0, -3); } },
      { id: 'no', label: 'Отказаться', sub: 'Сон дороже',
        apply: function (s, a) { a.energy(s, 5); a.mood(s, 2, 2); } }
    ]
  });

  ev('sidejob-tutor', {
    kind: 'opportunity', tags: ['sidejob', 'income', 'easy', 'mid'], concept: 'energy',
    shortTitle: 'Репетиторство', title: 'Учить тому, что умеете',
    text: 'Четыре ученика по вечерам — {26000} ₽ в месяц. Первое время придётся готовиться к каждому занятию.',
    choices: [
      { id: 'four', label: 'Взять четверых', sub: '+{26000} ₽/мес, −15 сил',
        apply: function (s, a) { a.tempIncome(s, sum(s, 26000), 6, { label: 'Учебный год закончился' }); a.energy(s, -15); a.mood(s, 3, -2); a.flag(s, 'tutor'); } },
      { id: 'two', label: 'Начать с двоих', sub: '+{13000} ₽/мес, −7 сил',
        apply: function (s, a) { a.tempIncome(s, sum(s, 13000), 6, { label: 'Учебный год закончился' }); a.energy(s, -7); a.mood(s, 2, 0); } },
      { id: 'no', label: 'Не браться', sub: '0 ₽',
        apply: function (s, a) { a.mood(s, 0, 1); } }
    ]
  });

  ev('sidejob-marketplace', {
    kind: 'opportunity', tags: ['sidejob', 'risk', 'mid', 'hard'], concept: 'risk',
    shortTitle: 'Торговля на маркетплейсе', title: 'Своя точка на маркетплейсе',
    text: 'Закупка товара — {90000} ₽. Может пойти, может зависнуть на складе. Продавцы, у которых пошло, рассказывают об этом чаще остальных.',
    choices: [
      { id: 'big', label: 'Вложить {90000} ₽', sub: 'Шанс 42% на хороший оборот', concept: 'expected',
        apply: function (s, a) { a.spend(s, sum(s, 90000), 'Закупка товара', 'invested'); a.energy(s, -14); a.gamble(s, 'mp-big', [
          { p: .42, label: 'Пошло: +{19000} ₽/мес на год', good: true, effect: function (s, a) { a.tempIncome(s, sum(s, 19000), 12, { label: 'Сезон закончился' }); a.mood(s, 9, 4); } },
          { p: .38, label: 'Продалось в ноль', effect: function (s, a) { a.earn(s, sum(s, 78000), 'Возврат вложенного'); a.mood(s, -2, 0); } },
          { p: .20, label: 'Товар завис на складе', bad: true, effect: function (s, a) { a.earn(s, sum(s, 22000), 'Распродали остатки'); a.mood(s, -9, -4); } }
        ]); } },
      { id: 'small', label: 'Попробовать на {25000} ₽', sub: 'Меньше риска, меньше отдача',
        apply: function (s, a) { a.spend(s, sum(s, 25000), 'Пробная закупка', 'invested'); a.energy(s, -6); a.gamble(s, 'mp-small', [
          { p: .46, label: 'Небольшой, но стабильный доход', good: true, effect: function (s, a) { a.tempIncome(s, sum(s, 6000), 12, { label: 'Сезон закончился' }); a.mood(s, 4, 2); } },
          { p: .54, label: 'Вышли примерно в ноль', effect: function (s, a) { a.earn(s, sum(s, 21000), 'Возврат вложенного'); } }
        ]); } },
      { id: 'no', label: 'Не влезать', sub: 'Деньги остаются при вас',
        apply: function (s, a) { a.mood(s, 1, 0); } }
    ]
  });

  /* Семья и близкие */

  ev('family-child-school', {
    kind: 'social', tags: ['family', 'social', 'mid', 'hard'], concept: 'trust',
    shortTitle: 'Школа ребёнка', title: 'Сильная школа стоит денег',
    text: 'Перевод в школу получше: {18000} ₽ в месяц и дорога через полгорода. Ребёнок пока не понимает, о чём спор.',
    choices: [
      { id: 'move', label: 'Перевести', sub: '{18000} ₽/мес',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 18000)); a.trust(s, 7); a.mood(s, -2, 8); a.energy(s, -6); } },
      { id: 'tutors', label: 'Остаться и взять репетиторов', sub: '{9000} ₽/мес',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 9000)); a.trust(s, 3); a.mood(s, 0, 4); } },
      { id: 'stay', label: 'Оставить как есть', sub: '0 ₽',
        apply: function (s, a) { a.trust(s, -5); a.mood(s, -2, -3); } }
    ]
  });

  ev('family-support-ask', {
    kind: 'social', tags: ['family', 'social', 'easy', 'mid', 'hard'], concept: 'trust',
    shortTitle: 'Просьба о деньгах', title: 'Брат просит в долг',
    text: 'Просит {70000} ₽ до весны. Отдаёт обычно, но не всегда в срок. Отказ помнят дольше, чем деньги.',
    choices: [
      { id: 'all', label: 'Дать сколько просит', sub: '{70000} ₽ из своих',
        apply: function (s, a) { a.spend(s, sum(s, 70000), 'В долг брату', 'fun'); a.trust(s, 10); a.gamble(s, 'family-loan', [
          { p: .62, label: 'Вернул вовремя', good: true, effect: function (s, a) { a.defer(s, 5, { cash: sum(s, 70000), label: 'Долг вернули', type: 'good' }); } },
          { p: .38, label: 'Отдаёт частями и с задержкой', effect: function (s, a) { a.defer(s, 9, { cash: sum(s, 40000), label: 'Вернули часть' }); a.mood(s, -4, -2); } }
        ]); } },
      { id: 'part', label: 'Дать треть', sub: '{23000} ₽, честно объяснить',
        apply: function (s, a) { a.spend(s, sum(s, 23000), 'В долг брату', 'fun'); a.trust(s, 4); a.defer(s, 5, { cash: sum(s, 23000), label: 'Долг вернули', type: 'good' }); } },
      { id: 'no', label: 'Отказать', sub: '0 ₽',
        apply: function (s, a) { a.trust(s, -12); a.mood(s, -5, -2); } }
    ]
  });

  ev('family-move-in', {
    kind: 'social', tags: ['family', 'housing', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Родня переезжает', title: 'Родственники поживут у вас',
    text: 'На три месяца, пока ищут жильё. Еда и коммуналка вырастут, личного пространства не останется.',
    choices: [
      { id: 'yes', label: 'Пустить', sub: '+{9000} ₽/мес расходов на 3 месяца',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 9000)); a.trust(s, 11); a.mood(s, -3, -7); a.defer(s, 3, { mandatory: -sum(s, 9000), quality: 6, label: 'Родня съехала', type: 'good' }); } },
      { id: 'rent', label: 'Помочь с арендой', sub: '{16000} ₽/мес на 3 месяца',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 16000)); a.trust(s, 6); a.defer(s, 3, { mandatory: -sum(s, 16000), label: 'Помощь закончилась' }); } },
      { id: 'no', label: 'Отказать', sub: '0 ₽',
        apply: function (s, a) { a.trust(s, -10); a.mood(s, -4, 1); } }
    ]
  });

  /* Удары судьбы */

  ev('shock-car-crash', {
    kind: 'shock', tags: ['shock', 'bigbuy', 'mid', 'hard'], concept: 'insurance',
    shortTitle: 'Авария', title: 'Не ваша вина, но машина ваша',
    text: 'Виновник без страховки. Ремонт — {145000} ₽. Суд возможен, но это год и не факт.',
    choices: [
      { id: 'fix', label: 'Отремонтировать сразу', sub: '{145000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 145000), 'Ремонт после аварии', 'shocks'); a.mood(s, -6, -3); a.schedule(s, 8, 'arc-flood-court'); } },
      { id: 'cheap', label: 'Починить по минимуму', sub: '{52000} ₽, ездит и ладно',
        apply: function (s, a) { a.spend(s, sum(s, 52000), 'Минимальный ремонт', 'shocks'); a.mood(s, -3, -8); a.defer(s, 7, { cash: -sum(s, 40000), label: 'Вылезло то, что не чинили', type: 'bad' }); } },
      { id: 'sell', label: 'Продать как есть', sub: '+{70000} ₽, без машины',
        apply: function (s, a) { a.earn(s, sum(s, 70000), 'Продана битая машина'); a.mandatoryDelta(s, -sum(s, 7000)); a.mood(s, -2, -9); a.energy(s, -6); } }
    ]
  });

  ev('shock-layoff-wave', {
    kind: 'shock', tags: ['shock', 'income', 'career', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'Сокращения', title: 'Половину отдела сокращают',
    text: 'Предлагают уйти по соглашению с двумя окладами или остаться и ждать. Ждать можно до приказа, а можно до последнего.',
    choices: [
      { id: 'leave', label: 'Уйти с компенсацией', sub: '+2 оклада, дохода нет 2 месяца',
        apply: function (s, a) { a.earn(s, Math.round(s.income * 2), 'Компенсация при увольнении'); a.tempIncome(s, -Math.round(s.income * 0.95), 2, { label: 'Нашлась новая работа', calm: 5 }); a.mood(s, -4, -3); a.energy(s, -8); } },
      { id: 'stay', label: 'Остаться и ждать', sub: 'Шанс 45% удержаться', concept: 'expected',
        apply: function (s, a) { a.mood(s, -7, -4); a.gamble(s, 'layoff-wave', [
          { p: .45, label: 'Вас оставили', good: true, effect: function (s, a) { a.mood(s, 10, 5); } },
          { p: .55, label: 'Сократили без компенсации', bad: true, effect: function (s, a) { a.tempIncome(s, -Math.round(s.income * 0.95), 3, { label: 'Нашлась новая работа' }); a.mood(s, -9, -6); } }
        ]); } },
      { id: 'search', label: 'Остаться и искать параллельно', sub: '−12 сил, но подстелить соломки',
        apply: function (s, a) { a.energy(s, -12); a.mood(s, -2, -2); a.defer(s, 3, { income: Math.round(s.income * 0.08), label: 'Оффер лучше прежнего', type: 'good' }); } }
    ]
  });

  ev('shock-flood-neighbors', {
    kind: 'shock', tags: ['shock', 'housing', 'easy', 'mid', 'hard'], concept: 'insurance',
    shortTitle: 'Затопили соседей', title: 'Вы затопили соседей снизу',
    text: 'Лопнул шланг стиральной машины. Соседи насчитали {96000} ₽. Страховки нет.',
    choices: [
      { id: 'pay', label: 'Заплатить сразу', sub: '{96000} ₽, вопрос закрыт',
        apply: function (s, a) { a.spend(s, sum(s, 96000), 'Возмещение соседям', 'shocks'); a.mood(s, -4, -2); a.trust(s, 3); } },
      { id: 'talk', label: 'Договориться на рассрочку', sub: '{16000} ₽ × 6 месяцев', concept: 'negotiation',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 16000)); a.mood(s, -2, -2); a.defer(s, 6, { mandatory: -sum(s, 16000), label: 'Возмещение выплачено', type: 'good' }); } },
      { id: 'court', label: 'Спорить и требовать оценку', sub: 'Дешевле, но дольше и нервно',
        apply: function (s, a) { a.mood(s, -8, -4); a.energy(s, -10); a.gamble(s, 'flood-court', [
          { p: .55, label: 'Оценка вышла вдвое меньше', good: true, effect: function (s, a) { a.spend(s, sum(s, 44000), 'Возмещение по оценке', 'shocks'); } },
          { p: .45, label: 'Суд встал на сторону соседей', bad: true, effect: function (s, a) { a.spend(s, sum(s, 118000), 'Возмещение и судебные', 'shocks'); a.trust(s, -5); } }
        ]); } }
    ]
  });

  ev('shock-theft', {
    kind: 'shock', tags: ['shock', 'easy', 'mid', 'hard'], concept: 'reserve',
    shortTitle: 'Кража', title: 'Вскрыли квартиру',
    text: 'Вынесли технику и наличные. Полиция приняла заявление и обещала позвонить.',
    choices: [
      { id: 'replace', label: 'Купить всё заново', sub: '{88000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 88000), 'Замена украденного', 'shocks'); a.mood(s, -6, 2); } },
      { id: 'minimal', label: 'Купить только необходимое', sub: '{31000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 31000), 'Самое необходимое', 'shocks'); a.mood(s, -8, -6); } },
      { id: 'insure', label: 'Купить минимум и застраховать жильё', sub: '{31000} ₽ + {1400} ₽/мес', concept: 'insurance',
        apply: function (s, a) { a.spend(s, sum(s, 31000), 'Самое необходимое', 'shocks'); a.addSub(s, 'Страховка жилья', sum(s, 1400)); a.mood(s, -4, -3); a.flag(s, 'home_insured'); } }
    ]
  });

  /* Жильё */

  ev('housing-landlord-sells', {
    kind: 'shock', tags: ['housing', 'shock', 'mid', 'hard'], concept: 'optionality',
    shortTitle: 'Хозяин продаёт', title: 'Квартиру продают',
    text: 'Два месяца на то, чтобы съехать. Переезд — это залог, комиссия и грузчики.',
    choices: [
      { id: 'similar', label: 'Снять похожую', sub: '{62000} ₽ разово, +{4000} ₽/мес',
        apply: function (s, a) { a.spend(s, sum(s, 62000), 'Переезд и залог', 'shocks'); a.mandatoryDelta(s, sum(s, 4000)); a.mood(s, -3, -2); a.energy(s, -8); } },
      { id: 'cheaper', label: 'Снять дешевле и дальше', sub: '{46000} ₽ разово, −{7000} ₽/мес',
        apply: function (s, a) { a.spend(s, sum(s, 46000), 'Переезд и залог', 'shocks'); a.mandatoryDelta(s, -sum(s, 7000)); a.energy(s, -14); a.mood(s, -2, -7); } },
      { id: 'buy-out', label: 'Попробовать выкупить', sub: 'Первый взнос из резерва', concept: 'liquidity',
        apply: function (s, a) { a.mood(s, -2, 1); a.gamble(s, 'buy-out', [
          { p: .35, label: 'Договорились: ипотека на 20 лет', effect: function (s, a) { a.spend(s, Math.min(s.reserve + s.cash, sum(s, 400000)), 'Первый взнос', 'invested'); a.mandatoryDelta(s, sum(s, 9000)); a.mood(s, 8, 8); a.flag(s, 'owner'); } },
          { p: .65, label: 'Продавец не стал ждать', bad: true, effect: function (s, a) { a.spend(s, sum(s, 62000), 'Срочный переезд', 'shocks'); a.energy(s, -12); a.mood(s, -7, -4); } }
        ]); } }
    ]
  });

  ev('housing-repair', {
    kind: 'temptation', tags: ['housing', 'bigbuy', 'easy', 'mid'], concept: 'sunk',
    shortTitle: 'Ремонт', title: 'Ремонт, который давно откладывали',
    text: 'Смета — {260000} ₽. Можно сделать всё сразу, можно по комнате в год, можно ещё потерпеть.',
    choices: [
      { id: 'all', label: 'Сделать всё сразу', sub: '{260000} ₽ или кредит',
        apply: function (s, a) { if (s.cash + s.reserve >= sum(s, 260000)) { a.spend(s, sum(s, 260000), 'Ремонт', 'fun'); } else { a.borrow(s, { id: 'repair', label: 'Кредит на ремонт', principal: sum(s, 260000), months: 36, baseAnnualRate: .23 }); } a.mood(s, 5, 14); a.energy(s, -12); } },
      { id: 'step', label: 'По комнате в год', sub: '{70000} ₽ сейчас',
        apply: function (s, a) { a.spend(s, sum(s, 70000), 'Ремонт: первая комната', 'fun'); a.mood(s, 3, 6); a.defer(s, 12, { cash: -sum(s, 70000), quality: 5, label: 'Ремонт: вторая комната' }); } },
      { id: 'wait', label: 'Ещё потерпеть', sub: '0 ₽',
        apply: function (s, a) { a.mood(s, -1, -4); } }
    ]
  });

  ev('housing-utilities-debt', {
    kind: 'shock', tags: ['housing', 'debt', 'mid', 'hard'], concept: 'debtload',
    shortTitle: 'Долг по коммуналке', title: 'Долг за коммуналку',
    text: 'Накопилось {64000} ₽ и пени капают. Управляющая готова на рассрочку, если прийти самому.',
    choices: [
      { id: 'pay', label: 'Погасить целиком', sub: '{64000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 64000), 'Долг по коммуналке', 'mandatory'); a.mood(s, 6, 2); } },
      { id: 'plan', label: 'Оформить рассрочку', sub: '{11000} ₽ × 6 месяцев', concept: 'negotiation',
        apply: function (s, a) { a.mandatoryDelta(s, sum(s, 11000)); a.mood(s, 2, 0); a.defer(s, 6, { mandatory: -sum(s, 11000), label: 'Долг по коммуналке закрыт', type: 'good' }); } },
      { id: 'ignore', label: 'Отложить ещё', sub: 'Пени растут',
        apply: function (s, a) { a.mood(s, -5, -3); a.defer(s, 4, { cash: -sum(s, 24000), label: 'Пени и судебный приказ', type: 'bad' }); a.credit(s, -20); } }
    ]
  });

  /* Деньги: подписки, покупки, обман */

  ev('subs-family-plan', {
    kind: 'offer', tags: ['subs', 'easy', 'mid'], concept: 'subs',
    shortTitle: 'Семейная подписка', title: 'Семейный тариф на всех',
    text: 'Один тариф вместо четырёх личных: {1290} ₽ вместо 2 400 ₽ в месяц. Считать придётся с родственниками.',
    choices: [
      { id: 'yes', label: 'Перевести всех', sub: '−1 100 ₽/мес',
        apply: function (s, a) { a.addSub(s, 'Семейный тариф', sum(s, 1290)); a.mood(s, 3, 1); a.trust(s, 3); } },
      { id: 'own', label: 'Оставить свой', sub: '0 ₽ изменений',
        apply: function (s, a) { a.mood(s, 0, 0); } },
      { id: 'cut', label: 'Отказаться от всех', sub: 'Минус все подписки', concept: 'subs',
        apply: function (s, a) { a.removeSubs(s); a.mood(s, 2, -5); } }
    ]
  });

  ev('bigbuy-furniture', {
    kind: 'temptation', tags: ['bigbuy', 'credit', 'easy', 'mid'], concept: 'installment',
    shortTitle: 'Мебель', title: 'Мебель в рассрочку «без переплаты»',
    text: 'Диван и шкаф — {118000} ₽. Рассрочка {9900} ₽ × 12. Магазин уверяет, что переплаты нет.',
    choices: [
      { id: 'cash', label: 'Купить за свои', sub: '{118000} ₽ сразу',
        apply: function (s, a) { a.spend(s, sum(s, 118000), 'Мебель', 'fun'); a.mood(s, 2, 9); } },
      { id: 'credit', label: 'Взять рассрочку', sub: '{9900} ₽ × 12 = 118 800 ₽',
        apply: function (s, a) { a.addDebt(s, { id: 'furn', label: 'Рассрочка на мебель', principal: sum(s, 118000), payment: sum(s, 9900), months: 12, monthlyRate: .0009 }); a.mood(s, 0, 9); } },
      { id: 'used', label: 'Найти б/у', sub: '{34000} ₽, выбор хуже',
        apply: function (s, a) { a.spend(s, sum(s, 34000), 'Мебель б/у', 'fun'); a.mood(s, 3, 4); a.energy(s, -6); } }
    ]
  });

  ev('scam-job-offer', {
    kind: 'scam', tags: ['scam', 'easy', 'mid', 'hard'], concept: 'scam',
    shortTitle: 'Работа мечты', title: 'Удалённая работа с оплатой вперёд',
    text: 'Пишут в мессенджер: 140 000 ₽ в месяц, из дома, опыт не нужен. Просят {12000} ₽ за «обучающий пакет и оформление».',
    choices: [
      { id: 'pay', label: 'Оплатить пакет', sub: '{12000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 12000), 'Обучающий пакет', 'fees'); s.stats.scamHit++; a.mood(s, -8, -4); a.note(s, 'Работодатель пропал', 0, 'bad'); } },
      { id: 'check', label: 'Проверить компанию', sub: '0 ₽, полчаса времени',
        apply: function (s, a) { s.stats.scamAvoided++; a.learn(s, 'scam'); a.mood(s, 5, 1); a.note(s, 'Компании не существует', 0, 'good'); } },
      { id: 'ignore', label: 'Не отвечать', sub: '0 ₽',
        apply: function (s, a) { s.stats.scamAvoided++; a.mood(s, 2, 0); } }
    ]
  });

  ev('scam-crypto-friend', {
    kind: 'scam', tags: ['scam', 'invest', 'mid', 'hard'], concept: 'scam',
    shortTitle: 'Схема знакомого', title: 'Знакомый зовёт в «схему»',
    text: 'Обещает 8% в месяц. Показывает свои выплаты за полгода — они настоящие. Откуда берётся доход, объяснить не может.',
    choices: [
      { id: 'in', label: 'Вложить {100000} ₽', sub: 'Выплаты идут, пока приходят новые',
        apply: function (s, a) { a.spend(s, sum(s, 100000), 'Вложение в схему', 'invested'); s.stats.gambles++; a.gamble(s, 'pyramid', [
          { p: .28, label: 'Успели выйти с прибылью', good: true, effect: function (s, a) { a.defer(s, 4, { cash: sum(s, 142000), label: 'Вывели вложенное с доходом', type: 'good' }); } },
          { p: .72, label: 'Схема закрылась вместе с деньгами', bad: true, effect: function (s, a) { s.stats.scamHit++; a.mood(s, -14, -6); a.trust(s, -6); } }
        ]); } },
      { id: 'small', label: 'Вложить {20000} ₽ «на попробовать»', sub: 'Потеря переживаема',
        apply: function (s, a) { a.spend(s, sum(s, 20000), 'Вложение в схему', 'invested'); a.gamble(s, 'pyramid-small', [
          { p: .28, label: 'Вышли с небольшой прибылью', good: true, effect: function (s, a) { a.defer(s, 4, { cash: sum(s, 28000), label: 'Вывели вложенное' }); } },
          { p: .72, label: 'Схема закрылась', bad: true, effect: function (s, a) { s.stats.scamHit++; a.mood(s, -5, -2); } }
        ]); } },
      { id: 'no', label: 'Отказаться и объяснить почему', sub: '0 ₽',
        apply: function (s, a) { s.stats.scamAvoided++; a.learn(s, 'scam'); a.mood(s, 4, 1); a.trust(s, -2); } }
    ]
  });

  /* Накопления, вложения, долги */

  ev('save-goal-split', {
    kind: 'offer', tags: ['save', 'easy', 'mid'], concept: 'reserve',
    shortTitle: 'Две цели', title: 'Копить на подушку или на мечту',
    text: 'Свободные деньги можно направить в резерв, а можно — на то, ради чего вообще стоит работать. Одновременно не выйдет.',
    choices: [
      { id: 'reserve', label: 'Всё в резерв', sub: 'Скучно и надёжно',
        apply: function (s, a) { a.setAutoSave(s, 0.18); a.mood(s, 5, -3); a.learn(s, 'reserve'); } },
      { id: 'split', label: 'Пополам', sub: 'И подушка, и мечта — медленнее',
        apply: function (s, a) { a.setAutoSave(s, 0.09); a.mood(s, 3, 3); } },
      { id: 'dream', label: 'Всё на мечту', sub: 'Резерв не растёт',
        apply: function (s, a) { a.setAutoSave(s, 0); a.mood(s, -2, 9); a.defer(s, 10, { quality: 8, cash: -sum(s, 120000), label: 'Мечта сбылась', type: 'good' }); } }
    ]
  });

  ev('invest-first-step', {
    kind: 'offer', tags: ['invest', 'save', 'easy', 'mid'], concept: 'diversify',
    shortTitle: 'Первые вложения', title: 'Часть резерва лежит без дела',
    text: 'Резерв должен быть под рукой, но весь резерв под рукой держать необязательно. Часть можно положить туда, где она хотя бы догоняет инфляцию.',
    choices: [
      { id: 'deposit', label: 'Часть — на вклад', sub: 'Медленно, зато не падает',
        apply: function (s, a) { a.mood(s, 4, 1); a.learn(s, 'inflation'); a.defer(s, 6, { cash: Math.round(Math.min(s.reserve, sum(s, 120000)) * 0.035), label: 'Проценты по вкладу', type: 'good' }); } },
      { id: 'fund', label: 'Часть — в фонд', sub: 'Выше отдача, бывает и минус', concept: 'diversify',
        apply: function (s, a) { a.mood(s, 2, 1); a.gamble(s, 'first-fund', [
          { p: .62, label: 'Фонд подрос', good: true, effect: function (s, a) { a.defer(s, 8, { cash: sum(s, 34000), label: 'Доход от фонда', type: 'good' }); } },
          { p: .38, label: 'Фонд просел', bad: true, effect: function (s, a) { a.defer(s, 8, { cash: -sum(s, 18000), label: 'Просадка фонда', type: 'bad' }); } }
        ]); } },
      { id: 'keep', label: 'Оставить всё на счету', sub: 'Инфляция съедает тихо',
        apply: function (s, a) { a.mood(s, 1, 0); a.learn(s, 'inflation'); } }
    ]
  });

  ev('debt-collector-call', {
    kind: 'shock', tags: ['debt', 'credit', 'hard'], concept: 'debtload',
    // Коллекторам нечего требовать с того, у кого нет долгов: без этого
    // условия событие приходило в чистую партию и не делало ровно ничего.
    requires: function (s, E) { return E.debtBalanceTotal(s) > 0; },
    shortTitle: 'Звонок из банка', title: 'Долг передали коллекторам',
    text: 'Звонят каждый день. Предлагают закрыть 40% суммы разом и забыть остальное — письменно подтвердить отказываются.',
    choices: [
      { id: 'settle', label: 'Договориться письменно', sub: 'Скидка меньше, зато на бумаге', concept: 'negotiation',
        apply: function (s, a) { var d = s.debts[0]; if (d) { var pay = Math.round(d.balance * 0.62); a.repay(s, pay, { id: d.id, all: true }); a.mood(s, 8, 3); a.credit(s, -10); } else { a.mood(s, 2, 0); } } },
      { id: 'verbal', label: 'Заплатить на слово', sub: '40% сразу, гарантий нет',
        apply: function (s, a) { var d = s.debts[0]; if (d) { a.repay(s, Math.round(d.balance * 0.4), { id: d.id }); } a.gamble(s, 'collector', [
          { p: .45, label: 'Долг действительно списали', good: true, effect: function (s, a) { var d = s.debts[0]; if (d) a.repay(s, d.balance, { id: d.id, all: true }); a.mood(s, 9, 4); } },
          { p: .55, label: 'Остаток продолжают требовать', bad: true, effect: function (s, a) { a.mood(s, -11, -6); } }
        ]); } },
      { id: 'ignore', label: 'Не брать трубку', sub: 'Пени и суд',
        apply: function (s, a) { a.mood(s, -9, -7); a.credit(s, -30); a.defer(s, 5, { cash: -sum(s, 40000), label: 'Судебные издержки', type: 'bad' }); } }
    ]
  });

  ev('credit-holiday', {
    kind: 'offer', tags: ['credit', 'debt', 'mid', 'hard'], concept: 'restructure',
    shortTitle: 'Кредитные каникулы', title: 'Банк предлагает каникулы',
    text: 'Три месяца можно не платить. Проценты за эти месяцы никуда не денутся — их добавят к долгу.',
    choices: [
      { id: 'take', label: 'Взять каникулы', sub: 'Дышать легче, долг больше',
        apply: function (s, a) { s.debts.forEach(function (d) { d.balance = Math.round(d.balance * 1.07); }); a.mandatoryDelta(s, 0); var total = 0; s.debts.forEach(function (d) { total += d.payment; d.payment = 0; }); a.defer(s, 3, { label: 'Каникулы закончились', effect: function (s2) { s2.debts.forEach(function (d) { if (!d.payment && d.months > 0) d.payment = Math.round(d.balance / Math.max(1, d.months)); }); } }); a.mood(s, 7, 2); a.learn(s, 'annuity'); } },
      { id: 'part', label: 'Платить только проценты', sub: 'Долг не растёт, но и не тает',
        apply: function (s, a) { s.debts.forEach(function (d) { d.payment = Math.round(d.balance * d.monthlyRate) + 1; }); a.mood(s, 4, 1); a.defer(s, 4, { label: 'Вернулись к обычному платежу', effect: function (s2) { s2.debts.forEach(function (d) { d.payment = Math.round(d.balance / Math.max(1, d.months)) + Math.round(d.balance * d.monthlyRate); }); } }); } },
      { id: 'no', label: 'Платить как платили', sub: 'Дороже сейчас, дешевле в сумме',
        apply: function (s, a) { a.mood(s, -2, -1); a.credit(s, 6); a.learn(s, 'avalanche'); } }
    ]
  });

  /* Работа и карьера */

  ev('career-relocate-offer', {
    kind: 'opportunity', tags: ['career', 'income', 'housing', 'mid', 'hard'], concept: 'optionality',
    shortTitle: 'Оффер с переездом', title: 'Работа мечты в другом городе',
    text: 'Доход выше на 40%, но там всё дороже, а здесь остаются друзья и родня.',
    choices: [
      { id: 'go', label: 'Переехать', sub: '+40% дохода, +{18000} ₽/мес расходов',
        apply: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.40)); a.mandatoryDelta(s, sum(s, 18000)); a.spend(s, sum(s, 90000), 'Переезд', 'shocks'); a.trust(s, -9); a.mood(s, 2, 2); a.energy(s, -10); } },
      { id: 'remote', label: 'Попроситься на удалёнку', sub: 'Шанс 40%', concept: 'negotiation',
        apply: function (s, a) { a.gamble(s, 'relocate-remote', [
          { p: .40, label: 'Согласовали удалённо: +28% дохода', good: true, effect: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.28)); a.mood(s, 11, 6); } },
          { p: .60, label: 'Только очно — отказались', effect: function (s, a) { a.mood(s, -4, -1); } }
        ]); } },
      { id: 'stay', label: 'Остаться', sub: 'Всё как есть',
        apply: function (s, a) { a.trust(s, 4); a.mood(s, 1, 3); } }
    ]
  });

  ev('career-own-business', {
    kind: 'opportunity', tags: ['career', 'risk', 'sidejob', 'mid', 'hard'], concept: 'ruin',
    shortTitle: 'Уйти в своё дело', title: 'Бросить работу ради своего дела',
    text: 'Есть клиенты на первые три месяца и накопления. Дальше — как пойдёт. Обратно в найм пускают, но не сразу и не на то же место.',
    choices: [
      { id: 'jump', label: 'Уйти сразу', sub: 'Дохода нет 2 месяца, потом как повезёт', concept: 'ruin',
        apply: function (s, a) { a.tempIncome(s, -Math.round(s.income * 0.85), 2, { label: 'Дело пошло' }); a.energy(s, -18); a.gamble(s, 'own-business', [
          { p: .34, label: 'Дело взлетело: доход вдвое', good: true, effect: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.9)); a.mood(s, 14, 10); } },
          { p: .40, label: 'Держится на уровне прежней работы', effect: function (s, a) { a.mood(s, 3, 5); } },
          { p: .26, label: 'Не пошло, пришлось вернуться в найм', bad: true, effect: function (s, a) { a.incomeDelta(s, -Math.round(s.income * 0.2)); a.mood(s, -12, -8); } }
        ]); } },
      { id: 'parallel', label: 'Вести параллельно полгода', sub: '−20 сил, зато без обрыва',
        apply: function (s, a) { a.energy(s, -20); a.tempIncome(s, sum(s, 22000), 6, { label: 'Проект закончился' }); a.mood(s, 0, -5); a.defer(s, 6, { income: sum(s, 18000), label: 'Дело выросло в основной доход', type: 'good' }); } },
      { id: 'no', label: 'Остаться в найме', sub: 'Скучно и предсказуемо',
        apply: function (s, a) { a.mood(s, 2, 0); a.energy(s, 5); } }
    ]
  });

  /* Доход */

  ev('income-bonus-choice', {
    kind: 'opportunity', tags: ['income', 'save', 'easy', 'mid'], concept: 'lifestyle',
    shortTitle: 'Годовая премия', title: 'Пришла годовая премия',
    text: 'Три оклада разом. Ощущается как «свободные деньги», хотя это просто зарплата за год, выданная одним куском.',
    choices: [
      { id: 'reserve', label: 'В резерв целиком', sub: 'Подушка вырастет заметно',
        apply: function (s, a) { var b = Math.round(s.income * 3); a.earn(s, b, 'Годовая премия'); a.toReserve(s, b); a.mood(s, 6, 0); a.learn(s, 'reserve'); } },
      { id: 'split', label: 'Половину отложить, половину прожить', sub: 'Компромисс',
        apply: function (s, a) { var b = Math.round(s.income * 3); a.earn(s, b, 'Годовая премия'); a.toReserve(s, Math.round(b / 2)); a.mood(s, 4, 7); } },
      { id: 'spend', label: 'Потратить', sub: 'Ощущение праздника',
        apply: function (s, a) { var b = Math.round(s.income * 3); a.earn(s, b, 'Годовая премия'); a.spend(s, b, 'Потрачена премия', 'fun'); a.mood(s, 3, 13); a.learn(s, 'lifestyle'); } }
    ]
  });

  ev('income-freelance-big', {
    kind: 'opportunity', tags: ['income', 'sidejob', 'mid', 'hard'], concept: 'energy',
    shortTitle: 'Крупный заказ', title: 'Большой заказ на два месяца',
    text: '{190000} ₽ за два месяца работы по выходным. Заказчик новый, предоплата — треть.',
    choices: [
      { id: 'take', label: 'Взяться', sub: '+{190000} ₽, −26 сил',
        apply: function (s, a) { a.earn(s, sum(s, 63000), 'Предоплата'); a.energy(s, -26); a.gamble(s, 'freelance-big', [
          { p: .70, label: 'Заказчик расплатился полностью', good: true, effect: function (s, a) { a.defer(s, 2, { cash: sum(s, 127000), label: 'Остаток по заказу', type: 'good' }); } },
          { p: .30, label: 'Заказчик пропал с остатком', bad: true, effect: function (s, a) { a.mood(s, -10, -4); } }
        ]); } },
      { id: 'prepay', label: 'Согласиться только на полную предоплату', sub: 'Шанс 45%, что согласятся', concept: 'negotiation',
        apply: function (s, a) { a.gamble(s, 'freelance-prepay', [
          { p: .45, label: 'Согласились на предоплату', good: true, effect: function (s, a) { a.earn(s, sum(s, 190000), 'Заказ оплачен вперёд'); a.energy(s, -26); a.mood(s, 8, 2); } },
          { p: .55, label: 'Заказчик ушёл к другому', effect: function (s, a) { a.mood(s, -3, 0); } }
        ]); } },
      { id: 'no', label: 'Отказаться', sub: 'Выходные останутся вашими',
        apply: function (s, a) { a.energy(s, 6); a.mood(s, 1, 3); } }
    ]
  });

  ev('income-indexation', {
    kind: 'quiet', tags: ['income', 'easy', 'mid', 'hard'], concept: 'inflation',
    shortTitle: 'Индексация', title: 'Зарплату проиндексировали на 4%',
    text: 'Цены за тот же год выросли сильнее. Формально прибавка, фактически — минус.',
    choices: [
      { id: 'accept', label: 'Принять как есть', sub: '+4% к доходу',
        apply: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.04)); a.learn(s, 'inflation'); a.mood(s, 1, 0); } },
      { id: 'ask', label: 'Пойти к руководителю с цифрами', sub: 'Шанс 44% на реальную прибавку', concept: 'negotiation',
        apply: function (s, a) { a.energy(s, -6); a.gamble(s, 'indexation-ask', [
          { p: .44, label: 'Пересмотрели: +13%', good: true, effect: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.13)); a.mood(s, 9, 3); } },
          { p: .56, label: 'Оставили как есть', effect: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.04)); a.mood(s, -3, -1); } }
        ]); } },
      { id: 'look', label: 'Начать искать другое место', sub: '−10 сил, оффер через полгода',
        apply: function (s, a) { a.incomeDelta(s, Math.round(s.income * 0.04)); a.energy(s, -10); a.defer(s, 6, { income: Math.round(s.income * 0.16), label: 'Перешли на новое место', type: 'good' }); } }
    ]
  });

  /* Общество */

  ev('social-friend-wedding-far', {
    kind: 'social', tags: ['social', 'easy', 'mid'], concept: 'social',
    shortTitle: 'Свадьба далеко', title: 'Свадьба друга в другом городе',
    text: 'Дорога, гостиница и подарок — {54000} ₽. Друг зовёт третий раз и явно ждёт.',
    choices: [
      { id: 'go', label: 'Поехать', sub: '{54000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 54000), 'Поездка на свадьбу', 'fun'); a.trust(s, 8); a.mood(s, 4, 8); } },
      { id: 'gift', label: 'Не ехать, но прислать подарок', sub: '{15000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 15000), 'Подарок', 'fun'); a.trust(s, 2); a.mood(s, 0, 1); } },
      { id: 'no', label: 'Честно сказать, что не тянете', sub: '0 ₽',
        apply: function (s, a) { a.trust(s, -4); a.mood(s, -2, -2); a.learn(s, 'social'); } }
    ]
  });

  ev('social-status-pressure', {
    kind: 'temptation', tags: ['social', 'bigbuy', 'easy', 'mid', 'hard'], concept: 'social',
    shortTitle: 'Как у всех', title: 'У всех в компании телефон новее',
    text: 'Никто ничего не говорит. Просто каждый раз, доставая свой, вы про это думаете.',
    choices: [
      { id: 'buy', label: 'Купить новый', sub: '{96000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 96000), 'Новый телефон', 'fun'); a.mood(s, 3, 8); a.learn(s, 'social'); a.defer(s, 6, { quality: -6, label: 'Ощущение новизны прошло' }); } },
      { id: 'used', label: 'Взять прошлогодний', sub: '{42000} ₽',
        apply: function (s, a) { a.spend(s, sum(s, 42000), 'Телефон прошлого года', 'fun'); a.mood(s, 3, 5); } },
      { id: 'no', label: 'Оставить свой', sub: '0 ₽',
        apply: function (s, a) { a.mood(s, 2, -2); a.learn(s, 'social'); } }
    ]
  });



  /*
   *  СОРЕВНОВАТЕЛЬНЫЙ СЦЕНАРИЙ «НАСЛЕДСТВО»
   *
   *  Эти события живут только в одном сценарии и никогда не попадают
   *  в общий пул: у них нет тегов, зато есть общая линия. Почти каждое
   *  зависит от того, что игрок решил раньше, — поэтому одинаковых
   *  партий здесь не бывает, а сравнивать результаты честно: события,
   *  их порядок и все жеребьёвки у всех игроков одни и те же.
   */

  ev('cup-inherit', {
    kind: 'offer', cup: true, concept: 'cashflow',
    shortTitle: 'Наследство', title: 'Наследство: квартира и чужой долг',
    text: 'Умер двоюродный дед. По завещанию вам достаётся его однокомнатная квартира в соседнем городе — примерно {900000} ₽, если продавать не спеша. Вместе с ней переходит и его кредит: {340000} ₽. Принять только квартиру нельзя: наследство принимается целиком.',
    forecast: {
      question: 'Сколько, по-вашему, останется от наследства после долга?',
      max: function (E, s) { return sum(s, 900000); }, step: 10000,
      actual: function (E, s) { return sum(s, 900000) - sum(s, 340000); },
      reveal: function (E, s) {
        return 'Наследство — это активы минус долги: ' + money(sum(s, 900000)) + ' − ' +
          money(sum(s, 340000)) + '. Но разница лежит не в кошельке, а в стенах: платить по кредиту нужно каждый месяц, а квартира продастся неизвестно когда.';
      }
    },
    choices: [
      { id: 'take', label: 'Принять наследство', sub: 'Квартира ваша — и долг тоже',
        apply: function (s, a) {
          a.addAsset(s, { id: 'flat', label: 'Квартира в наследство', value: sum(s, 900000), annualRate: .01, kind: 'locked' });
          a.addDebt(s, { id: 'heir', label: 'Кредит наследодателя', principal: sum(s, 340000), monthlyRate: .019, months: 42 });
          a.mandatoryDelta(s, sum(s, 2600));
          a.flag(s, 'flat', 'own');
          a.note(s, 'Квартира и коммунальные платежи приняты', 0, 'info');
          a.mood(s, -4, 6);
        } },
      { id: 'sell', label: 'Принять и сразу выставить на продажу', sub: 'Быстрее деньги, дешевле цена',
        apply: function (s, a) {
          a.addAsset(s, { id: 'flat', label: 'Квартира (в продаже)', value: sum(s, 900000), annualRate: .01, kind: 'locked' });
          a.addDebt(s, { id: 'heir', label: 'Кредит наследодателя', principal: sum(s, 340000), monthlyRate: .019, months: 42 });
          a.mandatoryDelta(s, sum(s, 2600));
          a.flag(s, 'flat', 'sale');
          a.energy(s, -6);
          a.schedule(s, 5, 'cup-sale-first');
          a.note(s, 'Объявление размещено', 0, 'info');
        } },
      { id: 'refuse', label: 'Отказаться от наследства', sub: 'Ни квартиры, ни долга',
        apply: function (s, a) {
          a.flag(s, 'flat', 'no');
          a.mood(s, 6, -3);
          a.note(s, 'Отказ оформлен у нотариуса', 0, 'info');
          a.spend(s, sum(s, 6000), 'Нотариус', 'life');
        } }
    ]
  });

  ev('cup-job-fork', {
    kind: 'offer', cup: true, concept: 'optionality',
    shortTitle: 'Развилка на работе', title: 'Отдел закрывают: куда переходить',
    text: 'Ваш отдел расформировали, но увольнять никого не хотят. Предлагают три места, и выбрать надо сегодня.',
    choices: [
      { id: 'stable', label: 'Тихий отдел', sub: 'Минус {4000} ₽ к доходу, зато предсказуемо',
        apply: function (s, a) { a.incomeDelta(s, -sum(s, 4000)); a.mood(s, 8, 0); a.energy(s, 8); a.flag(s, 'track', 'stable'); } },
      { id: 'project', label: 'Проектная команда', sub: 'Плюс {14000} ₽, но премия зависит от результата',
        apply: function (s, a) { a.incomeDelta(s, sum(s, 14000)); a.energy(s, -10); a.mood(s, -5, 2); a.flag(s, 'track', 'project'); a.schedule(s, 8, 'cup-project-review'); } },
      { id: 'free', label: 'Уйти на вольные хлеба', sub: 'Доход скачет, потолка нет',
        apply: function (s, a) { a.incomeDelta(s, -sum(s, 10000)); a.flag(s, 'track', 'free'); a.mood(s, -6, 5); a.energy(s, -4); a.schedule(s, 6, 'cup-freelance-wave'); a.note(s, 'Трудовой договор расторгнут', 0, 'info'); } }
    ]
  });

  ev('cup-project-review', {
    kind: 'opportunity', cup: true,
    requires: function (s) { return s.flags.track === 'project'; },
    shortTitle: 'Итоги проекта', title: 'Проект сдан. Что с премией',
    text: 'Проект закрыт в срок. Премию обещали «по результату» — и теперь предлагают выбрать форму.',
    choices: [
      { id: 'cash', label: 'Забрать деньгами', sub: 'Разово {90000} ₽',
        apply: function (s, a) { a.earn(s, sum(s, 90000), 'Премия за проект'); a.mood(s, 6, 2); } },
      { id: 'share', label: 'Взять долей в следующем проекте', sub: 'Может выйти вдвое больше, может ноль',
        apply: function (s, a) {
          a.flag(s, 'project_share');
          a.gamble(s, 'cup-project-share', [
            { p: .45, label: 'Следующий проект выстрелил', good: true,
              effect: function (s2, a2) { a2.defer(s2, 6, { cash: sum(s2, 210000), label: 'Доля в проекте выплачена', type: 'good', calm: 8 }); } },
            { p: .55, label: 'Проект свернули, доля обесценилась', bad: true,
              effect: function (s2, a2) { a2.mood(s2, -10, -3); a2.energy(s2, -6); } }
          ]);
        } },
      { id: 'time', label: 'Взять отгулами', sub: 'Денег нет, зато вы живой',
        apply: function (s, a) { a.energy(s, 20); a.mood(s, 10, 6); } }
    ]
  });

  ev('cup-freelance-wave', {
    kind: 'shock', cup: true,
    requires: function (s) { return s.flags.track === 'free'; },
    shortTitle: 'Волна заказов', title: 'Заказов больше, чем рук',
    text: 'Пришло сразу три заказа. Взять все — значит месяц без выходных; взять один — оставить деньги на столе.',
    choices: [
      { id: 'all', label: 'Взять все три', sub: '+{120000} ₽ за два месяца',
        apply: function (s, a) { a.tempIncome(s, sum(s, 60000), 2); a.energy(s, -24); a.mood(s, -8, -6); a.defer(s, 3, { label: 'Выгорание после трёх заказов', calm: -8, energy: -10, type: 'bad' }); } },
      { id: 'two', label: 'Взять два', sub: '+{70000} ₽ за два месяца',
        apply: function (s, a) { a.tempIncome(s, sum(s, 35000), 2); a.energy(s, -12); } },
      { id: 'one', label: 'Взять один и выспаться', sub: '+{30000} ₽',
        apply: function (s, a) { a.tempIncome(s, sum(s, 30000), 1); a.energy(s, 6); a.mood(s, 5, 3); } }
    ]
  });

  ev('cup-collector', {
    kind: 'shock', cup: true, lesson: true, concept: 'late',
    requires: function (s) { return s.flags.flat && s.flags.flat !== 'no'; },
    shortTitle: 'Требование по долгу', title: 'Письмо: требуют вернуть долг деда',
    text: 'Приходит требование на {410000} ₽ — это больше, чем сам кредит. Разницу называют «расходами на взыскание», но расчёта не прилагают.',
    choices: [
      { id: 'pay', label: 'Заплатить сколько требуют', sub: 'Лишь бы отстали',
        apply: function (s, a) { var x = Math.min(Math.max(0, s.cash + s.reserve), sum(s, 70000)); a.spend(s, x, 'Платёж по требованию', 'debtService'); a.mood(s, -6, -3); a.note(s, 'Расчёт так и не показали', 0, 'bad'); } },
      { id: 'check', label: 'Запросить расчёт и оспорить лишнее', sub: 'Месяц переписки',
        apply: function (s, a) {
          a.energy(s, -8); a.flag(s, 'disputed');
          a.note(s, 'Запрошен расчёт долга', 0, 'info');
          a.defer(s, 2, { label: 'Лишние начисления сняли', calm: 8, type: 'good',
            effect: function (s2) { s2.debts.forEach(function (d) { if (d.id === 'heir') d.balance *= 0.86; }); } });
        } },
      { id: 'ignore', label: 'Не отвечать', sub: 'Может, само рассосётся',
        apply: function (s, a) { a.credit(s, -40); s.stats.late++; a.mood(s, -10, -4); a.schedule(s, 4, 'cup-court'); a.note(s, 'Молчание зафиксировано как отказ платить', 0, 'bad'); } }
    ]
  });

  ev('cup-repair', {
    kind: 'temptation', cup: true, concept: 'sunk',
    requires: function (s) { return s.flags.flat === 'own' || s.flags.flat === 'sale'; },
    shortTitle: 'Ремонт', title: 'Квартиру надо приводить в порядок',
    text: 'Без ремонта её не сдать и не продать за нормальные деньги. Полная смета — {180000} ₽. Косметика своими руками — {55000} ₽ и месяц выходных.',
    choices: [
      { id: 'full', label: 'Полный ремонт по смете', sub: '{180000} ₽ сейчас',
        apply: function (s, a) {
          var need = sum(s, 180000);
          var got = Math.min(Math.max(0, s.cash + s.reserve), need);
          a.spend(s, got, 'Ремонт квартиры', 'life');
          if (got < need) { a.addDebt(s, { id: 'repair', label: 'Кредит на ремонт', principal: need - got, baseAnnualRate: .24, months: 24, annualRate: .24 }); }
          a.flag(s, 'repair', 'full'); a.energy(s, -10); a.mood(s, -4, 6);
          s.assets.forEach(function (x) { if (x.id === 'flat') x.value = Math.round(x.value * 1.12); });
        } },
      { id: 'light', label: 'Косметика своими руками', sub: '{55000} ₽ и ваши выходные',
        apply: function (s, a) { a.spend(s, sum(s, 55000), 'Косметический ремонт', 'life'); a.flag(s, 'repair', 'light'); a.energy(s, -18); a.mood(s, -6, 2);
          s.assets.forEach(function (x) { if (x.id === 'flat') x.value = Math.round(x.value * 1.04); }); } },
      { id: 'none', label: 'Оставить как есть', sub: 'Дешевле сейчас, дешевле и потом',
        apply: function (s, a) { a.flag(s, 'repair', 'none'); a.mood(s, 2, -4); } }
    ]
  });

  ev('cup-tenant', {
    kind: 'offer', cup: true, concept: 'cashflow',
    requires: function (s) { return s.flags.flat === 'own'; },
    shortTitle: 'Жильцы', title: 'Кого пускать в квартиру',
    text: 'Откликнулись двое. Семья с ребёнком готова платить {24000} ₽ и жить долго. Компания студентов даёт {32000} ₽, но их четверо и ремонт им не жалко.',
    choices: [
      { id: 'family', label: 'Пустить семью', sub: '+{24000} ₽ каждый месяц',
        apply: function (s, a) { a.incomeDelta(s, sum(s, 24000)); a.flag(s, 'tenant', 'family'); a.mood(s, 5, 2); } },
      { id: 'students', label: 'Пустить студентов', sub: '+{32000} ₽ и риск',
        apply: function (s, a) { a.incomeDelta(s, sum(s, 32000)); a.flag(s, 'tenant', 'students'); a.mood(s, 2, 1); a.schedule(s, 7, 'cup-tenant-trouble'); } },
      { id: 'no', label: 'Не сдавать', sub: 'Пусть стоит пустая',
        apply: function (s, a) { a.flag(s, 'tenant', 'no'); a.mood(s, 3, 0); a.note(s, 'Квартира стоит пустой и всё равно требует платежей', 0, 'info'); } }
    ]
  });

  ev('cup-tenant-trouble', {
    kind: 'shock', cup: true,
    requires: function (s) { return s.flags.tenant === 'students'; },
    shortTitle: 'Жильцы не платят', title: 'Второй месяц без оплаты',
    text: 'Жильцы перестали платить и не выходят на связь. Договор есть, но выселять — время и нервы.',
    choices: [
      { id: 'court', label: 'Выселять через договор и суд', sub: 'Долго, но по правилам',
        apply: function (s, a) { a.incomeDelta(s, -sum(s, 32000)); a.energy(s, -12); a.spend(s, sum(s, 12000), 'Юрист по выселению', 'life'); a.mood(s, -6, -2);
          a.defer(s, 3, { label: 'Квартира освобождена, нашли новых жильцов', calm: 6, type: 'good',
            effect: function (s2, a2) { a2.incomeDelta(s2, sum(s2, 22000)); } }); } },
      { id: 'deal', label: 'Договориться на меньшую плату', sub: 'Пусть платят {18000} ₽, но платят',
        apply: function (s, a) { a.incomeDelta(s, -sum(s, 14000)); a.mood(s, -2, 0); a.flag(s, 'tenant', 'family'); } },
      { id: 'wait', label: 'Подождать ещё месяц', sub: 'Вдруг заплатят',
        apply: function (s, a) { a.incomeDelta(s, -sum(s, 32000)); a.mood(s, -8, -3);
          a.defer(s, 2, { label: 'Жильцы съехали, оставив долг и разбитую дверь', calm: -8, type: 'bad',
            effect: function (s2, a2) { a2.spend(s2, sum(s2, 26000), 'Ремонт после жильцов', 'shocks'); a2.flag(s2, 'tenant', 'no'); } }); } }
    ]
  });

  ev('cup-warranty', {
    kind: 'temptation', cup: true, concept: 'warranty',
    shortTitle: 'Допы на кассе', title: 'Техника и «расширенная гарантия»',
    text: 'В квартиру нужна стиральная машина за {38000} ₽. На кассе предлагают расширенную гарантию на три года — ещё {7000} ₽ — и «страховку от протечки» за {4000} ₽.',
    choices: [
      { id: 'all', label: 'Взять всё', sub: '{49000} ₽ и спокойствие',
        apply: function (s, a) { a.spend(s, sum(s, 49000), 'Техника с допами', 'life'); a.flag(s, 'warranty'); a.mood(s, 3, 3); } },
      { id: 'plain', label: 'Только машину', sub: '{38000} ₽, гарантия завода два года',
        apply: function (s, a) { a.spend(s, sum(s, 38000), 'Стиральная машина', 'life'); a.mood(s, 1, 3); } },
      { id: 'used', label: 'Купить б/у за {14000} ₽', sub: 'Как повезёт',
        apply: function (s, a) { a.spend(s, sum(s, 14000), 'Машина б/у', 'life'); a.gamble(s, 'cup-washer', [
          { p: .55, label: 'Б/у машина работает', good: true, effect: function (s2, a2) { a2.mood(s2, 3, 1); } },
          { p: .45, label: 'Машина потекла и залила соседей', bad: true,
            effect: function (s2, a2) { a2.spend(s2, sum(s2, 42000), 'Залив соседей', 'shocks'); a2.mood(s2, -12, -5); } }
        ]); } }
    ]
  });

  ev('cup-lawyer', {
    kind: 'offer', cup: true,
    requires: function (s, E) { return E.debtBalanceTotal(s) > 0 && s.flags.flat !== 'no'; },
    shortTitle: 'Юрист', title: 'Юрист по наследственным долгам',
    text: 'Юрист берётся снять часть требований. Фиксированная цена — {40000} ₽ вперёд. Или «процент от успеха» — {90000} ₽, но только если выиграет.',
    choices: [
      { id: 'fix', label: 'Фиксированная цена', sub: '{40000} ₽ вперёд',
        apply: function (s, a) { a.spend(s, sum(s, 40000), 'Юрист (фикс)', 'life'); a.flag(s, 'lawyer', 'fix'); a.mood(s, 3, 0); } },
      { id: 'success', label: 'Процент от успеха', sub: 'Ноль сейчас, {90000} ₽ при победе',
        apply: function (s, a) { a.flag(s, 'lawyer', 'success'); a.mood(s, 2, 0); } },
      { id: 'self', label: 'Разбираться самому', sub: 'Бесплатно, но по вечерам',
        apply: function (s, a) { a.flag(s, 'lawyer', 'self'); a.energy(s, -14); a.mood(s, -4, -2); } }
    ]
  });

  ev('cup-court', {
    kind: 'shock', cup: true, concept: 'late',
    requires: function (s) { return s.flags.flat && s.flags.flat !== 'no'; },
    shortTitle: 'Суд', title: 'Заседание по долгу наследодателя',
    text: function (s) {
      return s.flags.lawyer
        ? 'Дело дошло до суда. Позиция готова: ' + (s.flags.lawyer === 'self' ? 'вы собрали документы сами.' : 'юрист собрал документы.')
        : 'Дело дошло до суда, а позиции у вас нет: документы никто не готовил.';
    },
    choices: [
      { id: 'fight', label: 'Идти и спорить', sub: 'Как подготовились, так и выйдет',
        apply: function (s, a) {
          var strong = !!s.flags.lawyer || !!s.flags.disputed;
          a.energy(s, -8);
          a.gamble(s, 'cup-court-roll', strong
            ? [{ p: .68, label: 'Суд снял часть требований', good: true,
                 effect: function (s2, a2) { s2.debts.forEach(function (d) { if (d.id === 'heir') d.balance *= 0.7; });
                   if (s2.flags.lawyer === 'success') a2.spend(s2, sum(s2, 90000), 'Гонорар юриста', 'life');
                   a2.mood(s2, 10, 2); } },
                { p: .32, label: 'Суд оставил долг как есть', bad: true, effect: function (s2, a2) { a2.mood(s2, -8, -2); } }]
            : [{ p: .25, label: 'Повезло: часть требований сняли', good: true,
                 effect: function (s2, a2) { s2.debts.forEach(function (d) { if (d.id === 'heir') d.balance *= 0.85; }); a2.mood(s2, 6, 1); } },
                { p: .75, label: 'Суд взыскал всё и добавил расходы', bad: true,
                 effect: function (s2, a2) { s2.debts.forEach(function (d) { if (d.id === 'heir') d.balance *= 1.12; }); a2.credit(s2, -30); a2.mood(s2, -12, -4); } }]);
        } },
      { id: 'settle', label: 'Заключить мировое', sub: 'Заплатить {150000} ₽ и закрыть тему',
        apply: function (s, a) {
          var need = sum(s, 150000);
          var got = Math.min(Math.max(0, s.cash + s.reserve), need);
          a.spend(s, got, 'Мировое соглашение', 'debtService');
          s.debts.forEach(function (d) { if (d.id === 'heir') d.balance = Math.max(0, d.balance - got * 1.6); });
          a.mood(s, 6, 0); a.note(s, 'Спор закрыт мировым соглашением', 0, 'info');
        } },
      { id: 'skip', label: 'Не ходить', sub: 'Решат без вас',
        apply: function (s, a) { s.debts.forEach(function (d) { if (d.id === 'heir') d.balance *= 1.18; }); a.credit(s, -45); s.stats.late++; a.mood(s, -14, -5); } }
    ]
  });

  ev('cup-tax', {
    kind: 'opportunity', cup: true, concept: 'tax',
    shortTitle: 'Налоги', title: 'Налог на имущество и забытый вычет',
    text: 'Пришёл налог на унаследованную квартиру — {9000} ₽ в год. Заодно выясняется, что за прошлые годы можно вернуть вычет за лечение — примерно {31000} ₽, но нужно собрать справки.',
    choices: [
      { id: 'both', label: 'Заплатить налог и подать на вычет', sub: 'Вечер на справки',
        apply: function (s, a) { a.spend(s, sum(s, 9000), 'Налог на имущество', 'life'); a.energy(s, -6);
          a.defer(s, 4, { cash: sum(s, 31000), label: 'Налоговый вычет вернулся', type: 'good', calm: 5 }); } },
      { id: 'tax', label: 'Только заплатить налог', sub: 'Справки — потом',
        apply: function (s, a) { a.spend(s, sum(s, 9000), 'Налог на имущество', 'life'); a.mood(s, 0, 0); } },
      { id: 'delay', label: 'Отложить и то, и другое', sub: 'Пени начнут капать',
        apply: function (s, a) { a.defer(s, 3, { cash: -sum(s, 14000), label: 'Налог с пенями списали', type: 'bad', calm: -6 }); } }
    ]
  });

  ev('cup-pension', {
    kind: 'offer', cup: true, concept: 'pension',
    shortTitle: 'Длинные деньги', title: 'Счёт, который нельзя трогать',
    text: 'На работе предлагают программу долгих накоплений: вы отправляете {6000} ₽ в месяц, работодатель добавляет половину. Забрать всё можно только через много лет — раньше только с потерей прибавки.',
    choices: [
      { id: 'in', label: 'Подключиться', sub: '{6000} ₽ в месяц, +50% сверху',
        apply: function (s, a) { a.addSub(s, 'Долгие накопления', sum(s, 6000)); a.flag(s, 'pension');
          a.addAsset(s, { id: 'pens', label: 'Долгий счёт', value: sum(s, 9000), annualRate: .11, kind: 'locked' });
          a.mood(s, 2, 0);
          a.defer(s, 24, { label: 'Долгий счёт заметно подрос', calm: 6, type: 'good',
            effect: function (s2) { s2.assets.forEach(function (x) { if (x.id === 'pens') x.value += sum(s2, 230000); }); } }); } },
      { id: 'half', label: 'Подключиться на минимум', sub: '{2500} ₽ в месяц',
        apply: function (s, a) { a.addSub(s, 'Долгие накопления', sum(s, 2500)); a.flag(s, 'pension');
          a.addAsset(s, { id: 'pens', label: 'Долгий счёт', value: sum(s, 4000), annualRate: .11, kind: 'locked' });
          a.defer(s, 24, { label: 'Долгий счёт подрос', calm: 3, type: 'good',
            effect: function (s2) { s2.assets.forEach(function (x) { if (x.id === 'pens') x.value += sum(s2, 95000); }); } }); } },
      { id: 'no', label: 'Отказаться', sub: 'Деньги нужны сейчас',
        apply: function (s, a) { a.mood(s, 1, 1); } }
    ]
  });

  ev('cup-offer-sell', {
    kind: 'offer', cup: true, concept: 'liquidity',
    requires: function (s) { return !!(s.flags.flat === 'own' || s.flags.flat === 'sale'); },
    shortTitle: 'Покупатель', title: 'Нашёлся покупатель на квартиру',
    text: 'Первый реальный покупатель. Готов взять сразу, но за {760000} ₽ — заметно ниже рынка. Или по рынку, {950000} ₽, но платежами в течение года и с распиской.',
    choices: [
      { id: 'now', label: 'Продать сразу дешевле', sub: '{760000} ₽ на счёт в этом месяце',
        apply: function (s, a) {
          s.assets = s.assets.filter(function (x) { return x.id !== 'flat'; });
          a.earn(s, sum(s, 760000), 'Продажа квартиры');
          a.mandatoryDelta(s, -sum(s, 2600));
          if (s.flags.tenant && s.flags.tenant !== 'no') a.incomeDelta(s, -sum(s, s.flags.tenant === 'students' ? 32000 : 24000));
          a.flag(s, 'flat', 'sold'); a.flag(s, 'tenant', 'no'); a.mood(s, 6, -2);
        } },
      { id: 'parts', label: 'Продать в рассрочку по рынку', sub: '{950000} ₽ частями за год',
        apply: function (s, a) {
          s.assets = s.assets.filter(function (x) { return x.id !== 'flat'; });
          a.mandatoryDelta(s, -sum(s, 2600));
          if (s.flags.tenant && s.flags.tenant !== 'no') a.incomeDelta(s, -sum(s, s.flags.tenant === 'students' ? 32000 : 24000));
          a.flag(s, 'flat', 'sold'); a.flag(s, 'tenant', 'no');
          a.tempIncome(s, sum(s, 62000), 12);
          a.gamble(s, 'cup-sell-parts', [
            { p: .7, label: 'Покупатель платит вовремя', good: true, effect: function (s2, a2) { a2.mood(s2, 4, 0); } },
            { p: .3, label: 'Покупатель пропал на полпути', bad: true,
              effect: function (s2, a2) { a2.incomeDelta(s2, -sum(s2, 62000)); a2.mood(s2, -12, -4); a2.note(s2, 'Остаток придётся выбивать', 0, 'bad'); } }
          ], 'parts');
        } },
      { id: 'keep', label: 'Не продавать', sub: 'Пусть стоит и приносит аренду',
        apply: function (s, a) { a.mood(s, 2, 2); a.flag(s, 'kept_flat'); } }
    ]
  });

  ev('cup-sale-first', {
    kind: 'quiet', cup: true,
    requires: function (s) { return s.flags.flat === 'sale'; },
    shortTitle: 'Первый показ', title: 'Первый покупатель торгуется',
    text: 'Пришли смотреть. Предлагают {620000} ₽ — сразу и наличными, «чтобы не тянуть».',
    choices: [
      { id: 'yes', label: 'Согласиться', sub: 'Быстро и дёшево',
        apply: function (s, a) {
          s.assets = s.assets.filter(function (x) { return x.id !== 'flat'; });
          a.earn(s, sum(s, 620000), 'Быстрая продажа квартиры');
          a.mandatoryDelta(s, -sum(s, 2600));
          a.flag(s, 'flat', 'sold'); a.mood(s, 2, -4);
        } },
      { id: 'no', label: 'Отказать и ждать нормальную цену', sub: 'Платежи идут дальше',
        apply: function (s, a) { a.mood(s, -2, 0); a.flag(s, 'flat', 'own'); a.note(s, 'Ждём покупателя по рынку', 0, 'info'); } }
    ]
  });

  ev('cup-bankrupt', {
    kind: 'shock', cup: true, concept: 'bankruptcy',
    requires: function (s, E) { return E.debtBalanceTotal(s) > sum(s, 260000); },
    shortTitle: 'Мысль о банкротстве', title: 'Долг больше, чем видно выхода',
    text: 'Долг не уменьшается, платежи съедают месяц. Знакомый советует «списать всё через банкротство»: процедура стоит около {90000} ₽, тянется больше года и закрывает дорогу к кредитам на пять лет.',
    choices: [
      { id: 'go', label: 'Начать процедуру', sub: 'Дорого, долго, но долгов не будет',
        apply: function (s, a) {
          var fee = Math.min(Math.max(0, s.cash + s.reserve), sum(s, 90000));
          a.spend(s, fee, 'Процедура банкротства', 'life');
          a.flag(s, 'bankrupt');
          a.defer(s, 12, { label: 'Долги списаны по итогам процедуры', calm: 14, type: 'good',
            effect: function (s2) { s2.debts.forEach(function (d) { d.balance = 0; d.payment = 0; }); } });
          a.credit(s, -120); a.mood(s, -6, -4);
        } },
      { id: 'talk', label: 'Пойти в банк и просить реструктуризацию', sub: 'Платёж ниже, срок длиннее',
        concept: 'restructure',
        apply: function (s, a) { s.debts.forEach(function (d) { d.payment *= .6; d.months += 18; }); a.credit(s, -10); a.mood(s, 6, 1); a.energy(s, -4); } },
      { id: 'push', label: 'Не сдаваться и давить долг', sub: 'Платить больше, жить теснее',
        apply: function (s, a) { s.debts.forEach(function (d) { d.payment *= 1.3; }); a.mood(s, -8, -8); a.energy(s, -8); a.flag(s, 'aggressive_debt'); } }
    ]
  });

  ev('cup-auction', {
    kind: 'temptation', cup: true, concept: 'expected',
    shortTitle: 'Торги', title: 'Гараж с торгов',
    text: 'Рядом с квартирой продают гараж с торгов. Реальная цена — около {260000} ₽. Ставка делается вслепую: выигрывает наибольшая, и назад её не берут.',
    choices: [
      { id: 'high', label: 'Поставить {240000} ₽', sub: 'Почти наверняка выиграете',
        apply: function (s, a) { var bid = sum(s, 240000);
          a.gamble(s, 'cup-auction', [
            { p: .8, label: 'Ставка выиграла: гараж ваш', good: true,
              effect: function (s2, a2) { var got = Math.min(Math.max(0, s2.cash + s2.reserve), bid); a2.spend(s2, got, 'Гараж с торгов', 'invested');
                a2.addAsset(s2, { id: 'garage', label: 'Гараж', value: sum(s2, 260000), annualRate: .02, kind: 'locked' });
                a2.incomeDelta(s2, sum(s2, 5000)); } },
            { p: .2, label: 'Кто-то поставил больше', effect: function (s2, a2) { a2.mood(s2, -3, 0); } }
          ], 'high'); } },
      { id: 'low', label: 'Поставить {170000} ₽', sub: 'Дёшево, но вряд ли',
        apply: function (s, a) { var bid = sum(s, 170000);
          a.gamble(s, 'cup-auction', [
            { p: .3, label: 'Неожиданно выиграли: гараж за бесценок', good: true,
              effect: function (s2, a2) { var got = Math.min(Math.max(0, s2.cash + s2.reserve), bid); a2.spend(s2, got, 'Гараж с торгов', 'invested');
                a2.addAsset(s2, { id: 'garage', label: 'Гараж', value: sum(s2, 260000), annualRate: .02, kind: 'locked' });
                a2.incomeDelta(s2, sum(s2, 5000)); } },
            { p: .7, label: 'Ставка не прошла', effect: function (s2, a2) { a2.mood(s2, -1, 0); } }
          ], 'low'); } },
      { id: 'skip', label: 'Не участвовать', sub: 'Деньги нужнее в резерве',
        apply: function (s, a) { a.mood(s, 2, 0); } }
    ]
  });

  ev('cup-final', {
    kind: 'offer', cup: true, concept: 'optionality',
    shortTitle: 'Последний ход', title: 'Пять лет почти прошли',
    text: 'Осталось несколько месяцев. Можно закрыть остатки долгов и выйти чистым, можно вложить свободное и рискнуть, а можно наконец потратить на себя — впервые за пять лет.',
    choices: [
      { id: 'clean', label: 'Закрыть долги', needs: 'debt',
        sub: function (s, E) { return 'Спокойный финиш: осталось ' + money(E.debtBalanceTotal(s)); },
        apply: function (s, a) { var pay = Math.max(0, s.cash - sum(s, 20000)); if (pay > 0) a.repay(s, pay); a.mood(s, 10, 2); } },
      { id: 'invest', label: 'Вложить свободные деньги', sub: 'Может подрасти, может просесть',
        apply: function (s, a) { var x = Math.max(0, Math.min(s.cash - sum(s, 30000), sum(s, 200000)));
          if (x <= 0) { a.mood(s, -2, 0); a.note(s, 'Вкладывать оказалось нечего', 0, 'info'); return; }
          a.spend(s, x, 'Вложение перед финишем', 'invested');
          a.gamble(s, 'cup-final-invest', [
            { p: .5, label: 'Рынок подрос', good: true, effect: function (s2, a2) { a2.defer(s2, 3, { cash: Math.round(x * 1.28), label: 'Вложение закрыто с прибылью', type: 'good', calm: 6 }); } },
            { p: .5, label: 'Рынок просел', bad: true, effect: function (s2, a2) { a2.defer(s2, 3, { cash: Math.round(x * 0.82), label: 'Вложение закрыто в минус', type: 'bad', calm: -6 }); } }
          ]); } },
      { id: 'live', label: 'Потратить на себя', sub: '{120000} ₽ на то, что откладывали пять лет',
        apply: function (s, a) { var x = Math.min(Math.max(0, s.cash), sum(s, 120000)); a.spend(s, x, 'Наконец на себя', 'fun'); a.mood(s, 16, 18); a.energy(s, 14); } }
    ]
  });

  ['dental', 'appliance-break', 'wedding-invite', 'vacation', 'gym-health',
   'friend-loan', 'scam-bank-call', 'scam-fine', 'side-job', 'freelance',
   'raise-ask', 'promotion-load', 'subs-creep', 'buy-phone', 'health-signal',
   'daily-living-review', 'daily-savings-review', 'daily-transport', 'daily-clothes',
   'daily-friend-birthday', 'daily-utility-bill', 'daily-home-fix', 'daily-rest',
   'daily-insurance', 'daily-learning',
   'credit-offer-rate', 'credit-guarantor', 'credit-microloan',

   // Версия 3: бытовые ситуации. Их много намеренно — за пять лет
   // повторов почти не остаётся, и месяц перестаёт быть предсказуемым.
   'daily-tooth-check', 'daily-screen-crack', 'daily-fridge-noise', 'daily-pet-vet',
   'daily-glasses', 'daily-season-clothes', 'daily-energy-bill', 'daily-rent-raise',
   'daily-transport-pass', 'daily-delivery-habit', 'daily-marketplace', 'daily-bank-fee',
   'daily-medicine-course', 'daily-back-pain', 'daily-parents-meds', 'daily-colleague-loan',
   'daily-overtime-weekend', 'daily-tax-deduction', 'daily-cashback-card',
   'daily-subscription-audit', 'daily-work-laptop', 'daily-friend-trip',
   'daily-course-discount', 'daily-emergency-thought', 'daily-home-repair-small',
   'daily-neighbor-flood', 'daily-boss-hint', 'daily-new-job-offer',
   'daily-friend-business', 'daily-guarantor-ask', 'daily-card-fraud',
   'daily-used-car', 'daily-crypto-hype', 'daily-invest-regular'
  ].forEach(function (id) { if (POOL[id]) POOL[id].filler = true; });

  root.EventPool = POOL;
  if (typeof module !== 'undefined' && module.exports) module.exports = POOL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
