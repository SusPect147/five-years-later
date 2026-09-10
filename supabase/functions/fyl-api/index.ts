/*
 * fyl-api — серверная часть игры «Пять лет спустя».
 *
 * Главный принцип: клиенту не верят ни в чём. Он присылает только то, что
 * не может подделать без последствий — seed партии и журнал своих действий.
 * Сервер сам прогоняет ту же партию тем же движком и сам считает балл.
 * Присланный клиентом балл сохраняется отдельно и только для того, чтобы
 * видеть, кто пытается накручивать.
 *
 * Личность игрока берётся из подписи MAX (launch_params), а не из тела запроса.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BOT_TOKEN = Deno.env.get('MAX_BOT_TOKEN') ?? '';
const DEV_ALLOW_UNSIGNED = (Deno.env.get('FYL_DEV_ALLOW_UNSIGNED') ?? '') === '1';

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'fyl' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  });

/* ================================================================
 * Подпись MAX
 * ================================================================ */

const enc = new TextEncoder();

async function hmac(keyData: ArrayBuffer | Uint8Array, message: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyData as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return await crypto.subtle.sign('HMAC', key, enc.encode(message));
}

function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Постоянное по времени сравнение — чтобы подпись нельзя было подобрать по таймингу. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type MaxUser = { user_id: number; name?: string; username?: string };

async function verifyLaunchParams(raw: string): Promise<MaxUser | null> {
  if (!raw || typeof raw !== 'string' || raw.length > 4096) return null;
  if (!BOT_TOKEN) return null;

  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;

  const pairs: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const checkString = pairs.join('\n');

  const secretKey = await hmac(enc.encode('WebAppData'), BOT_TOKEN);
  const signature = toHex(await hmac(new Uint8Array(secretKey), checkString));
  if (!safeEqual(signature, hash.toLowerCase())) return null;

  // Просроченный запуск не принимаем: перехваченные параметры не должны
  // работать вечно.
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return null;
  const ageSec = Math.abs(Date.now() / 1000 - (authDate > 1e11 ? authDate / 1000 : authDate));
  if (ageSec > 60 * 60 * 24) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || typeof user.user_id !== 'number') return null;
    return user as MaxUser;
  } catch {
    return null;
  }
}

/* ================================================================
 * Движок: тот же код, что и у игрока
 *
 * Файлы игры тянутся с её же хостинга и проверяются по sha256 из таблицы
 * engine_builds. Подменённый на хостинге движок сервер исполнять откажется,
 * а значит и накрутить через него ничего нельзя.
 * ================================================================ */

type EngineBundle = { Engine: any; Content: any };
let bundle: EngineBundle | null = null;
let bundleAt = 0;

async function sha256Hex(text: string) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function loadEngine(): Promise<EngineBundle> {
  // Держим движок в памяти инстанса: пересчёт партии не должен каждый раз
  // ходить в сеть.
  if (bundle && Date.now() - bundleAt < 60 * 60 * 1000) return bundle;

  const { data: build, error } = await db
    .from('engine_builds')
    .select('base_url, files')
    .eq('active', true)
    .maybeSingle();
  if (error) throw new Error('engine_builds: ' + error.message);
  if (!build) throw new Error('нет активной сборки движка (fyl.engine_builds)');

  const files: Record<string, string> = build.files;
  const order = ['engine.js', 'events.js', 'content.js'];
  const g = globalThis as any;

  for (const name of order) {
    const expected = files[name];
    if (!expected) throw new Error('в сборке нет файла ' + name);
    const url = String(build.base_url).replace(/\/+$/, '') + '/' + name;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`не скачался ${name}: HTTP ${res.status}`);
    const src = await res.text();
    const got = await sha256Hex(src);
    if (got !== expected) {
      throw new Error(`${name}: sha256 не совпал (ожидалось ${expected.slice(0, 12)}…, получено ${got.slice(0, 12)}…)`);
    }
    // Файлы игры — обычные скрипты, они кладут себя в globalThis.
    new Function(src)();
  }

  const Engine = g.Engine;
  const Content = g.Content;
  if (!Engine || !Content) throw new Error('движок не инициализировался');
  Engine.setPool(Content.pool);
  if (Engine.setMarket) Engine.setMarket(Content.instruments || []);

  bundle = { Engine, Content };
  bundleAt = Date.now();
  return bundle;
}

/* ================================================================
 * Балл. Формула ровно та же, что на экране итогов у игрока.
 * ================================================================ */

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function resultScore(E: any, st: any, evaluation: any) {
  const goals = evaluation.total ? evaluation.met / evaluation.total : 0;
  const life = (clamp(st.calm, 0, 100) + clamp(st.quality, 0, 100) + clamp(st.energy, 0, 100)) / 300;
  const reserve = clamp(E.reserveMonths(st) / 3, 0, 1);
  return Math.round(clamp(100 * (goals * 0.55 + life * 0.28 + reserve * 0.17), 0, 100));
}

/* ================================================================
 * Приём партии
 * ================================================================ */

const MAX_ACTIONS = 600;

