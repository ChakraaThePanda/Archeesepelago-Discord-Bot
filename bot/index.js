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

const CT_API_KEY        = process.env.CT_API_KEY;
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const CT_HOST           = "cheesetrackers.theincrediblewheelofchee.se";
const BASE_URL          = `https://${CT_HOST}/api`;
const LINKS_FILE        = path.join(__dirname, "links.json");

const EMBED_COLOR       = 0xf5c542; // Every embed except DMs, which are colored by kind
const BIG_WORLD_PLAYERS = 20;       // Player count that triggers the "use Registered Only" warning

function trackerUrl(trackerId) {
  return `https://${CT_HOST}/tracker/${trackerId}`;
}

function collectionRoomUrl(roomId) {
  return `https://${CT_HOST}/collection_room/${roomId}`;
}

// ─── Persistent Links (JSON) ──────────────────────────────────────────────────
// Structure: { "<guildId>:<channelId>": entry }, one entry per linked channel. An entry is either
// a tracker link, or (before the game has a tracker) a collection room, never both: linking a
// tracker overwrites the whole entry, and a collection room can't be linked while a tracker is.
// Read entries through trackerLinkOf/collectionRoomOf rather than links[key], so a collection-only
// entry is never mistaken for a tracker.
//
// Tracker link: { trackerId, linkedAt?, mode?, registeredUsers?, messageIds?, lastActivityAt?,
//   dmSlotSettings?, itemCounts?, hintKeys? }
// Collection room: { collectionRoom: { roomId, linkedAt, messageId?, lastActivityAt? } }, where a
//   CheeseTrackers collection room gathers YAMLs before the game is generated. messageId and
//   lastActivityAt belong to its posted status, like a tracker link's messageIds/lastActivityAt.
//
// dmSlotSettings: { [discordUserId]: { progression?: "all" | apPlayerPosition[], useful?: "all" | apPlayerPosition[],
//   hintProgression?: boolean, hintUseful?: boolean } }
// progression/useful are per-user, per-slot opt-in to Progression / Useful item DMs for this
// channel's tracker. "all" means every slot the user owns, including ones added to the room later;
// an array is an explicit subset of AP player positions. A kind absent from a user's entry means
// DMs are off for it.
// hintProgression/hintUseful are plain on/off toggles for Hint Received DMs, applying to every
// game the user owns (not just the slots selected above for progression/useful item DMs) since a
// hint can be about a game the user hasn't picked for item DMs at all.
// itemCounts: { [apPlayerPosition]: lastSeenItemCount }, used to detect new items only. Shared
// baseline for both progression and useful DMs, since it just tracks total items received (it's
// not "progression-only" despite the field's old name).
// hintKeys: { [apPlayerPosition]: hintKey[] }, the identity keys of hints already seen/notified for
// that position (as the hint's receiving player), used to detect newly-created hints only.

