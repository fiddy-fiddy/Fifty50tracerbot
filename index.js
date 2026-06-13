// FiddyBot - Discord bot with Stripe Payment Link + Discord OAuth integration
// Deploy this to Railway. Required env vars:
//   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_ID,
//   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET,
//   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   PUBLIC_URL (e.g. https://fiddybot-production.up.railway.app),
//   DATABASE_URL (Neon Postgres), PORT (Railway sets this)
//   BREVO_API_KEY, FROM_EMAIL (for emailing the connect link after payment)

const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const express = require('express');
const Stripe = require('stripe');
const { Pool } = require('pg');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ====== POSTGRES (Neon) FOR PERSISTENT SUBSCRIBER STORAGE ======
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Neon drops idle connections — don't let that crash the whole bot.
pool.on('error', (err) => console.error('PG pool error (ignored, will reconnect):', err.message));
// Last-resort safety net so one bad request/promise never kills the bot process.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection (ignored):', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception (ignored):', err));

// Run a query, retrying once if the connection was dropped (Neon idle timeout).
async function dbQuery(text, params) {
    try {
        return await pool.query(text, params);
    } catch (err) {
        console.error('DB query failed, retrying once:', err.message);
        return await pool.query(text, params);
    }
}

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bot_subscribers (
            customer_id TEXT PRIMARY KEY,
            discord_id TEXT NOT NULL,
            username TEXT
        );
        CREATE TABLE IF NOT EXISTS bot_pending (
            username_key TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bot_checkout_sessions (
            session_id TEXT PRIMARY KEY,
            customer_id TEXT NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        ALTER TABLE bot_checkout_sessions ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT FALSE;
    `);
    console.log('Database tables ready.');
}

async function dbSaveCheckoutSession(sessionId, customerId) {
    await dbQuery(
        `INSERT INTO bot_checkout_sessions (session_id, customer_id) VALUES ($1, $2)
         ON CONFLICT (session_id) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
        [sessionId, customerId]
    );
}
async function dbGetCheckoutSession(sessionId) {
    const r = await dbQuery(`SELECT customer_id, used FROM bot_checkout_sessions WHERE session_id = $1`, [sessionId]);
    if (!r.rows[0]) return null;
    return { customerId: r.rows[0].customer_id, used: r.rows[0].used };
}
// Atomically claim a link so it can only ever be used once. Returns customer_id if
// this caller won the claim, or null if it was already used / doesn't exist.
async function dbClaimCheckoutSession(sessionId) {
    const r = await dbQuery(
        `UPDATE bot_checkout_sessions SET used = TRUE WHERE session_id = $1 AND used = FALSE RETURNING customer_id`,
        [sessionId]
    );
    return r.rows[0]?.customer_id || null;
}

async function dbSaveSubscriber(customerId, discordId, username) {
    await dbQuery(
        `INSERT INTO bot_subscribers (customer_id, discord_id, username) VALUES ($1, $2, $3)
         ON CONFLICT (customer_id) DO UPDATE SET discord_id = EXCLUDED.discord_id, username = EXCLUDED.username`,
        [customerId, discordId, username || null]
    );
}
async function dbGetSubscriber(customerId) {
    const r = await dbQuery(`SELECT discord_id FROM bot_subscribers WHERE customer_id = $1`, [customerId]);
    return r.rows[0]?.discord_id || null;
}
async function dbDeleteSubscriber(customerId) {
    await dbQuery(`DELETE FROM bot_subscribers WHERE customer_id = $1`, [customerId]);
}
async function dbSavePending(usernameKey, customerId) {
    await dbQuery(
        `INSERT INTO bot_pending (username_key, customer_id) VALUES ($1, $2)
         ON CONFLICT (username_key) DO UPDATE SET customer_id = EXCLUDED.customer_id`,
        [usernameKey, customerId]
    );
}
async function dbGetPending(usernameKey) {
    const r = await dbQuery(`SELECT customer_id FROM bot_pending WHERE username_key = $1`, [usernameKey]);
    return r.rows[0]?.customer_id || null;
}
async function dbDeletePending(usernameKey) {
    await dbQuery(`DELETE FROM bot_pending WHERE username_key = $1`, [usernameKey]);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// ====== DATA STORAGE (JSON for bot features, DB for subscribers) ======
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

// ====== SWEEP: kick anyone without PAID role or admin perms ======
async function sweepUnpaidMembers() {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const roleId = process.env.DISCORD_ROLE_ID;
        const members = await guild.members.fetch();
        let kicked = 0;
        for (const member of members.values()) {
            if (member.user.bot) continue;
            if (member.id === guild.ownerId) continue;
            if (member.permissions.has(PermissionFlagsBits.Administrator)) continue;
            if (member.permissions.has(PermissionFlagsBits.ManageGuild)) continue;
            if (member.roles.cache.has(roleId)) continue;
            try {
                await member.send(`You were removed from the server because you don't have an active paid subscription. Subscribe again to rejoin.`).catch(() => {});
                await member.kick('No paid role');
                kicked++;
                console.log(`Swept: kicked ${member.user.username}`);
            } catch (e) {
                console.error(`Failed to kick ${member.user.username}:`, e.message);
            }
        }
        console.log(`Sweep complete: kicked ${kicked} unpaid members`);
    } catch (err) {
        console.error('Sweep failed:', err);
    }
}

