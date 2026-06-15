# Multi-Document RAG Implementation Plan

## Issue

Implement multi-document RAG querying support.

Current behavior:

- Users upload documents into a shared document library.
- Users chat with one uploaded document at a time through `/documents/[id]`.
- Backend RAG retrieval accepts one `documentId` and filters chunks for that single document.

Goal:

- Support selecting and querying multiple uploaded documents at once.
- Keep the existing single-document `documentId` API behavior working.

## Current Architecture Summary

### Upload Flow

Relevant files:

- `backend/src/routes/document.routes.js`
- `backend/src/controllers/document.controller.js`
- `backend/src/services/documentService.js`
- `backend/src/models/document.model.js`
- `backend/src/models/documentChunk.model.js`
- `backend/src/agents/embeddingAdapter.js`
- `frontend/src/app/documents/page.tsx`

Flow:

1. The frontend document library page uploads one file at a time with `POST /api/documents/upload`.
2. `frontend/src/app/documents/page.tsx` sends a `FormData` request containing `file`.
3. `backend/src/routes/document.routes.js` handles `POST /upload` with auth, rate limiting, and `multer.memoryStorage()`.
4. `uploadDocument` in `backend/src/controllers/document.controller.js` parses supported file types:
   - PDF via `pdf-parse`
   - TXT/MD via UTF-8 buffer text
   - JSON via parsed and pretty-printed JSON
   - CSV via UTF-8 buffer text
5. A `Document` record is created with `userId`, `title`, `fileType`, and `size`.
6. `processDocument(agent, document, text)` chunks and embeds the document.
7. Each chunk is stored in `DocumentChunk` with:
   - `documentId`
   - `userId`
   - `chunkIndex`
   - `content`
   - `embedding`
8. The `Document` is updated to `status: "ready"` and `chunkCount`.

### Chunking and Embedding

Relevant files:

- `backend/src/services/documentService.js`
- `backend/src/agents/embeddingAdapter.js`
- `backend/src/models/documentChunk.model.js`

Current behavior:

- `chunkText(text, chunkSize = 1200, overlap = 200)` slices raw text into overlapping character chunks.
- `processDocument` embeds each chunk with `runEmbedding(content, agent)`.
- Embedding provider selection happens in `embeddingAdapter.js`.
- The upload controller builds a minimal agent object from document chat settings:
  - `provider = settings.documentChat.provider || "ollama"`
  - default model is read, but upload currently only passes `{ config: { provider } }` to embedding.
- Chunks are persisted in MongoDB. There is no external vector database.

### Retrieval Flow

Relevant files:

- `backend/src/controllers/document.controller.js`
- `backend/src/services/documentService.js`
- `backend/src/models/documentChunk.model.js`

Current behavior:

1. `chatWithDocument` receives `{ documentId, question }`.
2. It loads the user's `SystemSettings.documentChat`.
3. It calls:

   ```js
   queryDocument(agent, req.user._id, documentId, question, topK)
   ```

4. `queryDocument` embeds the question.
5. It queries MongoDB with:

   ```js
   DocumentChunk.find({ userId, documentId })
   ```

6. It calculates cosine similarity in application code.
7. It sorts chunks by descending similarity.
8. It returns the top `topK` chunks.

### Chat and LLM Flow

Relevant files:

- `frontend/src/app/documents/[id]/page.tsx`
- `backend/src/routes/document.routes.js`
- `backend/src/controllers/document.controller.js`
- `backend/src/agents/llmAdapter.js`

Current flow:

1. User opens `/documents/[id]`.
2. `frontend/src/app/documents/[id]/page.tsx` gets `id` from `useParams()`.
3. The page loads document metadata with:

   ```http
   GET /api/documents/:id
   ```

4. On chat submit, the page sends:

   ```http
   POST /api/documents/chat
   Content-Type: application/json

   {
     "documentId": "<route id>",
     "question": "<user question>"
   }
   ```

5. `chatWithDocument` retrieves chunks for exactly that `documentId`.
6. The controller concatenates retrieved chunk content:

   ```js
   const context = chunks.map((c) => c.content).join("\n\n");
   ```

7. It builds a prompt using that context and the question.
8. It calls `runLLM(prompt, { provider, model, temperature })`.
9. The response shape is currently:

   ```json
   {
     "ok": true,
     "answer": "..."
   }
   ```

## Current `documentId` Data Flow

