-- A few rows in user, chat and RAG tables (and auth.users) for the backup
-- round trip. Values are fake.
INSERT INTO auth.users (id, email) VALUES
    ('00000000-0000-4000-8000-000000000001', 'a@example.com'),
    ('00000000-0000-4000-8000-000000000002', NULL);

INSERT INTO holdings (id, user_id, ticker, shares, buy_price, purchase_date, updated_at) VALUES
    ('h1', '00000000-0000-4000-8000-000000000001', 'NVDA', 15, 118.6, '2024-08-27', now()),
    ('h2', '00000000-0000-4000-8000-000000000001', 'AAPL', 0.5, 210.15, NULL, now());

INSERT INTO chat_conversations (id, user_id, title) VALUES
    ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'NVDA');
INSERT INTO chat_messages (id, conversation_id, user_id, role, content, citations) VALUES
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c1',
     '00000000-0000-4000-8000-000000000001', 'user', 'What changed?', '[]'),
    ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000c1',
     '00000000-0000-4000-8000-000000000001', 'assistant', 'Revenue rose [1].',
     '[{"id": 1, "ticker": "NVDA"}]');
INSERT INTO chat_usage_events (id, user_id, kind) VALUES
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'message');

INSERT INTO rag_tickers (ticker, company_name, status, chunk_count, quarters, latest_call_date) VALUES
    ('NVDA', 'Nvidia Corp', 'indexed', 205, '["FY2027Q2", "FY2027Q1"]', '2026-08-26');
