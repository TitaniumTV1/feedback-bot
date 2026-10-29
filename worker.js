const DEFAULT_WELCOME = "Здравствуйте!\n\nНапишите Ваш вопрос, и мы ответим Вам в ближайшее время.";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const api = (method, payload) =>
      fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => r.json());

    const adminId = String(env.ADMIN_ID);

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message.chat.id);

      if (chatId !== adminId) {
        await api("answerCallbackQuery", { callback_query_id: cb.id });
        return new Response("OK");
      }

      if (cb.data === "edit_welcome") {
        await env.BOT_KV.put("admin_state", "waiting_welcome");
        await api("editMessageText", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: "Отправьте новый текст приветствия.\n\nПоддерживаются переносы строк. Для отмены отправьте /cancel.",
        });
      } else if (cb.data === "reset_welcome") {
        await env.BOT_KV.delete("welcome_text");
        await env.BOT_KV.delete("admin_state");
        await api("editMessageText", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: `Текст приветствия сброшен до значения по умолчанию:\n\n${DEFAULT_WELCOME}`,
          reply_markup: getSettingsKeyboard(),
        });
      }

      await api("answerCallbackQuery", { callback_query_id: cb.id });
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    const chatId = String(msg.chat.id);
    const text = msg.text || "";

    // Логика для администратора
    if (chatId === adminId) {
      if (text === "/cancel") {
        await env.BOT_KV.delete("admin_state");
        await api("sendMessage", {
          chat_id: chatId,
          text: "Действие отменено.",
        });
        return new Response("OK");
      }

      if (text === "/start" || text === "/settings") {
        await env.BOT_KV.delete("admin_state");
        const currentWelcome = (await env.BOT_KV.get("welcome_text")) || DEFAULT_WELCOME;

        await api("sendMessage", {
          chat_id: chatId,
          text: `Настройки бота обратной связи.\n\nТекущее приветствие:\n---\n${currentWelcome}\n---`,
          reply_markup: getSettingsKeyboard(),
        });
        return new Response("OK");
      }

      const adminState = await env.BOT_KV.get("admin_state");
      if (adminState === "waiting_welcome") {
        if (!text) {
          await api("sendMessage", {
            chat_id: chatId,
            text: "Отправьте текстовое сообщение или введите /cancel.",
          });
          return new Response("OK");
        }

        await env.BOT_KV.put("welcome_text", text);
        await env.BOT_KV.delete("admin_state");

        await api("sendMessage", {
          chat_id: chatId,
          text: `Приветствие обновлено:\n---\n${text}\n---`,
          reply_markup: getSettingsKeyboard(),
        });
        return new Response("OK");
      }

      if (msg.reply_to_message) {
        const repliedMsgId = msg.reply_to_message.message_id;
        const targetUserId = await env.BOT_KV.get(`msg:${repliedMsgId}`);

        if (!targetUserId) {
          await api("sendMessage", {
            chat_id: chatId,
            text: "Не удалось определить получателя. Убедитесь, что вы отвечаете на пересланное сообщение пользователя.",
            reply_to_message_id: msg.message_id,
          });
          return new Response("OK");
        }

        const copyRes = await api("copyMessage", {
          chat_id: targetUserId,
          from_chat_id: chatId,
          message_id: msg.message_id,
        });

        if (copyRes.ok) {
          await api("sendMessage", {
            chat_id: chatId,
            text: "Ответ отправлен.",
            reply_to_message_id: msg.message_id,
          });
        } else {
          await api("sendMessage", {
            chat_id: chatId,
            text: `Ошибка отправки: ${copyRes.description || "пользователь заблокировал бота"}.`,
            reply_to_message_id: msg.message_id,
          });
        }
        return new Response("OK");
      }

      await api("sendMessage", {
        chat_id: chatId,
        text: "Для ответа пользователю сделайте Reply на его сообщение.\nДля изменения текста приветствия используйте команду /settings.",
      });
      return new Response("OK");
    }

    // Логика для пользователя
    if (text === "/start") {
      const welcomeText = (await env.BOT_KV.get("welcome_text")) || DEFAULT_WELCOME;
      await api("sendMessage", {
        chat_id: chatId,
        text: welcomeText,
      });
      return new Response("OK");
    }

    const fwdRes = await api("forwardMessage", {
      chat_id: adminId,
      from_chat_id: chatId,
      message_id: msg.message_id,
    });

    if (fwdRes.ok && fwdRes.result) {
      await env.BOT_KV.put(`msg:${fwdRes.result.message_id}`, chatId, {
        expirationTtl: 60 * 60 * 24 * 30,
      });
    }

    return new Response("OK");
  },
};

function getSettingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Изменить приветствие", callback_data: "edit_welcome" }],
      [{ text: "Сбросить по умолчанию", callback_data: "reset_welcome" }],
    ],
  };
}
