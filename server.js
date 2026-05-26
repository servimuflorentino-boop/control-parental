const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getDatabase, initDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 6000;
const JWT_SECRET = process.env.JWT_SECRET || 'parental_control_secure_secret_2026';

// --- UTILIDADES JWT NATIVAS (Sin Dependencias Externas) ---
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  if (signature !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// Middleware de Autenticación
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Acceso denegado. Token faltante.' });
  
  const payload = verifyToken(token);
  if (!payload) return res.status(403).json({ error: 'Token inválido o expirado.' });
  
  req.user = payload; // { parent_id: ... } o { child_id: ... }
  next();
}

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

// --- MAPA MULTITENANT DE CLIENTES SSE CONECTADOS ---
// Estructura: { [parent_id]: [res1, res2, ...] }
let sseClients = {};

// Helper para enviar eventos SSE de forma aislada a una familia específica
function broadcastEvent(parentId, type, payload) {
  const data = JSON.stringify({ type, payload });
  const clients = sseClients[parentId];
  if (clients && clients.length > 0) {
    clients.forEach(client => {
      client.write(`data: ${data}\n\n`);
    });
  }
}

// Helper para obtener fecha formateada YYYY-MM-DD HH:MM:SS
function getFormattedDateTime() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  const localTime = new Date(now.getTime() - offset);
  return localTime.toISOString().slice(0, 19).replace('T', ' ');
}

// Sembrar Reglas Base de Apps para un nuevo menor
async function seedBaseAppRules(db, childId) {
  const baseApps = [
    { name: 'WhatsApp', package: 'com.whatsapp', block: 0, bully: 1 },
    { name: 'Facebook', package: 'com.facebook.katana', block: 0, bully: 1 },
    { name: 'Facebook Messenger', package: 'com.facebook.orca', block: 0, bully: 1 },
    { name: 'TikTok', package: 'com.zhiliaoapp.musically', block: 0, bully: 0 },
    { name: 'Roblox', package: 'com.roblox.client', block: 0, bully: 0 },
    { name: 'Google Play Store', package: 'com.android.vending', block: 0, bully: 0 },
    { name: 'Navegador Web', package: 'com.android.chrome', block: 0, bully: 0 },
    { name: 'Teléfono', package: 'com.android.phone', block: 0, bully: 0 },
    { name: 'Cámara', package: 'com.android.camera', block: 0, bully: 0 }
  ];

  for (const app of baseApps) {
    await db.run(
      'INSERT OR IGNORE INTO app_rules (child_id, name, package_name, is_blocked, bully_monitoring) VALUES (?, ?, ?, ?, ?)',
      [childId, app.name, app.package, app.block, app.bully]
    );
  }
}

// --- ENDPOINTS DE AUTENTICACIÓN Y REGISTRO (SaaS) ---

// 1. Registro de Nuevas Cuentas de Padres
app.post('/api/auth/register', async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }

  let db;
  try {
    db = await getDatabase();
    
    // Verificar si el usuario ya existe
    const existing = await db.get('SELECT * FROM parents WHERE username = ?', [username]);
    if (existing) {
      await db.close();
      return res.status(400).json({ error: 'El correo ya se encuentra registrado.' });
    }

    // Hashear contraseña
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(password, salt);

    // Crear cuenta del padre
    const result = await db.run(
      'INSERT INTO parents (username, password, full_name) VALUES (?, ?, ?)',
      [username, hash, full_name]
    );
    const parentId = result.lastID;

    // Crear un hijo por defecto (Matias) para demostración inmediata
    const childResult = await db.run(
      'INSERT INTO children (parent_id, name, daily_limit_minutes, used_minutes_today, is_locked) VALUES (?, ?, 120, 0, 0)',
      [parentId, 'Matias']
    );
    const childId = childResult.lastID;

    // Sembrar reglas de apps por defecto para el hijo creado
    await seedBaseAppRules(db, childId);
    await db.close();

    res.status(201).json({ success: true, message: 'Usuario registrado con éxito.' });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al registrar usuario:', error);
    res.status(500).json({ error: 'Error interno en el servidor.' });
  }
});

