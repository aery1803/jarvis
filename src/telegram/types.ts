export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  /** Absent for some photos; `getFile` reports the size before anything is downloaded. */
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Result of the Bot API `getFile` call. */
export interface TelegramFile {
  file_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  /** One entry per available resolution, smallest first. */
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  reply_markup?: InlineKeyboardMarkup;
  /** Present on a forwarded message (Bot API 7+); `forward_date`/`forward_from*` are the older spellings. */
  forward_origin?: unknown;
  forward_date?: number;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_sender_name?: string;
  /** Present when the message was sent through an inline bot. */
  via_bot?: TelegramUser;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface SendMessageOptions {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  reply_markup?: InlineKeyboardMarkup;
  reply_to_message_id?: number;
}
