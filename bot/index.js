const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "archeesepelago.conf"), quiet: true });

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ActivityType,
  MessageFlags,
} = require("discord.js");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────

const CT_API_KEY    = process.env.CT_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BASE_URL      = "https://cheesetrackers.theincrediblewheelofchee.se/api";
const LINKS_FILE    = path.join(__dirname, "links.json");

// ─── Persistent Links (JSON) ──────────────────────────────────────────────────
// Structure: { "<guildId>:<channelId>": { trackerId, linkedAt?, mode?, registeredUsers?, messageIds?, lastActivityAt? } }

function loadLinks() {
  if (!fs.existsSync(LINKS_FILE)) return {};
  return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
}

function saveLinks(links) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

function linkKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

// ─── CT API ───────────────────────────────────────────────────────────────────

function ctHeaders() {
  const h = {};
  if (CT_API_KEY) h["Authorization"] = `Bearer ${CT_API_KEY}`;
  return h;
}

async function ctGet(endpoint) {
  const res = await fetch(`${BASE_URL}${endpoint}`, { headers: ctHeaders() });
  if (!res.ok) throw new Error(`CheeseTrackers API returned ${res.status}`);
  return res.json();
}

const CT_HOST = "cheesetrackers.theincrediblewheelofchee.se";

function parseTrackerId(input) {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname !== CT_HOST) throw new Error(`URL must be from ${CT_HOST}`);
    const match = url.pathname.match(/\/tracker\/([A-Za-z0-9_-]+)/);
    if (!match) throw new Error("No tracker ID found in that URL");
    return match[1];
  } catch (err) {
    // Not a URL — treat as a bare tracker ID unless the error was ours
    if (err.message.startsWith("URL must be") || err.message.startsWith("No tracker")) throw err;
    return trimmed;
  }
}

const COMPLETION_EMOJI = {
  all_checks: "✅",
  goal:       "🎯",
  done:       "🏁",
  released:   "💀",
};

const PROGRESSION_EMOJI = {
  unknown:   "❓",
  unblocked: "🟢",
  bk:        "🔴",
  go:        "🚀",
  soft_bk:   "🟡",
};

// Guild member cache — one fetch per guild per 5 min to avoid gateway opcode 8 rate limits
const memberCacheMap = new Map();
const MEMBER_CACHE_TTL = 5 * 60 * 1000;

async function fetchGuildMembers(guild) {
  const cached = memberCacheMap.get(guild.id);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL) return cached.members;
  try {
    const members = await guild.members.fetch();
    memberCacheMap.set(guild.id, { members, fetchedAt: Date.now() });
    return members;
  } catch (err) {
    console.warn("[fetchGuildMembers] failed, using Discord cache:", err.message);
    return guild.members.cache;
  }
}

function progressBar(done, total) {
  if (!total) return "0/0 (0%)";
  const rawPct = Math.round((done / total) * 100);
  const pct    = (rawPct === 100 && done < total) ? 99 : rawPct;
  const filled = pct === 99 ? 7 : Math.round((done / total) * 8);
  return `${"█".repeat(filled)}${"░".repeat(8 - filled)} ${done}/${total} (${pct}%)`;
}

// Returns an ActionRowBuilder with Prev/Next nav (when totalPages > 1) and optionally a Post button.
// Returns null when there would be no buttons.
function buildStatusNavRow(trackerId, page, totalPages, includePost = false) {
  const components = [];
  if (totalPages > 1) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`pg:p:${trackerId}:${page}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`pg:n:${trackerId}:${page}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );
  }
  if (includePost) {
    components.push(
      new ButtonBuilder()
        .setCustomId(`post:${trackerId}`)
        .setLabel("Post to channel")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📋"),
    );
  }
  return components.length > 0 ? new ActionRowBuilder().addComponents(...components) : null;
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS   = 5 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;
const STALE_LINK_MS         = 30 * 24 * 60 * 60 * 1000;

