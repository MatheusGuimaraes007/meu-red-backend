# Prompt de implementação do frontend CRM RED

Implemente a integração completa do frontend Vue 3 localizado em:

`C:\Users\Matheus Guimarães\Desktop\Projetos Matheus\IA - RED`

com o backend NestJS do CRM RED.

## Stack e regras

- Vue 3, TypeScript, Composition API, Pinia, Vue Router, Axios e `socket.io-client`.
- Use o backend como única fonte oficial do chat e das atualizações em tempo real.
- Remova do chat `supabase.channel`, `postgres_changes`, `RealtimeChannel`, `subscribe`, `removeChannel` e equivalentes.
- O frontend nunca deve chamar `api.w-api.app` diretamente.
- Nunca exponha `W_API_API_KEY`, `provider_token`, `WHATSAPP_WEBHOOK_SECRET`, `JWT_SECRET` ou chave `service_role` no browser.
- IDs de mensagens e tamanhos `BigInt` chegam como `string`; nunca converta esses valores para `Number`.
- O backend retorna principalmente `snake_case`. Converta centralmente na camada HTTP ou mantenha `snake_case` em toda a aplicação; não misture padrões nos componentes.

## Ambiente

```env
VITE_API_BASE_URL=http://localhost:3000/api
VITE_WS_URL=http://localhost:3000
```

Em produção, use o domínio HTTPS do Render. O Socket.IO atual não usa namespace; conecte na raiz de `VITE_WS_URL`, e não em `/chat`.

## Arquitetura esperada

Crie ou ajuste:

```text
src/services/api.ts
src/services/socket.ts
src/services/auth.service.ts
src/services/crm.service.ts
src/services/whatsapp.service.ts
src/stores/auth.ts
src/stores/dashboard.ts
src/stores/contacts.ts
src/stores/messages.ts
src/stores/funnels.ts
src/stores/whatsapp.ts
src/types/api.ts
src/types/auth.ts
src/types/contact.ts
src/types/message.ts
src/types/whatsapp.ts
src/types/socket-events.ts
```

O Axios deve ter uma única instância e interceptors registrados uma única vez. Envie `Authorization: Bearer <access_token>` nas rotas protegidas.

## Autenticação

### `POST /api/auth/login`

Pública.

```json
{ "email": "usuario@example.com", "password": "senha-com-8-ou-mais-caracteres" }
```

Resposta:

```json
{
  "access_token": "jwt",
  "refresh_token": "token-opaco",
  "refresh_token_expires_at": "ISO_DATE",
  "user": {
    "id": "uuid",
    "name": "Nome",
    "email": "usuario@example.com",
    "role": "master | admin | manager | agent",
    "status": "active",
    "created_at": "ISO_DATE",
    "updated_at": "ISO_DATE"
  }
}
```

### `POST /api/auth/refresh`

Pública, com rotação de refresh token.

```json
{ "refreshToken": "token-opaco-atual" }
```

Retorna novo `access_token`, novo `refresh_token`, expiração e usuário. Substitua o refresh token antigo de forma atômica no frontend. Nunca reutilize o token anterior.

### `POST /api/auth/logout`

```json
{ "refreshToken": "token-opaco-atual" }
```

Revoga a sessão atual. Depois da resposta, desconecte o socket e limpe todos os stores.

### `POST /api/auth/logout-all`

Protegida. Revoga todas as sessões do usuário autenticado.

### `GET /api/auth/me`

Protegida. Retorna o usuário atual sem `password_hash`.

Implemente fila de renovação no interceptor: se várias requisições receberem 401 simultaneamente, execute apenas um refresh e repita as demais com o novo access token. Se o refresh falhar, finalize a sessão.

## Health check

### `GET /api/health`

Pública. Resposta: `{ "status": "ok" }`.

## Dashboard

### `GET /api/dashboard`

```json
{
  "contacts": { "total": 0, "pending": 0 },
  "messages": { "total": 0, "today": 0 },
  "instances": { "total": 0 }
}
```

## Contatos e conversas

### `GET /api/contacts`

Query parameters:

- `instance_id`: UUID opcional.
- `search`: nome ou telefone opcional.
- `page`: padrão 1.
- `limit`: padrão 50, máximo 100.

Resposta:

```json
{
  "items": [
    {
      "id": "uuid",
      "phone_number": "5511999999999 ou ID@g.us",
      "name": "Nome",
      "onboarding_stage": "pending | in_progress | completed",
      "last_interaction": "ISO_DATE | null",
      "metadata": { "isGroup": false, "needs_reply": false },
      "whatsapp_config_id": "uuid | null",
      "crm_funnel_id": "uuid | null",
      "crm_stage_id": "uuid | null",
      "message_count": 0
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 0,
    "totalPages": 0,
    "hasNext": false,
    "hasPrevious": false
  }
}
```

### `GET /api/contacts/:id`

Retorna o contato ou 404.

### `PATCH /api/contacts/:id`

```json
{
  "name": "Nome",
  "onboarding_stage": "pending | in_progress | completed",
  "crm_funnel_id": "uuid | null",
  "crm_stage_id": "uuid | null",
  "metadata": {}
}
```

### `POST /api/contacts/:id/read`

Marca mensagens recebidas como lidas e limpa `metadata.needs_reply`. Também gera `conversation:read` no Socket.IO.

## Mensagens

### `GET /api/contacts/:id/messages?page=1&limit=50`

Retorna:

```json
{
  "items": [
    {
      "id": "string",
      "contact_id": "uuid",
      "role": "user | assistant",
      "content": "Texto",
      "message_type": "text | image | video | audio | sticker | gif | document | unknown",
      "status": "queued | sending | sent | delivered | read | failed",
      "error_message": "string | null",
      "client_message_id": "uuid | null",
      "external_message_id": "string | null",
      "original_content": "string | null",
      "edited_content": "string | null",
      "deleted_on_whatsapp": false,
      "deleted_at": "ISO_DATE | null",
      "read_at": "ISO_DATE | null",
      "created_at": "ISO_DATE",
      "updated_at": "ISO_DATE",
      "metadata": {},
      "reply_to": {
        "message_id": "string | null",
        "external_message_id": "string | null",
        "participant": "string | null",
        "role": "user | assistant",
        "sender_name": "Nome | Você",
        "content": "Conteúdo da mensagem citada",
        "message_type": "text | image | video | audio | sticker | document | unknown"
      },
      "message_edits": []
    }
  ],
  "pagination": {}
}
```

A página vem ordenada cronologicamente. Ao carregar páginas anteriores, preserve a ordenação e deduplique pelo ID.

`reply_to` é `null` quando a mensagem não responde/cita outra mensagem. O
backend resolve citações recebidas e enviadas pelo WhatsApp a partir de
`contextInfo.stanzaID`, inclusive mensagens enviadas manualmente pelo celular.
Renderize o bloco citado acima do conteúdo da mensagem, mostrando
`sender_name`, um resumo de `content` e uma indicação visual conforme
`message_type`. Se `message_id` existir, ao clicar no bloco role a conversa até
a mensagem original; se for `null`, mantenha apenas o preview persistido.

### `POST /api/contacts/:id/messages`

O envio é assíncrono. O backend grava imediatamente com status `queued`, responde e processa a W-API em segundo plano.

Texto:

```json
{
  "clientMessageId": "crypto.randomUUID()",
  "type": "text",
  "content": "Olá"
}
```

Mídia:

```json
{
  "clientMessageId": "crypto.randomUUID()",
  "type": "image | video | audio | sticker | document",
  "content": "Conteúdo ou fallback",
  "caption": "Legenda",
  "storageBucket": "chat-media",
  "storagePath": "outbound/UUID/DATE/UUID.ext",
  "mimeType": "application/pdf",
  "fileName": "arquivo.pdf",
  "extension": "pdf",
  "size": 12345,
  "durationSeconds": 10
}
```

Use sempre `clientMessageId`; ele é a chave de idempotência. Reenvio acidental do mesmo ID retorna o registro existente.

## Upload e exibição de mídia

O bucket `chat-media` é privado. O frontend nunca usa a service-role e nunca faz upload diretamente no Supabase.

### `POST /api/uploads`

Protegida. Envie `multipart/form-data` com um único campo chamado `file`.

```ts
const formData = new FormData()
formData.append('file', file)
const { data } = await api.post('/uploads', formData)
```

Resposta:

```json
{
  "bucket": "chat-media",
  "path": "outbound/USER_ID/2026-07-12/UUID.ext",
  "url": "URL_ASSINADA_TEMPORARIA",
  "mimeType": "image/jpeg",
  "extension": "jpg",
  "originalName": "foto.jpg",
  "size": 12345
}
```

Limite: 50 MB. Tipos aceitos: imagens, vídeos, áudios, PDF, Word, Excel, TXT, CSV e ZIP.

Fluxo obrigatório para enviar mídia:

1. Fazer upload em `POST /api/uploads`.
2. Usar `url` apenas para preview imediato.
3. Enviar `bucket/path/mimeType/extension/originalName/size` na mensagem.
4. O backend gera uma nova URL assinada no momento de encaminhar para a W-API.
5. Não persistir a URL assinada como identificador permanente; persistir apenas bucket e path.

### `GET /api/uploads/messages/:messageId/url`

Protegida. Renova a URL assinada de uma mensagem quando a URL anterior expirar.

```json
{ "url": "URL_ASSINADA_NOVA_OU_NULL" }
```

Mensagens retornadas por HTTP e Socket.IO podem conter:

```json
{
  "media_url": "URL_ASSINADA_TEMPORARIA | null",
  "media_storage_bucket": "chat-media | null",
  "media_storage_path": "path | null",
  "media_mime_type": "string | null",
  "media_extension": "string | null",
  "media_original_name": "string | null",
  "media_size": "string | null",
  "media_duration_seconds": 0,
  "media_status": "pending | completed | failed | null",
  "media_error": "string | null"
}
```

Se uma mídia recebida chegar com `media_status=pending`, exiba skeleton/processamento. Ao receber `message:updated` com `completed`, substitua pelo arquivo pronto. Em `failed`, mostre fallback e opção de tentar recarregar a conversa.

Renderização:

- `image`: `<img>` com lazy loading.
- `video`: `<video controls preload="metadata">`.
- `audio`: `<audio controls preload="metadata">`.
- `sticker`: imagem sem moldura de foto.
- `gif`: imagem animada.
- `document`: nome, extensão, tamanho e botão para abrir/baixar.
- Revogue URLs locais criadas com `URL.createObjectURL` no `onUnmounted`.
- Ao receber 403/expiração na URL, chame a rota de renovação e tente novamente uma vez.

### `POST /api/messages/:id/retry`

Sem body. Recoloca a mesma mensagem em `queued`, sem criar registro duplicado.

### `PATCH /api/messages/:id/edit`

```json
{ "text": "Novo texto" }
```

O backend preserva `original_content` e cria histórico em `message_edits`.

### `DELETE /api/messages/:id/delete`

Apaga somente no WhatsApp. O registro continua no CRM com `deleted_on_whatsapp=true`.

### `POST /api/messages/:id/action`

Rota de compatibilidade:

```json
{ "action": "edit", "text": "Novo texto" }
```

ou `{ "action": "delete" }`.

## WhatsApp/W-API

Todos os endpoints abaixo, exceto webhook, são protegidos. Criação, alteração, desconexão, status e exclusão exigem `master` ou `admin`.

O backend usa internamente `W_API_API_KEY` para endpoints `/v1/client/*` e o `provider_token` da instância para QR Code, pairing, desconexão e mensagens. Nenhum desses segredos deve chegar ao frontend.

### `POST /api/whatsapp/instances`

```json
{
  "instanceName": "Atendimento",
  "lite": false,
  "automaticReading": false,
  "rejectCalls": true,
  "callMessage": "Não podemos atender ligações por aqui.",
  "useProxy": false
}
```

Proxy opcional:

```json
{
  "useProxy": true,
  "proxyProtocol": "socks5",
  "proxyHost": "host",
  "proxyPort": "1080",
  "proxyUser": "usuário",
  "proxyPass": "senha"
}
```

O backend chama `POST /v1/client/create-instance`, injeta a API key e cadastra automaticamente todos os webhooks. A resposta do frontend recebe a instância sanitizada e nunca recebe o token do provedor.

### `GET /api/whatsapp/instances?sync=true`

Com `sync=true`, o backend consulta `GET /v1/client/list-instances`, sincroniza o PostgreSQL e retorna:

```json
{ "ok": true, "instances": [], "total": 0 }
```

Sem `sync=true`, consulta apenas o banco local. Use sincronização manual ou na entrada da tela; não faça polling agressivo.

