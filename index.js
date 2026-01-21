client.on('interactionCreate', async interaction => {
if (!interaction.isChatInputCommand()) return;

try {
// 🔑 CRITICAL: acknowledge immediately
await interaction.deferReply();

const { commandName, options, user } = interaction;

// FOLLOW
if (commandName === 'follow') {
const target = options.getUser('target');
if (!followers[user.id]) followers[user.id] = [];
if (!followers[user.id].includes(target.id)) {
followers[user.id].push(target.id);
saveFollowers();
return interaction.editReply(`You are now following **${target.username}**`);
}
return interaction.editReply(`You are already following **${target.username}**`);
}

// UNFOLLOW
if (commandName === 'unfollow') {
const target = options.getUser('target');
if (followers[user.id]) {
followers[user.id] = followers[user.id].filter(id => id !== target.id);
saveFollowers();
}
return interaction.editReply(`You unfollowed **${target.username}**`);
}

// FOLLOWING
if (commandName === 'following') {
const followed = followers[user.id] || [];
if (followed.length === 0) {
return interaction.editReply('You are not following anyone.');
}
const names = followed
.map(id => client.users.cache.get(id)?.username || 'Unknown')
.join('\n- ');
return interaction.editReply(`You are following:\n- ${names}`);
}

// FEED
if (commandName === 'feed') {
const followed = followers[user.id] || [];
if (followed.length === 0) {
return interaction.editReply('You are not following anyone.');
}
const recentSlips = slips
.filter(slip => followed.includes(slip.userId))
.slice(-5)
.map(slip => `${slip.username}: ${slip.content} ${slip.attachmentUrl || ''}`)
.join('\n\n');

return interaction.editReply(recentSlips || 'No recent slips from followed users.');
}

// ALERTS
if (commandName === 'alerts') {
const toggle = options.getString('state');
alerts[user.id] = toggle.toLowerCase() === 'on';
saveAlerts();
return interaction.editReply(`DM alerts turned **${toggle.toUpperCase()}**`);
}

// VERIFY WIN (admin)
if (commandName === 'verifywin') {
if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
return interaction.editReply('You do not have permission to use this command.');
}

const target = options.getUser('target');
leaderboard[target.id] = (leaderboard[target.id] || 0) + 1;
saveLeaderboard();

return interaction.editReply(`Recorded win for ${target.username}`);
}

// ADD WIN
if (commandName === 'addwin') {
if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
return interaction.editReply('You do not have permission to use this command.');
}

const name = options.getString('name');
const odds = options.getInteger('odds');

leaderboard[name] = (leaderboard[name] || 0) + odds;
saveLeaderboard();

return interaction.editReply(`Added ${odds > 0 ? '+' : ''}${odds} to ${name}'s record`);
}

// RESET LEADERBOARD
if (commandName === 'resetleaderboard') {
if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
return interaction.editReply('You do not have permission to use this command.');
}

leaderboard = {};
saveLeaderboard();
return interaction.editReply('Leaderboard has been completely reset.');
}

} catch (err) {
console.error(err);
if (interaction.deferred) {
await interaction.editReply('⚠️ An error occurred.');
}
}
});
