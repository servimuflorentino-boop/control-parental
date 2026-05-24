const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getDatabase, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 6000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Directorios para capturas y servicio estático
const dataDir = process.env.PERSISTENT_DIR || path.join(__dirname, 'data');
const alertPhotosDir = path.join(dataDir, 'alert_photos');
if (!fs.existsSync(alertPhotosDir)) fs.mkdirSync(alertPhotosDir, { recursive: true });
app.use('/api/alerts/photo', express.static(alertPhotosDir));

// Lista de clientes conectados a Server-Sent Events (SSE)
let sseClients = [];

// Helper para enviar eventos SSE a todos los conectados
function broadcastEvent(type, payload) {
  const data = JSON.stringify({ type, payload });
  sseClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Helper para obtener fecha formateada YYYY-MM-DD HH:MM:SS
function getFormattedDateTime() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  const localTime = new Date(now.getTime() - offset);
  return localTime.toISOString().slice(0, 19).replace('T', ' ');
}

// --- ENDPOINTS DE API ---

// 1. Obtener Estado Consolidado del Sistema (Para el Padre)
app.get('/api/status', async (req, res) => {
  let db;
  try {
    db = await getDatabase();
    
    // Obtener perfil del niño
    const child = await db.get('SELECT * FROM children LIMIT 1');
    // Obtener reglas de apps
    const appRules = await db.all('SELECT * FROM app_rules');
    // Obtener alertas recientes
    const alerts = await db.all('SELECT * FROM alerts ORDER BY id DESC LIMIT 50');
    // Obtener peticiones de instalación pendientes
    const installRequests = await db.all('SELECT * FROM installation_requests ORDER BY id DESC');

    await db.close();

    res.json({
      child,
      appRules,
      alerts,
      installRequests
    });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al obtener estado consolidado:', error);
    res.status(500).json({ error: 'Error interno en el servidor.' });
  }
});

// 2. Bloqueo de Emergencia con Un Solo Clic
app.post('/api/emergency-lock', async (req, res) => {
  const { is_locked } = req.body; // 1 para bloquear, 0 para desbloquear
  
  let db;
  try {
    db = await getDatabase();
    await db.run('UPDATE children SET is_locked = ? WHERE id = 1', [is_locked]);
    const updatedChild = await db.get('SELECT * FROM children WHERE id = 1');
    await db.close();

    // Notificar al celular del hijo y a los paneles en caliente
    broadcastEvent('SCREEN_LOCKED', { is_locked });
    broadcastEvent('CHILD_STATUS_UPDATED', { child: updatedChild });

    res.json({ message: is_locked ? 'Pantalla bloqueada con éxito.' : 'Pantalla desbloqueada.', child: updatedChild });
  } catch (error) {
    if (db) await db.close();
    console.error('Error en bloqueo de emergencia:', error);
    res.status(500).json({ error: 'Error al cambiar estado de bloqueo.' });
  }
});

// 3. Bloquear / Desaparecer Aplicaciones en Tiempo Real
app.post('/api/app-block', async (req, res) => {
  const { app_id, is_blocked } = req.body;

  let db;
  try {
    db = await getDatabase();
    await db.run('UPDATE app_rules SET is_blocked = ? WHERE id = ?', [is_blocked, app_id]);
    const updatedApps = await db.all('SELECT * FROM app_rules');
    await db.close();

    // Notificar al celular del hijo
    broadcastEvent('APP_RULES_UPDATED', { appRules: updatedApps });

    res.json({ message: 'Regla de ocultamiento actualizada correctamente.', appRules: updatedApps });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al cambiar bloqueo de aplicación.' });
  }
});

