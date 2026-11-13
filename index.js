require('dotenv').config();
const http = require('node:http');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const required = ['DISCORD_TOKEN','GUILD_ID','TICKET_CATEGORY_ID','STAFF_ROLE_ID','API_BASE_URL','API_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
if (process.env.API_SECRET.length < 40) throw new Error('API_SECRET must be at least 40 characters.');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const API = process.env.API_BASE_URL.replace(/\/+$/,'');
const headers = { 'X-API-Secret': process.env.API_SECRET };
const maxUpload = Number(process.env.MAX_DISCORD_UPLOAD_BYTES || 8000000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(action, params={}) {
  const url = new URL(API);
  url.searchParams.set('action', action);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Website API ${res.status}: ${(await res.text()).slice(0,300)}`);
  return res;
}
async function apiPost(action, body) {
  const url = new URL(API); url.searchParams.set('action', action);
  const res = await fetch(url, { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Website API ${res.status}: ${(await res.text()).slice(0,300)}`);
  return res.json();
}
async function downloadFiles(items) {
  const result=[];
  for (const item of items || []) {
    if (Number(item.file_size) > maxUpload) continue;
    try {
      const res=await apiGet('file',{id:item.id});
      const buf=Buffer.from(await res.arrayBuffer());
      if(buf.length<=maxUpload) result.push(new AttachmentBuilder(buf,{name:item.original_name}));
    } catch(err) { console.warn('Could not fetch attachment',item.original_name,err.message); }
  }
  return result;
}
function safeChannelName(code) { return `complaint-${code.toLowerCase().replace(/[^a-z0-9-]/g,'').slice(-18)}`; }

async function createComplaintChannel(guild, c) {
  const existing = guild.channels.cache.find(ch => ch.topic && ch.topic.includes(`complaint_id=${c.id}`));
  if (existing) return existing;
  const channel = await guild.channels.create({
    name: safeChannelName(c.ticket_code),
    type: ChannelType.GuildText,
    parent: process.env.TICKET_CATEGORY_ID,
    topic: `Dibiaa Customer Support | ${c.ticket_code} | complaint_id=${c.id}`,
    permissionOverwrites: [
      { id:guild.roles.everyone.id, deny:[PermissionFlagsBits.ViewChannel] },
      { id:process.env.STAFF_ROLE_ID, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.EmbedLinks] },
      { id:client.user.id, allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageChannels,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.EmbedLinks] }
    ]
  });
  const embed = new EmbedBuilder()
    .setColor(0xe11d48).setTitle(`New Customer Complaint • ${c.ticket_code}`)
    .setDescription(c.description.slice(0,4000))
    .addFields(
      {name:'Customer',value:c.customer_name.slice(0,1024),inline:true},
      {name:'Mobile',value:c.mobile.slice(0,1024),inline:true},
      {name:'Category',value:c.category.slice(0,1024),inline:true},
      {name:'Email',value:(c.email||'Not provided').slice(0,1024),inline:true},
      {name:'Company',value:(c.company||'Not provided').slice(0,1024),inline:true},
      {name:'Order / Invoice ID',value:(c.order_id||'Not provided').slice(0,1024),inline:true},
      {name:'Submitted',value:String(c.created_at).slice(0,100),inline:false}
    ).setFooter({text:'Dibiaa Customer Support • Website complaint record'});
  const files=await downloadFiles(c.files);
  const fileText=(c.files||[]).map(f=>`• ${f.original_name} (${(Number(f.file_size)/1048576).toFixed(2)} MB)`).join('\n');
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cs_status:${c.id}:In Progress`).setLabel('Start Working').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`cs_status:${c.id}:Resolved`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cs_status:${c.id}:Closed`).setLabel('Close').setStyle(ButtonStyle.Secondary)
  );
  const websiteRoot = process.env.API_BASE_URL.replace(/\/api\.php.*$/, '');
  await channel.send({content:`<@&${process.env.STAFF_ROLE_ID}> **A new customer complaint has been received.**\nWebsite record: ${websiteRoot}/complaint.php?id=${c.id}\n${fileText ? `\n**Attachments:**\n${fileText}` : '\nNo attachments uploaded.'}`, embeds:[embed], files, components:[controls]});
  return channel;
}

async function processQueue() {
  while (client.isReady()) {
    try {
      const res=await apiGet('next');
      const data=await res.json();
      if(data.complaint) {
        const c=data.complaint;
        try {
          const guild=await client.guilds.fetch(process.env.GUILD_ID);
          const channel=await createComplaintChannel(guild,c);
          const last=await channel.messages.fetch({limit:1});
          const message=last.first();
          await apiPost('complete',{id:c.id,channel_id:channel.id,message_id:message?.id||''});
          console.log(`Created/confirmed ${c.ticket_code} -> ${channel.id}`);
        } catch(err) {
          console.error('Complaint processing failed:',err);
          await apiPost('failed',{id:c.id,error:err.message}).catch(e=>console.error('Could not report failure:',e.message));
        }
      }
    } catch(err) { console.error('Queue/API error:',err.message); }
    await sleep(Number(process.env.POLL_INTERVAL_MS||7000));
  }
}
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton() || !interaction.customId.startsWith('cs_status:')) return;
  try {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels) &&
        !interaction.member?.roles?.cache?.has(process.env.STAFF_ROLE_ID)) {
      return interaction.reply({content:'You do not have permission to update this complaint.',ephemeral:true});
    }
    const [, rawId, status] = interaction.customId.split(':');
    const id = Number(rawId);
    if (!id || !['In Progress','Resolved','Closed'].includes(status)) {
      return interaction.reply({content:'Invalid complaint action.',ephemeral:true});
    }
    await apiPost('status',{id,status});
    await interaction.reply({content:`Complaint status updated to **${status}**. Website dashboard has been synchronized.`,ephemeral:true});
  } catch (err) {
    console.error('Status update failed:',err);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({content:'Could not update status. Please try again.',ephemeral:true}).catch(()=>{});
  }
});
client.once('ready', () => { console.log(`Logged in as ${client.user.tag} | Dibiaa Customer Support`); processQueue(); });
client.on('error', e=>console.error('Discord client error:',e));
process.on('unhandledRejection', e=>console.error('Unhandled rejection:',e));
process.on('SIGTERM',()=>{console.log('Shutting down');client.destroy();process.exit(0);});

// Render Web Service requires an HTTP listener. This endpoint is for health checks.
const port = Number(process.env.PORT || 10000);
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    const ready = client.isReady();
    res.writeHead(ready ? 200 : 503, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({ok: ready, service: 'Dibiaa Customer Support', discord: ready ? 'connected' : 'connecting'}));
    return;
  }
  res.writeHead(404, {'Content-Type':'application/json'});
  res.end(JSON.stringify({ok:false,error:'Not found'}));
});
healthServer.listen(port, '0.0.0.0', () => console.log(`Health server listening on ${port}`));

client.login(process.env.DISCORD_TOKEN);
