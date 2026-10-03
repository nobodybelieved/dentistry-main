/**
 * Pllato Suite — Browser SIP client (WebRTC)
 *
 * Подключается к нашему Asterisk через WSS, делает click-to-call
 * через SIP-trunk провайдера (Binotel/Mango/Zadarma и т.п.).
 *
 * Использует CDN-версию SIP.js 0.21.2 (загружается лениво при первом
 * звонке — не тратит трафик пока юзер не нажал 📞).
 *
 * Публичный API:
 *   window.SipClient.init()             — pre-warm UA + регистрация
 *   window.SipClient.call(phone, opts)  — позвонить (opts: {customerId, dealId, contactName})
 *   window.SipClient.hangup()           — завершить активный звонок
 *   window.SipClient.dtmf(digit)        — отправить DTMF тон
 *   window.SipClient.toggleMute()       — мут/анмут микрофона
 *   window.SipClient.state              — getter текущего состояния
 *
 * UI: floating bottom-bar (статус регистрации + индикатор активного звонка) +
 * dialer overlay (когда есть активный звонок).
 *
 * State:
 *   'idle'         — не инициализирован
 *   'connecting'   — UA подключается к WSS
 *   'registered'   — UA зарегистрирован, готов к звонку
 *   'calling'      — исходящий, ждём ответа
 *   'ringing'      — входящий, ждём принятия
 *   'in_call'      — разговор
 *   'reconnecting' — потеря соединения, пытаемся восстановить
 *   'error'        — фатальная ошибка
 */

