# Design Doc — AI Chat Backend

## 1. Arquitectura General

```
┌─────────────────────┐
│   React Native App  │
│   (Expo / Web)      │
├─────────────────────┤
│  Supabase JS Client │──── CRUD directo ────► DB (conversations, messages)
│  fetch() SSE        │──── POST streaming ──► Edge Function (chat-stream)
└─────────────────────┘
                                                      │
                                                      ▼
                                              Lovable AI Gateway
                                          (google/gemini-3-flash-preview)
```

## 2. Base de Datos

### 2.1 Tabla `conversations`

| Columna      | Tipo         | Nullable | Default                    | Notas                        |
|-------------|-------------|----------|----------------------------|------------------------------|
| `id`        | `uuid`      | No       | `gen_random_uuid()`        | PK                           |
| `user_id`   | `uuid`      | Sí       | `null`                     | Para futuro auth             |
| `title`     | `text`      | No       | `'New conversation'`       | Primeros ~50 chars del input |
| `created_at`| `timestamptz`| No      | `now()`                    |                              |
| `updated_at`| `timestamptz`| No      | `now()`                    | Auto-update via trigger      |

### 2.2 Tabla `messages`

| Columna           | Tipo         | Nullable | Default             | Notas                          |
|-------------------|-------------|----------|---------------------|--------------------------------|
| `id`              | `uuid`      | No       | `gen_random_uuid()` | PK                             |
| `conversation_id` | `uuid`      | No       | —                   | FK → `conversations(id)` CASCADE |
| `role`            | `text`      | No       | —                   | `'user'` o `'assistant'`       |
| `content`         | `text`      | No       | —                   | Contenido del mensaje          |
| `created_at`      | `timestamptz`| No      | `now()`             |                                |

### 2.3 Índices

- `idx_messages_conversation_id` en `messages(conversation_id)` — lookup rápido

### 2.4 Triggers

- `update_conversations_updated_at` — actualiza `updated_at` en cada UPDATE a `conversations`

### 2.5 RLS (Row Level Security)

- **Actualmente**: políticas abiertas (`USING (true)`, `WITH CHECK (true)`) — sin auth
- **Futuro con auth**: cambiar a `USING (auth.uid() = user_id)`

### 2.6 Realtime

- Tabla `messages` habilitada en `supabase_realtime` para suscripciones en tiempo real

## 3. Edge Function: `chat-stream`

### 3.1 Endpoint

```
POST /functions/v1/chat-stream
```

### 3.2 Headers requeridos

```
Content-Type: application/json
Authorization: Bearer <SUPABASE_ANON_KEY>
```

### 3.3 Request Body

```json
{
  "messages": [
    { "role": "user", "content": "Hola" },
    { "role": "assistant", "content": "¡Hola! ¿En qué puedo ayudarte?" },
    { "role": "user", "content": "Explicame qué es TypeScript" }
  ]
}
```

- `messages`: Array completo de la conversación (el cliente envía todo el historial)
- La función inyecta un system prompt al inicio automáticamente

### 3.4 Response

- **Content-Type**: `text/event-stream` (SSE)
- **Formato**: OpenAI-compatible

```
data: {"id":"...","choices":[{"delta":{"content":"Token"}}]}
data: {"id":"...","choices":[{"delta":{"content":" por"}}]}
data: {"id":"...","choices":[{"delta":{"content":" token"}}]}
data: [DONE]
```

### 3.5 Errores

| Status | Significado                  | Body                                                    |
|--------|-----------------------------|---------------------------------------------------------|
| 400    | Body inválido               | `{"error": "messages array is required"}`               |
| 402    | Sin créditos AI             | `{"error": "AI usage credits exhausted..."}`            |
| 429    | Rate limit                  | `{"error": "Rate limit exceeded..."}`                   |
| 500    | Error interno               | `{"error": "AI service error"}`                         |

### 3.6 Modelo AI

- **Modelo**: `google/gemini-3-flash-preview`
- **Gateway**: `https://ai.gateway.lovable.dev/v1/chat/completions`
- **System prompt**: `"You are a helpful AI assistant. Answer clearly and concisely. Use markdown formatting when appropriate."`

### 3.7 Flujo interno

```
Cliente → POST /chat-stream { messages }
         │
         ▼
   Validar body (messages array no vacío)
         │
         ▼
   Obtener LOVABLE_API_KEY de env
         │
         ▼
   POST a AI Gateway con stream: true
         │
         ▼
   Pipe response.body directo al cliente (SSE pass-through)
```

### 3.8 CORS

Acepta cualquier origen (`*`). Headers permitidos incluyen `authorization`, `apikey`, `content-type` y headers del SDK.

## 4. Flujo completo de la app

```
1. ABRIR APP
   └─ GET conversations → supabase.from('conversations').select('*').order('updated_at', { ascending: false })

2. NUEVA CONVERSACIÓN
   └─ (se crea lazy al enviar el primer mensaje)

3. ENVIAR MENSAJE
   ├─ Si no hay conversation_id:
   │   └─ INSERT conversations { title: input.slice(0, 50) } → obtener id
   ├─ INSERT messages { conversation_id, role: 'user', content }
   ├─ SELECT messages WHERE conversation_id → armar array completo
   ├─ POST /chat-stream { messages: [...] }
   ├─ Leer SSE token por token → mostrar en UI
   └─ Al recibir [DONE]:
       └─ INSERT messages { conversation_id, role: 'assistant', content: fullResponse }

4. CARGAR CONVERSACIÓN EXISTENTE
   └─ SELECT messages WHERE conversation_id ORDER BY created_at ASC

5. BORRAR CONVERSACIÓN
   └─ DELETE conversations WHERE id = X  (CASCADE borra los messages)
```

## 5. Ejemplo mínimo de implementación (JavaScript/React Native)

```javascript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- CRUD ---

// Listar conversaciones
const { data } = await supabase
  .from('conversations')
  .select('*')
  .order('updated_at', { ascending: false });

// Crear conversación
const { data: conv } = await supabase
  .from('conversations')
  .insert({ title: userInput.slice(0, 50) })
  .select()
  .single();

// Cargar mensajes
const { data: msgs } = await supabase
  .from('messages')
  .select('*')
  .eq('conversation_id', convId)
  .order('created_at', { ascending: true });

// Guardar mensaje
await supabase.from('messages').insert({
  conversation_id: convId,
  role: 'user',
  content: userInput,
});

// Borrar conversación (cascade borra mensajes)
await supabase.from('conversations').delete().eq('id', convId);

// --- STREAMING ---

const response = await fetch(`${SUPABASE_URL}/functions/v1/chat-stream`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  },
  body: JSON.stringify({ messages: allMessages }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let fullResponse = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const parsed = JSON.parse(line.slice(6));
    const token = parsed.choices?.[0]?.delta?.content || '';
    fullResponse += token;
    // Actualizar UI aquí
  }
}

// Guardar respuesta del asistente
await supabase.from('messages').insert({
  conversation_id: convId,
  role: 'assistant',
  content: fullResponse,
});
```

## 6. Consideraciones futuras

| Feature | Cambio requerido |
|---------|-----------------|
| **Autenticación** | Agregar auth con email/password, cambiar RLS a `auth.uid() = user_id` |
| **Auto-título** | Tras primer intercambio, llamar a la IA para generar título y UPDATE conversation |
| **Límite de contexto** | Enviar solo últimos N mensajes al endpoint para no exceder tokens |
| **Múltiples modelos** | Agregar campo `model` al request body del endpoint |