// 2. Login de Cuentas de Padres
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }

  let db;
  try {
    db = await getDatabase();
    const user = await db.get('SELECT * FROM parents WHERE username = ?', [username]);
    
    if (!user || !bcrypt.compareSync(password, user.password)) {
      await db.close();
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }

    // Generar token JWT nativo
    const token = createToken({ parent_id: user.id, username: user.username });
    await db.close();

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name
      }
    });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al iniciar sesión:', error);
    res.status(500).json({ error: 'Error interno en el servidor.' });
  }
});

// 3. Obtener perfil del usuario autenticado
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  let db;
  try {
    db = await getDatabase();
    const user = await db.get('SELECT id, username, full_name FROM parents WHERE id = ?', [req.user.parent_id]);
    await db.close();
    
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ user });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al recuperar perfil.' });
  }
});

// --- ENDPOINTS DE VINCULACIÓN DE DISPOSITIVOS ---

// 4. Generar Código de Vinculación de 6 Dígitos (Padre)
app.post('/api/auth/pairing-code', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 Minutos

  let db;
  try {
    db = await getDatabase();
    // Limpiar códigos anteriores del mismo padre
    await db.run('DELETE FROM pairing_codes WHERE parent_id = ?', [parentId]);
    // Insertar nuevo código
    await db.run(
      'INSERT INTO pairing_codes (code, parent_id, expires_at) VALUES (?, ?, ?)',
      [code, parentId, expiresAt]
    );
    await db.close();
    
    res.json({ success: true, code });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al generar código de emparejamiento:', error);
    res.status(500).json({ error: 'Error al generar código.' });
  }
});

// 5. Vincular Dispositivo / Celular del Hijo mediante Código (Menor)
app.post('/api/auth/pair', async (req, res) => {
  const { code, child_name } = req.body;
  if (!code || !child_name) {
    return res.status(400).json({ error: 'Código y nombre de menor requeridos.' });
  }

  let db;
  try {
    db = await getDatabase();
    // Buscar código
    const record = await db.get('SELECT * FROM pairing_codes WHERE code = ?', [code]);
    if (!record) {
      await db.close();
      return res.status(404).json({ error: 'Código de vinculación inválido o inexistente.' });
    }

    // Validar expiración
    if (new Date() > new Date(record.expires_at)) {
      await db.run('DELETE FROM pairing_codes WHERE id = ?', [record.id]);
      await db.close();
      return res.status(400).json({ error: 'El código ha expirado. Genere uno nuevo.' });
    }

    // Crear perfil del menor
    const childResult = await db.run(
      'INSERT INTO children (parent_id, name, daily_limit_minutes, used_minutes_today, is_locked) VALUES (?, ?, 120, 0, 0)',
      [record.parent_id, child_name.trim()]
    );
    const childId = childResult.lastID;

    // Sembrar catálogo de apps por defecto para este menor
    await seedBaseAppRules(db, childId);

    // Consolidar token para el celular del menor
    const token = createToken({ child_id: childId, parent_id: record.parent_id });

    // Borrar código de un solo uso
    await db.run('DELETE FROM pairing_codes WHERE id = ?', [record.id]);
    await db.close();

    // Notificar a la consola del padre que un menor se ha vinculado con éxito
    broadcastEvent(record.parent_id, 'DEVICE_PAIRED', { childId, name: child_name });

    res.json({ success: true, token, child_id: childId, parent_id: record.parent_id });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al vincular dispositivo:', error);
    res.status(500).json({ error: 'Error al emparejar el dispositivo.' });
  }
});

// --- ENDPOINTS OPERATIVOS MULTITENANT ---