function actionsLookSane(actions: unknown): actions is any[] {
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return false;
  for (const a of actions) {
    if (!a || typeof a !== 'object') return false;
    const keys = Object.keys(a);
    if (keys.length > 8) return false;
    for (const k of keys) {
      const v = (a as any)[k];
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean' && v !== null) return false;
      if (t === 'string' && (v as string).length > 128) return false;
      if (t === 'number' && !Number.isFinite(v)) return false;
    }
  }
  return true;
}

async function logSecurity(maxUserId: number | null, kind: string, detail: unknown) {
  await db.from('security_log').insert({ max_user_id: maxUserId, kind, detail });
}

async function getPlayer(user: MaxUser) {
  const { data, error } = await db
    .from('players')
    .upsert(
      {
        max_user_id: user.user_id,
        name: String(user.name ?? '').slice(0, 64),
        username: user.username ? String(user.username).slice(0, 64) : null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'max_user_id' },
    )
    .select('id, banned, name')
    .single();
  if (error) throw new Error('player: ' + error.message);
  return data;
}

async function tooManyRuns(playerId: number) {
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [{ count: perMinute }, { count: perDay }] = await Promise.all([
    db.from('runs').select('id', { count: 'exact', head: true })
      .eq('player_id', playerId).gte('created_at', minuteAgo),
    db.from('runs').select('id', { count: 'exact', head: true })
      .eq('player_id', playerId).gte('created_at', dayAgo),
  ]);
  return (perMinute ?? 0) >= 5 || (perDay ?? 0) >= 300;
}

