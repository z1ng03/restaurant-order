# Restaurant Order — backend + integrated frontend

A table-side ordering system: a kiosk-style menu/cart/checkout screen tied to
one physical monitor per table, a kitchen monitor, and a waiter monitor.
Built against `Техническое_задание.docx` and `Database - Лист1.pdf`.

This pass adds a complete **TypeScript backend** (there wasn't one — `backend/index.ts`
was `console.log("qwe")` with zero dependencies) and wires the existing
frontend prototype to it instead of a hardcoded menu + `localStorage` cart,
plus two new screens (kitchen and waiter monitors) that the ТЗ describes but
that didn't exist yet in the repo.

## Stack

- **Backend**: Node.js, TypeScript, Express, **Prisma** ORM, PostgreSQL, Zod
  (validation), JWT + bcrypt (staff auth)
- **Frontend**: the original plain HTML/CSS/JS, unchanged where possible,
  now calling the backend over `fetch`

## Project structure

```
backend/
  prisma/
    schema.prisma        # data model (see "Schema" below)
    migrations/           # initial migration, ready to apply
    seed.ts                # demo data: staff, tables, the same 18 dishes
                            # already in the old frontend's MENU array
  src/
    modules/                # one folder per business area (see below)
    middleware/, lib/, types/, config/, db/
    app.ts, server.ts
frontend/
  index.html, cart.html      # existing client screens, now API-backed
  kitchen.html, kitchen.js   # NEW — chef monitor
  waiter.html, waiter.js     # NEW — waiter monitor
  monitor-select.html        # NEW — local-dev table picker (see below)
  api.js, session.js, staff-auth.js, serial-payment.js  # shared client-side helpers
  style.css, staff.css       # existing styles + additions for the new screens
  arduino/rc522_payment.ino  # untouched — see "Payment hardware" below
```

## Quick start

### 1. Database

```bash
createdb restaurant_order   # or however you provision Postgres
cd backend
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, etc.
npm install
npx prisma migrate deploy   # applies prisma/migrations/20260916000000_init
npm run seed                # staff users, 6 tables, the 18-dish menu
npm run dev                 # http://localhost:4000
```

If you'd rather iterate on the schema than use the checked-in migration,
`npx prisma migrate dev` works too (it will detect the schema already
matches and offer to apply cleanly, or you can drop the database and let it
generate migrations from scratch).

> **A note on `npx prisma generate` / `migrate`, in case you hit the same wall I did:**
> these commands download a query-engine binary from Prisma's CDN
> (`binaries.prisma.sh`) the first time you run them. The sandbox this was
> built in whitelists specific domains for outbound traffic and that one
> wasn't on the list, so I could not run `prisma generate` or a live Prisma
> Client inside it. I validated the schema and every non-trivial piece of
> business logic (inventory reservation math, per-item consumption,
> checkout → kitchen → waiter → session/table lifecycle) by hand-translating
> `schema.prisma` into the SQL in `prisma/migrations/.../migration.sql` and
> running that against a real local Postgres — see the migration file, it's
> exactly what `prisma migrate dev` would have generated. On a normal machine
> with regular internet access, `npm install` + `prisma generate` just work;
> nothing about the code depends on the sandbox's restriction.

### 2. Frontend

```bash
cd frontend
./start_server.bat   # Windows; or `python3 -m http.server 8000` on macOS/Linux
```

Open `http://localhost:8000/monitor-select.html` — pick a table, and it'll
carry you into `index.html?monitor=N`. On a real deployment each physical
kiosk would just be bookmarked to its own `index.html?monitor=N` (ТЗ §1:
one monitor is permanently wired to one table) and would never see the
picker.

Kitchen monitor: `http://localhost:8000/kitchen.html` (demo login `marat` / `chef123`)
Waiter monitor: `http://localhost:8000/waiter.html` (demo login `aigerim` / `waiter123`)
Admin account: `admin` / `admin123` (no dedicated screen — see "Not built" below)

If the backend isn't running on `localhost:4000`, set
`window.RESTAURANT_API_BASE` before `api.js` loads on any page.

## Schema

`prisma/schema.prisma` mirrors `Database - Лист1.pdf` field-for-field —
same table names, same `VARCHAR(n)`-with-allowed-values-in-a-comment style
for status columns (rather than native Postgres enums, since that's what
the source spreadsheet used). A few things were added because the written
business flow needs them and the ERD didn't have a place for them yet, each
marked `// ADDED:` in the schema with its reasoning, in the same
"Добавил / Почему" spirit the ТЗ itself uses:

1. **`cart_item_options`** — the ТЗ says a client picks dish options *when
   adding to the cart* (§4), but the ERD only had `order_item_options`
   (options are recorded once an order exists). Without this table a chosen
   option couldn't survive from "add to cart" to checkout.
2. **`inventory_reservations.order_item_id`** — the ERD only ties a
   reservation to `order_id`. When one order has two items that need the
   same ingredient, there's no way to tell which item's reservation to
   release/consume when *that* item (not the whole order) starts cooking.
   `order_id` is kept too, so it's additive, not a replacement.
3. **`cart_items.notes` / `order_items.notes`** — the ТЗ says the chef
   should be able to see "особенности приготовления" per dish; nothing
   carried that text. Nullable, costs nothing if the frontend never sets it
   (the current UI doesn't expose an input for it yet either — the field is
   there for when it does).
