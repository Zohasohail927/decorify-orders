# Decorify Orders

Order-tracking app for The Decorify Studio. Runs on any phone from the browser, installs to the home screen like an app, and syncs orders live between phones.

## What it does

| Screen | Shows |
|---|---|
| Home | Orders, sales, cost, profit and margin (this month / all time); queue counts (New, In progress, Ready, Delivered); payment due; upcoming deliveries |
| Orders | All orders with search and status filters; one-tap "Mark In progress / Ready / Delivered"; WhatsApp button |
| Add / Edit | Customer, phone, lead source, address, **a list of items** (name, qty, price each, cost each), advance, dates, status, notes — totals, profit and balance due calculated live |
| Products | Saved products with default price and cost; picking one adds it to an order with prices prefilled |
| Insights | Sales, order profit (earned vs expected), lifetime figures, monthly trends with best/lowest months and averages, per-order averages, customers (by phone), product performance, monthly table and plain-language notes. Read-only. |
| Customers | Customer records with order history, total sales, average order and balance owed; repeat customers marked |
| Expenses | Business expenses, stock purchases and owner drawings (kept apart); corrections by voiding |
| Settings | Account, currency symbol, CSV exports (orders, payments, expenses, customers) |

Sale price = sum of qty × price over the items. Cost = sum of qty × cost when item costs are given, otherwise one total cost typed for the order. Profit = sale price − cost. Balance due = sale price − advance received. Orders created before version 2.1 (free-text items) keep their typed totals.

## Going live (about 30 minutes, once)

Three free services, set up in this order:

| # | Service | What it does | Account |
|---|---|---|---|
| 1 | Supabase | Stores every order and product in the cloud; both phones sync live | Sign up with Zoha's email |
| 2 | GitHub Pages | Hosts the app at a fixed web address | Zoha's GitHub (Zohasohail927) |
| 3 | GitHub Actions | Copies all data into a private repo every night | Same GitHub account |

### Step 1: Supabase (the data)

1. supabase.com → Start your project → sign up → **New project**. Name `decorify`, region **Singapore** or **Mumbai**, strong database password (save it in her password manager).
2. **SQL Editor** → New query → paste all of `supabase-schema.sql` → **Run**.
3. **Authentication → Users → Add user → Create new user**: one email + password you both use. Tick "Auto confirm user".
4. **Authentication → Sign In / Providers → Email**: turn **off** "Allow new users to sign up". This keeps strangers out.
5. **Project Settings → API keys**: copy the **Project URL** and the **anon / publishable** key into `config.js`. Also copy the **service_role / secret** key for Step 3. Never put the secret key in the app.

### Step 2: GitHub Pages (the app)

1. github.com (Zohasohail927) → **New repository** → name `decorify-orders` → **Public** → Create. (Public is required for free Pages; it contains code only. The orders live in Supabase behind the login.)
2. **Add file → Upload files** → upload `index.html`, `config.js`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png` → Commit.
3. **Settings → Pages** → Source "Deploy from a branch" → `main` / `(root)` → Save.
4. After a minute or two: `https://zohasohail927.github.io/decorify-orders/`
5. On her phone, open that link → Share (iPhone) or ⋮ menu (Android) → **Add to Home Screen** → open from the icon → Settings → sign in.

### Step 3: Nightly backup (the safety net)

1. github.com → **New repository** → name `decorify-backups` → **Private** → Create.
2. **Add file → Upload files**: upload `README.md`, `restore.sh` and the `data` folder from `decorify-backups`.
3. **Add file → Create new file**: type the name `.github/workflows/backup.yml` (the slashes create the folders), paste in the contents of `backup-workflow.yml`, then Commit.
4. That repo → **Settings → Secrets and variables → Actions → New repository secret**: `SUPABASE_URL` = project URL, `SUPABASE_SERVICE_KEY` = the secret key.
5. **Actions** tab → enable workflows → **Nightly backup → Run workflow**. After a minute `data/orders.json` shows up.

It then runs every night at 02:30 Pakistan time. The nightly call also keeps the Supabase project active, since free projects pause after a week with no activity.

## New phone, lost phone

Nothing lives only on the phone once she is signed in. On the new phone: open the link → Add to Home Screen → Settings → sign in. Every order and product loads back. Only the currency symbol is per-phone (default "Rs").

## If something goes really wrong

- **Supabase project paused:** supabase.com → the project → **Restore**. Data is kept.
- **Orders deleted by mistake:** in `decorify-backups`, open the History of `data/orders.json`, pick the day before, and run `restore.sh` with that file (or ask Claude to do it).
- **Manual copy any time:** app → Settings → Export orders (CSV).

## Updating the app later

Replace `index.html` (and `sw.js`) in the `decorify-orders` repo. The data is in Supabase, so updating the app never touches orders. The phone picks up the new version the next time it's opened. If it still looks old, close the app fully and reopen it.

## Insights: how the figures work

- Orders counted: booked orders that are not cancelled, grouped by order date (same as the Home screen).
- Order profit = sale price minus the direct cost recorded on the order, before business expenses. Earned = delivered; expected = still open.
- A cost of 0 on an order with a price is treated as not recorded (the form saves a blank as 0); profit is then shown only for orders with costs.
- Customers are recognised by phone number only.
- Monthly averages and best/lowest months use complete calendar months only.
- Calculations live in `insights-core.js`; tests in `tests/insights.test.js` (run: `node tests/insights.test.js`).

## Version 6 (payments, customers, expenses)

Run `supabase-migration-3.sql` once in Supabase → SQL Editor **before** uploading the v6 app files. It is additive (nothing is deleted) and runs as one transaction. `supabase-migration-3-rollback.sql` undoes only the access rules.

