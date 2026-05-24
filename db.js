const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbDir = process.env.PERSISTENT_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = path.join(dbDir, 'parental.db');

async function getDatabase() {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  await db.run('PRAGMA foreign_keys = ON');
  return db;
}

async function initDatabase() {
  const db = await getDatabase();

  // 1. Tabla de Padres (Administradores)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL
    )
  `);

  // 2. Tabla del Menor (Perfil de Control)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      daily_limit_minutes INTEGER DEFAULT 120,
      used_minutes_today INTEGER DEFAULT 0,
      is_locked INTEGER DEFAULT 0, -- 1: Bloqueado total (Botón de emergencia)
      bedtime_start TEXT,          -- HH:MM (Horario de bloqueo)
      bedtime_end TEXT             -- HH:MM
    )
  `);

  // 3. Tabla de Reglas de Aplicaciones
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      package_name TEXT UNIQUE NOT NULL,
      is_blocked INTEGER DEFAULT 0,      -- 1: Oculta / Desaparece de pantalla
      limit_minutes INTEGER DEFAULT 0,   -- 0: Sin límite específico
      used_minutes_today INTEGER DEFAULT 0,
      bully_monitoring INTEGER DEFAULT 0 -- 1: Habilitado para WhatsApp/FB
    )
  `);

  // 4. Tabla de Alertas de Auditoría (Gore, Pornografía, Geocercas, Cyberbullying)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('BULLYING', 'WEB_ADULT', 'GEOFENCE', 'EVASION')) NOT NULL,
      description TEXT NOT NULL,
      screenshot_path TEXT, -- Captura o simulación de grabación de pantalla
      timestamp TEXT NOT NULL
    )
  `);

  // 5. Tabla de Solicitudes de Instalación
  await db.exec(`
    CREATE TABLE IF NOT EXISTS installation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_name TEXT NOT NULL,
      status TEXT CHECK(status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')) NOT NULL DEFAULT 'PENDIENTE',
      timestamp TEXT NOT NULL
    )
  `);

  // --- SEMBRADO DE DATOS (SEEDING) ---
  
  // Sembrar Padre administrador por defecto
  const parentCount = await db.get('SELECT COUNT(*) as count FROM parents');
  if (parentCount.count === 0) {
    console.log('Sembrando cuenta de Padre Administrador...');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('admin123', salt);
    await db.run(
      'INSERT INTO parents (username, password, full_name) VALUES (?, ?, ?)',
      ['admin', hash, 'Padre de Familia']
    );
  }

  // Sembrar Perfil del Menor
  const childCount = await db.get('SELECT COUNT(*) as count FROM children');
  if (childCount.count === 0) {
    console.log('Sembrando perfil del menor...');
    await db.run(
      'INSERT INTO children (name, daily_limit_minutes, used_minutes_today, is_locked) VALUES (?, ?, ?, ?)',
      ['Matias', 120, 0, 0]
    );
  }

  // Sembrar Reglas de Apps Base
  const appRulesCount = await db.get('SELECT COUNT(*) as count FROM app_rules');
  if (appRulesCount.count === 0) {
    console.log('Sembrando catálogo de aplicaciones móviles del menor...');
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
        'INSERT INTO app_rules (name, package_name, is_blocked, bully_monitoring) VALUES (?, ?, ?, ?)',
        [app.name, app.package, app.block, app.bully]
      );
    }
  }

  await db.close();
  console.log('Base de datos de Control Parental inicializada con éxito.');
}

module.exports = {
  getDatabase,
  initDatabase,
  dbPath
};
