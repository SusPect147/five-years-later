/*
 * fyl-bot — вебхук бота «Пять лет спустя» в MAX.
 *
 * Отвечает на запуск бота и на /start: присылает приглашение с двумя
 * кнопками — открыть мини-приложение и перейти в канал.
 *
 * Endpoint защищён общим секретом в адресе (?s=...): без него запрос
 * не обрабатывается, чтобы посторонний не мог дёргать бота от чужого имени.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const API = 'https://platform-api2.max.ru';
const TOKEN = Deno.env.get('MAX_BOT_TOKEN') ?? '';
const HOOK_SECRET = Deno.env.get('FYL_HOOK_SECRET') ?? '';
const CHANNEL_URL = Deno.env.get('FYL_CHANNEL_URL') ?? 'https://max.ru/se13287255_biz';

const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false }, db: { schema: 'fyl' } },
);

const WELCOME = [
  '🎓 **Пять лет спустя** — симулятор взрослой жизни.',
  '',
  'Зарплата приходит раз в месяц. Аренда, еда, проезд — уходят сами.',
  'А дальше начинается интересное: рассрочка на телефон, «выгодное» предложение от друга,',
  'сломанный зуб, первая машина, первые накопления.',
  '',
  'Шестьдесят месяцев. Десятки решений. В конце — честный разбор:',
  'где вы выиграли, где переплатили и сколько стоила каждая ошибка.',
  '',
  'Двадцать минут вместо пяти лет собственных шишек.',
  '',
  'Жмите «Играть» — и первый месяц пошёл. 📈',
].join('\n');

let me: { user_id?: number; username?: string } | null = null;

async function getMe() {
  if (me) return me;
  const res = await fetch(`${API}/me`, { headers: { Authorization: TOKEN } });
  if (!res.ok) throw new Error('GET /me: HTTP ' + res.status);
  me = await res.json();
  return me!;
}

async function sendWelcome(chatId: number | null, userId: number | null) {
  const bot = await getMe();
  const buttons = [
    [{
      type: 'open_app',
      text: '▶️ Играть',
      web_app: bot.username,
      contact_id: bot.user_id,
    }],
    [{
      type: 'link',
      text: '📣 Наш канал',
      url: CHANNEL_URL,
    }],
  ];

  const qs = chatId ? `chat_id=${chatId}` : `user_id=${userId}`;
  const res = await fetch(`${API}/messages?${qs}`, {
    method: 'POST',
    headers: { Authorization: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: WELCOME,
      format: 'markdown',
      attachments: [{ type: 'inline_keyboard', payload: { buttons } }],
    }),
  });
  if (!res.ok) {
    console.error('send failed', res.status, (await res.text()).slice(0, 300));
  }
}

function pickIds(u: any) {
  const chatId = u?.chat_id ?? u?.message?.recipient?.chat_id ?? null;
  const user = u?.user ?? u?.message?.sender ?? null;
  return { chatId, user };
}

function isStart(u: any) {
  if (u?.update_type === 'bot_started') return true;
  if (u?.update_type !== 'message_created') return false;
  const text = String(u?.message?.body?.text ?? '').trim().toLowerCase();
  return text === '/start' || text === 'start' || text === 'начать' || text.startsWith('/start ');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  // Секрет в адресе вебхука: чужой запрос до бота не доходит.
  if (HOOK_SECRET) {
    const s = new URL(req.url).searchParams.get('s');
    if (s !== HOOK_SECRET) return new Response('forbidden', { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  try {
    const { chatId, user } = pickIds(update);

    if (user?.user_id) {
      await db.from('bot_chats').upsert({
        max_user_id: user.user_id,
        chat_id: chatId,
        name: String(user.name ?? '').slice(0, 64),
        username: user.username ? String(user.username).slice(0, 64) : null,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'max_user_id' });
    }

    if (isStart(update)) await sendWelcome(chatId, user?.user_id ?? null);
  } catch (e) {
    console.error(e);
  }

  // MAX ждёт быстрый 200: любые наши ошибки не должны приводить к повторам.
  return new Response('ok');
});