// 4. Configurar Tiempos de Uso y Monitoreo Anti-Bullying
app.post('/api/app-limit', async (req, res) => {
  const { app_id, limit_minutes, bully_monitoring } = req.body;

  let db;
  try {
    db = await getDatabase();
    await db.run(
      'UPDATE app_rules SET limit_minutes = ?, bully_monitoring = ? WHERE id = ?',
      [limit_minutes, bully_monitoring, app_id]
    );
    const updatedApps = await db.all('SELECT * FROM app_rules');
    await db.close();

    // Sincronizar en tiempo real
    broadcastEvent('APP_RULES_UPDATED', { appRules: updatedApps });

    res.json({ message: 'Límites de aplicación actualizados.', appRules: updatedApps });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al configurar límites.' });
  }
});

// 5. Configurar Horarios Programados (Bedtime)
app.post('/api/bedtime', async (req, res) => {
  const { bedtime_start, bedtime_end } = req.body;

  let db;
  try {
    db = await getDatabase();
    await db.run(
      'UPDATE children SET bedtime_start = ?, bedtime_end = ? WHERE id = 1',
      [bedtime_start, bedtime_end]
    );
    const updatedChild = await db.get('SELECT * FROM children WHERE id = 1');
    await db.close();

    broadcastEvent('BEDTIME_UPDATED', { child: updatedChild });

    res.json({ message: 'Horarios escolares/sueño programados con éxito.', child: updatedChild });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al programar horarios.' });
  }
});

// 6. Solicitud de Instalación desde el Celular del Menor
app.post('/api/installation-request', async (req, res) => {
  const { app_name } = req.body;

  if (!app_name || !app_name.trim()) {
    return res.status(400).json({ error: 'Nombre de aplicación inválido.' });
  }

  let db;
  try {
    db = await getDatabase();
    const result = await db.run(
      'INSERT INTO installation_requests (app_name, status, timestamp) VALUES (?, "PENDIENTE", ?)',
      [app_name.trim(), getFormattedDateTime()]
    );
    const request = await db.get('SELECT * FROM installation_requests WHERE id = ?', [result.lastID]);
    await db.close();

    // Notificar al panel de control del Padre
    broadcastEvent('INSTALL_REQUESTED', request);

    res.json({ message: 'Solicitud enviada a tus padres para aprobación.', request });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al solicitar instalación.' });
  }
});

// 7. Decidir Aprobación de Instalación (Padre)
app.post('/api/installation-approve', async (req, res) => {
  const { request_id, status, bully_monitoring } = req.body; // status: APROBADA o RECHAZADA

  let db;
  try {
    db = await getDatabase();
    await db.run('UPDATE installation_requests SET status = ? WHERE id = ?', [status, request_id]);
    const reqData = await db.get('SELECT * FROM installation_requests WHERE id = ?', [request_id]);
    
    if (status === 'APROBADA') {
      // Registrar la nueva app en el catálogo dinámico de app_rules para el celular del hijo
      const cleanPkg = `com.simulated.${reqData.app_name.trim().toLowerCase().replace(/\s+/g, '')}`;
      await db.run(
        'INSERT OR IGNORE INTO app_rules (name, package_name, is_blocked, bully_monitoring) VALUES (?, ?, 0, ?)',
        [reqData.app_name.trim(), cleanPkg, bully_monitoring ? 1 : 0]
      );
      console.log(`Nueva app instalada y aprobada: ${reqData.app_name} (Monitoreo de bullying: ${bully_monitoring ? 'SI' : 'NO'})`);
    }

    const updatedApps = await db.all('SELECT * FROM app_rules');
    const requests = await db.all('SELECT * FROM installation_requests ORDER BY id DESC');
    await db.close();

    // Sincronizar ambos paneles en caliente
    broadcastEvent('INSTALL_DECIDED', { request_id, status, appRules: updatedApps });
    broadcastEvent('APP_RULES_UPDATED', { appRules: updatedApps });

    res.json({ message: `Instalación ${status} con éxito.`, appRules: updatedApps, requests });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al decidir instalación:', error);
    res.status(500).json({ error: 'Error al procesar la aprobación.' });
  }
});