// A JSON file that's only re-parsed when it changed on disk. links.json can reach megabytes
// (itemCounts/hintKeys for big rooms), and re-parsing it on every click and every refresh tick
// was the bot's biggest avoidable cost. load() compares the file's modified time first (a cheap
// check), so it always returns what's on disk, including edits made outside the bot. The returned
// object is shared, so read from it freely but only change it inside update().
//
// update() serializes every read-modify-write cycle. Without that, two handlers that each await
// something mid-change could interleave, and whichever saved last would silently overwrite the
// other. `mutator` gets the latest data to change (it may be async), and its return value is
// passed through. The file is rewritten after every update().
function createJsonStore(file) {
  let data    = null;
  let mtimeMs = null;
  let queue   = Promise.resolve();

  function load() {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) {
      if (mtimeMs !== null) data = null; // deleted while running: start empty, like a fresh install
      data    ??= {};
      mtimeMs   = null;
    } else if (stat.mtimeMs !== mtimeMs) {
      data    = JSON.parse(fs.readFileSync(file, "utf8"));
      mtimeMs = stat.mtimeMs;
    }
    return data;
  }

  function update(mutator) {
    const run = queue.then(async () => {
      const result = await mutator(load());
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      mtimeMs = fs.statSync(file).mtimeMs;
      return result;
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  return { load, update };
}

const linksStore = createJsonStore(LINKS_FILE);
const loadLinks  = linksStore.load;
const withLinks  = linksStore.update;

function linkKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

// The channel's tracker link, or undefined if it has none (including a collection-only entry).
function trackerLinkOf(links, key) {
  const entry = links[key];
  return entry?.trackerId ? entry : undefined;
}

// The channel's collection room, or undefined. Only a channel without a tracker can have one.
function collectionRoomOf(links, key) {
  const entry = links[key];
  return entry && !entry.trackerId ? entry.collectionRoom : undefined;
}

function collectionRoomIdFor(interaction) {
  return collectionRoomOf(loadLinks(), linkKey(interaction.guildId, interaction.channelId))?.roomId ?? null;
}

function deleteCollectionEntry(guildId, channelId) {
  const key = linkKey(guildId, channelId);
  return withLinks(links => { if (collectionRoomOf(links, key)) delete links[key]; });
}

// ─── CT API ───────────────────────────────────────────────────────────────────

// An HTTP error status from the CT or AP API. Like a node-fetch FetchError (DNS hiccup, dropped
// connection), it's usually temporary, so callers retrying on a timer treat both as "try again
// later" rather than a bug (see isTransientError).
class ApiError extends Error {}

function isTransientError(err) {
  return err instanceof ApiError || err.name === "FetchError";
}

// Consecutive transient failures per "<tag>:<key>", so timer-driven checks only log an outage
// that lasts, not every one-off timeout. Each check retries on the next refresh anyway.
const failStreaks     = new Map();
const FAIL_WARN_AFTER = 3; // about 15 minutes at the 5-minute refresh interval

function noteFailure(tag, key, err) {
  const id     = `${tag}:${key}`;
  const streak = (failStreaks.get(id) ?? 0) + 1;
  failStreaks.set(id, streak);
  if (streak === FAIL_WARN_AFTER) console.warn(`[${tag}] Failed ${streak} checks in a row for ${key}: ${err.message}`);
}

function noteSuccess(tag, key) {
  const id = `${tag}:${key}`;
  if (failStreaks.get(id) >= FAIL_WARN_AFTER) console.log(`[${tag}] Working again for ${key}`);
  failStreaks.delete(id);
}

function ctHeaders() {
  const h = {};
  if (CT_API_KEY) h["Authorization"] = `Bearer ${CT_API_KEY}`;
  return h;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Every ctGet call fetches the same handful of tracker IDs, and a DM menu session alone can fire
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
// before. This only smooths over the one failure mode that's directly tied to click volume.
async function ctGetFresh(endpoint, attempt = 0) {
  const res = await fetch(`${BASE_URL}${endpoint}`, { headers: ctHeaders() });

  if (res.status === 429 && attempt < 3) {
    const retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
    await sleep(retryAfterMs);
    return ctGetFresh(endpoint, attempt + 1);
  }

  if (!res.ok) throw new ApiError(`CheeseTrackers API returned ${res.status}`);
  return res.json();
}

// Every tracker read goes through here, so a malformed response fails with a clear message
// instead of crashing whatever reads `data.games` next.
async function fetchTracker(trackerId) {
  const data = await ctGet(`/tracker/${trackerId}`);
  if (!Array.isArray(data?.games)) {
    throw new ApiError("Unexpected response from CheeseTrackers. The tracker may be unavailable.");
  }
  return data;
}

// ─── Archipelago webhost API (item DMs) ────────────────────────────────────────
// Public, unauthenticated JSON API exposed by the AP webhost itself (e.g. archipelago.gg),
// discovered via the CheeseTrackers tracker's `upstream_url` field. Confirmed against
// ArchipelagoMW/Archipelago's WebHostLib/api/tracker.py and BaseClasses.py.

const PROGRESSION_FLAG = 0b00001; // ItemClassification.progression bit
const USEFUL_FLAG      = 0b00010; // ItemClassification.useful bit
const TRAP_FLAG        = 0b00100; // ItemClassification.trap bit

// DM embed colors, one per notification kind.
const PROGRESSION_DM_COLOR = 0x9b30ff; // Purple
const USEFUL_DM_COLOR      = 0x2f6feb; // Blue
const HINT_DM_COLOR        = 0x1abc9c; // Teal

// Human-readable classification label for a hint's item_flags, shown next to the item name in
// hint DMs since, unlike item-received DMs, there's no separate opt-in per classification to
// imply it. Trap takes priority over progression/useful since a trap can carry either bit too.
// Deliberately NOT reused for the progression/useful item-DM routing check below (which tests
// PROGRESSION_FLAG/USEFUL_FLAG directly, gated by each user's own opt-in, and ignores trap
// entirely). That check decides which opt-in bucket a received item routes to, while this decides
// what label to print. A "progression trap" should still route as progression there; folding
// the two together would make it silently stop matching once trap-priority kicks in here.
function classifyItemFlags(flags) {
  if (flags & TRAP_FLAG) return "Trap";
  if (flags & PROGRESSION_FLAG) return "Progression";
  if (flags & USEFUL_FLAG) return "Useful";
  return "Filler";
}

function deriveApTrackerInfo(upstreamUrl) {
  const url = new URL(upstreamUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  const apTrackerId = segments[segments.length - 1];
  if (!apTrackerId) throw new Error("No tracker ID found in upstream_url");
  return { origin: url.origin, apTrackerId };
}

async function apGet(origin, endpoint) {
  const res = await fetch(`${origin}${endpoint}`);
  if (!res.ok) throw new ApiError(`Archipelago webhost API returned ${res.status}`);
  return res.json();
}

// Cache of datapackage id->name maps (items and locations), keyed by `${game}::${checksum}`.
// Safe to keep for the process lifetime, since a checksum uniquely identifies a datapackage version.
// Item ids live in the receiving game's namespace; location ids live in the finding game's
// namespace, so callers pick whichever game/checksum matches what they're looking up.
const datapackageCache = new Map();

async function getDatapackageMaps(origin, game, checksum) {
  const key = `${game}::${checksum}`;
  if (datapackageCache.has(key)) return datapackageCache.get(key);

  const pkg = await apGet(origin, `/api/datapackage/${checksum}`);
  const itemIdToName = {};
  for (const [name, id] of Object.entries(pkg.item_name_to_id ?? {})) itemIdToName[id] = name;
  const locationIdToName = {};
  for (const [name, id] of Object.entries(pkg.location_name_to_id ?? {})) locationIdToName[id] = name;

  const maps = { itemIdToName, locationIdToName };
  datapackageCache.set(key, maps);
  return maps;
}

// getDatapackageMaps, but never throws: returns null (after logging) on a missing game/checksum
// or a fetch failure. Lets callers fire the item-name and location-name lookups for one DM
// together via Promise.all instead of sequentially, since they're independent fetches (different
// game/checksum pairs).
async function getDatapackageMapsOrNull(origin, game, checksum, logPrefix) {
  if (!game || !checksum) return null;
  try {
    return await getDatapackageMaps(origin, game.game, checksum);
  } catch (err) {
    console.warn(`[${logPrefix}] Failed to load datapackage for ${game.game}:`, err.message);
    return null;
  }
}

// A Hint tuple serializes as [receiving_player, finding_player, location, item, found, entrance,
// item_flags, status] (Archipelago's WebHostLib NamedTuple -> JSON array convention, same as
// NetworkItem below). Identity deliberately excludes `found`/`status` (indices 4 and 7), since those
// can flip after a hint is first seen (e.g. once its location gets checked), and re-keying on them
// would re-notify for a hint the user has already been DMed about.
function hintKeyOf(hint) {
  return JSON.stringify([hint[0], hint[1], hint[2], hint[3], hint[5]]);
}

// Diffs each opted-in user's received items (against the link's itemCounts) and hints (against
// hintKeys), DMing for any newly-received item flagged as progression and/or useful, and any
// newly-created, not-yet-checked hint on a Progression/Useful item, whether it points at one of
// their items in someone else's world, or at a location in their own world holding someone
// else's item (per their own opt-in for each). Looks the link up fresh (by `key`) itself, inside
// withLinks, right before persisting, since the network fetches below all happen before that lock is
// taken, so this never holds up other menu actions for longer than the synchronous diff. Never
// throws; failures are logged and treated as "no update".
async function checkNewDms(data, guild, key) {
  const peek = trackerLinkOf(loadLinks(), key);
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
    // The AP webhost times out now and then, and the next refresh retries anyway.
    if (isTransientError(err)) noteFailure("item-dm", key, err);
    else console.error("[item-dm] AP webhost fetch failed:", err);
    return;
  }
  noteSuccess("item-dm", key);

  const playerItemsReceived = trackerData.player_items_received ?? [];
  const playerHints         = trackerData.hints ?? [];
  if (!playerItemsReceived.length && !playerHints.length) return;

  // CT can return a falsy title (see buildStatusPages' own `title || "Tracker Status"` fallback).
  // embed.setTitle() throws on an empty string, and that throw isn't caught per-recipient, so
  // an unguarded raw title would silently drop every remaining DM in this tick.
  const trackerTitle = data.title || "Tracker Status";

  // O(1) position lookups instead of scanning `data.games` per entry/item, since a room can
  // have 1000+ slots, and the old .find() calls ran once per changed slot plus once per item.
  const gameByPosition = new Map((data.games ?? []).map(g => [g.position, g]));

  const pendingItems = [];
  const pendingHints = [];

  await withLinks(links => {
    const link = trackerLinkOf(links, key);
    if (!link?.dmSlotSettings || !Object.keys(link.dmSlotSettings).length) return;

    if (!link.itemCounts) link.itemCounts = {};
    const counts = link.itemCounts;

    for (const entry of playerItemsReceived) {
      const position  = entry.player;
      const items     = entry.items ?? [];
      const prevCount = counts[position];

      if (prevCount === undefined) {
        // First time observing this slot: establish a baseline, don't backfill DMs.
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
        const [itemId, locationId, senderPlayer, flags = 0] = netItem;

        let kind;
        if (wantsProgression && (flags & PROGRESSION_FLAG)) kind = "progression";
        else if (wantsUseful && (flags & USEFUL_FLAG)) kind = "useful";
        else continue;

        const senderGame = gameByPosition.get(senderPlayer);
        const senderMember = resolveOwnerMember(memberByUsername, senderGame);
        if (senderMember && senderMember.id === member.id) continue;

        // Location ids live in the SENDING game's namespace (the location belongs to the world
        // where the check happened), unlike item ids which live in the receiving game's namespace.
        const senderChecksum = senderGame ? staticData?.datapackage?.[senderGame.game]?.checksum : null;

        pendingItems.push({
          kind, member, game, senderGame, senderPlayer, itemId, locationId,
          checksum, senderChecksum, trackerId: link.trackerId, title: trackerTitle,
        });
      }
    }

    if (!link.hintKeys) link.hintKeys = {};
    const hintKeys = link.hintKeys;

    for (const entry of playerHints) {
      const position = entry.player;
      // A player's hint list already mixes hints where they're the receiver (their item is
      // somewhere) and ones where they're the finder (their location holds someone else's item).
      // See PlayerHints docstring: "relevant" hints. Both are "Hint Received" notifications,
      // just about different things, so no role filter here: track/diff the whole list.
      const allHints     = entry.hints ?? [];
      const currentKeys  = allHints.map(hintKeyOf);
      const prevKeys     = hintKeys[position];

      if (prevKeys === undefined) {
        // First time observing this slot's hints: establish a baseline, don't backfill DMs.
        hintKeys[position] = currentKeys;
        continue;
      }

      const prevKeySet = new Set(prevKeys);
      const newHints    = allHints.filter(h => !prevKeySet.has(hintKeyOf(h)));
      // Grow-only, like itemCounts, since a transient partial/empty response from the AP webhost
      // must never shrink the baseline, or previously-seen hints would look "new" again next
      // tick and get re-DMed.
      hintKeys[position] = [...new Set([...prevKeys, ...currentKeys])];
      if (!newHints.length) continue;

      const game = gameByPosition.get(position);
      if (!game?.effective_discord_username) continue;
      const member = memberByUsername.get(game.effective_discord_username.toLowerCase());
      if (!member) continue;
      const dmSetting = link.dmSlotSettings[member.id];
      if (!dmSetting || (!dmSetting.hintProgression && !dmSetting.hintUseful)) continue;

      // This position's own checksum doubles as the item namespace when it's the receiving
      // player (its item's id space) and as the location namespace when it's the finding player
      // (its location's id space); see the two branches below.
      const ownChecksum = staticData?.datapackage?.[game.game]?.checksum;
      if (!ownChecksum) continue;

      for (const hint of newHints) {
        const [receivingPlayer, findingPlayer, location, itemId, found, , itemFlags = 0] = hint;
        // Already checked by the time we saw it. Whichever side of the hint this is, the
        // outcome is already old news, so a DM about it would be redundant.
        if (found) continue;

        // Only Progression and Useful items are worth a hint DM, each gated by its own toggle
        // (hintProgression/hintUseful), applying across every game the user owns regardless of
        // that game's progression/useful item-DM selection above. Filler and Trap aren't
        // interesting enough to notify about either way. Uses the same classification the embed
        // itself displays, so an item never gets excluded here yet still shown as "Progression"
        // in a DM that did go out (or vice versa).
        const classification = classifyItemFlags(itemFlags);
        if (classification === "Progression" && !dmSetting.hintProgression) continue;
        if (classification === "Useful" && !dmSetting.hintUseful) continue;
        if (classification !== "Progression" && classification !== "Useful") continue;

        if (receivingPlayer === position && findingPlayer !== position) {
          // Someone hinted a location in THEIR world, and it holds YOUR item.
          const senderGame = gameByPosition.get(findingPlayer);
          const senderMember = resolveOwnerMember(memberByUsername, senderGame);
          if (senderMember && senderMember.id === member.id) continue;

          const senderChecksum = senderGame ? staticData?.datapackage?.[senderGame.game]?.checksum : null;

          pendingHints.push({
            scenario: "item", member, game, checksum: ownChecksum,
            otherGame: senderGame, otherPlayer: findingPlayer, otherChecksum: senderChecksum,
            location, itemId, itemFlags, trackerId: link.trackerId, title: trackerTitle,
          });
        } else if (findingPlayer === position && receivingPlayer !== position) {
          // Someone hinted one of THEIR items, and it's sitting at a location in YOUR world.
          const receiverGame = gameByPosition.get(receivingPlayer);
          const receiverMember = resolveOwnerMember(memberByUsername, receiverGame);
          if (receiverMember && receiverMember.id === member.id) continue;

          const receiverChecksum = receiverGame ? staticData?.datapackage?.[receiverGame.game]?.checksum : null;

          pendingHints.push({
            scenario: "location", member, game, checksum: ownChecksum,
            otherGame: receiverGame, otherPlayer: receivingPlayer, otherChecksum: receiverChecksum,
            location, itemId, itemFlags, trackerId: link.trackerId, title: trackerTitle,
          });
        }
        // else: receivingPlayer === findingPlayer === position, your own item at your own
        // location (e.g. a shop hover auto-hint). Not interesting, skip.
      }
    }
  });

  // Datapackage lookups and the actual DM sends happen after the lock is released, so other
  // links.json operations never wait on Discord API calls.
  for (const p of pendingItems) {
    // Item and location names live in different datapackages (receiving vs. sending game), so fire
    // both fetches together rather than sequentially since neither depends on the other.
    const [itemMaps, locationMaps] = await Promise.all([
      getDatapackageMapsOrNull(apInfo.origin, p.game, p.checksum, "item-dm"),
      getDatapackageMapsOrNull(apInfo.origin, p.senderGame, p.senderChecksum, "item-dm"),
    ]);
    if (!itemMaps) continue;

    const itemName    = itemMaps.itemIdToName[p.itemId] ?? `Item #${p.itemId}`;
    const locationName = locationMaps?.locationIdToName[p.locationId] ?? null;

    const senderLabel = p.senderGame
      ? `${p.senderGame.name} (${p.senderGame.game})${locationName ? `\n${locationName}` : ""}`
      : `Player ${p.senderPlayer}`;

    // Discord's mobile push preview renders the embed title + full description, but no fields, so
    // description carries both the item name and the receiving slot (no separate "Received In"
    // field) so that identifying info still shows up in the notification itself, not just once
    // the DM is opened. Kind (progression/useful) is conveyed by color + author, no field needed.
    // The tracker link lives on the title itself (setURL) rather than a separate "Tracker" field.
    const embed = new EmbedBuilder()
      .setColor(p.kind === "useful" ? USEFUL_DM_COLOR : PROGRESSION_DM_COLOR)
      .setAuthor({ name: p.kind === "useful" ? "Useful Item Received" : "Progression Item Received" })
      .setTitle(p.title)
      .setURL(trackerUrl(p.trackerId))
      .setDescription(`${itemName}\n${p.game.name} (${p.game.game})`)
      .addFields({ name: "Found by", value: senderLabel });

    try {
      await p.member.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[item-dm] Failed to DM ${p.member.id}:`, err.message);
    }
  }

  for (const p of pendingHints) {
    // "item" scenario: p.game is the receiving (your) side, item ids live in its namespace,
    // and p.otherGame is the finder whose world holds the location.
    // "location" scenario: p.game is the finding (your) side, location ids live in its
    // namespace, and p.otherGame is the receiver who'll get the item.
    const itemGame        = p.scenario === "item" ? p.game : p.otherGame;
    const itemChecksum    = p.scenario === "item" ? p.checksum : p.otherChecksum;
    const locationGame     = p.scenario === "item" ? p.otherGame : p.game;
    const locationChecksum = p.scenario === "item" ? p.otherChecksum : p.checksum;

    // Item and location live in different datapackages (receiving vs. finding game, whichever
    // side is "yours" for this scenario), so fire both fetches together since they're independent.
    const [itemMaps, locationMaps] = await Promise.all([
      getDatapackageMapsOrNull(apInfo.origin, itemGame, itemChecksum, "hint-dm"),
      getDatapackageMapsOrNull(apInfo.origin, locationGame, locationChecksum, "hint-dm"),
    ]);

    const itemName  = itemMaps?.itemIdToName[p.itemId] ?? `Item #${p.itemId}`;
    const itemLabel = `${itemName} (${classifyItemFlags(p.itemFlags)})`;
    const locationName = locationMaps?.locationIdToName[p.location] ?? `Location #${p.location}`;

    const otherLabel = p.otherGame ? `${p.otherGame.name} (${p.otherGame.game})` : `Player ${p.otherPlayer}`;
    const yourLabel   = `${p.game.name} (${p.game.game})`;

    const embed = new EmbedBuilder()
      .setColor(HINT_DM_COLOR)
      .setAuthor({ name: "New Hint" })
      .setTitle(p.title)
      .setURL(trackerUrl(p.trackerId));

    if (p.scenario === "item") {
      embed.addFields(
        { name: "Your Item", value: `${itemLabel}\n${yourLabel}` },
        { name: "Their Location", value: `${locationName}\n${otherLabel}` },
      );
    } else {
      embed.addFields(
        { name: "Your Location", value: `${locationName}\n${yourLabel}` },
        { name: "Their Item", value: `${itemLabel}\n${otherLabel}` },
      );
    }

    try {
      await p.member.send({ embeds: [embed] });
    } catch (err) {
      console.warn(`[hint-dm] Failed to DM ${p.member.id}:`, err.message);
    }
  }
}

// Establishes the itemCounts/hintKeys baselines from the AP webhost's *current* state. Called
// right when a channel is linked so the baseline reflects that moment, not whatever the tracker
// looked like the first time someone happened to have DMs enabled during an auto-refresh tick,
// otherwise anything received/hinted in between is silently treated as pre-existing and never
// DMed. Returns null (and logs) on any fetch failure. Link/relink still succeeds, it just leaves
// the baselines to be established lazily on the next tick as before.
async function computeDmBaselines(data) {
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

  const itemCounts = {};
  for (const entry of trackerData.player_items_received ?? []) {
    itemCounts[entry.player] = (entry.items ?? []).length;
  }

  const hintKeys = {};
  for (const entry of trackerData.hints ?? []) {
    hintKeys[entry.player] = (entry.hints ?? []).map(hintKeyOf);
  }

  return { itemCounts, hintKeys };
}

// checkNewDms bails out before touching itemCounts/hintKeys whenever dmSlotSettings is empty (see
// its guard), so the baselines sit frozen at whatever they were at link time for as long as
// nobody on this link has ever opted into any DM kind. Call this right before a dmSlotSettings
// write takes effect. If it's the link's first-ever opt-in, the frozen baselines would otherwise
// misreport everything received/hinted since link time as new on the very next tick, flooding
// that user. Re-baseline to "now" instead, same as the link-time baseline.
async function rebaselineDmBaselinesIfFirstOptIn(l, data) {
  const hadAnyDmSettings = !!l.dmSlotSettings && Object.keys(l.dmSlotSettings).length > 0;
  if (hadAnyDmSettings) return;
  const baselines = await computeDmBaselines(data);
  if (baselines) {
    l.itemCounts = baselines.itemCounts;
    l.hintKeys   = baselines.hintKeys;
  }
}

// `pathSegment` is "tracker" or "collection_room"; both use the same URL-safe base64 ID format.
function parseCtId(input, pathSegment, label) {
  const trimmed = input.trim();
  let url;
  try { url = new URL(trimmed); } catch { url = null; }

  if (!url) {
    // Not a URL: treat as a bare ID
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error(`That doesn't look like a ${label} URL or ID.`);
    return trimmed;
  }

  if (url.hostname !== CT_HOST) throw new Error(`That URL isn't from ${CT_HOST}.`);
  const match = url.pathname.match(new RegExp(`/${pathSegment}/([A-Za-z0-9_-]+)`));
  if (!match) throw new Error(`That URL doesn't contain a ${label} ID.`);
  return match[1];
}

function parseTrackerId(input) {
  return parseCtId(input, "tracker", "tracker");
}

function parseCollectionRoomId(input) {
  return parseCtId(input, "collection_room", "collection room");
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

// Guild member cache: one fetch per guild per 5 min to avoid gateway opcode 8 rate limits.
// memberFetchInFlight dedupes concurrent callers (checkNewDms and buildStatusPages both call
// this within the same auto-refresh tick) onto a single in-flight request instead of each
// firing its own guild.members.fetch(). Failures are cached too (falling back to the Discord
// client cache), otherwise a stretch of gateway timeouts/rate limits would retry a fresh
// fetch(), and its opcode 8 request/listener, on every single call forever instead of backing
// off for the TTL like a success does.
const memberCacheMap = new Map();
const memberFetchInFlight = new Map();
const MEMBER_CACHE_TTL = 5 * 60 * 1000;

async function fetchGuildMembers(guild) {
  const cached = memberCacheMap.get(guild.id);
  if (cached && Date.now() - cached.fetchedAt < MEMBER_CACHE_TTL) return cached.members;

  const inFlight = memberFetchInFlight.get(guild.id);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const members = await guild.members.fetch();
      memberCacheMap.set(guild.id, { members, fetchedAt: Date.now() });
      return members;
    } catch (err) {
      console.warn("[fetchGuildMembers] failed, using Discord cache:", err.message);
      memberCacheMap.set(guild.id, { members: guild.members.cache, fetchedAt: Date.now() });
      return guild.members.cache;
    } finally {
      memberFetchInFlight.delete(guild.id);
    }
  })();
  memberFetchInFlight.set(guild.id, promise);
  return promise;
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

// Resolves a game's claimed Discord owner the same way everywhere in checkNewDms. A game with
// no claimed owner (or one not resolvable in this guild) yields null.
function resolveOwnerMember(memberByUsername, game) {
  const username = game?.effective_discord_username?.toLowerCase();
  return username ? memberByUsername.get(username) : null;
}

// A dmSlotSettings value for one kind (progression/useful): "all" every owned slot including
// future ones, an array of specific AP player positions, or undefined/missing (off).
function isSlotSelected(setting, position) {
  return setting === "all" || (Array.isArray(setting) && setting.includes(position));
}

// Games in this tracker owned by `userId`, matched the same way checkNewDms resolves a slot's
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

// Shown when a menu opened before an Unlink is used afterwards. Replaces the menu (with a Back
// button to the now-unlinked main menu) rather than leaving it on screen with stale buttons.
const NOT_LINKED_MESSAGE = "❌ This channel isn't linked to a tracker anymore.";

function notLinkedUpdate(interaction) {
  return interaction.update({ content: NOT_LINKED_MESSAGE, embeds: [], components: [backToMenuRow()] });
}

// `ownedPositions`, when given, cross-references the stored setting against games the user
// currently owns. A stored array can otherwise still list positions from games unclaimed since
// (links.json never prunes those on its own), which would overcount. Omitted at call sites that
// don't have fresh tracker data on hand; those fall back to the raw (possibly stale) length.
function dmSettingSummary(setting, ownedPositions = null) {
  if (setting === "all") return "✅ **On** (all games)";
  if (!Array.isArray(setting) || !setting.length) return "❌ **Off**";
  const count = ownedPositions ? setting.filter(p => ownedPositions.includes(p)).length : setting.length;
  if (!count) return "❌ **Off**";
  return `✅ **On** (${count} game${count === 1 ? "" : "s"})`;
}

// `collectionRoomId` is only passed (and only matters) while no tracker is linked.
function buildMenuEmbed(link, userId, isManager, ownedPositions = null, collectionRoomId = null) {
  const e = new EmbedBuilder().setColor(EMBED_COLOR).setTitle("Archeesepelago Menu");
  if (!link && collectionRoomId) {
    const lines = [`**[Collection Room](${collectionRoomUrl(collectionRoomId)})**`, "Tracker: ❌ **Not Linked Yet**"];
    if (isManager) lines.push("", "Once the game is generated, use **Admin Actions → Link Tracker** to replace the collection room.");
    e.setDescription(lines.join("\n"));
    return e;
  }
  if (!link) {
    e.setDescription(
      isManager
        ? "This channel isn't linked to a tracker yet.\nUse **Admin Actions** below to link a tracker or a collection room."
        : "This channel isn't linked to a tracker yet.\nAsk a server admin to link one."
    );
    return e;
  }

  const isRegisteredMode = (link.mode ?? "all") === "registered";
  const modeLabel = isRegisteredMode ? "**Registered Only**" : "**Show All**";

  const lines = [`**[Tracker Room](${trackerUrl(link.trackerId)})**`, `View Mode: ${modeLabel}`];
  if (isRegisteredMode) {
    const isRegistered = (link.registeredUsers ?? []).includes(userId);
    lines.push(isRegistered ? "You Are: ✅ **Registered**" : "You Are: ❌ **Not Registered**");
  }

  const dmSetting = link.dmSlotSettings?.[userId];
  lines.push(`Progression Item DMs: ${dmSettingSummary(dmSetting?.progression, ownedPositions)}`);
  lines.push(`Progression Hints: ${dmSetting?.hintProgression ? "✅ **On** (all games)" : "❌ **Off**"}`);
  lines.push(`Useful Item DMs: ${dmSettingSummary(dmSetting?.useful, ownedPositions)}`);
  lines.push(`Useful Hints: ${dmSetting?.hintUseful ? "✅ **On** (all games)" : "❌ **Off**"}`);

  e.setDescription(lines.join("\n"));
  return e;
}

// One row instead of one-button-per-row. Discord allows up to 5 buttons per action row, and
// this menu never has more than 4 (Status, Register/Unregister, DM Notifications, Admin Actions),
// so they all fit side by side. Chunked defensively in case a future button pushes past 5.
function buildMainMenuRows(interaction, link, collectionRoomId = null) {
  const buttons = [
    new ButtonBuilder().setCustomId("menu:status").setLabel("Status").setStyle(ButtonStyle.Success).setDisabled(!link && !collectionRoomId),
  ];

  if (link && (link.mode ?? "all") === "registered") {
    const isRegistered = (link.registeredUsers ?? []).includes(interaction.user.id);
    buttons.push(
      isRegistered
        ? new ButtonBuilder().setCustomId("menu:unregister").setLabel("Unregister").setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId("menu:register").setLabel("Register").setStyle(ButtonStyle.Success)
    );
  }

  if (link) {
    buttons.push(
      new ButtonBuilder().setCustomId("menu:dm").setLabel("DM Notifications").setStyle(ButtonStyle.Primary)
    );
  }

  if (hasManageChannels(interaction)) {
    buttons.push(
      new ButtonBuilder().setCustomId("menu:admin").setLabel("Admin Actions").setStyle(ButtonStyle.Primary)
    );
  }

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
  }
  return rows;
}

const DM_SLOTS_PER_PAGE = 25; // Discord's per-select option cap

// The two opt-in item-DM kinds, and the order they're tabbed through in the menu. Hint DMs are
// no longer their own tab/kind, since each tab now carries its own "Enable/Disable {kind} Hints"
// toggle instead (see buildDmSlotRows), stored as hintProgression/hintUseful.
const DM_KINDS = ["progression", "useful"];
const DM_KIND_LABELS = { progression: "Progression", useful: "Useful" };
const HINT_FLAG_KEY = { progression: "hintProgression", useful: "hintUseful" };

// Only one kind's picker (select + controls) is ever shown at a time, since a message caps out at 5
// action rows, and both kinds' worth of select+controls (2 rows each) plus a tab row and a back
// button would need 6. Each kind still keeps its own page position across tab switches, so the
// customId threads both page numbers through regardless of which kind is currently active.
function encodeDmPages(pages) {
  return DM_KINDS.map(k => pages[k] ?? 0).join(":");
}

function decodeDmPages(parts) {
  const pages = {};
  DM_KINDS.forEach((k, i) => { pages[k] = parseInt(parts[i], 10) || 0; });
  return pages;
}

function buildDmTabRow(activeKind, pages) {
  const encoded = encodeDmPages(pages);
  return new ActionRowBuilder().addComponents(
    ...DM_KINDS.map(k =>
      new ButtonBuilder()
        .setCustomId(`menu:dmtab:${k}:${encoded}`)
        .setLabel(DM_KIND_LABELS[k])
        .setStyle(k === activeKind ? ButtonStyle.Primary : ButtonStyle.Secondary)
    )
  );
}

// "Enable/Disable All" is a dedicated button, not a select option. Mixing it into the select
// meant unchecking it while individual games still showed checked (inherited from "all") got
// silently overridden back to "all". A separate button has no such ambiguity: it's either "all"
// (select disabled, so nothing to conflict with) or a plain per-game pick list.
//
// The select never marks options as default/selected, because Discord renders a closed multi-select's
// default-selected options as inline chips in place of the placeholder, which is exactly the
// "every game listed one by one" clutter this avoids. Instead the placeholder itself carries a
// live count, and each option's description (not its checked state) shows current on/off, so
// picking an option here toggles that one game rather than replacing the page's whole selection.
function buildDmSlotRows(kind, ownedGames, dmSetting, pages) {
  const setting     = dmSetting[kind];
  const isAll       = setting === "all";
  const totalPages  = Math.max(1, Math.ceil(ownedGames.length / DM_SLOTS_PER_PAGE));
  const clampedPage = Math.max(0, Math.min(pages[kind] ?? 0, totalPages - 1));
  const pageGames   = ownedGames.slice(clampedPage * DM_SLOTS_PER_PAGE, (clampedPage + 1) * DM_SLOTS_PER_PAGE);
  const label       = DM_KIND_LABELS[kind];
  const pageSuffix  = totalPages > 1 ? `, page ${clampedPage + 1}/${totalPages}` : "";
  // Counts only positions still among ownedGames. A stored array can otherwise still list a
  // position from a game unclaimed since (nothing prunes links.json on unclaim), overcounting.
  const ownedPositions = ownedGames.map(g => g.position);
  const onCount        = Array.isArray(setting) ? setting.filter(p => ownedPositions.includes(p)).length : 0;
  const placeholder = isAll
    ? `All ${label} enabled`
    : `${onCount === 0 ? "❌" : "✅"} ${onCount} of ${ownedGames.length} ${label} enabled${pageSuffix}`;

  const encoded = encodeDmPages({ ...pages, [kind]: clampedPage });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`menu:dmslot:${kind}:${encoded}`)
    .setPlaceholder(placeholder)
    .setDisabled(isAll)
    .setMinValues(0)
    .setMaxValues(pageGames.length)
    .addOptions(
      pageGames.map(g =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`${g.game} (${g.name})`.slice(0, 100))
          .setDescription(isSlotSelected(setting, g.position) ? "✅ On. Pick to turn it off." : "❌ Off. Pick to turn it on.")
          .setValue(String(g.position))
      )
    );

  // Hint DMs for this kind (see HINT_FLAG_KEY) are a single on/off toggle applying to every game
  // the user owns, not the per-game picker above, since a hint can be about a game the user hasn't
  // selected for item DMs at all, and hints affect other players so they shouldn't be silently
  // scoped down to a subset of games.
  const hintOn = Boolean(dmSetting[HINT_FLAG_KEY[kind]]);
  const controls = [
    isAll
      ? new ButtonBuilder().setCustomId(`menu:dmslotall:${kind}:off:${encoded}`).setLabel(`Disable All ${label}`).setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`menu:dmslotall:${kind}:on:${encoded}`).setLabel(`Enable All ${label}`).setStyle(ButtonStyle.Success),
    hintOn
      ? new ButtonBuilder().setCustomId(`menu:dmhint:${kind}:off:${encoded}`).setLabel(`Disable ${label} Hints`).setStyle(ButtonStyle.Danger)
      : new ButtonBuilder().setCustomId(`menu:dmhint:${kind}:on:${encoded}`).setLabel(`Enable ${label} Hints`).setStyle(ButtonStyle.Success),
  ];
  if (totalPages > 1) {
    controls.push(
      new ButtonBuilder().setCustomId(`menu:dmslotpage:${kind}:p:${encoded}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(clampedPage <= 0),
      new ButtonBuilder().setCustomId(`menu:dmslotpage:${kind}:n:${encoded}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(clampedPage >= totalPages - 1),
    );
  }

  return [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(...controls),
  ];
}