// Map<channelId, { messages, trackerId, guild, lastHash, lastActivityAt, mode, registeredUserIds, intervalId }>
const activeRefreshes = new Map();

function hashTrackerData(data) {
  const relevant = [...data.games]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(g => ({
      name:                       g.name,
      checks_done:                g.checks_done,
      checks_total:               g.checks_total,
      completion_status:          g.completion_status,
      progression_status:         g.progression_status,
      effective_discord_username: g.effective_discord_username ?? null,
    }));
  return JSON.stringify({ games: relevant, last_port: data.last_port ?? null });
}

function stopAutoRefresh(channelId) {
  const session = activeRefreshes.get(channelId);
  if (!session) return;
  clearInterval(session.intervalId);
  activeRefreshes.delete(channelId);
}

function clearMessageFromLinks(guildId, channelId) {
  const links = loadLinks();
  const key   = linkKey(guildId, channelId);
  if (links[key]) {
    delete links[key].messageIds;
    delete links[key].lastActivityAt;
    saveLinks(links);
  }
}

function deleteLinkEntry(guildId, channelId) {
  const links = loadLinks();
  const key   = linkKey(guildId, channelId);
  if (links[key]) {
    delete links[key];
    saveLinks(links);
  }
}

// messages is an array of Discord Message objects (one per posted page)
function startAutoRefresh(messages, trackerId, guild, initialHash, initialLastActivityAt = Date.now(), mode = "all", registeredUserIds = []) {
  const channelId = messages[0].channelId;
  stopAutoRefresh(channelId);

  const session = {
    messages,
    trackerId,
    guild,
    lastHash:          initialHash,
    lastActivityAt:    initialLastActivityAt,
    mode,
    registeredUserIds: [...registeredUserIds],
    intervalId:        null,
  };

  session.intervalId = setInterval(async () => {
    try {
      const data    = await ctGet(`/tracker/${trackerId}`);
      const newHash = hashTrackerData(data);
      const now     = Date.now();
      const changed = newHash !== session.lastHash;

      if (changed) {
        session.lastHash       = newHash;
        session.lastActivityAt = now;
        const links = loadLinks();
        const key   = linkKey(guild.id, channelId);
        if (links[key]) { links[key].lastActivityAt = now; saveLinks(links); }
      }

      if (now - session.lastActivityAt > INACTIVITY_TIMEOUT_MS) {
        stopAutoRefresh(channelId);
        const pages = await buildStatusPages(trackerId, data, guild, "stopped", session.mode, session.registeredUserIds);
        for (let i = 0; i < session.messages.length; i++) {
          try { await session.messages[i].edit({ embeds: [pages[i] ?? pages[pages.length - 1]], components: [] }); }
          catch { /* message gone */ }
        }
        clearMessageFromLinks(guild.id, channelId);
        return;
      }

      if (changed) {
        const pages = await buildStatusPages(trackerId, data, guild, "active", session.mode, session.registeredUserIds);
        for (let i = 0; i < session.messages.length; i++) {
          if (!pages[i]) break;
          try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
          catch { /* message gone */ }
        }
      }
    } catch (err) {
      console.error("[auto-refresh]", err);
      if (err.code === 10008) {
        clearMessageFromLinks(guild.id, channelId);
        stopAutoRefresh(channelId);
      }
      if (err.code === 10003) {
        deleteLinkEntry(guild.id, channelId);
        stopAutoRefresh(channelId);
      }
    }
  }, REFRESH_INTERVAL_MS);

  activeRefreshes.set(channelId, session);
}

