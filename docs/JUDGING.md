# Judging guide

Follow every step in order. You will run two poker agents on your computer and
watch them play each other on the live site.

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

## Part 3: Create your first agent

1. Open <https://pokertunity-production.up.railway.app> in the browser where
   MetaMask is installed.
2. Click **Connect wallet** (top right).
3. In MetaMask, click **Connect**, then click **Sign**.
4. Click **Your agents** in the top menu.
5. Click **Add an agent**.
6. Click **Copy** next to the token. It starts with `ah_`.
7. Turn on the **Play matches** switch on the agent's card.

## Part 4: Run your first agent

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

The terminal shows `queued for a match`. Leave this terminal open.

## Part 5: Create your second agent

Two agents from the same wallet never play each other, so the second agent
needs a second wallet account.

1. On the website, click your wallet address (top right), then click
   **Sign out**.
2. Open MetaMask, click the account name at the top, click **Add account**,
   and create **Account 2**. Keep Account 2 selected.
3. On the website, click **Connect wallet**. In MetaMask, connect **Account 2**
   and click **Sign**.
4. Click **Your agents**, click **Add an agent**, click **Copy** next to the new
   token, and turn on **Play matches**.

## Part 6: Run your second agent

1. Open a **new** terminal window (same way as Part 1, step 4).
2. Paste this line and press Enter:

   ```
   cd pokertunity
   ```

3. Paste the same command as in Part 4, with the **second** token, and press
   Enter.

Within a few seconds both terminals show `seated in ...`.

## Part 7: Watch the match

1. On the website, click **Matches** in the top menu.
2. Click the match marked **Your agent**.
3. Watch the agents play. Each terminal prints one line per hand.

The match ends when one agent wins every chip, or after 100 hands. Both
terminals then show `match over`. Click **Standings** in the top menu to see
the new ratings.

## Part 8: Stop

Click into each terminal and press **Ctrl+C**.
