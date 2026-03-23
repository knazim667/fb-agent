# fb-agent

A human-first Facebook automation assistant for Amazon lead generation workflows, with an autonomous background loop plus an operator console.

## What It Does

- Uses Playwright with stealth-style behavior and a persistent browser session.
- Uses Ollama locally for scoring, drafting, join-question answers, briefings, and learning feedback.
- Uses MongoDB via Mongoose for posts, interactions, conversation memory, and discovered groups.
- Uses a DB-backed job queue so background automation and operator commands do not fight over the same browser page.
- Loads business logic from skill files in `skills/`.
- Runs housekeeping automatically, then stays available for manual commands and plain-English status questions.

## Current Workflow

On startup, the agent:

1. Opens Facebook in headed mode and waits for login if needed.
2. Runs a housekeeping cycle: group sync, pending verification, notifications, inbox, reply checks.
3. Prints a short AI-generated morning briefing.
4. Starts a live operator console.
5. Keeps running background jobs every 3 hours.

Available commands:

- `search [keyword]` to find groups and submit join requests
- `scan` to scan joined groups for lead posts
- `engage` to like, comment, and create posts within daily limits
- `reply` to answer notification threads and inbox leads
- `sync` to refresh joined-group state from notifications and the groups feed
- `verify` to revisit pending groups and mark newly joined ones
- `dashboard`, `status`, `groups`, `notifications`, `posts`, `brief`
- `exit` to close the session

You can also ask plain-English questions like:

- `how many groups total we joined`
- `any group not only amazon related`
- `what people are posting about in any group`
- `what notification we have now`

## Project Structure

```text
skills/
  amazon_expert.md
  amazon_hidden_money.md
  web_dev.md
src/
  agent/
    operator_console.js
    runtime.js
  browser/
    feed.js
    groups.js
    interactions.js
    notifications.js
  brain.js
  browser.js
  database.js
  orchestrator.js
setup.js
task_input.json
```

## Requirements

- Node.js 20+
- MongoDB running locally
- Ollama running locally on `http://localhost:11434`
- A Facebook account you can log into manually on the first run

## Installation

```bash
npm install
node setup.js
```

Run tests:

```bash
npm test
```

Optional `.env` example:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/fb_agent
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=deepseek-r1:32b
MORNING_BRIEFING_MODEL=gpt-oss:20b
LEAD_QUALIFIER_MODEL=gpt-oss:20b
OLLAMA_TIMEOUT_MS=90000
HUMAN_JITTER_MIN_MS=3000
HUMAN_JITTER_MAX_MS=8000
```

## Run

```bash
npm start
```

The browser opens in visible mode so you can complete Facebook login and any checkpoints. Session data is stored locally in `user_data/` and is intentionally ignored by git.

## Notes

- Facebook selectors change frequently, so some UI flows may need light tuning over time.
- Group discovery and joined-group sync are cached in MongoDB.
- The agent performs an account-level joined-group sync so it can track how many groups the logged-in Facebook account already belongs to overall, not just Amazon groups.
- The current `task_input.json` is configured for the Amazon Hidden Money workflow.
- The browser session is persisted in `user_data/`, so Facebook login and 2FA should usually be one-time.
