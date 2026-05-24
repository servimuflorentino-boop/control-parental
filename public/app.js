/* ==========================================================================
   LÓGICA DEL FRONTEND - CONTROL PARENTAL Y SIMULADOR REAL-TIME
   ========================================================================== */

// --- ESTADOS GLOBALES ---
let appRules = [];
let childProfile = null;
let alerts = [];
let installRequests = [];
let sseSource = null;

// Ubicación GPS simulada
let gpsLat = -12.0463;
let gpsLng = -77.0310;
let isOutsideGeofence = false;

// Estado del simulador del menor
let childActiveApp = null;
let childUsageTimer = null;
const ACCELERATED_TIME_INTERVAL = 2000; // 2 segundos reales = 1 minuto de uso simulado

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  // Inicializar Iconos Lucide
  lucide.createIcons();

  // Cargar estado inicial desde la API del Servidor
  loadStatus();

  // Conectar canal de eventos en tiempo real SSE
  connectSSE();

  // Actualizar hora en el simulador celular cada segundo
  setInterval(updateSimulatedClock, 1000);
});

// --- CARGAR DATOS CONSOLIDADO ---
async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    const data = await response.json();

    appRules = data.appRules;
    childProfile = data.child;
    alerts = data.alerts;
    installRequests = data.installRequests;

    // Renderizar componentes
    renderParentRules();
    renderParentInstallations();
    renderParentAlerts();
    renderParentWebAlerts();
    renderChildDashboard();
    updateGPSUI();

  } catch (error) {
    console.error('Error al sincronizar con el servidor local:', error);
  }
}

// --- CONECTAR SERVER-SENT EVENTS (SSE) INTRANET ---
function connectSSE() {
  if (sseSource) {
    sseSource.close();
  }

  sseSource = new EventSource('/api/events');

  sseSource.onmessage = (event) => {
    try {
      const { type, payload } = JSON.parse(event.data);
      console.log(`Evento SSE Recibido: ${type}`, payload);

      if (type === 'SCREEN_LOCKED') {
        childProfile.is_locked = payload.is_locked;
        renderChildDashboard();
      } else if (type === 'APP_RULES_UPDATED') {
        appRules = payload.appRules;
        renderParentRules();
        renderChildDashboard();
        // Si la app activa del niño fue bloqueada u ocultada en vivo, cerrarla
        if (childActiveApp) {
          const rule = appRules.find(r => r.name.toLowerCase() === childActiveApp.toLowerCase());
          if (rule && (rule.is_blocked || (rule.limit_minutes > 0 && rule.used_minutes_today >= rule.limit_minutes))) {
            closeSimApp();
            triggerAdminOverlay(`Regla de uso activada. ${rule.name} bloqueada por tus padres.`);
          }
        }
      } else if (type === 'BEDTIME_UPDATED') {
        childProfile = payload.child;
        renderChildDashboard();
      } else if (type === 'INSTALL_REQUESTED') {
        installRequests.unshift(payload);
        renderParentInstallations();
        playParentNotificationSound();
      } else if (type === 'INSTALL_DECIDED') {
        installRequests = installRequests.filter(r => r.id !== payload.request_id);
        appRules = payload.appRules;
        renderParentInstallations();
        renderParentRules();
        renderChildDashboard();
        
        // Resetear botón de instalación en la Play Store simulada
        const btn = document.getElementById('btn-store-install');
        if (btn) {
          if (payload.status === 'APROBADA') {
            btn.textContent = "Instalado";
            btn.className = "btn-store-install approved";
            btn.disabled = true;
          } else {
            btn.textContent = "Rechazado";
            btn.className = "btn-store-install rejected";
            btn.disabled = false;
          }
        }
      } else if (type === 'ALERT_TRIGGERED') {
        alerts.unshift(payload);
        renderParentAlerts();
        renderParentWebAlerts();
        playParentAlarmSound();
      } else if (type === 'CHILD_STATUS_UPDATED') {
        childProfile = payload.child;
        if (payload.appRules) appRules = payload.appRules;
        renderParentRules();
        renderChildDashboard();
      }
    } catch (e) {
      console.error('Error procesando evento SSE:', e);
    }
  };

  sseSource.onerror = () => {
    console.warn('SSE Desconectado. Reconectando...');
  };
}

// --- RENDERIZADO: MÓDULO DEL PADRE ---

