import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } from "discord.js";
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
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days TTL for daily message records

if (REDIS_URL) {
    try {
        console.log("[Bot Redis] Connecting to:", REDIS_URL.replace(/:[^:@]+@/, ":***@"));
        redis = new Redis(REDIS_URL);
        redis.on("error", (err) => console.error("[Bot Redis] Error:", err.message));
        redis.on("connect", () => console.log("[Bot Redis] Connected"));
        redis.on("ready", () => console.log("[Bot Redis] Ready"));
    } catch (err) {
        console.error("[Bot Redis] Failed to initialize:", err);
        redis = null;
    }
} else {
    console.warn("[Bot] No REDIS_URL configured - daily message tracking will not persist across restarts");
}

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
        .setDescription("Quordle game commands")
        .addSubcommand((subcommand) =>
            subcommand
                .setName("daily")
                .setDescription("Start today's Daily Quordle challenge")
        ),
];

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

    try {
        console.log("[Bot] Registering slash commands...");
        await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
            body: commands.map((cmd) => cmd.toJSON()),
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

// ========== EVENT HANDLERS ==========

client.once("ready", async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);

    // Set bot activity status
    client.user.setActivity("Daily Quordle", { type: ActivityType.Playing });

    // Register slash commands
    await registerCommands();
});

client.on("interactionCreate", async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "quordle") {
                const subcommand = interaction.options.getSubcommand();
                if (subcommand === "daily") {
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
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("[Bot] Shutting down...");
    client.destroy();
    if (redis) redis.disconnect();
    process.exit(0);
});

export { client, getTodayDateKey, getDailyMsgRecord, setDailyMsgRecord };
