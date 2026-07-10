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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
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

// Returns an ActionRowBuilder with Prev/Next nav (when totalPages > 1) and a Post-to-channel button.
function buildStatusNavRow(trackerId, page, totalPages) {
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
  components.push(
    new ButtonBuilder()
      .setCustomId(`post:${trackerId}`)
      .setLabel("Post to channel")
      .setStyle(ButtonStyle.Primary),
  );
  return new ActionRowBuilder().addComponents(...components);
}

function backToMenuRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu:back").setLabel("◀ Back").setStyle(ButtonStyle.Secondary)
  );
}

// ─── Menu (buttons) ───────────────────────────────────────────────────────────

function hasManageChannels(interaction) {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels));
}

function buildMenuEmbed(link, userId, isManager) {
  const e = new EmbedBuilder().setColor(0xf5c542).setTitle("Archeesepelago Menu");
  if (!link) {
    e.setDescription(
      isManager
        ? "This channel isn't linked to a tracker yet.\nUse **Admin Actions** below to link one."
        : "This channel isn't linked to a tracker yet.\nAsk a server admin to link one."
    );
    return e;
  }

  const trackerUrl = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${link.trackerId}`;
  const isRegisteredMode = (link.mode ?? "all") === "registered";
  const modeLabel = isRegisteredMode ? "**Registered Only**" : "**Show All**";

  const lines = [`**[Tracker Room](${trackerUrl})**`, `View mode: ${modeLabel}`];
  if (isRegisteredMode) {
    const isRegistered = (link.registeredUsers ?? []).includes(userId);
    lines.push(isRegistered ? "You are: ✅ **Registered**" : "You are: ❌ **Not registered**");
  }

  e.setDescription(lines.join("\n"));
  return e;
}

function buildMainMenuRows(interaction, link) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:status").setLabel("Status").setStyle(ButtonStyle.Success).setDisabled(!link)
    ),
  ];

  if (link && (link.mode ?? "all") === "registered") {
    const isRegistered = (link.registeredUsers ?? []).includes(interaction.user.id);
    rows.push(
      new ActionRowBuilder().addComponents(
        isRegistered
          ? new ButtonBuilder().setCustomId("menu:unregister").setLabel("Unregister").setStyle(ButtonStyle.Danger)
          : new ButtonBuilder().setCustomId("menu:register").setLabel("Register").setStyle(ButtonStyle.Success)
      )
    );
  }

  if (hasManageChannels(interaction)) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("menu:admin").setLabel("Admin Actions").setStyle(ButtonStyle.Primary)
      )
    );
  }

  return rows;
}

function buildAdminMenuRows(link) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:link").setLabel(link ? "Update Tracker" : "Link Tracker").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu:admin:unlink").setLabel("Unlink Channel").setStyle(ButtonStyle.Danger).setDisabled(!link),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:viewmode:all").setLabel("View Mode: Show All").setStyle(ButtonStyle.Primary).setDisabled(!link || (link.mode ?? "all") === "all"),
      new ButtonBuilder().setCustomId("menu:admin:viewmode:registered").setLabel("View Mode: Registered Only").setStyle(ButtonStyle.Primary).setDisabled(!link || link.mode === "registered"),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:registeruser").setLabel("Register Someone").setStyle(ButtonStyle.Primary).setDisabled(!link)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:back").setLabel("◀ Back").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildUnlinkConfirmRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:unlink:confirm").setLabel("Yes, unlink").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("menu:admin:unlink:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
    ),
  ];
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
    blocks.push("*No one is registered yet.*\nUse `/menu` → **Register** to add your games to this view.");
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
    .setName("menu")
    .setDescription("Open the bot menu for this channel"),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show information and documentation for this bot"),
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleMenuCommand(interaction) {
  const links = loadLinks();
  const link  = links[linkKey(interaction.guildId, interaction.channelId)];

  await interaction.reply({
    embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, link),
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMenuStatus(interaction, link) {
  if (!link) {
    return interaction.reply({
      content: hasManageChannels(interaction)
        ? "❌ This channel isn't linked to a tracker yet. Open **Admin Actions → Link Tracker** first."
        : "❌ This channel isn't linked to a tracker yet. Ask a server admin to link one.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();
  await interaction.editReply({ content: "Loading tracker...", embeds: [], components: [] });

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    console.error("[menu:status] CT API fetch failed:", err);
    return interaction.followUp({ content: `❌ Failed to fetch tracker data: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  if (!Array.isArray(data?.games)) {
    console.error("[menu:status] Unexpected CT API response:", JSON.stringify(data).slice(0, 500));
    return interaction.followUp({ content: "❌ Unexpected response from CheeseTrackers — the tracker may be unavailable.", flags: MessageFlags.Ephemeral });
  }

  const pages  = await buildStatusPages(link.trackerId, data, interaction.guild, null, link.mode ?? "all", link.registeredUsers ?? []);
  const navRow = buildStatusNavRow(link.trackerId, 0, pages.length);

  await interaction.editReply({ content: null, embeds: [pages[0]], components: [navRow, backToMenuRow()] });
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

  const pages = await buildStatusPages(trackerId, data, interaction.guild, null, link?.mode ?? "all", link?.registeredUsers ?? []);
  const page  = Math.max(0, Math.min(dir === "n" ? fromPage + 1 : fromPage - 1, pages.length - 1));
  const row   = buildStatusNavRow(trackerId, page, pages.length);

  await interaction.editReply({ embeds: [pages[page]], components: [row, backToMenuRow()] });
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

  await interaction.editReply({ content: "✅ Posted!", embeds: [], components: [backToMenuRow()] });
}