// Takes ownedGames rather than fetching it, so callers can reuse the same fetch for the embed's
// accurate DM-count lines (see dmSettingSummary) instead of resolving guild membership twice.
// `activeKind` picks which of the 2 kinds' picker is currently shown (see buildDmSlotRows).
// `pages` pins each kind's own page (e.g. { progression: 1, useful: 0 }) so switching tabs or
// paging one kind doesn't bounce the other back to page 0 when the menu re-renders.
function buildDmMenuRows(link, userId, ownedGames, activeKind = "progression", pages = {}) {
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
    buildDmTabRow(activeKind, pages),
    ...buildDmSlotRows(activeKind, ownedGames, settings, pages),
    backToMenuRow(),
  ];
  return rows;
}

// The collection room button is disabled once a tracker is linked, since the tracker replaces it.
// Register Someone is hidden outside Registered Only, like Register/Unregister in the main menu,
// since the registered list only matters in that mode.
function buildAdminMenuRows(link, collectionRoomId = null) {
  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:link").setLabel(link ? "Update Tracker" : "Link Tracker").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("menu:admin:collection").setLabel(collectionRoomId ? "Update Collection Room" : "Link Collection Room").setStyle(ButtonStyle.Success).setDisabled(Boolean(link)),
      new ButtonBuilder().setCustomId("menu:admin:unlink").setLabel("Unlink Channel").setStyle(ButtonStyle.Danger).setDisabled(!link && !collectionRoomId),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:viewmode:all").setLabel("View Mode: Show All").setStyle(ButtonStyle.Primary).setDisabled(!link || (link.mode ?? "all") === "all"),
      new ButtonBuilder().setCustomId("menu:admin:viewmode:registered").setLabel("View Mode: Registered Only").setStyle(ButtonStyle.Primary).setDisabled(!link || link.mode === "registered"),
    ),
  ];
  if (link?.mode === "registered") {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin:registeruser").setLabel("Register Someone").setStyle(ButtonStyle.Primary)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("menu:back").setLabel("◀ Back").setStyle(ButtonStyle.Secondary)
  ));
  return rows;
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
// A posted status (tracker pages or a collection room embed) re-renders itself every
// REFRESH_INTERVAL_MS. A channel has at most one live post, since linking a tracker replaces the
// collection room, so both kinds share one session per channel in activeRefreshes.

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const STALE_LINK_MS       = 30 * 24 * 60 * 60 * 1000;

