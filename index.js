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
intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
});

// --------------------
// 3️⃣ Heartbeat Log
// --------------------
setInterval(() => {
console.log("Bot heartbeat OK", new Date().toISOString());
}, 1000 * 60 * 10); // every 10 minutes

// --------------------
// 4️⃣ Discord API Error Handling
// --------------------
client.on("error", (error) => {
console.error("Discord client error:", error);
});

client.on("shardDisconnect", (event, shardID) => {
console.warn(`Shard ${shardID} disconnected. Event:`, event);
});

// --------------------
// 5️⃣ Command Map (all commands here, keep your logic)
// --------------------
const commands = {
follow: async (interaction) => {
// your follow command code here
},
unfollow: async (interaction) => {
// your unfollow command code here
},
following: async (interaction) => {
// your following command code here
},
feed: async (interaction) => {
// your feed command code here
},
alerts: async (interaction) => {
// your alerts command code here
},
addwin: async (interaction) => {
// your addwin command code here
},
resetleaderboard: async (interaction) => {
// your resetleaderboard command code here
},
verifywin: async (interaction) => {
// your verifywin command code here
}
};

// --------------------
// 6️⃣ Ready Event + Command Registration
// --------------------
client.once('ready', async () => {
try {
console.log(`${client.user.tag} is online!`);

const guild = client.guilds.cache.first();
if (!guild) return console.log('Bot is not in a server yet.');

// Full list of commands (keep the same)
const allCommands = [
{ name: 'follow', description: 'Follow a bettor', options: [{ name: 'target', type: 6, description: 'User to follow', required: true }] },
{ name: 'unfollow', description: 'Stop following a bettor', options: [{ name: 'target', type: 6, description: 'User to unfollow', required: true }] },
{ name: 'following', description: 'See who you are following' },
{ name: 'feed', description: 'See recent slips from users you follow' },
{ name: 'alerts', description: 'Turn DM alerts on or off', options: [{ name: 'state', type: 3, description: 'on or off', required: true }] },
{ name: 'addwin', description: 'Add a win to the leaderboard', options: [{ name: 'name', type: 3, description: 'Bettor name', required: true }, { name: 'odds', type: 4, description: 'Win amount (+/- value)', required: true }] },
{ name: 'resetleaderboard', description: 'Admin: reset the entire leaderboard' },
{ name: 'verifywin', description: 'Admin: log a win for a user', options: [{ name: 'target', type: 6, description: 'User to verify', required: true }] }
];

const adminCommands = allCommands; // admins see all
const memberCommands = allCommands.filter(cmd =>
['feed', 'alerts', 'follow', 'unfollow', 'following'].includes(cmd.name)
);

const members = await guild.members.fetch();

members.forEach(member => {
try {
const isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);

if (isAdmin) {
member.user.send('Admin detected. Full command access enabled.').catch(() => {});
}

guild.commands.set(isAdmin ? adminCommands : memberCommands).catch(console.error);
} catch (cmdErr) {
console.error(`Error setting commands for member ${member.user.tag}:`, cmdErr);
}
});

console.log('Slash commands registered with role-based filtering!');
} catch (err) {
console.error("Error in ready event:", err);
}
});

// --------------------
// 7️⃣ Interaction Handler (safe execution for all commands)
// --------------------
client.on('interactionCreate', async (interaction) => {
if (!interaction.isCommand()) return;

const cmdFunc = commands[interaction.commandName];
if (!cmdFunc) {
console.warn(`No function found for command ${interaction.commandName}`);
return;
}

try {
await cmdFunc(interaction);
} catch (err) {
console.error(`Error executing command ${interaction.commandName}:`, err);

if (interaction.replied || interaction.deferred) {
await interaction.followUp({ content: 'An error occurred while running this command.', ephemeral: true }).catch(() => {});
} else {
await interaction.reply({ content: 'An error occurred while running this command.', ephemeral: true }).catch(() => {});
}
}
});

// --------------------
// 8️⃣ Safe Login
// --------------------
(async () => {
try {
await client.login(process.env.TOKEN);
} catch (err) {
console.error("Login failed:", err);
}
})();

// --------------------
// 9️⃣ Watchdog Reconnect
// --------------------
setInterval(() => {
if (!client.isReady()) {
console.warn("Bot not ready, attempting reconnect...");
client.login(process.env.TOKEN).catch(err => console.error("Reconnect failed:", err));
}
}, 1000 * 60 * 5); // every 5 minutes

   

    



   



       

   
     

    




       

        

            

       




            
        

          

         

      

             

   