### Standalone Document Chat

Files:

- `frontend/src/app/documents/page.tsx`
- `frontend/src/app/documents/[id]/page.tsx`
- `backend/src/routes/document.routes.js`
- `backend/src/controllers/document.controller.js`
- `backend/src/services/documentService.js`
- `backend/src/models/documentChunk.model.js`
- `backend/src/agents/llmAdapter.js`

Flow:

1. Document card link:

   ```tsx
   href={`/documents/${doc._id}`}
   ```

2. Dynamic route extracts `id`:

   ```tsx
   const { id } = useParams();
   ```

3. Chat request body:

   ```json
   {
     "documentId": "id-from-route",
     "question": "user input"
   }
   ```

4. Backend controller destructures:

   ```js
   const { documentId, question } = req.body;
   ```

5. Retrieval call:

   ```js
   queryDocument(agent, req.user._id, documentId, question, topK)
   ```

6. Chunk query:

   ```js
   DocumentChunk.find({ userId, documentId })
   ```

7. LLM receives only chunks from that single document.

### Workflow Document Query Steps

Related files:

- `frontend/src/app/workflows/[id]/builder/page.tsx`
- `frontend/src/components/workflow/visual-builder.tsx`
- `backend/src/agents/executor.js`

Current behavior:

- Workflow builder `Document` steps store a single `documentId`.
- `saveWorkflow` serializes document steps as:

  ```js
  {
    type: "document_query",
    documentId: s.documentId,
    query: s.query,
    topK: s.topK ?? 4
  }
  ```

- `executor.js` handles `step.type === "document_query"` and calls:

  ```js
  queryDocument(agent, context.userId, documentId, query, step.topK || 3)
  ```

This is not the primary chat UI, but it is another single-document RAG path and should either be updated in the same implementation or explicitly left as a follow-up.

## Files Involved

### Backend

Must update:

- `backend/src/controllers/document.controller.js`
  - Accept `documentIds` in addition to `documentId`.
  - Validate selected document ownership.
  - Pass multiple IDs into retrieval.
  - Return source attribution metadata.

- `backend/src/services/documentService.js`
  - Add multi-document retrieval support.
  - Keep `queryDocument(agent, userId, documentId, query, topK)` backward compatible.
  - Recommended: add `queryDocuments(agent, userId, documentIds, query, topK)`.

- `backend/src/models/documentChunk.model.js`
  - Existing schema can support multi-document retrieval with `{ documentId: { $in: documentIds } }`.
  - Existing index `{ userId: 1, documentId: 1 }` remains useful.

May update:

- `backend/src/agents/executor.js`
  - If workflow document-query steps should also support multiple docs, accept `step.documentIds` with fallback to `step.documentId`.

- `backend/src/routes/document.routes.js`
  - Route path can remain `POST /api/documents/chat`.
  - No routing change required unless adding a dedicated endpoint.

No change likely needed:

- `backend/src/models/document.model.js`
- `backend/src/agents/embeddingAdapter.js`

### Frontend

Must update:

- `frontend/src/app/documents/page.tsx`
  - Add multi-select state and UI in the document library.
  - Add a way to start a multi-document chat from selected documents.

- `frontend/src/app/documents/[id]/page.tsx`
  - Current single-document chat page can remain compatible.
  - Could be reused for single-document mode only.

Recommended new or updated route:

- Add `frontend/src/app/documents/chat/page.tsx`
  - A multi-document chat page that reads selected IDs from query params or client state.
  - Avoid overloading `/documents/[id]` with comma-separated IDs.

May update:

- `frontend/src/context/assistant-context.tsx`
  - Include selected document IDs/titles in assistant context if useful.

- `frontend/src/app/workflows/[id]/builder/page.tsx`
  - If workflow document-query steps should support multi-document RAG.

- `frontend/src/components/workflow/visual-builder.tsx`
  - If visual builder document-query steps should support multi-document RAG.

## Minimal Backend Implementation Plan

### 1. Normalize Request Input

In `chatWithDocument`, support both legacy and new request shapes:

```js
const { documentId, documentIds, question } = req.body;

const selectedDocumentIds = Array.isArray(documentIds)
  ? documentIds
  : documentId
    ? [documentId]
    : [];
```

Validation:

