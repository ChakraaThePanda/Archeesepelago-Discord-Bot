# Archeesepelago-Discord-Bot

Posts Archipelago multiworld room status from [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se) into Discord.

---

## Quick Start

### 1. Install Node.js
Download and install from [nodejs.org](https://nodejs.org/) if you don't have it.

### 2. Create a Discord bot
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Under **Bot**: click **Reset Token** and copy your token. Enable **Server Members Intent** under Privileged Gateway Intents.
3. Under **OAuth2**: generate an invite URL with the `bot` and `applications.commands` scopes and the **View Channels** + **Send Messages** + **Embed Links** permissions, then invite the bot to your server

### 3. Get your CheeseTrackers API key
Log in at CheeseTrackers → click your profile → copy your API key.

### 4. Configure and run
Open `bot/archipelago.conf`, fill in the two values, then double-click `bot/run.bat`.

The bat will open the config file for you automatically if it isn't filled in yet, and will install dependencies on its own on the first run.

---

## Commands

| Command | Who can use | Description |
|---|---|---|
| `/link #channel <url>` | Manage Channels | Links a channel to a CheeseTrackers room. Accepts a full URL or bare tracker ID. |
| `/status` | Everyone | Shows a status preview (visible only to you), with a **Post to channel** button to publish it. |

---

## Status format

Slots are sorted alphabetically and grouped by owner. Owners appear as Discord `@mentions` if their CT username matches a server member.

```
🏁🚀 `SlotName` — Game Name — 42/80 (53%) — Go Mode
```

| Completion | | Progression | |
|---|---|---|---|
| 🔴 Incomplete | ✅ All checks | 🟢 Unblocked | 🔒 BK |
| 🎯 Goal | 🏁 Done | 🚀 Go Mode | 🟡 Soft BK |
| 🎉 Released | | ❓ Unknown | |

---

## Notes
- Links are saved in `bot/links.json` — one entry per guild+channel pair
- Slash commands register globally on startup; Discord may take up to an hour to propagate changes to all servers