async function buildStatusPages(trackerId, data, guild, refreshStatus = null, mode = "all", registeredUserIds = []) {
  const { games, title, room_host, last_port } = data;

  const members = await fetchGuildMembers(guild);

  const memberByUsername = new Map();
  for (const [, member] of members) {
    memberByUsername.set(member.user.username.toLowerCase(), member);
    if (member.user.globalName) {
      memberByUsername.set(member.user.globalName.toLowerCase(), member);
    }
    if (member.nickname) {
      memberByUsername.set(member.nickname.toLowerCase(), member);
    }
  }

  // Group games by claimed owner; unclaimed slots go under "Unclaimed"
  const groups = new Map();
  const sorted = [...games].sort((a, b) => a.name.localeCompare(b.name));

  for (const game of sorted) {
    const ctUser   = game.effective_discord_username ?? null;
    const ownerKey = ctUser ? ctUser.toLowerCase() : "__unclaimed__";

    if (!groups.has(ownerKey)) {
      let label;
      if (!ctUser) {
        label = "Unclaimed";
      } else {
        const member = memberByUsername.get(ctUser.toLowerCase());
        label = member ? `<@${member.id}>` : ctUser;
      }
      groups.set(ownerKey, { label, games: [] });
    }
    groups.get(ownerKey).games.push(game);
  }

  let totalDone = 0, totalAll = 0;
  for (const g of games) { totalDone += g.checks_done; totalAll += g.checks_total; }

  // Build one block per owner group — Unclaimed always last.
  // In "registered" mode: skip Unclaimed and any owner whose Discord member ID isn't in registeredUserIds.
  const registeredSet = new Set(registeredUserIds);
  const blocks = [];
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "__unclaimed__") return 1;
    if (b === "__unclaimed__") return -1;
    return a.localeCompare(b);
  });
  for (const [ownerKey, { label, games: ownerGames }] of sortedGroups) {
    if (mode === "registered") {
      if (ownerKey === "__unclaimed__") continue;
      const member = memberByUsername.get(ownerKey);
      if (!member || !registeredSet.has(member.id)) continue;
    }
    const blockLines = [`- **${label}**`];
    for (const g of ownerGames) {
      const comp = COMPLETION_EMOJI[g.completion_status] ?? "";
      const prog = (g.completion_status === "done" || g.completion_status === "released") ? "" : (PROGRESSION_EMOJI[g.progression_status] ?? "❓");
      const rawPct = g.checks_total ? Math.round((g.checks_done / g.checks_total) * 100) : 0;
      const pct    = (rawPct === 100 && g.checks_done < g.checks_total) ? 99 : rawPct;
      const safeName = (g.name ?? "").replace(/`/g, "ˋ") || "—";
      const safeGame = (g.game ?? "").replace(/[`*]/g, (c) => c === "*" ? "\\*" : "ˋ") || "—";
      blockLines.push(
        `  - ${prog}${comp} \`${safeName}\` — **${safeGame}** — ${g.checks_done}/${g.checks_total} (${pct}%)`
      );
    }
    blocks.push(blockLines.join("\n"));
  }

  if (mode === "registered" && blocks.length === 0) {
    blocks.push("*No one is registered yet.*\nUse `/register` to add your games to this view.");
  }

  const trackerUrl = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${trackerId}`;
  const serverLine = (room_host && last_port) ? `\`\`\`\n${room_host}:${last_port}\n\`\`\`\n` : "";

  // Pack blocks into ≤3200-char chunks (measured by JS .length); first chunk reserves space
  // for serverLine header. Player-owned blocks are kept whole where possible.
  // Blocks too large for any single embed (e.g. 100+ Unclaimed games) are split by line.
  // NOTE: Discord counts Unicode code points, JS counts UTF-16 code units — surrogate-pair
  // emojis (🎯 🏁 🔴 etc.) cost 2 here but 1 in Discord's limit (4096 cp). Empirically,
  // Discord stops rendering content somewhere around 3400 code points despite the 4096 limit,
  // so we cap at 3200 JS chars to stay safely below that observed rendering threshold.
  const LIMIT = 3200;
  const chunks = [];
  let chunk = "";
  for (const block of blocks) {
    const budget = chunks.length === 0 ? LIMIT - serverLine.length : LIMIT;
    const sep = chunk ? "\n" : "";
    if (chunk.length + sep.length + block.length <= budget) {
      // Fits in current chunk — append
      chunk = chunk ? chunk + sep + block : block;
    } else if (chunk && block.length <= LIMIT) {
      // Fits standalone — flush current chunk and start fresh with this block
      chunks.push(chunk);
      chunk = block;
    } else {
      // Block exceeds LIMIT (or chunk is empty but budget is constrained) — split by line.
      // When flushing mid-block, reopen the next chunk with the group header + "(cont.)".
      if (chunk) { chunks.push(chunk); chunk = ""; }
      const lines = block.split("\n");
      const blockHeader = lines[0];
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const lb = chunks.length === 0 ? LIMIT - serverLine.length : LIMIT;
        const ls = chunk ? "\n" : "";
        if (chunk && chunk.length + ls.length + line.length > lb) {
          chunks.push(chunk);
          // If past the header line, re-open with "Header (cont.)" so each page is self-explanatory
          chunk = li > 0 ? `${blockHeader} (cont.)\n${line}` : line;
        } else {
          chunk = chunk ? chunk + ls + line : line;
        }
      }
    }
  }
  if (chunk) chunks.push(chunk);

  const totalPages  = chunks.length;
  const footerTotal = `Total: ${progressBar(totalDone, totalAll)}`;
  const nowStr      = new Date().toString().replace(/GMT[+-]\d{4} \((.+?)\)/, (_, tz) =>
    tz.includes(' ') ? tz.split(' ').map(w => w[0]).join('') : tz
  );
  const refreshLine = refreshStatus === "active"      ? `⟳ Updates every 5 min — Last Updated: ${nowStr}`
                    : refreshStatus === "stopped"     ? `⏹️ Stopped refreshing (1h inactivity) — Last Updated: ${nowStr}`
                    : refreshStatus === "superseded"  ? `⊘ Superseded by a newer post`
                    : null;

  return chunks.map((desc, i) => {
    const e = new EmbedBuilder().setColor(0xf5c542);

    if (i === 0) {
      e.setTitle(title || "Tracker Status")
       .setURL(trackerUrl)
       .setDescription(serverLine + desc);
    } else {
      e.setDescription(desc);
    }

    if (i === chunks.length - 1) {
      const bottom = totalPages > 1 ? `${footerTotal} — Page ${i + 1}/${totalPages}` : footerTotal;
      e.setFooter({ text: refreshLine ? `${refreshLine}\n${bottom}` : bottom });
    } else {
      const bottom = `Page ${i + 1}/${totalPages}`;
      e.setFooter({ text: refreshLine ? `${refreshLine}\n${bottom}` : bottom });
    }

    return e;
  });
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("[Permissions Needed] Link this channel to a CheeseTrackers room")
    .addStringOption(opt =>
      opt.setName("url")
        .setDescription("CheeseTrackers URL or tracker ID")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show tracker status for this linked channel"),

  new SlashCommandBuilder()
    .setName("viewmode")
    .setDescription("[Permissions Needed] Switch between showing all players or only registered ones")
    .addStringOption(opt =>
      opt.setName("mode")
        .setDescription("The view mode to use")
        .setRequired(true)
        .addChoices(
          { name: "Show All — display every player and unclaimed games", value: "all" },
          { name: "Registered Only — show only players who used /register", value: "registered" },
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("register")
    .setDescription("Add yourself (or another user) to this channel's registered tracker view")
    .addUserOption(opt =>
      opt.setName("user")
        .setDescription("[Permissions Needed] Register someone else instead of yourself")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("unregister")
    .setDescription("Remove yourself from this channel's registered tracker view"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show information and documentation for this bot"),
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleLink(interaction) {
  const channel = interaction.channel;
  const input   = interaction.options.getString("url");

  let trackerId;
  try {
    trackerId = parseTrackerId(input);
  } catch (err) {
    return interaction.reply({ content: `❌ Invalid URL: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await ctGet(`/tracker/${trackerId}`);
  } catch (err) {
    return interaction.editReply(`❌ Could not reach that tracker: ${err.message}`);
  }

  const links    = loadLinks();
  const key      = linkKey(interaction.guildId, channel.id);
  const isUpdate = Boolean(links[key]);
  links[key]     = { trackerId, linkedAt: Date.now() };
  saveLinks(links);

  const verb = isUpdate ? "updated to" : "linked to";
  await interaction.editReply(
    `✅ **#${channel.name}** is now ${verb} tracker \`${trackerId}\`.\nRun \`/status\` here to see progress.`
  );
}

async function handleStatus(interaction) {
  const links = loadLinks();
  const link  = links[linkKey(interaction.guildId, interaction.channelId)];

  if (!link) {
    return interaction.reply({
      content: "❌ This channel isn't linked to a CheeseTrackers room. Use `/link` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    console.error("[status] CT API fetch failed:", err);
    return interaction.editReply(`❌ Failed to fetch tracker data: ${err.message}`);
  }

  if (!Array.isArray(data?.games)) {
    console.error("[status] Unexpected CT API response:", JSON.stringify(data).slice(0, 500));
    return interaction.editReply("❌ Unexpected response from CheeseTrackers — the tracker may be unavailable.");
  }

  let pages;
  try {
    pages = await buildStatusPages(link.trackerId, data, interaction.guild, null, link.mode ?? "all", link.registeredUsers ?? []);
  } catch (err) {
    console.error("[status] buildStatusPages failed:", err);
    return interaction.editReply(`❌ Failed to build tracker display: ${err.message}`);
  }

  const row = buildStatusNavRow(link.trackerId, 0, pages.length, true);

  try {
    await interaction.editReply({
      embeds: [pages[0]],
      components: row ? [row] : [],
    });
  } catch (err) {
    console.error("[status] editReply failed:", err);
    return interaction.editReply({
      content: `❌ Failed to send tracker display: ${err.message}`,
      embeds: [],
      components: [],
    });
  }
}

async function handlePageButton(interaction) {
  const [, dir, trackerId, pageStr] = interaction.customId.split(":");
  const fromPage = parseInt(pageStr, 10);

  await interaction.deferUpdate();

  let data;
  try {
    data = await ctGet(`/tracker/${trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const links = loadLinks();
  const link  = links[linkKey(interaction.guildId, interaction.channelId)];

  // pg: buttons only appear on the ephemeral /status preview — always include Post button
  const pages = await buildStatusPages(trackerId, data, interaction.guild, null, link?.mode ?? "all", link?.registeredUsers ?? []);
  const page  = Math.max(0, Math.min(dir === "n" ? fromPage + 1 : fromPage - 1, pages.length - 1));
  const row   = buildStatusNavRow(trackerId, page, pages.length, true);

  await interaction.editReply({ embeds: [pages[page]], components: row ? [row] : [] });
}

async function handlePostButton(interaction) {
  const trackerId = interaction.customId.slice("post:".length);

  await interaction.deferUpdate();

  const links           = loadLinks();
  const key             = linkKey(interaction.guildId, interaction.channelId);
  const link            = links[key];
  const mode            = link?.mode ?? "all";
  const registeredUsers = link?.registeredUsers ?? [];

  let data, pages;
  try {
    data  = await ctGet(`/tracker/${trackerId}`);
    pages = await buildStatusPages(trackerId, data, interaction.guild, "active", mode, registeredUsers);
  } catch (err) {
    return interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  // Stop any running refresh and supersede any existing live messages for this channel
  stopAutoRefresh(interaction.channelId);
  if (link?.messageIds?.length) {
    const supersededPages = await buildStatusPages(trackerId, data, interaction.guild, "superseded", mode, registeredUsers);
    for (let i = 0; i < link.messageIds.length; i++) {
      try {
        const old = await interaction.channel.messages.fetch(link.messageIds[i]);
        await old.edit({ embeds: [supersededPages[i] ?? supersededPages[supersededPages.length - 1]], components: [] });
      } catch { /* old message gone — ignore */ }
    }
  }

  // Post all pages as separate messages — no nav buttons needed since all are visible
  const messages = [];
  for (const page of pages) {
    messages.push(await interaction.channel.send({ embeds: [page] }));
  }
  const now = Date.now();
  startAutoRefresh(messages, trackerId, interaction.guild, hashTrackerData(data), now, mode, registeredUsers);

  if (link) {
    link.messageIds     = messages.map(m => m.id);
    link.lastActivityAt = now;
    saveLinks(links);
  }

  await interaction.editReply({ content: "✅ Posted!", embeds: [], components: [] });
}

async function handleViewMode(interaction) {
  const links = loadLinks();
  const key   = linkKey(interaction.guildId, interaction.channelId);
  const link  = links[key];

  if (!link) {
    return interaction.reply({
      content: "❌ This channel isn't linked to a tracker. Use `/link` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const newMode = interaction.options.getString("mode");
  link.mode = newMode;
  saveLinks(links);

  // Immediately refresh any live posted messages
  const session = activeRefreshes.get(interaction.channelId);
  if (session) {
    session.mode = newMode;
    try {
      const data     = await ctGet(`/tracker/${link.trackerId}`);
      const pages    = await buildStatusPages(link.trackerId, data, interaction.guild, "active", newMode, session.registeredUserIds);
      const oldCount = session.messages.length;
      const newCount = pages.length;

      // Edit existing messages
      for (let i = 0; i < Math.min(newCount, oldCount); i++) {
        try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
        catch { /* message gone */ }
      }

      // Delete surplus messages if page count shrank
      for (let i = newCount; i < oldCount; i++) {
        try { await session.messages[i].delete(); }
        catch { /* already gone */ }
      }
      if (newCount < oldCount) session.messages = session.messages.slice(0, newCount);

      // Post new messages if page count grew
      for (let i = session.messages.length; i < newCount; i++) {
        const msg = await interaction.channel.send({ embeds: [pages[i]] });
        session.messages.push(msg);
      }

      // Persist updated messageIds if count changed
      if (newCount !== oldCount) {
        link.messageIds = session.messages.map(m => m.id);
        saveLinks(links);
      }
    } catch (err) {
      console.warn("[viewmode] refresh failed:", err.message);
    }
  }

  const label = newMode === "all" ? "**Show All**" : "**Registered Only**";
  const hint  = newMode === "registered" ? "\n> Players can use `/register` to add their games to this view." : "";
  await interaction.editReply(`✅ View mode set to ${label}.${hint}`);
}

async function handleRegister(interaction) {
  const links = loadLinks();
  const key   = linkKey(interaction.guildId, interaction.channelId);
  const link  = links[key];

  if (!link) {
    return interaction.reply({
      content: "❌ This channel isn't linked to a tracker. Use `/link` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const targetUser = interaction.options.getUser("user");

  if (targetUser) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply({
        content: "❌ You need **Manage Channels** permission to register someone else.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const userId   = targetUser ? targetUser.id : interaction.user.id;
  const isSelf   = !targetUser;
  const mention  = targetUser ? `<@${targetUser.id}>` : "You";
  const already  = isSelf ? "You're already registered" : `${mention} is already registered`;

  if (!link.registeredUsers) link.registeredUsers = [];

  if (link.registeredUsers.includes(userId)) {
    return interaction.reply({
      content: `✅ ${already} in this channel's tracker view.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  link.registeredUsers.push(userId);
  saveLinks(links);

  // Refresh live messages if the channel is currently in registered mode
  const session = activeRefreshes.get(interaction.channelId);
  if (session && (link.mode ?? "all") === "registered") {
    session.registeredUserIds = [...link.registeredUsers];
    try {
      const data  = await ctGet(`/tracker/${link.trackerId}`);
      const pages = await buildStatusPages(link.trackerId, data, interaction.guild, "active", "registered", session.registeredUserIds);
      for (let i = 0; i < session.messages.length; i++) {
        if (!pages[i]) break;
        try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
        catch { /* message gone */ }
      }
    } catch (err) {
      console.warn("[register] refresh failed:", err.message);
    }
  }

  const successMsg = isSelf
    ? "✅ Registered! Your games will appear in this channel when the view is set to **Registered Only**."
    : `✅ ${mention} has been registered in this channel's tracker view.`;

  await interaction.reply({
    content: successMsg,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleUnregister(interaction) {
  const links = loadLinks();
  const key   = linkKey(interaction.guildId, interaction.channelId);
  const link  = links[key];

  if (!link) {
    return interaction.reply({
      content: "❌ This channel isn't linked to a tracker. Use `/link` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const userId = interaction.user.id;
  const idx = (link.registeredUsers ?? []).indexOf(userId);
  if (idx === -1) {
    return interaction.reply({
      content: "❌ You're not registered in this channel's tracker view.",
      flags: MessageFlags.Ephemeral,
    });
  }

  link.registeredUsers.splice(idx, 1);
  saveLinks(links);

  // Refresh live messages if the channel is currently in registered mode
  const session = activeRefreshes.get(interaction.channelId);
  if (session && (link.mode ?? "all") === "registered") {
    session.registeredUserIds = [...link.registeredUsers];
    try {
      const data  = await ctGet(`/tracker/${link.trackerId}`);
      const pages = await buildStatusPages(link.trackerId, data, interaction.guild, "active", "registered", session.registeredUserIds);
      for (let i = 0; i < session.messages.length; i++) {
        if (!pages[i]) break;
        try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
        catch { /* message gone */ }
      }
    } catch (err) {
      console.warn("[unregister] refresh failed:", err.message);
    }
  }

  await interaction.reply({
    content: "✅ Unregistered. Your games will no longer appear in this channel's registered view.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xf5c542)
    .setTitle("Archeesepelago Discord Bot")
    .setURL("https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot")
    .setDescription(
      "Posts Archipelago multiworld room status from CheeseTrackers into Discord."
    )
    .addFields(
      { name: "`/link <url>`",    value: "Link this channel to a CheeseTrackers room. Requires **Manage Channels** permission." },
      { name: "`/status`",        value: "Show a tracker status preview with a **Post to channel** button." },
      { name: "`/viewmode`",      value: "Switch between **Show All** (default) and **Registered Only** view. Requires **Manage Channels** permission." },
      { name: "`/register`",      value: "Add yourself to this channel's registered tracker view. With **Manage Channels** permission, use `/register user:@someone` to register another player." },
      { name: "`/unregister`",    value: "Remove yourself from this channel's registered tracker view." },
      { name: "`/help`",          value: "Show this message." },
      { name: "GitHub",           value: "[github.com/ChakraaThePanda/Archeesepelago-Discord-Bot](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot)" },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

function setPresence() {
  client.user?.setActivity("/help to get started", { type: ActivityType.Listening });
}

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  console.log("Registering slash commands…");
  await rest.put(Routes.applicationCommands(client.application.id), {
    body: commands.map(c => c.toJSON()),
  });
  console.log("✅ Commands registered globally.");
  setPresence();
  setInterval(setPresence, 30 * 60 * 1000);

  // Resume auto-refresh for any persisted message IDs, immediately updating each embed
  const links  = loadLinks();
  let modified = false;
  let first    = true;
  const now    = Date.now();

  for (const [key, link] of Object.entries(links)) {
    // Remove entries with no activity in 30+ days (skip legacy entries with no timestamps)
    const lastSeen = Math.max(link.linkedAt ?? 0, link.lastActivityAt ?? 0);
    if (lastSeen > 0 && now - lastSeen > STALE_LINK_MS) {
      console.log(`[resume] Removing stale link ${key} (last activity > 30 days ago)`);
      delete links[key];
      modified = true;
      continue;
    }

    if (!link.messageIds?.length) continue;

    if (!first) await new Promise(r => setTimeout(r, 2000));
    first = false;

    const [guildId, channelId] = key.split(":");
    const stale                = now - (link.lastActivityAt ?? 0) > INACTIVITY_TIMEOUT_MS;
    const mode                 = link.mode ?? "all";
    const registeredUsers      = link.registeredUsers ?? [];

    try {
      const guild   = await client.guilds.fetch(guildId);
      const channel = await client.channels.fetch(channelId);
      const data    = await ctGet(`/tracker/${link.trackerId}`);

      if (stale) {
        const pages = await buildStatusPages(link.trackerId, data, guild, "stopped", mode, registeredUsers);
        for (let i = 0; i < link.messageIds.length; i++) {
          try {
            const msg = await channel.messages.fetch(link.messageIds[i]);
            await msg.edit({ embeds: [pages[i] ?? pages[pages.length - 1]], components: [] });
          } catch { /* message gone */ }
        }
      } else {
        const messages = [];
        for (const msgId of link.messageIds) {
          try { messages.push(await channel.messages.fetch(msgId)); }
          catch { /* message gone */ }
        }
        if (messages.length > 0) {
          const pages = await buildStatusPages(link.trackerId, data, guild, "active", mode, registeredUsers);
          for (let i = 0; i < messages.length; i++) {
            if (!pages[i]) break;
            try { await messages[i].edit({ embeds: [pages[i]], components: [] }); }
            catch { /* message gone */ }
          }
          startAutoRefresh(messages, link.trackerId, guild, hashTrackerData(data), link.lastActivityAt, mode, registeredUsers);
          console.log(`[resume] Restored and updated auto-refresh for ${key}`);
          continue;
        }
      }
    } catch (err) {
      if (err.code === 10003 || err.code === 10004) {
        console.log(`[resume] Removing dead link ${key}: ${err.message}`);
        delete links[key];
        modified = true;
        continue;
      }
      console.warn(`[resume] Failed to restore ${key}:`, err.message);
    }

    delete link.messageIds;
    delete link.lastActivityAt;
    modified = true;
  }
  if (modified) saveLinks(links);
});

client.on("shardReady", () => { setPresence(); });
client.on("shardResume", () => { setPresence(); });

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "link")       return await handleLink(interaction);
      if (interaction.commandName === "status")     return await handleStatus(interaction);
      if (interaction.commandName === "viewmode")   return await handleViewMode(interaction);
      if (interaction.commandName === "register")   return await handleRegister(interaction);
      if (interaction.commandName === "unregister") return await handleUnregister(interaction);
      if (interaction.commandName === "help")       return await handleHelp(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("pg:"))   return await handlePageButton(interaction);
      if (interaction.customId.startsWith("post:")) return await handlePostButton(interaction);
    }
  } catch (err) {
    if (err.code === 10062) return; // interaction expired (e.g. bot restarted mid-flight) — nothing to do
    console.error(`[${interaction.commandName ?? interaction.customId}]`, err);
    const msg = `❌ Unexpected error: ${err.message}`;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg, embeds: [], components: [] });
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
    } catch { /* ignore follow-up errors */ }
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (!DISCORD_TOKEN) {
  console.error("[!] DISCORD_TOKEN is not set in archeesepelago.conf");
  process.exit(1);
}

client.login(DISCORD_TOKEN).catch(err => {
  console.error("[!] Failed to log in to Discord:", err.message);
  process.exit(1);
});