// Footer notes on a post that has stopped updating.
const SUPERSEDED_NOTE = "⊘ Superseded by a newer post";
const REPLACED_NOTE   = "⊘ Replaced by this channel's tracker";
const STOPPED_NOTE    = "⊘ No longer updating";

// Map<channelId, session>. Both kinds have { kind, messages, guild, lastHash, lastActivityAt,
// intervalId }; "tracker" adds { trackerId, mode, registeredUserIds } and "collection" adds { roomId }.
const activeRefreshes = new Map();

// First footer line of a live post. Server-local time, since footers can't render Discord's
// viewer-local <t:...> timestamps.
function liveFooterLine() {
  const nowStr = new Date().toString().replace(/GMT[+-]\d{4} \((.+?)\)/, (_, tz) =>
    tz.includes(" ") ? tz.split(" ").map(w => w[0]).join("") : tz
  );
  return `⟳ Updates every 5 minutes. Last updated ${nowStr}.`;
}

// Swaps a post's live footer line for `note`, keeping the rest of each embed as last rendered.
// Cheaper than rebuilding the pages, and the old post should keep showing its old snapshot anyway.
async function markPostStopped(messages, note) {
  for (const msg of messages) {
    const embed = msg.embeds[0];
    if (!embed) continue;
    const rest = (embed.footer?.text ?? "").split("\n").filter(l => !l.startsWith("⟳") && !l.startsWith("⊘"));
    try { await msg.edit({ embeds: [EmbedBuilder.from(embed).setFooter({ text: [note, ...rest].join("\n") })], components: [] }); }
    catch { /* message gone */ }
  }
}

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

function hashCollectionRoom({ room, slots }) {
  return JSON.stringify({
    title:     room.title,
    notes:     room.notes,
    closes_at: room.closes_at,
    is_closed: room.is_closed,
    slots:     slots.map(s => [s.id, s.changed_at]),
  });
}

function stopAutoRefresh(channelId) {
  const session = activeRefreshes.get(channelId);
  if (!session) return;
  clearInterval(session.intervalId);
  activeRefreshes.delete(channelId);
}

