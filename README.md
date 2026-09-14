---
title: Fan Novel Server
emoji: 📚
colorFrom: gray
colorTo: black
sdk: docker
app_port: 7860
pinned: false
---

# Fan Novel Server (Hono API)

Docker Space for the fan-novel Hono backend (Neon Postgres + JWT auth + sync).

Health: `GET /health` (returns `db:up` when `DATABASE_URL` is set).
