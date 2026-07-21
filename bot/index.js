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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
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
// Structure: { "<guildId>:<channelId>": { trackerId, linkedAt?, mode?, registeredUsers?, messageIds?,
//   lastActivityAt?, dmSlotSettings?, itemCounts? } }
// dmSlotSettings: { [discordUserId]: { progression?: "all" | apPlayerPosition[], useful?: "all" | apPlayerPosition[] } }
// — per-user, per-slot opt-in to Progression / Useful item DMs for this channel's tracker. "all"
// means every slot the user owns, including ones added to the room later; an array is an explicit
// subset of AP player positions. A kind absent from a user's entry means DMs are off for it.
// itemCounts: { [apPlayerPosition]: lastSeenItemCount } — used to detect new items only. Shared
// baseline for both progression and useful DMs, since it just tracks total items received (it's
// not "progression-only" despite the field's old name).

function loadLinks() {
  if (!fs.existsSync(LINKS_FILE)) return {};
  return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
}

function saveLinks(links) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

// Serializes every links.json read-modify-write cycle. Without this, two handlers that each do
// loadLinks() -> (await something) -> saveLinks() can interleave: both load the same on-disk
// state, and whichever saves last silently overwrites the other's change. `mutator` gets the
// freshly-loaded links object to read/mutate (it may itself be async), and its return value is
// passed through as this call's result.
let linksQueue = Promise.resolve();
function withLinks(mutator) {
  const run = linksQueue.then(async () => {
    const links  = loadLinks();
    const result = await mutator(links);
    saveLinks(links);
    return result;
  });
  linksQueue = run.then(() => {}, () => {});
  return run;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every ctGet call fetches the same handful of tracker IDs — a DM-menu session alone can fire
// one per click (open, each toggle, each page, Enable/Disable All). This cache absorbs a burst
// of clicks on the same tracker within a few seconds without ever going stale for anything that
// actually cares about freshness (background refresh polls every 5 minutes).
const CT_CACHE_TTL_MS = 4000;
const ctCache = new Map(); // endpoint -> { data, fetchedAt }

async function ctGet(endpoint) {
  const cached = ctCache.get(endpoint);
  if (cached && Date.now() - cached.fetchedAt < CT_CACHE_TTL_MS) return cached.data;

  const data = await ctGetFresh(endpoint);
  ctCache.set(endpoint, { data, fetchedAt: Date.now() });
  return data;
}

// Retries a 429 a few times with backoff (honoring Retry-After when CheeseTrackers sends one)
// so a transient rate limit resolves itself within the same click instead of surfacing an error
// the user has to retry by clicking again. Any other failure still throws immediately, same as
// before — this only smooths over the one failure mode that's directly tied to click volume.
async function ctGetFresh(endpoint, attempt = 0) {
  const res = await fetch(`${BASE_URL}${endpoint}`, { headers: ctHeaders() });

  if (res.status === 429 && attempt < 3) {
    const retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
    await sleep(retryAfterMs);
    return ctGetFresh(endpoint, attempt + 1);
  }

  if (!res.ok) throw new Error(`CheeseTrackers API returned ${res.status}`);
  return res.json();
}

// ─── Archipelago webhost API (item DMs) ────────────────────────────────────────
// Public, unauthenticated JSON API exposed by the AP webhost itself (e.g. archipelago.gg),
// discovered via the CheeseTrackers tracker's `upstream_url` field. Confirmed against
// ArchipelagoMW/Archipelago's WebHostLib/api/tracker.py and BaseClasses.py.

const PROGRESSION_FLAG = 0b00001; // ItemClassification.progression bit
const USEFUL_FLAG      = 0b00010; // ItemClassification.useful bit

function deriveApTrackerInfo(upstreamUrl) {
  const url = new URL(upstreamUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const apTrackerId = segments[segments.length - 1];
  if (!apTrackerId) throw new Error("No tracker ID found in upstream_url");
  return { origin: url.origin, apTrackerId };
}

async function apGet(origin, endpoint) {
  const res = await fetch(`${origin}${endpoint}`);
  if (!res.ok) throw new Error(`Archipelago webhost API returned ${res.status}`);
  return res.json();
}

// Cache of datapackage item-id -> item-name maps, keyed by `${game}::${checksum}`.
// Safe to keep for the process lifetime — a checksum uniquely identifies a datapackage version.
const datapackageCache = new Map();

async function getItemIdToNameMap(origin, game, checksum) {
  const key = `${game}::${checksum}`;
  if (datapackageCache.has(key)) return datapackageCache.get(key);

  const pkg = await apGet(origin, `/api/datapackage/${checksum}`);
  const idToName = {};
  for (const [name, id] of Object.entries(pkg.item_name_to_id ?? {})) idToName[id] = name;
  datapackageCache.set(key, idToName);
  return idToName;
}

// Diffs each opted-in user's received items against the link's itemCounts and DMs
// them for any newly-received item flagged as progression and/or useful (per their own opt-in).
// Looks the link up fresh (by `key`) itself, inside withLinks, right before persisting — the
// network fetches below all happen before that lock is taken, so this never holds up other menu
// actions for longer than the synchronous diff. Never throws — failures are logged and treated
// as "no update".
async function checkNewItemDms(data, guild, key) {
  const peek = loadLinks()[key];
  if (!peek?.dmSlotSettings || !Object.keys(peek.dmSlotSettings).length) return;

  let apInfo;
  try {
    apInfo = deriveApTrackerInfo(data.upstream_url);
  } catch (err) {
    console.warn("[item-dm] Could not derive AP tracker info:", err.message);
    return;
  }

  let trackerData, staticData, memberByUsername;
  try {
    [trackerData, staticData, memberByUsername] = await Promise.all([
      apGet(apInfo.origin, `/api/tracker/${apInfo.apTrackerId}`),
      apGet(apInfo.origin, `/api/static_tracker/${apInfo.apTrackerId}`),
      buildMemberByUsernameMap(guild),
    ]);
  } catch (err) {
    console.warn("[item-dm] AP webhost fetch failed:", err.message);
    return;
  }

  const playerItemsReceived = trackerData.player_items_received ?? [];
  if (!playerItemsReceived.length) return;

  // O(1) position lookups instead of scanning `data.games` per entry/item — this room type can
  // have 1000+ slots, and the old .find() calls ran once per changed slot plus once per item.
  const gameByPosition = new Map((data.games ?? []).map(g => [g.position, g]));

  const pending = [];

  await withLinks(links => {
    const link = links[key];
    if (!link?.dmSlotSettings || !Object.keys(link.dmSlotSettings).length) return;

    if (!link.itemCounts) link.itemCounts = {};
    const counts = link.itemCounts;

    for (const entry of playerItemsReceived) {
      const position  = entry.player;
      const items     = entry.items ?? [];
      const prevCount = counts[position];

      if (prevCount === undefined) {
        // First time observing this slot — establish a baseline, don't backfill DMs.
        counts[position] = items.length;
        continue;
      }

      if (items.length <= prevCount) continue;
      const newItems = items.slice(prevCount);
      counts[position] = items.length;

      const game = gameByPosition.get(position);
      if (!game?.effective_discord_username) continue;
      const member = memberByUsername.get(game.effective_discord_username.toLowerCase());
      if (!member) continue;
      const dmSetting        = link.dmSlotSettings[member.id];
      if (!dmSetting) continue;
      const wantsProgression = isSlotSelected(dmSetting.progression, position);
      const wantsUseful      = isSlotSelected(dmSetting.useful, position);
      if (!wantsProgression && !wantsUseful) continue;

      const checksum = staticData?.datapackage?.[game.game]?.checksum;
      if (!checksum) continue;

      for (const netItem of newItems) {
        // NetworkItem tuple is [item, location, player, flags]. Here `player` is the SENDING
        // player (the world where the check happened), not the receiver. If that slot is claimed
        // by the same Discord user (even a different one of their games), they found it
        // themselves and already saw it live, so skip the DM.
        const [itemId, , senderPlayer, flags = 0] = netItem;

        let kind;
        if (wantsProgression && (flags & PROGRESSION_FLAG)) kind = "progression";
        else if (wantsUseful && (flags & USEFUL_FLAG)) kind = "useful";
        else continue;

        const senderGame = gameByPosition.get(senderPlayer);
        const senderUsername = senderGame?.effective_discord_username?.toLowerCase();
        const senderMember = senderUsername ? memberByUsername.get(senderUsername) : null;
        if (senderMember && senderMember.id === member.id) continue;

        pending.push({ kind, member, game, senderGame, senderPlayer, itemId, checksum, trackerId: link.trackerId, title: data.title });
      }
    }
  });

  // Datapackage lookups and the actual DM sends happen after the lock is released — no reason
  // to make other links.json operations wait on Discord API calls.
  for (const p of pending) {
    let idToName;
    try {
      idToName = await getItemIdToNameMap(apInfo.origin, p.game.game, p.checksum);
    } catch (err) {
      console.warn(`[item-dm] Failed to load datapackage for ${p.game.game}:`, err.message);
      continue;
    }

    const itemName    = idToName[p.itemId] ?? `Item #${p.itemId}`;
    const senderLabel = p.senderGame ? `${p.senderGame.game} (${p.senderGame.name})` : `Player ${p.senderPlayer}`;
    const trackerUrl  = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${p.trackerId}`;

    // Title leads with the tracker + slot name so it's the first thing visible when running
    // multiple trackers at once — Discord's mobile push preview renders the embed title + full
    // description, but no fields, so this keeps that identifying info in the notification itself
    // instead of buried in a field you only see once you open the DM. Kind (progression/useful)
    // is conveyed by color alone, no field needed. "Tracker" is still a field (matching the term
    // used everywhere else in the bot — "Link Tracker", "this tracker"), placed last so it sits
    // at the bottom of the embed.
    const embed = new EmbedBuilder()
      .setColor(p.kind === "useful" ? 0x2f6feb : 0x9b30ff)
      .setTitle(`${p.title} (${p.game.name})`)
      .setDescription(itemName)
      .addFields(
        { name: "Received In", value: `${p.game.game} (${p.game.name})` },
        { name: "Found by", value: senderLabel },
        { name: "Tracker", value: `**[${p.title}](${trackerUrl})**` },
      );

    try {
      await p.member.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[item-dm] Failed to DM ${p.member.id}:`, err.message);
    }
  }
}

