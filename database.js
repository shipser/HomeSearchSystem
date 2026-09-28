const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'apartments.db');
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS apartments (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'דירה חדשה',
    address TEXT DEFAULT '',
    price_display TEXT DEFAULT '',
    price_numeric INTEGER DEFAULT 0,
    rooms TEXT DEFAULT '',
    floor TEXT DEFAULT '',
    total_floors TEXT DEFAULT '',
    area REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_apartments_updated ON apartments(updated_at DESC);
`);

/**
 * Get all apartments (summary list for quick switching/rendering)
 */
function getAllApartments() {
  const stmt = db.prepare(`
    SELECT id, title, address, price_display, price_numeric, rooms, floor, total_floors, area, created_at, updated_at
    FROM apartments
    ORDER BY updated_at DESC
  `);
  return stmt.all();
}

/**
 * Get single apartment by ID with full parsed form data
 */
function getApartmentById(id) {
  const stmt = db.prepare(`SELECT * FROM apartments WHERE id = ?`);
  const row = stmt.get(id);
  if (!row) return null;
  return {
    ...row,
    data: JSON.parse(row.data_json || '{}')
  };
}

/**
 * Save or update apartment
 */
function saveApartment(id, data = {}, customTitle = null) {
  const address = (data['כתובת'] || '').trim();
  const title = customTitle || address || 'דירה חדשה (ללא כתובת)';
  const priceDisplay = (data['מחיר_מבוקש_display'] || '').trim();
  const priceNumeric = parseInt((data['מחיר_מבוקש'] || '').toString().replace(/\D/g, ''), 10) || 0;
  
  let rooms = (data['מספר_חדרים'] || '').trim();
  if (rooms === 'אחר' && data['מספר_חדרים_אחר']) {
    rooms = data['מספר_חדרים_אחר'].trim();
  }
  
  const floor = (data['קומה'] || '').trim();
  const totalFloors = (data['מתוך_קומות'] || '').trim();
  const area = parseFloat(data['שטח_מודעה'] || data['שטח_ארנונה'] || 0) || 0;
  const notes = (data['הערות_כלליות_נוספות'] || '').trim();
  const dataJson = JSON.stringify(data);
  const now = new Date().toISOString();

  const existing = db.prepare(`SELECT id, created_at FROM apartments WHERE id = ?`).get(id);

  if (existing) {
    const updateStmt = db.prepare(`
      UPDATE apartments 
      SET title = ?, address = ?, price_display = ?, price_numeric = ?, rooms = ?, floor = ?, total_floors = ?, area = ?, notes = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `);
    updateStmt.run(title, address, priceDisplay, priceNumeric, rooms, floor, totalFloors, area, notes, dataJson, now, id);
  } else {
    const insertStmt = db.prepare(`
      INSERT INTO apartments (id, title, address, price_display, price_numeric, rooms, floor, total_floors, area, notes, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertStmt.run(id, title, address, priceDisplay, priceNumeric, rooms, floor, totalFloors, area, notes, dataJson, now, now);
  }

  return getApartmentById(id);
}

/**
 * Create a new empty apartment form
 */
function createApartment(initialData = {}, title = 'דירה חדשה (ללא כתובת)') {
  const id = 'apt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  return saveApartment(id, initialData, title);
}

/**
 * Delete an apartment by ID
 */
function deleteApartment(id) {
  const stmt = db.prepare(`DELETE FROM apartments WHERE id = ?`);
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Duplicate an existing apartment
 */
function duplicateApartment(id) {
  const original = getApartmentById(id);
  if (!original) return null;

  const newId = 'apt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const clonedData = { ...original.data };
  if (clonedData['כתובת']) {
    clonedData['כתובת'] = clonedData['כתובת'] + ' (העתק)';
  }
  const newTitle = original.title + ' (העתק)';
  return saveApartment(newId, clonedData, newTitle);
}

/**
 * Bulk import apartments (e.g. from client localStorage)
 */
function importBulk(formsMapOrArray) {
  const entries = Array.isArray(formsMapOrArray) 
    ? formsMapOrArray 
    : Object.entries(formsMapOrArray).map(([id, item]) => ({ id, ...item }));
  
  const results = [];
  const runTransaction = db.transaction((items) => {
    for (const item of items) {
      const id = item.id || ('apt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7));
      const saved = saveApartment(id, item.data || {}, item.title);
      results.push(saved);
    }
  });

  runTransaction(entries);
  return results;
}

/**
 * Export all apartments with full data for backup
 */
function exportAll() {
  const stmt = db.prepare(`SELECT * FROM apartments ORDER BY updated_at DESC`);
  const rows = stmt.all();
  return rows.map(r => ({
    ...r,
    data: JSON.parse(r.data_json || '{}')
  }));
}

module.exports = {
  db,
  getAllApartments,
  getApartmentById,
  saveApartment,
  createApartment,
  deleteApartment,
  duplicateApartment,
  importBulk,
  exportAll
};
