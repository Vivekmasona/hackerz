import 'dotenv/config';
import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not set in .env");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Start command
bot.start((ctx) => ctx.reply('✅ Welcome! Send me any URL and I will fetch media links.'));

// Text handler
bot.on('text', async (ctx) => {
  const userUrl = ctx.message.text.trim();
  if (!userUrl.startsWith('http')) {
    return ctx.reply('❌ Please send a valid URL starting with http or https.');
  }

  const apiUrl = `https://scontent.onrender.com/cdn?url=${encodeURIComponent(userUrl)}`;
  const loadingMessage = await ctx.reply('⏳ Fetching media links...');

  try {
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMessage.message_id,
        null,
        '⚠️ No media found!'
      );
    }

    const messages = data.results.map((item, i) => {
      return `${i + 1}. [${item.type.toUpperCase()}] ${item.url}`;
    }).join('\n');

    // Telegram has a 4096 char limit per message, split if needed
    const chunks = [];
    let chunk = '';
    for (const line of messages.split('\n')) {
      if ((chunk + line + '\n').length > 4000) {
        chunks.push(chunk);
        chunk = '';
      }
      chunk += line + '\n';
    }
    if (chunk) chunks.push(chunk);

    // Edit initial message
    await ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, null, '✅ Media links found!');

    for (const c of chunks) {
      await ctx.reply(c);
    }

  } catch (err) {
    console.error(err);
    ctx.telegram.editMessageText(ctx.chat.id, loadingMessage.message_id, null, '❌ Failed to fetch media.');
  }
});

// Launch bot
bot.launch();
console.log('🤖 Telegram bot running...');
