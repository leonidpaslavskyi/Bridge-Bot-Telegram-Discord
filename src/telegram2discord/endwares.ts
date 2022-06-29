import R from "ramda";
import { MessageMap } from "../MessageMap";
import { sleepOneMinute } from "../sleep";
import { fetchDiscordChannel } from "../fetchDiscordChannel";
import { Context } from "telegraf";
import { deleteMessage, ignoreAlreadyDeletedError } from "./helpers";
import { createFromObjFromUser } from "./From";
import { MessageEditOptions } from "discord.js";
import { Message, User } from "telegraf/typings/core/types/typegram";

export interface ProtoCrossContext extends Context {
	ProtoVerse: any;
	protoVerse: {
		message: Message | any;
		file: {
			type: string;
			id: string;
			name: string;
			link?: string;
		};
		messageId: string;
		prepared: any;
		bridges: any;
		replyTo: any;
		text: any;
		forwardFrom: any;
		from: any;
	};
}

/***********
 * Helpers *
 ***********/

/**
 * Makes an endware function be handled by all bridges it applies to. Curried
 *
 * @param func	The message handler to wrap
 * @param ctx	The Telegraf context
 */
const createMessageHandler = R.curry((func, ctx) => {
	// Wait for the Discord bot to become ready
	ctx.protoVerse.dcBot.ready.then(() => R.forEach(bridge => func(ctx, bridge))(ctx.protoVerse.bridges));
});

/*************************
 * The endware functions *
 *************************/

/**
 * Replies to a message with info about the chat
 *
 * @param ctx	The Telegraf context
 * @param ctx.protoVerse	The ProtoVerse object on the context
 * @param ctx.protoVerse.message	The message to reply to
 * @param ctx.protoVerse.message.chat	The object of the chat the message is from
 * @param ctx.protoVerse.message.chat.id	ID of the chat the message is from
 */
export const chatinfo = (ctx: ProtoCrossContext, next: () => void) => {
	if (ctx.protoVerse.message.text === "/chatinfo") {
		// Reply with the info
		ctx.reply(`chatID: ${ctx.protoVerse.message.chat.id}`)
			// Wait some time
			.then(sleepOneMinute)
			// Delete the info and the command
			.then(message =>
				Promise.all([
					// Delete the info
					deleteMessage(ctx, message),
					// Delete the command
					ctx.deleteMessage()
				])
			)
			.catch(ignoreAlreadyDeletedError);
	} else {
		next();
	}
};

/**
 * Handles users joining chats
 *
 * @param ctx The Telegraf context
 * @param ctx.protoVerse.message The Telegram message received
 * @param ctx.protoVerse.message.new_chat_members List of the users who joined the chat
 * @param ctx.protoVerse The global ProtoVerse context of the message
 */
export const newChatMembers = createMessageHandler((ctx: ProtoCrossContext, bridge: any) =>
	// Notify Discord about each user
	R.forEach(user => {
		// Make the text to send
		const from = createFromObjFromUser(user as User);
		const text = `**${from.firstName} (${R.defaultTo(
			"No username",
			from.username
		)})** joined the Telegram side of the chat`;

		// Pass it on
		ctx.ProtoVerse.dcBot.ready
			.then(() => fetchDiscordChannel(ctx.ProtoVerse.dcBot, bridge).then(channel => channel.send(text)))
			.catch((err: any) =>
				console.error(`Could not tell Discord about a new chat member on bridge ${bridge.name}: ${err.message}`)
			);
	})(ctx.protoVerse.message.new_chat_members)
);

/**
 * Handles users leaving chats
 *
 * @param ctx The Telegraf context
 * @param ctx.protoVerse The ProtoVerse context of the message
 * @param ctx.protoVerse.message The Telegram message received
 * @param ctx.protoVerse.message.left_chat_member The user object of the user who left
 * @param ctx.protoVerse The global ProtoVerse context of the message
 */
export const leftChatMember = createMessageHandler((ctx: ProtoCrossContext, bridge: any) => {
	// Make the text to send
	const from = createFromObjFromUser(ctx.protoVerse.message.left_chat_member);
	const text = `**${from.firstName} (${R.defaultTo(
		"No username",
		from.username
	)})** left the Telegram side of the chat`;

	// Pass it on
	ctx.ProtoVerse.dcBot.ready
		.then(() => fetchDiscordChannel(ctx.ProtoVerse.dcBot, bridge).then(channel => channel.send(text)))
		.catch((err: any) =>
			console.error(
				`Could not tell Discord about a chat member who left on bridge ${bridge.name}: ${err.message}`
			)
		);
});

/**
 * Relays a message from Telegram to Discord
 *
 * @param ctx The Telegraf context
 * @param ctx.protoVerse	The ProtoVerse context of the message
 * @param ctx.protoVerse	The global ProtoVerse context of the message
 */