// 8. Registro de Alertas (Cyberbullying, Geocercas, Páginas de Adultos/Gore)
app.post('/api/alert', async (req, res) => {
  const { type, description, image_base64 } = req.body;

  let db;
  try {
    db = await getDatabase();
    let savedPhotoUrl = null;

    // Guardar imagen de grabación de pantalla simulada si existe
    if (image_base64) {
      const matches = image_base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        const buffer = Buffer.from(matches[2], 'base64');
        const filename = `alert-${type.toLowerCase()}-${Date.now()}.jpg`;
        const filepath = path.join(alertPhotosDir, filename);
        fs.writeFileSync(filepath, buffer);
        savedPhotoUrl = `/api/alerts/photo/${filename}`;
      }
    }

    const result = await db.run(
      'INSERT INTO alerts (type, description, screenshot_path, timestamp) VALUES (?, ?, ?, ?)',
      [type, description, savedPhotoUrl, getFormattedDateTime()]
    );
    const newAlert = await db.get('SELECT * FROM alerts WHERE id = ?', [result.lastID]);
    await db.close();

    // Notificar al panel del padre en caliente (SSE)
    broadcastEvent('ALERT_TRIGGERED', newAlert);

    res.status(201).json(newAlert);
  } catch (error) {
    if (db) await db.close();
    console.error('Error al registrar alerta:', error);
    res.status(500).json({ error: 'Error al reportar la alerta.' });
  }
});

// 9. Reporte Diario de Uso e Ubicación GPS del Menor
app.post('/api/child-report', async (req, res) => {
  const { used_minutes_today, app_usage, gps_lat, gps_lng } = req.body;

  let db;
  try {
    db = await getDatabase();
    await db.run('BEGIN TRANSACTION');

    // Actualizar tiempo general diario
    if (used_minutes_today !== undefined) {
      await db.run('UPDATE children SET used_minutes_today = ? WHERE id = 1', [used_minutes_today]);
    }

    // Actualizar tiempos por app
    if (app_usage && Array.isArray(app_usage)) {
      for (const app of app_usage) {
        await db.run(
          'UPDATE app_rules SET used_minutes_today = ? WHERE package_name = ?',
          [app.used_minutes_today, app.package_name]
        );
      }
    }

    const child = await db.get('SELECT * FROM children WHERE id = 1');
    const appRules = await db.all('SELECT * FROM app_rules');
    await db.run('COMMIT');
    await db.close();

    // Notificar actualización de estado
    broadcastEvent('CHILD_STATUS_UPDATED', { child, appRules, gps: { lat: gps_lat, lng: gps_lng } });

    res.json({ message: 'Uso e ubicación del menor actualizados correctamente.', child });
  } catch (error) {
    if (db) {
      await db.run('ROLLBACK');
      await db.close();
    }
    console.error('Error en el reporte de uso del menor:', error);
    res.status(500).json({ error: 'Error al registrar estadísticas de uso.' });
  }
});

// 10. SSE Channel en Intranet
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  console.log(`Dispositivo Conectado a SSE (Parental). Conexiones activas: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
    console.log(`Dispositivo Desconectado de SSE (Parental). Conexiones activas: ${sseClients.length}`);
  });
});

// Servir Frontend del Simulador y Consola
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arrancar Servidor e Inicializar base de datos
initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n======================================================');
      console.log('  PROTOTIPO DE CONTROL PARENTAL - INTRANET ACTIVO');
      console.log(`  Puerto de Control: ${PORT}`);
      console.log('------------------------------------------------------');
      console.log('  Consola y Simulador: http://localhost:' + PORT);
      
      const interfaces = os.networkInterfaces();
      console.log('  Accesos en Red (Intranet) desde dispositivos:');
      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            console.log(`   --> http://${iface.address}:${PORT}`);
          }
        }
      }
      console.log('======================================================\n');
    });
  })
  .catch(err => {
    console.error('Error crítico al inicializar base de datos:', err);
    process.exit(1);
  });
