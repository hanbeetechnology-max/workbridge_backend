-- WhatsApp-style "reply to a specific message" — a message can point back
-- at one earlier message in the same conversation. ON DELETE SET NULL (not
-- CASCADE/RESTRICT): if the original message is ever removed, the reply
-- itself should still exist, just without a quoted preview, rather than
-- being deleted or blocking the delete.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages (reply_to_message_id);
