require('dotenv').config();

const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    AttachmentBuilder
} = require('discord.js');

const { ethers } = require('ethers');
const qrcode = require('qrcode');
const axios = require('axios');
const moment = require('moment');
const database = require('better-sqlite3');
const shortid = require('shortid');

const db = new database('transactions.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT UNIQUE,
        user_id TEXT,
        amount TEXT,
        status TEXT,
        product_key TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        paid_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT,
        action TEXT,
        details TEXT,
        timestamp DATETIME DEFAULT (datetime('now')),
        FOREIGN KEY(transaction_id) REFERENCES transactions(transaction_id)
    );

    CREATE TABLE IF NOT EXISTS cooldowns (
        user_id TEXT PRIMARY KEY,
        last_used DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS used_amounts (
        amount TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT (datetime('now'))
    );
`);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

const contract_address = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const ethaddy = process.env.MERCHANT_ADDRESS; // your ETH address
const product_price = 1;
const tracking_fee = 0.21;
const cooldown_time = 30 * 60 * 1000; 
const etherscan_api = 'https://api.etherscan.io/api';

const activetransactions = new Map();


function generateuniqueamount() {
    const baseamount = product_price + tracking_fee;
    let uniqueamount;
    let isunique = false;

    while (!isunique) {
        const randomaddition = (Math.floor(Math.random() * 99) + 1) / 10000;
        uniqueamount = (baseamount + randomaddition).toFixed(4);

        const stmt = db.prepare(`
            SELECT amount 
            FROM used_amounts 
            WHERE amount = ? 
            AND created_at > datetime('now', '-1 day')
        `);
        const exists = stmt.get(uniqueamount);

        if (!exists) {
            const insertstmt = db.prepare(`
                INSERT INTO used_amounts (amount, created_at) 
                VALUES (?, datetime('now'))
            `);
            insertstmt.run(uniqueamount);
            isunique = true;
        }
    }

    return uniqueamount;
}

function cleanupusedamounts() {
    const stmt = db.prepare(`
        DELETE FROM used_amounts 
        WHERE created_at < datetime('now', '-1 day')
    `);
    stmt.run();
}

setInterval(cleanupusedamounts, 3600000);

function addtransaction(transactiondata) {
    const stmt = db.prepare(`
        INSERT INTO transactions (
            transaction_id, user_id, amount, status, created_at
        ) VALUES (?, ?, ?, ?, datetime('now'))
    `);
    
    stmt.run(
        transactiondata.transactionid,
        transactiondata.userid,
        transactiondata.amount,
        transactiondata.status
    );
}

function addauditlog(transactionid, action, details) {
    const stmt = db.prepare(`
        INSERT INTO audit_logs (
            transaction_id, action, details, timestamp
        ) VALUES (?, ?, ?, datetime('now'))
    `);
    
    stmt.run(
        transactionid,
        action,
        details
    );
}

function gettransaction(transactionid) {
    const stmt = db.prepare(`
        SELECT t.*, GROUP_CONCAT(
            json_object(
                'action', al.action,
                'details', al.details,
                'timestamp', al.timestamp
            )
        ) as audit_logs
        FROM transactions t
        LEFT JOIN audit_logs al ON t.transaction_id = al.transaction_id
        WHERE t.transaction_id = ?
        GROUP BY t.transaction_id
    `);
    
    return stmt.get(transactionid);
}

function updatetransactionstatus(transactionid, status, productkey = null) {
    const stmt = db.prepare(`
        UPDATE transactions 
        SET status = ?, 
            product_key = ?, 
            paid_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE null END
        WHERE transaction_id = ?
    `);
    
    stmt.run(
        status,
        productkey,
        status,
        transactionid
    );
}

function isadmin(member) {
    return member.permissions.has('Administrator');
}

function checkcooldown(userid) {
    const stmt = db.prepare('SELECT last_used FROM cooldowns WHERE user_id = ?');
    const cooldown = stmt.get(userid);
    
    if (!cooldown) return false;
    
    const timepassed = Date.now() - new Date(cooldown.last_used).getTime();
    return timepassed < cooldown_time;
}

function updatecooldown(userid) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO cooldowns (user_id, last_used)
        VALUES (?, datetime('now'))
    `);
    
    stmt.run(userid);
}

