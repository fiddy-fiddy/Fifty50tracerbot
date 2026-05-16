const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const { Pool } = require('pg');
const Stripe = require('stripe');
const express = require('express');

// ====== DISCORD CLIENT ======
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,   // <-- added for subscription role management
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

if (fs.existsSync(FOLLOWERS_FILE)) followers = JSON.parse(fs.readFileSync(FOLLOWERS_FILE));
if (fs.existsSync(SLIPS_FILE)) slips = JSON.parse(fs.readFileSync(SLIPS_FILE));
if (fs.existsSync(LEADERBOARD_FILE)) leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE));
if (fs.existsSync(ALERTS_FILE)) alerts = JSON.parse(fs.readFileSync(ALERTS_FILE));

function saveFollowers() { fs.writeFileSync(FOLLOWERS_FILE, JSON.stringify(followers, null, 2)); }
function saveSlips() { fs.writeFileSync(SLIPS_FILE, JSON.stringify(slips, null, 2)); }
function saveLeaderboard() { fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2)); }
function saveAlerts() { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2)); }

// ====== DATABASE (shared with Replit web app) ======
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function getUserByDiscordId(discordId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discordId]);
    return rows[0] || null;
}

async function getUserByStripeCustomerId(customerId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
    return rows[0] || null;
}

async function setSubscribed(discordId, stripeCustomerId, subscriptionId, isSubscribed) {
    await pool.query(
        `UPDATE users SET stripe_customer_id = $2, stripe_subscription_id = $3, is_subscribed = $4 WHERE discord_id = $1`,
        [discordId, stripeCustomerId, subscriptionId, isSubscribed]
    );
}

// ====== SUBSCRIPTION ROLE HELPERS ======
async function assignPaidRole(discordId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) {
            await member.roles.add(process.env.DISCORD_ROLE_ID);
            console.log(`Assigned paid role to ${discordId}`);
        }
    } catch (err) {
        console.error('assignPaidRole error:', err);
    }
}

async function removePaidRoleAndKick(discordId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (member) {
            await member.roles.remove(process.env.DISCORD_ROLE_ID);
            await member.kick('Subscription canceled');
            console.log(`Removed role and kicked ${discordId}`);
        }
    } catch (err) {
        console.error('removePaidRoleAndKick error:', err);
    }
}

// ====== BOT READY & COMMAND REGISTRATION ======
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);

    const data = [
        { name: 'follow', description: 'Follow a bettor', options: [{ name: 'target', type: 6, description: 'User to follow', required: true }] },
        { name: 'unfollow', description: 'Stop following a bettor', options: [{ name: 'target', type: 6, description: 'User to unfollow', required: true }] },
        { name: 'following', description: 'See who you are following' },
        { name: 'feed', description: 'See recent slips from users you follow' },
        { name: 'alerts', description: 'Turn DM alerts on or off', options: [{ name: 'state', type: 3, description: 'on or off', required: true }] },
        { name: 'addwin', description: 'Add a win to the leaderboard', options: [{ name: 'name', type: 3, description: 'Bettor name', required: true }, { name: 'odds', type: 4, description: 'Win amount (+/- value)', required: true }] },
        { name: 'resetleaderboard', description: 'Admin: reset the entire leaderboard' },
        { name: 'verifywin', description: 'Admin: log a win for a user', options: [{ name: 'target', type: 6, description: 'User to verify', required: true }] }
    ];

    try {
        console.log('Registering commands...');
        await client.application.commands.set(data);
        client.guilds.cache.forEach(async (guild) => {
            await guild.commands.set(data);
        });
        console.log('Slash commands registered!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
});

// ====== WHEN SOMEONE JOINS — AUTO-ASSIGN ROLE IF SUBSCRIBED ======
client.on('guildMemberAdd', async (member) => {
    try {
        const user = await getUserByDiscordId(member.id);
        if (user && user.is_subscribed) {
            await member.roles.add(process.env.DISCORD_ROLE_ID);
            console.log(`Auto-assigned paid role to ${member.id} on join`);
        }
    } catch (err) {
        console.error('guildMemberAdd error:', err);
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