// 1. Obtener Estado Consolidado del Sistema (Para el Padre)
app.get('/api/status', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const childId = req.query.child_id ? parseInt(req.query.child_id) : null;
  
  let db;
  try {
    db = await getDatabase();
    
    // Obtener lista completa de hijos del padre logueado
    const childrenList = await db.all('SELECT * FROM children WHERE parent_id = ?', [parentId]);
    
    let activeChild = null;
    let appRules = [];
    let alerts = [];
    let installRequests = [];

    if (childrenList.length > 0) {
      // Si no se provee child_id, tomar el primero
      const targetChildId = childId && childrenList.some(c => c.id === childId) 
        ? childId 
        : childrenList[0].id;
      
      activeChild = childrenList.find(c => c.id === targetChildId);
      appRules = await db.all('SELECT * FROM app_rules WHERE child_id = ?', [targetChildId]);
      alerts = await db.all('SELECT * FROM alerts WHERE child_id = ? ORDER BY id DESC LIMIT 50', [targetChildId]);
      installRequests = await db.all('SELECT * FROM installation_requests WHERE child_id = ? ORDER BY id DESC', [targetChildId]);
    }

    await db.close();

    res.json({
      children: childrenList,
      child: activeChild,
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
app.post('/api/emergency-lock', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const { child_id, is_locked } = req.body;
  
  if (!child_id) return res.status(400).json({ error: 'child_id requerido.' });

  let db;
  try {
    db = await getDatabase();
    // Validar propiedad del hijo
    const child = await db.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', [child_id, parentId]);
    if (!child) {
      await db.close();
      return res.status(403).json({ error: 'Acceso denegado.' });
    }

    await db.run('UPDATE children SET is_locked = ? WHERE id = ?', [is_locked, child_id]);
    const updatedChild = await db.get('SELECT * FROM children WHERE id = ?', [child_id]);
    await db.close();

    // Notificar al canal SSE exclusivo de la familia
    broadcastEvent(parentId, 'SCREEN_LOCKED', { child_id, is_locked });
    broadcastEvent(parentId, 'CHILD_STATUS_UPDATED', { child: updatedChild });

    res.json({ message: is_locked ? 'Pantalla bloqueada con éxito.' : 'Pantalla desbloqueada.', child: updatedChild });
  } catch (error) {
    if (db) await db.close();
    console.error('Error en bloqueo de emergencia:', error);
    res.status(500).json({ error: 'Error al cambiar estado de bloqueo.' });
  }
});

// 3. Bloquear / Desaparecer Aplicaciones en Tiempo Real
app.post('/api/app-block', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const { child_id, app_id, is_blocked } = req.body;
  
  if (!child_id || !app_id) return res.status(400).json({ error: 'Parámetros requeridos faltantes.' });

  let db;
  try {
    db = await getDatabase();
    // Validar propiedad
    const child = await db.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', [child_id, parentId]);
    if (!child) {
      await db.close();
      return res.status(403).json({ error: 'Acceso denegado.' });
    }

    await db.run('UPDATE app_rules SET is_blocked = ? WHERE id = ? AND child_id = ?', [is_blocked, app_id, child_id]);
    const updatedApps = await db.all('SELECT * FROM app_rules WHERE child_id = ?', [child_id]);
    await db.close();

    // Notificar por SSE a la familia
    broadcastEvent(parentId, 'APP_RULES_UPDATED', { child_id, appRules: updatedApps });

    res.json({ message: 'Regla de ocultamiento actualizada correctamente.', appRules: updatedApps });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al cambiar bloqueo de aplicación.' });
  }
});

// 4. Configurar Tiempos de Uso y Monitoreo Anti-Bullying
app.post('/api/app-limit', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const { child_id, app_id, limit_minutes, bully_monitoring } = req.body;

  if (!child_id || !app_id) return res.status(400).json({ error: 'Parámetros faltantes.' });

  let db;
  try {
    db = await getDatabase();
    const child = await db.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', [child_id, parentId]);
    if (!child) {
      await db.close();
      return res.status(403).json({ error: 'Acceso denegado.' });
    }

    await db.run(
      'UPDATE app_rules SET limit_minutes = ?, bully_monitoring = ? WHERE id = ? AND child_id = ?',
      [limit_minutes, bully_monitoring, app_id, child_id]
    );
    const updatedApps = await db.all('SELECT * FROM app_rules WHERE child_id = ?', [child_id]);
    await db.close();

    broadcastEvent(parentId, 'APP_RULES_UPDATED', { child_id, appRules: updatedApps });

    res.json({ message: 'Límites de aplicación actualizados.', appRules: updatedApps });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al configurar límites.' });
  }
});

// 5. Configurar Horarios Programados (Bedtime)
app.post('/api/bedtime', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const { child_id, bedtime_start, bedtime_end } = req.body;
  
  if (!child_id) return res.status(400).json({ error: 'child_id requerido.' });

  let db;
  try {
    db = await getDatabase();
    const child = await db.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', [child_id, parentId]);
    if (!child) {
      await db.close();
      return res.status(403).json({ error: 'Acceso denegado.' });
    }

    await db.run(
      'UPDATE children SET bedtime_start = ?, bedtime_end = ? WHERE id = ?',
      [bedtime_start, bedtime_end, child_id]
    );
    const updatedChild = await db.get('SELECT * FROM children WHERE id = ?', [child_id]);
    await db.close();

    broadcastEvent(parentId, 'BEDTIME_UPDATED', { child_id, child: updatedChild });

    res.json({ message: 'Horarios escolares/sueño programados con éxito.', child: updatedChild });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al programar horarios.' });
  }
});