// Establishes the { [position]: itemCount } baseline from the AP webhost's *current* item
// counts. Called right when a channel is linked so the baseline reflects that moment, not
// whatever the tracker looked like the first time someone happened to have DMs enabled during
// an auto-refresh tick — otherwise anything received in between is silently treated as
// pre-existing and never DMed. Returns null (and logs) on any fetch failure — link/relink still
// succeeds, it just leaves the baseline to be established lazily on the next tick as before.
async function computeItemCountBaseline(data) {
  let apInfo;
  try {
    apInfo = deriveApTrackerInfo(data.upstream_url);
  } catch (err) {
    console.warn("[item-dm] Could not derive AP tracker info for baseline:", err.message);
    return null;
  }

  let trackerData;
  try {
    trackerData = await apGet(apInfo.origin, `/api/tracker/${apInfo.apTrackerId}`);
  } catch (err) {
    console.warn("[item-dm] AP webhost fetch failed for baseline:", err.message);
    return null;
  }

  const counts = {};
  for (const entry of trackerData.player_items_received ?? []) {
    counts[entry.player] = (entry.items ?? []).length;
  }
  return counts;
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

async function buildMemberByUsernameMap(guild) {
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
  return memberByUsername;
}

// A dmSlotSettings value for one kind (progression/useful): "all" every owned slot including
// future ones, an array of specific AP player positions, or undefined/missing (off).
function isSlotSelected(setting, position) {
  return setting === "all" || (Array.isArray(setting) && setting.includes(position));
}

// Games in this tracker owned by `userId`, matched the same way checkNewItemDms resolves a slot's
// Discord owner (case-insensitive username/global name/nickname). Every call site needs both the
// full game objects (to render) and the bare positions (to cross-reference stored settings), so
// this returns both from the one fetch rather than making callers re-derive positions themselves.
async function getOwnedGames(guild, data, userId) {
  const memberByUsername = await buildMemberByUsernameMap(guild);
  const owned = [];
  for (const g of data.games ?? []) {
    if (!g.effective_discord_username) continue;
    const member = memberByUsername.get(g.effective_discord_username.toLowerCase());
    if (member?.id === userId) owned.push(g);
  }
  owned.sort((a, b) => a.game.localeCompare(b.game) || a.name.localeCompare(b.name));
  return { ownedGames: owned, ownedPositions: owned.map(g => g.position) };
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

// The "no link" guard repeats identically across most handlers — reply vs update depends only on
// whether the interaction has already been acknowledged by an earlier update/component render.
function notLinkedReply(interaction) {
  return interaction.reply({ content: "❌ This channel isn't linked to a tracker.", flags: MessageFlags.Ephemeral });
}

function notLinkedUpdate(interaction) {
  return interaction.update({ content: "❌ This channel isn't linked to a tracker.", embeds: [], components: [] });
}

// `ownedPositions`, when given, cross-references the stored setting against games the user
// currently owns — a stored array can otherwise still list positions from games unclaimed since
// (links.json never prunes those on its own), which would overcount. Omitted at call sites that
// don't have fresh tracker data on hand; those fall back to the raw (possibly stale) length.
function dmSettingSummary(setting, ownedPositions = null) {
  if (setting === "all") return "✅ **On** (all games)";
  if (!Array.isArray(setting) || !setting.length) return "❌ **Off**";
  const count = ownedPositions ? setting.filter(p => ownedPositions.includes(p)).length : setting.length;
  if (!count) return "❌ **Off**";
  return `✅ **On** (${count} game${count === 1 ? "" : "s"})`;
}

function buildMenuEmbed(link, userId, isManager, ownedPositions = null) {
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

  lines.push(`Progression item DMs: ${dmSettingSummary(link.dmSlotSettings?.[userId]?.progression, ownedPositions)}`);
  lines.push(`Useful item DMs: ${dmSettingSummary(link.dmSlotSettings?.[userId]?.useful, ownedPositions)}`);

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

  if (link) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("menu:dm").setLabel("DM Notifications").setStyle(ButtonStyle.Primary)
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

const DM_SLOTS_PER_PAGE = 25; // Discord's per-select option cap

// "Enable/Disable All" is a dedicated button, not a select option — mixing it into the select
// meant unchecking it while individual games still showed checked (inherited from "all") got
// silently overridden back to "all". A separate button has no such ambiguity: it's either "all"
// (select disabled — nothing to conflict with) or a plain per-game pick list.
//
// The select never marks options as default/selected — Discord renders a closed multi-select's
// default-selected options as inline chips in place of the placeholder, which is exactly the
// "every game listed one by one" clutter this avoids. Instead the placeholder itself carries a
// live count, and each option's description (not its checked state) shows current on/off — so
// picking an option here toggles that one game rather than replacing the page's whole selection.
function buildDmSlotRows(kind, ownedGames, setting, page, otherPage) {
  const isAll       = setting === "all";
  const totalPages  = Math.max(1, Math.ceil(ownedGames.length / DM_SLOTS_PER_PAGE));
  const clampedPage = Math.max(0, Math.min(page, totalPages - 1));
  // Both sections page over the same ownedGames list, so totalPages is shared — otherPage just
  // needs clamping the same way to stay valid if it's ever out of range.
  const clampedOtherPage = Math.max(0, Math.min(otherPage, totalPages - 1));
  const pageGames   = ownedGames.slice(clampedPage * DM_SLOTS_PER_PAGE, (clampedPage + 1) * DM_SLOTS_PER_PAGE);
  const label       = kind === "progression" ? "Progression" : "Useful";
  const pageSuffix  = totalPages > 1 ? ` — page ${clampedPage + 1}/${totalPages}` : "";
  // Counts only positions still among ownedGames — a stored array can otherwise still list a
  // position from a game unclaimed since (nothing prunes links.json on unclaim), overcounting.
  const ownedPositions = ownedGames.map(g => g.position);
  const onCount        = Array.isArray(setting) ? setting.filter(p => ownedPositions.includes(p)).length : 0;
  const placeholder = isAll
    ? `All ${label} enabled`
    : `${onCount === 0 ? "❌" : "✅"} ${onCount} of ${ownedGames.length} ${label} enabled${pageSuffix}`;

  const select = new StringSelectMenuBuilder()
    .setCustomId(`menu:dmslot:${kind}:${clampedPage}:${clampedOtherPage}`)
    .setPlaceholder(placeholder)
    .setDisabled(isAll)
    .setMinValues(0)
    .setMaxValues(pageGames.length)
    .addOptions(
      pageGames.map(g =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${g.game} (${g.name})`.slice(0, 100))
          .setDescription(isSlotSelected(setting, g.position) ? "✅ On — pick to turn off" : "❌ Off — pick to turn on")
          .setValue(String(g.position))
      )
    );

  const controls = [
    isAll
      ? new ButtonBuilder().setCustomId(`menu:dmslotall:${kind}:off:${clampedPage}:${clampedOtherPage}`).setLabel(`Disable All ${label}`).setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`menu:dmslotall:${kind}:on:${clampedPage}:${clampedOtherPage}`).setLabel(`Enable All ${label}`).setStyle(ButtonStyle.Success),
  ];
  if (totalPages > 1) {
    controls.push(
      new ButtonBuilder().setCustomId(`menu:dmslotpage:${kind}:p:${clampedPage}:${clampedOtherPage}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(clampedPage <= 0),
      new ButtonBuilder().setCustomId(`menu:dmslotpage:${kind}:n:${clampedPage}:${clampedOtherPage}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(clampedPage >= totalPages - 1),
    );
  }

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(...controls),
  ];
}

// Takes ownedGames rather than fetching it, so callers can reuse the same fetch for the embed's
// accurate DM-count lines (see dmSettingSummary) instead of resolving guild membership twice.
// `pages` optionally pins the current page per kind (e.g. { progression: 1 }) so paging one
// select doesn't bounce the other back to page 0 when the menu re-renders.
function buildDmMenuRows(link, userId, ownedGames, pages = {}) {
  if (!ownedGames.length) {
    return [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("menu:dm:noop").setLabel("You have no games in this tracker").setStyle(ButtonStyle.Secondary).setDisabled(true)
      ),
      backToMenuRow(),
    ];
  }

  const settings = link.dmSlotSettings?.[userId] ?? {};
  const rows = [
    ...buildDmSlotRows("progression", ownedGames, settings.progression, pages.progression ?? 0, pages.useful ?? 0),
    ...buildDmSlotRows("useful", ownedGames, settings.useful, pages.useful ?? 0, pages.progression ?? 0),
    backToMenuRow(),
  ];
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

async function clearMessageFromLinks(guildId, channelId) {
  const key = linkKey(guildId, channelId);
  await withLinks(links => {
    if (links[key]) {
      delete links[key].messageIds;
      delete links[key].lastActivityAt;
    }
  });
}

async function deleteLinkEntry(guildId, channelId) {
  const key = linkKey(guildId, channelId);
  await withLinks(links => {
    delete links[key];
  });
}

// messages is an array of Discord Message objects (one per posted page). initialData is the
// tracker data the caller already fetched to build/refresh those pages — reused here to run the
// first DM check immediately instead of waiting up to REFRESH_INTERVAL_MS for the first tick.
function startAutoRefresh(messages, trackerId, guild, initialData, initialHash, initialLastActivityAt = Date.now(), mode = "all", registeredUserIds = []) {
  const channelId = messages[0].channelId;
  const key       = linkKey(guild.id, channelId);
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

  checkNewItemDms(initialData, guild, key).catch(err => console.error("[item-dm] unexpected failure:", err));

  session.intervalId = setInterval(async () => {
    try {
      const data    = await ctGet(`/tracker/${trackerId}`);
      const newHash = hashTrackerData(data);
      const now     = Date.now();
      const changed = newHash !== session.lastHash;

      if (changed) {
        session.lastHash       = newHash;
        session.lastActivityAt = now;
        await withLinks(links => {
          if (links[key]) links[key].lastActivityAt = now;
        });
      }

      // Fetches its own data and persists itemCounts internally (via withLinks), so
      // this tick never has to hold a stale in-memory links snapshot across these awaits.
      await checkNewItemDms(data, guild, key);

      // No idle timeout — the loop (and item DMs with it) keeps running for as long as the
      // link exists, so opting into DMs doesn't silently stop working after an hour of quiet.
      // The only teardown is the 30-day stale-link sweep, and it leaves the last-posted embed
      // exactly as it was rather than editing it to a "stopped" state.
      const currentLink = loadLinks()[key];
      const lastSeen    = Math.max(currentLink?.linkedAt ?? 0, session.lastActivityAt);
      if (lastSeen > 0 && now - lastSeen > STALE_LINK_MS) {
        stopAutoRefresh(channelId);
        await deleteLinkEntry(guild.id, channelId);
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
        await clearMessageFromLinks(guild.id, channelId);
        stopAutoRefresh(channelId);
      }
      if (err.code === 10003) {
        await deleteLinkEntry(guild.id, channelId);
        stopAutoRefresh(channelId);
      }
    }
  }, REFRESH_INTERVAL_MS);

  activeRefreshes.set(channelId, session);
}

async function buildStatusPages(trackerId, data, guild, refreshStatus = null, mode = "all", registeredUserIds = []) {
  const { games, title, room_host, last_port } = data;

  const memberByUsername = await buildMemberByUsernameMap(guild);

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
  startAutoRefresh(messages, trackerId, interaction.guild, data, hashTrackerData(data), now, mode, registeredUsers);

  const messageIds = messages.map(m => m.id);
  await withLinks(freshLinks => {
    const freshLink = freshLinks[key];
    if (freshLink) {
      freshLink.messageIds     = messageIds;
      freshLink.lastActivityAt = now;
    }
  });

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
  if (!link) return notLinkedReply(interaction);

  const userId = interaction.user.id;
  const key    = linkKey(interaction.guildId, interaction.channelId);

  const { alreadyRegistered, freshLink } = await withLinks(links => {
    const freshLink = links[key];
    if (!freshLink.registeredUsers) freshLink.registeredUsers = [];
    if (freshLink.registeredUsers.includes(userId)) return { alreadyRegistered: true, freshLink };
    freshLink.registeredUsers.push(userId);
    return { alreadyRegistered: false, freshLink };
  });

  if (alreadyRegistered) {
    return interaction.reply({ content: "✅ You're already registered in this channel's tracker view.", flags: MessageFlags.Ephemeral });
  }

  // Ack before refreshRegisteredView's tracker fetch + message edits — those can easily run
  // past Discord's 3-second reply window, which is what was causing "This interaction failed".
  await interaction.deferUpdate();
  await refreshRegisteredView(interaction, freshLink);

  await interaction.editReply({
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, freshLink),
  });
  await interaction.followUp({
    content: "✅ Registered! Your games will appear in this channel's tracker view.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSelfUnregister(interaction, link) {
  if (!link) return notLinkedReply(interaction);

  const userId = interaction.user.id;
  const key    = linkKey(interaction.guildId, interaction.channelId);

  const { wasRegistered, freshLink } = await withLinks(links => {
    const freshLink = links[key];
    const idx       = (freshLink.registeredUsers ?? []).indexOf(userId);
    if (idx === -1) return { wasRegistered: false, freshLink };
    freshLink.registeredUsers.splice(idx, 1);
    return { wasRegistered: true, freshLink };
  });

  if (!wasRegistered) {
    return interaction.reply({ content: "❌ You're not registered in this channel's tracker view.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();
  await refreshRegisteredView(interaction, freshLink);

  await interaction.editReply({
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, freshLink),
  });
  await interaction.followUp({
    content: "✅ Unregistered. Your games will no longer appear in this channel's registered view.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDmMenu(interaction, link) {
  if (!link) return notLinkedReply(interaction);

  await interaction.deferUpdate();
  await interaction.editReply({ content: "Loading DM settings...", embeds: [], components: [] });

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ Failed to fetch tracker data: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const { ownedGames, ownedPositions } = await getOwnedGames(interaction.guild, data, interaction.user.id);

  await interaction.editReply({
    content: null,
    embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction), ownedPositions)],
    components: buildDmMenuRows(link, interaction.user.id, ownedGames),
  });
}

// Per-game toggles from a StringSelectMenu — only ever reachable when the kind isn't currently
// "all" (the select is disabled otherwise). The select doesn't track "checked" state (see
// buildDmSlotRows), so each submitted value is a flip: on->off or off->on. Games not picked are
// left exactly as they were, on any page.
async function handleDmSlotSelect(interaction) {
  const [, , kind, pageStr, otherPageStr] = interaction.customId.split(":");
  const page      = parseInt(pageStr, 10);
  const otherPage = parseInt(otherPageStr, 10);
  const key  = linkKey(interaction.guildId, interaction.channelId);
  const link = loadLinks()[key];

  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ Failed to fetch tracker data: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const toggledPositions = interaction.values.map(Number);

  const freshLink = await withLinks(freshLinks => {
    const l = freshLinks[key];
    l.dmSlotSettings ??= {};
    l.dmSlotSettings[interaction.user.id] ??= {};
    const prevSetting = l.dmSlotSettings[interaction.user.id][kind];
    const resolved     = new Set(Array.isArray(prevSetting) ? prevSetting : []);

    for (const pos of toggledPositions) {
      if (resolved.has(pos)) resolved.delete(pos);
      else resolved.add(pos);
    }

    l.dmSlotSettings[interaction.user.id][kind] = [...resolved];
    return l;
  });

  const { ownedGames, ownedPositions } = await getOwnedGames(interaction.guild, data, interaction.user.id);

  await interaction.editReply({
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, hasManageChannels(interaction), ownedPositions)],
    components: buildDmMenuRows(freshLink, interaction.user.id, ownedGames, {
      progression: kind === "progression" ? page : otherPage,
      useful:      kind === "useful" ? page : otherPage,
    }),
  });
}

// Dedicated Enable All / Disable All button — a single unconditional action, so there's no
// ambiguity with whatever the per-game select happens to show.
async function handleDmSlotAllToggle(interaction) {
  const [, , kind, action, pageStr, otherPageStr] = interaction.customId.split(":");
  const page      = parseInt(pageStr, 10);
  const otherPage = parseInt(otherPageStr, 10);
  const key  = linkKey(interaction.guildId, interaction.channelId);
  const link = loadLinks()[key];

  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ Failed to fetch tracker data: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const freshLink = await withLinks(freshLinks => {
    const l = freshLinks[key];
    l.dmSlotSettings ??= {};
    l.dmSlotSettings[interaction.user.id] ??= {};
    l.dmSlotSettings[interaction.user.id][kind] = action === "on" ? "all" : [];
    return l;
  });

  const { ownedGames, ownedPositions } = await getOwnedGames(interaction.guild, data, interaction.user.id);

  await interaction.editReply({
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, hasManageChannels(interaction), ownedPositions)],
    components: buildDmMenuRows(freshLink, interaction.user.id, ownedGames, {
      progression: kind === "progression" ? page : otherPage,
      useful:      kind === "useful" ? page : otherPage,
    }),
  });
}

async function handleDmSlotPageButton(interaction) {
  const [, , kind, dir, pageStr, otherPageStr] = interaction.customId.split(":");
  const fromPage  = parseInt(pageStr, 10);
  const otherPage = parseInt(otherPageStr, 10);
  const key      = linkKey(interaction.guildId, interaction.channelId);
  const link     = loadLinks()[key];

  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();

  let data;
  try {
    data = await ctGet(`/tracker/${link.trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ Failed to fetch tracker data: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const newPage       = dir === "n" ? fromPage + 1 : fromPage - 1;
  const { ownedGames, ownedPositions } = await getOwnedGames(interaction.guild, data, interaction.user.id);

  await interaction.editReply({
    embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction), ownedPositions)],
    components: buildDmMenuRows(link, interaction.user.id, ownedGames, {
      progression: kind === "progression" ? newPage : otherPage,
      useful:      kind === "useful" ? newPage : otherPage,
    }),
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

  // The modal was opened from the Admin Menu button, so this submission can edit that same
  // (possibly ephemeral) message directly via deferUpdate/editReply — no need to smuggle its
  // ID around and refetch it later, which doesn't work for ephemeral messages anyway.
  await interaction.deferUpdate();

  let data;
  try {
    data = await ctGet(`/tracker/${trackerId}`);
  } catch (err) {
    return interaction.followUp({ content: `❌ Could not reach that tracker: ${err.message}`, flags: MessageFlags.Ephemeral });
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
    embeds: [],
    components: [row],
  });
}

async function handleLinkModeButton(interaction, mode, trackerId) {
  const channel = interaction.channel;
  const key     = linkKey(interaction.guildId, channel.id);

  const { isUpdate, freshLink } = await withLinks(links => {
    const existed  = Boolean(links[key]);
    links[key]     = { trackerId, linkedAt: Date.now(), mode };
    return { isUpdate: existed, freshLink: links[key] };
  });

  await interaction.update({
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, true)],
    components: buildAdminMenuRows(freshLink),
  });

  const modeLabel  = mode === "all" ? "**Show All**" : "**Registered Only**";
  const trackerUrl = `https://cheesetrackers.theincrediblewheelofchee.se/tracker/${trackerId}`;
  await interaction.followUp({
    content: `✅ **#${channel.name}** is now ${isUpdate ? "updated to" : "linked to"} [this tracker](${trackerUrl}) in ${modeLabel} mode.`,
    flags: MessageFlags.Ephemeral,
  });

  try {
    const data     = await ctGet(`/tracker/${trackerId}`);
    const baseline = await computeItemCountBaseline(data);
    if (baseline) {
      await withLinks(links => {
        if (links[key]) links[key].itemCounts = baseline;
      });
    }
  } catch (err) {
    console.warn("[item-dm] Failed to establish item-count baseline at link time:", err.message);
  }
}

async function handleUnlinkConfirm(interaction) {
  stopAutoRefresh(interaction.channelId);
  await deleteLinkEntry(interaction.guildId, interaction.channelId);

  await interaction.update({
    embeds: [buildMenuEmbed(null, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, null),
  });
}

async function handleAdminViewMode(interaction, link, mode) {
  if (!link) return notLinkedReply(interaction);

  await interaction.deferUpdate();

  const key = linkKey(interaction.guildId, interaction.channelId);
  let freshLink = await withLinks(links => {
    links[key].mode = mode;
    return links[key];
  });

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
        const newMessageIds = session.messages.map(m => m.id);
        freshLink = await withLinks(links => {
          const l = links[key];
          if (l) l.messageIds = newMessageIds;
          return l ?? freshLink;
        });
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

  const key      = linkKey(interaction.guildId, interaction.channelId);
  const targetId = interaction.values[0];

  const { link, already } = await withLinks(links => {
    const link = links[key];
    if (!link) return { link: null, already: false };
    if (!link.registeredUsers) link.registeredUsers = [];
    const already = link.registeredUsers.includes(targetId);
    if (!already) link.registeredUsers.push(targetId);
    return { link, already };
  });

  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();
  if (!already) await refreshRegisteredView(interaction, link);

  await interaction.editReply({ embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction))], components: buildAdminMenuRows(link) });
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
  if (id === "menu:dm") return handleDmMenu(interaction, link);

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
    // Format: menu:admin:linkmode:<mode>:<trackerId>. trackerId can't contain ":"
    // (enforced by parseTrackerId), so the first colon is enough to split off `mode`.
    const rest      = id.slice("menu:admin:linkmode:".length);
    const firstSep  = rest.indexOf(":");
    const mode      = rest.slice(0, firstSep);
    const trackerId = rest.slice(firstSep + 1);
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
          "- **DM Notifications** — opens a submenu with a dropdown per item kind (**Progression**, **Useful**). Picking a game in the dropdown toggles it on/off (its description shows current state); the dropdown's own label shows how many are on. **Enable All** covers the whole roster, including games added later; the dropdown is disabled while that's on — hit **Disable All** first to pick individually.\n" +
          "- **Admin Actions** *(Manage Channels only)* — link/unlink this channel's tracker, switch view mode between **Show All** and **Registered Only**, or register another player.",
      },
      { name: "`/help`", value: "Show this message." },
      { name: "GitHub",  value: "[github.com/ChakraaThePanda/Archeesepelago-Discord-Bot](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot)" },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Client ───────────────────────────────────────────────────────────────────

// Without this, an unhandled rejection anywhere (a missed .catch on a fire-and-forget call, an
// unguarded await in a timer) kills the whole process — every interaction in flight at that
// moment fails with Discord's generic "This interaction failed", regardless of which button or
// menu the user actually clicked.
process.on("unhandledRejection", err => {
  console.error("[unhandled rejection]", err);
});

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

  // Resume auto-refresh for any persisted message IDs, immediately updating each embed.
  // Each removal/clear below persists immediately via its own withLinks call rather than
  // accumulating into one big save at the end — this loop can run for minutes (deliberate
  // 2s spacing per link plus network calls), and a single end-of-loop save would otherwise
  // hold a stale snapshot across that whole window and clobber any menu action a user takes
  // while the bot is still resuming.
  const links = loadLinks();
  let first   = true;
  const now   = Date.now();

  for (const [key, link] of Object.entries(links)) {
    // Remove entries with no activity in 30+ days (skip legacy entries with no timestamps)
    const lastSeen = Math.max(link.linkedAt ?? 0, link.lastActivityAt ?? 0);
    if (lastSeen > 0 && now - lastSeen > STALE_LINK_MS) {
      console.log(`[resume] Removing stale link ${key} (last activity > 30 days ago)`);
      await withLinks(ls => { delete ls[key]; });
      continue;
    }

    if (!link.messageIds?.length) continue;

    if (!first) await new Promise(r => setTimeout(r, 2000));
    first = false;

    const [guildId, channelId] = key.split(":");
    const mode                 = link.mode ?? "all";
    const registeredUsers      = link.registeredUsers ?? [];

    try {
      const guild   = await client.guilds.fetch(guildId);
      const channel = await client.channels.fetch(channelId);
      const data    = await ctGet(`/tracker/${link.trackerId}`);

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
        startAutoRefresh(messages, link.trackerId, guild, data, hashTrackerData(data), link.lastActivityAt, mode, registeredUsers);
        console.log(`[resume] Restored and updated auto-refresh for ${key}`);
        continue;
      }
    } catch (err) {
      if (err.code === 10003 || err.code === 10004) {
        console.log(`[resume] Removing dead link ${key}: ${err.message}`);
        await withLinks(ls => { delete ls[key]; });
        continue;
      }
      console.warn(`[resume] Failed to restore ${key}:`, err.message);
    }

    await withLinks(ls => {
      const l = ls[key];
      if (l) { delete l.messageIds; delete l.lastActivityAt; }
    });
  }
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
      if (interaction.customId.startsWith("pg:"))              return await handlePageButton(interaction);
      if (interaction.customId.startsWith("post:"))            return await handlePostButton(interaction);
      if (interaction.customId.startsWith("menu:dmslotpage:")) return await handleDmSlotPageButton(interaction);
      if (interaction.customId.startsWith("menu:dmslotall:"))  return await handleDmSlotAllToggle(interaction);
      if (interaction.customId.startsWith("menu:"))            return await handleMenuButton(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal:link") return await handleLinkModalSubmit(interaction);
    }
    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === "menu:admin:registeruser:select") return await handleRegisterUserSelect(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("menu:dmslot:")) return await handleDmSlotSelect(interaction);
    }
  } catch (err) {
    if (err.code === 10062) return; // interaction expired (e.g. bot restarted mid-flight) — nothing to do
    console.error(`[${interaction.commandName ?? interaction.customId}]`, err);
    const msg = err.code === 50001
      ? "❌ I don't have permission to post in this channel. Check that my role has **View Channel** and **Send Messages** here, then try again."
      : `❌ Unexpected error: ${err.message}`;
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
