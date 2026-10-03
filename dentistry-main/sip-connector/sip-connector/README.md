<!-- 🤖 ПОДКЛЮЧАЕШЬ В ДРУГОЙ ПРОЕКТ ЧЕРЕЗ CLAUDE CODE?
     Дай агенту файл INTEGRATE.md — там пошаговая инструкция для ИИ
     (разведка проекта → бэкенд → фронт → адаптация → тест). -->

# SIP-коннектор — «звонить прямо из CRM» (WebRTC-софтфон)

Портативный модуль звонков из браузера. Менеджер жмёт 📞 в карточке → говорит
прямо во вкладке браузера (гарнитура), без внешнего софтфона. Звонок уходит
через свой Asterisk на SIP-trunk провайдера (Binotel / Mango / Zadarma / любой).

> **Как это называется в проекте:** `SipClient` (фронт) + `sip-api` (бэк) +
> Asterisk-PBX. Общее имя — **SIP-коннектор / WebRTC-телефония**.

---

## Что в этой папке

| Файл | Куда ставится | Что это |
|------|---------------|---------|
| `sip-client.js` | фронт (статика рядом с index.html) | Браузерный софтфон. Глобал `window.SipClient`. SIP.js 0.21.2 (CDN, ленивая загрузка). UI: нижний бар статуса + оверлей-диалер. ~760 строк, без зависимостей сборки. |
| `sip-api.js` | бэк (Cloudflare Worker / любой JS-бэкенд) | 2 эндпоинта: выдача SIP-кредов браузеру + лог звонка. ~227 строк. |
| `setup-asterisk.sh` | один раз на VM | Ставит Asterisk 22 + TLS + WebRTC (WSS) + SIP-trunk + диалплан. |
| `asterisk-setup-README.md` | — | Подробный инфра-гайд по Asterisk/VM/провайдеру. |

---

## Архитектура (3 слоя)

```
┌─ Браузер ───────────────┐   WSS (SIP over WebSocket) + SRTP аудио
│  sip-client.js          │◄───────────────────────────────────┐
│  window.SipClient.call()│                                     │
└──────────┬──────────────┘                                     │
           │ GET /api/crm/sip/token  (один раз, креды)           │
           ▼                                                     ▼
┌─ Бэкенд (Worker) ───────┐                       ┌─ Asterisk (VM, public IP) ─┐
│  sip-api.js             │                       │  pjsip endpoint 100 (WSS)  │
│   /sip/token → креды    │                       │  + SIP-trunk (UDP) к       │
│   /sip/log   → история  │                       │    провайдеру              │
└─────────────────────────┘                       └────────────┬───────────────┘
                                                                │ обычный SIP
                                                                ▼
                                                        Провайдер → телефон клиента
```

- **Бэкенд НЕ участвует в аудио** — только отдаёт креды (`/sip/token`) и пишет
  историю (`/sip/log`). Голос идёт напрямую браузер ↔ Asterisk ↔ провайдер.
- Asterisk — единственная инфраструктура (1 дешёвая VM, напр. GCP e2-micro Free).

---

## Перенос в другой проект — 3 шага

### 1) Инфраструктура (один раз)
1. Подними VM с прямым public IP (Ubuntu 22.04). GCP e2-micro Always Free подходит.
2. У провайдера телефонии возьми SIP-trunk (логин/пароль/хост) и впиши IP VM в whitelist.
3. Заполни переменные в начале `setup-asterisk.sh` (PUBLIC_IP, данные trunk, пароль endpoint), запусти `sudo ./setup-asterisk.sh`.
4. Детали — в `asterisk-setup-README.md`.

### 2) Бэкенд
1. Положи `sip-api.js` в воркер.
2. Подключи роутер (в `crm-api.js` это две строки):
   ```js
   import { handleSipRequest } from './sip-api.js';
   // ...внутри основного хендлера, после авторизации:
   const sipResult = await handleSipRequest(path, method, request, env, user, ctx);
   if (sipResult) return sipResult;
   ```
   `user` — авторизованный юзер (нужны `user.id`, `user.name`). Это
   единственная связь с твоей auth — подставь свой объект юзера.
3. Задай переменные/секреты воркера (см. таблицу ниже).

### 3) Фронтенд
1. Подключи скрипт (в самом конце `<body>`):
   ```html
   <script src="sip-client.js"></script>
   ```
