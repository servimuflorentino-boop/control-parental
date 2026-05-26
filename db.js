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

  // --- MIGRACIÓN DE ESQUEMA ANTERIOR ---
  // Si detectamos que existe la tabla 'children' pero no tiene la columna 'parent_id',
  // significa que es el esquema monousuario estático y debemos recrearla para multitenencia.
  try {
    const childTableInfo = await db.all("PRAGMA table_info(children)");
    if (childTableInfo.length > 0) {
      const hasParentId = childTableInfo.some(col => col.name === 'parent_id');
      if (!hasParentId) {
        console.log('--- DETECTADO ESQUEMA ANTIGUO MONOUSUARIO ---');
        console.log('Recreando tablas para habilitar la arquitectura multitenant...');
        await db.exec('DROP TABLE IF EXISTS app_rules');
        await db.exec('DROP TABLE IF EXISTS alerts');
        await db.exec('DROP TABLE IF EXISTS installation_requests');
        await db.exec('DROP TABLE IF EXISTS pairing_codes');
        await db.exec('DROP TABLE IF EXISTS children');
        await db.exec('DROP TABLE IF EXISTS parents');
      }
    }
  } catch (err) {
    console.error('Error al validar migración de esquema antiguo:', err);
  }

  // --- CREACIÓN DE TABLAS MULTITENANT ---

  // 1. Tabla de Padres (Cuentas Administradoras SaaS)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL, -- Email de registro
      password TEXT NOT NULL,
      full_name TEXT NOT NULL
    )
  `);

  // 2. Tabla de Hijos (Dispositivos asociados por Parent)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      daily_limit_minutes INTEGER DEFAULT 120,
      used_minutes_today INTEGER DEFAULT 0,
      is_locked INTEGER DEFAULT 0, -- 1: Bloqueado por botón de emergencia
      bedtime_start TEXT,          -- HH:MM (Horario escolar / sueño)
      bedtime_end TEXT,            -- HH:MM
      FOREIGN KEY(parent_id) REFERENCES parents(id) ON DELETE CASCADE
    )
  `);

  // 3. Tabla de Códigos de Vinculación (Códigos temporales de 6 dígitos)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      parent_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL, -- Timestamp ISO String de expiración
      FOREIGN KEY(parent_id) REFERENCES parents(id) ON DELETE CASCADE
    )
  `);

  // 4. Tabla de Reglas de Aplicaciones (Único por menor)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      package_name TEXT NOT NULL,
      is_blocked INTEGER DEFAULT 0,      -- 1: Oculta / Bloqueada
      limit_minutes INTEGER DEFAULT 0,   -- 0: Sin límite específico
      used_minutes_today INTEGER DEFAULT 0,
      bully_monitoring INTEGER DEFAULT 0, -- 1: Habilitado para WhatsApp/FB
      FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE,
      UNIQUE(child_id, package_name)
    )
  `);

  // 5. Tabla de Alertas de Auditoría (Ligada a cada menor)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id INTEGER NOT NULL,
      type TEXT CHECK(type IN ('BULLYING', 'WEB_ADULT', 'GEOFENCE', 'EVASION')) NOT NULL,
      description TEXT NOT NULL,
      screenshot_path TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
    )
  `);

  // 6. Tabla de Solicitudes de Instalación (Por menor)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS installation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id INTEGER NOT NULL,
      app_name TEXT NOT NULL,
      status TEXT CHECK(status IN ('PENDIENTE', 'APROBADA', 'RECHAZADA')) NOT NULL DEFAULT 'PENDIENTE',
      timestamp TEXT NOT NULL,
      FOREIGN KEY(child_id) REFERENCES children(id) ON DELETE CASCADE
    )
  `);

  // --- SEMBRADO DE DATOS (SEEDING - CUENTA BASE ADMIN) ---
  
  // Sembrar Padre administrador por defecto si la tabla está vacía
  const parentCount = await db.get('SELECT COUNT(*) as count FROM parents');
  if (parentCount.count === 0) {
    console.log('Sembrando cuenta de Padre Administrador SaaS base...');
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync('admin123', salt);
    await db.run(
      'INSERT INTO parents (id, username, password, full_name) VALUES (?, ?, ?, ?)',
      [1, 'admin', hash, 'Padre de Familia']
    );
  }

  // Sembrar Perfil del Menor ligado a la cuenta 1 (Matias)
  const child = await db.get('SELECT * FROM children WHERE parent_id = 1 LIMIT 1');
  let childId = child ? child.id : null;
  if (!child) {
    console.log('Sembrando perfil del menor para la cuenta admin...');
    const result = await db.run(
      'INSERT INTO children (parent_id, name, daily_limit_minutes, used_minutes_today, is_locked) VALUES (?, ?, ?, ?, ?)',
      [1, 'Matias', 120, 0, 0]
    );
    childId = result.lastID;
  }

  // Sembrar Reglas de Apps Base para el menor Matias
  const appRulesCount = await db.get('SELECT COUNT(*) as count FROM app_rules WHERE child_id = ?', [childId]);
  if (appRulesCount.count === 0) {
    console.log('Sembrando catálogo de aplicaciones móviles para Matias...');
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
        'INSERT INTO app_rules (child_id, name, package_name, is_blocked, bully_monitoring) VALUES (?, ?, ?, ?, ?)',
        [childId, app.name, app.package, app.block, app.bully]
      );
    }
  }

  await db.close();
  console.log('Base de datos de Control Parental (Multitenant SaaS) inicializada con éxito.');
}

module.exports = {
  getDatabase,
  initDatabase,
  dbPath
};