4. The ERD lists both a singular `cart` and a plural `carts` table with
   identical columns — a leftover duplicate (`cart_items` itself points at
   `Carts`). Only `carts` is modeled.

## Business flow → code

The ТЗ's numbered pipeline, and where each step lives:

| # | Step | Endpoint / module |
|---|------|--------------------|
| 1 | Table/monitor pairing, session open | `POST /api/sessions/open` — `modules/sessions` |
| 2 | Menu list, computed availability | `GET /api/menu` — `modules/menu`, `inventory.service.ts` |
| 3 | Dish detail | `GET /api/menu/dishes/:id` |
| 4 | Add to cart (+ options, `price_at_add` snapshot) | `POST /api/cart/:sessionId/items` — `modules/cart` |
| 5 | Checkout validation | `GET /api/checkout/:sessionId/validate` — `modules/checkout` |
| 6 | 21+ verification | `POST /api/age-verification` — `modules/ageVerification` |
| 7–10 | Payment method → order created → ingredients reserved → sent to kitchen | `POST /api/checkout/:sessionId/confirm` (one transaction) |
| 9–11 | Kitchen monitor, item status, ingredient consumption | `modules/kitchen` |
| 12–13 | Waiter monitor, pickup, cash collection | `modules/waiter` |
| 14 | Delivery, session complete, table freed | `PATCH /api/waiter/orders/:id/delivered` |

Status enums (`order_status`, `order_item.status`, `payment_status`, …) and
their allowed transitions live in `src/types/status.ts`, matching the
values documented at the end of the ТЗ.

## Decisions made where the ТЗ was ambiguous

- **Age verification UI**: the ТЗ says a waiter walks over and confirms —
  it doesn't say *how* that reaches the system (payment explicitly says
  "card tap"; age verification doesn't). Implemented as the waiter entering
  their own login/password directly on the table's monitor
  (`POST /api/age-verification`), so `verified_by` is a real authenticated
  staff member rather than a client self-attestation — the client-facing
  build previously had "Мне есть 21 год" / "Мне нет 21 года" buttons the
  *client* clicked, which the ТЗ explicitly says shouldn't be trusted. That
  self-attestation UI was replaced; this is the one place I'd call the
  frontend change load-bearing rather than cosmetic. One verified check
  covers the rest of that session (ТЗ: "проверка относится к сессии"), not
  one check per order.
- **Payment method naming**: the ТЗ's only non-cash method is `KASPI_QR`.
  The existing frontend instead simulates a bank-card tap over Web Serial to
  a real Arduino + RC522 (`arduino/rc522_payment.ino` — genuine hardware
  integration, not decorative, so it was kept exactly as built). A
  successful tap now calls the backend with `paymentMethod: 'KASPI_QR'`; a
  declined tap never calls the backend at all, matching the ТЗ's Kaspi flow
  having no described failure branch. If you actually want a distinct `CARD`
  method recorded separately from `KASPI_QR`, that's a small schema/enum
  change away.
- **Cart lifecycle**: `carts.session_id` is `UNIQUE`, so a session has one
  persistent cart across however many orders it places (the ТЗ implies
  multiple orders per session: "если это был последний активный заказ
  сессии…"). "Cart marked CONVERTED" is implemented as clear-and-reset-to-
  `ACTIVE` rather than a dead end, so a second round of ordering in the same
  visit works.
- **Delivery requires payment settled**: the ТЗ doesn't explicitly forbid
  marking an order DELIVERED before cash is collected, but it also doesn't
  describe handing over food that hasn't been paid for. `markDelivered`
  enforces `payment_status === PAID` first — flagged in
  `waiter.service.ts` as an inferred rule, not a directly stated one.
- **Local dev table picker** (`monitor-select.html`): not part of the ТЗ —
  added purely so the client flow is testable without six physical kiosks.
  A real deployment never sees it.

## Not built

Kept in scope to what the ТЗ actually describes:

- **Admin UI** — the `users.role = ADMIN` and dish/category/ingredient
  management implied by the schema have no dedicated screen. The backend
  has what it needs (Prisma Studio — `npx prisma studio` — works fine
  against this schema for now); a real admin UI is a reasonable next step.
- **Real-time push** — kitchen/waiter monitors poll every 5s rather than
  using WebSockets/SSE. Simple, works, and the ТЗ doesn't ask for
  sub-second updates; swapping in a push channel later wouldn't touch the
  business logic, only how `GET /orders` results reach the screen.
- **Order/item cancellation** — the ТЗ's order-status enum has no
  `CANCELLED` state and the pipeline never describes cancelling a placed
  order, so no endpoint does it. `inventory_reservations.status` already
  has a `RELEASED` value ready for whenever that's designed.

## Demo data

`npm run seed` creates:

- Staff: `admin`/`admin123` (ADMIN), `aigerim`/`waiter123` (WAITER), `marat`/`chef123` (CHEF)
- 6 tables, monitor numbers 1–6, all `FREE`
- The same 6 categories / 18 dishes the old frontend had hardcoded, now with
  real recipes/ingredients/inventory behind them, plus 3 dish options and 8 allergens
