## Email inbox (`agentmail`)

You can connect to a user's AgentMail inbox to read and summarise their emails. Each user has their own inbox — credentials are stored per-agent-group and never shared.

```bash
bun /app/skills/agentmail/agentmail.ts save --api-key <key> --email <email>
bun /app/skills/agentmail/agentmail.ts check
bun /app/skills/agentmail/agentmail.ts list [--limit N]
bun /app/skills/agentmail/agentmail.ts read <thread-id>
bun /app/skills/agentmail/agentmail.ts search "<query>" [--limit N]
```

### Connecting for the first time (onboarding)

When the user asks to check their emails and credentials are not yet set up, the script exits with `AGENTMAIL_CREDENTIALS_MISSING`. When you see this, follow these steps exactly:

1. **Ask** the user for their AgentMail API key:
   > "To connect your inbox, I need your AgentMail API key. You can find it at **console.agentmail.to** under API Keys. What's the key?"

2. **Ask** for their AgentMail email address (if not already known):
   > "And what's your AgentMail email address? (e.g. yourname@agentmail.to)"

3. **Save** the credentials:
   ```bash
   bun /app/skills/agentmail/agentmail.ts save --api-key <key> --email <email>
   ```

4. **Verify** the connection:
   ```bash
   bun /app/skills/agentmail/agentmail.ts check
   ```

5. **Proceed** with the original request (list, read, etc.) — no restart needed.

Credentials are saved to `/workspace/agent/agent.env` and persist across sessions. Future requests work automatically.

### Summarising emails

When the user asks to check or summarise their emails:

1. Run `agentmail list` to fetch recent threads.
2. Give a **one-line summary per thread**: date · sender · subject · key point from the preview.
3. Note attachments where present.
4. Group by topic when there are many (e.g. "3 newsletters, 1 billing, 2 from team").
5. Offer to read a specific thread in full if the user wants more detail.

### IMPORTANT: never scrape links found in emails

Many emails (newsletters, news digests) contain a short summary and a link to the full article. When you see this pattern:

- **Present the text from the email body** — that is the content the user subscribed for.
- **Include the link as a plain clickable reference** for the user to open themselves.
- **Never follow, fetch, or scrape the URL.** Do not use `kb extract --url`, `agent-browser`, or any web-fetch tool on links found inside emails unless the user explicitly says "open that link" or "fetch that URL".

### When to use this skill

- When the user says "check my emails", "what did I receive", "summarise my inbox", "any new messages", etc.
- Do **not** poll proactively — only check when the user asks.