// ====== BOT READY & COMMAND REGISTRATION ======
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);
    try { await initDb(); } catch (e) { console.error('DB init failed:', e); }

    // Auto-sweep DISABLED on purpose. It kicked EVERY member without the PAID role,
    // including the owner's friends/staff and customers who had paid but not yet
    // clicked their Discord connect link. Removal now happens only via Stripe
    // webhooks (cancel / refund / dispute), which is precise and safe.
    // sweepUnpaidMembers();
    // setInterval(sweepUnpaidMembers, 6 * 60 * 60 * 1000);

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

// ====== #bet-slips: IMAGES/SCREENSHOTS/FILES ONLY + LOG SLIPS ======
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    // Match the bet-slips channel even if it has an emoji/separator in the name
    const cname = (message.channel.name || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!cname.includes('betslips')) return;

    const hasAttachment = message.attachments.size > 0;

    // Staff (owner/mods) can post text freely — e.g. to rank or comment on slips
    const isStaff = message.member?.permissions?.has(PermissionFlagsBits.ManageMessages)
        || message.member?.permissions?.has(PermissionFlagsBits.Administrator);

    // Regular members must post an image/screenshot/file — delete text-only posts
    if (!hasAttachment && !isStaff) {
        try {
            await message.delete();
            const warn = await message.channel.send(`<@${message.author.id}> this channel is for **images / screenshots / files only** — please post your bet slip as an image. 🧾`);
            setTimeout(() => warn.delete().catch(() => {}), 7000);
        } catch (e) {
            console.error('bet-slips delete failed (needs Manage Messages permission?):', e.message);
        }
        return;
    }

    // Only log actual slips (messages that include an attachment); skip staff text notes
    if (!hasAttachment) return;

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
    if (message.author.bot || !message.guild) return;
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
    updateLeaderboardEmbed(message.guild);
});

async function updateLeaderboardEmbed(guild) {
    const lbChannel = guild.channels.cache.find(c => c.name.toLowerCase().includes('leaderboard'));
    if (!lbChannel) return;

    const sorted = Object.entries(leaderboard).sort((a, b) => b[1] - a[1]).slice(0, 10);
    let output = '';
    let rank = 1;

    for (let i = 0; i < sorted.length; i++) {
        const [name, value] = sorted[i];
        if (i > 0 && value !== sorted[i - 1][1]) rank = i + 1;
        const sign = value >= 0 ? '+' : '';
        const medal = rank === 1 ? '🥇 ' : rank === 2 ? '🥈 ' : rank === 3 ? '🥉 ' : '🔹 ';
        output += `${medal}**#${rank}** ${name} • \`${sign}${value}\`\n`;
    }

    const embed = new EmbedBuilder()
        .setTitle('🏆 Fifty50 Leaderboard 🏆')
        .setDescription(output || 'No records yet!')
        .setColor(0x00AE86)
        .setTimestamp()
        .setFooter({ text: 'Fifty50 Betting Community' });

    const messages = await lbChannel.messages.fetch({ limit: 5 });
    await lbChannel.bulkDelete(messages);
    lbChannel.send({ embeds: [embed] });
}