// 1. Tabla de Reglas y Límites
function renderParentRules() {
  const tbody = document.getElementById('app-rules-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  appRules.forEach(rule => {
    const tr = document.createElement('tr');
    
    // Asignar color de fondo al icono de la tabla según app
    const appColorClass = getAppColorClass(rule.name);
    const iconName = getAppIconName(rule.name);

    tr.innerHTML = `
      <td>
        <div class="app-info-cell">
          <div class="table-app-icon ${appColorClass}">
            <i data-lucide="${iconName}"></i>
          </div>
          <div>
            <strong>${rule.name}</strong>
            <div style="font-size:11px; color:var(--text-muted);">Uso de hoy: ${rule.used_minutes_today} min</div>
          </div>
        </div>
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" ${rule.is_blocked ? '' : 'checked'} onchange="toggleAppVisibility(${rule.id}, this)">
          <span class="slider"></span>
        </label>
        <span style="font-size:11px; margin-left:8px; color:${rule.is_blocked ? 'var(--color-red)' : 'var(--color-emerald)'}">
          ${rule.is_blocked ? 'Oculta' : 'Visible'}
        </span>
      </td>
      <td>
        <div class="limit-input-wrapper">
          <input type="number" id="limit-input-${rule.id}" value="${rule.limit_minutes}" min="0" max="480">
          <span style="font-size:11px; color:var(--text-muted)">min</span>
        </div>
      </td>
      <td>
        <label class="switch">
          <input type="checkbox" id="bully-check-${rule.id}" ${rule.bully_monitoring ? 'checked' : ''} ${isBullyAppSupported(rule.name) ? '' : 'disabled'}>
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <button class="btn-save-row" onclick="saveAppRuleSettings(${rule.id})" title="Guardar cambios">
          <i data-lucide="check"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  lucide.createIcons();
}

// 2. Solicitudes de Instalación
function renderParentInstallations() {
  const container = document.getElementById('install-requests-container');
  if (!container) return;

  const pending = installRequests.filter(r => r.status === 'PENDIENTE');

  if (pending.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i data-lucide="inbox"></i>
        <p>No hay solicitudes de instalación pendientes.</p>
      </div>
    `;
    document.getElementById('install-badge').classList.add('hidden');
    lucide.createIcons();
    return;
  }

  // Actualizar indicador visual superior
  const badge = document.getElementById('install-badge');
  badge.textContent = pending.length;
  badge.classList.remove('hidden');

  container.innerHTML = '';
  pending.forEach(req => {
    const card = document.createElement('div');
    card.className = 'install-card';
    card.innerHTML = `
      <div class="card-header-app">
        <div class="store-card-icon"><i data-lucide="gamepad-2"></i></div>
        <div class="card-app-details">
          <h4>${req.app_name}</h4>
          <span>Solicitado el: ${req.timestamp}</span>
        </div>
      </div>
      <div class="checkbox-group">
        <input type="checkbox" id="install-bully-check-${req.id}" checked>
        <label for="install-bully-check-${req.id}">Monitorear conversaciones anti-bullying</label>
      </div>
      <div class="card-actions-row">
        <button class="btn-approve" onclick="decideInstallation(${req.id}, 'APROBADA')">Aprobar</button>
        <button class="btn-deny" onclick="decideInstallation(${req.id}, 'RECHAZADA')">Denegar</button>
      </div>
    `;
    container.appendChild(card);
  });
  lucide.createIcons();
}