// 6. Solicitud de Instalación desde el Celular del Menor
app.post('/api/installation-request', authenticateToken, async (req, res) => {
  const childId = req.user.child_id;
  const parentId = req.user.parent_id;
  const { app_name } = req.body;

  if (!app_name || !app_name.trim()) {
    return res.status(400).json({ error: 'Nombre de aplicación inválido.' });
  }

  let db;
  try {
    db = await getDatabase();
    const result = await db.run(
      'INSERT INTO installation_requests (child_id, app_name, status, timestamp) VALUES (?, ?, "PENDIENTE", ?)',
      [childId, app_name.trim(), getFormattedDateTime()]
    );
    const request = await db.get('SELECT * FROM installation_requests WHERE id = ?', [result.lastID]);
    await db.close();

    // Notificar a la familia
    broadcastEvent(parentId, 'INSTALL_REQUESTED', { child_id: childId, request });

    res.json({ message: 'Solicitud enviada a tus padres para aprobación.', request });
  } catch (error) {
    if (db) await db.close();
    res.status(500).json({ error: 'Error al solicitar instalación.' });
  }
});

// 7. Decidir Aprobación de Instalación (Padre)
app.post('/api/installation-approve', authenticateToken, async (req, res) => {
  const parentId = req.user.parent_id;
  const { child_id, request_id, status, bully_monitoring } = req.body;

  if (!child_id || !request_id) return res.status(400).json({ error: 'Parámetros inválidos.' });

  let db;
  try {
    db = await getDatabase();
    const child = await db.get('SELECT * FROM children WHERE id = ? AND parent_id = ?', [child_id, parentId]);
    if (!child) {
      await db.close();
      return res.status(403).json({ error: 'Acceso denegado.' });
    }

    await db.run('UPDATE installation_requests SET status = ? WHERE id = ? AND child_id = ?', [status, request_id, child_id]);
    const reqData = await db.get('SELECT * FROM installation_requests WHERE id = ?', [request_id]);
    
    if (status === 'APROBADA') {
      const cleanPkg = `com.simulated.${reqData.app_name.trim().toLowerCase().replace(/\s+/g, '')}`;
      await db.run(
        'INSERT OR IGNORE INTO app_rules (child_id, name, package_name, is_blocked, bully_monitoring) VALUES (?, ?, ?, 0, ?)',
        [child_id, reqData.app_name.trim(), cleanPkg, bully_monitoring ? 1 : 0]
      );
    }

    const updatedApps = await db.all('SELECT * FROM app_rules WHERE child_id = ?', [child_id]);
    const requests = await db.all('SELECT * FROM installation_requests WHERE child_id = ? ORDER BY id DESC', [child_id]);
    await db.close();

    broadcastEvent(parentId, 'INSTALL_DECIDED', { child_id, request_id, status, appRules: updatedApps });
    broadcastEvent(parentId, 'APP_RULES_UPDATED', { child_id, appRules: updatedApps });

    res.json({ message: `Instalación ${status} con éxito.`, appRules: updatedApps, requests });
  } catch (error) {
    if (db) await db.close();
    console.error('Error al decidir instalación:', error);
    res.status(500).json({ error: 'Error al procesar la aprobación.' });
  }
});