// ====== INTERACTION HANDLER ======
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

    if (commandName === 'addwin') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        const name = options.getString('name');
        const odds = options.getInteger('odds');
        if (!leaderboard[name]) leaderboard[name] = 0;
        leaderboard[name] += odds;
        saveLeaderboard();
        updateLeaderboardEmbed(interaction.guild);
        await interaction.reply(`Added win for ${name}`);
    }

    if (commandName === 'resetleaderboard') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'No permission.', ephemeral: true });
        }
        leaderboard = {};
        saveLeaderboard();
        updateLeaderboardEmbed(interaction.guild);
        await interaction.reply('Leaderboard reset.');
    }
});

// ====== STRIPE WEBHOOK SERVER ======
async function findMemberByUsername(guild, username) {
    const clean = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
    await guild.members.fetch();
    return guild.members.cache.find(m => {
        const u = m.user.username.toLowerCase();
        const n = (m.nickname || '').toLowerCase();
        const g = (m.user.globalName || '').toLowerCase();
        return u === clean || n === clean || g === clean;
    });
}

async function assignRoleByUsername(username, customerId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        const member = await findMemberByUsername(guild, username);
        if (!member) {
            // User hasn't joined the server yet — remember them and assign role when they join
            const key = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
            await dbSavePending(key, customerId);
            console.log(`User ${username} paid but not in server yet — saved as pending`);
            return;
        }
        await member.roles.add(process.env.DISCORD_ROLE_ID);
        await dbSaveSubscriber(customerId, member.id, member.user.username);
        console.log(`Assigned PAID role to ${member.user.username}`);
        try { await member.send(`Welcome! Your subscription is active and your PAID role has been assigned.`); } catch {}
    } catch (err) {
        console.error('Error assigning role:', err);
    }
}

// When someone joins the server, check if they have a pending paid subscription
client.on('guildMemberAdd', async (member) => {
    try {
        const candidates = [
            member.user.username,
            member.user.globalName,
            member.nickname
        ].filter(Boolean).map(n => n.toLowerCase());

        for (const name of candidates) {
            const customerId = await dbGetPending(name);
            if (customerId) {
                await member.roles.add(process.env.DISCORD_ROLE_ID);
                await dbSaveSubscriber(customerId, member.id, member.user.username);
                await dbDeletePending(name);
                console.log(`New member ${member.user.username} matched pending payment — role assigned`);
                try { await member.send(`Welcome! Your subscription is active and your PAID role has been assigned.`); } catch {}
                return;
            }
        }
    } catch (err) {
        console.error('Error in guildMemberAdd:', err);
    }
});

async function removeRoleAndKick(customerId) {
    try {
        const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
        let member = null;
        const discordId = await dbGetSubscriber(customerId);

        if (discordId) {
            member = await guild.members.fetch(discordId).catch(() => null);
        }

        // Fallback: look up the customer's checkout session in Stripe to find their Discord username
        if (!member) {
            console.log(`No mapping for customer ${customerId} — querying Stripe...`);
            try {
                const sessions = await stripe.checkout.sessions.list({ customer: customerId, limit: 1 });
                if (sessions.data.length) {
                    const session = sessions.data[0];
                    let username = null;
                    if (session.custom_fields && session.custom_fields.length) {
                        const field = session.custom_fields.find(f =>
                            (f.key || '').toLowerCase().includes('discord') ||
                            (f.label && f.label.custom && f.label.custom.toLowerCase().includes('discord'))
                        );
                        if (field && field.text) username = field.text.value;
                    }
                    if (username) {
                        member = await findMemberByUsername(guild, username);
                        const key = username.trim().toLowerCase().replace(/^@/, '').split('#')[0];
                        await dbDeletePending(key).catch(() => {});
                    }
                }
            } catch (e) {
                console.error('Stripe lookup failed:', e.message);
            }
        }

        if (member) {
            await member.roles.remove(process.env.DISCORD_ROLE_ID).catch(() => {});
            try { await member.send(`Your subscription has been canceled. You have been removed from the server.`); } catch {}
            await member.kick('Subscription canceled').catch(() => {});
            console.log(`Removed role and kicked ${member.user.username}`);
        } else {
            console.log(`Could not find member to kick for customer ${customerId}`);
        }
        await dbDeleteSubscriber(customerId).catch(() => {});
    } catch (err) {
        console.error('Error removing role:', err);
    }
}

