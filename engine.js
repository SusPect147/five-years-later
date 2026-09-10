/*
 * engine.js — детерминированный движок финансовой симуляции.
 *
 * Принципы:
 *  1. Никакой арифметики в UI. Все деньги считаются здесь.
 *  2. Функции расчётов — чистые. Их можно проверить тестами (см. engine.test.js).
 *  3. Симуляция воспроизводима: simulate(scenario, seed, choices) при одинаковых
 *     аргументах всегда даёт одинаковый результат. Именно это позволяет показать
 *     «альтернативную историю»: перепрогоняем тот же год с одним изменённым решением.
 *  4. Случайность ограничена ровно одним вызовом rnd() на месяц, и она НЕ зависит
 *     от выбора игрока. Иначе сравнение с альтернативной историей было бы нечестным.
 *
 * Работает и в браузере (globalThis.Engine), и в Node (module.exports).
 */
(function (root) {
  'use strict';

  /* Генератор псевдослучайных чисел (mulberry32) — воспроизводимый */

  function hashSeed(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Финансовая математика */

  var round2 = function (x) { return Math.round(x * 100) / 100; };

  /**
   * Аннуитетный платёж: одинаковая сумма каждый месяц.
   * P * i * (1+i)^n / ((1+i)^n - 1)
   */
  function annuityPayment(principal, monthlyRate, months) {
    if (!(months > 0)) throw new Error('annuityPayment: months must be > 0');
    if (principal <= 0) return 0;
    if (monthlyRate === 0) return principal / months;
    var q = Math.pow(1 + monthlyRate, months);
    return (principal * monthlyRate * q) / (q - 1);
  }

  /** Сколько всего будет отдано за весь срок. */
  function annuityTotal(principal, monthlyRate, months) {
    return annuityPayment(principal, monthlyRate, months) * months;
  }

  /** Переплата = отдано минус взято. */
  function annuityOverpay(principal, monthlyRate, months) {
    return annuityTotal(principal, monthlyRate, months) - principal;
  }

  /**
   * Обратная задача: известны сумма, платёж и срок — какая это реально ставка?
   * Нужна, чтобы показать «беспроцентную» рассрочку с наценкой в честных процентах.
   * Метод бисекции: annuityPayment монотонно растёт по ставке.
   */
  function impliedMonthlyRate(principal, payment, months) {
    if (!(months > 0)) throw new Error('impliedMonthlyRate: months must be > 0');
    if (payment * months <= principal) return 0;
    var lo = 0, hi = 1, k;
    for (k = 0; k < 100 && annuityPayment(principal, hi, months) < payment; k++) hi *= 2;
    for (k = 0; k < 200; k++) {
      var mid = (lo + hi) / 2;
      if (annuityPayment(principal, mid, months) < payment) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** Годовая ставка из месячной и наоборот — с учётом сложного процента. */
  function monthlyToAnnual(monthlyRate) { return Math.pow(1 + monthlyRate, 12) - 1; }
  function annualToMonthly(annualRate) { return Math.pow(1 + annualRate, 1 / 12) - 1; }

  /** Эффективная годовая ставка при m начислениях в год. */
  function effectiveAnnualRate(nominalAnnual, timesPerYear) {
    var m = timesPerYear || 1;
    return Math.pow(1 + nominalAnnual / m, m) - 1;
  }

  /** Сложный процент на разовый вклад. */
  function compound(principal, annualRate, years, timesPerYear) {
    var m = timesPerYear || 1;
    return principal * Math.pow(1 + annualRate / m, m * years);
  }

  /** Будущая стоимость регулярных взносов (взнос в конце периода). */
  function futureValueSeries(contribution, monthlyRate, months) {
    if (monthlyRate === 0) return contribution * months;
    return contribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  }

  /** Во что превратится сумма после инфляции — сколько она будет «стоить». */
  function realValue(nominal, inflationAnnual, years) {
    return nominal / Math.pow(1 + inflationAnnual, years);
  }

  /**
   * Один шаг амортизации долга.
   * Возвращает, сколько ушло на проценты, сколько на тело и новый остаток.
   */
  function amortizeStep(balance, monthlyRate, payment) {
    var interest = balance * monthlyRate;
    var due = Math.min(payment, balance + interest);
    var toPrincipal = due - interest;
    var rest = balance + interest - due;
    if (rest < 0.01) rest = 0;
    return { interest: interest, due: due, toPrincipal: toPrincipal, balance: rest, closed: rest === 0 };
  }

  /** Полный график платежей — используется в тестах и в разборах. */
  function amortizationSchedule(principal, monthlyRate, months) {
    var payment = annuityPayment(principal, monthlyRate, months);
    var balance = principal, rows = [], i;
    for (i = 0; i < months && balance > 0; i++) {
      var step = amortizeStep(balance, monthlyRate, payment);
      rows.push({ month: i, interest: step.interest, principal: step.toPrincipal, balance: step.balance });
      balance = step.balance;
    }
    return { payment: payment, rows: rows };
  }

  /* Состояние */

  var BASE = {
    CALM_START: 62,
    QUALITY_START: 55,
    ENERGY_START: 70,
    // Восстановление намеренно небольшое и убывающее: силы — дефицитный ресурс.
    // При большом регене «работай больше» снова становится бесплатным.
    ENERGY_REGEN: 7,
    OVERDRAFT_MONTHLY: 0.02,   // цена жизни в минусе
    // Инфляция: обязательные расходы и еда дорожают каждый месяц.
    // Без этого пять лет «стоят» столько же, сколько первый месяц,
    // и любая партия сводится к бесконечному накоплению.
    // Темп зависит от сложности: на первом уровне ошибки должны прощаться.
    INFLATION_MONTHLY: 0.0042,
    INFLATION_BY_LEVEL: { 1: 0.0026, 2: 0.0042, 3: 0.0058, 4: 0.0072, 5: 0.0038 },
    // Инфляция образа жизни: часть выросшего дохода уходит в быт.
    // Это не штраф, а модель того, что с ростом дохода растут и траты.
    LIFESTYLE_CREEP: 0.22,
    LIFESTYLE_BY_LEVEL: { 1: 0.14, 2: 0.22, 3: 0.28, 4: 0.34, 5: 0.20 },
    LATE_FEE_RATE: 0.01,       // штраф за пропущенный платёж
    LATE_FEE_MIN: 600,

    // Бытовые расходы: то, что не попадает ни в «обязательные», ни в еду —
    // одежда, кафе, транспорт сверх нормы, подарки, мелочи.
    // Считаются долей ДОХОДА, а не остатка. Это принципиально: без этой статьи
    // свободные деньги просто копились бы на счёте вечно, и любая трата
    // «возвращалась» за месяц-два сама собой. Именно из-за этого раньше
    // казалось, что после расходов денег становится больше.
    LIVING_SHARE: 0.10,
    LIVING_BY_LEVEL: { 1: 0.085, 2: 0.095, 3: 0.08, 4: 0.075, 5: 0.085 },

    // Кредитный рейтинг: от него зависит и ставка, и сам факт одобрения.
    CREDIT_START: 660,
    CREDIT_MIN: 300,
    CREDIT_MAX: 850,
    CREDIT_ON_TIME: 5,         // за месяц без просрочек
    CREDIT_LATE: 58,           // за каждую просрочку
    CREDIT_NEW_LOAN: 12,       // новый долг временно снижает рейтинг
    // Максимальная доля дохода, которую банк готов отдать под платежи.
    CREDIT_MAX_LOAD: 0.55,

    /*
     * Накопительный счёт
     * Раньше на месте счёта стоял «вклад» — бумага с нулевым колебанием
     * цены, которую можно было купить на бирже и держать. Получался
     * бесконечный безрисковый доход одним нажатием: покупаешь и забываешь.
     *
     * Счёт устроен как в банке и потому не даёт бесплатных денег:
     *  - процент начисляется на МИНИМАЛЬНЫЙ остаток за месяц, а не на
     *    остаток в момент начисления. Положить в конце месяца и получить
     *    процент за весь месяц нельзя;
     *  - повышенная ставка действует только на первые SAVINGS_CAP рублей
     *    и только если в этом месяце со счёта ничего не снимали;
     *  - всё, что сверх лимита, и весь остаток в месяц со снятием идут по
     *    базовой ставке, которая едва обгоняет инфляцию.
     * Отсюда и урок: доступность денег стоит доходности, и наоборот.
     */
    SAVINGS_BASE_ANNUAL: 0.055,
    SAVINGS_BOOST_ANNUAL: 0.12,
    SAVINGS_CAP: 300000
  };

  /*
   *  Кредитный рейтинг
   *
   *  Модель простая и честная: рейтинг — это память о том, как человек
   *  обращался с долгами. Он растёт медленно (месяцами аккуратных платежей)
   *  и падает мгновенно (одна просрочка стоит года хорошего поведения).
   *  Цена рейтинга выражается в ставке: это делает «плачу вовремя»
   *  не моральным правилом, а измеримой суммой денег.
   */

  var CREDIT_TIERS = [
    { min: 780, label: 'отличный',      adj: -0.05, limit: 6.0 },
    { min: 720, label: 'хороший',       adj: -0.02, limit: 4.5 },
    { min: 660, label: 'обычный',       adj: 0.00,  limit: 3.0 },
    { min: 600, label: 'ниже среднего', adj: 0.05,  limit: 1.8 },
    { min: 520, label: 'плохой',        adj: 0.11,  limit: 0.9 },
    { min: 0,   label: 'испорченный',   adj: 0.22,  limit: 0.0 }
  ];

  function creditTier(score) {
    for (var i = 0; i < CREDIT_TIERS.length; i++) {
      if (score >= CREDIT_TIERS[i].min) return CREDIT_TIERS[i];
    }
    return CREDIT_TIERS[CREDIT_TIERS.length - 1];
  }

  /** Ставка, которую банк реально даст при текущем рейтинге. */
  function creditRate(s, baseAnnual) {
    var r = baseAnnual + creditTier(s.creditScore).adj;
    return Math.max(0.03, r);
  }

  /** Сколько банк готов одолжить: и по рейтингу, и по нагрузке на бюджет. */
  function creditLimit(s) {
    var byScore = s.income * 12 * creditTier(s.creditScore).limit / 12 * 3;
    var room = s.income * BASE.CREDIT_MAX_LOAD - debtPaymentsTotal(s);
    if (room <= 0) return 0;
    // Грубая оценка: платёж ~4% от тела при типичном сроке 3 года.
    var byLoad = room / 0.04;
    return Math.max(0, Math.round(Math.min(byScore, byLoad) / 1000) * 1000);
  }

  /** Одобрит ли банк такую сумму. */
  function creditApproved(s, principal) {
    return principal > 0 && principal <= creditLimit(s);
  }

  function emptyFlows() {
    return {
      income: 0, mandatory: 0, food: 0, subs: 0, debtPaid: 0, interest: 0,
      fun: 0, shocks: 0, fees: 0, saved: 0, assetGrowth: 0, living: 0,
      borrowed: 0, invested: 0, feesOnDebt: 0,
      // Вложения: сколько ушло в бумаги, сколько вернулось при продаже
      // и сколько съели комиссии брокера.
      investSold: 0, tradeFees: 0
    };
  }

  /**
   * Жеребьёвка, привязанная к сценарию, seed и событию — но НЕ к выбору игрока.
   * Благодаря этому «повезло/не повезло» одинаково для всех вариантов одного
   * события, и альтернативная история сравнивает решения, а не удачу.
   */
  function drawFor(scenarioId, seed, eventId, salt) {
    var h = hashSeed(scenarioId + '#' + String(seed) + '#' + eventId + '#' + (salt || ''));
    return mulberry32(h)();
  }

  /*
   *  РЫНОК
   *
   *  Цена инструмента — чистая функция от (сценарий, seed, месяц).
   *  Она НЕ зависит от решений игрока: иначе альтернативная история
   *  сравнивала бы удачу, а не выбор, а «продать вовремя» превращалось
   *  бы в чтение мыслей движка.
   *
   *  Шаг цены логнормальный:
   *      p(m+1) = p(m) * exp(drift - vol^2/2 + vol * (rho*Zрынок + sqrt(1-rho^2)*Zбумаги))
   *
   *  Zрынок общий для всех бумаг — поэтому акции и крипта падают вместе,
   *  а вклад и золото ведут себя иначе. Это и есть диверсификация:
   *  она видна в цифрах, а не только в тексте карточки знаний.
   */

  var MARKET_REF = [];
  var priceCache = {};

  function setMarket(list) { MARKET_REF = list || []; priceCache = {}; }
  function marketList() { return MARKET_REF; }
  function instrument(id) {
    for (var i = 0; i < MARKET_REF.length; i++) if (MARKET_REF[i].id === id) return MARKET_REF[i];
    return null;
  }

  /** Стандартная нормальная величина из двух детерминированных розыгрышей. */
  function normalFor(scenarioId, seed, key) {
    var u1 = drawFor(scenarioId, seed, key, 'n1');
    var u2 = drawFor(scenarioId, seed, key, 'n2');
    if (u1 < 1e-9) u1 = 1e-9;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Ряд цен инструмента с месяца 0 по months включительно.
   * Кэшируется: цена нужна и графику, и портфелю, и каждому пересчёту партии.
   */
  function priceSeries(scenarioId, seed, instId, months) {
    var inst = instrument(instId);
    if (!inst) return [];
    var n = (months || 60) + 2;
    var key = scenarioId + '|' + String(seed) + '|' + instId + '|' + n;
    if (priceCache[key]) return priceCache[key];

    var vol = inst.vol || 0;
    var rho = inst.rho || 0;
    var drift = inst.drift || 0;
    var idio = Math.sqrt(Math.max(0, 1 - rho * rho));
    var out = [inst.price];
    var p = inst.price;
    for (var m = 1; m <= n; m++) {
      var zm = normalFor(scenarioId, seed, 'market-' + m);
      var zi = normalFor(scenarioId, seed, instId + '-' + m);
      var step = drift - vol * vol / 2 + vol * (rho * zm + idio * zi);
      p = p * Math.exp(step);
      // Цена не уходит в ноль совсем: обнулившийся актив ломает и проценты,
      // и деление при показе доходности.
      if (p < inst.price * 0.002) p = inst.price * 0.002;
      out.push(p);
    }
    priceCache[key] = out;
    return out;
  }

  function priceAt(scenarioId, seed, instId, month) {
    var series = priceSeries(scenarioId, seed, instId, Math.max(62, month + 2));
    if (!series.length) return 0;
    var i = Math.max(0, Math.min(series.length - 1, Math.round(month)));
    return series[i];
  }

  /** Цена для состояния партии: seed и сценарий берутся из самого состояния. */
  function price(s, instId, month) {
    return priceAt(s.scenarioId, s._seed, instId, month == null ? s.month : month);
  }

  var TRADE_FEE = 0.003;   // комиссия брокера, берётся и при покупке, и при продаже

  function holdingValue(s, h) {
    return h.units * price(s, h.instId);
  }

  function portfolioValue(s) {
    if (!s.portfolio || !s.portfolio.length) return 0;
    var sum = 0;
    for (var i = 0; i < s.portfolio.length; i++) sum += holdingValue(s, s.portfolio[i]);
    return sum;
  }

  function holdingOf(s, instId) {
    for (var i = 0; i < s.portfolio.length; i++) if (s.portfolio[i].instId === instId) return s.portfolio[i];
    return null;
  }

  /**
   * Покупка на сумму в рублях. Платим только наличными: покупать бумаги
   * из резерва или в минус нельзя — это отдельный урок, а не удобство.
   * Возвращает купленное количество (0, если сделка не состоялась).
   */
  function buyInstrument(s, instId, amount) {
    var inst = instrument(instId);
    if (!inst) return 0;
    amount = Math.floor(amount);
    if (amount < (inst.min || 1000)) return 0;
    if (amount > s.cash) return 0;
    var px = price(s, instId);
    if (!(px > 0)) return 0;
    var fee = Math.round(amount * TRADE_FEE);
    var net = amount - fee;
    var units = net / px;

    s.cash -= amount;
    s.flows.invested += amount;
    s.flows.tradeFees += fee;

    var h = holdingOf(s, instId);
    if (h) { h.units += units; h.cost += net; }
    else s.portfolio.push({ instId: instId, units: units, cost: net, since: s.month });

    s.stats.trades++;
    s.stats.invested += amount;
    api.note(s, 'Куплено: ' + inst.name, -amount, 'invest');
    return units;
  }

  /**
   * Продажа доли позиции (share от 0 до 1). Возвращает выручку.
   * Прибыль и убыток фиксируются здесь же: пока бумага не продана,
   * «плюс на экране» — не деньги.
   */
  function sellInstrument(s, instId, share) {
    var h = holdingOf(s, instId);
    if (!h) return 0;
    share = Math.max(0, Math.min(1, share == null ? 1 : share));
    if (share <= 0) return 0;
    var inst = instrument(instId);
    var px = price(s, instId);
    var units = h.units * share;
    var gross = units * px;
    var fee = Math.round(gross * TRADE_FEE);
    var net = Math.round(gross - fee);
    var costPart = h.cost * share;
    var pnl = net - costPart;

    h.units -= units;
    h.cost -= costPart;
    if (h.units <= 1e-9 || share >= 1) {
      s.portfolio = s.portfolio.filter(function (x) { return x !== h; });
    }

    s.cash += net;
    s.flows.investSold += net;
    s.flows.tradeFees += fee;
    s.stats.trades++;
    s.stats.realized += pnl;
    if (pnl >= 0) s.stats.tradeWins++; else s.stats.tradeLosses++;

    api.note(s, (pnl >= 0 ? 'Продано с прибылью: ' : 'Продано с убытком: ') +
      (inst ? inst.name : instId), net, pnl >= 0 ? 'good' : 'bad');
    return net;
  }

  /**
   * Перевод наличных в резерв. Резерв — это те же деньги, просто отложенные:
   * они не тратятся сами и считаются подушкой.
   */
  function moveToReserve(s, amount) {
    var real = Math.min(Math.floor(amount), Math.max(0, Math.floor(s.cash)));
    if (real <= 0) return 0;
    s.cash -= real;
    s.reserve += real;
    s.flows.saved += real;
    api.note(s, 'Переведено в резерв', -real, 'reserve');
    return real;
  }

  /**
   * Снятие из резерва обратно на счёт. Разрешено в любой момент: подушка,
   * которую нельзя тронуть, подушкой не является. Но «отложено в резерв»
   * в отчёте считается по итогу, а не по числу переводов туда-обратно.
   */
  function moveFromReserve(s, amount) {
    var real = Math.min(Math.floor(amount), Math.max(0, Math.floor(s.reserve)));
    if (real <= 0) return 0;
    s.reserve -= real;
    s.cash += real;
    s.flows.saved = Math.max(0, s.flows.saved - real);
    api.note(s, 'Снято из резерва', real, 'reserve');
    return real;
  }

  /* НАКОПИТЕЛЬНЫЙ СЧЁТ */

  function savingsOf(s) {
    // Старые сохранения и чужие состояния счёта не знают — заводим на месте.
    if (!s.savings) s.savings = { balance: 0, minMonth: 0, earned: 0, withdrew: false };
    return s.savings;
  }

  function savingsBalance(s) { return savingsOf(s).balance; }

  /** Ставки счёта в этом состоянии: обе годовые, лимит — в рублях. */
  function savingsRates(s) {
    return {
      base: BASE.SAVINGS_BASE_ANNUAL,
      boost: BASE.SAVINGS_BOOST_ANNUAL,
      cap: scaleAmount(s, BASE.SAVINGS_CAP),
      // Снятие в этом месяце уже случилось — повышенной ставки не будет.
      boosted: !savingsOf(s).withdrew
    };
  }

  function savingsIn(s, amount) {
    var acc = savingsOf(s);
    var real = Math.min(Math.floor(amount), Math.max(0, Math.floor(s.cash)));
    if (real <= 0) return 0;
    s.cash -= real;
    acc.balance += real;
    s.flows.saved += real;
    api.note(s, 'На накопительный счёт', -real, 'reserve');
    return real;
  }

  function savingsOut(s, amount) {
    var acc = savingsOf(s);
    var real = Math.min(Math.floor(amount), Math.max(0, Math.floor(acc.balance)));
    if (real <= 0) return 0;
    acc.balance -= real;
    s.cash += real;
    // Процент считается по минимальному остатку: снятие опускает планку.
    if (acc.balance < acc.minMonth) acc.minMonth = acc.balance;
    acc.withdrew = true;
    s.flows.saved = Math.max(0, s.flows.saved - real);
    api.note(s, 'Снято с накопительного счёта', real, 'reserve');
    return real;
  }

  /**
   * Сколько процентов принесёт счёт по итогам ТЕКУЩЕГО месяца, если больше
   * ничего не делать. Отдельная чистая функция: интерфейс показывает игроку
   * ровно то число, которое потом и начислится.
   */
  function savingsMonthGain(s) {
    var acc = savingsOf(s);
    var basis = Math.max(0, Math.min(acc.minMonth, acc.balance));
    if (basis <= 0) return 0;
    var r = savingsRates(s);
    var top = r.boosted ? Math.min(basis, r.cap) : 0;
    var rest = basis - top;
    return Math.round(top * annualToMonthly(r.boost) + rest * annualToMonthly(r.base));
  }

  /** Ежемесячный процент. Вызывается один раз за месяц, из tick. */
  function savingsAccrue(s) {
    var acc = savingsOf(s);
    var gain = savingsMonthGain(s);
    if (gain <= 0) return 0;
    acc.balance += gain;
    acc.earned += gain;
    s.flows.assetGrowth += gain;
    api.note(s, 'Процент по накопительному счёту', gain, 'good');
    return gain;
  }

  /** Досрочное погашение конкретного долга по решению игрока. */
  function repayDebt(s, amount, debtId, fromReserve) {
    return api.repay(s, Math.floor(amount), { debtId: debtId, fromReserve: !!fromReserve });
  }

  /** Применить действие игрока (сделка или движение денег). Только из simulate. */
  function applyTrade(s, t) {
    if (!t) return;
    if (t.op === 'buy') buyInstrument(s, t.instId, t.amount);
    else if (t.op === 'sell') sellInstrument(s, t.instId, t.share);
    else if (t.op === 'toReserve') moveToReserve(s, t.amount);
    else if (t.op === 'fromReserve') moveFromReserve(s, t.amount);
    else if (t.op === 'saveIn') savingsIn(s, t.amount);
    else if (t.op === 'saveOut') savingsOut(s, t.amount);
    else if (t.op === 'repay') repayDebt(s, t.amount, t.debtId, t.fromReserve);
  }

  function initState(scenario) {
    var st = scenario.start;
    return {
      scenarioId: scenario.id,
      month: 0,
      months: scenario.months,
      cash: st.cash,
      reserve: st.reserve || 0,
      income: st.income,
      mandatory: st.mandatory,
      foodBudget: st.foodBudget != null ? st.foodBudget : 12000,
      subs: (st.subs || []).map(function (s) { return { label: s.label, amount: s.amount }; }),
      debts: (st.debts || []).map(function (d) { return Object.assign({}, d); }),
      assets: (st.assets || []).map(function (a) { return Object.assign({}, a); }),
      calm: st.calm != null ? st.calm : BASE.CALM_START,
      quality: st.quality != null ? st.quality : BASE.QUALITY_START,
      // Доля дохода, автоматически уходящая в резерв («сначала заплати себе»).
      // Задаётся решением игрока, по умолчанию ноль — то есть само ничего не копится.
      autoSave: st.autoSave || 0,

      // Силы: четвёртый ограниченный ресурс. Подработки и активные действия
      // тратят их, отдых восстанавливает. Из-за этого «просто работай больше»
      // перестаёт быть бесплатным решением.
      energy: st.energy != null ? st.energy : BASE.ENERGY_START,

      // Репутация у близких. Отдельная валюта: её нельзя купить деньгами,
      // но она открывает помощь в трудный момент.
      trust: st.trust != null ? st.trust : 50,

      // Бытовые расходы: доля дохода, уходящая на жизнь сверх обязательных
      // статей и еды. Игрок может её менять решениями («жить скромнее»),
      // но она никогда не равна нулю — жить бесплатно нельзя.
      livingShare: st.livingShare != null ? st.livingShare
        : (BASE.LIVING_BY_LEVEL[scenario.level] != null
            ? BASE.LIVING_BY_LEVEL[scenario.level] : BASE.LIVING_SHARE),

      // Кредитный рейтинг. От него зависят ставка и доступная сумма.
      creditScore: st.creditScore != null ? st.creditScore : BASE.CREDIT_START,

      // Портфель бумаг. Пустой в начале любой партии, поэтому старые
      // сохранения и сценарии без вложений ведут себя ровно как раньше.
      portfolio: [],

      // Накопительный счёт: остаток, минимальный остаток текущего месяца
      // (по нему считается процент) и отметка о снятии.
      savings: { balance: st.savings || 0, minMonth: st.savings || 0,
                 earned: 0, withdrew: false },

      pending: [],
      // Отложенные РЕШЕНИЯ: событие, которое появится через несколько месяцев
      // как следствие сегодняшнего выбора. В отличие от pending, здесь игроку
      // снова дадут выбрать — это и есть сюжетный поворот, а не просто эхо.
      scheduled: [],
      concepts: [],
      timeline: [],
      monthly: [],        // помесячный отчёт: сколько пришло, сколько ушло
      flags: {},          // произвольные метки: что игрок уже сделал
      locked: {},         // события, закрытые предыдущими решениями
      outcomes: [],       // чем закончились жеребьёвки — для отчёта
      flows: emptyFlows(),
      stats: {
        late: 0, scamHit: 0, scamAvoided: 0, monthsNegative: 0,
        minReserve: st.reserve || 0, gambles: 0, luckyBreaks: 0, badBreaks: 0,
        burnout: 0, starvationMonths: 0, hungryMonths: 0, loansTaken: 0,
        onTimeMonths: 0, refinanced: 0, earlyRepaid: 0, creditRefused: 0,
        minCredit: st.creditScore != null ? st.creditScore : BASE.CREDIT_START,
        trades: 0, invested: 0, realized: 0, tradeWins: 0, tradeLosses: 0
      },
      gameOver: false,
      gameOverReason: null,
      // Чем закончилось последнее обращение в банк: сколько просили,
      // сколько дали, отказали ли. Нужно интерфейсу, чтобы честно
      // предупредить об отказе до того, как игрок выберет кредит.
      // Счётчик рядом — по нему видно, что обращение вообще было:
      // сравнивать сами объекты нельзя, копия состояния создаёт новый.
      lastCredit: null,
      creditSeq: 0,
      _noise: 0,
      _eventScale: 1,
      // Точка отсчёта для инфляции образа жизни: с какого дохода уже «списан» рост быта.
      _incomeMark: st.income,
      // Стартовый доход: от него считается убывающая отдача повышений.
      _baseIncome: st.income,
      // Темп инфляции и инфляции образа жизни зависят от уровня сложности.
      _inflation: BASE.INFLATION_BY_LEVEL[scenario.level] != null
        ? BASE.INFLATION_BY_LEVEL[scenario.level] : BASE.INFLATION_MONTHLY,
      _creep: BASE.LIFESTYLE_BY_LEVEL[scenario.level] != null
        ? BASE.LIFESTYLE_BY_LEVEL[scenario.level] : BASE.LIFESTYLE_CREEP
    };
  }

  function subsTotal(s) {
    return s.subs.reduce(function (a, x) { return a + x.amount; }, 0);
  }
  function debtPaymentsTotal(s) {
    return s.debts.reduce(function (a, d) { return a + d.payment; }, 0);
  }
  function debtBalanceTotal(s) {
    return s.debts.reduce(function (a, d) { return a + d.balance; }, 0);
  }
  function assetsTotal(s) {
    return s.assets.reduce(function (a, x) { return a + x.value; }, 0);
  }
  function netWorth(s) {
    return s.cash + s.reserve + savingsBalance(s)
      + assetsTotal(s) + portfolioValue(s) - debtBalanceTotal(s);
  }
  /* Подушка — это доступные деньги, а не конкретный счёт. Накопительный
     счёт снимается в тот же день, поэтому он считается наравне с резервом:
     иначе игра требовала бы держать подушку там, где она не работает. */
  function reserveMonths(s) {
    var need = s.mandatory + s.foodBudget + subsTotal(s);
    return need > 0 ? (s.reserve + savingsBalance(s)) / need : 0;
  }

  /* API для контента: события описываются через эти операции */

  /**
   * Насколько сильно ОДНО событие двигает самочувствие.
   *
   * Раньше событий было около тридцати за пять лет, и цифры вроде «−6 спокойствия»
   * подбирались под эту плотность. Теперь событие есть каждый месяц, плюс
   * межмесячные ситуации — их больше сотни. Если оставить прежние числа,
   * спокойствие и качество жизни выгорают за полтора года при любой игре,
   * и партия заканчивается не из-за решений, а из-за арифметики.
   * Поэтому вклад одного события уменьшен: суммарное давление осталось прежним,
   * а вот распределено оно теперь по всем месяцам.
   */
  var EVENT_MOOD_SCALE = 0.42;
  var INTER_MOOD_SCALE = 0.30;
  function eventScale(s) {
    return s._eventScale != null ? s._eventScale : 1;
  }

  /*
   *  МАСШТАБ СУММ
   *
   *  События написаны под доход около 62 000 ₽. Без пересчёта одна и та же
   *  поломка холодильника была бы мелочью в одном сценарии и катастрофой
   *  в другом. Формула живёт здесь, а не в events.js, потому что по ней
   *  считает не только движок: интерфейс подставляет те же суммы прямо
   *  в текст события — иначе в тексте стоит одна цифра, а списывается
   *  другая, и игра врёт игроку.
   */

  var SCALE_BASE_INCOME = 62000;

  function scaleAmount(s, base) {
    var income = (s && s.income) || SCALE_BASE_INCOME;
    var k = Math.max(0.55, Math.min(2.2, income / SCALE_BASE_INCOME));
    return Math.round(base * k / 500) * 500;
  }

  var api = {
    note: function (s, label, amount, type) {
      s.timeline.push({ month: s.month, label: label, amount: amount || 0, type: type || 'info' });
    },

    /** Трата: сначала наличные, потом резерв, потом в минус. */
    spend: function (s, amount, label, bucket) {
      if (amount <= 0) return;
      var fromReserve = 0;
      s.cash -= amount;
      if (s.cash < 0 && s.reserve > 0) {
        fromReserve = Math.min(s.reserve, -s.cash);
        s.reserve -= fromReserve;
        s.cash += fromReserve;
      }
      s.flows[bucket || 'fun'] += amount;
      if (fromReserve > 0) api.note(s, 'Из резерва: ' + label, -fromReserve, 'reserve');
    },

    earn: function (s, amount, label) {
      s.cash += amount;
      s.flows.income += amount;
      if (label) api.note(s, label, amount, 'good');
    },

    toReserve: function (s, amount) {
      var real = Math.min(amount, Math.max(0, s.cash));
      s.cash -= real;
      s.reserve += real;
      s.flows.saved += real;
      return real;
    },

    /**
     * Новый долг. cashNow = сколько денег приходит на руки.
     * Для покупки в рассрочку cashNow = 0: вещь получена, долг остался.
     */
    addDebt: function (s, opt) {
      var monthlyRate = opt.monthlyRate != null ? opt.monthlyRate : annualToMonthly(opt.annualRate || 0);
      var payment = opt.payment != null
        ? opt.payment
        : annuityPayment(opt.principal, monthlyRate, opt.months);
      s.debts.push({
        id: opt.id || ('debt' + s.debts.length),
        label: opt.label,
        balance: opt.principal,
        monthlyRate: monthlyRate,
        payment: payment,
        months: opt.months,
        opened: s.month
      });
      if (opt.cashNow) { s.cash += opt.cashNow; s.flows.borrowed += opt.cashNow; }
      return payment;
    },

    /**
     * Взять кредит наличными: деньги приходят сразу, платёж появляется в бюджете.
     * Отдельная операция от addDebt, потому что решение игрока «занять денег»
     * должно быть видно в истории партии и учитываться в статистике.
     *
     * Если передан baseAnnualRate, ставка считается от кредитного рейтинга:
     * банк не назначает цену по доброте, он назначает её по вашей истории.
     * Если сумма превышает лимит, банк выдаёт столько, сколько одобряет,
     * либо отказывает совсем — и это тоже исход решения.
     */
    /**
     * Спросить у банка, дадут ли столько, НЕ оформляя кредит.
     * Нужна событиям, которые решают судьбу заявки сами: без этой
     * отметки интерфейс не знал, что банк откажет, и игрок выбирал
     * «взять кредит», а не происходило ровно ничего.
     * Возвращает одобренную сумму (0 — отказ).
     */
    askCredit: function (s, asked) {
      var limit = creditLimit(s);
      s.creditSeq = (s.creditSeq || 0) + 1;
      s.lastCredit = { asked: Math.round(asked), given: 0, limit: Math.round(limit) };
      var given = Math.min(limit, asked);
      if (given < Math.min(20000, asked * 0.25)) {
        s.lastCredit.refused = true;
        return 0;
      }
      if (given < asked) s.lastCredit.cut = true;
      s.lastCredit.given = Math.round(given);
      return given;
    },

    borrow: function (s, opt) {
      var annual = opt.baseAnnualRate != null
        ? creditRate(s, opt.baseAnnualRate)
        : opt.annualRate;
      var limit = creditLimit(s);
      var principal = opt.principal;

      /* Итог обращения в банк запоминается прямо в состоянии.
         Без этого интерфейс не мог отличить «кредит взят» от «банку
         не понравился рейтинг»: игрок выбирал «взять кредит», долг
         не появлялся, деньги не приходили, и выглядело это как
         сломанная кнопка. По этой отметке предварительный расчёт
         показывает ответ банка ещё ДО выбора. */
      s.creditSeq = (s.creditSeq || 0) + 1;
      s.lastCredit = { asked: Math.round(opt.principal), given: 0, limit: Math.round(limit) };

      if (opt.checkLimit !== false && principal > limit) {
        if (limit < Math.min(20000, principal * 0.25)) {
          s.stats.creditRefused++;
          s.lastCredit.refused = true;
          api.note(s, 'Банк отказал: кредитный рейтинг слишком низкий', 0, 'bad');
          api.mood(s, -4, -1);
          return 0;
        }
        principal = limit;
        s.lastCredit.cut = true;
        api.note(s, 'Банк одобрил меньше: ' + Math.round(principal) + ' \u20bd', 0, 'info');
      }

      s.lastCredit.given = Math.round(principal);

      var payment = api.addDebt(s, {
        id: opt.id || ('loan' + s.debts.length),
        label: opt.label || 'Кредит наличными',
        principal: principal,
        annualRate: annual,
        monthlyRate: opt.monthlyRate,
        months: opt.months,
        cashNow: principal
      });
      s.stats.loansTaken++;
      api.credit(s, -BASE.CREDIT_NEW_LOAN);
      api.note(s, 'Взят кредит: ' + (opt.label || 'наличными') +
        ' под ' + (annual != null ? (annual * 100).toFixed(1) + '%' : '\u2014'),
        principal, 'debt');
      return payment;
    },

    /**
     * Досрочное погашение. Возвращает, сколько реально ушло на тело долга.
     * Гасим по «лавине»: сначала самый дорогой долг — так меньше переплата.
     */
    repay: function (s, amount, opt) {
      opt = opt || {};
      var source = opt.fromReserve ? 'reserve' : 'cash';
      var available = source === 'reserve' ? s.reserve : Math.max(0, s.cash);
      var left = Math.min(amount, available);
      if (left <= 0) return 0;
      var paid = 0;
      var order = s.debts.slice().sort(function (x, y) {
        return opt.snowball ? x.balance - y.balance : y.monthlyRate - x.monthlyRate;
      });
      for (var i = 0; i < order.length && left > 0; i++) {
        var d = order[i];
        if (d.balance <= 0) continue;
        if (opt.debtId && d.id !== opt.debtId) continue;
        var pay = Math.min(left, d.balance);
        d.balance -= pay;
        left -= pay;
        paid += pay;
        if (d.balance <= 0.01) {
          d.balance = 0;
          api.note(s, 'Долг закрыт досрочно: ' + d.label, 0, 'good');
          api.credit(s, 10);
        }
      }
      if (paid > 0) {
        if (source === 'reserve') s.reserve -= paid; else s.cash -= paid;
        s.flows.debtPaid += paid;
        s.stats.earlyRepaid += paid;
        api.note(s, 'Досрочное погашение', -paid, 'good');
      }
      s.debts = s.debts.filter(function (d) { return d.balance > 0; });
      return paid;
    },

    /**
     * Рефинансирование: заменить дорогие долги одним под новую ставку.
     * Реально доступно только при приличном рейтинге — в этом и урок.
     */
    refinance: function (s, opt) {
      opt = opt || {};
      var total = debtBalanceTotal(s);
      if (total <= 0) return false;
      var annual = creditRate(s, opt.baseAnnualRate != null ? opt.baseAnnualRate : 0.19);
      var months = opt.months || 36;
      var monthlyRate = annualToMonthly(annual);
      s.debts = [{
        id: 'refin-' + s.month,
        label: 'Рефинансированный кредит',
        balance: total,
        monthlyRate: monthlyRate,
        payment: annuityPayment(total, monthlyRate, months),
        months: months,
        opened: s.month
      }];
      s.stats.refinanced++;
      api.note(s, 'Долги рефинансированы под ' + (annual * 100).toFixed(1) + '%', 0, 'info');
      return true;
    },

    /** Изменение кредитного рейтинга. */
    credit: function (s, delta) {
      s.creditScore = Math.max(BASE.CREDIT_MIN, Math.min(BASE.CREDIT_MAX, s.creditScore + delta));
      if (s.creditScore < s.stats.minCredit) s.stats.minCredit = s.creditScore;
    },

    /** Изменение доли дохода, уходящей на быт. Ноль недостижим намеренно. */
    livingDelta: function (s, delta) {
      s.livingShare = Math.max(0.05, Math.min(0.4, s.livingShare + delta));
    },

    addAsset: function (s, opt) {
      s.assets.push({
        id: opt.id || ('asset' + s.assets.length),
        label: opt.label,
        value: opt.value,
        monthlyRate: opt.monthlyRate != null ? opt.monthlyRate : annualToMonthly(opt.annualRate || 0),
        kind: opt.kind || 'save'
      });
    },

    addSub: function (s, label, amount) {
      s.subs.push({ label: label, amount: amount });
    },

    removeSubs: function (s) {
      var freed = subsTotal(s);
      s.subs = [];
      return freed;
    },

    /**
     * Изменение дохода. Рост имеет убывающую отдачу: каждая следующая
     * прибавка даёт меньше, чем обещает событие. Без этого несколько
     * повышений подряд превращают доход в неограниченно растущую величину,
     * и любая партия перестаёт быть про выбор.
     */
    incomeDelta: function (s, delta) {
      if (delta > 0 && s._baseIncome > 0) {
        var ratio = s.income / s._baseIncome;
        var damp = ratio >= 2.4 ? 0.3 : ratio >= 1.9 ? 0.45 : ratio >= 1.5 ? 0.65 : ratio >= 1.25 ? 0.85 : 1;
        delta *= damp;
      }
      var before = s.income;
      s.income += delta;
      if (s.income < 0) s.income = 0;
      return s.income - before;         // сколько прибавки дошло на самом деле
    },

    /**
     * Временный доход: подработка, проект, сезонная надбавка.
     *
     * ОШИБКА, которую это исправляет: раньше событие прибавляло доход через
     * incomeDelta (где рост гасится убывающей отдачей: +38 000 могли стать
     * +32 000), а через несколько месяцев откатывало его вручную на полные
     * −38 000. Каждая временная подработка навсегда съедала несколько тысяч
     * дохода, и через пару лет игрок зарабатывал МЕНЬШЕ, чем в начале, ничего
     * плохого не сделав. Теперь откат равен ровно тому, что было начислено.
     */
    tempIncome: function (s, delta, months, extra) {
      var applied = api.incomeDelta(s, delta);
      var back = { income: -applied };
      if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) back[k] = extra[k]; }
      api.defer(s, months, back);
      return applied;
    },
    mandatoryDelta: function (s, delta) {
      s.mandatory += delta;
      if (s.mandatory < 0) s.mandatory = 0;
    },

    /** Месячный бюджет на еду. Низкий бюджет ухудшает здоровье и настроение. */
    setFoodBudget: function (s, amount) {
      s.foodBudget = Math.max(0, Math.round(amount));
    },

    /** Установить долю дохода, уходящую в резерв автоматически. */
    setAutoSave: function (s, share) {
      s.autoSave = Math.max(0, Math.min(0.6, share));
    },

    /** Силы. Отрицательные значения — усталость, при нуле начинается выгорание. */
    energy: function (s, delta) {
      s.energy = Math.max(0, Math.min(100, s.energy + delta * eventScale(s)));
    },

    /** Доверие близких: копится медленно, тратится быстро. */
    trust: function (s, delta) {
      s.trust = Math.max(0, Math.min(100, s.trust + delta * eventScale(s)));
    },

    /** Метка: что игрок уже сделал. Читается условиями других событий. */
    flag: function (s, key, value) {
      s.flags[key] = value === undefined ? true : value;
    },

    /** Закрыть событие: решение сделало его невозможным. */
    lock: function (s, eventId) { s.locked[eventId] = true; },

    /**
     * Жеребьёвка. Исход зависит от seed и события, но не от выбора игрока:
     * при любом варианте одного события выпадает одно и то же число.
     * Поэтому рискованный выбор — это ставка на неизвестное, а не на подкрученное.
     *
     * outcomes — массив {p, label, effect}. Вероятности нормализуются.
     */
    gamble: function (s, eventId, outcomes, salt) {
      var roll = drawFor(s.scenarioId, s._seed, eventId, salt || 'g');
      var total = outcomes.reduce(function (a, o) { return a + o.p; }, 0);
      var acc = 0, picked = outcomes[outcomes.length - 1];
      for (var i = 0; i < outcomes.length; i++) {
        acc += outcomes[i].p / total;
        if (roll <= acc) { picked = outcomes[i]; break; }
      }
      s.stats.gambles++;
      if (picked.good) s.stats.luckyBreaks++;
      if (picked.bad) s.stats.badBreaks++;
      s.outcomes.push({ month: s.month, event: eventId, label: picked.label, good: !!picked.good });
      api.note(s, picked.label, 0, picked.good ? 'good' : picked.bad ? 'bad' : 'info');
      if (picked.effect) picked.effect(s, api, EngineExport);
      return picked;
    },

    /** Прочитать жеребьёвку заранее, не применяя (для расчёта исходов). */
    peek: function (s, eventId, salt) {
      return drawFor(s.scenarioId, s._seed, eventId, salt || 'g');
    },

    mood: function (s, calmDelta, qualityDelta) {
      var k = eventScale(s);
      s.calm += (calmDelta || 0) * k;
      s.quality += (qualityDelta || 0) * k;
    },

    /** Отложенное последствие: сработает через monthsAhead месяцев. */
    defer: function (s, monthsAhead, effect) {
      s.pending.push(Object.assign({ atMonth: s.month + monthsAhead }, effect));
    },

    learn: function (s, conceptId) {
      if (conceptId && s.concepts.indexOf(conceptId) === -1) s.concepts.push(conceptId);
    },

    /**
     * Назначить будущее событие. Через monthsAhead месяцев игрок получит
     * карточку eventId — продолжение сегодняшнего решения.
     * Идентификатор привязан к месяцу появления, поэтому при пересчёте
     * партии продолжение встаёт на то же место, а решение по нему не теряется.
     */
    schedule: function (s, monthsAhead, eventId) {
      if (!eventId) return;
      var at = s.month + Math.max(1, monthsAhead || 1);
      if (at >= s.months) return;
      var id = eventId + '@s' + at;
      for (var i = 0; i < s.scheduled.length; i++) if (s.scheduled[i].id === id) return;
      s.scheduled.push({ atMonth: at, eventId: eventId, id: id });
    }
  };

  /* Месячный такт */

  function tick(s, rnd) {
    s._noise = rnd();               // ровно один вызов на месяц, всегда
    var subs = subsTotal(s);

    // 0. Инфляция и инфляция образа жизни.
    // Обязательные расходы и еда дорожают каждый месяц, а часть прибавки
    // к доходу оседает в быту. Вместе это не даёт партии выродиться
    // в бесконечное накопление при неизменных расходах.
    var infl = s._inflation;
    s.mandatory = round2(s.mandatory * (1 + infl));
    s.foodBudget = Math.round(s.foodBudget * (1 + infl));
    // ОШИБКА, которую здесь исправили: раньше отметка дохода опускалась вслед
    // за его падением. Из-за этого каждая ВРЕМЕННАЯ подработка добавляла
    // к обязательным расходам новую порцию «инфляции образа жизни»: подработка
    // заканчивалась, отметка падала обратно, а следующая подработка начисляла
    // прибавку заново. За пять лет обязательные расходы разгонялись до уровня,
    // при котором дохода не хватало ни на что, и партия ломалась сама собой.
    // Инфляция образа жизни — реакция на УСТОЙЧИВЫЙ рост дохода, поэтому
    // отметка теперь только растёт.
    if (s.income > s._incomeMark) {
      var gained = s.income - s._incomeMark;
      s.mandatory = round2(s.mandatory + gained * s._creep);
      s._incomeMark = s.income;
    }

    // 1. Доход
    s.cash += s.income;
    s.flows.income += s.income;

    // 2. Обязательные расходы (небольшой разброс месяц к месяцу)
    var mandThis = s.mandatory * (0.95 + s._noise * 0.1);
    s.cash -= mandThis;
    s.flows.mandatory += mandThis;

    // 2.5. Продукты — постоянная управляемая статья бюджета.
    // Игрок задаёт сумму на год вперёд отдельным решением, а списание происходит
    // каждый месяц. Экономия на еде имеет накопительную цену.
    s.cash -= s.foodBudget;
    s.flows.food += s.foodBudget;
    // Порог «голодного» бюджета тоже растёт с инфляцией: 7 000 ₽ в начале
    // и 7 000 ₽ через пять лет — это разное количество еды.
    var foodFloor = 7000 * Math.pow(1 + infl, s.month);
    if (s.foodBudget < foodFloor) {
      s.quality -= 3.5;
      s.energy -= 2.5;
      s.calm -= 1.5;
    } else if (s.foodBudget < foodFloor * (10 / 7)) {
      s.quality -= 1.2;
      s.energy -= 0.8;
    } else if (s.foodBudget >= foodFloor * (20 / 7)) {
      s.quality += 1.2;
      s.energy += 0.6;
    }

    // 3. Подписки — списываются молча. В отчёте это будет неприятным открытием.
    s.cash -= subs;
    s.flows.subs += subs;

    // 4. Долги
    var paidOnTime = 0, missedThisMonth = 0;
    for (var i = 0; i < s.debts.length; i++) {
      var d = s.debts[i];
      if (d.balance <= 0) continue;
      var step = amortizeStep(d.balance, d.monthlyRate, d.payment);
      var available = s.cash + s.reserve;
      if (available >= step.due) {
        s.cash -= step.due;
        if (s.cash < 0) { var take = Math.min(s.reserve, -s.cash); s.reserve -= take; s.cash += take; }
        d.balance = step.balance;
        s.flows.debtPaid += step.due;
        s.flows.interest += step.interest;
        paidOnTime++;
        if (d.balance === 0) api.note(s, 'Закрыт долг: ' + d.label, 0, 'good');
      } else {
        var fee = Math.max(BASE.LATE_FEE_MIN, d.balance * BASE.LATE_FEE_RATE);
        d.balance = d.balance + step.interest + fee;
        // Штраф за просрочку не списывается деньгами — он приклеивается к долгу.
        // Поэтому в помесячном отчёте он не должен выглядеть как ушедшие деньги:
        // иначе итог месяца не сойдётся и снова станет необъяснимым.
        s.flows.feesOnDebt += fee;
        s.flows.interest += step.interest;
        s.calm -= 9;
        s.stats.late++;
        missedThisMonth++;
        api.note(s, 'Просрочка: ' + d.label, -fee, 'bad');
      }
    }
    s.debts = s.debts.filter(function (d) { return d.balance > 0; });

    // 4.5. Автоматическое пополнение резерва — только из того, что реально осталось.
    // Правило «сначала заплати себе» работает лишь при положительном остатке:
    // копить в минусе бессмысленно, это просто рост платы за овердрафт.
    if (s.autoSave > 0 && s.cash > 0) {
      var want = s.income * s.autoSave;
      var can = Math.min(want, s.cash);
      if (can > 0) {
        s.cash -= can;
        s.reserve += can;
        s.flows.saved += can;
      }
    }

    // 4.6. Бытовые расходы.
    // Это ответ на вопрос «почему после трат денег становится больше».
    // Раньше всё, что не ушло в обязательные статьи, еду и подписки, просто
    // оседало на счёте. Поэтому любая трата отыгрывалась за месяц-другой сама,
    // и решения ничего не решали. Теперь часть дохода уходит на жизнь всегда:
    // одежда, транспорт, кафе, подарки, мелочи. Считается от дохода, а не от
    // остатка — иначе экономия снова давала бы бесконечное накопление.
    var living = Math.max(0, s.income * s.livingShare);
    if (living > 0) {
      s.cash -= living;
      s.flows.living += living;
      s.flows.fun += 0;   // быт учитывается отдельной статьёй, не «развлечениями»
    }

    // 4.7. Кредитная история.
    // Растёт медленно, падает мгновенно — как в жизни.
    var creditMove = 0;
    if (missedThisMonth > 0) creditMove -= BASE.CREDIT_LATE * missedThisMonth;
    else if (paidOnTime > 0) { creditMove += BASE.CREDIT_ON_TIME; s.stats.onTimeMonths++; }
    else if (s.creditScore < 700) creditMove += 1.2;   // без долгов рейтинг подтягивается сам
    var loadNow = s.income > 0 ? debtPaymentsTotal(s) / s.income : 0;
    if (loadNow > 0.45) creditMove -= 5;
    else if (loadNow > 0.3) creditMove -= 1.5;
    if (s.cash < 0) creditMove -= 2.5;
    api.credit(s, creditMove);

    // 5. Рост активов
    for (var j = 0; j < s.assets.length; j++) {
      var a = s.assets[j];
      var g = a.value * a.monthlyRate;
      a.value += g;
      s.flows.assetGrowth += g;
    }

    // 5.5. Процент по накопительному счёту — по минимальному остатку месяца.
    savingsAccrue(s);

    // 6. Отложенные последствия — это тоже эхо событий, масштаб тот же.
    s._eventScale = EVENT_MOOD_SCALE;
    var still = [];
    for (var k = 0; k < s.pending.length; k++) {
      var p = s.pending[k];
      if (p.atMonth === s.month) {
        if (p.cash) {
          if (p.cash < 0) api.spend(s, -p.cash, p.label || 'Последствие', p.bucket || 'shocks');
          else api.earn(s, p.cash, p.label);
        } else if (p.label) {
          api.note(s, p.label, 0, p.type || 'info');
        }
        if (typeof p.effect === 'function') p.effect(s, api, EngineExport);
        if (p.income) api.incomeDelta(s, p.income);
        if (p.mandatory) api.mandatoryDelta(s, p.mandatory);
        if (p.energy) api.energy(s, p.energy);
        if (p.trust) api.trust(s, p.trust);
        if (p.calm || p.quality) api.mood(s, p.calm, p.quality);
      } else if (p.atMonth > s.month) {
        still.push(p);
      }
    }
    s.pending = still;
    s._eventScale = 1;

    // 7. Жизнь в минусе стоит денег
    if (s.cash < 0) {
      var od = -s.cash * BASE.OVERDRAFT_MONTHLY;
      s.cash -= od;
      s.flows.fees += od;
      s.calm -= 3;
      s.stats.monthsNegative++;
    }

    // 7.5. Силы восстанавливаются, но хуже при низком спокойствии.
    // Выгорание при нуле сил: доход падает, потому что работать так нельзя.
    // Очень жёсткая норма накоплений тоже имеет цену: если каждый месяц
    // отрезать четверть дохода, жизнь становится уже. Это не «штраф за
    // сбережения», а модель потери гибкости и социального ресурса.
    if (s.autoSave >= 0.25) {
      s.quality -= 0.9;
      s.energy -= 1.2;
    } else if (s.autoSave >= 0.15) {
      s.quality -= 0.3;
    }
    // Восстановление убывает по мере приближения к норме: последние 20 пунктов
    // добираются медленно. Плюс высокая долговая нагрузка мешает отдыхать.
    var headroom = (100 - s.energy) / 100;
    var loadRatio = s.income > 0 ? debtPaymentsTotal(s) / s.income : 0;
    var regen = BASE.ENERGY_REGEN
      * (0.45 + s.calm / 180)
      * (0.35 + headroom)
      * (loadRatio > 0.35 ? 0.6 : 1);
    s.energy = Math.min(100, s.energy + regen);
    if (s.energy <= 0.5) {
      s.stats.burnout++;
      s.calm -= 8;
      s.quality -= 6;
      if (s.income > 0) {
        var lost = s.income * 0.25;
        s.income -= lost;
        api.note(s, 'Выгорание: доход просел', -Math.round(lost), 'bad');
      }
      s.energy = 18;
    }

    // 8. Давление обстоятельств на спокойствие и качество жизни.
    // Свободные деньги считаются после ВСЕХ регулярных статей, включая быт
    // и еду: иначе «свободным» выглядело бы то, что на самом деле уже потрачено.
    var free = s.income - s.mandatory - subs - debtPaymentsTotal(s)
      - s.foodBudget - s.income * s.livingShare;
    var freeRatio = s.income > 0 ? free / s.income : -1;
    var rm = reserveMonths(s);

    if (rm >= 3) s.calm += 2.2;
    else if (rm >= 1) s.calm += 0.6;
    else s.calm -= 2.0;

    if (debtPaymentsTotal(s) > s.income * 0.4) s.calm -= 2.5;
    // Пороги пересчитаны под новое определение свободных денег: теперь из дохода
    // вычитаются ещё еда и быт, поэтому «нормальный» остаток — это единицы
    // процентов дохода, а не четверть. Старые пороги здесь означали бы,
    // что почти любая жизнь считается бедственной.
    if (freeRatio < -0.03) { s.calm -= 1.5; s.quality -= 2.0; }
    else if (freeRatio > 0.10) { s.quality += 0.8; s.calm += 0.5; }
    else s.quality += 0.2;

    s.calm = Math.max(0, Math.min(100, s.calm));
    s.quality = Math.max(0, Math.min(100, s.quality));
    if (s.reserve < s.stats.minReserve) s.stats.minReserve = s.reserve;

    // 8.5. Помесячный итог: куда именно ушли деньги за месяц.
    // Нужен не для расчётов, а для честности перед игроком: без него
    // движение денег выглядит как необъяснимый скачок остатка.
    var openTotal = s._monthOpen != null ? s._monthOpen : (s.cash + s.reserve);
    var f0 = s._flowsOpen || emptyFlows();
    var monthRec = {
      month: s.month,
      open: round2(openTotal),
      close: round2(s.cash + s.reserve),
      income: round2(s.flows.income - f0.income),
      borrowed: round2(s.flows.borrowed - f0.borrowed),
      mandatory: round2(s.flows.mandatory - f0.mandatory),
      food: round2(s.flows.food - f0.food),
      subs: round2(s.flows.subs - f0.subs),
      living: round2(s.flows.living - f0.living),
      debt: round2(s.flows.debtPaid - f0.debtPaid),
      fees: round2(s.flows.fees - f0.fees),
      invested: round2(s.flows.invested - f0.invested),
      events: round2((s.flows.fun - f0.fun) + (s.flows.shocks - f0.shocks))
    };
    monthRec.delta = round2(monthRec.close - monthRec.open);
    // Остаток должен сходиться: если он не сходится, значит какая-то операция
    // двигает деньги мимо статей — лучше показать это честной строкой «прочее»,
    // чем оставить игрока с необъяснимым скачком остатка.
    monthRec.other = round2(monthRec.delta - (
      monthRec.income + monthRec.borrowed - monthRec.mandatory - monthRec.food -
      monthRec.subs - monthRec.living - monthRec.debt - monthRec.fees -
      monthRec.invested - monthRec.events));
    s.monthly.push(monthRec);
    api.note(s, 'Итог месяца', Math.round(monthRec.delta),
      monthRec.delta >= 0 ? 'month-up' : 'month-down');
    s._monthOpen = null;
    s._flowsOpen = null;

    // Проверка условий проигрыша: критически низкие показатели.
    // Радость жизни и голод проверяются отдельно: это наглядно показывает,
    // что нельзя бесконечно экономить на базовых потребностях.
    if (s.quality <= 5) {
      s.gameOver = true;
      s.gameOverReason = 'Радость от жизни исчезла: качество жизни упало до критического уровня.';
    } else if (s.calm <= 5) {
      s.gameOver = true;
      s.gameOverReason = 'Уровень стресса стал невыносимым. Нужно менять что-то радикально.';
    } else if (s.stats.hungryMonths >= 3) {
      s.gameOver = true;
      s.gameOverReason = 'Три месяца подряд не хватало денег на нормальное питание. Так продолжать нельзя.';
    } else if (freeRatio < -0.2 && s.cash + s.reserve < s.mandatory + s.foodBudget) {
      s.stats.starvationMonths++;
      if (s.stats.starvationMonths >= 2) {
        s.gameOver = true;
        s.gameOverReason = 'Не хватает денег даже на базовые нужды. Игра окончена.';
      }
    } else {
      s.stats.starvationMonths = 0;
    }
    if (s.foodBudget < 7000 && s.cash + s.reserve < s.mandatory + s.foodBudget) {
      s.stats.hungryMonths++;
    } else {
      s.stats.hungryMonths = 0;
    }
    if (s.gameOver) api.note(s, 'Игра окончена: ' + s.gameOverReason, 0, 'bad');
  }

  /**
   * Отметка начала месяца: запоминаем остаток и накопленные потоки,
   * чтобы в конце месяца показать честный отчёт «пришло / ушло».
   */
  function beginMonth(s) {
    s._monthOpen = s.cash + s.reserve + savingsBalance(s);
    s._flowsOpen = Object.assign({}, s.flows);
    // Новый месяц — новая планка минимального остатка на счёте.
    var acc = savingsOf(s);
    acc.minMonth = acc.balance;
    acc.withdrew = false;
  }

  /* Симуляция */

  function snapshot(s) {
    return {
      month: s.month,
      cash: s.cash,
      reserve: s.reserve,
      savings: savingsBalance(s),
      calm: s.calm,
      quality: s.quality,
      energy: s.energy,
      trust: s.trust,
      credit: s.creditScore,
      netWorth: netWorth(s),
      debt: debtBalanceTotal(s),
      assets: assetsTotal(s),
      portfolio: portfolioValue(s)
    };
  }

  function findChoice(event, choiceId) {
    for (var i = 0; i < event.choices.length; i++) {
      if (event.choices[i].id === choiceId) return event.choices[i];
    }
    return null;
  }

  /*
   *  ДОСТУПНОСТЬ ВАРИАНТОВ
   *
   *  У события есть requires — оно решает, случится ли ситуация вообще.
   *  У отдельного варианта такого фильтра не было, и в списке решений
   *  появлялось то, чего в жизни игрока нет: «закрыть часть долга» без
   *  долгов, «взять из резерва» при пустом резерве, «продать вложения»
   *  без единой бумаги. Выбор был, а последствий у него не было — деньги
   *  просто оставались на счету, и игра переставала быть одним целым:
   *  события жили отдельно от долгов и биржи.
   *
   *  needs — короткое имя условия или своя функция. Вариант, чьё условие
   *  не выполнено, не показывается игроку и не участвует в разборе
   *  «а если бы»: предлагать несделанным то, чего нельзя было сделать,
   *  так же нечестно, как предлагать это в самой партии.
   */

  var CHOICE_NEEDS = {
    debt:      function (s) { return debtBalanceTotal(s) > 0; },
    portfolio: function (s) { return portfolioValue(s) > 0; },
    reserve:   function (s) { return s.reserve > 0; },
    savings:   function (s) { return savingsBalance(s) > 0; },
    assets:    function (s) { return assetsTotal(s) > 0; },
    subs:      function (s) { return (s.subs || []).length > 0; }
  };

  function choiceAvailable(ch, s) {
    if (!ch) return false;
    if (typeof ch.needs === 'function') return !!ch.needs(s, EngineExport);
    if (typeof ch.needs === 'string') {
      var test = CHOICE_NEEDS[ch.needs];
      return test ? !!test(s) : true;
    }
    return true;
  }

  /**
   * Варианты, которые имеет смысл показать в этом состоянии.
   * Если условия отсеяли всё, возвращается исходный список: остаться
   * совсем без решения хуже, чем показать одно неудобное.
   */
  function availableChoices(ev, s) {
    if (!ev || !ev.choices) return [];
    var out = ev.choices.filter(function (ch) { return choiceAvailable(ch, s); });
    return out.length ? out : ev.choices;
  }

  /*
   *  Сборка сценария из пула событий
   *
   *  Сценарий описывает условия жизни и требования, а конкретный набор
   *  событий собирается детерминированно из seed. Благодаря этому:
   *   - один сценарий даёт разные партии, но воспроизводимые по seed;
   *   - альтернативная история и контрфактические прогоны остаются корректными,
   *     потому что сборка зависит только от (сценарий, seed), а не от решений.
   */

  /** Перемешивание Фишера—Йетса на заданном ГПСЧ. */
  function shuffle(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * Собирает список событий сценария.
   *
   * Ожидает в описании сценария:
   *   months      — длительность;
   *   slots       — [{month, tags:[...], required?:bool}] расписание «мест» под события;
   *   pool        — общий пул событий (передаётся отдельно, из контента).
   *
   * Каждый слот заполняется событием, у которого есть хотя бы один совпадающий
   * тег и которое ещё не использовано. Так один и тот же пул даёт разные партии.
   */
  /*
   *  Межмесячные ситуации.
   *
   *  Это те самые «редкие» события — казино, наследство, вложения, кредитное
   *  предложение. Раньше их выпадало около десятка за пять лет, и игрок мог
   *  вообще не увидеть ни одного. Теперь они появляются между месяцами с
   *  вероятностью INTERSTITIAL_CHANCE, но с весами и лимитами: бытовые
   *  ситуации частые, крупная удача — по-прежнему редкая.
   */
  var INTERSTITIAL_CHANCE = 0.8;
  // Сколько месяцев одна и та же межмесячная ситуация не повторяется.
  // Без этого пул с весами выдаёт «мелкий расход» четыре раза за полгода,
  // и пять лет начинают ощущаться одинаковыми.
  var INTERSTITIAL_COOLDOWN = 9;

  var RANDOM_KINDS = [
    // Бытовые мелочи — самые частые: из них и складывается фон жизни.
    { id: 'random-small-expense',   w: 11 },
    { id: 'random-loss',            w: 11 },
    { id: 'random-broken-shoes',    w: 9 },
    { id: 'random-forgot-sub',      w: 9 },
    { id: 'random-lost-card',       w: 8 },
    { id: 'random-neighbor-noise',  w: 8 },
    { id: 'random-price-jump',      w: 7 },
    { id: 'random-fine',            w: 7 },
    { id: 'random-invest',          w: 7 },
    { id: 'random-casino',          w: 7 },
    { id: 'random-price-drop',      w: 7 },
    { id: 'random-scam-sms',        w: 7 },
    { id: 'random-side-gig',        w: 7 },
    { id: 'random-freelance-ping',  w: 7 },
    { id: 'random-cashback',        w: 6 },
    { id: 'random-emergency-loan',  w: 6 },
    { id: 'random-market-dip',      w: 6 },
    { id: 'random-market-crash',    w: 6 },
    { id: 'random-tax-letter',      w: 6,  max: 5 },
    { id: 'random-medical-bill',    w: 6,  max: 6 },
    { id: 'random-gift',            w: 5 },
    { id: 'random-refund',          w: 5 },
    { id: 'random-friend-repay',    w: 5,  max: 4 },
    { id: 'random-utility-recalc',  w: 5,  max: 4 },
    { id: 'random-loan-offer',      w: 5,  max: 6 },
    { id: 'random-sell-investment', w: 5 },
    { id: 'random-windfall',        w: 4,  max: 4 },
    { id: 'random-bonus',           w: 4,  max: 5 },
    { id: 'random-credit-check',    w: 3,  max: 3 },
    { id: 'random-inheritance',     w: 2,  max: 1 }
  ];

  /* Запасные межмесячные ситуации без условий появления: нужны, чтобы
     обещанные 80% действительно выполнялись, даже когда выпавшая ситуация
     невозможна (нет активов, нет свободных денег и т. д.). */
  var RANDOM_FALLBACK = ['random-small-expense', 'random-loss', 'random-price-jump',
    'random-fine', 'random-gift', 'random-side-gig', 'random-broken-shoes',
    'random-lost-card', 'random-neighbor-noise', 'random-cashback', 'random-refund',
    'random-price-drop', 'random-freelance-ping', 'random-tax-letter'];

  /**
   * Собирает список событий сценария.
   *
   * Гарантии, на которые опирается остальная игра:
   *   1. В КАЖДОМ месяце есть ровно одно основное событие. Пустых месяцев нет.
   *      Благодаря этому игрок видит результат своего решения через месяц,
   *      а не через три — раньше остаток успевал вырасти за время «промотки»,
   *      и любая трата выглядела так, будто денег стало больше.
   *   2. Дополнительно в каждом месяце с вероятностью 80% возникает
   *      межмесячная ситуация (удача, беда, соблазн, кредит, вложение).
   *   3. Сборка зависит только от (сценарий, seed) — не от решений игрока,
   *      поэтому альтернативная история остаётся честной.
   *
   * Слот основного события хранит НЕСКОЛЬКО кандидатов подряд: если у первого
   * не выполняется requires, показывается следующий. Так условие «событие есть
   * всегда» не ломается о ветвление.
   */
  function buildEvents(scenario, pool, seed) {
    if (scenario.events) return scenario.events;      // сценарий с ручным сюжетом
    var rnd = mulberry32(hashSeed('build|' + scenario.id + '|' + String(seed)));
    var used = {};
    var months = scenario.months;
    var mainByMonth = {};   // месяц -> массив кандидатов (в порядке предпочтения)

    function addMain(month, ev, id) {
      if (!ev || month == null || month < 0 || month >= months) return;
      (mainByMonth[month] = mainByMonth[month] || []).push(
        Object.assign({}, ev, { id: id, month: month, slot: 'main-' + month })
      );
    }

    /* 1. Фиксированные события сценария */
    (scenario.fixed || []).forEach(function (item, idx) {
      var id = Array.isArray(item) ? item[0] : item;
      var month = Array.isArray(item) ? item[1] : idx;
      var ev = pool[id];
      if (!ev) return;
      used[id] = true;
      addMain(month, ev, id);
    });

    /* 2. Слоты сценария */
    (scenario.slots || []).forEach(function (slot) {
      function matchesSlot(id) {
        var ev = pool[id];
        if (!ev) return false;
        // События соревновательного сценария живут только в нём: они
        // связаны в одну историю и в чужой партии повисли бы без начала.
        if (ev.cup) return false;
        if ((ev.tags || []).indexOf('random') !== -1) return false;
        if (slot.kind && ev.kind !== slot.kind) return false;
        if (!slot.tags || !slot.tags.length) return true;
        return (ev.tags || []).some(function (t) { return slot.tags.indexOf(t) !== -1; });
      }
      var candidates = Object.keys(pool).filter(function (id) {
        return !used[id] && matchesSlot(id);
      });
      if (!candidates.length) candidates = Object.keys(pool).filter(matchesSlot);
      if (!candidates.length) return;

      /* Слот сценария — это месяц, ради которого партия и играется, поэтому
         в него должна встать крупная ситуация, а не бытовая мелочь. Бытовые
         события носят те же теги и, попадая в общий список кандидатов,
         вытесняли авторские: из шестидесяти месяцев значимыми оставались
         едва двадцать. Мелочь берём в слот только тогда, когда подходящей
         крупной ситуации в пуле не нашлось вовсе. */
      var strong = candidates.filter(function (id) { return !pool[id].filler; });
      if (strong.length) candidates = strong;

      var pick = shuffle(candidates, rnd)[0];
      var repeated = !!used[pick];
      used[pick] = true;
      addMain(slot.month, pool[pick], repeated ? pick + '-repeat-' + slot.month : pick);
    });

    /* 3. Бюджет на продукты пересматривается раз в год */
    if (pool['buy-groceries']) {
      for (var foodMonth = 0; foodMonth < months; foodMonth += 12) {
        var target = foodMonth;
        while (mainByMonth[target] && target < foodMonth + 12 && target < months) target++;
        if (target >= months) {
          // Свободного месяца в этом году не нашлось — ставим первым кандидатом.
          target = foodMonth;
          (mainByMonth[target] = mainByMonth[target] || []).unshift(
            Object.assign({}, pool['buy-groceries'],
              { id: 'buy-groceries-' + foodMonth, month: target, slot: 'main-' + target })
          );
          continue;
        }
        addMain(target, pool['buy-groceries'], 'buy-groceries-' + foodMonth);
      }
    }

    /*
     * 4. Заполняем ВСЕ оставшиеся месяцы
     * Кандидаты берутся только из событий без requires: иначе гарантия
     * «событие каждый месяц» была бы обещанием, а не гарантией.
     * Очередь перемешивается и проходится по кругу — так за пять лет
     * повторы неизбежны, но идут не подряд.
     */
    var levelTag = scenario.level === 1 ? 'easy' : scenario.level >= 3 ? 'hard' : 'mid';
    function fillerOk(id) {
      var ev = pool[id];
      if (!ev) return false;
      // Только повторяемые ситуации: разовые решения вроде «выбрать правило
      // накоплений» на третий раз ломают и смысл, и баланс.
      if (!ev.filler) return false;
      if (ev.cup) return false;
      if (typeof ev.requires === 'function') return false;
      var tags = ev.tags || [];
      if (tags.indexOf('random') !== -1) return false;
      if (id === 'buy-groceries') return false;
      var hasLevel = tags.indexOf('easy') !== -1 || tags.indexOf('mid') !== -1 || tags.indexOf('hard') !== -1;
      return !hasLevel || tags.indexOf(levelTag) !== -1;
    }
    var fillerPool = Object.keys(pool).filter(fillerOk);
    if (!fillerPool.length) fillerPool = Object.keys(pool).filter(function (id) {
      return typeof pool[id].requires !== 'function' && (pool[id].tags || []).indexOf('random') === -1;
    });
    var queue = shuffle(fillerPool, rnd);
    var qi = 0;
    function nextFiller() {
      if (!queue.length) return null;
      if (qi >= queue.length) { queue = shuffle(fillerPool, rnd); qi = 0; }
      return queue[qi++];
    }

    for (var m = 0; m < months; m++) {
      var slotList = mainByMonth[m];
      var needFallback = !slotList ||
        typeof slotList[slotList.length - 1].requires === 'function';
      if (!needFallback) continue;
      var pickId = nextFiller();
      if (!pickId) continue;
      addMain(m, pool[pickId], pickId + '@m' + m);
    }

    /*
     * 5. Межмесячные ситуации
     * Одна жеребьёвка на месяц решает, будет ли ситуация (80%), вторая —
     * какая именно. Обе зависят только от seed, поэтому переигрывание
     * альтернативы сравнивает решения, а не удачу.
     */
    var counts = {};
    var lastSeen = {};
    var interstitials = [];
    for (var im = 0; im < months; im++) {
      if (drawFor(scenario.id, seed, 'inter-' + im, 'p') >= INTERSTITIAL_CHANCE) continue;

      var pool2 = RANDOM_KINDS.filter(function (k) {
        return pool[k.id] && (k.max == null || (counts[k.id] || 0) < k.max);
      });
      if (!pool2.length) continue;
      // Недавно встречавшиеся ситуации временно выбывают из розыгрыша,
      // пока есть достаточный выбор. Разнообразие важнее точных весов.
      var monthNow = im;
      var fresh = pool2.filter(function (k) {
        var last = lastSeen[k.id];
        return last == null || (monthNow - last) > INTERSTITIAL_COOLDOWN;
      });
      if (fresh.length >= 5) pool2 = fresh;
      var totalW = pool2.reduce(function (a, x) { return a + x.w; }, 0);
      var pickW = drawFor(scenario.id, seed, 'inter-kind-' + im, 'type') * totalW;
      var accW = 0, chosen = pool2[pool2.length - 1].id;
      for (var ri = 0; ri < pool2.length; ri++) {
        accW += pool2[ri].w;
        if (pickW <= accW) { chosen = pool2[ri].id; break; }
      }
      counts[chosen] = (counts[chosen] || 0) + 1;
      lastSeen[chosen] = im;

      var slotName = 'inter-' + im;
      interstitials.push(Object.assign({}, pool[chosen],
        { id: chosen + '@i' + im, month: im, slot: slotName, interstitial: true }));

      // Запасной вариант без условий: обещанные 80% должны выполняться,
      // даже если выпавшая ситуация в этот момент невозможна.
      if (typeof pool[chosen].requires === 'function') {
        var fbList = RANDOM_FALLBACK.filter(function (id) {
          return pool[id] && typeof pool[id].requires !== 'function' && id !== chosen;
        });
        if (fbList.length) {
          var fb = fbList[Math.floor(drawFor(scenario.id, seed, 'inter-fb-' + im, 'fb') * fbList.length) % fbList.length];
          interstitials.push(Object.assign({}, pool[fb],
            { id: fb + '@if' + im, month: im, slot: slotName, interstitial: true }));
        }
      }
    }

    /* --- 6. Сборка: сначала основное событие месяца, потом межмесячное --- */
    var result = [];
    for (var mm = 0; mm < months; mm++) {
      (mainByMonth[mm] || []).forEach(function (e) { result.push(e); });
      interstitials.forEach(function (e) { if (e.month === mm) result.push(e); });
    }
    return result;
  }

  /**
   * Возвращает сценарий, готовый к симуляции: с собранным списком событий.
   * Кэшируется по (id, seed), потому что simulate() вызывается многократно
   * при пересчёте партии и при построении альтернативной истории.
   */
  // Пул по умолчанию: задаётся один раз через setPool(), чтобы вызывающему
  // коду не приходилось передавать его в каждый simulate().
  var POOL_REF = {};
  function setPool(pool) { POOL_REF = pool || {}; buildCache = {}; }

  var buildCache = {};
  function resolveScenario(scenario, pool, seed) {
    if (scenario.events) return scenario;
    var key = scenario.id + '|' + String(seed);
    if (buildCache[key]) return buildCache[key];
    var built = Object.assign({}, scenario, { events: buildEvents(scenario, pool, seed) });
    buildCache[key] = built;
    return built;
  }

  /**
   * Какие события актуальны в этом месяце.
   * Событие может быть закрыто предыдущим решением (lock) или иметь условие
   * появления (requires) — так возникает настоящее ветвление: два игрока
   * в одном сценарии видят разные наборы событий.
   */
  function eventsAt(scenario, month, s) {
    var out = [], taken = {};
    for (var i = 0; i < scenario.events.length; i++) {
      var e = scenario.events[i];
      if (e.month !== month) continue;
      if (s.locked[e.id]) continue;
      var ok = typeof e.requires !== 'function' || e.requires(s, EngineExport);
      if (e.slot) {
        // Слот — это одно место в расписании с несколькими кандидатами.
        // Берём первого подходящего: так «событие есть всегда» остаётся
        // правдой даже там, где у кандидата не выполнилось requires.
        if (taken[e.slot]) continue;
        if (!ok) continue;
        taken[e.slot] = true;
        out.push(e);
      } else if (ok) {
        out.push(e);
      }
    }

    // Продолжения сюжетных линий: их назначил прошлый выбор игрока,
    // поэтому в расписании сценария их нет — они появляются на лету.
    for (var k = 0; k < s.scheduled.length; k++) {
      var sch = s.scheduled[k];
      if (sch.atMonth !== month) continue;
      if (s.locked[sch.id]) continue;
      var tpl = POOL_REF[sch.eventId];
      if (!tpl) continue;
      if (typeof tpl.requires === 'function' && !tpl.requires(s, EngineExport)) continue;
      out.push(Object.assign({}, tpl, { id: sch.id, month: month, followUp: true }));
    }
    return out;
  }

  /**
   * Главная функция. choices — массив {eventId, choiceId} в порядке принятия.
   * Если на очередное событие решения нет, симуляция останавливается и возвращает
   * awaiting — то есть игра ждёт игрока. Это позволяет держать всё состояние
   * как чистую функцию от списка решений: никакой скрытой мутации между ходами.
   */
  function simulate(scenario, seed, choices, pool) {
    // Если сценарий описан слотами, собираем его события из пула по seed.
    // Сборка зависит только от (сценарий, seed) — не от решений игрока,
    // поэтому альтернативная история остаётся корректной.
    if (!scenario.events) {
      scenario = resolveScenario(scenario, pool || POOL_REF, seed);
    }
    var rnd = mulberry32(hashSeed(scenario.id + '|' + String(seed)));
    var s = initState(scenario);
    s._seed = seed;                  // нужен для жеребьёвок, привязанных к событию
    var history = [snapshot(s)];
    var map = {};
    /* Что игроку РЕАЛЬНО предлагали на каждом событии. Нужно разбору
       «а если бы»: он не должен считать упущенным то, чего в списке
       не было. */
    var offered = {};

    /* Сделки игрока лежат в том же массиве, что и решения, но помечены
     * type:'trade'. У каждой записан `after` — сколько решений было принято
     * к моменту сделки. Благодаря этому сделка встаёт в поток ровно туда,
     * где игрок её сделал, и переигрывание партии не переставляет её
     * задним числом относительно уже принятых решений. */
    var trades = [];
    (choices || []).forEach(function (c) {
      if (c && c.type === 'trade') trades.push(c);
      else if (c) map[c.eventId] = c.choiceId;
    });
    trades.sort(function (a, b) { return (a.after || 0) - (b.after || 0); });
    var ti = 0, decided = 0;
    function flushTrades() {
      while (ti < trades.length && (trades[ti].after || 0) <= decided) {
        applyTrade(s, trades[ti]);
        ti++;
      }
    }

    for (var m = 0; m < scenario.months; m++) {
      s.month = m;
      beginMonth(s);
      var evs = eventsAt(scenario, m, s);
      for (var i = 0; i < evs.length; i++) {
        flushTrades();
        var ev = evs[i];
        offered[ev.id] = availableChoices(ev, s).map(function (c) { return c.id; });
        var picked = map[ev.id];
        if (picked == null) {
          return { state: s, history: history, awaiting: ev, offered: offered, finished: false };
        }
        var ch = findChoice(ev, picked);
        if (!ch) return { state: s, history: history, awaiting: ev, offered: offered, finished: false };
        api.learn(s, ev.concept);
        if (ch.concept) api.learn(s, ch.concept);
        api.note(s, ev.shortTitle || ev.title, 0, 'decision');
        s._eventScale = ev.interstitial ? INTER_MOOD_SCALE : EVENT_MOOD_SCALE;
        ch.apply(s, api, EngineExport);
        s._eventScale = 1;
        if (ev.kind === 'scam') {
          if (ch.scamHit) s.stats.scamHit++; else s.stats.scamAvoided++;
        }
        decided++;
      }
      tick(s, rnd);
      history.push(snapshot(s));
      // Проверка на проигрыш
      if (s.gameOver) {
        return { state: s, history: history, awaiting: null, offered: offered,
                 finished: true, gameOver: true };
      }
    }
    // Сделки, сделанные после последнего решения партии, исполняются здесь:
    // внутри месяцев они привязаны к позиции в потоке решений, а после
    // финального решения такой позиции уже нет.
    s.month = scenario.months - 1;
    flushTrades();
    s.month = scenario.months;
    return { state: s, history: history, awaiting: null, offered: offered, finished: true };
  }

  /**
   * Альтернативная история: перепрогоняем тот же сценарий с тем же seed,
   * заменив ровно одно решение. Возвращает самое дорогое расхождение.
   */
  /**
   * Разбор партии: что было бы, выбери игрок иначе.
   *
   * Для каждого решения перебираются остальные варианты, партия
   * пересчитывается с самого начала — движок детерминирован, поэтому
   * разница в итоге целиком объясняется этим одним выбором. Возвращается
   * список решений, отсортированный по величине разницы: сначала те,
   * что стоили дороже всего.
   */
  function counterfactualList(scenario, seed, choices, limit, pool) {
    if (!scenario.events) scenario = resolveScenario(scenario, pool || POOL_REF, seed);
    var basis = simulate(scenario, seed, choices);
    if (!basis.finished) return [];
    var baseNW = netWorth(basis.state);
    var out = [];

    choices.forEach(function (c) {
      var ev = scenario.events.filter(function (e) { return e.id === c.eventId; })[0];
      if (!ev) return;
      var best = null;   // самое дорогое расхождение — о нём и рассказ
      var fatal = null;  // вариант, который вообще обрывал партию
      var up = null;     // лучший из вариантов, если он вообще был лучше
      // Только то, что игроку показывали в тот месяц: «а если бы вы закрыли
      // долг» при отсутствии долгов — не упущенная возможность, а выдумка.
      var shown = basis.offered && basis.offered[ev.id];
      ev.choices.forEach(function (alt) {
        if (alt.id === c.choiceId) return;
        if (shown && shown.indexOf(alt.id) === -1) return;
        var swapped = choices.map(function (x) {
          return x.eventId === c.eventId ? { eventId: x.eventId, choiceId: alt.id } : x;
        });
        var run = simulate(scenario, seed, swapped);
        if (!run.finished) return;
        var delta = netWorth(run.state) - baseNW;
        var row = {
          delta: delta,
          month: ev.month,
          event: ev,
          chosen: findChoice(ev, c.choiceId),
          alternative: alt,
          history: run.history,
          state: run.state,
          // Партия оборвалась досрочно — капитал у неё измерен не в том же
          // месяце, что у вашей.
          gameOver: !!run.state.gameOver
        };

        /* Вариант, после которого партия обрывается, в разборе не участвует
           наравне с остальными. Его «разница» — это не «столько вы бы имели»,
           а сравнение капитала на пятнадцатом месяце с капиталом на
           шестьдесят первом: величины разного смысла. Раньше именно такие
           варианты и возглавляли разбор — просто потому, что их число
           получалось самым большим по модулю, — и на графике давали линию,
           которая обрывалась в начале и до конца лежала плашмя рядом со
           средней. Они не выбрасываются совсем: если сравнивать больше не
           с чем, показывается такой вариант, но уже с отметкой. */
        if (row.gameOver) {
          if (!fatal || Math.abs(delta) > Math.abs(fatal.delta)) fatal = row;
          return;
        }
        if (!best || Math.abs(delta) > Math.abs(best.delta)) best = row;
        if (delta > 0 && (!up || delta > up.delta)) up = { id: alt.id, delta: delta };
      });
      if (!best) best = fatal;
      if (best) { best.up = up; out.push(best); }
    });

    out.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    return limit ? out.slice(0, limit) : out;
  }

  /** Самое дорогое решение партии. Тот же разбор, только первая строка. */
  function counterfactual(scenario, seed, choices, pool) {
    return counterfactualList(scenario, seed, choices, 1, pool)[0] || null;
  }

  /*
   *  ЛИНИИ СРАВНЕНИЯ ДЛЯ ИТОГОВОГО ГРАФИКА
   *
   *  Одна своя линия ни о чём не говорит: полтора миллиона — это много
   *  или мало? Смысл появляется от соседних линий. Их три, и каждая
   *  отвечает на свой вопрос:
   *   - «если бы выбрали иначе» — цена ОДНОГО самого дорогого решения;
   *   - «идеальный выбор» — потолок этого сценария с этими же случайностями;
   *   - «среднестатистический» — как выглядит партия без обдумывания.
   *  Все три считаются тем же движком и тем же seed, поэтому разница
   *  между линиями — это разница решений, а не разница везения.
   */

  /**
   * Идеальная партия.
   *
   * Берётся уже посчитанный разбор: в каждом решении, где какой-то другой
   * вариант дал бы результат лучше, подставляется он. Это не полный перебор
   * всех сочетаний (их астрономически много), а честный потолок «если бы
   * каждое отдельное решение было лучшим из показанных».
   */
  function idealRun(scenario, seed, choices, pool, list) {
    if (!scenario.events) scenario = resolveScenario(scenario, pool || POOL_REF, seed);
    var full = list || counterfactualList(scenario, seed, choices, 0, pool);

    var base = simulate(scenario, seed, choices, pool);
    if (!base.finished) return null;
    var bestPicks = (choices || []).slice();
    var bestNW = netWorth(base.state);
    var bestRun = base;

    /* Замены накладываются по одной, от самой выгодной к менее выгодной,
       и каждая остаётся только если она улучшает ИТОГ целиком.
       Просто подставить все «лучшие поодиночке» варианты нельзя: решения
       влияют друг на друга, и сумма локально лучших ходов легко
       оказывается хуже исходной партии — а линия с подписью «идеальный
       выбор» обязана быть не хуже вашей, иначе она врёт. */
    var gains = full.filter(function (r) { return r.up; })
      .sort(function (a, b) { return b.up.delta - a.up.delta; });

    for (var i = 0; i < gains.length; i++) {
      var evId = gains[i].event.id, altId = gains[i].up.id;
      var picks = bestPicks.map(function (c) {
        if (!c || c.type === 'trade') return c;
        return c.eventId === evId ? { eventId: evId, choiceId: altId } : c;
      });
      var run = simulate(scenario, seed, picks, pool);
      if (!run.finished || run.state.gameOver) continue;
      var nw = netWorth(run.state);
      if (nw > bestNW) { bestNW = nw; bestPicks = picks; bestRun = run; }
    }

    /* Второй проход. Разбор считался от ВАШЕЙ партии, поэтому после первых
       замен появляются новые возможности: решение, которое раньше ничего
       не давало, на изменённом пути может оказаться выгодным. Один
       повторный проход заметно поднимает потолок и стоит столько же,
       сколько первый разбор. Дальше отдача падает, и партия перестаёт быть
       похожей на вашу — а линия должна оставаться сравнимой. */
    if (bestPicks !== choices) {
      var again = counterfactualList(scenario, seed, bestPicks, 0, pool)
        .filter(function (r) { return r.up; })
        .sort(function (a, b) { return b.up.delta - a.up.delta; });
      for (var k = 0; k < again.length; k++) {
        var evId2 = again[k].event.id, altId2 = again[k].up.id;
        var picks2 = bestPicks.map(function (c) {
          if (!c || c.type === 'trade') return c;
          return c.eventId === evId2 ? { eventId: evId2, choiceId: altId2 } : c;
        });
        var run2 = simulate(scenario, seed, picks2, pool);
        if (!run2.finished || run2.state.gameOver) continue;
        var nw2 = netWorth(run2.state);
        if (nw2 > bestNW) { bestNW = nw2; bestPicks = picks2; bestRun = run2; }
      }
    }

    return bestRun;
  }

  /**
   * Партия, где решения принимаются наугад из того, что предложено.
   * Жеребьёвка привязана к сценарию, seed и номеру прогона, поэтому
   * «средняя линия» у одной и той же партии всегда одна и та же.
   */
  function randomRun(scenario, seed, salt, pool) {
    if (!scenario.events) scenario = resolveScenario(scenario, pool || POOL_REF, seed);
    var rnd = mulberry32(hashSeed('avg|' + scenario.id + '|' + String(seed) + '|' + salt));
    var picks = [];
    var run = simulate(scenario, seed, picks, pool);
    var guard = 0;

    while (!run.finished && run.awaiting && guard++ < scenario.months * 8) {
      var opts = shuffle(availableChoices(run.awaiting, run.state), rnd);
      if (!opts.length) break;

      /* «Среднестатистический» — это человек, который не считает, но и не
         гробит себя нарочно: увидев, что после решения жить станет нечем,
         он выберет другое. Без этой оговорки линия была не средней партией,
         а линией самоубийства: ни одна из случайных партий не доживала до
         конца, и «средний результат» превращался в плоскую черту у нуля,
         неотличимую от любой другой оборвавшейся линии.
         Проверка стоит одного прогона на вариант и обычно срабатывает
         с первого. */
      var chosen = null, tried = null;
      for (var i = 0; i < opts.length; i++) {
        var test = picks.concat([{ eventId: run.awaiting.id, choiceId: opts[i].id }]);
        var probe = simulate(scenario, seed, test, pool);
        if (!tried) tried = { pick: test, run: probe };
        if (!probe.state.gameOver) { chosen = { pick: test, run: probe }; break; }
      }
      if (!chosen) chosen = tried;
      if (!chosen) break;
      picks = chosen.pick;
      run = chosen.run;
    }
    return run.finished ? run : null;
  }

  /**
   * Средняя линия: несколько случайных партий, усреднённых по месяцам.
   * Партия, оборвавшаяся проигрышем, дальше держит своё последнее значение —
   * иначе средняя линия обрывалась бы вместе с самой неудачной попыткой.
   */
  function averageHistory(scenario, seed, samples, pool, months) {
    samples = samples || 5;
    var runs = [];
    for (var i = 0; i < samples; i++) {
      var r = randomRun(scenario, seed, i, pool);
      if (r && r.history && r.history.length) runs.push(r.history);
    }
    if (!runs.length) return null;
    var n = months || Math.max.apply(null, runs.map(function (h) { return h.length; }));
    var out = [];
    for (var m = 0; m < n; m++) {
      var total = 0;
      for (var k = 0; k < runs.length; k++) {
        var h = runs[k];
        total += h[Math.min(m, h.length - 1)].netWorth;
      }
      out.push({ month: m, netWorth: total / runs.length });
    }
    return out;
  }

  /* Точность прогнозов */

  /** Ошибка прогноза в процентах от факта. */
  function forecastError(guess, actual) {
    if (actual === 0) return guess === 0 ? 0 : 1;
    return Math.abs(guess - actual) / Math.abs(actual);
  }

  /**
   * Многокритериальная оценка итога.
   * Намеренно не сводится к деньгам: цель считается достигнутой только если
   * выполнены ВСЕ условия сценария. Иначе оптимальной стратегией было бы
   * «ничего не трать, ни на что не соглашайся», а это неверный урок.
   */
  function evaluate(scenario, s) {
    var req = scenario.requirements(s, EngineExport);
    var met = req.filter(function (r) { return r.done; }).length;
    return {
      requirements: req,
      met: met,
      total: req.length,
      done: met === req.length,
      // Ранг от D до S — чтобы был смысл переигрывать даже после успеха
      grade: (function () {
        if (met < req.length) return met === 0 ? 'D' : (met < req.length / 2 ? 'C' : 'B');
        var bonus = (s.calm >= 70 ? 1 : 0) + (s.quality >= 60 ? 1 : 0) +
                    (s.energy >= 50 ? 1 : 0) + (s.stats.late === 0 ? 1 : 0) +
                    (s.stats.scamHit === 0 ? 1 : 0);
         return bonus >= 5 && req.length >= 5 ? 'S' : bonus >= 3 ? 'A' : 'B+';
      })()
    };
  }

  var EngineExport = {
    // Масштаб сумм под доход сценария. Нужен и интерфейсу: он подставляет
    // те же суммы в текст события, чтобы цифра в тексте и списание совпадали.
    scaleAmount: scaleAmount,
    hashSeed: hashSeed,
    mulberry32: mulberry32,
    round2: round2,
    annuityPayment: annuityPayment,
    annuityTotal: annuityTotal,
    annuityOverpay: annuityOverpay,
    impliedMonthlyRate: impliedMonthlyRate,
    monthlyToAnnual: monthlyToAnnual,
    annualToMonthly: annualToMonthly,
    effectiveAnnualRate: effectiveAnnualRate,
    compound: compound,
    futureValueSeries: futureValueSeries,
    realValue: realValue,
    amortizeStep: amortizeStep,
    amortizationSchedule: amortizationSchedule,
    initState: initState,
    tick: tick,
    beginMonth: beginMonth,
    creditTier: creditTier,
    creditRate: creditRate,
    creditLimit: creditLimit,
    creditApproved: creditApproved,
    simulate: simulate,
    counterfactual: counterfactual,
    counterfactualList: counterfactualList,
    availableChoices: availableChoices,
    choiceAvailable: choiceAvailable,
    idealRun: idealRun,
    randomRun: randomRun,
    averageHistory: averageHistory,
    snapshot: snapshot,
    netWorth: netWorth,
    subsTotal: subsTotal,
    setMarket: setMarket,
    marketList: marketList,
    instrument: instrument,
    priceSeries: priceSeries,
    priceAt: priceAt,
    price: price,
    portfolioValue: portfolioValue,
    holdingValue: holdingValue,
    holdingOf: holdingOf,
    buyInstrument: buyInstrument,
    sellInstrument: sellInstrument,
    moveToReserve: moveToReserve,
    moveFromReserve: moveFromReserve,
    savingsBalance: savingsBalance,
    savingsRates: savingsRates,
    savingsIn: savingsIn,
    savingsOut: savingsOut,
    savingsMonthGain: savingsMonthGain,
    repayDebt: repayDebt,
    TRADE_FEE: TRADE_FEE,
    debtBalanceTotal: debtBalanceTotal,
    debtPaymentsTotal: debtPaymentsTotal,
    assetsTotal: assetsTotal,
    reserveMonths: reserveMonths,
    forecastError: forecastError,
    evaluate: evaluate,
    drawFor: drawFor,
    eventsAt: eventsAt,
    shuffle: shuffle,
    buildEvents: buildEvents,
    resolveScenario: resolveScenario,
    setPool: setPool,
    api: api,
    BASE: BASE
  };

  root.Engine = EngineExport;
  if (typeof module !== 'undefined' && module.exports) module.exports = EngineExport;
})(typeof globalThis !== 'undefined' ? globalThis : this);
