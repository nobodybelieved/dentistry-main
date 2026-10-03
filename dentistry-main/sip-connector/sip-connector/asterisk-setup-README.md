# Pllato Suite — WebRTC SIP телефония

Click-to-call из браузера через Asterisk PBX + SIP-trunk провайдера (Binotel).
Менеджер звонит клиенту прямо из CRM, голос идёт через браузер.
Не нужны физические IP-телефоны.

## Стоимость

| Компонент | Стоимость |
|---|---|
| Google Cloud `e2-micro` Always Free (Asterisk PBX) | **$0** навсегда |
| Cloudflare Worker (token endpoint) | $0 |
| nip.io домен | $0 |
| Binotel SIP-trunk | от $5/мес + минуты (у нас уже есть) |

**Итого**: $0 сверх уже-оплачиваемого Binotel.

## Архитектура

```
Браузер менеджера (sip-client.js)
       ↓ WSS:8089 + DTLS-SRTP
Asterisk на GCP VM (e2-micro us-east1)
       ↓ SIP UDP:5060 + RTP
Binotel → PSTN → телефон клиента
```

## Подготовка — что делает юзер

### Фаза 1: Google Cloud Free VM (~30 мин)

1. https://cloud.google.com/free → регистрация (карта только для верификации, ничего не списывают)
2. Создать проект `ppb-sip`
3. Compute Engine → Create VM:
   - **Тип**: `e2-micro` (Always Free)
   - **Регион**: `us-east1-b`
   - **OS**: Ubuntu 22.04 LTS Minimal
   - **Disk**: 30 GB Standard persistent (Always Free)
   - **Network**: Allow HTTP + HTTPS traffic
4. После создания → External IP → **Reserve as static**
5. VPC firewall → создать 2 rules:
   - `sip-tcp`: TCP `22, 80, 443, 8089` source `0.0.0.0/0`
   - `sip-udp`: UDP `5060, 10000-20000, 3478` source `0.0.0.0/0`
6. SSH в VM → `curl ifconfig.me` → запиши IP

### Фаза 2: Binotel whitelist (1 день ожидания)

Открыть тикет в support@binotel.ua:
> Прошу whitelist IP `<GCP-IP>` для нашего SIP-аккаунта `<SIP_USERNAME>`.
> Подключаем через Asterisk PBX. SIP-trunk нужен в обе стороны (исходящие + входящие).

Когда ответят — будут готовы:
- `BINOTEL_USERNAME`
- `BINOTEL_PASSWORD`
- `BINOTEL_SERVER` (обычно `sip52.binotel.com`)
- `BINOTEL_PORT` (обычно `5060`)

### Фаза 3: Asterisk deploy (~10 мин)

На VM через SSH:

```bash
# Скачать скрипт
wget https://raw.githubusercontent.com/ppbcrmalmaty-sys/ppb-crm/main/webrtc/setup-asterisk.sh
chmod +x setup-asterisk.sh

# Запустить (заполни переменные)
sudo BINOTEL_USERNAME=xxxx \
     BINOTEL_PASSWORD=yyyy \
     BINOTEL_SERVER=sip52.binotel.com \
     LE_EMAIL=uurraa@gmail.com \
     ./setup-asterisk.sh
```

Что произойдёт автоматом:
1. Установится Asterisk 22 LTS из исходников (~5 мин компиляции)
2. UFW откроет нужные порты
3. Let's Encrypt cert на `<ip>-<ip>-<ip>-<ip>.nip.io`
4. Self-signed DTLS cert для WebRTC
5. pjsip endpoint 100 (browser) + Binotel SIP-trunk
6. Диалплан (исходящие через Binotel, входящие на endpoint 100)
7. Systemd-сервис запустится

В конце скрипт распечатает:
- `ENDPOINT_PASSWORD` (для worker secret)
- `SIP_DOMAIN` (для worker secret)
- Команды проверки

### Фаза 4: Worker secrets + redeploy

На локальной машине (где репо):

```bash
cd ppb-crm/repo/worker
echo "<ENDPOINT_PASSWORD>" | npx wrangler secret put SIP_ENDPOINT_PASSWORD
echo "<SIP_DOMAIN>"        | npx wrangler secret put SIP_DOMAIN

# (опц) external TURN если оператор за корпоративным NAT — пока не нужно
# echo "turn:standard.relay.metered.ca:80" | npx wrangler secret put SIP_TURN_URL
# echo "<turn_user>"  | npx wrangler secret put SIP_TURN_USERNAME
# echo "<turn_pass>"  | npx wrangler secret put SIP_TURN_PASSWORD

npx wrangler deploy
```