// Shared by self-register, self-unregister, and admin register-someone.
async function refreshRegisteredView(interaction, link) {
  const session = activeRefreshes.get(interaction.channelId);
  if (!session || (link.mode ?? "all") !== "registered") return;

  session.registeredUserIds = [...(link.registeredUsers ?? [])];
  try {
    const data  = await ctGet(`/tracker/${link.trackerId}`);
    const pages = await buildStatusPages(link.trackerId, data, interaction.guild, "active", "registered", session.registeredUserIds);
    for (let i = 0; i < session.messages.length; i++) {
      if (!pages[i]) break;
      try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
      catch { /* message gone */ }
    }
  } catch (err) {
    console.warn("[refreshRegisteredView] failed:", err.message);
  }
}

async function handleSelfRegister(interaction, link) {
  if (!link) {
    return interaction.reply({ content: "❌ This channel isn't linked to a tracker.", flags: MessageFlags.Ephemeral });
  }

  const links     = loadLinks();
  const freshLink = links[linkKey(interaction.guildId, interaction.channelId)];
  if (!freshLink.registeredUsers) freshLink.registeredUsers = [];

  const userId = interaction.user.id;
  if (freshLink.registeredUsers.includes(userId)) {
    return interaction.reply({ content: "✅ You're already registered in this channel's tracker view.", flags: MessageFlags.Ephemeral });
  }

  freshLink.registeredUsers.push(userId);
  saveLinks(links);
  await refreshRegisteredView(interaction, freshLink);

  await interaction.reply({
    content: "✅ Registered! Your games will appear in this channel's tracker view.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelfUnregister(interaction, link) {
  if (!link) {
    return interaction.reply({ content: "❌ This channel isn't linked to a tracker.", flags: MessageFlags.Ephemeral });
  }

  const links     = loadLinks();
  const freshLink = links[linkKey(interaction.guildId, interaction.channelId)];
  const userId    = interaction.user.id;
  const idx       = (freshLink.registeredUsers ?? []).indexOf(userId);

  if (idx === -1) {
    return interaction.reply({ content: "❌ You're not registered in this channel's tracker view.", flags: MessageFlags.Ephemeral });
  }

  freshLink.registeredUsers.splice(idx, 1);
  saveLinks(links);
  await refreshRegisteredView(interaction, freshLink);

  await interaction.reply({
    content: "✅ Unregistered. Your games will no longer appear in this channel's registered view.",
    flags: MessageFlags.Ephemeral,
  });
}

async function showLinkModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId("modal:link")
    .setTitle("Link Tracker")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("url")
          .setLabel("CheeseTrackers URL or tracker ID")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

async function handleLinkModalSubmit(interaction) {
  const input = interaction.fields.getTextInputValue("url");

  let trackerId;
  try {
    trackerId = parseTrackerId(input);
  } catch (err) {
    return interaction.reply({ content: `❌ Invalid URL: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let data;
  try {
    data = await ctGet(`/tracker/${trackerId}`);
  } catch (err) {
    return interaction.editReply(`❌ Could not reach that tracker: ${err.message}`);
  }

  const playerCount = new Set((data?.games ?? []).map(g => g.effective_discord_username).filter(Boolean)).size;
  const warning = playerCount >= 20
    ? `\n\n⚠️ **Big world warning:** this room has **${playerCount}** players. Pick **Registered Only** below to avoid flooding the channel on every update.`
    : "";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`menu:admin:linkmode:all:${trackerId}`).setLabel("Show All").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`menu:admin:linkmode:registered:${trackerId}`).setLabel("Registered Only").setStyle(ButtonStyle.Primary),
  );

  await interaction.editReply({
    content: `Found tracker \`${trackerId}\` — **${playerCount}** players.\nPick a view mode to finish linking:${warning}`,
    components: [row],
  });
}

async function handleLinkModeButton(interaction, mode, trackerId) {
  const channel  = interaction.channel;
  const links    = loadLinks();
  const key      = linkKey(interaction.guildId, channel.id);
  const isUpdate = Boolean(links[key]);
  links[key]     = { trackerId, linkedAt: Date.now(), mode };
  saveLinks(links);

  const modeLabel  = mode === "all" ? "**Show All**" : "**Registered Only**";
  const trackerUrl = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${trackerId}`;
  await interaction.update({
    content: `✅ **#${channel.name}** is now ${isUpdate ? "updated to" : "linked to"} [this tracker](${trackerUrl}) in ${modeLabel} mode.`,
    components: [],
  });
}

async function handleUnlinkConfirm(interaction) {
  stopAutoRefresh(interaction.channelId);
  deleteLinkEntry(interaction.guildId, interaction.channelId);

  await interaction.update({
    embeds: [buildMenuEmbed(null, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, null),
  });
}

async function handleAdminViewMode(interaction, link, mode) {
  if (!link) {
    return interaction.reply({ content: "❌ This channel isn't linked to a tracker.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  const links     = loadLinks();
  const key       = linkKey(interaction.guildId, interaction.channelId);
  const freshLink = links[key];
  freshLink.mode  = mode;
  saveLinks(links);

  // Immediately refresh any live posted messages
  const session = activeRefreshes.get(interaction.channelId);
  if (session) {
    session.mode = mode;
    try {
      const data     = await ctGet(`/tracker/${freshLink.trackerId}`);
      const pages    = await buildStatusPages(freshLink.trackerId, data, interaction.guild, "active", mode, session.registeredUserIds);
      const oldCount = session.messages.length;
      const newCount = pages.length;

      for (let i = 0; i < Math.min(newCount, oldCount); i++) {
        try { await session.messages[i].edit({ embeds: [pages[i]], components: [] }); }
        catch { /* message gone */ }
      }
      for (let i = newCount; i < oldCount; i++) {
        try { await session.messages[i].delete(); }
        catch { /* already gone */ }
      }
      if (newCount < oldCount) session.messages = session.messages.slice(0, newCount);
      for (let i = session.messages.length; i < newCount; i++) {
        const msg = await interaction.channel.send({ embeds: [pages[i]] });
        session.messages.push(msg);
      }
      if (newCount !== oldCount) {
        freshLink.messageIds = session.messages.map(m => m.id);
        saveLinks(links);
      }
    } catch (err) {
      console.warn("[menu:admin:viewmode] refresh failed:", err.message);
    }
  }

  await interaction.editReply({ embeds: [buildMenuEmbed(freshLink, interaction.user.id, hasManageChannels(interaction))], components: buildAdminMenuRows(freshLink) });

  if (mode === "all") {
    try {
      const data        = await ctGet(`/tracker/${freshLink.trackerId}`);
      const playerCount = new Set((data?.games ?? []).map(g => g.effective_discord_username).filter(Boolean)).size;
      if (playerCount >= 20) {
        await interaction.followUp({
          content: `⚠️ **Big world warning:** this room has **${playerCount}** players. **Show All** posts every player's games, which can spread across many embeds/pages and spam the channel on every update.`,
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch { /* non-critical — skip warning if tracker fetch fails */ }
  }
}

async function handleRegisterUserSelect(interaction) {
  if (!hasManageChannels(interaction)) {
    return interaction.reply({ content: "❌ You need **Manage Channels** permission.", flags: MessageFlags.Ephemeral });
  }

  const links = loadLinks();
  const key   = linkKey(interaction.guildId, interaction.channelId);
  const link  = links[key];

  if (!link) {
    return interaction.update({ content: "❌ This channel isn't linked to a tracker.", embeds: [], components: [] });
  }

  const targetId = interaction.values[0];
  if (!link.registeredUsers) link.registeredUsers = [];
  const already = link.registeredUsers.includes(targetId);

  if (!already) {
    link.registeredUsers.push(targetId);
    saveLinks(links);
    await refreshRegisteredView(interaction, link);
  }

  await interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction))], components: buildAdminMenuRows(link) });
  await interaction.followUp({
    content: already ? `✅ <@${targetId}> is already registered.` : `✅ <@${targetId}> has been registered in this channel's tracker view.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMenuButton(interaction) {
  const id    = interaction.customId;
  const links = loadLinks();
  const link  = links[linkKey(interaction.guildId, interaction.channelId)];

  if (id === "menu:back")       return interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction))], components: buildMainMenuRows(interaction, link) });
  if (id === "menu:status")     return handleMenuStatus(interaction, link);
  if (id === "menu:register")   return handleSelfRegister(interaction, link);
  if (id === "menu:unregister") return handleSelfUnregister(interaction, link);

  // Everything below is admin-only.
  if (id.startsWith("menu:admin") && !hasManageChannels(interaction)) {
    return interaction.reply({ content: "❌ You need **Manage Channels** permission.", flags: MessageFlags.Ephemeral });
  }

  if (id === "menu:admin")               return interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, true)], components: buildAdminMenuRows(link) });
  if (id === "menu:admin:link")          return showLinkModal(interaction);
  if (id === "menu:admin:unlink")        return interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, true)], components: buildUnlinkConfirmRows() });
  if (id === "menu:admin:unlink:confirm") return handleUnlinkConfirm(interaction);
  if (id === "menu:admin:unlink:cancel")  return interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, true)], components: buildAdminMenuRows(link) });

  if (id === "menu:admin:viewmode:all")        return handleAdminViewMode(interaction, link, "all");
  if (id === "menu:admin:viewmode:registered") return handleAdminViewMode(interaction, link, "registered");

  if (id === "menu:admin:registeruser") {
    const selectRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("menu:admin:registeruser:select").setPlaceholder("Choose a user to register").setMinValues(1).setMaxValues(1)
    );
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin").setLabel("◀ Back").setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [buildMenuEmbed(link, interaction.user.id, true)], components: [selectRow, backRow] });
  }

  if (id.startsWith("menu:admin:linkmode:")) {
    const rest      = id.slice("menu:admin:linkmode:".length);
    const sep       = rest.indexOf(":");
    const mode      = rest.slice(0, sep);
    const trackerId = rest.slice(sep + 1);
    return handleLinkModeButton(interaction, mode, trackerId);
  }
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
      {
        name: "`/menu`",
        value:
          "Opens the bot menu for this channel:\n" +
          "- **Status** — preview tracker status with a **Post to channel** button.\n" +
          "- **Register** / **Unregister** — add or remove yourself from the registered view (only shown once the channel's view mode is **Registered Only**).\n" +
          "- **Admin Actions** *(Manage Channels only)* — link/unlink this channel's tracker, switch view mode between **Show All** and **Registered Only**, or register another player.",
      },
      { name: "`/help`", value: "Show this message." },
      { name: "GitHub",  value: "[github.com/ChakraaThePanda/Archeesepelago-Discord-Bot](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot)" },
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
      if (interaction.commandName === "menu") return await handleMenuCommand(interaction);
      if (interaction.commandName === "help") return await handleHelp(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("pg:"))   return await handlePageButton(interaction);
      if (interaction.customId.startsWith("post:")) return await handlePostButton(interaction);
      if (interaction.customId.startsWith("menu:")) return await handleMenuButton(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal:link") return await handleLinkModalSubmit(interaction);
    }
    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === "menu:admin:registeruser:select") return await handleRegisterUserSelect(interaction);
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
