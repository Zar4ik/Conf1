import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import db, { User, Room, Request } from "./db.js";
import session from "express-session";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;
const INACTIVITY_LIMIT = 20 * 60 * 1000;
const ADMIN_LOGIN = "Conf2027";

const RULES = [
  {
    field: "login",
    test: (v) => /^[A-Za-z0-9]{6,}$/.test(v),
    msg: "Логин: латиница+цифры, минимум 6 символов",
  },
  {
    field: "password",
    test: (v) => v && v.length >= 8,
    msg: "Пароль: минимум 8 символов",
  },
  {
    field: "fio",
    test: (v) => /^[А-Яа-яЁё\s]+$/.test(v),
    msg: "ФИО: только кириллица и пробелы",
  },
  {
    field: "phone",
    test: (v) => /^8\(\d{3}\)\d{3}-\d{2}-\d{2}$/.test(v),
    msg: "Телефон: формат 8(ХХХ)ХХХ-ХХ-ХХ",
  },
  {
    field: "email",
    test: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
    msg: "Email: некорректный формат",
  },
];

const validate = (data) =>
  RULES.filter(({ field, test }) => !test((data[field] || "").trim())).map(
    (r) => r.msg,
  );

const requireAuth = (req, res, next) =>
  req.session.userId ? next() : res.redirect("/login"
  );

const requireAdmin = (req, res, next) => {
  if (!req.session.userId) return res.redirect("/login");
  if (req.session.login !== ADMIN_LOGIN) return res.redirect("/dashboard");
  next();
};

app.set("view engine", "ejs");
app.set("views", "./views");

app.use(express.urlencoded({ extended: true }));
app.use(express.static(join(__dirname, "public")));
app.use(
  session({
    secret: "conf2027-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 2, httpOnly: true, sameSite: "lax" },
  }),
);
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.currentPath = req.path;
  next();
});
app.use((req, res, next) => {
  if (req.session && req.session.userId) {
    const now = Date.now();
    if (
      req.session.lastActivity &&
      now - req.session.lastActivity > INACTIVITY_LIMIT
    ) {
      return req.session.destroy(() => res.redirect("/login"));
    }
    req.session.lastActivity = now;
  }
  next();
});

app.get("/register", (req, res) => {
  res.render("auth", {
    mode: "register",
    form: {},
    errors: [],
    flash: null,
  });
});
app.post("/register", (req, res) => {
  const errors = validate(req.body);

  if (User.exists(req.body.login)) {
    errors.push("Логин уже занят");
  }
  if (errors.length) {
    return res.render("auth", {
      mode: "register",
      form: req.body,
      errors,
      error: null,
      flash: null,
    });
  }

  User.create(req.body); // модель сама хэширует
  req.session.flash = {
    type: "success",
    text: "Регистрация успешна. Войдите.",
  };
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render("auth", {
    mode: "login",
    form: {},
    error: null,
    errors: [],
    flash,
  });
});
app.post("/login", (req, res) => {
  const user = User.findByLogin(req.body.login);
  if (user && bcrypt.compareSync(req.body.password, user.password)) {
    req.session.userId = user.id;
    req.session.fio = user.fio;
    req.session.login = user.login;
    req.session.lastActivity = Date.now();
    return res.redirect(user.login === ADMIN_LOGIN ? "/admin" : "/dashboard");
  }
  res.render("auth", {
    mode: "login",
    form: { login: req.body.login },
    error: "Неверный логин или пароль",
    errors: [],
    flash: null,
  });
});

app.all("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", (req, res) => res.redirect("/rooms"));

app.get("/rooms", (req, res) => {
  const rooms = Room.findAll();
  const types = Room.allTypes();
  res.render("rooms", { rooms, types, activeType: null });
});
app.get("/rooms/type/:type", (req, res) => {
  const rooms = Room.findByType(req.params.type);
  const types = Room.allTypes();
  res.render("rooms", { rooms, types, activeType: req.params.type });
});

app.get("/create", requireAuth, (req, res) => {
  const rooms = Room.findAll();
  const preselected = req.query.room_id || "";
  res.render("create_request", {
    rooms,
    errors: [],
    form: preselected ? { room_id: preselected } : {},
  });
});
app.post("/create", requireAuth, (req, res) => {
  const { room_id, date_start, payment } = req.body;
  if (!room_id || !date_start || !payment) {
    return res.render("create_request", {
      rooms: Room.findAll(),
      errors: ["Заполните все поля формы"],
      form: req.body,
    });
  }
  Request.create({
    userId: req.session.userId,
    roomId: room_id,
    dateStart: date_start,
    payment,
  });
  return res.redirect("/dashboard");
});

app.get("/dashboard", requireAuth, (req, res) => {
  const requests = Request.findByUser(req.session.userId);
  res.render("requests_list", { isAdmin: false, requests });
});

app.get("/admin", requireAdmin, (req, res) => {
  const requests = Request.findAllDetailed();
  res.render("requests_list", { isAdmin: true, requests });
});
app.post("/admin", requireAdmin, (req, res) => {
  Request.updateStatus(req.body.id, req.body.status);
  res.redirect("/admin");
});

app.get("/request/:id", requireAuth, (req, res) => {
  const request = Request.findDetailed(req.params.id);
  if (!request) return res.status(404).send("Заявка не найдена");

  const isOwner = request.user_id === req.session.userId;
  const isAdmin = req.session.login === ADMIN_LOGIN;
  if (!isOwner && !isAdmin) return res.status(403).send("Доступ запрещён");

  res.render("request_detail", { request, isOwner, isAdmin });
});
app.post("/review/:id", requireAuth, (req, res) => {
  const request = Request.findDetailed(req.params.id);
  if (!request) return res.status(404).send("Заявка не найдена");
  if (request.user_id !== req.session.userId) {
    return res.status(403).send("Только владелец может оставить отзыв");
  }
  const review = (req.body.review || "").trim();
  const ok = Request.addReview(request.id, req.session.userId, review);
  if (!ok) {
    return res
      .status(400)
      .send("Нельзя оставить отзыв: заявка не завершена или текст пуст");
  }
  res.redirect(`/request/${request.id}`);
});

app.use((req, res) => res.status(404).send("Страница не найдена"));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Ошибка сервера");
});

app.listen(PORT, () => {
  console.log(`Сервер: http://localhost:${PORT}`);
});
