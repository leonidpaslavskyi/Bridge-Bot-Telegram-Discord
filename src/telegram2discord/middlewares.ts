import R from "ramda";
import { Bridge } from "../bridgestuff/Bridge";
import mime from "mime/lite";
import { handleEntities } from "./handleEntities";
import Discord, { Client } from "discord.js";
import { sleepOneMinute } from "../sleep";
import { fetchDiscordChannel } from "../fetchDiscordChannel";
import { Message } from "telegraf/typings/core/types/typegram";
import { ProtoCrossContext } from "./endwares";
import { createFromObjFromChat, createFromObjFromMessage, createFromObjFromUser, makeDisplayName } from "./From";
import { deleteMessage, ignoreAlreadyDeletedError } from "./helpers";

/***********
 * Helpers *
 ***********/

/**
 * Creates a text object from a Telegram message
 *
 * @param message The message object
 *
 * @returns The text object, or undefined if no text was found
 */
function createTextObjFromMessage(ctx: ProtoCrossContext, message: Message) {
	return R.cond<any, any>([
		// Text
		[
			R.has("text"),
			({ text, entities }) => ({
				raw: text,
				entities: R.defaultTo([], entities)
			})
		],
		// Animation, audio, document, photo, video or voice
		[
			R.has<any>("caption"),
			({ caption, caption_entities }: { caption: string; caption_entities: string }) => ({
				raw: caption,
				entities: R.defaultTo([], caption_entities)
			})
		],
		// Stickers have an emoji instead of text
		[
			R.has("sticker"),
			message => ({
				raw: R.ifElse<any, any, any>(
					() => ctx.ProtoVerse.settings.telegram.sendEmojiWithStickers,
					R.path(["sticker", "emoji"]),
					R.always("")
				)(message),
				entities: []
			})
		],
		// Locations must be turned into an URL
		[
			R.has<any>("location"),
			({ location }: any) => ({
				raw: `https://maps.google.com/maps?q=${location.latitude},${location.longitude}&ll=${location.latitude},${location.longitude}&z=16`,
				entities: []
			})
		],
		// Default to undefined
		[R.T, R.always({ raw: "", entities: [] })]
	])(message);
}

/**
 * Makes the reply text to show on Discord
 *
 * @param replyTo The replyTo object from the protoVerse context
 * @param replyLength How many characters to take from the original
 * @param maxReplyLines How many lines to cut the reply text after
 *
 * @returns The reply text to display
 */
const makeReplyText = (replyTo: any, replyLength: number, maxReplyLines: number) => {
	const countDoublePipes = R.tryCatch(str => str.match(/\|\|/g).length, R.always(0));

	// Make the reply string
	return R.compose<any, any>(
		// Add ellipsis if the text was cut
		R.ifElse(R.compose(R.equals(R.length(replyTo.text.raw)), R.length), R.identity, R.concat(R.__, "…")),
		// Handle spoilers (pairs of "||" in Discord)
		//@ts-ignore
		R.ifElse<any, any, any>(
			// If one of a pair of "||" has been removed
			quote =>
				R.and(
					//@ts-ignore
					countDoublePipes(quote, "||") % 2 === 1,
					countDoublePipes(replyTo.text.raw) % 2 === 0
				),
			// Add one to the end
			R.concat(R.__, "||"),
			// Otherwise do nothing
			R.identity
		),
		// Take only a number of lines
		R.join("\n"),
		R.slice(0, maxReplyLines),
		R.split("\n"),
		// Take only a portion of the text
		R.slice(0, replyLength)
	)(replyTo.text.raw);
};

/**
 * Makes a discord mention out of a username
 *
 * @param username The username to make the mention from
 * @param dcBot The Discord bot to look up the user's ID with
 * @param bridge The bridge to use
 *
 * @returns A Discord mention of the user
 */
async function makeDiscordMention(username: string, dcBot: Client, bridge: Bridge) {
	try {
		// Get the name of the Discord user this is a reply to
		const channel = await fetchDiscordChannel(dcBot, bridge);
		const dcUser = await channel.members.find(R.propEq("displayName", username));

		return R.ifElse(R.isNil, R.always(username), dcUser => `<@${dcUser.id}>`)(dcUser);
	} catch (err) {
		// Cannot make a mention. Just return the username
		return username;
	}
}

