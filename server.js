const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');
const qrcode = require('qrcode');
const multer = require('multer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable trust proxy for deployments behind reverse proxies (Nginx, Traefik, Caddy, Cloudflare)
app.set('trust proxy', true);

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Files storage directory
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const filesDir = path.join(dataDir, 'files');
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

// Multer config: per-form subfolder, 20 MB limit, allowed types
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain'
]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_FILES_PER_FORM = 20;

// Helper: Fix filename encoding if received as Latin-1/ISO-8859-1 from busboy/multer
function fixFilenameEncoding(filename) {
  if (!filename) return '';
  try {
    // Busboy / Multer historically decodes UTF-8 multipart filenames as Latin-1.
    // If that happened, converting latin1 -> utf8 restores Hebrew/Unicode without loss.
    const decoded = Buffer.from(filename, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) {
      return decoded;
    }
  } catch (e) {}
  return filename;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const formDir = path.join(filesDir, req.params.id);
    if (!fs.existsSync(formDir)) fs.mkdirSync(formDir, { recursive: true });
    cb(null, formDir);
  },
  filename: (req, file, cb) => {
    // Preserve full Hebrew / Unicode filename while sanitizing illegal filesystem chars
    const rawName = fixFilenameEncoding(file.originalname);
    const safe = rawName.replace(/[/\\?%*:|"<>]/g, '_').trim() || 'file';
    const formDir = path.join(filesDir, req.params.id);
    let target = safe;
    let counter = 1;
    while (fs.existsSync(path.join(formDir, target))) {
      const ext = path.extname(safe);
      const base = path.basename(safe, ext);
      target = `${base}_(${counter})${ext}`;
      counter++;
    }
    cb(null, target);
  }
});

const fileFilter = (req, file, cb) => {
  const decodedName = fixFilenameEncoding(file.originalname);
  file.originalname = decodedName;
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    // Fallback by extension (in case browser sends application/octet-stream for docx/txt)
    const ext = path.extname(decodedName).toLowerCase();
    const allowedExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.pdf', '.doc', '.docx', '.txt']);
    if (allowedExts.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`סוג קובץ לא מותר: ${file.mimetype}`), false);
    }
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events (SSE) clients pool
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const client = {
    res,
    id: req.query.clientId || 'client_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6)
  };

  sseClients.add(client);

  // Send initial handshake
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId: client.id, timestamp: new Date().toISOString() })}\n\n`);

  // Heartbeat every 25 seconds to keep connection open across mobile and Wi-Fi routers
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(client);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

function broadcastEvent(type, payload, senderClientId = null) {
  const message = JSON.stringify({
    type,
    payload,
    senderClientId,
    timestamp: new Date().toISOString()
  });

  for (const client of sseClients) {
    try {
      client.res.write(`data: ${message}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// REST API Endpoints