// 8. Registro de Alertas (Cyberbullying, Geocercas, Páginas de Adultos/Gore)
app.post('/api/alert', authenticateToken, async (req, res) => {
  const childId = req.user.child_id;
  const parentId = req.user.parent_id;
  const { type, description, image_base64 } = req.body;

  let db;
  try {
    db = await getDatabase();
    let savedPhotoUrl = null;

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
      'INSERT INTO alerts (child_id, type, description, screenshot_path, timestamp) VALUES (?, ?, ?, ?, ?)',
      [childId, type, description, savedPhotoUrl, getFormattedDateTime()]
    );
    const newAlert = await db.get('SELECT * FROM alerts WHERE id = ?', [result.lastID]);
    await db.close();

    broadcastEvent(parentId, 'ALERT_TRIGGERED', { child_id: childId, alert: newAlert });

    res.status(201).json(newAlert);
  } catch (error) {
    if (db) await db.close();
    console.error('Error al registrar alerta:', error);
    res.status(500).json({ error: 'Error al reportar la alerta.' });
  }
});

// 9. Reporte Diario de Uso e Ubicación GPS del Menor
app.post('/api/child-report', authenticateToken, async (req, res) => {
  const childId = req.user.child_id;
  const parentId = req.user.parent_id;
  const { used_minutes_today, app_usage, gps_lat, gps_lng } = req.body;

  let db;
  try {
    db = await getDatabase();
    await db.run('BEGIN TRANSACTION');

    if (used_minutes_today !== undefined) {
      await db.run('UPDATE children SET used_minutes_today = ? WHERE id = ?', [used_minutes_today, childId]);
    }

    if (app_usage && Array.isArray(app_usage)) {
      for (const app of app_usage) {
        await db.run(
          'UPDATE app_rules SET used_minutes_today = ? WHERE package_name = ? AND child_id = ?',
          [app.used_minutes_today, app.package_name, childId]
        );
      }
    }

    const child = await db.get('SELECT * FROM children WHERE id = ?', [childId]);
    const appRules = await db.all('SELECT * FROM app_rules WHERE child_id = ?', [childId]);
    await db.run('COMMIT');
    await db.close();

    broadcastEvent(parentId, 'CHILD_STATUS_UPDATED', { child_id: childId, child, appRules, gps: { lat: gps_lat, lng: gps_lng } });

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

// 10. SSE Channel Multitenant
app.get('/api/events', (req, res) => {
  const parentId = req.query.parent_id ? parseInt(req.query.parent_id) : null;
  if (!parentId) {
    return res.status(400).write('data: {"error": "parent_id requerido"}\n\n');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!sseClients[parentId]) {
    sseClients[parentId] = [];
  }
  sseClients[parentId].push(res);
  console.log(`Dispositivo Conectado a SSE (Parental - Familia ${parentId}). Conexiones activas: ${sseClients[parentId].length}`);

  req.on('close', () => {
    if (sseClients[parentId]) {
      sseClients[parentId] = sseClients[parentId].filter(client => client !== res);
      console.log(`Dispositivo Desconectado de SSE (Parental - Familia ${parentId}). Conexiones activas: ${sseClients[parentId].length}`);
      if (sseClients[parentId].length === 0) {
        delete sseClients[parentId];
      }
    }
  });
});

// Servir Frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Arrancar Servidor
initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n======================================================');
      console.log('  SISTEMA MULTITENANT DE CONTROL PARENTAL (SaaS) ACTIVO');
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
