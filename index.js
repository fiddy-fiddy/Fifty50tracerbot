const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// ====== DATA STORAGE ======
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

// ====== HELPER FUNCTIONS ======
function saveFollowers() { fs.writeFileSync(FOLLOWERS_FILE, JSON.stringify(followers, null, 2)); }
function saveSlips() { fs.writeFileSync(SLIPS_FILE, JSON.stringify(slips, null, 2)); }
function saveLeaderboard() { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2)); }
function saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2)); }

// ====== BOT READY ======
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    
    const data = [
        { name: 'follow', description: 'Follow a bettor', options: [{ name: 'target', type: 6, description: 'User to follow', required: true }] },
        { name: 'unfollow', description: 'Stop following a bettor', options: [{ name: 'target', type: 6, description: 'User to unfollow', required: true }] },
        { name: 'following', description: 'See who you are following' },
        { name: 'feed', description: 'See recent slips from users you follow' },
        { name: 'alerts', description: 'Turn DM alerts on or off', options: [{ name: 'state', type: 3, description: 'on or off', required: true }] },
        { 
            name: 'addwin', 
            description: 'Add a win to the leaderboard', 
            default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
            options: [{ name: 'name', type: 3, description: 'Bettor name', required: true }, { name: 'odds', type: 4, description: 'Win amount (+/- value)', required: true }] 
        },
        { 
            name: 'resetleaderboard', 
            description: 'Admin: reset the entire leaderboard',
            default_member_permissions: PermissionFlagsBits.ManageGuild.toString()
        },
        { 
            name: 'verifywin', 
            description: 'Admin: log a win for a user', 
            default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
            options: [{ name: 'target', type: 6, description: 'User to verify', required: true }] 
        }
    ];

    try {
        console.log('Started refreshing application (/) commands.');
        await client.application.commands.set(data);
        console.log('Successfully reloaded application (/) commands globally!');
        
        client.guilds.cache.forEach(async (guild) => {
            await guild.commands.set(data);
            console.log(`Successfully reloaded commands for guild: ${guild.name}`);
        });
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

// ====== LOG ALL SLIPS AND SEND ALERTS ======
client.on('messageCreate', async message => {
    if (message.channel.name !== 'bet-slips') return;
    if (message.author.bot) return;

    let attachmentUrl = message.attachments.first() ? message.attachments.first().url : null;
    let slip = {
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        timestamp: message.createdTimestamp,
        attachmentUrl
    };
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

// ====== AUTO LEADERBOARD TRACKING ======
const WINS_CHANNEL = 'wins';

client.on('messageCreate', async (message) => {
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

    const sorted = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]).slice(0, 10);
    let output = '';
    let rank = 1;

    for (let i = 0; i < sorted.length; i++) {
        const [name, value] = sorted[i];
        if (i > 0 && value === sorted[i - 1][1]) {
            // tie
        } else {
            rank = i + 1;
        }
        const sign = value >= 0 ? '+' : '';
        const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : '🔹 ';
        output += `${medal}**#${rank}** ${name} • \`${sign}${value}\`\n`;
    }

    const lbChannel = message.guild.channels.cache.find(c => c.name.toLowerCase().includes('leaderboard'));
    if (!lbChannel) return;

    const embed = new EmbedBuilder()
        .setTitle('🏆 Fifty50 Leaderboard 🏆')
        .setDescription(output || 'No records yet!')
        .setColor(0x00AE86)
        .setTimestamp()
        .setFooter({ text: 'Fifty50 Betting Community' });

    const messages = await lbChannel.messages.fetch({ limit: 5 });
    await lbChannel.bulkDelete(messages);
    lbChannel.send({ embeds: [embed] });
});

// ====== COMMAND HANDLER ======
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName, options, user } = interaction;

    if (commandName === 'follow') {
        const target = options.getUser('target');
        if (!followers[user.id]) followers[user.id] = [];
        if (!followers[user.id].includes(target.id)) {
            followers[user.id].push(target.id);
            saveFollowers();
            await interaction.reply(`You are now following **${target.username}**`);
        } else {
            await interaction.reply(`You are already following **${target.username}**`);
        }
    }

    if (commandName === 'unfollow') {
        const target = options.getUser('target');
        if (followers[user.id]) {
            followers[user.id] = followers[user.id].filter(id => id !== target.id);
            saveFollowers();
        }
        await interaction.reply(`You unfollowed **${target.username}**`);
    }

    if (commandName === 'following') {
        const followed = followers[user.id] || [];
        if (followed.length === 0) return interaction.reply('You are not following anyone.');
        let names = followed.map(id => client.users.cache.get(id)?.username || 'Unknown').join('\n- ');
        await interaction.reply(`You are following:\n- ${names}`);
    }

    if (commandName === 'feed') {
        const followed = followers[user.id] || [];
        if (followed.length === 0) return interaction.reply('You are not following anyone.');
        let recentSlips = slips
            .filter(slip => followed.includes(slip.userId))
            .slice(-5)
            .map(slip => `${slip.username}: ${slip.content} ${slip.attachmentUrl || ''}`)
            .join('\n\n');
        await interaction.reply(recentSlips || 'No recent slips from followed users.');
    }

    if (commandName === 'alerts') {
        const toggle = options.getString('state');
        alerts[user.id] = toggle.toLowerCase() === 'on';
        saveAlerts();
        await interaction.reply(`DM alerts turned **${toggle.toUpperCase()}**`);
    }

    if (commandName === 'verifywin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        const target = options.getUser('target');
        if (!leaderboard[target.id]) leaderboard[target.id] = 0;
        leaderboard[target.id] += 1;
        saveLeaderboard();
        await interaction.reply(`Recorded win for ${target.username}`);
    }

    if (commandName === 'addwin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        const name = options.getString('name');
        const odds = options.getInteger('odds');
        if (!leaderboard[name]) leaderboard[name] = 0;
        leaderboard[name] += odds;
        saveLeaderboard();
        await interaction.reply(`Added ${odds} to ${name}`);
    }

    if (commandName === 'resetleaderboard') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        leaderboard = {};
        saveLeaderboard();
        await interaction.reply('Leaderboard reset.');
    }
});

// ====== LOGIN ======
client.login(process.env.DISCORD_BOT_TOKEN);