2. Пре-варм при старте приложения (UA подключается заранее → первый звонок мгновенный):
   ```js
   if (window.SipClient) {
     setTimeout(() => {
       window.SipClient.init().catch((e) => {
         // sip_not_configured = SIP не настроен, это ОК (фича опциональна)
         if (!String(e?.message || '').includes('sip_not_configured')) console.warn('[sip]', e?.message);
       });
     }, 2000);
   }
   ```
3. Повесь на любую кнопку 📞:
   ```js
   await window.SipClient.call(phone, { contactName, customerId, dealId });
   ```
   Где `apiBase` берётся фронтом (sip-client.js шлёт на `apiBase + '/api/crm/sip/token'`).
   Проверь переменную `apiBase` внутри `sip-client.js` под свой бэкенд-URL.

---

## Переменные воркера (env / secrets)

| Имя | Обяз. | Пример | Что |
|-----|-------|--------|-----|
| `SIP_DOMAIN` | да | `34-23-1-1.nip.io` | домен Asterisk (nip.io от IP VM) |
| `SIP_ENDPOINT_PASSWORD` | да | hex32 | пароль pjsip-endpoint `100` (из setup-asterisk.sh) |
| `SIP_USER` | нет | `100` | SIP-username (по умолчанию `100`, общий на всех операторов) |
| `SIP_TURN_URL` | нет | `turn:host:3478` | TURN, если оператор за жёстким NAT |
| `SIP_TURN_USERNAME` / `SIP_TURN_PASSWORD` | нет | — | креды TURN |

Если `SIP_DOMAIN` или `SIP_ENDPOINT_PASSWORD` не заданы → `/sip/token` отдаёт
`503 sip_not_configured`, фронт тихо не показывает бар. Фича полностью опциональна.

---

## API-контракт (2 эндпоинта)

**`GET /api/crm/sip/token`** → креды для SIP.js:
```json
{ "user":"100", "password":"…", "domain":"…nip.io",
  "wss":"wss://…nip.io:8089/ws",
  "iceServers":[{"urls":"stun:…"},{"urls":"turn:…","username":"…","credential":"…"}],
  "display_name":"Имя менеджера" }
```

**`POST /api/crm/sip/log`** → лог звонка (направление, номер, длительность,
deal_id/customer_id). Пишет в историю сделки + (опц.) триггерит «авто-пинг».
Это место завязано на твою БД/историю — если переносишь голый звонок без CRM,
эндпоинт можно оставить заглушкой (вернуть `{ok:true}`).

---

## `window.SipClient` — публичный API

| Метод | Что |
|-------|-----|
| `init()` | подключить UA + зарегистрироваться (идемпотентно) |
| `call(phone, {customerId, dealId, contactName})` | позвонить |
| `hangup()` | завершить |
| `dtmf(digit)` | тон (для голосовых меню) |
| `toggleMute()` | мут/анмут микрофона |
| `state` | геттер: `idle / connecting / registered / calling / ringing / in_call / reconnecting / error` |

---

## Что отвязать при переносе (точки связи с этой CRM)

1. **Auth**: `sip-api.js` принимает `user` (нужны `id`, `name`). Подставь свой.
2. **`apiBase`** в `sip-client.js` — URL твоего бэка.
3. **`/sip/log`** пишет в `deal_activity_log` и шлёт `auto_ping` через DO — это
   CRM-специфика. Для чистого звонка замени на свой лог или заглушку.
4. **Кнопка 📞** — пример хука выше; data-атрибуты (`data-phone`, `data-name`…)
   подставь свои.

Всё остальное (`sip-client.js` UI, регистрация, ICE, реконнект, DTMF, мут) —
самодостаточно и переносится как есть.

---

## Зависимости
- **SIP.js 0.21.2** — тянется лениво с jsDelivr (`https://cdn.jsdelivr.net/npm/sip.js@0.21.2/+esm`)
  при первом звонке. Чтобы убрать внешний CDN — скачай в `vendor/sip.js` и поправь
  константу `SIPJS_ESM` в `sip-client.js`.
- Asterisk 22 LTS на VM. Браузер: любой с WebRTC (Chrome/Edge/Safari/Firefox).
- HTTPS обязателен (микрофон + WSS работают только на secure-origin).