// Stops the channel's live post (if any) and footnotes it with `note` so it doesn't keep claiming
// to update every 5 minutes.
async function retireLivePost(channelId, note) {
  const session = activeRefreshes.get(channelId);
  stopAutoRefresh(channelId);
  if (session) await markPostStopped(session.messages, note);
}

async function deleteLinkEntry(guildId, channelId) {
  const key = linkKey(guildId, channelId);
  await withLinks(links => {
    delete links[key];
  });
}

// Logs a failed refresh tick. Transient API/network errors only surface once they persist (see
// noteFailure), anything else is a bug worth a stack trace every time.
function logRefreshError(key, err) {
  if (isTransientError(err)) noteFailure("auto-refresh", key, err);
  else console.error("[auto-refresh]", err);
}

// messages is an array of Discord Message objects (one per posted page). initialData is the
// tracker data the caller already fetched to build/refresh those pages. It's reused here to run
// the first DM check immediately instead of waiting up to REFRESH_INTERVAL_MS for the first tick.
// It's null when resuming during a CheeseTrackers outage, and the first tick then catches up.
function startAutoRefresh(messages, trackerId, guild, initialData, initialLastActivityAt = Date.now(), mode = "all", registeredUserIds = []) {
  const channelId = messages[0].channelId;
  const key       = linkKey(guild.id, channelId);
  stopAutoRefresh(channelId);

  const session = {
    kind:              "tracker",
    messages,
    trackerId,
    guild,
    lastHash:          initialData ? hashTrackerData(initialData) : null,
    lastActivityAt:    initialLastActivityAt,
    mode,
    registeredUserIds: [...registeredUserIds],
    intervalId:        null,
  };

  if (initialData) checkNewDms(initialData, guild, key).catch(err => console.error("[item-dm] Unexpected failure:", err));

  session.intervalId = setInterval(async () => {
    try {
      const data    = await fetchTracker(trackerId);
      const newHash = hashTrackerData(data);
      const now     = Date.now();

      if (newHash !== session.lastHash) {
        session.lastHash       = newHash;
        session.lastActivityAt = now;
        await withLinks(links => {
          const link = trackerLinkOf(links, key);
          if (link) link.lastActivityAt = now;
        });
      }

      // Fetches its own data and persists itemCounts internally (via withLinks), so
      // this tick never has to hold a stale in-memory links snapshot across these awaits.
      await checkNewDms(data, guild, key);

      // No idle timeout. The loop (and item DMs with it) keeps running for as long as the
      // link exists, so opting into DMs doesn't silently stop working after an hour of quiet.
      // The only teardown is the 30-day stale-link sweep, and it leaves the last-posted embed
      // exactly as it was rather than editing it to a "stopped" state.
      const lastSeen = Math.max(trackerLinkOf(loadLinks(), key)?.linkedAt ?? 0, session.lastActivityAt);
      if (now - lastSeen > STALE_LINK_MS) {
        stopAutoRefresh(channelId);
        await deleteLinkEntry(guild.id, channelId);
        return;
      }

      // Edited every tick even when nothing changed, since the footer promises "Updates every 5
      // minutes", so Last updated has to reflect that a check actually happened.
      const pages = await buildStatusPages(trackerId, data, guild, true, session.mode, session.registeredUserIds);
      await editPages(session.messages, pages);
      noteSuccess("auto-refresh", key);
    } catch (err) {
      logRefreshError(key, err);
    }
  }, REFRESH_INTERVAL_MS);

  activeRefreshes.set(channelId, session);
}

// Collection room counterpart of startAutoRefresh. `initial` is the { room, slots } the caller
// just rendered the post from, or null when resuming during an outage.
function startCollectionAutoRefresh(message, roomId, guild, initial, initialLastActivityAt = Date.now()) {
  const channelId = message.channelId;
  const key       = linkKey(guild.id, channelId);
  stopAutoRefresh(channelId);

  const session = {
    kind:           "collection",
    messages:       [message],
    roomId,
    guild,
    lastHash:       initial ? hashCollectionRoom(initial) : null,
    lastActivityAt: initialLastActivityAt,
    intervalId:     null,
  };

  session.intervalId = setInterval(async () => {
    try {
      const current = await fetchCollectionRoom(roomId);
      const newHash = hashCollectionRoom(current);
      const now     = Date.now();

      if (newHash !== session.lastHash) {
        session.lastHash       = newHash;
        session.lastActivityAt = now;
        await withLinks(links => {
          const room = collectionRoomOf(links, key);
          if (room) room.lastActivityAt = now;
        });
      }

      // Same 30-day stale sweep as tracker links.
      const lastSeen = Math.max(collectionRoomOf(loadLinks(), key)?.linkedAt ?? 0, session.lastActivityAt);
      if (now - lastSeen > STALE_LINK_MS) {
        stopAutoRefresh(channelId);
        await deleteCollectionEntry(guild.id, channelId);
        return;
      }

      await editPages(session.messages, [buildCollectionRoomEmbed(roomId, current, true)]);
      noteSuccess("auto-refresh", key);
    } catch (err) {
      logRefreshError(key, err);
    }
  }, REFRESH_INTERVAL_MS);

  activeRefreshes.set(channelId, session);
}

// Edits each posted message to its matching page. Stops at whichever list runs out first.
async function editPages(messages, pages) {
  for (let i = 0; i < Math.min(messages.length, pages.length); i++) {
    try { await messages[i].edit({ embeds: [pages[i]], components: [] }); }
    catch { /* message gone */ }
  }
}

// ─── Status embeds ────────────────────────────────────────────────────────────

// `live` adds the "Updates every 5 minutes" footer line, for posted status (not the preview).
async function buildStatusPages(trackerId, data, guild, live = false, mode = "all", registeredUserIds = []) {
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

  // Build one block per owner group, with Unclaimed always last.
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
      const safeName = (g.name ?? "").replace(/`/g, "ˋ") || "Unknown";
      const safeGame = (g.game ?? "").replace(/[`*]/g, (c) => c === "*" ? "\\*" : "ˋ") || "Unknown";
      blockLines.push(
        `  - ${prog}${comp} \`${safeName}\` · **${safeGame}** · ${g.checks_done}/${g.checks_total} (${pct}%)`
      );
    }
    blocks.push(blockLines.join("\n"));
  }

  if (mode === "registered" && blocks.length === 0) {
    blocks.push("*No one is registered yet.*\nUse `/menu` → **Register** to add your games to this view.");
  }

  const serverLine = (room_host && last_port) ? `\`\`\`\n${room_host}:${last_port}\n\`\`\`\n` : "";

  // Pack blocks into ≤3200-char chunks (measured by JS .length); first chunk reserves space
  // for serverLine header. Player-owned blocks are kept whole where possible.
  // Blocks too large for any single embed (e.g. 100+ Unclaimed games) are split by line.
  // NOTE: Discord counts Unicode code points and JS counts UTF-16 code units, so surrogate-pair
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
      // Fits in the current chunk: append
      chunk = chunk ? chunk + sep + block : block;
    } else if (chunk && block.length <= LIMIT) {
      // Fits standalone: flush the current chunk and start fresh with this block
      chunks.push(chunk);
      chunk = block;
    } else {
      // Block exceeds LIMIT (or chunk is empty but budget is constrained): split by line.
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
  const liveLine    = live ? liveFooterLine() : null;

  return chunks.map((desc, i) => {
    const e = new EmbedBuilder().setColor(EMBED_COLOR);

    if (i === 0) {
      e.setTitle(title || "Tracker Status")
       .setURL(trackerUrl(trackerId))
       .setDescription(serverLine + desc);
    } else {
      e.setDescription(desc);
    }

    const pageLabel = `Page ${i + 1}/${totalPages}`;
    const bottom    = i < totalPages - 1 ? pageLabel
                    : totalPages > 1     ? `${footerTotal} · ${pageLabel}`
                    :                      footerTotal;
    return e.setFooter({ text: liveLine ? `${liveLine}\n${bottom}` : bottom });
  });
}

// A room counts as closed once its owner closes it or its optional deadline passes (same rule as
// the CheeseTrackers collection room page). Like a tracker status page, the room title links to
// CheeseTrackers and a posted copy carries the same "Updates every 5 minutes" footer.
function buildCollectionRoomEmbed(roomId, { room, slots }, live = false) {
  const closesAtMs = room.closes_at ? Date.parse(room.closes_at) : null;
  const isClosed   = room.is_closed || (closesAtMs !== null && closesAtMs <= Date.now());

  let statusLine;
  if (isClosed)        statusLine = "🔒 Closed";
  else if (closesAtMs) statusLine = `🟢 Open, closes <t:${Math.floor(closesAtMs / 1000)}:R>`;
  else                 statusLine = "🟢 Open";

  const playerCount = new Set(slots.map(s => s.owner_discord_username)).size;
  const submissions = `${slots.length} slot${slots.length === 1 ? "" : "s"} from ${playerCount} player${playerCount === 1 ? "" : "s"}`;

  // Submissions isn't inline, so it gets its own row under Host and Status.
  const e = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(room.title.slice(0, 256) || "Collection Room")
    .setURL(collectionRoomUrl(roomId))
    .addFields(
      { name: "Host",        value: room.owner_discord_username || "Unknown", inline: true },
      { name: "Status",      value: statusLine,                               inline: true },
      { name: "Submissions", value: submissions },
    );
  if (live) e.setFooter({ text: liveFooterLine() });

  const notes = room.notes?.trim();
  if (notes) e.setDescription(notes.length > 1000 ? `${notes.slice(0, 1000)}…` : notes);
  return e;
}

// Throws on a fetch failure or an unexpected response, like ctGet.
async function fetchCollectionRoom(roomId) {
  const [room, slots] = await Promise.all([
    ctGet(`/collection_room/${roomId}`),
    ctGet(`/collection_room/${roomId}/slot`),
  ]);
  if (typeof room?.title !== "string" || !Array.isArray(slots)) {
    throw new ApiError("Unexpected response from CheeseTrackers. The collection room may be unavailable.");
  }
  return { room, slots };
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
  const link             = trackerLinkOf(loadLinks(), linkKey(interaction.guildId, interaction.channelId));
  const collectionRoomId = collectionRoomIdFor(interaction);

  await interaction.reply({
    embeds: [buildMenuEmbed(link, interaction.user.id, hasManageChannels(interaction), null, collectionRoomId)],
    components: buildMainMenuRows(interaction, link, collectionRoomId),
    flags: MessageFlags.Ephemeral,
  });
}

// Replaces the menu with an error and a Back button, for a status view that couldn't load. Used
// instead of an ephemeral follow-up so the menu isn't left stuck on "Loading...".
function statusErrorReply(interaction, content) {
  return interaction.editReply({ content, embeds: [], components: [backToMenuRow()] });
}