function generatetransferdata(to, amount) {
    const transferfunction = 'transfer(address,uint256)';
    const functionhash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(transferfunction)).slice(0, 10);
    const encodedparams = ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [to, amount]);
    return functionhash + encodedparams.slice(2);
}

function generateproductkey() {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const segments = 4;
    const segmentlength = 4;
    
    let key = [];
    for(let i = 0; i < segments; i++) {
        let segment = '';
        for(let j = 0; j < segmentlength; j++) {
            segment += charset[Math.floor(Math.random() * charset.length)];
        }
        key.push(segment);
    }
    
    return key.join('-');
}

async function updateembed(transaction, status, remaining = 0) {
    try {
        const channel = await client.channels.fetch(transaction.channelid);
        const message = await channel.messages.fetch(transaction.messageid);
        const embed = message.embeds[0].toJSON();
        const newembed = new EmbedBuilder(embed);

        switch (status) {
            case 'waiting':
                newembed.setFields(
                    { name: 'Transaction ID', value: transaction.transactionid },
                    { name: 'Wallet Address', value: ethaddy },
                    { name: 'Amount (USDT)', value: ethers.utils.formatUnits(transaction.amount, 6) },
                    { name: 'Status', value: '⏳ Waiting for payment...' },
                    { name: 'Time Remaining', value: moment.duration(remaining).minutes() + ':' + 
                        moment.duration(remaining).seconds().toString().padStart(2, '0') }
                );
                break;
            case 'expired':
                newembed
                    .setColor('#ff0000')
                    .setFields(
                        { name: 'Transaction ID', value: transaction.transactionid },
                        { name: 'Wallet Address', value: ethaddy },
                        { name: 'Amount (USDT)', value: ethers.utils.formatUnits(transaction.amount, 6) },
                        { name: 'Status', value: '❌ Payment expired' }
                    );
                break;
            case 'cancelled':
                newembed
                    .setColor('#ff0000')
                    .setFields(
                        { name: 'Transaction ID', value: transaction.transactionid },
                        { name: 'Wallet Address', value: ethaddy },
                        { name: 'Amount (USDT)', value: ethers.utils.formatUnits(transaction.amount, 6) },
                        { name: 'Status', value: '❌ Payment cancelled by admin' }
                    );
                break;
            case 'success':
                newembed
                    .setColor('#00ff00')
                    .setFields(
                        { name: 'Transaction ID', value: transaction.transactionid },
                        { name: 'Wallet Address', value: ethaddy },
                        { name: 'Amount (USDT)', value: ethers.utils.formatUnits(transaction.amount, 6) },
                        { name: 'Status', value: '✅ Payment successful' },
                        { name: 'Product Key', value: transaction.productkey }
                    );
                break;
        }

        await message.edit({ embeds: [newembed] });
    } catch (error) {
        console.error('Error updating embed:', error);
        addauditlog(transaction.transactionid, 'ERROR', `Failed to update embed: ${error.message}`);
    }
}

async function handlesuccessfulpayment(transaction) {
    try {
        const productkey = generateproductkey();
        transaction.productkey = productkey;

        updatetransactionstatus(transaction.transactionid, 'completed', productkey);
        addauditlog(transaction.transactionid, 'COMPLETED', 'Payment received and verified');

        await updateembed(transaction, 'success');

        const guild = client.guilds.cache.first();
        const member = await guild.members.fetch(transaction.userid);

        const role = guild.roles.cache.find(r => r.name === 'Product Owner');
        if (role) {
            await member.roles.add(role);
            addauditlog(transaction.transactionid, 'ROLE_ADDED', `Added role: ${role.name}`);
        }

        const dmembed = new EmbedBuilder()
            .setTitle('Purchase Successful!')
            .setColor('#00ff00')
            .setDescription('Thank you for your purchase!')
            .addFields(
                { name: 'Transaction ID', value: transaction.transactionid },
                { name: 'Product Key', value: productkey },
                { name: 'Amount Paid', value: `${ethers.utils.formatUnits(transaction.amount, 6)} USDT` }
            )
            .setTimestamp();

        await member.send({ embeds: [dmembed] });
        addauditlog(transaction.transactionid, 'DM_SENT', 'Product key sent to user');

    } catch (error) {
        console.error('Error handling successful payment:', error);
        addauditlog(transaction.transactionid, 'ERROR', `Payment handling error: ${error.message}`);
    }
}

