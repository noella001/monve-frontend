# MONVÉ storefront

The site is a React/Vite storefront with a small Node service for local catalogue management, customer accounts, and saved shopping. It stores catalogue and account data on disk, authenticates customers and admins, and sends catalogue updates to the customer portal. Orders, Customs requests, checkout, and payments still need a full replacement service.

## Website and backend documentation

The 4 November 2026 source snapshot is documented in [Website current state](docs/website-current-state.md). Use [Backend requirements](docs/backend-requirements.md) for the complete feature mapping, API contracts, data model, integration changes and acceptance checklist. The [AI backend build prompt](docs/backend-ai-prompt.md) is ready to copy into a development AI with access to this repository.

## Run locally

From the project root:

```sh
npm ci
npm run dev
```

`npm run dev` starts the API on port 3001 and the storefront on port 5173. Copy `.env.example` to `.env` if needed, then set a private `ADMIN_PASSWORD` before signing in. `ADMIN_EMAIL` optionally restricts that credential to one address. Customer accounts use email and a password of at least 12 characters. The development API creates an unpredictable session secret at startup when `SESSION_SECRET` is not set.

Products and customer accounts are stored in `.data/monve/products.json` and `.data/monve/accounts.json`; uploaded product images are stored in `.data/monve/uploads/`. These paths are ignored by Git. Account passwords are stored as scrypt hashes, and saved carts and wishlists are tied to customer accounts on the API.

## Scope of the local product service

- Admin login, product list, category filters, product create/edit/delete, and product image uploads.
- Customer signup, login, logout, account session restoration, and server-saved carts and wishlists.
- The public catalogue reads the same saved product file, so a product added in Admin appears in the storefront and survives a server restart.
- The service is a single-process, JSON-file implementation for local use and small single-instance deployments. Keep its data directory on persistent storage and back it up. Do not run multiple API replicas against the same JSON files.

This local service still returns unavailable routes for orders, Customs requests, and payments. Deploy a full backend for those features.

## Production deployment

Deploy `backend/server.mjs` as a Node service with a persistent data volume (start it with `npm run start:backend`). Set `ADMIN_PASSWORD`, `SESSION_SECRET`, `API_PUBLIC_URL`, `APP_ORIGINS`, and `VITE_API_BASE_URL` in the appropriate server/build environments. Additional admins can be added later through server-only `ADMIN_ACCOUNTS_JSON`, an array of `{ "email", "password" }` entries; the existing admin credential remains valid. Keep the frontend and API on the same site (for example, `shop.example.com` and `api.example.com`) so the authentication cookies work. Never put server secrets in a `VITE_` variable.

For a larger or multi-instance deployment, replace the JSON-file store with a transactional database and shared media storage before adding replicas.

## Connect your replacement

The frontend integration boundary is `frontend/src/services/`:

- `api.ts`: catalogue, orders, Customs, store settings and events.
- `account.ts`: account/session operations.
- `http.ts`: optional HTTP transport, availability flag and response errors.
- `shared/types.ts`: the data shapes consumed by the pages.

To use a different API, set `VITE_API_BASE_URL` in the root `.env` to its origin, then restart Vite or rebuild. The origin must serve the routes below. Requests include cookies; configure the replacement service for the frontend origin and its authentication approach.

| Frontend operation | Current HTTP contract |
| --- | --- |
| Catalogue | `GET /api/products` returns `Product[]` |
| Product management | `POST /api/products`, `PUT /api/products/:id`, `DELETE /api/products/:id` |
| Orders | `GET/POST /api/orders`, `PATCH /api/orders/:id/status` |
| Customs | `GET/POST /api/custom-requests`, `PATCH /api/custom-requests/:id/status` |
| Customer accounts | `/api/account/session`, `/signup`, `/login`, `/logout`, `/shopping`, `/shopping/merge`, `/orders` |
| Admin authentication | `/api/admin/session`, `/login`, `/logout` |
| Admin email | `/api/admin/customers`, `/api/admin/emails/status`, `/api/admin/emails`, `/api/admin/emails/send` |
| Existing payment settings UI | `GET/POST /api/flutterwave/config` |

Successful responses contain the relevant JSON data (or HTTP 204 for void operations). Errors may return `{ "error": "message" }`. Customer sign-in returns `{ customer, cart, wishlist, orders }`; a guest session returns `{ customer: null }`. The shared `/login` form also accepts the server-configured admin credentials and routes admins to `/admin`.

The local product service supports product events at `GET /api/events`; the frontend polls this route so the customer catalogue updates after a product change. A replacement service can provide the same route or configure an SSE endpoint.

The replacement service must own authentication, permissions, durable storage, pricing and payment verification. The retained checkout payload contains simulated payment-success fields, including when the signed-in screen says the order is unpaid; replace this behavior before accepting real orders. The current admin settings form shows non-secret fields, but the shared configuration type still includes `secret_key`. Remove that field from the browser contract and never return payment secrets to the frontend. Never put passwords or secret keys in `VITE_` variables, which are public browser configuration.

The admin email panel sends individual plain-text messages via the connected backend. Configure Brevo only in the backend's private environment; signup, delivery-status and abandoned-cart automations are not enabled yet.

## Existing data

Ignored `.data/` files are preserved for migration and are not read by the storefront directly. New customer accounts and saved shopping are stored by the API in `.data/monve/accounts.json`; legacy account files are not imported automatically. Admin credentials continue to come from server-only environment variables.

## Build and deploy

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

The build output is `frontend/dist`. Deploy it to a static host and configure an SPA fallback to `index.html` for routes such as `/shop`, `/customs`, `/account` and `/admin`. `npm run preview` is a local build preview, not a production application server.
