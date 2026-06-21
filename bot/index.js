const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "archeesepelago.conf") });

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
// Structure: { "<guildId>:<channelId>": { trackerId } }

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

// ─── Status Builder ───────────────────────────────────────────────────────────

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

function progressBar(done, total) {
  if (!total) return "0/0 (0%)";
  const pct    = Math.round((done / total) * 100);
  const filled = Math.round((done / total) * 8);
  return `${"█".repeat(filled)}${"░".repeat(8 - filled)} ${done}/${total} (${pct}%)`;
}

async function buildStatusEmbeds(trackerId, guild) {
  const data = await ctGet(`/tracker/${trackerId}`);
  const { games, title, room_host, last_port } = data;

  // Fetch all members for @mention resolution (requires GuildMembers intent + Members privilege)
  let members;
  try {
    members = await guild.members.fetch();
  } catch {
    members = guild.members.cache;
  }

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
    const ctUser  = game.effective_discord_username ?? null;
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

  // Build one block per owner group — these are never split across embeds
  const blocks = [];
  for (const [, { label, games: ownerGames }] of groups) {
    const blockLines = [`- **${label}**`];
    for (const g of ownerGames) {
      const comp = COMPLETION_EMOJI[g.completion_status] ?? "";
      const prog = (g.completion_status === "done" || g.completion_status === "released") ? "" : (PROGRESSION_EMOJI[g.progression_status] ?? "❓");
      const pct  = g.checks_total ? Math.round((g.checks_done / g.checks_total) * 100) : 0;
      blockLines.push(
        `  - ${prog}${comp} \`${g.name}\` — **${g.game}** — ${g.checks_done}/${g.checks_total} (${pct}%)`
      );
    }
    blocks.push(blockLines.join("\n"));
  }

  const trackerUrl = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${trackerId}`;
  const serverLine = (room_host && last_port) ? `\`\`\`\n${room_host}:${last_port}\n\`\`\`\n` : "";

  // Pack blocks into ≤4000-char chunks; first chunk reserves space for serverLine header
  const LIMIT = 4000;
  const chunks = [];
  let chunk = "";
  for (const block of blocks) {
    const budget = chunks.length === 0 ? LIMIT - serverLine.length : LIMIT;
    const sep = chunk ? "\n" : "";
    if (chunk && chunk.length + sep.length + block.length > budget) {
      chunks.push(chunk);
      chunk = block;
    } else {
      chunk = chunk ? chunk + sep + block : block;
    }
  }
  if (chunk) chunks.push(chunk);

  const totalPages  = chunks.length;
  const footerTotal = `Total: ${progressBar(totalDone, totalAll)}`;

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
      const footer = totalPages > 1 ? `${footerTotal} — Page ${i + 1}/${totalPages}` : footerTotal;
      e.setFooter({ text: footer });
    } else {
      e.setFooter({ text: `Page ${i + 1}/${totalPages}` });
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
  links[key]     = { trackerId };
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

  let embeds;
  try {
    embeds = await buildStatusEmbeds(link.trackerId, interaction.guild);
  } catch (err) {
    return interaction.editReply(`❌ Failed to fetch tracker data: ${err.message}`);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`post:${link.trackerId}`)
      .setLabel("Post to channel")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("📋"),
  );

  await interaction.editReply({
    embeds,
    components: [row],
  });
}

async function handlePostButton(interaction) {
  const trackerId = interaction.customId.slice("post:".length);

  await interaction.deferUpdate();

  let embeds;
  try {
    embeds = await buildStatusEmbeds(trackerId, interaction.guild);
  } catch (err) {
    return interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.channel.send({ embeds });
  await interaction.editReply({ content: "✅ Posted!", embeds: [], components: [] });
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
      { name: "`/link <url>`", value: "Link this channel to a CheeseTrackers room. Requires **Manage Channels** permission." },
      { name: "`/status`",     value: "Show a tracker status preview with a **Post to channel** button." },
      { name: "`/help`",       value: "Show this message." },
      { name: "GitHub",        value: "[github.com/ChakraaThePanda/Archeesepelago-Discord-Bot](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot)" },
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

client.once("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  console.log("Registering slash commands…");
  await rest.put(Routes.applicationCommands(client.application.id), {
    body: commands.map(c => c.toJSON()),
  });
  console.log("✅ Commands registered globally.");
  client.user.setActivity("/help to get started", { type: ActivityType.Listening });
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "link")   return await handleLink(interaction);
      if (interaction.commandName === "status") return await handleStatus(interaction);
      if (interaction.commandName === "help")   return await handleHelp(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("post:")) return await handlePostButton(interaction);
    }
  } catch (err) {
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