/****************************
 * The middleware functions *
 ****************************/

/**
 * Adds a `protoVerse` property to the context
 *
 * @param ctx The context to add the property to
 * @param next Function to pass control to next middleware
 */
function addProtoVerseCrossObj(ctx: ProtoCrossContext, next: () => void) {
	ctx.protoVerse = {} as any;
	next();
}

/**
 * Adds a message object to the protoVerse context. One of the four optional arguments must be present. Requires the protoVerse context to work
 *
 * @param ctx The Telegraf context
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param [ctx.channelPost]
 * @param [ctx.editedChannelPost]
 * @param [ctx.message]
 * @param [ctx.editedChannelPost]
 * @param next Function to pass control to next middleware
 */
function addMessageObj(ctx: ProtoCrossContext, next: () => void) {
	// Put it on the context
	ctx.protoVerse.message = R.cond([
		// XXX I tried both R.has and R.hasIn as conditions. Neither worked for some reason
		[ctx => !R.isNil(ctx.update.channel_post), R.path(["update", "channel_post"])],
		[ctx => !R.isNil(ctx.update.edited_channel_post), R.path(["update", "edited_channel_post"])],
		[ctx => !R.isNil(ctx.update.message), R.path(["update", "message"])],
		[ctx => !R.isNil(ctx.update.edited_message), R.path(["update", "edited_message"])]
	])(ctx) as any;

	next();
}

/**
 * Adds the message ID as a prop to the protoVerse context
 *
 * @param ctx The Telegraf context
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse.message The message object being handled
 * @param next Function to pass control to next middleware
 */
function addMessageId(ctx: ProtoCrossContext, next: () => void) {
	ctx.protoVerse.messageId = ctx.protoVerse.message.message_id;

	next();
}

/**
 * Adds the bridges to the protoVerse object on the context. Requires the protoVerse context to work
 *
 * @param ctx The context to add the property to
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse The global ProtoVerse context
 * @param ctx.protoVerse.bridgeMap The bridge map of the application
 * @param next Function to pass control to next middleware
 */
function addBridgesToContext(ctx: ProtoCrossContext, next: () => void) {
	ctx.protoVerse.bridges = ctx.ProtoVerse.bridgeMap.fromTelegramChatId(ctx.protoVerse.message.chat.id);
	next();
}

/**
 * Removes d2t bridges from the bridge list
 *
 * @param ctx The Telegraf context to use
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeD2TBridges(ctx: ProtoCrossContext, next: () => void) {
	ctx.protoVerse.bridges = R.reject(R.propEq("direction", Bridge.DIRECTION_DISCORD_TO_TELEGRAM))(
		ctx.protoVerse.bridges
	);

	next();
}

/**
 * Removes bridges with the `relayCommands` flag set to false from the bridge list
 *
 * @param ctx The Telegraf context to use
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringCommands(ctx: ProtoCrossContext, next: () => void) {
	//@ts-ignore
	ctx.protoVerse.bridges = R.filter<any, any>(R.path(["telegram", "relayCommands"]), ctx.protoVerse.bridges);
	next();
}

/**
 * Removes bridges with `telegram.relayJoinMessages === false`
 *
 * @param ctx The Telegraf context to use
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringJoinMessages(ctx: ProtoCrossContext, next: () => void) {
	//@ts-ignore
	ctx.protoVerse.bridges = R.filter(R.path(["telegram", "relayJoinMessages"]), ctx.protoVerse.bridges);
	next();
}

/**
 * Removes bridges with `telegram.relayLeaveMessages === false`
 *
 * @param ctx The Telegraf context to use
 * @param ctx.protoVerse The ProtoVerse object on the context
 * @param ctx.protoVerse.bridges The bridges the message could use
 * @param next Function to pass control to next middleware
 */
function removeBridgesIgnoringLeaveMessages(ctx: ProtoCrossContext, next: () => void) {
	//@ts-ignore
	ctx.protoVerse.bridges = R.filter(R.path(["telegram", "relayLeaveMessages"]), ctx.protoVerse.bridges);
	next();
}