const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const customerId = session.customer;
        if (customerId && session.id) {
            await dbSaveCheckoutSession(session.id, customerId);
            console.log(`Saved checkout session ${session.id} for customer ${customerId}`);
            const email = (session.customer_details && session.customer_details.email) || session.customer_email;
            if (email) {
                await sendConnectEmail(email, session.id).catch(e => console.error('Email send failed:', e.message));
            } else {
                console.log('No customer email on checkout session — could not send connect link');
            }
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        await removeRoleAndKick(sub.customer);
    }

    // Refund or dispute = kick immediately, and also cancel any active subscription
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        const charge = event.data.object;
        const customerId = charge.customer;
        if (customerId) {
            console.log(`Refund/dispute for customer ${customerId} — canceling subscription and kicking`);
            try {
                const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
                for (const sub of subs.data) {
                    if (sub.status !== 'canceled') {
                        await stripe.subscriptions.cancel(sub.id).catch(e => console.error('Cancel failed:', e.message));
                    }
                }
            } catch (e) {
                console.error('Subscription cancel on refund failed:', e.message);
            }
            await removeRoleAndKick(customerId);
        }
    }

    res.json({ received: true });
});

// ====== DISCORD OAUTH CONNECT FLOW ======
function publicUrl() {
    return (process.env.PUBLIC_URL || '').replace(/\/$/, '');
}

// Send the "Connect Discord" link by email via Brevo (free, no credit card)
async function sendConnectEmail(toEmail, sessionId) {
    if (!process.env.BREVO_API_KEY || !process.env.FROM_EMAIL) {
        console.log('Brevo not configured (BREVO_API_KEY / FROM_EMAIL) — skipping email');
        return;
    }
    const link = `${publicUrl()}/connect?session_id=${sessionId}`;
    const html = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h2>Thanks for subscribing!</h2>
            <p>Click the button below to connect your Discord account and unlock your access:</p>
            <p style="text-align:center;margin:28px 0">
                <a href="${link}" style="background:#5865F2;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600">Connect Discord</a>
            </p>
            <p style="color:#666;font-size:13px">If the button doesn't work, copy and paste this link into your browser:<br>${link}</p>
        </div>`;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            sender: { email: process.env.FROM_EMAIL, name: '50fifty' },
            to: [{ email: toEmail }],
            subject: 'Connect your Discord to unlock access',
            htmlContent: html
        })
    });
    if (res.status >= 200 && res.status < 300) {
        console.log(`Connect email sent to ${toEmail}`);
    } else {
        const txt = await res.text();
        console.error(`Brevo error ${res.status}:`, txt);
    }
}
function htmlPage(title, body) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1115;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
.card{background:#1a1d24;padding:40px;border-radius:12px;max-width:420px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)}
h1{margin:0 0 12px;font-size:24px}
p{color:#9aa3b2;line-height:1.5;margin:0 0 24px}
a.btn{display:inline-block;background:#5865F2;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px}
a.btn:hover{background:#4752c4}
.success{color:#4ade80}
.error{color:#f87171}
</style></head><body><div class="card">${body}</div></body></html>`;
}

app.get('/connect', async (req, res) => {
    const sessionId = req.query.session_id;
    if (!sessionId) {
        // No session id (e.g. plain redirect from Stripe) — point them to their email
        return res.send(htmlPage('Payment received', `
            <h1 class="success">Payment received!</h1>
            <p>Check your email for your personal <strong>Connect Discord</strong> link to unlock your access. It should arrive within a minute.</p>
            <p style="font-size:13px;color:#9aa3b2">Don't see it? Check your spam folder.</p>
        `));
    }
    try {
        const row = await dbGetCheckoutSession(sessionId);
        if (!row) {
            return res.status(404).send(htmlPage('Not found', `<h1 class="error">Payment not found yet</h1><p>Your payment is still processing. Please refresh this page in 30 seconds.</p>`));
        }
        if (row.used) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account. If this wasn't you, contact support.</p>`));
        }
        const redirectUri = encodeURIComponent(`${publicUrl()}/oauth/callback`);
        const clientId = process.env.DISCORD_CLIENT_ID;
        const state = encodeURIComponent(sessionId);
        const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=identify%20guilds.join&state=${state}&prompt=consent`;
        res.send(htmlPage('Connect Discord', `
            <h1>Payment received!</h1>
            <p>Click below to connect your Discord account and unlock your access.</p>
            <a class="btn" href="${url}">Connect Discord</a>
        `));
    } catch (err) {
        console.error('/connect error:', err.message);
        res.status(500).send(htmlPage('Try again', `<h1 class="error">One moment</h1><p>We couldn't load your connect page just now. Please refresh this page in a few seconds.</p>`));
    }
});

