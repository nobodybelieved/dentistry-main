# INTEGRATE — инструкция для Claude Code: подключить SIP-софтфон в ЭТОТ проект

> Это задание для ИИ-агента (Claude Code). Ты получил папку `sip-connector/` с
> готовым модулем «звонки прямо из браузера» (WebRTC SIP). Твоя задача —
> **встроить его в текущий проект пользователя**, которого ты ещё не знаешь.
> Действуй по фазам ниже. НЕ предполагай стек — сначала разведай (Фаза 0).

---

## Что это за модуль

Браузерный софтфон: менеджер жмёт 📞 на номере → говорит в гарнитуру во вкладке,
без внешних программ. Голос идёт **браузер → Asterisk (отдельная VM) → SIP-trunk
провайдера (Binotel/Mango/Zadarma/любой) → телефон клиента**.

Бэкенд в аудио НЕ участвует — только (а) отдаёт SIP-креды браузеру и (б)
опционально логирует звонок. Голос НЕ проходит через бэкенд.

### Файлы в этой папке
| Файл | Роль | Куда |
|------|------|------|
| `sip-client.js` | браузерный софтфон, `window.SipClient`, ~760 стр, грузит SIP.js с CDN | в статику фронтенда |
| `sip-api.js` | 2 эндпоинта (`/sip/token`, `/sip/log`) — **написан под Cloudflare Workers**, адаптируй под стек проекта | в бэкенд |
| `setup-asterisk.sh` | ставит Asterisk на VM (один раз) | на сервер, не в проект |
| `asterisk-setup-README.md` | инфра-гайд | чтение |
| `README.md` | человеческое описание | чтение |

---

## ФАЗА 0 — разведка целевого проекта (сделай ПЕРВОЙ)

Найди и зафиксируй (по коду), потом перескажи пользователю что нашёл:

1. **Фронтенд-точка входа** — главный HTML (`index.html`?), куда добавить `<script>`.
2. **Как фронт хранит auth-токен** — JWT в `localStorage`? в каком ключе? есть ли
   глобальный `window.state.token` / `window.PLLATO_CONFIG.API_URL`?
   → нужно для запроса `/sip/token` с `Authorization: Bearer <token>`.
3. **Базовый URL API** на фронте (как фронт обычно зовёт бэкенд).
4. **Бэкенд-роутер** — где регистрируются маршруты `/api/...`; как выглядит
   объект авторизованного юзера (нужны `user.id` и `user.name`/`username`).
5. **Стек бэкенда** — Cloudflare Worker? Node/Express? другое? От этого зависит,
   берёшь ли `sip-api.js` как есть или переписываешь по спецификации (Фаза 2).
6. **Где в UI телефоны/кнопки звонка** — карточки клиентов/сделок, строки списка.
   Туда повесишь хук на `SipClient.call(...)`.

Если чего-то не нашёл — спроси пользователя, не угадывай.

---

## ФАЗА 1 — инфраструктура Asterisk (это в основном на пользователе)

Сообщи пользователю, что для звонков нужен **1 сервер с публичным IP** и **SIP-trunk
у провайдера**. Шаги (детали — `asterisk-setup-README.md`):
1. VM с прямым public IP, Ubuntu 22.04 (подойдёт GCP e2-micro Always Free).
2. У провайдера телефонии: SIP-trunk (хост/логин/пароль) + добавить IP VM в whitelist.
3. Заполнить переменные в начале `setup-asterisk.sh` (PUBLIC_IP, данные trunk,
   `SIP_ENDPOINT_PASSWORD` = `openssl rand -hex 16`), запустить `sudo ./setup-asterisk.sh`.
4. Записать итоговые: `SIP_DOMAIN` (вид `<ip-через-дефис>.nip.io`) и `SIP_ENDPOINT_PASSWORD`.

Эти два значения понадобятся бэкенду (Фаза 2). Без них модуль просто не активируется
(деградирует тихо — это нормально, фича опциональна).

---

## ФАЗА 2 — бэкенд (2 эндпоинта)

Нужны два маршрута. **`GET /api/crm/sip/token`** — главный (без него нельзя
звонить). **`POST /api/crm/sip/log`** — опциональный (история звонка).

### Если проект на Cloudflare Workers
Положи `sip-api.js`, подключи роутер (после авторизации, где есть `user` и `env`):
```js
import { handleSipRequest } from './sip-api.js';
const sipResult = await handleSipRequest(path, method, request, env, user, ctx);
if (sipResult) return sipResult;
```
`/sip/log` в этом файле пишет в D1 (`env.DB`, таблица `deal_activity_log`) и шлёт
`auto_ping` через Durable Object — **это CRM-специфика**. Если в целевом проекте
такого нет — упрости `handleSipLog` до записи в свою БД или верни `{ok:true}`.

