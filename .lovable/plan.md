

## Analysis

Currently, the `chat-stream` endpoint is stateless: it receives a `messages` array, forwards it to the AI, and streams back the response. Nothing is persisted.

For a chat app with conversation history, there are two clean approaches:

### Option A: 2 Endpoints (Recommended for simplicity)
1. **`chat-stream`** (existing) — Send message + conversation history, get streaming AI response. After the response completes, save both the user message and assistant response to the database.
2. **Direct DB access via Supabase client** — From your Expo app, use the Supabase JS client (`@supabase/supabase-js`) to query conversations and messages directly. No second endpoint needed.

### Option B: Modified `chat-stream` + REST endpoint
1. **`chat-stream`** saves messages automatically to DB after streaming completes.
2. A separate **`conversations`** edge function for listing/creating/deleting conversations.

### Recommended Architecture (Option A)

**Database tables:**

```text
conversations
├── id (uuid, PK)
├── user_id (uuid, nullable for anonymous)
├── title (text)
├── created_at (timestamptz)
└── updated_at (timestamptz)

messages
├── id (uuid, PK)
├── conversation_id (uuid, FK → conversations)
├── role (text: 'user' | 'assistant')
├── content (text)
└── created_at (timestamptz)
```

**Flow from Expo app:**

1. User opens app → `supabase.from('conversations').select('*')` to list past chats
2. User taps a conversation → `supabase.from('messages').select('*').eq('conversation_id', id)` to load history
3. User sends a message → 
   - Insert user message into `messages` table via Supabase client
   - Call `chat-stream` with the full messages array
   - When stream completes, insert assistant message into `messages` table
4. New conversation → Insert into `conversations`, then proceed with step 3

**What changes in this project:**

1. **Create `conversations` and `messages` tables** with appropriate columns
2. **No RLS initially** (since the user mentioned anonymous/no auth for now), or simple open policies
3. **No changes to `chat-stream`** — it stays stateless. The Expo app handles persistence by reading/writing directly to the DB using the Supabase JS client
4. Optionally: modify `chat-stream` to auto-save messages (but this adds complexity and the user's Expo app would need to pass `conversation_id`)

### Summary

You do **not** need a second endpoint. The Supabase JS client (`@supabase/supabase-js`) works in React Native and lets you query tables directly. The only endpoint you need is `chat-stream` for the AI streaming part. All CRUD operations (list conversations, load messages, save messages) happen via the Supabase client SDK from your Expo app.

### Implementation Steps

1. Create `conversations` and `messages` tables via migration
2. Set permissive RLS policies (or disable RLS if no auth)
3. Provide the Expo code snippets for: initializing Supabase client, CRUD operations, and integrating with the existing stream endpoint

