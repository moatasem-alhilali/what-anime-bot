# What Anime Telegram Bot (Node.js + Vercel)

Telegram bot that receives an anime screenshot as a photo, sends it to Trace.moe, and replies in Arabic with the best matches.

## Features

- Node.js 18+ ESM project
- Single Vercel Serverless Function (`/api/telegram.js`)
- Accepts Telegram photo messages only
- Downloads image from Telegram servers in memory
- Sends multipart request to Trace.moe (`image` field)
- Replies with top 3 matches max:
  - anime title
  - episode
  - similarity percentage (2 decimals)
  - timestamp range (`mm:ss`)
  - preview image URL
  - preview video URL (if available)
- Arabic user-facing messages and robust error handling

## Environment Variables

Set these in Vercel (`Project Settings -> Environment Variables`):

- `BOT_TOKEN` (required)

## Local Run

```bash
npm install
npm run dev
```

## Telegram Webhook

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram"
```

Verify:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## Endpoint

- `POST /api/telegram`

Behavior:

- non-POST => `405`
- invalid payload => `400`
- valid updates => `200 { "ok": true }`

## Project Structure

```text
what-anime-telegram-bot/
  api/
    telegram.js
  lib/
    telegram.js
    utils.js
  package.json
  vercel.json
```