// 1. Get all forms (summary list)
app.get('/api/forms', (req, res) => {
  try {
    const list = db.getAllApartments();
    res.json({ success: true, forms: list });
  } catch (error) {
    console.error('Error fetching forms:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Get single form by ID
app.get('/api/forms/:id', (req, res) => {
  try {
    const form = db.getApartmentById(req.params.id);
    if (!form) {
      return res.status(404).json({ success: false, error: 'Form not found' });
    }
    res.json({ success: true, form });
  } catch (error) {
    console.error('Error fetching form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Create a new form
app.post('/api/forms', (req, res) => {
  try {
    const { initialData = {}, title, clientId } = req.body;
    const newForm = db.createApartment(initialData, title);
    
    broadcastEvent('FORM_CREATED', { id: newForm.id, title: newForm.title }, clientId);
    res.status(201).json({ success: true, form: newForm });
  } catch (error) {
    console.error('Error creating form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. Save/Update a form
app.put('/api/forms/:id', (req, res) => {
  try {
    const { data = {}, title, clientId } = req.body;
    const formId = req.params.id;
    const saved = db.saveApartment(formId, data, title);

    broadcastEvent('FORM_UPDATED', {
      id: saved.id,
      title: saved.title,
      address: saved.address,
      updated_at: saved.updated_at
    }, clientId);

    res.json({ success: true, form: saved });
  } catch (error) {
    console.error('Error saving form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. Delete a form
app.delete('/api/forms/:id', (req, res) => {
  try {
    const formId = req.params.id;
    const clientId = req.query.clientId;
    const deleted = db.deleteApartment(formId);

    if (deleted) {
      broadcastEvent('FORM_DELETED', { id: formId }, clientId);
      res.json({ success: true, message: 'Deleted successfully' });
    } else {
      res.status(404).json({ success: false, error: 'Form not found' });
    }
  } catch (error) {
    console.error('Error deleting form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. Duplicate a form
app.post('/api/forms/:id/duplicate', (req, res) => {
  try {
    const { clientId } = req.body;
    const duplicated = db.duplicateApartment(req.params.id);
    if (!duplicated) {
      return res.status(404).json({ success: false, error: 'Source form not found' });
    }

    broadcastEvent('FORM_CREATED', { id: duplicated.id, title: duplicated.title }, clientId);
    res.status(201).json({ success: true, form: duplicated });
  } catch (error) {
    console.error('Error duplicating form:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. Bulk Import (e.g. migrating from old localStorage)
app.post('/api/forms/import', (req, res) => {
  try {
    const { forms = [], clientId } = req.body;
    const imported = db.importBulk(forms);
    broadcastEvent('FORMS_BULK_IMPORTED', { count: imported.length }, clientId);
    res.json({ success: true, count: imported.length, forms: imported });
  } catch (error) {
    console.error('Error importing forms:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 8. Export all data as JSON
app.get('/api/forms/export', (req, res) => {
  try {
    const all = db.exportAll();
    const filename = `apartments_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(all, null, 2));
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 9. Network detection & QR code generation for multi-device access
function getNetworkAdapters() {
  const interfaces = os.networkInterfaces();
  const physical = [];
  const virtual = [];

  for (const name of Object.keys(interfaces)) {
    const isVirtual = /vethernet|wsl|docker|virtual|vmware|vbox|loopback|bluetooth/i.test(name);
    for (const net of interfaces[name]) {
      // Look for non-internal IPv4, skip link-local (169.254.x.x)
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        const item = { name, address: net.address, isVirtual };
        if (isVirtual) {
          virtual.push(item);
        } else {
          physical.push(item);
        }
      }
    }
  }

  // Physical first, then virtual as fallback
  return [...physical, ...virtual];
}

function getNetworkAddresses() {
  return getNetworkAdapters().map(a => a.address);
}

app.get('/api/network-info', async (req, res) => {
  try {
    const adapters = getNetworkAdapters();
    const primaryIp = adapters.length > 0 ? adapters[0].address : 'localhost';
    const primaryAdapterName = adapters.length > 0 ? adapters[0].name : '';
    const localUrl = `http://localhost:${PORT}`;
    const networkUrls = adapters.map(a => `http://${a.address}:${PORT}`);

    // Determine primary URL:
    // 1. Explicit PUBLIC_URL env var (e.g. https://apartments.myserver.com)
    // 2. Request host from header (if domain or external IP)
    // 3. Primary physical LAN adapter
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
    const reqBaseUrl = hostHeader ? `${proto}://${hostHeader}` : null;

    let primaryUrl = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') : null;
    if (!primaryUrl) {
      if (reqBaseUrl && !hostHeader.startsWith('localhost') && !hostHeader.startsWith('127.0.0.1')) {
        primaryUrl = reqBaseUrl;
      } else {
        primaryUrl = `http://${primaryIp}:${PORT}`;
      }
    }

    // Generate base64 QR code image
    const qrDataUrl = await qrcode.toDataURL(primaryUrl, {
      margin: 2,
      scale: 7,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });

    res.json({
      success: true,
      port: PORT,
      primaryIp,
      primaryAdapterName,
      adapters,
      primaryUrl,
      localUrl,
      networkUrls,
      qrDataUrl
    });
  } catch (error) {
    console.error('Error getting network info:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── File Upload API ────────────────────────────────────────────────────────

// List files for a form
app.get('/api/forms/:id/files', (req, res) => {
  const formDir = path.join(filesDir, req.params.id);
  if (!fs.existsSync(formDir)) return res.json({ success: true, files: [] });
  try {
    const entries = fs.readdirSync(formDir).map(name => {
      const stat = fs.statSync(path.join(formDir, name));
      return { name, size: stat.size, mtime: stat.mtime };
    }).sort((a, b) => a.mtime - b.mtime);
    res.json({ success: true, files: entries });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Upload files for a form (up to 20)
app.post('/api/forms/:id/files', (req, res) => {
  // Check current count first
  const formDir = path.join(filesDir, req.params.id);
  const existing = fs.existsSync(formDir) ? fs.readdirSync(formDir).length : 0;

  const uploader = upload.array('files', MAX_FILES_PER_FORM - existing);
  uploader(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'גודל הקובץ חורג מהמותר (מקסימום 20MB)'
        : err.message || 'שגיאה בהעלאת קובץ';
      return res.status(400).json({ success: false, error: msg });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'לא נבחרו קבצים' });
    }
    const uploaded = req.files.map(f => ({ name: f.filename, size: f.size }));
    res.json({ success: true, files: uploaded });
  });
});

// Download / serve a file (supports inline preview for images and attachment download)
app.get('/api/forms/:id/files/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(filesDir, req.params.id, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'קובץ לא נמצא' });

  if (req.query.download === '1') {
    res.download(filePath, filename, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ success: false, error: 'שגיאה בהורדת הקובץ' });
      }
    });
  } else {
    // Serve inline (e.g. for image thumbnail preview)
    res.sendFile(filePath);
  }
});

// Delete a file
app.delete('/api/forms/:id/files/:filename', (req, res) => {
  const filePath = path.join(filesDir, req.params.id, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'קובץ לא נמצא' });
  try {
    fs.unlinkSync(filePath);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────

// Start listening on 0.0.0.0 (all network interfaces)
const server = app.listen(PORT, '0.0.0.0', async () => {
  const ips = getNetworkAddresses();
  const primaryIp = ips[0] || '127.0.0.1';
  const networkUrl = process.env.PUBLIC_URL || `http://${primaryIp}:${PORT}`;
  const localUrl = `http://localhost:${PORT}`;

  console.log('\n=============================================================');
  console.log('  🏡 מערכת צ\'ק-ליסט בדיקת דירות לקניה - שרת פעיל!');
  console.log('=============================================================');
  console.log(`  💻 גישה מקומית:   ${localUrl}`);
  console.log(`  📱 כתובת לחיבור: ${networkUrl}`);
  console.log('-------------------------------------------------------------');
  console.log('  סרוק באמצעות הנייד לפתיחה מיידית (באותה רשת Wi-Fi / שרת):');
  
  try {
    const terminalQR = await qrcode.toString(networkUrl, { type: 'terminal', small: true });
    console.log(terminalQR);
  } catch (err) {
    // Ignore terminal QR error if not supported
  }
  
  console.log('=============================================================\n');
});

// Graceful shutdown handling for Docker containers and system signals
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    try {
      db.db.close();
    } catch (e) {}
    console.log('Server and SQLite database closed safely. Exiting.');
    process.exit(0);
  });

  // Force close if graceful shutdown hangs
  setTimeout(() => {
    console.error('Shutdown timed out, force exiting.');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