// 3. Alertas de Bullying y Chats
function renderParentAlerts() {
  const container = document.getElementById('bullying-alerts-container');
  if (!container) return;

  const bullyAlerts = alerts.filter(a => a.type === 'BULLYING');

  if (bullyAlerts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="smile"></i>
        <p>Ambiente seguro. No se han detectado conversaciones hostiles.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = '';
  bullyAlerts.forEach(alert => {
    const card = document.createElement('div');
    card.className = 'bullying-card';
    
    // Thumbnail de la captura de pantalla
    const imgHtml = alert.screenshot_path
      ? `<img src="${alert.screenshot_path}" alt="Evidencia de pantalla">`
      : `<div style="font-size:10px; color:var(--text-muted)">Grabación no disponible</div>`;

    card.innerHTML = `
      <div class="bullying-card-header">
        <span class="threat-badge"><i data-lucide="alert-triangle" style="width:10px; height:10px; display:inline; margin-right:4px;"></i> AMENAZA DETECTADA</span>
        <small style="color:var(--text-muted); font-size:11px;">${alert.timestamp}</small>
      </div>
      <div class="bullying-body">
        <div class="bullying-text-log">
          <strong>Tipo de Incidencia:</strong>
          <p style="margin-top:6px; color:#fca5a5;">${alert.description}</p>
        </div>
        <div class="bullying-screen-capture">
          ${imgHtml}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
  lucide.createIcons();
}

// 4. Alertas de Navegación Web Silenciosas
function renderParentWebAlerts() {
  const tbody = document.getElementById('web-alerts-body');
  if (!tbody) return;

  const webAlerts = alerts.filter(a => a.type === 'WEB_ADULT');

  if (webAlerts.length === 0) {
    tbody.innerHTML = `
      <tr class="empty-row-web">
        <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 30px 10px;">
          Sin alertas de navegación registradas.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  webAlerts.forEach(alert => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color:#fca5a5; padding: 2px 8px; border-radius:10px; font-size:10px; font-weight:600;">CONTENIDO ADULTO / GORE</span></td>
      <td><code style="color:white;">${alert.description}</code></td>
      <td style="color:var(--text-muted); font-size:12px;">${alert.timestamp}</td>
    `;
    tbody.appendChild(tr);
  });
}

// --- INTERCAMBIO DE PESTAÑAS (PADRE) ---
function switchTab(tabId) {
  document.querySelectorAll('.tab-link').forEach(btn => {
    btn.classList.remove('active');
  });
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.remove('active');
  });

  const activeBtn = Array.from(document.querySelectorAll('.tab-link')).find(btn => btn.getAttribute('onclick').includes(tabId));
  if (activeBtn) activeBtn.classList.add('active');

  const pane = document.getElementById(tabId);
  if (pane) pane.classList.add('active');
}

// --- ACCIONES ADMINISTRATIVAS DEL PADRE ---

// Bloqueo total manual (Emergencia)
async function toggleEmergencyLock() {
  if (!childProfile) return;
  
  const currentLock = childProfile.is_locked;
  const newLock = currentLock === 1 ? 0 : 1;

  try {
    const response = await fetch('/api/emergency-lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_locked: newLock })
    });
    
    if (!response.ok) throw new Error('Error de red');
    const data = await response.json();
    childProfile = data.child;

    renderChildDashboard();
  } catch (e) {
    alert('Error al comunicar bloqueo con el celular del menor.');
  }
}

// Bloquear visibilidad de iconos
async function toggleAppVisibility(appId, checkbox) {
  const is_blocked = checkbox.checked ? 0 : 1; // Checked significa NO bloqueado (visible)

  try {
    const response = await fetch('/api/app-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, is_blocked })
    });
    if (!response.ok) throw new Error('Error al guardar regla');
  } catch (e) {
    alert('No se pudo aplicar el bloqueo en caliente.');
    checkbox.checked = !checkbox.checked; // Revertir visual
  }
}

// Guardar límites de aplicación y monitoreo
async function saveAppRuleSettings(appId) {
  const limitVal = parseInt(document.getElementById(`limit-input-${appId}`).value) || 0;
  const bullyCheck = document.getElementById(`bully-check-${appId}`);
  const bully_monitoring = bullyCheck && bullyCheck.checked ? 1 : 0;

  try {
    const response = await fetch('/api/app-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, limit_minutes: limitVal, bully_monitoring })
    });
    
    if (!response.ok) throw new Error('Error en el servidor');
    
    alert('Reglas de aplicación y tiempos guardados con éxito.');
  } catch (e) {
    alert('Error al sincronizar límites de tiempo.');
  }
}

// Guardar bedtime
async function saveBedtime(event) {
  event.preventDefault();
  const bedtime_start = document.getElementById('bedtime-start').value;
  const bedtime_end = document.getElementById('bedtime-end').value;

  try {
    const response = await fetch('/api/bedtime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bedtime_start, bedtime_end })
    });
    if (!response.ok) throw new Error();
    alert('Horario nocturno registrado correctamente.');
  } catch (e) {
    alert('Error al programar horario.');
  }
}

// Aprobar o denegar instalación
async function decideInstallation(requestId, status) {
  const bullyCheckbox = document.getElementById(`install-bully-check-${requestId}`);
  const bully_monitoring = bullyCheckbox && bullyCheckbox.checked;

  try {
    const response = await fetch('/api/installation-approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, status, bully_monitoring })
    });
    if (!response.ok) throw new Error();
  } catch (e) {
    alert('Error al enviar respuesta de instalación.');
  }
}

// --- RENDERIZADO: CELULAR DEL MENOR (SIMULADOR) ---

function renderChildDashboard() {
  if (!childProfile) return;

  const chassis = document.querySelector('.smartphone-chassis');
  const lockScreen = document.getElementById('phone-lock-screen');
  const homeScreen = document.getElementById('phone-home-screen');
  const emergencyBtn = document.getElementById('btn-emergency-lock');
  const emergencyText = document.getElementById('emergency-btn-text');

  // 1. Determinar si debe mostrarse la pantalla de bloqueo total
  // Bloqueo activo por botón, o por exceder el límite diario
  const hasExceededDailyLimit = childProfile.used_minutes_today >= childProfile.daily_limit_minutes;
  const isTimeLocked = isBedtimeActive();

  const isLockScreenActive = childProfile.is_locked === 1 || hasExceededDailyLimit || isTimeLocked;

  if (isLockScreenActive) {
    lockScreen.style.display = 'flex';
    homeScreen.classList.remove('active');
    chassis.classList.add('phone-locked-glow');

    // Cambiar etiquetas en la pantalla de bloqueo según motivo
    const lockTitle = document.getElementById('lock-screen-title');
    const lockMsg = document.getElementById('lock-screen-msg');

    if (childProfile.is_locked === 1) {
      lockTitle.textContent = "Bloqueo de Emergencia";
      lockMsg.textContent = "Activado por tus padres de forma inmediata.";
    } else if (hasExceededDailyLimit) {
      lockTitle.textContent = "Límite Diario Agotado";
      lockMsg.textContent = `Consumiste tus ${childProfile.daily_limit_minutes} minutos diarios de uso.`;
    } else if (isTimeLocked) {
      lockTitle.textContent = "Hora de Dormir / Estudio";
      lockMsg.textContent = `Restricción programada activa (${childProfile.bedtime_start} - ${childProfile.bedtime_end}).`;
    }

    // Si estaba jugando una app, cerrarla
    if (childActiveApp) {
      closeSimApp();
    }
  } else {
    lockScreen.style.display = 'none';
    homeScreen.classList.add('active');
    chassis.classList.remove('phone-locked-glow');
  }

  // 2. Sincronizar el botón del Padre
  if (childProfile.is_locked === 1) {
    emergencyBtn.className = "btn-emergency locked-active";
    emergencyText.textContent = "Desbloquear Celular";
  } else {
    emergencyBtn.className = "btn-emergency";
    emergencyText.textContent = "Bloquear Celular";
  }

  // 3. Sincronizar visibilidad de iconos en el escritorio en vivo (Ocultamiento en caliente)
  appRules.forEach(rule => {
    const appEl = document.getElementById(`app-${getAppElementId(rule.name)}`);
    if (appEl) {
      if (rule.is_blocked === 1) {
        appEl.classList.add('hidden-blocked');
      } else {
        appEl.classList.remove('hidden-blocked');
      }
    }
  });

  // Mostrar el tiempo de uso diario consumido en la barra superior
  document.getElementById('sim-time').textContent = `${childProfile.used_minutes_today}m / ${childProfile.daily_limit_minutes}m`;
}

// --- FUNCIONES NAVEGABLES DEL CELULAR SIMULADO ---

// Abrir una sub-aplicación dentro del teléfono
function openSimApp(appName) {
  // Comprobar si está bloqueado total, excepto para apps de emergencia
  const hasExceededDailyLimit = childProfile.used_minutes_today >= childProfile.daily_limit_minutes;
  const isTimeLocked = isBedtimeActive();
  const isCurrentlyLocked = childProfile.is_locked === 1 || hasExceededDailyLimit || isTimeLocked;

  if (isCurrentlyLocked && !['phone', 'camera'].includes(appName)) {
    triggerAdminOverlay("Dispositivo bloqueado. Solo llamadas de emergencia y cámara habilitadas.");
    return;
  }

  // Comprobar si la app está restringida por regla individual de ocultamiento (Anti-Evasión)
  const rule = appRules.find(r => r.name.toLowerCase() === appName.toLowerCase());
  if (rule) {
    if (rule.is_blocked === 1) {
      triggerAdminOverlay(`Regla Parental Activa: El escritorio ha ocultado ${rule.name}. Ejecución bloqueada.`);
      return;
    }

    // Comprobar si excedió su propio límite de tiempo
    if (rule.limit_minutes > 0 && rule.used_minutes_today >= rule.limit_minutes) {
      triggerAdminOverlay(`Límite Agotado: Excediste los ${rule.limit_minutes} minutos diarios asignados a ${rule.name}.`);
      return;
    }
  }

  // Ocultar home screen
  document.getElementById('phone-home-screen').classList.remove('active');
  document.getElementById('phone-lock-screen').style.display = 'none';

  // Ocultar otras vistas
  document.querySelectorAll('.sim-app-view').forEach(view => {
    view.style.display = 'none';
  });

  // Mostrar la app seleccionada
  const appView = document.getElementById(`app-view-${appName}`);
  if (appView) {
    appView.style.display = 'flex';
    childActiveApp = appName;

    // Si es WhatsApp o Chrome, reiniciar a sus estados iniciales
    if (appName === 'whatsapp') {
      document.getElementById('whatsapp-chat-box').innerHTML = `
        <div class="msg-bubble incoming">
          <span>Hola Matias, ¿estarás en el parque luego?</span>
          <small>15:00</small>
        </div>
      `;
    } else if (appName === 'chrome') {
      loadWebpage('google.com', 'SAFE');
    }

    // Iniciar conteo de minutos de uso simulado acelerados
    startAppUsageTimer(rule);
  }
}

// Cerrar aplicación y volver al escritorio
function closeSimApp() {
  stopAppUsageTimer();

  // Ocultar vistas de apps
  document.querySelectorAll('.sim-app-view').forEach(view => {
    view.style.display = 'none';
  });

  childActiveApp = null;
  renderChildDashboard();
}

// --- TEMPORIZADORES DE USO DEL CELULAR ---

function startAppUsageTimer(rule) {
  stopAppUsageTimer();

  childUsageTimer = setInterval(async () => {
    if (!childProfile) return;

    // Aumentar minutos de uso
    const newTotalMinutes = childProfile.used_minutes_today + 1;
    
    const appUsagePayload = [];
    if (rule) {
      const newAppMinutes = rule.used_minutes_today + 1;
      rule.used_minutes_today = newAppMinutes;
      appUsagePayload.push({
        package_name: rule.package_name,
        used_minutes_today: newAppMinutes
      });

      // Si la aplicación llegó a su límite, disparar bloqueo y cerrarla
      if (rule.limit_minutes > 0 && newAppMinutes >= rule.limit_minutes) {
        closeSimApp();
        triggerAdminOverlay(`Límite Superado: Tiempo asignado a ${rule.name} terminado.`);
        await reportChildUsage(newTotalMinutes, appUsagePayload);
        return;
      }
    }

    // Reportar uso diario al servidor
    await reportChildUsage(newTotalMinutes, appUsagePayload);

    // Si el total excede el límite general diario
    if (newTotalMinutes >= childProfile.daily_limit_minutes) {
      closeSimApp();
      triggerAdminOverlay("Límite diario agotado. Celular bloqueado por Administración.");
    }

  }, ACCELERATED_TIME_INTERVAL);
}

function stopAppUsageTimer() {
  if (childUsageTimer) {
    clearInterval(childUsageTimer);
    childUsageTimer = null;
  }
}

async function reportChildUsage(totalMinutes, appUsage) {
  try {
    const response = await fetch('/api/child-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        used_minutes_today: totalMinutes,
        app_usage: appUsage,
        gps_lat: gpsLat,
        gps_lng: gpsLng
      })
    });
    const data = await response.json();
    childProfile = data.child;
    
    // Actualizar barras
    document.getElementById('sim-time').textContent = `${childProfile.used_minutes_today}m / ${childProfile.daily_limit_minutes}m`;
  } catch (e) {
    console.error('Error reportando estadísticas de uso.');
  }
}

// --- COMPROBADORES HORARIOS (BEDTIME) ---
function isBedtimeActive() {
  if (!childProfile || !childProfile.bedtime_start || !childProfile.bedtime_end) return false;

  const now = new Date();
  const currentHourMin = now.toTimeString().slice(0, 5); // HH:MM

  const start = childProfile.bedtime_start;
  const end = childProfile.bedtime_end;

  if (start < end) {
    return currentHourMin >= start && currentHourMin <= end;
  } else {
    // Cruza la medianoche (ej. 21:00 a 06:00)
    return currentHourMin >= start || currentHourMin <= end;
  }
}

// --- SIMULACIÓN DE SEGURIDAD EN CHATS (CYBERBULLYING & GRABACIÓN) ---

function sendSimChatMessage(text) {
  const chatBox = document.getElementById('whatsapp-chat-box');
  
  // Agregar burbuja del hijo
  const time = new Date().toTimeString().slice(0, 5);
  const bubble = document.createElement('div');
  bubble.className = "msg-bubble outgoing";
  bubble.innerHTML = `
    <span>${text}</span>
    <small>${time}</small>
  `;
  chatBox.appendChild(bubble);
  chatBox.scrollTop = chatBox.scrollHeight;

  // Palabras claves disparadoras de lenguaje violento
  const triggers = ['idiota', 'golpear', 'muérete', 'matar', 'amenaza'];
  const hasTrigger = triggers.some(word => text.toLowerCase().includes(word));

  // Verificar si la aplicación WhatsApp tiene activado el Monitoreo de Cyberbullying
  const whatsappRule = appRules.find(r => r.name === 'WhatsApp');
  const isMonitored = whatsappRule && whatsappRule.bully_monitoring === 1;

  if (hasTrigger && isMonitored) {
    // 1. Activar efectos visuales de GRABACIÓN DE PANTALLA en el celular
    const recordBar = document.getElementById('screen-recording-indicator');
    recordBar.classList.remove('hidden');

    // Sonido sutil de alerta
    playNotificationClickSound();

    // 2. Simular captura de pantalla dinámica en canvas (dibujo visual)
    setTimeout(async () => {
      recordBar.classList.add('hidden');
      
      // Dibujar un canvas con la evidencia
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 120;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 300, 120);
      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('EVIDENCIA DE PANTALLA - WHATSAPP', 15, 25);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px sans-serif';
      ctx.fillText('Remitente: Matias (Celular Hijo)', 15, 50);
      ctx.fillStyle = '#fca5a5';
      ctx.fillText(`Mensaje: "${text.substring(0, 30)}..."`, 15, 75);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('Captura de auditoría interna de red.', 15, 100);

      const base64Img = canvas.toDataURL('image/jpeg');

      // 3. Reportar alerta crítica de Cyberbullying al Padre
      try {
        await fetch('/api/alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'BULLYING',
            description: `Matias envió mensaje amenazante/bullying en WhatsApp: "${text}"`,
            image_base64: base64Img
          })
        });
      } catch (e) {
        console.error('Error al registrar alerta de cyberbullying:', e);
      }
    }, 1600);
  }
}

// --- SIMULACIÓN DE NAVEGACIÓN WEB (ALERTAS SILENCIOSAS) ---

async function loadWebpage(url, category) {
  document.getElementById('chrome-url').value = url;
  const container = document.getElementById('chrome-page-container');

  if (url === 'google.com') {
    container.innerHTML = `
      <h3>Buscador Google</h3>
      <p>Navega de forma libre. Filtros silenciosos activos.</p>
      <div class="nav-links">
        <button onclick="loadWebpage('wikipedia.org', 'SAFE')">Wikipedia (Educativo)</button>
        <button onclick="loadWebpage('xxx-portal-adultos.com', 'WEB_ADULT')" class="btn-web-adult">Página Exclusiva Adultos</button>
        <button onclick="loadWebpage('gore-ejecuciones-foro.ru', 'WEB_ADULT')" class="btn-web-gore">Vídeos Gore y Maltrato</button>
      </div>
    `;
    return;
  }

  if (category === 'SAFE') {
    container.innerHTML = `
      <h3 style="color:var(--color-emerald)">Wikipedia Española</h3>
      <p style="font-size:11px; margin-top:6px;">Wikipedia es una enciclopedia libre, políglota y editada de manera colaborativa...</p>
      <button onclick="loadWebpage('google.com', 'SAFE')" style="margin-top:14px; background:rgba(255,255,255,0.05); border:1px solid var(--border-glass); color:white; padding:6px 12px; border-radius:6px; cursor:pointer;">Volver</button>
    `;
  } else if (category === 'WEB_ADULT') {
    // El menor navega libremente sin saber que se le está reportando
    container.innerHTML = `
      <h3 style="color:var(--color-red)">${url}</h3>
      <p style="font-size:10px; margin-top:6px; color:#fca5a5;">Contenido cargado en el navegador del menor correctamente.</p>
      <div style="width:100%; height:60px; background:#222; border-radius:6px; margin-top:10px; display:flex; align-items:center; justify-content:center; font-size:10px; color:var(--text-muted);">[ Reproductor de Vídeo ]</div>
      <button onclick="loadWebpage('google.com', 'SAFE')" style="margin-top:14px; background:rgba(255,255,255,0.05); border:1px solid var(--border-glass); color:white; padding:6px 12px; border-radius:6px; cursor:pointer;">Volver</button>
    `;

    // Reportar alerta silenciosa al padre
    try {
      await fetch('/api/alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'WEB_ADULT',
          description: `Matias accedió a URL con contenido restringido: ${url}`,
          image_base64: null
        })
      });
    } catch (e) {
      console.error('Error reportando alerta web:', e);
    }
  }
}

// --- SOLICITUD DE INSTALACIÓN DESDE CELULAR (PLAY STORE) ---

async function requestInstall(appName) {
  const btn = document.getElementById('btn-store-install');
  if (!btn) return;

  btn.textContent = "Esperando Aprobación...";
  btn.className = "btn-store-install waiting";
  btn.disabled = true;

  try {
    const response = await fetch('/api/installation-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_name: appName })
    });
    if (!response.ok) throw new Error();
    
    triggerAdminOverlay(`Solicitud enviada a tus padres para instalar ${appName}. Espera su decisión.`);
  } catch (e) {
    alert('Error al enviar solicitud a tus padres.');
    btn.textContent = "Instalar";
    btn.className = "btn-store-install";
    btn.disabled = false;
  }
}

// --- SEGURIDAD: EVITAR DESACTIVACIÓN DE DATOS O MODO AVIÓN ---
function toggleChildNetwork(type) {
  if (type === 'data') {
    triggerAdminOverlay("Seguridad de Red: No puedes desactivar los datos móviles de este dispositivo.");
  } else if (type === 'airplane') {
    triggerAdminOverlay("Acción Restringida: El Modo Avión ha sido inhabilitado por tus padres.");
  }
}

// Bloqueos de ajustes generales
function triggerSettingsBlocked(feature) {
  triggerAdminOverlay(`Seguridad de Administración: Acceso bloqueado a '${feature}'.`);
}

// --- OVERLAYS Y MODALES DEL CELULAR ---

function triggerAdminOverlay(messageText) {
  const overlay = document.getElementById('sim-admin-overlay');
  const textEl = document.getElementById('sim-admin-text');
  if (overlay && textEl) {
    textEl.textContent = messageText;
    overlay.classList.remove('hidden');
    playNotificationClickSound();
  }
}

function dismissAdminOverlay() {
  const overlay = document.getElementById('sim-admin-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

// Simulación de disparo de cámara
function triggerSimCameraShot() {
  const chassis = document.querySelector('.smartphone-chassis');
  chassis.style.filter = "brightness(2)";
  setTimeout(() => {
    chassis.style.filter = "none";
  }, 150);
}

// --- MAPA GPS INTERACTIVO & GEOCERCAS ---

function handlePinDrag(event) {
  // Solo simulación visual de arrastre
}

async function handlePinDragEnd(event) {
  const mapContainer = document.querySelector('.simulated-map-container');
  const rect = mapContainer.getBoundingClientRect();
  const pin = document.getElementById('child-gps-pin');

  // Calcular nueva posición relativa dentro del mapa simulado
  let newLeft = event.clientX - rect.left;
  let newTop = event.clientY - rect.top;

  // Ajustar límites
  newLeft = Math.max(20, Math.min(rect.width - 20, newLeft));
  newTop = Math.max(20, Math.min(rect.height - 20, newTop));

  pin.style.left = `${newLeft}px`;
  pin.style.top = `${newTop}px`;

  // Calcular distancia desde el centro del mapa (donde está la geocerca de la Escuela)
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const distance = Math.sqrt(Math.pow(newLeft - centerX, 2) + Math.pow(newTop - centerY, 2));

  // Geocerca radio escolar aproximado de 130px
  const schoolGeofenceCircle = document.querySelector('.geofence-circle');
  const statusBadge = document.getElementById('gps-status-badge');

  // Simular cambio de coordenadas
  gpsLat = -12.0463 + ((centerY - newTop) * 0.0001);
  gpsLng = -77.0310 + ((newLeft - centerX) * 0.0001);
  document.getElementById('gps-coords-display').textContent = `Lat: ${gpsLat.toFixed(5)}, Lng: ${gpsLng.toFixed(5)}`;

  if (distance > 130) {
    // SALIÓ DE LA GEOCERCA
    schoolGeofenceCircle.classList.add('violated');
    statusBadge.textContent = "¡FUERA DE ESCUELA!";
    statusBadge.className = "badge-status-red";
    isOutsideGeofence = true;

    // Reportar alerta de geocerca al padre
    try {
      await fetch('/api/alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'GEOFENCE',
          description: `Matias salió del perímetro de la Escuela (Horario Escolar Activo)`,
          image_base64: null
        })
      });
    } catch (e) {
      console.error('Error reportando geocerca violada:', e);
    }
  } else {
    // VOLVIÓ A ENTRAR A LA GEOCERCA
    schoolGeofenceCircle.classList.remove('violated');
    statusBadge.textContent = "DENTRO DE ESCUELA";
    statusBadge.className = "badge-status-green";
    isOutsideGeofence = false;
  }
}

function updateGPSUI() {
  const pin = document.getElementById('child-gps-pin');
  if (pin && isOutsideGeofence) {
    const schoolGeofenceCircle = document.querySelector('.geofence-circle');
    const statusBadge = document.getElementById('gps-status-badge');
    schoolGeofenceCircle.classList.add('violated');
    statusBadge.textContent = "¡FUERA DE ESCUELA!";
    statusBadge.className = "badge-status-red";
  }
}

// --- UTILERÍAS ---

// Reloj del Simulador Celular
function updateSimulatedClock() {
  const clockEl = document.getElementById('sim-time');
  if (clockEl && childProfile) {
    clockEl.textContent = `${childProfile.used_minutes_today}m / ${childProfile.daily_limit_minutes}m`;
  }
}

// Mapeos estéticos de Apps a Iconos Lucide
function getAppIconName(appName) {
  const mapping = {
    'whatsapp': 'message-circle',
    'facebook': 'facebook',
    'facebook messenger': 'message-square',
    'tiktok': 'music-2',
    'roblox': 'gamepad-2',
    'google play store': 'shopping-bag',
    'navegador web': 'chrome',
    'teléfono': 'phone',
    'cámara': 'camera',
    'ajustes': 'settings'
  };
  return mapping[appName.toLowerCase()] || 'app-window';
}

function getAppElementId(appName) {
  const mapping = {
    'whatsapp': 'whatsapp',
    'facebook': 'facebook',
    'facebook messenger': 'messenger',
    'tiktok': 'tiktok',
    'roblox': 'roblox',
    'google play store': 'playstore',
    'navegador web': 'chrome',
    'teléfono': 'phone',
    'cámara': 'camera',
    'ajustes': 'settings'
  };
  return mapping[appName.toLowerCase()] || '';
}

function getAppColorClass(appName) {
  const mapping = {
    'whatsapp': 'green-app',
    'facebook': 'blue-app',
    'facebook messenger': 'purple-app',
    'tiktok': 'dark-app',
    'roblox': 'red-app',
    'google play store': 'play-app',
    'navegador web': 'chrome-app',
    'teléfono': 'call-app',
    'cámara': 'cam-app',
    'ajustes': 'settings-app'
  };
  return mapping[appName.toLowerCase()] || 'dark-app';
}

function isBullyAppSupported(appName) {
  return ['whatsapp', 'facebook', 'facebook messenger'].includes(appName.toLowerCase());
}

// --- SINTETIZADOR DE SONIDO (AUDIO CONTEXT) ---

function playParentNotificationSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.frequency.setValueAtTime(660, audioCtx.currentTime); // Mi5
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
    
    setTimeout(() => {
      const osc2 = audioCtx.createOscillator();
      osc2.connect(gain);
      osc2.frequency.setValueAtTime(880, audioCtx.currentTime); // La5
      osc2.start();
      osc2.stop(audioCtx.currentTime + 0.22);
    }, 100);
  } catch (e) {
    // Ignorar bloqueo de reproducción de audio por el navegador
  }
}

function playParentAlarmSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(330, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
    osc.start();
    
    // Simular sirena oscilante
    osc.frequency.linearRampToValueAtTime(550, audioCtx.currentTime + 0.25);
    osc.frequency.linearRampToValueAtTime(330, audioCtx.currentTime + 0.5);
    osc.frequency.linearRampToValueAtTime(550, audioCtx.currentTime + 0.75);
    osc.frequency.linearRampToValueAtTime(330, audioCtx.currentTime + 1.0);
    
    osc.stop(audioCtx.currentTime + 1.1);
  } catch (e) {
    // Ignorar
  }
}

function playNotificationClickSound() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.05, audioCtx.currentTime);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.08);
  } catch (e) {}
}
