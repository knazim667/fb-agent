# fb-agent

A human-first Facebook automation assistant for Amazon lead generation workflows.

## What It Does

- Uses Playwright with stealth-style behavior and a persistent browser session.
- Uses Ollama locally for scoring, drafting, join-question answers, and morning briefings.
- Uses MongoDB via Mongoose for posts, interactions, conversation memory, and discovered groups.
- Loads business logic from skill files in `skills/`.
- Starts in an operator-controlled mode with a morning briefing and manual commands.

## Current Workflow

On startup, the agent:

1. Opens Facebook in headed mode and waits for login if needed.
2. Scrapes recent notifications and inbox previews.
3. Prints a short AI-generated morning briefing.
4. Enters command mode.

Available commands:

- `search [keyword]` to find groups and submit join requests
- `scan` to scan target groups for trigger posts
- `engage` to like, comment, and create posts within daily limits
- `reply` to answer notification threads and inbox leads
- `exit` to close the session

## Project Structure

```text
skills/
  amazon_expert.md
  amazon_hidden_money.md
  web_dev.md
src/
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

Optional `.env` example:

```env
MONGODB_URI=mongodb://127.0.0.1:27017/fb_agent
OLLAMA_URL=http://localhost:11434/api/generate
OLLAMA_MODEL=llama3.3:70b
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
- Group discovery caches valid discovered groups in MongoDB.
- The current `task_input.json` is configured for the Amazon Hidden Money workflow.