- `question` must be a non-empty string.
- `selectedDocumentIds` must contain at least one ID.
- IDs should be valid Mongo ObjectIds.
- Remove duplicates.
- Apply a maximum selection count to prevent large fan-out, for example 10 documents.

### 2. Verify Ownership and Readiness

Before retrieval, fetch matching documents:

```js
Document.find({
  _id: { $in: selectedDocumentIds },
  userId: req.user._id
})
```

Rules:

- If no documents match, return `404`.
- If some requested IDs do not belong to the user or do not exist, return `403` or `404`.
- Prefer strict behavior: every requested ID must resolve to a document owned by the user.
- Consider filtering to `status: "ready"` or returning a clear error if any selected document is not ready.

### 3. Add Multi-Document Retrieval Service

Keep the existing function working:

```js
async function queryDocument(agent, userId, documentId, query, topK = 3)
```

Add:

```js
async function queryDocuments(agent, userId, documentIds, query, topK = 3)
```

Implementation:

```js
const chunks = await DocumentChunk.find({
  userId,
  documentId: { $in: documentIds }
})
  .select("documentId chunkIndex content embedding")
  .lean();
```

Then:

- Embed query once.
- Score all chunks across selected documents.
- Sort globally by similarity.
- Return global top `topK`.

Backward compatibility:

```js
async function queryDocument(agent, userId, documentId, query, topK = 3) {
  return queryDocuments(agent, userId, [documentId], query, topK);
}
```

### 4. Include Source Metadata in Retrieved Chunks

Retrieval should return enough data for attribution:

```js
{
  documentId,
  documentTitle,
  chunkIndex,
  content,
  score
}
```

Options:

- Join document titles in the controller after retrieval by using the already-fetched `Document` records.
- Or have `queryDocuments` fetch documents and attach titles.

Minimal approach:

- `queryDocuments` returns `documentId`, `chunkIndex`, `content`, and `score`.
- Controller maps `documentId` to document title.

### 5. Build a Source-Aware Prompt

Instead of concatenating raw chunk text only, format context with source labels:

```text
[Source 1]
Document: Product Roadmap.pdf
Document ID: 64...
Chunk: 3
Score: 0.8123
Content:
...
```

Prompt should tell the model:

- Use only the provided context.
- If the answer spans multiple documents, synthesize across them.
- When possible, mention which document(s) support the answer.
- If the answer cannot be found, say the information was not found in the selected documents.

### 6. Return Sources in API Response

Keep existing `answer` field. Add `sources`.

Backward-compatible response:

```json
{
  "ok": true,
  "answer": "The answer...",
  "sources": [
    {
      "documentId": "665...",
      "title": "Document A.pdf",
      "chunkIndex": 2,
      "score": 0.84
    },
    {
      "documentId": "666...",
      "title": "Document B.md",
      "chunkIndex": 0,
      "score": 0.79
    }
  ]
}
```

Existing clients that only read `answer` will continue to work.

## Backend API Shape

### Existing Request: Still Supported

```http
POST /api/documents/chat
Content-Type: application/json
Authorization: Bearer <token>

{
  "documentId": "665...",
  "question": "What are the project risks?"
}
```

### New Request: Multi-Document

```http
POST /api/documents/chat
Content-Type: application/json
Authorization: Bearer <token>

{
  "documentIds": ["665...", "666...", "667..."],
  "question": "Compare the implementation risks across these documents."
}
```

### Optional Future Request Fields

These are not required for the minimal implementation:

```json
{
  "documentIds": ["665...", "666..."],
  "question": "Summarize common themes.",
  "topK": 8
}
```

For now, continue using `SystemSettings.documentChat.topK` as the source of truth.

### Success Response

```json
{
  "ok": true,
  "answer": "The documents identify API compatibility and retrieval quality as key risks.",
  "sources": [
    {
      "documentId": "665...",
      "title": "Backend Notes.md",
      "chunkIndex": 4,
      "score": 0.86
    },
    {
      "documentId": "666...",
      "title": "Frontend Plan.md",
      "chunkIndex": 1,
      "score": 0.81
    }
  ],
  "documentIds": ["665...", "666..."]
}
```

### Error Responses

Missing question:

```json
{
  "ok": false,
  "error": "question_required"
}
```

No selected documents:

```json
{
  "ok": false,
  "error": "document_required"
}
```

Invalid IDs:

```json
{
  "ok": false,
  "error": "invalid_document_ids"
}
```

Document not found or forbidden:

```json
{
  "ok": false,
  "error": "document_not_found"
}
```

No chunks found:

```json
{
  "ok": true,
  "answer": "I could not find this information in the selected documents.",
  "sources": [],
  "documentIds": ["665...", "666..."]
}
```

## Minimal Frontend Implementation Plan

### 1. Add Multi-Select State to Document Library

File:

- `frontend/src/app/documents/page.tsx`

Add state:

```ts
const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
```

Behavior:

- Each document card gets a checkbox or selection control.
- Clicking the checkbox toggles the document ID in `selectedDocumentIds`.
- Keep normal card click behavior for opening single-document chat.
- Prevent checkbox clicks from navigating by using `event.preventDefault()` and `event.stopPropagation()`.

### 2. Add Bulk Chat Action

On `documents/page.tsx`, show a toolbar action when one or more documents are selected:

- `Chat with selected`
- Selected count
- Clear selection

For one selected document:

- Option A: navigate to existing `/documents/:id`.
- Option B: navigate to the new multi-chat page with one ID.

For two or more selected documents:

- Navigate to a new route, recommended:

  ```text
  /documents/chat?ids=<id1>,<id2>,<id3>
  ```

Avoid storing selected IDs only in component state because a refresh would lose the selection.

### 3. Add Multi-Document Chat Page

Recommended new file:

- `frontend/src/app/documents/chat/page.tsx`

Responsibilities:

1. Read IDs from `useSearchParams()`.
2. Fetch `/api/documents` or individual `/api/documents/:id` records to show selected document titles.
3. Keep the same chat message state pattern as `documents/[id]/page.tsx`.
4. Submit:

   ```ts
   body: JSON.stringify({
     documentIds: selectedDocumentIds,
     question,
   })
   ```

5. Render `data.answer`.
6. Render `data.sources` below assistant messages.

### 4. Keep Existing Single-Document Chat Page

File:

- `frontend/src/app/documents/[id]/page.tsx`

Minimal change:

- No change required for backward compatibility.

Optional improvement:

- Update it to consume `sources` if the backend returns them.
- It can continue sending `{ documentId: id, question }`.

### 5. Source Display UI

For each assistant response, store optional sources:

```ts
type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: {
    documentId: string;
    title: string;
    chunkIndex: number;
    score: number;
  }[];
};
```

Render below assistant answers:

- Document title
- Chunk number
- Optional similarity score, rounded to two decimals
- Link to `/documents/:documentId`

Example label:

```text
Sources: Backend Notes.md · chunk 4, Frontend Plan.md · chunk 1
```

## Source Attribution Strategy

The current backend only sends the generated answer. Multi-document RAG needs explicit source metadata because answers may combine information from multiple files.

Recommended strategy:

1. Retrieval returns chunk metadata:
   - `documentId`
   - `chunkIndex`
   - `score`
   - `content`
2. Controller enriches chunks with document titles.
3. Prompt labels each context block with document title and chunk index.
4. API response returns compact source metadata, not full chunk content.
5. Frontend displays sources under assistant answers.

Do not expose full chunk text in the public response unless needed for a debug mode. Full chunks can leak more document content into the UI than the user asked to see.

Recommended response `sources` shape:

```ts
type RagSource = {
  documentId: string;
  title: string;
  chunkIndex: number;
  score: number;
};
```

Deduplication:

- If multiple chunks from the same document are used, either show all chunks or group by document.
- Minimal implementation can show all chunks.
- More polished UI can group:

  ```text
  Backend Notes.md: chunks 2, 4
  Frontend Plan.md: chunk 1
  ```

## Risks and Edge Cases

### Retrieval Quality

- Global top `topK` may pull all chunks from one document and ignore others.
- This is usually acceptable for minimal implementation because it ranks by relevance.
- If users expect balanced retrieval across documents, add a future option like `topKPerDocument`.

### Context Size

- Multi-document retrieval can increase prompt length.
- Current `topK` defaults to 3, which limits context naturally.
- If topK is raised, enforce a max context character budget before calling the LLM.

### Unauthorized Access

- Never trust client-provided `documentIds`.
- Always filter by `userId`.
- Prefer strict validation that every selected ID belongs to the current user.

### Invalid or Missing IDs

- `documentIds` might be empty, malformed, duplicated, or include deleted documents.
- Normalize, deduplicate, validate ObjectIds, then verify ownership.