function postButtonRow(customId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel("Post to channel").setStyle(ButtonStyle.Primary)
  );
}

// Stops the channel's refresh loop and marks its previous post (by stored message IDs, so this
// also works for a post that wasn't resumed after a restart) as superseded.
async function supersedeOldPost(channel, messageIds = []) {
  stopAutoRefresh(channel.id);
  const old = [];
  for (const id of messageIds) {
    try { old.push(await channel.messages.fetch(id)); }
    catch { /* message gone */ }
  }
  await markPostStopped(old, SUPERSEDED_NOTE);
}

async function handleCollectionStatus(interaction, roomId) {
  await interaction.deferUpdate();
  await interaction.editReply({ content: "Loading collection room...", embeds: [], components: [] });

  let current;
  try {
    current = await fetchCollectionRoom(roomId);
  } catch (err) {
    console.error("[menu:status] Collection room fetch failed:", err.message);
    return statusErrorReply(interaction, `❌ Failed to fetch collection room data: ${err.message}`);
  }

  await interaction.editReply({
    content: null,
    embeds: [buildCollectionRoomEmbed(roomId, current)],
    components: [postButtonRow(`postcr:${roomId}`), backToMenuRow()],
  });
}

async function handleCollectionPostButton(interaction) {
  const roomId = interaction.customId.slice("postcr:".length);
  const key    = linkKey(interaction.guildId, interaction.channelId);
  const room   = collectionRoomOf(loadLinks(), key);

  await interaction.deferUpdate();

  // The preview may be older than an Update/Unlink or a tracker link made since.
  if (room?.roomId !== roomId) {
    return statusErrorReply(interaction, "❌ This channel's link changed since this preview was opened. Go back and open **Status** again.");
  }

  let current;
  try {
    current = await fetchCollectionRoom(roomId);
  } catch (err) {
    return statusErrorReply(interaction, `❌ Failed to fetch collection room data: ${err.message}`);
  }

  await supersedeOldPost(interaction.channel, room.messageId ? [room.messageId] : []);

  const message = await interaction.channel.send({ embeds: [buildCollectionRoomEmbed(roomId, current, true)] });
  const now     = Date.now();
  startCollectionAutoRefresh(message, roomId, interaction.guild, current, now);

  await withLinks(links => {
    const r = collectionRoomOf(links, key);
    if (r) {
      r.messageId      = message.id;
      r.lastActivityAt = now;
    }
  });

  await interaction.editReply({ content: "✅ Posted!", embeds: [], components: [backToMenuRow()] });
}

// Status is disabled in the menu while nothing is linked, so the "not linked" branch only runs
// for a menu opened before an unlink.
async function handleMenuStatus(interaction, link, collectionRoomId = null) {
  if (!link && collectionRoomId) return handleCollectionStatus(interaction, collectionRoomId);
  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();
  await interaction.editReply({ content: "Loading tracker...", embeds: [], components: [] });

  let data;
  try {
    data = await fetchTracker(link.trackerId);
  } catch (err) {
    console.error("[menu:status] Tracker fetch failed:", err.message);
    return statusErrorReply(interaction, `❌ Failed to fetch tracker data: ${err.message}`);
  }

  const pages  = await buildStatusPages(link.trackerId, data, interaction.guild, false, link.mode ?? "all", link.registeredUsers ?? []);
  const navRow = buildStatusNavRow(link.trackerId, 0, pages.length);

  await interaction.editReply({ content: null, embeds: [pages[0]], components: [navRow, backToMenuRow()] });
}

async function handlePageButton(interaction) {
  const [, dir, trackerId, pageStr] = interaction.customId.split(":");
  const fromPage = parseInt(pageStr, 10);

  await interaction.deferUpdate();

  let data;
  try {
    data = await fetchTracker(trackerId);
  } catch (err) {
    return statusErrorReply(interaction, `❌ Failed to fetch tracker data: ${err.message}`);
  }

  const link  = trackerLinkOf(loadLinks(), linkKey(interaction.guildId, interaction.channelId));
  const pages = await buildStatusPages(trackerId, data, interaction.guild, false, link?.mode ?? "all", link?.registeredUsers ?? []);
  const page  = Math.max(0, Math.min(dir === "n" ? fromPage + 1 : fromPage - 1, pages.length - 1));
  const row   = buildStatusNavRow(trackerId, page, pages.length);

  await interaction.editReply({ embeds: [pages[page]], components: [row, backToMenuRow()] });
}

async function handlePostButton(interaction) {
  const trackerId = interaction.customId.slice("post:".length);
  const key       = linkKey(interaction.guildId, interaction.channelId);
  const link      = trackerLinkOf(loadLinks(), key);

  await interaction.deferUpdate();

  // The preview may be older than an Update/Unlink made since.
  if (link?.trackerId !== trackerId) {
    return statusErrorReply(interaction, "❌ This channel's link changed since this preview was opened. Go back and open **Status** again.");
  }

  const mode            = link.mode ?? "all";
  const registeredUsers = link.registeredUsers ?? [];

  let data, pages;
  try {
    data  = await fetchTracker(trackerId);
    pages = await buildStatusPages(trackerId, data, interaction.guild, true, mode, registeredUsers);
  } catch (err) {
    return statusErrorReply(interaction, `❌ Failed to fetch tracker data: ${err.message}`);
  }

  await supersedeOldPost(interaction.channel, link.messageIds);

  // Every page is posted as its own message, so no nav buttons are needed.
  const messages = [];
  for (const page of pages) {
    messages.push(await interaction.channel.send({ embeds: [page] }));
  }
  const now = Date.now();
  startAutoRefresh(messages, trackerId, interaction.guild, data, now, mode, registeredUsers);

  const messageIds = messages.map(m => m.id);
  await withLinks(links => {
    const l = trackerLinkOf(links, key);
    if (l) {
      l.messageIds     = messageIds;
      l.lastActivityAt = now;
    }
  });

  await interaction.editReply({ content: "✅ Posted!", embeds: [], components: [backToMenuRow()] });
}

// Shared by self-register, self-unregister, and admin register-someone.
async function refreshRegisteredView(interaction, link) {
  const session = activeRefreshes.get(interaction.channelId);
  if (session?.kind !== "tracker" || (link.mode ?? "all") !== "registered") return;

  session.registeredUserIds = [...(link.registeredUsers ?? [])];
  try {
    const data  = await fetchTracker(link.trackerId);
    const pages = await buildStatusPages(link.trackerId, data, interaction.guild, true, "registered", session.registeredUserIds);
    await editPages(session.messages, pages);
  } catch (err) {
    console.warn("[refreshRegisteredView] Failed:", err.message);
  }
}

