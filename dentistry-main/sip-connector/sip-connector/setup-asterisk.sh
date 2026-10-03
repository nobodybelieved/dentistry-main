#!/bin/bash
# ============================================================
# Pllato Suite — Asterisk 22 + Binotel WebRTC SIP setup
# ============================================================
# Запускается на свежей Ubuntu 22.04 LTS VM с прямым public IP.
# Рекомендация: Google Cloud e2-micro Always Free us-east1-b.
#
# Что делает:
#   1. Устанавливает Asterisk 22 LTS из исходников
#   2. Получает Let's Encrypt cert через nip.io домен
#   3. Создаёт self-signed DTLS cert для WebRTC
#   4. Настраивает pjsip endpoint (browser-WSS) + Binotel SIP-trunk (UDP)
#   5. Настраивает диалплан (исходящие/входящие)
#   6. Запускает systemd Asterisk service
#
# Использование:
#   sudo ./setup-asterisk.sh
#
# Перед запуском заполни ENV переменные (см. ниже).
# ============================================================

set -euo pipefail

# ──────────────────────────────────────────────────────────────
# ПЕРЕМЕННЫЕ — ЗАПОЛНИ ПЕРЕД ЗАПУСКОМ
# ──────────────────────────────────────────────────────────────

# Public IP этой VM (узнать через `curl ifconfig.me`)
PUBLIC_IP="${PUBLIC_IP:-}"

# Email для Let's Encrypt уведомлений об expiry
LE_EMAIL="${LE_EMAIL:-uurraa@gmail.com}"

# Endpoint password для браузерного юзера 100 (любая случайная hex 32)
# Сгенерируй: openssl rand -hex 16
ENDPOINT_PASSWORD="${ENDPOINT_PASSWORD:-}"

# Binotel SIP-trunk credentials (получить у поддержки Binotel)
BINOTEL_USERNAME="${BINOTEL_USERNAME:-}"
BINOTEL_PASSWORD="${BINOTEL_PASSWORD:-}"
BINOTEL_SERVER="${BINOTEL_SERVER:-sip52.binotel.com}"
BINOTEL_PORT="${BINOTEL_PORT:-5060}"

# ──────────────────────────────────────────────────────────────
# ПРОВЕРКА
# ──────────────────────────────────────────────────────────────

if [ "$EUID" -ne 0 ]; then
  echo "❌ Запусти через sudo: sudo ./setup-asterisk.sh"
  exit 1
fi

if [ -z "$PUBLIC_IP" ]; then
  echo "⚠ Не задан PUBLIC_IP. Пытаюсь определить..."
  PUBLIC_IP=$(curl -s ifconfig.me)
  if [ -z "$PUBLIC_IP" ]; then
    echo "❌ Не могу определить public IP. Задай вручную: PUBLIC_IP=1.2.3.4 sudo ./setup-asterisk.sh"
    exit 1
  fi
  echo "ℹ Определён PUBLIC_IP=$PUBLIC_IP"
fi

if [ -z "$ENDPOINT_PASSWORD" ]; then
  ENDPOINT_PASSWORD=$(openssl rand -hex 16)
  echo "ℹ Сгенерирован ENDPOINT_PASSWORD=$ENDPOINT_PASSWORD (сохрани его — нужен для worker secret)"
fi

if [ -z "$BINOTEL_USERNAME" ] || [ -z "$BINOTEL_PASSWORD" ]; then
  echo "❌ Не заданы BINOTEL_USERNAME / BINOTEL_PASSWORD"
  echo "   Получи их в кабинете Binotel и пропиши в начале скрипта или через env:"
  echo "   BINOTEL_USERNAME=xxx BINOTEL_PASSWORD=yyy sudo ./setup-asterisk.sh"
  exit 1
fi

SIP_DOMAIN=$(echo "$PUBLIC_IP" | tr '.' '-').nip.io

echo "═══════════════════════════════════════════════════════════"
echo "  ASTERISK SETUP — Pllato Suite WebRTC"
echo "═══════════════════════════════════════════════════════════"
echo "  Public IP:       $PUBLIC_IP"
echo "  SIP Domain:      $SIP_DOMAIN"
echo "  Binotel user:    $BINOTEL_USERNAME"
echo "  Binotel server:  $BINOTEL_SERVER:$BINOTEL_PORT"
echo "═══════════════════════════════════════════════════════════"
sleep 3

# ──────────────────────────────────────────────────────────────
# ШАГ 1: Установка зависимостей
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 1/9: Установка зависимостей..."
apt update
apt install -y build-essential wget curl libssl-dev libsrtp2-dev \
  libjansson-dev libxml2-dev libsqlite3-dev libedit-dev libncurses-dev \
  pkg-config uuid-dev libsystemd-dev certbot ufw

