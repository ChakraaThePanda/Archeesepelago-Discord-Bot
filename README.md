# Archeesepelago-Discord-Bot
A simple Discord bot that shows your [Archipelago](https://archipelago.gg) room's progress from [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se) right in a Discord channel.

If you have any questions, add me on Discord: **Chakraa**

---

### Features
* Room Status: a post in your channel showing every player's games and progress, updated every 5 minutes
* Collection Room: before the game is generated, show the room where players send their YAMLs instead
* Item DMs: get a Discord DM when someone finds one of your Progression or Useful items
* Hint DMs: get a DM when a hint involves one of your games
* Registered Only view: for big rooms, only show the players who signed up

---

### How to Use
* Download the [latest version](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot/archive/refs/heads/main.zip) and extract it somewhere.
* Create your Discord bot:
  1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**
  2. In **Bot**, click **Reset Token** and copy it. Also turn on **Server Members Intent** on that page.
  3. In **OAuth2**, tick `bot` and `applications.commands`, then the **View Channels**, **Send Messages** and **Embed Links** permissions. Open the link it gives you to invite the bot to your server.
* Get your CheeseTrackers API key: log in on [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se), click your profile and copy your API key.
* Open `bot/archeesepelago.conf`, paste your bot token and API key, then double-click `bot/run.bat`. The first time, it installs everything it needs for you (a Windows permission popup may appear). If that fails, install [Node.js](https://nodejs.org/) yourself and run `run.bat` again.

#### Updating
Extract the new version to a new folder, then copy `archeesepelago.conf` and `links.json` from your old `bot` folder into the new one. This keeps your settings and your linked channels.

---

### In Discord
Type `/menu` in a channel to open the bot's menu, or `/help` for a quick overview.
* **Status**: preview the room, then **Post to channel** to share it.
* **Register / Unregister**: add or remove yourself when the channel uses **Registered Only**.
* **DM Notifications**: pick which of your games send you item DMs, and turn hint DMs on or off.
* **Admin Actions** (needs the Manage Channels permission): link the channel to a tracker or a collection room, unlink it, switch between **Show All** and **Registered Only**, or register someone else (in **Registered Only**).

#### What the icons mean
| Completion | | Progression | |
|---|---|---|---|
| ✅ All checks | 🎯 Goal | 🟢 Unblocked | 🔴 BK |
| 🏁 Done | 💀 Released | 🚀 Go Mode | 🟡 Soft BK |
| | | ❓ Unknown | |
