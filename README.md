# Archeesepelago-Discord-Bot

Posts Archipelago multiworld room status from [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se) into Discord.

---

## Quick Start

### 1. Create a Discord bot
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Under **Bot**: click **Reset Token** and copy your token. Enable **Server Members Intent** under Privileged Gateway Intents.
3. Under **OAuth2**: generate an invite URL with the `bot` and `applications.commands` scopes and the **View Channels** + **Send Messages** + **Embed Links** permissions, then invite the bot to your server

### 2. Get your CheeseTrackers API key
Log in at CheeseTrackers → click your profile → copy your API key.

### 3. Configure and run
Open `bot/archeesepelago.conf`, fill in the two values, then double-click `bot/run.bat`.

`run.bat` handles everything automatically on first run:
- **Node.js**: installs it via winget if not found, with a PowerShell download as fallback. A UAC prompt may appear during installation.
- **Dependencies**: runs `npm install` automatically.
- **Config**: opens `archeesepelago.conf` in Notepad for you if it hasn't been filled in yet.

> **If Node.js fails to install automatically**, install it manually from [nodejs.org](https://nodejs.org/), then double-click `run.bat` again.

---

## Commands

| Command | Who can use | Description |
|---|---|---|
| `/menu` | Everyone | Shows the menu for the current channel. |
| `/help` | Everyone | Shows bot info and a link to this GitHub page. |

### `/menu` layout

- **Status** *(Everyone)*: shows a status preview, with **Prev/Next** page buttons (for big rooms) and a **Post to channel** button to publish it.
- **Register** / **Unregister** *(Everyone, only shown when the channel's view mode is Registered Only)*: adds/removes you from the channel's **Registered Only** view.
- **DM Notifications** *(Everyone)*: opens a submenu with a dropdown per item kind — **Progression** and **Useful** — plus an **Enable All / Disable All** button. The dropdown's label shows how many games are currently on; picking a game toggles it (its description shows its current state) rather than replacing the whole list, so the closed dropdown stays a compact count instead of listing every selected game. While **Enable All** is on, the dropdown is disabled (everything's already covered, including games added to the room later) — hit **Disable All** to pick individually. Rosters over 25 games page across multiple dropdowns.

  Both kinds are detected directly from the Archipelago room's own item data (via the tracker's linked Archipelago webhost), not just hinted items. Items you find yourself (including in any other game you claim in the same room) don't trigger a DM, only items sent to you from someone else's world do.
- **Admin Actions** *(Manage Channels)*: opens a submenu:
  - **Link Tracker** / **Update Tracker**: opens a modal for a CheeseTrackers URL or bare tracker ID, then a mode picker (**Show All** / **Registered Only**) to finish linking. Re-linking an already-linked channel updates it.
  - **Unlink Channel**: removes the channel's link (with a confirmation step) and stops auto-refresh.
  - **View Mode: Show All** / **View Mode: Registered Only**: switches the channel's view mode, updating any live posted messages immediately.
  - **Register Someone**: picks another member (via Discord's user select menu) to add to the **Registered Only** view.

### View modes
- **Show All**: every player's games are shown, including unclaimed slots. Best for small rooms.
- **Registered Only**: only players who've run `/register` are shown. Recommended for big rooms (20+ players) to avoid flooding the channel with huge, frequently-updating posts.

---

## Status format

Slots are sorted alphabetically and grouped by owner. Owners appear as Discord `@mentions` if their CT username matches a server member.

```
🚀🏁 `SlotName` - Game Name - 42/80 (53%)
```

| Completion | | Progression | |
|---|---|---|---|
| ✅ All checks | 🎯 Goal | 🟢 Unblocked | 🔴 BK |
| 🏁 Done | 💀 Released | 🚀 Go Mode | 🟡 Soft BK |
| | | ❓ Unknown | |

Large rooms are split across multiple embeds/messages (paged in the **Status** preview, posted as separate messages once published).

---

## Auto-refresh

Once posted via **Post to channel**, a status post updates itself automatically:
- Refreshes every 5 minutes if the tracker data changed
- Stops refreshing after 1 hour with no changes, marking the post as stopped
- Posting again supersedes the previous live post and starts a fresh refresh cycle

---

## Notes
- Links are saved in `bot/links.json`, one entry per guild+channel pair, along with view mode, registered users, and live message IDs
- Links with no activity for 30+ days are automatically cleaned up on bot startup
- Slash commands register globally on startup; Discord may take up to an hour to propagate changes to all servers
