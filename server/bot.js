import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, InteractionType } from "discord.js";
import dotenv from "dotenv";
import Redis from "ioredis";

// Load .env from parent directory in dev, or current directory in production
dotenv.config({ path: "../.env" });
dotenv.config();

// ========== CONFIGURATION ==========
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL;

if (!DISCORD_CLIENT_ID) {
    console.error("[Bot] Missing VITE_DISCORD_CLIENT_ID");
    process.exit(1);
}

if (!DISCORD_BOT_TOKEN) {
    console.error("[Bot] Missing DISCORD_BOT_TOKEN - Bot will not start");
    process.exit(1);
}

// ========== REDIS CLIENT ==========
let redis = null;
let redisErrorLogged = false; // Prevent spam
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days TTL for daily message records

if (REDIS_URL) {
    try {
        console.log("[Bot Redis] Connecting to:", REDIS_URL.replace(/:[^:@]+@/, ":***@"));
        redis = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                if (times > 3) {
                    if (!redisErrorLogged) {
                        console.warn("[Bot Redis] Connection failed, using in-memory fallback");
                        redisErrorLogged = true;
                    }
                    return null; // Stop retrying
                }
                return Math.min(times * 200, 2000);
            },
        });
        redis.on("error", (err) => {
            if (!redisErrorLogged) {
                console.error("[Bot Redis] Error:", err.message);
                redisErrorLogged = true;
            }
        });
        redis.on("connect", () => {
            redisErrorLogged = false;
            console.log("[Bot Redis] Connected");
        });
        redis.on("ready", () => console.log("[Bot Redis] Ready"));
    } catch (err) {
        console.error("[Bot Redis] Failed to initialize:", err);
        redis = null;
    }
} else {
    console.warn("[Bot] No REDIS_URL configured - daily message tracking will not persist across restarts");
}

// Separate Redis client for pub/sub (can't use same connection)
let redisSub = null;
if (REDIS_URL) {
    try {
        redisSub = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => times > 3 ? null : Math.min(times * 200, 2000),
        });
        redisSub.on("error", () => { }); // Suppress errors (already logged by main client)
        redisSub.on("ready", () => console.log("[Bot Redis Sub] Ready for pub/sub"));
    } catch (err) {
        redisSub = null;
    }
}

// Track recent leave events to dedupe (users may trigger multiple times)
const recentLeaves = new Map(); // key: `${guildId}:${channelId}:${userId}` -> timestamp
const LEAVE_DEDUPE_MS = 30000; // 30 seconds

// In-memory fallback for daily message tracking
const dailyMessageStore = new Map();

// ========== REDIS KEY HELPERS ==========
// Key format: dailyMsg:{guildId}:{channelId}
// Value: JSON { messageId, dateKey }

function makeDailyMsgKey(guildId, channelId) {
    return `dailyMsg:${guildId}:${channelId}`;
}

async function getDailyMsgRecord(guildId, channelId) {
    const key = makeDailyMsgKey(guildId, channelId);

    if (redis) {
        try {
            const data = await redis.get(key);
            if (data) {
                return JSON.parse(data);
            }
        } catch (err) {
            console.error("[Bot] Failed to get daily message from Redis:", err.message);
        }
    }

    // Fallback to in-memory
    return dailyMessageStore.get(key) || null;
}

async function setDailyMsgRecord(guildId, channelId, messageId, dateKey) {
    const key = makeDailyMsgKey(guildId, channelId);
    const record = { messageId, dateKey, updatedAt: Date.now() };

    if (redis) {
        try {
            await redis.setex(key, REDIS_TTL_SECONDS, JSON.stringify(record));
            console.log("[Bot] Saved daily message record to Redis:", key);
        } catch (err) {
            console.error("[Bot] Failed to save daily message to Redis:", err.message);
        }
    }

    // Also store in memory for quick access
    dailyMessageStore.set(key, record);
}

// ========== DATE HELPERS ==========
// Use America/Chicago timezone for consistent daily reset

function getTodayDateKey() {
    const now = new Date();
    const chicagoTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Chicago" }));
    const year = chicagoTime.getFullYear();
    const month = String(chicagoTime.getMonth() + 1).padStart(2, "0");
    const day = String(chicagoTime.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatDateForDisplay(dateKey) {
    // Convert YYYY-MM-DD to "Month Day, Year"
    const [year, month, day] = dateKey.split("-");
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    return date.toLocaleDateString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric"
    });
}

// ========== DISCORD CLIENT SETUP ==========
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

