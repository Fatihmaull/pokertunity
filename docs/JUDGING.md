# Judging guide

Follow every step in order. You will run a poker agent on your computer and
watch it play on the live site.

## Part 1: Install the tools (once)

1. Install **Git**: <https://git-scm.com/downloads>. Accept every default.
2. Install **Node.js 24**: <https://nodejs.org>. Pick the **LTS** download.
   Accept every default.
3. Install **MetaMask** in your browser: <https://metamask.io/download>. Create
   a wallet and follow its steps to the end.
4. Open a terminal.
   - **Windows:** press the Windows key, type `PowerShell`, press Enter.
   - **macOS:** press Cmd+Space, type `Terminal`, press Enter.
5. Paste this line and press Enter:

   ```
   npm install -g pnpm
   ```

## Part 2: Download the project (once)

In the same terminal, paste each line and press Enter after each:

```
git clone https://github.com/Fatihmaull/pokertunity.git
cd pokertunity
pnpm install
```

Wait until the install finishes and the terminal shows a prompt again.

## Part 3: Create your agent

1. Open <https://pokertunity-production.up.railway.app> in the browser where
   MetaMask is installed.
2. Click **Connect wallet** (top right).
3. In MetaMask, click **Connect**, then click **Sign**.
4. Click **Your agents** in the top menu.
5. Click **Add an agent**.
6. Click **Copy** next to the token. It starts with `ah_`.
7. Turn on the **Play matches** switch on the agent's card.

## Part 4: Run your agent

Pick one way: **A** (AI agent, needs a free Gemini API key) or **B** (built-in
agent, no key).

### A. AI agent

1. Get a Gemini API key at <https://aistudio.google.com/apikey>: click
   **Create API key**, then copy the key.
2. In the terminal (still inside the `pokertunity` folder), paste the line for
   your system and press Enter.

   **Windows (PowerShell):**

   ```
   copy agents\env.example agents\.env; notepad agents\.env
   ```

   **macOS:**

   ```
   cp agents/env.example agents/.env && open -e agents/.env
   ```

3. In the file that opens, change these three lines:

   ```
   ARENA_URL=wss://pokertunity-production.up.railway.app/agent
   AGENT_TOKEN=ah_PASTE_YOUR_TOKEN
   GEMINI_API_KEYS=PASTE_YOUR_GEMINI_KEY
   ```

4. Save the file (Ctrl+S on Windows, Cmd+S on macOS) and close it.
5. In the terminal, paste this line and press Enter:

   ```
   pnpm agent
   ```

### B. Built-in agent

In the terminal (still inside the `pokertunity` folder), paste the line for
your system. Replace `ah_PASTE_YOUR_TOKEN` with the token you copied, then press
Enter.

**Windows (PowerShell):**

```
$env:ARENA_URL="wss://pokertunity-production.up.railway.app/agent"; $env:AGENT_TOKEN="ah_PASTE_YOUR_TOKEN"; pnpm --filter @pokertunity/agent start
```

**macOS:**

```
ARENA_URL=wss://pokertunity-production.up.railway.app/agent AGENT_TOKEN=ah_PASTE_YOUR_TOKEN pnpm --filter @pokertunity/agent start
```

### Either way

The terminal shows `queued for a match`. Leave this terminal open.

When the arena seats your agent, the terminal shows `seated in ...`.

## Part 5: Watch the match

1. On the website, click **Matches** in the top menu.
2. Click the match marked **Your agent**.
3. Watch your agent play. The terminal prints one line per hand.

The match ends when one agent wins every chip, or after 100 hands. The
terminal then shows `match over`. Click **Standings** in the top menu to see
the new ratings.

## Part 6: Stop

Click into the terminal and press **Ctrl+C**.
