import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "conf.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    fio TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    capacity INTEGER NOT NULL
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    date_start TEXT NOT NULL,
    payment TEXT NOT NULL,
    status TEXT DEFAULT 'Новая',
    review TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT
  );
`);

const count         = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
const countrooms    = db.prepare("SELECT COUNT(*) AS c FROM rooms").get().c;
const requestsCount = db.prepare("SELECT COUNT(*) AS c FROM requests").get().c;

// FIX: сидинг в транзакции + хэширование паролей (без этого тестовые пользователи не входят)
db.transaction(() => {
  if (count === 0) {
    const stmt = db.prepare(`
      INSERT INTO users (login, password, fio, phone, email)
      VALUES (?, ?, ?, ?, ?)
    `);
    const demoPwd  = bcrypt.hashSync("demo", 10);
    const adminPwd = bcrypt.hashSync("demo77", 10);
    stmt.run("ivan",     demoPwd,  "Иванов Иван",     "8(999)123-45-67", "ivan@example.com");
    stmt.run("petr",     demoPwd,  "Петров Петр",     "8(999)123-45-68", "petr@example.com");
    stmt.run("anna",     demoPwd,  "Анна Сидорова",   "8(999)123-45-69", "anna@example.com");
    stmt.run("Conf2027", adminPwd, "Администратор",   "8(999)000-00-00", "admin@conf.com");
    console.log("Тестовые пользователи добавлены");
  }

  if (countrooms === 0) {
    const stmt = db.prepare(`
      INSERT INTO rooms (name, type, capacity)
      VALUES (?, ?, ?)
    `);
    stmt.run("КабанетСот", "Сотрудник", 10);
    stmt.run("КабинетРук", "Директор",   1);
    stmt.run("КабинетЗам", "Заместитель", 2);
    console.log("Комнаты добавлены");
  }

  if (requestsCount === 0) {
    const stmtrequests = db.prepare(`
      INSERT INTO requests (user_id, room_id, date_start, payment)
      VALUES (?, ?, ?, ?)
    `);
    stmtrequests.run(1, 1, "2027-03-15", "При очном посещении");
    stmtrequests.run(1, 3, "2027-03-20", "Перевод по СБП");
    stmtrequests.run(2, 3, "2027-04-01", "При очном посещении");
    console.log("Тестовые заявки добавлены");
  }
})();

class UserClass {
  constructor() { this.table = "users"; }
  findById(id)      { return db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id); }
  findByLogin(login){ return db.prepare(`SELECT * FROM ${this.table} WHERE login = ?`).get(login); }
  findAll()         { return db.prepare(`SELECT * FROM ${this.table}`).all(); }
  count() {
    const r = db.prepare(`SELECT COUNT(*) AS total FROM ${this.table}`).get();
    return r ? r.total : 0;
  }
  create({ login, password, fio, phone, email }) {
    const hashed = bcrypt.hashSync(password, 10);
    const r = db.prepare(`
      INSERT INTO ${this.table} (login, password, fio, phone, email)
      VALUES (?, ?, ?, ?, ?)
    `).run(login, hashed, fio, phone, email);
    return this.findById(r.lastInsertRowid);
  }
  exists(login) {
    return !!db.prepare(`SELECT 1 FROM ${this.table} WHERE login = ? LIMIT 1`).get(login);
  }
}
class RoomClass {
  constructor() { this.table = "rooms"; }
  findAll()          { return db.prepare(`SELECT * FROM ${this.table}`).all(); }
  findById(id)       { return db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id); }
  findByType(type)   { return db.prepare(`SELECT * FROM ${this.table} WHERE type = ? COLLATE NOCASE`).all(type); }
  // FIX: новый метод — нужен server.js для передачи списка типов в rooms.ejs
  allTypes() {
    return db.prepare(`SELECT DISTINCT type FROM ${this.table} ORDER BY type`).all().map(r => r.type);
  }
  count() {
    const r = db.prepare(`SELECT COUNT(*) AS total FROM ${this.table}`).get();
    return r ? r.total : 0;
  }
}
class RequestClass {
  constructor() { this.table = "requests"; } // FIX: было "Requests"
  findById(id) { return db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id); }

  // FIX: JOIN с rooms — иначе в dashboard.ejs нет room_name/room_type
  findByUser(userId) {
    return db.prepare(`
      SELECT r.*,
             rm.name AS room_name,
             rm.type AS room_type
      FROM ${this.table} r
      JOIN rooms rm ON rm.id = r.room_id
      WHERE r.user_id = ?
      ORDER BY r.id DESC
    `).all(userId);
  }

  // FIX: удалён битый метод rooms(type) — в requests нет колонки type

  count() {
    const r = db.prepare(`SELECT COUNT(*) AS total FROM ${this.table}`).get();
    return r ? r.total : 0;
  }
  updateStatus(id, status) {
    return db.prepare(`UPDATE ${this.table} SET status = ? WHERE id = ?`).run(status, id).changes > 0;
  }
  addReview(id, userId, review) {
    if (!review || !review.trim()) return false;
    return db.prepare(`
      UPDATE ${this.table}
      SET review = ?
      WHERE id = ? AND user_id = ? AND status = 'Завершено'
    `).run(review.trim(), id, userId).changes > 0;
  }
  findAllDetailed() {
    // FIX: исправлен алиас rooms: "u" (дубль) → "rm"
    return db.prepare(`
      SELECT r.*,
             u.fio   AS user_fio,
             u.login AS user_login,
             rm.name AS room_name,
             rm.type AS room_type
      FROM ${this.table} r
      JOIN users u  ON u.id  = r.user_id
      JOIN rooms rm ON rm.id = r.room_id
      ORDER BY r.id DESC
    `).all();
  }
  findDetailed(id) {
    return db.prepare(`
      SELECT r.*,
             u.fio      AS user_fio,
             u.login    AS user_login,
             u.email    AS user_email,
             u.phone    AS user_phone,
             rm.name     AS room_name,
             rm.type     AS room_type,
             rm.capacity AS room_capacity
      FROM ${this.table} r
      JOIN users u  ON u.id  = r.user_id
      JOIN rooms rm ON rm.id = r.room_id
      WHERE r.id = ?
    `).get(id);
  }
  create({ userId, roomId, dateStart, payment }) {
    const r = db.prepare(`
      INSERT INTO ${this.table} (user_id, room_id, date_start, payment)
      VALUES (?, ?, ?, ?)
    `).run(userId, roomId, dateStart, payment);
    return this.findById(r.lastInsertRowid);
  }
}

export const User    = new UserClass();
export const Room    = new RoomClass();
export const Request = new RequestClass();

export default db;