# ──────────────────────────────────────────────────────────────
# ШАГ 2: UFW firewall
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 2/9: Настройка UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8089/tcp
ufw allow 5060/udp
ufw allow 10000:20000/udp
ufw allow 3478/udp
ufw --force enable

# ──────────────────────────────────────────────────────────────
# ШАГ 3: Установка Asterisk 22 LTS из исходников
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 3/9: Установка Asterisk 22 LTS (5-10 минут)..."

if ! command -v asterisk &>/dev/null; then
  cd /usr/src
  if [ ! -f asterisk-22-current.tar.gz ]; then
    wget https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-22-current.tar.gz
  fi
  tar xzf asterisk-22-current.tar.gz
  cd asterisk-22.*/

  ./configure --with-jansson-bundled --with-pjproject-bundled --disable-asteriskssl
  make menuselect.makeopts
  # Включаем нужные модули
  menuselect/menuselect --enable codec_opus.so menuselect.makeopts || true
  make -j$(nproc)
  make install
  make samples
  make config

  useradd -r -d /var/lib/asterisk -g users asterisk 2>/dev/null || true
  chown -R asterisk:users /etc/asterisk /var/lib/asterisk /var/log/asterisk /var/spool/asterisk

  systemctl enable asterisk
fi

# ──────────────────────────────────────────────────────────────
# ШАГ 4: Let's Encrypt cert
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 4/9: Let's Encrypt certificate для $SIP_DOMAIN..."

systemctl stop asterisk 2>/dev/null || true
sleep 2

if [ ! -d "/etc/letsencrypt/live/$SIP_DOMAIN" ]; then
  certbot certonly --standalone --non-interactive --agree-tos \
    -m "$LE_EMAIL" -d "$SIP_DOMAIN" --preferred-challenges http
fi

# Копируем для Asterisk (он не может читать LE privkey root:root 600)
mkdir -p /etc/asterisk/keys
cp "/etc/letsencrypt/live/$SIP_DOMAIN/fullchain.pem" /etc/asterisk/keys/wss-fullchain.pem
cp "/etc/letsencrypt/live/$SIP_DOMAIN/privkey.pem"   /etc/asterisk/keys/wss-privkey.pem
chown asterisk:users /etc/asterisk/keys/wss-*
chmod 600 /etc/asterisk/keys/wss-*

# Self-signed DTLS cert (для WebRTC media encryption)
if [ ! -f /etc/asterisk/keys/dtls.pem ]; then
  openssl req -new -x509 -days 3650 -nodes \
    -newkey rsa:2048 -keyout /etc/asterisk/keys/dtls.key \
    -out /etc/asterisk/keys/dtls.crt -subj "/CN=$SIP_DOMAIN"
  cat /etc/asterisk/keys/dtls.crt /etc/asterisk/keys/dtls.key > /etc/asterisk/keys/dtls.pem
  chown asterisk:users /etc/asterisk/keys/dtls.*
  chmod 600 /etc/asterisk/keys/dtls.*
fi

# Renew hook
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-sip.sh <<HOOK
#!/bin/bash
cp /etc/letsencrypt/live/$SIP_DOMAIN/fullchain.pem /etc/asterisk/keys/wss-fullchain.pem
cp /etc/letsencrypt/live/$SIP_DOMAIN/privkey.pem   /etc/asterisk/keys/wss-privkey.pem
chown asterisk:users /etc/asterisk/keys/wss-*
systemctl reload asterisk
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-sip.sh

# ──────────────────────────────────────────────────────────────
# ШАГ 5: modules.conf — отключаем chan_sip
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 5/9: Конфигурация модулей (отключаем chan_sip)..."

cat > /etc/asterisk/modules.conf <<'EOF'
[modules]
autoload=yes
noload => chan_sip.so
EOF

# ──────────────────────────────────────────────────────────────
# ШАГ 6: http.conf — WSS на 8089
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 6/9: HTTP/WSS конфигурация..."

cat > /etc/asterisk/http.conf <<EOF
[general]
enabled=yes
bindaddr=0.0.0.0
bindport=8088
tlsenable=yes
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/wss-fullchain.pem
tlsprivatekey=/etc/asterisk/keys/wss-privkey.pem
EOF

# ──────────────────────────────────────────────────────────────
# ШАГ 7: rtp.conf — ICE/STUN
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 7/9: RTP/ICE конфигурация..."

cat > /etc/asterisk/rtp.conf <<'EOF'
[general]
rtpstart=10000
rtpend=20000
icesupport=yes
stunaddr=stun.l.google.com:19302
; turnaddr= не задаём — VM имеет прямой public IP
EOF