### `GET /api/whatsapp/instances/:id`

Retorna `{ "ok": true, "instance": {} }`, sempre sem `provider_token`, `api_key` ou `webhook_verify_token`.

### `PATCH /api/whatsapp/instances/:id`

```json
{
  "instanceName": "Novo nome",
  "displayPhoneNumber": "5511999999999",
  "isActive": true,
  "automaticReading": false,
  "rejectCalls": true,
  "callMessage": "Mensagem"
}
```

### `GET /api/whatsapp/instances/:id/qr-code?image=enable`

- `image=enable`: pode retornar PNG convertido pelo backend para data URL Base64.
- `image=disable`: retorna QR Code Base64/JSON da W-API.

Resposta principal:

```json
{
  "ok": true,
  "instanceId": "uuid-local",
  "providerInstanceId": "ID-WAPI",
  "image": "enable",
  "qrcode": "data:image/png;base64,..."
}
```

Renove o QR Code somente quando necessário e encerre timers ao sair do componente.

### `GET /api/whatsapp/instances/:id/pairing-code?phoneNumber=5511999999999`

Resposta:

```json
{
  "ok": true,
  "instanceId": "uuid-local",
  "providerInstanceId": "ID-WAPI",
  "phoneNumber": "5511999999999",
  "pairingCode": "WAPIPBYM"
}
```

### `POST /api/whatsapp/instances/:id/disconnect`

Desconecta na W-API e atualiza o banco para `DISCONNECTED`.

### `PATCH /api/whatsapp/instances/:id/status`

```json
{ "status": "PENDING | CONNECTED | DISCONNECTED | EXPIRED | BLOCKED" }
```

### `POST /api/whatsapp/instances/:id/sync-group-names`

Protegida e restrita a `master`/`admin`. Consulta `group-metadata` na W-API
para os grupos existentes da instância, persiste `group.subject` em
`contacts.name` e publica `contact:updated`/`conversation:updated`.

```json
{ "ok": true, "total": 10, "updated": 8, "unresolved": 1, "manual": 1 }
```

O backend também resolve automaticamente o nome no primeiro webhook do grupo.
Nomes editados manualmente nunca devem ser substituídos pelo JID `@g.us`.

### `DELETE /api/whatsapp/instances/:id`

Solicita exclusão na W-API e faz soft delete local: limpa o token, marca `EXPIRED` e `is_active=false`. Exija confirmação forte na interface.

### `POST /api/whatsapp/webhook?secret=...`

Rota exclusiva da W-API. O frontend nunca deve chamá-la.

O backend persiste o evento antes de processá-lo, trata idempotência, diferencia grupos somente quando `isGroup=true` e `chat.id` termina em `@g.us`, persiste status/mensagens e publica eventos Socket.IO.

## Outras rotas

- `GET /api/funnels?instance_id=UUID`: retorna funis com `stages` ordenados.
- `GET /api/knowledge`: retorna a base de conhecimento. A rota atual é `/knowledge`, não `/knowledge-base`.
- `GET /api/ai-instances`: retorna instâncias de IA.
- `GET /api/users`: retorna usuários sem senha.

## Socket.IO

Crie singleton em `src/services/socket.ts`:

```ts
const socket = io(import.meta.env.VITE_WS_URL, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
  auth: { token: accessToken },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
  randomizationFactor: 0.5,
})
```

Antes de reconectar após refresh, atualize `socket.auth = { token: novoAccessToken }`. A conexão sem JWT válido é rejeitada. Ao conectar, o backend entra automaticamente em `user:<userId>`.

Implemente `emitWithAck` tipado com `socket.timeout(15000).emit(...)` e `requestId: crypto.randomUUID()`.

### Eventos cliente → servidor

#### `chat:join`

```json
{
  "requestId": "uuid",
  "instanceId": "uuid opcional",
  "contactId": "uuid opcional",
  "conversationId": "string opcional"
}
```

`instanceId` deve ser informado ou resolvido pelo `contactId`. Ack:

```json
{ "ok": true, "requestId": "uuid", "rooms": ["instance:...", "contact:...", "conversation:..."] }
```

#### `chat:leave`

Mesmo payload; ack `{ "ok": true, "requestId": "uuid" }`.

#### `message:send`

