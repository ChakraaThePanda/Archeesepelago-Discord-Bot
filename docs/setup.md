# Setup and usage

There are two ways to use the bot. Pick the one that fits you:

* **Just me, in my DMs**: follow your own runs privately in a DM with the bot. Check their status whenever you like and get a DM when you receive an item or a hint. No server needed.
* **In a server**: link a channel to a run and post a status that updates itself every 5 minutes, for yourself or a whole group. Everyone in the server can also get their own item and hint DMs.

Both start the same way: [get the bot running](#1-get-the-bot-running), then follow [Just me, in my DMs](#2a-just-me-in-my-dms) or [In a server](#2b-in-a-server). You can always do both later.

---

### 1. Get the bot running
1. Download the [latest version](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot/archive/refs/heads/main.zip) and extract it somewhere.
2. Create your bot in the [Discord Developer Portal](https://discord.com/developers/applications): click **New Application** and give it a name. Then in **Bot**, click **Reset Token** and copy it. Turn on **Server Members Intent** on that page too.
3. Get your CheeseTrackers API key: log in on [CheeseTrackers](https://cheesetrackers.theincrediblewheelofchee.se), click your profile and copy it.
4. Open `bot/archeesepelago.conf` and paste in your bot token and API key.
5. Double-click `bot/Start Archeesepelago.bat`.

The first start installs everything the bot needs (a Windows permission popup may appear). If that fails, install [Node.js](https://nodejs.org/) yourself and start it again.

The bot now runs in the background, with its logo in the system tray next to the clock. See [Running the bot](#running-the-bot) for what you can do from there.

---

### 2a. Just me, in my DMs
**Set it up (once):**
1. Back in the [Developer Portal](https://discord.com/developers/applications), open your bot and go to **Installation**.
2. Under **Installation Contexts**, tick **User Install**. Leave **Install Link** on **None**, then click **Save Changes** at the bottom.
3. Go to **OAuth2**. Further down, in the link builder, tick `applications.commands`, and set **Integration Type** to **User Install**.
4. Open the link it gives you at the bottom of the page and choose **Add to My Apps**. Only you can use this link, since you own the bot.
5. Within a few seconds, the bot sends you a message, and its chat shows up in your DM list. Open it: that's where you use `/menu`, and where your notifications arrive.

**Use it:** type `/menu` in your DM with the bot to see **Your Runs**.
* **New Run**: paste a CheeseTrackers tracker link to add a run. Pasting a tracker link in a normal message works too: the bot offers an **Add This Run** button.
* Pick a run from the list to open it:
  * **Status**: shows just your games. Press **Show Everyone** to see the whole room.
  * **DM Notifications**: choose which of your games send you a DM when you receive a **Progression** or **Useful** item, and turn hint DMs on or off.
  * **Remove Run**: takes it off your list and stops its DMs.

**Good to know:**
* You can keep up to 25 runs. A run with no activity for 30 days is removed on its own.
* The bot finds your games by the Discord name your slots are claimed under on CheeseTrackers: your username or display name. If it says none of your games match, claim your slots on CheeseTrackers under one of those names.

---

### 2b. In a server
**Set it up (once):**
1. Back in the [Developer Portal](https://discord.com/developers/applications), open your bot and go to **OAuth2**.
2. Tick `bot` and `applications.commands`, then the **View Channels**, **Send Messages** and **Embed Links** permissions.
3. Open the link it gives you at the bottom of the page and pick your server.
4. In the channel you want, type `/menu`, then **Admin Actions** → **Link Tracker** and paste your CheeseTrackers tracker link.

**Use it:** type `/menu` in the channel, or `/help` for a quick overview.
* **Status**: preview the room, then **Post to channel** to share it. The posted status updates itself every 5 minutes.
* **Register / Unregister**: add or remove yourself when the channel uses **Registered Only**.
* **DM Notifications**: choose which of your games send you a DM when you receive a **Progression** or **Useful** item, and turn hint DMs on or off.
* **Admin Actions** (needs the Manage Channels permission): link the channel to a tracker, or to a collection room before the game is generated. You can also unlink it, switch between **Show All** and **Registered Only** (better for big rooms), or register someone else. **Post Notifications in This Channel** posts everyone's item and hint notifications in the channel, pinging each person, instead of DMing them. People who can't see the channel still get DMs. Everyone still chooses what they get, under **Notifications** (called **DM Notifications** when this is off).

**Good to know:**
* The bot finds your games by the Discord name your slots are claimed under on CheeseTrackers: your username, display name or server nickname.
* Server members can also use the bot in their own DMs: open the bot's profile in the server, press **Message**, and type `/menu`.
* DMs for a run come from one place at a time, so you never get the same item twice. Turning them on in your DMs turns them off for that run in the server channel, and the other way around. The bot tells you when that happens.

---

### Running the bot
Right-click the logo in the system tray to **Show log**, **Restart bot** or **Stop bot and exit**. A red dot on the logo means the bot stopped; open the log to see why.

* **Start with Windows**: press `Win + R`, type `shell:startup`, and put a shortcut to `Start Archeesepelago.bat` in that folder.
* **Run in a window instead**: from a terminal in the `bot` folder, run `"Start Archeesepelago.bat" console`.

#### Updating
Extract the new version to a new folder, then copy `archeesepelago.conf` and the `data` folder from your old `bot` folder into the new one. This keeps your settings, your linked channels and everyone's runs.

Coming from a version without a `data` folder? Copy `links.json` instead of `data`; the bot moves it into place on its next start.

---

### What the icons mean
| Completion | | Progression | |
|---|---|---|---|
| ✅ All checks | 🎯 Goal | 🟢 Unblocked | 🔴 BK |
| 🏁 Done | 💀 Released | 🚀 Go Mode | 🟡 Soft BK |
| | | ❓ Unknown | |