/**
 * Replies to the message telling the user this is a private bot if there are no bridges on the protoVerse context
 *
 * @param ctx The Telegraf context
 * @param ctx.reply The context's reply function
 * @param next Function to pass control to next middleware
 */
function informThisIsPrivateBot(ctx: ProtoCrossContext, next: () => void) {
	R.ifElse(
		// If there are no bridges
		//@ts-ignore
		R.compose(R.isEmpty, R.path(["protoVerse", "bridges"])),
		// Inform the user, if enough time has passed since last time
		R.when<ProtoCrossContext, any>(
			// When there is no timer for the chat in the anti spam map
			ctx => R.not(ctx.ProtoVerse.antiInfoSpamSet.has(ctx.protoVerse.message.chat.id)),
			// Inform the chat this is an instance of ProtoVerse
			ctx => {
				// Update the anti spam set
				ctx.ProtoVerse.antiInfoSpamSet.add(ctx.protoVerse.message.chat.id);

				// Send the reply
				ctx.reply(
					"This is ProtoVerse bot",
					{
						parse_mode: "Markdown"
					}
				).then(msg =>
					// Delete it again after a while
					//@ts-ignore
					sleepOneMinute()
						.then(() => deleteMessage(ctx, msg))
						.catch(ignoreAlreadyDeletedError)
						// Remove it from the anti spam set again
						.then(() => ctx.ProtoVerse.antiInfoSpamSet.delete(ctx.message!.chat.id))
				);
			}
		),
		// Otherwise go to next middleware
		next
	)(ctx);
}

/**
 * Adds a `from` object to the protoVerse context
 *
 * @param ctx The context to add the property to
 * @param ctx.protoVerse The protoVerse on the context
 * @param ctx.protoVerse.message The message object to create the `from` object from
 * @param next Function to pass control to next middleware
 */
function addFromObj(ctx: ProtoCrossContext, next: () => void) {
	ctx.protoVerse.from = createFromObjFromMessage(ctx.protoVerse.message);
	next();
}

/**
 * Adds a `reply` object to the protoVerse context, if the message is a reply
 *
 * @param ctx The context to add the property to
 * @param ctx.protoVerse The protoVerse on the context
 * @param ctx.protoVerse.message The message object to create the `reply` object from
 * @param next Function to pass control to next middleware
 */
function addReplyObj(ctx: ProtoCrossContext, next: () => void) {
	const repliedToMessage = ctx.protoVerse.message.reply_to_message;

	if (!R.isNil(repliedToMessage)) {
		// This is a reply
		const isReplyToProtoVerse =
			!R.isNil(repliedToMessage.from) && R.equals(repliedToMessage.from.id, ctx.ProtoVerse.me.id);
		ctx.protoVerse.replyTo = {
			isReplyToProtoVerse,
			message: repliedToMessage,
			originalFrom: createFromObjFromMessage(repliedToMessage),
			text: createTextObjFromMessage(ctx, repliedToMessage)
		};

		// Handle replies to ProtoVerse
		if (isReplyToProtoVerse) {
			// Get the username of the Discord user who sent this and remove it from the text
			const split = R.split("\n", ctx.protoVerse.replyTo.text.raw);
			ctx.protoVerse.replyTo.dcUsername = R.head(split);
			ctx.protoVerse.replyTo.text.raw = R.join("\n", R.tail(split));

			// Cut off the first entity (the bold text on the username) and reduce the offset of the rest by the length of the username and the newline
			ctx.protoVerse.replyTo.text.entities = R.compose(
				R.map((entity: any) =>
					R.mergeRight(entity, {
						offset: entity.offset - ctx.protoVerse.replyTo.dcUsername.length - 1
					})
				),
				R.tail
			)(ctx.protoVerse.replyTo.text.entities);
		}

		// Turn the original text into "<no text>" if there is no text
		if (R.isEmpty(ctx.protoVerse.replyTo.text.raw)) {
			ctx.protoVerse.replyTo.text.raw = "<no text>";
		}
	}

	next();
}

/**
 * Adds a `forward` object to the protoVerse context, if the message is a forward
 *
 * @param ctx	The context to add the property to
 * @param ctx.protoVerse	The protoVerse on the context
 * @param ctx.protoVerse.message	The message object to create the `forward` object from
 * @param next	Function to pass control to next middleware
 */