app.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) {
        return res.status(400).send(htmlPage('Error', `<h1 class="error">Missing code</h1><p>Something went wrong. Please try the connect link again.</p>`));
    }
    const sessionId = decodeURIComponent(state);

    try {
        const row = await dbGetCheckoutSession(sessionId);
        if (!row) {
            return res.status(404).send(htmlPage('Error', `<h1 class="error">Session expired</h1><p>Please use the link from your Stripe receipt again.</p>`));
        }
        if (row.used) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account.</p>`));
        }

        // Exchange code for access token
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: `${publicUrl()}/oauth/callback`
            })
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            console.error('Token exchange failed:', tokenData);
            return res.status(500).send(htmlPage('Error', `<h1 class="error">Connection failed</h1><p>Could not verify your Discord account. Please try again.</p>`));
        }

        // Get user info
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const user = await userRes.json();
        if (!user.id) {
            console.error('User fetch failed:', user);
            return res.status(500).send(htmlPage('Error', `<h1 class="error">Connection failed</h1><p>Could not read your Discord account.</p>`));
        }

        // Atomically claim the link so it can never be reused/shared
        const customerId = await dbClaimCheckoutSession(sessionId);
        if (!customerId) {
            return res.status(409).send(htmlPage('Already used', `<h1 class="error">This link has already been used</h1><p>This access link can only be used once and has already connected a Discord account.</p>`));
        }

        // Add user to guild with PAID role (or update if already a member)
        const guildId = process.env.DISCORD_GUILD_ID;
        const roleId = process.env.DISCORD_ROLE_ID;
        const addRes = await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                access_token: tokenData.access_token,
                roles: [roleId]
            })
        });

        if (addRes.status === 204) {
            // Already in server — just add the role
            await fetch(`https://discord.com/api/guilds/${guildId}/members/${user.id}/roles/${roleId}`, {
                method: 'PUT',
                headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }
            });
        } else if (!addRes.ok) {
            const errText = await addRes.text();
            console.error('Failed to add member:', addRes.status, errText);
        }

        await dbSaveSubscriber(customerId, user.id, user.username);
        console.log(`Connected ${user.username} (${user.id}) to customer ${customerId}`);

        res.send(htmlPage('Success', `
            <h1 class="success">You're in!</h1>
            <p>Your Discord account is connected and your PAID role is active. You can close this tab and open Discord.</p>
        `));
    } catch (err) {
        console.error('OAuth callback error:', err);
        res.status(500).send(htmlPage('Error', `<h1 class="error">Something went wrong</h1><p>Please try the connect link again.</p>`));
    }
});

const BUILD_MARKER = 'betslips-enforce-2026-06-13-1';
app.get('/', (_req, res) => {
    let betSlips = 'unknown';
    try {
        const g = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (!g) {
            betSlips = 'guild-not-cached';
        } else {
            const ch = g.channels.cache.find(c => c.name && c.name.toLowerCase().replace(/[^a-z]/g, '').includes('betslips'));
            betSlips = ch ? { id: ch.id, name: ch.name } : 'not-found';
        }
    } catch (e) {
        betSlips = 'err:' + e.message;
    }
    res.json({
        status: 'FiddyBot is running!',
        build: BUILD_MARKER,
        botReady: client.isReady(),
        botTag: client.user ? client.user.tag : null,
        betSlipsChannel: betSlips
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`Webhook server listening on port ${PORT}`));

// ====== LOGIN ======
client.login(process.env.DISCORD_BOT_TOKEN);