export const relayMessage = (ctx: ProtoCrossContext) =>
	R.forEach(async (prepared: any) => {
		try {
			// Discord doesn't handle messages longer than 2000 characters. Split it up into chunks that big
			const messageText = prepared.header + "\n" + prepared.text;
			let chunks = R.splitEvery(2000, messageText);
			const lastChunk = R.last(chunks);
			const watermarkedChunk = lastChunk + "\n\n Powered by @ProtoVerse_ai";
			chunks[chunks.length - 1] = watermarkedChunk;

			// Wait for the Discord bot to become ready
			await ctx.ProtoVerse.dcBot.ready;

			// Get the channel to send to
			const channel = await fetchDiscordChannel(ctx.ProtoVerse.dcBot, prepared.bridge);

			let dcMessage = null;
			// Send the attachment first, if there is one
			if (!R.isNil(prepared.file)) {
				try {
					dcMessage = await channel.send({
						content: R.head(chunks),
						files: [prepared.file]
					});
					chunks = R.tail(chunks);
				} catch (err: any) {
					if (err.message === "Request entity too large") {
						dcMessage = await channel.send(
							`***${prepared.senderName}** on Telegram sent a file, but it was too large for Discord. If you want it, ask them to send it some other way*`
						);
					} else {
						throw err;
					}
				}
			}

			dcMessage = await R.reduce(
				(p, chunk) => p.then(() => channel.send(chunk)),
				Promise.resolve(dcMessage),
				chunks
			);


			ctx.ProtoVerse.messageMap.insert(
				MessageMap.TELEGRAM_TO_DISCORD,
				prepared.bridge,
				ctx.protoVerse.messageId,
				dcMessage?.id
			);
		} catch (err: any) {
			console.error(`Could not relay a message to Discord on bridge ${prepared.bridge.name}: ${err.message}`);
		}
	})(ctx.protoVerse.prepared);

/**
 * Handles message edits
 *
 * @param ctx	The Telegraf context
 */
export const handleEdits = createMessageHandler(async (ctx: ProtoCrossContext, bridge: any) => {
	// Function to "delete" a message on Discord
	const del = async (ctx: ProtoCrossContext, bridge: any) => {
		try {
			// Find the ID of this message on Discord
			const [dcMessageId] = ctx.ProtoVerse.messageMap.getCorresponding(
				MessageMap.TELEGRAM_TO_DISCORD,
				bridge,
				ctx.protoVerse.message.message_id
			);

			// Get the channel to delete on
			const channel = await fetchDiscordChannel(ctx.ProtoVerse.dcBot, bridge);

			// Delete it on Discord
			const dp = channel.bulkDelete([dcMessageId]);

			// Delete it on Telegram
			const tp = ctx.deleteMessage();

			await Promise.all([dp, tp]);
		} catch (err: any) {
			console.error(
				`Could not cross-delete message from Telegram to Discord on bridge ${bridge.name}: ${err.message}`
			);
		}
	};

	// Function to edit a message on Discord
	const edit = async (ctx: ProtoCrossContext, bridge: any) => {
		try {
			const tgMessage = ctx.protoVerse.message;

			// Find the ID of this message on Discord
			const [dcMessageId] = ctx.ProtoVerse.messageMap.getCorresponding(
				MessageMap.TELEGRAM_TO_DISCORD,
				bridge,
				tgMessage.message_id
			);

			// Wait for the Discord bot to become ready
			await ctx.ProtoVerse.dcBot.ready;

			// Get the messages from Discord
			const dcMessage = await fetchDiscordChannel(ctx.ProtoVerse.dcBot, bridge).then(channel =>
				channel.messages.fetch(dcMessageId)
			);


			
			R.forEach(async (prepared: any) => {
				// Discord doesn't handle messages longer than 2000 characters. Take only the first 2000
				var messageText = R.slice(0, 2000, prepared.header + "\n" + prepared.text);
				messageText += "\n\n Powered by @ProtoVerse_ai";

				// Send them in serial, with the attachment first, if there is one
				if (typeof dcMessage.edit !== "function") {
					console.error("dcMessage.edit is not a function");
				} else {
					await dcMessage.edit({
						content: messageText,
						attachment: prepared.attachment
					} as MessageEditOptions);
				}
			})(ctx.protoVerse.prepared);
		} catch (err: any) {
			// Log it
			console.error(
				`Could not cross-edit message from Telegram to Discord on bridge ${bridge.name}: ${err.message}`
			);
		}
	};

	// Check if this is a "delete", meaning it has been edited to a single dot
	if (
		bridge.telegram.crossDeleteOnDiscord &&
		ctx.protoVerse.text.raw === "." &&
		R.isEmpty(ctx.protoVerse.text.entities)
	) {
		await del(ctx, bridge);
	} else {
		await edit(ctx, bridge);
	}
});