function addForwardFrom(ctx: ProtoCrossContext, next: () => void) {
	const msg = ctx.protoVerse.message;

	if (!R.isNil(msg.forward_from) || !R.isNil(msg.forward_from_chat)) {
		ctx.protoVerse.forwardFrom = R.ifElse(
			// If there is no `forward_from` prop
			R.compose(R.isNil, R.prop("forward_from")),
			// Then this is a forward from a chat (channel)
			//@ts-ignore
			R.compose<any, any>(createFromObjFromChat, R.prop("forward_from_chat")),
			// Else it is from a user
			//@ts-ignore
			R.compose(createFromObjFromUser, R.prop("forward_from"))
		)(msg);
	}

	next();
}

/**
 * Adds a text object to the protoVerse property on the context, if there is text in the message
 *
 * @param ctx	The context to add the property to
 * @param ctx.protoVerse	The protoVerse on the context
 * @param ctx.protoVerse.message	The message object to get the text data from
 * @param next	Function to pass control to next middleware
 */
function addTextObj(ctx: ProtoCrossContext, next: () => void) {
	const text = createTextObjFromMessage(ctx, ctx.protoVerse.message as any);

	if (!R.isNil(text)) {
		ctx.protoVerse.text = text;
	}

	next();
}

/**
 * Adds a file object to the protoVerse property on the context
 *
 * @param ctx The context to add the property to
 * @param ctx.protoVerse The protoVerse on the context
 * @param ctx.protoVerse.message The message object to get the file data from
 * @param next Function to pass control to next middleware
 */
function addFileObj(ctx: ProtoCrossContext, next: () => void) {
	const message = ctx.protoVerse.message;

	// Figure out if a file is present
	if (!R.isNil(message.audio)) {
		// Audio
		ctx.protoVerse.file = {
			type: "audio",
			id: message.audio.file_id,
			name: message.audio.title + "." + mime.getExtension(message.audio.mime_type)
		};
	} else if (!R.isNil(message.document)) {
		// Generic file
		ctx.protoVerse.file = {
			type: "document",
			id: message.document.file_id,
			name: message.document.file_name
		};
	} else if (!R.isNil(message.photo)) {
		// Photo. It has an array of photos of different sizes. Use the last and biggest
		const photo = R.last(message.photo) as any;
		ctx.protoVerse.file = {
			type: "photo",
			id: photo.file_id,
			name: "photo.jpg" // Telegram will convert it to a jpg no matter which format is orignally sent
		};
	} else if (!R.isNil(message.sticker)) {
		// Sticker
		ctx.protoVerse.file = {
			type: "sticker",
			id: R.ifElse(
				R.propEq("is_animated", true),
				R.path(["thumb", "file_id"]),
				R.prop<any>("file_id")
			)(message.sticker),
			name: "sticker.webp"
		};
	} else if (!R.isNil(message.video)) {
		// Video
		ctx.protoVerse.file = {
			type: "video",
			id: message.video.file_id,
			name: "video" + "." + mime.getExtension(message.video.mime_type)
		};
	} else if (!R.isNil(message.voice)) {
		// Voice
		ctx.protoVerse.file = {
			type: "voice",
			id: message.voice.file_id,
			name: "voice" + "." + mime.getExtension(message.voice.mime_type)
		};
	}

	next();
}

/**
 * Adds a file link to the file object on the protoVerse context, if there is one
 *
 * @param ctx The context to add the property to
 * @param ctx.protoVerse The protoVerse on the context
 * @param next Function to pass control to next middleware
 *
 * @returns Promise resolving to nothing when the operation is complete
 */
function addFileLink(ctx: ProtoCrossContext, next: () => void) {
	return Promise.resolve()
		.then(() => {
			// Get a stream to the file, if one was found
			if (!R.isNil(ctx.protoVerse.file)) {
				return ctx.telegram.getFileLink(ctx.protoVerse.file.id).then(fileLink => {
					ctx.protoVerse.file.link = fileLink.href;
				});
			}
		})
		.then(next)
		.then(R.always(undefined))
		.catch(err => {
			if (err.response && err.response.description === "Bad Request: file is too big") {
				ctx.reply("<i>File is too big for ProtoVerse to handle</i>", { parse_mode: "HTML" });
			}
		});
}