async function monitortransaction(uniqueamount, interaction) {
    const transaction = activetransactions.get(uniqueamount);
    if (!transaction) return;

    const starttime = Date.now();
    const timelimit = 30 * 60 * 1000; 
    let lastupdate = starttime;
    let lastcheckedblock = 'latest';

    const checkinterval = setInterval(async () => {
        try {
            const elapsed = Date.now() - starttime;
            const remaining = timelimit - elapsed;

            if (remaining <= 0) {
                clearInterval(checkinterval);
                await updateembed(transaction, 'expired');
                updatetransactionstatus(transaction.transactionid, 'expired');
                addauditlog(transaction.transactionid, 'EXPIRED', 'Transaction time limit reached');
                activetransactions.delete(uniqueamount);
                return;
            }

            if (Date.now() - lastupdate >= 30000) {
                await updateembed(transaction, 'waiting', remaining);
                lastupdate = Date.now();
            }

            const response = await axios.get(etherscan_api, {
                params: {
                    module: 'account',
                    action: 'tokentx',
                    contractaddress: contract_address,
                    address: ethaddy,
                    startblock: lastcheckedblock,
                    endblock: 'latest',
                    sort: 'desc',
                    apikey: process.env.ETHERSCAN_API_KEY
                }
            });

            if (response.data.status === '1' && response.data.result.length > 0) {
                lastcheckedblock = response.data.result[0].blockNumber;

                for (const tx of response.data.result) {
                    const txamount = tx.value;
                    if (txamount === transaction.amount) {
                        clearInterval(checkinterval);
                        addauditlog(transaction.transactionid, 'PAYMENT_DETECTED', `Transaction hash: ${tx.hash}`);
                        await handlesuccessfulpayment(transaction);
                        activetransactions.delete(uniqueamount);
                        return;
                    }
                }
            }

        } catch (error) {
            console.error('Error monitoring transaction:', error);
            addauditlog(transaction.transactionid, 'MONITOR_ERROR', `Error: ${error.message}`);
        }
    }, 10000);
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    
    const commands = [
        {
            name: 'purchase',
            description: 'Purchase the product with USDT'
        },
        {
            name: 'transaction',
            description: 'Check transaction status (Admin Only)',
            options: [{
                name: 'id',
                type: 3,
                description: 'Transaction ID',
                required: true
            }],
            default_member_permissions: '8' 
        }
    ];

    await client.application.commands.set(commands);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

 

    if (interaction.commandName === 'purchase') {
        try {
            if (checkcooldown(interaction.user.id)) {
                const cooldown = db.prepare('SELECT last_used FROM cooldowns WHERE user_id = ?').get(interaction.user.id);
                const remainingtime = moment.duration(cooldown_time - (Date.now() - new Date(cooldown.last_used).getTime()));
                await interaction.reply({
                    content: `Please wait ${remainingtime.minutes()}m ${remainingtime.seconds()}s before making another purchase.`,
                    ephemeral: true
                });
                return;
            }
    
            const transactionid = shortid.generate();
            const uniqueamount = generateuniqueamount();
            const usdtamount = ethers.utils.parseUnits(uniqueamount, 6).toString();
    
            const qrdata = `ethereum:${ethaddy}?value=${usdtamount}&data=${
                generatetransferdata(ethaddy, usdtamount)
            }`;
    
            const qrcodebuffer = await qrcode.toBuffer(qrdata);
            const attachment = new AttachmentBuilder(qrcodebuffer, { name: 'qr_code.png' });
    
            const embed = new EmbedBuilder()
                .setTitle('Purchase Product - USDT Payment')
                .setDescription(`Please send exactly ${uniqueamount} USDT (ERC20)`)
                .setColor('#0099ff')
                .addFields(
                    { name: 'Transaction ID', value: transactionid },
                    { name: 'Wallet Address', value: ethaddy },
                    { name: 'Amount (USDT)', value: uniqueamount.toString() },
                    { name: 'Network', value: 'Ethereum (ERC20)' },
                    { name: 'Status', value: '⏳ Waiting for payment...' },
                    { name: 'Time Remaining', value: '30:00' }
                )
                .setImage('attachment://qr_code.png')
                .setFooter({ text: 'Send exact amount to avoid transaction issues' })
                .setTimestamp();
    
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('View Transaction')
                        .setCustomId(`view_${transactionid}`)
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setLabel('Copy Address')
                        .setCustomId(`copy_address_${transactionid}`)
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setLabel('Copy Amount')
                        .setCustomId(`copy_amount_${transactionid}`)
                        .setStyle(ButtonStyle.Secondary)
                );
    
            const response = await interaction.reply({
                embeds: [embed],
                files: [attachment],
                components: [row],
                fetchReply: true
            });
    
            addtransaction({
                transactionid,
                userid: interaction.user.id,
                amount: usdtamount,
                status: 'pending'
            });
    
            addauditlog(
                transactionid,
                'CREATED',
                `Transaction created by ${interaction.user.tag}`
            );
    
            updatecooldown(interaction.user.id);
    
            activetransactions.set(uniqueamount, {
                transactionid,
                userid: interaction.user.id,
                messageid: response.id,
                channelid: interaction.channelId,
                amount: usdtamount,
                timestamp: Date.now(),
                paid: false
            });
    
            monitortransaction(uniqueamount, interaction);
    
            try {
                const dmembed = new EmbedBuilder()
                    .setTitle('Payment Instructions')
                    .setColor('#0099ff')
                    .setDescription('Please follow these steps to complete your purchase:')
                    .addFields(
                        { name: 'Transaction ID', value: transactionid, inline: true },
                        { name: 'Amount', value: `${uniqueamount} USDT`, inline: true },
                        { name: 'Network', value: 'Ethereum (ERC20)', inline: true },
                        { name: 'Address', value: ethaddy },
                        { 
                            name: 'Important Notes', 
                            value: '• Send exact amount\n• Use ERC20 network only\n• Transaction expires in 30 minutes' 
                        }
                    )
                    .setTimestamp();
    
                await interaction.user.send({
                    content: 'Here are your payment details:',
                    embeds: [dmembed],
                    files: [attachment]
                });
    
                addauditlog(
                    transactionid,
                    'DM_SENT',
                    'Payment instructions sent via DM'
                );
            } catch (dmerror) {
                console.error('Failed to send DM:', dmerror);
                addauditlog(
                    transactionid,
                    'DM_FAILED',
                    'Failed to send payment instructions via DM'
                );
            }
    
        } catch (error) {
            console.error('Purchase command error:', error);
            
            try {
                await interaction.reply({
                    content: 'An error occurred while processing your purchase. Please try again later.',
                    ephemeral: true
                });
            } catch (replyerror) {
                try {
                    await interaction.followUp({
                        content: 'An error occurred while processing your purchase. Please try again later.',
                        ephemeral: true
                    });
                } catch (followuperror) {
                    console.error('Failed to send error message:', followuperror);
                }
            }
        }
    }



    if (interaction.commandName === 'transaction') {
        try {
            if (!isadmin(interaction.member)) {
                await interaction.reply({
                    content: '❌ This command is only available to administrators.',
                    flags: { ephemeral: true }
                });
                return;
            }

            const transactionid = interaction.options.getString('id');
            const transaction = gettransaction(transactionid);

            if (!transaction) {
                await interaction.reply({
                    content: 'Transaction not found.',
                    flags: { ephemeral: true }
                });
                return;
            }

            const user = await client.users.fetch(transaction.user_id).catch(() => null);
            const userinfo = user ? `${user.tag} (${user.id})` : transaction.user_id;

            const auditlogs = JSON.parse(`[${transaction.audit_logs}]`);

            const embed = new EmbedBuilder()
                .setTitle(`Transaction Details: ${transactionid}`)
                .setColor('#0099ff')
                .addFields(
                    { name: 'User', value: userinfo },
                    { name: 'Status', value: transaction.status },
                    { name: 'Amount', value: ethers.utils.formatUnits(transaction.amount, 6) + ' USDT' },
                    { name: 'Created', value: moment(transaction.created_at).format('YYYY-MM-DD HH:mm:ss') }
                )
                .setTimestamp();

            if (transaction.paid_at) {
                embed.addFields({
                    name: 'Paid At',
                    value: moment(transaction.paid_at).format('YYYY-MM-DD HH:mm:ss')
                });
            }

            const auditlogtext = auditlogs
                .map(log => `${moment(log.timestamp).format('YYYY-MM-DD HH:mm:ss')} - ${log.action}: ${log.details}`)
                .join('\n');

            embed.addFields({ 
                name: 'Audit Log', 
                value: auditlogtext || 'No audit log available'
            });

            if (transaction.product_key) {
                embed.addFields({ 
                    name: 'Product Key', 
                    value: transaction.product_key 
                });
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`cancel_${transactionid}`)
                        .setLabel('Cancel Transaction')
                        .setStyle(ButtonStyle.Danger)
                        .setDisabled(transaction.status !== 'pending'),
                    new ButtonBuilder()
                        .setCustomId(`resend_${transactionid}`)
                        .setLabel('Resend Key')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(!transaction.product_key)
                );

            await interaction.reply({
                embeds: [embed],
                components: [row]
            });

        } catch (error) {
            console.error(error);
            await interaction.reply({
                content: 'An error occurred while fetching transaction details.',
                flags: { ephemeral: true }
            });
        }
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, transactionid] = interaction.customId.split('_');

    if (action === 'view') {
        try {
            const transaction = gettransaction(transactionid);
            if (!transaction) {
                await interaction.reply({
                    content: 'Transaction not found.',
                    flags: { ephemeral: true }
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle(`Transaction Status: ${transactionid}`)
                .setColor('#0099ff')
                .addFields(
                    { name: 'Status', value: transaction.status },
                    { name: 'Amount', value: ethers.utils.formatUnits(transaction.amount, 6) + ' USDT' },
                    { name: 'Created', value: moment(transaction.created_at).format('YYYY-MM-DD HH:mm:ss') }
                )
                .setTimestamp();

            await interaction.reply({
                embeds: [embed],
                flags: { ephemeral: true }
            });
        } catch (error) {
            console.error(error);
            await interaction.reply({
                content: 'An error occurred while fetching transaction details.',
                flags: { ephemeral: true }
            });
        }
        return;
    }

    if (!isadmin(interaction.member)) {
        await interaction.reply({
            content: '❌ This action is only available to administrators.',
            flags: { ephemeral: true }
        });
        return;
    }

    try {
        const transaction = gettransaction(transactionid);
        if (!transaction) {
            await interaction.reply({
                content: 'Transaction not found.',
                flags: { ephemeral: true }
            });
            return;
        }

        switch (action) {
            case 'cancel':
                if (transaction.status === 'pending') {
                    updatetransactionstatus(transactionid, 'cancelled');
                    addauditlog(
                        transactionid,
                        'CANCELLED',
                        `Transaction cancelled by admin ${interaction.user.tag}`
                    );
                    await updateembed(transaction, 'cancelled');
                    await interaction.reply({
                        content: `Transaction ${transactionid} has been cancelled.`,
                        flags: { ephemeral: true }
                    });
                }
                break;

            case 'resend':
                if (transaction.product_key) {
                    const user = await client.users.fetch(transaction.user_id);
                    const dmembed = new EmbedBuilder()
                        .setTitle('Product Key Resent')
                        .setColor('#00ff00')
                        .setDescription('Your product key has been resent by an administrator.')
                        .addFields(
                            { name: 'Transaction ID', value: transactionid },
                            { name: 'Product Key', value: transaction.product_key }
                        )
                        .setTimestamp();

                    await user.send({ embeds: [dmembed] });
                    addauditlog(
                        transactionid,
                        'KEY_RESENT',
                        `Product key resent by admin ${interaction.user.tag}`
                    );
                    await interaction.reply({
                        content: `Product key has been resent to the user.`,
                        flags: { ephemeral: true }
                    });
                }
                break;
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({
            content: 'An error occurred while processing your request.',
            flags: { ephemeral: true }
        });
    }
});

client.on('error', error => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);