// ========== SLASH COMMANDS ==========
const commands = [
    new SlashCommandBuilder()
        .setName("quordle")
        .setDescription("Play Quordle - solve 4 words at once!")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("play")
                .setDescription("Launch Quordle activity instantly")
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("daily")
                .setDescription("Post today's Daily Quordle challenge to this channel")
        ),
];

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

    try {
        console.log("[Bot] Fetching existing commands...");

        // Get existing commands (including Entry Point)
        const existingCommands = await rest.get(Routes.applicationCommands(DISCORD_CLIENT_ID));

        // Find the Entry Point command (type 4) - we must include it in bulk update
        const entryPointCmd = existingCommands.find(cmd => cmd.type === 4);

        // Build the command list
        const commandsToRegister = commands.map((cmd) => cmd.toJSON());

        // Include Entry Point if it exists (required by Discord)
        if (entryPointCmd) {
            console.log(`[Bot] Including Entry Point command: ${entryPointCmd.name} (id: ${entryPointCmd.id})`);
            commandsToRegister.push({
                id: entryPointCmd.id,
                name: entryPointCmd.name,
                type: entryPointCmd.type,
                handler: entryPointCmd.handler,
            });
        }

        console.log("[Bot] Registering slash commands...");
        await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
            body: commandsToRegister,
        });
        console.log("[Bot] Slash commands registered successfully");
    } catch (err) {
        console.error("[Bot] Failed to register slash commands:", err);
    }
}

// ========== MESSAGE BUILDERS ==========

function buildDailyEmbed(dateKey) {
    const displayDate = formatDateForDisplay(dateKey);

    return new EmbedBuilder()
        .setColor(0x538d4e) // Wordle green
        .setTitle("🟩 Daily Quordle")
        .setDescription(
            `**${displayDate}**\n\n` +
            "Can you solve all 4 words in 9 guesses?\n\n" +
            "Click **Play** below to join the challenge!"
        )
        .setFooter({ text: "Resets daily at midnight (America/Chicago)" });
}

function buildPlayButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId("quordle_play")
            .setLabel("Play")
            .setStyle(ButtonStyle.Primary)
            .setEmoji("🎮")
    );
}

// ========== COMMAND HANDLERS ==========

async function handleDailyCommand(interaction) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const todayDateKey = getTodayDateKey();

    if (!guildId) {
        await interaction.reply({
            content: "This command can only be used in a server.",
            ephemeral: true,
        });
        return;
    }

    // Check for existing daily message record
    const existingRecord = await getDailyMsgRecord(guildId, channelId);

    const embed = buildDailyEmbed(todayDateKey);
    const components = [buildPlayButton()];

    if (existingRecord) {
        // Record exists - try to edit the existing message
        try {
            const channel = await client.channels.fetch(channelId);
            const existingMessage = await channel.messages.fetch(existingRecord.messageId);

            if (existingRecord.dateKey === todayDateKey) {
                // Same day - just edit to refresh components (idempotent)
                await existingMessage.edit({ embeds: [embed], components });
                console.log(`[Bot] Refreshed existing daily message for ${guildId}:${channelId} (same day)`);

                await interaction.reply({
                    content: "Today's Daily Quordle is already posted above! Click Play to join.",
                    ephemeral: true,
                });
            } else {
                // New day - edit the existing message with new day's content
                await existingMessage.edit({ embeds: [embed], components });
                await setDailyMsgRecord(guildId, channelId, existingRecord.messageId, todayDateKey);
                console.log(`[Bot] Updated daily message for new day: ${existingRecord.dateKey} -> ${todayDateKey}`);

                await interaction.reply({
                    content: "Daily Quordle has been updated for today! Click Play above to join.",
                    ephemeral: true,
                });
            }
            return;
        } catch (err) {
            // Message was probably deleted - fall through to create new one
            console.log(`[Bot] Existing message not found (${err.code || err.message}), creating new one`);
        }
    }

    // No existing message or it was deleted - send a new one
    try {
        // Defer the reply since we're going to send a channel message
        await interaction.deferReply({ ephemeral: true });

        const channel = await client.channels.fetch(channelId);
        const newMessage = await channel.send({ embeds: [embed], components });

        // Store the message reference
        await setDailyMsgRecord(guildId, channelId, newMessage.id, todayDateKey);
        console.log(`[Bot] Created new daily message: ${newMessage.id} for ${guildId}:${channelId}`);

        await interaction.editReply({
            content: "Daily Quordle posted! Click Play to join.",
        });
    } catch (err) {
        console.error("[Bot] Failed to send daily message:", err);
        await interaction.editReply({
            content: "Failed to post Daily Quordle. Make sure I have permission to send messages in this channel.",
        });
    }
}

async function handlePlayButton(interaction) {
    // Launch the Activity directly - no new channel message
    try {
        // Use Discord's native activity launch (same as official Wordle)
        await interaction.launchActivity();
        console.log(`[Bot] Launched activity for user ${interaction.user.id}`);
    } catch (err) {
        console.error("[Bot] Failed to launch activity:", err);
        // Fallback: provide instructions if launchActivity fails
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: "Something went wrong. Try starting the activity from the Activities menu in a voice channel.",
                ephemeral: true,
            });
        }
    }
}

