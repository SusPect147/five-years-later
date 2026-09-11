/*
 * fyl-bot — вебхук бота «Пять лет спустя» в MAX.
 *
 * Отвечает на запуск бота и на /start: присылает приглашение с двумя
 * кнопками — открыть мини-приложение и перейти в канал.
 *
 * Запрос от MAX проверяется общим секретом FYL_HOOK_SECRET. MAX присылает
 * его в заголовке X-Max-Bot-Api-Secret (так рекомендует документация);
 * старый вариант — секрет в адресе (?s=...) — тоже принимается.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const API = 'https://platform-api2.max.ru';
const TOKEN = Deno.env.get('MAX_BOT_TOKEN') ?? '';
const HOOK_SECRET = Deno.env.get('FYL_HOOK_SECRET') ?? '';
const CHANNEL_URL = Deno.env.get('FYL_CHANNEL_URL') ?? 'https://max.ru/se13287255_biz';
const CA_PEM_RAW = Deno.env.get('MAX_CA_PEM') ?? '';
const PUBLIC_URL = (Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/fyl-bot';

/*
 * Сертификат platform-api2.max.ru выпущен российским удостоверяющим центром
 * Минцифры, которого нет в стандартном списке доверенных у сервера Supabase.
 * Без него любой запрос к MAX падает с «invalid peer certificate: UnknownIssuer»
 * — бот не может ни ответить, ни подписаться на вебхук.
 *
 * Оба сертификата — корневой и промежуточный — публичные, их раздаёт
 * Госуслуги: https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt
 * и .../russian_trusted_sub_ca_pem.crt. Нужны оба: MAX отдаёт неполную
 * цепочку, и с одним корневым ошибка остаётся той же.
 *
 * Доверие выдаётся только отдельному http-клиенту для запросов к MAX,
 * глобальные настройки не трогаются. Промежуточный действует до марта 2027 —
 * если к тому времени выйдет новый, его можно положить в секрет MAX_CA_PEM,
 * он добавится к встроенным.
 */