### Not-Ready Documents

- A document may still be `processing` or `failed`.
- The chat endpoint should either reject non-ready documents or exclude them with a clear response.
- Recommended minimal behavior: reject if any selected document is not `ready`.

### No Chunks

- Documents may have zero chunks due to failed processing or legacy data.
- Return a successful fallback answer with empty sources rather than crashing.

### Backward Compatibility

- Existing frontend sends `documentId`.
- Existing workflow document steps store `documentId`.
- Keep `documentId` working everywhere.
- Add `documentIds` as an additive field.

### Workflow RAG Compatibility

- The issue describes document chat, but workflow document-query steps also use `documentId`.
- Decide during implementation whether to:
  - Update workflow steps to accept `documentIds`, or
  - Keep workflows single-document and document this as a follow-up.

### Settings Consistency

- Upload and chat both use `SystemSettings.documentChat.provider`.
- If embedding provider/model settings are added later, document ingestion and query embedding must use compatible embedding dimensions.
- Mixing embeddings from different providers/models can degrade or break cosine similarity.

### Frontend Routing

- `/documents/[id]` may conflict with `/documents/chat` if route matching is ambiguous.
- In Next.js App Router, a static segment like `/documents/chat` should be preferred over dynamic `[id]`, but verify locally.

## Test Cases

### Backend Unit or Integration Tests

1. Legacy single-document request works:

   ```json
   {
     "documentId": "docA",
     "question": "What is this about?"
   }
   ```

2. Multi-document request works:

   ```json
   {
     "documentIds": ["docA", "docB"],
     "question": "Compare both documents."
   }
   ```

3. `documentIds` takes precedence when both fields are provided.

4. Duplicate IDs are deduplicated.

5. Empty `documentIds` returns `document_required`.

6. Missing `question` returns `question_required`.

7. Invalid ObjectId returns `invalid_document_ids`.

8. A document owned by another user is rejected.

9. A deleted/nonexistent document is rejected.

10. A `processing` or `failed` document is rejected or handled according to the chosen rule.

11. Retrieval returns chunks from multiple document IDs when relevant.

12. Response includes `sources` with `documentId`, `title`, `chunkIndex`, and `score`.

13. No matching chunks returns a graceful answer and `sources: []`.

### Frontend Tests

1. Document library renders checkboxes or selection controls.

2. Selecting one document updates selected count.

3. Selecting multiple documents enables `Chat with selected`.

4. Checkbox click does not navigate to `/documents/:id`.

5. Clear selection resets selected IDs.

6. Multi-chat page reads IDs from query params.

7. Multi-chat page sends `documentIds`, not `documentId`.

8. Existing `/documents/:id` chat still sends `documentId` and works.

9. Assistant responses render sources when returned.

10. Empty or invalid `ids` query param shows a useful empty/error state.

### Manual QA

1. Upload two small text files with distinct facts.

2. Chat with each individually and confirm old behavior still works.

3. Select both documents and ask a question requiring information from both.

4. Confirm the answer references both documents when relevant.

5. Confirm source chips/links point back to the correct document pages.

6. Delete one selected document, reload multi-chat URL, and confirm the UI/backend handles the missing document cleanly.

## Suggested Implementation Order

1. Add `queryDocuments` in `backend/src/services/documentService.js`.
2. Refactor `queryDocument` to call `queryDocuments` with one ID.
3. Update `chatWithDocument` to normalize `documentId` and `documentIds`.
4. Add ownership/readiness validation in `chatWithDocument`.
5. Add source-aware context formatting and `sources` response.
6. Add frontend selection state and bulk action in `frontend/src/app/documents/page.tsx`.
7. Add `frontend/src/app/documents/chat/page.tsx` for multi-document chat.
8. Optionally render sources in `frontend/src/app/documents/[id]/page.tsx`.
9. Decide whether workflow `document_query` should support `documentIds` in this same PR or a follow-up.

## Minimal Acceptance Criteria

- Existing single-document chat keeps working without frontend changes.
- `POST /api/documents/chat` accepts `documentIds: string[]`.
- Retrieval searches chunks across all selected documents owned by the current user.
- LLM prompt includes clearly labeled source context.
- Response includes `answer` and `sources`.
- Frontend allows selecting multiple documents from the document library.
- Frontend can send one chat question against multiple selected documents.
- Frontend displays source attribution for multi-document answers.
