# sui-sub API Documentation

Base URL: `http://<host>:8780`

Authentication:
- Login endpoint issues cookie session (`sui_sub_session`).
- Most admin APIs require authenticated session.

---

## Auth

### POST `/api/auth/login`
Request:
```json
{ "username": "admin", "password": "admin123" }
```
Response:
```json
{ "ok": true, "username": "admin" }
```

### POST `/api/auth/logout`
Logout current session.

### GET `/api/auth/me`
Check session status.

---

## Admin / User

### GET `/api/admin/user`
Get current admin username.

### POST `/api/admin/user`
Update admin username/password/template URL.

### GET `/api/admin/subscription-logs`
Get subscription access logs.

---

## Source Management

### GET `/api/sources`
List all sources.

### POST `/api/sources`
Add source (supports token or `username:password` input).

### PUT `/api/sources/:id`
Update source info.

### DELETE `/api/sources/:id`
Delete source.

### POST `/api/sources/sync-all`
Trigger sync for all non-local sources.

---

## Secure Panel Proxy

### ALL `/panel-proxy/:sourceId/*`
Securely proxy upstream SUI panel pages and APIs.

Typical usage:
- Open panel via `/panel-proxy/:sourceId/`
- Login via proxied `/panel-proxy/:sourceId/auth/login`

---

## View APIs (frontend bootstrap)

### GET `/api/view/home`
Home tab payload.

### GET `/api/view/nodes`
Nodes tab payload.

### GET `/api/view/bootstrap`
Full bootstrap payload.

### GET `/api/view/modal-nodes`
Node selector payload.

### GET `/api/view/subscriptions`
Subscriptions overview payload.

---

## Nodes

### GET `/api/nodes`
List nodes.

### POST `/api/nodes/:id/toggle`
Enable/disable node.

### POST `/api/local-nodes`
Create local node.

### PUT `/api/nodes/:id/rename`
Rename node.

### DELETE `/api/local-nodes/:id`
Delete local node.

---

## Connectivity / Kernel

### GET `/api/kernel/status`
Mihomo kernel install status.

### POST `/api/kernel/install`
Install mihomo kernel.

### POST `/api/kernel/uninstall`
Uninstall mihomo kernel.

### POST `/api/nodes/connectivity/check`
Run connectivity checks.

### GET `/api/nodes/connectivity`
Get connectivity results.

---

## SUI Bridge APIs

### GET `/api/sui/:sourceId/inbounds`
Fetch upstream SUI inbounds.

### POST `/api/sui/:sourceId/reality-quick`
Create quick Reality inbound on upstream SUI.

### DELETE `/api/sui/:sourceId/inbounds/:inboundId`
Delete upstream inbound.

### GET `/api/bridge/e2ee-meta`
Get E2EE metadata for trusted push.

### POST `/api/bridge/push-source`
Push source from SUI side to sub.

---

## Subscription Management

### GET `/api/subscriptions`
List subscriptions.

### POST `/api/subscriptions`
Create subscription.

### PUT `/api/subscriptions/:id`
Update subscription.

### DELETE `/api/subscriptions/:id`
Delete subscription.

---

## Subscription Delivery

### GET `/sub/:token`
Plain links subscription.

### GET `/api/sub/:token/plain`
Plain links subscription (API route).

### GET `/sub/:token/clash`
Clash YAML subscription.

### GET `/api/sub/:token/clash`
Clash YAML subscription (API route).

---

## Common Response Shape

Success:
```json
{ "ok": true, "...": "..." }
```
Failure:
```json
{ "ok": false, "error": "error message" }
```

HTTP status codes follow semantic meaning (`400/401/403/404/500`).