async function addPreparedObj(ctx: ProtoCrossContext, next: () => void) {
	// Shorthand for the protoVerse context
	const tc = ctx.protoVerse;

	ctx.protoVerse.prepared = await Promise.all(
		R.map(async (bridge: Bridge) => {
			// Get the name of the sender of this message
			const senderName = makeDisplayName(ctx.ProtoVerse.settings.telegram.useFirstNameInsteadOfUsername, tc.from);

			// Make the header
			// WARNING! Butt-ugly code! If you see a nice way to clean this up, please do it
			const header = await (async () => {
				// Get the name of the original sender, if this is a forward
				const originalSender = R.isNil(tc.forwardFrom)
					? null
					: makeDisplayName(ctx.ProtoVerse.settings.telegram.useFirstNameInsteadOfUsername, tc.forwardFrom);
				// Get the name of the replied-to user, if this is a reply
				const repliedToName = R.isNil(tc.replyTo)
					? null
					: await R.ifElse(
							R.prop("isReplyToProtoVerse") as any,
							R.compose(
								(username: string) => makeDiscordMention(username, ctx.ProtoVerse.dcBot, bridge),
								R.prop("dcUsername") as any
							),
							R.compose(
								R.partial(makeDisplayName, [
									ctx.ProtoVerse.settings.telegram.useFirstNameInsteadOfUsername
								]),
								//@ts-ignore
								R.prop("originalFrom")
							)
					  )(tc.replyTo);
				// Build the header
				let header = "";
				if (bridge.telegram.sendUsernames) {
					if (!R.isNil(tc.forwardFrom)) {
						// Forward
						header = `**${originalSender}** (forwarded by **${senderName}**)`;
					} else if (!R.isNil(tc.replyTo)) {
						// Reply
						header = `**${senderName}** (in reply to **${repliedToName}**)`;
					} else {
						// Ordinary message
						header = `**${senderName}**`;
					}
				} else {
					if (!R.isNil(tc.forwardFrom)) {
						// Forward
						header = `(forward from **${originalSender}**)`;
					} else if (!R.isNil(tc.replyTo)) {
						// Reply
						header = `(in reply to **${repliedToName}**)`;
					} else {
						// Ordinary message
						header = "";
					}
				}

				return header;
			})();

			// Handle blockquote replies
			const replyQuote = R.ifElse(
				tc => !R.isNil(tc.replyTo),
				//@ts-ignore
				R.compose<any, any>(R.replace(/^/gm, "> "), tc =>
					makeReplyText(
						tc.replyTo,
						ctx.ProtoVerse.settings.discord.replyLength,
						ctx.ProtoVerse.settings.discord.maxReplyLines
					)
				),
				R.always(undefined)
			)(tc);

			// Handle file
			const file = R.ifElse(
				R.compose(R.isNil, R.prop("file")),
				R.always(undefined),
				(tc: ProtoCrossContext["ProtoVerse"]["tc"]) => new Discord.MessageAttachment(tc.file.link, tc.file.name)
			)(tc);

			// Make the text to send
			const text = await (async () => {
				let text = await handleEntities(tc.text.raw, tc.text.entities, ctx.ProtoVerse.dcBot, bridge);

				if (!R.isNil(replyQuote)) {
					text = replyQuote + "\n" + text;
				}

				return text;
			})();

			return {
				bridge,
				header,
				senderName,
				file,
				text
			};
		})(tc.bridges)
	);

	next();
}

/***************
 * Export them *
 ***************/

export default {
	addProtoVerseCrossObj,
	addMessageObj,
	addMessageId,
	addBridgesToContext,
	removeD2TBridges,
	removeBridgesIgnoringCommands,
	removeBridgesIgnoringJoinMessages,
	removeBridgesIgnoringLeaveMessages,
	informThisIsPrivateBot,
	addFromObj,
	addReplyObj,
	addForwardFrom,
	addTextObj,
	addFileObj,
	addFileLink,
	addPreparedObj
};
