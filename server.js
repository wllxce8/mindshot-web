// Mindshot — servidor de lobbies em tempo real + Autenticação por E-mail
const http = require("http"), crypto = require("crypto"), fs = require("fs"), path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const APP_SECRET = process.env.APP_SECRET || "turbine sua mente com o mindshot";
const SENDER_EMAIL = process.env.SENDER_EMAIL || "wallac1nmma@gmail.com";

// Decodifica credenciais caso não estejam nas variáveis de ambiente do Render
const _d = s => Buffer.from(s, "base64").toString("utf8");
const DB_URL = process.env.DATABASE_URL || _d("cG9zdGdyZXNxbDovL21pbmRzaG90X2RiX3VzZXI6dk94Mll1V0xBdHFadThWd3BoR0thbkZ2VEwwNHk4UDBAZHBnLWRjMHMzcGMwOTE2czczY21hbGtnLWEvbWluZHNob3RfZGI=");
const BREVO_KEY = process.env.BREVO_API_KEY || _d("eGtleXNpYi03NGNjNmU5NDdkMzk5NzBlMjRmZGViOGRiYzMzOWE4MDRkY2RhZGMyMDUzMGQyYzhmMzI3NDExMWJkZDc0MWE4LTI0d0lyQzBzQ3p0eWI2Z28=");

// --- Conexão com PostgreSQL ---
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes("render.com") ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        email VARCHAR(255) PRIMARY KEY,
        name VARCHAR(100),
        role VARCHAR(20) DEFAULT 'stu',
        otp_code VARCHAR(10),
        otp_expires BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("PostgreSQL conectado e tabela 'users' verificada.");
  } catch (err) {
    console.error("Erro ao conectar/criar tabela no PostgreSQL:", err.message);
  }
}
initDB();

// --- Utilitários HTTP & Token ---
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 1e5) reject(new Error("Payload muito grande"));
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(obj));
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", APP_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", APP_SECRET).update(data).digest("base64url");
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

async function sendEmailBrevo(toEmail, code) {
  const res = await fetch("https://brevo.com", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": BREVO_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: { name: "Mindshot PvP", email: SENDER_EMAIL },
      to: [{ email: toEmail }],
      subject: `Código de acesso Mindshot: ${code}`,
      htmlContent: `
        <div style="font-family:sans-serif;max-width:460px;margin:auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;">
          <h2 style="margin-top:0;color:#1e293b;">Mindshot PvP</h2>
          <p style="color:#475569;font-size:15px;">Use o código abaixo para confirmar seu acesso. Ele vale por 15 minutos:</p>
          <div style="font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px;background:#f1f5f9;color:#0f172a;text-align:center;border-radius:8px;margin:20px 0;">
            ${code}
          </div>
          <p style="color:#94a3b8;font-size:12px;margin-bottom:0;">Turbine sua mente com o Mindshot.</p>
        </div>`
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo API (${res.status}): ${errText}`);
  }
}

// --- Servidor HTTP ---
const lobbies = new Map();
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", rid = n => crypto.randomBytes(n).toString("hex");
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => ALPHA[crypto.randomInt(32)]).join(""); } while (lobbies.has(c)); return c; };

const srv = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    return sendJSON(res, 200, { ok: true });
  }

  if (urlPath === "/health") {
    res.end("ok");
    return;
  }

  // ROTA 1: Enviar código OTP por e-mail
  if (req.method === "POST" && ["/api/auth/send-code", "/api/send-code", "/api/login", "/login"].includes(urlPath)) {
    try {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        return sendJSON(res, 400, { ok: false, msg: "Digite um e-mail válido." });
      }

      const code = String(crypto.randomInt(100000, 999999));
      const expires = Date.now() + 15 * 60 * 1000;

      await pool.query(`
        INSERT INTO users (email, otp_code, otp_expires)
        VALUES ($1, $2, $3)
        ON CONFLICT (email) DO UPDATE SET otp_code = $2, otp_expires = $3
      `, [email, code, expires]);

      await sendEmailBrevo(email, code);
      return sendJSON(res, 200, { ok: true, msg: "Código enviado! Verifique sua caixa de entrada ou spam." });
    } catch (e) {
      console.error("Erro no envio de código:", e);
      return sendJSON(res, 500, { ok: false, msg: "Erro ao enviar e-mail: " + e.message });
    }
  }

  // ROTA 2: Validar código OTP e finalizar login
  if (req.method === "POST" && ["/api/auth/verify-code", "/api/verify-code", "/api/verify", "/verify"].includes(urlPath)) {
    try {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      const name = String(body.name || "").replace(/[<>]/g, "").trim().slice(0, 30);
      const role = body.role === "prof" ? "prof" : "stu";

      if (!email || !code) {
        return sendJSON(res, 400, { ok: false, msg: "Informe o e-mail e o código recebido." });
      }

      const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
      const user = rows[0];

      if (!user || user.otp_code !== code) {
        return sendJSON(res, 401, { ok: false, msg: "Código inválido." });
      }
      if (Date.now() > Number(user.otp_expires)) {
        return sendJSON(res, 401, { ok: false, msg: "Código expirado. Solicite um novo." });
      }

      const finalName = name || user.name || email.split("@")[0];
      await pool.query(
        "UPDATE users SET otp_code = NULL, otp_expires = NULL, name = $1, role = $2 WHERE email = $3",
        [finalName, role, email]
      );

      const token = signToken({ email, name: finalName, role, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 });
      return sendJSON(res, 200, { ok: true, token, user: { email, name: finalName, role } });
    } catch (e) {
      console.error("Erro ao verificar código:", e);
      return sendJSON(res, 500, { ok: false, msg: "Erro interno ao verificar código." });
    }
  }

  // ROTA 3: Validar sessão salva (opcional)
  if (req.method === "GET" && urlPath === "/api/auth/me") {
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const user = verifyToken(token);
    if (!user) return sendJSON(res, 401, { ok: false, msg: "Sessão inválida." });
    return sendJSON(res, 200, { ok: true, user: { email: user.email, name: user.name, role: user.role } });
  }

  // Evita retornar index.html para chamadas de API desconhecidas
  if (urlPath.startsWith("/api/")) {
    return sendJSON(res, 404, { ok: false, msg: "Endpoint não encontrado." });
  }

  // Servir o jogo (index.html)
  fs.readFile(path.join(__dirname, "index.html"), (e, d) => {
    if (e) { res.writeHead(404); res.end("index.html não encontrado"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(d);
  });
});

/* --- WebSocket mínimo (RFC 6455) --- */
function frame(op, buf) {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, buf]);
}

srv.on("upgrade", (req, sock) => {
  if (req.url.split("?")[0] !== "/ws" || !req.headers["sec-websocket-key"]) { sock.destroy(); return; }
  const acc = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
  const c = { sock, alive: true, lobby: null, pid: null }; let buf = Buffer.alloc(0);
  c.send = o => { if (!sock.destroyed) sock.write(frame(1, Buffer.from(JSON.stringify(o)))); };
  sock.setNoDelay(true);
  sock.on("data", d => {
    buf = Buffer.concat([buf, d]); if (buf.length > 1 << 20) { sock.destroy(); return; }
    for (; ;) {
      if (buf.length < 2) return; const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
