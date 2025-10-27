# Bluesky Block Watcher

Automatically monitor multiple Bluesky accounts for blocks and moderation list additions, then add offenders to a master moderation list.

Perfect for feed makers who want to prevent users from blocking their accounts and then posting content they can't see.

## How it works

1. **Monitor multiple accounts** - Each of your accounts subscribes to [@listifications.app](https://bsky.app/profile/listifications.app)
2. **Parse notifications** - The service monitors DMs/mentions from listifications for block alerts
3. **Detect hostile actions** - Catches both blocks and moderation list additions
4. **Auto-add to list** - Adds offenders to your specified moderation list
5. **Close the loophole** - Use the moderation list in your feeds to exclude these users

## Setup

### 1. Subscribe to listifications

Each account you want to monitor should:
- Follow [@listifications.app](https://bsky.app/profile/listifications.app)
- Enable DMs from listifications (or at least allow mentions)

### 2. Create your blockers list

Create a moderation list in Bluesky and copy its AT-URI from the URL:
```
https://bsky.app/profile/youraccount.bsky.social/lists/3l2ujiym5dm2z
                                                    ↑ this part
```

The AT-URI format is: `at://did:plc:youraccountdid/app.bsky.graph.list/3l2ujiym5dm2z`

### 3. Configure the service

```bash
# Copy the example config
cp .env.example .env

# Edit with your settings
nano .env
```

Create a `.env` file with your settings:

```bash
# Account that manages the blockers list (handle or DID)
LIST_ACCOUNT_HANDLE=youraccount.bsky.social
LIST_ACCOUNT_PASSWORD=your-app-password
# Also monitor this account for blocks (avoids duplicate login)
MONITOR_LIST_ACCOUNT=true

# Moderation list to add blockers to (supports both formats):
# Web URL: https://bsky.app/profile/did:plc:youraccountdid/lists/3l2ujiym5dm2z
# AT-URI: at://did:plc:youraccountdid/app.bsky.graph.list/3l2ujiym5dm2z
BLOCKERS_LIST_URI=

# Additional accounts to monitor for blocks (format: handle_or_did:password)
# Supports both handles and DIDs. Each account should subscribe to listifications.app
MONITOR_ACCOUNTS=altaccount.bsky.social:apppassword2,did:plc:example123:apppassword3

# Optional settings
POLL_INTERVAL_SECONDS=30
DRY_RUN=false
PORT=3000
BACKFILL_HOURS=24
```

### 4. Run the service

```bash
# Install dependencies
bun install

# Start monitoring
bun start

# Or for development
bun dev
```

### Local Development

```bash
# Install dependencies
bun install

# Start in development mode
bun dev
```

## Utilities

Find DIDs from handles:
```bash
bun run get-did @username.bsky.social
```

## Example Use Case

You run a custom feed and have multiple accounts (main + alts). Some users block your accounts to post content you can't see, then their posts appear in your feed.

With this service:
1. All your accounts subscribe to listifications
2. When someone blocks any of your accounts, listifications sends a DM
3. The service automatically adds the blocker to your moderation list
4. Configure your feed to exclude users from this moderation list
5. Loophole closed! 🎉

## What gets detected

✅ **Blocks**: `@baduser.bsky.social has blocked you`
✅ **Moderation list additions**: `@baduser.bsky.social has added you to the "Spam" moderation list`
❌ **Regular lists**: Ignored (not hostile)
❌ **Starter packs**: Ignored (not hostile)

## Requirements

- [Bun](https://bun.sh/) runtime or Docker
- Bluesky accounts with app passwords
- Subscription to [@listifications.app](https://bsky.app/profile/listifications.app)

## Docker Deployment

### Quick Start

```bash
# Clone the repository
git clone https://github.com/femavibes/bsky-block-countermod.git
cd bsky-block-countermod

# Copy and configure environment
cp .env.example .env
nano .env

# Run with Docker Compose
docker compose up -d
```

### Docker Compose File

The included `docker-compose.yml`:

```yaml
services:
  block-watcher:
    image: ghcr.io/femavibes/bsky-block-countermod:latest
    container_name: bsky-block-countermod
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./logs:/usr/src/app/logs
    environment:
      - NODE_ENV=production
```

### Docker Hub

Pre-built images are available at:
```bash
docker pull ghcr.io/femavibes/bsky-block-countermod:latest
```

### Manual Docker Run

```bash
docker run -d \
  --name bsky-block-countermod \
  --env-file .env \
  --restart unless-stopped \
  ghcr.io/femavibes/bsky-block-countermod:latest
```

## License

MIT