// ========== "WAS PLAYING" MESSAGE ==========

function buildWasPlayingEmbed(profile, gameState) {
    const displayName = profile?.displayName || "Someone";

    let description = `**${displayName}** was playing Daily Quordle`;

    // Add game result if available
    if (gameState) {
        const { solvedCount, guessCount, gameOver, won } = gameState;
        if (gameOver) {
            if (won) {
                description += `\n🏆 Solved all 4 in ${guessCount} guesses!`;
            } else {
                description += `\n📊 Solved ${solvedCount}/4 boards`;
            }
        } else if (guessCount > 0) {
            description += `\n📊 ${solvedCount}/4 boards • ${guessCount} guesses`;
        }
    }

    return new EmbedBuilder()
        .setColor(0x538d4e)
        .setDescription(description)
        .setFooter({ text: "Click Play to join!" });
}

async function handleActivityLeave(event) {
    const { userId, guildId, channelId, profile, gameState } = event;

    // Dedupe check
    const dedupeKey = `${guildId}:${channelId}:${userId}`;
    const lastLeave = recentLeaves.get(dedupeKey);
    const now = Date.now();

    if (lastLeave && (now - lastLeave) < LEAVE_DEDUPE_MS) {
        console.log(`[Bot] Skipping duplicate leave event for ${userId}`);
        return;
    }
    recentLeaves.set(dedupeKey, now);

    // Clean up old entries
    for (const [key, timestamp] of recentLeaves) {
        if (now - timestamp > LEAVE_DEDUPE_MS * 2) {
            recentLeaves.delete(key);
        }
    }

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            console.log(`[Bot] Channel ${channelId} not found`);
            return;
        }

        const embed = buildWasPlayingEmbed(profile, gameState);
        const components = [buildPlayButton()];

        await channel.send({ embeds: [embed], components });
        console.log(`[Bot] Posted "was playing" for ${profile?.displayName || userId} in ${guildId}/${channelId}`);
    } catch (err) {
        console.error("[Bot] Failed to post 'was playing' message:", err.message);
    }
}

function setupActivityEventSubscription() {
    if (!redisSub) {
        console.log("[Bot] No Redis sub client - activity events disabled");
        return;
    }

    redisSub.subscribe("activity:events", (err) => {
        if (err) {
            console.error("[Bot] Failed to subscribe to activity:events:", err.message);
            return;
        }
        console.log("[Bot] Subscribed to activity:events channel");
    });

    redisSub.on("message", async (channel, message) => {
        if (channel !== "activity:events") return;

        try {
            const event = JSON.parse(message);

            if (event.type === "ACTIVITY_LEAVE") {
                await handleActivityLeave(event);
            }
        } catch (err) {
            console.error("[Bot] Failed to handle activity event:", err.message);
        }
    });
}

// ========== EVENT HANDLERS ==========

client.once("ready", async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);

    // Set bot activity status
    client.user.setActivity("Daily Quordle", { type: ActivityType.Playing });

    // Register slash commands
    await registerCommands();

    // Start listening for activity events
    setupActivityEventSubscription();
});

client.on("interactionCreate", async (interaction) => {
    try {
        // Handle Entry Point command (type 4 = PRIMARY_ENTRY_POINT)
        // This is the "Launch" button in Activities - when handler is APP_HANDLER
        if (interaction.type === InteractionType.ApplicationCommand && interaction.commandType === 4) {
            console.log(`[Bot] Entry Point interaction from ${interaction.user.id}`);
            await interaction.launchActivity();
            return;
        }

        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "quordle") {
                const subcommand = interaction.options.getSubcommand();
                if (subcommand === "play") {
                    // Instant launch - no channel message
                    console.log(`[Bot] /quordle play from ${interaction.user.id}`);
                    await interaction.launchActivity();
                } else if (subcommand === "daily") {
                    await handleDailyCommand(interaction);
                }
            }
        } else if (interaction.isButton()) {
            if (interaction.customId === "quordle_play") {
                await handlePlayButton(interaction);
            }
        }
    } catch (err) {
        console.error("[Bot] Interaction error:", err);

        // Try to respond with an error message
        try {
            const reply = {
                content: "An error occurred while processing your request.",
                ephemeral: true,
            };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        } catch (replyErr) {
            console.error("[Bot] Failed to send error reply:", replyErr);
        }
    }
});

// ========== START BOT ==========
console.log("[Bot] Starting Discord bot...");
client.login(DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on("SIGINT", () => {
    console.log("[Bot] Shutting down...");
    client.destroy();
    if (redis) redis.disconnect();
    if (redisSub) redisSub.disconnect();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("[Bot] Shutting down...");
    client.destroy();
    if (redis) redis.disconnect();
    if (redisSub) redisSub.disconnect();
    process.exit(0);
});

export { client, getTodayDateKey, getDailyMsgRecord, setDailyMsgRecord };