Mesmo contrato do POST HTTP, acrescentando `contactId` e `requestId`. Ack imediato:

```json
{ "ok": true, "requestId": "uuid", "messageId": "string" }
```

#### `message:retry`

```json
{ "requestId": "uuid", "messageId": "string" }
```

#### `message:edit`

```json
{ "requestId": "uuid", "messageId": "string", "text": "Novo texto" }
```

#### `message:delete`

```json
{ "requestId": "uuid", "messageId": "string" }
```

#### `conversation:read`

```json
{ "requestId": "uuid", "contactId": "uuid" }
```

### Eventos servidor → cliente

Registre listeners uma única vez no serviço singleton:

- `message:created`: inserir/reconciliar mensagem por ID ou `client_message_id`.
- `message:updated`: substituir mensagem existente por ID.
- `message:status`: atualizar `queued/sending/sent/delivered/read`.
- `message:failed`: marcar falha, exibir `error_message` e botão de retry.
- `message:deleted_on_whatsapp`: manter registro e mostrar indicador de exclusão.
- `contact:created`: inserir contato sem duplicar.
- `contact:updated`: atualizar contato por ID.
- `conversation:created`: inserir nova conversa/contato gerado por webhook.
- `conversation:updated`: atualizar resumo, última mensagem e ordenação.
- `conversation:read`: limpar contador/indicador de não lida.
- `instance:status`: atualizar status, telefone, conexão e disponibilidade da instância.
- `exception`: apresentar erro seguro; se indicar token inválido, renovar ou encerrar sessão.

Rooms atuais:

```text
user:<userId>
instance:<whatsappConfigId>
contact:<contactId>
conversation:<conversationId>
```

Ao reconectar, reentre nas rooms da instância e conversa ativas e refaça a consulta paginada de mensagens para recuperar eventos possivelmente perdidos.

## Estado otimista e reconciliação

1. Gere `clientMessageId` antes de enviar.
2. Insira mensagem otimista `queued` no store.
3. Envie via Socket.IO preferencialmente; HTTP é fallback.
4. Reconcilie ack e `message:created` usando `client_message_id` e depois o ID real.
5. Aplique eventos por ID de forma idempotente.
6. Nunca duplique mensagem em reconexão ou refetch.
7. Exiba estados `queued`, `sending`, `sent`, `delivered`, `read` e `failed`.
8. Retry usa o mesmo registro e não cria nova mensagem.

## Ciclo de vida e conectividade

- Trate `online`, `offline` e `visibilitychange`.
- Não reconecte em loop enquanto offline.
- Ao voltar online, conecte, reentre nas rooms e sincronize dados.
- Não adicione listener dentro de outro listener.
- Remova listeners locais no `onUnmounted` quando forem específicos do componente.
- Listeners globais dos stores devem ser registrados e removidos pelo serviço central.
- Desconecte e limpe rooms no logout.

## Tela de instâncias WhatsApp

Implemente:

- Listagem e sincronização manual.
- Criação LITE/PRO.
- Configuração de leitura automática e rejeição de chamadas.
- Proxy opcional com campos condicionais.
- Modal de QR Code.
- Modal de pairing code por telefone.
- Status em tempo real.
- Desconexão.
- Soft delete com confirmação.
- Ocultar ações administrativas para `manager` e `agent`.
- Nunca renderizar nem persistir token do provedor.

## Validação obrigatória

Ao concluir:

1. Execute instalação, build, lint e testes disponíveis.
2. Valide login, refresh rotativo, logout e logout-all.
3. Valide expiração e fila única de refresh no Axios.
4. Valide contatos e mensagens paginados.
5. Valide envio assíncrono, estados e idempotência.
6. Valide retry sem duplicidade.
7. Valide edição e histórico.
8. Valide exclusão no WhatsApp sem apagar o registro local.
9. Valide criação, sync, QR Code, pairing, desconexão e exclusão de instância.
10. Valide autenticação do socket, acknowledgements e reentrada nas rooms.
11. Valide todos os eventos do servidor sem listeners duplicados.
12. Confirme que o chat não usa Supabase Realtime.

Ao final, informe arquivos alterados, rotas integradas, eventos integrados, assinaturas Supabase removidas, resultado do build/testes e qualquer limitação real encontrada. Não invente endpoints nem contratos diferentes dos documentados acima.
