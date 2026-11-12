# KinoBattle server

Node-сервер: акаунти (HTTP `/api/…`), гра з людиною (WebSocket `/ws`) і роздача веб-превʼю (`/preview/`).
Логіка матчу — у `../shared/engine.js` (той самий код грає з ботом у браузері).

Модулі: `server.js` (збірка, статика), `api.js` (HTTP API), `game.js` (лобі й матчі),
`auth.js` (коди входу на пошту), `db.js` (SQLite через вбудований `node:sqlite`).

```sh
npm install
npm start          # http://localhost:5180/preview/
npm test           # рушій + наскрізні тести з двома клієнтами
```

Змінні середовища:

| Змінна | За замовчуванням | Навіщо |
|---|---|---|
| `PORT` | `5180` | порт HTTP і WebSocket |
| `HOST` | `127.0.0.1` | `0.0.0.0` — щоб зайти з телефона в тій самій Wi-Fi (`http://<IP компʼютера>:5180/preview/`; Windows спитає дозвіл у брандмауері) |
| `TIME_SCALE` | `1` | множник усіх пауз; тести ставлять `0.01` |
| `DB_PATH` | `server/data/kinobattle.db` | файл бази; `:memory:` — тимчасова база (тести) |
| `RESEND_API_KEY`, `MAIL_FROM` | — | справжні листи з кодами через [Resend](https://resend.com). Без ключа — режим розробки: код друкується в консоль і повертається в API як `devCode` |

Сервер — єдине джерело правди: обирає питання, перемішує варіанти, міряє час відповіді й рахує
очки. Клієнт лише показує стан і надсилає вибір, тож підробити час чи очки з клієнта не вийде.
Час відповіді міряється в момент, коли відповідь дійшла до сервера, тому гравець із повільнішою
мережею втрачає кілька очок за питання.

Кімнати, черга й запрошення живуть у памʼяті процесу (зникають після перезапуску);
акаунти, історія, рейтинг і друзі — у базі.

## Акаунти

- **Гість** — створюється з одним лише імʼям. Має історію й статистику, але не має рейтингу,
  коду друга й не потрапляє в таблицю лідерів.
- **Зареєстрований** — гість, що підтвердив пошту кодом. Той самий акаунт, тож прогрес лишається.
  Якщо пошта вже належить іншому акаунту — це вхід, а матчі поточного гостя переносяться туди.
- **Рейтинг** — Elo (старт 1000, K = 32), лише за матчі між двома зареєстрованими.
  Матчі з ботом грають на пристрої й ідуть лише в статистику.
- **Друзі** — за 6-символьним кодом: запит → прийняття (зустрічний запит = одразу друзі).
  Онлайн-друга можна позвати в гру через WebSocket (`invite`).

### HTTP API

Авторизація — `Authorization: Bearer <token>`. Помилки — `{ "error": "текст" }` з відповідним статусом.

| Запит | Тіло | Відповідь |
|---|---|---|
| `POST /api/guest` | `name` | `token`, `me` |
| `POST /api/auth/email/start` | `email` | `sent`, `email`, `devCode` (лише в режимі розробки) |
| `POST /api/auth/email/verify` | `email`, `code` (+ токен гостя, якщо є) | `token`, `me`, `merged` |
| `POST /api/auth/logout` | — | `ok` |
| `GET /api/me` | — | профіль: `id`, `name`, `guest`, `email`, `friendCode`, `rating`, `rank`, `stats` |
| `PATCH /api/me` | `name` | профіль |
| `DELETE /api/me` | — | `deleted` (вимога App Store: акаунт можна видалити із застосунку) |
| `GET /api/me/history` | — | `matches` (останні 30) |
| `POST /api/matches/bot` | `length`, `outcome`, `you`, `opponent` (`score`, `correct`) | `ok` |
| `GET /api/leaderboard` | — | `top` (до 50), `me` (`rank`, `rating`, `guest`) |
| `GET /api/friends` | — | `friends` (з `online`), `incoming`, `outgoing`, `friendCode` — лише з акаунтом |
| `POST /api/friends` | `code` | `status` (`pending` / `accepted`), `friend` |
| `POST /api/friends/:id/accept` | — | `ok` |
| `DELETE /api/friends/:id` | — | `ok` (видалити друга / відхилити чи скасувати запит) |

## Протокол WebSocket

Повідомлення — JSON-обʼєкти з полем `t`.

**Клієнт → сервер**

| `t` | Поля | Що робить |
|---|---|---|
| `auth` | `token` | привʼязати зʼєднання до акаунта (надсилати першим) → `authed` / `authError` |
| `hello` | `name` | імʼя для зʼєднання без акаунта (до 24 символів) |
| `invite` | `friendId`, `length` | позвати друга, що онлайн → `inviteSent`; другу — `invited` |
| `inviteAccept` / `inviteDecline` | `inviteId` | відповідь на запрошення |
| `quick` | `length` (7/14) | стати в чергу на випадкового суперника |
| `create` | `length` | створити кімнату → `room` з кодом |
| `join` | `code` | увійти в кімнату за кодом (код одноразовий) |
| `cancel` / `leave` | — | вийти з черги / кімнати / матчу (у матчі — технічна поразка) |
| `answer` | `index`, `option` | відповідь на питання `index` |
| `skip` | `index` | «далі» на картці факту; переходимо, коли готові обидва |
| `rematch` | — | реванш; стартує, коли попросили обидва |

**Сервер → клієнт** (ті самі повідомлення шле й локальний `Match` у грі з ботом)

| `t` | Поля |
|---|---|
| `queued` | `length` |
| `room` | `code`, `length` |
| `error` | `message` |
| `start` | `total`, `you`, `opponent` (`name`, `avatar`, `isBot`) |
| `question` | `index`, `total`, `multiplier`, `type`, `prompt` — варіанти приходять окремо після паузи (банер ×2 + 1 с) |
| `options` | `index`, `options`, `time` |
| `answerAccepted` | `index`, `option` |
| `opponentAnswered` | `index` — без вибору суперника |
| `reveal` | `index`, `correctIndex`, `fact`, `duration`, `you`/`opponent` (`option`, `points`, `score`) |
| `opponentReady` | `index` — суперник уже натиснув «далі» |
| `end` | `outcome` (`win`/`loss`/`draw`), `reason` (`null`/`opponentLeft`), `total`, `you`/`opponent` (`score`, `correct`) |
| `rating` | після `end` у матчі з людиною: `rated: true`, `delta`, `rating` або `rated: false`, `why` (`guest` / `opponentGuest`) |
| `rematchRequested` | — |
| `opponentLeft` | — |
| `invited` | `inviteId`, `from` (`id`, `name`), `length` |
| `inviteSent` | `inviteId`, `friend` (`id`, `name`) |
| `inviteDeclined` | `name` |
| `inviteCancelled` | `inviteId` |
