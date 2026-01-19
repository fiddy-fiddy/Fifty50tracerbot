// --------------------
// 1️⃣ Crash Protection
// --------------------
process.on("unhandledRejection", (reason, promise) => {
console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (error) => {
console.error("Uncaught Exception:", error);
});

// --------------------
// 2️⃣ Imports & Setup
// --------------------
const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
require("dotenv").config();

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent
],
});

// --------------------
// 3️⃣ Heartbeat Log
// --------------------
setInterval(() => {
console.log("Bot heartbeat OK", new Date().toISOString());
}, 1000 * 60 * 10); // every 10 minutes

// --------------------
// 4️⃣ Command Map (put your existing commands here)
// --------------------
const commands = {
follow: async (interaction) => {},
unfollow: async (interaction) => {},
following: async (interaction) => {},
feed: async (interaction) => {},
alerts: async (interaction) => {},
addwin: async (interaction) => {},
resetleaderboard: async (interaction) => {},
verifywin: async (interaction) => {}
};

// --------------------
// 5️⃣ Login Function
// --------------------
async function startBot() {
try {
await client.login(process.env.TOKEN);
console.log(`${client.user.tag} is online!`);
} catch (err) {
console.error("Login failed:", err);
}
}

// Start the bot
startBot();

// --------------------
// 6️⃣ Auto-Reconnect Watchdog
// --------------------
setInterval(() => {
if (!client.isReady()) {
console.warn("Bot not ready, attempting reconnect...");
client.login(process.env.TOKEN).catch(err => console.error("Reconnect failed:", err));
}
}, 1000 * 60 * 5); // every 5 minutes

// --------------------
// 7️⃣ Discord Error Handling
// --------------------
client.on("error", (error) => {
console.error("Discord client error:", error);
});

client.on("shardDisconnect", (event, shardID) => {
console.warn(`Shard ${shardID} disconnected. Event:`, event);
});

// --------------------
// 8️⃣ Ready Event + Command Registration
// --------------------
client.once('ready', async () => {
try {
const guild = client.guilds.cache.get("1450546600823886007");
if (!guild) return console.log('Bot is not in your server yet.');
// Register commands here if needed
} catch (err) {
console.error("Ready event failed:", err);
}
});    




       

        

            

       




            
        

          

         

      

             

   