(function () {
  'use strict';

  // SIP.js 0.21.2 — на cdnjs больше не хостится UMD-bundle, npm-пакет
  // публикуется только как ESM. Берём собранный +esm у jsDelivr —
  // тот же исходник, на лету бандлится Rollup'ом jsDelivr.
  // Если в будущем хочется убрать внешнюю зависимость — скачать в
  // pllato-suite-client/vendor/sip.js и ссылаться локально.
  const SIPJS_ESM = 'https://cdn.jsdelivr.net/npm/sip.js@0.21.2/+esm';

  const state = {
    sipjs: null,        // загруженный модуль SIP.js
    ua: null,           // UserAgent instance
    registerer: null,
    session: null,      // активный звонок
    creds: null,        // от /api/sip/token
    state: 'idle',
    muted: false,
    callMeta: null,     // { phone, customerId, dealId, contactName, startedAt }
    audioEl: null,      // <audio> для remote stream
  };

  // ──────────────────────────────────────────────────────────────
  // INIT
  // ──────────────────────────────────────────────────────────────

  async function loadSipJs() {
    // Кэшируем модуль — повторные init() не качают заново.
    if (state.sipjs) return state.sipjs;
    // Если кто-то уже подгрузил SIP.js как UMD-bundle и положил
    // на window — используем (для совместимости со старым кодом).
    if (typeof window.SIP !== 'undefined') {
      state.sipjs = window.SIP;
      return state.sipjs;
    }
    // ESM-import — pуми ESM-bundle jsDelivr через `+esm`.
    // import() возвращает namespace object, у sip.js все экспорты
    // доступны на верхнем уровне (UserAgent, Inviter, и т.д.).
    try {
      const mod = await import(SIPJS_ESM);
      // Для совместимости с местами кода, которые используют SIP.X —
      // оборачиваем namespace как объект и кладём также на window.
      state.sipjs = mod;
      window.SIP = mod;
      return state.sipjs;
    } catch (e) {
      console.error('[sip] ESM import failed:', e);
      throw new Error('failed_to_load_sipjs');
    }
  }

  async function fetchCreds() {
    const token = localStorage.getItem('dentaly_token');
    const apiBase = (window.PLLATO_CONFIG && window.PLLATO_CONFIG.API_URL) || 'https://dentaly-worker.rahymstar13.workers.dev';
    const resp = await fetch(apiBase + '/api/crm/sip/token', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || ('http_' + resp.status));
    }
    return await resp.json();
  }

  async function init() {
    if (state.state !== 'idle' && state.state !== 'error') return;

    // Сначала проверяем что SIP вообще настроен на сервере — без UI-bar изменений.
    // Если 503 (sip_not_configured) — выходим тихо, ничего не показываем.
    let creds;
    try {
      creds = await fetchCreds();
    } catch (e) {
      // sip_not_configured ИЛИ временные сетевые ошибки → не светим UI
      return; // state остаётся 'idle'
    }

    setState('connecting');

    try {
      const SIP = await loadSipJs();
      state.creds = creds;

      // Audio element для remote stream
      if (!state.audioEl) {
        state.audioEl = document.createElement('audio');
        state.audioEl.autoplay = true;
        state.audioEl.style.display = 'none';
        document.body.appendChild(state.audioEl);
      }

      const uri = SIP.UserAgent.makeURI(`sip:${creds.user}@${creds.domain}`);
      if (!uri) throw new Error('invalid_uri');

      state.ua = new SIP.UserAgent({
        uri,
        authorizationUsername: creds.user,
        authorizationPassword: creds.password,
        displayName: creds.display_name || creds.user,
        transportOptions: {
          server: creds.wss,
          // Auto-reconnect
          reconnectionAttempts: 100,
          reconnectionDelay: 4,
          keepAliveInterval: 30,
        },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: creds.iceServers || [],
            iceTransportPolicy: 'all',  // не форсим relay — у нас прямой IP
          },
        },
        logBuiltinEnabled: false,
        delegate: {
          onInvite: (invitation) => onIncomingCall(invitation),
        },
      });

      // Transport state — для auto-reconnect re-register
      state.ua.transport.stateChange.addListener((newState) => {
        if (newState === SIP.TransportState.Connected) {
          // После reconnect — restart registerer
          if (state.registerer && state.registerer.state !== SIP.RegistererState.Registered) {
            state.registerer.register().catch(() => {});
          }
        }
      });

      await state.ua.start();

      state.registerer = new SIP.Registerer(state.ua);
      state.registerer.stateChange.addListener((s) => {
        if (s === SIP.RegistererState.Registered) {
          setState('registered');
        } else if (s === SIP.RegistererState.Unregistered) {
          if (state.state === 'registered') setState('reconnecting');
        }
      });
      await state.registerer.register();

      // ──────────────────────────────────────────────────────────────
      // Resilience: 3 страховки от «Подключаемся…» после sleep ноутбука
      // ──────────────────────────────────────────────────────────────
      installResilienceHandlers();
    } catch (e) {
      console.error('[sip] init failed:', e);
      setState('error', e.message);
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Auto-reconnect — 3 источника восстановления:
  //   1. visibilitychange — возвращение во вкладку после sleep
  //   2. online — возврат сети после offline
  //   3. periodic health-check — каждые 60 сек проверка состояния
  // Раньше rely-ились только на SIP.js transport.stateChange, но
  // после долгого sleep браузер просто закрывает WS, и transport-state
  // не триггерится повторно. UA остаётся в Connected-like состоянии,
  // а реально соединения нет.
  // ──────────────────────────────────────────────────────────────
  function installResilienceHandlers() {
    if (state._resilienceInstalled) return;
    state._resilienceInstalled = true;

    const tryReconnect = (source) => {
      if (!state.ua || !state.registerer || !state.sipjs) return;
      const SIP = state.sipjs;
      const transportConnected = state.ua.transport.state === SIP.TransportState.Connected;
      const registered = state.registerer.state === SIP.RegistererState.Registered;
      if (transportConnected && registered) return;  // всё ок
      // Дебаунс — не дёргаем чаще раза в 10 сек чтобы не спамить Console
      // когда есть устойчивая проблема (зомби-контакт, зависший REGISTER)
      const now = Date.now();
      if (state._lastReconnect && (now - state._lastReconnect) < 10000) return;
      state._lastReconnect = now;
      console.log(`[sip] reconnect requested by ${source}: transport=${state.ua.transport.state}, registerer=${state.registerer.state}`);
      // Сначала пробуем мягко — re-register без пересоздания UA.
      // Если transport мёртв — ua.start() переподключит WSS.
      (async () => {
        try {
          if (!transportConnected) {
            await state.ua.reconnect();
          }
          if (!registered) {
            await state.registerer.register();
          }
        } catch (e) {
          console.warn('[sip] soft reconnect failed:', e?.message);
          // Hard fallback — полный re-init (создание нового UA).
          // setState на 'idle' разрешает init() пройти заново.
          try {
            await state.ua.stop().catch(() => {});
          } catch (_) {}
          state.ua = null;
          state.registerer = null;
          state.state = 'idle';
          init().catch(err => console.error('[sip] hard reinit failed:', err));
        }
      })();
    };

    // 1. Возврат во вкладку (после sleep ноутбука / переключения с другого таба)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        tryReconnect('visibilitychange');
      }
    });

    // 2. Возврат сети (после Wi-Fi drop / переключения с 4G на Wi-Fi)
    window.addEventListener('online', () => tryReconnect('online'));

    // 3. Periodic health-check — каждые 60 сек проверяем что мы Registered.
    //    Если нет — мягко пытаемся переподключиться.
    if (state._healthCheckInterval) clearInterval(state._healthCheckInterval);
    state._healthCheckInterval = setInterval(() => {
      if (state.state === 'in_call' || state.state === 'calling' || state.state === 'ringing') {
        return;  // во время звонка не дёргаем
      }
      tryReconnect('healthcheck');
    }, 60_000);
  }

  // ──────────────────────────────────────────────────────────────
  // OUTGOING CALL
  // ──────────────────────────────────────────────────────────────

  async function call(phone, opts) {
    if (!phone) throw new Error('phone_required');
    if (state.state === 'in_call' || state.state === 'calling') {
      throw new Error('already_in_call');
    }

    // Lazy init если ещё не пробовали
    if (state.state === 'idle' || state.state === 'error') {
      await init();
    }

    // Wait-and-retry: даём до 5 секунд на завершение регистрации.
    // Раньше throw 'not_registered' случался сразу — юзер жмёт сразу
    // после открытия страницы / после reload, init только начался,
    // registerer ещё в Connecting → мгновенный fail.
    const isReady = () => state.state === 'registered' || state.state === 'reconnecting';
    if (!isReady()) {
      // 1. Просто ждём 5 сек — может registrar успеет
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (isReady()) break;
      }
    }
    // 2. Не помогло → принудительный re-register если registerer ещё жив
    if (!isReady() && state.registerer && state.sipjs) {
      try {
        await state.registerer.register();
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 100));
          if (isReady()) break;
        }
      } catch (e) {
        console.warn('[sip] force re-register failed:', e?.message);
      }
    }
    // 3. Полный re-init как последний шанс
    if (!isReady()) {
      console.warn('[sip] hard re-init before call');
      try { if (state.ua) await state.ua.stop(); } catch (_) {}
      state.ua = null;
      state.registerer = null;
      state.state = 'idle';
      await init();
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (isReady()) break;
      }
    }
    if (!isReady()) {
      throw new Error('not_registered');
    }

    const SIP = state.sipjs;
    const digits = String(phone).replace(/[^\d]/g, '');
    const target = SIP.UserAgent.makeURI(`sip:${digits}@${state.creds.domain}`);
    if (!target) throw new Error('invalid_target');

    // callId — общий ключ для записи разговора: уходит в SIP-заголовок
    // X-Pllato-Call-Id (Asterisk назовёт им .wav), и в /sip/log (тот же id =
    // phone_calls.id). По нему запись с Asterisk потом привяжется к звонку.
    const callId = (crypto.randomUUID ? crypto.randomUUID()
      : 'c' + Date.now() + Math.random().toString(16).slice(2));

    state.callMeta = {
      phone: digits,
      customerId: opts?.customerId || null,
      dealId: opts?.dealId || null,
      contactName: opts?.contactName || digits,
      startedAt: Date.now(),
      callId,
    };

    state.session = new SIP.Inviter(state.ua, target, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
      extraHeaders: ['X-Pllato-Call-Id: ' + callId],
    });

    setupSessionHandlers(state.session);
    setState('calling');

    try {
      await state.session.invite();
    } catch (e) {
      const msg = String(e?.message || e || '');
      // «Peer connection closed» / «Request terminated» / «canceled» — это
      // НЕ ошибки, а нормальное завершение: юзер сам положил трубку до того
      // как звонок установился, или удалённая сторона отбила. SIP.js
      // reject'ит invite() в этих случаях. Не показываем юзеру алерт —
      // просто тихо чистим состояние (Terminated-handler в setupSessionHandlers
      // уже сделает логирование + auto-ping если разговор состоялся).
      const benign = /peer connection closed|request terminated|canceled|cancelled|dialog\b|terminated/i.test(msg);
      state.session = null;
      state.callMeta = null;
      if (benign) {
        setState(state.registerer && state.sipjs
          && state.registerer.state === state.sipjs.RegistererState.Registered
          ? 'registered' : 'connecting');
        return;  // не throw — вызывающий код не покажет alert
      }
      // Реальная ошибка (нет микрофона, invalid target, etc.) — пробрасываем
      setState('error', msg);
      throw e;
    }
  }

  function onIncomingCall(invitation) {
    if (state.session) {
      // Уже в звонке — отклоняем
      invitation.reject().catch(() => {});
      return;
    }
    state.session = invitation;
    const SIP = state.sipjs;
    state.callMeta = {
      phone: invitation.remoteIdentity?.uri?.user || '?',
      contactName: invitation.remoteIdentity?.displayName || invitation.remoteIdentity?.uri?.user || 'Неизвестный',
      incoming: true,
      startedAt: Date.now(),
    };
    setupSessionHandlers(invitation);
    setState('ringing');
  }

  function setupSessionHandlers(session) {
    const SIP = state.sipjs;
    session.stateChange.addListener((s) => {
      if (s === SIP.SessionState.Established) {
        attachRemoteStream(session);
        state.callMeta.startedAt = Date.now();
        setState('in_call');
      } else if (s === SIP.SessionState.Terminated) {
        state.session = null;
        const meta = state.callMeta;
        state.callMeta = null;
        state.muted = false;
        setState(state.registerer && state.registerer.state === SIP.RegistererState.Registered
          ? 'registered' : 'connecting');
        // Лог события в CRM — ВСЕГДА, не только если есть customer/deal.
        // Backend сам найдёт клиента по номеру если customerId не передан
        // (например для звонков из тестовой панели Интеграций или из набора).
        if (meta && meta.phone) {
          logCallEnded(meta).catch(() => {});
        }
      }
    });
  }

  function attachRemoteStream(session) {
    try {
      const pc = session.sessionDescriptionHandler?.peerConnection;
      if (!pc) return;
      const stream = new MediaStream();
      pc.getReceivers().forEach((r) => {
        if (r.track && r.track.kind === 'audio') stream.addTrack(r.track);
      });
      state.audioEl.srcObject = stream;
    } catch (e) {
      console.warn('[sip] attachRemoteStream:', e?.message);
    }
  }

  async function answer() {
    if (!state.session || state.state !== 'ringing') return;
    try {
      await state.session.accept({
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
        },
      });
    } catch (e) {
      console.error('[sip] answer failed:', e);
    }
  }

  async function hangup() {
    // Раньше: если state.session === null, функция молча выходила, но
    // модал-overlay оставался открытым (например когда удалённая
    // сторона повесила трубку первой — session уже null, но UI
    // остался "in_call"). Теперь даже без активной session принудительно
    // чистим UI чтобы красная кнопка ВСЕГДА закрывала модал.
    const s = state.session;
    if (s) {
      try {
        const SIP = state.sipjs;
        // SessionState проверяем через state.sipjs (ESM namespace).
        // Если по какой-то причине sipjs не загружен — fallback на bye.
        if (SIP && SIP.SessionState) {
          if (s.state === SIP.SessionState.Initial || s.state === SIP.SessionState.Establishing) {
            if (s.cancel) await s.cancel();
            else if (s.reject) await s.reject();
          } else if (s.state === SIP.SessionState.Established) {
            await s.bye();
          }
        } else if (s.bye) {
          await s.bye();
        }
      } catch (e) {
        console.warn('[sip] hangup:', e?.message);
      }
    }
    state.session = null;
    state.callMeta = null;
    state.muted = false;
    state._autoMinScheduled = false;
    // Принудительно вернуть состояние в registered/connecting — Terminated-
    // handler мог не сработать (например при ошибке bye() или если session
    // уже завершилась с другой стороны). Без этого UI остаётся залипшим
    // в "in_call" с таймером, и кнопка ничего видимо не делает.
    try {
      const SIP = state.sipjs;
      const isReg = state.registerer && SIP && SIP.RegistererState
        && state.registerer.state === SIP.RegistererState.Registered;
      setState(isReg ? 'registered' : 'connecting');
    } catch (_) {
      setState('idle');
    }
  }

  function toggleMute() {
    if (!state.session) return;
    try {
      const pc = state.session.sessionDescriptionHandler?.peerConnection;
      if (!pc) return;
      const senders = pc.getSenders();
      senders.forEach((s) => {
        if (s.track && s.track.kind === 'audio') {
          s.track.enabled = state.muted;  // инверсия
        }
      });
      state.muted = !state.muted;
      renderUi();
    } catch (e) {
      console.warn('[sip] mute:', e?.message);
    }
  }

  function dtmf(digit) {
    if (!state.session) return;
    try {
      state.session.sessionDescriptionHandler?.sendDtmf(String(digit));
    } catch (e) {
      console.warn('[sip] dtmf:', e?.message);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // STATE
  // ──────────────────────────────────────────────────────────────

  function setState(s, errMsg) {
    state.state = s;
    if (errMsg) state.errMsg = errMsg;
    renderUi();
    if (typeof state.onStateChange === 'function') {
      state.onStateChange(s);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // LOG CALL → CRM (опц.)
  // ──────────────────────────────────────────────────────────────

  async function logCallEnded(meta) {
    try {
      const token = localStorage.getItem('dentaly_token');
      const apiBase = (window.PLLATO_CONFIG && window.PLLATO_CONFIG.API_URL) || 'https://dentaly-worker.rahymstar13.workers.dev';
      const durationSec = Math.round((Date.now() - meta.startedAt) / 1000);
      await fetch(apiBase + '/api/crm/sip/log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({
          call_id: meta.callId || null,   // тот же id, что в SIP-заголовке → привязка записи
          phone: meta.phone,
          customer_id: meta.customerId,
          deal_id: meta.dealId,
          incoming: !!meta.incoming,
          duration_sec: durationSec,
          contact_name: meta.contactName,
        }),
      });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────
  // UI — floating bottom-bar + dialer overlay
  // ──────────────────────────────────────────────────────────────

  let uiEl;

  function ensureUi() {
    if (uiEl) return uiEl;
    uiEl = document.createElement('div');
    uiEl.id = 'sip-ui';
    uiEl.innerHTML = `
      <div class="sip-bar" id="sip-bar" style="display:none">
        <span class="sip-bar-dot"></span>
        <span class="sip-bar-text">—</span>
        <span class="sip-bar-timer" id="sip-bar-timer" style="display:none">0:00</span>
        <button class="sip-bar-hangup" id="sip-bar-hangup" style="display:none" title="Завершить">✕</button>
      </div>
      <div class="sip-overlay" id="sip-overlay" style="display:none">
        <div class="sip-overlay-card">
          <div class="sip-overlay-state" id="sip-overlay-state">—</div>
          <div class="sip-overlay-name" id="sip-overlay-name">—</div>
          <div class="sip-overlay-phone" id="sip-overlay-phone">—</div>
          <div class="sip-overlay-timer" id="sip-overlay-timer" style="display:none">0:00</div>
          <!-- DTMF pad — открывается при клике на dialpad-кнопку.
               Важно: тоны отправляются мгновенно при нажатии и
               отменить их нельзя — они уже долетели до IVR/АТС
               провайдера. Дисплей сверху — только визуальная
               подсказка что юзер нажимал. Кнопка «×» очищает
               дисплей чтобы не путаться при многошаговых меню. -->
          <div class="sip-dtmf-pad" id="sip-dtmf-pad" style="display:none">
            <div class="sip-dtmf-display-row">
              <div class="sip-dtmf-display" id="sip-dtmf-display"></div>
              <button class="sip-dtmf-clear" id="sip-dtmf-clear" title="Очистить дисплей (тоны уже отправлены)">×</button>
            </div>
            <div class="sip-dtmf-grid">
              ${['1','2','3','4','5','6','7','8','9','*','0','#'].map(d =>
                `<button class="sip-dtmf-key" data-digit="${d}">${d}</button>`).join('')}
            </div>
          </div>
          <div class="sip-overlay-actions">
            <button class="sip-btn sip-btn-mute" id="sip-btn-mute" title="Mute">${window.icon ? window.icon('mic', { size: 22 }) : '🎙'}</button>
            <button class="sip-btn sip-btn-dtmf" id="sip-btn-dtmf" title="Набор цифр (DTMF)">${window.icon ? window.icon('dialpad', { size: 22 }) : '🔢'}</button>
            <button class="sip-btn sip-btn-min" id="sip-btn-min" title="Свернуть">${window.icon ? window.icon('minimize', { size: 22 }) : '−'}</button>
            <button class="sip-btn sip-btn-hangup-overlay" id="sip-btn-hangup-overlay" title="Положить трубку">${window.icon ? window.icon('phone', { size: 22 }) : '📵'}</button>
            <button class="sip-btn sip-btn-answer" id="sip-btn-answer" style="display:none" title="Ответить">${window.icon ? window.icon('phone', { size: 22 }) : '📞'}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(uiEl);

    document.getElementById('sip-bar-hangup').onclick = hangup;
    document.getElementById('sip-btn-hangup-overlay').onclick = hangup;
    document.getElementById('sip-btn-mute').onclick = toggleMute;
    document.getElementById('sip-btn-answer').onclick = answer;
    document.getElementById('sip-btn-min').onclick = () => {
      document.getElementById('sip-overlay').style.display = 'none';
    };

    // Backdrop click — клик мимо card сворачивает overlay (как в обычных
    // модалках). Звонок при этом НЕ завершается — только UI скрывается,
    // в bottom-bar остаётся pill с таймером и красной X для hangup.
    // Если юзер случайно повторно открыл модалку (через клик на bar),
    // он сможет её свернуть обратно одним кликом мимо.
    document.getElementById('sip-overlay').onclick = (e) => {
      // Игнорируем клики внутри card — иначе обычные кнопки тоже
      // будут закрывать overlay.
      if (e.target.id === 'sip-overlay') {
        e.currentTarget.style.display = 'none';
      }
    };

    // DTMF — toggle панели + клик по цифре отправляет тон.
    // Тоны нужны для голосовых меню (IVR) типа «нажмите 1 для отдела продаж».
    const dtmfBtn = document.getElementById('sip-btn-dtmf');
    const dtmfPad = document.getElementById('sip-dtmf-pad');
    const dtmfDisplay = document.getElementById('sip-dtmf-display');
    dtmfBtn.onclick = () => {
      const willShow = dtmfPad.style.display === 'none';
      dtmfPad.style.display = willShow ? 'block' : 'none';
      dtmfBtn.classList.toggle('sip-btn-active', willShow);
      if (willShow) dtmfDisplay.textContent = '';
    };
    dtmfPad.querySelectorAll('.sip-dtmf-key').forEach(key => {
      key.onclick = () => {
        const d = key.dataset.digit;
        dtmf(d);
        dtmfDisplay.textContent = (dtmfDisplay.textContent + d).slice(-12);
      };
    });
    // Кнопка «×» — очистка дисплея. ВНИМАНИЕ: тоны уже отправлены
    // в IVR в момент нажатия, отменить их невозможно. Эта кнопка
    // только визуальная — сбрасывает «след» нажатий чтобы юзер не
    // путался на следующем шаге голосового меню.
    document.getElementById('sip-dtmf-clear').onclick = () => {
      dtmfDisplay.textContent = '';
    };
    document.getElementById('sip-bar').onclick = (e) => {
      if (e.target.id === 'sip-bar-hangup') return;
      document.getElementById('sip-overlay').style.display = 'flex';
    };

    return uiEl;
  }

  let timerInterval;

  function renderUi() {
    ensureUi();
    const bar = document.getElementById('sip-bar');
    const overlay = document.getElementById('sip-overlay');
    const barText = bar.querySelector('.sip-bar-text');
    const barDot = bar.querySelector('.sip-bar-dot');
    const barTimer = document.getElementById('sip-bar-timer');
    const barHangup = document.getElementById('sip-bar-hangup');

    const labels = {
      idle: { txt: '—', cls: 'idle', show: false },
      connecting: { txt: 'Подключаемся…', cls: 'connecting', show: true },
      registered: { txt: 'Готов к звонкам', cls: 'ready', show: true },
      calling: { txt: 'Соединяемся…', cls: 'calling', show: true },
      ringing: { txt: 'Входящий звонок', cls: 'ringing', show: true },
      in_call: { txt: 'Разговор', cls: 'in-call', show: true },
      reconnecting: { txt: 'Переподключение…', cls: 'connecting', show: true },
      // Ошибки прячем — нет смысла пугать юзера если SIP опционален
      error: { txt: '', cls: 'error', show: false },
    };
    const l = labels[state.state] || labels.idle;
    bar.style.display = l.show ? 'flex' : 'none';
    bar.className = 'sip-bar sip-bar-' + l.cls;
    barText.textContent = l.txt;

    // Overlay show только в активных состояниях
    const showOverlay = state.state === 'ringing' || state.state === 'in_call' || state.state === 'calling';
    if (showOverlay && state.callMeta) {
      overlay.style.display = 'flex';
      document.getElementById('sip-overlay-state').textContent = l.txt;
      document.getElementById('sip-overlay-name').textContent = state.callMeta.contactName || '—';
      document.getElementById('sip-overlay-phone').textContent = '+' + (state.callMeta.phone || '');
      // Auto-minimize при Established (через 700ms)
      if (state.state === 'in_call' && !state._autoMinScheduled) {
        state._autoMinScheduled = true;
        setTimeout(() => {
          if (state.state === 'in_call') overlay.style.display = 'none';
        }, 700);
      }
    } else {
      overlay.style.display = 'none';
      state._autoMinScheduled = false;
    }

    // Mute button visual
    const muteBtn = document.getElementById('sip-btn-mute');
    if (muteBtn) muteBtn.classList.toggle('sip-btn-active', state.muted);

    // Answer button — только для ringing
    document.getElementById('sip-btn-answer').style.display =
      state.state === 'ringing' ? 'inline-flex' : 'none';

    // Timer
    if (state.state === 'in_call') {
      barTimer.style.display = '';
      barHangup.style.display = '';
      if (!timerInterval) {
        timerInterval = setInterval(updateTimer, 1000);
        updateTimer();
      }
    } else {
      barTimer.style.display = 'none';
      barHangup.style.display = state.state === 'calling' || state.state === 'ringing' ? '' : 'none';
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }
  }

  function updateTimer() {
    if (!state.callMeta) return;
    const sec = Math.floor((Date.now() - state.callMeta.startedAt) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const text = m + ':' + String(s).padStart(2, '0');
    const el1 = document.getElementById('sip-bar-timer');
    const el2 = document.getElementById('sip-overlay-timer');
    if (el1) el1.textContent = text;
    if (el2) { el2.textContent = text; el2.style.display = ''; }
  }

  // ──────────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────────

  window.SipClient = {
    init,
    call,
    hangup,
    answer,
    toggleMute,
    dtmf,
    get state() { return state.state; },
    get isReady() { return state.state === 'registered' || state.state === 'in_call'; },
  };

  // Простой helper для inline onclick в карточках:
  //   <button onclick="event.stopPropagation(); window.placeCall({phone:'77011234567',customerId:'...'})">📞</button>
  window.placeCall = async function (opts) {
    try {
      await window.SipClient.call(opts.phone, opts);
    } catch (e) {
      alert('Не удалось позвонить: ' + (e.message || e));
    }
  };
})();