- **Payments ledger**: many payments and refunds per order. Balance = order total − (payments − refunds). Overpayment shows as customer credit. A wrong entry is voided with a reason, never deleted. Delivery never marks an order paid.
- **Costs**: a blank cost means "not entered" (not 0). An order made of pieces has a cost only when every piece has one. Profit is shown only for orders with complete costs, with the count of the rest.
- **Delivery**: the actual delivery date is saved when an order is marked Delivered; the planned date is kept. Insights can count by order date or by delivery date.
- **Customers**: orders link to a customer record and keep their own name/phone/address copy. Matching by phone is suggested, never automatic.
- **Expenses & P&L**: Insights shows delivered sales − direct costs = order profit − business expenses = operating profit. Stock purchases and owner drawings are listed separately.
- **Safety**: only approved logins (table `app_users`) can see data; every change is written to `audit_log` by the database; two phones editing the same order get a "changed on another phone" choice instead of silently overwriting; drafts are kept on the phone until saved; signing out removes the phone's copy; the service worker never caches customer data.
- **Tests**: `node tests/insights.test.js`, `node tests/finance.test.js` (run with `TZ=Asia/Karachi`); SQL access tests in `tests/sql/`; end-to-end results in `tests/e2e-results.txt`.

## Version 6.1 (Modern Navy design)

A front-end-only redesign. No database changes, no change to any calculation, sync or sign-in.

- **Design system** (`build/navy.css`): semantic colour tokens for Light (Premium Navy) and Dark (Midnight Navy); Inter typeface self-hosted as `inter-var.woff2` (no Google Fonts request, works offline); one spacing, radius, shadow and motion scale; WCAG AA contrast for text and form-field borders.
- **Phone**: navy header; Home, Orders, New order, Insights, More tab bar; More holds Clients, Products, Expenses, Settings and the theme choice. Respects iPhone safe areas.
- **Dashboard**: navy performance card (order profit, sales, direct cost, margin, six-month bars), money owed / orders / in-the-studio cards, quick actions, a connected order pipeline, upcoming deliveries and needs-attention lists. Designed empty states when there are no orders.
- **Desktop**: navy sidebar with grouped navigation, theme switch and sync status; drawer-style order sheets.
- **Themes**: Light, Dark, System (follows the phone, remembered, applied before first paint). Build: `python3 build/assemble.py`.
- **Tests**: `tests/qa-layout-theme.js` checks overflow at 390/430/768/1440 px in both themes, touch-target sizes, theme switching and persistence, keyboard shortcuts and reduced motion.

## Version 6.2 (per-unit or total / batch costing)

Each piece on an order, and each saved product, can take its cost in one of two ways:

- **Per unit**: type the cost of one piece. The total is quantity × unit cost.
- **Total / batch**: type what the whole quantity cost (e.g. 12 stickers for Rs 27, or the sheets for 10 cones for Rs 60). The unit cost is worked out (Rs 2.25, Rs 6).

Rules (in `insights-core.js`, `DSInsights.costing`, tested in `tests/costing.test.js`):

- When the quantity changes, the unit cost is kept and the total is worked out again ("Total cost updated using the previous unit cost"). Typing a new total then sets the unit cost.
- Switching method never changes the cost. A batch total is kept exactly to the paisa; the unit cost is kept unrounded, so 3 for Rs 10 stays Rs 10.00 (never 9.99).
- Blank means not entered (no profit is shown); 0 typed is a real zero. Negative costs and quantities below 1 can't be saved.
- A product's usual cost fills in new order lines ("Estimated total cost"). Each order keeps its own cost, so changing a product never changes saved orders.
- Storage: order lines are JSON on the order. Per-unit lines keep the original `{name, qty, price, cost}` shape; batch lines add `cost_mode: "total"` and the exact `cost_total`. No change is needed to the orders table.
- Products: `supabase-migration-4.sql` (optional, additive) adds `cost_batch_qty` and `cost_batch_total` so a product's batch is remembered. Without it, a batch typed for a product is saved as its unit cost. Undo: `supabase-migration-4-rollback.sql`.

## Version 6.3 (iPhone stability)

Root causes found and fixed:

- **Zooming in when a field is tapped**: iOS Safari zooms the page when an input's text is under 16px, and stays zoomed. The order-piece fields were 15px (15.5px in 6.2). Every input, dropdown and text box is now 16px or larger; `tests/audit.js` checks this.
- **Page appearing zoomed out / sliding sideways**: on Products (and other lists with long names) a grid column could not shrink below the longest name, so the page became 413–418px wide on a 390px screen. All grid columns now use `minmax(0, …)`, and long unbroken text wraps.
- **Double-tap zoom**: rapid taps (e.g. + / − quantity) triggered iOS double-tap zoom. `touch-action: manipulation` turns that off; pinch-zoom is untouched (no `user-scalable=no`, no `maximum-scale`).
- **Landscape**: an iPhone on its side (956px wide) switched to the desktop sidebar layout. Layouts now depend on height too, so phones keep the phone layout with slimmer bars.

Also: the bottom tab bar steps aside while the keyboard is up (no floating bar); sticky bars leave room for focused fields (`scroll-padding`); each screen keeps its scroll position and tapping the current tab returns to the top; safe-area insets on all sides (Dynamic Island in landscape); no stuck hover states after a tap; calm screen fade; `100vh` fallbacks for `dvh`; long order lists drawn 150 at a time; build fingerprint on the core script, the offline cache and the Settings version line, so old and new files are never mixed; no reloads forced under the user.

Tests: `tests/mobile.js` (iPhone walk-through at 390/402/430/440 px, landscape, 150% and 200% zoom), `tests/audit.js`, plus all earlier suites. These run in Chromium with mobile emulation, not on a real iPhone.
