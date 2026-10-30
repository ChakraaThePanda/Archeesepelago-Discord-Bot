# Archeesepelago-Discord-Bot
A simple Discord bot that shows your [Archipelago](https://archipelago.gg) room's progress from [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se) right in a Discord channel.

If you have any questions, join my Discord server: [Chakraa's Projects](https://discord.gg/bkk4nVXcjm)

---

### Features
* Room Status: a post in your channel showing every player's games and progress, updated every 5 minutes
* Collection Room: before the game is generated, show the room where players send their YAMLs instead
* Item DMs: get a Discord DM when someone finds one of your Progression or Useful items
* Hint DMs: get a DM when a hint involves one of your games
* Registered Only view: for big rooms, only show the players who signed up

---

### Setup
1. Download the [latest version](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot/archive/refs/heads/main.zip) and extract it somewhere.
2. Create your Discord bot in the [Discord Developer Portal](https://discord.com/developers/applications):
   * **New Application**, then in **Bot**, click **Reset Token** and copy it. Turn on **Server Members Intent** on that page too.
   * In **OAuth2**, tick `bot` and `applications.commands`, then the **View Channels**, **Send Messages** and **Embed Links** permissions. Open the link it gives you to invite the bot to your server.
3. Get your CheeseTrackers API key: log in on [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se), click your profile and copy it.
4. Open `bot/archeesepelago.conf` and paste in your bot token and API key.
5. Double-click `bot/Start Archeesepelago.bat`.

The first start installs everything the bot needs (a Windows permission popup may appear). If that fails, install [Node.js](https://nodejs.org/) yourself and start it again.

---

### Running the bot
The bot runs in the background, with its logo in the system tray next to the clock. Right-click the logo to **Show log**, **Restart bot** or **Stop bot and exit**. A red dot on the logo means the bot stopped; open the log to see why.

* **Start with Windows**: press `Win + R`, type `shell:startup`, and put a shortcut to `Start Archeesepelago.bat` in that folder.
* **Run in a window instead**: from a terminal in the `bot` folder, run `"Start Archeesepelago.bat" console`.

#### Updating
Extract the new version to a new folder, then copy `archeesepelago.conf` and the `data` folder from your old `bot` folder into the new one. This keeps your settings and your linked channels.

Coming from a version without a `data` folder? Copy `links.json` instead of `data`; the bot moves it into place on its next start.

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

---

### Questions or feedback?

Need help, found a bug, or have an idea? Join my Discord server, [Chakraa's Projects](https://discord.gg/bkk4nVXcjm), and post in this project's channel.
