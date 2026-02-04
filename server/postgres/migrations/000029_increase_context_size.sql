-- Increase the size of the context column to handle longer questionnaire responses
ALTER TABLE conversations
ALTER COLUMN context TYPE TEXT;

COMMENT ON COLUMN conversations.context IS 'Questionnaire context data stored as JSON, containing all questionnaire answers and submission metadata';