// Register (register = true) or Unregister yourself from the channel's registered view.
async function handleSelfRegistration(interaction, link, register) {
  if (!link) return notLinkedUpdate(interaction);

  const userId = interaction.user.id;
  const key    = linkKey(interaction.guildId, interaction.channelId);

  const { changed, freshLink } = await withLinks(links => {
    const l = trackerLinkOf(links, key);
    if (!l) return { changed: false, freshLink: null };
    l.registeredUsers ??= [];
    const isRegistered = l.registeredUsers.includes(userId);
    if (isRegistered === register) return { changed: false, freshLink: l };
    l.registeredUsers = register ? [...l.registeredUsers, userId] : l.registeredUsers.filter(id => id !== userId);
    return { changed: true, freshLink: l };
  });

  if (!freshLink) return notLinkedUpdate(interaction);
  if (!changed) {
    return interaction.reply({
      content: register ? "✅ You're already in this channel's registered view." : "❌ You're not in this channel's registered view.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Ack before refreshRegisteredView's tracker fetch and message edits, since those can run past
  // Discord's 3-second reply window ("This interaction failed").
  await interaction.deferUpdate();
  await refreshRegisteredView(interaction, freshLink);

  await interaction.editReply({
    embeds: [buildMenuEmbed(freshLink, userId, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, freshLink),
  });
  await interaction.followUp({
    content: register
      ? "✅ Registered. Your games now appear in this channel's registered view."
      : "✅ Unregistered. Your games no longer appear in this channel's registered view.",
    flags: MessageFlags.Ephemeral,
  });
}

// Every DM menu action ends up here: fetch the tracker, optionally apply `change` to the user's
// dmSlotSettings entry (under the links lock), then re-render the DM menu on `kind`'s tab.
// `loading` shows a placeholder first, for opening the menu (the other actions are quick edits
// of a menu that's already on screen).
async function renderDmMenu(interaction, { kind = "progression", pages = {}, change = null, loading = false } = {}) {
  const key    = linkKey(interaction.guildId, interaction.channelId);
  const userId = interaction.user.id;
  let link     = trackerLinkOf(loadLinks(), key);
  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();
  if (loading) await interaction.editReply({ content: "Loading DM settings...", embeds: [], components: [] });

  let data;
  try {
    data = await fetchTracker(link.trackerId);
  } catch (err) {
    return statusErrorReply(interaction, `❌ Failed to fetch tracker data: ${err.message}`);
  }

  if (change) {
    link = await withLinks(async links => {
      const l = trackerLinkOf(links, key);
      if (!l) return null;
      await rebaselineDmBaselinesIfFirstOptIn(l, data);
      l.dmSlotSettings ??= {};
      l.dmSlotSettings[userId] ??= {};
      change(l.dmSlotSettings[userId]);
      return l;
    });
    if (!link) return statusErrorReply(interaction, NOT_LINKED_MESSAGE);
  }

  const { ownedGames, ownedPositions } = await getOwnedGames(interaction.guild, data, userId);

  await interaction.editReply({
    content: null,
    embeds: [buildMenuEmbed(link, userId, hasManageChannels(interaction), ownedPositions)],
    components: buildDmMenuRows(link, userId, ownedGames, kind, pages),
  });
}

// customId: menu:dmtab:<kind>:<pages...>. A plain view change, no settings write.
async function handleDmTabSwitch(interaction) {
  const [, , kind, ...pageParts] = interaction.customId.split(":");
  return renderDmMenu(interaction, { kind, pages: decodeDmPages(pageParts) });
}

// customId: menu:dmslot:<kind>:<pages...>. Only reachable while the kind isn't "all" (the select
// is disabled otherwise). The select doesn't track checked state (see buildDmSlotRows), so each
// picked game flips on or off, and games not picked stay as they were, on any page.
async function handleDmSlotSelect(interaction) {
  const [, , kind, ...pageParts] = interaction.customId.split(":");
  const toggled = interaction.values.map(Number);
  return renderDmMenu(interaction, {
    kind,
    pages: decodeDmPages(pageParts),
    change: settings => {
      const selected = new Set(Array.isArray(settings[kind]) ? settings[kind] : []);
      for (const pos of toggled) {
        if (selected.has(pos)) selected.delete(pos);
        else selected.add(pos);
      }
      settings[kind] = [...selected];
    },
  });
}

// customId: menu:dmslotall:<kind>:<on|off>:<pages...>. Enable All / Disable All for one kind.
async function handleDmSlotAllToggle(interaction) {
  const [, , kind, action, ...pageParts] = interaction.customId.split(":");
  return renderDmMenu(interaction, {
    kind,
    pages: decodeDmPages(pageParts),
    change: settings => { settings[kind] = action === "on" ? "all" : []; },
  });
}

// customId: menu:dmhint:<kind>:<on|off>:<pages...>. A plain boolean (see HINT_FLAG_KEY) covering
// every game the user owns, unlike the per-game pickers, since hints affect other players and
// shouldn't be silently scoped to a subset of games.
async function handleDmHintToggle(interaction) {
  const [, , kind, action, ...pageParts] = interaction.customId.split(":");
  return renderDmMenu(interaction, {
    kind,
    pages: decodeDmPages(pageParts),
    change: settings => { settings[HINT_FLAG_KEY[kind]] = action === "on"; },
  });
}

// customId: menu:dmslotpage:<kind>:<p|n>:<pages...>
async function handleDmSlotPageButton(interaction) {
  const [, , kind, dir, ...pageParts] = interaction.customId.split(":");
  const pages = decodeDmPages(pageParts);
  pages[kind] += dir === "n" ? 1 : -1;
  return renderDmMenu(interaction, { kind, pages });
}

// Both Link Tracker and Link Collection Room ask for one URL or ID, in a field named "url".
async function showUrlModal(interaction, customId, title, label) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("url")
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

const MANAGE_CHANNELS_MESSAGE = "❌ You need **Manage Channels** permission.";

function countPlayers(data) {
  return new Set(data.games.map(g => g.effective_discord_username).filter(Boolean)).size;
}

function bigWorldWarning(playerCount) {
  return `⚠️ **Big world warning:** this room has **${playerCount}** players. **Show All** posts every player's games on every update, which can flood the channel, so **Registered Only** is recommended.`;
}

async function handleLinkModalSubmit(interaction) {
  const input = interaction.fields.getTextInputValue("url");

  let trackerId;
  try {
    trackerId = parseTrackerId(input);
  } catch (err) {
    return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  // The modal was opened from the Admin Menu button, so this submission can edit that same
  // (possibly ephemeral) message directly via deferUpdate/editReply, with no need to smuggle its
  // ID around and refetch it later, which doesn't work for ephemeral messages anyway.
  await interaction.deferUpdate();

  let data;
  try {
    data = await fetchTracker(trackerId);
  } catch (err) {
    return interaction.followUp({ content: `❌ Could not reach that tracker: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  const playerCount = countPlayers(data);
  const warning     = playerCount >= BIG_WORLD_PLAYERS ? `\n\n${bigWorldWarning(playerCount)}` : "";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`menu:admin:linkmode:all:${trackerId}`).setLabel("Show All").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`menu:admin:linkmode:registered:${trackerId}`).setLabel("Registered Only").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("menu:admin").setLabel("◀ Back").setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    content: `Found tracker \`${trackerId}\` with **${playerCount}** players.\nPick a view mode to finish linking:${warning}`,
    embeds: [],
    components: [row],
  });
}

async function handleCollectionModalSubmit(interaction) {
  const input = interaction.fields.getTextInputValue("url");

  let roomId;
  try {
    roomId = parseCollectionRoomId(input);
  } catch (err) {
    return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferUpdate();

  try {
    await fetchCollectionRoom(roomId);
  } catch (err) {
    return interaction.followUp({ content: `❌ Could not reach that collection room: ${err.message}`, flags: MessageFlags.Ephemeral });
  }

  // A tracker may have been linked from another menu while this modal was open, and it wins.
  // Checked inside the save too, since a tracker could still be linked while the old post retires.
  const key               = linkKey(interaction.guildId, interaction.channelId);
  const trackerLinkedNote = "❌ This channel already has a tracker linked, which replaces the collection room.";
  if (trackerLinkOf(loadLinks(), key)) {
    return interaction.followUp({ content: trackerLinkedNote, flags: MessageFlags.Ephemeral });
  }

  // Switching to a different room retires the old room's live post, like relinking a tracker.
  const previous = collectionRoomOf(loadLinks(), key);
  if (previous && previous.roomId !== roomId) await retireLivePost(interaction.channelId, STOPPED_NOTE);

  const saved = await withLinks(links => {
    if (trackerLinkOf(links, key)) return false;
    links[key] = { collectionRoom: previous?.roomId === roomId ? previous : { roomId, linkedAt: Date.now() } };
    return true;
  });
  if (!saved) return interaction.followUp({ content: trackerLinkedNote, flags: MessageFlags.Ephemeral });

  await interaction.editReply({
    embeds: [buildMenuEmbed(null, interaction.user.id, true, null, roomId)],
    components: buildAdminMenuRows(null, roomId),
  });
  await interaction.followUp({
    content: `✅ **#${interaction.channel.name}** is now ${previous ? "updated to" : "linked to"} [this collection room](${collectionRoomUrl(roomId)}).`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLinkModeButton(interaction, mode, trackerId) {
  const channel = interaction.channel;
  const key     = linkKey(interaction.guildId, channel.id);

  // The new link starts without messageIds, so whatever is live in this channel (the old
  // tracker's post, or the collection room's) stops updating now. Left running, an old tracker's
  // loop would also diff its items against the new tracker's DM baselines.
  const liveKind = activeRefreshes.get(channel.id)?.kind;
  await retireLivePost(channel.id, liveKind === "collection" ? REPLACED_NOTE : STOPPED_NOTE);

  // Overwriting the entry also drops any collection room, since the tracker takes over from it.
  const { isUpdate, freshLink } = await withLinks(links => {
    const existed = Boolean(trackerLinkOf(links, key));
    links[key]    = { trackerId, linkedAt: Date.now(), mode };
    return { isUpdate: existed, freshLink: links[key] };
  });

  await interaction.update({
    content: null,
    embeds: [buildMenuEmbed(freshLink, interaction.user.id, true)],
    components: buildAdminMenuRows(freshLink),
  });

  const modeLabel = mode === "all" ? "**Show All**" : "**Registered Only**";
  await interaction.followUp({
    content: `✅ **#${channel.name}** is now ${isUpdate ? "updated to" : "linked to"} [this tracker](${trackerUrl(trackerId)}) in ${modeLabel} mode.`,
    flags: MessageFlags.Ephemeral,
  });

  try {
    const data      = await fetchTracker(trackerId);
    const baselines = await computeDmBaselines(data);
    if (baselines) {
      await withLinks(links => {
        const l = trackerLinkOf(links, key);
        if (l) {
          l.itemCounts = baselines.itemCounts;
          l.hintKeys   = baselines.hintKeys;
        }
      });
    }
  } catch (err) {
    console.warn("[item-dm] Failed to establish DM baselines at link time:", err.message);
  }
}

async function handleUnlinkConfirm(interaction) {
  await retireLivePost(interaction.channelId, STOPPED_NOTE);
  await deleteLinkEntry(interaction.guildId, interaction.channelId);

  await interaction.update({
    embeds: [buildMenuEmbed(null, interaction.user.id, hasManageChannels(interaction))],
    components: buildMainMenuRows(interaction, null),
  });
}

async function handleAdminViewMode(interaction, link, mode) {
  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();

  const key       = linkKey(interaction.guildId, interaction.channelId);
  const freshLink = await withLinks(links => {
    const l = trackerLinkOf(links, key);
    if (l) l.mode = mode;
    return l;
  });
  if (!freshLink) return statusErrorReply(interaction, NOT_LINKED_MESSAGE);

  // One fetch serves both the live post refresh and the big world warning.
  let data = null;
  try {
    data = await fetchTracker(freshLink.trackerId);
  } catch (err) {
    console.warn("[menu:admin:viewmode] Tracker fetch failed:", err.message);
  }

  // Re-render the live post in the new mode right away. The page count can change, so extra
  // old pages are deleted and missing ones are posted.
  const session = activeRefreshes.get(interaction.channelId);
  if (data && session?.kind === "tracker") {
    session.mode = mode;
    try {
      const pages    = await buildStatusPages(freshLink.trackerId, data, interaction.guild, true, mode, session.registeredUserIds);
      const oldCount = session.messages.length;

      await editPages(session.messages, pages);
      for (const extra of session.messages.slice(pages.length)) {
        try { await extra.delete(); }
        catch { /* already gone */ }
      }
      session.messages = session.messages.slice(0, pages.length);
      for (const page of pages.slice(session.messages.length)) {
        session.messages.push(await interaction.channel.send({ embeds: [page] }));
      }

      if (pages.length !== oldCount) {
        const newMessageIds = session.messages.map(m => m.id);
        await withLinks(links => {
          const l = trackerLinkOf(links, key);
          if (l) l.messageIds = newMessageIds;
        });
      }
    } catch (err) {
      console.warn("[menu:admin:viewmode] Refresh failed:", err.message);
    }
  }

  await interaction.editReply({ embeds: [buildMenuEmbed(freshLink, interaction.user.id, true)], components: buildAdminMenuRows(freshLink) });

  if (mode === "all" && data) {
    const playerCount = countPlayers(data);
    if (playerCount >= BIG_WORLD_PLAYERS) {
      await interaction.followUp({ content: bigWorldWarning(playerCount), flags: MessageFlags.Ephemeral });
    }
  }
}

async function handleRegisterUserSelect(interaction) {
  if (!hasManageChannels(interaction)) {
    return interaction.reply({ content: MANAGE_CHANNELS_MESSAGE, flags: MessageFlags.Ephemeral });
  }

  const key      = linkKey(interaction.guildId, interaction.channelId);
  const targetId = interaction.values[0];

  const { link, already } = await withLinks(links => {
    const l = trackerLinkOf(links, key);
    if (!l) return { link: null, already: false };
    l.registeredUsers ??= [];
    const already = l.registeredUsers.includes(targetId);
    if (!already) l.registeredUsers.push(targetId);
    return { link: l, already };
  });

  if (!link) return notLinkedUpdate(interaction);

  await interaction.deferUpdate();
  if (!already) await refreshRegisteredView(interaction, link);

  await interaction.editReply({ embeds: [buildMenuEmbed(link, interaction.user.id, true)], components: buildAdminMenuRows(link) });
  await interaction.followUp({
    content: already
      ? `✅ <@${targetId}> is already in this channel's registered view.`
      : `✅ <@${targetId}> is now in this channel's registered view.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMenuButton(interaction) {
  const id               = interaction.customId;
  const link             = trackerLinkOf(loadLinks(), linkKey(interaction.guildId, interaction.channelId));
  const collectionRoomId = collectionRoomIdFor(interaction);
  const isManager        = hasManageChannels(interaction);

  if (id === "menu:back")       return interaction.update({ content: null, embeds: [buildMenuEmbed(link, interaction.user.id, isManager, null, collectionRoomId)], components: buildMainMenuRows(interaction, link, collectionRoomId) });
  if (id === "menu:status")     return handleMenuStatus(interaction, link, collectionRoomId);
  if (id === "menu:register")   return handleSelfRegistration(interaction, link, true);
  if (id === "menu:unregister") return handleSelfRegistration(interaction, link, false);
  if (id === "menu:dm")         return renderDmMenu(interaction, { loading: true });

  // Everything below is admin-only.
  if (id.startsWith("menu:admin") && !isManager) {
    return interaction.reply({ content: MANAGE_CHANNELS_MESSAGE, flags: MessageFlags.Ephemeral });
  }

  const adminEmbed = buildMenuEmbed(link, interaction.user.id, true, null, collectionRoomId);

  if (id === "menu:admin")                return interaction.update({ content: null, embeds: [adminEmbed], components: buildAdminMenuRows(link, collectionRoomId) });
  if (id === "menu:admin:link")           return showUrlModal(interaction, "modal:link", "Link Tracker", "CheeseTrackers URL or tracker ID");
  if (id === "menu:admin:collection")     return showUrlModal(interaction, "modal:collection", "Link Collection Room", "CheeseTrackers URL or collection room ID");
  if (id === "menu:admin:unlink")         return interaction.update({ embeds: [adminEmbed], components: buildUnlinkConfirmRows() });
  if (id === "menu:admin:unlink:confirm") return handleUnlinkConfirm(interaction);
  if (id === "menu:admin:unlink:cancel")  return interaction.update({ embeds: [adminEmbed], components: buildAdminMenuRows(link, collectionRoomId) });

  if (id === "menu:admin:viewmode:all")        return handleAdminViewMode(interaction, link, "all");
  if (id === "menu:admin:viewmode:registered") return handleAdminViewMode(interaction, link, "registered");

  if (id === "menu:admin:registeruser") {
    const selectRow = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("menu:admin:registeruser:select").setPlaceholder("Choose a user to register").setMinValues(1).setMaxValues(1)
    );
    const backRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("menu:admin").setLabel("◀ Back").setStyle(ButtonStyle.Secondary)
    );
    return interaction.update({ embeds: [adminEmbed], components: [selectRow, backRow] });
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
    .setColor(EMBED_COLOR)
    .setTitle("Archeesepelago Discord Bot")
    .setURL("https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot")
    .setDescription(
      "Posts Archipelago multiworld room status from CheeseTrackers into Discord."
    )
    .addFields(
      {
        name: "`/menu`",
        value:
          "Opens the bot menu for this channel.\n" +
          "- **Status**: preview the room status, then **Post to channel**. Posted status updates itself every 5 minutes.\n" +
          "- **Register / Unregister**: join or leave the channel's view (only in **Registered Only** mode).\n" +
          "- **DM Notifications**: get a DM when you receive a **Progression** or **Useful** item, per game. Each tab also has a **Hints** toggle for hints involving your games.\n" +
          "- **Admin Actions** *(Manage Channels)*: link a tracker, or a collection room until the tracker exists. Also **Unlink Channel**, **View Mode** and **Register Someone**.",
      },
      { name: "`/help`", value: "Show this message." },
      { name: "GitHub",  value: "[github.com/ChakraaThePanda/Archeesepelago-Discord-Bot](https://github.com/ChakraaThePanda/Archeesepelago-Discord-Bot)" },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ─── Client ───────────────────────────────────────────────────────────────────

// Without this, an unhandled rejection anywhere (a missed .catch on a fire-and-forget call, an
// unguarded await in a timer) kills the whole process, and every interaction in flight at that
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
  setPresence();
  setInterval(setPresence, 30 * 60 * 1000);

  // A failure here shouldn't stop live posts from resuming below; the commands registered on a
  // previous run keep working.
  try {
    console.log("Registering slash commands…");
    await new REST().setToken(DISCORD_TOKEN).put(Routes.applicationCommands(client.application.id), {
      body: commands.map(c => c.toJSON()),
    });
    console.log("✅ Commands registered globally.");
  } catch (err) {
    console.error("[!] Failed to register slash commands:", err.message);
  }

  await resumeTrackerPosts();
  await resumeCollectionPosts();
});

// Fetches a posted status's messages for resuming. Returns null if the channel itself is gone
// (the caller then drops the entry), or the messages still there (possibly none).
async function fetchPostMessages(channelId, messageIds) {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    if (err.code === 10003 || err.code === 10004) return null; // Unknown Channel / Unknown Guild
    throw err;
  }
  const messages = [];
  for (const id of messageIds) {
    try { messages.push(await channel.messages.fetch(id)); }
    catch { /* message gone */ }
  }
  return messages;
}

// Resumes auto-refresh for every link with a posted status, updating each post right away.
// Each removal below persists immediately via its own withLinks call rather than one save at the
// end, since this loop can run for minutes (2s spacing per link plus network calls) while users
// are already clicking menus. A CheeseTrackers outage at startup doesn't drop a post: it resumes
// without the immediate update, and the first refresh tick catches up.
async function resumeTrackerPosts() {
  const now = Date.now();
  let first = true;

  for (const [key, link] of Object.entries(loadLinks())) {
    if (!link.trackerId) continue; // collection rooms resume in resumeCollectionPosts

    // Remove entries with no activity in 30+ days (skip legacy entries with no timestamps)
    const lastSeen = Math.max(link.linkedAt ?? 0, link.lastActivityAt ?? 0);
    if (lastSeen > 0 && now - lastSeen > STALE_LINK_MS) {
      console.log(`[resume] Removing stale link ${key} (no activity in 30+ days)`);
      await withLinks(ls => { delete ls[key]; });
      continue;
    }

    if (!link.messageIds?.length) continue;

    if (!first) await sleep(2000);
    first = false;

    const [guildId, channelId] = key.split(":");
    const mode                 = link.mode ?? "all";
    const registeredUsers      = link.registeredUsers ?? [];

    try {
      const messages = await fetchPostMessages(channelId, link.messageIds);
      if (!messages) {
        console.log(`[resume] Removing link ${key}, its channel is gone`);
        await withLinks(ls => { delete ls[key]; });
        continue;
      }
      if (!messages.length) {
        await withLinks(ls => {
          const l = trackerLinkOf(ls, key);
          if (l) { delete l.messageIds; delete l.lastActivityAt; }
        });
        continue;
      }

      const guild = await client.guilds.fetch(guildId);
      let data    = null;
      try {
        data = await fetchTracker(link.trackerId);
        await editPages(messages, await buildStatusPages(link.trackerId, data, guild, true, mode, registeredUsers));
      } catch (err) {
        console.warn(`[resume] Couldn't update ${key} yet, the next refresh will:`, err.message);
      }
      startAutoRefresh(messages, link.trackerId, guild, data, link.lastActivityAt, mode, registeredUsers);
      console.log(`[resume] Restored auto-refresh for ${key}`);
    } catch (err) {
      console.warn(`[resume] Failed to restore ${key}:`, err.message);
    }
  }
}

// Collection room counterpart of resumeTrackerPosts.
async function resumeCollectionPosts() {
  const now = Date.now();

  for (const key of Object.keys(loadLinks())) {
    const entry = collectionRoomOf(loadLinks(), key);
    if (!entry) continue;

    const [guildId, channelId] = key.split(":");
    const lastSeen             = Math.max(entry.linkedAt ?? 0, entry.lastActivityAt ?? 0);
    if (now - lastSeen > STALE_LINK_MS) {
      console.log(`[resume] Removing stale collection room ${key} (no activity in 30+ days)`);
      await deleteCollectionEntry(guildId, channelId);
      continue;
    }

    if (!entry.messageId) continue;

    try {
      const messages = await fetchPostMessages(channelId, [entry.messageId]);
      if (!messages) {
        console.log(`[resume] Removing collection room ${key}, its channel is gone`);
        await deleteCollectionEntry(guildId, channelId);
        continue;
      }
      if (!messages.length) {
        await withLinks(ls => {
          const c = collectionRoomOf(ls, key);
          if (c) { delete c.messageId; delete c.lastActivityAt; }
        });
        continue;
      }

      const guild = await client.guilds.fetch(guildId);
      let current = null;
      try {
        current = await fetchCollectionRoom(entry.roomId);
        await editPages(messages, [buildCollectionRoomEmbed(entry.roomId, current, true)]);
      } catch (err) {
        console.warn(`[resume] Couldn't update ${key} yet, the next refresh will:`, err.message);
      }
      startCollectionAutoRefresh(messages[0], entry.roomId, guild, current, entry.lastActivityAt);
      console.log(`[resume] Restored auto-refresh for collection room ${key}`);
    } catch (err) {
      console.warn(`[resume] Failed to restore collection room ${key}:`, err.message);
    }
  }
}

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
      if (interaction.customId.startsWith("postcr:"))          return await handleCollectionPostButton(interaction);
      if (interaction.customId.startsWith("menu:dmslotpage:")) return await handleDmSlotPageButton(interaction);
      if (interaction.customId.startsWith("menu:dmslotall:"))  return await handleDmSlotAllToggle(interaction);
      if (interaction.customId.startsWith("menu:dmhint:"))     return await handleDmHintToggle(interaction);
      if (interaction.customId.startsWith("menu:dmtab:"))      return await handleDmTabSwitch(interaction);
      if (interaction.customId.startsWith("menu:"))            return await handleMenuButton(interaction);
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "modal:link")       return await handleLinkModalSubmit(interaction);
      if (interaction.customId === "modal:collection") return await handleCollectionModalSubmit(interaction);
    }
    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === "menu:admin:registeruser:select") return await handleRegisterUserSelect(interaction);
    }
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("menu:dmslot:")) return await handleDmSlotSelect(interaction);
    }
  } catch (err) {
    if (err.code === 10062) return; // Interaction expired (e.g. the bot restarted mid-flight), nothing to do
    console.error(`[${interaction.commandName ?? interaction.customId}]`, err);
    const msg = err.code === 50001
      ? "❌ I don't have permission to post in this channel. Check that my role has **View Channel** and **Send Messages** here, then try again."
      : `❌ Unexpected error: ${err.message}`;
    try {
      if (interaction.deferred || interaction.replied) {
        // Anything past a slash command is editing the menu, so offer a way back to it.
        await interaction.editReply({ content: msg, embeds: [], components: interaction.isChatInputCommand() ? [] : [backToMenuRow()] });
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
