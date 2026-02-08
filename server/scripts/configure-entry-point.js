/**
 * Configure Discord Entry Point Command
 * 
 * This script configures the Activity's "Launch" command behavior:
 * - By default: Routes "Launch" to your bot (APP_HANDLER) so it calls launchActivity() without spam
 * - With --disable flag: Deletes the Entry Point so only /quordle commands work
 * 
 * Usage:
 *   node scripts/configure-entry-point.js           # Set APP_HANDLER (Launch still works, no spam)
 *   node scripts/configure-entry-point.js --disable # Delete Launch, use only /quordle
 */

import dotenv from "dotenv";

// Load .env
dotenv.config({ path: "../.env" });
dotenv.config();

const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISABLE_ENTRY_POINT = process.argv.includes("--disable");

if (!DISCORD_CLIENT_ID || !DISCORD_BOT_TOKEN) {
    console.error("Missing VITE_DISCORD_CLIENT_ID or DISCORD_BOT_TOKEN in .env");
    process.exit(1);
}

const API_BASE = "https://discord.com/api/v10";

async function apiRequest(method, endpoint, body = null) {
    const options = {
        method,
        headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
            "Content-Type": "application/json",
        },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    // Handle 204 No Content (e.g., DELETE)
    if (response.status === 204) {
        return null;
    }

    const data = await response.json();

    if (!response.ok) {
        throw new Error(`API Error ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
}

async function main() {
    console.log("Fetching application commands...");
    console.log(`App ID: ${DISCORD_CLIENT_ID}`);

    // Get all global commands
    const commands = await apiRequest("GET", `/applications/${DISCORD_CLIENT_ID}/commands`);

    console.log(`\nFound ${commands.length} command(s):\n`);

    // Find the Entry Point command (type 4 = PRIMARY_ENTRY_POINT)
    let entryPointCommand = null;

    for (const cmd of commands) {
        const typeDesc = cmd.type === 4 ? "PRIMARY_ENTRY_POINT" : cmd.type === 1 ? "CHAT_INPUT" : `type=${cmd.type}`;
        const handlerDesc = cmd.handler === 1 ? "APP_HANDLER" : cmd.handler === 2 ? "DISCORD_LAUNCH_ACTIVITY" : `handler=${cmd.handler || "default"}`;

        console.log(`  - ${cmd.name} (${typeDesc}) [${handlerDesc}]`);
        console.log(`    ID: ${cmd.id}`);

        if (cmd.type === 4) {
            entryPointCommand = cmd;
        }
    }

    if (!entryPointCommand) {
        console.log("\n✅ No Entry Point command found (already disabled or Activities not enabled).");
        if (!DISABLE_ENTRY_POINT) {
            console.log("   If you want the built-in Launch command, enable Activities in Developer Portal.");
        }
        return;
    }

    console.log(`\n🎯 Entry Point Command: "${entryPointCommand.name}" (ID: ${entryPointCommand.id})`);

    if (DISABLE_ENTRY_POINT) {
        // Delete the Entry Point command entirely
        console.log("\n🗑️  Deleting Entry Point command (--disable flag)...");

        await apiRequest(
            "DELETE",
            `/applications/${DISCORD_CLIENT_ID}/commands/${entryPointCommand.id}`
        );

        console.log("✅ Entry Point command deleted!");
        console.log("\nUsers can now only launch via /quordle play or /quordle daily");
        return;
    }

    // Check current handler
    if (entryPointCommand.handler === 1) {
        console.log("✅ Already configured to use APP_HANDLER (no changes needed)");
        console.log("\nBoth 'Launch' and /quordle commands will work without spam.");
        return;
    }

    console.log("\n📝 Updating handler to APP_HANDLER...");

    // Update the command to use APP_HANDLER
    const updated = await apiRequest(
        "PATCH",
        `/applications/${DISCORD_CLIENT_ID}/commands/${entryPointCommand.id}`,
        { handler: 1 } // 1 = APP_HANDLER
    );

    console.log(`✅ Updated! Handler is now: ${updated.handler === 1 ? "APP_HANDLER" : updated.handler}`);
    console.log("\nThe 'Launch' command now routes to your bot (no channel spam).");
    console.log("Users can use 'Launch' OR /quordle play - both work cleanly.");
}

main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});
