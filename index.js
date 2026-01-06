// ------------------------
// IMPORTS
// ------------------------
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const express = require('express');

// ------------------------
// CLIENT SETUP
// ------------------------
const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
GatewayIntentBits.GuildMembers
],
partials: [Partials.Channel]
});

// ------------------------
// DATA STORAGE
// ------------------------
let followers = {};
let slips = [];
let leaderboard = {};
let alerts = {};

const FOLLOWERS_FILE = './followers.json';
const SLIPS_FILE = './slips.json';
const LEADERBOARD_FILE = './leaderboard.json';
const ALERTS_FILE = './alerts.json';

// Load existing data
if (fs.existsSync(FOLLOWERS_FILE)) followers = JSON.parse(fs.readFileSync(FOLLOWERS_FILE));
if (fs.existsSync(SLIPS_FILE)) slips = JSON.parse(fs.readFileSync(SLIPS_FILE));
if (fs.existsSync(LEADERBOARD_FILE)) leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE));
if (fs.existsSync(ALERTS_FILE)) alerts = JSON.parse(fs.readFileSync(ALERTS_FILE));

// Helper functions
function saveFollowers() { fs.writeFileSync(FOLLOWERS_FILE, JSON.stringify(followers, null, 2)); }
function saveSlips() { fs.writeFileSync(SLIPS_FILE, JSON.stringify(slips, null, 2)); }
function saveLeaderboard() { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2)); }
function saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2)); }

// ------------------------
// READY EVENT + SLASH COMMANDS
// ------------------------
client.once('ready', async () => {
console.log(`${client.user.tag} is online!`);

const guild = client.guilds.cache.first();
if (!guild) return console.log('Bot is not in a server yet.');

// Full list of commands
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

await guild.commands.set(allCommands);
console.log('Slash commands registered!');
});

// ------------------------
// MESSAGE HANDLERS
// ------------------------
// Slips channel
client.on('messageCreate', async message => {
if (message.channel.name !== 'bet-slips') return;
if (message.author.bot) return;

const attachmentUrl = message.attachments.first()?.url || null;
const slip = { userId: message.author.id, username: message.author.username, content: message.content, timestamp: message.createdTimestamp, attachmentUrl };
slips.push(slip);
saveSlips();

for (const [followerId, targets] of Object.entries(followers)) {
if (targets.includes(message.author.id) && alerts[followerId]) {
try {
const user = await client.users.fetch(followerId);
await user.send(`New slip from ${message.author.username}:\n${message.content}\n${attachmentUrl || ''}`);
} catch (err) {
console.log(`Failed to DM ${followerId}: ${err}`);
}
}
}
});

// Wins channel / leaderboard updates
const WINS_CHANNEL = 'wins';
client.on('messageCreate', async message => {
if (message.author.bot) return;
if (!message.guild) return;
if (message.channel.name !== WINS_CHANNEL) return;

const lines = message.content.split('\n');
for (const line of lines) {
const match = line.trim().match(/^(.+?)\s([+-]\d+)$/);
if (!match) continue;

const name = match[1];
const odds = parseInt(match[2]);
if (!leaderboard[name]) leaderboard[name] = 0;
leaderboard[name] += odds;
}

saveLeaderboard();

const sorted = Object.entries(leaderboard).sort((a,b) => b[1]-a[1]).slice(0,10);
let output = '', rank = 1;
for (let i=0;i<sorted.length;i++) {
const [name, value] = sorted[i];
if(i>0 && value===sorted[i-1][1]){}else{rank=i+1;}
const sign = value>=0?'+':'';
const medal = rank===1?'🥇':rank===2?'🥈':rank===3?'🥉':'🔹';
output += `${medal} **#${rank}** ${name} • \`${sign}${value}\`\n`;
}

const lbChannel = message.guild.channels.cache.find(c=>c.name.toLowerCase().includes('leaderboard'));
if(!lbChannel) return;

const embed = new EmbedBuilder().setTitle('🏆 Fifty50 Leaderboard 🏆').setDescription(output||'No records yet!').setColor(0x00AE86).setTimestamp().setFooter({text:'Fifty50 Betting Community'});

const messages = await lbChannel.messages.fetch({limit:5});
await lbChannel.bulkDelete(messages);
await lbChannel.send({embeds:[embed]});
});

// ------------------------
// COMMAND HANDLER
// ------------------------
client.on('interactionCreate', async interaction => {
if (!interaction.isChatInputCommand()) return;

const { commandName, options, user } = interaction;
const member = interaction.member;
const isAdmin = member.permissions.has(PermissionFlagsBits.ManageGuild);
const memberCommands = ['feed','alerts','follow','unfollow','following'];

if (!isAdmin && !memberCommands.includes(commandName)) {
return interaction.reply({content:'You do not have access to this command.',ephemeral:true});
}

// Commands: follow, unfollow, following, feed, alerts, verifywin, addwin, resetleaderboard
// Keep your existing command logic here...
});

// ------------------------
// LOGIN
// ------------------------
const token = process.env.DISCORD_BOT;
if(!token){console.error('❌ ERROR: DISCORD_BOT is not set!');process.exit(1);}
client.login(token).then(()=>console.log(`✅ Logged in as ${client.user.tag}`)).catch(err=>console.error('❌ Failed to login:',err));

// ------------------------
// KEEP RAILWAY ALIVE
// ------------------------
const app = express();
app.get('/', (req,res)=>res.send('Bot is running'));
app.listen(process.env.PORT||3000, ()=>console.log('🌐 Web server is alive on port', process.env.PORT||3000));




    

   

    



   



       

   
     

    




       

        

            

       




            
        

          

         

      

             

   