async function submitRun(user: MaxUser, body: any) {
  const player = await getPlayer(user);
  if (player.banned) return json({ error: 'banned' }, 403);

  const scenarioId = String(body.scenario_id ?? '').slice(0, 64);
  const seed = String(body.seed ?? '').slice(0, 64);
  const actions = body.actions;

  if (!scenarioId || !seed) return json({ error: 'bad_request' }, 400);
  if (!actionsLookSane(actions)) {
    await logSecurity(user.user_id, 'actions_malformed', { scenarioId, count: Array.isArray(actions) ? actions.length : null });
    return json({ error: 'bad_actions' }, 400);
  }
  if (await tooManyRuns(player.id)) {
    await logSecurity(user.user_id, 'rate_limited', { scenarioId });
    return json({ error: 'rate_limited' }, 429);
  }

  const { Engine, Content } = await loadEngine();
  const scenario = (Content.scenarios || []).find((s: any) => s.id === scenarioId);
  if (!scenario) return json({ error: 'unknown_scenario' }, 400);

  // Пересчёт. Всё, что было в партии, восстанавливается из seed и журнала:
  // события, цены, жеребьёвки. Ничего из присланного клиентом не участвует
  // в подсчёте, кроме самих действий.
  const built = Engine.resolveScenario(scenario, Content.pool, seed);
  let run: any;
  try {
    run = Engine.simulate(built, seed, actions);
  } catch (e) {
    await logSecurity(user.user_id, 'replay_crashed', { scenarioId, message: String(e) });
    return json({ error: 'replay_failed' }, 400);
  }

  // Партия обязана быть доигранной: если движок всё ещё ждёт решения,
  // значит журнал оборван или в нём есть ход, которого игроку не предлагали.
  if (!run.finished) {
    await logSecurity(user.user_id, 'replay_unfinished', {
      scenarioId, awaiting: run.awaiting?.id ?? null, count: actions.length,
    });
    return json({ error: 'run_unfinished' }, 400);
  }

  // Каждый ход обязан быть из того списка, который движок реально предлагал
  // в этот момент партии. Сам simulate это не проверяет: там достаточно, что
  // вариант существует у события. Поэтому «купить машину без денег» ловится
  // здесь — сверкой с offered.
  const offered: Record<string, string[]> = run.offered || {};
  for (const a of actions) {
    if (!a || a.type === 'trade' || !a.eventId) continue;
    const list = offered[a.eventId];
    if (!list || list.indexOf(a.choiceId) < 0) {
      await logSecurity(user.user_id, 'illegal_choice', {
        scenarioId, eventId: a.eventId, choiceId: a.choiceId,
      });
      return json({ error: 'illegal_choice' }, 400);
    }
  }

  const st = run.state;
  const evaluation = Engine.evaluate(built, st);
  const score = resultScore(Engine, st, evaluation);
  const netWorth = Math.round(Engine.netWorth(st));
  const clientScore = Number.isFinite(body.client_score) ? Math.round(body.client_score) : null;
  const mismatch = clientScore !== null && clientScore !== score;
  if (mismatch) {
    await logSecurity(user.user_id, 'score_mismatch', { scenarioId, clientScore, score });
  }

  const { data: saved, error: runErr } = await db
    .from('runs')
    .upsert({
      player_id: player.id,
      scenario_id: scenarioId,
      scenario_level: scenario.level ?? null,
      cup: !!scenario.cup,
      seed,
      actions,
      action_count: actions.length,
      score,
      grade: evaluation.grade ?? null,
      met: evaluation.met ?? null,
      total: evaluation.total ?? null,
      net_worth: netWorth,
      months: st.month ?? null,
      game_over: !!st.gameOver,
      client_score: clientScore,
      mismatch,
      duration_ms: Number.isFinite(body.duration_ms) ? Math.min(86_400_000, Math.round(body.duration_ms)) : null,
    }, { onConflict: 'player_id,scenario_id,seed,actions_hash', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (runErr && runErr.code !== '23505') throw new Error('run: ' + runErr.message);

  const runId = saved?.id ?? null;

  if (runId) {
    // Лучший результат по сценарию.
    const { data: best } = await db.from('best_scores')
      .select('score').eq('player_id', player.id).eq('scenario_id', scenarioId).maybeSingle();
    if (!best || score > best.score) {
      await db.from('best_scores').upsert({
        player_id: player.id,
        scenario_id: scenarioId,
        score,
        net_worth: netWorth,
        grade: evaluation.grade ?? null,
        cup: !!scenario.cup,
        run_id: runId,
        achieved_at: new Date().toISOString(),
      }, { onConflict: 'player_id,scenario_id' });
    }

    // Прогресс и аналитика.
    await bumpProgress(player.id, scenarioId, st);
    await bumpEventStats(scenarioId, actions);
  }

  return json({
    ok: true,
    run_id: runId,
    score,
    grade: evaluation.grade ?? null,
    met: evaluation.met ?? null,
    total: evaluation.total ?? null,
    net_worth: netWorth,
    name: player.name,
    duplicate: !runId,
  });
}

async function bumpProgress(playerId: number, scenarioId: string, st: any) {
  const { data: prev } = await db.from('progress').select('*').eq('player_id', playerId).maybeSingle();
  const concepts = new Set<string>([...(prev?.concepts ?? []), ...((st.concepts ?? []) as string[])]);
  const played = new Set<string>([...(prev?.scenarios_played ?? []), scenarioId]);
  await db.from('progress').upsert({
    player_id: playerId,
    concepts: [...concepts].slice(0, 500),
    scenarios_played: [...played].slice(0, 200),
    runs_count: (prev?.runs_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'player_id' });
}

async function bumpEventStats(scenarioId: string, actions: any[]) {
  const picks = actions
    .filter((a) => a && !a.type && a.eventId && a.choiceId)
    .slice(0, 300)
    .map((a) => ({ eventId: String(a.eventId), choiceId: String(a.choiceId) }));
  if (!picks.length) return;
  await db.rpc('bump_choices', { p_scenario: scenarioId, p_picks: picks });
}

/* ================================================================
 * Таблица лидеров и прогресс
 * ================================================================ */

async function leaderboard(body: any) {
  const cupOnly = !!body.cup;
  const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));
  const { data, error } = await db
    .from('best_scores')
    .select('score, net_worth, grade, cup, scenario_id, achieved_at, run_id, players(max_user_id, name)')
    .eq('cup', cupOnly)
    .order('score', { ascending: false })
    .order('achieved_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error('leaderboard: ' + error.message);

  const rows = (data ?? []).map((r: any) => ({
    id: r.run_id,
    playerId: String(r.players?.max_user_id ?? ''),
    name: r.players?.name || 'Аноним',
    scenarioId: r.scenario_id,
    level: null,
    cup: r.cup,
    score: r.score,
    netWorth: r.net_worth == null ? null : Number(r.net_worth),
    grade: r.grade,
    at: r.achieved_at,
  }));
  return json({ ok: true, rows });
}

async function getProgress(user: MaxUser) {
  const player = await getPlayer(user);
  const [{ data: progress }, { data: best }] = await Promise.all([
    db.from('progress').select('concepts, scenarios_played, runs_count').eq('player_id', player.id).maybeSingle(),
    db.from('best_scores').select('scenario_id, score, grade').eq('player_id', player.id),
  ]);
  return json({
    ok: true,
    player: { id: String(user.user_id), name: player.name },
    progress: progress ?? { concepts: [], scenarios_played: [], runs_count: 0 },
    best: best ?? [],
  });
}

/* ================================================================
 * Точка входа
 * ================================================================ */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: any;
  try {
    const text = await req.text();
    if (text.length > 512_000) return json({ error: 'payload_too_large' }, 413);
    body = JSON.parse(text || '{}');
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const action = String(body.action ?? '');

  try {
    // Публичное чтение таблицы лидеров: подпись не нужна, писать нечего.
    if (action === 'leaderboard') return await leaderboard(body);

    let user = await verifyLaunchParams(String(body.launch_params ?? ''));
    if (!user && DEV_ALLOW_UNSIGNED && body.dev_user_id) {
      // Только для отладки вне MAX; включается секретом FYL_DEV_ALLOW_UNSIGNED.
      user = { user_id: Number(body.dev_user_id), name: String(body.dev_name ?? 'Тестер') };
    }
    if (!user) {
      await logSecurity(null, 'bad_signature', { action });
      return json({ error: 'unauthorized' }, 401);
    }

    if (action === 'submit') return await submitRun(user, body);
    if (action === 'progress') return await getProgress(user);
    return json({ error: 'unknown_action' }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: 'server_error', detail: String(e).slice(0, 300) }, 500);
  }
});