# ──────────────────────────────────────────────────────────────
# ШАГ 8: pjsip.conf — endpoints + Binotel trunk
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 8/9: PJSIP конфигурация..."

cat > /etc/asterisk/pjsip.conf <<EOF
[global]
type=global
endpoint_identifier_order=username,ip

;=== Transport WSS — для браузера ===
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
cert_file=/etc/asterisk/keys/wss-fullchain.pem
priv_key_file=/etc/asterisk/keys/wss-privkey.pem

;=== Transport UDP — для SIP-trunk провайдера ===
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

;========== BROWSER ENDPOINT (operator: 100) ==========
[100-auth]
type=auth
auth_type=userpass
username=100
password=$ENDPOINT_PASSWORD

[100]
type=endpoint
transport=transport-wss
context=from-internal
disallow=all
; КРИТИЧНО: только alaw,ulaw (Binotel-совместимо, без opus-транскодинга)
allow=alaw,ulaw
auth=100-auth
aors=100
webrtc=yes
dtls_cert_file=/etc/asterisk/keys/dtls.pem
dtls_private_key=/etc/asterisk/keys/dtls.pem
dtls_setup=actpass
dtls_verify=fingerprint
ice_support=yes
media_use_received_transport=yes
rtcp_mux=yes

[100]
type=aor
max_contacts=5
remove_existing=yes

;========== BINOTEL SIP-TRUNK ==========
[binotel-auth]
type=auth
auth_type=userpass
username=$BINOTEL_USERNAME
password=$BINOTEL_PASSWORD

[binotel]
type=endpoint
transport=transport-udp
context=from-binotel
disallow=all
allow=alaw,ulaw
outbound_auth=binotel-auth
aors=binotel
from_user=$BINOTEL_USERNAME
from_domain=$BINOTEL_SERVER
direct_media=no

[binotel]
type=aor
contact=sip:$BINOTEL_SERVER:$BINOTEL_PORT

[binotel]
type=identify
endpoint=binotel
match=$BINOTEL_SERVER

[binotel-reg]
type=registration
outbound_auth=binotel-auth
server_uri=sip:$BINOTEL_SERVER:$BINOTEL_PORT
client_uri=sip:$BINOTEL_USERNAME@$BINOTEL_SERVER
retry_interval=60
EOF

# ──────────────────────────────────────────────────────────────
# ШАГ 9: extensions.conf — диалплан
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Шаг 9/9: Диалплан..."

cat > /etc/asterisk/extensions.conf <<'EOF'
[general]
static=yes
writeprotect=no

;=== Браузер → SIP-trunk (исходящие) ===
[from-internal]
exten => _X.,1,NoOp(Outbound: ${EXTEN})
 same => n,Dial(PJSIP/${EXTEN}@binotel,60)
 same => n,Hangup()

;=== Эхо для теста (набери 9000 из браузера → услышишь свой голос) ===
exten => 9000,1,Answer()
 same => n,Echo()
 same => n,Hangup()

;=== SIP-trunk → Браузер (входящие) ===
[from-binotel]
exten => _X.,1,NoOp(Inbound from Binotel)
 same => n,Dial(PJSIP/100,30)
 same => n,Hangup()
EOF

chown -R asterisk:users /etc/asterisk

# ──────────────────────────────────────────────────────────────
# ЗАПУСК
# ──────────────────────────────────────────────────────────────
echo ""
echo "▶ Запуск Asterisk..."
systemctl restart asterisk
sleep 5

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ГОТОВО"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  ENDPOINT_PASSWORD для worker:"
echo "    $ENDPOINT_PASSWORD"
echo ""
echo "  SIP_DOMAIN для worker:"
echo "    $SIP_DOMAIN"
echo ""
echo "  WSS endpoint (для клиента):"
echo "    wss://$SIP_DOMAIN:8089/ws"
echo ""
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Проверь статус:"
echo "    sudo asterisk -rx 'pjsip show transports'"
echo "    sudo asterisk -rx 'pjsip show registrations'"
echo "    (binotel-reg должен быть Registered)"
echo ""
echo "  Live логи:"
echo "    sudo journalctl -u asterisk -f"
echo ""
echo "  Следующий шаг — в worker'е:"
echo "    cd ppb-crm/repo/worker"
echo "    echo '$ENDPOINT_PASSWORD' | wrangler secret put SIP_ENDPOINT_PASSWORD"
echo "    echo '$SIP_DOMAIN'        | wrangler secret put SIP_DOMAIN"
echo "    wrangler deploy"
echo ""