const RU_TRUSTED_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----`;

const RU_TRUSTED_SUB_CA = `-----BEGIN CERTIFICATE-----
MIIHQjCCBSqgAwIBAgICEAIwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAyMTEyNTE5WhcNMjcwMzA2MTEyNTE5WjBvMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMR8wHQYDVQQDDBZSdXNzaWFuIFRydXN0ZWQgU3Vi
IENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9YPqBKOk19NFymrE
wehzrhBEgT2atLezpduB24mQ7CiOa/HVpFCDRZzdxqlh8drku408/tTmWzlNH/br
HuQhZ/miWKOf35lpKzjyBd6TPM23uAfJvEOQ2/dnKGGJbsUo1/udKSvxQwVHpVv3
S80OlluKfhWPDEXQpgyFqIzPoxIQTLZ0deirZwMVHarZ5u8HqHetRuAtmO2ZDGQn
vVOJYAjls+Hiueq7Lj7Oce7CQsTwVZeP+XQx28PAaEZ3y6sQEt6rL06ddpSdoTMp
BnCqTbxW+eWMyjkIn6t9GBtUV45yB1EkHNnj2Ex4GwCiN9T84QQjKSr+8f0psGrZ
vPbCbQAwNFJjisLixnjlGPLKa5vOmNwIh/LAyUW5DjpkCx004LPDuqPpFsKXNKpa
L2Dm6uc0x4Jo5m+gUTVORB6hOSzWnWDj2GWfomLzzyjG81DRGFBpco/O93zecsIN
3SL2Ysjpq1zdoS01CMYxie//9zWvYwzI25/OZigtnpCIrcd2j1Y6dMUFQAzAtHE+
qsXflSL8HIS+IJEFIQobLlYhHkoE3avgNx5jlu+OLYe0dF0Ykx1PGNjbwqvTX37R
Cn32NMjlotW2QcGEZhDKj+3urZizp5xdTPZitA+aEjZM/Ni71VOdiOP0igbw6asZ
2fxdozZ1TnSSYNYvNATwthNmZysCAwEAAaOCAeUwggHhMBIGA1UdEwEB/wQIMAYB
Af8CAQAwDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBTR4XENCy2BTm6KSo9MI7NM
XqtpCzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzCBxwYIKwYBBQUH
AQEEgbowgbcwOwYIKwYBBQUHMAKGL2h0dHA6Ly9yb3N0ZWxlY29tLnJ1L2NkcC9y
b290Y2Ffc3NsX3JzYTIwMjIuY3J0MDsGCCsGAQUFBzAChi9odHRwOi8vY29tcGFu
eS5ydC5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNydDA7BggrBgEFBQcwAoYv
aHR0cDovL3JlZXN0ci1wa2kucnUvY2RwL3Jvb3RjYV9zc2xfcnNhMjAyMi5jcnQw
gbAGA1UdHwSBqDCBpTA1oDOgMYYvaHR0cDovL3Jvc3RlbGVjb20ucnUvY2RwL3Jv
b3RjYV9zc2xfcnNhMjAyMi5jcmwwNaAzoDGGL2h0dHA6Ly9jb21wYW55LnJ0LnJ1
L2NkcC9yb290Y2Ffc3NsX3JzYTIwMjIuY3JsMDWgM6Axhi9odHRwOi8vcmVlc3Ry
LXBraS5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNybDANBgkqhkiG9w0BAQsF
AAOCAgEARBVzZls79AdiSCpar15dA5Hr/rrT4WbrOfzlpI+xrLeRPrUG6eUWIW4v
Sui1yx3iqGLCjPcKb+HOTwoRMbI6ytP/ndp3TlYua2advYBEhSvjs+4vDZNwXr/D
anbwIWdurZmViQRBDFebpkvnIvru/RpWud/5r624Wp8voZMRtj/cm6aI9LtvBfT9
cfzhOaexI/99c14dyiuk1+6QhdwKaCRTc1mdfNQmnfWNRbfWhWBlK3h4GGE9JK33
Gk8ZS8DMrkdAh0xby4xAQ/mSWAfWrBmfzlOqGyoB1U47WTOeqNbWkkoAP2ys94+s
Jg4NTkiDVtXRF6nr6fYi0bSOvOFg0IQrMXO2Y8gyg9ARdPJwKtvWX8VPADCYMiWH
h4n8bZokIrImVKLDQKHY4jCsND2HHdJfnrdL2YJw1qFskNO4cSNmZydw0Wkgjv9k
F+KxqrDKlB8MZu2Hclph6v/CZ0fQ9YuE8/lsHZ0Qc2HyiSMnvjgK5fDc3TD4fa8F
E8gMNurM+kV8PT8LNIM+4Zs+LKEV8nqRWBaxkIVJGekkVKO8xDBOG/aN62AZKHOe
GcyIdu7yNMMRihGVZCYr8rYiJoKiOzDqOkPkLOPdhtVlgnhowzHDxMHND/E2WA5p
ZHuNM/m0TXt2wTTPL7JH2YC0gPz/BvvSzjksgzU5rLbRyUKQkgU=
-----END CERTIFICATE-----`;

function splitPem(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function extraPem(): string[] {
  const raw = CA_PEM_RAW.trim();
  if (!raw) return [];
  if (raw.indexOf('-----BEGIN') >= 0) return splitPem(raw.replace(/\\n/g, '\n'));
  // Секрет можно положить и в base64 — на случай, если переносы строк потерялись.
  try { return splitPem(atob(raw)); } catch { return []; }
}

let maxClient: unknown = null;
let clientError = '';

function httpOptions(init: RequestInit = {}): RequestInit {
  const create = (Deno as any).createHttpClient;
  if (typeof create !== 'function') {
    clientError = 'Deno.createHttpClient недоступен в этой среде';
    return init;
  }
  if (!maxClient) {
    try {
      maxClient = create({ caCerts: [RU_TRUSTED_ROOT_CA, RU_TRUSTED_SUB_CA, ...extraPem()] });
    } catch (e) {
      clientError = 'сертификат не принят: ' + String(e).slice(0, 160);
      return init;
    }
  }
  return { ...init, client: maxClient } as RequestInit;
}

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
  const res = await fetch(`${API}/me`, httpOptions({ headers: { Authorization: TOKEN } }));
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
  const res = await fetch(`${API}/messages?${qs}`, httpOptions({
    method: 'POST',
    headers: { Authorization: TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: WELCOME,
      format: 'markdown',
      attachments: [{ type: 'inline_keyboard', payload: { buttons } }],
    }),
  }));
  if (!res.ok) {
    console.error('send failed', res.status, (await res.text()).slice(0, 300));
  }
}

/*
 * Разовая настройка через браузер: /functions/v1/fyl-bot?s=СЕКРЕТ&setup=1
 *
 * Запрос к MAX уходит с сервера Supabase, а не с домашней машины, — так
 * не мешают ни сертификаты Windows, ни кавычки PowerShell.
 * Секрет передаётся полем secret (MAX потом шлёт его в заголовке
 * X-Max-Bot-Api-Secret), а не в адресе: так он не попадает в логи.
 */
async function setupWebhook() {
  const out: Record<string, unknown> = {
    webhook: PUBLIC_URL,
    token_set: !!TOKEN,
    secret_set: !!HOOK_SECRET,
    extra_ca_from_secret: extraPem().length,
    custom_client: typeof (Deno as any).createHttpClient === 'function',
  };

  if (HOOK_SECRET && !/^[A-Za-z0-9_-]{5,256}$/.test(HOOK_SECRET)) {
    out.warning = 'FYL_HOOK_SECRET должен быть 5–256 символов: латиница, цифры, _ и -';
  }

  try {
    const meRes = await fetch(`${API}/me`, httpOptions({ headers: { Authorization: TOKEN } }));
    out.me_status = meRes.status;
    out.me = meRes.ok ? await meRes.json() : (await meRes.text()).slice(0, 300);
  } catch (e) {
    out.me_error = String(e).slice(0, 300);
  }

  try {
    const body: Record<string, unknown> = {
      url: PUBLIC_URL,
      update_types: ['bot_started', 'message_created'],
    };
    if (HOOK_SECRET) body.secret = HOOK_SECRET;
    const subRes = await fetch(`${API}/subscriptions`, httpOptions({
      method: 'POST',
      headers: { Authorization: TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    out.subscribe_status = subRes.status;
    out.subscribe = (await subRes.text()).slice(0, 500);
  } catch (e) {
    out.subscribe_error = String(e).slice(0, 300);
  }

  try {
    const listRes = await fetch(`${API}/subscriptions`, httpOptions({ headers: { Authorization: TOKEN } }));
    // Секрет в старых адресах подписки прячем, чтобы не светить его на экране.
    out.subscriptions = (await listRes.text()).slice(0, 800).replace(/([?&]s=)[^"&]+/g, '$1***');
  } catch (e) {
    out.list_error = String(e).slice(0, 300);
  }

  if (clientError) out.client_error = clientError;

  return new Response(JSON.stringify(out, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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
  const qs = new URL(req.url).searchParams;
  const fromHeader = req.headers.get('x-max-bot-api-secret');
  const fromQuery = qs.get('s');
  const authorized = !HOOK_SECRET || fromHeader === HOOK_SECRET || fromQuery === HOOK_SECRET;
  if (!authorized) {
    return new Response('forbidden', { status: 403 });
  }

  // Разовая настройка подписки — открывается в браузере, только с ?s=СЕКРЕТ.
  if (qs.get('setup') === '1' && fromQuery === HOOK_SECRET) return await setupWebhook();

  if (req.method !== 'POST') return new Response('ok');

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