### Если проект НЕ на Cloudflare (Node/Express/др.)
Перепиши по спецификации (логика тривиальна). **`GET /api/crm/sip/token`** —
проверь auth, верни JSON из env:
```
{
  user:     env.SIP_USER || '100',
  password: env.SIP_ENDPOINT_PASSWORD,        // секрет
  domain:   env.SIP_DOMAIN,                    // '<ip>.nip.io'
  wss:      `wss://${env.SIP_DOMAIN}:8089/ws`,
  iceServers: [
    { urls: `stun:${env.SIP_DOMAIN}:3478` },
    { urls: 'stun:stun.l.google.com:19302' },
    // если задан TURN: { urls: env.SIP_TURN_URL, username: …, credential: … }
  ],
  display_name: user.name || user.username || ''
}
```
Если `SIP_DOMAIN` или `SIP_ENDPOINT_PASSWORD` пусты → верни **HTTP 503** с
`{error:'sip_not_configured'}` (фронт это понимает и тихо прячет UI).
**`POST /api/crm/sip/log`** — прими `{direction, external_number, duration_sec,
deal_id, customer_id, ...}`, запиши в свою историю (или заглушка `{ok:true}`).

### Переменные окружения / секреты (задай в проекте)
| Имя | Обяз. | Пример | Что |
|-----|-------|--------|-----|
| `SIP_DOMAIN` | да | `34-23-1-1.nip.io` | домен Asterisk |
| `SIP_ENDPOINT_PASSWORD` | да (секрет) | hex32 | пароль pjsip-endpoint |
| `SIP_USER` | нет | `100` | SIP-username |
| `SIP_TURN_URL` / `SIP_TURN_USERNAME` / `SIP_TURN_PASSWORD` | нет | — | TURN при жёстком NAT |

---

## ФАЗА 3 — фронтенд (3 правки)

1. **Подключить скрипт** в конце `<body>` главного HTML:
   ```html
   <script src="sip-client.js"></script>
   ```
   (положи `sip-client.js` рядом с остальной статикой проекта.)

2. **Адаптировать 2 связки внутри `sip-client.js`** (встречаются дважды — в
   `/sip/token` ~стр.84 и `/sip/log` ~стр.525). Сейчас там pllato-специфика:
   ```js
   const token   = (window.state && window.state.token) || localStorage.getItem('pllato_jwt');
   const apiBase = (window.PLLATO_CONFIG && window.PLLATO_CONFIG.API_URL) || '';
   ```
   Замени на способ ЭТОГО проекта получать (а) JWT/сессию и (б) базовый URL API.
   Проще всего: перед подключением скрипта определить глобали
   `window.PLLATO_CONFIG = { API_URL: '<твой бэкенд>' }` и положить токен в
   `localStorage` под нужным ключом — тогда правки не нужны. Иначе — поправь
   эти 2 строки (всего 4 места).

3. **Пре-варм при старте** приложения (UA подключится заранее → первый звонок
   мгновенный; если SIP не настроен — тихо ничего):
   ```js
   if (window.SipClient) {
     setTimeout(() => {
       window.SipClient.init().catch((e) => {
         if (!String(e?.message||'').includes('sip_not_configured')) console.warn('[sip]', e?.message);
       });
     }, 2000);
   }
   ```

4. **Повесить звонок на кнопку 📞** у номера телефона:
   ```js
   await window.SipClient.call(phone, { contactName, customerId, dealId });
   ```
   `customerId`/`dealId` опциональны (нужны только если используешь `/sip/log` для
   привязки к сущности). Минимально достаточно `SipClient.call(phone)`.

### `window.SipClient` API
`init()` · `call(phone, opts)` · `hangup()` · `dtmf(d)` · `toggleMute()` ·
`state` (`idle/connecting/registered/calling/ringing/in_call/reconnecting/error`).
UI (нижний бар статуса + оверлей активного звонка) рисуется самим `sip-client.js` —
отдельной вёрстки не нужно.

---

## Зависимости и требования
- **SIP.js 0.21.2** — грузится лениво с jsDelivr (`cdn.jsdelivr.net/npm/sip.js@0.21.2/+esm`)
  при первом звонке. Хочешь без CDN — скачай в `vendor/` и поправь константу
  `SIPJS_ESM` вверху `sip-client.js`.
- **HTTPS обязателен** на фронте — микрофон и WSS работают только на secure-origin.
- Браузер с WebRTC (Chrome/Edge/Safari/Firefox).

---

## Чек-лист адаптации (пройди перед тестом)
- [ ] `apiBase` в `sip-client.js` указывает на бэкенд проекта.
- [ ] токен авторизации читается так, как принято в проекте.
- [ ] роут `/api/crm/sip/token` отвечает 200 с кредами (или 503 если SIP не настроен).
- [ ] `<script src="sip-client.js">` подключён, `SipClient.init()` вызывается.
- [ ] кнопка 📞 вызывает `SipClient.call(phone)`.
- [ ] env заданы: `SIP_DOMAIN`, `SIP_ENDPOINT_PASSWORD`.
- [ ] (если нужен лог) `/sip/log` пишет в БД проекта или возвращает `{ok:true}`.

## Тест
1. Открой приложение по HTTPS → внизу должен появиться бар статуса SIP
   («регистрируется» → «готов»). Если бара нет — `/sip/token` вернул 503 (проверь env).
2. Нажми 📞 на тестовом номере → браузер попросит микрофон → пойдёт дозвон.
3. Проверь входящие (если провайдер шлёт на trunk).

## Что спросить у пользователя, если неясно
- Какой провайдер телефонии и есть ли уже SIP-trunk + VM с Asterisk?
- Стек бэкенда (Cloudflare / Node / др.)?
- Как в проекте хранится auth-токен и какой базовый URL API?
- Нужен ли лог звонков в БД (история) или достаточно самого звонка?