### Фаза 5: Тест

1. Перезагрузить https://ppb-crm-client.pages.dev (хард-reload Cmd+Shift+R)
2. Внизу справа появится pill «✓ Готов к звонкам»
3. В DevTools Console:
   ```js
   await SipClient.call('9000')   // эхо-тест: услышишь свой голос
   await SipClient.call('77011234567')  // реальный звонок
   ```
4. Если работает — добавить inline-кнопку `📞` в карточку клиента/сделки:
   ```html
   <button onclick="event.stopPropagation();
                    window.placeCall({
                      phone: this.dataset.phone,
                      customerId: this.dataset.customerId,
                      contactName: this.dataset.contactName
                    });"
           data-phone="+77011234567"
           data-customer-id="abc-123"
           data-contact-name="Иван Иванов">📞</button>
   ```

## Проверка состояния Asterisk (на VM)

```bash
# Зарегистрирован ли SIP-trunk у Binotel
sudo asterisk -rx 'pjsip show registrations'
# Должно быть: binotel-reg ... Registered

# Транспорты слушают
sudo asterisk -rx 'pjsip show transports'
# Ожидаемо: transport-udp:5060 + transport-wss:8089

# Endpoint 100 готов (Unavailable пока браузер не подключится — это норма)
sudo asterisk -rx 'pjsip show endpoint 100'

# Live логи
sudo journalctl -u asterisk -f
```

## Известные грабли (важно)

1. **chan_sip перехватывает 5060** — фикс в `setup-asterisk.sh` (`noload => chan_sip.so` в `modules.conf`). REGISTER к Binotel падает с 403 если этого не сделать.

2. **opus codec не работает без транскодинга** — Asterisk без коммерческого `codec_opus.so` Digium не может транскодить opus↔alaw. Скрипт ставит `allow=alaw,ulaw` на обоих endpoint'ах. Binotel отдаёт alaw, браузер тоже соглашается на alaw.

3. **Oracle Cloud Free НЕ РАБОТАЕТ** — 1:1 NAT убивает WebRTC ICE. Используйте GCP с прямым public IP.

4. **DTLS cert отдельный от WSS cert** — Asterisk не умеет читать LE privkey для DTLS-SRTP. Self-signed `dtls.pem` создаётся скриптом.

5. **iceTransportPolicy: 'relay'** не использовать на прямом IP — браузер форсит relay через TURN, Asterisk шлёт RTP на TURN-IP без auth → 603 Decline через 7 сек. В нашем `sip-client.js` это `iceTransportPolicy: 'all'`.

6. **WebSocket reconnect** — после sleep ноутбука / смены Wi-Fi UA умирает по умолчанию. `transportOptions.reconnectionAttempts: 100` + re-register в transport.stateChange listener — это уже сделано в `sip-client.js`.

7. **nip.io vs sslip.io** — sslip.io имеет rate-limit на Let's Encrypt. Используем nip.io.

## Multi-tenant (когда будет 2-й клиент)

На том же Asterisk:
- Endpoint 200 + auth 200 (как 100 но другой context)
- Trunk2 (если другой провайдер)
- В extensions.conf новый context `from-tenant2`

На worker'е клиента-2:
```bash
echo "<endpoint-200-password>" | wrangler secret put SIP_ENDPOINT_PASSWORD
echo "200"                     | wrangler secret put SIP_USER
echo "<тот же SIP_DOMAIN>"     | wrangler secret put SIP_DOMAIN
```

Frontend и `sip-client.js` — без изменений. Один Asterisk обслуживает N клиентов.

## Файлы

- `setup-asterisk.sh` — deployment script (runs on VM)
- `worker/src/sip-api.js` — `/api/crm/sip/token` endpoint
- `pllato-suite-client/sip-client.js` — браузерный SIP UA + UI
- `pllato-suite-client/style.css` (секция SIP CLIENT) — стили dialer'а

## Roadmap

- [x] Phase 1-5 — базовое подключение
- [ ] Inline `📞` кнопки в карточке клиента / сделки (после успешного теста)
- [ ] История звонков в карточке клиента (через `/api/crm/sip/log`)
- [ ] Audio запись звонков (Asterisk MixMonitor → R2)
- [ ] Multi-tenant config (когда подключим 2-го клиента)
